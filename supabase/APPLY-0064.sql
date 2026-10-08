-- ============================================================================
-- HELM - 0064 saved filters / saved views (one paste) (2026-10-08)
--   * saved_views: each member's saved search/filter views for the Leads,
--     Quotes, Staff, Vendors and Inventory lists. Members manage only their own.
--   * Studio admins may share a view with the studio; it is readable only by
--     members of the same studio whose role may VIEW that page in the access
--     matrix. Suspended studios are read-only here like every studio table.
-- REQUIRES the base schema (has_area, current_org_id, is_admin) and 0045.
-- WHAT IT TOUCHES: 1 new table (RLS on), 3 new functions, triggers on the new
-- table only. NO existing table or row is created, deleted or changed.
-- SAFE TO RE-RUN. Plain ASCII on purpose (the SQL editor mangles fancy characters).
-- ============================================================================
-- ============================================================================
-- 0064_saved_views.sql - CANONICAL forward-only. Saved filters / views for the
-- list pages (public/saved-filters.js): leads, quotes (events), staff, vendors,
-- inventory. REQUIRES the base schema (has_area, current_org_id, is_admin) and
-- 0045 (tg_studio_read_only) - the preflight stops if either is missing.
--
-- In plain words:
--   * saved_views - one row per saved view: who saved it, which studio, which
--     page, a name and the page's search / filter state (a small JSON object,
--     max 4 KB). Each member may keep up to 50 views per page.
--   * Members create, rename, change and delete ONLY their own views.
--   * "Share with studio" (shared = true) may only be set by studio admins.
--     A shared view is readable by members of the SAME studio whose role may
--     VIEW that page's area in the access matrix (has_area). Other studios never
--     see it. Clients and signed-out callers get nothing.
--   * One default view per member per page (is_default). saved_view_set_default()
--     moves the default in one call (own rows only, runs as the caller under RLS).
--   * Suspended studios are read-only here too (zzz_studio_read_only, like every
--     other studio table).
--
-- Additive + idempotent: 1 new table, 3 new functions, 1 trigger set. NO existing
-- row is changed.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0064: has_area(text,text) is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0064: current_org_id() is not installed'; end if;
  if to_regprocedure('public.is_admin()') is null then raise exception '0064: is_admin() is not installed'; end if;
end $$;

create table if not exists public.saved_views (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  page        text not null,
  name        text not null,
  state       jsonb not null default '{}'::jsonb,
  shared      boolean not null default false,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'saved_views_page_chk' and conrelid = 'public.saved_views'::regclass) then
    alter table public.saved_views add constraint saved_views_page_chk check (page in ('leads', 'quotes', 'staff', 'vendors', 'inventory'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'saved_views_name_chk' and conrelid = 'public.saved_views'::regclass) then
    alter table public.saved_views add constraint saved_views_name_chk check (char_length(btrim(name)) between 1 and 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'saved_views_state_chk' and conrelid = 'public.saved_views'::regclass) then
    alter table public.saved_views add constraint saved_views_state_chk check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 4096);
  end if;
end $$;
create index if not exists saved_views_org_page_idx on public.saved_views(org_id, page);
create index if not exists saved_views_user_page_idx on public.saved_views(user_id, page);
create unique index if not exists saved_views_one_default on public.saved_views(user_id, page) where is_default;

alter table public.saved_views enable row level security;
revoke all on public.saved_views from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on public.saved_views from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.saved_views from authenticated';
    execute 'grant select, insert, update, delete on public.saved_views to authenticated';
  end if;
end $$;

-- page -> access-matrix area
create or replace function public.saved_view_area(p_page text)
returns text language sql immutable set search_path = '' as $$
  select case p_page when 'leads' then 'leads' when 'quotes' then 'quotes' when 'staff' then 'staff'
                     when 'vendors' then 'vendors' when 'inventory' then 'inventory' end $$;
