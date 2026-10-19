-- r21-trial-paid-0244.sql -- 0244: ONE activation step (HQ "Activate plan" + the dormant subscription webhook)
-- turns a free-trial studio into a paying one: payment + GST invoice + status active + plan + interval + period,
-- trial caps / read-only lifted, the keep / remove sample / start clean choice offered. HQ operators only,
-- idempotent, never touches another studio. Contact sales saved (studio admin only, rate limited, e-mail queued),
-- "Ask my admin to upgrade" (teammates only, once a day), the comms-dispatch lane. Rolled back. Local PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps; re-apply 0244 inside this rolled-back tx (also proves a re-run is safe)
\ir ../../supabase/migrations/0244_trial_to_paid_activation.sql
\ir ../../supabase/migrations/0244_trial_to_paid_activation.sql
create temp table _tp(name text, result text); grant all on _tp to anon, authenticated, service_role;
create temp table _tpkv(k text primary key, v text); grant all on _tpkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tpkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tpkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the studio's trial ends in the past (read-only), as the database owner
create or replace function pg_temp.expire(p_org uuid) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '2 days' where id = p_org;
  update public.studio_subscriptions set trial_ends_at = current_date - 2 where org_id = p_org;
end $$;
-- add one own lead as the signed-in studio admin: '' = added, else the error
create or replace function pg_temp.addlead(p_email text, p_tag text) returns text language plpgsql as $$
declare e text; begin
  perform pg_temp.login(p_email);
  e := pg_temp.try(format($q$insert into public.leads(org_id, name, status) values (public.current_org_id(), %L, 'new')$q$, 'R21 lead ' || p_tag));
  perform pg_temp.su(); return e;
end $$;
-- a fingerprint of the other studios' subscription + payment rows (cross-tenant: must never change)
create or replace function pg_temp.others(p_skip uuid[]) returns text language sql as $$
  select md5(coalesce(string_agg(x, ',' order by x), '')) from (
    select 's' || org_id::text || status || coalesce(plan_id::text, '') || coalesce(current_period_end::text, '') as x
      from public.studio_subscriptions where not (org_id = any(p_skip))
    union all select 'p' || id::text || coalesce(voided_at::text, '') from public.subscription_payments where not (org_id = any(p_skip))) t;
$$;

-- ---- setup -------------------------------------------------------------------------------------------
do $$ declare a uuid; b uuid; c uuid; d uuid; e uuid; f uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  update public.helm_billing_settings set gst_rate = 18, invoice_prefix = 'HELM-' where id;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r21starter', 'R21 Starter', 1999, 'INR', true)
    on conflict (code) do update set active = true;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r21old', 'R21 Old', 999, 'INR', false)
    on conflict (code) do update set active = false;
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('r21_a@t.test'); perform pg_temp.put('A', a::text);
  b := pg_temp.trial('r21_b@t.test'); perform pg_temp.put('B', b::text);
  c := pg_temp.trial('r21_c@t.test'); perform pg_temp.put('C', c::text);
  d := pg_temp.trial('r21_d@t.test'); perform pg_temp.put('D', d::text);
  e := pg_temp.trial('r21_e@t.test'); perform pg_temp.put('E', e::text);
  f := pg_temp.trial('r21_f@t.test'); perform pg_temp.put('F', f::text);
  perform pg_temp.newuser('r21_b_mgr@t.test', b, 'manager');
  perform pg_temp.newuser('r21_b_cli@t.test', b, 'client');
  perform pg_temp.newuser('r21_f_crd@t.test', f, 'coordinator');
  perform pg_temp.newuser('r21_a_mgr@t.test', a, 'manager');
  perform pg_temp.newuser('r21_e_crd@t.test', e, 'coordinator');
  perform pg_temp.expire(c); perform pg_temp.expire(f);
