-- event-group-people-0194.sql -- 0194: "Add people" to an event group adds teammates (chat members),
-- login-linked staff (chat members), other staff / vendors / the client (contacts, name only); names come
-- from the studio's rows, another studio's rows are skipped, non-members / other studios / anon refused,
-- contacts are readable only by the group, never written directly, removal keeps the row, nothing is
-- sent. Also the Confirm & lock pricing case (coupon + % discount) from the server authority.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
\ir ../../supabase/migrations/0194_event_group_people.sql
create temp table _gp(name text, result text); grant all on _gp to anon, authenticated, service_role;
create temp table _gpv(k text primary key, v text); grant all on _gpv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _gp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
create or replace function pg_temp.setv(p_k text, p_v text) returns void language sql security definer as $$
  insert into _gpv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.getv(p_k text) returns text language sql security definer as $$ select v from _gpv where k = p_k $$;
grant execute on function pg_temp.res(text,boolean,text), pg_temp.try(text), pg_temp.uid(text), pg_temp.setv(text,text), pg_temp.getv(text) to anon, authenticated, service_role;

-- ---- setup (superuser): a confirmed event in studio A, 2 crew (1 linked to a_staff), 1 vendor in A, 1 in B,
--      a 3rd studio-A user (a_other) who is NOT in the group
do $$ declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001'; o uuid;
begin perform pg_temp.su();
  select id into o from auth.users where email = 'a_other@a.test';
  if o is null then o := auth.seed_user('a_other@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (o, 'a_other@a.test', 'sales', orgA, false, now()) on conflict (id) do update set role = 'sales', org_id = orgA;
  insert into public.quotes(id, code, title, event_type, status, client, pricing, current_version, org_id, event_date, created_at, updated_at)
    values ('a0000000-0000-4000-8000-0000000e0194', '10182026-94', 'Uma reception', 'Reception', 'confirmed',
            '{"name":"Uma Rao","phone":"+91 98480 00000"}'::jsonb, '{"subtotal":1000,"discount":0,"gstPct":18,"total":1180}'::jsonb,
            1, orgA, '2026-12-20', now(), now())
    on conflict (id) do update set status = 'confirmed', client = excluded.client;
  insert into public.crew_members(id, name, phone, org_id, active, profile_id) values
    ('a0000000-0000-4000-8000-00000c194001', 'Ravi Decor Lead', '+91 90000 00001', orgA, true, null),
    ('a0000000-0000-4000-8000-00000c194002', 'Sales Staff Login', '+91 90000 00002', orgA, true, pg_temp.uid('a_staff@a.test')),
    ('a0000000-0000-4000-8000-00000c194003', 'Old Helper', '+91 90000 00003', orgA, false, null)
    on conflict (id) do nothing;
  insert into public.vendors(id, name, category, phone, org_id, active) values
    ('a0000000-0000-4000-8000-00000f194001', 'Lotus Caterers', 'Catering', '+91 90000 00009', orgA, true),
    ('b0000000-0000-4000-8000-00000f194001', 'Studio B Florist', 'Flowers', '+91 90000 00010', orgB, true)
    on conflict (id) do nothing;
end $$;

-- the owner (a_admin) creates the event group with nobody else ticked
do $$ declare v uuid; begin perform pg_temp.login('a_admin@a.test');
  v := public.create_event_group('a0000000-0000-4000-8000-0000000e0194', null); perform pg_temp.setv('conv', v::text);
  perform pg_temp.res('01 group created', v is not null);
end $$;

-- ---- 02-08 add people: user, staff (plain + login-linked), vendor, client; junk + other studio skipped
do $$ declare r jsonb; conv uuid; begin perform pg_temp.login('a_admin@a.test'); conv := pg_temp.getv('conv')::uuid;
  r := public.event_group_add_people(conv, jsonb_build_array(
    jsonb_build_object('kind','user','id',pg_temp.uid('a_other@a.test')),
    jsonb_build_object('kind','staff','id','a0000000-0000-4000-8000-00000c194001'),
    jsonb_build_object('kind','staff','id','a0000000-0000-4000-8000-00000c194002'),
    jsonb_build_object('kind','staff','id','a0000000-0000-4000-8000-00000c194003'),
    jsonb_build_object('kind','vendor','id','a0000000-0000-4000-8000-00000f194001'),
    jsonb_build_object('kind','vendor','id','b0000000-0000-4000-8000-00000f194001'),
    jsonb_build_object('kind','client'),
    jsonb_build_object('kind','user','id',pg_temp.uid('b_admin@b.test')),
    jsonb_build_object('kind','staff','id','not-a-uuid','name','Injected'),
    '"junk"'::jsonb));
  perform pg_temp.setv('r1', r::text);
  perform pg_temp.res('02 two chat members added (teammate + login-linked staff)', (r->>'users')::int = 2, r::text);
  perform pg_temp.res('03 three contacts added (staff, vendor, client)', (r->>'contacts')::int = 3, r::text);
  perform pg_temp.res('04 inactive staff / other studio / junk skipped', (r->>'skipped')::int = 5, r::text);
  perform pg_temp.res('05 nothing sent', (r->>'messages_sent')::int = 0 and (r ? 'trial'), r::text);
end $$;
do $$ declare conv uuid := pg_temp.getv('conv')::uuid; begin perform pg_temp.su();
  perform pg_temp.res('06 teammate + a_staff are chat members',
    (select count(*) from public.chat_members m where m.conversation_id = conv
       and m.user_id in (pg_temp.uid('a_other@a.test'), pg_temp.uid('a_staff@a.test'))) = 2);
  perform pg_temp.res('07 contact names come from the studio rows (no phone kept)',
    (select string_agg(kind||':'||name, ',' order by kind) from public.chat_group_contacts where conversation_id = conv)
      = 'client:Uma Rao,staff:Ravi Decor Lead,vendor:Lotus Caterers'
    and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_group_contacts'
                     and column_name in ('phone','email')));
  perform pg_temp.res('08 other studio user / vendor never added',
    not exists (select 1 from public.chat_members m where m.conversation_id = conv and m.user_id = pg_temp.uid('b_admin@b.test'))
    and not exists (select 1 from public.chat_group_contacts g where g.conversation_id = conv and g.ref_id = 'b0000000-0000-4000-8000-00000f194001'));
  perform pg_temp.res('09 audit row written', exists (select 1 from public.audit_log where action = 'chat.event_group.add_people'
    and entity_id = conv::text));
