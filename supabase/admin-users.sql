-- =========================================================================
-- DEPRECATED — DO NOT RUN (PR-DEPLOY-01). This file defines PRE-HARDENING,
-- NON-org-scoped admin_set_role / admin_delete_user bodies. Re-running it after
-- phase73 would REVERT tenant isolation (cross-org role change / user deletion).
-- The canonical, org-scoped versions live in
-- supabase/phase73-definer-org-isolation-final.sql. Kept for history only.
-- =========================================================================
-- Admin user management via RPC — (historical) run ONCE in the Supabase SQL editor.
-- After this, the in-app "Users" panel (admin only) can add users, change
-- roles, and remove users with NO further SQL. Every function is guarded by
-- is_admin(), so only a signed-in admin can call them — a non-admin (or anon)
-- calling these over the API is rejected. Safe & idempotent.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- guard helper (already exists from setup, redefined here so this file stands alone)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- valid roles guard
create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable as $$
  select p_role in ('admin','planner','sales','operations','crew','client'); $$;

-- ---- create a fully-confirmed user + profile (admin only) -------------------
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_email is null or position('@' in p_email) = 0 then raise exception 'invalid email'; end if;
  if length(coalesce(p_password,'')) < 4 then raise exception 'password too short'; end if;

  select id into uid from auth.users where email = lower(p_email);
  if uid is not null then raise exception 'a user with that email already exists'; end if;

  uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    lower(p_email), extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', lower(p_email)),
    'email', uid::text, now(), now(), now()
  );
  -- profile (the on_auth_user_created trigger may also fire; upsert the role either way)
  insert into public.profiles (id, email, role) values (uid, lower(p_email), p_role)
    on conflict (id) do update set role = excluded.role, email = excluded.email;
  return uid;
end; $$;

-- ---- change a user's role (admin only) -------------------------------------
create or replace function public.admin_set_role(p_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_id = auth.uid() and p_role <> 'admin' then
    raise exception 'you cannot remove your own admin role'; end if;
  update public.profiles set role = p_role where id = p_id;
  if not found then raise exception 'no such user'; end if;
end; $$;

-- ---- remove a user (admin only) --------------------------------------------
create or replace function public.admin_delete_user(p_id uuid)
returns void language plpgsql security definer set search_path = auth, public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_id = auth.uid() then raise exception 'you cannot delete your own account'; end if;
  delete from auth.users where id = p_id;   -- cascades to public.profiles
  if not found then raise exception 'no such user'; end if;
end; $$;

-- lock down execute: only authenticated callers reach the guarded body
revoke all on function public.admin_create_user(text,text,text) from public, anon;
revoke all on function public.admin_set_role(uuid,text)         from public, anon;
revoke all on function public.admin_delete_user(uuid)           from public, anon;
grant execute on function public.admin_create_user(text,text,text) to authenticated;
grant execute on function public.admin_set_role(uuid,text)         to authenticated;
grant execute on function public.admin_delete_user(uuid)           to authenticated;

-- verify — expect the three admin_* functions
select proname from pg_proc where proname like 'admin\_%' order by proname;
