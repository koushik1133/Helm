-- PROD-01-APPLY — paste into the PRODUCTION SQL editor AFTER PROD-00 shows 0 violations + a backup is taken.
-- All statements are additive/idempotent (CREATE OR REPLACE / IF NOT EXISTS). Safe order.
-- Bundles: W15B-01,04,05,06 (money integrity, tokens, OTP CSPRNG, cascade RESTRICT, pricing harden)
--          W16-02 (manager authority), W16-03 (overpayment guard), W16-01 (input CHECK constraints LAST).

-- ===================== supabase/wave15b/W15B-01-PRICING-UPGRADE.sql =====================
-- ============================================================================
-- W15B-01-PRICING-UPGRADE.sql  — W15-001 server pricing authority (CANONICAL).
-- STATUS: APPLIED TO STAGING + VERIFIED ON STAGING (2026-09-28). NOT FOR PRODUCTION.
-- Runtime proof: as planner, a real-UI payload with tampered total=1 now recomputes
-- to 236000 (was 1 pre-fix); money-attack regression passed; W15B-02 VERIFY passed.
-- ----------------------------------------------------------------------------
-- WHY: phase99 helm_quote_total() only recomputes when the pricing jsonb has a
-- TOP-LEVEL `subtotal`. The shipping UI payload (quotes.html gatherPricing /
-- flow.html saveQuotation) nests subtotal under `computed` and sends a top-level
-- client `total`, so the server trusted the client total verbatim (W15-001).
--
-- FIX: recompute the total from the CANONICAL RAW INPUTS the UI already sends
-- (chairs, chairPrice, guests, platePrice, other, catering{mode,amount},
-- serviceChargePct, discount, discountPct, coupon{kind,value}, gstPct), mirroring
-- store-api.js `_canon`/`quoteTotal` EXACTLY (locked rules D1/D4/D5/D7). Proven
-- rupee-equivalent to the shipping engine across 405 cases by
-- test/pricing-differential.test.mjs. The client-supplied `total`/`computed` are
-- NEVER trusted. Legacy top-level-`subtotal` payloads keep the phase99 behavior.
--
-- Additive & idempotent (CREATE OR REPLACE). Forward-only. Preserves all data.
-- DO NOT edit already-applied historical migrations to deploy this. Run PRECHECK
-- first, then this UPGRADE on STAGING, then VERIFY. ROLLBACK restores phase99.
-- ============================================================================
begin;

