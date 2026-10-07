-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- ═════════════════════════════════════════════════════════════════════════════
-- =========================================================================
-- Blueprint Stage — seed team users (one per role), password "helm"
-- Run order in the Supabase SQL editor:
--   1) schema.sql        (layouts table)
--   2) auth-rbac.sql     (profiles + roles + RLS)
--   3) seed-users.sql    (THIS FILE)
--
-- Creates confirmed email/password users directly in the auth schema and
-- assigns each an RBAC role. Idempotent — safe to re-run.
--
-- Accounts (all password: helm):
--   admin@helm.com       → admin       (full access + user management)
--   planner@helm.com     → planner     (full create/edit/delete)
--   sales@helm.com       → sales       (create/edit)
--   operations@helm.com  → operations  (edit)
--   crew@helm.com        → crew        (view only)
--   client@helm.com      → client      (view only)
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_helm_user(p_email text, p_password text, p_role text)
returns void language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;

  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      p_email, extensions.crypt(p_password, extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now()
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      created_at, updated_at, last_sign_in_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', p_email),
      'email', uid::text, now(), now(), now()
    );
  else
    -- reset the password on re-run so it always matches
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
                          email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = uid;
  end if;

  insert into public.profiles (id, email, role)
  values (uid, p_email, p_role)
  on conflict (id) do update set role = excluded.role, email = excluded.email;
end; $$;

select public.create_helm_user('admin@helm.com',      encode(extensions.gen_random_bytes(18), 'base64'), 'admin');
select public.create_helm_user('planner@helm.com',    encode(extensions.gen_random_bytes(18), 'base64'), 'planner');
select public.create_helm_user('sales@helm.com',      encode(extensions.gen_random_bytes(18), 'base64'), 'sales');
select public.create_helm_user('operations@helm.com', encode(extensions.gen_random_bytes(18), 'base64'), 'operations');
select public.create_helm_user('crew@helm.com',       encode(extensions.gen_random_bytes(18), 'base64'), 'crew');
select public.create_helm_user('client@helm.com',     encode(extensions.gen_random_bytes(18), 'base64'), 'client');

-- verify
select p.email, p.role from public.profiles p order by p.role;
