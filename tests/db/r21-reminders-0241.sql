-- r21-reminders-0241.sql -- 0241: delivery / arrival reminders. A planner schedules "120 chairs from Deccan Rentals by
-- <time>" on an event with its own reminder times; the 5-minute tick queues reminder e-mails at those times (once,
-- deduped, never late); the dispatcher claim re-checks each row and mints a one-click status link (only its hash is
-- kept); the vendor answers through the link without signing in (on the way / delayed + new time / arrived /
-- problem); every answer is logged and posted by Helm into the event's team chat group (@admins + scheduler) and the
-- bell; no answer after the due time -> "No response from ..." once; Control Center settings (controls edit) and the
-- 'deliveries' access area (falls back to 'command'); free-trial caps, ended trials, demo events and tenants.
-- Rolled back. Local disposable PG only. Nothing is ever sent (no dispatcher / edge function runs here).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _dr(name text, result text); grant all on _dr to anon, authenticated, service_role;
create temp table _dk(k text primary key, v text); grant all on _dk to anon, authenticated, service_role;

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
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.role_rows() returns text language sql as $$
  select coalesce(md5(string_agg(org_id::text || role || area || can_view::text || can_edit::text, ',' order by org_id, role, area)), '') from public.role_access $$;

-- ---- setup ------------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; adm uuid; crd uuid; v uuid; vb uuid; cv uuid; begin
  crd := pg_temp.member('dl_coord@a.test', 'coordinator', a, 'Ravi Coordinator');
  perform pg_temp.member('dl_quality@a.test', 'quality', a, 'Q Person');
  perform pg_temp.member('dl_crew@a.test', 'crew', a, 'Crew Person');
  perform pg_temp.member('dl_planner@b.test', 'planner', b, 'B Planner');
  perform pg_temp.su();
  select id into adm from public.profiles where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Asha Admin' where id = adm;
  -- default-matrix 'command' rights: coordinator edit, quality edit, crew none; B planner edit
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (a, 'coordinator', 'command', true, true, now()), (a, 'quality', 'command', true, true, now()), (b, 'planner', 'command', true, true, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.quotes set status = 'confirmed', event_date = current_date + 1, title = 'Wedding A' where id = qa;
  insert into public.vendors(id, name, category, email, org_id) values (gen_random_uuid(), 'Deccan Rentals', 'Furniture', 'Orders@Deccan.test', a) returning id into v;
  insert into public.vendors(id, name, category, email, org_id) values (gen_random_uuid(), 'B Vendor', 'Furniture', 'b@vendor.test', b) returning id into vb;
  insert into public.chat_conversations(id, org_id, kind, title, quote_id, created_by) values (gen_random_uuid(), a, 'group', 'Event group A-0001', qa, adm) returning id into cv;
  insert into public.chat_members(conversation_id, user_id, org_id) values (cv, adm, a), (cv, crd, a);
  perform pg_temp.put('v', v::text); perform pg_temp.put('vb', vb::text); perform pg_temp.put('cv', cv::text);
  perform pg_temp.put('adm', adm::text); perform pg_temp.put('crd', crd::text);
  perform pg_temp.put('roles0', pg_temp.role_rows());
end $$;

-- ---- the migration, twice (safe to re-run) -----------------------------------------------------------------------
\ir ../../supabase/migrations/0241_delivery_reminders.sql
\ir ../../supabase/migrations/0241_delivery_reminders.sql

-- ---- 0) structure + grants ----------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 five new tables, RLS on, no anon / signed-in table privilege',
    (select bool_and(c.relrowsecurity) and count(*) = 5 from pg_class c where c.oid in ('public.delivery_settings'::regclass, 'public.delivery_commitments'::regclass,
       'public.delivery_commitment_log'::regclass, 'public.delivery_reminder_sends'::regclass, 'public.delivery_links'::regclass))
    and not has_table_privilege('authenticated', 'public.delivery_commitments', 'select')
    and not has_table_privilege('authenticated', 'public.delivery_commitments', 'insert')
    and not has_table_privilege('anon', 'public.delivery_links', 'select')
    and not has_table_privilege('authenticated', 'public.delivery_reminder_sends', 'select'));
  perform pg_temp.res('02 the migration wrote no role_access row (deliveries falls back to command)', pg_temp.role_rows() = pg_temp.get('roles0')
    and not exists (select 1 from public.role_access where area = 'deliveries'));
  perform pg_temp.res('03 scheduler + claim + mark: service role only; helpers internal',
    has_function_privilege('service_role', 'public.delivery_reminders_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.delivery_reminders_tick()', 'execute')
    and not has_function_privilege('anon', 'public.delivery_reminder_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.delivery_reminder_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.delivery_reminder_mark(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._dl241_announce(uuid,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public._dl241_send_block(uuid,text,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._dl241_can(text)', 'execute'));
  perform pg_temp.res('04 app RPCs: signed-in only; the two link RPCs also for anon',
    has_function_privilege('authenticated', 'public.delivery_save(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.delivery_save(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.delivery_list(uuid,timestamptz,timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.delivery_settings_set(jsonb)', 'execute')
    and has_function_privilege('anon', 'public.delivery_link_get(text)', 'execute')
    and has_function_privilege('anon', 'public.delivery_link_update(text,text,text,timestamptz)', 'execute'));
  perform pg_temp.res('06 trial retention: the 4 assignment tables purge with the quote, delivery_settings kept',
    public._tr184_purge_tables() @> array['delivery_links', 'delivery_reminder_sends', 'delivery_commitment_log', 'delivery_commitments']
    and 'delivery_settings' = any(public._tr184_keep_tables()) and not ('delivery_settings' = any(public._tr184_purge_tables())));
  perform pg_temp.res('05 every 0241 function body is ASCII', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and (p.proname like '\_dl241%' or p.proname like 'delivery\_%') and p.prosrc ~ '[^\x01-\x7e\s]'));
