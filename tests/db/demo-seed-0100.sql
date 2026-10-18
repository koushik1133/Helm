-- demo-seed-0100.sql -- 0100: "Try with demo data" on a PROD-LIKE database: full canonical chain
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
grant execute on function pg_temp.all_fp(uuid) to anon, authenticated, service_role;

-- prod drift (present on www.helm.events, not in the canonical chain)
do $$ declare r record; begin
  if not exists (select 1 from pg_constraint where conname = 'quote_payments_amount_pos') then
    alter table public.quote_payments add constraint quote_payments_amount_pos check (amount > 0); end if;
  if not exists (select 1 from pg_constraint where conname = 'inventory_items_total_qty_nonneg') then
    alter table public.inventory_items add constraint inventory_items_total_qty_nonneg check (total_qty >= 0); end if;
  for r in select con.conname, cl.relname as child from pg_constraint con join pg_class cl on cl.oid = con.conrelid
            join pg_class pcl on pcl.oid = con.confrelid
           where con.contype = 'f' and pcl.relname = 'quotes' and cl.relname in ('quote_payments','quote_consents') and con.confdeltype = 'c' loop
    execute format('alter table public.%I drop constraint %I', r.child, r.conname);
    execute format('alter table public.%I add constraint %I foreign key (quote_id) references public.quotes(id) on delete restrict', r.child, r.conname);
  end loop;
