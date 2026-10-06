-- ============================================================================
-- FIX — create_helm_user() must set GoTrue's auth token columns to '' (not NULL)
-- ============================================================================
-- FINDING: public.create_helm_user(text,text,text) inserts into auth.users WITHOUT
-- setting confirmation_token / recovery_token / email_change* / phone_change* /
-- reauthentication_token. They default to NULL. GoTrue (Go) scans these as
-- non-nullable strings, so EVERY login for a user created this way returns
-- HTTP 500 "Database error querying schema". Confirmed on staging 2026-10-01
-- (admin@helm.com → 500; a non-existent user → clean 400, proving it is row-level).
--
-- SCOPE: create_helm_user is a DEV-SEED helper. The app's real user paths
-- (create_studio, admin_create_user / admin_create_user_temp) already set these
-- columns, so PRODUCTION end-user signups are NOT affected. This hardens the seed
-- helper so accounts it creates can actually log in, and (per SEC-01) RE-ASSERTS
-- the lockdown so the function is never reachable by anon/authenticated.
--
-- SAFETY: additive, idempotent, forward-only (create-or-replace + revoke).
-- Touches no data. Apply on STAGING first, verify, then PRODUCTION.
-- Related: supabase/security-fix/SEC-01-CRITICAL-create-helm-user-lockdown.sql
-- ============================================================================

-- ---- APPLY: replace the function so it writes valid auth rows ----
create or replace function public.create_helm_user(p_email text, p_password text, p_role text)
  returns void
  language plpgsql
  security definer
  set search_path to 'auth', 'public', 'extensions'
as $function$
declare
  uid     uuid;
  v_email text := lower(p_email);
begin
  select id into uid from auth.users where email = v_email;

  if uid is null then
    uid := gen_random_uuid();
    -- Column set mirrors public.admin_create_user() EXACTLY — proven present in this
    -- schema and proven sufficient for login (admin_create_user accounts sign in fine).
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      -- the columns that were missing before (GoTrue cannot scan NULL here):
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
    ) values (
      gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', v_email),
      'email', uid::text, now(), now(), now()
    );
  else
    -- existing row: reset password, confirm, and repair any NULL token columns
    update auth.users set
      encrypted_password     = extensions.crypt(p_password, extensions.gen_salt('bf')),
      email_confirmed_at     = coalesce(email_confirmed_at, now()),
      confirmation_token     = coalesce(confirmation_token, ''),
      recovery_token         = coalesce(recovery_token, ''),
      email_change           = coalesce(email_change, ''),
      email_change_token_new = coalesce(email_change_token_new, '')
    where id = uid;
  end if;

  insert into public.profiles (id, email, role) values (uid, v_email, p_role)
  on conflict (id) do update set role = excluded.role, email = excluded.email;
end;
$function$;

-- ---- RE-ASSERT SEC-01 LOCKDOWN (defense-in-depth; safe to re-run) ----
-- create-or-replace preserves existing grants, but we re-revoke so a freshly
-- created function (or an env that never applied SEC-01) is never anon-reachable.
revoke all on function public.create_helm_user(text, text, text) from anon;
revoke all on function public.create_helm_user(text, text, text) from authenticated;
revoke all on function public.create_helm_user(text, text, text) from public;

-- ---- VERIFY 1: definition now sets the token columns ----
select 'create_helm_user sets confirmation_token' as check,
       pg_get_functiondef('public.create_helm_user(text,text,text)'::regprocedure)
         like '%confirmation_token%' as ok;

-- ---- VERIFY 2: anon/authenticated CANNOT execute it (SEC-01 intact) ----
select coalesce(array_agg(r.rolname order by r.rolname)
         filter (where has_function_privilege(r.oid, p.oid, 'EXECUTE')
                   and r.rolname in ('anon','authenticated')), '{}') as reachable_by_api_roles,
       case when bool_or(r.rolname in ('anon','authenticated')
                          and has_function_privilege(r.oid, p.oid, 'EXECUTE'))
            then 'FAIL — still reachable' else 'PASS — locked' end as status
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated')) r
where n.nspname = 'public' and p.proname = 'create_helm_user';
