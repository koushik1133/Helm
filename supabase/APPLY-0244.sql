-- APPLY-0244.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER the release that is live on www.helm.events (0045 / 0056 / 0058 / 0165 / 0166 / 0183 / 0185 applied).
-- Order-independent of the other r21 files (0240-0243).
-- Trial -> paid (TRIAL-TO-PAID-PLAN.md phase A): HQ "Activate plan" (one step: payment + GST invoice + plan ACTIVE
-- with period, trial caps / read-only lifted, keep / remove sample / start clean offered), the dormant Razorpay
-- subscription webhook activates through the same function, Contact sales saved in Helm (HQ "Requests" tab +
-- e-mail alert to sales@helm.events), "Ask my admin to upgrade" (admin bell notice + e-mail).
-- Then: deploy the site (hq / checkout / trial / store-api ...) and REDEPLOY the edge functions comms-dispatch
-- (sends the new e-mails) and razorpay-subscription-webhook (passes the subscription id; still dormant).
-- Safe to run twice (the 2nd run changes nothing). ASCII only. Nothing is deleted or rewritten.
begin;
-- 0244_trial_to_paid_activation.sql
-- REQUIRES 0045 (studio_subscriptions, subscription_payments, _sub_record_payment 13-arg, _sub_payment_json,
--          hq_settle_provider_payment 10-arg, _hq_wgate, _hq_gate), 0056 (studio_subscriptions.billing_interval),
--          0166 (_is_trial_org), 0183 (_trial_locked), 0058 / 0120 (notifications kind 'trial_reminder' =
--          admin-only bell rows), 0165 (email_is_opted_out), 0185 (my_upgrade_status).
--
-- In plain words (r21, TRIAL-TO-PAID-PLAN.md phase A, owner approved):
--   1  ONE server step makes a studio a paying studio: _sub_activate(org, plan, interval, period) sets
--      studio_subscriptions to status 'active' with the plan, the billing interval and the period. Before
--      this, recording a payment never changed the status, so a paid studio stayed capped as a "trial"
--      (caps / lockdown ask status = 'trial') and never saw the keep / remove sample / start clean choice.
--        * hq_activate_plan(...)  HQ "Activate plan" (platform admins only, two-step session when HQ requires
--          it - the same _hq_wgate as every HQ write, audit-logged): in ONE transaction it sets the plan,
--          records the payment (numbered GST invoice, the existing _sub_record_payment) and activates the
--          plan. Pressing it twice with the same payment (same studio, amount, period, method within a day)
--          records ONE payment and answers 'replay'. A suspended studio is refused.
--        * hq_settle_provider_payment (the dormant Razorpay subscription webhook's RPC, service role only):
--          same signature, body kept as hq_settle_provider_payment__pre0244 (renamed once, no app grants);
--          after the payment is settled (or replayed) the plan is activated through the same _sub_activate
--          ONLY when p_provider_subscription_id is the subscription Helm attached to that studio
--          (checkout_attach_subscription). The webhook itself stays dormant / fail-closed.
--        * An already active plan is never shortened by an older payment (a replayed old charge leaves the
--          newer period as it is).
--   2  Contact sales is saved in Helm: table sales_requests (RLS on, no policies: only these functions read
--      or write it). request_plan_activation(...) - a signed-in STUDIO ADMIN of their own studio only
--      (anonymous visitors: OFF), validated, rate limited (the same plan + billing again within a day = the
--      same request; at most 5 a day per studio). HQ: hq_sales_requests() / hq_set_sales_request_status().
--      An e-mail alert to sales@helm.events is QUEUED in helm_notice_outbox and sent by the existing
--      comms-dispatch function + shared mailer (new lane helm_notice_outbox_claim / _mark, service role).
--   3  "Ask my admin to upgrade": ask_admin_upgrade() - a teammate (not a client, not an admin) of a studio
--      that is on / just past its free trial puts ONE bell notice for the studio admins (kind
--      'trial_reminder': already admin-readable only, links to /checkout) and queues an e-mail to each admin
--      (skipped for an address that unsubscribed from Helm's e-mails, 0165). Once a day per
--      teammate, at most 10 a day per studio.
--   4  Trial retention (0184, switched off): both new tables are KEPT tables (_tr184_keep_tables gets the two names;
--      the rest of its list is unchanged), so they are never purged with trial data.
--   Nothing existing is deleted or rewritten: 2 new tables, new functions, 1 function wrapped (original kept).
--   Additive + idempotent: safe to run twice (the 2nd run changes nothing). ASCII only.
-- ROLLBACK (manual, only if ever needed): drop function public.hq_settle_provider_payment(text,uuid,numeric,
--   date,date,date,text,text,text,numeric); alter function public.hq_settle_provider_payment__pre0244(text,uuid,
--   numeric,date,date,date,text,text,text,numeric) rename to hq_settle_provider_payment; grant execute on it to
--   service_role; drop the new functions. The two new tables can stay (they only hold requests / queued mails).

do $$ begin
  if to_regclass('public.studio_subscriptions') is null or to_regclass('public.subscription_payments') is null then
    raise exception 'STOP: 0045 (HQ subscriptions) is not applied'; end if;
  if to_regprocedure('public._sub_record_payment(uuid,numeric,text,date,date,date,text,text,uuid,text,text,text,numeric)') is null
     or to_regprocedure('public._sub_payment_json(public.subscription_payments)') is null then
    raise exception 'STOP: 0045 (_sub_record_payment with tax snapshot) is not applied'; end if;
  if to_regprocedure('public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)') is null
     and to_regprocedure('public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)') is null then
    raise exception 'STOP: hq_settle_provider_payment (0045, 10 arguments) is missing'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regprocedure('public._hq_gate(text,text)') is null then
    raise exception 'STOP: 0029 / 0045 HQ gates are not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_subscriptions'
                   and column_name = 'billing_interval') then raise exception 'STOP: 0056 (billing_interval) is not applied'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception 'STOP: 0166 + 0183 (trial helpers) are not applied'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is null then
    raise exception 'STOP: 0165 (email_is_opted_out) is not applied'; end if;
end $$;

-- ---- 1) new tables (RLS on, no policies: only the functions below touch them) --------------------------
create table if not exists public.sales_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid references public.organizations(id) on delete set null,
  created_by       uuid,
  source           text not null default 'checkout' check (source in ('checkout', 'read_only_banner')),
  plan_code        text not null check (plan_code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  plan_name        text check (plan_name is null or char_length(plan_name) <= 80),
  billing_interval text not null default 'monthly' check (billing_interval in ('monthly', 'yearly')),
  studio_name      text not null check (char_length(studio_name) between 1 and 160),
  contact_name     text not null check (char_length(contact_name) between 1 and 80),
  contact_email    text not null check (char_length(contact_email) between 3 and 200),
  contact_phone    text check (contact_phone is null or char_length(contact_phone) <= 20),
  message          text check (message is null or char_length(message) <= 1000),
  status           text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  hq_note          text check (hq_note is null or char_length(hq_note) <= 500),
  handled_by       uuid,
  handled_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists sales_requests_created_idx on public.sales_requests (created_at desc);
create index if not exists sales_requests_org_idx on public.sales_requests (org_id, created_at desc);

-- Helm's own notices to a fixed address (sales) or to a studio's admins; sent by comms-dispatch
create table if not exists public.helm_notice_outbox (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('sales_request', 'upgrade_ask')),
  org_id      uuid references public.organizations(id) on delete set null,
  ref_id      uuid,
  payload     jsonb not null default '{}'::jsonb,
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists helm_notice_outbox_dedupe on public.helm_notice_outbox (dedupe_key);
create index if not exists helm_notice_outbox_pending_idx on public.helm_notice_outbox (created_at) where sent_at is null;

do $$ declare t text; begin
  foreach t in array array['sales_requests', 'helm_notice_outbox'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- NO read-only guard (zzz_studio_read_only) on the two new tables on purpose: they are written only by definer
-- RPCs that check the caller, and asking sales / asking the admin must work exactly when a studio is read-only
-- (ended trial, waiting for its first payment). Same rule as the other system ledgers (0151 / 0157 / 0186).

-- the address that gets the sales alerts (change here if it ever moves)
create or replace function public._helm_sales_email()
returns text language sql immutable set search_path = '' as $$ select 'sales@helm.events'::text $$;

-- one line of text: control characters flattened, spaces collapsed, cut to n
create or replace function public._r21_line(p text, n integer)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), n), '');
$$;

