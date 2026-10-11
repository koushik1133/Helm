-- venue4-0104.sql -- 0104: 4th sample venue (200 x 200 ft) + loader adds only missing samples.
-- Fixture: a_admin/a_staff (sales) studio A, b_admin/b_staff studio B. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _v104(name text, result text); grant all on _v104 to anon, authenticated, service_role;
create temp table _v104kv(k text primary key, v text); grant all on _v104kv to anon, authenticated, service_role;

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
begin insert into _v104 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _v104kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _v104kv where k = p_k $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; j jsonb; n int; r public.venues; begin
  perform pg_temp.su();
  -- studio A: has only its own venue -> loader still adds nothing (unchanged 0085 rule)
  perform pg_temp.login('a_admin@a.test');
  j := public.venue_save(null, '{"name":"Own Hall","venue_type":"banquet_hall","seated_capacity":200}');
  j := public.venue_load_samples();
  perform pg_temp.res('01 studio with only own venues gets no samples', (j ->> 'added')::int = 0, j::text);

  -- studio A now holds the 3 pre-0104 samples (as an earlier click would have left them)
  perform pg_temp.su();
  insert into public.venues(org_id, name, venue_type, ac_type, setting, floating_capacity, is_sample, notes) values
    (a, 'SAMPLE - Grand Convention Centre, Hitec City', 'convention_centre', 'ac', 'indoor', 2000, true, 'edited by studio'),
    (a, 'SAMPLE - Royal Banquet Hall', 'banquet_hall', 'ac', 'indoor', 700, true, 'edited by studio'),
    (a, 'SAMPLE - Green Meadows Lawn', 'lawn', 'non_ac', 'outdoor', 2000, false, 'edited by studio');
  update public.venues set active = false where org_id = a and name = 'SAMPLE - Royal Banquet Hall';
  perform pg_temp.login('a_admin@a.test');
  j := public.venue_load_samples();
  perform pg_temp.res('02 studio with the 3 old samples gets +1', (j ->> 'added')::int = 1, j::text);
  perform pg_temp.su();
  select count(*) into n from public.venues where org_id = a;
  perform pg_temp.res('03 studio A total = own + 3 + 1, no duplicates', n = 5
     and not exists (select 1 from public.venues where org_id = a group by lower(name) having count(*) > 1), n::text);
  perform pg_temp.res('04 existing rows untouched (notes / active kept)',
     (select count(*) from public.venues where org_id = a and notes = 'edited by studio') = 3
     and not (select active from public.venues where org_id = a and name = 'SAMPLE - Royal Banquet Hall'));
  perform pg_temp.login('a_admin@a.test');
  j := public.venue_load_samples();
  perform pg_temp.res('05 second click adds 0', (j ->> 'added')::int = 0, j::text);

  -- the new venue: exactly 200 x 200 ft
  perform pg_temp.su();
  select * into r from public.venues where org_id = a and name = 'SAMPLE - Square Garden Pavilion, Gachibowli';
  perform pg_temp.res('06 4th venue: 60.96 x 60.96 m shown in ft = exactly 200 x 200 ft',
     r.length_m = 60.96 and r.width_m = 60.96 and r.dim_unit = 'ft'
     and round(r.length_m / 0.3048, 6) = 200 and round(r.width_m / 0.3048, 6) = 200, coalesce(r.length_m::text, 'missing'));
  perform pg_temp.res('07 4th venue: sample, Hyderabad, https map, restrictions + curfew 22:00',
     r.is_sample and r.city = 'Hyderabad' and r.map_url like 'https://%' and r.sound_curfew = '22:00'
     and r.restrictions @> array['no_fireworks', 'sound_curfew']::text[] and r.seated_capacity > 0 and r.floating_capacity > r.seated_capacity
     and r.cost_min < r.cost_max and r.venue_type = 'lawn' and r.setting = 'both');

  -- studio B: fresh -> 4, again -> 0
  perform pg_temp.login('b_admin@b.test');
  j := public.venue_load_samples();
  perform pg_temp.res('08 fresh studio gets 4', (j ->> 'added')::int = 4, j::text);
  j := public.venue_load_samples();
  perform pg_temp.res('09 fresh studio second click adds 0', (j ->> 'added')::int = 0, j::text);
  perform pg_temp.su();
  perform pg_temp.res('10 loader definer + empty search_path + venues-0104 body',
     exists (select 1 from pg_proc where oid = 'public.venue_load_samples()'::regprocedure and prosecdef
             and proconfig @> array['search_path=""'] and prosrc like '%venues-0104%'));
  perform pg_temp.res('11 grants: authenticated yes, anon no',
     has_function_privilege('authenticated', 'public.venue_load_samples()', 'execute')
     and not has_function_privilege('anon', 'public.venue_load_samples()', 'execute'));
exception when others then perform pg_temp.su(); insert into _v104 values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _v104 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'VENUE4-0104: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'VENUE4-0104: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _v104;
rollback;
