-- password-lockout.sql — 0053: per-account password lockout through the Supabase
-- "Password Verification Attempt" hook. Hook calls are simulated as supabase_auth_admin.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _g53; create temp table _g53(name text, result text);
grant all on _g53 to anon, authenticated, supabase_auth_admin;

create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
-- one hook call as GoTrue would make it; returns 'continue' or 'reject:<message>' or 'err:...'
create or replace function pg_temp.hook(p_uid uuid, p_valid boolean) returns text language plpgsql as $$
declare j jsonb;
begin
  execute 'set role supabase_auth_admin';
  j := public.hook_password_verification_attempt(jsonb_build_object('user_id', p_uid, 'valid', p_valid));
  execute 'reset role';
  return case when j->>'decision' = 'reject' then 'reject:' || coalesce(j->>'message', '') else j->>'decision' end;
exception when others then execute 'reset role'; return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.as_try(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute format('set role %I', p_role);
  execute p_sql into v;
  execute 'reset role'; return 'ok:' || coalesce(v, '');
exception when others then execute 'reset role'; return 'err:' || sqlstate;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g53 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
grant execute on function pg_temp.t(text, boolean, text) to supabase_auth_admin, anon, authenticated;

do $$ begin
  execute 'reset role';
  delete from public.auth_password_attempts;   -- disposable test DB
end $$;

do $$ declare a uuid := pg_temp.uid('a_staff@a.test'); b uuid := pg_temp.uid('b_staff@b.test'); r text; i int; n int;
begin
  -- 4 failures are allowed through (GoTrue then says "invalid credentials")
  for i in 1..4 loop r := pg_temp.hook(a, false);
    perform pg_temp.t('fail #' || i || ' → continue', r = 'continue', r); end loop;
  -- 5th locks
  r := pg_temp.hook(a, false);
  perform pg_temp.t('5th failure → reject with 15-minute message',
    r = 'reject:Too many attempts. Try again in 15 minutes or reset your password.', r);
  perform pg_temp.t('lock audited (user id only)',
    (select count(*) from public.audit_log where action = 'auth.password.locked' and actor = a and actor_email is null) = 1, null);
  perform pg_temp.t('audit row has no email', not exists (select 1 from public.audit_log where action like 'auth.password.%'
    and changed::text ilike '%@%'), null);
  -- 0054 integration: the real 0053 lock audit row raises a password_lockout security alert for a's studio
  perform pg_temp.t('0054 alert fires on auth.password.locked (event, a''s org)',
    to_regclass('public.security_alert_events') is null or exists (select 1 from public.security_alert_events e
      where e.alert_type = 'password_lockout' and e.source = 'audit_log.auth.password.locked'
        and e.org_id = (select org_id from public.profiles where id = a)), null);
  -- locked rejects even a valid password, and does not clear the lock
  r := pg_temp.hook(a, true);
  perform pg_temp.t('locked: valid password still rejected', r like 'reject:Too many attempts%', r);
  r := pg_temp.hook(a, false);
  perform pg_temp.t('locked: wrong password rejected', r like 'reject:Too many attempts%', r);
  perform pg_temp.t('locked attempts do not extend lock',
    (select locked_until < now() + interval '15 minutes 1 second' from public.auth_password_attempts where user_id = a), null);
  -- other user unaffected
  r := pg_temp.hook(b, true);
  perform pg_temp.t('other user valid → continue', r = 'continue', r);
  r := pg_temp.hook(b, false);
  perform pg_temp.t('other user wrong → continue (own counter)', r = 'continue', r);

  -- expiry: move the lock into the past
  update public.auth_password_attempts set locked_until = now() - interval '1 second' where user_id = a;
  r := pg_temp.hook(a, false);
  perform pg_temp.t('after expiry: wrong password → continue (fresh count)', r = 'continue', r);
  perform pg_temp.t('after expiry: count restarted at 1', (select fails from public.auth_password_attempts where user_id = a) = 1, null);
  -- escalation: a second lock within 24 h → 1 hour
  for i in 1..4 loop r := pg_temp.hook(a, false); end loop;
  perform pg_temp.t('repeat lock → 1-hour message', r = 'reject:Too many attempts. Try again in 1 hour or reset your password.', r);
  perform pg_temp.t('repeat lock lasts ~1 hour',
    (select locked_until > now() + interval '59 minutes' from public.auth_password_attempts where user_id = a), null);
  r := pg_temp.hook(a, true);
  perform pg_temp.t('1-hour lock: valid still rejected with 1-hour message', r like 'reject:%1 hour%', r);

  -- password reset clears the lock
  update auth.users set encrypted_password = 'reset-' || gen_random_uuid() where id = a;
  perform pg_temp.t('password change clears lock row', not exists (select 1 from public.auth_password_attempts where user_id = a), null);
  perform pg_temp.t('unlock audited', exists (select 1 from public.audit_log where action = 'auth.password.unlocked' and actor = a), null);
  r := pg_temp.hook(a, true);
  perform pg_temp.t('after reset: valid → continue', r = 'continue', r);

  -- success resets the counter
  for i in 1..4 loop r := pg_temp.hook(a, false); end loop;
  r := pg_temp.hook(a, true);
  perform pg_temp.t('success after 4 fails → continue', r = 'continue', r);
  perform pg_temp.t('success deletes counter', not exists (select 1 from public.auth_password_attempts where user_id = a), null);
  r := pg_temp.hook(a, false);
  perform pg_temp.t('after success: next failure is #1 (no lock)', r = 'continue'
    and (select fails from public.auth_password_attempts where user_id = a) = 1, r);
  -- old window: failures older than 15 minutes do not count
  update public.auth_password_attempts set fails = 4, window_start = now() - interval '16 minutes' where user_id = a;
  r := pg_temp.hook(a, false);
  perform pg_temp.t('stale window: 5th-ever failure after 16 min does not lock', r = 'continue', r);

  -- malformed events never block
  execute 'set role supabase_auth_admin';
  r := public.hook_password_verification_attempt('{"user_id":"nope","valid":false}'::jsonb)->>'decision';
  execute 'reset role';
  perform pg_temp.t('malformed event → continue', r = 'continue', r);

  -- clients cannot call the hook or touch the table
  r := pg_temp.as_try('anon', format($q$select public.hook_password_verification_attempt('{"user_id":"%s","valid":true}'::jsonb)::text$q$, a));
  perform pg_temp.t('anon cannot call hook', r like 'err:42501%', r);
  r := pg_temp.as_try('authenticated', format($q$select public.hook_password_verification_attempt('{"user_id":"%s","valid":true}'::jsonb)::text$q$, a));
  perform pg_temp.t('authenticated cannot call hook', r like 'err:42501%', r);
  r := pg_temp.as_try('service_role', format($q$select public.hook_password_verification_attempt('{"user_id":"%s","valid":true}'::jsonb)::text$q$, a));
  perform pg_temp.t('service_role cannot call hook', r like 'err:42501%', r);
  r := pg_temp.as_try('authenticated', 'select count(*)::text from public.auth_password_attempts');
  perform pg_temp.t('authenticated cannot read lockout table', r like 'err:42501%', r);
  r := pg_temp.as_try('anon', 'select count(*)::text from public.auth_password_attempts');
  perform pg_temp.t('anon cannot read lockout table', r like 'err:42501%', r);
  r := pg_temp.as_try('authenticated', format($q$delete from public.auth_password_attempts where user_id = '%s' returning 'x'$q$, a));
  perform pg_temp.t('authenticated cannot clear a lock', r like 'err:42501%', r);
  perform pg_temp.t('trigger fn not client-callable',
    not has_function_privilege('authenticated', 'public._a53_password_changed()', 'execute'), null);
  perform pg_temp.t('RLS on lockout table', (select relrowsecurity from pg_class where oid = 'public.auth_password_attempts'::regclass), null);
end $$;

select name, result from _g53 where result <> 'PASS';
select case when not exists (select 1 from _g53 where result <> 'PASS')
            then 'PASSWORD-LOCKOUT: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PASSWORD-LOCKOUT: FAILURES (' || count(*) filter (where result <> 'PASS') || ')' end
  from _g53;