exception when others then insert into _uf values ('00 prod drift', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- the root cause, pinned: the 0097 demo pricing shape (guests + gstPct, no plate price) prices at 0
do $$ begin
  perform pg_temp.res('01 old demo pricing shape = 0 under D8 (root cause)',
    public.helm_quote_total('{"guests":500,"subtotal":1250000,"discount":0,"gstPct":18}'::jsonb) = 0);
  perform pg_temp.res('02 0100 body carries the marker', exists (select 1 from pg_proc where proname in ('_demo_seed', '_demo_seed__pre0166')  -- 0166 wraps it
    and pronamespace = 'public'::regnamespace and prosrc like '%demo-seed-0100%'));
end $$;

-- prod-like real studio A
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  t text; dt text; n int := 0; begin
  perform pg_temp.login('a_admin@a.test');
  insert into public.leads(org_id, name, phone, email, status) values (a, 'Real Lead A', '+91 98480 11111', 'real.a@studio.test', 'new');
  perform pg_temp.su();
  insert into public.quotes(id, org_id, code, title, event_type, status, approval_status, event_date, pricing, confirmed_at) values
    ('a0000000-0000-4000-8000-0000000100a2', a, 'A-0002', 'Real Wedding', 'Wedding', 'confirmed', 'paid', current_date + 40,
     '{"guests":300,"platePrice":800,"chairs":300,"chairPrice":40,"other":50000,"discount":0,"gstPct":18}', now()),
    ('a0000000-0000-4000-8000-0000000100a3', a, 'A-0003', 'Real Engagement', 'Engagement', 'quote', 'none', current_date + 20,
     '{"guests":100,"platePrice":600,"gstPct":18}', null),
    ('a0000000-0000-4000-8000-0000000100a4', a, 'A-0004', 'Real Birthday', 'Birthday', 'quote', 'none', current_date + 10,
     '{"guests":50,"platePrice":500,"gstPct":18}', null);
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, paid_at)
    values ('a0000000-0000-4000-8000-0000000100a2', a, 'cash', 50000, 'paid', now()), (qa, a, 'cash', 1000, 'paid', now());
  insert into public.payment_milestones(quote_id, org_id, label, amount, status, paid_at, seq)
    values ('a0000000-0000-4000-8000-0000000100a2', a, 'Advance', 50000, 'paid', now(), 1);
  insert into public.event_checklist(quote_id, section, title) values (qa, 'logistics', 'Real check A');
  insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, dim_unit, cost_basis) values
    (a, 'SAMPLE Venue 1', 'banquet_hall', 'ac', 'indoor', 200, 'm', 'per_day'),
    (a, 'SAMPLE Venue 2', 'lawn', 'non_ac', 'outdoor', 500, 'm', 'per_day'),
    (a, 'SAMPLE Venue 3', 'banquet_hall', 'ac', 'indoor', 300, 'm', 'per_day');
  foreach t in array array['standard','gold','premium'] loop foreach dt in array array['veg','nonveg'] loop
    n := n + 1;
    insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes)
      select a, t, dt, 'Real ' || t || ' ' || dt, 400 + n * 100, '[]'
       where not exists (select 1 from public.menu_templates m where m.org_id = a and m.tier = t and m.diet = dt);
  end loop; end loop;
  insert into public.crew_members(org_id, name, phone) values (a, 'Real Crew A', '+91 98480 33333');
  insert into public.vendors(org_id, name, kind, phone) values (a, 'Real Vendor A', 'vendor', '+91 98480 55555');
  insert into public.inventory_items(org_id, name, total_qty) values (a, 'Real Item A', 10);
  insert into public.dish_catalog(org_id, category, name, kind) values (a, 'Main', 'Real Dish A', 'veg');
  perform pg_temp.put('fpA', pg_temp.real_fp(a));
  perform pg_temp.put('fpB', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001'));
exception when others then perform pg_temp.su(); insert into _uf values ('03 prod-like fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- seed
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; v_tot numeric; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('10 seed succeeds on prod-like DB', (r ->> 'seeded')::boolean, r::text);
  select (pricing ->> 'total')::numeric into v_tot from public.quotes where org_id = a and code = 'DEMO-101';
  perform pg_temp.res('11 demo wedding server total is realistic (6-9 lakh)', v_tot between 600000 and 900000, coalesce(v_tot::text, 'null'));
  perform pg_temp.res('12 every demo event has a total > 0', not exists (select 1 from public.quotes where org_id = a and is_demo
    and coalesce((pricing ->> 'total')::numeric, 0) <= 0));
  perform pg_temp.res('13 demo advance payment > 0 and = 30% of server total', exists (select 1 from public.quote_payments
    where org_id = a and is_demo and amount > 0 and amount = round(v_tot * 0.3)));
  perform pg_temp.res('14 demo milestones all > 0 and sum to server total', (select count(*) from public.payment_milestones where org_id = a and is_demo and amount > 0) = 3
    and (select sum(amount) from public.payment_milestones where org_id = a and is_demo) = v_tot);
  perform pg_temp.res('15 package slots full -> no demo package, real 6 kept', (select count(*) from public.menu_templates where org_id = a and is_demo) = 0
    and (select count(*) from public.menu_templates where org_id = a and not is_demo) = 6);
  perform pg_temp.res('16 checklist, layout, leads, staff, vendors, inventory, venues seeded',
    (select count(*) from public.event_checklist where org_id = a and is_demo) = 6 and (select count(*) from public.layouts where org_id = a and is_demo) = 1
    and (select count(*) from public.leads where org_id = a and is_demo) >= 6 and (select count(*) from public.crew_members where org_id = a and is_demo) = 4
    and (select count(*) from public.vendors where org_id = a and is_demo) = 3 and (select count(*) from public.inventory_items where org_id = a and is_demo) = 6
    and (select count(*) from public.venues where org_id = a and is_demo and active) = 2);
  perform pg_temp.res('17 real rows untouched by seed', pg_temp.real_fp(a) = pg_temp.get('fpA'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x seed', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- reset, then clear
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.reset_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('20 reset succeeds', (r #>> '{seeded,seeded}')::boolean, r::text);
  perform pg_temp.res('21 reset payments > 0', (select count(*) from public.quote_payments where org_id = a and is_demo and amount > 0) = 1
    and not exists (select 1 from public.quote_payments where org_id = a and is_demo and amount <= 0));
  perform pg_temp.res('22 real rows untouched by reset', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.login('a_admin@a.test');
  r := public.clear_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('23 clear removes every demo event', not exists (select 1 from public.quotes where org_id = a and is_demo)
    and not exists (select 1 from public.quote_payments where org_id = a and is_demo), r::text);
  perform pg_temp.res('24 real rows untouched after clear', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.res('25 real paid payments still there', (select count(*) from public.quote_payments where org_id = a and not is_demo and status = 'paid') = 2);
  perform pg_temp.res('26 other studio untouched', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001') = pg_temp.get('fpB'));
  perform pg_temp.login('a_admin@a.test');
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('27 re-seed after clear succeeds (kept masters re-activated)', (r ->> 'seeded')::boolean
    and exists (select 1 from public.quote_payments where org_id = a and is_demo and amount > 0), r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('2x reset/clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'DEMO-SEED-0100: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'DEMO-SEED-0100: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
