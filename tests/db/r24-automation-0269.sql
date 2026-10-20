-- r24-automation-0269.sql -- 0269: run-sheet reminders (a real owner per line, bell + e-mail queued + WhatsApp queue +
-- event chat, studio default 15 / 0 min, per-line time, never twice, never late), the Automations settings, the public
-- enquiry form -> a lead (rate limits, honeypot, consent, no data exposure, instant reply queued) and the existing
-- quote -> lead sync. Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _dr(name text, result text); grant all on _dr to anon, authenticated, service_role;
create temp table _dk(k text primary key, v text); grant all on _dk to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text default null) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip, 'user-agent', 'TestUA/1')::text, false); end if;
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, false);
  perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _dr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _dk values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _dk where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid, p_name text default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, p_email, p_name, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role, full_name = excluded.full_name;
  return u;
end $$;

-- ---- the migration, twice (safe to re-run) -----------------------------------------------------------------------
\ir ../../supabase/migrations/0269_r24_automation.sql
\ir ../../supabase/migrations/0269_r24_automation.sql

-- ---- setup ------------------------------------------------------------------------------------------------------
-- the event is "today" in the studio zone and the lines start 15 minutes from now (so the 15-minute reminder is due)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; qb uuid := 'b0000000-0000-4000-8000-00000000da01';
  adm uuid; crd uuid; crw uuid; bm uuid; c1 uuid; c2 uuid; v1 uuid; cv uuid; loc timestamp := (now() at time zone 'Asia/Kolkata') + interval '15 minutes'; begin
  crd := pg_temp.member('r24_coord@a.test', 'coordinator', a, 'Ravi Coordinator');
  crw := pg_temp.member('r24_crew@a.test', 'crew', a, 'Crew Login');
  bm  := pg_temp.member('r24_b@b.test', 'coordinator', b, 'Bina B');
  perform pg_temp.su();
  select id into adm from public.profiles where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Asha Admin' where id = adm;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (a, 'coordinator', 'runsheet', true, true, now()), (a, 'coordinator', 'controls', true, false, now()),
    (a, 'crew', 'runsheet', true, false, now()), (a, 'crew', 'controls', false, false, now()),
    (b, 'coordinator', 'runsheet', true, true, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.quotes set status = 'confirmed', event_date = loc::date, title = 'Wedding A' where id = qa;
  update public.quotes set status = 'confirmed', event_date = loc::date, title = 'Wedding B' where id = qb;
  update public.organizations set public_slug = 'studio-a-r24' where id = a;
  insert into public.crew_members(id, name, phone, email, org_id) values (gen_random_uuid(), 'Suresh Lights', '98765 43210', 'suresh@crew.test', a) returning id into c1;
  insert into public.crew_members(id, name, phone, org_id, profile_id) values (gen_random_uuid(), 'Crew Login', '9811111111', a, crw) returning id into c2;
  insert into public.vendors(id, name, category, email, phone, org_id) values (gen_random_uuid(), 'Deccan Rentals', 'Furniture', 'orders@deccan.test', '+91 99887 76655', a) returning id into v1;
  insert into public.chat_conversations(id, org_id, kind, title, quote_id, created_by) values (gen_random_uuid(), a, 'group', 'Event group A-0001', qa, adm) returning id into cv;
  insert into public.chat_members(conversation_id, user_id, org_id) values (cv, adm, a), (cv, crd, a);
  perform pg_temp.put('bm', bm::text); perform pg_temp.put('adm', adm::text); perform pg_temp.put('crd', crd::text); perform pg_temp.put('crw', crw::text);
  perform pg_temp.put('c1', c1::text); perform pg_temp.put('c2', c2::text); perform pg_temp.put('v1', v1::text); perform pg_temp.put('cv', cv::text);
  perform pg_temp.put('t', to_char(loc, 'HH24:MI'));
end $$;

-- ---- 1) schema + defaults ---------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 seven new run-sheet columns (nullable / defaulted) exist',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'run_sheet_items'
       and column_name in ('owner_kind', 'owner_user_id', 'owner_crew_id', 'owner_vendor_id', 'remind', 'remind_offsets', 'remind_group')) = 7);
  perform pg_temp.res('02 three new tables, RLS on, no anon / signed-in table privilege',
    (select count(*) from pg_class c where c.oid in (to_regclass('public.automation_settings'), to_regclass('public.runsheet_reminder_sends'),
       to_regclass('public.lead_enquiries')) and c.relrowsecurity) = 3
    and not has_table_privilege('authenticated', 'public.automation_settings', 'select')
    and not has_table_privilege('anon', 'public.lead_enquiries', 'select')
    and not has_table_privilege('authenticated', 'public.runsheet_reminder_sends', 'insert')
    and exists (select 1 from pg_trigger where tgrelid = 'public.runsheet_reminder_sends'::regclass and tgname = 'zz_quote_org_match'));
  perform pg_temp.res('03 defaults without a settings row: run-sheet reminders ON at 15 / 0, enquiry form OFF',
    (public._r24_cfg('a0000000-0000-4000-8000-000000000001') ->> 'runsheet_enabled')::boolean
    and public._r24_cfg('a0000000-0000-4000-8000-000000000001') -> 'runsheet_offsets' = '[15, 0]'::jsonb
    and not (public._r24_cfg('a0000000-0000-4000-8000-000000000001') ->> 'enquiry_enabled')::boolean);
  perform pg_temp.res('04 tick / claim / mark are service role only; enquiry RPCs open to anon; app RPCs signed-in only',
    not has_function_privilege('authenticated', 'public.runsheet_reminders_tick()', 'execute')
    and not has_function_privilege('anon', 'public.runsheet_reminder_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.enquiry_reply_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.runsheet_reminders_tick()', 'execute')
    and has_function_privilege('anon', 'public.public_enquiry_submit(text, jsonb)', 'execute')
    and has_function_privilege('anon', 'public.public_enquiry_info(text)', 'execute')
    and not has_function_privilege('anon', 'public.automation_settings_set(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.runsheet_reminder_targets(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.runsheet_reminder_targets(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r24_target(public.run_sheet_items, uuid)', 'execute'));
  perform pg_temp.res('05 trial retention (0184) classifies the new tables (purge with the event / lead, settings kept)',
    to_regprocedure('public._tr184_purge_tables()') is null
    or (public._tr184_purge_tables() @> array['runsheet_reminder_sends', 'lead_enquiries'] and 'automation_settings' = any(public._tr184_keep_tables())));
