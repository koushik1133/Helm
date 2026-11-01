-- 0321_r112_reprice_money.sql - CANONICAL forward-only. R112 (staging trial test, HIGH money bugs).
-- REQUIRES 0052 (consent_stale), 0110 (helm_invoice_total), 0198 (_a49_close_blockers), 0264 (payment schedules),
--          0282 (_r282_event_closed), 0304 (save_quotation_version), 0311 (_r311_app_call).
--
-- In plain words:
--   Saving a floor layout re-priced an already sent / approved quote (200 -> 150 guests, Rs 1,82,310 -> Rs 1,41,010)
--   with NO new quotation version, and afterwards the money screens disagreed: the payment schedule rows and its
--   "Outstanding" still used the old total, the closure page used the new one.
--   1) A NEW quotation version is kept for EVERY price change of a sent / approved / confirmed quote. When an app call
--      changes quotes.pricing total on such a quote and the newest quotation version does not have that total, the
--      database writes the next Q-version (same as "Save quotation"), so the client's approved figure and the new one
--      are both on record. save_quotation_version already writes its version first, so nothing is doubled.
--      (The consent_stale rule from 0052 is unchanged: a changed price after approval still needs a new approval.)
--   2) ONE outstanding figure. payment_schedule_for_quote (re-issued, same signature + grants) now reports
--      'outstanding' = the closure balance (close_event_blockers balance_owed = invoice total - payments), so the
--      schedule card, the event page and the closure page say the same number. It also reports 'mismatch' (the
--      template schedule's rows no longer add up to the invoice total) with 'scheduled' / 'total', and 'can_resync'.
--   3) The schedule follows the price. NEW RPC payment_schedule_resync(quote) (Finance edit, own studio, event not
--      closed): the OPEN payments (due / invoiced; paid and waived ones are never touched) are re-split in the same
--      proportions so the schedule adds up to the current invoice total again (whole rupees, the last open payment
--      takes the rounding), then money already received covers payments in order (0264 rule). Every resync writes one
--      audit_log row with the old and new amounts. It also runs automatically when the client approves the new
--      price (approval_status -> approved / paid) for a schedule made from a template (a hand-made schedule is never
--      changed automatically, the 0264 rule) - never blocking the approval (problems are a warning only).
--      When the new total is not more than what is already scheduled as paid, nothing is changed (flag only).
-- ZERO DATA LOSS: no table / column / row / policy / index deleted. Existing milestone rows change only their
-- 'amount' (open rows only, audited with the old values) through the resync; quotation_versions only gains rows.
-- payment_schedule_for_quote keeps every key it returned (outstanding is now the canonical balance).
-- Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop trigger zzzz_r321_reprice_version on public.quotes;
--   drop trigger zzzz_r321_resync_on_approval on public.quotes; re-run the 0264 payment_schedule_for_quote body;
--   revoke execute on function public.payment_schedule_resync(uuid) from authenticated;

-- ---- 0) preflight -----------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.quotes') is null or to_regclass('public.quotation_versions') is null
     or to_regclass('public.payment_milestones') is null or to_regclass('public.quote_payments') is null then
    raise exception 'STOP 0321: quotes / quotation_versions / payment_milestones / quote_payments missing'; end if;
  if to_regprocedure('public.helm_invoice_total(uuid)') is null then raise exception 'STOP 0321: run 0110 first'; end if;
  if to_regprocedure('public._a49_close_blockers(uuid)') is null then raise exception 'STOP 0321: run 0198 first'; end if;
  if to_regprocedure('public._pst_allocate(uuid)') is null or to_regprocedure('public._pst_today(uuid)') is null then
    raise exception 'STOP 0321: run 0264 first'; end if;
  if to_regprocedure('public._r282_event_closed(uuid)') is null then raise exception 'STOP 0321: run 0282 first'; end if;
  if to_regprocedure('public._r311_app_call()') is null then raise exception 'STOP 0321: run 0311 first'; end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'consent_stale' and not attisdropped) then
    raise exception 'STOP 0321: run 0052 first (consent_stale)'; end if;
end $$;

