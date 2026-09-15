-- =========================================================================
-- Blueprint Stage — COMPLETE setup (run this ONE file in the Supabase SQL editor)
-- Idempotent & self-contained: layouts table + RBAC (profiles/roles/RLS)
-- + six team users (password "helm"). Safe to re-run.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- 1) Layouts table -------------------------------------------------------------
create table if not exists public.layouts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Untitled layout',
  data       jsonb not null default '{"items":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists layouts_updated_at_idx on public.layouts (updated_at desc);

create or replace function public.set_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists layouts_set_updated_at on public.layouts;
create trigger layouts_set_updated_at before update on public.layouts
  for each row execute function public.set_updated_at();

-- 2) Profiles (one per auth user) + RBAC role ----------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'client'
             check (role in ('admin','planner','sales','operations','crew','client')),
  created_at timestamptz not null default now()
);

-- role helpers (SECURITY DEFINER → bypass RLS, no recursion)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales'), false); $$;
create or replace function public.can_delete() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner'), false); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- auto-create a profile whenever a user is added
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3) Row Level Security --------------------------------------------------------
alter table public.profiles enable row level security;
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "admin update profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using ( id = auth.uid() or public.is_admin() );
create policy "admin update profiles" on public.profiles for update to authenticated
  using ( public.is_admin() ) with check ( public.is_admin() );

alter table public.layouts enable row level security;
drop policy if exists "anon full access to layouts" on public.layouts;
drop policy if exists "authed read layouts"   on public.layouts;
drop policy if exists "editors insert layouts" on public.layouts;
drop policy if exists "editors update layouts" on public.layouts;
drop policy if exists "editors delete layouts" on public.layouts;
create policy "authed read layouts"   on public.layouts for select to authenticated using ( true );
create policy "editors insert layouts" on public.layouts for insert to authenticated with check ( public.can_create() );
create policy "editors update layouts" on public.layouts for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "editors delete layouts" on public.layouts for delete to authenticated using ( public.can_delete() );

-- 4) Seed the six team users (password "helm") ---------------------------------
create or replace function public.create_helm_user(p_email text, p_password text, p_role text)
returns void language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      p_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
    ) values (
      gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', p_email),
      'email', uid::text, now(), now(), now()
    );
  else
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
                          email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = uid;
  end if;
  -- GoTrue can't scan NULL token columns → normalise to '' (fixes "Database error querying schema")
  update auth.users set
    confirmation_token     = coalesce(confirmation_token, ''),
    recovery_token         = coalesce(recovery_token, ''),
    email_change           = coalesce(email_change, ''),
    email_change_token_new = coalesce(email_change_token_new, '')
  where id = uid;
  -- ensure an email identity row exists (older partial runs may have missed it)
  if not exists (select 1 from auth.identities where user_id = uid and provider = 'email') then
    insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', p_email), 'email', uid::text, now(), now(), now());
  end if;
  insert into public.profiles (id, email, role) values (uid, p_email, p_role)
  on conflict (id) do update set role = excluded.role, email = excluded.email;
end; $$;

select public.create_helm_user('admin@helm.com',      'helm', 'admin');
select public.create_helm_user('planner@helm.com',    'helm', 'planner');
select public.create_helm_user('sales@helm.com',      'helm', 'sales');
select public.create_helm_user('operations@helm.com', 'helm', 'operations');
select public.create_helm_user('crew@helm.com',       'helm', 'crew');
select public.create_helm_user('client@helm.com',     'helm', 'client');

-- verify (expect 6 rows)
select p.email, p.role from public.profiles p order by p.role;
