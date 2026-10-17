-- mfa-verify-hook-0158.sql -- 0158: Supabase Auth "MFA Verification Attempt" hook.
-- audit run-3 auth/mfa-attempts/lockout-only-browser-reported. Calls the hook the way
-- GoTrue does (as supabase_auth_admin) with fake user ids. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _mf(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _mf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.hook(p_uid uuid, p_valid boolean) returns jsonb language plpgsql as $$
declare r jsonb; begin
  execute 'set local role supabase_auth_admin';
  r := public.hook_mfa_verification_attempt(jsonb_build_object('factor_id', gen_random_uuid(), 'factor_type', 'totp', 'user_id', p_uid, 'valid', p_valid));
  execute 'reset role';
  return r;
end $$;

do $$
declare u1 uuid := 'f0000000-0000-4000-8000-0000000158a1'; u2 uuid := 'f0000000-0000-4000-8000-0000000158a2';
        u3 uuid := 'f0000000-0000-4000-8000-0000000158a3'; r jsonb; i int; e text;
begin
  -- 1-4 wrong codes: continue (GoTrue still says "invalid code")
  for i in 1..4 loop r := pg_temp.hook(u1, false); end loop;
  perform pg_temp.res('01 four wrong codes continue', r->>'decision' = 'continue', r::text);
  r := pg_temp.hook(u1, false);
  perform pg_temp.res('02 fifth wrong code locks', r->>'decision' = 'reject' and r->>'message' like 'Too many wrong codes%', r::text);
  r := pg_temp.hook(u1, true);
  perform pg_temp.res('03 locked: even a correct code is refused', r->>'decision' = 'reject', r::text);
  perform pg_temp.res('04 lock audited (no e-mail)', exists (select 1 from public.audit_log where action = 'auth.mfa.locked_server' and actor = u1 and actor_email is null));
  -- lock expires -> correct code passes and clears the counter
  update public.auth_mfa_verify_attempts set locked_until = now() - interval '1 second' where user_id = u1;
  r := pg_temp.hook(u1, true);
  perform pg_temp.res('05 after the lock a correct code continues', r->>'decision' = 'continue', r::text);
  perform pg_temp.res('06 correct code clears the counter', (select fails = 0 and locked_until is null from public.auth_mfa_verify_attempts where user_id = u1));
  -- correct code mid-window resets
  r := pg_temp.hook(u2, false); r := pg_temp.hook(u2, false); r := pg_temp.hook(u2, true);
  perform pg_temp.res('07 correct code resets a partial count', (select fails = 0 from public.auth_mfa_verify_attempts where user_id = u2));
  -- old window -> fresh count
  for i in 1..4 loop r := pg_temp.hook(u2, false); end loop;
  update public.auth_mfa_verify_attempts set window_start = now() - interval '16 minutes' where user_id = u2;
  r := pg_temp.hook(u2, false);
  perform pg_temp.res('08 old window starts a fresh count', r->>'decision' = 'continue' and (select fails = 1 from public.auth_mfa_verify_attempts where user_id = u2), r::text);
  -- a browser-recorded 0050 lock is now enforced server-side
  insert into public.auth_mfa_attempts(user_id, fails, window_start, locked_until) values (u3, 5, now(), now() + interval '10 minutes')
    on conflict (user_id) do update set locked_until = excluded.locked_until;
  r := pg_temp.hook(u3, true);
  perform pg_temp.res('09 browser-recorded lock enforced', r->>'decision' = 'reject', r::text);
  perform pg_temp.res('10 browser counter untouched', (select fails = 5 from public.auth_mfa_attempts where user_id = u3));
  -- malformed events never block
  execute 'set local role supabase_auth_admin';
  r := public.hook_mfa_verification_attempt('{"user_id":"not-a-uuid","valid":false}'::jsonb);
  e := public.hook_mfa_verification_attempt('{}'::jsonb)->>'decision';
  execute 'reset role';
  perform pg_temp.res('11 malformed event continues', r->>'decision' = 'continue', r::text);
  perform pg_temp.res('12 empty event continues', e = 'continue', e);
  -- clients cannot call the hook or read the counters
  perform pg_temp.res('13 hook closed to anon/authenticated/service_role',
    not has_function_privilege('anon', 'public.hook_mfa_verification_attempt(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.hook_mfa_verification_attempt(jsonb)', 'execute')
    and not has_function_privilege('service_role', 'public.hook_mfa_verification_attempt(jsonb)', 'execute'));
  perform pg_temp.res('14 counter table closed to clients',
    not has_table_privilege('authenticated', 'public.auth_mfa_verify_attempts', 'select')
    and not has_table_privilege('anon', 'public.auth_mfa_verify_attempts', 'select'));
  perform pg_temp.res('15 auth admin can call the hook', has_function_privilege('supabase_auth_admin', 'public.hook_mfa_verification_attempt(jsonb)', 'execute'));
exception when others then execute 'reset role'; insert into _mf values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _mf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'MFA-VERIFY-HOOK-0158: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'MFA-VERIFY-HOOK-0158: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _mf;
rollback;