-- ---- 1) a price change of a committed quote always keeps a quotation version ------------------------------------
create or replace function public._r321_num(p jsonb)
returns numeric language sql immutable set search_path = '' as $$
  -- r112-0321: a pricing total as a number (null when missing / not numeric)
  select case when p is not null and btrim(coalesce(p #>> '{}', '')) ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$'
              then btrim(p #>> '{}')::numeric end;
$$;

create or replace function public._r321_tg_reprice_version()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r112-0321: sent / approved / confirmed quote re-priced through the app -> the next Q-version, unless the newest
-- version already has this total (save_quotation_version writes its version before it updates the quote)
declare v_new numeric; v_old numeric; v_last numeric; n integer;
begin
  if not public._r311_app_call() then return null; end if;
  if coalesce(new.is_demo, false) or new.deleted_at is not null then return null; end if;
  if not (coalesce(old.approval_status, '') in ('sent', 'viewed', 'approved', 'paid')
          or coalesce(old.status, '') = 'confirmed' or coalesce(old.consent_stale, false)) then return null; end if;
  v_new := public._r321_num(new.pricing -> 'total');
  v_old := public._r321_num(old.pricing -> 'total');
  if v_new is null or v_new <= 0 or v_new is not distinct from v_old then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:qv:' || new.id::text, 0));
  select v.total into v_last from public.quotation_versions v where v.quote_id = new.id
   order by v.created_at desc, v.label desc limit 1;
  if v_last is not null and abs(v_last - v_new) <= 0.005 then return null; end if;
  select count(*) + 1 into n from public.quotation_versions where quote_id = new.id;
  insert into public.quotation_versions(org_id, quote_id, label, pricing, total, created_by)
    values (new.org_id, new.id, 'Q' || n, new.pricing, v_new, auth.uid());
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'quote.reprice_version', 'quotes', new.id::text, new.id,
            jsonb_build_object('label', 'Q' || n, 'from', v_old, 'to', v_new), new.org_id);
  return null;
exception when others then
  raise warning 'r112-0321: quotation version not kept (% %)', sqlstate, sqlerrm;
  return null;
end $$;
revoke all on function public._r321_tg_reprice_version() from public;
revoke all on function public._r321_num(jsonb) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r321_tg_reprice_version() from %I', r);
      execute format('revoke all on function public._r321_num(jsonb) from %I', r);
    end if;
  end loop;
end $$;
drop trigger if exists zzzz_r321_reprice_version on public.quotes;
create trigger zzzz_r321_reprice_version after update of pricing on public.quotes
  for each row execute function public._r321_tg_reprice_version();

-- ---- 2) the schedule follows the price (open payments re-split, audited) ----------------------------------------
create or replace function public._r321_resync(p_quote uuid, p_source text, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r112-0321: re-split the OPEN milestones (due / invoiced) so the schedule adds up to the invoice total again.
-- Paid / waived rows are never touched. -> {changed, reason?, total, scheduled, rows?}
declare v_org uuid; v_total numeric; v_paidms numeric; v_waived numeric; v_open numeric; v_target numeric; v_n integer;
  m record; i integer := 0; v_amt numeric; v_run numeric := 0; v_old jsonb := '[]'::jsonb; v_new jsonb := '[]'::jsonb; v_cov integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select q.org_id into v_org from public.quotes q where q.id = p_quote;
  if v_org is null then return jsonb_build_object('changed', false, 'reason', 'no_event'); end if;
  v_total := coalesce(public.helm_invoice_total(p_quote), 0);
  select coalesce(sum(amount) filter (where status = 'paid'), 0), coalesce(sum(amount) filter (where status = 'waived'), 0),
         coalesce(sum(amount) filter (where status in ('due', 'invoiced')), 0), count(*) filter (where status in ('due', 'invoiced') and coalesce(amount, 0) > 0)
    into v_paidms, v_waived, v_open, v_n
    from public.payment_milestones where quote_id = p_quote;
  if v_n = 0 then return jsonb_build_object('changed', false, 'reason', 'nothing_open', 'total', v_total, 'scheduled', v_paidms + v_open); end if;
  if v_total <= 0 then return jsonb_build_object('changed', false, 'reason', 'no_total', 'total', v_total, 'scheduled', v_paidms + v_open); end if;
  v_target := round(v_total - v_paidms, 2);
  if abs(v_target - v_open) <= 0.5 then return jsonb_build_object('changed', false, 'reason', 'in_step', 'total', v_total, 'scheduled', v_paidms + v_open); end if;
  if v_target < v_n then return jsonb_build_object('changed', false, 'reason', 'below_paid', 'total', v_total, 'scheduled', v_paidms + v_open); end if;
  for m in select pm.id, pm.label, pm.amount from public.payment_milestones pm
            where pm.quote_id = p_quote and pm.status in ('due', 'invoiced') and coalesce(pm.amount, 0) > 0
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    i := i + 1;
    if i < v_n then v_amt := greatest(round(m.amount * v_target / v_open), 1);
    else v_amt := round(v_target - v_run, 2); end if;
    if v_amt <= 0 then
      raise exception 'r112-0321: the open payments can not be re-split' using errcode = '22023';
    end if;
    v_run := v_run + v_amt;
    v_old := v_old || jsonb_build_array(jsonb_build_object('id', m.id, 'label', m.label, 'amount', m.amount));
    v_new := v_new || jsonb_build_array(jsonb_build_object('id', m.id, 'label', m.label, 'amount', v_amt));
    update public.payment_milestones set amount = v_amt where id = m.id;
  end loop;
  begin v_cov := public._pst_allocate(p_quote);
  exception when others then v_cov := 0; raise warning 'r112-0321: milestone cover skipped (%)', sqlstate;
  end;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (p_actor, 'payment_schedule.resynced', 'quotes', p_quote::text, p_quote,
            jsonb_build_object('source', p_source, 'total', v_total, 'scheduled_before', v_paidms + v_open,
                               'old', v_old, 'new', v_new, 'covered', v_cov), v_org);
  return jsonb_build_object('changed', true, 'total', v_total, 'scheduled', v_paidms + v_run, 'rows', v_new, 'covered', v_cov);
end $$;
revoke all on function public._r321_resync(uuid, text, uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r321_resync(uuid, text, uuid) from %I', r); end if;
  end loop;
end $$;

-- staff: "Re-split the open payments" (Finance edit, own studio, event not closed)
create or replace function public.payment_schedule_resync(p_quote uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r112-0321
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'event not found' using errcode = '42501'; end if;
  if not public.has_area('finance', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._r282_event_closed(p_quote) then
    raise exception 'This event is closed - re-open it first.' using errcode = '42501'; end if;
  return public._r321_resync(p_quote, 'manual', auth.uid());
end $$;
revoke all on function public.payment_schedule_resync(uuid) from public;
do $$ declare r text; begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.payment_schedule_resync(uuid) from anon'; end if;
  foreach r in array array['authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.payment_schedule_resync(uuid) to %I', r); end if;
  end loop;
end $$;

-- automatic: the client approved the (new) price -> the open payments follow it
create or replace function public._r321_tg_resync_on_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r112-0321: never blocks the approval - any problem is a warning
begin
  begin
    if not (coalesce(new.approval_status, '') in ('approved', 'paid') and coalesce(old.approval_status, '') not in ('approved', 'paid')) then return null; end if;
    if coalesce(new.is_demo, false) or new.deleted_at is not null or coalesce(new.status, '') = 'cancelled' then return null; end if;
    if not exists (select 1 from public.payment_milestones m where m.quote_id = new.id) then return null; end if;
    -- only a schedule made from a template (it is meant to add up to the total); a hand-made one is never changed (0264)
    if not exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = new.id and p.applied_at is not null) then return null; end if;
    if public._r282_event_closed(new.id) then return null; end if;
    perform public._r321_resync(new.id, 'reapproval', auth.uid());
  exception when others then raise warning 'r112-0321: schedule resync skipped (% %)', sqlstate, sqlerrm;
  end;
  return null;
end $$;
revoke all on function public._r321_tg_resync_on_approval() from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._r321_tg_resync_on_approval() from %I', r); end if;
  end loop;
end $$;
drop trigger if exists zzzz_r321_resync_on_approval on public.quotes;
create trigger zzzz_r321_resync_on_approval after update of approval_status on public.quotes
  for each row execute function public._r321_tg_resync_on_approval();

-- ---- 3) one outstanding figure: payment_schedule_for_quote = 0264 body + canonical outstanding + mismatch ------------
create or replace function public.payment_schedule_for_quote(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r112-0321: 0264 body; 'outstanding' = close_event_blockers balance_owed (invoice total - payments), the one figure
-- every money screen shows; + 'mismatch' (schedule rows no longer add up to the invoice total) + 'can_resync'
declare v_org uuid := public.current_org_id(); q public.quotes; v_today date; v_paid numeric; v_left numeric; v_total numeric;
  m record; v_rows jsonb := '[]'::jsonb; v_take numeric; v_rem numeric; v_state text; pr public.payment_schedule_quote_prefs;
  v_cfg jsonb; v_next jsonb; v_sched numeric := 0; v_owed numeric; v_n integer := 0;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'event not found' using errcode = '42501'; end if;
  if not public.has_area('finance', 'view') then raise exception 'not authorized' using errcode = '42501'; end if;
  v_today := public._pst_today(v_org);
  v_total := public.helm_invoice_total(q.id);
  select coalesce(sum(qp.amount), 0) into v_paid from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid';
  v_left := greatest(v_paid - coalesce((select sum(pm.amount) from public.payment_milestones pm where pm.quote_id = q.id and pm.status = 'paid'), 0), 0);
  for m in select pm.* from public.payment_milestones pm where pm.quote_id = q.id
            order by pm.due_date nulls last, pm.seq, pm.created_at, pm.id loop
    v_n := v_n + 1;
    if m.status <> 'waived' then v_sched := v_sched + coalesce(m.amount, 0); end if;
    if m.status = 'paid' then v_take := coalesce(m.amount, 0); v_rem := 0; v_state := 'paid';
    elsif m.status = 'waived' then v_take := 0; v_rem := 0; v_state := 'waived';
    else
      v_take := least(greatest(coalesce(m.amount, 0), 0), v_left); v_left := v_left - v_take;
      v_rem := round(greatest(coalesce(m.amount, 0), 0) - v_take, 2);
      v_state := case when coalesce(m.amount, 0) > 0 and v_rem <= 0.005 then 'paid'
                      when m.due_date is not null and m.due_date < v_today then 'overdue'
                      when v_take > 0.005 then 'part_paid'
                      else m.status end;
    end if;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('id', m.id, 'seq', m.seq, 'label', m.label, 'due_date', m.due_date,
      'amount', m.amount, 'status', m.status, 'state', v_state, 'paid', round(v_take, 2), 'remaining', v_rem,
      'days', case when m.due_date is not null then m.due_date - v_today end, 'paid_at', m.paid_at));
    if v_next is null and v_state in ('due', 'invoiced', 'overdue', 'part_paid') then
      v_next := jsonb_build_object('id', m.id, 'label', m.label, 'due_date', m.due_date, 'remaining', v_rem, 'state', v_state);
    end if;
  end loop;
  -- the closure balance, word for word (invoice total - payments; under half a rupee = 0)
  v_owed := coalesce((public._a49_close_blockers(q.id) ->> 'balance_owed')::numeric, greatest(v_total - v_paid, 0));
  select * into pr from public.payment_schedule_quote_prefs x where x.quote_id = q.id;
  v_cfg := public._comms_cfg(v_org);
  return jsonb_build_object(
    'quote_id', q.id, 'code', q.code, 'currency', coalesce(public._comms_quote_cur(q.id), 'INR'),
    'event_date', q.event_date, 'today', v_today,
    'total', round(v_total, 2), 'paid', round(v_paid, 2), 'scheduled', round(v_sched, 2),
    'outstanding', round(v_owed, 2),
    'mismatch', (v_n > 0 and v_total > 0 and abs(v_sched - v_total) > 0.5 and pr.applied_at is not null),
    'can_resync', public.has_area('finance', 'edit') and not public._r282_event_closed(q.id),
    'rows', v_rows, 'next', v_next,
    'receipts', coalesce((select jsonb_agg(jsonb_build_object('receipt_no', qp.receipt_no, 'amount', qp.amount, 'method', qp.method,
                                                              'paid_at', coalesce(qp.paid_at, qp.created_at)) order by coalesce(qp.paid_at, qp.created_at))
                            from public.quote_payments qp where qp.quote_id = q.id and qp.status = 'paid'), '[]'::jsonb),
    'paused', coalesce(pr.reminders_paused, false), 'paused_at', pr.paused_at,
    'applied', case when pr.applied_at is not null then jsonb_build_object('at', pr.applied_at, 'source', pr.applied_source, 'template', pr.applied_template) end,
    'reminders', jsonb_build_object('enabled', (v_cfg ->> 'pay_enabled')::boolean,
      'before_days', (v_cfg ->> 'pay_before_days')::integer, 'on_due', (v_cfg ->> 'pay_on_due')::boolean,
      'every_days', (v_cfg ->> 'pay_every_days')::integer, 'max_overdue', (v_cfg ->> 'pay_max_overdue')::integer,
      'client_reachable', exists (select 1 from unnest(public._comms_channels(v_cfg, 'pay_channels')) c
                                   where public._comms_client_to(q.client, c, v_org) is not null)),
    'can_edit', public.has_area('finance', 'edit'),
    'can_pause', public.has_area('finance', 'edit') or public.has_area('quotes', 'edit'),
    'default_template', (public._pst_resolve(v_org, null)) ->> 'key',
    'templates', (select coalesce(jsonb_agg(jsonb_build_object('key', b ->> 'key', 'name', b ->> 'name')), '[]'::jsonb)
                    from jsonb_array_elements(public._pst_builtins()) b)
                 || coalesce((select jsonb_agg(jsonb_build_object('key', t.id::text, 'name', t.name) order by lower(t.name))
                                from public.payment_schedule_templates t where t.org_id = v_org and t.archived_at is null), '[]'::jsonb));
end $$;
revoke all on function public.payment_schedule_for_quote(uuid) from public;
do $$ declare r text; begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.payment_schedule_for_quote(uuid) from anon'; end if;
  foreach r in array array['authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.payment_schedule_for_quote(uuid) to %I', r); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
