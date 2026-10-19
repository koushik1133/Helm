-- direct-studio-0159.sql - 0159: a studio made with "Create studio" (no trial) must pick a plan
-- and pay first. Each DO block is its own transaction (autocommit) so "later" writes are real.
-- Proves: direct studio is gated (writes refused, checkout required), billing details / Terms still
-- save, the trial path + existing studios are NOT gated, switching to the free trial lifts the gate
-- (payment off only), an HQ / paid subscription lifts it, the marker is private, plans exist.
-- Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _d159; create temp table _d159(name text, result text); grant all on _d159 to anon, authenticated;
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare n bigint; v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v; get diagnostics n = row_count;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _d159 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

-- setup (superuser): two brand-new sign-ups, payment switched off
do $$ begin
  execute 'reset role';
  if not exists (select 1 from auth.users where email = 'd159_direct@d.test') then perform auth.seed_user('d159_direct@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'd159_trial@d.test') then perform auth.seed_user('d159_trial@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'd159_hq@d.test') then perform auth.seed_user('d159_hq@d.test'); end if;
  -- a re-run starts each sign-up without a studio again (the earlier test studios stay, unused)
  update public.profiles set org_id = null where email in ('d159_direct@d.test', 'd159_trial@d.test', 'd159_hq@d.test');
  update public.helm_billing_settings set online_payments_live = false where id;
  -- r22 0255: switching to the free trial needs the current Terms - this sign-up accepted them
  if to_regclass('public.account_terms_acceptances') is not null then
    insert into public.account_terms_acceptances(user_id, version) select u.id, public._account_terms_version() from auth.users u
     where u.email = 'd159_direct@d.test' on conflict do nothing; end if;
end $$;

-- 1) plans exist for /checkout
do $$ begin
  perform pg_temp.t('plans: at least two active plans with INR monthly + yearly prices',
    (select count(*) from public.helm_plans hp join public.helm_plan_prices pp on pp.plan_id = hp.id and pp.currency = 'INR'
      where hp.active and pp.price_yearly is not null) >= 2, null);
end $$;

-- 2) direct studio
do $$ declare r text; begin
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.create_studio('D159 Direct Studio', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('direct: create_studio works', r like 'ok:%' and length(r) > 10, r);
  perform pg_temp.t('direct: marker written',
    exists (select 1 from public.studio_payment_gate g join public.profiles p on p.org_id = g.org_id where p.email = 'd159_direct@d.test'), null);
end $$;
do $$ declare r text; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'd159_direct@d.test';
  perform pg_temp.t('direct: pending payment', public._studio_payment_pending(v_org), null);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_checkout_status()::text$q$);
  perform pg_temp.t('direct: checkout required + pending_payment', r like '%"required": true%' and r like '%"pending_payment": true%' and r like '%"reason": "pending_payment"%', r);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_checkout_options()::text$q$);
  perform pg_temp.t('direct: options list plans + pending flag', r like '%"pending_payment": true%' and r like '%"code": "starter"%', r);
  r := pg_temp.as_try('d159_direct@d.test', format($q$insert into public.leads(org_id, name, status) values (%L, 'D159 lead', 'new') returning id::text$q$, v_org));
  perform pg_temp.t('direct: app write refused (payment_pending)', r like 'err:25006:%Choose a plan%', r);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_studio_account_update('{"legal_business_name":"D159 Pvt Ltd","country":"IN","state":"Telangana","billing_address":"1 Road"}'::jsonb)::text$q$);
  perform pg_temp.t('direct: billing details still save', r like 'ok:%', r);
end $$;

-- 3) live payment: the switch to trial is refused
do $$ declare r text; begin
  update public.helm_billing_settings set online_payments_live = true where id;
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: refused while online payment is live', r like 'err:42501:%online payment is available%', r);
  update public.helm_billing_settings set online_payments_live = false where id;
end $$;
-- 4) payment off: switch to the free trial lifts the gate
do $$ declare r text; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'd159_direct@d.test';
  r := pg_temp.as_try('d159_trial@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: a user with no studio is refused', r like 'err:42501:%', r);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: started', r like '%"result": "started"%', r);
  perform pg_temp.t('switch: org now a trial (own data)',
    exists (select 1 from public.organizations o where o.id = v_org and o.trial_ends_at > now() and o.trial_mode = 'own'), null);
  perform pg_temp.t('switch: trial subscription row',
    exists (select 1 from public.studio_subscriptions s where s.org_id = v_org and s.status = 'trial' and s.trial_source = 'payment_pending'), null);
  perform pg_temp.t('switch: no longer pending', not public._studio_payment_pending(v_org), null);
