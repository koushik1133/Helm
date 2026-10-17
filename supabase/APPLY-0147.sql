-- APPLY-0147.sql - paste into the Supabase SQL editor (staging first). See migrations/0147_manager_quote_create.sql.
-- Additive + idempotent. No delete / drop / truncate. Never overwrites an existing access row.
begin;
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

commit;

-- verify (read-only)
select 'can_create present' as item, to_regprocedure('public.can_create()') is not null as ok
union all select 'can_create reads quote_create', pg_get_functiondef('public.can_create()'::regprocedure) ilike '%quote_create%'
union all select 'can_create default ON when no row', pg_get_functiondef('public.can_create()'::regprocedure) ilike '%), true)%'
union all select 'can_edit ignores quote_create', pg_get_functiondef('public.can_edit()'::regprocedure) ilike '%<> ''quote_create''%'
union all select 'every studio has manager quote_create row',
  not exists (select 1 from public.organizations o where not exists (select 1 from public.role_access ra
    where ra.org_id = o.id and ra.role = 'manager' and ra.area = 'quote_create'))
union all select 'every studio has planner quote_create row',
  not exists (select 1 from public.organizations o where not exists (select 1 from public.role_access ra
    where ra.org_id = o.id and ra.role = 'planner' and ra.area = 'quote_create'))
union all select 'every studio has sales quote_create row',
  not exists (select 1 from public.organizations o where not exists (select 1 from public.role_access ra
    where ra.org_id = o.id and ra.role = 'sales' and ra.area = 'quote_create'));