end $$;

-- ---- 1) settings (Control Center) ---------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.login('dl_coord@a.test');
  r := public.delivery_settings_get();
  perform pg_temp.res('10 coordinator (command view) reads the settings: defaults = off, 60 / 30 / 0, vendor + staff + user, chat + bell on',
    r ->> 'enabled' = 'false' and r -> 'offsets' = '[60, 30, 0]'::jsonb and r -> 'ping_kinds' = '["vendor", "staff", "user"]'::jsonb
    and r ->> 'chat_post' = 'true' and r ->> 'notify_bell' = 'true' and r ->> 'can_schedule' = 'true' and r ->> 'can_manage' = 'false'
    and r ->> 'timezone' = 'Asia/Kolkata', r::text);
  e := pg_temp.err($q$select public.delivery_settings_set('{"enabled": true}'::jsonb)$q$);
  perform pg_temp.res('11 coordinator cannot change the settings (controls edit needed)', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.err($q$select public.delivery_settings_set('{"offsets": [2000]}'::jsonb)$q$);
  perform pg_temp.res('12 bad offsets refused (0..1440 minutes)', e like '22023%', e);
  e := pg_temp.err($q$select public.delivery_settings_set('{"ping_kinds": ["sms"]}'::jsonb)$q$);
  perform pg_temp.res('13 unknown kind of person refused', e like '22023%', e);
  e := pg_temp.err($q$select public.delivery_settings_set('{"evil": 1}'::jsonb)$q$);
  perform pg_temp.res('14 unknown setting refused', e like '22023%', e);
  r := public.delivery_settings_set('{"enabled": true, "offsets": [0, 60, 30, 60], "ping_kinds": ["vendor", "staff", "user"]}'::jsonb);
  perform pg_temp.res('15 admin switches it on; offsets de-duplicated, latest first', r ->> 'enabled' = 'true' and r -> 'offsets' = '[60, 30, 0]'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('16 settings change is audited', exists (select 1 from public.audit_log where action = 'delivery_settings.set' and org_id = 'a0000000-0000-4000-8000-000000000001'));
  -- a chat group of ANOTHER studio cannot be picked
  insert into public.chat_conversations(id, org_id, kind, title) values ('b0000000-0000-4000-8000-0000000c0001', 'b0000000-0000-4000-8000-000000000001', 'group', 'B ops');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.err($q$select public.delivery_settings_set('{"chat_conversation_id": "b0000000-0000-4000-8000-0000000c0001"}'::jsonb)$q$);
  perform pg_temp.res('17 another studio''s chat group refused', e like 'P0002%', e);
end $$;

-- ---- 2) scheduling an assignment ----------------------------------------------------------------------------------
do $$ declare r jsonb; e text; v text := pg_temp.get('v'); begin
  perform pg_temp.login('dl_crew@a.test');
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"a0000000-0000-4000-8000-00000000da01","what":"Chairs","party_kind":"other","party_name":"X","due_at":"%s"}'::jsonb)$q$, now() + interval '1 hour'));
  perform pg_temp.res('20 crew (no command / deliveries right) cannot schedule', e like '42501%', e);
  perform pg_temp.login('dl_coord@a.test');
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"b0000000-0000-4000-8000-00000000da01","what":"Chairs","party_kind":"other","party_name":"X","due_at":"%s"}'::jsonb)$q$, now() + interval '1 hour'));
  perform pg_temp.res('21 another studio''s event refused', e like 'P0002%', e);
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"a0000000-0000-4000-8000-00000000da01","what":"Chairs","party_kind":"vendor","vendor_id":"%s","due_at":"%s"}'::jsonb)$q$, pg_temp.get('vb'), now() + interval '1 hour'));
  perform pg_temp.res('22 another studio''s vendor refused', e like 'P0002%', e);
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"a0000000-0000-4000-8000-00000000da01","what":"<b>x","party_kind":"other","party_name":"X","due_at":"%s"}'::jsonb)$q$, now() + interval '1 hour'));
  perform pg_temp.res('23 markup in "what" refused', e like '22023%', e);
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"a0000000-0000-4000-8000-00000000da01","what":"Chairs","party_kind":"other","party_name":"X","contact_email":"not-an-email","due_at":"%s"}'::jsonb)$q$, now() + interval '1 hour'));
  perform pg_temp.res('24 bad e-mail refused', e like '22023%', e);
  e := pg_temp.err(format($q$select public.delivery_save('{"quote_id":"a0000000-0000-4000-8000-00000000da01","what":"Chairs","party_kind":"other","party_name":"X","due_at":"%s","offsets":[5000]}'::jsonb)$q$, now() + interval '1 hour'));
  perform pg_temp.res('25 bad per-assignment reminder time refused', e like '22023%', e);
  -- the real one: 120 chairs from Deccan Rentals, due in exactly 60 minutes, this assignment's own reminders 60 / 30 / 0
  r := public.delivery_save(jsonb_build_object('quote_id', 'a0000000-0000-4000-8000-00000000da01', 'what', 'Chairs', 'qty', 120,
         'party_kind', 'vendor', 'vendor_id', v, 'due_at', now() + interval '60 minutes', 'offsets', jsonb_build_array(0, 30, 60), 'source', 'shortage'));
  perform pg_temp.put('c1', r ->> 'id');
  perform pg_temp.res('26 saved: vendor name + e-mail (lower-cased) taken from the vendor, status scheduled, own offsets kept',
    r ->> 'party_name' = 'Deccan Rentals' and r ->> 'contact_email' = 'orders@deccan.test' and r ->> 'status' = 'scheduled'
    and r -> 'offsets' = '[60, 30, 0]'::jsonb and r ->> 'source' = 'shortage' and r ->> 'due_text' ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}, ', r::text);
  -- a second one with NO reminders ([]), and a third to someone outside the allowed kinds ("other")
  r := public.delivery_save(jsonb_build_object('quote_id', 'a0000000-0000-4000-8000-00000000da01', 'what', 'Generator', 'party_kind', 'other',
         'party_name', 'Gen Guy', 'contact_email', 'gen@guy.test', 'due_at', now() + interval '60 minutes', 'offsets', '[]'::jsonb));
  perform pg_temp.put('c2', r ->> 'id');
  r := public.delivery_save(jsonb_build_object('quote_id', 'a0000000-0000-4000-8000-00000000da01', 'what', 'Flowers', 'party_kind', 'other',
         'party_name', 'Florist', 'contact_email', 'flo@rist.test', 'due_at', now() + interval '60 minutes'));
  perform pg_temp.put('c3', r ->> 'id');
  perform pg_temp.res('27 board lists the event''s three deliveries, in due order', jsonb_array_length(public.delivery_list('a0000000-0000-4000-8000-00000000da01')) = 3);
  perform pg_temp.su();
  perform pg_temp.res('28 history: "scheduled" by the coordinator (name kept)',
    exists (select 1 from public.delivery_commitment_log where commitment_id = pg_temp.get('c1')::uuid and status = 'scheduled' and actor_kind = 'user' and actor_label = 'Ravi Coordinator'));
  -- tenant isolation
  perform pg_temp.login('dl_planner@b.test');
  perform pg_temp.res('29 studio B sees none of A''s deliveries', jsonb_array_length(public.delivery_list('a0000000-0000-4000-8000-00000000da01')) = 0
    and jsonb_array_length(public.delivery_list()) = 0);
  e := pg_temp.err(format($q$select public.delivery_set_status('%s', 'arrived')$q$, pg_temp.get('c1')));
  perform pg_temp.res('30 studio B cannot change A''s delivery', e like 'P0002%', e);
  e := pg_temp.err(format($q$select public.delivery_link_issue('%s')$q$, pg_temp.get('c1')));
  perform pg_temp.res('31 studio B cannot mint a link for A''s delivery', e like 'P0002%', e);
  e := pg_temp.err(format($q$select public.delivery_history('%s')$q$, pg_temp.get('c1')));
  perform pg_temp.res('32 studio B cannot read A''s history', e like 'P0002%', e);
