-- capacity-shortage-0197.sql - behavioral proof for 0197.
-- Over-capacity decision: stored only through set_quote_capacity_decision (quotes edit + own studio,
-- shape checked, venue / item / vendor of the caller's studio only), never by a direct app update.
-- Stock shortage: reserve_inventory_with_sourcing reserves only what is free on the event date (live
-- reservations + still-out check-outs, other events' same-day demand), records the shortfall as a
-- stock request (+ a vendor booking with cost = shortfall x rate for 'vendor'), never over-commits;
-- tenant + role gates; cross-studio references refused. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _cap(name text, result text); grant all on _cap to anon, authenticated;
-- earlier suites in run-all re-apply older migrations: re-run 0197 (also proves a re-run is safe)
\i supabase/migrations/0197_capacity_and_stock_shortage.sql

do $$ declare a_admin uuid; a_staff uuid; b_admin uuid;
  org uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; qB uuid := 'b0000000-0000-4000-8000-00000000da01';
  qY uuid := gen_random_uuid(); qZ uuid := gen_random_uuid(); qN uuid := gen_random_uuid();
  cooler uuid; tent uuid; itemB uuid; ven uuid; venB uuid; hall uuid; hallB uuid;
  j jsonb; e text; n numeric; cnt int; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_admin from auth.users where email='b_admin@b.test';
  insert into public.inventory_items(name, total_qty, category, unit, org_id) values ('CAP Air Cooler / Fan', 20, 'Cooling', 'pcs', org) returning id into cooler;
  insert into public.inventory_items(name, total_qty, category, unit, org_id) values ('CAP Tent 20x20', 4, 'Tents & Canopies', 'pcs', org) returning id into tent;
  insert into public.inventory_items(name, total_qty, category, org_id) values ('CAP B item', 10, 'Cooling', orgB) returning id into itemB;
  insert into public.vendors(name, category, kind, org_id) values ('CAP Cool Rentals', 'Cooling', 'vendor', org) returning id into ven;
  insert into public.vendors(name, category, kind, org_id) values ('CAP B vendor', 'Cooling', 'vendor', orgB) returning id into venB;
  insert into public.venues(name, seated_capacity, floating_capacity, org_id) values ('CAP Grounds', 40000, 10000, org) returning id into hall;
  insert into public.venues(name, seated_capacity, org_id) values ('CAP B hall', 100, orgB) returning id into hallB;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_date) values
    (qY, 'CAP-Y', 'Event Y', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date + 40),
    (qZ, 'CAP-Z', 'Event Z', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date + 40),
    (qN, 'CAP-N', 'Event N', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date + 80);

  -- ---- 0) shape ----
  insert into _cap values ('00 new columns are nullable', case when (select count(*) from information_schema.columns where table_schema='public'
    and ((table_name='quotes' and column_name='capacity_decision') or (table_name='event_stock_requests' and column_name in ('source','booking_id','vendor_id')))
    and is_nullable='YES') = 4 then 'PASS' else 'FAIL' end);
  insert into _cap values ('01 both functions SECURITY DEFINER with pinned search_path', case when (select count(*) from pg_proc
    where proname in ('set_quote_capacity_decision','reserve_inventory_with_sourcing') and pronamespace='public'::regnamespace and prosecdef
      and proconfig::text like '%search_path=%') = 2 then 'PASS' else 'FAIL' end);
  insert into _cap values ('02 anon cannot call either function', case when not has_function_privilege('anon','public.set_quote_capacity_decision(uuid,jsonb)','execute')
    and not has_function_privilege('anon','public.reserve_inventory_with_sourcing(uuid,uuid,numeric,text,text,uuid,numeric,text)','execute') then 'PASS' else 'FAIL' end);
  insert into _cap values ('03 app has no column grant on quotes.capacity_decision', case when not has_column_privilege('authenticated','public.quotes','capacity_decision','UPDATE')
    then 'PASS' else 'FAIL' end);
  insert into _cap values ('04 org-match triggers on the new references', case when (select count(*) from pg_trigger where tgrelid='public.event_stock_requests'::regclass
    and tgname in ('zz_ref_org_match_booking_id','zz_ref_org_match_vendor_id') and not tgisinternal) = 2 then 'PASS' else 'FAIL' end);

  -- ---- 1) capacity decision ----
  perform auth.login_as(a_admin);
  j := public.set_quote_capacity_decision(qA, jsonb_build_object('choice','proceed','note','Client accepts standing room','guests',60000,'capacity',50000,'venue_id',hall,'venue_name','CAP Grounds'));
  insert into _cap values ('10 proceed with a note is stored with who / when', case when j->>'choice'='proceed' and (j->>'guests')::int=60000
    and j->>'decided_by'=a_admin::text and j ? 'decided_at' and j->>'venue_id'=hall::text then 'PASS' else 'FAIL: '||coalesce(j::text,'null') end);
  insert into _cap values ('11 the quote row holds the decision', case when (select capacity_decision->>'note' from public.quotes where id=qA)='Client accepts standing room' then 'PASS' else 'FAIL' end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, '{"choice":"proceed","guests":60000}'); exception when others then e := sqlstate; end;
  insert into _cap values ('12 proceed without a note refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, '{"choice":"ignore","guests":60000,"note":"whatever"}'); exception when others then e := sqlstate; end;
  insert into _cap values ('13 unknown choice refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, '{"choice":"extend","guests":60000,"capacity":50000,"line":{"label":"Tent","qty":2,"rate":1000}}'); exception when others then e := sqlstate; end;
  insert into _cap values ('14 extend without extra capacity refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  j := public.set_quote_capacity_decision(qA, jsonb_build_object('choice','extend','guests',60000,'capacity',50000,'extra_capacity',10000,'venue_id',hall,
    'line', jsonb_build_object('label','Overflow tent','qty',2,'rate',75000,'source','inventory','item_id',tent)));
  insert into _cap values ('15 extend stores the line with amount = qty x rate', case when j->>'choice'='extend' and (j->>'extra_capacity')::int=10000
    and (j->'line'->>'amount')::numeric=150000 and j->'line'->>'item_id'=tent::text then 'PASS' else 'FAIL: '||coalesce(j::text,'null') end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, jsonb_build_object('choice','extend','guests',60000,'extra_capacity',10000,
    'line', jsonb_build_object('label','Tent','qty',1,'rate',1,'source','vendor','vendor_id',venB))); exception when others then e := sqlstate; end;
  insert into _cap values ('16 another studio''s vendor refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, jsonb_build_object('choice','proceed','note','ok fine','guests',10,'venue_id',hallB)); exception when others then e := sqlstate; end;
  insert into _cap values ('17 another studio''s venue refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, jsonb_build_object('choice','extend','guests',60000,'extra_capacity',10000,
    'line', jsonb_build_object('label','Tent','qty',1,'rate',1,'source','inventory','item_id',itemB))); exception when others then e := sqlstate; end;
  insert into _cap values ('18 another studio''s item refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qB, '{"choice":"proceed","note":"cross studio","guests":5}'); exception when others then e := sqlstate; end;
  insert into _cap values ('19 another studio''s quote refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin update public.quotes set capacity_decision = '{"choice":"proceed"}' where id = qA; exception when others then e := sqlstate; end;
  insert into _cap values ('20 direct app update of the column refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.set_quote_capacity_decision(qA, '{"choice":"proceed","note":"x","guests":"60000; drop"}'); exception when others then e := sqlstate; end;
  insert into _cap values ('21 malformed guests refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(b_admin);
  e := ''; begin perform public.set_quote_capacity_decision(qA, '{"choice":"proceed","note":"intruder","guests":5}'); exception when others then e := sqlstate; end;
  insert into _cap values ('22 studio B admin cannot write studio A''s quote', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_admin);
  j := public.set_quote_capacity_decision(qA, null);
  insert into _cap values ('23 null clears the decision', case when (select capacity_decision from public.quotes where id=qA) is null then 'PASS' else 'FAIL' end);

  -- ---- 2) reserve with sourcing ----
  j := public.reserve_inventory_with_sourcing(cooler, qY, 30, 'main hall', 'vendor', ven, 500, 'deliver by 4 pm');
  insert into _cap values ('30 30 asked, 20 free: reserves 20, short 10', case when (j->>'reserved')::numeric=20 and (j->>'short')::numeric=10 and (j->>'available')::numeric=20
    then 'PASS' else 'FAIL: '||j::text end);
  insert into _cap values ('31 reservation row holds only the free 20', case when (select sum(qty) from public.inventory_reservations where item_id=cooler and quote_id=qY)=20 then 'PASS' else 'FAIL' end);
  insert into _cap values ('32 vendor booking: enquiry, qty 10, cost 10 x 500', case when exists (select 1 from public.event_resources where id=(j->>'booking_id')::uuid
    and quote_id=qY and vendor_id=ven and status='enquiry' and qty=10 and cost=5000 and note like '%stock shortfall%deliver by 4 pm%') then 'PASS' else 'FAIL' end);
  insert into _cap values ('33 shortage request: source vendor, linked booking + vendor, open', case when exists (select 1 from public.event_stock_requests
    where id=(j->>'request_id')::uuid and quote_id=qY and item_id=cooler and qty=10 and status='requested' and source='vendor'
      and booking_id=(j->>'booking_id')::uuid and vendor_id=ven and label like 'Short: 10 x CAP Air Cooler%' and note like 'Sourcing from CAP Cool Rentals%') then 'PASS' else 'FAIL' end);
  j := public.reserve_inventory_with_sourcing(cooler, qZ, 5, null, 'none', null, null, null);
  insert into _cap values ('34 same date, nothing free: reserves 0, short 5, no reservation row', case when (j->>'reserved')::numeric=0 and (j->>'short')::numeric=5
    and not (j ? 'reservation_id') and not exists (select 1 from public.inventory_reservations where item_id=cooler and quote_id=qZ) then 'PASS' else 'FAIL: '||j::text end);
  insert into _cap values ('35 unsourced shortage recorded', case when exists (select 1 from public.event_stock_requests where id=(j->>'request_id')::uuid and source='none'
    and booking_id is null and vendor_id is null and note like 'Unsourced%') then 'PASS' else 'FAIL' end);
  select coalesce(sum(r.qty),0) into n from public.inventory_reservations r join public.quotes q on q.id=r.quote_id
    where r.item_id=cooler and r.status in ('reserved','allocated') and q.event_date=current_date + 40;
  insert into _cap values ('36 committed on that date never above stock (20 of 20)', case when n=20 then 'PASS' else 'FAIL: '||n end);
  j := public.reserve_inventory_with_sourcing(cooler, qN, 12, null, 'buy', null, null, 'buy 2 locally');
  insert into _cap values ('37 another date: all 12 fit, no shortage written', case when (j->>'reserved')::numeric=12 and (j->>'short')::numeric=0
    and not (j ? 'request_id') then 'PASS' else 'FAIL: '||j::text end);
  perform auth.logout(); execute 'reset role';
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, org_id) values (cooler, null, 5, 'Crew loose', org);
  perform auth.login_as(a_admin);
  j := public.reserve_inventory_with_sourcing(cooler, qN, 6, null, 'buy', null, null, 'buy locally');
  insert into _cap values ('38 still-out check-outs count: 20 - 12 - 5 = 3 free, short 3 (buy)', case when (j->>'reserved')::numeric=3 and (j->>'short')::numeric=3
    and exists (select 1 from public.event_stock_requests where id=(j->>'request_id')::uuid and source='buy' and note like 'Outsource / buy - buy locally') then 'PASS' else 'FAIL: '||j::text end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 4, null, 'vendor', venB, 10, null); exception when others then e := sqlstate; end;
  insert into _cap values ('39 another studio''s vendor refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 4, null, 'vendor', null, 10, null); exception when others then e := sqlstate; end;
  insert into _cap values ('40 vendor source without a vendor refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 2.5, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('41 fractional quantity refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 0, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('42 zero quantity refused', case when e='22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qB, 1, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('43 another studio''s event refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.reserve_inventory_with_sourcing(itemB, qY, 1, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('44 another studio''s item refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin insert into public.event_stock_requests(quote_id, label, qty, source, vendor_id) values (qY, 'x', 1, 'vendor', venB); exception when others then e := sqlstate; end;
  insert into _cap values ('45 direct request pointing at another studio''s vendor refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin insert into public.event_stock_requests(quote_id, label, qty, source) values (qY, 'x', 1, 'steal'); exception when others then e := sqlstate; end;
  insert into _cap values ('46 unknown source refused by the check', case when e='23514' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(a_staff);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 1, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('47 role without inventory edit refused', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); execute 'reset role';
  perform auth.login_as(b_admin);
  e := ''; begin perform public.reserve_inventory_with_sourcing(cooler, qY, 1, null, 'none', null, null, null); exception when others then e := sqlstate; end;
  insert into _cap values ('48 studio B admin cannot reserve studio A stock', case when e='42501' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); execute 'reset role';
  select count(*) into cnt from public.event_stock_requests where quote_id in (qY, qZ, qN);
  insert into _cap values ('49 exactly 3 shortage rows written (vendor, none, buy)', case when cnt=3 then 'PASS' else 'FAIL: '||cnt end);
exception when others then execute 'reset role'; insert into _cap values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _cap order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'CAPACITY-SHORTAGE-0197: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'CAPACITY-SHORTAGE-0197: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _cap;
rollback;
