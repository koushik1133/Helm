-- 0323_r114_trial_simulation.sql - CANONICAL forward-only. R114 (owner decision 2026-10-31): a FREE TRIAL studio is a
-- full SIMULATION - nothing real leaves Helm to a client.
--
-- In plain words:
--   A studio on a Helm free trial (active OR ended, and the sample master - the 0179 rule _tb179_no_send) never sends
--   anything real to a client or a third party: no e-mail, no WhatsApp, no SMS, no approval code (0322), no payment
--   link (0187). The owner still walks the whole flow and SEES what would happen, as previews, with a red
--   "Trial simulation" banner. Paid studios: nothing changes.
--
--   1) _tr212_email_ok(org) WRAPPED (house pattern: the 0212 body is kept as _tr212_email_ok__pre0323, app privileges
--      taken away): it now always answers false. That one switch turns OFF every 0212 "an active trial really e-mails
--      its client" path at once:
--        * client-mailer (approval / booklet link e-mail): trial_email_gate answers {allowed:false, trial:true} ->
--          the edge function answers status "test_mode" (nothing sent, a 'suppressed' / 'simulated' log row);
--        * booklet_send / event_site_send ("Send to client"): the outbox guard stores the row 'skipped' (free_trial)
--          - the row is the record of the simulated send; the dispatcher never hands it out (_tr212_claim_blocked);
--        * the approval code by e-mail (already off since 0322) and delivery reminders e-mailed to vendors (0241);
--        * my_trial_messaging() says email:false, so the app shows previews instead of "send".
--   2) NEW BEFORE INSERT trigger ab2_r323_trial_email_slot on trial_email_sends (0212 ledger): an app call can no
--      longer take ANY trial e-mail slot (0322 refused only 'otp') -> 42501 hint trial_no_send. Defence in depth: even
--      if (1) were ever undone, no trial e-mail can be counted, so none is allowed.
--   3) NEW table trial_sim_payments: a SIMULATED client payment in a trial (one row per milestone, or one per quote
--      when the quote has no schedule). test_mode is always true (check). It is NOT the money ledger: quote_payments /
--      payment_milestones are never written, no Razorpay call is ever made. RLS: the studio's own members read it;
--      nobody writes it except the RPC below. Purged with the studio's quotes by the trial data deletion (0184 list).
--   4) NEW public RPC public_trial_payment_sim(token) -> {simulation, approved, ended, can_pay, amount, currency, label,
--      paid, paid_at, receipt} for the approval page (anon; null for an unknown / expired / revoked / deleted /
--      cancelled link). Paid studio -> {simulation:false} only. No phone, e-mail, id or payment detail is exposed.
--   5) NEW public RPC trial_simulate_payment(token, client name, user agent): trial studio (active, client on the page
--      or the studio's own member), quote approved -> one trial_sim_payments row for the next open milestone (or the
--      quote total), audit_log 'payment.simulated' {test_mode:true, real_payment:false} -> {simulated:true, receipt
--      'TEST-...'}. Paid studio -> {simulated:false, error:'trial_only'}; ended trial -> 'trial_ended'; not approved ->
--      'not_approved'; nothing left to pay -> {simulated:true, already:true}. Idempotent per milestone.
--   6) NEW public RPC public_trial_simulation(kind, ref) -> {simulation:true|false} for the client pages (approve /
--      portal by approval token, booklet by booklet token, invitation site by slug) - shows the red banner. null for
--      an unknown link. Nothing else is returned.
--   7) NEW RPC trial_sim_payments_for_quote(quote) for the studio (own studio, signed in) -> the simulated payments.
-- No table / column / row / policy deleted; no existing function body lost (kept as __pre0323). Safe to run twice.
-- ASCII only. Goes after 0166 + 0179 + 0184 + 0212 + 0236 + 0260 + 0311 + 0322.
-- ROLLBACK (manual, only if ever needed; no data involved): drop function public._tr212_email_ok(uuid); alter function
-- public._tr212_email_ok__pre0323(uuid) rename to _tr212_email_ok; grant execute on it to service_role; drop trigger
-- ab2_r323_trial_email_slot on public.trial_email_sends. (The table, the RPCs and the audit rows can stay.)