end $$;

-- ---- 3) the 'deliveries' switch overrides the 'command' fallback ------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quality', 'deliveries', true, false, now());
  perform pg_temp.login('dl_quality@a.test');
  perform pg_temp.res('35 quality: deliveries row (view only) wins over command edit - sees the board', jsonb_array_length(public.delivery_list('a0000000-0000-4000-8000-00000000da01')) = 3);
  e := pg_temp.err(format($q$select public.delivery_set_status('%s', 'arrived')$q$, pg_temp.get('c1')));
  perform pg_temp.res('36 quality: ... but cannot change anything', e like '42501%', e);
  perform pg_temp.login('dl_crew@a.test');
  e := pg_temp.err($q$select public.delivery_list()$q$);
  perform pg_temp.res('37 crew (no command, no deliveries row) cannot read the board', e like '42501%', e);
  perform pg_temp.anon();
  e := pg_temp.err($q$select public.delivery_list()$q$);
  perform pg_temp.res('38 anon cannot read the board', e like '42501%', e);
end $$;

-- ---- 4) the tick: reminders at the assignment's own times ---------------------------------------------------------
do $$ declare r jsonb; r2 jsonb; c1 uuid := pg_temp.get('c1')::uuid; begin
  perform pg_temp.svc();
  r := public.delivery_reminders_tick();
  r2 := public.delivery_reminders_tick();
  perform pg_temp.su();
  perform pg_temp.res('40 tick at T-60: vendor + scheduler copy queued for "Chairs" (2 rows) + the Flowers copy, nothing for "no reminders"', (r ->> 'queued')::int = 3
    and (select count(*) from public.delivery_reminder_sends where commitment_id = c1 and offset_min = 60 and status = 'pending') = 2
    and not exists (select 1 from public.delivery_reminder_sends where commitment_id in (pg_temp.get('c2')::uuid)), r::text);
  perform pg_temp.res('41 "other" is not an allowed kind: only the scheduler''s copy for Flowers',
    (select count(*) from public.delivery_reminder_sends where commitment_id = pg_temp.get('c3')::uuid and recipient_kind = 'party') = 0
    and (select count(*) from public.delivery_reminder_sends where commitment_id = pg_temp.get('c3')::uuid and recipient_kind = 'cc') = 1);
  perform pg_temp.res('42 a second tick queues nothing new (dedupe)', (r2 ->> 'queued')::int = 0 and (select count(*) from public.delivery_reminder_sends) = 3, r2::text);
  perform pg_temp.res('43 status -> reminded, logged as Helm', (select status from public.delivery_commitments where id = c1) = 'reminded'
    and exists (select 1 from public.delivery_commitment_log where commitment_id = c1 and status = 'reminded' and actor_kind = 'system'));
  perform pg_temp.res('44 the vendor address is the vendor''s, the copy is the scheduler''s',
    exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and recipient_kind = 'party' and recipient = 'orders@deccan.test')
    and exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and recipient_kind = 'cc' and recipient = 'dl_coord@a.test'));
