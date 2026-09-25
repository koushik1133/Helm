-- ============================================================================
-- phase100-temp-password-users.sql  — forward-only, additive, idempotent.
-- ----------------------------------------------------------------------------
-- Option A: admins add a user in User Control WITHOUT typing a password. The
-- server generates a strong one-time TEMP password, returns it once for the admin
-- to hand over, and flags the account so the user MUST set their own password on
-- first login.
--
-- Adds:
--   • profiles.must_change_password (bool, default false)
--   • admin_create_user_temp(email, role) -> { user_id, temp_password }  (admin only)
--   • password_change_required()  -> bool   (caller checks their own flag)
--   • clear_password_change_required() -> void (caller clears it after changing pw)
--
-- SAFETY: additive column (IF NOT EXISTS), CREATE OR REPLACE functions, explicit
-- grants. No data rewritten. Reuses the existing admin_create_user (which already
-- validates is_admin, role, email, and creates the auth user). Run once.
-- ============================================================================

begin;

alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

-- Admin-only: create a user with a SERVER-GENERATED temp password + force change.
create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare v_uid uuid; v_temp text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  -- URL-safe strong temp password (~16 chars); admin_create_user re-validates role/email.
  v_temp := translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9');
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);       -- creates auth user + profile
  update public.profiles set must_change_password = true where id = v_uid;
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;
revoke all on function public.admin_create_user_temp(text,text) from public, anon;
grant execute on function public.admin_create_user_temp(text,text) to authenticated;

-- Caller's own flag: does this user still need to set a real password?
create or replace function public.password_change_required()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select must_change_password from public.profiles where id = auth.uid()), false);
$$;
revoke all on function public.password_change_required() from public, anon;
grant execute on function public.password_change_required() to authenticated;

-- Caller clears their own flag after they have changed their password.
create or replace function public.clear_password_change_required()
returns void language sql security definer set search_path = public, pg_temp as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;
revoke all on function public.clear_password_change_required() from public, anon;
grant execute on function public.clear_password_change_required() to authenticated;

notify pgrst, 'reload schema';
commit;
