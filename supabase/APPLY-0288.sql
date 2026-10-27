-- APPLY-0288.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER every earlier APPLY file (needs 0047 / 0053 / 0248 / 0277; 0279-0292 are not needed by this file).
-- R39 Google-only sign-in for Helm staff (@helm.events). Adds ONE switch, helm_hq_settings.staff_google_only, which is OFF.
-- While it is OFF nothing changes for anybody. When the HQ Owner turns it ON (HQ -> Staff access, after testing):
--   * password sign-in for any @helm.events address is refused: "Helm staff sign in with Google. Use 'Continue with Google'."
--   * Helm HQ only opens on a Google sign-in with the helm.events Workspace account (+ two-step, as today)
--   * magic links and password-reset links for @helm.events are refused (never stored)
--   * a new @helm.events login can only be made with Google
-- Studio (customer) people are never affected. New columns / functions / two guard triggers; no row deleted or changed.
-- Safe to run twice. ASCII only.
--
-- OWNER STEPS (full plain-words list: STAFF-GOOGLE-ONLY-STEPS.md):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Supabase dashboard -> Authentication -> Hooks: "Password Verification Attempt" must point to
--      public.hook_password_verification_attempt (Team plan). On a Pro plan use instead "Customize Access Token (JWT)
--      Claims" -> public.hook_custom_access_token_r39. Either one is optional: HQ is protected by the database anyway.
--   3  Deploy the site. Each HQ person signs in once with Continue with Google; then the Owner turns the switch on in
--      HQ -> Staff access -> "Google-only sign-in for Helm staff".
--   EMERGENCY UNDO (Owner locked out): run ONLY this in the SQL editor, then sign in with password + two-step as before:
--      update public.helm_hq_settings set staff_google_only = false, staff_google_only_changed_at = now(),
--             staff_google_only_changed_by = 'break-glass (SQL editor)' where id;
--   If you ever re-run APPLY-0277.sql, re-run this file after it (0277 puts back the HQ check without the Google rule).
begin;
-- 0288_staff_google_only.sql - CANONICAL forward-only.
-- REQUIRES 0047 (helm_hq_settings), 0053 (hook_password_verification_attempt), 0277 (HQ staff roles: is_platform_admin,
--          _hq_gate / _hq_wgate, _hq27_me, _hq27_event, hq_staff_events).
--
-- In plain words (owner, r39: "Helm staff on @helm.events sign in ONLY with their Google Workspace account"):
--   1  A SWITCH, helm_hq_settings.staff_google_only (default OFF). While it is OFF nothing at all changes.
--   2  While it is ON, for every address on helm.events (exactly that domain):
--        a  PASSWORD sign-in is refused with "Helm staff sign in with Google. Use 'Continue with Google'." - by the
--           Supabase "Password Verification Attempt" hook (0053's hook, now wrapped: the staff check first, then the
--           0053 lockout body unchanged). Studio people go straight to the 0053 body as before.
--        b  HELM HQ needs a GOOGLE session: is_platform_admin() (and with it every HQ gate) also requires that this
--           sign-in was made with Google (the token's amr list has method 'oauth' - Supabase writes 'oauth' for BOTH
--           Google's own button (GIS id token) and the redirect button) AND the login's Google identity is a
--           helm.events Workspace account: Google said hd = helm.events, or the Google e-mail is on helm.events and
--           Google verified it. A personal Gmail never passes (wrong domain). A login that also has a NON-helm.events
--           Google identity, or any other social / SSO identity, never passes either.
--        c  MAGIC LINKS and PASSWORD RESET links for a helm.events address are refused: the link is never stored, so
--           it cannot sign anyone in (guard trigger on auth.users.recovery_token, which Supabase uses for both).
--           A NEW helm.events login can only be made by Google (guard trigger on auth.identities: a password / e-mail
--           identity, or a Google identity that is not the helm.events Workspace one, is refused).
--        d  OPTIONAL, for plans without the password hook: hook_custom_access_token_r39 (Supabase "Custom Access
--           Token" hook, Free / Pro) refuses to issue a token to a helm.events login unless the sign-in was Google.
--           Dormant until the owner turns that hook on in the dashboard (STAFF-GOOGLE-ONLY-STEPS.md).
--   3  Turning the switch ON / OFF: hq_set_staff_google_only - HQ Owner only, two-step (aal2) session, fresh code (the
--      0277 _hq_wgate rule for Owner-only changes), audited (audit_log + hq_staff_events 'settings' + e-mail to every
--      Owner). Turning it ON is refused unless YOUR OWN sign-in right now is a helm.events Google sign-in (so you have
--      proved Google works before you depend on it).
--   4  HQ page helpers: staff_google_session_check() (any HQ person, before two-step: "do I need to sign in with Google?"),
--      hq_staff_google_only() (Owner: the switch + a per-person "has signed in with Google" checklist),
--      staff_google_only_for(email) (sign-in page, anyone: "is this a helm.events address while the switch is on?" -
--      it says nothing about whether the address has a login).
--   5  BREAK-GLASS (only in the Supabase SQL editor, never in the app):
--        update public.helm_hq_settings set staff_google_only = false, staff_google_only_changed_at = now(),
--               staff_google_only_changed_by = 'break-glass (SQL editor)' where id;
-- Studio (customer) people: never affected - every check needs the switch ON *and* a helm.events address.
-- Additive + idempotent: 3 new columns (defaults), new functions, 2 new guard triggers, create-or-replace of
-- is_platform_admin (the 0277 body + one check), 0053's hook renamed ONCE to *__pre0288 (body untouched) and wrapped.
-- No row is deleted or changed. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): turn the switch off (above) - that alone restores the old behaviour.
--   Full code rollback: re-run the is_platform_admin block of 0277; drop function public.hook_password_verification_attempt(jsonb);
--   alter function public.hook_password_verification_attempt__pre0288(jsonb) rename to hook_password_verification_attempt;
--   drop trigger a288_staff_google_identity on auth.identities; drop trigger a288_staff_google_recovery on auth.users.

do $$ begin
  if to_regclass('public.helm_hq_settings') is null then raise exception 'STOP 0288: 0047 (helm_hq_settings) is not applied'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_me()') is null
     or to_regprocedure('public._hq27_event(text,text,jsonb)') is null then
    raise exception 'STOP 0288: 0277 (HQ staff roles) is not applied'; end if;
  if to_regprocedure('public.hook_password_verification_attempt(jsonb)') is null then
    raise exception 'STOP 0288: 0053 (hook_password_verification_attempt) is not applied'; end if;
  if to_regclass('auth.users') is null or to_regclass('auth.identities') is null then raise exception 'STOP 0288: auth.users / auth.identities missing'; end if;
  if position('r27-hq-staff-0277' in coalesce((select prosrc from pg_proc where oid = 'public.is_platform_admin()'::regprocedure), '')) = 0
     and position('r39-staff-google-0288' in coalesce((select prosrc from pg_proc where oid = 'public.is_platform_admin()'::regprocedure), '')) = 0 then
    raise exception 'STOP 0288: is_platform_admin is not the 0277 one - run APPLY-0277 first'; end if;
end $$;

-- ---- 1) the switch (OFF) ---------------------------------------------------------------------------------------------
alter table public.helm_hq_settings add column if not exists staff_google_only boolean not null default false;
alter table public.helm_hq_settings add column if not exists staff_google_only_changed_at timestamptz;
alter table public.helm_hq_settings add column if not exists staff_google_only_changed_by text;

