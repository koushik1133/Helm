-- menu-pkg-0192.sql -- 0192: menu package saves are validated in the database.
-- Paid studio (direct app writes as authenticated): an ACTIVE package needs a price > 0 and at least one
-- dish; a price can never be cleared / set to 0 (also inactive); new price <= 1,00,000 with <= 2 decimals;
-- malformed / duplicate dish lists refused. Existing bad rows are never re-checked (name / seq edits still
-- work). Free trial (0173): new package still refused by 0173 first, price edit works, price 0 / null
-- refused. Helm's own functions are exempt: the 0167 sample clone copies a master package with price 0
-- and no dishes untouched. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _mp(name text, result text); grant all on _mp to anon, authenticated, service_role;
create temp table _mkv(k text primary key, v text); grant all on _mkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _mp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _mkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _mkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;

-- earlier suites in run-all re-apply older migrations: re-run 0173 then 0192 (also proves a re-run is safe)
\ir ../../supabase/migrations/0173_trial_lockdown.sql
\ir ../../supabase/migrations/0192_menu_package_validation.sql

-- ---- 0) shape -------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('00 one 0192 trigger after a re-run', (select count(*) from pg_trigger where tgrelid = 'public.menu_templates'::regclass
    and tgname = 'zzzzz_menu_pkg_validate_0192' and not tgisinternal) = 1);
  perform pg_temp.res('01 trigger function not callable by the app', not has_function_privilege('authenticated', 'public.tg_menu_pkg_validate_0192()', 'execute')
    and not has_function_privilege('anon', 'public.tg_menu_pkg_validate_0192()', 'execute'));
  perform pg_temp.res('02 SECURITY INVOKER + pinned search_path', not (select prosecdef from pg_proc where oid = 'public.tg_menu_pkg_validate_0192()'::regprocedure)
    and (select proconfig::text from pg_proc where oid = 'public.tg_menu_pkg_validate_0192()'::regprocedure) like '%search_path=%');
end $$;

