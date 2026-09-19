-- =========================================================================
-- Phase 31 — Cluster A: quality-engineer role, planner-only layouts, tighter sales
--
-- WHAT
--   • Adds the 'quality' (Quality engineer) role → 11 roles total.
--   • Gives floor layouts their own access area ('layouts') and makes EDITING
--     planner-only (everyone else who sees the workspace can view). Enforced in DB.
--   • Seeds default access for the new role, the layouts area, and tightens the
--     default SALES preset to Leads + CRM only (admins can widen any of it later
--     in Control Center → User control).
--
-- RUN AFTER phase29-role-access.sql. Idempotent (re-running is safe and corrects
-- the seeded rows). Display names (Event manager / Event coordinator / Quality
-- engineer / Supervisor) are labels in the app; the DB keeps stable role keys.
-- =========================================================================

-- 1) widen roles to include 'quality' -------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client'));

create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable set search_path = public as $$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client');
$$;

-- 2) layouts get their own area (planner-only edit) -----------------------
--    (supersedes phase29, which grouped layouts under 'quotes')
do $$ declare p record; begin
  if to_regclass('public.layouts') is not null then
    for p in select policyname from pg_policies where schemaname='public' and tablename='layouts'
    loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
    alter table public.layouts enable row level security;
    create policy "ra view" on public.layouts for select to authenticated using ( public.has_area('layouts','view') );
    create policy "ra ins"  on public.layouts for insert to authenticated with check ( public.has_area('layouts','edit') );
    create policy "ra upd"  on public.layouts for update to authenticated using ( public.has_area('layouts','edit') ) with check ( public.has_area('layouts','edit') );
    create policy "ra del"  on public.layouts for delete to authenticated using ( public.has_area('layouts','edit') );
  end if;
end $$;

-- 3) seed / correct default access rows -----------------------------------
--    overrides is [{role, area, view, edit}] applied as an upsert (corrects rows).
do $$
declare
  overrides jsonb := '[
    {"role":"planner","area":"layouts","view":true,"edit":true},
    {"role":"manager","area":"layouts","view":true,"edit":false},
    {"role":"sales","area":"layouts","view":false,"edit":false},
    {"role":"coordinator","area":"layouts","view":true,"edit":false},
    {"role":"supervisor","area":"layouts","view":true,"edit":false},
    {"role":"operations","area":"layouts","view":true,"edit":false},
    {"role":"quality","area":"layouts","view":true,"edit":false},
    {"role":"crew","area":"layouts","view":false,"edit":false},
    {"role":"worker","area":"layouts","view":false,"edit":false},
    {"role":"client","area":"layouts","view":false,"edit":false},

    {"role":"quality","area":"quotes","view":true,"edit":false},
    {"role":"quality","area":"staff","view":true,"edit":false},
    {"role":"quality","area":"inventory","view":true,"edit":false},
    {"role":"quality","area":"vendors","view":true,"edit":false},
    {"role":"quality","area":"calendar","view":true,"edit":false},
    {"role":"quality","area":"templates","view":true,"edit":false},
    {"role":"quality","area":"resources","view":true,"edit":false},
    {"role":"quality","area":"runsheet","view":true,"edit":false},
    {"role":"quality","area":"plan","view":true,"edit":false},
    {"role":"quality","area":"logistics","view":true,"edit":false},
    {"role":"quality","area":"ready","view":true,"edit":false},
    {"role":"quality","area":"command","view":true,"edit":true},
    {"role":"quality","area":"issues","view":true,"edit":true},
    {"role":"quality","area":"media","view":true,"edit":false},
    {"role":"quality","area":"leads","view":false,"edit":false},
    {"role":"quality","area":"crm","view":false,"edit":false},
    {"role":"quality","area":"nurture","view":false,"edit":false},
    {"role":"quality","area":"discovery","view":false,"edit":false},
    {"role":"quality","area":"proposal","view":false,"edit":false},
    {"role":"quality","area":"finance","view":false,"edit":false},
    {"role":"quality","area":"settlement","view":false,"edit":false},
    {"role":"quality","area":"closure","view":false,"edit":false},
    {"role":"quality","area":"controls","view":false,"edit":false},
    {"role":"quality","area":"codes","view":false,"edit":false},
    {"role":"quality","area":"users","view":false,"edit":false},

    {"role":"sales","area":"leads","view":true,"edit":true},
    {"role":"sales","area":"crm","view":true,"edit":true},
    {"role":"sales","area":"nurture","view":false,"edit":false},
    {"role":"sales","area":"discovery","view":false,"edit":false},
    {"role":"sales","area":"proposal","view":false,"edit":false},
    {"role":"sales","area":"quotes","view":false,"edit":false},
    {"role":"sales","area":"layouts","view":false,"edit":false},
    {"role":"sales","area":"finance","view":false,"edit":false},
    {"role":"sales","area":"settlement","view":false,"edit":false},
    {"role":"sales","area":"closure","view":false,"edit":false},
    {"role":"sales","area":"staff","view":false,"edit":false},
    {"role":"sales","area":"inventory","view":false,"edit":false},
    {"role":"sales","area":"vendors","view":false,"edit":false},
    {"role":"sales","area":"calendar","view":false,"edit":false},
    {"role":"sales","area":"templates","view":false,"edit":false},
    {"role":"sales","area":"media","view":false,"edit":false},
    {"role":"sales","area":"codes","view":false,"edit":false}
  ]'::jsonb;
  o jsonb;
begin
  for o in select value from jsonb_array_elements(overrides) loop
    insert into public.role_access(role, area, can_view, can_edit, updated_at)
      values (o->>'role', o->>'area', (o->>'view')::boolean, ((o->>'edit')::boolean and (o->>'view')::boolean), now())
    on conflict (role, area) do update
      set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now();
  end loop;

  -- make sure the layouts area exists for admin too (display)
  insert into public.role_access(role, area, can_view, can_edit)
    values ('admin','layouts',true,true) on conflict (role, area) do nothing;
end $$;

-- 4) reload
notify pgrst, 'reload schema';
