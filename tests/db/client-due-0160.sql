-- client-due-0160.sql -- 0160: client_timeline Due = confirmed events only (incl. approved change orders);
-- "Status now" for a confirmed event left on stage quote: 0160 said confirmed; 0189 folds in the client approval (locked - not sent yet). Rolled back.
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


do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, event_date, pricing, client, org_id) values
    ('a0000000-0000-4000-8000-0000000160e1', 'DU-2', 'Due confirmed', 'Wedding', 'confirmed', 'quote', '2026-06-10', '{"subtotal":82600,"discount":0,"gstPct":0,"total":82600}', '{"name":"Due Client","phone":"9000000160"}', a),
    ('a0000000-0000-4000-8000-0000000160e2', 'DU-1', 'Due draft', 'Wedding', 'quote', 'quote', '2026-06-12', '{"subtotal":77600,"discount":0,"gstPct":0,"total":77600}', '{"name":"Due Client","phone":"9000000160"}', a),
    ('a0000000-0000-4000-8000-0000000160e3', 'DU-3', 'Due partial', 'Birthday', 'confirmed', 'planning', '2026-06-14', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', '{"name":"Part Client","phone":"9000000161"}', a);
  update public.quotes set currency = 'INR' where id = 'a0000000-0000-4000-8000-0000000160e3';
  update public.quotes set currency = 'INR' where id in ('a0000000-0000-4000-8000-0000000160e1', 'a0000000-0000-4000-8000-0000000160e2');
  update public.quotes set created_at = now() - interval '1 day' where id in ('a0000000-0000-4000-8000-0000000160e1', 'a0000000-0000-4000-8000-0000000160e2');
  insert into public.change_requests(quote_id, title, price_delta, status, org_id) values
    ('a0000000-0000-4000-8000-0000000160e1', 'Extra lights', 5000, 'approved', a),
    ('a0000000-0000-4000-8000-0000000160e1', 'Maybe more', 9999, 'requested', a),
    ('a0000000-0000-4000-8000-0000000160e3', 'Cake', 5000, 'approved', a);
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id) values
    ('a0000000-0000-4000-8000-0000000160e1', 87600, 'paid', '2026-06-01 10:00+05:30', a),
    ('a0000000-0000-4000-8000-0000000160e3', 20000, 'paid', '2026-06-02 10:00+05:30', a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; tb jsonb; inr jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.client_timeline('a0000000-0000-4000-8000-0000000160e1', 300); tb := r -> 'totals';
  perform pg_temp.res('01 due = 0 (confirmed event fully paid incl. approved change; unconfirmed quote owes nothing)', (tb ->> 'due')::numeric = 0, tb::text);
  perform pg_temp.res('02 paid unchanged', (tb ->> 'paid')::numeric = 87600, tb::text);
  perform pg_temp.res('03 quoted unchanged (both quotes, base totals)', (tb ->> 'quoted')::numeric = 160200, tb::text);
  select x into inr from jsonb_array_elements(tb -> 'by_currency') x where x ->> 'currency' = 'INR';
  perform pg_temp.res('04 by_currency due follows the same rule', (inr ->> 'due')::numeric = 0 and (inr ->> 'quoted')::numeric = 160200, inr::text);
  -- 0189: DU-2 is locked by the studio but the client never got / approved the link -> one clear label
  perform pg_temp.res('05 Status now reads locked (0189), not quote', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = 'Status now: locked - not sent yet' and x ->> 'subtitle' like 'DU-2%')
    and not exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = 'Status now: quote' and x ->> 'subtitle' like 'DU-2%'), r ->> 'items');
  perform pg_temp.res('06 unconfirmed quote still says quote', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = 'Status now: quote' and x ->> 'subtitle' like 'DU-1%'), r ->> 'items');
  perform pg_temp.res('07 client status = the latest event''s label (0189)', r #>> '{client,status}' = 'locked - not sent yet', r ->> 'client');
  tb := public.client_timeline('a0000000-0000-4000-8000-0000000160e3', 300) -> 'totals';
  perform pg_temp.res('08 partial: due = 50000 + 5000 - 20000', (tb ->> 'due')::numeric = 35000, tb::text);
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('09 studio B cannot read A''s client', pg_temp.try('select public.client_timeline(''a0000000-0000-4000-8000-0000000160e1'', 300)') <> '', 'B read it');
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'CLIENT-DUE-0160: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'CLIENT-DUE-0160: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
