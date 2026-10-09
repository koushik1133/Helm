-- r3-sync-reprice.sql -- 0077: server recent records, re-pricing bell alerts, per-event profit.
-- Fixture: a_admin/a_staff studio A, b_admin studio B. Rolled back. Local disposable PG only.
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
create or replace function pg_temp.pc(p_code text) returns integer language sql as $$
  select count(*)::int from public.notifications n join public.quotes q on q.id = n.quote_id where q.code = p_code and n.kind = 'price_change' $$;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; u uuid; begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'r3_viewer@a.test'), auth.seed_user('r3_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'r3_viewer@a.test', 'R3 Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'insights', true, false, a, now()), ('quality', 'quotes', true, false, a, now());
  insert into public.app_config(org_id, key, value) values (a, 'pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0}'),
    (b, 'pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0}')
    on conflict (org_id, key) do update set value = excluded.value;
  delete from public.notifications where kind = 'price_change';
  insert into public.quotes(code, title, status, lifecycle_stage, event_date, pricing, org_id) values
    ('R3-F', 'future chairs', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a),
    ('R3-P', 'past chairs', 'confirmed', 'event_day', current_date - 3, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a),
    ('R3-C', 'cancelled', 'cancelled', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a),
    ('R3-S', 'settled', 'confirmed', 'settlement', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', a),
    ('R3-G', 'gold menu', 'quote', 'quote', current_date + 40, '{"guests":50,"platePrice":900,"_packageName":"Gold R3","subtotal":45000,"discount":0,"gstPct":18,"total":53100}', a),
    ('R3-B', 'other studio', 'quote', 'quote', current_date + 30, '{"chairs":100,"chairPrice":200,"subtotal":20000,"discount":0,"gstPct":18,"total":23600}', b),
    ('R3-E', 'profit event', 'confirmed', 'planning', '2026-03-10', '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', a);
  insert into public.menu_templates(tier, diet, name, price_per_plate, org_id) values ('gold', 'veg', 'Gold R3', 900, a);
  insert into public.event_costs(quote_id, description, estimated, actual, org_id)
    select id, 'Food', 30000, null, a from public.quotes where code = 'R3-E';
  insert into public.quote_payments(quote_id, amount, status, paid_at, org_id)
    select id, 40000, 'paid', '2026-03-01 10:00+05:30', a from public.quotes where code = 'R3-E';
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; e text; t1 numeric; begin
  perform pg_temp.su();
  perform pg_temp.res('01 security definer + empty search_path on every RPC',
    (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p
      where p.oid in ('public.recent_touch(text,text,text)'::regprocedure, 'public.recent_list(integer)'::regprocedure,
                      'public.insights_events(date,date)'::regprocedure, 'public.bell_feed(integer)'::regprocedure,
                      'public._r3_price_change_notify(uuid,text,text[],text)'::regprocedure)));
  perform pg_temp.res('02 anon no execute; helper not callable by authenticated',
    not has_function_privilege('anon', 'public.recent_touch(text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.insights_events(date,date)', 'execute')
    and not has_function_privilege('authenticated', 'public._r3_price_change_notify(uuid,text,text[],text)', 'execute')
    and has_function_privilege('authenticated', 'public.recent_list(integer)', 'execute'));

  -- recent records
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.recent_touch('flow.html?id=1', 'x', 'event')$q$);
  perform pg_temp.res('03 anon cannot record', e <> '', e);
  perform pg_temp.login('a_admin@a.test');
  perform public.recent_touch('flow.html?id=abc', 'Wedding A', 'event');
  perform public.recent_touch('/leads.html?id=l1', 'Lead One', 'lead');
  perform public.recent_touch('flow.html?id=abc', 'Wedding A renamed', 'event');
  r := public.recent_list(10);
  perform pg_temp.res('04 recent list: newest first, upserted (no duplicate), leading slash stripped',
    jsonb_array_length(r) = 2 and r -> 0 ->> 'title' = 'Wedding A renamed' and r -> 1 ->> 'href' = 'leads.html?id=l1', r::text);
  e := pg_temp.try($q$select public.recent_touch('https://evil.example/x.html', 'x', 'event')$q$);
  perform pg_temp.res('05 external link refused', e like '22023%', e);
  e := pg_temp.try($q$insert into public.user_recent_records(user_id, org_id, href, title) values (auth.uid(), public.current_org_id(), 'x.html', 'x')$q$);
  perform pg_temp.res('06 direct table write refused', e <> '', e);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('07 another person never sees my recents', jsonb_array_length(public.recent_list(10)) = 0
    and (select count(*) from public.user_recent_records) = 0);
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('08 other studio never sees my recents', jsonb_array_length(public.recent_list(10)) = 0);

  -- re-pricing alerts
  perform pg_temp.su();
  select (pricing ->> 'total')::numeric into t1 from public.quotes where code = 'R3-F';
  update public.app_config set value = value || '{"chairPrice":250}' where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing';
  perform pg_temp.res('09 chair price change alerts the future chair quote',
    pg_temp.pc('R3-F') = 1, pg_temp.pc('R3-F')::text);
  perform pg_temp.res('10 past / cancelled / settlement / no-chair / other-studio quotes not alerted',
    pg_temp.pc('R3-P') = 0 and pg_temp.pc('R3-C') = 0 and pg_temp.pc('R3-S') = 0 and pg_temp.pc('R3-G') = 0 and pg_temp.pc('R3-B') = 0);
  perform pg_temp.res('11 the quote price is never changed', (select (pricing ->> 'total')::numeric from public.quotes where code = 'R3-F') = t1
    and (select pricing ->> 'chairPrice' from public.quotes where code = 'R3-F') = '200');
  update public.app_config set value = value || '{"chairPrice":260}' where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing';
  perform pg_temp.res('12 repeated edit within 10 minutes is deduped', pg_temp.pc('R3-F') = 1, pg_temp.pc('R3-F')::text);
  update public.app_config set value = value || '{"currency":"INR"}' where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing';
  perform pg_temp.res('13 non-price config edit raises nothing', (select count(*) from public.notifications where kind = 'price_change') = 1);
  update public.menu_templates set price_per_plate = 950 where name = 'Gold R3';
  perform pg_temp.res('14 menu package price change alerts quotes on that package', pg_temp.pc('R3-G') = 1);
  perform pg_temp.res('15 alert row: in-app, own studio, deep link to the flow page',
    (select bool_and(n.channel = 'in_app' and n.org_id = q.org_id and n.detail ->> 'path' = 'flow.html?id=' || q.id::text)
       from public.notifications n join public.quotes q on q.id = n.quote_id where n.kind = 'price_change'));

  -- bell gate
  perform pg_temp.login('a_admin@a.test');
  r := public.bell_feed(50);
  perform pg_temp.res('16 quote editor sees price_change in the bell',
    exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'price_change'), r::text);
  perform pg_temp.login('r3_viewer@a.test');
  r := public.bell_feed(50);
  perform pg_temp.res('17 member without quote edit does not',
    not exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'price_change'), r::text);

  -- per-event profit
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.insights_events('2026-03-01', '2026-03-31')$q$);
  perform pg_temp.res('18 role without insights area refused', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.insights_events('2026-03-31', '2026-03-01')$q$);
  perform pg_temp.res('19 reversed range refused', e like '22023%', e);
  r := public.insights_events('2026-03-01', '2026-03-31');
  perform pg_temp.res('20 per-event money: revenue/cost/profit/margin/collected/outstanding',
    jsonb_array_length(r -> 'events') = 1 and r #>> '{events,0,code}' = 'R3-E'
    and (r #>> '{events,0,revenue}')::numeric = 100000 and (r #>> '{events,0,cost}')::numeric = 30000
    and (r #>> '{events,0,profit}')::numeric = 70000 and (r #>> '{events,0,margin_pct}')::numeric = 70
    and (r #>> '{events,0,collected}')::numeric = 40000 and (r #>> '{events,0,outstanding}')::numeric = 60000, r::text);
  perform pg_temp.login('r3_viewer@a.test');
  r := public.insights_events('2026-03-01', '2026-03-31');
  perform pg_temp.res('21 no finance area: rows kept, money null', (r ->> 'finance')::boolean = false
    and jsonb_array_length(r -> 'events') = 1 and r #> '{events,0,revenue}' = 'null'::jsonb and r #> '{events,0,profit}' = 'null'::jsonb, r::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.insights_events('2026-03-01', '2026-03-31');
  perform pg_temp.res('22 other studio sees none of A', jsonb_array_length(r -> 'events') = 0, r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R3-SYNC-REPRICE: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R3-SYNC-REPRICE: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