end $$;
do $$ declare r text; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'd159_direct@d.test';
  r := pg_temp.as_try('d159_direct@d.test', format($q$insert into public.leads(org_id, name, status) values (%L, 'D159 lead', 'new') returning id::text$q$, v_org));
  perform pg_temp.t('switch: app write now allowed', r like 'ok:%', r);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: second call is a no-op', r like '%not_pending%', r);
  r := pg_temp.as_try('d159_direct@d.test', $q$select public.my_checkout_status()::text$q$);
  perform pg_temp.t('switch: checkout no longer required', r like '%"required": false%', r);
end $$;

-- 5) the free-trial path is never gated
do $$ declare r text; v_org uuid; begin
  r := pg_temp.as_try('d159_trial@d.test', $q$select public.start_self_serve_trial('D159 Trial', 'Asia/Kolkata', 'INR', 'own')::text$q$);
  perform pg_temp.t('trial: started', r like '%"result": "started"%', r);
end $$;
do $$ declare r text; v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'd159_trial@d.test';
  perform pg_temp.t('trial: not pending', not public._studio_payment_pending(v_org), null);
  r := pg_temp.as_try('d159_trial@d.test', format($q$insert into public.leads(org_id, name, status) values (%L, 'D159 trial lead', 'new') returning id::text$q$, v_org));
  perform pg_temp.t('trial: app write allowed', r like 'ok:%', r);
  r := pg_temp.as_try('d159_trial@d.test', $q$select public.my_checkout_status()::text$q$);
  perform pg_temp.t('trial: checkout not required', r like '%"required": false%', r);
end $$;

-- 6) existing studios (fixture A, no marker) are grandfathered
do $$ declare r text; begin
  perform pg_temp.t('existing: studio A not pending', not public._studio_payment_pending('a0000000-0000-4000-8000-000000000001'), null);
  r := pg_temp.as_try('a_admin@a.test', $q$insert into public.leads(org_id, name, status) values ('a0000000-0000-4000-8000-000000000001', 'D159 A lead', 'new') returning id::text$q$);
  perform pg_temp.t('existing: studio A write allowed', r like 'ok:%', r);
end $$;

-- 7) an HQ-granted / paid subscription lifts the gate; a checkout-only row does not
do $$ declare r text; begin
  r := pg_temp.as_try('d159_hq@d.test', $q$select public.create_studio('D159 HQ Studio', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('hq: direct studio created', r like 'ok:%', r);
end $$;
do $$ declare v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'd159_hq@d.test';
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, provider, provider_subscription_id, updated_at)
    values (v_org, 'trial', current_date + 8, 'checkout', 'razorpay', 'sub_D159TEST01', now());
  perform pg_temp.t('hq: opened-but-unpaid checkout keeps it pending', public._studio_payment_pending(v_org), null);
  update public.studio_subscriptions set status = 'active' where org_id = v_org;
  perform pg_temp.t('hq: active subscription lifts the gate', not public._studio_payment_pending(v_org), null);
end $$;

-- 8) privacy: marker table + helper closed to the app
do $$ declare r text; begin
  r := pg_temp.as_try('d159_direct@d.test', $q$select count(*)::text from public.studio_payment_gate$q$);
  perform pg_temp.t('private: marker table not readable by the app', r like 'err:42501%', r);
  perform pg_temp.t('private: helper not callable by the app', not has_function_privilege('authenticated', 'public._studio_payment_pending(uuid)', 'execute'), null);
  perform pg_temp.t('private: old create_studio body not callable', not has_function_privilege('authenticated', 'public.create_studio__pre0159(text, text, text, text)', 'execute'), null);
  perform pg_temp.t('grants: switch callable by authenticated, not anon',
    has_function_privilege('authenticated', 'public.my_pending_start_trial()', 'execute')
    and not has_function_privilege('anon', 'public.my_pending_start_trial()', 'execute'), null);
end $$;

-- cleanup (disposable DB): remove only what this file created
do $$ declare v_orgs uuid[]; begin
  execute 'reset role';
  select array_agg(org_id) into v_orgs from public.profiles where email in ('d159_direct@d.test', 'd159_trial@d.test', 'd159_hq@d.test');
  delete from public.leads where name in ('D159 A lead');
  update public.helm_billing_settings set online_payments_live = false where id;
end $$;

select case when count(*) filter (where result <> 'PASS') = 0
            then 'DIRECT-STUDIO-0159: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'DIRECT-STUDIO-0159: FAIL' end as summary from _d159;
select name, result from _d159 where result <> 'PASS';
