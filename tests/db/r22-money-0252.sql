-- r22-money-0252.sql -- 0252: ONE rule for "staff on the event" = crew wage lines. A task that names a crew member
-- counts (as an Estimated wage) unless it is rejected / cancelled - also while its status is still 'unassigned'.
-- Proves: before (0246 body) the unassigned crew task was skipped; after 0252 (applied twice) the wage lines equal
-- the people the screens count (distinct crew_id on tasks that are not rejected / cancelled, + arrival roster);
-- the money everywhere (event_pnl / event_cost_breakdown / insights_event_costs) follows; "replaced by crew wages"
-- follows the same rule; no row rewritten; tenant isolation; admin-only pay; still internal. Rolled back.
-- Local disposable PG only.
--
-- Fixture (studio A, quote A-0001: 2,36,000 incl. 18% GST = 2,00,000 ex-tax, confirmed):
--   Ravi 1,200 accepted | Sita 1,500 assigned | Suresh 800 UNASSIGNED (crew set) | Dev 600 rejected + unassigned
--   Kiran 900 cancelled only | Raj 700 rejected only | a task with no crew member (name only, unassigned)
--   -> on the event: Ravi, Sita, Suresh, Dev = 4 people, wages 4,100 (0246 body: Ravi + Sita = 2, 2,700)
-- Studio B: one crew member (9,999) on an UNASSIGNED task + a staff budget line ticked "replaced by crew wages".
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
-- crew wage lines of one event (superuser view of the internal ledger)
create or replace function pg_temp.crew(p_q uuid, p_org uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(l order by l ->> 'label'), '[]'::jsonb)
    from jsonb_array_elements(coalesce(public._r21_cost_lines(p_q, p_org), '[]'::jsonb)) l where l ->> 'source' = 'crew' $$;
-- the people the screens count (store-api staff.forEvent / readiness, r22 rule): distinct crew on live tasks + roster
create or replace function pg_temp.people(p_q uuid, p_org uuid) returns bigint language sql as $$
  select count(*) from (
    select t.crew_id from public.event_tasks t join public.crew_members cm on cm.id = t.crew_id and cm.org_id = p_org
     where t.quote_id = p_q and t.org_id = p_org and t.status not in ('rejected', 'cancelled')
    union
    select d.ref_id from public.event_day d join public.crew_members cm on cm.id = d.ref_id and cm.org_id = p_org
     where d.quote_id = p_q and d.org_id = p_org and d.kind = 'arrival') p $$;
create or replace function pg_temp.rows_hash() returns text language sql as $$
  select md5(coalesce((select string_agg(to_jsonb(t)::text, ',' order by t.id) from public.event_tasks t), '')
          || coalesce((select string_agg(to_jsonb(k)::text, ',' order by k.id) from public.event_costs k), '')
          || coalesce((select string_agg(to_jsonb(c)::text, ',' order by c.id) from public.crew_members c), '')) $$;

-- ---- setup ---------------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid; cb uuid; ln uuid;
begin
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', lifecycle_stage = 'confirmed', event_date = current_date - 3 where id in (q, qb);
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Ravi', '+919800000101', 1200, a) returning id into c1;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Sita', '+919800000102', 1500, a) returning id into c2;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Suresh', '+919800000103', 800, a) returning id into c3;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Dev', '+919800000104', 600, a) returning id into c4;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Kiran', '+919800000105', 900, a) returning id into c5;
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'Raj', '+919800000106', 700, a) returning id into c6;
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Load in', c1, 'accepted', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Welcome desk', c2, 'assigned', a);
  insert into public.event_tasks(id, quote_id, category, title, crew_id, assignee_name, status, org_id)
    values (gen_random_uuid(), q, 'teardown', 'Pack and load rentals', c3, 'Suresh', 'unassigned', a) returning id into ln;
  perform pg_temp.put('suresh_task', ln::text);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Lights', c4, 'rejected', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Sound', c4, 'unassigned', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Old task', c5, 'cancelled', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (q, 'setup', 'Said no', c6, 'rejected', a);
  insert into public.event_tasks(quote_id, category, title, assignee_name, status, org_id) values (q, 'setup', 'Name only', 'Somebody', 'unassigned', a);
  -- studio B: its only crew task is unassigned + a staff line ticked "replaced by crew wages"
  insert into public.crew_members(id, name, phone, day_rate, org_id) values (gen_random_uuid(), 'B crew', '+919800000109', 9999, b) returning id into cb;
  insert into public.event_tasks(quote_id, category, title, crew_id, status, org_id) values (qb, 'setup', 'B task', cb, 'unassigned', b);
  insert into public.event_costs(id, quote_id, description, kind, estimated, requirement_key, crew_covered, org_id)
    values (gen_random_uuid(), qb, 'Staff & crew', 'internal', 3000, 'std:staff', true, b) returning id into ln;
  perform pg_temp.put('b_staffline', ln::text);
