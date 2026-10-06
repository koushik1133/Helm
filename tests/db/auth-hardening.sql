-- ============================================================================
-- auth-hardening.sql — 0028: password rule + bcrypt cost, no cross-tenant email
-- oracle, temp-password flow fails closed, mfa_ok() + my_auth_info() helpers.
-- Requires: canonical migrations (0028) + 10-fixtures.sql. Local disposable PG only.
-- Prints one row per case; final line 'AUTH-HARDENING: ALL PASS (N/N)'.
-- ============================================================================
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _ah;
create temp table _ah(n int, name text, result text);
grant all on _ah to anon, authenticated;
-- re-runnable: drop what this suite creates
delete from public.auth_temp_passwords where user_id in (select id from auth.users where email like 'ah\_%');
delete from public.profiles where email like 'ah\_%';
delete from auth.mfa_factors where user_id in (select id from auth.users where email like 'ah\_%' or email in ('a_staff@a.test','b_staff@b.test'));
delete from auth.sessions where user_id in (select id from auth.users where email in ('a_staff@a.test','b_staff@b.test'));
delete from auth.identities where user_id in (select id from auth.users where email like 'ah\_%');
delete from auth.users where email like 'ah\_%';

-- 1-5) the password rule itself
insert into _ah select 1, '_password_ok rejects 11 chars',          case when not public._password_ok('abcdefghi12') then 'PASS' else 'FAIL' end;
insert into _ah select 2, '_password_ok rejects letters only',      case when not public._password_ok('abcdefghijklmnop') then 'PASS' else 'FAIL' end;
insert into _ah select 3, '_password_ok rejects digits only',       case when not public._password_ok('123456789012345') then 'PASS' else 'FAIL' end;
insert into _ah select 4, '_password_ok rejects null',              case when not coalesce(public._password_ok(null), false) then 'PASS' else 'FAIL' end;
insert into _ah select 5, '_password_ok accepts 12 chars letter+digit', case when public._password_ok('abcdefghij12') then 'PASS' else 'FAIL' end;

-- 6) drift-safe wrapper: core kept private, wrapper carries the marker
insert into _ah select 6, 'admin_create_user is the 0028 wrapper; old body kept as private core',
  case when pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) like '%auth-hardening-0028%'
        and to_regprocedure('public._admin_create_user_core(text,text,text)') is not null then 'PASS' else 'FAIL' end;
-- 7) grants
insert into _ah select 7, 'core + _password_ok not callable by anon/authenticated; wrapper callable by authenticated only',
  case when not has_function_privilege('authenticated','public._admin_create_user_core(text,text,text)','EXECUTE')
        and not has_function_privilege('anon','public._admin_create_user_core(text,text,text)','EXECUTE')
        and not has_function_privilege('anon','public._password_ok(text)','EXECUTE')
        and has_function_privilege('authenticated','public.admin_create_user(text,text,text)','EXECUTE')
        and not has_function_privilege('anon','public.admin_create_user(text,text,text)','EXECUTE')
        and not has_function_privilege('anon','public.admin_create_user_temp(text,text)','EXECUTE')
        and not has_function_privilege('anon','public.my_auth_info()','EXECUTE')
        and not has_table_privilege('authenticated','public.auth_temp_passwords','SELECT')
       then 'PASS' else 'FAIL' end;