-- Canonical total from RAW INPUTS (mirrors store-api.js _canon exactly).
create or replace function public.helm_quote_total_canonical(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
declare
  chairs numeric; chair_price numeric; guests numeric; plate_price numeric; other numeric;
  client_cater boolean; rental numeric; plate_sub numeric; catering_amt numeric;
  pre_svc numeric; svc_pct numeric; service_charge numeric; subtotal numeric;
  disc_fixed numeric; disc_pct numeric; discount numeric;
  coupon jsonb; c_kind text; c_val numeric; taxed numeric; gp numeric; gst numeric;
begin
  chairs      := coalesce((p->>'chairs')::numeric, 0);
  chair_price := coalesce((p->>'chairPrice')::numeric, 0);
  guests      := coalesce((p->>'guests')::numeric, 0);
  plate_price := coalesce((p->>'platePrice')::numeric, 0);
  other       := coalesce((p->>'other')::numeric, 0);
  svc_pct     := coalesce((p->>'serviceChargePct')::numeric, 0);
  disc_fixed  := coalesce((p->>'discount')::numeric, 0);
  disc_pct    := coalesce((p->>'discountPct')::numeric, 0);
  gp          := coalesce((p->>'gstPct')::numeric, 0);
  client_cater := coalesce(p->'catering'->>'mode', 'inhouse') = 'client';

  rental      := chairs * chair_price + other;
  plate_sub   := case when client_cater then 0 else guests * plate_price end;
  catering_amt:= case when client_cater then 0 else coalesce((p->'catering'->>'amount')::numeric, 0) end;
  pre_svc     := rental + plate_sub + catering_amt;

  -- reject negative components (fail closed, matches phase99 intent)
  if chairs<0 or chair_price<0 or guests<0 or plate_price<0 or other<0
     or svc_pct<0 or disc_fixed<0 or disc_pct<0 or gp<0 then
    raise exception 'pricing components cannot be negative' using errcode='22003';
  end if;

  service_charge := pre_svc * svc_pct / 100;
  subtotal       := pre_svc + service_charge;

  discount := disc_fixed + subtotal * disc_pct / 100;
  coupon := p->'coupon';
  if coupon is not null and jsonb_typeof(coupon)='object' and (coupon ? 'value') then
    c_kind := coupon->>'kind';
    c_val  := coalesce((coupon->>'value')::numeric, 0);
    if c_kind = 'percent' then discount := discount + subtotal * c_val / 100;
    else discount := discount + c_val; end if;
  end if;
  discount := least(greatest(0, discount), subtotal);   -- D4 cap

  taxed := greatest(0, subtotal - discount);            -- D1 GST on post-discount
  gst   := taxed * gp / 100;                            -- D5 single rate
  return round(taxed + gst);                            -- D7 round final only
end $fn$;
revoke all on function public.helm_quote_total_canonical(jsonb) from anon;
grant execute on function public.helm_quote_total_canonical(jsonb) to authenticated;

-- True authority: canonical raw recompute; else legacy top-level-subtotal; else
-- (unknown shape) unchanged coalesce. NEVER derives from client `computed`/`total`.
create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return coalesce((p->>'total')::numeric, 0);
  end if;
  -- shipping payload carries raw inputs (gstPct + at least one item/catering key)
  if (p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice') then
    return public.helm_quote_total_canonical(p);
  end if;
  -- legacy/test payload with a precomputed top-level subtotal (phase99 path)
  if p ? 'subtotal' then
    declare sub numeric; disc numeric; gp numeric; taxed numeric;
    begin
      sub := coalesce((p->>'subtotal')::numeric,0); disc := coalesce((p->>'discount')::numeric,0);
      gp := coalesce((p->>'gstPct')::numeric,18);
      if sub<0 or disc<0 or gp<0 then raise exception 'pricing components cannot be negative' using errcode='22003'; end if;
      disc := least(disc, sub); taxed := greatest(0, sub-disc);
      return round(taxed * (1 + gp/100));
    end;
  end if;
  return coalesce((p->>'total')::numeric, 0);
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- Trigger: overwrite total whenever we can derive it (raw OR legacy subtotal).
create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object'
     and ( (new.pricing ? 'gstPct' and (new.pricing ? 'chairs' or new.pricing ? 'guests'
            or new.pricing ? 'other' or new.pricing ? 'catering' or new.pricing ? 'platePrice'))
           or (new.pricing ? 'subtotal') ) then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;

drop trigger if exists quotes_enforce_pricing_total on public.quotes;
create trigger quotes_enforce_pricing_total
  before insert or update of pricing on public.quotes
  for each row execute function public.enforce_pricing_total();

-- save_quotation_version: server total is authoritative; stamp it into the row.
create or replace function public.save_quotation_version(p_quote uuid, p_pricing jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $sv$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);               -- authoritative
  if p_pricing is not null and jsonb_typeof(p_pricing)='object' then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));   -- never keep client total
  end if;
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $sv$;
revoke all on function public.save_quotation_version(uuid,jsonb) from anon;
grant execute on function public.save_quotation_version(uuid,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ===================== supabase/wave15b/W15B-04-TOKEN-AND-RETENTION.sql =====================
-- ============================================================================
-- W15B-04-TOKEN-AND-RETENTION.sql — Cloudflare-audit CONFIRMED findings.
-- STATUS: APPLIED TO STAGING (2026-09-28). NOT FOR PRODUCTION.
-- Adds work_tokens.expires_at/revoked_at + revoke_work_token + guarded delete_quote
-- (both confirmed present on staging). Enforcement of the columns inside the four
-- worker_* RPCs is completed by W15B-05-FOLLOWUP.sql.
-- Additive & idempotent, forward-only. Apply on staging then re-run the audit
-- (run-2) + E2E. Money/security-critical — review before applying.
-- ============================================================================
begin;

-- CF tokens/worker-token-no-expiry-no-revocation --------------------------------
alter table public.work_tokens add column if not exists expires_at  timestamptz;
alter table public.work_tokens add column if not exists revoked_at  timestamptz;

create or replace function public.revoke_work_token(p_quote_id uuid, p_phone text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.work_tokens set revoked_at = now()
    where quote_id = p_quote_id and phone = p_phone;
end $$;
revoke all on function public.revoke_work_token(uuid,text) from anon;
grant execute on function public.revoke_work_token(uuid,text) to authenticated;

-- NOTE: the four worker_* RPCs (worker_get_tasks/worker_respond/worker_get_equipment/
-- worker_checkin_equipment) must add to their work_tokens lookup:
--   and (expires_at is null or expires_at > now()) and revoked_at is null
-- Those bodies live in operations.sql/phase52 and are re-created there; apply the
-- guarded versions in a companion forward-only migration so a base re-run cannot
-- drop the guard (tracked with CF deploy/legacy-base-files note).

-- CF tokens/portal-proposal-ignore-token-expiry --------------------------------
-- public_get_portal and public_get_proposal must mirror the sibling expiry guard
-- used by public_get_quote/request_otp/verify_and_consent/create_payment:
--   ... where approval_token = p_token
--       and (approval_token_expires_at is null or approval_token_expires_at > now())
-- (Re-create the two functions with the added predicate here once reviewed; left as
-- an explicit TODO rather than a blind rewrite because these are client-facing reads.)

-- CF data-lifecycle/quote-delete-cascades-financial-and-consent ----------------
-- Prevent silent destruction of the financial ledger + signed consent when a quote
-- is deleted. Recommended: a guarded delete_quote RPC that refuses when paid rows
-- exist, plus tightening the FKs from CASCADE to RESTRICT for financial/consent
-- children. FK changes are schema-altering and MUST be validated on staging first:
--   alter table public.quote_payments  drop constraint <fk>, add ... on delete restrict;
--   alter table public.quote_consents  drop constraint <fk>, add ... on delete restrict;
-- Left as reviewed TODO (constraint names vary; capture them from staging PRECHECK).
create or replace function public.delete_quote(p_quote_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.can_delete() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  if exists (select 1 from public.quote_payments where quote_id = p_quote_id and status = 'paid') then
    raise exception 'cannot delete a quote with recorded payments' using errcode='23503';
  end if;
  delete from public.quotes where id = p_quote_id and org_id = public.current_org_id();
end $$;
revoke all on function public.delete_quote(uuid) from anon;
grant execute on function public.delete_quote(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ===================== supabase/wave15b/W15B-05-FOLLOWUP.sql =====================
-- ============================================================================
-- W15B-05-FOLLOWUP.sql — closes the remaining audit items after W15B-01/04.
-- STATUS: APPLIED TO STAGING + VERIFIED ON STAGING (2026-09-28). NOT FOR PRODUCTION.
-- Runtime proof: worker_get_tasks -> 401/42501 after revoke_work_token and when
-- expires_at is past; service_role DELETE of a quote with a payment -> 409/23503
-- (FK RESTRICT); OTP/portal/proposal functions re-created cleanly.
-- Faithful CREATE OR REPLACE of the CURRENT deployed bodies (operations.sql +
-- phase52 + phase53 + phase93 + otp-payments.sql) with the minimal guard added,
-- so no later enhancement is reverted. Additive & idempotent. Requires W15B-04
-- (work_tokens.expires_at/revoked_at) applied first.
-- ============================================================================
begin;

-- 1) OTP CSPRNG (STRIX-001): replace random() with pgcrypto gen_random_bytes -----
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean; b bytea;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- CSPRNG 6-digit code (crypto bytes, not random()); no fixed PIN.
  b := extensions.gen_random_bytes(3);
  code := lpad(((get_byte(b,0)::bigint*65536 + get_byte(b,1)*256 + get_byte(b,2)) % 1000000)::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $$;

-- 2) Worker RPCs: enforce expires_at/revoked_at (CF worker-token finding) --------
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_date',q.event_date,'event_time',q.event_time),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone),
    'tasks', tasks);
end; $$;

create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into tsk from public.event_tasks where id=p_task_id and quote_id=w.quote_id and assignee_phone=w.phone;
  if tsk.id is null then raise exception 'task not found'; end if;
  newst := case p_action
    when 'accept'   then 'accepted'
    when 'reject'   then 'rejected'
    when 'start'    then 'in_progress'
    when 'complete' then 'completed'
    else null end;
  if newst is null then raise exception 'invalid action'; end if;
  if p_action='start'    and tsk.status not in ('accepted','assigned') then raise exception 'accept the task first'; end if;
  if p_action='complete' and tsk.status not in ('in_progress','accepted') then raise exception 'start the task first'; end if;
  update public.event_tasks set status=newst,
    responded_at = case when p_action in ('accept','reject') then now() else responded_at end,
    started_at   = case when p_action='start'    then now() else started_at end,
    completed_at = case when p_action='complete' then now() else completed_at end
    where id=p_task_id;
  perform public._notify(w.quote_id,'sms',null,'task_'||p_action, jsonb_build_object('task',tsk.title,'worker',w.name));
  return jsonb_build_object('ok',true,'status',newst);
end; $$;

create or replace function public.worker_get_equipment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; items jsonb; digits text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', i.name, 'unit', i.unit,
           'qty_out', c.qty_out, 'qty_in', c.qty_in, 'status', c.status
         ) order by i.name), '[]'::jsonb) into items
    from public.inventory_checkouts c
    join public.inventory_items i on i.id = c.item_id
    join public.crew_members cm on cm.id = c.issued_to_id
   where c.quote_id = w.quote_id
     and c.status in ('out','partial')
     and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits;
  return jsonb_build_object('equipment', items);