end $$;

-- ---- 10 adding the same people again is a no-op
do $$ declare r jsonb; conv uuid; begin perform pg_temp.login('a_admin@a.test'); conv := pg_temp.getv('conv')::uuid;
  r := public.event_group_add_people(conv, jsonb_build_array(jsonb_build_object('kind','client'),
         jsonb_build_object('kind','vendor','id','a0000000-0000-4000-8000-00000f194001')));
  perform pg_temp.res('10 re-add is idempotent', (r->>'users')::int = 0 and (r->>'contacts')::int = 0, r::text);
end $$;

-- ---- 11-13 RLS: a member (a_staff) reads the contacts; a non-member of studio A reads none; B reads none
do $$ declare conv uuid := pg_temp.getv('conv')::uuid; n int; begin
  perform pg_temp.login('a_staff@a.test'); select count(*) into n from public.chat_group_contacts where conversation_id = conv;
  perform pg_temp.res('11 group member sees the 3 contacts', n = 3, n::text);
  perform pg_temp.su(); delete from public.chat_members where conversation_id = conv and user_id = pg_temp.uid('a_other@a.test');
  perform pg_temp.login('a_other@a.test'); select count(*) into n from public.chat_group_contacts;
  perform pg_temp.res('12 non-member of the group sees none', n = 0, n::text);
  perform pg_temp.login('b_admin@b.test'); select count(*) into n from public.chat_group_contacts;
  perform pg_temp.res('13 other studio sees none', n = 0, n::text);
end $$;

