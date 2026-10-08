-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0050 server-side two-step lockout + durable Edge rate limits (one paste)  (2026-10-07)
--   * 5 wrong two-step codes → that account's code entry is locked for 15 minutes,
--     counted on the SERVER (was: per-browser localStorage). Locks are audited.
--   * rate_hit(bucket, key, window_s, max) — durable counter for Edge Functions
--     (service role only).
-- REQUIRES the base audit_log table. Independent of 0049 (apply in either order).
-- WHAT IT TOUCHES: 2 new private tables, 5 new functions. NO existing row, table or
--   function is changed or deleted. SAFE TO RE-RUN. STAGING first, then PROD.
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin
  if to_regclass('public.audit_log') is null then raise exception 'STOP: public.audit_log missing'; end if;
  raise notice 'Preflight OK — applying 0050…';
end $$;

-- Additive + idempotent: 2 new private tables, 5 new functions. No existing row,
-- table or function is changed or deleted.
-- ============================================================================

-- ---- 1. durable rate-limit counters -------------------------------------------------
create table if not exists public.auth_rate_hits (
  bucket       text        not null,
  key          text        not null,
  window_start timestamptz not null default now(),
  n            integer     not null default 0,
  primary key (bucket, key)
);
alter table public.auth_rate_hits enable row level security;
revoke all on table public.auth_rate_hits from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_rate_hits from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_rate_hits from authenticated; end if;
end $$;

create or replace function public.rate_hit(p_bucket text, p_key text, p_window_s integer, p_max integer)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_n integer; v_start timestamptz; v_win interval;
begin
  if p_bucket is null or p_bucket !~ '^[a-z0-9_.:-]{1,64}$' then raise exception 'rate_hit: bad bucket' using errcode = '22023'; end if;
  if p_key is null or length(p_key) < 1 or length(p_key) > 128 then raise exception 'rate_hit: bad key' using errcode = '22023'; end if;
  if p_window_s is null or p_window_s < 1 or p_window_s > 86400 then raise exception 'rate_hit: bad window' using errcode = '22023'; end if;
  if p_max is null or p_max < 1 or p_max > 1000000 then raise exception 'rate_hit: bad max' using errcode = '22023'; end if;
  v_win := make_interval(secs => p_window_s);
  insert into public.auth_rate_hits as h (bucket, key, window_start, n)
    values (p_bucket, p_key, now(), 1)
  on conflict (bucket, key) do update set
    n            = case when h.window_start <= now() - v_win then 1 else h.n + 1 end,
    window_start = case when h.window_start <= now() - v_win then now() else h.window_start end
  returning h.n, h.window_start into v_n, v_start;
  if v_n > p_max then
    return greatest(1, ceil(extract(epoch from (v_start + v_win - now())))::integer);
  end if;
  return 0;