-- ---- 2) the ONE activation step ------------------------------------------------------------------------
-- internal: no gate (callers gate). Sets the plan ACTIVE with plan, interval and period; never shortens a
-- newer active period; refuses a suspended studio. Writes one audit row (HQ log: org_id null).
create or replace function public._sub_activate(p_org uuid, p_plan_id uuid, p_interval text, p_period_start date,
  p_period_end date, p_actor uuid, p_source text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244
declare cur public.studio_subscriptions; v_found boolean;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio' using errcode = '22023'; end if;
  if p_plan_id is null or not exists (select 1 from public.helm_plans hp where hp.id = p_plan_id) then
    raise exception 'unknown plan' using errcode = '22023'; end if;
  if coalesce(p_interval, '') not in ('monthly', 'yearly') then raise exception 'interval must be monthly or yearly' using errcode = '22023'; end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'the plan period is not valid' using errcode = '22023'; end if;
  select * into cur from public.studio_subscriptions where org_id = p_org for update;
  v_found := found;
  if v_found and cur.status = 'suspended' then
    raise exception 'this studio is suspended - reactivate it first' using errcode = '22023'; end if;
  if v_found and cur.status = 'active' and cur.current_period_end is not null and p_period_end < cur.current_period_end then
    return jsonb_build_object('result', 'unchanged', 'status', cur.status, 'current_period_end', cur.current_period_end);
  end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, billing_interval, current_period_start, current_period_end,
                                          updated_at, updated_by)
    values (p_org, p_plan_id, 'active', p_interval, p_period_start, p_period_end, now(), p_actor)
  on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active', billing_interval = excluded.billing_interval,
      current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
      updated_at = now(), updated_by = p_actor;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (p_actor, (select u.email from auth.users u where u.id = p_actor), 'hq.subscription.activated', 'studio_subscriptions',
            p_org::text, jsonb_build_object('from_status', case when v_found then cur.status end, 'plan_id', p_plan_id,
              'interval', p_interval, 'period_start', p_period_start, 'period_end', p_period_end, 'source', left(coalesce(p_source, ''), 40)),
            null, now());
  return jsonb_build_object('result', 'activated', 'status', 'active', 'from_status', case when v_found then cur.status end,
    'current_period_start', p_period_start, 'current_period_end', p_period_end);