-- 8) short password refused server-side
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin perform public.admin_create_user('ah_short@a.test','pw12','sales');
        insert into _ah values (8,'admin_create_user refuses a 4-char password','FAIL: created');
  exception when others then insert into _ah values (8,'admin_create_user refuses a 4-char password',
        case when sqlerrm like '%at least 12%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  perform auth.logout();
end $$;
-- 9) no digit refused
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin perform public.admin_create_user('ah_nodigit@a.test','abcdefghijklmnop','sales');
        insert into _ah values (9,'admin_create_user refuses a password without a digit','FAIL: created');
  exception when others then insert into _ah values (9,'admin_create_user refuses a password without a digit',
        case when sqlerrm like '%letter and a number%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  perform auth.logout();
end $$;
-- 10-12) compliant password: created in own org, bcrypt cost 12, password verifies
do $$ declare v uuid; o uuid; h text; begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin
    v := public.admin_create_user('AH_Good@a.test','Helm-good-pass-2026','sales');
    perform auth.logout();
    select org_id into o from public.profiles where id = v;
    select encrypted_password into h from auth.users where id = v;
    insert into _ah values (10,'compliant password: user created in the admin''s own studio',
      case when o = 'a0000000-0000-4000-8000-000000000001' then 'PASS' else 'FAIL: org='||coalesce(o::text,'null') end);
    insert into _ah values (11,'password stored with bcrypt cost 12', case when h like '$2a$12$%' then 'PASS' else 'FAIL: '||left(h,7) end);
    insert into _ah values (12,'stored hash verifies the password (email lower-cased)',
      case when extensions.crypt('Helm-good-pass-2026', h) = h and exists(select 1 from auth.users where id=v and email='ah_good@a.test')
           then 'PASS' else 'FAIL' end);
  exception when others then
    perform auth.logout();
    insert into _ah values (10,'compliant password: user created','FAIL: '||sqlerrm),(11,'cost 12','FAIL: not created'),(12,'verifies','FAIL: not created');
  end;
end $$;
-- 13) same-studio duplicate keeps the clear message
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin perform public.admin_create_user('a_staff@a.test','Helm-good-pass-2026','sales');
        insert into _ah values (13,'same-studio duplicate: clear "already a user in your studio"','FAIL: created');
  exception when others then insert into _ah values (13,'same-studio duplicate: clear "already a user in your studio"',
        case when sqlerrm like '%already a user in your studio%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  perform auth.logout();
end $$;
-- 14) OTHER studio's email: generic message, no "exists" oracle
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin perform public.admin_create_user('b_staff@b.test','Helm-good-pass-2026','sales');
        insert into _ah values (14,'other-studio email: generic error, no existence oracle','FAIL: created');
  exception when others then insert into _ah values (14,'other-studio email: generic error, no existence oracle',
        case when sqlerrm like 'could not create this user%' and sqlerrm not ilike '%exist%' and sqlerrm not ilike '%b_staff%'
             then 'PASS' else 'FAIL: '||sqlerrm end); end;
  perform auth.logout();
end $$;
-- 15) other studio's user untouched by the probe
insert into _ah select 15, 'probe did not modify the other studio''s user',
  case when (select org_id from public.profiles where email='b_staff@b.test') = 'b0000000-0000-4000-8000-000000000001'
        and (select count(*) from auth.users where email='b_staff@b.test') = 1 then 'PASS' else 'FAIL' end;
-- 16) non-admin still denied (authorization checked before anything else)
do $$ begin
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  begin perform public.admin_create_user('ah_x@a.test','Helm-good-pass-2026','sales');
        insert into _ah values (16,'non-admin -> admin_create_user denied','FAIL: created');
  exception when insufficient_privilege then insert into _ah values (16,'non-admin -> admin_create_user denied','PASS');
            when others then insert into _ah values (16,'non-admin -> admin_create_user denied','FAIL: '||sqlerrm); end;
  perform auth.logout();
end $$;

