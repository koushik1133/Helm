-- 0106_staff_roles_departments.sql - CANONICAL forward-only. Staff roles + studio department list.
--
-- In plain words:
--   The Staff page "Role" and "Department" are now drop-downs. Roles come from the studio's
--   access-matrix roles (Admin, Event manager, Planner ...). Departments come from a studio
--   department list that anyone who may edit Staff can add to ("Add new department").
--   An admin can also change the LOGIN role of a staff member who has a Helm account, right
--   from the Staff page (same rules as Control Center -> Users: admin only, never your own
--   admin role, the last admin is protected by the 0074 trigger).
--
--   Changes (all additive, idempotent; nothing existing is deleted or rewritten):
--     * organizations.staff_departments text[] (default empty, max 100 names).
--     * staff_departments()             - the studio list + departments already used on staff
--                                         rows (Staff VIEW). Read-only.
--     * staff_department_add(name)      - add one name (Staff EDIT); case-insensitive no-dup;
--                                         1-60 characters. Returns the new list.
--     * staff_set_login_role(staff, role) - admin only; the staff row must be linked to an
--                                         account in the caller's studio; calls admin_set_role
--                                         and mirrors the role label onto the staff title when
--                                         the member has no job title of their own.
--   Existing free-text roles / departments are never changed by this migration.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then
    raise exception '0106: has_area(text,text) is not installed'; end if;
  if to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0106: _studio_writable(uuid) is not installed (apply 0045 first)'; end if;
  if to_regprocedure('public.admin_set_role(uuid,text)') is null then
    raise exception '0106: admin_set_role(uuid,text) is not installed'; end if;
  if to_regclass('public.crew_members') is null or to_regclass('public.member_profiles') is null then
    raise exception '0106: crew_members / member_profiles missing (apply 0041 first)'; end if;
end $$;

alter table public.organizations add column if not exists staff_departments text[] not null default '{}'::text[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'org_staff_departments_ck') then
    alter table public.organizations add constraint org_staff_departments_ck
      check (coalesce(array_length(staff_departments, 1), 0) <= 100) not valid;
  end if;
end $$;

create or replace function public.staff_departments()
returns text[] language plpgsql stable security definer set search_path = '' as $$
-- staff-roles-0106
declare v_org uuid := public.current_org_id(); v text[];
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('staff', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select coalesce(array_agg(d order by lower(d)), '{}'::text[]) into v from (
    select distinct on (lower(btrim(x))) btrim(x) as d from (
      select unnest(o.staff_departments) as x from public.organizations o where o.id = v_org
      union all
      select c.department from public.crew_members c where c.org_id = v_org and c.department is not null
    ) s where btrim(coalesce(x, '')) <> ''
    order by lower(btrim(x)), btrim(x)
  ) t;
  return v;
end $$;

create or replace function public.staff_department_add(p_name text)
returns text[] language plpgsql volatile security definer set search_path = '' as $$
-- staff-roles-0106
declare v_org uuid := public.current_org_id(); v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if auth.uid() is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if length(v_name) < 1 or length(v_name) > 60 or v_name ~ '[[:cntrl:]<>]' then
    raise exception 'Department names are 1-60 characters (no < or >).' using errcode = '22023'; end if;
  update public.organizations o
     set staff_departments = o.staff_departments || v_name
   where o.id = v_org
     and not exists (select 1 from unnest(o.staff_departments) e where lower(e) = lower(v_name));
  if (select coalesce(array_length(o.staff_departments, 1), 0) from public.organizations o where o.id = v_org) > 100 then
    raise exception 'A studio can have up to 100 departments.' using errcode = '22023'; end if;
  return public.staff_departments();
end $$;

create or replace function public._a106_role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  select case p_role
    when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'coordinator' then 'Event coordinator' when 'supervisor' then 'Supervisor'
    when 'quality' then 'Quality engineer' when 'operations' then 'Operations' when 'designer' then 'Designer'
    when 'crew' then 'Crew' when 'worker' then 'Worker' when 'client' then 'Client'
    else initcap(replace(coalesce(p_role, ''), '_', ' ')) end;
$$;

create or replace function public.staff_set_login_role(p_staff uuid, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- staff-roles-0106
declare v_org uuid := public.current_org_id(); v_prof uuid; v_title text;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._studio_writable(v_org) then raise exception 'studio is read-only' using errcode = '42501'; end if;
  if coalesce(p_role, '') = 'client' then
    raise exception 'A staff member can''t have the Client role.' using errcode = '22023'; end if;
  select c.profile_id into v_prof from public.crew_members c where c.id = p_staff and c.org_id = v_org;
  if v_prof is null then
    raise exception 'This staff member has no Helm login yet - invite them first.' using errcode = '22023'; end if;
  perform public.admin_set_role(v_prof, p_role);           -- is_admin / valid role / own-admin / same studio
  select m.job_title into v_title from public.member_profiles m where m.user_id = v_prof;
  if nullif(btrim(coalesce(v_title, '')), '') is null then
    update public.crew_members c set role = public._a106_role_label(p_role)
     where c.id = p_staff and c.org_id = v_org and c.role is distinct from public._a106_role_label(p_role);
  end if;
  return jsonb_build_object('staff_id', p_staff, 'profile_id', v_prof, 'role', p_role);
end $$;

do $$ declare f text; begin
  foreach f in array array['public.staff_departments()', 'public.staff_department_add(text)',
                           'public.staff_set_login_role(uuid,text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  execute 'revoke all on function public._a106_role_label(text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a106_role_label(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public._a106_role_label(text) to authenticated'; end if;
end $$;