end $$;

-- the last day of a plan period that starts on p_start (inclusive): +1 month / +1 year, minus one day
create or replace function public._sub_period_end(p_start date, p_interval text)
returns date language sql immutable set search_path = '' as $$
  select (p_start + case when p_interval = 'yearly' then interval '1 year' else interval '1 month' end)::date - 1;
$$;

-- HQ "Activate plan": plan + payment (GST invoice) + active, in one transaction
create or replace function public.hq_activate_plan(p_org uuid, p_plan_code text, p_interval text, p_amount numeric,
  p_method text, p_period_start date default null, p_paid_on date default null, p_reference text default null,
  p_currency text default 'INR', p_fx_rate_to_inr numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244
declare v_plan uuid; v_active boolean; v_start date := coalesce(p_period_start, current_date); v_end date;
  v_paid date := coalesce(p_paid_on, current_date); v_pay uuid; v_res jsonb; v_replay boolean := false; v_status text;
begin
  perform public._hq_wgate('hq.subscription.activate', 'studio_subscriptions', p_org::text,
    jsonb_build_object('plan', p_plan_code, 'interval', p_interval, 'amount', p_amount, 'currency', p_currency, 'method', p_method,
                       'period_start', v_start, 'paid_on', v_paid, 'reference', left(p_reference, 120)));
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio' using errcode = '22023'; end if;
  select hp.id, hp.active into v_plan, v_active from public.helm_plans hp where hp.code = lower(btrim(coalesce(p_plan_code, '')));
  if v_plan is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  if not v_active then raise exception 'this plan is switched off - turn it on in Plans first' using errcode = '22023'; end if;
  if coalesce(p_interval, '') not in ('monthly', 'yearly') then raise exception 'billing must be monthly or yearly' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be more than 0' using errcode = '22023'; end if;
  if v_start < date '2020-01-01' or v_start > current_date + 366 then raise exception 'period start is not valid' using errcode = '22023'; end if;
  v_end := public._sub_period_end(v_start, p_interval);
  perform pg_advisory_xact_lock(hashtext('helm_activate:' || p_org::text));
  select s.status into v_status from public.studio_subscriptions s where s.org_id = p_org for update;
  if v_status = 'suspended' then raise exception 'this studio is suspended - reactivate it first' using errcode = '22023'; end if;
  -- the same payment again (double click / retry): no second payment
  select sp.id into v_pay from public.subscription_payments sp
   where sp.org_id = p_org and sp.voided_at is null and sp.period_start = v_start and sp.period_end = v_end
     and sp.amount = round(p_amount, 2) and sp.method = p_method and sp.recorded_at > now() - interval '1 day'
   order by sp.recorded_at desc limit 1;
  v_replay := v_pay is not null;
  if not v_replay then
    -- the plan first, so the invoice names it
    insert into public.studio_subscriptions(org_id, plan_id, status, billing_interval, updated_at, updated_by)
      values (p_org, v_plan, 'trial', p_interval, now(), auth.uid())
    on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
        updated_at = now(), updated_by = auth.uid();
    v_pay := public._sub_record_payment(p_org, p_amount, p_currency, v_paid, v_start, v_end, p_method, p_reference,
               auth.uid(), null, null, null, p_fx_rate_to_inr);
  end if;
  v_res := public._sub_activate(p_org, v_plan, p_interval, v_start, v_end, auth.uid(), 'hq');
  return jsonb_build_object('result', case when v_replay then 'replay' else 'activated' end,
    'payment', (select public._sub_payment_json(sp) from public.subscription_payments sp where sp.id = v_pay),
    'subscription', (select jsonb_build_object('status', s.status, 'plan_code', (select hp.code from public.helm_plans hp where hp.id = s.plan_id),
                       'billing_interval', s.billing_interval, 'current_period_start', s.current_period_start,
                       'current_period_end', s.current_period_end)
                       from public.studio_subscriptions s where s.org_id = p_org),
    'activation', v_res);
end $$;

-- the dormant subscription webhook settles through here: same signature, original body kept
do $$ begin
  if to_regprocedure('public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)') is null then
    alter function public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)
      rename to hq_settle_provider_payment__pre0244;
  end if;