end $$;

-- ---- 2) the owner picker guard ----------------------------------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; e text; r public.run_sheet_items; begin
  perform pg_temp.login('r24_coord@a.test');
  insert into public.run_sheet_items(quote_id, start_time, title, owner_user_id, location)
    values (qa, pg_temp.get('t')::time, 'Cake cutting', pg_temp.get('crd')::uuid, 'Main hall') returning * into r;
  perform pg_temp.put('i_user', r.id::text);
  perform pg_temp.res('06 a picked team member: kind = user, the owner name is filled in', r.owner_kind = 'user' and r.owner = 'Ravi Coordinator', row_to_json(r)::text);
  insert into public.run_sheet_items(quote_id, start_time, title, owner_crew_id) values (qa, pg_temp.get('t')::time, 'Lights on', pg_temp.get('c1')::uuid) returning * into r;
  perform pg_temp.put('i_crew', r.id::text);
  perform pg_temp.res('07 a picked staff member: kind = staff', r.owner_kind = 'staff' and r.owner = 'Suresh Lights', row_to_json(r)::text);
  insert into public.run_sheet_items(quote_id, start_time, title, owner_vendor_id, remind_offsets)
    values (qa, pg_temp.get('t')::time, 'Chairs set', pg_temp.get('v1')::uuid, array[15]) returning * into r;
  perform pg_temp.put('i_vendor', r.id::text);
  perform pg_temp.res('08 a picked vendor: kind = vendor', r.owner_kind = 'vendor' and r.owner = 'Deccan Rentals', row_to_json(r)::text);
  insert into public.run_sheet_items(quote_id, start_time, title, owner, remind_group) values (qa, pg_temp.get('t')::time, 'Band arrives', 'Some Band', true) returning * into r;
  perform pg_temp.put('i_typed', r.id::text);
  insert into public.run_sheet_items(quote_id, start_time, title, owner_crew_id, remind) values (qa, pg_temp.get('t')::time, 'Quiet one', pg_temp.get('c1')::uuid, false) returning * into r;
  perform pg_temp.put('i_off', r.id::text);
  insert into public.run_sheet_items(quote_id, start_time, title, owner_crew_id) values (qa, pg_temp.get('t')::time, 'Login crew', pg_temp.get('c2')::uuid) returning * into r;
  perform pg_temp.put('i_crewlogin', r.id::text);
  e := pg_temp.err(format('insert into public.run_sheet_items(quote_id, title, owner_user_id) values (%L, %L, %L)', qa, 'x',
         pg_temp.get('bm')));
  perform pg_temp.res('09 another studio''s team member cannot be picked', e like '42501%', e);
  e := pg_temp.err(format('insert into public.run_sheet_items(quote_id, title, owner_user_id, owner_crew_id) values (%L, %L, %L, %L)', qa, 'x',
         pg_temp.get('crd'), pg_temp.get('c1')));
  perform pg_temp.res('10 only one owner per line', e like '22023%', e);
  e := pg_temp.err(format('insert into public.run_sheet_items(quote_id, title, remind_offsets) values (%L, %L, %L)', qa, 'x', '{5000}'));
  perform pg_temp.res('11 a reminder time beyond 24 hours is refused', e like '23514%', e);