end $$;

-- ---- 5) the dispatcher claim: re-checked, one fresh link per vendor e-mail, only its hash stored ------------------
do $$ declare rows jsonb; x jsonb; tok text; c1 uuid := pg_temp.get('c1')::uuid; e text; begin
  perform pg_temp.login('dl_coord@a.test');
  e := pg_temp.err($q$select public.delivery_reminder_claim(10)$q$);
  perform pg_temp.res('50 a signed-in user cannot claim', e like '42501%', e);
  perform pg_temp.svc();
  rows := public.delivery_reminder_claim(10);
  perform pg_temp.su();
  select r into x from jsonb_array_elements(rows) r where r ->> 'kind' = 'party' and r ->> 'what' = 'Chairs';
  tok := x ->> 'token'; perform pg_temp.put('tok', tok);
  perform pg_temp.res('51 claim hands out the 3 rows; vendor row carries what / qty / due text / event / studio + a 64-hex token',
    jsonb_array_length(rows) = 3 and tok ~ '^[0-9a-f]{64}$' and x ->> 'qty' = '120' and x ->> 'event' = 'Wedding A' and x ->> 'studio' = 'Studio A'
    and (x ->> 'offset_min')::int = 60 and x ->> 'due_text' is not null, rows::text);
  perform pg_temp.res('52 the copy rows carry no token', not exists (select 1 from jsonb_array_elements(rows) r where r ->> 'kind' = 'cc' and r ->> 'token' is not null));
  perform pg_temp.res('53 only the sha-256 of the token is stored, scoped to that one delivery, expiring',
    exists (select 1 from public.delivery_links where token_hash = encode(sha256(convert_to(tok, 'UTF8')), 'hex') and commitment_id = c1 and expires_at > now() + interval '12 hours')
    and not exists (select 1 from public.delivery_links where token_hash = tok));
  perform pg_temp.svc();
  perform public.delivery_reminder_mark((x ->> 'id')::uuid, 'sent');
  perform public.delivery_reminder_mark((select (r ->> 'id')::uuid from jsonb_array_elements(rows) r where r ->> 'kind' = 'cc' and r ->> 'what' = 'Chairs'), 'retry');
  perform pg_temp.su();
  perform pg_temp.res('54 mark: sent / retry (claimed again later)', (select status from public.delivery_reminder_sends where id = (x ->> 'id')::uuid) = 'sent'
    and exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and recipient_kind = 'cc' and status = 'pending' and claimed_at is null));