exception when others then perform pg_temp.su(); insert into _tp values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + privileges -------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 new tables: RLS on, no app grants (anon / authenticated)',
    (select relrowsecurity from pg_class where oid = 'public.sales_requests'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.helm_notice_outbox'::regclass)
    and not has_table_privilege('authenticated', 'public.sales_requests', 'select')
    and not has_table_privilege('authenticated', 'public.sales_requests', 'insert')
    and not has_table_privilege('anon', 'public.sales_requests', 'select')
    and not has_table_privilege('authenticated', 'public.helm_notice_outbox', 'select')
    and not has_table_privilege('anon', 'public.helm_notice_outbox', 'insert'));
  perform pg_temp.res('02 internal helpers + the webhook / mail lane are not callable by the app',
    not has_function_privilege('authenticated', 'public._sub_activate(uuid,uuid,text,date,date,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public._sub_activate(uuid,uuid,text,date,date,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
    and not has_function_privilege('authenticated', 'public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
    and not has_function_privilege('service_role', 'public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
    and has_function_privilege('service_role', 'public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)', 'execute')
    and not has_function_privilege('authenticated', 'public.helm_notice_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.helm_notice_outbox_mark(uuid,text)', 'execute')
    and has_function_privilege('service_role', 'public.helm_notice_outbox_claim(integer)', 'execute'));
  perform pg_temp.res('03 anonymous visitors cannot call any new RPC (contact sales anonymous = OFF)',
    not has_function_privilege('anon', 'public.request_plan_activation(text,text,text,text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_activate_plan(uuid,text,text,numeric,text,date,date,text,text,numeric)', 'execute')
    and not has_function_privilege('anon', 'public.ask_admin_upgrade()', 'execute')
    and not has_function_privilege('anon', 'public.hq_sales_requests(text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_set_sales_request_status(uuid,text,text)', 'execute'));
  perform pg_temp.res('04 the new functions never DELETE / TRUNCATE / DROP',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname in ('_sub_activate', 'hq_activate_plan', 'hq_settle_provider_payment',
                   'request_plan_activation', 'hq_sales_requests', 'hq_set_sales_request_status', 'ask_admin_upgrade',
                   'helm_notice_outbox_claim', 'helm_notice_outbox_mark', '_sub_period_end', '_r21_line')
                   and (p.prosrc ~* '\mdelete\s+from\M' or p.prosrc ~* '\mtruncate\M' or p.prosrc ~* '\mdrop\s+(table|function)\M')));
  perform pg_temp.res('05 re-run safe: the webhook RPC is wrapped exactly once (0045 body kept as __pre0244)',
    position('r21-trial-paid-0244' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_settle_provider_payment(text,uuid,numeric,date,date,date,text,text,text,numeric)'))) > 0
    and position('r21-trial-paid-0244' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_settle_provider_payment__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)'))) = 0
    and to_regprocedure('public.hq_settle_provider_payment__pre0244__pre0244(text,uuid,numeric,date,date,date,text,text,text,numeric)') is null);
  perform pg_temp.res('05c no read-only guard on the new tables (asking must work for a read-only studio; definer-only writes)',
    not exists (select 1 from pg_trigger where tgrelid = 'public.sales_requests'::regclass and tgname = 'zzz_studio_read_only')
    and not exists (select 1 from pg_trigger where tgrelid = 'public.helm_notice_outbox'::regclass and tgname = 'zzz_studio_read_only'));
  perform pg_temp.res('05b trial retention keeps both new tables (classified, never purged)',
    'sales_requests' = any(public._tr184_keep_tables()) and 'helm_notice_outbox' = any(public._tr184_keep_tables())
    and public.trial_retention_dry_run() -> 'unclassified_tables' = '[]'::jsonb
    and (select count(*) from unnest(public._tr184_keep_tables()) x where x = 'sales_requests') = 1);
exception when others then perform pg_temp.su(); insert into _tp values ('0x structure', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) admin-only: nobody but an HQ operator activates a plan -----------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; e text; q text; begin
  q := format($q$select public.hq_activate_plan(%L::uuid, 'r21starter', 'monthly', 2358.82, 'upi')$q$, a);
  perform pg_temp.login('r21_a@t.test'); e := pg_temp.try(q); perform pg_temp.su();
  perform pg_temp.res('06 the studio''s own admin cannot activate its plan (42501)', e like '42501%', e);
  perform pg_temp.login('r21_b@t.test'); e := pg_temp.try(q); perform pg_temp.su();
  perform pg_temp.res('07 another studio''s admin cannot activate it (42501)', e like '42501%', e);
  perform pg_temp.login('r21_a_mgr@t.test'); e := pg_temp.try(q); perform pg_temp.su();
  perform pg_temp.res('08 a studio member cannot activate it (42501)', e like '42501%', e);
  perform pg_temp.res('09 nothing was written by the refused calls',
    (select status from public.studio_subscriptions where org_id = a) = 'trial'
    and not exists (select 1 from public.subscription_payments where org_id = a), (select status from public.studio_subscriptions where org_id = a));
  perform pg_temp.svc(); e := pg_temp.try(q); perform pg_temp.su();
  perform pg_temp.res('10 the service role cannot use the HQ button either (no operator)', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _tp values ('1x gate', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) before: a trial studio is capped ------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; e1 text; e2 text; e3 text; begin
  perform pg_temp.res('11 before: A is in its free trial', public._is_trial_org(a));
  e1 := pg_temp.addlead('r21_a@t.test', '1'); e2 := pg_temp.addlead('r21_a@t.test', '2'); e3 := pg_temp.addlead('r21_a@t.test', '3');
  perform pg_temp.res('12 before: the trial cap allows 2 new leads and refuses the 3rd', e1 = '' and e2 = '' and e3 <> '', e1 || ' | ' || e2 || ' | ' || e3);
  perform pg_temp.put('OTHERS0', pg_temp.others(array[a]));
exception when others then perform pg_temp.su(); insert into _tp values ('2x before', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) HQ "Activate plan" ------------------------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; s public.studio_subscriptions; p public.subscription_payments; e text; u jsonb; n int; begin
  perform pg_temp.op();
  r := public.hq_activate_plan(a, 'r21starter', 'monthly', 2358.82, 'upi', date '2026-10-19', date '2026-10-19', 'UTR123456');
  perform pg_temp.su();
  select * into s from public.studio_subscriptions where org_id = a;
  select * into p from public.subscription_payments where org_id = a;
  perform pg_temp.res('13 activate: status active, plan, monthly, period 19/10/2026 - 18/11/2026',
    r ->> 'result' = 'activated' and s.status = 'active' and s.plan_id = (select id from public.helm_plans where code = 'r21starter')
    and s.billing_interval = 'monthly' and s.current_period_start = date '2026-10-19' and s.current_period_end = date '2026-11-18', r::text);
  perform pg_temp.res('14 activate: ONE payment with a numbered GST invoice naming the plan',
    (select count(*) from public.subscription_payments where org_id = a) = 1 and p.invoice_no like 'HELM-%' and p.plan_code = 'r21starter'
    and p.amount = 2358.82 and p.method = 'upi' and p.reference = 'UTR123456' and p.period_end = date '2026-11-18'
    and p.gst_amount > 0 and p.net_amount + p.gst_amount = p.amount and (r -> 'payment' ->> 'invoice_no') = p.invoice_no, to_jsonb(p)::text);
  perform pg_temp.res('15 after: trial caps + lockdown lifted (not a trial org, not read-only)',
    not public._is_trial_org(a) and not public._trial_locked(a) and not public._tl173_trial_locked(a));
  e := pg_temp.addlead('r21_a@t.test', '4');
  perform pg_temp.res('16 after: the 3rd own lead is now accepted', e = '', e);
  perform pg_temp.login('r21_a@t.test'); u := public.my_upgrade_status(); perform pg_temp.su();
  perform pg_temp.res('17 after: the admin is offered keep / remove sample / start clean (my_upgrade_status pending)',
    (u ->> 'pending')::boolean and (u ->> 'converted')::boolean and not (u ->> 'in_trial')::boolean, u::text);
  perform pg_temp.login('r21_a_mgr@t.test'); u := public.my_upgrade_status(); perform pg_temp.su();
  perform pg_temp.res('18 after: a member is not asked (admin only)', not (u ->> 'pending')::boolean, u::text);
  perform pg_temp.res('19 audit: HQ log has the activate request + the activation (org_id null = HQ log)',
    exists (select 1 from public.audit_log where action = 'hq.subscription.activate' and entity_id = a::text and org_id is null
              and actor = (select id from auth.users where email = 'admin@helm.events'))
    and exists (select 1 from public.audit_log where action = 'hq.subscription.activated' and entity_id = a::text and org_id is null
              and changed ->> 'source' = 'hq' and changed ->> 'from_status' = 'trial'));
  -- idempotent: the same button again
  perform pg_temp.op();
  r := public.hq_activate_plan(a, 'r21starter', 'monthly', 2358.82, 'upi', date '2026-10-19', date '2026-10-19', 'UTR123456');
  perform pg_temp.su();
  perform pg_temp.res('20 pressed twice: answers replay, still ONE payment, still active, same period',
    r ->> 'result' = 'replay' and (select count(*) from public.subscription_payments where org_id = a) = 1
    and (select status from public.studio_subscriptions where org_id = a) = 'active'
    and (select current_period_end from public.studio_subscriptions where org_id = a) = date '2026-11-18', r::text);
  perform pg_temp.res('21 tenant-safe: no other studio''s subscription or payment changed',
    pg_temp.others(array[a]) = pg_temp.get('OTHERS0'));
  perform pg_temp.res('22 tenant-safe: B is still a capped free trial with no payment',
    public._is_trial_org(pg_temp.get('B')::uuid) and not exists (select 1 from public.subscription_payments where org_id = pg_temp.get('B')::uuid));
exception when others then perform pg_temp.su(); insert into _tp values ('3x activate', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) validation + refusals ----------------------------------------------------------------------------
do $$ declare b uuid := pg_temp.get('B')::uuid; e1 text; e2 text; e3 text; e4 text; e5 text; begin
  perform pg_temp.op();
  e1 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'nope', 'monthly', 100, 'upi')$q$, b));
  e2 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'r21old', 'monthly', 100, 'upi')$q$, b));
  e3 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'r21starter', 'weekly', 100, 'upi')$q$, b));
  e4 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'r21starter', 'monthly', 0, 'upi')$q$, b));
  e5 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'r21starter', 'monthly', 100, 'bitcoin')$q$, b));
  perform pg_temp.su();
  perform pg_temp.res('23 refused: unknown plan, switched-off plan, bad interval, amount 0, bad method (22023)',
    e1 like '22023%' and e2 like '22023%' and e3 like '22023%' and e4 like '22023%' and e5 like '22023%',
    e1 || ' | ' || e2 || ' | ' || e3 || ' | ' || e4 || ' | ' || e5);
  perform pg_temp.res('24 refused calls left B untouched (trial, no payment)',
    (select status from public.studio_subscriptions where org_id = b) = 'trial' and not exists (select 1 from public.subscription_payments where org_id = b));
  update public.studio_subscriptions set prev_status = status, status = 'suspended', suspended_at = now(), suspend_reason = 'test' where org_id = b;
  perform pg_temp.op();
  e1 := pg_temp.try(format($q$select public.hq_activate_plan(%L::uuid, 'r21starter', 'yearly', 23588, 'bank')$q$, b));
  perform pg_temp.su();
  perform pg_temp.res('25 a suspended studio is refused (reactivate first), nothing recorded',
    e1 like '22023%' and not exists (select 1 from public.subscription_payments where org_id = b), e1);
  update public.studio_subscriptions set status = prev_status, prev_status = null, suspended_at = null, suspend_reason = null where org_id = b;
