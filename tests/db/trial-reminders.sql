-- trial-reminders.sql — 0058 trial-ending reminders: thresholds queued once per studio per
-- kind per trial end date, ended trial → past_due (never suspended), bell row for admins only,
-- studio isolation, my_trial_status for members (clients / anon refused), and paying from
-- an ended trial through checkout. Uses its OWN studios (F, G) so no other suite's rows move.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _tr; create temp table _tr(name text, result text); grant all on _tr to anon, authenticated, service_role;
drop table if exists _trs; create temp table _trs as select * from public.helm_billing_settings where id;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin execute 'reset role'; insert into _tr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if coalesce(c, '') <> '' then perform set_config('request.jwt.claims', c, false); end if;
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- count reminders as superuser
create or replace function pg_temp.nrem(p_org uuid, p_kind text) returns int language sql as $$
  select count(*)::int from public.billing_reminders where org_id = p_org and kind = p_kind; $$;
create or replace function pg_temp.nbell(p_org uuid) returns int language sql as $$
  select count(*)::int from public.notifications where org_id = p_org and kind = 'trial_reminder'; $$;

-- ---- fixtures: studio F (on trial), studio G (trial, paid) ----------------------------------------
do $$ declare f uuid := 'f0000000-0000-4000-8000-0000000000f1'; g uuid := '90000000-0000-4000-8000-000000000091';
  u uuid; em text; o uuid; r text;
begin
  perform pg_temp.su();
  insert into public.organizations(id,name,currency,timezone,brand,plan,created_at) values
    (f,'Studio F','INR','Asia/Kolkata','{}'::jsonb,'pro',now()), (g,'Studio G','INR','Asia/Kolkata','{}'::jsonb,'pro',now())
  on conflict (id) do nothing;
  for em, o, r in values ('f_admin@f.test', f, 'admin'), ('f_staff@f.test', f, 'sales'), ('f_client@f.test', f, 'client'),
                         ('g_admin@g.test', g, 'admin') loop
    select id into u from auth.users where email = em;
    if u is null then u := auth.seed_user(em); end if;
    insert into public.profiles(id,email,role,org_id,must_change_password,created_at) values (u, em, r, o, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  end loop;
  -- this suite's own studios only
  delete from public.billing_reminders where org_id in (f, g);
  delete from public.notifications where org_id in (f, g) and kind = 'trial_reminder';
  delete from public.studio_subscriptions where org_id in (f, g);
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at)
    values (f, 'trial', current_date + 7, 'bypass', now()), (g, 'trial', current_date - 1, 'checkout', now());
  -- G paid through Razorpay already (covers today) — its trial must never be flagged
  if not exists (select 1 from public.subscription_payments where org_id = g and voided_at is null) then
    perform public._sub_record_payment(g, 1180::numeric, 'INR'::text, current_date, current_date, current_date + 30, 'card'::text, 'pay_trialG'::text, null::uuid, null::text, null::text, null::text, null::numeric);
  end if;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('zz-tr-basic', 'Basic', 1000, 'INR', true)
    on conflict (code) do update set active = true;
  insert into public.helm_plan_prices(plan_id, currency, price_monthly, price_yearly, razorpay_plan_id_monthly)
    select id, 'INR', 1000, 10000, 'plan_TRIAL123456' from public.helm_plans where code = 'zz-tr-basic'
    on conflict (plan_id, currency) do update set price_monthly = 1000, razorpay_plan_id_monthly = 'plan_TRIAL123456';
  insert into public.studio_account(org_id, country, state) values (f, 'IN', 'Telangana') on conflict (org_id) do nothing;
  update public.studio_account set terms_version_accepted = (select terms_version from public.helm_billing_settings where id) where org_id = f;
end $$;

