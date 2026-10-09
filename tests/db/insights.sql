-- insights.sql -- 0076 insights_range: area gate, tenant scope, finance masking, money + staff
-- participation math. Fixture: a_admin/a_staff studio A, b_admin studio B. Rolled back.
-- Local disposable PG only. Fake data only.
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
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;   -- keeps the current role
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- fixture: a no-quotes-edit member in studio A

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid; adm uuid; c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); bk uuid := gen_random_uuid();
begin
  perform pg_temp.su();
  select id into adm from auth.users where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Asha Admin' where id = adm;
  u := coalesce((select id from auth.users where email = 'in_viewer@a.test'), auth.seed_user('in_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'in_viewer@a.test', 'Ins Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'insights', true, false, a, now());
  -- events: E1 confirmed 2026-05-10 total 100000 ; E2 cancelled 2026-05-20 ; E3 quote 2026-05-25 ; E4 confirmed 2026-07-01 (out of range)
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, org_id, manager_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'IN-1', 'Ins One', 'Wedding', 'confirmed', 'closed', '2026-05-10', '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', a, adm),
    ('a0000000-0000-4000-8000-0000000076e2', 'IN-2', 'Ins Two', 'Wedding', 'cancelled', 'quote', '2026-05-20', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', a, null),
    ('a0000000-0000-4000-8000-0000000076e3', 'IN-3', 'Ins Three', 'Birthday', 'quote', 'quote', '2026-05-25', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000}', a, null),
    ('a0000000-0000-4000-8000-0000000076e4', 'IN-4', 'Ins Four', 'Wedding', 'confirmed', 'planning', '2026-07-01', '{"subtotal":999999,"discount":0,"gstPct":0,"total":999999}', a, adm);
  insert into public.quotes(id, code, title, status, event_date, pricing, org_id) values
    ('b0000000-0000-4000-8000-0000000076e1', 'INB-1', 'B event', 'confirmed', '2026-05-12', '{"subtotal":777777,"discount":0,"gstPct":0,"total":777777}', b);
  insert into public.change_requests(quote_id, title, price_delta, cost_delta, status, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'extra', 10000, 2000, 'approved', a),
    ('a0000000-0000-4000-8000-0000000076e1', 'pending', 99999, 99999, 'requested', a);
  insert into public.event_resources(id, quote_id, label, cost, status, org_id) values
    (bk, 'a0000000-0000-4000-8000-0000000076e1', 'DJ', 5000, 'booked', a),
    (gen_random_uuid(), 'a0000000-0000-4000-8000-0000000076e1', 'Tent', 3000, 'booked', a);
  insert into public.event_costs(quote_id, description, estimated, actual, booking_id, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'Food', 30000, 32000, null, a),
    ('a0000000-0000-4000-8000-0000000076e1', 'Decor', 10000, null, null, a),
    ('a0000000-0000-4000-8000-0000000076e1', 'DJ', 5000, null, bk, a);
  insert into public.expense_claims(quote_id, who, amount, status, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'x', 1000, 'paid', a), ('a0000000-0000-4000-8000-0000000076e1', 'x', 500, 'pending', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 60000, 'paid', '2026-05-05 10:00+05:30', a),
    ('a0000000-0000-4000-8000-0000000076e1', 7000, 'failed', null, a);
  insert into public.crew_members(id, name, phone, org_id) values (c1, 'Ravi Crew', '9000000001', a), (c2, 'Sita Crew', '9000000002', a);
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, status, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'Decor', 't1', c1, 'Ravi Crew', 'completed', a),
    ('a0000000-0000-4000-8000-0000000076e1', 'Decor', 't2', c1, 'Ravi Crew', 'assigned', a),
    ('a0000000-0000-4000-8000-0000000076e3', 'Decor', 't3', c1, 'Ravi Crew', 'assigned', a),
    ('a0000000-0000-4000-8000-0000000076e2', 'Decor', 't4', c2, 'Sita Crew', 'assigned', a),
    ('a0000000-0000-4000-8000-0000000076e4', 'Decor', 't5', c2, 'Sita Crew', 'assigned', a);
  insert into public.event_tasks(quote_id, category, title, assignee_kind, assignee_name, status, org_id) values
    ('a0000000-0000-4000-8000-0000000076e1', 'Decor', 'tv', 'outsourced', 'Vendor Co', 'assigned', a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; e text; ravi jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('01 security definer + search_path empty',
    (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = 'public.insights_range(date,date)'::regprocedure));
  perform pg_temp.res('02 anon no, authenticated yes',
    not has_function_privilege('anon', 'public.insights_range(date,date)', 'execute')
    and has_function_privilege('authenticated', 'public.insights_range(date,date)', 'execute'));
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.insights_range('2026-05-01', '2026-05-31')$q$);
  perform pg_temp.res('03 anon refused', e <> '', e);
  perform pg_temp.login('a_staff@a.test');   -- sales: finance + controls but no insights area
  e := pg_temp.try($q$select public.insights_range('2026-05-01', '2026-05-31')$q$);
  perform pg_temp.res('04 role without insights area refused (42501)', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.insights_range('2026-05-31', '2026-05-01')$q$);
  perform pg_temp.res('05 reversed range refused', e like '22023%', e);
  r := public.insights_range('2026-05-01', '2026-05-31');
  perform pg_temp.put('r', r::text);
  perform pg_temp.res('06 counts total/confirmed/completed/cancelled/open',
    r #>> '{counts,total}' = '3' and r #>> '{counts,confirmed}' = '1' and r #>> '{counts,completed}' = '1'
    and r #>> '{counts,cancelled}' = '1' and r #>> '{counts,open_quotes}' = '1', r ->> 'counts');
  -- revenue 100000 + 10000 ; cost 32000 + 10000 + 5000(DJ line) + 2000 (change) + 3000 (tent, not imported) = 52000 ; exp 1000
  perform pg_temp.res('07 revenue', (r #>> '{money,revenue}')::numeric = 110000, r ->> 'money');
  perform pg_temp.res('08 cost (actual else estimate + change + unimported vendor)', (r #>> '{money,cost}')::numeric = 52000, r ->> 'money');
  perform pg_temp.res('09 profit + margin', (r #>> '{money,profit}')::numeric = 57000 and (r #>> '{money,margin_pct}')::numeric = 52, r ->> 'money');
  perform pg_temp.res('10 collected from ledger + outstanding', (r #>> '{money,collected}')::numeric = 60000
    and (r #>> '{money,outstanding}')::numeric = 50000, r ->> 'money');
  perform pg_temp.res('11 avg event value + cash in range', (r #>> '{money,avg_event_value}')::numeric = 110000
    and (r #>> '{money,cash_in_range}')::numeric = 60000, r ->> 'money');
  perform pg_temp.res('12 top types exclude cancelled', jsonb_array_length(r -> 'types') = 2
    and (select bool_and((t ->> 'count')::int = 1) from jsonb_array_elements(r -> 'types') t), r ->> 'types');
  select s into ravi from jsonb_array_elements(r -> 'staff') s where s ->> 'name' = 'Ravi Crew';
  perform pg_temp.res('13 staff: Ravi 2 events, 3 tasks, 1 done, drill-down list', (ravi ->> 'events')::int = 2
    and (ravi ->> 'tasks')::int = 3 and (ravi ->> 'done')::int = 1 and jsonb_array_length(ravi -> 'list') = 2, coalesce(ravi::text, r ->> 'staff'));
  perform pg_temp.res('14 staff: cancelled-only + out-of-range + outsourced excluded',
    not exists (select 1 from jsonb_array_elements(r -> 'staff') s where s ->> 'name' in ('Sita Crew', 'Vendor Co')), r ->> 'staff');
  perform pg_temp.res('15 staff: event manager counted by display name',
    exists (select 1 from jsonb_array_elements(r -> 'staff') s where s ->> 'name' = 'Asha Admin' and s ->> 'kind' = 'manager' and (s ->> 'events')::int = 1), r ->> 'staff');
  perform pg_temp.res('16 tenant scope: studio B event never counted', position('INB-1' in r::text) = 0 and position('777777' in r::text) = 0);
  perform pg_temp.login('in_viewer@a.test');   -- insights area, no finance
  r := public.insights_range('2026-05-01', '2026-05-31');
  perform pg_temp.res('17 no finance area: money null, type revenue null, counts kept', r -> 'money' = 'null'::jsonb
    and (r ->> 'finance')::boolean = false and r #>> '{counts,total}' = '3'
    and (select bool_and(t -> 'revenue' = 'null'::jsonb) from jsonb_array_elements(r -> 'types') t), r::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.insights_range('2026-05-01', '2026-05-31');
  perform pg_temp.res('18 studio B sees only its own event', r #>> '{counts,total}' = '1' and position('IN-1' in r::text) = 0, r ->> 'counts');
  r := public.insights_range(null, null);
  perform pg_temp.res('19 open range works', (r #>> '{counts,total}')::int >= 1);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'INSIGHTS: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'INSIGHTS: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