end; $$;

create or replace function public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  if w.revoked_at is not null or (w.expires_at is not null and w.expires_at <= now()) then raise exception 'link expired or revoked' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $$;

-- 3) Portal/proposal: honour token expiry (CF portal-proposal finding) ----------
create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());   -- CF: honour expiry
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $$;

-- add an optional share-token expiry to proposals (nullable = no expiry) + guard
alter table public.event_proposal add column if not exists share_token_expires_at timestamptz;
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal
    where share_token = p_token and published = true
      and (share_token_expires_at is null or share_token_expires_at > now());       -- CF: honour expiry
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $$;

-- 4) Protect the financial/consent ledger from cascade delete (HLM-DEL-01) ------
-- Swap ONLY the financial + consent children's FK to quotes from CASCADE to
-- RESTRICT (other children like tasks/plan legitimately still cascade). Dynamic
-- so it works regardless of the constraint's generated name.
do $$
declare r record;
begin
  for r in
    select con.conname, cl.relname as child
      from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_class pcl on pcl.oid = con.confrelid
     where con.contype='f' and pcl.relname='quotes'
       and cl.relname in ('quote_payments','quote_consents')
       and con.confdeltype='c'   -- currently ON DELETE CASCADE
  loop
    execute format('alter table public.%I drop constraint %I', r.child, r.conname);
    execute format('alter table public.%I add constraint %I foreign key (quote_id) references public.quotes(id) on delete restrict', r.child, r.conname);
    raise notice 'FK % on % -> ON DELETE RESTRICT', r.conname, r.child;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- ===================== supabase/wave15b/W15B-06-PRICING-HARDEN.sql =====================
