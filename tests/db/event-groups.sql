-- event-groups.sql — 0035 event groups + @mentions.
-- create_event_group: confirmed quote OK; unconfirmed refused; another studio refused;
-- no quotes access refused; anon refused; a second create returns the SAME group (no
-- duplicate, one card); the event card carries NO money key/value; users can't forge an
-- event card; refresh posts only when something changed and only while confirmed;
-- @mentions of non-members / other studios / junk are stripped; chat_my_mentions;
-- event_group_index is studio-scoped; deleting the quote keeps the group.
-- Fixture: a_admin/a_staff (studio A), b_admin/b_staff (studio B). Own quotes are
-- created here and removed at the end (the shared fixture quotes are not touched).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _eg; create temp table _eg(name text, result text); grant all on _eg to anon, authenticated;
drop table if exists _egv; create temp table _egv(k text primary key, v text); grant all on _egv to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
-- superuser, but with studio A's admin as the request user (triggers that read current_org_id work)
create or replace function pg_temp.su_as(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); execute 'reset role';
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _eg values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create or replace function pg_temp.setv(p_k text, p_v text) returns void language sql security definer as $$
  insert into _egv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.getv(p_k text) returns text language sql security definer as $$ select v from _egv where k = p_k $$;
-- every object key anywhere in a jsonb document
create or replace function pg_temp.keys(p jsonb) returns setof text language sql as $$
  select distinct k from jsonb_path_query(coalesce(p, '{}'::jsonb), 'lax $.**') v, jsonb_object_keys(v) k
   where jsonb_typeof(v) = 'object' $$;
grant execute on function pg_temp.try(text), pg_temp.uid(text), pg_temp.setv(text,text), pg_temp.getv(text), pg_temp.keys(jsonb) to anon, authenticated;

