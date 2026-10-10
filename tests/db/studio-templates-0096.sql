-- studio-templates-0096.sql -- 0096: studio layout templates. RLS cross-tenant, has_area gating, no delete, one default per type.
-- Fixture: a_admin/a_staff (sales) studio A, b_admin/b_staff studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _t96(name text, result text); grant all on _t96 to anon, authenticated, service_role;
create temp table _t96kv(k text primary key, v text); grant all on _t96kv to anon, authenticated, service_role;

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
begin insert into _t96 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _t96kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _t96kv where k = p_k $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  e text; j jsonb; tid uuid; t2 uuid; n int; begin
  perform pg_temp.su();
  delete from public.role_access where area in ('layouts', 'controls') and role = 'sales';

  perform pg_temp.login('a_admin@a.test');
  j := public.studio_template_save(null, '{"name":"My wedding","event_type":"wedding","description":"Round tables","data":{"items":[{"type":"table","x":1,"y":1}],"room":{"w":200,"h":140}},"thumbnail":"data:image/png;base64,iVBORw0KGgo="}');
  tid := (j ->> 'id')::uuid; perform pg_temp.put('tid', tid::text);
  perform pg_temp.res('01 admin saves a template in own studio', (j ->> 'org_id')::uuid = a and j ->> 'name' = 'My wedding' and j ->> 'thumbnail' like 'data:image/png%', j::text);
  e := pg_temp.try($q$select public.studio_template_save(null, '{"name":"","data":{"items":[]}}')$q$);
  perform pg_temp.res('02 empty name refused', e like '22023%', e);
  e := pg_temp.try($q$select public.studio_template_save(null, '{"name":"x"}')$q$);
  perform pg_temp.res('03 missing layout refused', e like '22023%', e);
  e := pg_temp.try($q$select public.studio_template_save(null, '{"name":"x","event_type":"Bad Type!","data":{"items":[]}}')$q$);
  perform pg_temp.res('04 bad event type refused', e like '22023%', e);
  j := public.studio_template_save(null, '{"name":"Bad pic","data":{"items":[]},"thumbnail":"javascript:alert(1)"}');
  perform pg_temp.res('05 bad thumbnail dropped (not stored)', j ->> 'thumbnail' is null, j::text);
  e := pg_temp.try(format('select public.studio_template_save(null, %L::jsonb)', jsonb_build_object('name','big','data',jsonb_build_object('items',(select jsonb_agg(jsonb_build_object('i',g)) from generate_series(1,5001) g)))));
  perform pg_temp.res('06 over 5000 objects refused', e like '22023%', e);
  e := pg_temp.try(format('delete from public.studio_layout_templates where id = %L', tid));
  perform pg_temp.res('07 authenticated cannot delete', e like '42501%', e);
  e := pg_temp.try(format('update public.studio_layout_templates set name = %L where id = %L', 'x', tid));
  perform pg_temp.res('08 authenticated cannot update directly', e like '42501%', e);

  -- defaults: one per event type
  j := public.studio_template_set_default(tid, true);
  perform pg_temp.res('09 set default', (j ->> 'is_default')::boolean, j::text);
  j := public.studio_template_duplicate(tid); t2 := (j ->> 'id')::uuid; perform pg_temp.put('t2', t2::text);
  perform pg_temp.res('10 duplicate makes a copy (not default)', j ->> 'name' = 'My wedding (copy)' and not (j ->> 'is_default')::boolean, j::text);
  j := public.studio_template_set_default(t2, true);
  select count(*) into n from public.studio_layout_templates where org_id = a and event_type = 'wedding' and is_default;
  perform pg_temp.res('11 only one default per event type', n = 1 and (j ->> 'is_default')::boolean, n::text);
  j := public.studio_template_set_archived(t2, true);
  perform pg_temp.res('12 archive keeps row + clears default', (j ->> 'archived')::boolean and not (j ->> 'is_default')::boolean, j::text);
  e := pg_temp.try(format('select public.studio_template_set_default(%L, true)', t2));
  perform pg_temp.res('13 archived cannot be default', e like '22023%', e);
  j := public.studio_template_save(tid, '{"name":"Renamed","event_type":"wedding"}');
  perform pg_temp.res('14 rename keeps layout data', j ->> 'name' = 'Renamed' and jsonb_array_length(j -> 'data' -> 'items') = 1, j::text);

  -- staff A (sales) without area
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.studio_layout_templates;
  perform pg_temp.res('15 staff without layouts/controls area sees nothing', n = 0, n::text);
  e := pg_temp.try($q$select public.studio_template_save(null, '{"name":"S","data":{"items":[]}}')$q$);
  perform pg_temp.res('16 staff without edit cannot save', e like '42501%', e);
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'layouts', true, false, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.studio_layout_templates;
  perform pg_temp.res('17 layouts view reads own studio templates', n = 3, n::text);
  e := pg_temp.try(format('select public.studio_template_set_archived(%L, true)', pg_temp.get('tid')));
  perform pg_temp.res('18 view-only cannot archive', e like '42501%', e);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'layouts' and org_id = a;
  perform pg_temp.login('a_staff@a.test');
  j := public.studio_template_save(null, '{"name":"Staff tpl","data":{"items":[]}}');
  perform pg_temp.res('19 layouts edit can save', j ->> 'name' = 'Staff tpl', j::text);

  -- studio B
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.studio_layout_templates;
  perform pg_temp.res('20 other studio sees none of A templates', n = 0, n::text);
  e := pg_temp.try(format('select public.studio_template_save(%L, %L)', pg_temp.get('tid'), '{"name":"Hijack"}'));
  perform pg_temp.res('21 other studio cannot edit', e like '42501%', e);
  e := pg_temp.try(format('select public.studio_template_duplicate(%L)', pg_temp.get('tid')));
  perform pg_temp.res('22 other studio cannot duplicate', e like '42501%', e);
  e := pg_temp.try(format('select public.studio_template_set_default(%L, true)', pg_temp.get('tid')));
  perform pg_temp.res('23 other studio cannot set default', e like '42501%', e);

  perform pg_temp.anon();
  e := pg_temp.try('select count(*) from public.studio_layout_templates');
  perform pg_temp.res('24 anon cannot read', e like '42501%', e);
  e := pg_temp.try($q$select public.studio_template_save(null, '{"name":"Anon","data":{"items":[]}}')$q$);
  perform pg_temp.res('25 anon cannot save', e like '42501%', e);

  perform pg_temp.su();
  e := pg_temp.try('delete from public.studio_layout_templates');
  perform pg_temp.res('26 hard delete blocked for everyone', e like '42501%' and (select count(*) from public.studio_layout_templates) = 4, e);
exception when others then perform pg_temp.su(); insert into _t96 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _t96 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'STUDIO-TEMPLATES: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'STUDIO-TEMPLATES: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _t96;
rollback;