end $$;

create or replace function public.hq_settle_provider_payment(p_provider_payment_id text, p_org uuid, p_amount numeric,
  p_paid_on date, p_period_start date default null, p_period_end date default null, p_currency text default 'INR',
  p_provider text default 'razorpay', p_provider_subscription_id text default null, p_fx_rate_to_inr numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244: settle (0045 body, idempotent on the provider payment id), then activate the plan when the
-- payment belongs to the provider subscription Helm attached to THIS studio
declare v_out jsonb; s public.studio_subscriptions; v_start date; v_end date; v_act jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  v_out := public.hq_settle_provider_payment__pre0244(p_provider_payment_id, p_org, p_amount, p_paid_on, p_period_start, p_period_end,
             p_currency, p_provider, p_provider_subscription_id, p_fx_rate_to_inr);
  if nullif(btrim(coalesce(p_provider_subscription_id, '')), '') is null then return v_out; end if;
  select * into s from public.studio_subscriptions where org_id = p_org;
  if not found or s.provider_subscription_id is distinct from btrim(p_provider_subscription_id) or s.plan_id is null
     or s.billing_interval is null or s.status = 'suspended' then
    return v_out || jsonb_build_object('activation', 'skipped');
  end if;
  v_start := coalesce(p_period_start, p_paid_on, current_date);
  v_end := coalesce(p_period_end, public._sub_period_end(v_start, s.billing_interval));
  if v_end < v_start then v_end := public._sub_period_end(v_start, s.billing_interval); end if;
  v_act := public._sub_activate(p_org, s.plan_id, s.billing_interval, v_start, v_end, null, 'provider');
  return v_out || jsonb_build_object('activation', v_act ->> 'result');
end $$;

-- ---- 3) contact sales (studio admin, own studio) ---------------------------------------------------------
create or replace function public.request_plan_activation(p_plan text, p_interval text, p_studio text, p_name text,
  p_email text, p_phone text default null, p_message text default null, p_source text default 'checkout')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244: saved in Helm (HQ "Requests") + an e-mail alert to sales queued; nothing is charged
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); v_plan text; v_pname text; v_iv text;
  v_studio text; v_name text; v_email text; v_phone text; v_msg text; v_src text; v_id uuid; n int;
