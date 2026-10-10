-- per-currency-0094.sql -- 0094: insights_range / insights_events / client_timeline per-currency totals.
-- Mixed INR + AED + USD events in studio A; old fields unchanged. Rolled back.
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
    ('a0000000-0000-4000-8000-0000000094e1', 'CU-1', 'Cur INR', 'Wedding', 'confirmed', 'planning', '2026-05-10', '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', '{"name":"Cur Client","phone":"9000000094"}', a),
    ('a0000000-0000-4000-8000-0000000094e2', 'CU-2', 'Cur AED', 'Wedding', 'confirmed', 'planning', '2026-05-12', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000,"taxCountry":"AE","currency":"AED"}', '{"name":"Cur Client","phone":"9000000094"}', a),
    ('a0000000-0000-4000-8000-0000000094e3', 'CU-3', 'Cur AED 2', 'Birthday', 'confirmed', 'planning', '2026-05-14', '{"subtotal":30000,"discount":0,"gstPct":0,"total":30000,"taxCountry":"AE","currency":"AED"}', '{"name":"Cur Client","phone":"9000000094"}', a),
    ('a0000000-0000-4000-8000-0000000094e4', 'CU-4', 'Cur USD', 'Wedding', 'confirmed', 'planning', '2026-05-16', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000,"taxCountry":"US","currency":"USD"}', '{"name":"Cur Client","phone":"9000000094"}', a);
  -- 0089's trigger stamps currency from pricing; force it in case pricing enforcement rewrote it
  update public.quotes set currency = 'INR' where id = 'a0000000-0000-4000-8000-0000000094e1';
  update public.quotes set currency = 'AED' where id in ('a0000000-0000-4000-8000-0000000094e2', 'a0000000-0000-4000-8000-0000000094e3');
  update public.quotes set currency = 'USD' where id = 'a0000000-0000-4000-8000-0000000094e4';
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id) values
    ('a0000000-0000-4000-8000-0000000094e1', 40000, 'paid', '2026-05-05 10:00+05:30', a),
    ('a0000000-0000-4000-8000-0000000094e2', 10000, 'paid', '2026-05-06 10:00+05:30', a);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; m jsonb; inr jsonb; aed jsonb; usd jsonb; ev jsonb; t jsonb; tb jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.insights_range('2026-05-01', '2026-05-31'); m := r -> 'money_by_currency';
  select x into inr from jsonb_array_elements(m) x where x ->> 'currency' = 'INR';
  select x into aed from jsonb_array_elements(m) x where x ->> 'currency' = 'AED';
  select x into usd from jsonb_array_elements(m) x where x ->> 'currency' = 'USD';
  perform pg_temp.res('01 three currency rows', jsonb_array_length(m) = 3, m::text);
  perform pg_temp.res('02 INR revenue separate', (inr ->> 'revenue')::numeric = 100000 and (inr ->> 'events')::int = 1, inr::text);
  perform pg_temp.res('03 AED revenue + average per currency', (aed ->> 'revenue')::numeric = 80000 and (aed ->> 'avg_event_value')::numeric = 40000 and (aed ->> 'events')::int = 2, aed::text);
  perform pg_temp.res('04 USD revenue separate', (usd ->> 'revenue')::numeric = 20000, usd::text);
  perform pg_temp.res('05 collected / outstanding per currency', (inr ->> 'collected')::numeric = 40000 and (inr ->> 'outstanding')::numeric = 60000 and (aed ->> 'collected')::numeric = 10000 and (aed ->> 'outstanding')::numeric = 70000, m::text);
  perform pg_temp.res('06 old money field unchanged (legacy sum)', (r #>> '{money,revenue}')::numeric = 200000, r ->> 'money');
  perform pg_temp.res('07 cash_by_currency split', (select bool_and(case x ->> 'currency' when 'INR' then (x ->> 'amount')::numeric = 40000 when 'AED' then (x ->> 'amount')::numeric = 10000 else false end) from jsonb_array_elements(r -> 'cash_by_currency') x) and jsonb_array_length(r -> 'cash_by_currency') = 2, r ->> 'cash_by_currency');
  select x into t from jsonb_array_elements(r -> 'types_by_currency') x where x ->> 'type' = 'Wedding' and x ->> 'currency' = 'AED';
  perform pg_temp.res('08 types_by_currency', (t ->> 'revenue')::numeric = 50000, r ->> 'types_by_currency');
  ev := public.insights_events('2026-05-01', '2026-05-31');
  perform pg_temp.res('09 insights_events rows carry currency', (select bool_and(x ->> 'currency' = case x ->> 'code' when 'CU-1' then 'INR' when 'CU-4' then 'USD' else 'AED' end) from jsonb_array_elements(ev -> 'events') x), ev::text);
  tb := public.client_timeline('a0000000-0000-4000-8000-0000000094e1', 300) -> 'totals';
  perform pg_temp.res('10 client totals.by_currency', jsonb_array_length(tb -> 'by_currency') = 3
    and (select bool_and(case x ->> 'currency' when 'INR' then (x ->> 'quoted')::numeric = 100000 and (x ->> 'paid')::numeric = 40000 and (x ->> 'due')::numeric = 60000
                                                when 'AED' then (x ->> 'quoted')::numeric = 80000 and (x ->> 'due')::numeric = 70000
                                                when 'USD' then (x ->> 'quoted')::numeric = 20000 and (x ->> 'paid')::numeric = 0 end) from jsonb_array_elements(tb -> 'by_currency') x), tb::text);
  perform pg_temp.res('11 client legacy quoted unchanged', (tb ->> 'quoted')::numeric = 200000, tb::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.insights_range('2026-05-01', '2026-05-31');
  perform pg_temp.res('12 studio B sees none of A''s currency rows', position('CU-' in r::text) = 0 and not exists (select 1 from jsonb_array_elements(r -> 'money_by_currency') x where x ->> 'currency' in ('AED','USD')), r ->> 'money_by_currency');
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PER-CURRENCY-0094: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PER-CURRENCY-0094: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
