-- 0143_roles_crew_defaults.sql - CANONICAL forward-only. REQUIRES 0008, 0049 (create_studio wrapper),
-- 0072 (_valid_role), 0106 (_a106_role_label), phase29 (role_access).
--
-- In plain words:
--   1) The "Worker" role is merged into "Crew" (owner decision). Every profile, invitation and staff
--      record whose role is EXACTLY 'worker' becomes 'crew'. Counts are printed as NOTICEs.
--      'worker' stays a VALID value in _valid_role() and the CHECK constraints, so nothing old breaks -
--      it is simply no longer offered anywhere in the app.
--      Any worker access row is copied to crew ONLY where crew has no row for that area (never overwrites).
--   2) Default access: Designer and Crew get a sensible starting set, but ONLY in a studio where that
--      role has nothing switched on yet (no row with view or edit). A role an admin has already set up
--      (any area on) is never touched. Rows are only ever switched ON, never off. The matrix stays fully
--      editable in Control Center and the "Apply suggested access" button stays.
--        Designer: design, layouts, proposal, media (view + edit); quotes, calendar, templates (view)
--        Crew:     runsheet, calendar (view)   ("briefing" is not a real area - skipped)
--      New studios get the same defaults (create_studio wrapper).
-- Nothing is deleted. Idempotent: re-running changes nothing.

-- ---- 1a) worker -> crew (exact value only) -------------------------------------------------
do $$ declare n int; begin
  update public.profiles set role = 'crew' where role = 'worker';
  get diagnostics n = row_count; raise notice '0143: profiles worker -> crew: %', n;
  if to_regclass('public.invitations') is not null then
    update public.invitations set role = 'crew' where role = 'worker';
    get diagnostics n = row_count; raise notice '0143: invitations worker -> crew: %', n;
  end if;
  if to_regclass('public.crew_members') is not null
     and exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'crew_members' and column_name = 'role') then
    update public.crew_members set role = 'crew' where role = 'worker';
    get diagnostics n = row_count; raise notice '0143: crew_members.role worker -> crew: %', n;
  end if;
end $$;

-- ---- 1b) copy worker access into crew where crew has no row for that area -------------------
do $$ declare n int; begin
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select w.org_id, 'crew', w.area, w.can_view, w.can_edit, now()
      from public.role_access w
     where w.role = 'worker'
       and not exists (select 1 from public.role_access c
                        where c.org_id = w.org_id and c.role = 'crew' and c.area = w.area)
  on conflict (org_id, role, area) do nothing;
  get diagnostics n = row_count; raise notice '0143: worker access rows copied to crew: %', n;
end $$;

-- staff record label for a legacy 'worker' login now reads "Crew"
create or replace function public._a106_role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  select case p_role
    when 'admin' then 'Admin' when 'manager' then 'Event manager' when 'planner' then 'Planner'
    when 'sales' then 'Sales' when 'coordinator' then 'Event coordinator' when 'supervisor' then 'Supervisor'
    when 'quality' then 'Quality engineer' when 'operations' then 'Operations' when 'designer' then 'Designer'
    when 'crew' then 'Crew' when 'worker' then 'Crew' when 'client' then 'Client'
    else initcap(replace(coalesce(p_role, ''), '_', ' ')) end;
$$;

-- ---- 2) default access for unconfigured designer / crew ------------------------------------
create or replace function public._a143_role_defaults()
returns table(role text, area text, can_view boolean, can_edit boolean)
language sql immutable set search_path = '' as $$
  values ('designer','design',true,true), ('designer','layouts',true,true), ('designer','proposal',true,true),
         ('designer','media',true,true), ('designer','quotes',true,false), ('designer','calendar',true,false),
         ('designer','templates',true,false),
         ('crew','runsheet',true,false), ('crew','calendar',true,false);
$$;
revoke all on function public._a143_role_defaults() from public, anon, authenticated;

-- p_org null = every studio. Only roles with NOTHING switched on in that studio are seeded.
create or replace function public._a143_seed_role_defaults(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  with targets as (
    select o.id as org_id, r.role
      from public.organizations o
     cross join (select distinct d.role from public._a143_role_defaults() d) r
     where (p_org is null or o.id = p_org)
       and not exists (select 1 from public.role_access ra
                        where ra.org_id = o.id and ra.role = r.role and (ra.can_view or ra.can_edit))
  )
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    select t.org_id, d.role, d.area, d.can_view, d.can_edit, now()
      from targets t join public._a143_role_defaults() d on d.role = t.role
  on conflict (org_id, role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
    where public.role_access.can_view = false and public.role_access.can_edit = false;  -- only switch ON
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._a143_seed_role_defaults(uuid) from public, anon, authenticated;
grant execute on function public._a143_seed_role_defaults(uuid) to service_role;

do $$ declare n int; begin
  n := public._a143_seed_role_defaults(null);
  raise notice '0143: default access rows switched on: %', n;
end $$;

-- ---- 2b) new studios get the same defaults (wrap the current create_studio once) -----------
do $$ begin
  if to_regprocedure('public.create_studio__pre0143(text,text,text,text)') is null then
    alter function public.create_studio(text, text, text, text) rename to create_studio__pre0143;
  end if;
end $$;
revoke all on function public.create_studio__pre0143(text, text, text, text) from public, anon, authenticated;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- a143: a NEW studio also gets the designer / crew starting access
declare v_had uuid; v_org uuid;
begin
  select p.org_id into v_had from public.profiles p where p.id = auth.uid();
  v_org := public.create_studio__pre0143(p_name, p_email, p_currency, p_timezone);
  if v_had is null and v_org is not null then
    perform public._a143_seed_role_defaults(v_org);
  end if;
  return v_org;
end $$;
revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated, service_role;
