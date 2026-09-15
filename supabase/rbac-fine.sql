-- =========================================================================
-- Fine-grained RBAC on layouts — run ONCE in the Supabase SQL editor.
-- Safe & idempotent. Fixes DB-level enforcement so the API matches the UI:
--   view   : everyone signed in
--   create : admin / planner / sales
--   edit   : admin / planner / sales / operations
--   delete : admin / planner
-- =========================================================================

-- 1) role → capability helpers (SECURITY DEFINER = bypass RLS, no recursion)
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

-- 2) wipe EVERY existing policy on layouts (incl. legacy permissive ones that
--    would otherwise OR-in and defeat the strict rules), then rebuild cleanly.
alter table public.layouts enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
end $$;

create policy "authed read layouts"    on public.layouts for select to authenticated using ( true );
create policy "editors insert layouts" on public.layouts for insert to authenticated with check ( public.can_create() );
create policy "editors update layouts" on public.layouts for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "editors delete layouts" on public.layouts for delete to authenticated using ( public.can_delete() );

-- 3) verify — expect exactly these four rows
select policyname, cmd from pg_policies
where schemaname='public' and tablename='layouts' order by cmd;