end $$;

-- ---- before: the 0246 body skips the unassigned crew task --------------------------------------------------------------
\ir ../../supabase/migrations/0246_event_money_ledger.sql
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01';
  b uuid := 'b0000000-0000-4000-8000-000000000001'; qb uuid := 'b0000000-0000-4000-8000-00000000da01'; c jsonb; begin
  perform pg_temp.su();
  c := pg_temp.crew(q, a);
  perform pg_temp.res('01 before 0252 (0246 body): 2 wage lines (Ravi, Sita) vs 4 people on the screens - the reported mismatch',
    jsonb_array_length(c) = 2 and pg_temp.people(q, a) = 4, c::text);
  perform pg_temp.res('02 before 0252: studio B has no crew line, so its "replaced by crew wages" line still counted 3,000',
    jsonb_array_length(pg_temp.crew(qb, b)) = 0
    and (select (l ->> 'c_fc')::numeric from jsonb_array_elements(public._r21_cost_lines(qb, b)) l where l ->> 'source_id' = pg_temp.get('b_staffline')) = 3000);
  perform pg_temp.put('h0', pg_temp.rows_hash());
end $$;

-- ---- the migration, twice ----------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/0252_crew_wages_unassigned.sql
\ir ../../supabase/migrations/0252_crew_wages_unassigned.sql

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; c jsonb; s jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('03 applied twice: no task / cost line / crew row rewritten', pg_temp.rows_hash() = pg_temp.get('h0'));
  c := pg_temp.crew(q, a);
  perform pg_temp.res('04 wage lines = people on the event (4 = 4): Dev, Ravi, Sita, Suresh',
    jsonb_array_length(c) = pg_temp.people(q, a) and jsonb_array_length(c) = 4
    and (select string_agg(l ->> 'label', ',' order by l ->> 'label') from jsonb_array_elements(c) l) = 'Dev,Ravi,Sita,Suresh', c::text);
  select l into s from jsonb_array_elements(c) l where l ->> 'label' = 'Suresh';
  perform pg_temp.res('05 the unassigned crew task is an ESTIMATED wage: estimate 800, nothing committed / actual yet, says not accepted',
    pg_temp.n(s, 'estimated') = 800 and s ->> 'committed' is null and s ->> 'actual' is null and pg_temp.n(s, 'c_com') = 0
    and pg_temp.n(s, 'c_fc') = 800 and pg_temp.n(s, 'c_act') = 0 and s ->> 'attendance' = 'not_marked'
    and s ->> 'note' = 'assigned - not accepted yet', s::text);
  perform pg_temp.res('06 only cancelled / only rejected tasks still mean "not on the event" (Kiran, Raj); a name-only task is not crew',
    not exists (select 1 from jsonb_array_elements(c) l where l ->> 'label' in ('Kiran', 'Raj', 'Somebody')));
  perform pg_temp.res('07 a person with a rejected AND an unassigned task is on the event once (Dev, one line)',
    (select count(*) from jsonb_array_elements(c) l where l ->> 'label' = 'Dev') = 1);
  perform pg_temp.res('08 still internal: the app cannot call _r21_cost_lines; marker present, no ''unassigned'' skip left',
    not has_function_privilege('authenticated', 'public._r21_cost_lines(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r21_cost_lines(uuid,uuid)', 'execute')
    and position('r22-money-0252' in (select prosrc from pg_proc where oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)'))) > 0
    and position('''unassigned''' in (select prosrc from pg_proc where oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)'))) = 0);
end $$;

-- ---- the money follows (one P&L everywhere) -----------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; p jsonb; m jsonb; i jsonb; r jsonb; begin
  p := pg_temp.j(format('select public.event_pnl(%L)', q));
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  i := pg_temp.j('select public.insights_event_costs(current_date - 30, current_date + 30)');
  select e into r from jsonb_array_elements(i -> 'events') e where e ->> 'id' = q::text;
  perform pg_temp.res('09 event_pnl: wages 4,100 (incl. Suresh 800), net profit 1,95,900, margin 98%',
    pg_temp.n(p, 'wages') = 4100 and pg_temp.n(p, 'net_profit') = 195900 and pg_temp.n(p, 'margin_pct') = 98, p::text);
  perform pg_temp.res('10 event_cost_breakdown (admin): 4 named crew lines, estimated 4,100, expected margin 1,95,900',
    (select count(*) from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 4
    and pg_temp.n(m, 'cost_wages') = 4100 and pg_temp.n(m, 'cost_estimated') = 4100 and pg_temp.n(m, 'margin_expected') = 195900, m::text);
  perform pg_temp.res('11 insights_event_costs: crew = wages = 4,100, profit = event_pnl, margin 98% (Insights card = per-event table source)',
    pg_temp.n(r, 'crew') = 4100 and pg_temp.n(r, 'wages') = 4100 and pg_temp.n(r, 'profit') = pg_temp.n(p, 'net_profit')
    and pg_temp.n(r, 'margin_pct') = 98 and pg_temp.n(r, 'cost_total') = 4100, coalesce(r::text, i::text));
end $$;

select pg_temp.login('a_staff@a.test');
do $$ declare q uuid := 'a0000000-0000-4000-8000-00000000da01'; m jsonb; begin
  m := pg_temp.j(format('select public.event_cost_breakdown(%L)', q));
  perform pg_temp.res('12 non-admin with finance: ONE combined line "Crew wages (4 people)", no names / rates',
    (select count(*) from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 1
    and (select (l ->> 'people')::int from jsonb_array_elements(m -> 'lines') l where l ->> 'source' = 'crew') = 4
    and position('Suresh' in m::text) = 0 and position('day_rate' in m::text) = 0, m::text);
end $$;

-- ---- "replaced by crew wages" follows the same rule; tenant isolation -----------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  q uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01'; c jsonb; begin
  perform pg_temp.su();
  c := pg_temp.crew(qb, b);
  perform pg_temp.res('13 studio B: its unassigned crew task is 1 wage line (= 1 person) and the ticked staff line now counts 0',
    jsonb_array_length(c) = 1 and pg_temp.people(qb, b) = 1
    and (select (l ->> 'c_fc')::numeric + (l ->> 'c_est')::numeric from jsonb_array_elements(public._r21_cost_lines(qb, b)) l
          where l ->> 'source_id' = pg_temp.get('b_staffline')) = 0, c::text);
  perform pg_temp.res('14 tenant isolation: B crew never in A, A crew never in B; A ledger read with B studio is empty',
    position('B crew' in pg_temp.crew(q, a)::text) = 0 and position('Suresh' in c::text) = 0
    and public._r21_cost_lines(q, b) is null);
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare p jsonb; begin
  p := pg_temp.j('select public.event_pnl(''a0000000-0000-4000-8000-00000000da01'')');
  perform pg_temp.res('15 studio B admin cannot read studio A''s P&L (null, no A numbers)', p is null or p ? 'err' or p = 'null'::jsonb, coalesce(p::text, 'null'));
end $$;

-- ---- the person accepts later: committed; cancelled: off the event ---------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; s jsonb; begin
  perform pg_temp.su();
  update public.event_tasks set status = 'accepted', responded_at = now() where id = pg_temp.get('suresh_task')::uuid;
  select l into s from jsonb_array_elements(pg_temp.crew(q, a)) l where l ->> 'label' = 'Suresh';
  perform pg_temp.res('16 Suresh accepts: his line is committed (800), still one line', pg_temp.n(s, 'committed') = 800 and pg_temp.n(s, 'c_com') = 800, s::text);
  update public.event_tasks set status = 'cancelled' where id = pg_temp.get('suresh_task')::uuid;
  perform pg_temp.res('17 his only task cancelled: off the event in both counts (3 = 3)',
    jsonb_array_length(pg_temp.crew(q, a)) = 3 and pg_temp.people(q, a) = 3);
end $$;

select pg_temp.su();
select name, result from _rm order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R22-MONEY-0252: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R22-MONEY-0252: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _rm;
rollback;