end $$;

-- ---- 6) the vendor answers through the link (signed out) ------------------------------------------------------------
do $$ declare r jsonb; e text; tok text := pg_temp.get('tok'); c1 uuid := pg_temp.get('c1')::uuid; begin
  perform pg_temp.anon();
  r := public.delivery_link_get(repeat('0', 64));
  perform pg_temp.res('60 a wrong token shows nothing', r ->> 'ok' = 'false' and not (r ? 'what'), r::text);
  r := public.delivery_link_get('not-a-token');
  perform pg_temp.res('61 a malformed token shows nothing', r ->> 'ok' = 'false');
  r := public.delivery_link_get(tok);
  perform pg_temp.res('62 the link shows only this delivery: what, qty, due, event, studio - no client, no money',
    r ->> 'ok' = 'true' and r ->> 'what' = 'Chairs' and r ->> 'qty' = '120' and r ->> 'event' = 'Wedding A' and r ->> 'studio' = 'Studio A'
    and r ->> 'can_update' = 'true' and not (r ? 'contact_email') and not (r ? 'client') and position('Alice' in r::text) = 0 and position('236000' in r::text) = 0, r::text);
  e := pg_temp.err(format($q$select public.delivery_link_update('%s', 'cancelled')$q$, tok));
  perform pg_temp.res('63 the link cannot cancel (only on the way / arrived / delayed / problem)', e like '22023%', e);
  e := pg_temp.err(format($q$select public.delivery_link_update('%s', 'issue', '')$q$, tok));
  perform pg_temp.res('64 "problem" needs a note', e like '22023%', e);
  r := public.delivery_link_update(tok, 'confirmed', 'Loaded, leaving now');
  perform pg_temp.res('65 vendor: on the way', r ->> 'status' = 'confirmed', r::text);
  r := public.delivery_link_update(tok, 'delayed', 'Truck stuck', now() + interval '90 minutes');
  perform pg_temp.res('66 vendor: delayed + new time', r ->> 'status' = 'delayed' and r ->> 'eta_text' is not null, r::text);
  perform pg_temp.su();
  perform pg_temp.res('67 every answer logged as the vendor via the status link, with the note + new ETA',
    (select count(*) from public.delivery_commitment_log where commitment_id = c1 and actor_kind = 'link' and actor_label = 'Deccan Rentals (status link)') = 2
    and exists (select 1 from public.delivery_commitment_log where commitment_id = c1 and status = 'delayed' and note = 'Truck stuck' and eta_at is not null));
  perform pg_temp.res('68 each answer posted by Helm into the event group, @mentioning admin + scheduler',
    (select count(*) from public.chat_messages where conversation_id = pg_temp.get('cv')::uuid and sender_id is null and kind = 'system' and meta ->> 'delivery_id' = c1::text) = 2
    and exists (select 1 from public.chat_messages where conversation_id = pg_temp.get('cv')::uuid and body like '%Chairs x120 (Deccan Rentals)%delayed: Truck stuck, new ETA %'
                  and (meta -> 'mentions') ? pg_temp.get('adm') and (meta -> 'mentions') ? pg_temp.get('crd'))
    and exists (select 1 from public.chat_messages where conversation_id = pg_temp.get('cv')::uuid and body like '%on the way, due % - Loaded, leaving now%A-0001'),
    (select string_agg(body, ' | ') from public.chat_messages where conversation_id = pg_temp.get('cv')::uuid));
  perform pg_temp.res('69 ... and dropped into the bell (studio, event-linked)',
    (select count(*) from public.notifications where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'event_reminder' and detail ->> 'source' = '0241') = 2);
