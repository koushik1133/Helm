-- hq-mfa-optional.sql — 0047 one switch decides whether HQ operators need two-step.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ho; create temp table _ho(name text, result text); grant all on _ho to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin perform pg_temp.su(); insert into _ho values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if coalesce(c, '') <> '' then perform set_config('request.jwt.claims', c, false); end if;
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.flag(p boolean) returns void language plpgsql as $$
begin perform pg_temp.su(); update public.helm_hq_settings set hq_require_mfa = p where id; end $$;
-- one HQ read + one HQ write as the caller → 'read|write' SQLSTATEs ('' = allowed)
create or replace function pg_temp.rw() returns text language plpgsql as $$
begin return pg_temp.try('select public.hq_overview()') || '|' ||
              pg_temp.try('select public.hq_set_billing_settings(''Helm'', null, null, 18, ''HELM-'')'); end $$;
grant execute on function pg_temp.rw() to anon, authenticated, service_role;

do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  if not exists (select 1 from auth.users where email = 'security@helm.events') then perform auth.seed_user('security@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email in ('admin@helm.events', 'security@helm.events');
  update public.platform_admins set require_mfa = true;   -- the per-operator flag must not matter when the switch is off
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
  -- admin@ has an authenticator; security@ has none
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'admin@helm.events';
end $$;

-- ---- switch OFF ------------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.flag(false);
  perform pg_temp.as_user('security@helm.events', 'aal1'); execute 'set role authenticated';
  r := pg_temp.rw();
  perform pg_temp.res('01 off: operator without two-step at aal1 may read + write HQ', r = '|', r);
  perform pg_temp.res('02 off: operator_mfa_required() says false', public.operator_mfa_required() = false);
  perform pg_temp.res('03 off: is_platform_admin() true at aal1 (no factor)', public.is_platform_admin());
  perform pg_temp.as_user('admin@helm.events', 'aal1'); execute 'set role authenticated';
  r := pg_temp.rw();
  perform pg_temp.res('04 off: operator WITH an authenticator at aal1 is still challenged (refused)', r = '42501|42501', r);
  perform pg_temp.as_user('admin@helm.events', 'aal2'); execute 'set role authenticated';
  r := pg_temp.rw();
  perform pg_temp.res('05 off: operator at aal2 allowed', r = '|', r);
  perform pg_temp.as_user('a_admin@a.test', 'aal1'); execute 'set role authenticated';
  r := pg_temp.rw(); perform pg_temp.res('06 off: non-operator (aal1) refused', r = '42501|42501', r);
  perform pg_temp.as_user('a_admin@a.test', 'aal2'); execute 'set role authenticated';
  r := pg_temp.rw(); perform pg_temp.res('07 off: non-operator (aal2) refused', r = '42501|42501' and not public.is_platform_admin(), r);
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  r := pg_temp.rw() || pg_temp.try('select public.operator_mfa_required()') || pg_temp.try('select public.hq_set_require_mfa(true)');
  perform pg_temp.res('08 anon refused everywhere', r = '42501|425014250142501', r);
end $$;

-- ---- switch ON (pre-0047 behaviour) -----------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.flag(true);
  perform pg_temp.as_user('security@helm.events', 'aal1'); execute 'set role authenticated';
  r := pg_temp.rw();
  perform pg_temp.res('09 on: operator (require_mfa) at aal1 refused read + write', r = '42501|42501', r);
  perform pg_temp.res('10 on: operator_mfa_required() says true', public.operator_mfa_required());
  perform pg_temp.su(); update public.platform_admins set require_mfa = false;
  perform pg_temp.as_user('security@helm.events', 'aal1'); execute 'set role authenticated';
  r := pg_temp.rw();
  perform pg_temp.res('11 on: operator without factor/require_mfa at aal1 may read, write refused', r = '|42501', r);
  perform pg_temp.as_user('admin@helm.events', 'aal2'); execute 'set role authenticated';
  r := pg_temp.rw(); perform pg_temp.res('12 on: operator at aal2 allowed', r = '|', r);
  perform pg_temp.as_user('a_admin@a.test', 'aal2'); execute 'set role authenticated';
  r := pg_temp.rw() || pg_temp.try('select public.hq_set_require_mfa(false)');
  perform pg_temp.res('13 on: non-operator refused (incl. the switch)', r = '42501|4250142501', r);
end $$;

-- ---- who may flip the switch; audit -----------------------------------------------------------
do $$ declare r text; n int; begin
  perform pg_temp.as_user('security@helm.events', 'aal1'); execute 'set role authenticated';
  r := pg_temp.try('select public.hq_set_require_mfa(false)');
  perform pg_temp.res('14 on: operator at aal1 cannot switch it off', r = '42501', r);
  perform pg_temp.as_user('admin@helm.events', 'aal2'); execute 'set role authenticated';
  r := pg_temp.try('select public.hq_set_require_mfa(false)');
  perform pg_temp.su(); select count(*) into n from public.audit_log where action = 'hq.settings.require_mfa' and entity = 'helm_hq_settings';
  perform pg_temp.res('15 operator at aal2 switches it off; audited', r = '' and not public._hq_require_mfa() and n >= 2, r || ' n=' || n);
  perform pg_temp.as_user('a_admin@a.test', 'aal2'); execute 'set role authenticated';
  r := pg_temp.try('select * from public.helm_hq_settings') || '|' || pg_temp.try('update public.helm_hq_settings set hq_require_mfa = true');
  perform pg_temp.res('16 table not readable / writable by clients', r = '42501|42501', r);
  perform pg_temp.su();
  r := pg_temp.try('delete from public.helm_hq_settings');
  perform pg_temp.res('17 the settings row cannot be deleted', r = '42501' and exists (select 1 from public.helm_hq_settings), r);
end $$;

do $$ begin perform pg_temp.su();
  update public.helm_hq_settings set hq_require_mfa = true where id;
  update public.platform_admins set require_mfa = false;
  delete from auth.mfa_factors where user_id in (select id from auth.users where email like '%@helm.events');
end $$;
select name, result from _ho order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 17 then 'HQ-MFA-OPTIONAL: ALL PASS (17/17)'
            else 'HQ-MFA-OPTIONAL: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/17 ran' end from _ho;