-- ---- 14-17 refusals: non-member, other studio, anon, direct writes
do $$ declare conv uuid := pg_temp.getv('conv')::uuid; s text; begin
  perform pg_temp.login('a_other@a.test');
  s := pg_temp.try(format('select public.event_group_add_people(%L, %L::jsonb)', conv, '[{"kind":"client"}]'));
  perform pg_temp.res('14 non-member refused', s = '42501', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try(format('select public.event_group_add_people(%L, %L::jsonb)', conv, '[{"kind":"client"}]'));
  perform pg_temp.res('15 other studio refused', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try(format('select public.event_group_add_people(%L, %L::jsonb)', conv, '[{"kind":"client"}]'));
  perform pg_temp.res('16 anon refused', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('insert into public.chat_group_contacts(conversation_id, kind, ref_key, name) values (%L, %L, %L, %L)', conv, 'client', 'x', 'Forged'));
  perform pg_temp.res('17 no direct insert / update / delete', s = '42501'
    and pg_temp.try(format('update public.chat_group_contacts set name = %L where conversation_id = %L', 'X', conv)) = '42501'
    and pg_temp.try(format('delete from public.chat_group_contacts where conversation_id = %L', conv)) = '42501', s);
end $$;

-- ---- 18-19 not an event group / too many
do $$ declare s text; g uuid; begin perform pg_temp.login('a_admin@a.test');
  g := public.chat_create_group('Plain group', array[]::uuid[]);
  s := pg_temp.try(format('select public.event_group_add_people(%L, %L::jsonb)', g, '[{"kind":"client"}]'));
  perform pg_temp.res('18 plain group refused (22023)', s = '22023', s);
  s := pg_temp.try(format('select public.event_group_add_people(%L, (select jsonb_agg(jsonb_build_object(''kind'',''client'')) from generate_series(1,201)))', pg_temp.getv('conv')));
  perform pg_temp.res('19 more than 200 refused', s = '22023', s);
end $$;

-- ---- 20-21 remove keeps the row, re-add restores
do $$ declare conv uuid := pg_temp.getv('conv')::uuid; cid uuid; ok boolean; r jsonb; begin perform pg_temp.login('a_admin@a.test');
  select id into cid from public.chat_group_contacts where conversation_id = conv and kind = 'vendor';
  ok := public.event_group_remove_contact(conv, cid);
  perform pg_temp.su();
  perform pg_temp.res('20 remove marks removed_at, row kept', ok and exists (select 1 from public.chat_group_contacts where id = cid and removed_at is not null));
  perform pg_temp.login('a_admin@a.test');
  r := public.event_group_add_people(conv, jsonb_build_array(jsonb_build_object('kind','vendor','id','a0000000-0000-4000-8000-00000f194001')));
  perform pg_temp.su();
  perform pg_temp.res('21 re-add restores the same row', (r->>'contacts')::int = 1
    and exists (select 1 from public.chat_group_contacts where id = cid and removed_at is null), r::text);
end $$;

-- ---- 22 grants
do $$ begin perform pg_temp.su();
  perform pg_temp.res('22 grants: signed-in only', has_function_privilege('authenticated', 'public.event_group_add_people(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.event_group_add_people(uuid,jsonb)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.event_group_remove_contact(uuid,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.event_group_remove_contact(uuid,uuid)', 'EXECUTE')
    and not has_table_privilege('anon', 'public.chat_group_contacts', 'SELECT')
    and not has_table_privilege('authenticated', 'public.chat_group_contacts', 'INSERT'));
end $$;

-- ---- 23 Confirm & lock pricing (confirm-1018 #1): Rs 1,000 coupon AND 5% both off the subtotal, GST after
do $$ declare t numeric; begin perform pg_temp.su();
  t := public.helm_quote_total('{"chairs":42000,"chairPrice":150,"other":110000,"guests":60000,"platePrice":450,
         "catering":{"mode":"inhouse","amount":0},"couponCode":"DEMO WELCOME BACK","coupon":{"kind":"flat","value":1000},
         "discount":0,"discountPct":5,"gstPct":18,"total":1}'::jsonb);
  -- subtotal 33,410,000 - (1,000 + 1,670,500) = 31,738,500 taxable; + 18% = 37,451,430
  perform pg_temp.res('23 server total = coupon + % off the subtotal, then GST', t = 37451430, t::text);
end $$;

select name, result from _gp order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 23 then 'EVENT-GROUP-PEOPLE-0194: ALL PASS (23/23)'
            else 'EVENT-GROUP-PEOPLE-0194: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/23 ran' end from _gp;
rollback;