-- ---- 2) the rules (one place) ----------------------------------------------------------------------------------------
create or replace function public._r39_on()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r39-staff-google-0288
  select coalesce((select s.staff_google_only from public.helm_hq_settings s where s.id), false)
$$;

-- an address on helm.events (exactly; case / spaces / a trailing dot ignored)
create or replace function public._r39_is_staff_email(p_email text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(split_part(rtrim(lower(btrim(coalesce(p_email, ''))), '.'), '@', 2) = 'helm.events'
                  and length(split_part(lower(btrim(coalesce(p_email, ''))), '@', 1)) > 0
                  and array_length(string_to_array(lower(btrim(coalesce(p_email, ''))), '@'), 1) = 2, false)
$$;

create or replace function public._r39_message()
returns text language sql immutable set search_path = '' as $$
  select 'Helm staff sign in with Google. Use ''Continue with Google''.'::text
$$;

-- one Google identity is the helm.events Workspace account of this login:
-- same e-mail as the login, on helm.events, and Google said hd = helm.events or verified the e-mail
create or replace function public._r39_google_identity_ok(p_data jsonb, p_user_email text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(
    public._r39_is_staff_email(p_data ->> 'email')
    and lower(btrim(p_data ->> 'email')) = lower(btrim(coalesce(p_user_email, '')))
    and (lower(coalesce(p_data -> 'custom_claims' ->> 'hd', '')) = 'helm.events'
         or lower(coalesce(p_data ->> 'email_verified', '')) = 'true'),
    false)
$$;

-- this LOGIN may use Helm HQ under the switch: helm.events address, at least one helm.events Workspace Google identity,
-- and no other social / SSO identity (a linked personal Gmail or any other provider makes it fail)
create or replace function public._r39_login_ok(p_uid uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  -- r39-staff-google-0288
  select u.email into v_email from auth.users u where u.id = p_uid;
  if v_email is null or not public._r39_is_staff_email(v_email) then return false; end if;
  if not exists (select 1 from auth.identities i where i.user_id = p_uid and i.provider = 'google'
                  and public._r39_google_identity_ok(i.identity_data, v_email)) then return false; end if;
  if exists (select 1 from auth.identities i where i.user_id = p_uid and i.provider not in ('email', 'phone')
              and not (i.provider = 'google' and public._r39_google_identity_ok(i.identity_data, v_email))) then return false; end if;
  return true;
end $$;

-- THIS sign-in (the caller's token) was made with Google ('oauth' in amr: Google's button and the redirect button)
create or replace function public._r39_session_is_google()
returns boolean language plpgsql stable set search_path = '' as $$
declare a jsonb := auth.jwt() -> 'amr';
begin
  -- r39-staff-google-0288
  if a is null or jsonb_typeof(a) <> 'array' then return false; end if;
  return exists (select 1 from jsonb_array_elements(a) e
                  where (jsonb_typeof(e) = 'object' and e ->> 'method' = 'oauth') or (jsonb_typeof(e) = 'string' and e #>> '{}' = 'oauth'));
end $$;

-- the whole HQ rule under the switch (true when the switch is off)
create or replace function public._r39_hq_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  -- r39-staff-google-0288
  if not public._r39_on() then return true; end if;
  return auth.uid() is not null and public._r39_session_is_google() and public._r39_login_ok(auth.uid());
end $$;

-- ---- 3) HQ access needs a Google session while the switch is on (0277 body + one check) ------------------------------
create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  -- r27-hq-staff-0277: aal2 always (r22-mfa-0253 rule with the switch permanently on) + active / invited staff only
  -- r39-staff-google-0288: + while helm_hq_settings.staff_google_only is on, a helm.events Google sign-in only
  v_uid uuid := auth.uid(); v_st text;
begin
  if v_uid is null or not public.is_platform_operator() then return false; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  select me.status into v_st from public._hq27_me() me;
  if coalesce(v_st, '') not in ('active', 'invited') then return false; end if;
  return public._r39_hq_ok();
end $$;

-- ---- 4) password sign-in: the 0053 hook renamed ONCE to *__pre0288 (body untouched) and wrapped ------------------------
-- A wrapper is recognised by its marker. If a later re-run of 0053 put the plain body back under the public name, that
-- newer body becomes the inner function (the older *__pre0288 copy is replaced by it) and the wrapper goes on top.
do $$
declare v_pub regprocedure := to_regprocedure('public.hook_password_verification_attempt(jsonb)');
        v_pre regprocedure := to_regprocedure('public.hook_password_verification_attempt__pre0288(jsonb)');
begin
  if v_pub is not null and position('r39-staff-google-0288' in coalesce((select prosrc from pg_proc where oid = v_pub), '')) = 0 then
    if v_pre is not null then execute 'drop function ' || v_pre::text; end if;
    alter function public.hook_password_verification_attempt(jsonb) rename to hook_password_verification_attempt__pre0288;
  end if;
  if to_regprocedure('public.hook_password_verification_attempt__pre0288(jsonb)') is null then
    raise exception '0288: hook_password_verification_attempt__pre0288 missing (run 0053 first)'; end if;
end $$;

create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_email text; v_staff boolean := false;
begin
  -- r39-staff-google-0288: helm.events staff sign in with Google while the switch is on; everyone else -> the 0053 body
  begin
    if public._r39_on() then
      select u.email into v_email from auth.users u where u.id = (event ->> 'user_id')::uuid;
      v_staff := public._r39_is_staff_email(v_email);
    end if;
  exception when others then v_staff := false;   -- malformed event / our bug: never block on it (the HQ gate still applies)
  end;
  if v_staff then
    return jsonb_build_object('decision', 'reject', 'message', public._r39_message(), 'should_logout_user', false);
  end if;
  return public.hook_password_verification_attempt__pre0288(event);
end $$;

-- ---- 5) optional Custom Access Token hook (Free / Pro plans): no token for a helm.events login unless it is Google -------
-- event = {"user_id", "claims": {..., "amr": [{"method": ...}]}, "authentication_method"}; allow -> {"claims": claims}
create or replace function public.hook_custom_access_token_r39(event jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb); v_email text; v_block boolean := false; a jsonb;
begin
  -- r39-staff-google-0288
  begin
    if public._r39_on() then
      select u.email into v_email from auth.users u where u.id = (event ->> 'user_id')::uuid;
      if public._r39_is_staff_email(v_email) then
        a := v_claims -> 'amr';
        v_block := not (jsonb_typeof(a) = 'array' and exists (select 1 from jsonb_array_elements(a) e
                         where (jsonb_typeof(e) = 'object' and e ->> 'method' = 'oauth') or (jsonb_typeof(e) = 'string' and e #>> '{}' = 'oauth')))
                   and coalesce(event ->> 'authentication_method', '') <> 'oauth';
      end if;
    end if;
  exception when others then v_block := false;     -- our bug must never stop anyone signing in (the HQ gate still applies)
  end;
  if v_block then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', public._r39_message()));
  end if;
  return jsonb_build_object('claims', v_claims);
end $$;

-- ---- 6) guard triggers (act only while the switch is on, only for helm.events) ----------------------------------------
-- a NEW identity on a helm.events login must be its helm.events Workspace Google identity
create or replace function public.tg_r39_identity_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text; v_bad boolean := false;
begin
  -- r39-staff-google-0288
  begin
    if public._r39_on() then
      select u.email into v_email from auth.users u where u.id = new.user_id;
      if public._r39_is_staff_email(v_email) or public._r39_is_staff_email(new.identity_data ->> 'email') then
        v_bad := not (new.provider = 'google' and public._r39_google_identity_ok(new.identity_data, coalesce(v_email, new.identity_data ->> 'email')));
      end if;
    end if;
  exception when others then v_bad := false;       -- our bug must never stop Supabase Auth working
  end;
  if v_bad then raise exception '%', public._r39_message() using errcode = '42501'; end if;
  return new;
end $$;

-- a magic-link / password-reset link for a helm.events login is never stored (so it can never sign anyone in)
create or replace function public.tg_r39_recovery_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_bad boolean := false;
begin
  -- r39-staff-google-0288
  begin
    v_bad := coalesce(new.recovery_token, '') <> '' and new.recovery_token is distinct from old.recovery_token
             and public._r39_on() and public._r39_is_staff_email(new.email);
  exception when others then v_bad := false;
  end;
  if v_bad then raise exception '%', public._r39_message() using errcode = '42501'; end if;
  return new;
end $$;

do $$ begin
  drop trigger if exists a288_staff_google_identity on auth.identities;
  create trigger a288_staff_google_identity before insert on auth.identities
    for each row execute function public.tg_r39_identity_guard();
  drop trigger if exists a288_staff_google_recovery on auth.users;
  create trigger a288_staff_google_recovery before update of recovery_token on auth.users
    for each row execute function public.tg_r39_recovery_guard();
exception when insufficient_privilege then
  raise notice '0288: could not add the guard triggers on auth.* (%). The switch, the HQ rule and the hooks still work.', sqlerrm;
end $$;

-- ---- 7) HQ functions ------------------------------------------------------------------------------------------------
-- any HQ person, before two-step: does THIS sign-in need to be a Google one?
create or replace function public.staff_google_session_check()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_on boolean := public._r39_on(); v_sess boolean := public._r39_session_is_google(); v_login boolean;
begin
  -- r39-staff-google-0288
  if auth.uid() is null or not public.is_platform_operator() then raise exception 'not authorized' using errcode = '42501'; end if;
  v_login := public._r39_login_ok(auth.uid());
  return jsonb_build_object('on', v_on, 'session_google', v_sess, 'login_google', v_login,
    'needs_google', v_on and not (v_sess and v_login));
end $$;

-- Owner: the switch + the "test my Google sign-in first" checklist (every active / invited HQ person)
create or replace function public.hq_staff_google_only()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s public.helm_hq_settings; r jsonb;
begin
  -- r39-staff-google-0288
  perform public._hq_gate('hq_staff_google_only');   -- unknown read -> Owner only (0277)
  select * into s from public.helm_hq_settings x where x.id;
  select coalesce(jsonb_agg(jsonb_build_object('email', pa.email, 'role', pa.role, 'status', pa.status,
           'on_domain', public._r39_is_staff_email(pa.email), 'has_login', u.id is not null,
           'google_ok', u.id is not null and public._r39_login_ok(u.id),
           'google_last_sign_in', (select max(i.last_sign_in_at) from auth.identities i where i.user_id = u.id and i.provider = 'google'))
           order by (pa.role = 'owner') desc, pa.email), '[]'::jsonb)
    into r
    from public.platform_admins pa left join auth.users u on lower(u.email) = pa.email
   where pa.status in ('active', 'invited');
  return jsonb_build_object('on', coalesce(s.staff_google_only, false), 'changed_at', s.staff_google_only_changed_at,
    'changed_by', s.staff_google_only_changed_by, 'my_session_google', public._r39_session_is_google() and public._r39_login_ok(auth.uid()),
    'staff', r);
end $$;

-- Owner + aal2 + fresh code (_hq_wgate, Owner-only action), audited; ON only from a helm.events Google sign-in
create or replace function public.hq_set_staff_google_only(p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me public.platform_admins; v_before boolean := public._r39_on();
begin
  -- r39-staff-google-0288
  if p_on is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  perform public._hq_wgate('hq.staff.google_only', 'helm_hq_settings', 'staff_google_only',
    jsonb_build_object('before', v_before, 'after', p_on));
  select * into me from public._hq27_me();
  if me.email is null or me.role <> 'owner' then
    raise exception 'not authorized: HQ_ROLE only an HQ Owner can change Google-only sign-in' using errcode = '42501'; end if;
  if p_on and not (public._r39_session_is_google() and public._r39_login_ok(auth.uid())) then
    raise exception 'Sign in to HQ with Google (your helm.events Workspace account) first, then turn this on. That proves Google works for you, so you can''t lock yourself out.'
      using errcode = '22023';
  end if;
  update public.helm_hq_settings set staff_google_only = p_on, staff_google_only_changed_at = now(), staff_google_only_changed_by = me.email
   where id and staff_google_only is distinct from p_on;
  if v_before is distinct from p_on then
    perform public._hq27_event('settings', me.email, jsonb_build_object('staff_google_only', jsonb_build_object('before', v_before, 'after', p_on)));
  end if;
  return jsonb_build_object('on', public._r39_on());
end $$;

-- sign-in page (anyone): "Helm staff: please use Continue with Google" for a helm.events address while the switch is on.
-- Says nothing about whether the address has a login.
create or replace function public.staff_google_only_for(p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r39-staff-google-0288
  select public._r39_on() and length(coalesce(p_email, '')) <= 254 and public._r39_is_staff_email(p_email)
$$;

-- ---- 8) grants -------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: nobody calls these through the API
  foreach f in array array['public._r39_on()', 'public._r39_is_staff_email(text)', 'public._r39_message()',
      'public._r39_google_identity_ok(jsonb, text)', 'public._r39_login_ok(uuid)', 'public._r39_session_is_google()', 'public._r39_hq_ok()',
      'public.tg_r39_identity_guard()', 'public.tg_r39_recovery_guard()', 'public.hook_password_verification_attempt__pre0288(jsonb)',
      'public.hook_password_verification_attempt(jsonb)', 'public.hook_custom_access_token_r39(jsonb)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', f); end if;
  end loop;
  -- Supabase Auth calls the hooks
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
    grant execute on function public.hook_custom_access_token_r39(jsonb) to supabase_auth_admin;
  end if;
  -- signed-in only (each checks HQ staff inside); never anon
  foreach f in array array['public.staff_google_session_check()', 'public.hq_staff_google_only()', 'public.hq_set_staff_google_only(boolean)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the sign-in page asks before anyone is signed in
  revoke all on function public.staff_google_only_for(text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then grant execute on function public.staff_google_only_for(text) to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.staff_google_only_for(text) to authenticated; end if;
  -- is_platform_admin keeps the 0277 grants (signed-in only)
  revoke all on function public.is_platform_admin() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.is_platform_admin() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.is_platform_admin() to authenticated; end if;
end $$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 the switch exists (helm_hq_settings.staff_google_only, default OFF)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_hq_settings'
              and column_name = 'staff_google_only' and column_default = 'false')),
  ('02 INFO the switch is now ' || case when public._r39_on() then 'ON' else 'OFF (nothing changes until the HQ Owner turns it on)' end, true),
  ('03 HQ access = the 0277 rule + the Google rule (is_platform_admin)',
     position('r27-hq-staff-0277' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0
     and position('r39-staff-google-0288' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0),
  ('04 password hook wrapped once; the 0053 lockout body kept as hook_password_verification_attempt__pre0288',
     position('r39-staff-google-0288' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hook_password_verification_attempt(jsonb)')), '')) > 0
     and position('auth_password_attempts' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.hook_password_verification_attempt__pre0288(jsonb)')), '')) > 0),
  ('05 Supabase Auth may call both hooks; the app may not',
     (not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
      or (has_function_privilege('supabase_auth_admin', 'public.hook_password_verification_attempt(jsonb)', 'execute')
          and has_function_privilege('supabase_auth_admin', 'public.hook_custom_access_token_r39(jsonb)', 'execute')))
     and not has_function_privilege('authenticated', 'public.hook_password_verification_attempt(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.hook_custom_access_token_r39(jsonb)', 'execute')),
  ('06 guard triggers: reset / magic links (auth.users) + new identities (auth.identities)',
     exists (select 1 from pg_trigger where tgname = 'a288_staff_google_recovery' and tgrelid = 'auth.users'::regclass and not tgisinternal)
     and exists (select 1 from pg_trigger where tgname = 'a288_staff_google_identity' and tgrelid = 'auth.identities'::regclass and not tgisinternal)),
  ('07 HQ functions signed-in only; the sign-in page hint open to visitors; rule pieces private',
     has_function_privilege('authenticated', 'public.hq_set_staff_google_only(boolean)', 'execute')
     and not has_function_privilege('anon', 'public.hq_set_staff_google_only(boolean)', 'execute')
     and not has_function_privilege('anon', 'public.staff_google_session_check()', 'execute')
     and has_function_privilege('anon', 'public.staff_google_only_for(text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r39_login_ok(uuid)', 'execute')),
  ('08 studio people never affected: only exactly helm.events counts',
     public._r39_is_staff_email('admin@helm.events') and not public._r39_is_staff_email('owner@studio.example')
     and not public._r39_is_staff_email('x@helm.events.example') and not public.staff_google_only_for('owner@studio.example')),
  ('09 a personal Gmail or an unverified Google account never passes',
     not public._r39_google_identity_ok('{"email":"someone@gmail.com","email_verified":true}'::jsonb, 'someone@gmail.com')
     and not public._r39_google_identity_ok('{"email":"x@helm.events","email_verified":false}'::jsonb, 'x@helm.events')
     and public._r39_google_identity_ok('{"email":"x@helm.events","email_verified":true,"custom_claims":{"hd":"helm.events"}}'::jsonb, 'x@helm.events')),
  ('10 INFO HQ people with a working helm.events Google sign-in: ' || coalesce((select string_agg(pa.email, ', ' order by pa.email)
     from public.platform_admins pa join auth.users u on lower(u.email) = pa.email
     where pa.status in ('active', 'invited') and public._r39_login_ok(u.id)), 'none yet - each person signs in once with Continue with Google'), true),
  ('11 INFO HQ people who would lose HQ while the switch is on (not on helm.events): ' || coalesce((select string_agg(pa.email, ', ' order by pa.email)
     from public.platform_admins pa where pa.status in ('active', 'invited') and not public._r39_is_staff_email(pa.email)), 'none'), true)
) v(item, ok) order by item;
