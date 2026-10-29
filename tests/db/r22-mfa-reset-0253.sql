-- r22-mfa-reset-0253.sql -- r22 "make 2-step (MFA) working": the server-side two-step rules end to end and the
-- 0253 Helm-HQ-assisted reset for a lost phone (aal2 operator only, never self, reason, rate limit, audit, append-only
-- log, factor marked unverified - never deleted). Rolled back. Local disposable PG only. Fake data only.
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
create or replace function pg_temp.verified(p_email text) returns int language sql as $$
  select count(*)::int from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = p_email and f.status = 'verified' $$;
create or replace function pg_temp.total(p_email text) returns int language sql as $$
  select count(*)::int from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = p_email $$;

-- ---- setup: two operators (admin@ and ops2@, both with two-step), studio users from the fixture ------------------
do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  insert into public.platform_admins(email, added_by) values ('ops2@helm.events', 'test') on conflict do nothing;
  if not exists (select 1 from auth.users where email = 'ops2@helm.events') then perform auth.seed_user('ops2@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'ops2@helm.events';
  delete from auth.mfa_factors where user_id in (select id from auth.users where email in ('admin@helm.events', 'ops2@helm.events', 'a_staff@a.test', 'b_admin@b.test'));
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email in ('admin@helm.events', 'ops2@helm.events', 'a_staff@a.test');
  update public.helm_hq_settings set hq_require_mfa = true where id;
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) the existing server-side two-step rules (0028 / 0043 / 0047) -------------------------------------------------
do $$ declare v uuid; e text; begin
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  v := public.current_org_id();
  perform pg_temp.res('01 studio member WITH two-step at aal1: no studio (0043 - every RLS check fails closed)', v is null, coalesce(v::text, 'null'));
  perform pg_temp.as_user('a_staff@a.test', 'aal2');
  v := public.current_org_id();
  perform pg_temp.res('02 same member at aal2: studio back', v is not null);
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  v := public.current_org_id();
  perform pg_temp.res('03 member WITHOUT two-step at aal1: unaffected', v is not null);
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  perform pg_temp.res('04 HQ operator with two-step at aal1: is_platform_admin() = false (must enter the code)', not public.is_platform_admin());
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('05 HQ RPC at aal1 refused (42501)', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform pg_temp.res('06 HQ operator at aal2: admitted', public.is_platform_admin());
  e := pg_temp.try('select public.hq_set_require_mfa(true)');
  perform pg_temp.res('07 HQ write at aal2 (switch on): allowed', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) hq_mfa_reset: who may ---------------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su(); perform auth.login_anon();
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''phone lost - verified by call'')');
  perform pg_temp.res('08 anon refused', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''phone lost - verified by call'')');
  perform pg_temp.res('09 studio admin (even at aal2) refused - studio admins cannot reset two-step', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''phone lost - verified by call'')');
  perform pg_temp.res('10 operator at aal1 refused', e like '42501%', e);
  -- switch OFF and an operator WITHOUT two-step: HQ is open at aal1, the reset still is not
  perform pg_temp.su();
  update public.helm_hq_settings set hq_require_mfa = false where id;
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'ops2@helm.events');
  perform pg_temp.as_user('ops2@helm.events', 'aal1');
  perform pg_temp.res('11a switch off: r27 (0277) operator without two-step still has no HQ at aal1 (two-step always)', not public.is_platform_admin());
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''phone lost - verified by call'')');
  perform pg_temp.res('11b ... but cannot reset anyone (aal2 always required)', e like '42501%', e);
  perform pg_temp.su();
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'ops2@helm.events';
  update public.helm_hq_settings set hq_require_mfa = true where id;
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_mfa_reset(''admin@helm.events'', ''lost my own phone, please'')');
  perform pg_temp.res('12 no self-bypass: own account refused', e like '42501%own two-step%', e);
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''short'')');
  perform pg_temp.res('13 reason under 10 characters refused', e like '22023%reason%', e);
  e := pg_temp.try('select public.hq_mfa_reset(''nobody@nowhere.test'', ''phone lost - verified by call'')');
  perform pg_temp.res('14 unknown e-mail: clear error', e like 'P0002%No Helm account%', e);
  perform pg_temp.su();
  perform pg_temp.res('15 refused attempts changed nothing (factor still verified, no log row)',
    pg_temp.verified('a_staff@a.test') = 1 and pg_temp.verified('admin@helm.events') = 1
    and not exists (select 1 from public.mfa_resets));
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) hq_mfa_reset: what it does -----------------------------------------------------------------------------------
do $$ declare r jsonb; e text; n0 int; v uuid; begin
  perform pg_temp.su(); n0 := pg_temp.total('a_staff@a.test');
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_mfa_reset('b_admin@b.test', 'no factor here, just checking');
  perform pg_temp.su();
  perform pg_temp.res('16 account without two-step: nothing to reset, nothing logged',
    (r ->> 'factors_reset')::int = 0 and not exists (select 1 from public.mfa_resets), r::text);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_mfa_reset('  A_Staff@A.test ', 'phone lost - identity checked by call');
  perform pg_temp.su();
  perform pg_temp.res('17 reset: factor marked unverified, NOT deleted (row count unchanged)',
    (r ->> 'factors_reset')::int = 1 and pg_temp.verified('a_staff@a.test') = 0 and pg_temp.total('a_staff@a.test') = n0, r::text);
  perform pg_temp.res('18 reset logged in mfa_resets (who, whom, why)',
    exists (select 1 from public.mfa_resets m join auth.users t on t.id = m.target_user_id join auth.users o on o.id = m.operator_user_id
      where t.email = 'a_staff@a.test' and o.email = 'admin@helm.events' and m.reason = 'phone lost - identity checked by call' and m.factors_reset = 1));
  perform pg_temp.res('19 reset audited (audit_log hq.mfa.reset)',
    exists (select 1 from public.audit_log where action = 'hq.mfa.reset' and entity = 'auth_user'
      and entity_id = (select id::text from auth.users where email = 'a_staff@a.test')));
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  v := public.current_org_id();
  perform pg_temp.res('20 after the reset the member signs in at aal1 and has their studio (then sets two-step up again)', v is not null);
  r := public.my_mfa_reset_info();
  perform pg_temp.res('21 my_mfa_reset_info: the member sees when (no operator identity)', r ? 'reset_at' and not (r ? 'operator_email') and not (r ? 'reason'), coalesce(r::text, 'null'));
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  perform pg_temp.res('22 my_mfa_reset_info: someone else sees nothing', public.my_mfa_reset_info() is null);
  e := pg_temp.try('select count(*) from public.mfa_resets');
  perform pg_temp.res('23 mfa_resets not readable by app users', e like '42501%', e);
  perform pg_temp.su(); perform auth.login_anon();
  e := pg_temp.try('select public.my_mfa_reset_info()');
  perform pg_temp.res('24 my_mfa_reset_info closed to anon', e like '42501%', e);
  -- r57 (0298, G-HQ-3): an HQ team member's two-step is reset only by the HQ Owner - an HQ Admin is refused
  perform pg_temp.as_user('ops2@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_mfa_reset(''admin@helm.events'', ''operator phone lost - checked in person'')');
  if to_regprocedure('public.hq_mfa_reset__pre0298(text,text)') is not null and e not like '42501%Only the Helm HQ Owner%' then
    raise exception 'r57: an HQ Admin was not refused: %', e; end if;
  perform pg_temp.su(); update public.platform_admins set role = 'owner' where email = 'ops2@helm.events';
  -- the Owner (ops2 now) may reset admin@ (another operator), and the operator then has to set it up again (switch on)
  perform pg_temp.as_user('ops2@helm.events', 'aal2');
  r := public.hq_mfa_reset('admin@helm.events', 'operator phone lost - checked in person');
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  perform pg_temp.res('25 another operator may reset an operator; switch on -> that operator has no HQ until set-up again',
    (r ->> 'factors_reset')::int = 1 and not public.is_platform_admin(), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) append-only log + rate limit -----------------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  e := pg_temp.try('update public.mfa_resets set reason = ''x''');
  perform pg_temp.res('26 mfa_resets: update refused even for the database owner', e like '42501%append-only%', e);
  e := pg_temp.try('delete from public.mfa_resets');
  perform pg_temp.res('27 mfa_resets: delete refused even for the database owner', e like '42501%append-only%', e);
  insert into public.mfa_resets(target_user_id, operator_user_id, reason)
    select gen_random_uuid(), (select id from auth.users where email = 'ops2@helm.events'), 'filler for the rate limit' from generate_series(1, 9);
  insert into auth.mfa_factors(user_id, factor_type, status) select id, 'totp', 'verified' from auth.users where email = 'a_staff@a.test';
  perform pg_temp.as_user('ops2@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_mfa_reset(''a_staff@a.test'', ''phone lost - verified by call'')');
  perform pg_temp.su();
  perform pg_temp.res('28 rate limit: 11th reset in 24 h refused, factor untouched', e like 'P0001%Too many%' and pg_temp.verified('a_staff@a.test') = 1, e);
  perform pg_temp.res('29 grants: authenticated may call hq_mfa_reset (gate inside) + my_mfa_reset_info; anon neither',
    has_function_privilege('authenticated', 'public.hq_mfa_reset(text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_mfa_reset(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_mfa_reset_info()', 'execute')
    and not has_function_privilege('anon', 'public.my_mfa_reset_info()', 'execute')
    and not has_table_privilege('authenticated', 'public.mfa_resets', 'insert'));
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R22-MFA-RESET-0253: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R22-MFA-RESET-0253: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
