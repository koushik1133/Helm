-- r24-stock-0268.sql -- 0268: ONE stock story per item on an event - Reserved -> Out (given to a person) -> Back /
-- Missing / Damaged. Mark back (OK + damaged, rest missing, written off once), event-day "Issued" really gives stock
-- out (check-out against inventory, same free-stock rule), reservations follow their stock (released when back /
-- never taken out after the event day), free-stock maths no longer double-counts written-off missing units, and
-- the closure checklist blocks only on stock that went Out and did not come Back. Roles + tenants. Rolled back.
-- Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _dr(name text, result text); grant all on _dr to anon, authenticated, service_role;
create temp table _dk(k text primary key, v text); grant all on _dk to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _dr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _dk values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _dk where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid, p_name text default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, p_email, p_name, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, full_name = excluded.full_name;
  return u;
end $$;
create or replace function pg_temp.g(p_k text) returns uuid language sql as $$ select v::uuid from _dk where k = p_k $$;
grant execute on function pg_temp.g(text) to anon, authenticated, service_role;
create or replace function pg_temp.inv(p_q uuid, p_item uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(public._r22_close_checks(p_q, 'a0000000-0000-4000-8000-000000000001') -> 'inventory') x
   where x ->> 'item_id' = p_item::text $$;
create or replace function pg_temp.chk(p_q uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(public._r22_close_checks(p_q, 'a0000000-0000-4000-8000-000000000001') -> 'checks') x
   where x ->> 'key' = 'inventory' $$;

-- ---- setup --------------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qP uuid := gen_random_uuid(); qT uuid := gen_random_uuid(); qF uuid := gen_random_uuid(); qC uuid := gen_random_uuid();
  chairs uuid; mics uuid; lights uuid; crew uuid; v_today date; begin
  perform pg_temp.member('st_coord@a.test', 'coordinator', a, 'Ravi Coordinator');
  perform pg_temp.member('st_crew@a.test', 'crew', a, 'Crew Person');
  perform pg_temp.su();
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (a, 'coordinator', 'command', true, true, now()), (a, 'coordinator', 'inventory', true, false, now()),
    (a, 'coordinator', 'closure', true, false, now()),
    (a, 'crew', 'command', true, false, now()), (a, 'crew', 'inventory', true, false, now()), (a, 'crew', 'closure', false, false, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  v_today := public._a198_org_today(a);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_date) values
    (qP, 'ST-P', 'Past wedding', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', a, v_today - 1),
    (qT, 'ST-T', 'Today party', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', a, v_today),
    (qF, 'ST-F', 'Future gala', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', a, v_today + 10),
    (qC, 'ST-C', 'Closure test', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', a, v_today - 2);
  insert into public.inventory_items(name, total_qty, category, org_id) values ('ST Chairs', 100, 'Seating', a) returning id into chairs;
  insert into public.inventory_items(name, total_qty, category, org_id) values ('ST Mics', 10, 'Sound', a) returning id into mics;
  insert into public.inventory_items(name, total_qty, category, org_id) values ('ST Lights', 30, 'Lighting', a) returning id into lights;
  insert into public.crew_members(name, phone, org_id) values ('Suresh Crew', '+919800000001', a) returning id into crew;
  perform pg_temp.put('qP', qP::text); perform pg_temp.put('qT', qT::text); perform pg_temp.put('qF', qF::text); perform pg_temp.put('qC', qC::text);
  perform pg_temp.put('chairs', chairs::text); perform pg_temp.put('mics', mics::text); perform pg_temp.put('lights', lights::text);
  perform pg_temp.put('crew', crew::text);
end $$;

-- ---- the migration, twice (safe to re-run) -------------------------------------------------------------------------
\ir ../../supabase/migrations/0268_stock_one_flow.sql
\ir ../../supabase/migrations/0268_stock_one_flow.sql

-- ---- 0) structure + grants -----------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 new columns: qty_damaged (default 0) + event_stock_requests.checkout_id (FK)',
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_checkouts'
            and column_name = 'qty_damaged' and column_default = '0' and is_nullable = 'NO')
    and exists (select 1 from pg_constraint where conname = 'event_stock_requests_checkout_fk_0268'));
  perform pg_temp.res('02 RPCs signed-in only; helpers private',
    has_function_privilege('authenticated', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
    and not has_function_privilege('anon', 'public.checkin_stock(uuid,numeric,numeric,text)', 'execute')
    and has_function_privilege('authenticated', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.issue_stock_request(uuid,text,uuid,text,boolean)', 'execute')
    and not has_function_privilege('anon', 'public.release_unused_stock(uuid,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r24_release(uuid,uuid,uuid,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r24_not_back(numeric,numeric,numeric,numeric)', 'execute'));
  perform pg_temp.res('03 no table privilege change: the app still cannot write check-outs directly',
    not has_table_privilege('authenticated', 'public.inventory_checkouts', 'delete'));
end $$;

-- ---- 1) mark back: OK + damaged, the rest missing ------------------------------------------------------------------
do $$ declare j jsonb; co uuid; e text; r public.inventory_checkouts; begin
  perform pg_temp.su();
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (pg_temp.g('chairs'), pg_temp.g('qP'), 20, 'reserved', 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test');
  j := public.checkout_equipment_smart(pg_temp.g('chairs'), pg_temp.g('qP'), 20, 'Suresh Crew', pg_temp.g('crew'), null, false);
  co := (j ->> 'checkout_id')::uuid; perform pg_temp.put('co1', co::text);
  e := pg_temp.err(format('select public.checkin_stock(%L, 15, 6, null)', co));
  perform pg_temp.res('10 OK + damaged more than went out is refused', e like '22023%', e);
  e := pg_temp.err(format('select public.checkin_stock(%L, -1, 0, null)', co));
  perform pg_temp.res('11 negative is refused', e like '22023%', e);
  e := pg_temp.err(format('select public.checkin_stock(%L, 1.5, 0, null)', co));
  perform pg_temp.res('12 half units are refused', e like '22023%', e);
  j := public.checkin_stock(co, 17, 2, 'Asha');
  select * into r from public.inventory_checkouts where id = co;
  perform pg_temp.res('13 17 OK + 2 damaged of 20 -> 1 missing; qty_in 19, damaged 2, written off 3, status partial',
    (j ->> 'missing')::numeric = 1 and r.qty_in = 19 and r.qty_damaged = 2 and r.written_off = 3 and r.status = 'partial'
    and r.returned_by = 'Asha' and r.checked_in_at is not null, j::text);
  perform pg_temp.res('14 missing + damaged taken off what you own exactly once (100 -> 97)',
    (select total_qty from public.inventory_items where id = pg_temp.g('chairs')) = 97);
  e := pg_temp.err(format('select public.checkin_stock(%L, 1, 0, null)', co));
  perform pg_temp.res('15 marking back twice is refused (no second write-off)', e like 'P0001%Already marked back%'
    and (select total_qty from public.inventory_items where id = pg_temp.g('chairs')) = 97, e);
  perform pg_temp.res('16 the event''s reservation follows its stock: released once everything is back (event day has come)',
    (select status from public.inventory_reservations where quote_id = pg_temp.g('qP') and item_id = pg_temp.g('chairs')) = 'returned'
    and (select note from public.inventory_reservations where quote_id = pg_temp.g('qP') and item_id = pg_temp.g('chairs')) like '%Back - released automatically%');
  -- free-stock maths: the written-off missing unit is not also counted as still out
  j := public.checkout_availability(pg_temp.g('chairs'), pg_temp.g('qF'));
  perform pg_temp.res('17 free on another date = 97 (was 96: the missing unit counted twice)', (j ->> 'available')::numeric = 97
    and (j ->> 'out_now')::numeric = 0 and jsonb_array_length(j -> 'blocking') = 0, j::text);
  -- a cancelled check-out
  j := public.checkout_equipment_smart(pg_temp.g('lights'), pg_temp.g('qP'), 3, 'Suresh Crew', null, null, false);
  perform public.cancel_checkout((j ->> 'checkout_id')::uuid, 'typo');
  e := pg_temp.err(format('select public.checkin_stock(%L, 3, 0, null)', j ->> 'checkout_id'));
  perform pg_temp.res('18 a cancelled check-out cannot be marked back', e like 'P0001%cancelled%', e);
  -- everything back OK
  j := public.checkout_equipment_smart(pg_temp.g('lights'), pg_temp.g('qP'), 4, 'Suresh Crew', null, null, false);
  j := public.checkin_stock((j ->> 'checkout_id')::uuid, 4, 0, null);
  perform pg_temp.res('19 all back OK -> status returned, nothing written off', j ->> 'status' = 'returned' and (j ->> 'written_off')::numeric = 0
    and (select total_qty from public.inventory_items where id = pg_temp.g('lights')) = 30, j::text);
  perform pg_temp.su();
end $$;

-- ---- 2) reservations: never taken out -> released after the event day ---------------------------------------------
do $$ declare j jsonb; e text; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values
    (pg_temp.g('mics'), pg_temp.g('qP'), 5, 'reserved', a),
    (pg_temp.g('lights'), pg_temp.g('qP'), 2, 'allocated', a),     -- given out before names were recorded (no check-out for mics? lights has one)
    (pg_temp.g('mics'), pg_temp.g('qT'), 2, 'reserved', a),
    (pg_temp.g('mics'), pg_temp.g('qF'), 3, 'reserved', a),
    (pg_temp.g('mics'), pg_temp.g('qC'), 4, 'allocated', a);
  perform pg_temp.login('st_crew@a.test');
  e := pg_temp.err(format('select public.release_unused_stock(%L, false)', pg_temp.g('qP')));
  perform pg_temp.res('20 crew (view only) cannot release', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.err(format('select public.release_unused_stock(%L, false)', pg_temp.g('qP')));
  perform pg_temp.res('21 another studio cannot release this event', e like '42501%', e);
  perform pg_temp.login('st_coord@a.test');                       -- command edit is enough
  j := public.release_unused_stock(pg_temp.g('qP'), false);
  perform pg_temp.su();
  perform pg_temp.res('22 past event: reserved-never-out released ("Released - never taken out")',
    (select status from public.inventory_reservations where quote_id = pg_temp.g('qP') and item_id = pg_temp.g('mics')) = 'returned'
    and (select note from public.inventory_reservations where quote_id = pg_temp.g('qP') and item_id = pg_temp.g('mics')) = 'Released - never taken out', j::text);
  perform pg_temp.res('23 lights (given out + all back) also released', (select status from public.inventory_reservations
    where quote_id = pg_temp.g('qP') and item_id = pg_temp.g('lights')) = 'returned');
  perform pg_temp.login('a_admin@a.test');
  j := public.release_unused_stock(pg_temp.g('qT'), false);
  perform pg_temp.res('24 today''s event: not released without include_today', (j ->> 'released')::int = 0
    and (select status from public.inventory_reservations where quote_id = pg_temp.g('qT')) = 'reserved', j::text);
  j := public.release_unused_stock(pg_temp.g('qT'), true);
  perform pg_temp.res('25 today''s event with include_today (Teardown): released', (j ->> 'released')::int = 1, j::text);
  j := public.release_unused_stock(pg_temp.g('qF'), true);
  perform pg_temp.res('26 future event: never released', (j ->> 'released')::int = 0
    and (select status from public.inventory_reservations where quote_id = pg_temp.g('qF')) = 'reserved', j::text);
  j := public.release_unused_stock(pg_temp.g('qC'), true);
  perform pg_temp.res('27 allocated with no check-out (given out, no name) is never auto-released', (j ->> 'released')::int = 0
    and (select status from public.inventory_reservations where quote_id = pg_temp.g('qC')) = 'allocated', j::text);
  -- future event: given out and back before the event day -> reservation kept
  j := public.checkout_equipment_smart(pg_temp.g('mics'), pg_temp.g('qF'), 3, 'Suresh Crew', null, null, false);
  perform public.checkin_stock((j ->> 'checkout_id')::uuid, 3, 0, null);
  perform pg_temp.res('28 back before the event day: the reservation is kept', (select status from public.inventory_reservations
    where quote_id = pg_temp.g('qF')) = 'reserved');
  perform pg_temp.su();
end $$;

-- ---- 3) event-day command: Issued = a real check-out ----------------------------------------------------------------
do $$ declare j jsonb; e text; rq uuid; rq2 uuid; rq3 uuid; rq4 uuid; rq5 uuid; n int; begin
  perform pg_temp.login('st_coord@a.test');
  insert into public.event_stock_requests(quote_id, item_id, label, qty) values (pg_temp.g('qT'), pg_temp.g('chairs'), 'ST Chairs', 5) returning id into rq;
  insert into public.event_stock_requests(quote_id, item_id, label, qty) values (pg_temp.g('qT'), pg_temp.g('chairs'), 'ST Chairs', 1000) returning id into rq2;
  insert into public.event_stock_requests(quote_id, item_id, label, qty) values (pg_temp.g('qT'), null, 'Extension cord', 2) returning id into rq3;
  insert into public.event_stock_requests(quote_id, item_id, label, qty, status) values (pg_temp.g('qT'), pg_temp.g('mics'), 'ST Mics', 1, 'cancelled') returning id into rq4;
  perform pg_temp.su();
  insert into public.event_stock_requests(quote_id, item_id, label, qty, source, org_id) values (pg_temp.g('qT'), pg_temp.g('chairs'), 'Short: 10 x ST Chairs', 10, 'buy', 'a0000000-0000-4000-8000-000000000001') returning id into rq5;
  perform pg_temp.login('st_crew@a.test');
  e := pg_temp.err(format('select public.issue_stock_request(%L, %L)', rq, 'Suresh'));
  perform pg_temp.res('30 crew (command view only) cannot give stock out', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.err(format('select public.issue_stock_request(%L, %L)', rq, 'Suresh'));
  perform pg_temp.res('31 another studio cannot give out this request', e like '42501%', e);
  perform pg_temp.login('st_coord@a.test');
  e := pg_temp.err(format('select public.issue_stock_request(%L, %L)', rq, '  '));
  perform pg_temp.res('32 "who is it given to" is required', e like '22023%', e);
  j := public.issue_stock_request(rq, 'Suresh Crew', pg_temp.g('crew'), 'stage left', false);
  perform pg_temp.su();
  perform pg_temp.res('33 coordinator (command edit, no inventory edit) gives 5 chairs out: a real check-out, linked',
    (j ->> 'ok')::boolean and (j ->> 'from_stock')::boolean
    and exists (select 1 from public.inventory_checkouts c where c.id = (j ->> 'checkout_id')::uuid and c.item_id = pg_temp.g('chairs')
                and c.quote_id = pg_temp.g('qT') and c.qty_out = 5 and c.status = 'out' and c.issued_to = 'Suresh Crew'
                and c.issued_to_id = pg_temp.g('crew') and c.note like 'stage left | From event-day stock request%')
    and (select status = 'issued' and checkout_id = (j ->> 'checkout_id')::uuid from public.event_stock_requests where id = rq), j::text);
  perform pg_temp.put('co_rq', j ->> 'checkout_id');
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('34 inventory counts stay in sync: 5 fewer chairs free (97 -> 92)', (public.checkout_availability(pg_temp.g('chairs'), null) ->> 'available')::numeric = 92);
  perform pg_temp.login('st_coord@a.test');
  j := public.issue_stock_request(rq, 'Someone else', null, null, false);
  select count(*) into n from public.inventory_checkouts where quote_id = pg_temp.g('qT') and item_id = pg_temp.g('chairs');
  perform pg_temp.res('35 pressing Issued again gives nothing out twice', (j ->> 'already')::boolean and n = 1, j::text);
  j := public.issue_stock_request(rq2, 'Suresh Crew', null, null, false);
  perform pg_temp.res('36 more than is free: a shortage answer, nothing written', (j ->> 'ok')::boolean = false and j ->> 'code' = 'shortage'
    and (j ->> 'available')::numeric = 92 and (select status from public.event_stock_requests where id = rq2) = 'requested', j::text);
  j := public.issue_stock_request(rq2, 'Suresh Crew', null, null, true);
  perform pg_temp.res('37 "give what is free": 92 out, short by 908 noted', (j ->> 'qty_out')::numeric = 92 and (j ->> 'shortfall')::numeric = 908
    and (select note from public.inventory_checkouts where id = (j ->> 'checkout_id')::uuid) like 'Short by 908%', j::text);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('38 never negative: 0 chairs free now', (public.checkout_availability(pg_temp.g('chairs'), null) ->> 'available')::numeric = 0);
  perform pg_temp.login('st_coord@a.test');
  j := public.issue_stock_request(rq3, 'Suresh Crew', null, null, false);
  perform pg_temp.res('39 a typed item (not in stock) is only marked given', (j ->> 'from_stock')::boolean = false
    and (select status = 'issued' and checkout_id is null from public.event_stock_requests where id = rq3), j::text);
  e := pg_temp.err(format('select public.issue_stock_request(%L, %L)', rq4, 'Suresh'));
  perform pg_temp.res('40 a cancelled request cannot be given out', e like 'P0001%cancelled%', e);
  e := pg_temp.err(format('select public.issue_stock_request(%L, %L)', rq5, 'Suresh'));
  perform pg_temp.res('41 a rent / buy shortage row is not given out of stock', e like 'P0001%Sourced%', e);
  -- coordinator marks the event stock back (command edit on an event check-out)
  j := public.checkin_stock(pg_temp.g('co_rq'), 5, 0, 'Ravi');
  perform pg_temp.res('42 coordinator can mark event stock back', j ->> 'status' = 'returned', j::text);
  perform pg_temp.su();
  perform pg_temp.login('st_crew@a.test');
  e := pg_temp.err(format('select public.checkin_stock(%L, 1, 0, null)', (select id from public.inventory_checkouts where quote_id = pg_temp.g('qT') and status = 'out' limit 1)));
  perform pg_temp.res('43 crew (view only) cannot mark back', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.err(format('select public.checkin_stock(%L, 1, 0, null)', (select id from public.inventory_checkouts where quote_id = pg_temp.g('qT') and status = 'out' limit 1)));
  perform pg_temp.res('44 another studio cannot see or mark back the check-out', e like '42501%', e);
  perform pg_temp.su();
end $$;

-- ---- 4) closure checklist: only Out-and-not-Back blocks ------------------------------------------------------------
do $$ declare j jsonb; c jsonb; co uuid; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  -- qC: mics allocated (no name, see above) + chairs reserved-never-out + lights given out
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (pg_temp.g('lights'), pg_temp.g('qC'), 6, 'reserved', a);
  update public.inventory_items set total_qty = 100 where id = pg_temp.g('chairs');
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (pg_temp.g('chairs'), pg_temp.g('qC'), 10, 'reserved', a);
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, org_id) values (pg_temp.g('lights'), pg_temp.g('qC'), 6, 'Suresh Crew', a) returning id into co;
  c := pg_temp.chk(pg_temp.g('qC'));
  perform pg_temp.res('50 stock Out and not back blocks (admin), the no-name one is mentioned', c ->> 'status' = 'fail' and c ->> 'override' = 'admin'
    and c ->> 'label' = 'All stock back' and c ->> 'detail' like 'Out and not back yet: 6 (and 4 given out with no name recorded)%', c::text);
  j := pg_temp.inv(pg_temp.g('qC'), pg_temp.g('chairs'));
  perform pg_temp.res('51 reserved but never taken out: not a blocker (state reserved, ok)', j ->> 'status' = 'ok' and j ->> 'state' = 'reserved'
    and (j ->> 'reserved_unused')::numeric = 10 and (j ->> 'reserved_open')::numeric = 0, j::text);
  j := pg_temp.inv(pg_temp.g('qC'), pg_temp.g('lights'));
  perform pg_temp.res('52 lights: state out, fail', j ->> 'state' = 'out' and j ->> 'status' = 'fail' and (j ->> 'still_out')::numeric = 6, j::text);
  perform pg_temp.login('a_admin@a.test');
  perform public.checkin_stock(co, 4, 1, null);
  perform pg_temp.su();
  c := pg_temp.chk(pg_temp.g('qC'));
  perform pg_temp.res('53 lights back: only the no-name mics block now (any approver)', c ->> 'status' = 'fail' and c ->> 'override' = 'any'
    and c ->> 'detail' like 'Given out (no name recorded) and not marked back: 4%', c::text);
  j := pg_temp.inv(pg_temp.g('qC'), pg_temp.g('lights'));
  perform pg_temp.res('54 per item: out 6, back 4, damaged 1, missing 1, state missing (warn)', (j ->> 'checked_out')::numeric = 6
    and (j ->> 'back')::numeric = 4 and (j ->> 'damaged')::numeric = 1 and (j ->> 'missing')::numeric = 1 and j ->> 'state' = 'missing'
    and j ->> 'status' = 'warn', j::text);
  perform pg_temp.res('55 lights reservation released by the check-in (event day over)', (select status from public.inventory_reservations
    where quote_id = pg_temp.g('qC') and item_id = pg_temp.g('lights')) = 'returned');
  update public.inventory_reservations set status = 'returned' where quote_id = pg_temp.g('qC') and item_id = pg_temp.g('mics');
  c := pg_temp.chk(pg_temp.g('qC'));
  perform pg_temp.res('56 nothing out any more: warn (1 missing, 1 damaged) - reserved-never-out chairs do not block', c ->> 'status' = 'warn'
    and c ->> 'detail' like '%1 missing, 1 damaged%', c::text);
  perform pg_temp.res('57 counts carry reserved_unused + damaged', ((public._r22_close_checks(pg_temp.g('qC'), a) -> 'counts') ->> 'reserved_unused')::numeric = 10
    and ((public._r22_close_checks(pg_temp.g('qC'), a) -> 'counts') ->> 'damaged')::numeric = 1);
  perform pg_temp.res('58 0049 server gate unchanged: nothing with status out -> not blocked by stock',
    coalesce((public._a49_close_blockers(pg_temp.g('qC')) ->> 'open_checkouts')::numeric, -1) = 0);
end $$;

-- ---- 5) old check-in path still releases (crew link / checkin_equipment) -------------------------------------------
do $$ declare j jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (pg_temp.g('chairs'), pg_temp.g('qP'), 2, 'reserved', a);
  perform pg_temp.login('a_admin@a.test');
  j := public.checkout_equipment_smart(pg_temp.g('chairs'), pg_temp.g('qP'), 2, 'Suresh Crew', null, null, false);
  perform public.checkin_equipment((j ->> 'checkout_id')::uuid, 2, 'Asha', false);
  perform pg_temp.su();
  perform pg_temp.res('60 checkin_equipment (old path) also releases the reservation', not exists (select 1 from public.inventory_reservations
    where quote_id = pg_temp.g('qP') and status in ('reserved', 'allocated')));
end $$;

select name, result from _dr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R24-STOCK-0268: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R24-STOCK-0268: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _dr;
rollback;
