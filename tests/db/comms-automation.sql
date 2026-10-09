-- comms-automation.sql -- 0078: payment reminders, client follow-ups, low-stock bell,
-- WhatsApp forwarding. Gates, tenant scope, idempotency (unique dedupe), stop rules,
-- dormant defaults. Fixture: a_admin/a_staff studio A, b_admin studio B. Rolled back.
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
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.ob(p_purpose text) returns integer language sql as $$
  select count(*)::int from public.comms_outbox where purpose = p_purpose $$;

-- fixture
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  u uuid; st uuid;
begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'cm_crew@a.test'), auth.seed_user('cm_crew@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'cm_crew@a.test', 'Crew Member', 'crew', a, false, now()) on conflict (id) do update set role = 'crew', org_id = a;
  delete from public.role_access where org_id = a and role = 'crew';
  select id into st from auth.users where email = 'a_staff@a.test';
  insert into public.member_profiles(user_id, phone, whatsapp, whatsapp_same) values (st, '+919876543210', null, true)
    on conflict (user_id) do update set phone = excluded.phone, whatsapp_same = true;
  insert into public.quotes(id, code, title, status, client, pricing, org_id, event_date, approval_status) values
    ('a0000000-0000-4000-8000-0000000078e1', 'CM-1', 'Comms One', 'confirmed', '{"name":"Riya","email":"riya@example.test","phone":"9811112222"}',
     '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', a, current_date + 10, 'approved'),
    ('a0000000-0000-4000-8000-0000000078e2', 'CM-2', 'Comms Two', 'quote', '{"name":"Kabir","email":"kabir@example.test"}',
     '{"subtotal":50000,"discount":0,"gstPct":0,"total":50000}', a, current_date + 10, 'sent');
  update public.quotes set approval_token = 'a0000000-0000-4000-8000-0000000078aa' where id = 'a0000000-0000-4000-8000-0000000078e2';
  insert into public.quotes(id, code, title, status, client, pricing, org_id, event_date) values
    ('b0000000-0000-4000-8000-0000000078e1', 'CMB-1', 'B Comms', 'confirmed', '{"name":"Zed","email":"zed@example.test"}',
     '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}', b, current_date + 10);
  insert into public.payment_milestones(id, quote_id, label, due_date, amount, status, org_id) values
    ('a0000000-0000-4000-8000-0000000078a1', 'a0000000-0000-4000-8000-0000000078e1', 'Advance', current_date + 2, 30000, 'due', a),
    ('a0000000-0000-4000-8000-0000000078a2', 'a0000000-0000-4000-8000-0000000078e1', 'Second', current_date - 7, 40000, 'due', a),
    ('a0000000-0000-4000-8000-0000000078a3', 'a0000000-0000-4000-8000-0000000078e1', 'Paid one', current_date - 1, 30000, 'waived', a),
    ('b0000000-0000-4000-8000-0000000078a1', 'b0000000-0000-4000-8000-0000000078e1', 'B adv', current_date + 1, 500, 'due', b);
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- grants / shape
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 tables have RLS on', (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.comms_settings'::regclass, 'public.comms_outbox'::regclass, 'public.client_link_opens'::regclass,
                    'public.member_wa_optin'::regclass, 'public.inv_shortage_alerts'::regclass)));
  perform pg_temp.res('02 anon/authenticated cannot read or write the outbox',
    not has_table_privilege('anon', 'public.comms_outbox', 'select') and not has_table_privilege('authenticated', 'public.comms_outbox', 'select')
    and not has_table_privilege('authenticated', 'public.comms_outbox', 'insert') and not has_table_privilege('authenticated', 'public.comms_settings', 'update'));
  perform pg_temp.res('03 claim/mark/tick service-role only',
    has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.comms_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_mark(uuid, text)', 'execute'));
  perform pg_temp.res('04 link-open is the only anon entry point',
    has_function_privilege('anon', 'public.public_link_opened(text, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.comms_settings_get()', 'execute')
    and not has_function_privilege('anon', 'public.payment_reminder_send_now(uuid)', 'execute'));
  perform pg_temp.res('05 all new functions security definer + empty search_path',
    (select bool_and(p.prosecdef = (p.proname not in ('_comms_render', '_comms_money', '_comms_client_to', '_comms_channels',
        '_comms_default_pay_template', '_comms_default_fu_template', 'notification_catalog', 'notification_type_of'))
        and 'search_path=""' = any(p.proconfig))
       from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like '%comms%' or p.proname in
        ('payment_reminder_send_now', 'my_wa_forward_get', 'my_wa_forward_set', 'public_link_opened', 'notify_default'))));
  perform pg_temp.res('06 catalog has the two new types', public.notification_type_of('inventory_low_stock') = 'inventory_low_stock'
    and public.notification_type_of('client_follow_up', 'email') = 'client_follow_up'
    and public.notification_type_of('task_due') = 'task_due'
    and (select count(*) from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' in ('inventory_low_stock', 'client_follow_up')) = 2);
exception when others then perform pg_temp.su(); insert into _uf values ('0x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- dormant by default + settings gate
do $$ declare r jsonb; e text; begin
  perform pg_temp.su();
  r := public.comms_tick();
  perform pg_temp.res('07 nothing queued while switched off (default)', pg_temp.ob('pay_reminder') = 0 and pg_temp.ob('follow_up') = 0, r::text);
  perform pg_temp.login('cm_crew@a.test');
  e := pg_temp.try('select public.comms_settings_get()');
  perform pg_temp.res('08 crew (no controls) cannot read settings', e like '42501%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"pay_enabled":true}'')');
  perform pg_temp.res('09 crew cannot change settings', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.comms_settings_get();
  perform pg_temp.res('10 admin reads defaults (off, email, 3/3/3)', (r ->> 'pay_enabled')::boolean = false and r -> 'pay_channels' = '["email"]'
    and (r ->> 'pay_before_days')::int = 3 and jsonb_array_length(r -> 'roles') >= 5
    and exists (select 1 from jsonb_array_elements(r -> 'types') t where t ->> 'type' = 'admin_message')
    and not exists (select 1 from jsonb_array_elements(r -> 'types') t where t ->> 'type' = 'otp'), r::text);
  e := pg_temp.try('select public.comms_settings_set(''{"bogus":1}'')');
  perform pg_temp.res('11 unknown key refused', e like '22023%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"pay_channels":["sms"]}'')');
  perform pg_temp.res('12 unknown channel refused', e like '22023%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"wa_forward_roles":{"sales":["otp"]}}'')');
  perform pg_temp.res('13 OTP can never be forwarded', e like '22023%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"wa_forward_roles":{"hacker":["task_due"]}}'')');
  perform pg_temp.res('14 unknown role refused', e like '22023%', e);
  e := pg_temp.try('select public.comms_settings_set(''{"pay_template":"<script>x</script>"}'')');
  perform pg_temp.res('15 markup in template refused', e <> '', e);
  r := public.comms_settings_set('{"pay_enabled":true,"pay_channels":["email","whatsapp"],"pay_every_days":3,"pay_max_overdue":3}');
  perform pg_temp.res('16 admin saves settings', (r ->> 'pay_enabled')::boolean and (select count(*) from public.audit_log where action = 'comms_settings.set') >= 1, r::text);
  perform pg_temp.login('b_admin@b.test');
  r := public.comms_settings_get();
  perform pg_temp.res('17 studio B still sees its own (off) settings', (r ->> 'pay_enabled')::boolean = false, r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('1x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- payment reminders
do $$ declare r jsonb; e text; v_id uuid; begin
  perform pg_temp.su();
  r := public.comms_tick();
  perform pg_temp.res('18 pre-due + overdue queued by e-mail only (no studio WhatsApp yet)',
    (select count(*) from public.comms_outbox where purpose = 'pay_reminder' and channel = 'email') = 2
    and (select count(*) from public.comms_outbox where channel = 'whatsapp') = 0
    and exists (select 1 from public.comms_outbox where dedupe_key = 'pay:a0000000-0000-4000-8000-0000000078a1:pre:email')
    and exists (select 1 from public.comms_outbox where dedupe_key = 'pay:a0000000-0000-4000-8000-0000000078a2:od2:email'), r::text);
  perform pg_temp.res('19 settled milestone + other studio never queued',
    not exists (select 1 from public.comms_outbox where milestone_id in ('a0000000-0000-4000-8000-0000000078a3', 'b0000000-0000-4000-8000-0000000078a1')));
  perform pg_temp.res('20 template rendered', (select payload ->> 'text' from public.comms_outbox where dedupe_key like 'pay:a0000000-0000-4000-8000-0000000078a1:pre:email')
    like 'Hi Riya, a gentle reminder from Studio A: the payment "Advance" of Rs. 30,000 for Comms One is due in _ day%(due __ ___ 20__). Thank you!', (select payload ->> 'text' from public.comms_outbox where dedupe_key like 'pay:a0000000-0000-4000-8000-0000000078a1:pre:email'));
  r := public.comms_tick();
  perform pg_temp.res('21 second tick is a no-op (unique dedupe)', pg_temp.ob('pay_reminder') = 2, r::text);
  update public.comms_settings set studio_whatsapp = '919000000001' where org_id = 'a0000000-0000-4000-8000-000000000001';
  r := public.comms_tick();
  perform pg_temp.res('22 WhatsApp joins once the studio number is saved',
    (select count(*) from public.comms_outbox where purpose = 'pay_reminder' and channel = 'whatsapp' and recipient = '919811112222') = 2, r::text);
  -- paid after queueing -> skipped at claim
  update public.payment_milestones set status = 'waived' where id = 'a0000000-0000-4000-8000-0000000078a2';
  set local role service_role;
  r := public.comms_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('23 claim skips the now-settled milestone, hands out the rest',
    jsonb_array_length(r) = 2 and not exists (select 1 from public.comms_outbox where milestone_id = 'a0000000-0000-4000-8000-0000000078a2' and status <> 'skipped'), r::text);
  perform pg_temp.res('24 claim payload has no internal ids beyond the row id', not (r -> 0 ? 'org_id') and (r -> 0 ? 'to'));
  v_id := (r -> 0 ->> 'id')::uuid;
  set local role service_role;
  perform public.comms_outbox_mark(v_id, 'sent');
  perform public.comms_outbox_mark(v_id, 'sent');
  perform pg_temp.su();
  perform pg_temp.res('25 sent row logged once to the activity trail', (select count(*) from public.notifications
    where kind = 'payment_reminder' and detail ->> 'via' = 'comms' and quote_id = 'a0000000-0000-4000-8000-0000000078e1') = 1);
  -- manual send
  perform pg_temp.login('a_staff@a.test');
  r := public.payment_reminder_send_now('a0000000-0000-4000-8000-0000000078a1');
  perform pg_temp.res('26 send now queues on both channels', (r ->> 'queued')::int = 2, r::text);
  r := public.payment_reminder_send_now('a0000000-0000-4000-8000-0000000078a1');
  perform pg_temp.res('27 double click within 10 min is deduped', (r ->> 'queued')::int = 0 and (r ->> 'already_queued')::boolean, r::text);
  e := pg_temp.try('select public.payment_reminder_send_now(''b0000000-0000-4000-8000-0000000078a1'')');
  perform pg_temp.res('28 other studio milestone refused', e like '42501%', e);
  e := pg_temp.try('select public.payment_reminder_send_now(''a0000000-0000-4000-8000-0000000078a3'')');
  perform pg_temp.res('29 settled milestone refused', e like '22023%', e);
  perform pg_temp.login('cm_crew@a.test');
  e := pg_temp.try('select public.payment_reminder_send_now(''a0000000-0000-4000-8000-0000000078a1'')');
  perform pg_temp.res('30 crew cannot send', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- follow-ups
do $$ declare r jsonb; begin
  perform pg_temp.anon();
  perform public.public_link_opened('quote', 'a0000000-0000-4000-8000-0000000078aa');
  perform public.public_link_opened('quote', '00000000-0000-4000-8000-000000000000');
  perform public.public_link_opened('nope', 'a0000000-0000-4000-8000-0000000078aa');
  perform pg_temp.su();
  perform pg_temp.res('31 anon open recorded once, junk ignored', (select count(*) from public.client_link_opens) = 1
    and (select open_count from public.client_link_opens where quote_id = 'a0000000-0000-4000-8000-0000000078e2') = 1);
  perform pg_temp.login('a_admin@a.test');
  perform public.public_link_opened('quote', 'a0000000-0000-4000-8000-0000000078aa');
  perform pg_temp.su();
  perform pg_temp.res('32 studio member preview does not count', (select open_count from public.client_link_opens where quote_id = 'a0000000-0000-4000-8000-0000000078e2') = 1);
  update public.client_link_opens set first_opened_at = now() - interval '4 days';
  r := public.comms_tick();
  perform pg_temp.res('33 follow-up off -> none', pg_temp.ob('follow_up') = 0, r::text);
  update public.comms_settings set fu_enabled = true, fu_channels = array['email', 'whatsapp'] where org_id = 'a0000000-0000-4000-8000-000000000001';
  r := public.comms_tick();
  perform pg_temp.res('34 follow-up #1 by e-mail (no client phone -> no WhatsApp)',
    pg_temp.ob('follow_up') = 1 and exists (select 1 from public.comms_outbox where dedupe_key = 'fu:a0000000-0000-4000-8000-0000000078e2:1:email'), r::text);
  r := public.comms_tick();
  perform pg_temp.res('35 not repeated', pg_temp.ob('follow_up') = 1);
  update public.quotes set approval_status = 'approved' where id = 'a0000000-0000-4000-8000-0000000078e2';
  update public.client_link_opens set first_opened_at = now() - interval '7 days';
  r := public.comms_tick();
  perform pg_temp.res('36 approved -> no more follow-ups', pg_temp.ob('follow_up') = 1, r::text);
  set local role service_role;
  r := public.comms_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('37 queued follow-up skipped at claim after approval',
    (select status from public.comms_outbox where purpose = 'follow_up') = 'skipped');
exception when others then perform pg_temp.su(); insert into _uf values ('3x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- low stock
do $$ declare r jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; it uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.inventory_items(id, name, total_qty, org_id) values (it, 'Gold chairs', 10, a);
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values
    (it, 'a0000000-0000-4000-8000-0000000078e1', 6, 'reserved', a);
  insert into public.event_resource_needs(quote_id, label, item_id, qty, org_id) values
    ('a0000000-0000-4000-8000-0000000078e2', 'chairs', it, 6, a);
  r := public.comms_tick();
  perform pg_temp.res('38 shortage -> one bell row with item + date', (select count(*) from public.notifications
    where kind = 'inventory_low_stock' and detail ->> 'item_id' = it::text and (detail ->> 'need')::numeric = 12 and (detail ->> 'have')::numeric = 10) = 1, r::text);
  r := public.comms_tick();
  perform pg_temp.res('39 deduped on the next tick', (select count(*) from public.notifications where kind = 'inventory_low_stock') = 1);
  update public.event_resource_needs set qty = 8 where item_id = it;
  r := public.comms_tick();
  perform pg_temp.res('40 a bigger gap notifies again', (select count(*) from public.notifications where kind = 'inventory_low_stock') = 2);
  perform pg_temp.login('a_admin@a.test');
  r := public.bell_feed(50);
  perform pg_temp.res('41 admin bell shows it', exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'inventory_low_stock'), left(r::text, 300));
  perform pg_temp.login('cm_crew@a.test');
  r := public.bell_feed(50);
  perform pg_temp.res('42 role without Inventory does not', not exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'inventory_low_stock'));
  perform pg_temp.login('b_admin@b.test');
  r := public.bell_feed(50);
  perform pg_temp.res('43 other studio never sees it', not exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'inventory_low_stock'));
exception when others then perform pg_temp.su(); insert into _uf values ('4x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- WhatsApp forwarding
do $$ declare r jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; st uuid; cv uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  select id into st from auth.users where email = 'a_staff@a.test';
  perform pg_temp.login('a_staff@a.test');
  r := public.my_wa_forward_get();
  perform pg_temp.res('44 member sees number tail, off by default, studio not ready',
    (r ->> 'opted_in')::boolean = false and (r ->> 'has_number')::boolean and r ->> 'number_tail' = '3210' and (r ->> 'studio_ready')::boolean = false, r::text);
  perform pg_temp.su();
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values ('a0000000-0000-4000-8000-0000000078e1', 'in_app', 'task_due', 'simulated', '{"task_id":"t1"}', a);
  perform pg_temp.res('45 dormant: nothing forwarded while forwarding is off', pg_temp.ob('wa_forward') = 0);
  perform pg_temp.login('a_admin@a.test');
  perform public.comms_settings_set('{"wa_forward_enabled":true,"wa_forward_roles":{"sales":["task_due","admin_message","approval_link"]}}');
  perform pg_temp.su();
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
    values ('a0000000-0000-4000-8000-0000000078e1', 'in_app', 'task_due', 'simulated', '{"task_id":"t2"}', a);
  perform pg_temp.res('46 not opted in -> nothing', pg_temp.ob('wa_forward') = 0);
  perform pg_temp.login('a_staff@a.test');
  r := public.my_wa_forward_set(true);
  perform pg_temp.res('47 opt in', (r ->> 'opted_in')::boolean and (r ->> 'studio_ready')::boolean, r::text);
  perform pg_temp.su();
  insert into public.notifications(id, quote_id, channel, kind, status, detail, org_id)
    values ('a0000000-0000-4000-8000-0000000078f1', 'a0000000-0000-4000-8000-0000000078e1', 'in_app', 'task_due', 'simulated', '{"task_id":"t3"}', a);
  perform pg_temp.res('48 forwarded once to the opted-in member with a deep-link payload',
    (select count(*) from public.comms_outbox where purpose = 'wa_forward' and user_id = st and recipient = '919876543210'
       and payload ->> 'kind' = 'task_due' and payload #>> '{detail,task_id}' = 't3' and dedupe_key = 'fwd:n:a0000000-0000-4000-8000-0000000078f1:' || st) = 1);
  insert into public.notifications(quote_id, channel, kind, status, org_id) values ('a0000000-0000-4000-8000-0000000078e1', 'sms', 'otp', 'simulated', a);
  insert into public.notifications(quote_id, channel, kind, status, org_id) values ('a0000000-0000-4000-8000-0000000078e1', 'in_app', 'design_review', 'simulated', a);
  perform pg_temp.res('49 OTP + types the role did not pick are not forwarded', pg_temp.ob('wa_forward') = 1);
  insert into public.notifications(quote_id, channel, kind, status, org_id) values ('b0000000-0000-4000-8000-0000000078e1', 'in_app', 'task_due', 'simulated', 'b0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('50 other studio rows never reach studio A members', pg_temp.ob('wa_forward') = 1);
  insert into public.chat_conversations(id, org_id, kind, title) values (cv, a, 'broadcast', 'Everyone')
    on conflict do nothing;
  select id into cv from public.chat_conversations where org_id = a and kind = 'broadcast';
  insert into public.chat_messages(conversation_id, org_id, sender_id, body)
    values (cv, a, (select id from auth.users where email = 'a_admin@a.test'), 'Team meeting at 5');
  perform pg_temp.res('51 admin announcement forwarded', (select count(*) from public.comms_outbox where purpose = 'wa_forward'
    and payload ->> 'type' = 'admin_message' and payload ->> 'text' like '%Team meeting at 5%') = 1);
  -- rate limit
  insert into public.notifications(quote_id, channel, kind, status, org_id)
    select 'a0000000-0000-4000-8000-0000000078e1', 'in_app', 'task_due', 'simulated', a from generate_series(1, 40);
  perform pg_temp.res('52 rate limit: at most 30 per member per hour', (select count(*) from public.comms_outbox where user_id = st and purpose = 'wa_forward') = 30);
  perform pg_temp.login('a_staff@a.test');
  perform public.my_wa_forward_set(false);
  perform pg_temp.su();
  set local role service_role;
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('53 opted out after queueing -> skipped at claim',
    not exists (select 1 from jsonb_array_elements(r) x where x ->> 'purpose' = 'wa_forward'), left(r::text, 200));
  perform pg_temp.res('54 insert never fails even if forwarding errors', pg_temp.try('insert into public.notifications(quote_id, channel, kind, status, org_id) values (null, ''in_app'', ''x'', ''simulated'', ''a0000000-0000-4000-8000-000000000001'')') = '');
exception when others then perform pg_temp.su(); insert into _uf values ('5x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'COMMS-AUTOMATION: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'COMMS-AUTOMATION: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
