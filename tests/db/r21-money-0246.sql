-- r21-money-0246.sql -- 0246: one cost ledger per event (Estimated / Committed / Actual per category), staff wages
-- from crew x day rate + attendance, no double count, GST split on vendor bills, refunds ex-GST, legacy closed
-- events keep their numbers, finance gating, admin-only day rates, tenant isolation. The migration is applied
-- twice. Rolled back. Local disposable PG only.
--
-- Fixture event (studio A, quote A-0001: 2,36,000 incl. 18% GST = 2,00,000 + 36,000):
--   approved change order: client pays 11,800 (10,000 + 1,800 GST), extra cost 4,000
--   processed refund 11,800 (= 10,000 revenue + 1,800 GST)          -> revenue ex-GST 2,10,000, net revenue 2,00,000
--   booking "Royal Caterers" (catering) confirmed, cost 60,000; bill 70,800 incl. GST 10,800 (food: GST blocked)
--   booking "Sound & lights" booked, cost 50,000; bill 59,000 incl. GST 9,000 (claimable)  -> cost 50,000, ITC 9,000
--   booking "Stage decor" enquiry, cost 30,000, its budget line estimate 25,000, no actual
--   unlinked bill 10,000 (no GST split) + unlinked vendor line "Transport" est 8,000 -> the bill counts (larger)
--   budget lines: std:staff "Staff & crew" est 2,000 (typed); std:contingency est 5,000 (plan only)
--   crew: Ravi 1,200 accepted + arrived; Sita 1,500 assigned, no-show; Ajay no rate, not marked; Meena 1,000 roster only, arrived
--   expense claims: pending 500, approved 700, paid 300, rejected 900
--   write-off: 2 x chair (item cost 250) = 500
-- Expected (r21): est 1,57,700 / committed 1,15,700 / expected 1,66,000 / actual 1,34,500; margin expected 34,000;
--   accuracy floor(134500/166000*100) = 81; legacy (0146) net profit 22,100.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rm(name text, result text); grant all on _rm to anon, authenticated, service_role;
create temp table _rkv(k text primary key, v text); grant all on _rkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rm values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.n(p jsonb, p_k text) returns numeric language sql as $$ select (p ->> p_k)::numeric $$;
grant execute on function pg_temp.n(jsonb, text) to anon, authenticated, service_role;
create or replace function pg_temp.cat(p jsonb, p_cat text, p_k text) returns numeric language sql as $$
  select (c ->> p_k)::numeric from jsonb_array_elements(p -> 'by_category') c where c ->> 'key' = p_cat $$;
grant execute on function pg_temp.cat(jsonb, text, text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
-- every money row as one hash: proves the migration never rewrites a row
create or replace function pg_temp.rows_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(k)::text, ',' order by k.id) from public.event_costs k), '')
          || coalesce((select string_agg(to_jsonb(b)::text, ',' order by b.id) from public.vendor_bills b), '')
          || coalesce((select string_agg(to_jsonb(r)::text, ',' order by r.id) from public.event_resources r), '')
          || coalesce((select string_agg(to_jsonb(e)::text, ',' order by e.id) from public.expense_claims e), '')) $$;