-- ---- setup (superuser) -------------------------------------------------------------
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001'; c uuid;
begin perform pg_temp.su();
  -- a studio-A crew member with NO quotes access (no role_access row for 'crew')
  select id into c from auth.users where email = 'a_crew@a.test';
  if c is null then c := auth.seed_user('a_crew@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (c, 'a_crew@a.test', 'crew', orgA, false, now())
    on conflict (id) do update set role = 'crew', org_id = orgA;
  delete from public.role_access where role = 'crew' and org_id = orgA;
  -- quotes: A confirmed (full details + money everywhere), A draft, B confirmed
  insert into public.quotes(id, code, title, event_type, status, client, pricing, current_version, org_id, event_date, event_time, created_at, updated_at)
  values
   ('a0000000-0000-4000-8000-0000000e0001', '10062026-11', 'Sharma wedding', 'Wedding', 'confirmed',
    '{"name":"Priya Sharma","phone":"+91 98765 43210","email":"priya@example.com","venue":"Lotus Lawns","address":"MG Road","notes":"Jain food at one counter","guests":180,"budget":900000,"advance":50000,"eventDate":"2026-12-10"}'::jsonb,
    '{"subtotal":200000,"discount":5000,"gstPct":18,"total":230100,"guests":200,"chairs":200,"chairPrice":40,"platePrice":950,"advance":25000}'::jsonb,
    1, orgA, '2026-12-10', '18:30', now(), now()),
   ('a0000000-0000-4000-8000-0000000e0002', '10062026-12', 'Draft party', 'Birthday', 'quote',
    '{"name":"Draft Client"}'::jsonb, '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}'::jsonb, 1, orgA, null, null, now(), now()),
   ('b0000000-0000-4000-8000-0000000e0001', 'B-EG-01', 'Studio B gala', 'Gala', 'confirmed',
    '{"name":"Bob"}'::jsonb, '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}'::jsonb, 1, orgB, null, null, now(), now())
  on conflict (id) do update set status = excluded.status, client = excluded.client, pricing = excluded.pricing;
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
    values ('a0000000-0000-4000-8000-0000000e0001', 1, '{"items":[]}'::jsonb, 42, orgA)
    on conflict (quote_id, version_no) do update set object_count = 42;
  insert into public.event_plan(quote_id, venue_name, venue_address, access_notes, package, menu_template, menu_plate_price, org_id)
    values ('a0000000-0000-4000-8000-0000000e0001', 'Lotus Lawns (main)', 'MG Road, Pune', 'Gate 2 for vendors',
            'Royal Veg', 'Royal Veg', 1250, orgA)
    on conflict (quote_id) do update set venue_name = excluded.venue_name, menu_plate_price = excluded.menu_plate_price;
  delete from public.event_menu_items where quote_id = 'a0000000-0000-4000-8000-0000000e0001';
  insert into public.event_menu_items(quote_id, dish_name, category, kind, qty, seq, org_id) values
    ('a0000000-0000-4000-8000-0000000e0001', 'Paneer Tikka', 'Starters', 'veg', 200, 1, orgA),
    ('a0000000-0000-4000-8000-0000000e0001', 'Dal Makhani', 'Mains', 'veg', 200, 2, orgA);
end $$;

-- ---- 01-04 create on a confirmed quote ---------------------------------------------------
do $$ declare s text := ''; v uuid; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    v := public.create_event_group('a0000000-0000-4000-8000-0000000e0001',
           array[pg_temp.uid('a_admin@a.test'), pg_temp.uid('b_staff@b.test'), gen_random_uuid(), null]::uuid[]);
  exception when others then s := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.setv('conv', v::text);
  perform pg_temp.res('01 staff with quotes access creates the event group of a confirmed quote', s = '' and v is not null, s);
end $$;
do $$ declare v uuid := pg_temp.getv('conv')::uuid; c record; mem text; begin perform pg_temp.su();
  select * into c from public.chat_conversations where id = v;
  select string_agg(p.email || ':' || m.member_role, ',' order by p.email) into mem
    from public.chat_members m join public.profiles p on p.id = m.user_id where m.conversation_id = v;
  perform pg_temp.res('02 group: kind group, linked to the quote, titled code · event, studio A',
    c.kind = 'group' and c.quote_id = 'a0000000-0000-4000-8000-0000000e0001' and c.title = '10062026-11 · Sharma wedding'
    and c.org_id = 'a0000000-0000-4000-8000-000000000001', coalesce(c.title, '∅'));
  perform pg_temp.res('03 members: creator (group admin) + picked studio member; other studio / unknown ids dropped',
    mem = 'a_admin@a.test:member,a_staff@a.test:admin', coalesce(mem, '∅'));
end $$;
do $$ declare v uuid := pg_temp.getv('conv')::uuid; n int; m record; bad text; begin perform pg_temp.su();
  select count(*) into n from public.chat_messages where conversation_id = v;
  select * into m from public.chat_messages where conversation_id = v order by created_at limit 1;
  perform pg_temp.res('04 one system event card is posted (sender null, kind card, meta.kind event)',
    n = 1 and m.sender_id is null and m.kind = 'card' and m.meta ->> 'kind' = 'event', 'n='||n);
  perform pg_temp.res('05 card has the non-money details (client, phone, email, type, date/time, venue, guests, layout, menu, notes)',
    m.meta -> 'client' ->> 'name' = 'Priya Sharma' and m.meta -> 'client' ->> 'phone' = '+91 98765 43210'
    and m.meta -> 'client' ->> 'email' = 'priya@example.com' and m.meta ->> 'event_type' = 'Wedding'
    and m.meta ->> 'event_date' = '2026-12-10' and m.meta ->> 'event_time' = '18:30'
    and m.meta ->> 'venue' = 'Lotus Lawns (main)' and m.meta ->> 'venue_address' = 'MG Road, Pune'
    and (m.meta ->> 'guests')::int = 200 and (m.meta -> 'layout' ->> 'object_count')::int = 42
    and m.meta -> 'menu' ->> 'package' = 'Royal Veg' and jsonb_array_length(m.meta -> 'menu' -> 'dishes') = 2
    and m.meta -> 'menu' -> 'dishes' -> 0 ->> 'name' = 'Paneer Tikka'
    and m.meta ->> 'notes' = 'Jain food at one counter' and m.meta ->> 'access_notes' = 'Gate 2 for vendors', m.meta::text);
  select string_agg(k, ',') into bad from pg_temp.keys(m.meta) k
   where k ~* '(total|price|amount|advance|paid|balance|gst|discount|budget|subtotal|pricing|coupon)';
  perform pg_temp.res('06 card contains NO money key (total/price/amount/advance/paid/balance/gst/discount/…)', bad is null, bad);
  perform pg_temp.res('07 card contains no money value from the quote (230100 / 900000 / 50000 / 1250 / 950)',
    m.meta::text !~ '(230100|900000|50000|25000|1250|950|200000)', m.meta::text);
end $$;

-- ---- 08-09 no duplicate ----------------------------------------------------------------------
do $$ declare s text := ''; v uuid; begin
  perform pg_temp.login('a_admin@a.test');
  begin v := public.create_event_group('a0000000-0000-4000-8000-0000000e0001', null); exception when others then s := sqlstate; end;
  perform pg_temp.res('08 a second create returns the SAME group (no duplicate)', s = '' and v = pg_temp.getv('conv')::uuid, s||' '||coalesce(v::text,'∅'));
  perform pg_temp.su();
  perform pg_temp.res('09 still exactly one group and one card for the quote',
    (select count(*) from public.chat_conversations where quote_id = 'a0000000-0000-4000-8000-0000000e0001') = 1
    and (select count(*) from public.chat_messages where conversation_id = pg_temp.getv('conv')::uuid) = 1, '');
  s := pg_temp.try($q$insert into public.chat_conversations(org_id, kind, title, quote_id)
         values ('a0000000-0000-4000-8000-000000000001', 'group', 'dup', 'a0000000-0000-4000-8000-0000000e0001')$q$);
  perform pg_temp.res('10 a second group row for the same quote is refused by the unique index (23505)', s = '23505', s);
end $$;

-- ---- 11-15 refusals ------------------------------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.create_event_group('a0000000-0000-4000-8000-0000000e0002', null)$q$);
  perform pg_temp.su();
  perform pg_temp.res('11 unconfirmed quote is refused (22023) and no group is made',
    s = '22023' and not exists (select 1 from public.chat_conversations where quote_id = 'a0000000-0000-4000-8000-0000000e0002'), s);
  perform pg_temp.login('b_staff@b.test');
  s := pg_temp.try($q$select public.create_event_group('a0000000-0000-4000-8000-0000000e0001', null)$q$);
  perform pg_temp.res('12 another studio''s quote is refused (42501)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.create_event_group('b0000000-0000-4000-8000-0000000e0001', null)$q$);
  perform pg_temp.su();
  perform pg_temp.res('13 studio A cannot create a group on studio B''s confirmed quote (42501)',
    s = '42501' and not exists (select 1 from public.chat_conversations where quote_id = 'b0000000-0000-4000-8000-0000000e0001'), s);
  perform pg_temp.login('a_crew@a.test');
  s := pg_temp.try($q$select public.create_event_group('a0000000-0000-4000-8000-0000000e0001', null)$q$);
  perform pg_temp.res('14 a studio member without quotes access is refused (42501)', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.create_event_group('a0000000-0000-4000-8000-0000000e0001', null)$q$);
  perform pg_temp.res('15 anon is refused (42501)', s = '42501', s);
end $$;

-- ---- 16-17 users can't forge an event card ---------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$select public.chat_send(%L::uuid, 'card', 'x', null, null, null, null, '{"kind":"event","total":999999}'::jsonb)$q$, pg_temp.getv('conv')));
  perform pg_temp.res('16 chat_send with an event card is refused (42501)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format($q$insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
         values (%L::uuid, 'a0000000-0000-4000-8000-000000000001', auth.uid(), 'card', 'x', '{"kind":"event","total":1}'::jsonb)$q$, pg_temp.getv('conv')));
  perform pg_temp.res('17 a direct insert of an event card is refused (42501)', s = '42501', s);
