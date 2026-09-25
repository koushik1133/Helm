-- ============================================================================
-- Phase 90 — Concurrency & ledger integrity (MONEY-03, MONEY-04, MONEY-05)
-- ---------------------------------------------------------------------------
-- Supersedes the numbering logic in phase76 (record_payment) and phase77
-- (save_quotation_version). Those used `select count(*)+1` with NO unique
-- constraint and NO retry, so two concurrent calls could mint duplicate
-- receipt numbers (RCP-<code>-01) or duplicate version labels (Q2) silently.
-- The repo already solves the identical problem correctly in
-- phase28-quote-codes.sql (create_quote): a real UNIQUE index + a
-- `loop … exception when unique_violation … retry` block. We apply that same
-- proven pattern here, as the DATABASE is the final authority on uniqueness.
--
-- MONEY-05: record_payment also gains an OPTIONAL idempotency key so a retried
-- / double-submitted payment collapses to a single ledger row instead of
-- issuing a second receipt. Passing NULL preserves the exact current behavior
-- (manual/offline entry keeps working), so this is additive & backward safe.
--
-- DO NOT BREAK: org scoping (assert_quote_org + current_org_id), the
--   user-supplied p_receipt_no override, milestone-paid + booking-confirm side
--   effects, notifications, and the human-readable RCP-/Q<n> formats.
-- Additive, idempotent, NON-destructive (no row deletes, no truncation).
-- Run AFTER phase76 + phase77 (numbered-phase order guarantees this).
-- ============================================================================

-- ---- MONEY-03: receipt numbers are unique per quote ------------------------
-- Guard against pre-existing duplicates BEFORE adding the unique index so the
-- migration fails LOUD (never silently drops data) if history already collided.
do $$ declare dup int; begin
  select count(*) into dup from (
    select quote_id, receipt_no from public.quote_payments
     where receipt_no is not null
     group by quote_id, receipt_no having count(*) > 1) d;
  if dup > 0 then
    raise exception 'phase90: % duplicate (quote_id,receipt_no) group(s) already exist — resolve manually before adding the unique index (no data was changed)', dup;
  end if;
end $$;
create unique index if not exists quote_payments_quote_receipt_uk
  on public.quote_payments(quote_id, receipt_no) where receipt_no is not null;

-- ---- MONEY-05: optional idempotency key (nullable → current behavior kept) --
alter table public.quote_payments add column if not exists idempotency_key text;
create unique index if not exists quote_payments_idempotency_uk
  on public.quote_payments(quote_id, idempotency_key) where idempotency_key is not null;

-- ---- MONEY-04: version labels are unique per quote -------------------------
do $$ declare dup int; begin
  select count(*) into dup from (
    select quote_id, label from public.quotation_versions
     group by quote_id, label having count(*) > 1) d;
  if dup > 0 then
    raise exception 'phase90: % duplicate (quote_id,label) version group(s) already exist — resolve manually first (no data was changed)', dup;
  end if;
end $$;
create unique index if not exists quotation_versions_quote_label_uk
  on public.quotation_versions(quote_id, label);