-- ---- setup -----------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  bk1 uuid; bk2 uuid; bk3 uuid; v1 uuid; v2 uuid; c1 uuid; c2 uuid; c3 uuid; c4 uuid; it uuid; bl uuid; ln uuid;
begin
  perform pg_temp.member('rm_coord@a.test', 'coordinator', a);   -- no finance
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = current_date - 3 where id in (q, qb);
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Royal Caterers', 'Catering', a) returning id into v1;
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Bright Sound', 'Sound & lights', a) returning id into v2;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, contract, org_id)
    values (gen_random_uuid(), q, v1, 'catering', 'Royal Caterers', 60000, 'confirmed', true, a) returning id into bk1;
  insert into public.event_resources(id, quote_id, vendor_id, kind, label, cost, status, org_id)
    values (gen_random_uuid(), q, v2, 'sound', 'Sound & lights', 50000, 'booked', a) returning id into bk2;
  insert into public.event_resources(id, quote_id, kind, label, cost, status, org_id)
    values (gen_random_uuid(), q, 'decor', 'Stage decor', 30000, 'enquiry', a) returning id into bk3;
  insert into public.event_costs(quote_id, description, kind, estimated, booking_id, org_id) values (q, 'Stage decor', 'vendor', 25000, bk3, a);
  insert into public.vendor_bills(quote_id, booking_id, vendor_id, amount, gst_amount, org_id) values (q, bk1, v1, 70800, 10800, a);
  insert into public.vendor_bills(quote_id, booking_id, vendor_id, amount, gst_amount, org_id) values (q, bk2, v2, 59000, 9000, a) returning id into bl;
  insert into public.vendor_payouts(bill_id, amount, org_id) values (bl, 20000, a);
  insert into public.vendor_bills(quote_id, amount, description, org_id) values (q, 10000, 'Truck hire', a);
  insert into public.event_costs(quote_id, description, kind, estimated, org_id) values (q, 'Transport', 'vendor', 8000, a);
  insert into public.event_costs(id, quote_id, description, kind, estimated, requirement_key, org_id)
    values (gen_random_uuid(), q, 'Staff & crew', 'internal', 2000, 'std:staff', a) returning id into ln;
  perform pg_temp.put('staffline', ln::text);
  insert into public.event_costs(quote_id, description, kind, estimated, requirement_key, org_id) values (q, 'Contingency (5%)', 'internal', 5000, 'std:contingency', a);
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ravi', '+919800000001', 1200, a) returning id into c1;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Sita', '+919800000002', 1500, a) returning id into c2;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ajay', '+919800000003', null, a) returning id into c3;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Meena', '+919800000004', 1000, a) returning id into c4;
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Load in', c1, 'accepted', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Chairs', c1, 'completed', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Welcome desk', c2, 'assigned', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Lights', c3, 'assigned', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Old task', c2, 'cancelled', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Ravi', c1, 'arrived', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Sita', c2, 'no_show', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Ajay', c3, 'expected', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Meena', c4, 'arrived', a);
  insert into public.event_day(quote_id, kind, who, ref_id, status, org_id) values (q, 'arrival', 'Royal Caterers', bk1, 'arrived', a);
  insert into public.expense_claims(quote_id, who, description, amount, status, org_id) values
    (q, 'Ravi', 'Fuel', 500, 'pending', a), (q, 'Sita', 'Food', 700, 'approved', a), (q, 'Ravi', 'Auto', 300, 'paid', a), (q, 'Ajay', 'Tips', 900, 'rejected', a);
  insert into public.change_requests(quote_id, title, price_delta, cost_delta, status, org_id) values (q, 'Photo booth', 11800, 4000, 'approved', a);
  insert into public.change_requests(quote_id, title, price_delta, cost_delta, status, org_id) values (q, 'Fireworks', 50000, 30000, 'requested', a);
  insert into public.event_refunds(quote_id, kind, amount, status, org_id) values (q, 'refund', 11800, 'processed', a);
  insert into public.event_refunds(quote_id, kind, amount, status, org_id) values (q, 'recovery', 2000, 'processed', a);
  insert into public.inventory_items(id, name, total_qty, unit_cost, org_id) values (gen_random_uuid(), 'Chiavari chair', 100, 250, a) returning id into it;
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, qty_in, written_off, status, org_id) values (it, q, 20, 'Ravi', 18, 2, 'returned', a);
  -- studio B: one crew member + a bill on its own event (must never show in A)
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'B crew', '+919800000009', 9999, b) returning id into c1;
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (qb, 'setup', 'B task', c1, 'accepted', b);
  insert into public.vendor_bills(quote_id, amount, org_id) values (qb, 7777, b);
  perform pg_temp.put('h0', pg_temp.rows_hash());
  perform pg_temp.put('cut0', coalesce((select effective_at::text from public.helm_money_rules where rule = 'r21-ledger'), 'none'));
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/0246_event_money_ledger.sql
\ir ../../supabase/migrations/0246_event_money_ledger.sql

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 applied twice: no money row rewritten, the rules marker written once and never moved',
    pg_temp.rows_hash() = pg_temp.get('h0')
    and (select count(*) from public.helm_money_rules where rule = 'r21-ledger') = 1
    and (pg_temp.get('cut0') = 'none' or pg_temp.get('cut0') = (select effective_at::text from public.helm_money_rules where rule = 'r21-ledger')),
    pg_temp.get('cut0'));
  perform pg_temp.res('02 0146 body kept as _vb_event_pnl__pre0246; wrapper + RPCs present; new columns nullable / defaulted',
    to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)') is not null
    and position('aud1017' in (select prosrc from pg_proc where oid = to_regprocedure('public._vb_event_pnl__pre0246(uuid,uuid)'))) > 0
    and position('r21-money-0246' in (select prosrc from pg_proc where oid = to_regprocedure('public._vb_event_pnl(uuid,uuid)'))) > 0
    and to_regprocedure('public.event_cost_breakdown(uuid)') is not null and to_regprocedure('public.studio_cost_breakdown(date,date)') is not null
    and (select bool_and(not crew_covered) from public.event_costs)
    and (select bool_and(gst_claimable is null) from public.vendor_bills));