-- 17-19) temp-password onboarding: compliant temp pw, flag set, cost 12
do $$ declare r jsonb; mcp boolean; h text; tp text; begin
  perform auth.login_as((select id from auth.users where email='a_admin@a.test'));
  begin
    r := public.admin_create_user_temp('ah_temp@a.test','sales');
    perform auth.logout();
    tp := r->>'temp_password';
    select must_change_password into mcp from public.profiles where id=(r->>'user_id')::uuid;
    select encrypted_password into h from auth.users where id=(r->>'user_id')::uuid;
    insert into _ah values (17,'temp password meets the rule (>=12, letter+digit)', case when public._password_ok(tp) then 'PASS' else 'FAIL: '||coalesce(tp,'null') end);
    insert into _ah values (18,'temp user must change password; hash cost 12',
      case when mcp and h like '$2a$12$%' and extensions.crypt(tp,h)=h then 'PASS' else 'FAIL' end);
    insert into _ah values (19,'temp password hash recorded for the fail-closed check',
      case when exists(select 1 from public.auth_temp_passwords where user_id=(r->>'user_id')::uuid and pw_hash=h) then 'PASS' else 'FAIL' end);
  exception when others then
    perform auth.logout();
    insert into _ah values (17,'temp','FAIL: '||sqlerrm),(18,'temp','FAIL'),(19,'temp','FAIL');
  end;
end $$;
-- 20) cannot clear the flag while still on the temp password
do $$ declare m boolean; begin
  perform auth.login_as((select id from auth.users where email='ah_temp@a.test'));
  begin perform public.clear_password_change_required();
        insert into _ah values (20,'clear_password_change_required refused while temp password unchanged','FAIL: cleared');
  exception when others then insert into _ah values (20,'clear_password_change_required refused while temp password unchanged',
        case when sqlerrm like '%set a new password first%' then 'PASS' else 'FAIL: '||sqlerrm end); end;
  perform auth.logout();
end $$;
insert into _ah select 21, 'flag still set after the refused clear',
  case when (select must_change_password from public.profiles where email='ah_temp@a.test') then 'PASS' else 'FAIL' end;
-- 22-23) after a real password change (GoTrue updates encrypted_password) the clear works
update auth.users set encrypted_password = extensions.crypt('Helm-new-pass-2026', extensions.gen_salt('bf', 4)) where email='ah_temp@a.test';
do $$ declare req boolean; begin
  perform auth.login_as((select id from auth.users where email='ah_temp@a.test'));
  begin perform public.clear_password_change_required(); req := public.password_change_required();
        insert into _ah values (22,'after a real change the flag clears', case when req = false then 'PASS' else 'FAIL: still required' end);
  exception when others then insert into _ah values (22,'after a real change the flag clears','FAIL: '||sqlerrm); end;
  perform auth.logout();
end $$;
insert into _ah select 23, 'temp-password bookkeeping row removed after the change',
  case when not exists(select 1 from public.auth_temp_passwords t join auth.users u on u.id=t.user_id where u.email='ah_temp@a.test') then 'PASS' else 'FAIL' end;
-- 24) legacy temp users (no bookkeeping row) can still clear (no lock-out)
do $$ begin
  update public.profiles set must_change_password=true where email='a_staff@a.test';
  perform auth.login_as((select id from auth.users where email='a_staff@a.test'));
  begin perform public.clear_password_change_required();
        insert into _ah values (24,'legacy temp user (no record) is not locked out','PASS');
  exception when others then insert into _ah values (24,'legacy temp user (no record) is not locked out','FAIL: '||sqlerrm); end;
  perform auth.logout();
  update public.profiles set must_change_password=false where email='a_staff@a.test';
end $$;
-- 25) anon cannot clear anything
do $$ begin
  perform auth.login_anon();
  begin perform public.clear_password_change_required();
        insert into _ah values (25,'anon -> clear_password_change_required denied','FAIL: allowed');
  exception when others then insert into _ah values (25,'anon -> clear_password_change_required denied','PASS'); end;
  perform auth.logout();
end $$;