-- ---- record_payment: unique receipt + retry + idempotency ------------------
create or replace function public.record_payment(
  p_quote uuid, p_amount numeric, p_method text default 'cash',
  p_receipt_no text default null, p_milestone uuid default null, p_note text default null,
  p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; rno text; seqn int; studio_email text; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  -- MONEY-05: if this exact operation was already recorded, return it unchanged
  -- (idempotent replay/double-submit protection). Only active when a key is given.
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is not null then
    select * into existing from public.quote_payments
      where quote_id = p_quote and idempotency_key = p_idempotency_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'booking','confirmed', 'idempotent_replay', true);
    end if;
  end if;

  -- MONEY-03: mint a unique receipt number. Honor an explicit p_receipt_no
  -- override (offline cash); otherwise auto-number with a unique_violation retry
  -- loop (same pattern as create_quote). The UNIQUE index is the real authority.
  loop
    tries := tries + 1;
    select count(*)+1 into seqn from public.quote_payments where quote_id = p_quote and status = 'paid';
    rno := coalesce(nullif(btrim(coalesce(p_receipt_no,'')),''), 'RCP-'||q.code||'-'||lpad(seqn::text,2,'0'));
    begin
      insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at, note, idempotency_key)
        values (p_quote, coalesce(p_method,'cash'), p_amount, 'paid', rno, rno, coalesce(p_method,'cash'),
                (coalesce(p_method,'cash') <> 'cash'), now(), nullif(btrim(coalesce(p_note,'')),''),
                nullif(btrim(coalesce(p_idempotency_key,'')),''));
      exit;  -- inserted successfully
    exception
      when unique_violation then
        -- A concurrent txn took this receipt_no (or idempotency key). If the
        -- caller supplied an explicit receipt_no we cannot re-number it → fail
        -- clearly rather than duplicate. Otherwise retry with the next number.
        if nullif(btrim(coalesce(p_receipt_no,'')),'') is not null then
          raise exception 'receipt number % already exists for this event', rno using errcode='23505';
        end if;
        if tries >= 5 then raise; end if;
    end;
  end loop;

  -- mark the chosen milestone paid (or the earliest unpaid one if none given)
  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now() where id = p_milestone and quote_id = p_quote;
  else
    update public.payment_milestones set status='paid', paid_at=now()
      where id = (select id from public.payment_milestones where quote_id = p_quote and status <> 'paid' order by seq, due_date limit 1);
  end if;

  -- recording the advance confirms the booking
  update public.quotes
     set approval_status = 'paid',
         status = case when status <> 'confirmed' then 'confirmed' else status end,
         lifecycle_stage = case when lifecycle_stage in ('lead','discovery','proposal','quote','confirmed')
                                then 'planning' else lifecycle_stage end,
         updated_at = now()
   where id = p_quote and org_id = public.current_org_id();

  -- acknowledge BOTH sides
  select business_email into studio_email from public.organizations where id = q.org_id;
  perform public._notify(p_quote,'email', q.client->>'email', 'payment_receipt',
    jsonb_build_object('code',q.code,'amount',p_amount,'receipt',rno,'method',coalesce(p_method,'cash'),'booking','confirmed'));
  perform public._notify(p_quote,'email', coalesce(studio_email,''), 'advance_paid',
    jsonb_build_object('code',q.code,'amount',p_amount,'client',q.client->>'name','receipt',rno,'method',coalesce(p_method,'cash')));

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'booking','confirmed');
end; $$;
-- IMPORTANT: keep ONLY the 7-arg signature. A separate 6-arg overload would make
-- a 6-argument call ambiguous ("function record_payment(...) is not unique"),
-- because the 7-arg version also matches (p_idempotency_key defaulted). The old
-- 6-arg body from phase76 is dropped so every existing 6-arg call resolves
-- cleanly to this one with p_idempotency_key = NULL (identical prior behavior).
drop function if exists public.record_payment(uuid,numeric,text,text,uuid,text);
revoke all on function public.record_payment(uuid,numeric,text,text,uuid,text,text) from anon;
grant execute on function public.record_payment(uuid,numeric,text,text,uuid,text,text) to authenticated;

-- ---- save_quotation_version: unique label + retry -------------------------
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int; lbl text; tot numeric; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  -- MONEY-01 guard (safe subset): reject a structurally invalid total. This does
  -- NOT recompute the total (that requires the ratified pricing rules — see
  -- docs / PRODUCT DECISION), it only refuses obviously-bad persisted values.
  tot := coalesce((p_pricing->>'total')::numeric, 0);
  if tot < 0 then raise exception 'quotation total cannot be negative'; end if;
  -- MONEY-04: unique Q-label with unique_violation retry (DB is the authority).
  loop
    tries := tries + 1;
    select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
    lbl := 'Q'||n;
    begin
      insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
        values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
      exit;
    exception when unique_violation then
      if tries >= 5 then raise; end if;
    end;
  end loop;
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end; $$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';

select 'phase90 numbering-integrity' t, 'ready' s;