end $$;
revoke all on function public.rate_hit(text, text, integer, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.rate_hit(text, text, integer, integer) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.rate_hit(text, text, integer, integer) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.rate_hit(text, text, integer, integer) to service_role; end if;
end $$;

-- ---- 2. server-side MFA wrong-code lockout -----------------------------------------
create table if not exists public.auth_mfa_attempts (
  user_id      uuid        primary key,
  fails        integer     not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz,
  updated_at   timestamptz not null default now()
);
alter table public.auth_mfa_attempts enable row level security;
revoke all on table public.auth_mfa_attempts from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.auth_mfa_attempts from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.auth_mfa_attempts from authenticated; end if;
end $$;

-- policy constants in one place (5 wrong codes → 15 minutes; counter window 15 minutes)
create or replace function public._mfa_lock_policy()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('max_fails', 5, 'lock_s', 900, 'window_s', 900);
$$;
revoke all on function public._mfa_lock_policy() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._mfa_lock_policy() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._mfa_lock_policy() from authenticated; end if;
end $$;

create or replace function public.mfa_lock_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.auth_mfa_attempts; p jsonb := public._mfa_lock_policy();
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into r from public.auth_mfa_attempts where user_id = v_uid;
  if not found then return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', 0); end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('locked', true, 'retry_after', greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer), 'fails', r.fails);
  end if;
  if r.window_start <= now() - make_interval(secs => (p->>'window_s')::int) or r.locked_until is not null then
    return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', 0);
  end if;
  return jsonb_build_object('locked', false, 'retry_after', 0, 'fails', r.fails);
end $$;

create or replace function public.mfa_record_failure()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); r public.auth_mfa_attempts; p jsonb := public._mfa_lock_policy();
        v_rl integer; v_max int := (p->>'max_fails')::int;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  -- the recorder itself is rate-limited (a script can't churn the row / audit log)
  v_rl := public.rate_hit('mfa.record', v_uid::text, 600, 30);
  if v_rl > 0 then
    return jsonb_build_object('locked', true, 'retry_after', v_rl, 'fails', v_max);
  end if;
  insert into public.auth_mfa_attempts(user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from public.auth_mfa_attempts where user_id = v_uid for update;
  -- already locked: count nothing more, report the remaining time
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('locked', true, 'retry_after', greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer), 'fails', r.fails);
  end if;
  -- an expired lock or an old window starts a fresh count
  if r.locked_until is not null or r.window_start <= now() - make_interval(secs => (p->>'window_s')::int) then
    r.fails := 0; r.window_start := now(); r.locked_until := null;
  end if;
  r.fails := r.fails + 1;
  if r.fails >= v_max then
    r.locked_until := now() + make_interval(secs => (p->>'lock_s')::int);
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'auth.mfa.locked', 'auth_mfa_attempts', v_uid::text,
              jsonb_build_object('fails', r.fails, 'locked_until', r.locked_until), null, now());
  end if;
  update public.auth_mfa_attempts
     set fails = r.fails, window_start = r.window_start, locked_until = r.locked_until, updated_at = now()
   where user_id = v_uid;
  return jsonb_build_object('locked', r.locked_until is not null,
    'retry_after', case when r.locked_until is null then 0 else greatest(1, ceil(extract(epoch from (r.locked_until - now())))::integer) end,
    'fails', r.fails);
end $$;

create or replace function public.mfa_record_success()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_had integer;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  -- only a session that has really passed the code may clear the counter
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  update public.auth_mfa_attempts set fails = 0, locked_until = null, window_start = now(), updated_at = now()
   where user_id = v_uid and (fails > 0 or locked_until is not null)
  returning 1 into v_had;
  if v_had is not null then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (v_uid, (select u.email from auth.users u where u.id = v_uid), 'auth.mfa.counter_cleared', 'auth_mfa_attempts', v_uid::text,
              jsonb_build_object('by', 'successful_code'), null, now());
  end if;
  return true;
end $$;

do $$ declare f text; begin
  foreach f in array array['public.mfa_lock_status()', 'public.mfa_record_failure()', 'public.mfa_record_success()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- VERIFY — every row must say ok = true
select item, ok from (values
  ('tables are private (RLS on, no anon / authenticated access)',
     (select relrowsecurity from pg_class where oid = 'public.auth_rate_hits'::regclass)
     and (select relrowsecurity from pg_class where oid = 'public.auth_mfa_attempts'::regclass)
     and not has_table_privilege('authenticated', 'public.auth_rate_hits', 'select')
     and not has_table_privilege('authenticated', 'public.auth_mfa_attempts', 'select')
     and not has_table_privilege('anon', 'public.auth_mfa_attempts', 'select')),
  ('rate_hit is service-role only',
     has_function_privilege('service_role', 'public.rate_hit(text,text,integer,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.rate_hit(text,text,integer,integer)', 'execute')
     and not has_function_privilege('anon', 'public.rate_hit(text,text,integer,integer)', 'execute')),
  ('MFA lockout RPCs: signed-in users only',
     has_function_privilege('authenticated', 'public.mfa_record_failure()', 'execute')
     and has_function_privilege('authenticated', 'public.mfa_lock_status()', 'execute')
     and has_function_privilege('authenticated', 'public.mfa_record_success()', 'execute')
     and not has_function_privilege('anon', 'public.mfa_record_failure()', 'execute')
     and not has_function_privilege('anon', 'public.mfa_lock_status()', 'execute'))
) v(item, ok);