-- ---- 1) thresholds, once each --------------------------------------------------------------------
do $$ declare f uuid := 'f0000000-0000-4000-8000-0000000000f1'; g uuid := '90000000-0000-4000-8000-000000000091'; j jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('01 new reminder kinds accepted by the check',
    pg_temp.try('insert into public.billing_reminders(org_id, kind, period_end) values (''' || f || ''', ''trial_ended'', date ''2001-01-01'')') = ''
    and pg_temp.try('insert into public.billing_reminders(org_id, kind, period_end) values (''' || f || ''', ''bogus'', date ''2001-01-01'')') = '23514');
  delete from public.billing_reminders where org_id = f and period_end = date '2001-01-01';
  j := public._billing_refresh();
  perform pg_temp.res('02 7 days left → trial_7d queued', pg_temp.nrem(f, 'trial_7d') = 1 and pg_temp.nrem(f, 'trial_3d') = 0, j::text);
  perform pg_temp.res('03 _billing_refresh reports the trial job', j ? 'trial_reminders_queued' and j ? 'past_due_set', j::text);
  perform public._billing_refresh(); perform public._trial_refresh();
  perform pg_temp.res('04 re-running queues nothing twice', pg_temp.nrem(f, 'trial_7d') = 1 and pg_temp.nbell(f) = 1);
  perform pg_temp.res('05 bell row: admin-only kind with label + days', exists (select 1 from public.notifications n where n.org_id = f
    and n.kind = 'trial_reminder' and n.detail ->> 'trial' = 'trial_7d' and (n.detail ->> 'days_left')::int = 7 and n.detail ->> 'label' like '%7 days%'));
  update public.studio_subscriptions set trial_ends_at = current_date + 3 where org_id = f;
  perform public._trial_refresh(); perform public._trial_refresh();
  perform pg_temp.res('06 3 days left → trial_3d once', pg_temp.nrem(f, 'trial_3d') = 1 and pg_temp.nrem(f, 'trial_7d') = 1 and pg_temp.nbell(f) = 2);
  update public.studio_subscriptions set trial_ends_at = current_date + 1 where org_id = f;
  perform public._trial_refresh(); perform public._trial_refresh();
  perform pg_temp.res('07 1 day left → trial_1d once', pg_temp.nrem(f, 'trial_1d') = 1 and pg_temp.nrem(f, 'trial_3d') = 1);
  perform pg_temp.res('08 still trial before the end', (select status from public.studio_subscriptions where org_id = f) = 'trial');
  perform pg_temp.res('09 paid studio G: no reminder, stays trial',
    pg_temp.nrem(g, 'trial_ended') = 0 and pg_temp.nbell(g) = 0 and (select status from public.studio_subscriptions where org_id = g) = 'trial');
  perform pg_temp.res('10 isolation: F rows never land on G', not exists (select 1 from public.billing_reminders where org_id = g)
    and not exists (select 1 from public.notifications where org_id = g and kind = 'trial_reminder'));
end $$;

-- ---- 2) member reads (before the end) -------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('f_admin@f.test'); j := public.my_trial_status();
  perform pg_temp.res('11 admin: trial, 1 day left, can pay', j ->> 'state' = 'trial' and (j ->> 'days_left')::int = 1
    and (j ->> 'can_pay')::boolean and j ->> 'ends_at' = (current_date + 1)::text, j::text);
  perform pg_temp.login('f_staff@f.test'); j := public.my_trial_status();
  perform pg_temp.res('12 member reads status but cannot pay', j ->> 'state' = 'trial' and not (j ->> 'can_pay')::boolean, j::text);
  perform pg_temp.res('13 member cannot read trial bell rows (RLS)', (select count(*) from public.notifications where kind = 'trial_reminder') = 0);
  perform pg_temp.res('14 member bell feed hides trial reminders', not exists (select 1 from jsonb_array_elements(public.bell_feed(50) -> 'items') x where x ->> 'kind' = 'trial_reminder'));
  perform pg_temp.login('f_admin@f.test');
  perform pg_temp.res('15 admin reads trial bell rows', (select count(*) from public.notifications where kind = 'trial_reminder') = 3);
  perform pg_temp.res('16 admin bell feed shows trial reminders', exists (select 1 from jsonb_array_elements(public.bell_feed(50) -> 'items') x where x ->> 'kind' = 'trial_reminder'));
  perform pg_temp.res('17 admin cannot forge / edit / delete trial bell rows',
    pg_temp.try('insert into public.notifications(channel, kind, status, detail) values (''in_app'', ''trial_reminder'', ''simulated'', ''{}'')') <> ''
    and (select count(*) from (select 1 from public.notifications where kind = 'trial_reminder') x) = 3);
  update public.notifications set detail = '{}' where kind = 'trial_reminder';
  delete from public.notifications where kind = 'trial_reminder';
  perform pg_temp.su();
  perform pg_temp.res('18 trial bell rows unchanged after client update/delete',
    (select count(*) from public.notifications where org_id = 'f0000000-0000-4000-8000-0000000000f1' and kind = 'trial_reminder' and detail ? 'trial') = 3);
  perform pg_temp.login('f_client@f.test');
  perform pg_temp.res('19 client cannot read trial status', pg_temp.try('select public.my_trial_status()') = '42501');
  perform pg_temp.su(); execute 'set role anon';
  perform pg_temp.res('20 anon cannot read trial status', pg_temp.try('select public.my_trial_status()') = '42501');
  perform pg_temp.login('g_admin@g.test'); j := public.my_trial_status();
  perform pg_temp.res('21 isolation: G admin sees only G (paid → none)', j ->> 'state' = 'none' and j ->> 'ends_at' is null, j::text);
  perform pg_temp.res('22 internal jobs not callable by members',
    pg_temp.try('select public._trial_refresh()') = '42501' and pg_temp.try('select public._billing_refresh()') = '42501');
end $$;

-- ---- 3) checkout during the trial ------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('f_admin@f.test');
  j := public.my_checkout_prepare('zz-tr-basic', 'monthly');
  perform pg_temp.res('23 in-trial studio can pay (prepare)', j ->> 'org_id' = 'f0000000-0000-4000-8000-0000000000f1', j::text);
  j := public.my_checkout_status();
  perform pg_temp.res('24 in-trial studio is not forced to checkout', not (j ->> 'required')::boolean and j ->> 'status' = 'trial', j::text);
end $$;

-- ---- 4) the trial ends ------------------------------------------------------------------------------
do $$ declare f uuid := 'f0000000-0000-4000-8000-0000000000f1'; j jsonb; begin
  perform pg_temp.su();
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = f;
  j := public._billing_refresh(); perform public._billing_refresh();
  perform pg_temp.res('25 ended unpaid → past_due', (select status from public.studio_subscriptions where org_id = f) = 'past_due', j::text);
  perform pg_temp.res('26 NOT suspended: studio stays writable', public._studio_writable(f));
  perform pg_temp.res('27 trial_ended queued once + one bell row', pg_temp.nrem(f, 'trial_ended') = 1
    and (select count(*) from public.notifications where org_id = f and kind = 'trial_reminder' and detail ->> 'trial' = 'trial_ended') = 1);
  perform pg_temp.res('28 audited', exists (select 1 from public.audit_log where action = 'billing.trial_ended_past_due' and entity_id = f::text));
  perform pg_temp.res('29 no renewal past_due reminder for a trial', pg_temp.nrem(f, 'past_due') = 0);
  perform pg_temp.login('f_admin@f.test'); j := public.my_trial_status();
  perform pg_temp.res('30 admin: ended, can pay', j ->> 'state' = 'ended' and (j ->> 'days_left')::int = 0 and (j ->> 'can_pay')::boolean, j::text);
  j := public.my_checkout_prepare('zz-tr-basic', 'monthly');
  perform pg_temp.res('31 ended trial can still pay (prepare)', j ->> 'org_id' = f::text, j::text);
  perform pg_temp.res('32 ended trial cannot restart a free trial', pg_temp.try('select public.my_start_trial(''bypass'')') = '22023');
  perform pg_temp.svc();
  perform pg_temp.res('33 service attach works for an ended trial', public.checkout_attach_subscription(f, 'sub_TRIALF123456', 'zz-tr-basic', 'monthly'));
  perform pg_temp.su();
  perform pg_temp.res('34 attach keeps past_due (webhook / HQ activates)',
    (select status = 'past_due' and provider_subscription_id = 'sub_TRIALF123456' from public.studio_subscriptions where org_id = f));
  -- a renewal that lapsed (had a paid period) is still refused at checkout
  update public.studio_subscriptions set current_period_end = current_date - 3 where org_id = f;
  perform pg_temp.login('f_admin@f.test');
  perform pg_temp.res('35 lapsed paid renewal still refused at checkout', pg_temp.try('select public.my_checkout_prepare(''zz-tr-basic'', ''monthly'')') = '22023');
  perform pg_temp.su();
  update public.studio_subscriptions set current_period_end = null where org_id = f;
  perform pg_temp.su(); execute 'set role anon';
  perform pg_temp.res('36 anon cannot call the internal trial helpers', pg_temp.try('select public._trial_refresh()') = '42501');
end $$;

-- ---- restore --------------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  update public.helm_billing_settings b set terms_version = s.terms_version from _trs s where b.id;
  -- this suite's own test plan only (later suites count the plans list)
  update public.studio_subscriptions set plan_id = null where org_id in ('f0000000-0000-4000-8000-0000000000f1', '90000000-0000-4000-8000-000000000091');
  delete from public.helm_plan_prices where plan_id in (select id from public.helm_plans where code = 'zz-tr-basic');
  delete from public.helm_plans where code = 'zz-tr-basic';
end $$;
select pg_temp.su();
select name, result from _tr order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 36 then 'TRIAL-REMINDERS: ALL PASS (36/36)'
            else 'TRIAL-REMINDERS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/36 ran' end from _tr;
