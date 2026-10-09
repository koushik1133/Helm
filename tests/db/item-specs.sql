-- item-specs.sql -- 0086: item rate cards (seed, RLS, item_pricing gate, validation, audit).
-- Fixture: a_admin/a_staff studio A, b_admin studio B, quoteA. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _is(name text, result text); grant all on _is to anon, authenticated, service_role;
create temp table _isk(k text primary key, v text); grant all on _isk to anon, authenticated, service_role;

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
begin insert into _is values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _isk values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _isk where k = p_k $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  e text; j jsonb; n int; c uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  -- 01 seed: fixture studios got all 11 default cards (org insert trigger / migration loop)
  select count(*) into n from public.item_rate_cards where org_id = a;
  perform pg_temp.res('01 studio A seeded with 11 default cards', n = 11, n::text);
  -- 02 re-seed never overwrites an edit
  update public.item_rate_cards set rates = '{"base":0,"perSqM":999,"stdHeightM":0.6,"heightPerSqMPerM":150}' where org_id = a and item_type = 'stage';
  perform public._a86_seed_org(a);
  perform pg_temp.res('02 re-seed keeps studio edits', (select (rates->>'perSqM')::int from public.item_rate_cards where org_id = a and item_type = 'stage') = 999);
  perform pg_temp.res('03 re-seed inserts nothing new', public._a86_seed_org(a) = 0);
  -- 04 missing type re-seeded only
  delete from public.item_rate_cards where org_id = b and item_type = 'dancers';
  perform pg_temp.res('04 missing type filled by seed', public._a86_seed_org(b) = 1);
  -- role_access for the gate tests: sales view-only on item_pricing in A
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'item_pricing', true, false, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;

  -- reads
  perform pg_temp.login('a_staff@a.test');
  j := public.get_item_rate_cards();
  perform pg_temp.res('05 member reads own studio rates (edit seen)', (j->'rates'->'stage'->>'perSqM')::int = 999, j::text);
  perform pg_temp.res('06 view-only role: canEdit false', (j->>'canEdit')::boolean = false, j->>'canEdit');
  perform pg_temp.res('07 all 11 types present', (select count(*) from jsonb_object_keys(j->'rates')) = 11);
  select count(*) into n from public.item_rate_cards;   -- RLS: own studio only
  perform pg_temp.res('08 RLS: table read sees own studio only', n = 11 and not exists (select 1 from public.item_rate_cards where org_id = b), n::text);
  -- writes refused for view-only
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":500}')$q$);
  perform pg_temp.res('09 view-only role cannot edit rates', e like '42501%', e);
  e := pg_temp.try($q$update public.item_rate_cards set rates = '{"perSqM":1}' where item_type = 'stage'$q$);
  perform pg_temp.res('10 no direct table update', e like '42501%', e);
  e := pg_temp.try($q$insert into public.item_rate_cards(org_id, item_type, rates) values ('a0000000-0000-4000-8000-000000000001', 'dj', '{"x":1}')$q$);
  perform pg_temp.res('11 no direct table insert', e like '42501%', e);
  -- admin grants edit -> now allowed
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'item_pricing' and org_id = a;
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('12 granted role: canEdit true', (public.get_item_rate_cards()->>'canEdit')::boolean);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"base":0,"perSqM":500,"stdHeightM":0.6,"heightPerSqMPerM":150}')$q$);
  perform pg_temp.res('13 editor saves stage rate', e = '' and (public.get_item_rate_cards()->'rates'->'stage'->>'perSqM')::int = 500, e);
  perform pg_temp.res('14 saved type listed as custom', public.get_item_rate_cards()->'custom' ? 'stage');
  -- validation
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":-1}')$q$);
  perform pg_temp.res('15 negative rate refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":100000001}')$q$);
  perform pg_temp.res('16 huge rate refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":"450"}')$q$);
  perform pg_temp.res('17 string rate refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"a":{"b":{"c":1}}}')$q$);
  perform pg_temp.res('18 deep nesting refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('spaceship', '{"x":1}')$q$);
  perform pg_temp.res('19 unknown type refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '[1,2]')$q$);
  perform pg_temp.res('20 non-object refused', e like '22023%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{}')$q$);
  perform pg_temp.res('21 empty object refused', e like '22023%', e);
  -- tenant isolation: B admin edits do not touch A
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"base":0,"perSqM":777,"stdHeightM":0.6,"heightPerSqMPerM":150}')$q$);
  perform pg_temp.res('22 admin edits own studio', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('23 cross-studio untouched', (select (rates->>'perSqM')::int from public.item_rate_cards where org_id = a and item_type = 'stage') = 500
    and (select (rates->>'perSqM')::int from public.item_rate_cards where org_id = b and item_type = 'stage') = 777);
  select count(*) into n from public.audit_log where action = 'item_rates_update' and entity_id = 'stage';
  perform pg_temp.res('24 every change audited', n = 2, n::text);
  -- anon
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.get_item_rate_cards()$q$);
  perform pg_temp.res('25 anon cannot read rates', e like '42501%', e);
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":1}')$q$);
  perform pg_temp.res('26 anon cannot write rates', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('27 definer fns have empty search_path', (select bool_and(p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""']) from pg_proc p
      where p.oid in ('public.get_item_rate_cards()'::regprocedure, 'public.set_item_rate_card(text,jsonb)'::regprocedure, 'public._a86_seed_org(uuid)'::regprocedure)));
  perform pg_temp.res('28 seed fn not callable by authenticated', not has_function_privilege('authenticated', 'public._a86_seed_org(uuid)', 'execute'));
  -- suspended studio read-only
  insert into public.studio_subscriptions(org_id, status) values (b, 'suspended')
    on conflict (org_id) do update set status = 'suspended';
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try($q$select public.set_item_rate_card('stage', '{"perSqM":1}')$q$);
  perform pg_temp.res('29 suspended studio cannot edit', e like '42501%', e);
  -- new studio seeded on creation
  perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (c, 'Studio C86', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now());
  perform pg_temp.res('30 new studio seeded with defaults', (select count(*) from public.item_rate_cards where org_id = c) = 11);
exception when others then perform pg_temp.su(); insert into _is values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _is order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'ITEM-SPECS: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'ITEM-SPECS: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _is;
rollback;