exception when others then perform pg_temp.su(); insert into _tp values ('4x refusals', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) an expired (read-only) trial is unlocked by activation; yearly period ----------------------------
do $$ declare c uuid := pg_temp.get('C')::uuid; r jsonb; e text; s public.studio_subscriptions; begin
  perform pg_temp.res('26 before: C ended its trial unpaid and is read-only', public._trial_locked(c));
  perform pg_temp.op();
  r := public.hq_activate_plan(c, 'r21starter', 'yearly', 23588, 'bank', current_date, current_date, 'NEFT-1');
  perform pg_temp.su();
  select * into s from public.studio_subscriptions where org_id = c;
  perform pg_temp.res('27 yearly: active, period today .. today + 1 year - 1 day; read-only lifted',
    s.status = 'active' and s.billing_interval = 'yearly' and s.current_period_start = current_date
    and s.current_period_end = (current_date + interval '1 year')::date - 1 and not public._trial_locked(c), to_jsonb(s)::text);
  e := pg_temp.addlead('r21_c@t.test', 'c1');
  perform pg_temp.res('28 the unlocked studio can add records again', e = '', e);
exception when others then perform pg_temp.su(); insert into _tp values ('5x expired', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) the dormant subscription webhook path (service role) ----------------------------------------------
do $$ declare d uuid := pg_temp.get('D')::uuid; e uuid := pg_temp.get('E')::uuid; r jsonb; x text; s public.studio_subscriptions; begin
  perform pg_temp.su();
  update public.studio_subscriptions set plan_id = (select id from public.helm_plans where code = 'r21starter'), billing_interval = 'monthly',
         provider = 'razorpay', provider_subscription_id = 'sub_R21DDDDDD1' where org_id = d;
  update public.studio_subscriptions set plan_id = (select id from public.helm_plans where code = 'r21starter'), billing_interval = 'monthly',
         provider = 'razorpay', provider_subscription_id = 'sub_R21EEEEEE1' where org_id = e;
  perform pg_temp.login('r21_d@t.test');
  x := pg_temp.try(format($q$select public.hq_settle_provider_payment('pay_R21AAAAAA1', %L::uuid, 2358.82, current_date, current_date, current_date + 29, 'INR', 'razorpay', 'sub_R21DDDDDD1')$q$, d));
  perform pg_temp.su();
  perform pg_temp.res('29 webhook RPC: a signed-in studio admin is refused (service role only)',
    x like '42501%' and not exists (select 1 from public.subscription_payments where org_id = d), x);
  perform pg_temp.svc();
  r := public.hq_settle_provider_payment('pay_R21AAAAAA1', d, 2358.82, current_date, current_date, current_date + 29, 'INR', 'razorpay', 'sub_R21DDDDDD1');
  perform pg_temp.su();
  select * into s from public.studio_subscriptions where org_id = d;
  perform pg_temp.res('30 a verified charge for the attached subscription activates the plan (gap G1 closed)',
    r ->> 'result' = 'settled' and r ->> 'activation' = 'activated' and s.status = 'active'
    and s.current_period_end = current_date + 29 and not public._is_trial_org(d), r::text);
  perform pg_temp.svc();
  r := public.hq_settle_provider_payment('pay_R21AAAAAA1', d, 2358.82, current_date, current_date, current_date + 29, 'INR', 'razorpay', 'sub_R21DDDDDD1');
  perform pg_temp.su();
  perform pg_temp.res('31 the same webhook delivery again: replay, still one payment, still active',
    r ->> 'result' = 'replay' and (select count(*) from public.subscription_payments where org_id = d) = 1
    and (select status from public.studio_subscriptions where org_id = d) = 'active', r::text);
  -- a newer renewal, then an OLD charge replayed late: the newer period is never shortened
  perform pg_temp.svc();
  r := public.hq_settle_provider_payment('pay_R21AAAAAA2', d, 2358.82, current_date, current_date + 30, current_date + 59, 'INR', 'razorpay', 'sub_R21DDDDDD1');
  r := public.hq_settle_provider_payment('pay_R21AAAAAA0', d, 2358.82, current_date - 30, current_date - 30, current_date - 1, 'INR', 'razorpay', 'sub_R21DDDDDD1');
  perform pg_temp.su();
  perform pg_temp.res('32 renewal moves the period on; a late old charge never shortens it',
    (select current_period_end from public.studio_subscriptions where org_id = d) = current_date + 59
    and r ->> 'activation' = 'unchanged', r::text);
  -- a charge whose subscription id is NOT the one attached to the studio: payment kept, plan NOT activated
  perform pg_temp.svc();
  r := public.hq_settle_provider_payment('pay_R21EEEEEE1', e, 2358.82, current_date, current_date, current_date + 29, 'INR', 'razorpay', 'sub_R21DDDDDD1');
  perform pg_temp.su();
  perform pg_temp.res('33 a charge for another studio''s subscription id never activates this studio',
    r ->> 'activation' = 'skipped' and (select status from public.studio_subscriptions where org_id = e) = 'trial', r::text);
  perform pg_temp.svc();
  r := public.hq_settle_provider_payment('pay_R21EEEEEE2', e, 2358.82, current_date, current_date, current_date + 29);
  perform pg_temp.su();
  perform pg_temp.res('34 no subscription id given (old caller): settles only, exactly as before 0244',
    r ->> 'result' = 'settled' and r -> 'activation' is null and (select status from public.studio_subscriptions where org_id = e) = 'trial', r::text);
