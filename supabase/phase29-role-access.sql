-- =========================================================================
-- Phase 29 — Configurable per-role access matrix + 4 new roles
--
-- WHAT this adds
--   1. Four new roles: coordinator, supervisor, worker, manager (total 10).
--   2. role_access(role, area, can_view, can_edit) — an admin-editable matrix
--      that decides, per role, which feature AREAS are visible/editable.
--   3. has_area(area, need) — the single helper every RLS policy now uses, so
--      access follows the matrix. Admin is always allowed (safety floor).
--   4. Every feature table's RLS is rebuilt off has_area (supersedes phase21).
--   5. admin_get_role_access / admin_set_role_access RPCs for the Control Center.
--
-- SAFE + IDEMPOTENT: re-running drops & recreates policies and re-seeds any
-- missing default rows (it never overwrites choices an admin already changed).
-- Token / worker / approval flows are untouched — they use SECURITY DEFINER RPCs
-- that bypass RLS. Run this AFTER phase21..phase28.
-- =========================================================================

-- 1) Widen the allowed roles (CHECK constraint + validator) ----------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','planner','sales','coordinator','supervisor','operations','crew','worker','client'));

create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable set search_path = public as $$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','operations','crew','worker','client');
$$;

-- 2) The access-matrix table ----------------------------------------------
create table if not exists public.role_access (
  role      text not null,
  area      text not null,
  can_view  boolean not null default false,
  can_edit  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (role, area)
);
alter table public.role_access enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='role_access'
  loop execute format('drop policy if exists %I on public.role_access', p.policyname); end loop;
end $$;
-- everyone signed in may read the rows for their OWN role (so the app can gate the UI);
-- admins may read/write everything.
create policy "ra read own"  on public.role_access for select to authenticated
  using ( role = public.user_role() or public.is_admin() );
create policy "ra admin ins" on public.role_access for insert to authenticated with check ( public.is_admin() );
create policy "ra admin upd" on public.role_access for update to authenticated using ( public.is_admin() ) with check ( public.is_admin() );
create policy "ra admin del" on public.role_access for delete to authenticated using ( public.is_admin() );

