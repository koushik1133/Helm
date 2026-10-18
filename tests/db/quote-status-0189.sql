-- quote-status-0189.sql -- 0189: one quote status label (helm_quote_status_label) on the client page:
-- "confirmed" only once the client approved / paid; a locked quote with the link out reads
-- "sent - awaiting client approval". Due / totals unchanged. Rolled back. Local disposable PG only. Fake data only.
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
  insert into public.quotes(id, code, title, event_type, status, lifecycle_stage, approval_status, event_date, pricing, client, org_id) values
    ('a0000000-0000-4000-8000-0000000189e1', 'QS-SENT', 'Sent quote', 'Wedding', 'confirmed', 'quote', 'sent', '2026-11-04', '{"subtotal":118000,"discount":0,"gstPct":0,"total":118000}', '{"name":"Label Client","phone":"9000000189"}', a),
    ('a0000000-0000-4000-8000-0000000189e2', 'QS-APPR', 'Approved quote', 'Wedding', 'confirmed', 'quote', 'approved', '2026-11-05', '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', '{"name":"Label Client","phone":"9000000189"}', a),
    ('a0000000-0000-4000-8000-0000000189e3', 'QS-LOCK', 'Locked quote', 'Wedding', 'confirmed', 'quote', 'none', '2026-11-06', '{"subtotal":40000,"discount":0,"gstPct":0,"total":40000}', '{"name":"Label Client","phone":"9000000189"}', a),
    ('a0000000-0000-4000-8000-0000000189e4', 'QS-DRAFT', 'Draft quote', 'Wedding', 'quote', 'quote', 'none', '2026-11-07', '{"subtotal":30000,"discount":0,"gstPct":0,"total":30000}', '{"name":"Label Client","phone":"9000000189"}', a),
    ('a0000000-0000-4000-8000-0000000189e5', 'QS-PLAN', 'Planning event', 'Wedding', 'confirmed', 'planning', 'none', '2026-11-08', '{"subtotal":20000,"discount":0,"gstPct":0,"total":20000}', '{"name":"Label Client","phone":"9000000189"}', a),
    ('a0000000-0000-4000-8000-0000000189e6', 'QS-ONLY', 'Only sent', 'Birthday', 'confirmed', 'quote', 'sent', '2026-11-09', '{"subtotal":11800,"discount":0,"gstPct":0,"total":11800}', '{"name":"Solo Client","phone":"9000000289"}', a);
  update public.quotes set currency = 'INR', created_at = now() - interval '1 day' where id::text like 'a0000000-0000-4000-8000-0000000189e%';
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 helper: locked + sent -> sent - awaiting client approval', public.helm_quote_status_label('confirmed', 'quote', 'sent') = 'sent - awaiting client approval');
  perform pg_temp.res('02 helper: approved / paid -> confirmed', public.helm_quote_status_label('confirmed', 'quote', 'approved') = 'confirmed' and public.helm_quote_status_label('confirmed', null, 'paid') = 'confirmed');
  perform pg_temp.res('03 helper: locked, link not sent', public.helm_quote_status_label('confirmed', '', 'none') = 'locked - not sent yet' and public.helm_quote_status_label('confirmed', 'quote', null) = 'locked - not sent yet');
  perform pg_temp.res('04 helper: draft keeps its stage', public.helm_quote_status_label('quote', 'quote', 'none') = 'quote' and public.helm_quote_status_label('quote', 'discovery', null) = 'discovery' and public.helm_quote_status_label(null, null, null) = 'quote');
  perform pg_temp.res('05 helper: stages after quote unchanged', public.helm_quote_status_label('confirmed', 'planning', 'none') = 'planning' and public.helm_quote_status_label('confirmed', 'closed', 'paid') = 'closed' and public.helm_quote_status_label('confirmed', 'confirmed', 'sent') = 'confirmed');
  perform pg_temp.res('06 helper: cancelled early quote says cancelled', public.helm_quote_status_label('cancelled', 'quote', 'sent') = 'cancelled');
  perform pg_temp.res('07 helper is immutable (no table read)', coalesce((select provolatile = 'i' from pg_proc where oid = to_regprocedure('public.helm_quote_status_label(text,text,text)')), false));
  perform pg_temp.res('08 anon cannot call the helper', not has_function_privilege('anon', 'public.helm_quote_status_label(text,text,text)', 'execute'));
exception when others then perform pg_temp.su(); insert into _uf values ('0x helper', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; tb jsonb;
  st text := 'Status now: ';
begin
  perform pg_temp.login('a_admin@a.test');
  r := public.client_timeline('a0000000-0000-4000-8000-0000000189e1', 300);
  perform pg_temp.res('09 Status now: sent quote is not "confirmed"', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'sent - awaiting client approval' and x ->> 'subtitle' like 'QS-SENT%')
    and not exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'confirmed' and x ->> 'subtitle' like 'QS-SENT%'), r ->> 'items');
  perform pg_temp.res('10 Status now: client-approved quote reads confirmed', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'confirmed' and x ->> 'subtitle' like 'QS-APPR%'), r ->> 'items');
  perform pg_temp.res('11 Status now: locked, not sent', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'locked - not sent yet' and x ->> 'subtitle' like 'QS-LOCK%'), r ->> 'items');
  perform pg_temp.res('12 Status now: draft says quote', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'quote' and x ->> 'subtitle' like 'QS-DRAFT%'), r ->> 'items');
  perform pg_temp.res('13 Status now: later stage unchanged', exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'title' = st || 'planning' and x ->> 'subtitle' like 'QS-PLAN%'), r ->> 'items');
  tb := r -> 'totals';
  -- Due (0160, unchanged): every status=confirmed event owes its total (nothing paid): 118000+50000+40000+20000
  perform pg_temp.res('14 Due unchanged (0160 rule)', (tb ->> 'due')::numeric = 228000, tb::text);
  perform pg_temp.res('15 Quoted unchanged', (tb ->> 'quoted')::numeric = 258000, tb::text);
  r := public.client_timeline('a0000000-0000-4000-8000-0000000189e6', 300);
  perform pg_temp.res('16 client status follows the label (only a sent quote)', r #>> '{client,status}' = 'sent - awaiting client approval', r ->> 'client');
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('17 studio B cannot read A''s client', pg_temp.try('select public.client_timeline(''a0000000-0000-4000-8000-0000000189e1'', 300)') <> '', 'B read it');
  perform pg_temp.anon();
  perform pg_temp.res('18 anon cannot read the timeline', pg_temp.try('select public.client_timeline(''a0000000-0000-4000-8000-0000000189e1'', 300)') <> '', 'anon read it');
exception when others then perform pg_temp.su(); insert into _uf values ('1x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('19 no quote row changed by reading (status / approval intact)',
    (select count(*) from public.quotes where id::text like 'a0000000-0000-4000-8000-0000000189e%' and status = 'confirmed' and approval_status = 'sent') = 2);
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'QUOTE-STATUS-0189: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'QUOTE-STATUS-0189: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
