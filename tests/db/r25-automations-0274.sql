-- r25-automations-0274.sql -- 0274: every automation that sends something is OFF until the studio admin switches it on in
-- Control Center -> Automations. Proves (applied twice first = re-run safe): OFF defaults for a studio that never saved
-- anything (every reader + column default), the daily digest off, the 0265 / 0266 _r23_cfg clash fixed (crew + inbox keys),
-- the ledger gates (event reminders, run-sheet, overdue bell, vendor reminders - a hand-sent vendor request still passes),
-- the 0132 "assigned" WhatsApp wrapper, automation_overview / automation_switch (rights, read-only studio, audit, studio
-- isolation, WhatsApp number needed), the once-only data step (stored ON -> OFF with a backup row; a re-run never undoes
-- an admin's later choice) and the queued rows of automations that are off marked skipped (hand-sent ones untouched).
-- Rolled back. Local disposable PG only. Nothing is ever sent.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ar(name text, result text); grant all on _ar to anon, authenticated, service_role;
create temp table _ak(k text primary key, v text); grant all on _ak to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su();
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, false);
  perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ar values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.err(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ak values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ak where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.def(p_tab text, p_col text) returns text language sql as $$
  select column_default from information_schema.columns where table_schema = 'public' and table_name = p_tab and column_name = p_col $$;

-- ---- the migration, twice (safe to re-run) -----------------------------------------------------------------------
\ir ../../supabase/migrations/0274_automations_optin.sql
\ir ../../supabase/migrations/0274_automations_optin.sql

-- ---- setup: Studio A / B have never saved any automation setting; a viewer without Control Center edit --------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; u uuid; begin
  perform pg_temp.su();
  delete from public.comms_settings where org_id in (a, b);              -- throwaway test database: start from "never saved"
  delete from public.client_view_settings where org_id in (a, b);
  delete from public.payment_schedule_settings where org_id in (a, b);
  delete from public.automation_settings where org_id in (a, b);
  delete from public.inbox_settings where org_id in (a, b);
  delete from public.inbox_person_prefs where org_id in (a, b);
  delete from public.delivery_settings where org_id in (a, b);
  delete from public.app_config where org_id in (a, b) and key in ('quote_validity', 'crew');
  select id into u from auth.users where email = 'a_view274@a.test'; if u is null then u := auth.seed_user('a_view274@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_view274@a.test', 'Vee Viewer', 'designer', a, false, now()) on conflict (id) do update set role = 'designer', org_id = a;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('designer', 'controls', true, false, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  -- a confirmed event 3 days away (inside the 7-day event-reminder window)
  update public.quotes set status = 'confirmed', event_date = current_date + 3, deleted_at = null, lifecycle_stage = null
   where id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.event_reminders where quote_id = 'a0000000-0000-4000-8000-00000000da01';
end $$;

-- ---- 1) schema, defaults, the clash fix --------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; k text; v_bad text := ''; c jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('01 backup table: RLS on, no anon / signed-in privilege, the once-only marker row',
    (select relrowsecurity from pg_class where oid = 'public.automation_optin_backup_0274'::regclass)
    and not has_table_privilege('authenticated', 'public.automation_optin_backup_0274', 'select')
    and not has_table_privilege('anon', 'public.automation_optin_backup_0274', 'select')
    and (select count(*) from public.automation_optin_backup_0274 where studio_id is null and setting = 'data_step_done') = 1);
  perform pg_temp.res('02 column defaults: every sending switch starts OFF, the digest default is "No e-mails"',
    pg_temp.def('comms_settings', 'pay_enabled') = 'false' and pg_temp.def('comms_settings', 'low_stock_enabled') = 'false'
    and pg_temp.def('comms_settings', 'fu_enabled') = 'false' and pg_temp.def('client_view_settings', 'followup_enabled') = 'false'
    and pg_temp.def('payment_schedule_settings', 'overdue_bell') = 'false' and pg_temp.def('automation_settings', 'runsheet_enabled') = 'false'
    and pg_temp.def('automation_settings', 'event_reminders_enabled') = 'false' and pg_temp.def('automation_settings', 'vendor_reminders_enabled') = 'false'
    and pg_temp.def('automation_settings', 'assign_whatsapp_enabled') = 'false' and pg_temp.def('inbox_settings', 'email_enabled') = 'false'
    and pg_temp.def('inbox_settings', 'digest_default') like '''off''%' and pg_temp.def('delivery_settings', 'enabled') = 'false');
  foreach k in array array['pay_reminders', 'client_followups', 'quote_expiry_client', 'enquiry', 'viewed_alert', 'quote_expiry_team',
      'overdue_bell', 'low_stock', 'event_reminders', 'inbox_email', 'wa_forward', 'vendor_reminders', 'delivery', 'runsheet',
      'assign_whatsapp', 'crew_shifts'] loop
    if public._auto274_on(a, k) then v_bad := v_bad || k || ' '; end if;
  end loop;
  perform pg_temp.res('03 a studio that never saved anything: every sending automation is OFF (the schedule-on-approval, which sends nothing, stays on)',
    v_bad = '' and public._auto274_on(a, 'auto_schedule') and not public._auto274_on(a, 'bogus') and not public._auto274_on(null, 'runsheet'), v_bad);
  perform pg_temp.res('04 the settings readers say OFF: payment reminders, low stock, viewed alert, quote-expiry (client + team), run-sheet',
    not (public._comms_cfg(a) ->> 'pay_enabled')::boolean and not (public._comms_cfg(a) ->> 'low_stock_enabled')::boolean
    and (public._comms_cfg(a) ->> 'pay_before_days')::int = 3 and (public._comms_cfg(a) ->> 'pay_max_overdue')::int = 1
    and not (public._lv261_cfg(a) ->> 'followup_enabled')::boolean and (public._lv261_cfg(a) ->> 'track_enabled')::boolean
    and not (public._qv262_cfg(a) ->> 'client_reminders')::boolean and not (public._qv262_cfg(a) ->> 'studio_reminders')::boolean
    and (public._qv262_cfg(a) ->> 'enabled')::boolean
    and not (public._r24_cfg(a) ->> 'runsheet_enabled')::boolean and not (public._r24_cfg(a) ->> 'event_reminders_enabled')::boolean);
  c := public._r23_cfg(a);
  perform pg_temp.res('05 the daily digest is off: inbox e-mails off, studio default "No e-mails", a person with no choice gets none',
    not (c ->> 'email_enabled')::boolean and c ->> 'digest_default' = 'off' and public._r23_mode(a, (select id from public.profiles where email = 'a_staff@a.test')) = 'off', c::text);
  perform pg_temp.res('06 0265 / 0266 clash fixed: one _r23_cfg answers the inbox AND the crew settings (open-shift WhatsApp OFF)',
    c ? 'digest_hour' and c ? 'bell_open_marks_read' and (c ->> 'availability')::boolean and (c ->> 'openShifts')::boolean
    and not (c ->> 'notifyShifts')::boolean and (c ->> 'selfCheckin')::boolean and c ->> 'claimMode' = 'first_come'
    and (c ->> 'lateGraceMin')::int = 15, c::text);
  perform pg_temp.res('07 internal helpers are not callable by the app; overview / switch are (signed in only)',
    not has_function_privilege('authenticated', 'public._auto274_on(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public._r23_cfg(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._assign132_enqueue__pre0274(uuid, uuid, text, uuid, text, text, text, text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.automation_overview()', 'execute')
    and has_function_privilege('authenticated', 'public.automation_switch(text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.automation_switch(text, boolean)', 'execute'));
  perform pg_temp.res('08 four ledger gates + the assigned-WhatsApp wrapper are installed',
    (select count(*) from pg_trigger where tgname = 'a274_gate' and tgrelid in ('public.event_reminders'::regclass,
       'public.runsheet_reminder_sends'::regclass, 'public.payment_overdue_alerts'::regclass, 'public.vendor_request_sends'::regclass)) = 4
    and position('r25-automations-0274' in (select prosrc from pg_proc where oid = 'public._assign132_enqueue(uuid,uuid,text,uuid,text,text,text,text,text)'::regprocedure)) > 0);
end $$;

-- ---- 2) the gates: nothing is written while off ---------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; n int; v uuid; it uuid; begin
  perform pg_temp.svc();
  r := public.event_reminders_tick();
  perform pg_temp.su();
  perform pg_temp.res('09 event reminders OFF: the hourly job writes no reminder and rings no bell',
    not exists (select 1 from public.event_reminders where quote_id = q)
    and not exists (select 1 from public.notifications where quote_id = q and kind = 'event_reminder'), r::text);
  insert into public.payment_overdue_alerts(milestone_id, org_id, quote_id, due_date) values (gen_random_uuid(), a, q, current_date - 2);
  insert into public.run_sheet_items(quote_id, org_id, start_time, title) values (q, a, '18:00', 'Gate test') returning id into it;
  insert into public.runsheet_reminder_sends(org_id, quote_id, item_id, offset_min, channel, dedupe_key) values (a, q, it, 15, 'bell', 'rs274:gate');
  perform pg_temp.res('10 overdue bell / run-sheet ledgers OFF: no row is written',
    not exists (select 1 from public.payment_overdue_alerts where quote_id = q)
    and not exists (select 1 from public.runsheet_reminder_sends where dedupe_key = 'rs274:gate'));
  insert into public.vendor_requests(org_id, quote_id, vendor_name, what, when_at, agreed_amount, respond_by, contact_email)
    values (a, q, 'Deccan Rentals', 'Chairs', now() + interval '3 days', 5000, now() + interval '1 day', 'orders@deccan.test') returning id into v;
  insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key) values
    (a, v, 'request', 'email', 'orders@deccan.test', 'vr274:req'), (a, v, 'reminder', 'email', 'orders@deccan.test', 'vr274:rem');
  perform pg_temp.res('11 vendor reminders OFF: the reminder is not queued, the request sent by hand still is',
    exists (select 1 from public.vendor_request_sends where dedupe_key = 'vr274:req')
    and not exists (select 1 from public.vendor_request_sends where dedupe_key = 'vr274:rem'));
  perform pg_temp.res('12 "you have been assigned" WhatsApp OFF: nothing queued',
    not public._assign132_enqueue(a, q, 'task', gen_random_uuid(), '9876543210', 'Suresh', 'Lights', '18:00', 'Hall')
    and not exists (select 1 from public.assign_notify_outbox where org_id = a and name = 'Suresh'));
  perform pg_temp.put('it', it::text); perform pg_temp.put('v', v::text);
end $$;

-- ---- 3) Control Center -> Automations --------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('a_view274@a.test');
  r := public.automation_overview();
  perform pg_temp.res('13 overview: a Control Center viewer reads every automation OFF, cannot edit',
    r -> 'on' ->> 'pay_reminders' = 'false' and r -> 'on' ->> 'inbox_email' = 'false' and r -> 'on' ->> 'event_reminders' = 'false'
    and r -> 'on' ->> 'auto_schedule' = 'true' and jsonb_typeof(r -> 'on') = 'object'
    and (select count(*) from jsonb_object_keys(r -> 'on')) = 17 and not (r ->> 'can_edit')::boolean
    and (r -> 'details' -> 'pay' ->> 'before_days')::int = 3 and (r -> 'details' ->> 'event_days')::int = 7, r::text);
  e := pg_temp.err($q$select public.automation_switch('event_reminders', true)$q$);
  perform pg_temp.res('14 switch: refused without Control Center edit', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.err($q$select public.automation_switch('bogus', true)$q$);
  perform pg_temp.res('15 switch: unknown automation / no value refused', e like '22023%'
    and pg_temp.err($q$select public.automation_switch('runsheet', null)$q$) like '22023%', e);
  e := pg_temp.err($q$select public.automation_switch('wa_forward', true)$q$);
  perform pg_temp.res('16 WhatsApp copies need the studio WhatsApp number first', e like '22023%WhatsApp number%', e);
  r := public.automation_switch('event_reminders', true);
  r := public.automation_switch('pay_reminders', true);
  r := public.automation_switch('quote_expiry_client', true);
  r := public.automation_switch('crew_shifts', true);
  r := public.automation_switch('inbox_email', true);
  r := public.automation_switch('overdue_bell', true);
  perform pg_temp.res('17 switch on: written where each setting lives, the overview says ON',
    r -> 'on' ->> 'event_reminders' = 'true' and r -> 'on' ->> 'pay_reminders' = 'true' and r -> 'on' ->> 'quote_expiry_client' = 'true'
    and r -> 'on' ->> 'crew_shifts' = 'true' and r -> 'on' ->> 'inbox_email' = 'true' and r -> 'on' ->> 'overdue_bell' = 'true'
    and r -> 'on' ->> 'runsheet' = 'false' and (r ->> 'can_edit')::boolean, r::text);
end $$;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; r jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('18 the switches land in the feature settings (payment channel e-mail, quote validity merge, crew merge, digest daily)',
    (select pay_enabled and pay_channels = array['email'] from public.comms_settings where org_id = a)
    and (public._qv262_cfg(a) ->> 'client_reminders')::boolean and not (public._qv262_cfg(a) ->> 'studio_reminders')::boolean
    and (public._r23_cfg(a) ->> 'notifyShifts')::boolean and (public._r23_cfg(a) ->> 'availability')::boolean
    and (public._r23_cfg(a) ->> 'email_enabled')::boolean and public._r23_cfg(a) ->> 'digest_default' = 'daily'
    and public._r23_mode(a, (select id from public.profiles where email = 'a_staff@a.test')) = 'daily');
  perform pg_temp.res('19 every switch is in the audit log (from -> to)',
    (select count(*) from public.audit_log l where l.action = 'automation.switch' and l.org_id = a) = 6
    and exists (select 1 from public.audit_log l where l.action = 'automation.switch' and l.org_id = a and l.entity_id = 'event_reminders'
                  and l.changed = '{"key": "event_reminders", "from": false, "to": true}'::jsonb));
  perform pg_temp.res('20 the other studio is untouched (still all off)',
    not public._auto274_on(b, 'event_reminders') and not public._auto274_on(b, 'pay_reminders') and not public._auto274_on(b, 'inbox_email'));
  perform pg_temp.svc();
  r := public.event_reminders_tick();
  perform pg_temp.su();
  perform pg_temp.res('21 event reminders ON: the next run reminds the team once (ledger + bell)',
    (select count(*) from public.event_reminders where quote_id = q) = 1
    and (select count(*) from public.notifications where quote_id = q and kind = 'event_reminder') = 1, r::text);
  insert into public.payment_overdue_alerts(milestone_id, org_id, quote_id, due_date) values (gen_random_uuid(), a, q, current_date - 2);
  perform pg_temp.res('22 overdue bell ON: its ledger row is written', (select count(*) from public.payment_overdue_alerts where quote_id = q) = 1);
end $$;
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.automation_switch('event_reminders', false);
  r := public.automation_switch('inbox_email', false);
  perform pg_temp.su();
  perform pg_temp.res('23 switch off again: OFF in the overview, inbox e-mails off (the person''s mode is off)',
    r -> 'on' ->> 'event_reminders' = 'false' and r -> 'on' ->> 'inbox_email' = 'false'
    and public._r23_mode('a0000000-0000-4000-8000-000000000001', (select id from public.profiles where email = 'a_staff@a.test')) = 'off', r::text);
  -- a fresh studio whose free trial ended yesterday (no payment ever) = read-only
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, trial_ends_at)
    values ('c0000000-0274-4000-8000-000000000001', 'Trial T274', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'trial', now() - interval '20 days', now() - interval '1 day')
    on conflict (id) do update set trial_ends_at = excluded.trial_ends_at;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values ('c0000000-0274-4000-8000-000000000001', 'trial', now() - interval '1 day');
  perform pg_temp.put('tu', (select coalesce((select id from auth.users where email = 't_admin274@t.test'), auth.seed_user('t_admin274@t.test')))::text);
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (pg_temp.get('tu')::uuid, 't_admin274@t.test', 'admin', 'c0000000-0274-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = 'admin', org_id = excluded.org_id;
  perform pg_temp.login('t_admin274@t.test');
  e := pg_temp.err($q$select public.automation_switch('pay_reminders', true)$q$);
  perform pg_temp.su();
  perform pg_temp.res('24 a read-only (ended trial) studio cannot switch anything on',
    (e like '25006%' or e like '42501%') and not public._auto274_on('c0000000-0274-4000-8000-000000000001', 'pay_reminders'), e);
end $$;

-- ---- 4) the once-only data step + queued rows ---------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.su();
  -- Studio B as it was before 0274: rows saved with the old ON defaults, a studio that chose follow-ups (default was off)
  insert into public.comms_settings(org_id, pay_enabled, low_stock_enabled, fu_enabled) values (b, true, true, true)
    on conflict (org_id) do update set pay_enabled = true, low_stock_enabled = true, fu_enabled = true;
  insert into public.automation_settings(org_id, runsheet_enabled) values (b, true) on conflict (org_id) do update set runsheet_enabled = true;
  insert into public.inbox_settings(org_id, email_enabled, digest_default) values (b, true, 'daily')
    on conflict (org_id) do update set email_enabled = true, digest_default = 'daily';
  insert into public.app_config(org_id, key, value, updated_at) values (b, 'quote_validity', '{"client_reminders": true, "default_days": 21}', now())
    on conflict (org_id, key) do update set value = excluded.value;
  -- queued rows: an automatic payment reminder + a "Send reminder now" (A switched payment reminders ON above, B is off)
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key) values
    (b, 'b0000000-0000-4000-8000-00000000da01', 'pay_reminder', 'email', 'bob@example.test', '{"manual": false}', 'pay:274:auto:b'),
    (b, 'b0000000-0000-4000-8000-00000000da01', 'pay_reminder', 'email', 'bob@example.test', '{"manual": true}', 'pay:274:now:b'),
    (b, 'b0000000-0000-4000-8000-00000000da01', 'follow_up', 'email', 'bob@example.test', '{"r23": "nudge"}', 'fu:274:nudge:b'),
    (a, q, 'pay_reminder', 'email', 'alice@example.test', '{"manual": false}', 'pay:274:auto:a');
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key) values
    ('inbox_digest', b, gen_random_uuid(), '{}', 'inbox_digest:274:b');
  -- 1st: the marker is there -> a re-run never switches anything back off
  perform pg_temp.put('backups', (select count(*)::text from public.automation_optin_backup_0274));
end $$;
\ir ../../supabase/migrations/0274_automations_optin.sql
do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('25 re-run with the marker: stored choices stay as they are (nothing new backed up)',
    (select pay_enabled and low_stock_enabled from public.comms_settings where org_id = b)
    and (select runsheet_enabled from public.automation_settings where org_id = b)
    and (select count(*)::text from public.automation_optin_backup_0274) = pg_temp.get('backups'));
  perform pg_temp.res('26 queued rows of automations that are OFF are skipped; hand-sent and switched-on ones are not',
    (select status from public.comms_outbox where dedupe_key = 'pay:274:auto:b') = 'pending'   -- B still had pay reminders ON
    and (select status from public.comms_outbox where dedupe_key = 'pay:274:now:b') = 'pending'
    and (select status from public.comms_outbox where dedupe_key = 'fu:274:nudge:b') = 'pending'
    and (select status from public.comms_outbox where dedupe_key = 'pay:274:auto:a') = 'pending'   -- A switched them ON
    and (select status from public.helm_notice_outbox where dedupe_key = 'inbox_digest:274:b') = 'pending');   -- B had inbox e-mails ON
  -- simulate the first run on this database state (test only: the marker is renamed inside this rolled-back transaction)
  update public.automation_optin_backup_0274 set setting = 'data_step_done_test' where studio_id is null and setting = 'data_step_done';
end $$;
\ir ../../supabase/migrations/0274_automations_optin.sql
do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.res('27 first run: ON-by-default values switched OFF; follow-ups (a real choice) kept ON',
    (select not pay_enabled and not low_stock_enabled and fu_enabled from public.comms_settings where org_id = b)
    and not (select runsheet_enabled from public.automation_settings where org_id = b)
    and (select not email_enabled and digest_default = 'off' from public.inbox_settings where org_id = b)
    and (select value from public.app_config where org_id = b and key = 'quote_validity') = '{"client_reminders": false, "default_days": 21}'::jsonb);
  perform pg_temp.res('28 every change is backed up with its value before (stored + what it did)',
    exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = b and x.setting = 'pay_enabled'
              and x.old_value = '{"stored": true, "effective": true}'::jsonb and x.new_value ->> 'stored' = 'false')
    and exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = b and x.setting = 'digest_default'
              and x.old_value = '{"stored": "daily", "effective": "daily"}'::jsonb)
    and exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = b and x.store = 'app_config:quote_validity'
              and x.setting = 'client_reminders' and x.old_value ->> 'stored' = 'true')
    and not exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = b and x.setting = 'fu_enabled')
    and (select count(*) from public.automation_optin_backup_0274 where studio_id is null and setting = 'data_step_done') = 1);
  perform pg_temp.res('29 queued rows now skipped (status only): automatic pay reminders + the digest; hand-sent ones still waiting, none deleted',
    (select status from public.comms_outbox where dedupe_key = 'pay:274:auto:b') = 'skipped'
    and (select status from public.comms_outbox where dedupe_key = 'pay:274:auto:a') = 'skipped'
    and (select status from public.helm_notice_outbox where dedupe_key = 'inbox_digest:274:b') = 'skipped'
    and (select status from public.comms_outbox where dedupe_key = 'pay:274:now:b') = 'pending'
    and (select status from public.comms_outbox where dedupe_key = 'fu:274:nudge:b') = 'pending'
    and (select count(*) from public.comms_outbox where dedupe_key like 'pay:274:%' or dedupe_key like 'fu:274:%') = 4);
  -- (in real life the first run comes before anyone can use the new switches; here A's switches from section 3 look like old
  -- defaults, so the first run turns them off too - and keeps their values so they can be put back)
  perform pg_temp.res('30 the first run is reversible for every studio: A''s values before are in the backup',
    not public._auto274_on(a, 'pay_reminders') and not public._auto274_on(a, 'crew_shifts')
    and exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = a and x.setting = 'pay_enabled' and x.old_value ->> 'stored' = 'true')
    and exists (select 1 from public.automation_optin_backup_0274 x where x.studio_id = a and x.setting = 'notifyShifts' and x.old_value ->> 'stored' = 'true'));
end $$;

select name, result from _ar order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R25-AUTOMATIONS-0274: ALL PASS (' || count(*) || '/30)'
            else 'R25-AUTOMATIONS-0274: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end
  from _ar;
rollback;
