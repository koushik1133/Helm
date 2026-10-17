-- APPLY-0157.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: two new tables (privacy PIN hash per studio, wrong-try counter), new functions only. No rows change. Safe to run twice.
begin;
-- 0157_privacy_pin.sql - CANONICAL forward-only.
-- REQUIRES the base schema (organizations, profiles, current_org_id(), is_admin()) and pgcrypto
-- in the extensions schema (extensions.crypt / extensions.gen_salt, as 0026 already uses).
--
-- In plain words - the "Hide amounts" privacy PIN moves to the server, one PIN per studio:
--   * Until now the PIN that shows hidden amounts was 0000 for everyone, and "Change PIN" only
--     changed it in that one browser. Now each studio has ONE privacy PIN, kept on the server
--     as a salted bcrypt hash (never the plain PIN). A studio that never set one keeps the
--     default 0000, exactly like today.
--   * Only a studio ADMIN can change it (Control Center > Hide amounts). Changing needs the
--     current PIN. "Forgot the PIN?": an admin who signed in within the last 15 minutes can put
--     it back to the default 0000 (so someone at an unattended screen cannot reset it).
--   * Every signed-in studio member unlocks against the server hash. Wrong tries are counted on
--     the server per person: 5 wrong -> locked 30 s, and each further lock doubles (max 15 min).
--     A right PIN clears the counter.
--   New: table privacy_pin (one row per studio, hash only), table privacy_pin_attempts (wrong-try
--   counter per person), RPCs privacy_pin_status / privacy_pin_check / privacy_pin_set /
--   privacy_pin_reset. Both tables have RLS on with NO policies and no grants: only these
--   SECURITY DEFINER functions can read or write them, and they never return the hash.
--
-- ZERO DATA LOSS: two new tables, new functions only. No existing table, column, row, policy or
-- function is removed or changed. No DELETE / DROP / TRUNCATE ("reset" sets the hash to NULL).
-- ASCII only. Safe to run twice.

do $$ begin
  if to_regclass('public.organizations') is null or to_regclass('public.profiles') is null then
    raise exception 'STOP: base schema (organizations, profiles) missing'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception 'STOP: current_org_id() / is_admin() missing'; end if;
  if to_regprocedure('extensions.crypt(text,text)') is null or to_regprocedure('extensions.gen_salt(text,integer)') is null then
    raise exception 'STOP: pgcrypto (extensions.crypt / gen_salt) missing'; end if;
end $$;

