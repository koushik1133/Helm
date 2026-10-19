-- r21-security-0249.sql -- 0249: HQ two-step readiness report, the guard on the hq_require_mfa switch (no lock-out
-- of operators who have not enrolled), and the dormant captcha pass on "Contact sales" (rpc_captcha_required).
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.sales(p_plan text, p_iv text) returns text language plpgsql as $$
begin return pg_temp.try(format('select public.request_plan_activation(%L, %L, ''Studio A'', ''Asha'', ''asha@a.test'')', p_plan, p_iv)); end $$;
grant execute on function pg_temp.sales(text, text) to authenticated;

-- ---- setup: known operator state (admin@ has a login and no authenticator; security@ never signed in) ------
-- run-all.sh switches the 0249 guard off for the other suites' fixtures (helm.allow_hq_mfa_lockout=on); this suite
-- tests the guard itself, so it is switched back on for this session
select set_config('helm.allow_hq_mfa_lockout', 'off', false);
do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  delete from auth.mfa_factors where user_id in (select id from auth.users where email in ('admin@helm.events', 'security@helm.events'));
  delete from public.platform_admins where email not in ('admin@helm.events', 'security@helm.events');
  delete from auth.users where email = 'security@helm.events';
  update public.helm_hq_settings set hq_require_mfa = false, rpc_captcha_required = false where id;
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) readiness report -------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try('select public.hq_mfa_readiness()');
  perform pg_temp.res('01 readiness: a studio admin is refused', e like '42501%', e);
  perform pg_temp.su(); perform auth.login_anon();
  e := pg_temp.try('select public.hq_mfa_readiness()');
  perform pg_temp.res('02 readiness: anon is refused', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  r := public.hq_mfa_readiness();
  perform pg_temp.res('03 readiness: operator sees every operator with login + two-step state',
    r -> 'operators' @> '[{"email":"admin@helm.events","has_login":true,"has_2step":false,"is_me":true}]'::jsonb
    and r -> 'operators' @> '[{"email":"security@helm.events","has_login":false,"has_2step":false}]'::jsonb, r::text);
  perform pg_temp.res('04 readiness: counts + not safe yet (switch off)',
    (r ->> 'operators_without_2step')::int = 1 and (r ->> 'operators_never_signed_in')::int = 1
    and (r ->> 'operators_with_2step')::int = 0 and (r ->> 'safe_to_require')::boolean = false
    and (r ->> 'hq_require_mfa')::boolean = false and (r ->> 'rpc_captcha_required')::boolean = false, r::text);
  perform pg_temp.res('05 readiness: studio admins counted (two-step for the config flag)',
    (r -> 'studio_admins' ->> 'total')::int >= 2 and (r -> 'studio_admins' ->> 'with_2step')::int = 0, r::text);
  perform pg_temp.su();
  perform pg_temp.res('06 readiness: the read is logged as an HQ view', exists (select 1 from public.audit_log where action = 'hq.view' and entity = 'hq_mfa_readiness'));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) the guard: no lock-out ---------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.su();
  e := pg_temp.try('update public.helm_hq_settings set hq_require_mfa = true where id');
  perform pg_temp.res('07 guard: SQL-editor flip ON refused while admin@ has no authenticator (names it)',
    e like 'P0001%admin@helm.events%' and e not like '%security@helm.events%'
    and not (select hq_require_mfa from public.helm_hq_settings where id), e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_set_require_mfa(true)');
  perform pg_temp.su();
  perform pg_temp.res('08 guard: HQ flip ON refused too, switch stays off', e like 'P0001%' and not (select hq_require_mfa from public.helm_hq_settings where id), e);
  -- admin@ enrols
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'admin@helm.events';
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_mfa_readiness();
  perform pg_temp.res('09 readiness: safe once every operator with a login has two-step (never-signed-in = pending, not blocking)',
    (r ->> 'safe_to_require')::boolean and (r ->> 'operators_without_2step')::int = 0 and (r ->> 'operators_with_2step')::int = 1, r::text);
  e := pg_temp.try('select public.hq_set_require_mfa(true)');
  perform pg_temp.su();
  perform pg_temp.res('10 guard: flip ON allowed now, and audit-logged', e = '' and (select hq_require_mfa from public.helm_hq_settings where id)
    and exists (select 1 from public.audit_log where action = 'hq.settings.require_mfa'), e);
  -- a new operator with a login joins while ON: nothing breaks; turning OFF is never blocked; ON again is refused
  insert into public.platform_admins(email, added_by) values ('ops-new@helm.events', 'test');   -- first: 0248 reserves helm.events
  perform auth.seed_user('ops-new@helm.events');
  update auth.users set email_confirmed_at = now() where email = 'ops-new@helm.events';
  e := pg_temp.try('update public.helm_hq_settings set hq_require_mfa = false where id');
  perform pg_temp.res('11 guard: turning OFF is never blocked', e = '' and not (select hq_require_mfa from public.helm_hq_settings where id), e);
  e := pg_temp.try('update public.helm_hq_settings set hq_require_mfa = true where id');
  perform pg_temp.res('12 guard: ON again refused, names the new operator', e like 'P0001%ops-new@helm.events%', e);
  perform set_config('helm.allow_hq_mfa_lockout', 'on', false);
  e := pg_temp.try('update public.helm_hq_settings set hq_require_mfa = true where id');
  perform pg_temp.res('12b test-harness bypass (helm.allow_hq_mfa_lockout=on) works only when set explicitly', e = '', e);
  update public.helm_hq_settings set hq_require_mfa = false where id;
  perform set_config('helm.allow_hq_mfa_lockout', 'off', false);
  e := pg_temp.try('update public.helm_hq_settings set updated_by = null where id');
  perform pg_temp.res('13 guard: other updates of the row still work', e = '', e);
  -- a bound operator (user_id set) is judged by THAT login
  update public.platform_admins set user_id = (select id from auth.users where email = 'admin@helm.events') where email = 'ops-new@helm.events';
  perform pg_temp.res('14 bound operator: judged by the bound login (has two-step)',
    exists (select 1 from public._a249_operator_rows() o where o.email = 'ops-new@helm.events' and o.has_2step));
  delete from public.platform_admins where email = 'ops-new@helm.events';
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) captcha pass on Contact sales (dormant by default) -----------------------------------------------------
do $$ declare e text; n0 int; begin
  perform pg_temp.su();
  update public.helm_hq_settings set rpc_captcha_required = false where id;
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('starter', 'monthly');
  perform pg_temp.su();
  perform pg_temp.res('15 switch OFF: Contact sales works with no captcha (unchanged)', e = '' and exists (select 1 from public.sales_requests where plan_code = 'starter' and billing_interval = 'monthly'), e);
  update public.helm_hq_settings set rpc_captcha_required = true where id;
  perform pg_temp.res('16 switch ON is audit-logged', exists (select 1 from public.audit_log where action = 'hq.settings.rpc_captcha'));
  select count(*) into n0 from public.sales_requests;
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'monthly');
  perform pg_temp.su();
  perform pg_temp.res('17 switch ON: no pass -> refused (42501, captcha), nothing saved', e like '42501%security check%' and (select count(*) from public.sales_requests) = n0, e);
  perform public.captcha_pass_record((select id from auth.users where email = 'a_admin@a.test'), 'sales');
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'monthly');
  perform pg_temp.su();
  perform pg_temp.res('18 switch ON: a fresh pass -> saved, and the pass is used up',
    e = '' and exists (select 1 from public.sales_requests where plan_code = 'studio')
    and not exists (select 1 from public.captcha_passes c join auth.users u on u.id = c.user_id where u.email = 'a_admin@a.test' and c.used_at is null), e);
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'yearly');
  perform pg_temp.su();
  perform pg_temp.res('19 a used pass does not work twice', e like '42501%', e);
  perform public.captcha_pass_record((select id from auth.users where email = 'a_admin@a.test'), 'sales');
  update public.captcha_passes set created_at = now() - interval '11 minutes' where used_at is null;
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'yearly');
  perform pg_temp.su();
  perform pg_temp.res('20 a pass older than 10 minutes does not work', e like '42501%', e);
  perform public.captcha_pass_record((select id from auth.users where email = 'b_admin@b.test'), 'sales');
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'yearly');
  perform pg_temp.su();
  perform pg_temp.res('21 another user''s pass does not help', e like '42501%', e);
  e := pg_temp.try($q$insert into public.sales_requests(org_id, plan_code, studio_name, contact_name, contact_email) values (null, 'starter', 'S', 'N', 'n@x.test')$q$);
  perform pg_temp.res('22 service role / SQL editor inserts need no captcha', e = '', e);
  e := pg_temp.try($q$select public.captcha_pass_record((select id from auth.users where email = 'a_admin@a.test'), 'trial')$q$)
    || '|' || pg_temp.try($q$select public.captcha_pass_record(gen_random_uuid(), 'sales')$q$)
    || '|' || pg_temp.try($q$select public.captcha_pass_record(null, 'sales')$q$);
  perform pg_temp.res('23 captcha_pass_record validates action + user', e like '22023%|22023%|22023%', e);
  update public.helm_hq_settings set rpc_captcha_required = false where id;
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.sales('studio', 'yearly');
  perform pg_temp.su();
  perform pg_temp.res('24 switch OFF again: requests flow without a pass', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) grants -----------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('25 app roles cannot record / consume passes or read the operator helper',
    not has_function_privilege('authenticated', 'public.captcha_pass_record(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.captcha_pass_record(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._captcha_consume(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._a249_operator_rows()', 'execute')
    and not has_function_privilege('authenticated', 'public._a249_has_factor(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.captcha_pass_record(uuid,text)', 'execute'));
  perform pg_temp.res('26 captcha_passes: RLS on, no policies, no app grants',
    (select relrowsecurity from pg_class where oid = 'public.captcha_passes'::regclass)
    and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captcha_passes')
    and not has_table_privilege('authenticated', 'public.captcha_passes', 'select')
    and not has_table_privilege('anon', 'public.captcha_passes', 'insert'));
  perform pg_temp.res('27 hq_mfa_readiness: authenticated may call (gate inside), anon may not',
    has_function_privilege('authenticated', 'public.hq_mfa_readiness()', 'execute')
    and not has_function_privilege('anon', 'public.hq_mfa_readiness()', 'execute'));
  perform pg_temp.res('28 defaults: both switches OFF on a fresh install',
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'helm_hq_settings' and column_name = 'rpc_captcha_required') = 'false');
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-SECURITY-0249: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-SECURITY-0249: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