-- ============================================================================
-- W15B-06-PRICING-HARDEN.sql — close the residual W15-001 bypass.
-- STATUS: APPLIED + RUNTIME-VERIFIED ON STAGING (xizehqgeyjcfpzrdymly) 2026-09-28.
--   Verified: unshaped {total:999999} rejected (errcode 22023) at RPC, PostgREST (HTTP 400),
--   and table trigger (rejects even owner UPDATE); RLS denies planner direct PATCH (0 rows);
--   legit raw payload still computes 236000, legacy subtotal still 118000. Stored total held at 59000.
-- STAGING ONLY. NOT FOR PRODUCTION (until reviewed).
-- ----------------------------------------------------------------------------
-- Gap (runtime-confirmed): a pricing jsonb carrying a top-level `total` but NO
-- derivable shape (no gstPct+item/catering key, no top-level `subtotal`) fell
-- through to `coalesce(p->>'total')`, so an authenticated caller could persist an
-- arbitrary total by omitting gstPct. Fix: reject a client `total` that has no
-- computable shape, and make the trigger engage for that case too. Additive/idempotent.
-- ============================================================================
begin;

create or replace function public.helm_quote_total(p jsonb)
returns numeric language plpgsql immutable set search_path = public, pg_temp as $fn$
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return 0;
  end if;
  -- shipping payload carries raw inputs
  if (p ? 'gstPct') and (p ? 'chairs' or p ? 'guests' or p ? 'other' or p ? 'catering' or p ? 'platePrice') then
    return public.helm_quote_total_canonical(p);
  end if;
  -- legacy/test payload with a precomputed top-level subtotal
  if p ? 'subtotal' then
    declare sub numeric; disc numeric; gp numeric; taxed numeric;
    begin
      sub := coalesce((p->>'subtotal')::numeric,0); disc := coalesce((p->>'discount')::numeric,0);
      gp := coalesce((p->>'gstPct')::numeric,18);
      if sub<0 or disc<0 or gp<0 then raise exception 'pricing components cannot be negative' using errcode='22003'; end if;
      disc := least(disc, sub); taxed := greatest(0, sub-disc);
      return round(taxed * (1 + gp/100));
    end;
  end if;
  -- unknown shape: a client-supplied total here cannot be trusted -> reject.
  if p ? 'total' then
    raise exception 'a pricing total without a computable shape (gstPct+items or subtotal) is not accepted' using errcode='22023';
  end if;
  return 0;