end $$;

-- ---- 18-22 @mentions --------------------------------------------------------------------------------
do $$ declare r public.chat_messages; s text := ''; begin
  perform pg_temp.login('a_staff@a.test');
  begin
    r := public.chat_send(pg_temp.getv('conv')::uuid, 'text', '@Asha please check', null, null, null, null,
           jsonb_build_object('mentions', jsonb_build_array(pg_temp.uid('a_admin@a.test'), pg_temp.uid('a_admin@a.test'),
             pg_temp.uid('b_staff@b.test'), pg_temp.uid('a_crew@a.test'), pg_temp.uid('a_staff@a.test'), 'not-a-uuid', 42)));
  exception when others then s := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.setv('m1', r.id::text);
  perform pg_temp.res('18 mentions keep only conversation members (dupes, other studio, non-member, self, junk stripped)',
    s = '' and r.meta -> 'mentions' = jsonb_build_array(pg_temp.uid('a_admin@a.test')::text), s||' '||coalesce(r.meta::text,'∅'));
  perform pg_temp.login('a_staff@a.test');
  r := public.chat_send(pg_temp.getv('conv')::uuid, 'text', 'only outsiders', null, null, null, null,
         jsonb_build_object('mentions', jsonb_build_array(pg_temp.uid('b_admin@b.test'), pg_temp.uid('a_crew@a.test'))));
  perform pg_temp.res('19 a message mentioning only non-members stores no mentions', r.meta is null, coalesce(r.meta::text,'∅'));
  perform pg_temp.login('a_staff@a.test');
  r := public.chat_send(pg_temp.getv('conv')::uuid, 'text', 'bad shape', null, null, null, null, '{"mentions":"everyone"}'::jsonb);
  perform pg_temp.res('20 a non-list mentions value is dropped', r.meta is null, coalesce(r.meta::text,'∅'));