-- ---- tables (hash + counter only; no grants, RLS on, no policies) --------------------------
create table if not exists public.privacy_pin (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  pin_hash   text,                                   -- bcrypt; NULL = the default PIN 0000
  updated_by uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.privacy_pin_attempts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  org_id       uuid,
  fails        integer not null default 0,
  locks        integer not null default 0,
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.privacy_pin enable row level security;
alter table public.privacy_pin_attempts enable row level security;
revoke all on table public.privacy_pin from public;
revoke all on table public.privacy_pin_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.privacy_pin from anon';
    execute 'revoke all on table public.privacy_pin_attempts from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.privacy_pin from authenticated';
    execute 'revoke all on table public.privacy_pin_attempts from authenticated'; end if;
end $$;

-- ---- helpers (not callable by app roles) -----------------------------------------------------
-- the caller's studio, or an error: signed in, in a studio, not a client account
create or replace function public._pp_org()
returns uuid language plpgsql stable security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id = v_org
                   and coalesce(p.role, '') <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return v_org;
end $$;

-- does p_pin match this studio's PIN (default 0000 when none is set)?
create or replace function public._pp_matches(p_org uuid, p_pin text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_hash text;
begin
  select x.pin_hash into v_hash from public.privacy_pin x where x.org_id = p_org;
  if v_hash is null then return p_pin = '0000'; end if;
  return extensions.crypt(p_pin, v_hash) = v_hash;
end $$;

-- seconds this person is still locked out (0 = not locked)
create or replace function public._pp_locked(p_user uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- privacy-pin-0157
  select coalesce((select greatest(0, ceil(extract(epoch from (a.locked_until - now()))))::integer
                     from public.privacy_pin_attempts a where a.user_id = p_user and a.locked_until > now()), 0)
$$;

-- count a wrong PIN; returns {tries_left, locked_seconds}
create or replace function public._pp_fail(p_user uuid, p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- privacy-pin-0157
declare r public.privacy_pin_attempts; v_secs integer;
begin
  insert into public.privacy_pin_attempts as a (user_id, org_id, fails, locks, updated_at)
    values (p_user, p_org, 1, 0, now())
  on conflict (user_id) do update
    set fails = case when a.locked_until is not null and a.locked_until <= now() then 1 else a.fails + 1 end,
        locked_until = case when a.locked_until is not null and a.locked_until <= now() then null else a.locked_until end,
        org_id = excluded.org_id, updated_at = now()
  returning * into r;
  if r.fails >= 5 then
    v_secs := least(30 * power(2, least(r.locks, 5))::integer, 900);
    update public.privacy_pin_attempts set fails = 0, locks = locks + 1,
           locked_until = now() + make_interval(secs => v_secs), updated_at = now()
     where user_id = p_user;
    return jsonb_build_object('tries_left', 0, 'locked_seconds', v_secs);
  end if;
  return jsonb_build_object('tries_left', 5 - r.fails, 'locked_seconds', 0);
end $$;

-- a right PIN clears the counter (update only; the row stays)
create or replace function public._pp_clear(p_user uuid)
returns void language sql volatile security definer set search_path = '' as $$
  -- privacy-pin-0157
  update public.privacy_pin_attempts set fails = 0, locks = 0, locked_until = null, updated_at = now()
   where user_id = p_user and (fails <> 0 or locks <> 0 or locked_until is not null)
$$;

-- ---- app RPCs ---------------------------------------------------------------------------------
-- {is_default, can_change, updated_at, locked_seconds}; any studio member
create or replace function public.privacy_pin_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_org uuid := public._pp_org(); v_hash text; v_at timestamptz;
begin
  select x.pin_hash, x.updated_at into v_hash, v_at from public.privacy_pin x where x.org_id = v_org;
  return jsonb_build_object('is_default', v_hash is null,
                            'can_change', coalesce(public.is_admin(), false),
                            'updated_at', case when v_hash is null then null else v_at end,
                            'locked_seconds', public._pp_locked(auth.uid()));
end $$;

-- unlock: {ok, tries_left, locked_seconds}; any studio member
create or replace function public.privacy_pin_check(p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_org uuid := public._pp_org(); v_me uuid := auth.uid(); v_lock integer; v_f jsonb;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4}$' then raise exception 'enter 4 digits' using errcode = '22023'; end if;
  v_lock := public._pp_locked(v_me);
  if v_lock > 0 then return jsonb_build_object('ok', false, 'tries_left', 0, 'locked_seconds', v_lock); end if;
  if public._pp_matches(v_org, p_pin) then
    perform public._pp_clear(v_me);
    return jsonb_build_object('ok', true, 'tries_left', 5, 'locked_seconds', 0);
  end if;
  v_f := public._pp_fail(v_me, v_org);
  return jsonb_build_object('ok', false) || v_f;
end $$;

-- admin: change the studio PIN (needs the current one). {ok, tries_left, locked_seconds}
create or replace function public.privacy_pin_set(p_current text, p_new text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_org uuid := public._pp_org(); v_me uuid := auth.uid(); v_lock integer; v_f jsonb;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'only a studio admin can change the privacy PIN' using errcode = '42501'; end if;
  if p_current is null or p_current !~ '^[0-9]{4}$' then raise exception 'enter the current 4-digit PIN' using errcode = '22023'; end if;
  if p_new is null or p_new !~ '^[0-9]{4}$' then raise exception 'the new PIN must be 4 digits' using errcode = '22023'; end if;
  v_lock := public._pp_locked(v_me);
  if v_lock > 0 then return jsonb_build_object('ok', false, 'tries_left', 0, 'locked_seconds', v_lock); end if;
  if not public._pp_matches(v_org, p_current) then
    v_f := public._pp_fail(v_me, v_org);
    return jsonb_build_object('ok', false, 'reason', 'wrong_current') || v_f;
  end if;
  perform public._pp_clear(v_me);
  insert into public.privacy_pin as x (org_id, pin_hash, updated_by, updated_at)
    values (v_org, extensions.crypt(p_new, extensions.gen_salt('bf', 8)), v_me, now())
  on conflict (org_id) do update set pin_hash = excluded.pin_hash, updated_by = excluded.updated_by, updated_at = now();
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'privacy_pin.set', 'privacy_pin', v_org::text, jsonb_build_object('pin', 'changed'), v_org);
  end if;
  return jsonb_build_object('ok', true, 'is_default', false);
end $$;

-- admin: forgot the PIN -> back to the default 0000. Only within 15 minutes of signing in.
create or replace function public.privacy_pin_reset()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- privacy-pin-0157
declare v_org uuid := public._pp_org(); v_me uuid := auth.uid(); v_sid text; v_since timestamptz;
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'only a studio admin can reset the privacy PIN' using errcode = '42501'; end if;
  v_sid := nullif(coalesce(auth.jwt() ->> 'session_id', ''), '');
  if v_sid is not null and v_sid ~ '^[0-9a-fA-F-]{36}$' then
    select s.created_at into v_since from auth.sessions s where s.id = v_sid::uuid and s.user_id = v_me;
  else
    select u.last_sign_in_at into v_since from auth.users u where u.id = v_me;
  end if;
  if v_since is null or v_since < now() - interval '15 minutes' then
    return jsonb_build_object('ok', false, 'reason', 'sign_in_again');
  end if;
  update public.privacy_pin set pin_hash = null, updated_by = v_me, updated_at = now() where org_id = v_org;
  perform public._pp_clear(v_me);
  if to_regclass('public.audit_log') is not null then
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'privacy_pin.reset', 'privacy_pin', v_org::text, jsonb_build_object('pin', 'default'), v_org);
  end if;
  return jsonb_build_object('ok', true, 'is_default', true);
end $$;

-- ---- privileges -------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._pp_org()', 'public._pp_matches(uuid,text)', 'public._pp_locked(uuid)',
                           'public._pp_fail(uuid,uuid)', 'public._pp_clear(uuid)',
                           'public.privacy_pin_status()', 'public.privacy_pin_check(text)',
                           'public.privacy_pin_set(text,text)', 'public.privacy_pin_reset()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach f in array array['public.privacy_pin_status()', 'public.privacy_pin_check(text)',
                             'public.privacy_pin_set(text,text)', 'public.privacy_pin_reset()'] loop
      execute format('grant execute on function %s to authenticated', f);
    end loop;
  end if;
end $$;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 privacy_pin table, RLS on', (select c.relrowsecurity from pg_class c where c.oid = 'public.privacy_pin'::regclass)),
  ('02 attempts table, RLS on', (select c.relrowsecurity from pg_class c where c.oid = 'public.privacy_pin_attempts'::regclass)),
  ('03 tables closed to app roles', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or (not has_table_privilege('authenticated', 'public.privacy_pin', 'select')
           and not has_table_privilege('authenticated', 'public.privacy_pin_attempts', 'select'))),
  ('04 tables closed to anon', not exists (select 1 from pg_roles where rolname = 'anon')
       or (not has_table_privilege('anon', 'public.privacy_pin', 'select')
           and not has_table_privilege('anon', 'public.privacy_pin_attempts', 'select'))),
  ('05 RPCs callable when signed in', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or (has_function_privilege('authenticated', 'public.privacy_pin_status()', 'execute')
           and has_function_privilege('authenticated', 'public.privacy_pin_check(text)', 'execute')
           and has_function_privilege('authenticated', 'public.privacy_pin_set(text,text)', 'execute')
           and has_function_privilege('authenticated', 'public.privacy_pin_reset()', 'execute'))),
  ('06 RPCs closed to anon', not exists (select 1 from pg_roles where rolname = 'anon')
       or (not has_function_privilege('anon', 'public.privacy_pin_check(text)', 'execute')
           and not has_function_privilege('anon', 'public.privacy_pin_set(text,text)', 'execute'))),
  ('07 helpers closed', not exists (select 1 from pg_roles where rolname = 'authenticated')
       or (not has_function_privilege('authenticated', 'public._pp_matches(uuid,text)', 'execute')
           and not has_function_privilege('authenticated', 'public._pp_fail(uuid,uuid)', 'execute'))),
  ('08 set is admin-gated', position('is_admin()' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.privacy_pin_set(text,text)'))) > 0),
  ('09 hash is bcrypt', position('gen_salt(''bf''' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.privacy_pin_set(text,text)'))) > 0),
  ('10 default PIN kept', position('''0000''' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._pp_matches(uuid,text)'))) > 0)
) v(item, ok);

commit;
