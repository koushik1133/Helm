-- venues.sql -- 0085: venues list. RLS cross-tenant, has_area gating, no delete, sample loader idempotent.
-- Fixture: a_admin/a_staff (sales) studio A, b_admin/b_staff studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _v85(name text, result text); grant all on _v85 to anon, authenticated, service_role;
create temp table _v85kv(k text primary key, v text); grant all on _v85kv to anon, authenticated, service_role;

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
begin insert into _v85 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _v85kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _v85kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  e text; j jsonb; vid uuid; n int; begin
  perform pg_temp.su();
  delete from public.role_access where area = 'venues';

  -- admin A: samples
  perform pg_temp.login('a_admin@a.test');
  j := public.venue_load_samples();
  perform pg_temp.res('01 admin loads 3 samples', (j ->> 'added')::int = 3, j::text);
  j := public.venue_load_samples();
  perform pg_temp.res('02 sample loader idempotent (2nd run adds 0)', (j ->> 'added')::int = 0, j::text);
  select count(*) into n from public.venues where is_sample and name like 'SAMPLE - %';
  perform pg_temp.res('03 samples clearly marked + visible to admin', n = 3, n::text);

  -- admin A: add / validate
  j := public.venue_save(null, '{"name":"Test Hall","venue_type":"banquet_hall","seated_capacity":300,"length_m":30,"width_m":20,"cost_min":100000,"cost_max":200000,"event_types":["wedding","birthday"],"restrictions":["sound_curfew"],"sound_curfew":"22:00"}');
  vid := (j ->> 'id')::uuid; perform pg_temp.put('vid', vid::text);
  perform pg_temp.res('04 admin adds a venue in own studio', (j ->> 'org_id')::uuid = a and j ->> 'name' = 'Test Hall', j::text);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Bad","seated_capacity":0}')$q$);
  perform pg_temp.res('05 capacity 0 refused', e like '22023%', e);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Bad","seated_capacity":10,"length_m":-1}')$q$);
  perform pg_temp.res('06 negative length refused', e like '22023%', e);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Bad","seated_capacity":10,"cost_min":5,"cost_max":1}')$q$);
  perform pg_temp.res('07 cost min > max refused', e like '22023%', e);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Bad","seated_capacity":10,"event_types":["rave"]}')$q$);
  perform pg_temp.res('08 unknown event type refused', e like '23514%', e);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Bad","seated_capacity":10,"map_url":"javascript:alert(1)"}')$q$);
  perform pg_temp.res('09 non-https map link refused', e like '22023%', e);
  e := pg_temp.try(format('delete from public.venues where id = %L', vid));
  perform pg_temp.res('10 authenticated cannot delete', e like '42501%', e);
  e := pg_temp.try(format('update public.venues set name = %L where id = %L', 'x', vid));
  perform pg_temp.res('11 authenticated cannot update table directly', e like '42501%', e);
  e := pg_temp.try($q$insert into public.venues(org_id, name, seated_capacity) values ('a0000000-0000-4000-8000-000000000001', 'x', 1)$q$);
  perform pg_temp.res('12 authenticated cannot insert table directly', e like '42501%', e);

  -- staff A (sales) without area
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.venues;
  perform pg_temp.res('13 staff without venues area sees nothing', n = 0, n::text);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Staff","seated_capacity":10}')$q$);
  perform pg_temp.res('14 staff without edit cannot save', e like '42501%', e);
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'venues', true, false, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.venues;
  perform pg_temp.res('15 staff with view reads own studio venues', n = 4, n::text);
  e := pg_temp.try(format('select public.venue_set_active(%L, false)', pg_temp.get('vid')));
  perform pg_temp.res('16 view-only cannot deactivate', e like '42501%', e);
  e := pg_temp.try('select public.venue_load_samples()');
  perform pg_temp.res('17 non-admin cannot load samples', e like '42501%', e);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'venues' and org_id = a;
  perform pg_temp.login('a_staff@a.test');
  j := public.venue_set_active(pg_temp.get('vid')::uuid, false);
  perform pg_temp.res('18 edit role deactivates (row kept)', (j ->> 'active')::boolean = false
    and exists (select 1 from public.venues where id = pg_temp.get('vid')::uuid), j::text);
  j := public.venue_save(pg_temp.get('vid')::uuid, '{"name":"Test Hall 2","seated_capacity":350}');
  perform pg_temp.res('19 edit role updates venue', j ->> 'name' = 'Test Hall 2', j::text);

  -- studio B
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.venues;
  perform pg_temp.res('20 other studio sees none of studio A venues', n = 0, n::text);
  e := pg_temp.try(format('select public.venue_save(%L, %L)', pg_temp.get('vid'), '{"name":"Hijack","seated_capacity":1}'));
  perform pg_temp.res('21 other studio cannot edit A venue', e like '42501%', e);
  e := pg_temp.try(format('select public.venue_set_active(%L, true)', pg_temp.get('vid')));
  perform pg_temp.res('22 other studio cannot deactivate A venue', e like '42501%', e);
  j := public.venue_load_samples();
  perform pg_temp.res('23 studio B gets its own samples', (j ->> 'added')::int = 3, j::text);

  -- anon
  perform pg_temp.anon();
  e := pg_temp.try('select count(*) from public.venues');
  perform pg_temp.res('24 anon cannot read', e like '42501%', e);
  e := pg_temp.try($q$select public.venue_save(null, '{"name":"Anon","seated_capacity":1}')$q$);
  perform pg_temp.res('25 anon cannot save', e like '42501%', e);

  -- maintenance role cannot hard-delete either
  perform pg_temp.su();
  e := pg_temp.try('delete from public.venues');
  perform pg_temp.res('26 hard delete blocked for everyone', e like '42501%' and (select count(*) from public.venues) = 7, e);
  perform pg_temp.res('27 audit rows written', exists (select 1 from public.audit_log where entity = 'venues'));
exception when others then perform pg_temp.su(); insert into _v85 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _v85 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'VENUES: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'VENUES: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _v85;
rollback;