begin
  if v_uid is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'Only a studio admin can request a plan' using errcode = '42501'; end if;
  v_plan := lower(btrim(coalesce(p_plan, '')));
  if v_plan !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'Choose a plan' using errcode = '22023'; end if;
  select hp.name into v_pname from public.helm_plans hp where hp.code = v_plan;
  if v_pname is null and v_plan not in ('starter', 'studio', 'enterprise') then raise exception 'Choose a plan' using errcode = '22023'; end if;
  v_pname := coalesce(v_pname, initcap(v_plan));
  v_iv := case when p_interval = 'yearly' then 'yearly' else 'monthly' end;
  v_studio := public._r21_line(p_studio, 160);
  v_name := public._r21_line(p_name, 80);
  v_email := lower(public._r21_line(p_email, 200));
  v_phone := public._r21_line(p_phone, 20);
  v_msg := nullif(left(btrim(regexp_replace(replace(coalesce(p_message, ''), E'\r', ''), '[\x01-\x09\x0b-\x1f\x7f]', ' ', 'g')), 1000), '');
  v_src := case when p_source = 'read_only_banner' then 'read_only_banner' else 'checkout' end;
  if v_studio is null then v_studio := (select left(o.name, 160) from public.organizations o where o.id = v_org); end if;
  if v_studio is null then raise exception 'Enter your studio name' using errcode = '22023'; end if;
  if v_name is null then raise exception 'Enter your name' using errcode = '22023'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Enter a valid email address' using errcode = '22023'; end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$' then raise exception 'Enter a valid phone number' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('helm_sales_req:' || v_org::text));
  -- the same plan + billing again within a day = the same request (no second alert)
  select r.id into v_id from public.sales_requests r
   where r.org_id = v_org and r.plan_code = v_plan and r.billing_interval = v_iv and r.status = 'new'
     and r.created_at > now() - interval '1 day' order by r.created_at desc limit 1;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'status', 'received', 'duplicate', true);
  end if;
  select count(*) into n from public.sales_requests r where r.org_id = v_org and r.created_at > now() - interval '1 day';
  if n >= 5 then
    raise exception 'We already have your requests from today - our team will contact you within one working day' using errcode = '22023';
  end if;
  insert into public.sales_requests(org_id, created_by, source, plan_code, plan_name, billing_interval, studio_name,
                                    contact_name, contact_email, contact_phone, message)
    values (v_org, v_uid, v_src, v_plan, left(v_pname, 80), v_iv, v_studio, v_name, v_email, v_phone, v_msg)
    returning id into v_id;
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
    values ('sales_request', v_org, v_id, jsonb_build_object('request_id', v_id), 'sales_request:' || v_id::text)
  on conflict (dedupe_key) do nothing;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'sales.request', 'sales_requests', v_id::text,
            jsonb_build_object('plan', v_plan, 'interval', v_iv, 'source', v_src), v_org, now());
  return jsonb_build_object('id', v_id, 'status', 'received', 'duplicate', false);
