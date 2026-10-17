-- 0158_mfa_verify_hook.sql - CANONICAL forward-only.
-- REQUIRES 0050 (auth_mfa_attempts + _mfa_lock_policy) and the base audit_log table.
--
-- In plain words - audit run-3 auth/mfa-attempts/lockout-only-browser-reported:
--   The two-step (MFA) wrong-code lockout from 0050 only counted failures that the BROWSER
--   chose to report (mfa_record_failure), and no server gate read the lock. Someone who has
--   a member's password could call Supabase Auth's MFA challenge/verify API directly and be
--   limited only by Supabase's own rate limit.
--
--   This adds a Supabase Auth "MFA Verification Attempt" hook (a Postgres function, the same
--   pattern as the 0053 password hook). Supabase Auth itself calls it after checking every
--   two-step code, with event = {"factor_id", "factor_type", "user_id", "valid"}:
--     * 5 wrong codes inside 15 minutes (the 0050 policy) -> every code is refused for
--       15 minutes, even a correct one (the lock does not extend while it runs);
--     * a lock the browser already recorded through mfa_record_failure is honoured too;
--     * a correct code (when not locked) clears this counter;
--     * lock events go to audit_log (user id only - no e-mail, no IP).
--   Counts live in a NEW private table (auth_mfa_verify_attempts), so the existing browser
--   counter in auth_mfa_attempts is not counted twice and is not changed.
--
-- NOTHING CHANGES until the owner enables the hook (staging first):
--   Dashboard -> Authentication -> Hooks -> "MFA Verification Attempt" -> Postgres ->
--   schema public, function hook_mfa_verification_attempt.
--   (Check the hook is offered on the project's plan; if it is not, this stays dormant.)
--
-- ZERO DATA LOSS: one new table, one new function, grants. No existing table, column, row,
-- policy or function is removed or changed. No DELETE of existing data / DROP TABLE /
-- TRUNCATE. ASCII only. Safe to run twice.

do $$ begin
  if to_regclass('public.auth_mfa_attempts') is null then raise exception 'STOP: apply 0050 first'; end if;
  if to_regprocedure('public._mfa_lock_policy()') is null then raise exception 'STOP: apply 0050 first'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: base audit_log table missing'; end if;
end $$;

create table if not exists public.auth_mfa_verify_attempts (
  user_id      uuid        primary key,
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.auth_mfa_verify_attempts enable row level security;
revoke all on table public.auth_mfa_verify_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_mfa_verify_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_mfa_verify_attempts from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant select, insert, update, delete on table public.auth_mfa_verify_attempts to supabase_auth_admin;
  end if;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'auth_mfa_verify_attempts'
                     and policyname = 'auth_admin_all_158') then
    create policy auth_admin_all_158 on public.auth_mfa_verify_attempts as permissive for all
      to supabase_auth_admin using (true) with check (true);
  end if;
end $$;

create or replace function public.hook_mfa_verification_attempt(event jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- audit-run3-mfa-hook-0158
  v_uid    uuid;
  v_valid  boolean;
  p        jsonb := public._mfa_lock_policy();
  c_max    integer;
  c_win    interval;
  c_lock   interval;
  r        public.auth_mfa_verify_attempts%rowtype;
  v_client timestamptz;
  v_msg    constant text := 'Too many wrong codes. Try again in 15 minutes.';
begin
  begin
    v_uid   := (event->>'user_id')::uuid;
    v_valid := coalesce((event->>'valid')::boolean, false);
    c_max   := greatest(1, coalesce((p->>'max_fails')::integer, 5));
    c_win   := make_interval(secs => greatest(60, coalesce((p->>'window_s')::integer, 900)));
    c_lock  := make_interval(secs => greatest(60, coalesce((p->>'lock_s')::integer, 900)));
  exception when others then
    return jsonb_build_object('decision', 'continue');      -- malformed event: never block on our bug
  end;
  if v_uid is null then return jsonb_build_object('decision', 'continue'); end if;

  -- a lock the member's own browser recorded (0050 mfa_record_failure) is now enforced too
  select a.locked_until into v_client from public.auth_mfa_attempts a where a.user_id = v_uid;
  if v_client is not null and v_client > now() then
    return jsonb_build_object('decision', 'reject', 'message', v_msg);
  end if;

  insert into public.auth_mfa_verify_attempts(user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from public.auth_mfa_verify_attempts where user_id = v_uid for update;

  -- locked -> refuse every code, right or wrong (does not extend the lock)
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('decision', 'reject', 'message', v_msg);
  end if;

  if v_valid then
    update public.auth_mfa_verify_attempts
       set fails = 0, window_start = now(), locked_until = null, updated_at = now()
     where user_id = v_uid and (fails > 0 or locked_until is not null);
    return jsonb_build_object('decision', 'continue');
  end if;

  -- expired lock or old window -> fresh count
  if r.locked_until is not null or r.window_start <= now() - c_win then
    r.fails := 0; r.window_start := now(); r.locked_until := null;
  end if;
  r.fails := r.fails + 1;
  if r.fails >= c_max then
    r.locked_until := now() + c_lock;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, null, 'auth.mfa.locked_server', 'auth_mfa_verify_attempts', v_uid::text,
              jsonb_build_object('fails', r.fails, 'locked_until', r.locked_until, 'by', 'mfa_verification_hook'), null, now());
  end if;
  update public.auth_mfa_verify_attempts
     set fails = r.fails, window_start = r.window_start, locked_until = r.locked_until, updated_at = now()
   where user_id = v_uid;

  if r.locked_until is not null then
    return jsonb_build_object('decision', 'reject', 'message', v_msg);
  end if;
  return jsonb_build_object('decision', 'continue');        -- Supabase Auth still answers "invalid code"
end $$;

revoke all on function public.hook_mfa_verification_attempt(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hook_mfa_verification_attempt(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.hook_mfa_verification_attempt(jsonb) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then revoke all on function public.hook_mfa_verification_attempt(jsonb) from service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.hook_mfa_verification_attempt(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 hook function exists', to_regprocedure('public.hook_mfa_verification_attempt(jsonb)') is not null),
  ('02 hook body is 0158', position('audit-run3-mfa-hook-0158' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hook_mfa_verification_attempt(jsonb)'))) > 0),
  ('03 hook closed to clients', (not exists (select 1 from pg_roles where rolname = 'anon') or not has_function_privilege('anon', 'public.hook_mfa_verification_attempt(jsonb)', 'execute'))
       and (not exists (select 1 from pg_roles where rolname = 'authenticated') or not has_function_privilege('authenticated', 'public.hook_mfa_verification_attempt(jsonb)', 'execute'))),
  ('04 auth admin may call hook', not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
       or has_function_privilege('supabase_auth_admin', 'public.hook_mfa_verification_attempt(jsonb)', 'execute')),
  ('05 counter table private', (select c.relrowsecurity from pg_class c where c.oid = 'public.auth_mfa_verify_attempts'::regclass)
       and (not exists (select 1 from pg_roles where rolname = 'authenticated') or not has_table_privilege('authenticated', 'public.auth_mfa_verify_attempts', 'select'))),
  ('06 browser counter kept', to_regclass('public.auth_mfa_attempts') is not null and to_regprocedure('public.mfa_record_failure()') is not null)
) v(item, ok);