end $$;

-- ---- admin of studio A: the full picture ---------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m jsonb; p jsonb; s text; begin
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  perform pg_temp.put('m_admin', m::text);
  perform pg_temp.res('03 revenue ex-GST incl. change order 2,10,000; refund ex-GST 10,000 (GST 1,800); net revenue 2,00,000',
    pg_temp.n(m, 'revenue') = 210000 and pg_temp.n(m, 'tax') = 37800 and pg_temp.n(m, 'refunds_ex_tax') = 10000
    and pg_temp.n(m, 'refunds_tax') = 1800 and pg_temp.n(m, 'net_revenue') = 200000, m::text);
  perform pg_temp.res('04 four totals: estimated 1,57,700 / committed 1,15,700 / expected 1,66,000 / actual 1,34,500',
    pg_temp.n(m, 'cost_estimated') = 157700 and pg_temp.n(m, 'cost_committed') = 115700
    and pg_temp.n(m, 'cost_expected') = 166000 and pg_temp.n(m, 'cost_actual') = 134500,
    format('est %s com %s exp %s act %s', m ->> 'cost_estimated', m ->> 'cost_committed', m ->> 'cost_expected', m ->> 'cost_actual'));
  perform pg_temp.res('05 margins shown apart: estimated 42,300 / expected 34,000 / actual 65,500; accuracy 81%; gross = net (no overhead yet)',
    pg_temp.n(m, 'margin_estimated') = 42300 and pg_temp.n(m, 'margin_expected') = 34000 and pg_temp.n(m, 'margin_actual') = 65500
    and pg_temp.n(m, 'accuracy_pct') = 81 and pg_temp.n(m, 'gross_margin') = 34000 and pg_temp.n(m, 'net_margin') = 34000
    and pg_temp.n(m, 'overhead') = 0 and pg_temp.n(m, 'net_margin_pct') = 17, m::text);
  perform pg_temp.res('06 G1 staff wages: estimate 3,700 (rate x 1 day), expected = actual 2,200 (arrived only; no-show 0; missing rate 0)',
    pg_temp.cat(m, 'staff', 'estimated') = 3700 + 2000 and pg_temp.n(m, 'cost_wages') = 2200
    and (select (l ->> 'c_act')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Sita') = 0
    and (select (l ->> 'c_fc')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Sita') = 0
    and (select (l ->> 'committed')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Ravi') = 1200
    and (select l ->> 'committed' from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Meena') is null
    and (select (l ->> 'actual')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Meena') = 1000
    and (select count(*) from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 4,
    (m -> 'by_category')::text);
  perform pg_temp.res('07 a vendor arrival row is not a crew wage; a cancelled task does not add a person',
    not exists (select 1 from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew' and l ->> 'label' = 'Royal Caterers'));
  perform pg_temp.res('08 GST split: catering bill counts 70,800 (food GST 10,800 blocked); sound bill counts 50,000 (9,000 input tax)',
    (select (l ->> 'actual')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Royal Caterers' and l ->> 'source' = 'booking') = 70800
    and (select (l ->> 'actual')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Sound & lights') = 50000
    and pg_temp.n(m, 'input_tax') = 9000 and pg_temp.n(m, 'blocked_gst') = 10800
    and pg_temp.cat(m, 'food', 'actual') = 70800 and pg_temp.cat(m, 'rentals', 'actual') = 50000, m::text);
  perform pg_temp.res('09 GST unknown: the unlinked bill without a split counts as-is (10,000) and is flagged',
    (select (l ->> 'c_act')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'bill') = 10000
    and (select l ->> 'gst_status' from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'bill') = 'unknown'
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'gst_unknown' and (w ->> 'count')::int = 1 and (w ->> 'amount')::numeric = 10000));
  perform pg_temp.res('10 no double count: unlinked bill 10,000 vs unlinked vendor line 8,000 -> bill counts, line is plan-only (est 8,000, expected 0)',
    (select (l ->> 'c_fc')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Transport') = 0
    and (select (l ->> 'c_est')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Transport') = 8000);
  perform pg_temp.res('11 booking with a budget line + no bill: one line (est 25,000 from the line, enquiry -> not committed, no actual)',
    (select count(*) from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Stage decor') = 1
    and (select (l ->> 'c_fc')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Stage decor') = 25000
    and (select l ->> 'committed' from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Stage decor') is null
    and pg_temp.cat(m, 'decor', 'actual') = 0);
  perform pg_temp.res('12 contingency is plan-only; expense claims: pending = committed, approved + paid = actual, rejected ignored',
    pg_temp.cat(m, 'contingency', 'estimated') = 5000 and pg_temp.cat(m, 'contingency', 'expected') = 0
    and pg_temp.n(m, 'cost_claims') = 1500 and pg_temp.cat(m, 'misc', 'actual') = 1000 and pg_temp.cat(m, 'misc', 'committed') = 500
    and not exists (select 1 from jsonb_array_elements(m -> 'lines') l where l ->> 'label' like '%Tips%'));
  perform pg_temp.res('13 approved change cost 4,000 committed (requested one ignored); write-off 2 x 250 = 500 actual in Damages',
    pg_temp.cat(m, 'changes', 'committed') = 4000 and pg_temp.cat(m, 'changes', 'actual') = 0
    and pg_temp.cat(m, 'damages', 'actual') = 500 and pg_temp.cat(m, 'damages', 'expected') = 500);
  perform pg_temp.res('14 warnings: 1 crew without a rate, 1 not marked, staff double count risk on the typed staff line',
    exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'crew_rate_missing' and (w ->> 'count')::int = 1)
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'attendance_not_marked' and (w ->> 'count')::int = 1)
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'staff_double_count' and (w ->> 'amount')::numeric = 2000)
    and exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'estimate_only' and (w ->> 'amount')::numeric = 31500), (m -> 'warnings')::text);
  perform pg_temp.res('15 every category adds up: sum(by_category.expected) = cost_expected; variance = expected - estimated',
    (select sum((c ->> 'expected')::numeric) from jsonb_array_elements(m -> 'by_category') c) = pg_temp.n(m, 'cost_expected')
    and (select sum((c ->> 'estimated')::numeric) from jsonb_array_elements(m -> 'by_category') c) = pg_temp.n(m, 'cost_estimated')
    and (select bool_and((c ->> 'variance')::numeric = (c ->> 'expected')::numeric - (c ->> 'estimated')::numeric) from jsonb_array_elements(m -> 'by_category') c));
  perform pg_temp.res('16 admin sees per-person crew lines with day rates',
    (select (l ->> 'day_rate')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'label' = 'Ravi') = 1200
    and not (m ->> 'pay_private')::boolean);
  perform pg_temp.res('17 event_pnl old keys still add up: net_profit 34,000 = revenue - vendors - other - staff - refunds; legacy kept beside',
    p ->> 'rules' = 'r21' and pg_temp.n(p, 'net_profit') = 34000 and pg_temp.n(p, 'vendors') = 155800 and pg_temp.n(p, 'other') = 6500
    and pg_temp.n(p, 'staff') = 3700 and pg_temp.n(p, 'refunds') = 10000
    and pg_temp.n(p, 'revenue') - pg_temp.n(p, 'vendors') - pg_temp.n(p, 'other') - pg_temp.n(p, 'staff') - pg_temp.n(p, 'refunds') = pg_temp.n(p, 'net_profit')
    and pg_temp.n(p, 'legacy_net_profit') = 22100 and pg_temp.n(p, 'margin_pct') = 16 and pg_temp.n(p, 'accuracy_pct') = 81, p::text);
  -- Insights per-event costs (0240 shape): crew includes the auto crew wages, parts add up to cost_total, profit = event_pnl
  s := pg_temp.j('select public.insights_event_costs(current_date - 30, current_date + 30)')::text;
  perform pg_temp.put('ins_admin', s);
  -- studio-wide (admin = business + insights)
  s := pg_temp.j('select public.studio_cost_breakdown(current_date - 30, current_date + 30)')::text;
  perform pg_temp.put('studio_admin', s);
end $$;
do $$ declare s jsonb := pg_temp.get('studio_admin')::jsonb; begin
  perform pg_temp.res('18 studio_cost_breakdown (admin): A''s event with the same numbers, INR totals = sum of the events, never studio B',
    (select (e ->> 'margin_expected')::numeric from jsonb_array_elements(s -> 'events') e where e ->> 'code' = 'A-0001') = 34000
    and (select (e -> 'by_category' -> 'staff' ->> 'actual')::numeric from jsonb_array_elements(s -> 'events') e where e ->> 'code' = 'A-0001') = 2200
    and (s -> 'totals' -> 'INR' ->> 'cost_expected')::numeric = (select sum((e ->> 'cost_expected')::numeric) from jsonb_array_elements(s -> 'events') e)
    and (s -> 'totals' -> 'INR' -> 'by_category' -> 'staff' ->> 'actual')::numeric
        = (select sum(coalesce((e -> 'by_category' -> 'staff' ->> 'actual')::numeric, 0)) from jsonb_array_elements(s -> 'events') e)
    and not exists (select 1 from jsonb_array_elements(s -> 'events') e where e ->> 'code' like 'B-%')
    and position('7777' in s::text) = 0 and position('B crew' in s::text) = 0, s::text);
end $$;

do $$ declare s jsonb := pg_temp.get('ins_admin')::jsonb; e jsonb; begin
  select x into e from jsonb_array_elements(s -> 'events') x where x ->> 'code' = 'A-0001';
  perform pg_temp.res('31 insights_event_costs: crew = wages 2,200 + typed staff line 2,000; claims 1,500 only; parts = cost_total; profit = event_pnl',
    (e ->> 'crew')::numeric = 4200 and (e ->> 'wages')::numeric = 2200 and (e ->> 'expense_claims')::numeric = 1500
    and (e ->> 'refunds')::numeric = 10000 and (e ->> 'profit')::numeric = 34000 and (e ->> 'cost_total')::numeric = 176000
    and (e ->> 'vendors')::numeric + (e ->> 'crew')::numeric + (e ->> 'logistics')::numeric + (e ->> 'rentals')::numeric
        + (e ->> 'change_orders')::numeric + (e ->> 'other_costs')::numeric + (e ->> 'expense_claims')::numeric + (e ->> 'refunds')::numeric
        = (e ->> 'cost_total')::numeric
    and (e ->> 'revenue')::numeric - (e ->> 'cost_total')::numeric = (e ->> 'profit')::numeric
    and not exists (select 1 from jsonb_array_elements(s -> 'events') x where x ->> 'code' like 'B-%'), coalesce(e::text, s::text));
end $$;

-- ---- the typed staff line, replaced by crew wages (ticked by a finance user through the table policy) ---------------
select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m jsonb; e text; begin
  e := pg_temp.try(format('update public.event_costs set crew_covered = true where id = %L', pg_temp.get('staffline')));
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('19 ticked "replaced by crew wages": the staff line counts 0 everywhere, no double-count warning',
    e = '' and pg_temp.n(m, 'cost_expected') = 164000 and pg_temp.n(m, 'cost_estimated') = 155700
    and (select (l ->> 'c_fc')::numeric + (l ->> 'c_est')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'source_id' = pg_temp.get('staffline')) = 0
    and not exists (select 1 from jsonb_array_elements(m -> 'warnings') w where w ->> 'code' = 'staff_double_count'), e || ' ' || m::text);
  perform pg_temp.res('20 non-admin with finance: ONE combined crew line, no names, no day rate anywhere',
    (select count(*) from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 1
    and (m ->> 'pay_private')::boolean and position('day_rate' in m::text) = 0 and position('Meena' in m::text) = 0
    and (select (l ->> 'c_act')::numeric from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 2200
    and pg_temp.cat(m, 'staff', 'actual') = 2200, m::text);
  perform pg_temp.res('21 non-admin without Business / Insights: studio_cost_breakdown + insights_event_costs refused (42501)',
    pg_temp.try('select public.studio_cost_breakdown(current_date - 30, current_date + 30)') like '42501%'
    and pg_temp.try('select public.insights_event_costs(current_date - 30, current_date + 30)') like '42501%');
  perform pg_temp.put('ins_x', 'x');
  perform pg_temp.res('22 internal helpers (_r21_event_money / _r21_cost_lines / _vb_event_pnl__pre0246) are not callable by the app',
    pg_temp.try(format('select public._r21_event_money(%L, %L, true)', q, 'a0000000-0000-4000-8000-000000000001')) like '42501%'
    and pg_temp.try(format('select public._vb_event_pnl__pre0246(%L, %L)', q, 'a0000000-0000-4000-8000-000000000001')) like '42501%'
    and pg_temp.try(format('select public._r21_cost_lines(%L, %L)', q, 'a0000000-0000-4000-8000-000000000001')) like '42501%');
end $$;

-- ---- access: no finance / other studio / anon -----------------------------------------------------------------------
select pg_temp.login('rm_coord@a.test');
do $$ begin
  perform pg_temp.res('23 a role without finance: event_cost_breakdown + event_pnl refused (42501)',
    pg_temp.try('select public.event_cost_breakdown(''a0000000-0000-4000-8000-00000000da01'')') like '42501%'
    and pg_temp.try('select public.event_pnl(''a0000000-0000-4000-8000-00000000da01'')') like '42501%');
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare m jsonb; begin
  m := pg_temp.j('select public.event_cost_breakdown(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('24 tenant isolation: studio B admin gets nothing for studio A''s event (event_cost_breakdown + event_pnl)',
    m is null and pg_temp.j('select public.event_pnl(''a0000000-0000-4000-8000-00000000da01'')') is null, coalesce(m::text, 'null'));
  m := pg_temp.j('select public.studio_cost_breakdown(current_date - 30, current_date + 30)');
  perform pg_temp.res('25 tenant isolation: studio B''s studio breakdown has only its own event and wages (9,999 estimate)',
    jsonb_array_length(m -> 'events') = 1 and m -> 'events' -> 0 ->> 'code' = 'B-0001'
    and (m -> 'events' -> 0 ->> 'cost_estimated')::numeric = 9999 and (m -> 'events' -> 0 ->> 'cost_actual')::numeric = 7777 and position('Ravi' in m::text) = 0, m::text);
end $$;
select pg_temp.anon();
do $$ begin
  perform pg_temp.res('26 anon: both RPCs refused',
    pg_temp.try('select public.event_cost_breakdown(''a0000000-0000-4000-8000-00000000da01'')') <> ''
    and pg_temp.try('select public.studio_cost_breakdown(null, null)') <> '');
end $$;

select pg_temp.login('a_admin@a.test');
do $$ declare e jsonb; begin
  select x into e from jsonb_array_elements(pg_temp.j('select public.insights_event_costs(current_date - 30, current_date + 30)') -> 'events') x
   where x ->> 'code' = 'A-0001';
  perform pg_temp.res('32 insights_event_costs after "replaced by crew wages": crew = the wages only (2,200), no double count',
    (e ->> 'crew')::numeric = 2200 and (e ->> 'cost_total')::numeric = 174000 and (e ->> 'profit')::numeric = 36000, coalesce(e::text, 'null'));
end $$;

-- ---- legacy: an event closed BEFORE the rules started keeps its recorded numbers --------------------------------------
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; p jsonb; m jsonb; begin
  perform pg_temp.su();
  update public.event_costs set crew_covered = false where id = pg_temp.get('staffline')::uuid;
  insert into public.event_closure(quote_id, closed_at, org_id)
    values (q, (select effective_at from public.helm_money_rules where rule = 'r21-ledger') - interval '1 day', 'a0000000-0000-4000-8000-000000000001')
    on conflict (quote_id) do update set closed_at = excluded.closed_at;
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; p jsonb; m jsonb; b jsonb; begin
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  b := pg_temp.j('select public.business_pnl(current_date - 30, current_date + 30)');
  perform pg_temp.res('27 legacy: closed before the rules -> every old key = the 0146 numbers (net 22,100), new figures only under r21',
    p ->> 'rules' = 'legacy' and pg_temp.n(p, 'net_profit') = 22100 and pg_temp.n(p, 'staff') = 300 and pg_temp.n(p, 'refunds') = 11800
    and pg_temp.n(p, 'vendors') = 164800 and pg_temp.n(p, 'other') = 11000 and (p -> 'r21' ->> 'net_profit')::numeric = 34000, p::text);
  perform pg_temp.res('28 legacy: the breakdown says legacy and carries the recorded net profit; Business keeps the recorded number',
    m ->> 'rules' = 'legacy' and (m -> 'legacy' ->> 'net_profit')::numeric = 22100
    and (b -> 'events' -> 0 ->> 'net_profit')::numeric = 22100 and b -> 'events' -> 0 ->> 'rules' = 'legacy', b::text);
end $$;
do $$ begin
  perform pg_temp.su();
  update public.event_closure set closed_at = now() + interval '1 minute' where quote_id = 'a0000000-0000-4000-8000-00000000da01';
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare p jsonb; begin
  p := pg_temp.j('select public.event_pnl(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('29 closed AFTER the rules started -> new rules (net 34,000)', p ->> 'rules' = 'r21' and pg_temp.n(p, 'net_profit') = 34000, p::text);
end $$;

-- ---- an event with nothing yet: no crash, no fake accuracy ----------------------------------------------------------------
select pg_temp.login('b_admin@b.test');
do $$ declare m jsonb; begin
  perform pg_temp.su();
  update public.event_tasks set status = 'cancelled' where quote_id = 'b0000000-0000-4000-8000-00000000da01';
  update public.vendor_bills set status = 'void', void_reason = 'test reset' where quote_id = 'b0000000-0000-4000-8000-00000000da01';
  perform pg_temp.login('b_admin@b.test');
  m := pg_temp.j('select public.event_cost_breakdown(''b0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('30 an event with no costs: totals 0, accuracy empty (not 100%), margin = net revenue, no lines',
    pg_temp.n(m, 'cost_expected') = 0 and m ->> 'accuracy_pct' is null and pg_temp.n(m, 'margin_expected') = pg_temp.n(m, 'net_revenue')
    and jsonb_array_length(m -> 'lines') = 0 and jsonb_array_length(m -> 'by_category') = 0, m::text);
end $$;

select pg_temp.su();
select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R21-MONEY-0246: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-MONEY-0246: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _rm;
rollback;
