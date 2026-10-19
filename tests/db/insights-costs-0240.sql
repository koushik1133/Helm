-- insights-costs-0240.sql -- 0240 insights_event_costs: access (insights + finance), tenant scope, the cost split
-- adds up to event_pnl, classification of cost lines, guests / type / collected / outstanding. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;

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

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid; bk uuid := gen_random_uuid(); bt uuid := gen_random_uuid();
  e1 uuid := 'a0000000-0000-4000-8000-0000000240e1'; e5 uuid := 'a0000000-0000-4000-8000-0000000240e5';
begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'ic_viewer@a.test'), auth.seed_user('ic_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'ic_viewer@a.test', 'Costs Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'insights', true, false, a, now());
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id) values
    (e1, 'IC-1', 'Costs One', 'Wedding', 'confirmed', 'closed', '2026-05-10', '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', '{"guests":"200"}', a),
    ('a0000000-0000-4000-8000-0000000240e2', 'IC-2', 'Cancelled', 'Wedding', 'cancelled', 'quote', '2026-05-20', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', '{}', a),
    ('a0000000-0000-4000-8000-0000000240e3', 'IC-3', 'Open quote', 'Birthday', 'quote', 'quote', '2026-05-25', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000}', '{}', a),
    ('a0000000-0000-4000-8000-0000000240e4', 'IC-4', 'Out of range', 'Wedding', 'confirmed', 'planning', '2026-07-01', '{"subtotal":999999,"discount":0,"gstPct":0,"total":999999}', '{}', a),
    (e5, 'IC-5', 'Costs Five', 'Birthday', 'confirmed', 'planning', '2026-05-15', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000}', '{"guests":"80"}', a);
  insert into public.quotes(id, code, title, status, event_date, pricing, org_id, deleted_at) values
    ('a0000000-0000-4000-8000-0000000240e6', 'IC-6', 'Deleted', 'confirmed', '2026-05-11', '{"subtotal":444444,"discount":0,"gstPct":0,"total":444444}', a, now());
  insert into public.quotes(id, code, title, status, event_date, pricing, org_id) values
    ('b0000000-0000-4000-8000-0000000240e1', 'ICB-1', 'B event', 'confirmed', '2026-05-12', '{"subtotal":777777,"discount":0,"gstPct":0,"total":777777}', b);
  insert into public.change_requests(quote_id, title, price_delta, cost_delta, status, org_id) values
    (e1, 'extra', 10000, 2000, 'approved', a), (e1, 'pending', 99999, 99999, 'requested', a);
  insert into public.event_resources(id, quote_id, label, cost, status, org_id) values
    (bk, e1, 'DJ', 5000, 'booked', a), (bt, e1, 'Tent', 3000, 'booked', a),
    (gen_random_uuid(), e1, 'Cancelled band', 88888, 'cancelled', a);
  insert into public.event_costs(quote_id, description, category, kind, estimated, actual, booking_id, org_id) values
    (e1, 'DJ', 'Vendor', 'vendor', 5000, null, bk, a),
    (e1, 'Loose vendor line', 'Vendor', 'vendor', 2500, null, null, a),
    (e1, 'Transport truck', null, 'internal', 6000, null, null, a),
    (e1, 'Waiters', 'Staff', 'internal', 7000, 7500, null, a),
    (e1, 'Chair rental', null, 'other', 3000, null, null, a),
    (e1, 'Decor flowers', 'Decor', 'internal', 10000, null, null, a);
  insert into public.vendor_bills(quote_id, amount, description, org_id) values (e1, 4000, 'loose bill', a);
  insert into public.expense_claims(quote_id, who, amount, status, org_id) values (e1, 'x', 1000, 'paid', a), (e1, 'x', 500, 'pending', a);
  insert into public.event_refunds(quote_id, kind, amount, status, org_id) values (e1, 'refund', 1500, 'processed', a), (e1, 'refund', 999, 'pending', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id) values
    (e1, 60000, 'paid', '2026-05-05 10:00+05:30', a), (e1, 7000, 'failed', null, a);
  insert into public.payment_milestones(quote_id, label, amount, status, org_id) values (e5, 'Advance', 5000, 'paid', a), (e5, 'Balance', 15000, 'due', a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; e text; x jsonb; y jsonb; pnl jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('01 security definer + search_path empty',
    (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.insights_event_costs(date,date)'::regprocedure));
  perform pg_temp.res('02 anon no, authenticated yes',
    not has_function_privilege('anon', 'public.insights_event_costs(date,date)', 'execute')
    and has_function_privilege('authenticated', 'public.insights_event_costs(date,date)', 'execute'));
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.insights_event_costs('2026-05-01', '2026-05-31')$q$);
  perform pg_temp.res('03 anon refused', e <> '', e);
  perform pg_temp.login('a_staff@a.test');   -- sales: finance but no insights area
  e := pg_temp.try($q$select public.insights_event_costs('2026-05-01', '2026-05-31')$q$);
  perform pg_temp.res('04 role without insights area refused (42501)', e like '42501%', e);
  perform pg_temp.login('ic_viewer@a.test');   -- insights, no finance
  r := public.insights_event_costs('2026-05-01', '2026-05-31');
  perform pg_temp.res('05 insights without finance: no money, empty list', (r ->> 'finance')::boolean = false and jsonb_array_length(r -> 'events') = 0, r::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.insights_event_costs('2026-05-31', '2026-05-01')$q$);
  perform pg_temp.res('06 reversed range refused', e like '22023%', e);
  r := public.insights_event_costs('2026-05-01', '2026-05-31');
  perform pg_temp.res('07 only confirmed, in range, not deleted, own studio (IC-1, IC-5 by date)',
    jsonb_array_length(r -> 'events') = 2 and r #>> '{events,0,code}' = 'IC-1' and r #>> '{events,1,code}' = 'IC-5', r ->> 'events');
  perform pg_temp.res('08 tenant scope: studio B event never listed', position('ICB-1' in r::text) = 0 and position('777777' in r::text) = 0);
  select v into x from jsonb_array_elements(r -> 'events') v where v ->> 'code' = 'IC-1';
  select v into y from jsonb_array_elements(r -> 'events') v where v ->> 'code' = 'IC-5';
  -- r21: once 0246 (event money ledger) has re-issued insights_event_costs (x.rules = 'r21') the split follows the
  -- 0246 ledger (r21-money-0246.sql checks its numbers); here only the invariants that must hold either way.
  if x ->> 'rules' = 'r21' then
    perform pg_temp.res('09 vendors = one source per booking + larger loose source', (x ->> 'vendors')::numeric >= 12000, x::text);
    perform pg_temp.res('10 logistics / crew (actual over estimate) / rentals classified',
      (x ->> 'logistics')::numeric = 6000 and (x ->> 'crew')::numeric = 7500 and (x ->> 'rentals')::numeric >= 3000, x::text);
    perform pg_temp.res('11 change orders + other + expense claims (paid only) + refunds (processed only)',
      (x ->> 'change_orders')::numeric = 2000 and (x ->> 'refunds')::numeric = 1500 and (x ->> 'expense_claims')::numeric >= 1000, x::text);
    perform pg_temp.res('12 parts add up to cost_total; revenue - cost_total = profit',
      (x ->> 'vendors')::numeric + (x ->> 'crew')::numeric + (x ->> 'logistics')::numeric + (x ->> 'rentals')::numeric
      + (x ->> 'change_orders')::numeric + (x ->> 'other_costs')::numeric + (x ->> 'expense_claims')::numeric + (x ->> 'refunds')::numeric
      + coalesce((x ->> 'wages')::numeric, 0) + coalesce((x ->> 'damages')::numeric, 0) = (x ->> 'cost_total')::numeric
      and (x ->> 'revenue')::numeric = 110000 and (x ->> 'revenue')::numeric - (x ->> 'cost_total')::numeric = (x ->> 'profit')::numeric, x::text);
  else
  -- vendors: DJ line 5000 + Tent booking 3000 + max(loose bill 4000, loose vendor line 2500) = 12000
  perform pg_temp.res('09 vendors = one source per booking + larger loose source', (x ->> 'vendors')::numeric = 12000, x::text);
  perform pg_temp.res('10 logistics / crew (actual over estimate) / rentals classified',
    (x ->> 'logistics')::numeric = 6000 and (x ->> 'crew')::numeric = 7500 and (x ->> 'rentals')::numeric = 3000, x::text);
  perform pg_temp.res('11 change orders + other + expense claims (paid only) + refunds (processed only)',
    (x ->> 'change_orders')::numeric = 2000 and (x ->> 'other_costs')::numeric = 10000
    and (x ->> 'expense_claims')::numeric = 1000 and (x ->> 'refunds')::numeric = 1500, x::text);
  perform pg_temp.res('12 parts add up to cost_total; revenue - cost_total = profit',
    (x ->> 'cost_total')::numeric = 43000
    and (x ->> 'vendors')::numeric + (x ->> 'crew')::numeric + (x ->> 'logistics')::numeric + (x ->> 'rentals')::numeric
      + (x ->> 'change_orders')::numeric + (x ->> 'other_costs')::numeric + (x ->> 'expense_claims')::numeric + (x ->> 'refunds')::numeric = 43000
    and (x ->> 'revenue')::numeric = 110000 and (x ->> 'profit')::numeric = 67000 and (x ->> 'margin_pct')::numeric = 61, x::text);
  end if;
  pnl := public.event_pnl('a0000000-0000-4000-8000-0000000240e1');
  perform pg_temp.res('13 profit equals event_pnl net_profit (one profit everywhere)',
    (pnl ->> 'net_profit')::numeric = (x ->> 'profit')::numeric and (pnl ->> 'revenue')::numeric = (x ->> 'revenue')::numeric, pnl::text);
  perform pg_temp.res('14 guests (client), event type, collected from ledger, outstanding',
    (x ->> 'guests')::int = 200 and x ->> 'event_type' = 'Wedding' and (x ->> 'collected')::numeric = 60000
    and (x ->> 'outstanding')::numeric = 50000 and x ->> 'currency' = 'INR', x::text);
  perform pg_temp.res('15 no ledger: collected from paid milestones; guests from client; no costs = 100%',
    (y ->> 'collected')::numeric = 5000 and (y ->> 'outstanding')::numeric = 15000 and (y ->> 'guests')::int = 80
    and (y ->> 'cost_total')::numeric = 0 and (y ->> 'margin_pct')::numeric = 100, y::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.insights_event_costs('2026-05-01', '2026-05-31');
  perform pg_temp.res('16 studio B sees only its own event', jsonb_array_length(r -> 'events') = 1 and r #>> '{events,0,code}' = 'ICB-1', r::text);
  r := public.insights_event_costs(null, null);
  perform pg_temp.res('17 open range works', (r ->> 'finance')::boolean and jsonb_array_length(r -> 'events') >= 1);
  perform pg_temp.su();
  perform pg_temp.res('18 read-only: no rows changed by the calls',
    (select count(*) from public.event_costs where quote_id = 'a0000000-0000-4000-8000-0000000240e1') = 6
    and (select count(*) from public.quotes where code like 'IC-%') = 6);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'INSIGHTS-COSTS-0240: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'INSIGHTS-COSTS-0240: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