end $$;

-- ---- 3) what the run-sheet shows (who gets each reminder) -------------------------------------------------------
do $$ declare r jsonb; it jsonb; e text; begin
  perform pg_temp.login('r24_coord@a.test');
  r := public.runsheet_reminder_targets('a0000000-0000-4000-8000-00000000da01');
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_user');
  perform pg_temp.res('12 team member line: on, default 15 / 0, bell + e-mail, no contact details returned',
    (it ->> 'on')::boolean and it -> 'offsets' = '[15, 0]'::jsonb and it -> 'ways' = '["bell", "email"]'::jsonb and it ->> 'name' = 'Ravi Coordinator'
    and position('@' in r::text) = 0, it::text);
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_crew');
  perform pg_temp.res('13 staff line: e-mail + WhatsApp', it -> 'ways' = '["email", "whatsapp"]'::jsonb, it::text);
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_vendor');
  perform pg_temp.res('14 vendor line: its own time (15) + e-mail + WhatsApp', it -> 'offsets' = '[15]'::jsonb and it -> 'ways' = '["email", "whatsapp"]'::jsonb and (it ->> 'custom')::boolean, it::text);
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_typed');
  perform pg_temp.res('15 typed name nobody matches: only the event group', it -> 'ways' = '["group"]'::jsonb and it ->> 'name' is null, it::text);
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_off');
  perform pg_temp.res('16 a line switched off is shown off', not (it ->> 'on')::boolean, it::text);
  select x into it from jsonb_array_elements(r -> 'items') x where x ->> 'id' = pg_temp.get('i_crewlogin');
  perform pg_temp.res('17 staff with a Helm login: bell + e-mail (their login) + WhatsApp', it -> 'ways' = '["bell", "email", "whatsapp"]'::jsonb, it::text);
  r := public.runsheet_team_options();
  perform pg_temp.res('18 team options: names + roles of the own studio only, no e-mails',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'name' = 'Ravi Coordinator') and not exists (select 1 from jsonb_array_elements(r) x where x ->> 'name' = 'Bina B')
    and position('@a.test' in r::text) = 0, r::text);
  perform pg_temp.login('r24_b@b.test');
  e := pg_temp.err($q$select public.runsheet_reminder_targets('a0000000-0000-4000-8000-00000000da01')$q$);
  perform pg_temp.res('19 another studio cannot read the targets', e like '42501%', e);
  perform pg_temp.login('r24_crew@a.test');
  e := pg_temp.err($q$select public.runsheet_team_options()$q$);
  perform pg_temp.res('20 team options need run-sheet edit', e like '42501%', e);