exception when others then perform pg_temp.su(); insert into _tp values ('6x webhook', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) contact sales ----------------------------------------------------------------------------------------
do $$ declare b uuid := pg_temp.get('B')::uuid; r jsonb; r2 jsonb; e1 text; e2 text; e3 text; e4 text; i int; n int; begin
  perform pg_temp.login('r21_b@t.test');
  r := public.request_plan_activation('studio', 'yearly', 'B Studio', 'Asha Rao', 'Asha@Spark.in', '+91 98765 43210', E'Two branches\r\nPlease call', 'checkout');
  perform pg_temp.su();
  perform pg_temp.res('35 a studio admin''s request is saved for its own studio + one sales e-mail queued',
    r ->> 'status' = 'received' and not (r ->> 'duplicate')::boolean
    and exists (select 1 from public.sales_requests q where q.id = (r ->> 'id')::uuid and q.org_id = b and q.plan_code = 'studio'
                and q.billing_interval = 'yearly' and q.contact_email = 'asha@spark.in' and q.message = E'Two branches\nPlease call' and q.status = 'new')
    and (select count(*) from public.helm_notice_outbox o where o.kind = 'sales_request' and o.ref_id = (r ->> 'id')::uuid) = 1, r::text);
  perform pg_temp.login('r21_b@t.test');
  r2 := public.request_plan_activation('studio', 'yearly', 'B Studio', 'Asha Rao', 'asha@spark.in', null, 'again');
  perform pg_temp.su();
  perform pg_temp.res('36 the same plan + billing again within a day = the same request, no second e-mail',
    (r2 ->> 'duplicate')::boolean and r2 ->> 'id' = r ->> 'id'
    and (select count(*) from public.helm_notice_outbox o where o.kind = 'sales_request' and o.org_id = b) = 1, r2::text);
  perform pg_temp.login('r21_b_mgr@t.test');
  e1 := pg_temp.try($q$select public.request_plan_activation('studio', 'monthly', 'B', 'M', 'm@b.in')$q$);
  perform pg_temp.login('r21_b_cli@t.test');
  e2 := pg_temp.try($q$select public.request_plan_activation('studio', 'monthly', 'B', 'C', 'c@b.in')$q$);
  perform pg_temp.login('r21_b@t.test');
  e3 := pg_temp.try($q$select public.request_plan_activation('studio', 'monthly', 'B', 'A', 'not-an-email')$q$);
  e4 := pg_temp.try($q$select public.request_plan_activation('<script>', 'monthly', 'B', 'A', 'a@b.in')$q$);
  perform pg_temp.su();
  perform pg_temp.res('37 refused: a member / a client (42501), a bad e-mail / plan (22023)',
    e1 like '42501%' and e2 like '42501%' and e3 like '22023%' and e4 like '22023%', e1 || ' | ' || e2 || ' | ' || e3 || ' | ' || e4);
  -- rate limit: at most 5 a day per studio
  perform pg_temp.login('r21_b@t.test');
  e1 := '';
  for i in 1..5 loop
    e1 := e1 || pg_temp.try(format($q$select public.request_plan_activation(%L, %L, 'B', 'A', 'a@b.in')$q$,
      (array['starter', 'starter', 'enterprise', 'enterprise', 'r21starter'])[i], (array['monthly', 'yearly', 'monthly', 'yearly', 'monthly'])[i]));
  end loop;
  perform pg_temp.su();
  select count(*) into n from public.sales_requests where org_id = b;
  perform pg_temp.res('38 rate limit: the 6th different request in a day is refused, 5 kept',
    n = 5 and e1 like '%22023%' and position('22023' in e1) > 0, n::text || ' ' || e1);
  perform pg_temp.login('r21_b@t.test');
  e1 := pg_temp.try('select count(*) from public.sales_requests');
  perform pg_temp.su();
  perform pg_temp.res('39 a studio cannot read the requests table directly (no grant)', e1 like '42501%', e1);
  -- an expired (read-only) trial studio can still ask sales
  perform pg_temp.login('r21_f@t.test');
  r := public.request_plan_activation('starter', 'monthly', 'F', 'F admin', 'f@f.in', null, null, 'read_only_banner');
  perform pg_temp.su();
  perform pg_temp.res('40 a read-only (ended trial) studio admin can still contact sales',
    r ->> 'status' = 'received' and exists (select 1 from public.sales_requests where id = (r ->> 'id')::uuid and source = 'read_only_banner'
                                              and org_id = pg_temp.get('F')::uuid), r::text);