end $$;

create or replace function public.hq_sales_requests(p_status text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244
begin
  perform public._hq_gate('hq_sales_requests', p_status);
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb)
                 from (select r.status, count(*) n from public.sales_requests r group by r.status) x),
    'rows', coalesce((select jsonb_agg(z.j order by z.created_at desc) from (
       select r.created_at, jsonb_build_object('id', r.id, 'org_id', r.org_id, 'studio', coalesce(o.name, r.studio_name),
         'studio_name', r.studio_name, 'source', r.source, 'plan_code', r.plan_code, 'plan_name', r.plan_name,
         'billing_interval', r.billing_interval, 'contact_name', r.contact_name, 'contact_email', r.contact_email,
         'contact_phone', r.contact_phone, 'message', r.message, 'status', r.status, 'hq_note', r.hq_note,
         'handled_at', r.handled_at, 'created_at', r.created_at,
         'subscription_status', (select s.status from public.studio_subscriptions s where s.org_id = r.org_id)) j
         from public.sales_requests r left join public.organizations o on o.id = r.org_id
        where p_status is null or r.status = p_status
        order by r.created_at desc limit 300) z), '[]'::jsonb));
end $$;

create or replace function public.hq_set_sales_request_status(p_id uuid, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244
declare n int;
begin
  perform public._hq_wgate('hq.sales_request.status', 'sales_requests', p_id::text,
    jsonb_build_object('status', p_status, 'note', left(p_note, 500)));
  if coalesce(p_status, '') not in ('new', 'contacted', 'won', 'lost') then
    raise exception 'status must be new, contacted, won or lost' using errcode = '22023'; end if;
  update public.sales_requests set status = p_status,
         hq_note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 500), ''), hq_note),
         handled_by = auth.uid(), handled_at = now()
   where id = p_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'request not found' using errcode = '22023'; end if;
  return (select jsonb_build_object('id', r.id, 'status', r.status, 'hq_note', r.hq_note, 'handled_at', r.handled_at)
            from public.sales_requests r where r.id = p_id);
end $$;

-- ---- 4) "Ask my admin to upgrade" (a teammate of a trial / ended-trial studio) ---------------------------
create or replace function public.ask_admin_upgrade()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244: one admin-only bell notice + queued e-mails to the admins; once a day per teammate
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); v_role text := coalesce(public.user_role(), '');
  v_who text; v_day text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'); n int; v_nid uuid;
begin
  if v_uid is null or v_org is null or v_role in ('', 'client') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public.is_admin(), false) then
    raise exception 'You are a studio admin - choose a plan or talk to us from the plan page' using errcode = '22023'; end if;
  if not (public._is_trial_org(v_org) or public._trial_locked(v_org)) then
    raise exception 'Your studio already has a plan' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('helm_upgrade_ask:' || v_org::text));
  if exists (select 1 from public.notifications nt where nt.org_id = v_org and nt.kind = 'trial_reminder'
               and nt.detail ->> 'source' = 'r21_ask' and nt.detail ->> 'ask_by' = v_uid::text
               and nt.created_at > now() - interval '1 day') then
    return jsonb_build_object('sent', false, 'already', true);
  end if;
  select count(*) into n from public.notifications nt where nt.org_id = v_org and nt.kind = 'trial_reminder'
     and nt.detail ->> 'source' = 'r21_ask' and nt.created_at > now() - interval '1 day';
  if n >= 10 then return jsonb_build_object('sent', false, 'already', true); end if;
  select coalesce(public._r21_line(p.full_name, 80), split_part(coalesce(p.email, ''), '@', 1), 'A teammate') into v_who
    from public.profiles p where p.id = v_uid;
  v_who := coalesce(nullif(v_who, ''), 'A teammate');
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values (null, 'in_app', 'trial_reminder', 'simulated',
            jsonb_build_object('label', v_who || ' asked you to choose a Helm plan', 'source', 'r21_ask', 'ask_by', v_uid::text,
                               'ask_name', v_who), v_org)
    returning id into v_nid;
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
    values ('upgrade_ask', v_org, v_nid, jsonb_build_object('who', v_who, 'ask_by', v_uid::text),
            'upgrade_ask:' || v_org::text || ':' || v_uid::text || ':' || v_day)
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('sent', true, 'already', false);
end $$;