end $$;

-- ---- 4) the scheduler -------------------------------------------------------------------------------------------
-- r25 (0274): run-sheet reminders are OFF until a studio switches them on (Control Center -> Automations); both studios have
do $$ begin
  perform pg_temp.su();
  insert into public.automation_settings(org_id, runsheet_enabled)
    values ('a0000000-0000-4000-8000-000000000001', true), ('b0000000-0000-4000-8000-000000000001', true)
  on conflict (org_id) do update set runsheet_enabled = true;
end $$;
do $$ declare r jsonb; r2 jsonb; n integer; begin
  perform pg_temp.svc();
  r := public.runsheet_reminders_tick();
  r2 := public.runsheet_reminders_tick();
  perform pg_temp.su();
  perform pg_temp.res('21 tick queues the 15-minute reminders once (second run adds nothing)',
    (r ->> 'done')::int > 0 and (r2 ->> 'done')::int = 0 and (r2 ->> 'skipped')::int = 0, r::text || r2::text);
  perform pg_temp.res('22 team member: one bell row naming them + one e-mail pending',
    (select count(*) from public.notifications x where x.kind = 'event_reminder' and x.detail ->> 'source' = '0269'
       and x.detail ->> 'runsheet_item' = pg_temp.get('i_user') and x.detail -> 'notify' = jsonb_build_array(pg_temp.get('crd'))
       and x.detail ->> 'label' like 'In 15 min: Cake cutting at %(Main hall) - Wedding A - Ravi Coordinator') = 1
    and (select count(*) from public.runsheet_reminder_sends s where s.item_id = pg_temp.get('i_user')::uuid and s.channel = 'email'
           and s.status = 'pending' and s.recipient = 'r24_coord@a.test' and s.offset_min = 15) = 1,
    (select string_agg(x.detail ->> 'label', ' | ') from public.notifications x where x.detail ->> 'source' = '0269'));
  perform pg_temp.res('23 staff: WhatsApp handed to the 0132 queue (Indian number normalised) + e-mail pending',
    (select count(*) from public.assign_notify_outbox o where o.item_id = pg_temp.get('i_crew')::uuid and o.phone = '919876543210'
       and o.body like 'Hi Suresh Lights, reminder from Studio A: In 15 min: Lights on at %') = 1
    and (select count(*) from public.runsheet_reminder_sends s where s.item_id = pg_temp.get('i_crew')::uuid and s.channel = 'whatsapp' and s.status = 'queued') = 1
    and (select count(*) from public.runsheet_reminder_sends s where s.item_id = pg_temp.get('i_crew')::uuid and s.channel = 'email' and s.status = 'pending') = 1);
  perform pg_temp.res('24 vendor: WhatsApp + e-mail at its own time',
    (select count(*) from public.assign_notify_outbox o where o.item_id = pg_temp.get('i_vendor')::uuid and o.phone = '919988776655') = 1
    and (select count(*) from public.runsheet_reminder_sends s where s.item_id = pg_temp.get('i_vendor')::uuid and s.channel = 'email' and s.recipient = 'orders@deccan.test') = 1);
  perform pg_temp.res('25 "also post in the event group": one Helm message in the event chat',
    (select count(*) from public.chat_messages m where m.conversation_id = pg_temp.get('cv')::uuid and m.kind = 'system' and m.sender_id is null
       and m.body like '%In 15 min: Band arrives at %' and m.meta ->> 'runsheet_item' = pg_temp.get('i_typed')) = 1);
  perform pg_temp.res('26 a line with Remind off gets nothing',
    not exists (select 1 from public.runsheet_reminder_sends s where s.item_id = pg_temp.get('i_off')::uuid)
    and not exists (select 1 from public.assign_notify_outbox o where o.item_id = pg_temp.get('i_off')::uuid and o.body like '%reminder from%'));
  perform pg_temp.res('27 staff with a login: bell for that login',
    exists (select 1 from public.notifications x where x.detail ->> 'runsheet_item' = pg_temp.get('i_crewlogin') and x.detail -> 'notify' = jsonb_build_array(pg_temp.get('crw'))));
  -- the 0-minute reminder is not due yet (never early)
  perform pg_temp.res('28 nothing is sent early (the "at the start" reminder waits)',
    not exists (select 1 from public.runsheet_reminder_sends s where s.offset_min = 0));
