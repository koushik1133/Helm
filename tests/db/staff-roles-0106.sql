-- staff-roles-0106.sql -- 0106: staff departments list + staff_set_login_role.
-- Fixture: a_admin/a_staff (sales) studio A, b_admin/b_staff studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _t106(name text, result text); grant all on _t106 to anon, authenticated, service_role;
create temp table _t106kv(k text primary key, v text); grant all on _t106kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t106 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _t106kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _t106kv where k = p_k $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; e text; v text[]; j jsonb; cid uuid; cid2 uuid; sid uuid; n int; begin
  perform pg_temp.su();
  select id into sid from auth.users where email = 'a_staff@a.test';
  insert into public.crew_members(name, phone, org_id, department, role, active) values ('Free Text', '+919876500001', a, 'Catering', 'Lead planner', true) returning id into cid2;
  insert into public.crew_members(name, phone, org_id, profile_id, department, role, active) values ('Sam Staff', '+919876500002', a, sid, 'Sales', 'Sales', true) returning id into cid;
  perform pg_temp.put('cid', cid::text);
  delete from public.role_access where area = 'staff' and role = 'sales';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'staff', true, false, a, now());

  perform pg_temp.login('a_admin@a.test');
  v := public.staff_departments();
  perform pg_temp.res('01 list includes departments already on staff rows', 'Catering' = any(v) and 'Sales' = any(v), v::text);
  v := public.staff_department_add('  Production  ');
  perform pg_temp.res('02 admin adds a department (trimmed)', 'Production' = any(v), v::text);
  v := public.staff_department_add('production');
  select count(*) into n from unnest(v) x where lower(x) = 'production';
  perform pg_temp.res('03 case-insensitive no duplicate', n = 1, v::text);
  e := pg_temp.try($q$select public.staff_department_add('')$q$);
  perform pg_temp.res('04 empty name refused', e like '22023%', e);
  e := pg_temp.try($q$select public.staff_department_add('<script>')$q$);
  perform pg_temp.res('05 angle brackets refused', e like '22023%', e);
  e := pg_temp.try(format('select public.staff_department_add(%L)', repeat('x', 61)));
  perform pg_temp.res('06 too long refused', e like '22023%', e);

  j := public.staff_set_login_role(cid, 'planner');
  perform pg_temp.res('07 admin changes linked staff login role', (select role from public.profiles where id = sid) = 'planner', j::text);
  perform pg_temp.res('08 staff title mirrors the role label', (select role from public.crew_members where id = cid) = 'Planner', '');
  e := pg_temp.try(format('select public.staff_set_login_role(%L, %L)', cid2, 'planner'));
  perform pg_temp.res('09 unlinked staff refused (invite first)', e like '22023%', e);
  e := pg_temp.try(format('select public.staff_set_login_role(%L, %L)', cid, 'client'));
  perform pg_temp.res('10 client role refused', e like '22023%', e);
  e := pg_temp.try(format('select public.staff_set_login_role(%L, %L)', cid, 'bogus'));
  perform pg_temp.res('11 invalid role refused', e <> '' and (select role from public.profiles where id = sid) = 'planner', e);
  perform pg_temp.res('12 free-text role untouched', (select role from public.crew_members where id = cid2) = 'Lead planner', '');

  perform pg_temp.su(); update public.profiles set role = 'sales' where id = sid;   -- back to the view-only fixture role
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.staff_departments()$q$);
  perform pg_temp.res('13 staff VIEW can read the list', e = '', e);
  e := pg_temp.try($q$select public.staff_department_add('Finance')$q$);
  perform pg_temp.res('14 staff view-only cannot add', e like '42501%', e);
  e := pg_temp.try(format('select public.staff_set_login_role(%L, %L)', pg_temp.get('cid'), 'admin'));
  perform pg_temp.res('15 non-admin cannot change login roles', e like '42501%', e);

  perform pg_temp.login('b_admin@b.test');
  v := public.staff_departments();
  perform pg_temp.res('16 other studio sees none of A departments', not ('Production' = any(v)) and not ('Catering' = any(v)), v::text);
  e := pg_temp.try(format('select public.staff_set_login_role(%L, %L)', pg_temp.get('cid'), 'crew'));
  perform pg_temp.su();
  perform pg_temp.res('17 other studio admin cannot change A staff role', e like '22023%' and (select role from public.profiles where id = sid) = 'sales', e);

  perform pg_temp.anon();
  e := pg_temp.try($q$select public.staff_departments()$q$);
  perform pg_temp.res('18 anon cannot read', e like '42501%', e);
  e := pg_temp.try($q$select public.staff_department_add('X')$q$);
  perform pg_temp.res('19 anon cannot add', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('20 org B list untouched', (select staff_departments from public.organizations where id = 'b0000000-0000-4000-8000-000000000001') = '{}', '');
exception when others then perform pg_temp.su(); insert into _t106 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _t106 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'STAFF-ROLES-0106: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'STAFF-ROLES-0106: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _t106;
rollback;
