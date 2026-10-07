-- mfa-enforce.sql — 0043 (owner D3): enrolled members need aal2 at the database.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _mf(n serial, name text, result text);
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_aal(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  set local role authenticated;
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _mf(name, result) values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate||' '||sqlerrm; end $$;
grant execute on function pg_temp.try(text) to authenticated, anon;

do $$ begin perform pg_temp.su();
  insert into auth.mfa_factors(user_id, status) select id, 'verified' from auth.users where email = 'a_staff@a.test';
  insert into auth.mfa_factors(user_id, status) select id, 'unverified' from auth.users where email = 'b_staff@b.test';
end $$;

do $$ declare o uuid; n int; s text; begin
  perform pg_temp.as_aal('a_staff@a.test', 'aal1');
  o := public.current_org_id(); select count(*) into n from public.quotes;
  s := pg_temp.try($q$select public.bell_feed(5)$q$);
  perform pg_temp.res('01 denied: enrolled member at aal1 has no studio (org NULL, 0 quotes)', o is null and n = 0, coalesce(o::text,'∅')||' '||n);
  perform pg_temp.as_aal('a_staff@a.test', 'aal1');
  s := pg_temp.try($q$select public.record_payment('a0000000-0000-4000-8000-00000000da01', 10)$q$);
  perform pg_temp.res('02 denied: enrolled member at aal1 can''t call a studio RPC', s like '42501%', s);
  perform pg_temp.as_aal('a_staff@a.test', 'aal1');
  s := pg_temp.try($q$update public.quotes set title = 'x' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
  perform pg_temp.su();
  perform pg_temp.res('03 denied: enrolled member at aal1 can''t write through the API',
    (select title from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') <> 'x', s);
  perform pg_temp.as_aal('a_staff@a.test', 'aal2');
  o := public.current_org_id(); select count(*) into n from public.quotes;
  perform pg_temp.res('04 allowed: the same member at aal2 sees Studio A', o = 'a0000000-0000-4000-8000-000000000001' and n >= 1, coalesce(o::text,'∅')||' '||n);
  perform pg_temp.as_aal('a_staff@a.test', 'aal2');
  select count(*) into n from public.quotes where org_id = 'b0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('05 Org A at aal2 still reads 0 Org B quotes', n = 0, n::text);
  perform pg_temp.as_aal('a_admin@a.test', 'aal1');
  o := public.current_org_id();
  perform pg_temp.res('06 allowed: a member without a factor at aal1 is unaffected', o = 'a0000000-0000-4000-8000-000000000001', coalesce(o::text,'∅'));
  perform pg_temp.as_aal('b_staff@b.test', 'aal1');
  o := public.current_org_id();
  perform pg_temp.res('07 allowed: an UNVERIFIED (abandoned) enrolment doesn''t lock anyone out', o = 'b0000000-0000-4000-8000-000000000001', coalesce(o::text,'∅'));
  perform pg_temp.su(); perform auth.login_anon();
  s := pg_temp.try($q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000bb')$q$);
  perform pg_temp.res('08 visitors (client links) unaffected', s = '', s);
  perform pg_temp.su();
  perform pg_temp.res('09 service role / owner unaffected; clone private',
    to_regprocedure('public.current_org_id__pre0043()') is not null
    and not has_function_privilege('authenticated', 'public.current_org_id__pre0043()', 'execute'), '');
end $$;
do $$ declare ok boolean; begin perform pg_temp.su();
  update public.profiles set org_id = null where email = 'b_staff@b.test';
  insert into public.platform_admins(email, added_by) values ('b_staff@b.test', 'test') on conflict do nothing;
  update auth.mfa_factors set status = 'verified' where user_id = (select id from auth.users where email = 'b_staff@b.test');
  perform pg_temp.as_aal('b_staff@b.test', 'aal2'); ok := public.is_platform_admin();
  perform pg_temp.res('10 HQ operator (enrolled) at aal2 still works', ok, '');
  perform pg_temp.as_aal('b_staff@b.test', 'aal1'); ok := public.is_platform_admin();
  perform pg_temp.res('11 HQ operator at aal1 is not (unchanged rule)', not ok, '');
end $$;
\i ../../supabase/migrations/0043_mfa_enforce.sql
do $$ begin perform pg_temp.su();
  perform pg_temp.res('12 re-apply is a no-op (one clone, same wrapper)',
    (select count(*) from pg_proc where proname = 'current_org_id__pre0043') = 1
    and pg_get_functiondef('public.current_org_id()'::regprocedure) like '%mfa-enforce-0043%', '');
end $$;
select n, name, result from _mf order by n;
select case when count(*) filter (where result <> 'PASS') = 0 then 'MFA-ENFORCE: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'MFA-ENFORCE: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end from _mf;
rollback;
