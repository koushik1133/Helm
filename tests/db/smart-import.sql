-- smart-import.sql -- 0088: smart import batch RPC, attributes, custom fields, mappings. RLS + has_area + cross-tenant.
-- Fixture: a_admin/a_staff (sales) studio A, b_admin/b_staff studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _s88(name text, result text); grant all on _s88 to anon, authenticated, service_role;
create temp table _s88kv(k text primary key, v text); grant all on _s88kv to anon, authenticated, service_role;

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
begin insert into _s88 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _s88kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _s88kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  e text; j jsonb; sid uuid; bid uuid; did uuid; n int; rows jsonb; begin
  perform pg_temp.su();
  delete from public.role_access where area in ('staff', 'inventory', 'controls', 'vendors');

  -- admin A: create
  perform pg_temp.login('a_admin@a.test');
  j := public.smart_import_batch('staff', '[{"i":1,"action":"create","fields":{"name":"Ravi Kumar","phone":"+91 98765 43210","role":"Lead","skills":["sound","light"],"day_rate":"1500"},"attributes":{"ifsc":"HDFC0001234","joining_date":"2024-01-05","blood_group":"O+"}},{"i":2,"action":"create","fields":{"name":"Asha","phone":"9876500000"},"attributes":{}}]',
    '[{"key":"ifsc","label":"IFSC code"},{"key":"joining_date","label":"Joining date","type":"date"},{"key":"blood_group","label":"Blood Group"}]');
  sid := (j -> 0 ->> 'id')::uuid; perform pg_temp.put('sid', sid::text);
  perform pg_temp.res('01 admin creates 2 staff rows', j -> 0 ->> 'status' = 'created' and j -> 1 ->> 'status' = 'created', j::text);
  perform pg_temp.su();   -- r58 (0299): attributes / day_rate are read through staff_pay_fields, not the table, by signed-in users
  select count(*) into n from public.crew_members where id = sid and org_id = a and attributes ->> 'ifsc' = 'HDFC0001234' and day_rate = 1500 and skills = '["sound","light"]';
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('02 row is in own studio with attributes + standard fields', n = 1, n::text);
  select count(*) into n from public.custom_field_defs where org_id = a and entity = 'staff';
  perform pg_temp.res('03 custom field labels registered', n = 3, n::text);

  -- update merges, keeps unmentioned fields + attributes
  j := public.smart_import_batch('staff', format('[{"i":5,"action":"update","id":"%s","fields":{"department":"Production"},"attributes":{"ifsc":"SBIN0000001","shoe":"9"}}]', sid)::jsonb,
    '[{"key":"ifsc","label":"RENAMED"}]');
  perform pg_temp.su();
  select count(*) into n from public.crew_members where id = sid and department = 'Production' and role = 'Lead' and phone = '+91 98765 43210'
    and attributes ->> 'ifsc' = 'SBIN0000001' and attributes ->> 'blood_group' = 'O+' and attributes ->> 'shoe' = '9';
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('04 update only touches supplied fields; attributes merged', j -> 0 ->> 'status' = 'updated' and n = 1, j::text);
  perform pg_temp.res('05 existing custom field label never renamed by import',
    (select label from public.custom_field_defs where org_id = a and entity = 'staff' and key = 'ifsc') = 'IFSC code');

  -- per-row validation: others still succeed
  j := public.smart_import_batch('staff', '[{"i":1,"fields":{"name":"Bad Phone","phone":"12"}},{"i":2,"fields":{"name":"Nested"},"attributes":{"x":{"y":1}}},{"i":3,"fields":{"name":"Bad mail","email":"nope"}},{"i":4,"fields":{"name":"Fine","phone":"9876500001"}},{"i":7,"fields":{"name":"No phone"}},{"i":6,"fields":{"phone":"9876543210"}}]');
  perform pg_temp.res('06 bad phone -> row error', j -> 0 ->> 'status' = 'error', j::text);
  perform pg_temp.res('07 nested attribute -> row error', j -> 1 ->> 'status' = 'error', j::text);
  perform pg_temp.res('08 bad email -> row error', j -> 2 ->> 'status' = 'error', j::text);
  perform pg_temp.res('09 valid row in same batch still created', j -> 3 ->> 'status' = 'created', j::text);
  perform pg_temp.res('10 create without name / staff without phone -> row error', j -> 5 ->> 'status' = 'error' and j -> 4 ->> 'status' = 'error' and j -> 5 ->> 'i' = '6', j::text);

  -- inventory + menu + vendors
  j := public.smart_import_batch('inventory', '[{"i":1,"fields":{"name":"Chiavari chair","total_qty":"200","unit_cost":"150"},"attributes":{"warehouse":"Hyd-2","colour":"Gold"}},{"i":2,"fields":{"name":"Junk","total_qty":"abc"}},{"i":3,"fields":{"name":"Neg","total_qty":"-4"}}]');
  perform pg_temp.res('11 inventory create + numeric validation', j -> 0 ->> 'status' = 'created' and j -> 1 ->> 'status' = 'error' and j -> 2 ->> 'status' = 'error', j::text);
  j := public.smart_import_batch('inventory', '[{"i":1,"fields":{"name":"chiavari chair "}}]');
  perform pg_temp.res('12 duplicate active inventory name refused (no overwrite)', j -> 0 ->> 'status' = 'error'
    and (select total_qty from public.inventory_items where org_id = a and name = 'Chiavari chair') = 200, j::text);
  j := public.smart_import_batch('menu', '[{"i":1,"fields":{"name":"Paneer Tikka","category":"Starters","kind":"veg"},"attributes":{"diet":"jain","allergens":"dairy"}},{"i":2,"fields":{"name":"Egg Curry","kind":"bogus"}}]');
  did := (j -> 0 ->> 'id')::uuid;
  perform pg_temp.res('13 menu create; unknown kind falls back to veg', j -> 0 ->> 'status' = 'created' and j -> 1 ->> 'status' = 'created'
    and (select kind from public.dish_catalog where id = (j -> 1 ->> 'id')::uuid) = 'veg', j::text);
  j := public.smart_import_batch('vendors', '[{"i":1,"fields":{"name":"Shree Tents","phone":"040 2345 6789","kind":"rental"},"attributes":{"gstin":"36ABCDE1234F1Z5"}}]');
  perform pg_temp.res('14 vendor create', j -> 0 ->> 'status' = 'created', j::text);

  -- limits
  e := pg_temp.try(format('select public.smart_import_batch(%L, %L)', 'staff', (select jsonb_agg(jsonb_build_object('fields', jsonb_build_object('name', 'p' || g))) from generate_series(1, 501) g)));
  perform pg_temp.res('15 more than 500 rows refused', e like '22023%', e);
  e := pg_temp.try($q$select public.smart_import_batch('clients', '[]')$q$);
  perform pg_temp.res('16 unknown entity refused', e like '22023%', e);
  e := pg_temp.try($q$update public.crew_members set attributes = '{"a":[1]}' where name = 'Ravi Kumar'$q$);
  perform pg_temp.res('17 table CHECK blocks nested attributes on direct writes', e like '23514%', e);

  -- mappings: admin saves
  insert into public.import_mappings(entity, mapping) values ('staff', '{"mobile no":"phone"}');
  perform pg_temp.res('18 admin saves mapping in own studio', (select org_id from public.import_mappings where entity = 'staff') = a);

  -- sales user without staff edit
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.smart_import_batch('staff', '[{"fields":{"name":"Sneaky"}}]')$q$);
  perform pg_temp.res('19 role without staff edit cannot import', e like '42501%', e);
  e := pg_temp.try($q$insert into public.custom_field_defs(entity, key, label) values ('staff', 'zz', 'Z')$q$);
  perform pg_temp.res('20 non-admin cannot add custom fields', e like '42501%', e);
  e := pg_temp.try($q$update public.import_mappings set mapping = '{}' where entity = 'staff'$q$);
  perform pg_temp.su();
  perform pg_temp.res('21 non-editor cannot change saved mapping', (select mapping ->> 'mobile no' from public.import_mappings where entity = 'staff' and org_id = a) = 'phone');

  -- studio B
  perform pg_temp.login('b_admin@b.test');
  j := public.smart_import_batch('staff', format('[{"i":1,"action":"update","id":"%s","fields":{"name":"Hijacked"},"attributes":{"x":"1"}}]', pg_temp.get('sid'))::jsonb);
  perform pg_temp.res('22 other studio cannot update A row', j -> 0 ->> 'status' = 'error', j::text);
  select count(*) into n from public.custom_field_defs;
  perform pg_temp.res('23 other studio sees none of A custom fields', n = 0, n::text);
  select count(*) into n from public.import_mappings;
  perform pg_temp.res('24 other studio sees none of A mappings', n = 0, n::text);
  e := pg_temp.try(format($q$update public.custom_field_defs set org_id = %L where true$q$, b));
  insert into public.custom_field_defs(entity, key, label) values ('staff', 'ifsc', 'B IFSC');
  perform pg_temp.su();
  perform pg_temp.res('25 A row untouched by B', (select name || '|' || coalesce(attributes ->> 'x', '-') from public.crew_members where id = pg_temp.get('sid')::uuid) = 'Ravi Kumar|-');
  perform pg_temp.res('26 B keeps its own custom field, A label intact',
    (select count(*) from public.custom_field_defs where key = 'ifsc') = 2 and (select label from public.custom_field_defs where org_id = a and key = 'ifsc') = 'IFSC code');

  -- B admin tries to move a def into A / change key
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try($q$update public.custom_field_defs set key = 'other' where key = 'ifsc'$q$);
  perform pg_temp.res('27 custom field key cannot be changed', e like '42501%', e);
  e := pg_temp.try(format($q$insert into public.custom_field_defs(org_id, entity, key, label) values (%L, 'staff', 'evil', 'x')$q$, a));
  perform pg_temp.res('28 cannot insert a custom field into another studio', e like '42501%', e);

  -- anon
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.smart_import_batch('staff', '[{"fields":{"name":"Anon"}}]')$q$);
  perform pg_temp.res('29 anon cannot import', e like '42501%', e);
  e := pg_temp.try('select count(*) from public.custom_field_defs');
  perform pg_temp.res('30 anon cannot read custom fields', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _s88 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _s88 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'SMART-IMPORT: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'SMART-IMPORT: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _s88;
rollback;