end $$;
do $$ declare n int; n2 int; begin
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.chat_my_mentions(20) where id = pg_temp.getv('m1')::uuid;
  perform public.chat_mark_read(pg_temp.getv('conv')::uuid);
  select count(*) into n2 from public.chat_my_mentions(20);
  perform pg_temp.res('21 chat_my_mentions lists my unread mention, and clears once I read the chat', n = 1 and n2 = 0, n||'/'||n2);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.chat_my_mentions(20);
  perform pg_temp.res('22 another studio sees no mentions', n = 0, n::text);
end $$;
do $$ declare b uuid; r public.chat_messages; begin
  perform pg_temp.login('a_staff@a.test');
  b := public.chat_ensure_broadcast();
  r := public.chat_send(b, 'text', 'all hands', null, null, null, null,
         jsonb_build_object('mentions', jsonb_build_array(pg_temp.uid('a_crew@a.test'), pg_temp.uid('b_staff@b.test'))));
  perform pg_temp.res('23 broadcast: any same-studio person can be mentioned, other studio stripped',
    r.meta -> 'mentions' = jsonb_build_array(pg_temp.uid('a_crew@a.test')::text), coalesce(r.meta::text,'∅'));
  perform pg_temp.login('a_crew@a.test');
  perform pg_temp.res('24 the mentioned crew member gets it in chat_my_mentions',
    exists (select 1 from public.chat_my_mentions(20) where id = r.id), '');
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('25 the author can''t edit mentions into a message afterwards (42501)',
    pg_temp.try(format($q$update public.chat_messages set meta = '{"mentions":["%s"]}'::jsonb where id = %L::uuid$q$,
      pg_temp.uid('a_admin@a.test'), r.id)) = '42501', '');
end $$;

-- ---- 26-31 refresh / index / add members / cancelled / deleted ------------------------------------------
do $$ declare v uuid := pg_temp.getv('conv')::uuid; r uuid; s text := ''; m record; bad text; begin
  perform pg_temp.login('a_staff@a.test');
  r := public.refresh_event_group(v);
  perform pg_temp.res('26 refresh with no change posts nothing', r is null, coalesce(r::text,'∅'));
  perform pg_temp.su();
  update public.event_plan set venue_name = 'Lotus Lawns (garden)' where quote_id = 'a0000000-0000-4000-8000-0000000e0001';
  perform pg_temp.login('a_staff@a.test');
  begin r := public.refresh_event_group(v); exception when others then s := sqlstate||' '||sqlerrm; end;
  perform pg_temp.su();
  select * into m from public.chat_messages where id = r;
  select string_agg(k, ',') into bad from pg_temp.keys(m.meta) k
   where k ~* '(total|price|amount|advance|paid|balance|gst|discount|budget|subtotal|pricing|coupon)';
  perform pg_temp.res('27 refresh after a change posts an updated card (same whitelist, no money)',
    s = '' and m.sender_id is null and m.meta ->> 'venue' = 'Lotus Lawns (garden)' and (m.meta ->> 'refreshed')::boolean and bad is null,
    s||' '||coalesce(bad,''));
  perform pg_temp.login('a_crew@a.test');
  perform pg_temp.res('28 a non-member can''t refresh (42501)', pg_temp.try(format('select public.refresh_event_group(%L::uuid)', v)) = '42501', '');