-- 3) Seed sensible defaults (only inserts rows that don't exist yet) -------
--   v = can_view, e = can_edit. Admin is implicit-all (handled in has_area).
do $$
declare
  -- area, and the roles that get view / edit by default
  seed jsonb := '[
    {"area":"leads","view":["manager","planner","sales","coordinator"],"edit":["manager","planner","sales"]},
    {"area":"crm","view":["manager","planner","sales","coordinator"],"edit":["manager","planner","sales"]},
    {"area":"nurture","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"discovery","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"proposal","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"quotes","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","sales"]},
    {"area":"staff","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"inventory","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"vendors","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"calendar","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"templates","view":["manager","planner","coordinator","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"resources","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"runsheet","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"plan","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"logistics","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"ready","view":["manager","planner","coordinator","supervisor"],"edit":["manager","planner","coordinator"]},
    {"area":"finance","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"settlement","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"closure","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"command","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor"]},
    {"area":"issues","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor","operations"]},
    {"area":"media","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor"]},
    {"area":"controls","view":["manager"],"edit":["manager"]},
    {"area":"codes","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"users","view":[],"edit":[]}
  ]'::jsonb;
  allroles text[] := array['manager','planner','sales','coordinator','supervisor','operations','crew','worker','client'];
  rec jsonb; a text; r text; v boolean; e boolean;
begin
  for rec in select value from jsonb_array_elements(seed) loop
    a := rec->>'area';
    foreach r in array allroles loop
      v := (rec->'view')  ? r;
      e := (rec->'edit')  ? r;
      insert into public.role_access(role, area, can_view, can_edit)
        values (r, a, v, (e and v))          -- edit implies view
      on conflict (role, area) do nothing;    -- never clobber an admin's later change
    end loop;
    -- admin row too (kept in sync for display; has_area allows admin regardless)
    insert into public.role_access(role, area, can_view, can_edit)
      values ('admin', a, true, true) on conflict (role, area) do nothing;
  end loop;
end $$;

-- 4) has_area(): the one gate every policy uses --------------------------
create or replace function public.has_area(p_area text, p_need text default 'view')
  returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.user_role() = 'admin' then true                    -- admin: full floor
    else coalesce((
      select case when p_need = 'edit' then ra.can_edit else ra.can_view end
      from public.role_access ra
      where ra.role = public.user_role() and ra.area = p_area
    ), false)                                                       -- unknown/absent = deny
  end;
$$;
revoke all on function public.has_area(text,text) from anon;
grant execute on function public.has_area(text,text) to authenticated;

-- keep the legacy helpers working (older policies/copies may reference them)
create or replace function public.can_view_finance() returns boolean
  language sql stable set search_path = public as $$ select public.has_area('finance','view'); $$;
create or replace function public.can_view_ops() returns boolean
  language sql stable set search_path = public as $$ select public.has_area('quotes','view'); $$;

-- 5) Rebuild RLS on every feature table, driven by has_area(area) ----------
--    (supersedes the coarse phase21 groupings). Missing tables are skipped.
do $$
declare
  -- area -> tables that belong to it
  amap jsonb := '{
    "leads":["leads"],
    "crm":["lead_archive"],
    "nurture":["nurture"],
    "discovery":["event_discovery","event_requirements"],
    "proposal":["event_proposal","proposal_risks"],
    "quotes":["quotes","quote_versions","layouts","quote_consents","quote_payments","notifications"],
    "staff":["crew_members","event_tasks","work_tokens"],
    "inventory":["inventory_items","inventory_reservations"],
    "vendors":["vendors","event_resources","event_resource_needs"],
    "templates":["task_templates","checklist_templates"],
    "runsheet":["run_sheet_items"],
    "plan":["event_plan","event_checklist"],
    "finance":["event_costs","change_requests","payment_milestones","expense_claims"],
    "settlement":["event_refunds"],
    "closure":["event_closure","event_ratings"],
    "command":["event_day","event_guests","event_stock_requests"],
    "issues":["event_issues"],
    "media":["event_media"]
  }'::jsonb;
  area text; tbls jsonb; t text; p record;
begin
  for area in select jsonb_object_keys(amap) loop
    tbls := amap->area;
    for t in select jsonb_array_elements_text(tbls) loop
      if to_regclass('public.'||t) is null then continue; end if;
      for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      execute format('alter table public.%I enable row level security', t);
      execute format($f$create policy "ra view" on public.%I for select to authenticated using ( public.has_area(%L,'view') )$f$, t, area);
      execute format($f$create policy "ra ins"  on public.%I for insert to authenticated with check ( public.has_area(%L,'edit') )$f$, t, area);
      execute format($f$create policy "ra upd"  on public.%I for update to authenticated using ( public.has_area(%L,'edit') ) with check ( public.has_area(%L,'edit') )$f$, t, area, area);
      execute format($f$create policy "ra del"  on public.%I for delete to authenticated using ( public.has_area(%L,'edit') )$f$, t, area);
    end loop;
  end loop;
end $$;

-- 6) admin RPCs for the Control Center matrix editor ----------------------
create or replace function public.admin_get_role_access()
  returns setof public.role_access language sql stable security definer set search_path = public as $$
  select * from public.role_access order by role, area;
$$;

create or replace function public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
  returns public.role_access language plpgsql security definer set search_path = public as $$
declare row public.role_access;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'unknown role %', p_role; end if;
  insert into public.role_access(role, area, can_view, can_edit, updated_at)
    values (p_role, p_area, coalesce(p_view,false), coalesce(p_edit,false) and coalesce(p_view,false), now())
  on conflict (role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
  returning * into row;
  return row;
end; $$;

revoke all on function public.admin_get_role_access()                    from public, anon;
revoke all on function public.admin_set_role_access(text,text,boolean,boolean) from public, anon;
grant execute on function public.admin_get_role_access()                    to authenticated;
grant execute on function public.admin_set_role_access(text,text,boolean,boolean) to authenticated;

-- 7) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';