exception when others then perform pg_temp.su(); insert into _tp values ('7x sales', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) HQ Requests tab -------------------------------------------------------------------------------------
do $$ declare r jsonb; v_rid uuid; e text; begin
  perform pg_temp.login('r21_b@t.test'); e := pg_temp.try('select public.hq_sales_requests()'); perform pg_temp.su();
  perform pg_temp.res('41 a studio admin cannot open HQ requests (42501)', e like '42501%', e);
  perform pg_temp.op(); r := public.hq_sales_requests('new'); perform pg_temp.su();
  perform pg_temp.res('42 HQ lists the requests with the studio name and counts',
    jsonb_array_length(r -> 'rows') >= 6 and (r -> 'counts' ->> 'new')::int >= 6
    and exists (select 1 from jsonb_array_elements(r -> 'rows') x where x ->> 'contact_email' = 'asha@spark.in' and x ->> 'studio' like 'T r21_b%'), left(r::text, 400));
  select q.id into v_rid from public.sales_requests q where q.contact_email = 'asha@spark.in';
  perform pg_temp.login('r21_b@t.test'); e := pg_temp.try(format($q$select public.hq_set_sales_request_status(%L::uuid, 'won')$q$, v_rid)); perform pg_temp.su();
  perform pg_temp.res('43 a studio admin cannot mark a request (42501)', e like '42501%' and (select status from public.sales_requests where sales_requests.id = v_rid) = 'new', e);
  perform pg_temp.op(); r := public.hq_set_sales_request_status(v_rid, 'contacted', 'Called, sending UPI details');
  e := pg_temp.try(format($q$select public.hq_set_sales_request_status(%L::uuid, 'maybe')$q$, v_rid)); perform pg_temp.su();
  perform pg_temp.res('44 HQ marks a request handled (note + who + when, audit-logged); a bad status is refused',
    r ->> 'status' = 'contacted' and e like '22023%'
    and exists (select 1 from public.sales_requests q where q.id = v_rid and q.handled_by is not null and q.hq_note like 'Called%')
    and exists (select 1 from public.audit_log a where a.action = 'hq.sales_request.status' and a.entity_id = v_rid::text and a.org_id is null), r::text || e);
