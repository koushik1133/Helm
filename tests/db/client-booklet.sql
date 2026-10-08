-- client-booklet.sql -- 0065 client booklet: share/revoke authz, token lifecycle, client-safe payload,
-- RLS, rate limit, audit log, suspended-studio guard. Fixture: a_admin/a_staff(sales) studio A,
-- b_admin/b_staff studio B, quoteA / quoteB. Rolled back. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bk(name text, result text); grant all on _bk to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

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
begin perform pg_temp.su(); insert into _bk values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- fixture extras: priced quote with internal fields, layout, plan, menu, versions, milestones
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid;
begin
  perform pg_temp.su();
  set local session_replication_role = replica;
  update public.quotes set pricing = '{"chairs":100,"chairPrice":200,"guests":120,"platePrice":500,"gstPct":18,"total":118000,
      "catering":{"mode":"inhouse","vendor":"SECRET-VENDOR","amount":0,"gstPct":5},"internalCost":77777,"margin":"SECRET-MARGIN",
      "computed":{"rental":20000,"plateSub":60000,"subtotal":100000,"totalGst":18000,"total":118000}}'::jsonb,
    client = '{"name":"Alice","phone":"+91 98765 00000","email":"alice@private.test","notes":"SECRET-STAFF-NOTE","guests":"120"}'::jsonb,
    event_date = '2026-12-12', deleted_at = null, current_version = 1
   where id = qa;
  update public.organizations set brand = '{"accent":"#aa3355","logo":"https://cdn.example.test/logo.png","phone":"+91 40 1234"}'::jsonb,
    business_email = 'hello@studio-a.test' where id = a;
  delete from public.quote_versions where quote_id = qa;
  insert into public.quote_versions(quote_id, version_no, data, object_count, org_id)
    values (qa, 1, '{"items":[{"id":"i1","type":"stage","category":"structure","label":"Stage","x":10,"y":5,"width":24,"height":12,"rotation":0,"color":"#7c3aed","properties":{"price":99999,"note":"SECRET-ITEM-NOTE"}}],"venue":{"room":{"w":100,"h":60}}}'::jsonb, 1, a);
  delete from public.event_plan where quote_id = qa;
  insert into public.event_plan(quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, menu_template, menu_plate_price, org_id)
    values (qa, 'Grand Hall', '1 Lake Road', 'SECRET-VENUE-CONTACT', 'SECRET-ACCESS-NOTE', 'Gold', 'Veg feast', 'Royal Veg', 650, a);
  delete from public.menu_templates where org_id = a and name = 'Royal Veg';
  insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes) values (a, 'gold', 'veg', 'Royal Veg', 650, '["Paneer","Dal"]');
  delete from public.event_menu_items where quote_id = qa;
  insert into public.event_menu_items(quote_id, dish_name, category, kind, org_id) values (qa, 'Paneer tikka', 'starter', 'veg', a);
  delete from public.quotation_versions where quote_id = qa;
  insert into public.quotation_versions(id, org_id, quote_id, label, pricing, total, created_at) values
    ('a0000000-0000-4000-8000-0000000b0001', a, qa, 'First draft', '{"internalCost":1}', 100000, now() - interval '2 days'),
    ('a0000000-0000-4000-8000-0000000b0002', a, qa, 'Hidden draft', '{}', 110000, now() - interval '1 day'),
    ('a0000000-0000-4000-8000-0000000b0003', a, qa, 'Final', '{}', 118000, now());
  delete from public.payment_milestones where quote_id = qa;
  insert into public.payment_milestones(quote_id, label, due_date, amount, status, note, seq, org_id) values
    (qa, 'Advance', '2026-11-01', 50000, 'paid', 'SECRET-MS-NOTE', 1, a), (qa, 'Balance', '2026-12-10', 68000, 'due', null, 2, a);
  delete from public.client_booklets;
  delete from public.studio_subscriptions where org_id = a;
  delete from public.auth_rate_hits where bucket like 'booklet.%';
  u := coalesce((select id from auth.users where email = 'bk_client@a.test'), auth.seed_user('bk_client@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'bk_client@a.test', 'Client', 'client', a, false, now()) on conflict (id) do update set role = 'client', org_id = a;
  u := coalesce((select id from auth.users where email = 'bk_viewer@a.test'), auth.seed_user('bk_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'bk_viewer@a.test', 'Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  delete from public.role_access where org_id = a and role = 'quality';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'quotes', true, false, a, now());
end $$;

do $$ declare e text; r jsonb; n int; tok text; tok2 text;
  qa text := 'a0000000-0000-4000-8000-00000000da01'; qb text := 'b0000000-0000-4000-8000-00000000da01';
begin
  perform pg_temp.su();
  perform pg_temp.res('01 RLS enabled', (select relrowsecurity from pg_class where oid = 'public.client_booklets'::regclass));
  perform pg_temp.res('02 anon has no table privileges', not has_table_privilege('anon', 'public.client_booklets', 'select'));
  perform pg_temp.res('03 members cannot write the table directly', not has_table_privilege('authenticated', 'public.client_booklets', 'insert')
    and not has_table_privilege('authenticated', 'public.client_booklets', 'update') and not has_table_privilege('authenticated', 'public.client_booklets', 'delete'));
  perform pg_temp.res('04 suspended-studio guard attached', exists (select 1 from pg_trigger where tgrelid = 'public.client_booklets'::regclass and tgname = 'zzz_studio_read_only'));
  perform pg_temp.res('05 public reader callable signed out', has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute'));
  perform pg_temp.res('06 share/revoke/current not callable signed out', not has_function_privilege('anon', 'public.booklet_share(uuid,integer,uuid[],text,text)', 'execute')
    and not has_function_privilege('anon', 'public.booklet_revoke(uuid)', 'execute') and not has_function_privilege('anon', 'public.booklet_current(uuid)', 'execute'));
  perform pg_temp.res('07 internal helper not callable', not has_function_privilege('authenticated', 'public._booklet_staff_quote(uuid,boolean)', 'execute'));

  -- authz on share
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.booklet_share(%L)', qa));
  perform pg_temp.res('08 signed out cannot share', e like '42501%', e);
  perform pg_temp.login('bk_client@a.test');
  e := pg_temp.try(format('select public.booklet_share(%L)', qa));
  perform pg_temp.res('09 client role cannot share', e like '42501%', e);
  perform pg_temp.login('bk_viewer@a.test');
  e := pg_temp.try(format('select public.booklet_share(%L)', qa));
  perform pg_temp.res('10 quotes-view-only role cannot share', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_share(%L)', qa));
  perform pg_temp.res('11 other studio cannot share my event', e like 'P0002%', e);

  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_share(qa::uuid, 10, array['a0000000-0000-4000-8000-0000000b0001','a0000000-0000-4000-8000-0000000b0003','b0000000-0000-4000-8000-0000000b0009']::uuid[], 'Pay 50% up front.', 'Hi Alice!');
  tok := r ->> 'token'; perform pg_temp.put('tok', tok);
  perform pg_temp.res('12 quotes editor shares: token + expiry ~10 days', tok is not null
    and (r ->> 'expires_at')::timestamptz between now() + interval '9 days' and now() + interval '11 days', r::text);
  perform pg_temp.res('13 only this event''s versions kept', jsonb_array_length(r -> 'shared_versions') = 2, r::text);
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_current(qa::uuid);
  perform pg_temp.res('14 current returns the live link', r ->> 'token' = pg_temp.get('tok'), coalesce(r::text, 'null'));
  perform pg_temp.login('bk_viewer@a.test');
  select count(*) into n from public.client_booklets;
  perform pg_temp.res('15 quotes viewer reads studio rows via RLS', n = 1, n::text);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.client_booklets;
  perform pg_temp.res('16 other studio sees no rows', n = 0, n::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_current(%L)', qa));
  perform pg_temp.res('17 other studio cannot read current link', e like 'P0002%', e);

  -- public read: client-safe payload
  perform pg_temp.anon();
  r := public.public_get_booklet(pg_temp.get('tok')::uuid);
  perform pg_temp.res('18 anon reads the booklet', r #>> '{event,code}' = 'A-0001' and r #>> '{studio,name}' = 'Studio A', left(r::text, 300));
  perform pg_temp.res('19 venue + guests + date', r #>> '{event,venue_name}' = 'Grand Hall' and (r #>> '{event,guests}')::numeric = 120
    and r #>> '{event,event_date}' = '2026-12-12', left(r::text, 300));
  perform pg_temp.res('20 studio brand + contact', r #>> '{studio,accent}' = '#aa3355' and r #>> '{studio,logo}' = 'https://cdn.example.test/logo.png'
    and r #>> '{studio,email}' = 'hello@studio-a.test', (r -> 'studio')::text);
  perform pg_temp.res('21 layout shapes present', jsonb_array_length(r #> '{layout,items}') = 1 and r #>> '{layout,items,0,type}' = 'stage'
    and (r #>> '{layout,room,w}')::numeric = 100, (r -> 'layout')::text);
  perform pg_temp.res('22 menu + selected package', r #>> '{menu,items,0,name}' = 'Paneer tikka' and r #>> '{menu,selected_package,name}' = 'Royal Veg'
    and r #>> '{menu,package}' = 'Gold', (r -> 'menu')::text);
  perform pg_temp.res('23 quote totals', (r #>> '{quote,total}')::numeric = 118000 and (r #>> '{quote,computed,subtotal}')::numeric = 100000, (r -> 'quote')::text);
  perform pg_temp.res('24 only shared versions, latest flagged', jsonb_array_length(r -> 'versions') = 2
    and r #>> '{versions,0,label}' = 'Final' and (r #>> '{versions,0,latest}')::boolean and not (r #>> '{versions,1,latest}')::boolean
    and r::text not like '%Hidden draft%', (r -> 'versions')::text);
  perform pg_temp.res('25 payments summary', (r #>> '{payments,paid}')::numeric = 50000 and (r #>> '{payments,outstanding}')::numeric = 68000
    and jsonb_array_length(r #> '{payments,milestones}') = 2, (r -> 'payments')::text);
  perform pg_temp.res('26 terms + note', r ->> 'terms' = 'Pay 50% up front.' and r ->> 'note' = 'Hi Alice!', '');
  perform pg_temp.res('27 NO internal fields leak', r::text not like '%SECRET%' and r::text not like '%77777%' and r::text not like '%99999%'
    and r::text not like '%alice@private.test%' and r::text not like '%98765%' and r::text not like '%internalCost%', r::text);
  perform pg_temp.res('28 no other studio data', r::text not like '%Studio B%' and r::text not like '%B-0001%', '');

  perform pg_temp.anon();
  e := pg_temp.try('select public.public_get_booklet(''00000000-0000-4000-8000-000000000000'')');
  perform pg_temp.res('29 unknown token = invalid link', e like 'P0001%invalid link%', e);
  perform pg_temp.anon();
  e := pg_temp.try('select public.public_get_booklet(null)');
  perform pg_temp.res('30 null token = invalid link', e like 'P0001%invalid link%', e);

  perform pg_temp.su();
  select count(*) into n from public.audit_log where action = 'booklet.view' and quote_id = qa::uuid;
  perform pg_temp.res('31 read logged once per hour', n = 1, n::text);
  select count(*) into n from public.audit_log where action = 'booklet.share' and quote_id = qa::uuid;
  perform pg_temp.res('32 share logged', n = 1, n::text);

  -- re-share revokes the old link
  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid, 9999, null, null, null);
  tok2 := r ->> 'token'; perform pg_temp.put('tok2', tok2);
  perform pg_temp.res('33 days clamped to 365; null versions = all 3', (r ->> 'expires_at')::timestamptz < now() + interval '366 days'
    and jsonb_array_length(r -> 'shared_versions') = 3, r::text);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_booklet(%L)', pg_temp.get('tok')));
  perform pg_temp.res('34 old link dead after re-share', e like 'P0001%invalid link%', e);
  perform pg_temp.su();
  select count(*) into n from public.client_booklets where quote_id = qa::uuid and revoked_at is null;
  perform pg_temp.res('35 one live link per event', n = 1, n::text);

  -- expiry
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.client_booklets set expires_at = now() - interval '1 minute' where token = pg_temp.get('tok2')::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_booklet(%L)', pg_temp.get('tok2')));
  perform pg_temp.res('36 expired link = invalid link', e like 'P0001%invalid link%', e);
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.client_booklets set expires_at = now() + interval '1 day' where token = pg_temp.get('tok2')::uuid;
  set local session_replication_role = origin;

  -- revoke
  perform pg_temp.login('bk_viewer@a.test');
  e := pg_temp.try(format('select public.booklet_revoke(%L)', qa));
  perform pg_temp.res('37 view-only role cannot revoke', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.booklet_revoke(%L)', qa));
  perform pg_temp.res('38 other studio cannot revoke', e like 'P0002%', e);
  perform pg_temp.login('a_staff@a.test');
  n := public.booklet_revoke(qa::uuid);
  perform pg_temp.res('39 editor revokes', n = 1, n::text);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_booklet(%L)', pg_temp.get('tok2')));
  perform pg_temp.res('40 revoked link = invalid link', e like 'P0001%invalid link%', e);
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('41 no current link after revoke', public.booklet_current(qa::uuid) is null, '');

  -- deleted event
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_share(qa::uuid); perform pg_temp.put('tok3', r ->> 'token');
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = now() where id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_booklet(%L)', pg_temp.get('tok3')));
  perform pg_temp.res('42 deleted event = invalid link', e like 'P0001%invalid link%', e);
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa::uuid;
  set local session_replication_role = origin;

  -- rate limit
  perform pg_temp.su();
  update public.auth_rate_hits set n = 500 where bucket = 'booklet.read';
  insert into public.auth_rate_hits(bucket, key, window_start, n) values ('booklet.read', md5('booklet:' || pg_temp.get('tok3')), now(), 500)
    on conflict (bucket, key) do update set n = 500, window_start = now();
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_booklet(%L)', pg_temp.get('tok3')));
  perform pg_temp.res('43 reads are rate-limited per token', e like 'P0001%too many%', e);

  -- suspended studio: sharing is refused
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values ('a0000000-0000-4000-8000-000000000001', 'suspended');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.booklet_share(%L)', qa));
  perform pg_temp.res('44 suspended studio cannot share', e <> '', e);
end $$;

select name, result from _bk order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'CLIENT-BOOKLET: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'CLIENT-BOOKLET: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bk;
rollback;
