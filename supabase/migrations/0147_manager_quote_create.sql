-- 0147_manager_quote_create.sql - CANONICAL forward-only. REQUIRES phase29 (role_access),
-- 54-multitenant-rls (user_role, current_org_id), 0143.
--
-- In plain words (owner decision 2026-10-17):
--   Event managers CAN create new quotes by default. The owner can switch it off (or back on)
--   per role in Control Center -> Access matrix -> "Create new quotes".
--   1) New access area 'quote_create'. edit = this role may create new quotes
--      (start a quote, builder save-as-new, convert a lead into a quote).
--   2) can_create() = admin always; manager / planner / sales follow their 'quote_create' row;
--      when a studio has NO row yet for that role the default is ON. Any other role: never.
--      So planner and sales keep exactly what they have today, and manager gains create.
--   3) can_edit() ignores the 'quote_create' switch (so it never grants general edit).
--   4) Every existing studio gets an ON row for manager / planner / sales ONLY where no row
--      exists yet (insert ... on conflict do nothing). A row an admin already set is never touched.
-- can_delete() is NOT changed. Nothing is deleted. Idempotent: re-running changes nothing.

create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select case
    when public.user_role() = 'admin' then true
    when public.user_role() in ('manager', 'planner', 'sales') then coalesce((
      select ra.can_edit from public.role_access ra
       where ra.org_id = public.current_org_id()
         and ra.role = public.user_role()
         and ra.area = 'quote_create'), true)
    else false
  end; $$;

-- can_edit() (0144: admin or any edit area) must NOT count the new 'quote_create' switch as an
-- edit area, otherwise a role whose only ON switch is "Create new quotes" would gain general edit.
create or replace function public.can_edit()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.is_admin() or exists (
    select 1 from public.role_access ra
     where ra.org_id = public.current_org_id() and ra.role = public.user_role() and ra.can_edit
       and ra.area <> 'quote_create'), false);
$$;

do $$ declare n int; begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select o.id, r.role, 'quote_create', true, true, now()
      from public.organizations o
     cross join (values ('manager'), ('planner'), ('sales')) as r(role)
  on conflict (org_id, role, area) do nothing;
  get diagnostics n = row_count; raise notice '0147: quote_create rows added (default ON): %', n;
end $$;