end $$;
do $$ declare v uuid := pg_temp.getv('conv')::uuid; n int; s text; begin
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.event_group_index() where quote_id = 'a0000000-0000-4000-8000-0000000e0001' and conversation_id = v and is_member;
  perform pg_temp.res('29 event_group_index shows the group to a member of my studio', n = 1, n::text);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.event_group_index() where quote_id = 'a0000000-0000-4000-8000-0000000e0001';
  perform pg_temp.res('30 event_group_index never shows another studio''s group', n = 0, n::text);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('select public.chat_add_members(%L::uuid, array[%L::uuid])', v, pg_temp.uid('a_crew@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('31 a group member adds a studio member later (existing chat_add_members)',
    s = '' and exists (select 1 from public.chat_members where conversation_id = v and user_id = pg_temp.uid('a_crew@a.test')), s);
end $$;
do $$ declare v uuid := pg_temp.getv('conv')::uuid; s text; r uuid; begin perform pg_temp.su();
  update public.quotes set status = 'cancelled' where id = 'a0000000-0000-4000-8000-0000000e0001';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('select public.refresh_event_group(%L::uuid)', v));
  r := public.create_event_group('a0000000-0000-4000-8000-0000000e0001', null);
  perform pg_temp.su();
  perform pg_temp.res('32 cancelled event: group stays, refresh refused (22023), create returns the same group',
    s = '22023' and r = v and exists (select 1 from public.chat_conversations where id = v), s);
  perform pg_temp.login('a_admin@a.test');                       -- the app deletes a quote with a direct API delete
  s := pg_temp.try($q$delete from public.quotes where id = 'a0000000-0000-4000-8000-0000000e0001'$q$);
  perform pg_temp.su();
  perform pg_temp.res('33 deleting the quote (as the app does) keeps the group and its history (link cleared)',
    s = '' and not exists (select 1 from public.quotes where id = 'a0000000-0000-4000-8000-0000000e0001') and exists (select 1 from public.chat_conversations where id = v and quote_id is null)
    and (select count(*) from public.chat_messages where conversation_id = v) >= 2, s);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('34 refresh of an unlinked group is refused (22023)', pg_temp.try(format('select public.refresh_event_group(%L::uuid)', v)) = '22023', '');
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('35 the app can''t link a conversation to a quote directly (42501)',
    pg_temp.try(format($q$update public.chat_conversations set quote_id = 'a0000000-0000-4000-8000-0000000e0002' where id = %L::uuid$q$, v)) = '42501', '');
end $$;

-- ---- 36 grants ------------------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.res('36 grants: signed-in only; internal helpers not callable by API roles',
    not has_function_privilege('anon', 'public.create_event_group(uuid,uuid[])', 'EXECUTE')
    and not has_function_privilege('anon', 'public.refresh_event_group(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.event_group_index()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.chat_my_mentions(integer)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.create_event_group(uuid,uuid[])', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.refresh_event_group(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.event_group_index()', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.chat_my_mentions(integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._event_card(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public._event_card(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.tg_chat_message_meta()', 'EXECUTE'), 'grant drift');
end $$;

-- cleanup (superuser): only what this suite created
do $$ declare c uuid := pg_temp.uid('a_crew@a.test'); begin perform pg_temp.su_as('a_admin@a.test');
  delete from public.chat_conversations where id = pg_temp.getv('conv')::uuid;
  delete from public.chat_messages where conversation_id in (select id from public.chat_conversations where kind = 'broadcast'
                                                              and org_id = 'a0000000-0000-4000-8000-000000000001') and body = 'all hands';
  delete from public.audit_log where action = 'chat.event_group.create';
  delete from public.event_menu_items where quote_id in ('a0000000-0000-4000-8000-0000000e0001');
  delete from public.leads where quote_id in ('a0000000-0000-4000-8000-0000000e0001','a0000000-0000-4000-8000-0000000e0002');
  delete from public.quotes where id in ('a0000000-0000-4000-8000-0000000e0001','a0000000-0000-4000-8000-0000000e0002');
  perform pg_temp.su_as('b_admin@b.test');
  delete from public.leads where quote_id = 'b0000000-0000-4000-8000-0000000e0001';
  delete from public.quotes where id = 'b0000000-0000-4000-8000-0000000e0001';
  perform pg_temp.su();
  delete from public.chat_members where user_id = c;
  delete from public.profiles where id = c;
  delete from auth.users where id = c;
end $$;
select name, result from _eg order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 36 then 'EVENT-GROUPS: ALL PASS (36/36)'
            else 'EVENT-GROUPS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/36 ran' end from _eg;