end $$;

-- ---- 7) reminders follow the new ETA; arrival stops them ----------------------------------------------------------
do $$ declare r jsonb; rows jsonb; c1 uuid := pg_temp.get('c1')::uuid; tok text := pg_temp.get('tok'); n0 int; begin
  perform pg_temp.su();
  -- move the promised time so that "now" is the 30-minutes-before slot of the new ETA
  update public.delivery_commitments set eta_at = now() + interval '30 minutes' where id = c1;
  n0 := (select count(*) from public.delivery_reminder_sends where commitment_id = c1);
  perform pg_temp.svc(); r := public.delivery_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('70 delayed: the next reminder follows the new ETA (30 min slot, vendor + copy)',
    (select count(*) from public.delivery_reminder_sends where commitment_id = c1) = n0 + 2
    and exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and offset_min = 30 and status = 'pending'), r::text);
  perform pg_temp.anon();
  r := public.delivery_link_update(tok, 'arrived', 'All 120 unloaded');
  perform pg_temp.svc(); rows := public.delivery_reminder_claim(10); perform pg_temp.su();
  perform pg_temp.res('71 after "arrived" the queued reminders are skipped at claim time, never sent',
    not exists (select 1 from jsonb_array_elements(rows) x where x ->> 'what' = 'Chairs')
    and not exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and status = 'pending')
    and exists (select 1 from public.delivery_reminder_sends where commitment_id = c1 and status = 'skipped' and reason = 'recheck'), rows::text);
  perform pg_temp.res('72 "arrived" posted to the group', exists (select 1 from public.chat_messages where conversation_id = pg_temp.get('cv')::uuid and body like '%Chairs x120 (Deccan Rentals)%arrived % - All 120 unloaded%'));
end $$;