exception when others then perform pg_temp.su(); insert into _tp values ('8x requests', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 10) "Ask my admin to upgrade" -----------------------------------------------------------------------
do $$ declare f uuid := pg_temp.get('F')::uuid; r jsonb; r2 jsonb; e1 text; e2 text; e3 text; begin
  perform pg_temp.login('r21_f_crd@t.test'); r := public.ask_admin_upgrade(); perform pg_temp.su();
  perform pg_temp.res('45 a teammate of an ended trial asks: one admin-only bell row + one e-mail queued',
    (r ->> 'sent')::boolean
    and (select count(*) from public.notifications n where n.org_id = f and n.kind = 'trial_reminder' and n.detail ->> 'source' = 'r21_ask') = 1
    and (select count(*) from public.helm_notice_outbox o where o.org_id = f and o.kind = 'upgrade_ask') = 1, r::text);
  perform pg_temp.login('r21_f_crd@t.test'); r2 := public.ask_admin_upgrade(); perform pg_temp.su();
  perform pg_temp.res('46 asking again the same day: nothing new (once a day per teammate)',
    not (r2 ->> 'sent')::boolean and (r2 ->> 'already')::boolean
    and (select count(*) from public.notifications n where n.org_id = f and n.detail ->> 'source' = 'r21_ask') = 1, r2::text);
  perform pg_temp.login('r21_f_crd@t.test');
  e1 := pg_temp.try('select count(*) from public.notifications where kind = ''trial_reminder''');
  perform pg_temp.su();
  perform pg_temp.login('r21_f@t.test'); e2 := pg_temp.try('select public.ask_admin_upgrade()'); perform pg_temp.su();
  perform pg_temp.login('r21_b_cli@t.test'); e3 := pg_temp.try('select public.ask_admin_upgrade()'); perform pg_temp.su();
  perform pg_temp.res('47 the admin is pointed to the plan page (22023); a client is refused (42501)',
    e2 like '22023%' and e3 like '42501%', e2 || ' | ' || e3);
  perform pg_temp.login('r21_a_mgr@t.test'); e1 := pg_temp.try('select public.ask_admin_upgrade()'); perform pg_temp.su();
  perform pg_temp.res('48 a teammate of a PAID studio is told it already has a plan, nothing written',
    e1 like '22023%' and not exists (select 1 from public.notifications n where n.org_id = pg_temp.get('A')::uuid and n.detail ->> 'source' = 'r21_ask'), e1);
  perform pg_temp.login('r21_f_crd@t.test');
  e1 := (select count(*)::text from public.notifications where kind = 'trial_reminder' and detail ->> 'source' = 'r21_ask');
  perform pg_temp.login('r21_f@t.test');
  e2 := (select count(*)::text from public.notifications where kind = 'trial_reminder' and detail ->> 'source' = 'r21_ask');
  perform pg_temp.su();
  perform pg_temp.res('49 the bell row is visible to the admin only (0058 policy), never to the teammate', e1 = '0' and e2 = '1', e1 || '/' || e2);
