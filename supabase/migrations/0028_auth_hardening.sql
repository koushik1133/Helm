-- ============================================================================
-- 0028_auth_hardening.sql — CANONICAL forward-only. Security audit Phase 3-4
-- follow-up (Authentication + Session Management).
--
-- What this changes, in plain words:
--   1. Studio admins creating a user (Control Center) must now give a password of
--      at least 12 characters with a letter and a number. Passwords are stored
--      with bcrypt cost 12 (was the pgcrypto default, cost 6).
--   2. Creating a user whose email already belongs to ANOTHER studio no longer says
--      "a user with that email already exists" — a studio admin could use that to
--      test which emails have Helm accounts anywhere on the platform. They now get
--      a generic "could not create this user" message. Inside the admin's own
--      studio the clear "already a user in your studio" message is kept.
--   3. One-time (temp) passwords now always meet the rule above, and the
--      "must change your password" flag can only be cleared AFTER the password was
--      really changed (it used to be clearable by calling the RPC directly).
--   4. New helpers: public.mfa_ok() (server-side two-step-verification check, NOT
--      yet used by any policy — see note at the end) and public.my_auth_info()
--      (the caller's OWN last sign-in time, two-step status and recent sessions,
--      for the account panel).
--
-- Drift-safe: admin_create_user is NOT rewritten. Whatever body the target
-- database has (canonical base-v1 or a drifted prod copy) is RENAMED to
-- public._admin_create_user_core (kept private) and a thin wrapper with the new
-- checks calls it. Every existing behaviour (org placement, role validation,
-- identities row, profile upsert) is preserved exactly. The rename happens once
-- (marker check), so re-running this file is a no-op.
-- Additive + idempotent. No rows are changed or deleted (except the temp-password
-- bookkeeping table this file creates).
-- ============================================================================

-- ---- 1) password rule (one place) -------------------------------------------
create or replace function public._password_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p is not null and length(p) >= 12 and p ~ '[A-Za-z]' and p ~ '[0-9]'
$$;
revoke all on function public._password_ok(text) from public, anon, authenticated;

-- ---- 2) keep the existing admin_create_user body as the private core ---------
do $$
begin
  if to_regprocedure('public._admin_create_user_core(text,text,text)') is null
     and to_regprocedure('public.admin_create_user(text,text,text)') is not null
     and pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) not like '%auth-hardening-0028%' then
    alter function public.admin_create_user(text, text, text) rename to _admin_create_user_core;
  end if;
end $$;
-- the core still carries its own is_admin() check, but nobody may call it directly
do $$
begin
  if to_regprocedure('public._admin_create_user_core(text,text,text)') is not null then
    revoke all on function public._admin_create_user_core(text, text, text) from public, anon, authenticated;
  end if;
end $$;

-- ---- 3) the hardened entry point (same name + signature the app calls) -------
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: password rule + bcrypt cost 12 + no cross-tenant email oracle
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role using errcode = '22023'; end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'invalid email' using errcode = '22023'; end if;
  if not public._password_ok(p_password) then
    raise exception 'password must be at least 12 characters and include a letter and a number' using errcode = '22023';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is not null then
    -- Only reveal what the admin can already see: members of their own studio.
    if exists (select 1 from public.profiles p where p.id = v_uid and p.org_id = public.current_org_id()) then
      raise exception 'this person is already a user in your studio' using errcode = '23505';
    end if;
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;

  v_uid := public._admin_create_user_core(v_email, p_password, p_role);
  -- re-hash at bcrypt cost 12 (pgcrypto supports bf cost 4..31)
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = v_uid;
  return v_uid;
end $$;
revoke all on function public.admin_create_user(text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

-- ---- 4) temp passwords: always policy-compliant; flag clearable only after a real change
create table if not exists public.auth_temp_passwords (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  pw_hash    text not null,                 -- the temp password's hash as issued
  created_at timestamptz not null default now()
);
alter table public.auth_temp_passwords enable row level security;
revoke all on public.auth_temp_passwords from public, anon, authenticated;

create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028
declare v_uid uuid; v_temp text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 16 random base64 chars (96 bits) + a fixed letter pair + one random digit:
  -- always >= 12 chars with a letter and a digit.
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text;
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  update public.profiles set must_change_password = true where id = v_uid;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;
revoke all on function public.admin_create_user_temp(text, text) from public, anon;
grant execute on function public.admin_create_user_temp(text, text) to authenticated;

create or replace function public.clear_password_change_required()
returns void language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: refuse while the account still has the temp password it was issued
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if exists (select 1 from public.auth_temp_passwords t join auth.users u on u.id = t.user_id
              where t.user_id = auth.uid() and u.encrypted_password = t.pw_hash) then
    raise exception 'set a new password first' using errcode = '42501';
  end if;
  update public.profiles set must_change_password = false where id = auth.uid();
  delete from public.auth_temp_passwords where user_id = auth.uid();
end $$;
revoke all on function public.clear_password_change_required() from public, anon;
grant execute on function public.clear_password_change_required() to authenticated;

-- ---- 5) mfa_ok(): server-side two-step check (helper only — see note) --------
-- true when the caller's token is aal2, or the caller has NO verified factor.
create or replace function public.mfa_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then return true; end if;
  if auth.uid() is null then return true; end if;
  return not exists (select 1 from auth.mfa_factors f
                      where f.user_id = auth.uid() and f.status::text = 'verified');
end $$;
revoke all on function public.mfa_ok() from public;
grant execute on function public.mfa_ok() to anon, authenticated;

-- ---- 6) my_auth_info(): the caller's OWN sign-in details for the account panel
create or replace function public.my_auth_info()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb; s jsonb;
begin
  if auth.uid() is null then return null; end if;
  select jsonb_build_object(
           'last_sign_in_at', u.last_sign_in_at,
           'created_at',      u.created_at,
           'mfa_enabled',     exists (select 1 from auth.mfa_factors f
                                       where f.user_id = u.id and f.status::text = 'verified'))
    into v from auth.users u where u.id = auth.uid();
  begin
    select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) into s from (
      select jsonb_build_object('created_at', ss.created_at, 'updated_at', ss.updated_at,
                                'user_agent', left(coalesce(ss.user_agent, ''), 200),
                                'ip', host(ss.ip), 'aal', ss.aal::text) as x
        from auth.sessions ss where ss.user_id = auth.uid()
       order by ss.created_at desc limit 10) q;
  exception when undefined_table or undefined_column then s := null;   -- older GoTrue: no session list
  end;
  return v || jsonb_build_object('sessions', s);
end $$;
revoke all on function public.my_auth_info() from public, anon;
grant execute on function public.my_auth_info() to authenticated;

-- ---- NOTE (not applied): server-side MFA backstop ---------------------------
-- The browser gate already sends anyone with a verified factor back to the
-- two-step screen until their session is aal2. To make the DATABASE refuse an
-- aal1 token as well, add `and public.mfa_ok()` to RESTRICTIVE policies, e.g.
--   create policy mfa_gate on public.quotes as restrictive for all to authenticated
--     using (public.mfa_ok()) with check (public.mfa_ok());
-- That is deliberately NOT done here: it touches every table's access path and
-- must be rolled out table-by-table with tests on staging first.
-- Verify after apply (read-only):
--   select pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure) like '%auth-hardening-0028%';
--   select to_regprocedure('public._admin_create_user_core(text,text,text)') is not null;