-- ---- 8) planner actions on the board + copy link ------------------------------------------------------------------
do $$ declare r jsonb; e text; c3 uuid := pg_temp.get('c3')::uuid; begin
  perform pg_temp.login('dl_coord@a.test');
  r := public.delivery_set_status(c3, 'issue', 'Wrong colour');
  perform pg_temp.res('80 board: coordinator marks a problem (by name, posted)', r ->> 'status' = 'issue' and r ->> 'status_by' = 'Ravi Coordinator', r::text);
  r := public.delivery_link_issue(c3);
  perform pg_temp.res('81 copy status link: a fresh 64-hex token', r ->> 'token' ~ '^[0-9a-f]{64}$', r::text);
  perform pg_temp.put('tok3', r ->> 'token');
  r := public.delivery_set_status(c3, 'cancelled');
  perform pg_temp.anon();
  r := public.delivery_link_update(pg_temp.get('tok3'), 'confirmed');
  perform pg_temp.su();
  perform pg_temp.res('82 a cancelled delivery''s link cannot be updated', r ->> 'ok' = 'false' and r ->> 'reason' = 'closed'
    and (select status from public.delivery_commitments where id = c3) = 'cancelled', r::text);
  perform pg_temp.res('83 group got "problem" + "cancelled" with the planner''s name',
    exists (select 1 from public.chat_messages where body like '%Flowers (Florist)%problem: Wrong colour (by Ravi Coordinator)%')
    and exists (select 1 from public.chat_messages where body like '%Flowers (Florist)%cancelled%'));
  perform pg_temp.login('dl_coord@a.test');
  r := public.delivery_history(pg_temp.get('c1')::uuid);
  perform pg_temp.res('84 history lists every step newest first, with who', jsonb_array_length(r -> 'log') >= 5
    and (r -> 'log' -> 0 ->> 'status') = 'arrived' and jsonb_array_length(r -> 'reminders') >= 3, r::text);
  -- nothing is deleted: no delete RPC, and the API role cannot delete rows
  perform pg_temp.res('85 the app cannot delete a delivery (no table privilege)', not has_table_privilege('authenticated', 'public.delivery_commitments', 'delete'));
end $$;

-- ---- 9) no answer after the due time -> one "No response" alert -------------------------------------------------
do $$ declare r jsonb; r2 jsonb; c4 uuid; v_t timestamptz := now() - interval '20 minutes'; begin
  perform pg_temp.su();
  insert into public.delivery_commitments(org_id, quote_id, what, qty, party_kind, party_name, contact_email, due_at, status, created_by, created_at)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'Tent', 1, 'vendor', 'Tent House', 'tent@house.test', v_t, 'reminded',
            pg_temp.get('crd')::uuid, now() - interval '2 hours') returning id into c4;
  insert into public.delivery_reminder_sends(org_id, commitment_id, offset_min, recipient_kind, recipient, dedupe_key, status, sent_at, created_at)
    values ('a0000000-0000-4000-8000-000000000001', c4, 0, 'party', 'tent@house.test', 'dl:' || c4 || ':' || floor(extract(epoch from v_t))::bigint || ':0:party',
            'sent', now() - interval '19 minutes', now() - interval '20 minutes');
  perform pg_temp.svc(); r := public.delivery_reminders_tick(); r2 := public.delivery_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('90 no reply 15+ min after the due time: one "No response" alert (logged, group, bell)', (r ->> 'no_response')::int = 1 and (r2 ->> 'no_response')::int = 0
    and exists (select 1 from public.delivery_commitment_log where commitment_id = c4 and status = 'no_response' and actor_kind = 'system')
    and exists (select 1 from public.chat_messages where body like '%No response from Tent House for Tent x1 (due %')
    and exists (select 1 from public.notifications where detail ->> 'event' = 'no_response'), r::text || r2::text);
end $$;