end $$;

-- ---- 5) the dispatcher claim -------------------------------------------------------------------------------------
do $$ declare r jsonb; x jsonb; e text; begin
  perform pg_temp.svc();
  r := public.runsheet_reminder_claim(50);
  select y into x from jsonb_array_elements(r) y where y ->> 'to' = 'r24_coord@a.test';
  perform pg_temp.res('29 claim hands out the pending e-mails with plain text, studio, event, date (dd/mm/yyyy)',
    jsonb_array_length(r) = 4 and x ->> 'text' like 'In 15 min: Cake cutting at %' and x ->> 'studio' = 'Studio A' and x ->> 'event' = 'Wedding A'
    and x ->> 'event_date' ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$', r::text);
  perform public.runsheet_reminder_mark((x ->> 'id')::uuid, 'sent');
  r := public.runsheet_reminder_claim(50);
  perform pg_temp.res('30 a claimed e-mail is not handed out again within 10 minutes', jsonb_array_length(r) = 0, r::text);
  e := pg_temp.err($q$select public.runsheet_reminder_mark(gen_random_uuid(), 'bogus')$q$);
  perform pg_temp.res('31 mark refuses an unknown status', e like '22023%', e);
  perform pg_temp.su();
  perform pg_temp.res('32 marked sent', exists (select 1 from public.runsheet_reminder_sends s where s.id = (x ->> 'id')::uuid and s.status = 'sent'));
end $$;

-- ---- 6) settings ------------------------------------------------------------------------------------------------
do $$ declare r jsonb; e text; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; v uuid; begin
  perform pg_temp.login('r24_coord@a.test');
  r := public.automation_settings_get();
  perform pg_temp.res('33 a Control Center viewer reads the settings + the public link name', r ->> 'public_slug' = 'studio-a-r24' and not (r ->> 'can_manage')::boolean, r::text);
  e := pg_temp.err($q$select public.automation_settings_set('{"runsheet_enabled": false}'::jsonb)$q$);
  perform pg_temp.res('34 Control Center view-only cannot change them', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.err($q$select public.automation_settings_set('{"bogus": 1}'::jsonb)$q$);
  perform pg_temp.res('35 unknown setting refused', e like '22023%', e);
  e := pg_temp.err($q$select public.automation_settings_set('{"runsheet_offsets": [2000]}'::jsonb)$q$);
  perform pg_temp.res('36 reminder time over 1440 refused', e like '22023%', e);
  e := pg_temp.err($q$select public.automation_settings_set('{"enquiry_reply_text": "<script>"}'::jsonb)$q$);
  perform pg_temp.res('37 reply text with < > refused', e like '22023%', e);
  r := public.automation_settings_set('{"runsheet_offsets": [0, 30, 30]}'::jsonb);
  perform pg_temp.res('38 times saved distinct, longest first', r -> 'runsheet_offsets' = '[30, 0]'::jsonb, r::text);
  r := public.automation_settings_set('{"runsheet_enabled": false}'::jsonb);
  perform pg_temp.su();
  perform pg_temp.res('39 every change is in the audit log', exists (select 1 from public.audit_log l where l.action = 'automation_settings.set'));
  -- switched off: a new due line is not reminded
  perform pg_temp.login('r24_coord@a.test');
  insert into public.run_sheet_items(quote_id, start_time, title, owner_user_id) values (qa, pg_temp.get('t')::time, 'Late add', pg_temp.get('crd')::uuid) returning id into v;
  perform pg_temp.svc(); perform public.runsheet_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('40 studio switched off: nothing is queued', not exists (select 1 from public.runsheet_reminder_sends s where s.item_id = v));
  perform pg_temp.login('a_admin@a.test'); perform public.automation_settings_set('{"runsheet_enabled": true, "runsheet_offsets": [15, 0]}'::jsonb);
  -- a sample event never reminds
  perform pg_temp.su(); update public.quotes set is_demo = true where id = qa;
  perform pg_temp.svc(); perform public.runsheet_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('41 a sample event is never reminded', not exists (select 1 from public.runsheet_reminder_sends s where s.item_id = v));
  update public.quotes set is_demo = false where id = qa;
  -- a cancelled event: pending e-mails are skipped at claim time
  update public.quotes set status = 'cancelled' where id = qa;
  update public.runsheet_reminder_sends set claimed_at = null where status = 'pending';
  perform pg_temp.svc(); r := public.runsheet_reminder_claim(50); perform pg_temp.su();
  perform pg_temp.res('42 cancelled event: queued e-mails are skipped (recheck), nothing handed out',
    jsonb_array_length(r) = 0 and not exists (select 1 from public.runsheet_reminder_sends s where s.status = 'pending' and s.channel = 'email')
    and exists (select 1 from public.runsheet_reminder_sends s where s.reason = 'recheck'), r::text);
  update public.quotes set status = 'confirmed' where id = qa;
end $$;

-- ---- 7) the public enquiry form ---------------------------------------------------------------------------------
do $$ declare r jsonb; e text; n integer; p jsonb := '{"name": "Priya Sharma", "email": "Priya@Example.test", "phone": "98765 00000",
    "event_type": "Wedding", "guests": "300", "message": "Looking for decor", "consent": true}'::jsonb; begin
  perform pg_temp.anon();
  r := public.public_enquiry_info('studio-a-r24');
  perform pg_temp.res('43 form switched off: closed, nothing about the studio', r ->> 'ok' = 'false' and r ->> 'reason' = 'closed' and not (r ? 'studio'), r::text);
  r := public.public_enquiry_submit('studio-a-r24', p);
  perform pg_temp.res('44 switched off: an enquiry is refused', r ->> 'ok' = 'false' and r ->> 'reason' = 'closed', r::text);
  perform pg_temp.login('a_admin@a.test'); perform public.automation_settings_set('{"enquiry_enabled": true}'::jsonb);
  perform pg_temp.anon('203.0.113.7');
  r := public.public_enquiry_info('studio-a-r24');
  perform pg_temp.res('45 open form shows ONLY the studio name', r = '{"ok": true, "studio": "Studio A"}'::jsonb, r::text);
  r := public.public_enquiry_info('no-such-studio');
  perform pg_temp.res('46 unknown link name: closed', r ->> 'ok' = 'false', r::text);
  r := public.public_enquiry_submit('studio-a-r24', p || jsonb_build_object('event_date', to_char(current_date + 30, 'YYYY-MM-DD')));
  perform pg_temp.res('47 enquiry accepted, nothing read back but the studio name', r = '{"ok": true, "studio": "Studio A"}'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('48 a New lead with source enquiry_form, owner empty, details kept',
    (select count(*) from public.leads l where l.org_id = 'a0000000-0000-4000-8000-000000000001' and l.source = 'enquiry_form' and l.status = 'new'
       and l.name = 'Priya Sharma' and l.email = 'priya@example.test' and l.guest_count = 300 and l.event_type = 'Wedding'
       and l.event_date = current_date + 30 and l.owner is null and l.notes like '%Looking for decor%') = 1);
  perform pg_temp.res('49 consent + hashed network kept (never the address), instant reply queued',
    (select count(*) from public.lead_enquiries e where e.org_id = 'a0000000-0000-4000-8000-000000000001' and e.reply_status = 'pending'
       and e.reply_to = 'priya@example.test' and e.ip_hash ~ '^[0-9a-f]{64}$' and e.user_agent = 'TestUA/1') = 1
    and not exists (select 1 from public.lead_enquiries e where e.ip_hash like '%203.0.113.7%'));
  perform pg_temp.res('50 the bell says "New enquiry from Priya Sharma - Wedding" (no phone / e-mail)',
    exists (select 1 from public.notifications x where x.kind = 'lead_new' and x.detail ->> 'label' like 'New enquiry from Priya Sharma - Wedding, %'
              and position('example.test' in x.detail::text) = 0 and position('98765' in x.detail::text) = 0));
  perform pg_temp.anon('203.0.113.7');
  r := public.public_enquiry_submit('studio-a-r24', p || '{"website": "http://spam.test"}'::jsonb);
  perform pg_temp.su();
  perform pg_temp.res('51 honeypot filled: says ok, keeps nothing', r ->> 'ok' = 'true'
    and (select count(*) from public.leads l where l.source = 'enquiry_form') = 1, r::text);
  perform pg_temp.anon('203.0.113.8');
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "X Y", "consent": true}'::jsonb);
  perform pg_temp.res('52 no phone and no e-mail: refused in plain words', r ->> 'ok' = 'false' and r ->> 'field' = 'phone', r::text);
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "X Y", "email": "bad@", "consent": true}'::jsonb);
  perform pg_temp.res('53 bad e-mail refused', r ->> 'field' = 'email', r::text);
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "X Y", "phone": "9876500001"}'::jsonb);
  perform pg_temp.res('54 no consent: refused', r ->> 'field' = 'consent', r::text);
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "X Y", "phone": "9876500001", "consent": true, "event_date": "2020-01-01"}'::jsonb);
  perform pg_temp.res('55 a past date refused', r ->> 'field' = 'event_date', r::text);
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "X Y", "phone": "9876500001", "consent": true, "org_id": "x"}'::jsonb);
  perform pg_temp.res('56 unknown fields refused (no way to write other columns)', r ->> 'ok' = 'false' and r ->> 'reason' = 'invalid', r::text);
  -- the same phone: 3 a day
  perform pg_temp.anon('203.0.113.9'); r := public.public_enquiry_submit('studio-a-r24', '{"name": "Same Person", "phone": "9876511111", "consent": true}'::jsonb);
  perform pg_temp.anon('203.0.113.10'); r := public.public_enquiry_submit('studio-a-r24', '{"name": "Same Person", "phone": "9876511111", "consent": true}'::jsonb);
  perform pg_temp.anon('203.0.113.11'); r := public.public_enquiry_submit('studio-a-r24', '{"name": "Same Person", "phone": "9876511111", "consent": true}'::jsonb);
  perform pg_temp.anon('203.0.113.12'); r := public.public_enquiry_submit('studio-a-r24', '{"name": "Same Person", "phone": "9876511111", "consent": true}'::jsonb);
  perform pg_temp.res('57 the same phone / e-mail: max 3 a day', r ->> 'ok' = 'false' and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.su();
  perform pg_temp.res('58 phone-only enquiry: no reply e-mail (skipped no_email)',
    exists (select 1 from public.lead_enquiries e join public.leads l on l.id = e.lead_id where l.name = 'Same Person' and e.reply_status = 'skipped' and e.reply_reason = 'no_email'));
  -- one network: 5 an hour
  for n in 1..6 loop
    perform pg_temp.anon('198.51.100.5');
    r := public.public_enquiry_submit('studio-a-r24', jsonb_build_object('name', 'Net ' || n, 'phone', '98000000' || lpad(n::text, 2, '0'), 'consent', true));
  end loop;
  perform pg_temp.res('59 one network: max 5 an hour', r ->> 'ok' = 'false' and r ->> 'reason' = 'rate', r::text);
  perform pg_temp.anon();
  begin execute 'select count(*) from public.leads' into n; exception when others then n := 0; end;
  perform pg_temp.res('60 the signed-out caller cannot read leads / enquiries directly',
    n = 0 and pg_temp.err('select count(*) from public.lead_enquiries') like '42501%', n::text);
  perform pg_temp.su();
end $$;

do $$ declare r jsonb; x jsonb; begin
  perform pg_temp.login('a_admin@a.test'); perform public.automation_settings_set('{"enquiry_reply_text": "Namaste {name}, {studio} got your {event} enquiry."}'::jsonb);
  perform pg_temp.svc();
  r := public.enquiry_reply_claim(10);
  select y into x from jsonb_array_elements(r) y where y ->> 'to' = 'priya@example.test';
  perform pg_temp.res('61 the instant reply: the studio''s words with name / studio / event filled in',
    x ->> 'text' = 'Namaste Priya Sharma, Studio A got your Wedding enquiry.' and x ->> 'studio' = 'Studio A', r::text);
  perform public.enquiry_reply_mark((x ->> 'id')::uuid, 'sent');
  perform pg_temp.su();
  perform pg_temp.res('62 reply marked sent once', exists (select 1 from public.lead_enquiries e where e.id = (x ->> 'id')::uuid and e.reply_status = 'sent'));
end $$;

-- ---- 8) the other studio + leads from quotes ---------------------------------------------------------------------
do $$ declare r jsonb; e text; q uuid := gen_random_uuid(); begin
  perform pg_temp.anon('192.0.2.1');
  r := public.public_enquiry_submit('studio-a-r24', '{"name": "Tenant Check", "phone": "9876522222", "consent": true}'::jsonb);
  perform pg_temp.su();
  perform pg_temp.res('63 an enquiry only lands in the studio of that link',
    exists (select 1 from public.leads l where l.name = 'Tenant Check' and l.org_id = 'a0000000-0000-4000-8000-000000000001')
    and not exists (select 1 from public.leads l where l.name = 'Tenant Check' and l.org_id <> 'a0000000-0000-4000-8000-000000000001'));
  perform pg_temp.login('r24_b@b.test');
  perform pg_temp.res('64 another studio''s team never sees these leads',
    not exists (select 1 from public.leads l where l.name in ('Tenant Check', 'Priya Sharma')));
  -- a quote with a client creates its lead automatically (sync_quote_to_lead, unchanged)
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values (q, 'A-0269', 'Auto lead', 'quote', '{"name": "Kiran Rao", "email": "kiran@example.test"}'::jsonb, '{}'::jsonb, 1, 'none',
            'a0000000-0000-4000-8000-000000000001', now(), now());
  perform pg_temp.res('65 a new quote with a client becomes a lead automatically (source quote, linked)',
    exists (select 1 from public.leads l where l.quote_id = q and l.source = 'quote' and l.name = 'Kiran Rao'));
