-- uae-demo-0102.sql -- 0102: a UAE studio gets the Dubai demo (AED, VAT 5%, +971, halal packages);
-- (D8 server pricing authority) + prod-only drift constraints (W16-01 quote_payments_amount_pos,
-- inventory nonneg, HLM-DEL-01 RESTRICT FKs) + a studio already full of real data (4 events incl.
-- confirmed + paid, 3 venues, all 6 menu-package slots, staff/inventory/vendors). Seed, reset and
-- clear must succeed, money rows must be > 0, and every real row must survive byte-for-byte.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

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
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- fingerprint of every REAL (non-demo) row of a studio, plus the real event's children
create or replace function pg_temp.real_fp(p_org uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.leads x where x.org_id = p_org and not x.is_demo),
    (select string_agg((to_jsonb(x) - 'updated_at')::text, ',' order by x.id) from public.quotes x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.crew_members x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.vendors x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_items x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.venues x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.menu_templates x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.dish_catalog x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.layouts x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.event_checklist x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.quote_payments x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.payment_milestones x where x.org_id = p_org and not x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.event_tasks x where x.org_id = p_org),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.inventory_reservations x where x.org_id = p_org)));
$$;
grant execute on function pg_temp.real_fp(uuid) to anon, authenticated, service_role;
create or replace function pg_temp.all_fp(p_org uuid) returns text language sql as $$
  select md5(concat_ws('|', pg_temp.real_fp(p_org),
    (select string_agg((to_jsonb(x) - 'updated_at')::text, ',' order by x.id) from public.quotes x where x.org_id = p_org and x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.leads x where x.org_id = p_org and x.is_demo),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.crew_members x where x.org_id = p_org and x.is_demo)));
$$;

do $$ begin
  perform pg_temp.res('01 dispatcher + AE seed installed', to_regprocedure('public._demo_seed_for(uuid)') is not null
    and to_regprocedure('public._demo_seed_ae(uuid)') is not null);
  perform pg_temp.res('02 India _demo_seed body unchanged (0100 marker)', exists (select 1 from pg_proc where proname = '_demo_seed'
    and pronamespace = 'public'::regnamespace and prosrc like '%demo-seed-0100%'));
  perform pg_temp.res('03 internal helpers not callable by app roles', not has_function_privilege('authenticated', 'public._demo_seed_ae(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._demo_seed_for(uuid)', 'execute') and has_function_privilege('authenticated', 'public.seed_demo_data()', 'execute'));
end $$;

-- studio A is a UAE studio with one real event
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.organizations set country = 'AE' where id = a;
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, event_date, pricing) values
    ('a0000000-0000-4000-8000-0000000102a1', a, 'A-0102', 'Real Gala', 'Gala dinner', 'quote', 'none', current_date + 40,
     '{"guests":100,"platePrice":300,"gstPct":5,"currency":"AED","taxCountry":"AE"}');
  insert into public.crew_members(org_id, name, phone) values (a, 'Real Crew AE', '+971 50 123 4567');
  perform pg_temp.put('fpA', pg_temp.real_fp(a));
  perform pg_temp.put('fpB', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001'));
exception when others then perform pg_temp.su(); insert into _uf values ('04 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; v_tot numeric; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('10 AE seed succeeds', (r ->> 'seeded')::boolean and r ->> 'country' = 'AE', r::text);
  select (pricing ->> 'total')::numeric into v_tot from public.quotes where org_id = a and code = 'DEMO-101' and is_demo;
  perform pg_temp.res('11 demo wedding = (400x425 + 400x15 + 60000) + 5% VAT = AED 247,800', v_tot = 247800, coalesce(v_tot::text, 'null'));
  perform pg_temp.res('12 every demo event is AED / AE / 5%', not exists (select 1 from public.quotes where org_id = a and is_demo
    and (pricing ->> 'currency' <> 'AED' or pricing ->> 'taxCountry' <> 'AE' or (pricing ->> 'gstPct')::numeric <> 5 or coalesce((pricing ->> 'total')::numeric, 0) <= 0)));
  perform pg_temp.res('13 deposit = 50% of server total, AED, bank transfer', exists (select 1 from public.quote_payments where org_id = a and is_demo
    and amount = round(v_tot * 0.5) and currency = 'AED' and method = 'bank'));
  perform pg_temp.res('14 milestones sum to server total', (select sum(amount) from public.payment_milestones where org_id = a and is_demo) = v_tot);
  perform pg_temp.res('15 every demo phone is +971, none +91', not exists (select 1 from public.crew_members where org_id = a and is_demo and phone not like '+971 %')
    and not exists (select 1 from public.leads where org_id = a and is_demo and phone not like '+971 %')
    and not exists (select 1 from public.vendors where org_id = a and is_demo and phone not like '+971 %'));
  perform pg_temp.res('16 Dubai venues in metres, halal AED packages', (select count(*) from public.venues where org_id = a and is_demo and city = 'Dubai' and dim_unit = 'm') = 2
    and (select count(*) from public.menu_templates where org_id = a and is_demo and description like '%halal%') = 2
    and not exists (select 1 from public.dish_catalog where org_id = a and is_demo and name ~* 'pork|paneer|biryani'));
  perform pg_temp.res('17 real rows untouched by seed', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.res('18 other studio untouched', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001') = pg_temp.get('fpB'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x seed', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.reset_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('20 reset re-seeds the AE demo', (r #>> '{seeded,country}') = 'AE', r::text);
  perform pg_temp.res('21 real rows untouched by reset', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.login('a_admin@a.test');
  r := public.clear_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('22 clear removes every AE demo event', not exists (select 1 from public.quotes where org_id = a and is_demo)
    and not exists (select 1 from public.quote_payments where org_id = a and is_demo), r::text);
  perform pg_temp.res('23 real rows untouched after clear', pg_temp.real_fp(a) = pg_temp.get('fpA'));
exception when others then perform pg_temp.su(); insert into _uf values ('2x reset/clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- a studio with no country still gets the India demo
do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; r jsonb; begin
  perform pg_temp.login('b_admin@b.test');
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('30 no-country studio gets the India demo (INR, +91)', (r ->> 'seeded')::boolean and r ->> 'country' is null
    and exists (select 1 from public.quotes where org_id = b and is_demo and pricing ->> 'currency' = 'INR'), r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('3x india', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'UAE-DEMO-0102: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'UAE-DEMO-0102: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
