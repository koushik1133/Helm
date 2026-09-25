-- =========================================================================
-- Blueprint Stage — Auth + RBAC
-- Run this AFTER schema.sql, in the Supabase SQL editor.
-- Roles: admin | planner | sales | operations | crew | client
--   edit-capable: admin, planner, sales, operations
--   view-only:    crew, client
-- =========================================================================

-- 1) Profiles: one row per auth user, holds their RBAC role -----------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'client'
             check (role in ('admin','planner','sales','operations','crew','client')),
  created_at timestamptz not null default now()
);

-- 2) Role helper functions (SECURITY DEFINER → bypass RLS, no recursion) -----
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false);
$$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false);
$$;

-- 3) Auto-create a profile whenever a user is added -------------------------
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

-- 4) Profiles RLS: read your own (admins read all); admins can change roles --
alter table public.profiles enable row level security;
drop policy if exists "read profiles" on public.profiles;
drop policy if exists "admin update profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using ( id = auth.uid() or public.is_admin() );
create policy "admin update profiles" on public.profiles for update to authenticated
  using ( public.is_admin() ) with check ( public.is_admin() );

-- 5) Layouts RLS: any signed-in user can VIEW; only edit-roles can WRITE -----
drop policy if exists "anon full access to layouts" on public.layouts;
drop policy if exists "authed read layouts"   on public.layouts;
drop policy if exists "editors insert layouts" on public.layouts;
drop policy if exists "editors update layouts" on public.layouts;
drop policy if exists "editors delete layouts" on public.layouts;
-- SEC-01 (Wave 4): once phase89 adds layouts.org_id, these policies must be
-- ORG-SCOPED so re-running this legacy file can never restore cross-tenant
-- access. On a pre-phase89 DB (no org_id column yet) we keep the historical
-- behavior. phase89 remains the canonical authority for layouts RLS.
do $$
declare has_org boolean;
begin
  select exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='layouts' and column_name='org_id') into has_org;
  if has_org then
    execute $p$ create policy "authed read layouts"   on public.layouts for select to authenticated using ( org_id is not null and org_id = (select public.current_org_id()) ) $p$;
    execute $p$ create policy "editors insert layouts" on public.layouts for insert to authenticated with check ( public.can_edit() and org_id = (select public.current_org_id()) ) $p$;
    execute $p$ create policy "editors update layouts" on public.layouts for update to authenticated using ( org_id is not null and org_id = (select public.current_org_id()) ) with check ( public.can_edit() and org_id = (select public.current_org_id()) ) $p$;
    execute $p$ create policy "editors delete layouts" on public.layouts for delete to authenticated using ( public.can_edit() and org_id is not null and org_id = (select public.current_org_id()) ) $p$;
  else
    execute $p$ create policy "authed read layouts"   on public.layouts for select to authenticated using ( true ) $p$;
    execute $p$ create policy "editors insert layouts" on public.layouts for insert to authenticated with check ( public.can_edit() ) $p$;
    execute $p$ create policy "editors update layouts" on public.layouts for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() ) $p$;
    execute $p$ create policy "editors delete layouts" on public.layouts for delete to authenticated using ( public.can_edit() ) $p$;
  end if;
end $$;

-- =========================================================================
-- SETUP (do these in the Supabase dashboard):
--   Authentication → Providers → Email: enable. Turn OFF "Confirm email"
--     for internal team accounts, OR confirm each user's email.
--   Authentication → Users → "Add user" for each team member.
--   Then promote them by role, e.g.:
--       update public.profiles set role='admin'   where email='owner@agency.com';
--       update public.profiles set role='planner' where email='jane@agency.com';
--       update public.profiles set role='crew'    where email='setup@agency.com';
-- Make at least ONE admin first, or you won't be able to change roles in-app.
-- =========================================================================
