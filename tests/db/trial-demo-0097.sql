-- trial-demo-0097.sql -- 0097: seed / clear / reset demo data. ZERO DATA LOSS proofs:
-- real rows of the studio survive clear + reset byte-for-byte, the other studio is untouched,
-- demo rows still used by a real event are kept, the app can never flip is_demo, and demo
-- events / contacts are never messaged or charged. Rolled back. Local disposable PG only.
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

-- real data in BOTH studios (A: lead, staff, vendor, item, venue, dish, package, layout, event with a paid payment)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.login('a_admin@a.test');
  insert into public.leads(org_id, name, phone, email, status) values (a, 'Real Lead A', '+91 98480 11111', 'real.a@studio.test', 'new');
  insert into public.layouts(name, data) values ('Real Layout A', '{"items":[]}');
  perform pg_temp.login('b_admin@b.test');
  insert into public.leads(org_id, name, phone, email, status) values (b, 'Real Lead B', '+91 98480 22222', 'real.b@studio.test', 'new');
  insert into public.layouts(name, data) values ('Real Layout B', '{"items":[]}');
  perform pg_temp.su();
  insert into public.crew_members(id, org_id, name, phone) values ('a0000000-0000-4000-8000-0000000097c1', a, 'Real Crew A', '+91 98480 33333'),
                                                                 ('b0000000-0000-4000-8000-0000000097c1', b, 'Real Crew B', '+91 98480 44444');
  insert into public.vendors(org_id, name, kind, phone) values (a, 'Real Vendor A', 'vendor', '+91 98480 55555'), (b, 'Real Vendor B', 'vendor', '+91 98480 66666');
  insert into public.inventory_items(org_id, name, total_qty) values (a, 'Real Item A', 10), (b, 'Real Item B', 10);
  insert into public.venues(org_id, name, venue_type, ac_type, setting, seated_capacity, dim_unit, cost_basis)
    values (a, 'Real Venue A', 'banquet_hall', 'ac', 'indoor', 200, 'm', 'per_day'), (b, 'Real Venue B', 'banquet_hall', 'ac', 'indoor', 200, 'm', 'per_day');
  insert into public.dish_catalog(org_id, category, name, kind) values (a, 'Main', 'Real Dish A', 'veg'), (b, 'Main', 'Real Dish B', 'veg');
  insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes) values (a, 'gold', 'veg', 'Real Pkg A', 500, '[]'), (b, 'gold', 'veg', 'Real Pkg B', 500, '[]');
  insert into public.event_checklist(quote_id, section, title) values (qa, 'logistics', 'Real check A');
  insert into public.quote_payments(quote_id, provider, amount, status, paid_at) values (qa, 'cash', 1000, 'paid', now());
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- B seeds its own demo first (so we can prove A's clear never touches it)
do $$ begin
  perform pg_temp.login('b_admin@b.test'); perform public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.put('fpB', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001'));
  perform pg_temp.put('fpA', pg_temp.real_fp('a0000000-0000-4000-8000-000000000001'));
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture B', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- authz
do $$ declare e text; begin
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select public.seed_demo_data()');  perform pg_temp.res('01 staff cannot seed', e like '42501%', e);
  e := pg_temp.try('select public.clear_demo_data()'); perform pg_temp.res('02 staff cannot clear', e like '42501%', e);
  e := pg_temp.try('select public.reset_demo_data()'); perform pg_temp.res('03 staff cannot reset', e like '42501%', e);
  e := pg_temp.try('select public.set_trial_mode(''own'')'); perform pg_temp.res('04 staff cannot set trial mode', e like '42501%', e);
  perform pg_temp.res('05 staff can read demo status', (public.my_demo_status() ->> 'is_admin')::boolean = false);
  perform pg_temp.anon();
  e := pg_temp.try('select public.seed_demo_data()');  perform pg_temp.res('06 anon cannot seed', e like '42501%', e);
  e := pg_temp.try('select public.clear_demo_data()'); perform pg_temp.res('07 anon cannot clear', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _uf values ('0x authz', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- seed
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; r2 jsonb; n int; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.seed_demo_data();
  perform pg_temp.res('10 seed ok', (r ->> 'seeded')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('11 four demo events in four stages', (select count(distinct lifecycle_stage) from public.quotes where org_id = a and is_demo) = 4
    and (select count(*) from public.quotes where org_id = a and is_demo) = 4);
  perform pg_temp.res('12 confirmed wedding with an advance paid', exists (select 1 from public.quotes q join public.quote_payments p on p.quote_id = q.id
    where q.org_id = a and q.is_demo and q.status = 'confirmed' and p.status = 'paid' and p.is_demo and p.simulated));
  perform pg_temp.res('13 everything is marked Demo ·', not exists (select 1 from public.quotes where org_id = a and is_demo and title not like 'Demo · %')
    and not exists (select 1 from public.leads where org_id = a and is_demo and name not like 'Demo · %')
    and not exists (select 1 from public.crew_members where org_id = a and is_demo and name not like 'Demo · %'));
  perform pg_temp.res('14 every demo kind present', (select count(*) from public.venues where org_id = a and is_demo) = 2
    and (select count(*) from public.menu_templates where org_id = a and is_demo) = 1 and (select count(*) from public.dish_catalog where org_id = a and is_demo) = 8
    and (select count(*) from public.inventory_items where org_id = a and is_demo) = 6 and (select count(*) from public.vendors where org_id = a and is_demo) = 3
    and (select count(*) from public.layouts where org_id = a and is_demo) = 1 and (select count(*) from public.event_checklist where org_id = a and is_demo) = 6
    and (select count(*) from public.payment_milestones where org_id = a and is_demo) = 3);
  perform pg_temp.res('15 trial_mode = demo', (select trial_mode from public.organizations where id = a) = 'demo');
  perform pg_temp.res('16 real A rows unchanged by seed', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.res('17 every lead of a demo event is demo', not exists (select 1 from public.leads l join public.quotes q on q.id = l.quote_id where q.is_demo and not l.is_demo));
  select count(*) into n from public.quotes where org_id = a;
  perform pg_temp.login('a_admin@a.test');
  r2 := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('18 seeding twice is a no-op', (r2 ->> 'reason') = 'already_seeded' and (select count(*) from public.quotes where org_id = a) = n, r2::text);
  perform pg_temp.res('19 other studio untouched by seed', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001') = pg_temp.get('fpB'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x seed', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- the app can never flag / unflag
do $$ declare e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('update public.leads set is_demo = true where name = ''Real Lead A''');
  perform pg_temp.res('20 app cannot flag a real row as demo', e like '42501%', e);
  e := pg_temp.try('insert into public.vendors(name, kind, is_demo) values (''Sneaky'', ''vendor'', true)');
  perform pg_temp.res('21 app cannot insert a demo row', e like '42501%', e);
  e := pg_temp.try('update public.crew_members set is_demo = false where name like ''Demo · %''');
  perform pg_temp.res('22 app cannot unflag a demo row', e like '42501%', e);
  update public.vendors set name = 'Adopted Florist' where org_id = 'a0000000-0000-4000-8000-000000000001' and name = 'Demo · Gulmohar Florists';
  perform pg_temp.su();
  perform pg_temp.res('24 renaming a demo row away from "Demo ·" adopts it as real', exists (select 1 from public.vendors where name = 'Adopted Florist' and not is_demo));
  perform pg_temp.res('25 real package slot kept, demo package only fills a free slot',
    (select name from public.menu_templates where org_id = 'a0000000-0000-4000-8000-000000000001' and tier = 'gold' and diet = 'veg') = 'Real Pkg A');
  perform pg_temp.res('23 real lead still not demo', not (select is_demo from public.leads where name = 'Real Lead A'));
exception when others then perform pg_temp.su(); insert into _uf values ('2x guard', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- no messages / payments for demo
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; dq uuid; e text; r jsonb; tok uuid := gen_random_uuid(); st text; begin
  perform pg_temp.su();
  select id into dq from public.quotes where org_id = a and is_demo and status = 'confirmed';
  update public.quotes set approval_token = tok where id = (select id from public.quotes where org_id = a and is_demo and status = 'quote' limit 1);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, %L)', dq, '+91 90000 00301'));
  perform pg_temp.res('30 WhatsApp refused for a demo event', e like '42501%Demo%', e);
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, %L)', 'a0000000-0000-4000-8000-00000000da01', '+91 90000 00101'));
  perform pg_temp.res('31 WhatsApp refused for a demo contact number on a real event', e like '42501%Demo%', e);
  perform pg_temp.su();
  r := public.payment_link_begin(tok, 60);
  perform pg_temp.res('32 payment link refused for a demo event', r ->> 'reason' = 'demo_data', r::text);
  e := pg_temp.try(format('select public.otp_send_authorize(%L, %L)', tok, '9000000302'));
  perform pg_temp.res('33 approval OTP refused for a demo event', e like '42501%Demo%', e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.create_payment(%L)', tok));
  perform pg_temp.res('34 client payment refused for a demo event', e like '42501%Demo%', e);
  perform pg_temp.su();
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, dedupe_key) values (a, dq, 'pay_reminder', 'whatsapp', '919000000301', 'demo-test-1')
    returning status into st;
  perform pg_temp.res('35 demo outbox row stored as skipped', st = 'skipped', st);
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, dedupe_key) values (a, 'a0000000-0000-4000-8000-00000000da01', 'pay_reminder', 'whatsapp', '919848011111', 'demo-test-2')
    returning status into st;
  perform pg_temp.res('36 real outbox row still pending', st = 'pending', st);
  perform pg_temp.res('37 gates keep their callers', has_function_privilege('authenticated', 'public.whatsapp_authorize(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid,text)', 'execute')
    and has_function_privilege('anon', 'public.create_payment(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.whatsapp_authorize__pre0097(uuid,text)', 'execute'));
  delete from public.comms_outbox where dedupe_key like 'demo-test-%';
exception when others then perform pg_temp.su(); insert into _uf values ('3x gates', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- a REAL event uses demo staff + a demo item; then clear
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  c uuid; i uuid; r jsonb; begin
  perform pg_temp.su();
  select id into c from public.crew_members where org_id = a and is_demo order by name limit 1;
  select id into i from public.inventory_items where org_id = a and is_demo order by name limit 1;
  insert into public.event_tasks(quote_id, category, title, crew_id, org_id) values (qa, 'setup', 'Real task with demo crew', c, a);
  insert into public.inventory_reservations(item_id, quote_id, qty, org_id) values (i, qa, 2, a);
  perform pg_temp.put('crew', c::text); perform pg_temp.put('item', i::text);
  perform pg_temp.put('fpA', pg_temp.real_fp(a));
  perform pg_temp.login('a_admin@a.test');
  r := public.clear_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('40 clear ok', (r ->> 'cleared')::boolean and (r ->> 'quotes')::int = 4, r::text);
  perform pg_temp.res('41 REAL rows of A byte-for-byte unchanged', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.res('42 studio B (real + demo) untouched', pg_temp.all_fp('b0000000-0000-4000-8000-000000000001') = pg_temp.get('fpB'));
  perform pg_temp.res('43 no demo events / leads / layouts left in A', not exists (select 1 from public.quotes where org_id = a and is_demo)
    and not exists (select 1 from public.leads where org_id = a and is_demo) and not exists (select 1 from public.layouts where org_id = a and is_demo)
    and not exists (select 1 from public.quote_payments where org_id = a and is_demo));
  perform pg_temp.res('44 demo staff used by a real event kept (inactive), link intact',
    exists (select 1 from public.crew_members where id = pg_temp.get('crew')::uuid and not active)
    and exists (select 1 from public.event_tasks where quote_id = qa and crew_id = pg_temp.get('crew')::uuid));
  perform pg_temp.res('45 demo item reserved by a real event kept, reservation intact',
    exists (select 1 from public.inventory_items where id = pg_temp.get('item')::uuid)
    and exists (select 1 from public.inventory_reservations where quote_id = qa and item_id = pg_temp.get('item')::uuid));
  perform pg_temp.res('46 unused demo masters deleted', (select count(*) from public.crew_members where org_id = a and is_demo) = 1
    and (select count(*) from public.inventory_items where org_id = a and is_demo) = 1
    and not exists (select 1 from public.vendors where org_id = a and is_demo) and not exists (select 1 from public.menu_templates where org_id = a and is_demo));
  perform pg_temp.res('47 demo venues switched off, never deleted', (select count(*) from public.venues where org_id = a and is_demo and not active) = 2);
  perform pg_temp.res('48 real payment of the real event still there', exists (select 1 from public.quote_payments where quote_id = qa and status = 'paid' and amount = 1000));
  perform pg_temp.res('4a adopted vendor survives clear', exists (select 1 from public.vendors where name = 'Adopted Florist'));
  perform pg_temp.res('49 trial_mode = own after clear', (select trial_mode from public.organizations where id = a) = 'own');
exception when others then perform pg_temp.su(); insert into _uf values ('4x clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- reset (clear + seed) and B's own clear
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; r jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.reset_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('50 reset re-seeds', (r #>> '{seeded,seeded}')::boolean and (select count(*) from public.quotes where org_id = a and is_demo) = 4, r::text);
  perform pg_temp.res('51 reset re-uses demo venues (no pile-up)', (select count(*) from public.venues where org_id = a and is_demo) = 2
    and (select count(*) from public.venues where org_id = a and is_demo and active) = 2);
  perform pg_temp.res('52 real rows of A unchanged by reset', pg_temp.real_fp(a) = pg_temp.get('fpA'));
  perform pg_temp.res('53 B still untouched after A reset', pg_temp.all_fp(b) = pg_temp.get('fpB'));
  perform pg_temp.put('fpA2', pg_temp.all_fp(a));
  perform pg_temp.put('fpBreal', pg_temp.real_fp(b));
  perform pg_temp.login('b_admin@b.test');
  r := public.clear_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('54 B clear removes only B demo', not exists (select 1 from public.quotes where org_id = b and is_demo) and pg_temp.real_fp(b) = pg_temp.get('fpBreal'));
  perform pg_temp.res('55 A untouched by B clear', pg_temp.all_fp(a) = pg_temp.get('fpA2'));
  perform pg_temp.login('a_admin@a.test');
  r := public.set_trial_mode('own');
  perform pg_temp.res('56 keep demo + start onboarding', r ->> 'trial_mode' = 'own' and (r ->> 'has_demo')::boolean, r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('5x reset', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DEMO-0097: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DEMO-0097: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
