-- checkout-shortage-0105.sql - behavioral proof for 0105: check-out availability counts open
-- check-outs AND other events' same-date reservations, a shortage returns structured info (not an
-- error), partial check-out takes only what is free, stock never goes negative, tenant + role gates,
-- leads personal dates, nurture template seed is fill-only. Local disposable PG only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _cs(name text, result text); grant all on _cs to anon, authenticated;
-- fixture studios are created after the migration ran: apply it again (idempotent) so they get the seed
\i supabase/migrations/0105_checkout_shortage_nurture.sql

do $$ declare a_admin uuid; a_staff uuid; b_admin uuid; org uuid := 'a0000000-0000-4000-8000-000000000001';
  chairs uuid; chairs2 uuid; benches uuid; qX uuid := gen_random_uuid(); qY uuid := gen_random_uuid(); qZ uuid := gen_random_uuid();
  j jsonb; n numeric; e text; cnt int; begin
  execute 'reset role';
  select id into a_admin from auth.users where email='a_admin@a.test';
  select id into a_staff from auth.users where email='a_staff@a.test';
  select id into b_admin from auth.users where email='b_admin@b.test';
  insert into public.inventory_items(name, total_qty, category, org_id) values ('CS Chiavari chairs', 200, 'Seating', org) returning id into chairs;
  insert into public.inventory_items(name, total_qty, category, org_id) values ('CS Tiffany chairs', 150, 'Seating', org) returning id into chairs2;
  insert into public.inventory_items(name, total_qty, category, org_id) values ('CS Benches', 0, 'Seating', org) returning id into benches;
  -- X: past event still holding 80 chairs (overdue); Y: our target on 28 Dec; Z: another event on 28 Dec with a reservation
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_date) values
    (qX, 'CS-X', 'Event X', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date - 5),
    (qY, 'CS-Y', 'Event Y', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date + 30),
    (qZ, 'CS-Z', 'Event Z', 'confirmed', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', org, current_date + 30);
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, issued_to, org_id) values (chairs, qX, 80, 'Crew X', org);
  insert into public.inventory_reservations(item_id, quote_id, qty, status) values (chairs, qZ, 40, 'reserved');

  perform auth.login_as(a_admin);
  j := public.checkout_availability(chairs, qY);
  insert into _cs values ('01 available = 200 - 80 out - 40 reserved by Event Z same day = 80',
    case when (j->>'available')::numeric = 80 and (j->>'out_now')::numeric = 80 and (j->>'reserved_other')::numeric = 40 then 'PASS' else 'FAIL: '||j::text end);
  insert into _cs values ('02 blocking check-out names Event X + due date + overdue',
    case when j->'blocking'->0->>'event' = 'Event X' and (j->'blocking'->0->>'qty')::numeric = 80
      and j->'blocking'->0->>'due_back' = (current_date - 4)::text and jsonb_array_length(j->'overdue') = 1 then 'PASS' else 'FAIL: '||(j->'blocking')::text end);
  insert into _cs values ('03 substitutes: same category with free stock only (Tiffany yes, Benches 0 no)',
    case when jsonb_array_length(j->'substitutes') = 1 and j->'substitutes'->0->>'name' = 'CS Tiffany chairs'
      and (j->'substitutes'->0->>'available')::numeric = 150 then 'PASS' else 'FAIL: '||(j->'substitutes')::text end);
  insert into _cs values ('04 reserved_by lists Event Z', case when j->'reserved_by'->0->>'event' = 'Event Z' then 'PASS' else 'FAIL: '||(j->'reserved_by')::text end);

  -- shortage: structured, no row written
  select count(*) into cnt from public.inventory_checkouts where item_id = chairs;
  j := public.checkout_equipment_smart(chairs, qY, 200, 'Crew Y', null, null, false);
  insert into _cs values ('05 shortage returns ok=false code=shortage with requested + available',
    case when (j->>'ok')::boolean = false and j->>'code' = 'shortage' and (j->>'requested')::numeric = 200 and (j->>'available')::numeric = 80 then 'PASS' else 'FAIL: '||j::text end);
  insert into _cs values ('06 shortage writes nothing', case when (select count(*) from public.inventory_checkouts where item_id = chairs) = cnt then 'PASS' else 'FAIL' end);

  -- partial: takes exactly the free 80 and records the shortfall
  j := public.checkout_equipment_smart(chairs, qY, 200, 'Crew Y', null, 'stage side', true);
  insert into _cs values ('07 partial check-out takes the 80 available, shortfall 120',
    case when (j->>'ok')::boolean and (j->>'partial')::boolean and (j->>'qty_out')::numeric = 80 and (j->>'shortfall')::numeric = 120 then 'PASS' else 'FAIL: '||j::text end);
  insert into _cs values ('08 shortfall recorded in the note',
    case when exists (select 1 from public.inventory_checkouts where id = (j->>'checkout_id')::uuid and note like 'stage side | Short by 120%') then 'PASS' else 'FAIL' end);
  j := public.checkout_availability(chairs, qY);
  insert into _cs values ('09 nothing left free after partial (never negative)', case when (j->>'available')::numeric = 0 then 'PASS' else 'FAIL: '||j::text end);
  j := public.checkout_equipment_smart(chairs, qY, 1, 'Crew Y', null, null, true);
  insert into _cs values ('10 partial with 0 free is a shortage, not a 0-qty row', case when (j->>'ok')::boolean = false then 'PASS' else 'FAIL: '||j::text end);
  -- Event Z itself may still take its reserved 40 (its own reservation does not block it)
  j := public.checkout_equipment_smart(chairs, qZ, 40, 'Crew Z', null, null, false);
  insert into _cs values ('11 own reservation does not block its event (Z takes 40)', case when (j->>'ok')::boolean and (j->>'qty_out')::numeric = 40 then 'PASS' else 'FAIL: '||j::text end);
  select 200 - sum(qty_out - coalesce(qty_in,0)) into n from public.inventory_checkouts where item_id = chairs and status in ('out','partial');
  insert into _cs values ('12 physical stock never negative (200 - out >= 0)', case when n >= 0 then 'PASS' else 'FAIL: '||n end);
  -- a full fit is a plain check-out
  j := public.checkout_equipment_smart(chairs2, qY, 150, 'Crew Y', null, null, false);
  insert into _cs values ('13 full fit checks out all', case when (j->>'ok')::boolean and not (j->>'partial')::boolean then 'PASS' else 'FAIL: '||j::text end);
  e := ''; begin perform public.checkout_equipment_smart(chairs2, qY, 0, 'x', null, null, false); exception when others then e := sqlstate; end;
  insert into _cs values ('14 qty 0 refused', case when e = '22023' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.checkout_equipment_smart(chairs2, qY, 1, '  ', null, null, false); exception when others then e := sqlstate; end;
  insert into _cs values ('15 blank issued_to refused', case when e = '22023' then 'PASS' else 'FAIL: '||e end);

  -- other studio / staff without inventory edit / anon
  perform auth.logout(); perform auth.login_as(b_admin);
  e := ''; begin perform public.checkout_availability(chairs, null); exception when others then e := sqlstate; end;
  insert into _cs values ('16 other studio cannot read availability', case when e = '42501' then 'PASS' else 'FAIL: '||e end);
  e := ''; begin perform public.checkout_equipment_smart(chairs2, null, 1, 'x', null, null, true); exception when others then e := sqlstate; end;
  insert into _cs values ('17 other studio cannot check out', case when e = '42501' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout(); perform auth.login_as(a_staff);
  e := ''; begin perform public.checkout_equipment_smart(chairs2, null, 1, 'x', null, null, true); exception when others then e := sqlstate; end;
  insert into _cs values ('18 role without inventory edit cannot check out', case when e = '42501' then 'PASS' else 'FAIL: '||e end);
  perform auth.logout();
  execute 'reset role';
  insert into _cs values ('19 helper not callable by the app', case when not has_function_privilege('authenticated', 'public._checkout_free(uuid,date,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.checkout_equipment_smart(uuid,uuid,numeric,text,uuid,text,boolean)', 'execute') then 'PASS' else 'FAIL' end);

  -- leads personal dates
  insert into _cs values ('20 leads.birthday / anniversary nullable dates', case when (select count(*) from information_schema.columns
    where table_schema='public' and table_name='leads' and column_name in ('birthday','anniversary') and data_type='date' and is_nullable='YES') = 2 then 'PASS' else 'FAIL' end);

  -- nurture templates: seeded for each studio, fill-only
  insert into _cs values ('21 new occasions seeded for studio A', case when (select count(*) from public.nurture_templates where org_id = org
    and occasion_type in ('corporate_annual_day','annual_day_wishes','client_anniversary','new_year','diwali','holi','raksha_bandhan','dussehra','ramadan','eid','christmas','uae_national_day')) = 12 then 'PASS' else 'FAIL' end);
  update public.nurture_templates set body = 'MY OWN DIWALI TEXT' where org_id = org and occasion_type = 'diwali';
  delete from public.nurture_templates where org_id = org and occasion_type = 'holi';
exception when others then execute 'reset role'; insert into _cs values ('xx setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

\i supabase/migrations/0105_checkout_shortage_nurture.sql
insert into _cs select '22 re-run keeps the studio-edited template', case when (select body from public.nurture_templates
  where org_id = 'a0000000-0000-4000-8000-000000000001' and occasion_type = 'diwali') = 'MY OWN DIWALI TEXT' then 'PASS' else 'FAIL' end;
insert into _cs select '23 re-run adds back only the missing key', case when exists (select 1 from public.nurture_templates
  where org_id = 'a0000000-0000-4000-8000-000000000001' and occasion_type = 'holi') then 'PASS' else 'FAIL' end;
insert into _cs select '24 seeded templates use only server placeholders', case when not exists (select 1 from public.nurture_templates
  where (subject || body) ~ '\{\{\s*(event_date|planner_name|phone|client_name|studio_name)\s*\}\}') then 'PASS' else 'FAIL' end;

select name, result from _cs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'CHECKOUT-SHORTAGE-0105: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'CHECKOUT-SHORTAGE-0105: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _cs;
rollback;