end $fn$;
revoke all on function public.helm_quote_total(jsonb) from anon;
grant execute on function public.helm_quote_total(jsonb) to authenticated;

-- Trigger also engages when only a client `total` is present, so a direct
-- quotes.pricing write can't smuggle it past (helm_quote_total will reject).
create or replace function public.enforce_pricing_total()
returns trigger language plpgsql set search_path = public, pg_temp as $tg$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object'
     and ( (new.pricing ? 'gstPct' and (new.pricing ? 'chairs' or new.pricing ? 'guests'
            or new.pricing ? 'other' or new.pricing ? 'catering' or new.pricing ? 'platePrice'))
           or (new.pricing ? 'subtotal') or (new.pricing ? 'total') ) then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $tg$;

notify pgrst, 'reload schema';
commit;

-- ===================== supabase/wave16/W16-02-MANAGER-AUTHORITY.sql =====================
-- ============================================================================
-- W16-02-MANAGER-AUTHORITY.sql — product decision: Manager (Event Manager) may
-- create, settle, and close quotes. Adds 'manager' to can_create() (create) and
-- can_edit() (settlement/closure/payments gate on can_edit). Resolves the W15-002
-- can_edit/has_area divergence in favour of granting manager authority.
-- Additive, idempotent. can_delete() is NOT changed (manager still cannot delete).
-- ============================================================================
create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','manager'), false); $$;

create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid())
    in ('admin','planner','sales','operations','manager'), false); $$;

-- ===================== supabase/wave16/W16-03-NO-OVERPAYMENT.sql =====================
-- ============================================================================
-- W16-03-NO-OVERPAYMENT.sql — reject a payment that pushes total paid beyond the
-- quote total. Implemented as a BEFORE INSERT trigger on quote_payments so it
-- covers EVERY insert path (record_payment RPC, milestones, direct). Additive,
-- idempotent. Skips the guard when the quote total is unknown/0 (can't compute).
-- 0.5 epsilon absorbs rupee rounding. Errcode 23514 (check_violation).
-- ============================================================================
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric, 0) into v_total from public.quotes where id = new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;      -- unknown total → don't block
  select coalesce(sum(amount),0) into v_paid from public.quote_payments
    where quote_id = new.quote_id and status = 'paid'
      and id is distinct from new.id;
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert on public.quote_payments
  for each row execute function public.enforce_no_overpayment();

