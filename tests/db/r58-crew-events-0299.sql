-- r58-crew-events-0299.sql -- R58 (audit 2026-10-28): staff pay, crew-link tokens, crew-link task rules, greeting studio
-- name, crew-link open shifts, run-sheet person matching, crew run-sheet scope, inventory unit cost, event-group card +
-- members, inbox event names. Proves each finding is fixed and the legitimate roles keep working.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

-- re-apply twice (earlier suites re-apply 0012 / 0035 / 0132 / 0265 / 0266 bodies; proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0299_r58_crew_events_hardening.sql
\ir ../../supabase/migrations/0299_r58_crew_events_hardening.sql
set client_min_messages = warning;

-- run one statement as a signed-in member (role authenticated + JWT claims) -> its single value as text, or ERR:<sqlstate>
create or replace function pg_temp.q(p_email text, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = p_email)::text, 'role', 'authenticated')::text, true);
  begin
    execute 'set local role authenticated';
    execute p_sql into r;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    r := 'ERR:' || sqlstate || ':' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
-- the same as the public (crew link, no sign-in)
create or replace function pg_temp.qa(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    execute 'set local role anon';
    execute p_sql into r;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    r := 'ERR:' || sqlstate || ':' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;
create or replace function pg_temp.role(p_role text) returns void language sql as $$
  update public.profiles set role = p_role where email = 'a_staff@a.test';
$$;
create or replace function pg_temp.ra(p_role text, p_area text, p_view boolean, p_edit boolean) returns void language sql as $$
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
  values ('a0000000-0000-4000-8000-000000000001', p_role, p_area, p_view, p_edit, now())
  on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
$$;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01';
  qA2 uuid := 'a0000000-0000-4000-8000-0000005802a2';
  a_staff uuid := (select id from auth.users where email = 'a_staff@a.test');
  a_admin uuid := (select id from auth.users where email = 'a_admin@a.test');
  c_link uuid; c_plain uuid; c_same1 uuid; c_same2 uuid; c_me uuid;
  t_done uuid; t_prog uuid; t_new uuid; t_rej uuid;
  tok1 uuid := 'f2990000-0000-4000-8000-000000000001'; tok2 uuid := 'f2990000-0000-4000-8000-000000000002';
  i1 uuid; n1 uuid; cv uuid; s text; j jsonb; k jsonb; v_cnt int;
begin
  delete from auth.mfa_factors where user_id in (a_staff, a_admin);
  delete from public.team_member_status where user_id in (a_staff, a_admin);
  -- access matrix used below (org A)
  perform pg_temp.ra('coordinator', 'staff', true, true);   perform pg_temp.ra('coordinator', 'inventory', true, false);
  perform pg_temp.ra('coordinator', 'quotes', true, false); perform pg_temp.ra('coordinator', 'runsheet', true, true);
  perform pg_temp.ra('quality', 'staff', true, false);      perform pg_temp.ra('quality', 'inventory', true, false);
  perform pg_temp.ra('quality', 'quotes', false, false);    perform pg_temp.ra('quality', 'finance', false, false);
  perform pg_temp.ra('crew', 'runsheet', true, false);      perform pg_temp.ra('crew', 'calendar', true, false);
  perform pg_temp.ra('crew', 'quotes', false, false);       perform pg_temp.ra('crew', 'staff', false, false);
  perform pg_temp.ra('operations', 'inventory', true, true);

  insert into public.crew_members(name, phone, day_rate, profile_id, attributes, org_id)
    values ('Linked Lata', '+919800058001', 5000, a_staff, '{"monthly_salary":"90000","shirt":"L"}', orgA) returning id into c_link;
  insert into public.crew_members(name, phone, day_rate, attributes, org_id)
    values ('Plain Prem', '+919800058002', 1800, '{"monthly_salary":"30000"}', orgA) returning id into c_plain;

  -- ===== D-01 staff pay ==================================================================================
  perform pg_temp.role('quality');
  s := pg_temp.q('a_staff@a.test', 'select count(*)::text from (select * from public.crew_members) x');
  perform pg_temp.res('01 D-01 staff viewer: select * from crew_members is refused (pay columns not readable)', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', 'select day_rate::text from public.crew_members limit 1');
  perform pg_temp.res('02 D-01 staff viewer: day_rate column refused', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', format('select name from public.crew_members where id = %L', c_link));
  perform pg_temp.res('03 D-01 staff viewer: the other staff columns still readable', s = 'Linked Lata', s);
  s := pg_temp.q('a_staff@a.test', format('select row_to_json(x)::text from public.staff_pay_fields(array[%L]::uuid[]) x', c_link));
  j := case when s like 'ERR:%' then null else s::jsonb end;
  perform pg_temp.res('04 D-01 staff viewer: a linked row''s pay is hidden (rate null, salary field left out, other fields kept)',
    j ->> 'day_rate' is null and not (j -> 'attributes' ? 'monthly_salary') and j -> 'attributes' ->> 'shirt' = 'L' and (j ->> 'pay_hidden')::boolean, s);
  s := pg_temp.q('a_staff@a.test', format('select row_to_json(x)::text from public.staff_pay_fields(array[%L]::uuid[]) x', c_plain));
  perform pg_temp.res('05 D-01 staff viewer: plain crew pay as before', (s::jsonb ->> 'day_rate')::numeric = 1800 and s::jsonb -> 'attributes' ? 'monthly_salary', s);
  s := pg_temp.q('a_admin@a.test', format('select row_to_json(x)::text from public.staff_pay_fields(array[%L]::uuid[]) x', c_link));
  perform pg_temp.res('06 D-01 admin: linked row pay in full (unchanged experience)',
    (s::jsonb ->> 'day_rate')::numeric = 5000 and s::jsonb -> 'attributes' ->> 'monthly_salary' = '90000' and not (s::jsonb ->> 'pay_hidden')::boolean, s);
  perform pg_temp.role('crew');
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.staff_pay_fields(array[%L]::uuid[])', c_plain));
  perform pg_temp.res('07 D-01 no Staff view: staff_pay_fields refused', s like 'ERR:42501%', s);
  perform pg_temp.role('coordinator');
  s := pg_temp.q('a_staff@a.test', format('update public.crew_members set day_rate = 1 where id = %L returning id::text', c_link));
  perform pg_temp.res('08 D-01 staff editor: changing a linked row''s day rate refused', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', format('with u as (update public.crew_members set attributes = %L where id = %L returning id) select id::text from u', '{"shirt":"XL"}', c_link));
  j := (select attributes from public.crew_members where id = c_link);
  perform pg_temp.res('09 D-01 staff editor: a save without the hidden salary field keeps it (never lost)',
    s = c_link::text and j ->> 'shirt' = 'XL' and j ->> 'monthly_salary' = '90000', s || ' ' || j::text);
  s := pg_temp.q('a_staff@a.test', format('update public.crew_members set attributes = %L where id = %L returning id::text', '{"shirt":"XL","monthly_salary":"1"}', c_link));
  perform pg_temp.res('10 D-01 staff editor: changing the salary field refused', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', format('with u as (update public.crew_members set attributes = %L where id = %L returning id) select id::text from u', '{"monthly_salary":"30000","ctc":"5"}', c_plain));
  perform pg_temp.res('11 D-01 staff editor: plain crew pay fields still editable', s not like 'ERR:%', s);
  s := pg_temp.q('a_staff@a.test', format('with u as (update public.crew_members set day_rate = 2000, notes = %L where id = %L returning id) select id::text from u', 'ok', c_plain));
  perform pg_temp.res('12 D-01 staff editor: plain crew day rate still editable', s = c_plain::text and (select day_rate from public.crew_members where id = c_plain) = 2000, s);
  s := pg_temp.q('a_staff@a.test', format('update public.crew_members set notes = %L where id = %L returning notes', 'note', c_link));
  perform pg_temp.res('13 D-01 staff editor: other fields of a linked row still editable', s = 'note', s);
  s := pg_temp.q('a_admin@a.test', format('with u as (update public.crew_members set day_rate = 5500 where id = %L returning id) select id::text from u', c_link));
  perform pg_temp.res('14 D-01 admin: can still change a linked row''s day rate', s = c_link::text and (select day_rate from public.crew_members where id = c_link) = 5500, s);
  s := pg_temp.q('a_staff@a.test', 'select count(*)::text from public.crew_members where active');
  perform pg_temp.res('15 D-01 count(*) on the visible columns works (Staff list count)', s ~ '^[0-9]+$', s);

  -- ===== D-02 crew-link tokens ===========================================================================
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (tok1, qA, '+919800058003', 'Same Sam', orgA);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (tok2, qA, '+919800058004', 'Same Sam', orgA);
  perform pg_temp.role('quality');
  s := pg_temp.q('a_staff@a.test', 'select token::text from public.work_tokens limit 1');
  perform pg_temp.res('16 D-02 staff viewer: work_tokens.token refused', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.work_links_for_event(%L)', qA));
  perform pg_temp.res('17 D-02 staff viewer: no links from work_links_for_event', s = '0', s);
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.work_tokens where quote_id = %L', qA));
  perform pg_temp.res('18 D-02 staff viewer: link rows (without the token) still readable', s::int >= 2, s);
  perform pg_temp.role('coordinator');
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.work_links_for_event(%L) where token in (%L, %L)', qA, tok1, tok2));
  perform pg_temp.res('19 D-02 staff editor: gets the links', s = '2', s);
  s := pg_temp.q('a_admin@a.test', format('select count(*)::text from public.work_links_for_event(%L) where token = %L', qA, tok1));
  perform pg_temp.res('20 D-02 admin: gets the links', s = '1', s);
  s := pg_temp.qa(format('select count(*)::text from public.work_links_for_event(%L)', qA));
  perform pg_temp.res('21 D-02 anon cannot call work_links_for_event', s like 'ERR:42501%', s);

  -- ===== D-03 worker_respond =============================================================================
  insert into public.event_tasks(quote_id, category, title, assignee_name, assignee_phone, status, verify_status, completed_at, org_id)
    values (qA, 'Setup', 'Done task', 'Same Sam', '+919800058003', 'completed', 'passed', now(), orgA) returning id into t_done;
  insert into public.event_tasks(quote_id, category, title, assignee_name, assignee_phone, status, org_id)
    values (qA, 'Setup', 'Busy task', 'Same Sam', '+919800058003', 'in_progress', orgA) returning id into t_prog;
  insert into public.event_tasks(quote_id, category, title, assignee_name, assignee_phone, status, org_id)
    values (qA, 'Setup', 'New task', 'Same Sam', '+919800058003', 'assigned', orgA) returning id into t_new;
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_done, 'reject'));
  perform pg_temp.res('22 D-03 crew link: rejecting a completed (QC-passed) task refused',
    s like '%already closed%' and (select status from public.event_tasks where id = t_done) = 'completed', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_done, 'accept'));
  perform pg_temp.res('23 D-03 crew link: re-accepting a completed task refused', s like '%already closed%', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_prog, 'reject'));
  perform pg_temp.res('24 D-03 crew link: rejecting a started task refused (as crew_task_respond)', s like '%already started%', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_new, 'reject'));
  perform pg_temp.res('25 D-03 crew link: rejecting an assigned task still works', s like '%"rejected"%', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_new, 'accept'));
  perform pg_temp.res('26 D-03 crew link: accepting after a rejection is refused (r92 / 0311: the answer is final)',
    (s like '%"refused": true%' or s like '%22023%cannot move from rejected to accepted%')   -- 0311 wrapper, or its trigger under a re-applied 0299
    and (select status from public.event_tasks where id = t_new) = 'rejected', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok1, t_prog, 'complete'));
  perform pg_temp.res('27 D-03 crew link: completing a started task still works', s like '%"completed"%', s);
  s := pg_temp.qa(format('select public.worker_respond(%L, %L, %L)::text', tok2, t_new, 'start'));
  perform pg_temp.res('28 D-03 another person''s link cannot touch the task', s like '%task not found%', s);

  -- ===== D-04 greeting studio name =======================================================================
  insert into public.nurture_templates(occasion_type, subject, body, org_id) values ('custom', 'Hi from {{studio}}', 'Love, {{studio}}', orgA)
    on conflict do nothing;
  update public.nurture_templates set subject = 'Hi from {{studio}}', body = 'Love, {{studio}}' where org_id = orgA and occasion_type = 'custom';
  insert into public.nurture(name, email, occasion_type, occasion_date, quote_id, org_id)
    values ('Client C', 'c58@c.test', 'custom', current_date - 365, qA, orgA) returning id into n1;
  s := pg_temp.q('a_admin@a.test', format('select public.queue_nurture_greeting(%L)::text', n1));
  perform pg_temp.res('29 D-04 greeting {{studio}} = the studio''s own name',
    s not like 'ERR:%' and s::jsonb ->> 'subject' = 'Hi from Studio A' and s::jsonb ->> 'body' = 'Love, Studio A', s);
  perform pg_temp.res('30 D-04 no database function carries the demo studio name any more (except kept copies)',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc like '%Blueprint Stage%' and p.proname not like '%__pre0299'));

  -- ===== D-06 run-sheet person matching ==================================================================
  insert into public.crew_members(name, phone, org_id) values ('Same Sam', '+919800058003', orgA) returning id into c_same1;
  insert into public.crew_members(name, phone, org_id) values ('Same Sam', '+919800058004', orgA) returning id into c_same2;
  insert into public.run_sheet_items(quote_id, title, owner, owner_kind, owner_crew_id, note, org_id)
    values (qA, 'Sound check', 'Same Sam', 'staff', c_same1, 'client mobile 98xx', orgA);
  insert into public.run_sheet_items(quote_id, title, owner, note, org_id) values (qA, 'Legacy item', 'Same Sam', 'legacy note', orgA);
  s := pg_temp.qa(format('select public.worker_assignment_updates(%L)::text', tok1));
  perform pg_temp.res('31 D-06 crew link: own item (by owner id) and own legacy item (name + phone)',
    s like '%Sound check%' and s like '%Legacy item%', s);
  s := pg_temp.qa(format('select public.worker_assignment_updates(%L)::text', tok2));
  perform pg_temp.res('32 D-06 same name, other person: the other''s item is not shown',
    s not like '%Sound check%' and s not like '%client mobile%', s);
  perform pg_temp.res('33 D-06 same name, other person: legacy item only by name + own phone (shown, own staff record)',
    s like '%Legacy item%', s);
  delete from public.work_tokens where token = tok2;   -- fixture only
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values (tok2, qA, '+919800058099', 'Same Sam', orgA);
  s := pg_temp.qa(format('select public.worker_assignment_updates(%L)::text', tok2));
  perform pg_temp.res('34 D-06 a link with the same NAME but no staff record sees nothing (bare name no longer matches)',
    s not like '%Legacy item%' and s not like '%Sound check%', s);

  -- ===== D-07 crew run-sheet scope =======================================================================
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values (qA2, 'A-0582', 'Other event', 'quote', '{"name":"Zed"}', '{"subtotal":100,"discount":0,"gstPct":18,"total":118}', 1, 'sent', orgA, now(), now());
  insert into public.run_sheet_items(quote_id, title, note, org_id) values (qA2, 'Other item', 'secret note', orgA);
  insert into public.event_tasks(quote_id, category, title, crew_id, assignee_name, assignee_phone, status, org_id)
    values (qA, 'Setup', 'Lata task', c_link, 'Linked Lata', '+919800058001', 'assigned', orgA);
  perform pg_temp.role('crew');
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.run_sheet_items where quote_id = %L', qA));
  perform pg_temp.res('35 D-07 crew: run-sheet of an event they work on is readable', s::int >= 2, s);
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.run_sheet_items where quote_id = %L', qA2));
  perform pg_temp.res('36 D-07 crew: run-sheet (and notes) of another event not readable', s = '0', s);
  perform pg_temp.role('coordinator');
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.run_sheet_items where quote_id = %L', qA2));
  perform pg_temp.res('37 D-07 other roles with Run-sheet view: unchanged', s = '1', s);

  -- ===== D-09 inventory unit cost ========================================================================
  insert into public.inventory_items(name, total_qty, unit_cost, org_id) values ('Chair 58', 10, 150, orgA) returning id into i1;
  perform pg_temp.role('quality');
  s := pg_temp.q('a_staff@a.test', 'select unit_cost::text from public.inventory_items limit 1');
  perform pg_temp.res('38 D-09 inventory viewer: unit_cost column refused', s like 'ERR:42501%', s);
  s := pg_temp.q('a_staff@a.test', format('select name from public.inventory_items where id = %L', i1));
  perform pg_temp.res('39 D-09 inventory viewer: the item itself still readable', s = 'Chair 58', s);
  s := pg_temp.q('a_staff@a.test', format('select count(*)::text from public.inventory_costs(array[%L]::uuid[])', i1));
  perform pg_temp.res('40 D-09 inventory viewer: no cost from inventory_costs', s = '0', s);
  perform pg_temp.role('operations');   -- inventory edit (and finance through the fixture)
  s := pg_temp.q('a_staff@a.test', format('select unit_cost::text from public.inventory_costs(array[%L]::uuid[])', i1));
  perform pg_temp.res('41 D-09 inventory editor: gets the cost', s::numeric = 150, s);
  s := pg_temp.q('a_staff@a.test', format('update public.inventory_items set unit_cost = 175 where id = %L returning id::text', i1));
  perform pg_temp.res('42 D-09 inventory editor: can still change the cost', s = i1::text, s);
  perform pg_temp.role('sales');        -- finance view (fixture), no inventory edit
  s := pg_temp.q('a_staff@a.test', format('select unit_cost::text from public.inventory_costs(array[%L]::uuid[])', i1));
  perform pg_temp.res('43 D-09 finance role: gets the cost', s::numeric = 175, s);
  s := pg_temp.q('a_admin@a.test', format('select unit_cost::text from public.inventory_costs(array[%L]::uuid[])', i1));
  perform pg_temp.res('44 D-09 admin: gets the cost', s::numeric = 175, s);

  -- ===== BS-01 event-group card + members ================================================================
  update public.quotes set status = 'confirmed', client = client || '{"phone":"+919822222222","email":"alice@c.test"}' where id = qA;
  update public.event_tasks set status = 'cancelled' where title = 'Lata task';   -- no live task on the event for now
  perform pg_temp.role('quality');      -- no quotes view, no task on the event
  s := pg_temp.q('a_admin@a.test', format('select public.create_event_group(%L, array[%L]::uuid[])::text', qA, a_staff));
  cv := case when s ~ '^[0-9a-f-]{36}$' then s::uuid end;
  perform pg_temp.res('45 BS-01 create_event_group works', cv is not null, s);
  perform pg_temp.res('46 BS-01 a member whose role can''t open the event is not added at creation',
    not exists (select 1 from public.chat_members m where m.conversation_id = cv and m.user_id = a_staff));
  j := (select m.meta from public.chat_messages m where m.conversation_id = cv and m.kind = 'card' order by m.created_at limit 1);
  perform pg_temp.res('47 BS-01 the new card has no client phone / e-mail (name kept)',
    j -> 'client' ->> 'name' = 'Alice' and not (j -> 'client' ? 'phone') and not (j -> 'client' ? 'email') and j::text not like '%9822222222%', j::text);
  s := pg_temp.q('a_admin@a.test', format('select public.event_group_contact(%L)::text', qA));
  perform pg_temp.res('48 BS-01 Quotes viewer gets the phone / e-mail from event_group_contact',
    s::jsonb ->> 'phone' = '+919822222222' and s::jsonb ->> 'email' = 'alice@c.test', s);
  s := pg_temp.q('a_staff@a.test', format('select coalesce(public.event_group_contact(%L)::text, %L)', qA, 'null'));
  perform pg_temp.res('49 BS-01 no Quotes view: event_group_contact answers nothing', s = 'null', s);
  s := pg_temp.q('a_admin@a.test', format('select public.chat_add_members(%L, array[%L]::uuid[])::text', cv, a_staff));
  perform pg_temp.res('50 BS-01 chat_add_members refuses a person whose role can''t open the event', s like 'ERR:42501%' and s like '%Users & access%', s);
  s := pg_temp.q('a_admin@a.test', format('select public.event_group_add_people(%L, %L)::text', cv, jsonb_build_array(jsonb_build_object('kind', 'user', 'id', a_staff))));
  perform pg_temp.res('51 BS-01 event_group_add_people: not added, counted as not_allowed',
    s not like 'ERR:%' and (s::jsonb ->> 'not_allowed')::int = 1 and (s::jsonb ->> 'users')::int = 0
    and not exists (select 1 from public.chat_members m where m.conversation_id = cv and m.user_id = a_staff), s);
  s := pg_temp.q('a_admin@a.test', format('select public.event_group_add_people(%L, %L)::text', cv, jsonb_build_array(jsonb_build_object('kind', 'staff', 'id', c_link))));
  perform pg_temp.res('52 BS-01 a staff record whose login can''t open the event is not made a member',
    s not like 'ERR:%' and (s::jsonb ->> 'not_allowed')::int = 1, s);
  update public.event_tasks set status = 'assigned' where title = 'Lata task';
  perform pg_temp.role('crew');         -- crew with a task on the event (Lata task, linked row) may join
  s := pg_temp.q('a_admin@a.test', format('select public.chat_add_members(%L, array[%L]::uuid[])::text', cv, a_staff));
  perform pg_temp.res('53 BS-01 crew with a task on the event can be added',
    s not like 'ERR:%' and exists (select 1 from public.chat_members m where m.conversation_id = cv and m.user_id = a_staff), s);
  delete from public.chat_members where conversation_id = cv and user_id = a_staff;
  perform pg_temp.role('coordinator');  -- quotes view
  s := pg_temp.q('a_admin@a.test', format('select public.event_group_add_people(%L, %L)::text', cv, jsonb_build_array(jsonb_build_object('kind', 'user', 'id', a_staff))));
  perform pg_temp.res('54 BS-01 a Quotes viewer can be added as before', s not like 'ERR:%' and (s::jsonb ->> 'users')::int = 1, s);
  -- an old-style card (from before 0299) gets its phone / e-mail taken out once, original kept privately
  insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
    values (cv, orgA, null, 'card', 'Event details', jsonb_build_object('kind', 'event', 'quote_id', qA, 'client',
            jsonb_build_object('name', 'Alice', 'phone', '+919822222222', 'email', 'alice@c.test'))) returning id into i1;
  set client_min_messages = error;