-- ---- 5) the e-mail lane for comms-dispatch (service role only) ---------------------------------------------
create or replace function public.helm_notice_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244: each row is handed out once (claim + mark); recipients resolved here, never from the row
declare r record; v_out jsonb := '[]'::jsonb; v_to jsonb; v_data jsonb; q public.sales_requests;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  update public.helm_notice_outbox set status = 'failed', sent_at = now() where sent_at is null and attempts >= 5;
  for r in
    select o.* from public.helm_notice_outbox o
     where o.sent_at is null and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update skip locked
  loop
    v_to := '[]'::jsonb; v_data := null;
    if r.kind = 'sales_request' then
      select * into q from public.sales_requests where id = r.ref_id;
      if found then
        v_to := jsonb_build_array(public._helm_sales_email());
        v_data := jsonb_build_object('studio', q.studio_name, 'account', (select o.name from public.organizations o where o.id = q.org_id),
          'plan', coalesce(q.plan_name, q.plan_code), 'interval', q.billing_interval, 'name', q.contact_name, 'email', q.contact_email,
          'phone', q.contact_phone, 'message', q.message, 'source', q.source, 'created_at', q.created_at,
          'subscription_status', (select s.status from public.studio_subscriptions s where s.org_id = q.org_id));
      end if;
    elsif r.kind = 'upgrade_ask' and r.org_id is not null then
      select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
        from public.profiles p
       where p.org_id = r.org_id and p.role = 'admin' and p.email is not null
         and not public.email_is_opted_out(null, p.email);   -- Helm-level unsubscribe (0165) is respected
      v_data := jsonb_build_object('who', r.payload ->> 'who', 'studio', (select o.name from public.organizations o where o.id = r.org_id));
    end if;
    if v_data is null or jsonb_array_length(v_to) = 0 then
      update public.helm_notice_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.helm_notice_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'kind', r.kind, 'to', v_to, 'data', v_data));
  end loop;
  return v_out;
end $$;

create or replace function public.helm_notice_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r21-trial-paid-0244
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.helm_notice_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.helm_notice_outbox set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 5b) trial retention (0184): the two new tables are KEPT like the other billing / notice ledgers ---------
-- (a request to sales and its queued alert are Helm's sales records, never purged with the trial data)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''sales_requests''' in v_def) > 0 then return; end if;
  if position('''trial_terms_acceptances''' in v_def) = 0 then
    raise exception 'STOP: _tr184_keep_tables() has an unexpected body (no trial_terms_acceptances) - nothing changed'; end if;
  execute replace(v_def, '''trial_terms_acceptances''', '''trial_terms_acceptances'', ''sales_requests'', ''helm_notice_outbox''');
end $$;