-- ---- 10) switched off / demo event / free trial ------------------------------------------------------------------
do $$ declare r jsonb; c5 uuid; t uuid; tq uuid := gen_random_uuid(); u uuid; n int; begin
  perform pg_temp.su();
  -- demo (sample) event: queued rows are skipped, never sent
  update public.quotes set is_demo = true where id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.delivery_commitments(org_id, quote_id, what, party_kind, party_name, contact_email, due_at, created_by)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'Demo lights', 'other', 'D', 'd@d.test', now() + interval '30 minutes', null) returning id into c5;
  update public.delivery_settings set ping_kinds = array['vendor', 'staff', 'user', 'other'] where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.svc(); perform public.delivery_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('A0 demo (sample) event: the reminder is stored skipped (sample_event), never pending',
    exists (select 1 from public.delivery_reminder_sends where commitment_id = c5 and status = 'skipped' and reason = 'sample_event')
    and not exists (select 1 from public.delivery_reminder_sends where commitment_id = c5 and status = 'pending'));
  update public.quotes set is_demo = false where id = 'a0000000-0000-4000-8000-00000000da01';
  -- switched off: nothing queued
  update public.delivery_settings set enabled = false where org_id = 'a0000000-0000-4000-8000-000000000001';
  update public.delivery_commitments set due_at = now() + interval '60 minutes' where id = c5;
  n := (select count(*) from public.delivery_reminder_sends);
  perform pg_temp.svc(); r := public.delivery_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('A1 studio switched off: nothing queued', (select count(*) from public.delivery_reminder_sends) = n and (r ->> 'queued')::int = 0, r::text);

  -- an active free trial: e-mail allowed under the 0212 caps (a slot is taken)
  u := pg_temp.newuser('dl_trial@t.test'); perform pg_temp.login('dl_trial@t.test');
  r := public.start_self_serve_trial('T dl', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); t := (r ->> 'org_id')::uuid; perform pg_temp.put('t', t::text);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values (tq, 'T-0001', 'Trial event', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'none', t, now(), now());
  insert into public.delivery_settings(org_id, enabled, ping_kinds, cc_creator) values (t, true, array['other'], false);
  insert into public.delivery_commitments(org_id, quote_id, what, party_kind, party_name, contact_email, due_at, created_by)
    select t, tq, 'Trial chairs ' || g, 'other', 'P', 'same@vendor.test', now() + interval '60 minutes', u from generate_series(1, 6) g;
  perform pg_temp.svc(); perform public.delivery_reminders_tick(); perform pg_temp.su();
  perform pg_temp.res('A2 free trial: 5 e-mails to one address a day go out (slot taken each), the 6th is skipped (cap)',
    (select count(*) from public.delivery_reminder_sends where org_id = t and status = 'pending' and trial_slot) = 5
    and (select count(*) from public.delivery_reminder_sends where org_id = t and status = 'skipped' and reason = 'trial_cap_recipient') = 1
    and not exists (select 1 from public.trial_email_sends where org_id = t),
    (select string_agg(status || ':' || coalesce(reason, ''), ',') from public.delivery_reminder_sends where org_id = t));
  perform pg_temp.svc(); r := public.delivery_reminder_claim(50); perform pg_temp.su();
  perform pg_temp.res('A3 free trial: the 5 slotted rows are handed out', (select count(*) from jsonb_array_elements(r) x where x ->> 'what' like 'Trial chairs%') = 5, r::text);
  -- the trial ends: nothing more is sent, the link can no longer change anything
  update public.delivery_reminder_sends set status = 'pending', sent_at = null, claimed_at = null where org_id = t;
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = t;
  update public.studio_subscriptions set trial_ends_at = (now() - interval '2 days')::date where org_id = t;
  perform pg_temp.svc(); r := public.delivery_reminder_claim(50); perform pg_temp.su();
  perform pg_temp.res('A4 ended trial: queued rows are skipped at claim time', (select count(*) from jsonb_array_elements(r) x where x ->> 'what' like 'Trial chairs%') = 0
    and not exists (select 1 from public.delivery_reminder_sends where org_id = t and status = 'pending'), r::text);
  perform pg_temp.res('A5 ended trial: _dl241_send_block says trial_ended', public._dl241_send_block(t, 'x@y.test', false) = 'trial_ended');
end $$;

-- ---- 11) expiry ------------------------------------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.su();
  update public.delivery_links set expires_at = now() - interval '1 minute' where token_hash = encode(sha256(convert_to(pg_temp.get('tok'), 'UTF8')), 'hex');
  perform pg_temp.anon();
  r := public.delivery_link_get(pg_temp.get('tok'));
  perform pg_temp.su();
  perform pg_temp.res('B0 an expired link shows nothing', r ->> 'ok' = 'false', r::text);
end $$;

select name, result from _dr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-REMINDERS-0241: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-REMINDERS-0241: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _dr;
rollback;