do $$
begin
  if to_regclass('public.quotes') is null or to_regclass('public.client_booklets') is null or to_regclass('public.event_sites') is null
     or to_regclass('public.payment_milestones') is null or to_regclass('public.audit_log') is null then
    raise exception 'STOP 0323: quotes / client_booklets / event_sites / payment_milestones / audit_log missing'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0323: _tb179_no_send missing - run 0179 first'; end if;
  if to_regprocedure('public._trial_test_mode_ok(uuid)') is null or to_regprocedure('public._trial_client_skip_ok(uuid)') is null then
    raise exception 'STOP 0323: _trial_test_mode_ok / _trial_client_skip_ok missing - run 0128 + 0176 + 0236 first'; end if;
  if to_regprocedure('public._tr212_email_ok(uuid)') is null or to_regclass('public.trial_email_sends') is null
     or to_regprocedure('public.trial_email_gate(uuid,uuid,uuid,text,text)') is null then
    raise exception 'STOP 0323: 0212 (trial e-mail gate) missing - run 0212 first'; end if;
  if to_regprocedure('public._r322_trial_quote(uuid)') is null or to_regprocedure('public.trial_test_approve_code(uuid,text,text,text,text,text,text)') is null then
    raise exception 'STOP 0323: 0322 (trial approval test mode) missing - run APPLY-0322.sql first'; end if;
  if to_regprocedure('public._r311_app_call()') is null then raise exception 'STOP 0323: _r311_app_call missing - run 0311 first'; end if;
  if to_regprocedure('public._a260_quote_cancelled(uuid)') is null then raise exception 'STOP 0323: _a260_quote_cancelled missing - run 0260 first'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP 0323: current_org_id missing'; end if;
end $$;

-- ---- 1) a free trial never e-mails its clients: _tr212_email_ok wrapped (0212 body kept) ---------------------------
do $$ begin
  if to_regprocedure('public._tr212_email_ok__pre0323(uuid)') is null then
    alter function public._tr212_email_ok(uuid) rename to _tr212_email_ok__pre0323;
  end if;
end $$;
create or replace function public._tr212_email_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r114-trial-sim-0323: a free trial is a simulation - no real e-mail to a client, ever (0212 body: __pre0323)
  select false;
$$;

-- ---- 2) no trial e-mail slot can be taken by the app (any kind) --------------------------------------------------------
create or replace function public._r323_tg_trial_email_slot()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r114-trial-sim-0323: a row in the trial e-mail ledger = a real e-mail from a trial studio -> refused (app calls only)
begin
  if public._r311_app_call() then
    raise exception 'Free trial: nothing is sent to your client - this is a simulation. Use Preview to see what they would get.'
      using errcode = '42501', hint = 'trial_no_send';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_catalog.pg_trigger t where t.tgrelid = 'public.trial_email_sends'::regclass
                   and t.tgname = 'ab2_r323_trial_email_slot' and not t.tgisinternal) then
    create trigger ab2_r323_trial_email_slot before insert on public.trial_email_sends
      for each row execute function public._r323_tg_trial_email_slot();
  end if;
end $$;

-- ---- 3) the simulated client payments of a trial (never the money ledger) ---------------------------------------------
create table if not exists public.trial_sim_payments (
  id           uuid        primary key default gen_random_uuid(),
  org_id       uuid        not null references public.organizations(id) on delete cascade,
  quote_id     uuid        not null references public.quotes(id) on delete cascade,
  milestone_id uuid,
  amount       numeric     not null default 0,
  currency     text        not null default 'INR',
  label        text,
  client_name  text,
  test_mode    boolean     not null default true,
  created_at   timestamptz not null default now(),
  constraint trial_sim_payments_test_only check (test_mode),
  constraint trial_sim_payments_amount check (amount >= 0 and amount < 1000000000000),
  constraint trial_sim_payments_label_len check (label is null or char_length(label) <= 200),
  constraint trial_sim_payments_name_len check (client_name is null or char_length(client_name) <= 120)
);
comment on table public.trial_sim_payments is
  'R114 (0323): SIMULATED client payments in a Helm free trial (test only - no money, no Razorpay, not the money ledger).';
