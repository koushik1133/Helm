-- ============================================================================
-- 0053_password_lockout.sql — CANONICAL forward-only. REQUIRES the base audit_log table.
-- Per-account password lockout, enforced by Supabase Auth itself through the
-- "Password Verification Attempt" Auth Hook (Postgres function hook, Pro plan).
--
--   public.hook_password_verification_attempt(event jsonb) → jsonb
--     GoTrue calls it after checking a password for an EXISTING user, with
--     event = {"user_id": "<uuid>", "valid": true|false}. It returns
--     {"decision":"continue"} or {"decision":"reject","message":..., "should_logout_user":false}.
--     * 5 wrong passwords inside 15 minutes → the account is locked for 15 minutes.
--     * A lock that starts within 24 h of the previous lock → 1 hour instead.
--     * While locked, EVERY attempt is rejected — even with the right password.
--     * A correct password (when not locked) clears the counter and lock history.
--     * Lock events are written to audit_log (user id only — no email, no IP).
--   public.auth_password_attempts — one private row per user (RLS on, no client grants).
--   Trigger on auth.users: when the password changes (reset link / change password),
--     the user's counter + lock are cleared, so "reset your password" really unlocks.
--
-- NOTHING CHANGES until the owner enables the hook in the dashboard:
--   Authentication → Hooks → Password Verification Attempt → Postgres →
--   schema public, function hook_password_verification_attempt.
-- Additive + idempotent: 1 new table, 2 new functions, 1 new trigger. No existing row,
-- table or function is changed or deleted.
-- ============================================================================

create table if not exists public.auth_password_attempts (
  user_id      uuid        primary key,
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  last_lock_at timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.auth_password_attempts enable row level security;
revoke all on table public.auth_password_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_password_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_password_attempts from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant select, insert, update, delete on table public.auth_password_attempts to supabase_auth_admin;
  end if;
end $$;
-- The auth admin role may use the table (Supabase hook docs pattern); clients get nothing.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'auth_password_attempts'
                     and policyname = 'auth_admin_all') then
    create policy auth_admin_all on public.auth_password_attempts as permissive for all
      to supabase_auth_admin using (true) with check (true);
  end if;
end $$;

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid   uuid;
  v_valid boolean;
  r       public.auth_password_attempts%rowtype;
  c_max   constant integer  := 5;
  c_win   constant interval := interval '15 minutes';
  c_lock  constant interval := interval '15 minutes';
  c_long  constant interval := interval '1 hour';
  c_rep   constant interval := interval '24 hours';
  v_dur   interval;
begin
  begin
    v_uid   := (event->>'user_id')::uuid;
    v_valid := coalesce((event->>'valid')::boolean, false);
  exception when others then
    return jsonb_build_object('decision', 'continue');      -- malformed event: never block on our bug
  end;
  if v_uid is null then return jsonb_build_object('decision', 'continue'); end if;

  insert into public.auth_password_attempts(user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from public.auth_password_attempts where user_id = v_uid for update;

  -- locked → reject everything, valid or not (does not extend the lock)
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('decision', 'reject', 'should_logout_user', false,
      'message', case when r.locked_until - now() > c_lock
                      then 'Too many attempts. Try again in 1 hour or reset your password.'
                      else 'Too many attempts. Try again in 15 minutes or reset your password.' end);
  end if;

  if v_valid then
    delete from public.auth_password_attempts where user_id = v_uid;
    return jsonb_build_object('decision', 'continue');
  end if;

  -- expired lock or old window → fresh count (lock history kept for escalation)
  if r.locked_until is not null or r.window_start <= now() - c_win then
    r.fails := 0; r.window_start := now(); r.locked_until := null;
  end if;
  r.fails := r.fails + 1;

  if r.fails >= c_max then
    v_dur := case when r.last_lock_at is not null and r.last_lock_at > now() - c_rep then c_long else c_lock end;
    r.locked_until := now() + v_dur;
    r.last_lock_at := now();
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, null, 'auth.password.locked', 'auth_password_attempts', v_uid::text,
              jsonb_build_object('fails', r.fails, 'lock_minutes', extract(epoch from v_dur)::integer / 60,
                                 'locked_until', r.locked_until), null, now());
  end if;

  update public.auth_password_attempts
     set fails = r.fails, window_start = r.window_start, locked_until = r.locked_until,
         last_lock_at = r.last_lock_at, updated_at = now()
   where user_id = v_uid;

  if r.locked_until is not null then
    return jsonb_build_object('decision', 'reject', 'should_logout_user', false,
      'message', case when v_dur = c_long
                      then 'Too many attempts. Try again in 1 hour or reset your password.'
                      else 'Too many attempts. Try again in 15 minutes or reset your password.' end);
  end if;
  return jsonb_build_object('decision', 'continue');        -- GoTrue still answers "invalid credentials"
end $$;

revoke all on function public.hook_password_verification_attempt(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hook_password_verification_attempt(jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.hook_password_verification_attempt(jsonb) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then revoke all on function public.hook_password_verification_attempt(jsonb) from service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
  end if;
end $$;

-- ---- password changed (reset link / change password) → clear the lock -------------
create or replace function public._a53_password_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_was_locked boolean;
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    delete from public.auth_password_attempts where user_id = new.id
      returning (locked_until is not null and locked_until > now()) into v_was_locked;
    if coalesce(v_was_locked, false) then
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (new.id, null, 'auth.password.unlocked', 'auth_password_attempts', new.id::text,
                jsonb_build_object('reason', 'password_changed'), null, now());
    end if;
  end if;
  return new;
end $$;
revoke all on function public._a53_password_changed() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._a53_password_changed() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._a53_password_changed() from authenticated; end if;
end $$;
drop trigger if exists zz_a53_password_changed on auth.users;
create trigger zz_a53_password_changed after update of encrypted_password on auth.users
  for each row execute function public._a53_password_changed();
