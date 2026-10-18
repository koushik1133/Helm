-- trial-data-0171.sql -- 0171: the owner's price list as sample inventory (17 merged in place, 118 added, 5 zero-rate zones skipped),
-- owner rate cards, + 8 leads, + 3 events (2 confirmed with simulated advance + reservations within stock); manifest v5; a cloned trial gets all of it.
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


do $$ declare M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; mf public.helm_trial_seed_manifest; begin
  perform pg_temp.su();
  select * into mf from public.helm_trial_seed_manifest where is_current;
  perform pg_temp.res('01 manifest v5 current, v4 kept', mf.version = 5 and mf.notes = 'v5: owner price list, leads, events'
    and exists (select 1 from public.helm_trial_seed_manifest where version = 4 and not is_current));
  perform pg_temp.res('02 165 inventory items, unique names, all is_demo', (select count(*) from public.inventory_items where org_id = M) = 165
    and (select count(distinct lower(name)) from public.inventory_items where org_id = M) = 165
    and not exists (select 1 from public.inventory_items where org_id = M and not is_demo));
  perform pg_temp.res('03 17 merged in place at owner rate / qty, old names gone',
    (select count(*) from public.inventory_items i join (values ('Lectern / Podium',2,1500),('Registration Desk',4,800),('LED Wall',4,5000),('Generator',2,5000),
       ('Chandelier',6,4000),('Uplight',40,300),('Line Array',4,3500),('Moving Light',12,1800),('Floral Arch',2,9000),('Flower Wall',2,8000),
       ('Decor Mandap',1,50000),('Carpet / Aisle',6,2500),('Air Cooler / Fan',20,800),('Cocktail Table',30,350),('Rectangular Table',60,400),
       ('Lounge Set',6,4500),('Flower Urli',10,1200)) x(n,q,r) on i.name = E'Demo \u00b7 ' || x.n and i.total_qty = x.q and i.unit_cost = x.r where i.org_id = M) = 17
    and not exists (select 1 from public.inventory_items where org_id = M and name in (E'Demo \u00b7 Generator 125 kVA', E'Demo \u00b7 Crystal chandelier', E'Demo \u00b7 Lectern', E'Demo \u00b7 Podium', E'Demo \u00b7 Reg Desk')));
  perform pg_temp.res('04 owner notes + no-qty stock + zones skipped',
    (select count(*) from public.inventory_items where org_id = M and notes like 'Sample item. Owner rental rate%') = 135
    and exists (select 1 from public.inventory_items where org_id = M and name = E'Demo \u00b7 Generator' and notes like '%125 kVA, without diesel%')
    and exists (select 1 from public.inventory_items where org_id = M and name = E'Demo \u00b7 LED Video Wall' and notes like '%20x12 ft%' and unit_cost = 25000)
    and exists (select 1 from public.inventory_items where org_id = M and name = E'Demo \u00b7 Chair (single)' and total_qty = 400 and unit_cost = 100)
    and exists (select 1 from public.inventory_items where org_id = M and name = E'Demo \u00b7 Dancers' and notes like '%Per group performance%')
    and not exists (select 1 from public.inventory_items where org_id = M and name in (E'Demo \u00b7 Chair Row', E'Demo \u00b7 Seating Block',
         E'Demo \u00b7 Parking Zone', E'Demo \u00b7 Exit Zone', E'Demo \u00b7 Ambulance Bay')));
  perform pg_temp.res('05 rate cards take owner rates', exists (select 1 from public.item_rate_cards where org_id = M and item_type = 'generator'
      and (rates ->> 'base')::numeric = 0 and (rates ->> 'perKvaDay')::numeric = 40)
    and exists (select 1 from public.item_rate_cards where org_id = M and item_type = 'dj' and (rates #>> '{setup,console}')::numeric = 5000)
    and exists (select 1 from public.item_rate_cards where org_id = M and item_type = 'lighting' and (rates #>> '{each,uplighter}')::numeric = 300));
  perform pg_temp.res('06 16 leads across stages, dummy contacts', (select count(*) from public.leads where org_id = M) = 16
    and (select count(distinct status) from public.leads where org_id = M) = 6
    and not exists (select 1 from public.leads where org_id = M and (email not like '%@example.com' or right(regexp_replace(phone, '\D', '', 'g'), 10) not like '00000%')));
  perform pg_temp.res('07 3 new events on packages, GST 18, D8 priced', (select string_agg(code || '=' || (pricing ->> 'platePrice') || '/' || (pricing ->> 'total'), ',' order by code)
      from public.quotes where org_id = M and code in ('SMP-1004','SMP-1005','SMP-1006')) = 'SMP-1004=700/452530,SMP-1005=650/407100,SMP-1006=450/137175',
    (select string_agg(code || '=' || (pricing ->> 'total'), ',') from public.quotes where org_id = M));
  perform pg_temp.res('08 confirmed events: 30 % advance paid (simulated) + balance = total', not exists (select 1 from public.quotes q where q.org_id = M and q.code in ('SMP-1004','SMP-1005')
      and ((select sum(amount) from public.payment_milestones pm where pm.quote_id = q.id) <> (q.pricing ->> 'total')::numeric
        or (select amount from public.quote_payments p where p.quote_id = q.id and p.simulated) <> round((q.pricing ->> 'total')::numeric * 0.3))));
  perform pg_temp.res('09 reservations within stock per item', (select count(*) from public.inventory_reservations where org_id = M) = 21
    and not exists (select 1 from public.inventory_reservations r join public.inventory_items i on i.id = r.item_id where r.org_id = M
      group by i.id, i.total_qty having sum(r.qty) > i.total_qty));
  perform pg_temp.res('10 no outbound pending for the master', not exists (select 1 from public.comms_outbox where org_id = M and status = 'pending'));
  perform pg_temp.res('11 snapshot counts', (mf.counts ->> 'inventory_items')::int = 165 and (mf.counts ->> 'leads')::int = 16 and (mf.counts ->> 'quotes')::int = 7
    and (mf.counts ->> 'payment_milestones')::int = 8 and (mf.counts ->> 'inventory_reservations')::int = 21, mf.counts::text);
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid; o public.organizations; M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('td5_a@t.test');
  select * into o from public.organizations where id = a;
  perform pg_temp.res('20 trial cloned from v5', o.sample_version = 5, coalesce(o.sample_version::text, 'null'));
  perform pg_temp.res('21 trial inventory / leads / events', (select count(*) from public.inventory_items where org_id = a) = 165
    and (select count(*) from public.leads where org_id = a) = 16 and (select count(*) from public.quotes where org_id = a) = 7
    and (select count(*) from public.inventory_reservations where org_id = a) = 21 and (select count(*) from public.payment_milestones where org_id = a) = 8,
    (select count(*) from public.quotes where org_id = a)::text);
  perform pg_temp.res('22 trial event dates relative to today', exists (select 1 from public.quotes where org_id = a and code = 'SMP-1004' and event_date = current_date + 18)
    and exists (select 1 from public.leads where org_id = a and email = 'demo.rahuldivya@example.com' and event_date = current_date - 20));
  perform pg_temp.res('23 trial sends nothing', not exists (select 1 from public.comms_outbox where org_id = a and status = 'pending'));
  perform pg_temp.res('24 master untouched by the clone', (select count(*) from public.inventory_items where org_id = M) = 165
    and (select count(*) from public.quotes where org_id = M) = 7);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x clone', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DATA-0171: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DATA-0171: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