revoke all on function public.saved_view_area(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.saved_view_area(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.saved_view_area(text) to authenticated'; end if;
end $$;

-- write guard: stamps owner + studio, pins them, caps count, admin-only share
create or replace function public.tg_saved_views_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid; v_n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('authenticated', 'anon') then
    new.updated_at := now(); return new; end if;                                   -- service role / maintenance
  v_org := public.current_org_id();
  if v_me is null or v_org is null or not exists (
       select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and p.role is not null and p.role <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if tg_op = 'INSERT' then
    new.user_id := v_me; new.org_id := v_org; new.created_at := now();
    select count(*) into v_n from public.saved_views s where s.user_id = v_me and s.page = new.page;
    if v_n >= 50 then raise exception 'too many saved views for this page' using errcode = '54000'; end if;
  else
    if new.user_id is distinct from old.user_id or new.org_id is distinct from old.org_id or new.id is distinct from old.id then
      raise exception 'owner and studio cannot change' using errcode = '42501'; end if;
    new.created_at := old.created_at;
  end if;
  if new.shared and (tg_op = 'INSERT' or not old.shared) and not public.is_admin() then
    raise exception 'only studio admins can share a view' using errcode = '42501'; end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  return new;
end $$;
revoke all on function public.tg_saved_views_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.tg_saved_views_guard() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.tg_saved_views_guard() from authenticated'; end if;
end $$;
drop trigger if exists saved_views_guard on public.saved_views;
create trigger saved_views_guard before insert or update on public.saved_views
  for each row execute function public.tg_saved_views_guard();

do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    drop trigger if exists zzz_studio_read_only on public.saved_views;
    create trigger zzz_studio_read_only before insert or update or delete on public.saved_views
      for each row execute function public.tg_studio_read_only('org_id');
  end if;
end $$;

drop policy if exists "a64 saved views read" on public.saved_views;
create policy "a64 saved views read" on public.saved_views for select to authenticated
  using (org_id = (select public.current_org_id())
         and (user_id = (select auth.uid()) or (shared and public.has_area(public.saved_view_area(page), 'view'))));
drop policy if exists "a64 saved views insert" on public.saved_views;
create policy "a64 saved views insert" on public.saved_views for insert to authenticated
  with check (org_id = (select public.current_org_id()) and user_id = (select auth.uid()));
drop policy if exists "a64 saved views update" on public.saved_views;
create policy "a64 saved views update" on public.saved_views for update to authenticated
  using (org_id = (select public.current_org_id()) and user_id = (select auth.uid()))
  with check (org_id = (select public.current_org_id()) and user_id = (select auth.uid()));
drop policy if exists "a64 saved views delete" on public.saved_views;
create policy "a64 saved views delete" on public.saved_views for delete to authenticated
  using (org_id = (select public.current_org_id()) and user_id = (select auth.uid()));

-- move / clear the caller's default view for one page (runs as the caller, under RLS)
create or replace function public.saved_view_set_default(p_id uuid, p_on boolean default true)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_page text;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select s.page into v_page from public.saved_views s where s.id = p_id and s.user_id = auth.uid();
  if v_page is null then raise exception 'view not found' using errcode = 'P0002'; end if;
  update public.saved_views s set is_default = false
   where s.user_id = auth.uid() and s.page = v_page and s.is_default and s.id <> p_id;
  update public.saved_views s set is_default = coalesce(p_on, true) where s.id = p_id and s.user_id = auth.uid();
end $$;
revoke all on function public.saved_view_set_default(uuid, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.saved_view_set_default(uuid, boolean) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.saved_view_set_default(uuid, boolean) to authenticated'; end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('saved_views table exists', to_regclass('public.saved_views') is not null),
  ('saved_views has RLS on', (select relrowsecurity from pg_class where oid = 'public.saved_views'::regclass)),
  ('saved_views 4 policies', (select count(*) = 4 from pg_policies where schemaname = 'public' and tablename = 'saved_views')),
  ('saved_views not for anon', not has_table_privilege('anon', 'public.saved_views', 'select')),
  ('saved_views for members', has_table_privilege('authenticated', 'public.saved_views', 'insert')),
  ('suspended-studio guard attached', exists (select 1 from pg_trigger where tgrelid = 'public.saved_views'::regclass and tgname = 'zzz_studio_read_only')),
  ('owner guard attached', exists (select 1 from pg_trigger where tgrelid = 'public.saved_views'::regclass and tgname = 'saved_views_guard')),
  ('one default per page index', to_regclass('public.saved_views_one_default') is not null),
  ('set_default RPC for members', has_function_privilege('authenticated', 'public.saved_view_set_default(uuid,boolean)', 'execute')),
  ('set_default RPC not for anon', not has_function_privilege('anon', 'public.saved_view_set_default(uuid,boolean)', 'execute')),
  ('guard trigger fn not callable', not has_function_privilege('authenticated', 'public.tg_saved_views_guard()', 'execute'))
) v(item, ok);
