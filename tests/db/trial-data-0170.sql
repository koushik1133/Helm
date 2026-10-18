-- trial-data-0170.sql -- 0170: the owner's 145-dish catalog (no Demo prefix), 6 owner menu packages (same ids),
-- sample events on the packages (D8 repriced, wedding advance/balance follow), + 8 vendors (incl. fireworks), + owner inventory
-- (3 v1 duplicates merged, reservations capped), + 2 staff; manifest v4; a cloned trial gets all of it.
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
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_tz text default 'Asia/Kolkata', p_cur text default 'INR') returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, p_tz, p_cur, 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;


do $$ declare M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; mf public.helm_trial_seed_manifest; t1 numeric; begin
  perform pg_temp.su();
  select * into mf from public.helm_trial_seed_manifest where is_current;
  perform pg_temp.res('01 manifest v4 current, v3 kept', mf.version = 4 and mf.notes = 'v4: owner menus, dishes, vendors, inventory'
    and exists (select 1 from public.helm_trial_seed_manifest where version = 3 and not is_current));
  perform pg_temp.res('02 145 owner dishes, no Demo prefix, v1 dishes gone, all is_demo',
    (select count(*) from public.dish_catalog where org_id = M) = 145
    and not exists (select 1 from public.dish_catalog where org_id = M and (name like 'Demo%' or not is_demo))
    and (select count(distinct category) from public.dish_catalog where org_id = M) = 18
    and exists (select 1 from public.dish_catalog where org_id = M and category = 'Starters (nonveg)' and name = 'Apollo fish' and kind = 'special'));
  perform pg_temp.res('03 6 owner packages, same 0167 ids, exact prices',
    (select string_agg(name || '=' || price_per_plate::int, ',' order by seq) from public.menu_templates where org_id = M)
      = E'Standard \u2014 Vegetarian=450,Gold \u2014 Vegetarian=700,Premium \u2014 Vegetarian=1000,Standard \u2014 Non-veg=650,Gold \u2014 Non-veg=950,Premium \u2014 Non-veg=1400'
    and (select string_agg(jsonb_array_length(dishes)::text, ',' order by seq) from public.menu_templates where org_id = M) = '14,19,23,15,19,24',
    (select string_agg(name || '=' || price_per_plate, ',' order by seq) from public.menu_templates where org_id = M));
  perform pg_temp.res('04 every package dish is in the catalog (name + category + kind)', not exists (
    select 1 from public.menu_templates t, jsonb_array_elements(t.dishes) e where t.org_id = M
       and not exists (select 1 from public.dish_catalog d where d.org_id = M and d.name = e ->> 'n' and d.category = e ->> 'c' and d.kind = e ->> 'k')));
  perform pg_temp.res('05 sample events on the packages, D8 repriced', exists (select 1 from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a1'
      and pricing ->> 'platePrice' = '950' and pricing ->> '_packageName' = E'Gold \u2014 Non-veg' and (pricing ->> 'total')::numeric < 947245)
    and exists (select 1 from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a2' and pricing ->> 'platePrice' = '1000')
    and exists (select 1 from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a3' and pricing ->> 'platePrice' = '650' and (pricing ->> 'total')::numeric < 300900)
    and exists (select 1 from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a4' and pricing ->> 'platePrice' = '950' and (pricing ->> 'total')::numeric = 399725));
  select (pricing ->> 'total')::numeric into t1 from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a1';
  perform pg_temp.res('06 wedding advance 30 % + balance 70 % follow the new total', (select sum(amount) from public.payment_milestones
      where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a1') = t1
    and (select amount from public.quote_payments where org_id = M and receipt_no = 'SMP-R-0001') = round(t1 * 0.3), t1::text);
  perform pg_temp.res('07 16 vendors incl. fireworks + owner 7, dummy contacts', (select count(*) from public.vendors where org_id = M) = 16
    and exists (select 1 from public.vendors where org_id = M and name = E'Demo \u00b7 Sky Fireworks & Cold Pyro' and category = 'Fireworks')
    and exists (select 1 from public.vendors where org_id = M and name = E'Demo \u00b7 Gulmohar Florists')
    and not exists (select 1 from public.vendors where org_id = M and (email not like '%@example.com' or right(regexp_replace(phone, '\D', '', 'g'), 10) not like '00000%')));
  perform pg_temp.res('08 inventory 47: owner 10 present at owner qty/rate, 3 merged, no duplicate names',
    (select count(*) from public.inventory_items where org_id = M) = 47
    and (select count(*) from public.inventory_items i join (values ('Conference Chair',400,10),('Round Table',30,500),('Registration Desk',4,1600),
          ('Lectern / Podium',1,4500),('Wireless Microphone',6,1800),('PA Speaker',8,7000),('LED Par Light',20,950),('LED Screen Panel',120,180),
          ('Branded Backdrop Frame',1,8500),('Power Extension Cable',18,400)) x(n,q,r) on i.name = E'Demo \u00b7 ' || x.n and i.total_qty = x.q and i.unit_cost = x.r
         where i.org_id = M) = 10
    and not exists (select 1 from public.inventory_items where org_id = M and name in (E'Demo \u00b7 LED par light', E'Demo \u00b7 Cordless microphone', E'Demo \u00b7 Round table 6 ft')));
  perform pg_temp.res('09 wedding reservations within stock', not exists (select 1 from public.inventory_reservations r join public.inventory_items i on i.id = r.item_id
    where r.org_id = M and r.qty > i.total_qty) and (select count(*) from public.inventory_reservations where org_id = M) = 5);
  perform pg_temp.res('10 12 staff incl. registration desk lead + AV technician', (select count(*) from public.crew_members where org_id = M) = 12
    and exists (select 1 from public.crew_members where org_id = M and role = 'Registration desk lead')
    and exists (select 1 from public.crew_members where org_id = M and role = 'AV technician'));
  perform pg_temp.res('11 snapshot counts', (mf.counts ->> 'dish_catalog')::int = 145 and (mf.counts ->> 'vendors')::int = 16
    and (mf.counts ->> 'inventory_items')::int = 47 and (mf.counts ->> 'crew_members')::int = 12 and (mf.counts ->> 'menu_templates')::int = 6, mf.counts::text);
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid; o public.organizations; M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('td4_a@t.test');
  select * into o from public.organizations where id = a;
  perform pg_temp.res('20 trial cloned from v4', o.sample_version = 4, coalesce(o.sample_version::text, 'null'));
  perform pg_temp.res('21 trial has the owner dishes + packages (is_demo)', (select count(*) from public.dish_catalog where org_id = a and is_demo) = 145
    and (select count(*) from public.menu_templates where org_id = a and is_demo and name like E'% \u2014 %') = 6
    and exists (select 1 from public.menu_templates where org_id = a and name = E'Premium \u2014 Non-veg' and price_per_plate = 1400 and jsonb_array_length(dishes) = 24));
  perform pg_temp.res('22 trial vendors / inventory / staff', (select count(*) from public.vendors where org_id = a) = 16
    and (select count(*) from public.inventory_items where org_id = a) = 47 and (select count(*) from public.crew_members where org_id = a) = 12
    and exists (select 1 from public.vendors where org_id = a and category = 'Fireworks'));
  perform pg_temp.res('23 trial events keep the package prices', (select string_agg(pricing ->> 'platePrice', ',' order by code) from public.quotes where org_id = a) = '950,950,1000,650',
    (select string_agg(pricing ->> 'platePrice', ',' order by code) from public.quotes where org_id = a));
  perform pg_temp.res('24 master untouched by the clone', (select count(*) from public.dish_catalog where org_id = M) = 145
    and (select count(*) from public.inventory_items where org_id = M) = 47);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x clone', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DATA-0170: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DATA-0170: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
