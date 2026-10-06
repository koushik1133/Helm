-- ============================================================================
-- 00-supabase-shim.sql — minimal Supabase-compatible environment for LOCAL
-- behavioral testing of the Helm schema on a vanilla PostgreSQL 17 cluster.
-- ----------------------------------------------------------------------------
-- PURPOSE: a plain local Postgres lacks the objects the Helm schema depends on
-- (the auth/storage schemas, auth.uid()/auth.jwt(), the anon/authenticated/
-- service_role roles, pgcrypto in an `extensions` schema). This file stands up
-- the SMALLEST faithful subset so that RLS, SECURITY DEFINER RPCs, grants and
-- multi-tenant isolation can be exercised exactly as they behave on Supabase.
--
-- IT IS A TEST HARNESS ONLY. It is NEVER applied to staging or production
-- (Supabase already provides all of this). It is idempotent and self-contained.
--
-- HOW TESTS SIMULATE A SIGNED-IN USER (the standard Supabase-local pattern):
--   select auth.login_as('<user-uuid>');   -- sets request.jwt.claims + role
--   ... run queries as that tenant/role ...
--   select auth.logout();                   -- back to a clean session
-- current_org_id()/user_role() then resolve via public.profiles, exactly as in
-- production, because auth.uid() reads the claims GUC this file manages.
-- ============================================================================

-- ---- roles (NOLOGIN, matching Supabase) ------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator noinherit login password 'postgres'; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to current_user;   -- so the test superuser can SET ROLE into them

-- ---- schemas ---------------------------------------------------------------
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- ---- extensions (pgcrypto lives in `extensions`, as on Supabase) -----------
create extension if not exists pgcrypto with schema extensions;
-- gen_random_uuid() is built-in on PG13+; expose crypt()/gen_salt() via extensions schema (done by pgcrypto).

-- ---- auth.users / auth.identities (GoTrue subset; '' not NULL for tokens) --
create table if not exists auth.users (
  id                      uuid primary key default gen_random_uuid(),
  instance_id             uuid default '00000000-0000-0000-0000-000000000000',
  aud                     text,
  role                    text,
  email                   text unique,
  encrypted_password      text,
  email_confirmed_at      timestamptz,
  invited_at              timestamptz,
  confirmation_token      text default '',
  confirmation_sent_at    timestamptz,
  recovery_token          text default '',
  recovery_sent_at        timestamptz,
  email_change_token_new  text default '',
  email_change            text default '',
  email_change_sent_at    timestamptz,
  last_sign_in_at         timestamptz,
  raw_app_meta_data       jsonb default '{}'::jsonb,
  raw_user_meta_data      jsonb default '{}'::jsonb,
  is_super_admin          boolean,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  phone                   text,
  email_change_token_current text default '',
  email_change_confirm_status smallint default 0
);
create table if not exists auth.identities (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null default '{}'::jsonb,
  provider      text not null,
  provider_id   text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  last_sign_in_at timestamptz
);

-- ---- auth.uid()/auth.jwt()/auth.role() backed by request.jwt.claims GUC ----
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub','')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', current_setting('role', true));
$$;
create or replace function auth.email() returns text language sql stable as $$
  select auth.jwt() ->> 'email';
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email() to anon, authenticated, service_role;

-- ---- storage subset (buckets/objects) so storage policies load -------------
create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;

-- Supabase storage path helpers used by bucket RLS policies.
create or replace function storage.foldername(name text) returns text[] language sql immutable as $$
  select case when name is null or position('/' in name)=0 then array[]::text[]
              else (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] end;
$$;
create or replace function storage.filename(name text) returns text language sql immutable as $$
  select (string_to_array(name,'/'))[array_length(string_to_array(name,'/'),1)];
$$;
create or replace function storage.extension(name text) returns text language sql immutable as $$
  select nullif(split_part(storage.filename(name),'.',2),'');
$$;
grant execute on function storage.foldername(text), storage.filename(text), storage.extension(text) to anon, authenticated, service_role;

-- ---- test helpers: simulate sign-in as a given profile ----------------------
create or replace function auth.login_as(p_uid uuid) returns void language plpgsql as $$
declare claims jsonb;
begin
  select jsonb_build_object('sub', u.id::text, 'role','authenticated','email',u.email)
    into claims from auth.users u where u.id = p_uid;
  if claims is null then raise exception 'login_as: no auth.users row for %', p_uid; end if;
  perform set_config('request.jwt.claims', claims::text, false);
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('role', 'authenticated', false);
  set local role authenticated;
end $$;

create or replace function auth.login_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  set local role anon;
end $$;

create or replace function auth.logout() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
  reset role;
end $$;

-- A convenience: seed an auth user the way GoTrue would (token cols = '').
create or replace function auth.seed_user(p_email text, p_password text default 'test-pw')
  returns uuid language plpgsql as $$
declare uid uuid;
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                          confirmation_token, recovery_token, email_change, email_change_token_new,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated','authenticated', p_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '','','','', '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now())
  returning id into uid;
  insert into auth.identities (user_id, identity_data, provider, provider_id, last_sign_in_at)
  values (uid, jsonb_build_object('sub', uid::text, 'email', p_email), 'email', uid::text, now());
  return uid;
end $$;

-- ---- auth.mfa_factors / auth.sessions (GoTrue subset, used by 0028 helpers) --
-- On Supabase status/factor_type/aal are enums; text here (0028 compares ::text).
create table if not exists auth.mfa_factors (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type   text not null default 'totp',
  status        text not null default 'unverified',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create table if not exists auth.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  aal        text,
  user_agent text,
  ip         inet
);
