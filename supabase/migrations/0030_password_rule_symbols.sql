-- ============================================================================
-- 0030_password_rule_symbols.sql — CANONICAL forward-only.
--
-- What this changes, in plain words:
--   The owner set Supabase Auth -> Password requirements to "Lowercase, uppercase
--   letters, digits and symbols", minimum 12. Supabase enforces that on sign-up,
--   reset and change-password, but passwords set by a studio admin through
--   admin_create_user (Control Center) go straight into auth.users and never pass
--   through Supabase's check. This migration makes the database rule identical:
--     * at least 12 characters
--     * at least one lowercase letter, one uppercase letter, one digit
--     * at least one symbol from Supabase's set:  !@#$%^&*()_+-=[]{};'\:"|<>?,./`~
--   Temp (one-time) passwords issued by admin_create_user_temp now always contain
--   all four kinds, and the error message says exactly what is needed.
--
-- Additive + idempotent: only CREATE OR REPLACE of three functions. No table,
-- column or row is touched. admin_create_user keeps the exact 0028 body (and its
-- 'auth-hardening-0028' marker, so re-running 0028 never re-renames anything);
-- only the error text changes. 0028 is not edited.
-- ============================================================================

-- ---- 1) the rule (one place) -----------------------------------------------
create or replace function public._password_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  -- password-rule-0030: = Supabase "lowercase, uppercase, digits and symbols", min 12
  select p is not null
     and length(p) >= 12
     and p ~ '[a-z]'
     and p ~ '[A-Z]'
     and p ~ '[0-9]'
     and length(translate(p, '!@#$%^&*()_+-=[]{};''\:"|<>?,./`~', '')) < length(p)
$$;
revoke all on function public._password_ok(text) from public, anon, authenticated;

-- ---- 2) admin_create_user: same 0028 body, new message -----------------------
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028: password rule + bcrypt cost 12 + no cross-tenant email oracle
-- password-rule-0030: message matches the Supabase policy
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_uid   uuid;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role using errcode = '22023'; end if;
  if v_email = '' or position('@' in v_email) = 0 then raise exception 'invalid email' using errcode = '22023'; end if;
  if not public._password_ok(p_password) then
    raise exception 'password must be at least 12 characters and include a lowercase letter, an uppercase letter, a number and a symbol' using errcode = '22023';
  end if;

  select u.id into v_uid from auth.users u where lower(u.email) = v_email limit 1;
  if v_uid is not null then
    if exists (select 1 from public.profiles p where p.id = v_uid and p.org_id = public.current_org_id()) then
      raise exception 'this person is already a user in your studio' using errcode = '23505';
    end if;
    raise exception 'could not create this user — send them an invitation instead' using errcode = '22023';
  end if;

  v_uid := public._admin_create_user_core(v_email, p_password, p_role);
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 12))
   where id = v_uid;
  return v_uid;
end $$;
revoke all on function public.admin_create_user(text, text, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text) to authenticated;

-- ---- 3) temp passwords always satisfy the new rule ---------------------------
create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028 / password-rule-0030
declare v_uid uuid; v_temp text; v_sym text := '!#%*-_+=?';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 'H' (upper) + 'm' (lower) + 16 random base64 chars (96 bits) + one random digit
  -- + one random symbol: always >= 12 chars with all four kinds.
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text
         || substr(v_sym, 1 + get_byte(extensions.gen_random_bytes(1), 0) % length(v_sym), 1);
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  update public.profiles set must_change_password = true where id = v_uid;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;
revoke all on function public.admin_create_user_temp(text, text) from public, anon;
grant execute on function public.admin_create_user_temp(text, text) to authenticated;

-- Verify after apply (read-only):
--   select public._password_ok('Abcdefghij1!') as ok, public._password_ok('abcdefghij12') as old_rule_rejected_now;
--   select pg_get_functiondef('public._password_ok(text)'::regprocedure) like '%password-rule-0030%';
-- ============================================================================