-- ---- 1) paid studio, direct app writes ------------------------------------------------------------
do $$ declare e text; A uuid := 'a0000000-0000-4000-8000-000000000001'; pk uuid; old_bad uuid; v numeric; begin
  perform pg_temp.su();
  delete from public.menu_templates where org_id = A and tier = 'premium' and diet = 'nonveg';
  delete from public.menu_templates where org_id = A and tier = 'standard' and diet = 'nonveg';
  -- a legacy row that already has price 0 and no dishes (written by owner SQL: exempt)
  insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, active)
    values (A, 'standard', 'nonveg', 'Legacy bad', 0, '[]', true) returning id into old_bad;
  perform pg_temp.res('10 owner SQL write is not checked (legacy row stored)', old_bad is not null);
  perform pg_temp.put('old_bad', old_bad::text);

  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.menu_templates(tier, diet, name) values ('premium', 'nonveg', 'No price')$q$);
  perform pg_temp.res('11 insert active with default price 0 refused', e like '23514%price per plate above 0%', e);
  e := pg_temp.try($q$insert into public.menu_templates(tier, diet, name, price_per_plate, dishes) values ('premium', 'nonveg', 'No dishes', 900, '[]')$q$);
  perform pg_temp.res('12 insert active with no dishes refused', e like '23514%at least one dish%', e);
  e := pg_temp.try($q$insert into public.menu_templates(tier, diet, name, price_per_plate, dishes, active) values ('premium', 'nonveg', 'Draft', 0, '[]', false)$q$);
  perform pg_temp.res('13 insert INACTIVE draft with price 0 + no dishes allowed', e = '', e);
  perform pg_temp.su(); delete from public.menu_templates where org_id = A and name = 'Draft'; perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.menu_templates(tier, diet, name, price_per_plate, dishes) values ('premium', 'nonveg', 'Good', 900, '[{"c":"Starters","n":"Paneer tikka","k":"veg"}]')$q$);
  perform pg_temp.res('14 insert active with price + dish OK', e = '', e);
  perform pg_temp.su(); select id into pk from public.menu_templates where org_id = A and name = 'Good'; perform pg_temp.put('pk', pk::text);
  perform pg_temp.login('a_admin@a.test');

  -- price
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = null where id = %L', pk));
  perform pg_temp.res('20 price cleared (null) refused with a clear message', e like '23514%cannot be cleared%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 0 where id = %L', pk));
  perform pg_temp.res('21 price set to 0 refused', e like '23514%above 0%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = -5 where id = %L', pk));
  perform pg_temp.res('22 negative price refused', e like '23514%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 100000.01 where id = %L', pk));
  perform pg_temp.res('23 price over 1,00,000 refused', e like '23514%at most 1,00,000%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 650.505 where id = %L', pk));
  perform pg_temp.res('24 more than 2 decimals refused', e like '23514%2 decimal places%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 100000 where id = %L', pk))
    || pg_temp.try(format('update public.menu_templates set price_per_plate = 650.50 where id = %L', pk));
  perform pg_temp.res('25 1,00,000 and 650.50 accepted', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set active = false, price_per_plate = 0 where id = %L', pk));
  perform pg_temp.res('26 inactive package: price can still not be zeroed', e like '23514%cannot be cleared or set to 0%', e);
  e := pg_temp.try(format('update public.menu_templates set active = false where id = %L', pk));
  perform pg_temp.res('27 switching off keeps the last price', e = '' and (select price_per_plate from public.menu_templates where id = pk) = 650.50, e);
  e := pg_temp.try(format('update public.menu_templates set active = true where id = %L', pk));
  perform pg_temp.res('28 switching back on with price + dishes OK', e = '', e);

  -- dishes
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '[]' where id = %L$q$, pk));
  perform pg_temp.res('30 active package emptied refused', e like '23514%at least one dish%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '{"n":"x"}' where id = %L$q$, pk));
  perform pg_temp.res('31 non-list dishes refused', e like '23514%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '[{"c":"Starters","n":"  ","k":"veg"}]' where id = %L$q$, pk));
  perform pg_temp.res('32 dish with a blank name refused', e like '23514%needs a name%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = jsonb_build_array(jsonb_build_object('c','S','n',repeat('x',121),'k','veg')) where id = %L$q$, pk));
  perform pg_temp.res('33 dish name over 120 chars refused', e like '23514%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '[{"c":"Starters","n":"Paneer","k":"vegan"}]' where id = %L$q$, pk));
  perform pg_temp.res('34 unknown kind refused', e like '23514%veg, nonveg or special%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '[{"c":"Starters","n":"Paneer","k":"veg"},{"c":"starters","n":" paneer ","k":"veg"}]' where id = %L$q$, pk));
  perform pg_temp.res('35 duplicate dish refused', e like '23514%twice%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = (select jsonb_agg(jsonb_build_object('c','S','n','D'||i,'k','veg')) from generate_series(1,501) i) where id = %L$q$, pk));
  perform pg_temp.res('36 more than 500 dishes refused', e like '23514%500%', e);
  e := pg_temp.try(format($q$update public.menu_templates set dishes = '[{"c":"Starters","n":"Paneer tikka 🌶","k":"nonveg"},"Dal","Rice"]' where id = %L$q$, pk));
  perform pg_temp.res('37 emoji in a name + legacy string dishes accepted', e = '', e);
  e := pg_temp.try(format($q$update public.menu_templates set active = false, dishes = '[]' where id = %L$q$, pk));
  perform pg_temp.res('38 inactive package may have no dishes', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set active = true where id = %L', pk));
  perform pg_temp.res('39 switching ON with no dishes refused', e like '23514%at least one dish%', e);

  -- legacy row: never re-checked on unchanged values
  e := pg_temp.try(format('update public.menu_templates set name = ''Legacy renamed'', seq = 9, description = ''x'' where id = %L', old_bad));
  perform pg_temp.res('40 legacy 0-price / empty row: name + order edits still work', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 500 where id = %L', old_bad));
  perform pg_temp.res('41 legacy row: setting a real price works (dishes unchanged, not re-checked)', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 0 where id = %L', old_bad));
  perform pg_temp.res('42 legacy row: price back to 0 refused', e like '23514%', e);
  perform pg_temp.su();
  perform pg_temp.res('43 the refused writes changed nothing', (select price_per_plate from public.menu_templates where id = old_bad) = 500
    and (select name from public.menu_templates where id = old_bad) = 'Legacy renamed');
  -- client link role is checked too
  perform set_config('role', 'anon', false);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 0 where id = %L', pk));
  perform pg_temp.su();
  perform pg_temp.res('44 anon write cannot zero a price either (RLS or 0192)', (select price_per_plate from public.menu_templates where id = pk) = 650.50, e);
  -- owner SQL is not checked
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 0 where id = %L', pk));
  perform pg_temp.res('45 owner SQL fix still possible', e = '', e);
exception when others then perform pg_temp.su(); insert into _mp values ('1x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) free trial + the 0167 sample clone ---------------------------------------------------------
do $$ declare o uuid; e text; M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; mt uuid; nm int; nt int; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  -- the master gets a package the 0192 check would refuse from the app: price 0, no dishes, active
  update public.menu_templates set price_per_plate = 0, dishes = '[]', active = true
   where id = (select id from public.menu_templates where org_id = M order by seq limit 1);
  perform public.publish_sample_manifest('test 0192: master package with price 0 and no dishes');
  select count(*) into nm from jsonb_array_elements((select payload #> '{tables,menu_templates}' from public.helm_trial_seed_manifest where is_current));
  o := pg_temp.trial('mp192_trial@t.test');
  select count(*) into nt from public.menu_templates where org_id = o;
  perform pg_temp.res('50 trial start: the 0167 clone copies every package (incl. price 0 / no dishes)', nm > 0 and nt = nm, nt || ' of ' || nm);
  perform pg_temp.res('51 cloned price-0 package kept as published', exists (select 1 from public.menu_templates where org_id = o and price_per_plate = 0 and dishes = '[]'::jsonb));
  perform pg_temp.res('52 every cloned package is_demo', not exists (select 1 from public.menu_templates where org_id = o and not is_demo));
  select id into mt from public.menu_templates where org_id = o and price_per_plate > 0 order by seq limit 1;
  perform pg_temp.login('mp192_trial@t.test');
  e := pg_temp.try($q$insert into public.menu_templates(tier, diet, name, price_per_plate, dishes) values ('gold', 'veg', 'T pkg', 500, '[{"n":"x"}]')$q$);
  perform pg_temp.res('53 trial: new package still refused by 0173 first', e like '42501%not add new menu%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 777 where id = %L', mt));
  perform pg_temp.res('54 trial: price edit still works', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = null where id = %L', mt));
  perform pg_temp.res('55 trial: clearing the price refused', e like '23514%cannot be cleared%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 0 where id = %L', mt));
  perform pg_temp.res('56 trial: price 0 refused', e like '23514%', e);
  perform pg_temp.su();
  perform pg_temp.res('57 trial: stored price is the last good one', (select price_per_plate from public.menu_templates where id = mt) = 777);
exception when others then perform pg_temp.su(); insert into _mp values ('5x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _mp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'MENU-PKG-0192: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'MENU-PKG-0192: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _mp;
rollback;