end $$;
\ir ../../supabase/migrations/0299_r58_crew_events_hardening.sql
set client_min_messages = warning;
do $$
declare j jsonb; s text; v_old jsonb; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  select m.meta into j from public.chat_messages m where m.body = 'Event details' and m.meta ->> 'kind' = 'event'
     and m.id in (select b.message_id from public.chat_card_contact_backup_r58 b) order by m.created_at desc limit 1;
  select b.original_meta into v_old from public.chat_card_contact_backup_r58 b order by b.saved_at desc limit 1;
  perform pg_temp.res('55 BS-01 existing card: phone / e-mail taken out of chat, name kept',
    j is not null and j -> 'client' ->> 'name' = 'Alice' and not (j -> 'client' ? 'phone') and not (j -> 'client' ? 'email'), coalesce(j::text, 'none'));
  perform pg_temp.res('56 BS-01 existing card: the original is kept in the private backup (nothing lost)',
    v_old -> 'client' ->> 'phone' = '+919822222222', coalesce(v_old::text, 'none'));
  s := pg_temp.q('a_admin@a.test', 'select count(*)::text from public.chat_card_contact_backup_r58');
  perform pg_temp.res('57 BS-01 the backup table is not readable by the app', s like 'ERR:42501%', s);

  -- ===== BS-03 inbox / bell event names (wrapper over a stub of the 0266 answer; rolled back) =============
  perform pg_temp.role('quality');
  s := pg_temp.q('a_staff@a.test', 'select (public.inbox_feed() ? ''items'')::text');
  perform pg_temp.res('58 BS-03 inbox_feed still answers (real body)', s = 'true', s);
  s := pg_temp.q('a_staff@a.test', 'select (public.bell_feed(20) ? ''items'')::text');
  perform pg_temp.res('59 BS-03 bell_feed still answers (real body)', s = 'true', s);
  execute $f$create or replace function public.inbox_feed__pre0299(p_tab text default 'unread', p_filter text default null, p_quote uuid default null, p_limit integer default 50, p_cursor text default null)
    returns jsonb language sql as $b$ select '{"items":[{"id":"1","kind":"task_accept","event_code":"A-0001","event_title":"Wedding A"}],"counts":{"unread":1}}'::jsonb $b$ $f$;
  execute $f$create or replace function public.bell_feed__pre0299(p_limit integer default 20)
    returns jsonb language sql as $b$ select '{"items":[{"id":"1","kind":"task_accept","event_code":"A-0001","event_title":"Wedding A"}],"unread":1}'::jsonb $b$ $f$;
  s := pg_temp.q('a_staff@a.test', 'select public.inbox_feed()::text');
  perform pg_temp.res('60 BS-03 inbox row: no event code / title without Quotes view (rest kept)',
    s::jsonb -> 'items' -> 0 ->> 'kind' = 'task_accept' and not (s::jsonb -> 'items' -> 0 ? 'event_code') and not (s::jsonb -> 'items' -> 0 ? 'event_title')
    and (s::jsonb -> 'counts' ->> 'unread')::int = 1, s);
  s := pg_temp.q('a_staff@a.test', 'select public.bell_feed(20)::text');
  perform pg_temp.res('61 BS-03 bell row: no event code / title without Quotes view', not (s::jsonb -> 'items' -> 0 ? 'event_code') and (s::jsonb ->> 'unread')::int = 1, s);
  s := pg_temp.q('a_admin@a.test', 'select public.inbox_feed()::text');
  perform pg_temp.res('62 BS-03 Quotes viewer keeps the event code / title', s::jsonb -> 'items' -> 0 ->> 'event_code' = 'A-0001', s);

  -- ===== D-05 crew link open shifts (wrapper over a stub of the 0265 answer; rolled back) =================
  s := pg_temp.qa('select public.crew_link_home(''f2990000-0000-4000-8000-000000000001'')::text');
  perform pg_temp.res('63 D-05 crew_link_home still answers (real body)', s not like 'ERR:%' and s::jsonb ? 'today', s);
  execute $f$create or replace function public.crew_link_home__pre0299(p_token uuid) returns jsonb language sql as $b$ select '{"crew":{"name":"x"},"shifts":[
      {"id":"s1","event_code":"A-1","event_title":"E1","wage":900,"basis":"day","my_status":null,"unavailable":false},
      {"id":"s2","event_code":"A-2","event_title":"E2","wage":800,"basis":"day","my_status":"approved","unavailable":false},
      {"id":"s3","event_code":"A-3","event_title":"E3","wage":700,"basis":"hour","my_status":null,"unavailable":true},
      {"id":"s4","event_code":"A-4","event_title":"E4","wage":600,"basis":"day","my_status":"pending","unavailable":true}]}'::jsonb $b$ $f$;
  s := pg_temp.qa('select public.crew_link_home(''f2990000-0000-4000-8000-000000000001'')::text');
  j := s::jsonb -> 'shifts';
  perform pg_temp.res('64 D-05 no internal event code on any shift', not exists (select 1 from jsonb_array_elements(j) e where e ? 'event_code'), s);
  perform pg_temp.res('65 D-05 wage only on the person''s own shifts (applied / on it)',
    (select e ->> 'wage' from jsonb_array_elements(j) e where e ->> 'id' = 's1') is null
    and (select (e ->> 'wage')::int from jsonb_array_elements(j) e where e ->> 'id' = 's2') = 800
    and (select (e ->> 'wage')::int from jsonb_array_elements(j) e where e ->> 'id' = 's4') = 600, s);
  perform pg_temp.res('66 D-05 a shift on a day marked unavailable is left out (unless already claimed)',
    not exists (select 1 from jsonb_array_elements(j) e where e ->> 'id' = 's3') and jsonb_array_length(j) = 3, s);

  -- ===== shape, grants, kept copies ======================================================================
  perform pg_temp.res('67 every re-issued function carries its 0299 marker',
    (select bool_and(position(m in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure(f)), '')) > 0) from (values
      ('public.worker_respond(uuid,uuid,text)', 'r58-worker-respond-0299'), ('public.queue_nurture_greeting__pre0202(uuid)', 'r58-greeting-studio-0299'),
      ('public.worker_assignment_updates(uuid)', 'r58-assign-person-0299'), ('public._event_card(uuid)', 'r58-event-card-0299'),
      ('public.create_event_group(uuid,uuid[])', 'r58-event-group-members-0299'), ('public.chat_add_members(uuid,uuid[])', 'r58-event-group-members-0299'),
      ('public.event_group_add_people(uuid,jsonb)', 'r58-event-group-members-0299')) v(f, m)));
  perform pg_temp.res('68 previous bodies kept once as __pre0299, none callable by the app',
    (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0299') = 10
    and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0299'
                     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))));
  perform pg_temp.res('69 the crew link RPCs stay callable by the public link, the new studio RPCs are signed-in only',
    has_function_privilege('anon', 'public.worker_respond(uuid,uuid,text)', 'execute')
    and has_function_privilege('anon', 'public.crew_link_home(uuid)', 'execute')
    and has_function_privilege('anon', 'public.worker_assignment_updates(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.staff_pay_fields(uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.inventory_costs(uuid[])', 'execute')
    and not has_function_privilege('anon', 'public.event_group_contact(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.staff_pay_fields(uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._event_card(uuid)', 'execute'));
  perform pg_temp.res('70 nothing removed: the protected columns and every table are still there',
    exists (select 1 from information_schema.columns where table_name = 'crew_members' and column_name = 'day_rate')
    and exists (select 1 from information_schema.columns where table_name = 'work_tokens' and column_name = 'token')
    and exists (select 1 from information_schema.columns where table_name = 'inventory_items' and column_name = 'unit_cost'));
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R58-CREW-EVENTS-0299: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R58-CREW-EVENTS-0299: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