create unique index if not exists trial_sim_payments_once
  on public.trial_sim_payments(quote_id, coalesce(milestone_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists trial_sim_payments_org on public.trial_sim_payments(org_id, created_at desc);
alter table public.trial_sim_payments enable row level security;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then execute format('revoke all on public.trial_sim_payments from %I', r); end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant select on public.trial_sim_payments to authenticated;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    grant all on public.trial_sim_payments to service_role;
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'trial_sim_payments'
                   and policyname = 'trial_sim_payments_own_studio_read') then
    create policy trial_sim_payments_own_studio_read on public.trial_sim_payments
      for select to authenticated using (org_id = public.current_org_id());
  end if;
end $$;

-- trial retention (0184): purged with the studio's quotes (children first), patched in place like 0310
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''trial_sim_payments''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''quote_payments'', ''payment_milestones''', ''))) / length('''quote_payments'', ''payment_milestones''') <> 1 then
        raise notice '0323: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''quote_payments'', ''payment_milestones''', '''trial_sim_payments'', ''quote_payments'', ''payment_milestones''');
      end if;
    end if;
  end if;
end $$;

-- ---- helpers (not callable by the app) --------------------------------------------------------------------------------
-- the live approval link -> quote id (same rule as 0322: not revoked / expired / deleted)
create or replace function public._r323_token_quote(p_token uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  -- r114-trial-sim-0323
  select q.id from public.quotes q
   where p_token is not null and q.approval_token = p_token
     and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
     and q.deleted_at is null
   limit 1;
$$;

-- the next thing the client would pay: the first open milestone not yet simulated, else the quote total (once)
create or replace function public._r323_next_due(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r114-trial-sim-0323: {milestone_id, amount, label} or null when nothing is left to pay
declare m record; v_total numeric; v_has boolean;
begin
  select exists (select 1 from public.payment_milestones x where x.quote_id = p_quote and coalesce(x.status, 'due') <> 'waived')
    into v_has;
  if v_has then
    select x.id, x.amount, x.label into m
      from public.payment_milestones x
     where x.quote_id = p_quote and coalesce(x.status, 'due') not in ('paid', 'waived')
       and not exists (select 1 from public.trial_sim_payments s where s.quote_id = p_quote and s.milestone_id = x.id)
     order by x.due_date nulls last, x.seq, x.created_at
     limit 1;
    if m.id is null then return null; end if;
    return jsonb_build_object('milestone_id', m.id, 'amount', greatest(coalesce(m.amount, 0), 0),
                              'label', left(coalesce(nullif(btrim(m.label), ''), 'Payment'), 200));
  end if;
  if exists (select 1 from public.trial_sim_payments s where s.quote_id = p_quote and s.milestone_id is null) then return null; end if;
  select case when coalesce(q.pricing ->> 'total', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$' then (q.pricing ->> 'total')::numeric else 0 end
    into v_total from public.quotes q where q.id = p_quote;
  return jsonb_build_object('milestone_id', null, 'amount', greatest(coalesce(v_total, 0), 0), 'label', 'Booking payment');
end $$;

-- ---- 4) the approval page: the simulated payment step -------------------------------------------------------------------
create or replace function public.public_trial_payment_sim(p_token uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r114-trial-sim-0323: unknown / expired / revoked / deleted / cancelled -> null; paid studio -> {simulation:false}
declare v_q uuid; v_org uuid; v_status text; v_cur text; v_next jsonb; v_last_id uuid; v_last_at timestamptz; v_active boolean;
begin
  v_q := public._r323_token_quote(p_token);
  if v_q is null or coalesce(public._a260_quote_cancelled(v_q), false) then return null; end if;
  select q.org_id, coalesce(q.approval_status, ''), upper(coalesce(nullif(btrim(q.pricing ->> 'currency'), ''), nullif(btrim(q.currency), ''), 'INR'))
    into v_org, v_status, v_cur from public.quotes q where q.id = v_q;
  if not coalesce(public._tb179_no_send(v_org), false) then return jsonb_build_object('simulation', false); end if;
  v_active := coalesce(public._trial_test_mode_ok(v_org), false);
  v_next := public._r323_next_due(v_q);
  select s.id, s.created_at into v_last_id, v_last_at from public.trial_sim_payments s where s.quote_id = v_q order by s.created_at desc limit 1;
  return jsonb_build_object('simulation', true, 'approved', v_status in ('approved', 'paid'), 'ended', not v_active,
    'can_pay', v_active and v_status in ('approved', 'paid') and v_next is not null and coalesce(public._trial_client_skip_ok(v_org), false),
    'amount', coalesce((v_next ->> 'amount')::numeric, 0), 'label', v_next ->> 'label', 'currency', left(v_cur, 3),
    'paid', v_last_id is not null, 'paid_at', v_last_at,
    'receipt', case when v_last_id is null then null else 'TEST-' || upper(left(replace(v_last_id::text, '-', ''), 8)) end);
end $$;

-- ---- 5) "Simulate payment": a TEST payment, never real money ------------------------------------------------------------
create or replace function public.trial_simulate_payment(p_token uuid, p_client_name text default null, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r114-trial-sim-0323
declare v_q uuid; v_org uuid; v_status text; v_cur text; v_next jsonb; v_id uuid; v_receipt text;
begin
  v_q := public._r323_token_quote(p_token);
  if v_q is null or coalesce(public._a260_quote_cancelled(v_q), false) then raise exception 'invalid link' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:r323:simpay:' || v_q::text, 0));
  select q.org_id, coalesce(q.approval_status, ''), upper(coalesce(nullif(btrim(q.pricing ->> 'currency'), ''), nullif(btrim(q.currency), ''), 'INR'))
    into v_org, v_status, v_cur from public.quotes q where q.id = v_q;
  if not coalesce(public._tb179_no_send(v_org), false) then
    return jsonb_build_object('simulated', false, 'error', 'trial_only',
      'message', 'Simulated payments are only for studios on a Helm free trial - use the payment step on this page.');
  end if;
  if not coalesce(public._trial_test_mode_ok(v_org), false) then
    return jsonb_build_object('simulated', false, 'error', 'trial_ended',
      'message', 'This studio''s free trial has ended, so the payment simulation is closed. Please contact your planner.');
  end if;
  if not coalesce(public._trial_client_skip_ok(v_org), false) then
    return jsonb_build_object('simulated', false, 'error', 'trial_test_unavailable',
      'message', 'You are signed in to another Helm studio - open this link in a private window to try the simulation.');
  end if;
  if v_status not in ('approved', 'paid') then
    return jsonb_build_object('simulated', false, 'error', 'not_approved',
      'message', 'Approve the quote first (test mode) - then the simulated payment step opens.');
  end if;
  v_next := public._r323_next_due(v_q);
  if v_next is null then
    return jsonb_build_object('simulated', true, 'already', true, 'test_mode', true,
      'message', 'Every payment on this quote has already been simulated. Nothing real was charged.');
  end if;
  insert into public.trial_sim_payments(org_id, quote_id, milestone_id, amount, currency, label, client_name)
    values (v_org, v_q, nullif(v_next ->> 'milestone_id', '')::uuid, coalesce((v_next ->> 'amount')::numeric, 0), left(v_cur, 3),
            v_next ->> 'label', nullif(left(btrim(coalesce(p_client_name, '')), 120), ''))
    on conflict do nothing
    returning id into v_id;
  if v_id is null then
    return jsonb_build_object('simulated', true, 'already', true, 'test_mode', true,
      'message', 'This payment was already simulated a moment ago. Nothing real was charged.');
  end if;
  v_receipt := 'TEST-' || upper(left(replace(v_id::text, '-', ''), 8));
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), null, 'payment.simulated', 'quotes', v_q::text,
            jsonb_build_object('test_mode', true, 'real_payment', false, 'amount', coalesce((v_next ->> 'amount')::numeric, 0),
                               'currency', left(v_cur, 3), 'milestone_id', v_next ->> 'milestone_id', 'receipt', v_receipt,
                               'client_name', left(coalesce(p_client_name, ''), 120), 'user_agent', left(coalesce(p_user_agent, ''), 200)),
            v_org, now());
  return jsonb_build_object('simulated', true, 'test_mode', true, 'real_payment', false,
    'amount', coalesce((v_next ->> 'amount')::numeric, 0), 'currency', left(v_cur, 3), 'label', v_next ->> 'label',
    'receipt', v_receipt, 'more_due', public._r323_next_due(v_q) is not null);
end $$;

-- ---- 6) client pages: is this a trial simulation? ---------------------------------------------------------------------
create or replace function public.public_trial_simulation(p_kind text, p_ref text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r114-trial-sim-0323: {simulation} only; an unknown / malformed link -> null
declare v_org uuid; v_ref text := btrim(coalesce(p_ref, ''));
begin
  if v_ref = '' or length(v_ref) > 200 then return null; end if;
  if p_kind = 'quote' then
    if v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    select q.org_id into v_org from public.quotes q where q.id = public._r323_token_quote(v_ref::uuid);
  elsif p_kind = 'booklet' then
    if v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
    select b.org_id into v_org from public.client_booklets b where b.token = v_ref::uuid and b.revoked_at is null limit 1;
  elsif p_kind = 'site' then
    select s.org_id into v_org from public.event_sites s where s.slug = lower(v_ref) and s.status = 'published' limit 1;
  else
    return null;
  end if;
  if v_org is null then return null; end if;
  return jsonb_build_object('simulation', coalesce(public._tb179_no_send(v_org), false));
end $$;

-- ---- 7) the studio: its simulated client payments ------------------------------------------------------------------------
create or replace function public.trial_sim_payments_for_quote(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r114-trial-sim-0323: own studio only (signed in); [] for another studio's quote
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('amount', s.amount, 'currency', s.currency, 'label', s.label,
                                                       'at', s.created_at, 'test_mode', true,
                                                       'receipt', 'TEST-' || upper(left(replace(s.id::text, '-', ''), 8)))
                                    order by s.created_at)
                     from public.trial_sim_payments s where s.quote_id = p_quote and s.org_id = v_org), '[]'::jsonb);
end $$;

-- ---- 8) privileges ----------------------------------------------------------------------------------------------------
do $$ declare f text; r text; begin
  foreach f in array array['public._tr212_email_ok__pre0323(uuid)', 'public._tr212_email_ok(uuid)', 'public._r323_tg_trial_email_slot()',
                           'public._r323_token_quote(uuid)', 'public._r323_next_due(uuid)',
                           'public.public_trial_payment_sim(uuid)', 'public.trial_simulate_payment(uuid, text, text)',
                           'public.public_trial_simulation(text, text)', 'public.trial_sim_payments_for_quote(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = r) then execute format('revoke all on function %s from %I', f, r); end if;
    end loop;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._tr212_email_ok(uuid) to service_role';
  end if;
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.public_trial_payment_sim(uuid) to %I', r);
      execute format('grant execute on function public.trial_simulate_payment(uuid, text, text) to %I', r);
      execute format('grant execute on function public.public_trial_simulation(text, text) to %I', r);
    end if;
  end loop;
  foreach r in array array['authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.trial_sim_payments_for_quote(uuid) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