-- 26-29) mfa_ok()
do $$ declare s uuid; r1 boolean; r2 boolean; r3 boolean; r4 boolean; begin
  select id into s from auth.users where email='a_staff@a.test';
  perform auth.login_as(s); r1 := public.mfa_ok(); perform auth.logout();
  insert into auth.mfa_factors(user_id, friendly_name, status) values (s, 'pending', 'unverified');
  perform auth.login_as(s); r2 := public.mfa_ok(); perform auth.logout();
  insert into auth.mfa_factors(user_id, friendly_name, status) values (s, 'phone app', 'verified');
  perform auth.login_as(s); r3 := public.mfa_ok(); perform auth.logout();
  perform auth.login_as(s);
  perform set_config('request.jwt.claims', (auth.jwt() || '{"aal":"aal2"}'::jsonb)::text, false);
  r4 := public.mfa_ok(); perform auth.logout();
  insert into _ah values (26,'mfa_ok: no factor -> true', case when r1 then 'PASS' else 'FAIL' end);
  insert into _ah values (27,'mfa_ok: only an UNverified factor -> true', case when r2 then 'PASS' else 'FAIL' end);
  insert into _ah values (28,'mfa_ok: verified factor + aal1 token -> false', case when not r3 then 'PASS' else 'FAIL' end);
  insert into _ah values (29,'mfa_ok: verified factor + aal2 token -> true', case when r4 then 'PASS' else 'FAIL' end);
end $$;

-- 30-33) my_auth_info(): own data only
do $$ declare a uuid; b uuid; j jsonb; ja jsonb; begin
  select id into a from auth.users where email='a_staff@a.test';
  select id into b from auth.users where email='b_staff@b.test';
  update auth.users set last_sign_in_at = '2026-10-01 09:00+00' where id = a;
  update auth.users set last_sign_in_at = '2026-10-02 10:00+00' where id = b;
  insert into auth.sessions(user_id, aal, user_agent, ip) values (a, 'aal1', 'UA-of-A', '10.0.0.1'), (b, 'aal1', 'UA-of-B', '10.0.0.2');
  perform auth.login_as(a); j := public.my_auth_info(); perform auth.logout();
  insert into _ah values (30,'my_auth_info returns the caller''s own last sign-in',
    case when (j->>'last_sign_in_at')::timestamptz = '2026-10-01 09:00+00' then 'PASS' else 'FAIL: '||coalesce(j::text,'null') end);
  insert into _ah values (31,'my_auth_info lists only the caller''s own sessions',
    case when j->'sessions' @> '[{"user_agent":"UA-of-A"}]' and not (j::text like '%UA-of-B%') then 'PASS' else 'FAIL: '||coalesce(j::text,'null') end);
  insert into _ah values (32,'my_auth_info reports two-step status (a_staff has a verified factor)',
    case when (j->>'mfa_enabled')::boolean then 'PASS' else 'FAIL' end);
  perform auth.login_anon();
  begin ja := public.my_auth_info(); insert into _ah values (33,'anon -> my_auth_info denied','FAIL: '||coalesce(ja::text,'null'));
  exception when insufficient_privilege then insert into _ah values (33,'anon -> my_auth_info denied','PASS');
            when others then insert into _ah values (33,'anon -> my_auth_info denied','PASS ('||sqlerrm||')'); end;
  perform auth.logout();
end $$;

-- 34) re-applying 0028 is a no-op (no double rename, wrapper intact, core still private)
\i supabase/migrations/0028_auth_hardening.sql
insert into _ah select 34, 're-applying 0028 is safe (one core, wrapper intact, core private)',
  case when (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname in ('_admin_create_user_core','admin_create_user')) = 2
        and pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) like '%auth-hardening-0028%'
        and not has_function_privilege('authenticated','public._admin_create_user_core(text,text,text)','EXECUTE')
       then 'PASS' else 'FAIL' end;

-- cleanup fixtures touched
delete from auth.mfa_factors where user_id in (select id from auth.users where email in ('a_staff@a.test','b_staff@b.test'));
delete from auth.sessions where user_id in (select id from auth.users where email in ('a_staff@a.test','b_staff@b.test'));

select n, name, result from _ah order by n;
select case when count(*) filter (where result not like 'PASS%') = 0 and count(*) = 34
            then 'AUTH-HARDENING: ALL PASS (' || count(*) || '/34)'
            else 'AUTH-HARDENING: ' || count(*) filter (where result not like 'PASS%') || ' FAILED of ' || count(*) || ' (expected 34)' end as summary
  from _ah;