exception when others then perform pg_temp.su(); insert into _tp values ('9x ask', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 11) the comms-dispatch lane -------------------------------------------------------------------------
do $$ declare r jsonb; e text; v_id uuid; begin
  perform pg_temp.login('r21_b@t.test'); e := pg_temp.try('select public.helm_notice_outbox_claim(10)'); perform pg_temp.su();
  perform pg_temp.res('50 a signed-in user cannot claim the mail lane', e like '42501%', e);
  perform pg_temp.svc(); r := public.helm_notice_outbox_claim(100); perform pg_temp.su();
  perform pg_temp.res('51 claim: sales rows go to sales@helm.events with the request details',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'kind' = 'sales_request' and x -> 'to' = '["sales@helm.events"]'::jsonb
              and x -> 'data' ->> 'email' = 'asha@spark.in' and x -> 'data' ->> 'plan' = 'Studio' and x -> 'data' ->> 'interval' = 'yearly'), left(r::text, 500));
  perform pg_temp.res('52 claim: the upgrade ask goes to the studio''s admins only (never to the asking teammate)',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'kind' = 'upgrade_ask' and x -> 'to' = '["r21_f@t.test"]'::jsonb), left(r::text, 500));
  select (x ->> 'id')::uuid into v_id from jsonb_array_elements(r) x where x ->> 'kind' = 'upgrade_ask' limit 1;
  perform pg_temp.svc(); perform public.helm_notice_outbox_mark(v_id, 'sent'); r := public.helm_notice_outbox_claim(100); perform pg_temp.su();
  perform pg_temp.res('53 each row is handed out once: claimed rows are not handed out again; marked sent',
    jsonb_array_length(r) = 0 and (select status from public.helm_notice_outbox where id = v_id) = 'sent', r::text);
  -- an admin who unsubscribed from Helm's e-mails gets the bell notice but no e-mail
  perform pg_temp.su();
  insert into public.email_optouts(org_key, email_lc, opted_out) values (public._eu165_key(null), public._eu165_norm('r21_e@t.test'), true)
    on conflict do nothing;
  perform pg_temp.login('r21_e_crd@t.test'); perform public.ask_admin_upgrade();
  perform pg_temp.svc(); r := public.helm_notice_outbox_claim(100); perform pg_temp.su();
  perform pg_temp.res('54 an admin who unsubscribed from Helm e-mail: bell row yes, e-mail skipped',
    jsonb_array_length(r) = 0
    and exists (select 1 from public.notifications n where n.org_id = pg_temp.get('E')::uuid and n.detail ->> 'source' = 'r21_ask')
    and (select status from public.helm_notice_outbox where org_id = pg_temp.get('E')::uuid and kind = 'upgrade_ask') = 'skipped', r::text);
exception when others then perform pg_temp.su(); insert into _tp values ('10x lane', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _tp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-TRIAL-PAID-0244: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-TRIAL-PAID-0244: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _tp;
rollback;