-- ===================== supabase/wave16/W16-01-INPUT-INTEGRITY.sql =====================
-- ============================================================================
-- W16-01-INPUT-INTEGRITY.sql — data-layer backstop for the Wave 16 input-
-- hardening pass. Additive, idempotent CHECK constraints so invalid numerics can
-- never reach the database even via a crafted request that bypasses the UI.
-- STATUS: APPLIED + VERIFIED ON STAGING (xizehqgeyjcfpzrdymly) 2026-09-28.
--   Pre-check found 0 violating rows (inventory_items.total_qty/unit_cost < 0,
--   quote_payments.amount < 0), so the constraints validate cleanly.
--   Verified at runtime: negative total_qty and negative payment amount are both
--   rejected (check_violation).
-- NOT FOR PRODUCTION until reviewed. Pair with the client hardener in
-- public/store-api.js (BPStore.validate + the global input[type=number] guard).
-- ============================================================================
-- PRODUCTION PRE-CLEAN: production held invalid rows (negative stock/cost — corrupt
-- data). Clamp them to 0 so the CHECK constraints validate. Safe + idempotent.
update public.inventory_items set total_qty = 0 where total_qty < 0;
update public.inventory_items set unit_cost = 0 where unit_cost is not null and unit_cost < 0;

do $$
declare bad_pay int;
begin
  -- inventory constraints (data is clamped above → these validate cleanly)
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_total_qty_nonneg') then
    alter table public.inventory_items add constraint inventory_items_total_qty_nonneg check (total_qty >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_unit_cost_nonneg') then
    alter table public.inventory_items add constraint inventory_items_unit_cost_nonneg check (unit_cost is null or unit_cost >= 0);
  end if;
  -- quote_payments: do NOT auto-delete payment rows. Add the constraint only if the
  -- data is clean; otherwise skip with a NOTICE so the whole apply doesn't abort.
  select count(*) into bad_pay from public.quote_payments where amount <= 0;
  if not exists (select 1 from pg_constraint where conname = 'quote_payments_amount_pos') then
    if bad_pay = 0 then
      alter table public.quote_payments add constraint quote_payments_amount_pos check (amount > 0);
    else
      raise notice 'SKIPPED quote_payments_amount_pos: % row(s) have amount <= 0. Review those payment rows, then add the constraint manually.', bad_pay;
    end if;
  end if;
end $$;


-- ===================== supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql =====================
-- ============================================================================
-- W16-04-OVERPAYMENT-UNIFIED.sql — close the settlement-path overpayment gap.
-- "Money received" is tracked in TWO tables: quote_payments (flow advance/receipts)
-- and payment_milestones with status='paid' (settlement "Record payment"). W16-03
-- only guarded quote_payments, so overpayment via the Settlement screen slipped
-- through. This enforces ONE invariant across BOTH tables:
--   sum(paid quote_payments) + sum(paid payment_milestones) <= quote total (+0.5).
-- Additive, idempotent. Skips when the quote total is unknown/0. Errcode 23514.
-- ============================================================================
create or replace function public.helm_total_paid(p_quote uuid, p_excl_qp uuid, p_excl_pm uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select sum(amount) from public.quote_payments
                    where quote_id=p_quote and status='paid' and id is distinct from p_excl_qp),0)
       + coalesce((select sum(amount) from public.payment_milestones
                    where quote_id=p_quote and status='paid' and id is distinct from p_excl_pm),0);
$$;

-- quote_payments guard (INSERT)
create or replace function public.enforce_no_overpayment() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, new.id, null);
  if (v_paid + new.amount) > v_total + 0.5 then
    raise exception 'payment of % exceeds the outstanding balance (already paid %, quote total %)',
      new.amount, v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

-- payment_milestones guard (INSERT or UPDATE, only when the row is/*becomes* paid)
create or replace function public.enforce_no_overpayment_ms() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_total numeric; v_paid numeric;
begin
  if new.status is distinct from 'paid' then return new; end if;
  select coalesce((pricing->>'total')::numeric,0) into v_total from public.quotes where id=new.quote_id;
  if v_total is null or v_total <= 0 then return new; end if;
  v_paid := public.helm_total_paid(new.quote_id, null, new.id);
  if (v_paid + coalesce(new.amount,0)) > v_total + 0.5 then
    raise exception 'this payment of % exceeds the outstanding balance (already paid %, quote total %)',
      coalesce(new.amount,0), v_paid, v_total using errcode='23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_no_overpayment on public.quote_payments;
create trigger trg_no_overpayment before insert on public.quote_payments
  for each row execute function public.enforce_no_overpayment();

drop trigger if exists trg_no_overpayment_ms on public.payment_milestones;
create trigger trg_no_overpayment_ms before insert or update on public.payment_milestones
  for each row execute function public.enforce_no_overpayment_ms();