-- ---- 6) privileges -------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._helm_sales_email()', 'public._r21_line(text, integer)',
    'public._sub_activate(uuid, uuid, text, date, date, uuid, text)', 'public._sub_period_end(date, text)',
    'public.hq_activate_plan(uuid, text, text, numeric, text, date, date, text, text, numeric)',
    'public.hq_settle_provider_payment(text, uuid, numeric, date, date, date, text, text, text, numeric)',
    'public.hq_settle_provider_payment__pre0244(text, uuid, numeric, date, date, date, text, text, text, numeric)',
    'public.request_plan_activation(text, text, text, text, text, text, text, text)',
    'public.hq_sales_requests(text)', 'public.hq_set_sales_request_status(uuid, text, text)',
    'public.ask_admin_upgrade()',
    'public.helm_notice_outbox_claim(integer)', 'public.helm_notice_outbox_mark(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    -- each checks its caller inside (HQ operator + write gate / studio admin / studio member)
    execute 'grant execute on function public.hq_activate_plan(uuid, text, text, numeric, text, date, date, text, text, numeric) to authenticated';
    execute 'grant execute on function public.request_plan_activation(text, text, text, text, text, text, text, text) to authenticated';
    execute 'grant execute on function public.hq_sales_requests(text) to authenticated';
    execute 'grant execute on function public.hq_set_sales_request_status(uuid, text, text) to authenticated';
    execute 'grant execute on function public.ask_admin_upgrade() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.hq_settle_provider_payment(text, uuid, numeric, date, date, date, text, text, text, numeric) to service_role';
    execute 'grant execute on function public.helm_notice_outbox_claim(integer) to service_role';
    execute 'grant execute on function public.helm_notice_outbox_mark(uuid, text) to service_role';
    -- the kept 0045 body is reached only through the wrapper
    execute 'revoke all on function public.hq_settle_provider_payment__pre0244(text, uuid, numeric, date, date, date, text, text, text, numeric) from service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 new tables sales_requests + helm_notice_outbox exist with RLS on and no app grants',
     (select relrowsecurity from pg_class where oid = 'public.sales_requests'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.helm_notice_outbox'::regclass)
     and not has_table_privilege('authenticated', 'public.sales_requests', 'select')
     and not has_table_privilege('anon', 'public.sales_requests', 'select')
     and not has_table_privilege('authenticated', 'public.helm_notice_outbox', 'select')),
  ('02 HQ activate + requests RPCs: signed-in only (operator / admin checked inside), never anonymous',
     has_function_privilege('authenticated', 'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_sales_requests(text)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_set_sales_request_status(uuid,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.request_plan_activation(text,text,text,text,text,text,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.ask_admin_upgrade()', 'execute')
     and not has_function_privilege('anon', 'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
     and not has_function_privilege('anon', 'public.request_plan_activation(text,text,text,text,text,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.ask_admin_upgrade()', 'execute')),
  ('03 the activation core + mail lane are not callable by the app',
     not has_function_privilege('authenticated', 'public._sub_activate(uuid,uuid,text,date,date,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.helm_notice_outbox_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.helm_notice_outbox_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.helm_notice_outbox_mark(uuid,text)', 'execute')),
  ('04 webhook RPC wrapped once (0244), 0045 body kept as __pre0244 and reachable only through the wrapper',
     position('r21-trial-paid-0244' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)'))) > 0
     and to_regprocedure('public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)') is not null
     and has_function_privilege('service_role', 'public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
     and not has_function_privilege('authenticated', 'public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
     and not has_function_privilege('service_role', 'public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')),
  ('05 a monthly period ends the day before the same date next month; yearly the day before next year',
     public._sub_period_end(date '2026-10-19', 'monthly') = date '2026-11-18'
     and public._sub_period_end(date '2026-10-19', 'yearly') = date '2027-10-18'),
  ('06 sales alerts go to sales@helm.events', public._helm_sales_email() = 'sales@helm.events'),
  ('06b trial retention keeps the two new tables (never purged)',
     to_regprocedure('public._tr184_keep_tables()') is null
     or ('sales_requests' = any(public._tr184_keep_tables()) and 'helm_notice_outbox' = any(public._tr184_keep_tables()))),
  ('07 none of the new functions deletes or truncates anything',
     not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('_sub_activate', 'hq_activate_plan', 'hq_settle_provider_payment',
                    'request_plan_activation', 'hq_sales_requests', 'hq_set_sales_request_status', 'ask_admin_upgrade',
                    'helm_notice_outbox_claim', 'helm_notice_outbox_mark')
                    and (p.prosrc ~* '\mdelete\s+from\M' or p.prosrc ~* '\mtruncate\M')))
) v(item, ok) order by item;