end $$;

-- ---- 9) free trial: bell + chat only ----------------------------------------------------------------------------
do $$ declare r jsonb; u uuid; t uuid; tq uuid := gen_random_uuid(); c uuid; i uuid; loc timestamp := (now() at time zone 'Asia/Kolkata') + interval '15 minutes'; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'r24_trial@t.test';
  if u is null then u := auth.seed_user('r24_trial@t.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at) values (u, 'r24_trial@t.test', 'Tara Trial', 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login('r24_trial@t.test');
  r := public.start_self_serve_trial('T r24', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); t := (r ->> 'org_id')::uuid;
  insert into public.automation_settings(org_id, runsheet_enabled) values (t, true) on conflict (org_id) do update set runsheet_enabled = true;   -- r25 (0274)
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, event_date, created_at, updated_at)
    values (tq, 'T-0269', 'Trial event', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'none', t, loc::date, now(), now());
  insert into public.crew_members(id, name, phone, email, org_id) values (gen_random_uuid(), 'Trial Crew', '9822222222', 'tc@crew.test', t) returning id into c;
  insert into public.run_sheet_items(quote_id, org_id, start_time, title, owner_crew_id) values (tq, t, loc::time, 'Trial line', c) returning id into i;
  perform pg_temp.svc(); perform public.runsheet_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('66 free trial: no e-mail / WhatsApp is queued (kept as skipped free_trial)',
    (select count(*) from public.runsheet_reminder_sends s where s.item_id = i and s.status = 'skipped' and s.reason = 'free_trial') = 2
    and not exists (select 1 from public.assign_notify_outbox o where o.item_id = i and o.body like '%reminder from%'), (select string_agg(channel || ':' || status || ':' || coalesce(reason, ''), ',') from public.runsheet_reminder_sends s where s.item_id = i));
end $$;

select name, result from _dr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R24-AUTOMATION-0269: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R24-AUTOMATION-0269: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _dr;
rollback;
