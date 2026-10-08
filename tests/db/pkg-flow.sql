-- pkg-flow.sql -- 0069 package selection from the booklet + review (maker-checker), pricing
-- authority, re-approval, cancelled links, credit / manual refund, notifications + mutes,
-- OTP, rate limits, locks, suspended studio, share checklist sections, snapshot uploads.
-- Fixture: a_admin (only admin) / a_staff (sales) studio A, b_admin studio B. Rolled back. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bk(name text, result text); grant all on _bk to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); perform set_config('request.jwt.claims', '', true); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('request.jwt.claims', current_setting('request.jwt.claims'), true);  -- the RPC under test restores claims with set local
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('request.jwt.claims', '{"role":"anon"}', true); perform set_config('role', 'anon', false); end $$;
-- res() records a result and keeps the caller's identity (claims + role)
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin
  perform pg_temp.su(); insert into _bk values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  perform set_config('request.jwt.claims', coalesce(c, ''), false); perform set_config('request.jwt.claims', coalesce(c, ''), true);
  if r in ('anon', 'authenticated') then perform set_config('role', r, false); end if;
end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; a uuid := 'a0000000-0000-4000-8000-000000000001';
  b uuid := 'b0000000-0000-4000-8000-000000000001'; u uuid;
begin
  perform pg_temp.su();
  set local session_replication_role = replica;
  update public.quotes set pricing = '{"chairs":100,"chairPrice":50,"guests":100,"platePrice":300,"gstPct":18,"total":41300}'::jsonb,
    client = '{"name":"Alice","phone":"+91 98765 00000","email":"alice@client.test"}'::jsonb, event_date = current_date + 60,
    deleted_at = null, archived_at = null, confirmed_at = null, status = 'quote', lifecycle_stage = 'quote', approval_status = 'sent',
    consent_stale = false where id = qa;
  delete from public.quote_consents where quote_id = qa;
  delete from public.quote_payments where quote_id = qa;
  delete from public.payment_milestones where quote_id = qa;
  delete from public.event_closure where quote_id = qa;
  delete from public.event_plan where quote_id = qa;
  insert into public.event_plan(quote_id, org_id) values (qa, a);
  delete from public.package_selections; delete from public.pkg_credits; delete from public.pkg_outbox; delete from public.pkg_otps; delete from public.pkg_settings;
  delete from public.menu_templates where org_id in (a, b);
  insert into public.menu_templates(id, org_id, tier, diet, name, price_per_plate, dishes, active, seq, description, min_guests, max_guests) values
    ('a0000000-0000-4000-8000-0000000c0001', a, 'gold', 'veg', 'Gold Veg', 500, '["Paneer","Dal"]', true, 1, 'Our gold menu', 50, 300),
    ('a0000000-0000-4000-8000-0000000c0002', a, 'standard', 'veg', 'Old Basic', 200, '[]', false, 2, null, null, null),
    ('b0000000-0000-4000-8000-0000000c0001', b, 'gold', 'veg', 'B Gold', 100, '[]', true, 1, null, null, null);
  delete from public.client_booklets;
  delete from public.studio_subscriptions where org_id = a;
  delete from public.auth_rate_hits where bucket like 'pkg.%' or bucket like 'booklet.%';
  delete from public.notification_mutes where org_id = a;
  delete from storage.objects where bucket_id = 'booklet-snapshots';
  u := coalesce((select id from auth.users where email = 'pk_viewer@a.test'), auth.seed_user('pk_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'pk_viewer@a.test', 'Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  u := coalesce((select id from auth.users where email = 'pk_crew@a.test'), auth.seed_user('pk_crew@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'pk_crew@a.test', 'Crew', 'crew', a, false, now()) on conflict (id) do update set role = 'crew', org_id = a;
  delete from public.role_access where org_id = a and (role in ('quality', 'crew') or area in ('pkg_review', 'pkg_payments'));
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('quality', 'pkg_review', true, false, a, now()), ('sales', 'pkg_review', true, true, a, now());
  delete from public.member_profiles where user_id in (pg_temp.uid('a_admin@a.test'), pg_temp.uid('a_staff@a.test'), pg_temp.uid('pk_crew@a.test'));
  insert into public.member_profiles(user_id, whatsapp) values
    (pg_temp.uid('a_admin@a.test'), '+919848011111'), (pg_temp.uid('a_staff@a.test'), '+919848022222'), (pg_temp.uid('pk_crew@a.test'), '+919848033333');
  set local session_replication_role = origin;
  insert into public.notification_mutes(user_id, org_id, type) values (pg_temp.uid('a_staff@a.test'), a, 'pkg_selected');
end $$;

do $$ declare e text; r jsonb; n int; tok text; v numeric; s1 text; s2 text; t text;
  qa text := 'a0000000-0000-4000-8000-00000000da01'; pk text := 'a0000000-0000-4000-8000-0000000c0001';
  a uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  perform pg_temp.res('01 RLS on all new tables', (select bool_and(relrowsecurity) from pg_class where oid in
    ('public.package_selections'::regclass, 'public.pkg_settings'::regclass, 'public.pkg_credits'::regclass, 'public.pkg_otps'::regclass, 'public.pkg_outbox'::regclass)));
  perform pg_temp.res('02 anon has no table privileges', not has_table_privilege('anon', 'public.package_selections', 'select')
    and not has_table_privilege('anon', 'public.pkg_outbox', 'select'));
  perform pg_temp.res('03 no direct writes for members', not has_table_privilege('authenticated', 'public.package_selections', 'insert')
    and not has_table_privilege('authenticated', 'public.package_selections', 'update') and not has_table_privilege('authenticated', 'public.pkg_outbox', 'select'));
  perform pg_temp.res('04 suspended-studio guard on every new table', (select count(*) = 5 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid in
    ('public.package_selections'::regclass, 'public.pkg_settings'::regclass, 'public.pkg_credits'::regclass, 'public.pkg_otps'::regclass, 'public.pkg_outbox'::regclass)));
  perform pg_temp.res('05 public RPCs callable signed out', has_function_privilege('anon', 'public.public_booklet_packages(uuid)', 'execute')
    and has_function_privilege('anon', 'public.public_booklet_choose(uuid,uuid,integer,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_booklet_otp_request(uuid)', 'execute'));
  perform pg_temp.res('06 staff RPCs not for anon; outbox service-only', not has_function_privilege('anon', 'public.pkg_selection_review(uuid,text,numeric,text)', 'execute')
    and not has_function_privilege('anon', 'public.pkg_settings_set(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.pkg_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.booklet_snapshot_path(uuid,text)', 'execute'));
  perform pg_temp.res('07 catalog has the 4 package types', (select count(*) = 4 from jsonb_array_elements(public.notification_catalog()) c
    where c ->> 'type' in ('pkg_selected', 'pkg_accepted', 'pkg_declined', 'pkg_payment')));

  perform pg_temp.login('a_admin@a.test');
  r := public.booklet_share(qa::uuid);
  tok := r ->> 'token'; perform pg_temp.put('tok', tok);
  perform pg_temp.su();
  perform pg_temp.res('08 old 5-arg share works, all sections on', (select sections = public._bk_sections_all() from public.client_booklets where token = tok::uuid), r::text);

  perform pg_temp.anon();
  e := pg_temp.try('select public.public_booklet_packages(''00000000-0000-4000-8000-000000000000'')');
  perform pg_temp.res('09 unknown token = invalid link', e like 'P0001%invalid link%', e);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', '00000000-0000-4000-8000-000000000000', pk));
  perform pg_temp.res('10 choose with unknown token = invalid link', e like 'P0001%invalid link%', e);

  r := public.public_booklet_packages(tok::uuid);
  perform pg_temp.res('11 only active own-studio packages, choose mode', jsonb_array_length(r -> 'packages') = 1
    and r #>> '{packages,0,name}' = 'Gold Veg' and r ->> 'mode' = 'choose' and not (r ->> 'locked')::boolean
    and not (r ->> 'require_otp')::boolean and r -> 'current_selection' = 'null'::jsonb
    and (r #>> '{totals,total}')::numeric = 41300 and (r #>> '{packages,0,min_guests}')::int = 50, r::text);

  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, 'b0000000-0000-4000-8000-0000000c0001'));
  perform pg_temp.res('12 other studio''s package refused', e like 'P0001%not available%', e);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, 'a0000000-0000-4000-8000-0000000c0002'));
  perform pg_temp.res('13 deactivated package refused', e like 'P0001%not available%', e);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 10, null)', tok, pk));
  perform pg_temp.res('14 guests below minimum refused', e like 'P0001%between 50 and 300%', e);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 301, null)', tok, pk));
  perform pg_temp.res('15 guests above maximum refused', e like 'P0001%between%', e);

  r := public.public_booklet_choose(tok::uuid, pk::uuid, 100, 'veg only please');
  perform pg_temp.res('16 choose -> pending', (r ->> 'ok')::boolean and r ->> 'status' = 'pending', r::text);
  perform pg_temp.su();
  select draft_total into v from public.package_selections where quote_id = qa::uuid and status = 'pending';
  perform pg_temp.res('17 draft priced by the server authority', v = public.helm_quote_total('{"chairs":100,"chairPrice":50,"guests":100,"platePrice":500,"gstPct":18}'::jsonb) and v = 64900, coalesce(v::text, 'null'));
  perform pg_temp.res('18 draft version saved', exists (select 1 from public.quotation_versions qv join public.package_selections s on s.draft_version_id = qv.id
    where s.quote_id = qa::uuid and s.status = 'pending' and qv.total = 64900));
  perform pg_temp.res('19 bell row pkg_selected with ids', exists (select 1 from public.notifications where quote_id = qa::uuid and kind = 'pkg_selected'
    and detail ? 'selection_id' and detail ->> 'path' like 'event.html?id=%'));
  perform pg_temp.res('20 bell: crew (no area) does not see it, viewer does',
    'pkg_selected' = any(public._notify_hidden_types(a, pg_temp.uid('pk_crew@a.test')))
    and not ('pkg_selected' = any(public._notify_hidden_types(a, pg_temp.uid('pk_viewer@a.test')))), '');
  perform pg_temp.res('21 staff WhatsApp: admin only (sales muted, crew not permitted)',
    (select count(*) from public.pkg_outbox where kind = 'pkg_selected' and audience = 'staff') = 1
    and exists (select 1 from public.pkg_outbox where kind = 'pkg_selected' and user_id = pg_temp.uid('a_admin@a.test')),
    (select string_agg(coalesce(user_id::text, '-'), ',') from public.pkg_outbox where kind = 'pkg_selected'));
  perform pg_temp.res('22 choose audited with no client prices', exists (select 1 from public.audit_log where action = 'pkg.choose' and quote_id = qa::uuid));

  perform pg_temp.anon();
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 120, null);
  perform pg_temp.su();
  perform pg_temp.res('23 new choice supersedes the pending one', (select count(*) from public.package_selections where quote_id = qa::uuid and status = 'pending') = 1
    and (select count(*) from public.package_selections where quote_id = qa::uuid and status = 'superseded') = 1, '');
  select id::text into s2 from public.package_selections where quote_id = qa::uuid and status = 'pending';
  select id::text into s1 from public.package_selections where quote_id = qa::uuid and status = 'superseded';
  perform pg_temp.put('s2', s2);

  -- staff list + authz
  perform pg_temp.login('pk_viewer@a.test');
  r := public.pkg_selection_list(qa::uuid);
  perform pg_temp.res('24 viewer lists selections', jsonb_array_length(r) = 2 and not (r -> 0 ->> 'can_review')::boolean, left(r::text, 300));
  perform pg_temp.login('pk_crew@a.test');
  e := pg_temp.try('select public.pkg_selection_list()');
  perform pg_temp.res('25 role without pkg_review refused', e like '42501%', e);
  perform pg_temp.login('b_admin@b.test');
  r := public.pkg_selection_list();
  perform pg_temp.res('26 other studio sees none', jsonb_array_length(r) = 0, r::text);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''accept'')', s2));
  perform pg_temp.res('27 other studio cannot review', e like 'P0002%', e);
  perform pg_temp.login('pk_viewer@a.test');
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''accept'')', s2));
  perform pg_temp.res('28 view-only cannot review', e like '42501%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''decline'', null, ''  '')', s2));
  perform pg_temp.res('29 decline needs a reason', e like '22023%reason%', e);
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''accept'')', s1));
  perform pg_temp.res('30 superseded selection cannot be reviewed', e like '22023%superseded%', e);

  -- maker-checker
  perform pg_temp.login('a_staff@a.test');
  r := public.pkg_selection_review(s2::uuid, 'accept', 450, null);
  perform pg_temp.res('31 adjusting a draft keeps it pending for a checker', r ->> 'status' = 'pending' and (r ->> 'needs_checker')::boolean
    and r ->> 'approve_url' is null and r ->> 'version_id' is not null, r::text);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''accept'')', s2));
  perform pg_temp.res('32 maker cannot approve own adjusted draft', e like '42501%someone else%', e);

  -- prior approval + advance paid + an open link
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set approval_status = 'approved' where id = qa::uuid;
  insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, quote_total, org_id)
    values (qa::uuid, '+919876500000', 'Alice', true, true, 41300, a);
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, paid_at) values (qa::uuid, a, 'manual', 20000, 'paid', true, now());
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated) values (qa::uuid, a, 'razorpay', 21300, 'created', false);
  set local session_replication_role = origin;

  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_selection_review(s2::uuid, 'accept');
  perform pg_temp.put('url1', r ->> 'approve_url');
  perform pg_temp.res('33 checker accepts: approve link returned', r ->> 'status' = 'accepted' and r ->> 'approve_url' like '/approve?token=%', r::text);
  perform pg_temp.su();
  select (pricing ->> 'total')::numeric into v from public.quotes where id = qa::uuid;
  perform pg_temp.res('34 event total = adjusted server total', v = 69620 and (r ->> 'total')::numeric = 69620, coalesce(v::text, 'null'));
  perform pg_temp.res('35 re-approval required (client approved before)', (select consent_stale and approval_status = 'sent' from public.quotes where id = qa::uuid)
    and (r ->> 'reapproval_required')::boolean, r::text);
  perform pg_temp.res('36 old unpaid link cancelled, paid one kept', (select count(*) from public.quote_payments where quote_id = qa::uuid and status = 'cancelled') = 1
    and (select count(*) from public.quote_payments where quote_id = qa::uuid and status = 'paid') = 1 and (r ->> 'cancelled_links')::int = 1, '');
  perform pg_temp.res('37 approval link rotated + live', (select approval_token::text = substr(pg_temp.get('url1'), 16) and approval_token_revoked_at is null
    and approval_token_expires_at > now() from public.quotes where id = qa::uuid), pg_temp.get('url1'));
  perform pg_temp.res('38 client e-mail queued with the approve link', exists (select 1 from public.pkg_outbox where audience = 'client' and kind = 'pkg_accepted'
    and channel = 'email' and recipient = 'alice@client.test' and payload ->> 'approve_url' = pg_temp.get('url1') and status = 'pending'), '');
  perform pg_temp.res('39 bell pkg_accepted + audit pkg.accept + pkg.adjust', exists (select 1 from public.notifications where quote_id = qa::uuid and kind = 'pkg_accepted')
    and exists (select 1 from public.audit_log where action = 'pkg.accept' and entity_id = s2) and exists (select 1 from public.audit_log where action = 'pkg.adjust' and entity_id = s2), '');
  perform pg_temp.res('40 no self-approve override logged for a checker', not exists (select 1 from public.audit_log where action = 'pkg.self_approve_override' and entity_id = s2), '');

  perform pg_temp.anon();
  r := public.public_booklet_packages(tok::uuid);
  perform pg_temp.res('41 advance credited: balance = total - paid', (r #>> '{totals,paid}')::numeric = 20000 and (r #>> '{totals,balance}')::numeric = 49620
    and r #>> '{current_selection,status}' = 'accepted' and r #>> '{quote_ready,approve_url}' = pg_temp.get('url1'), r::text);
  perform pg_temp.res('42 selected package -> selected mode, only that package, locked', r ->> 'mode' = 'selected' and jsonb_array_length(r -> 'packages') = 1
    and (r ->> 'locked')::boolean, r::text);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('43 no chooser once a package is selected', e like 'P0001%closed%selected%', e);
  r := public.public_get_booklet(tok::uuid);
  perform pg_temp.res('44 booklet menu.mode = selected with that package', r #>> '{menu,mode}' = 'selected' and r #>> '{menu,selected_package,name}' = 'Gold Veg', (r -> 'menu')::text);

  -- payment received -> pkg_payment to pkg_payments viewers
  perform pg_temp.su();
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, paid_at) values (qa::uuid, a, 'manual', 1000, 'paid', true, now());
  perform pg_temp.res('45 payment received -> pkg_payment bell row', exists (select 1 from public.notifications where quote_id = qa::uuid and kind = 'pkg_payment'
    and detail ->> 'path' like 'settlement.html?quote=%'), '');
  perform pg_temp.res('46 pkg_payment hidden for a role without pkg_payments', 'pkg_payment' = any(public._notify_hidden_types(a, pg_temp.uid('pk_viewer@a.test'))), '');

  -- overpay: credit (default) - client paid more than the new package total
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.package_selections set status = 'cancelled' where id = s2::uuid;
  update public.event_plan set menu_template = null where quote_id = qa::uuid;
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, simulated, paid_at) values (qa::uuid, a, 'manual', 59000, 'paid', true, now());
  delete from public.auth_rate_hits where bucket like 'pkg.%';
  set local session_replication_role = origin;
  perform pg_temp.anon();
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 50, null);
  perform pg_temp.su(); select id::text into t from public.package_selections where quote_id = qa::uuid and status = 'pending';
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_selection_review(t::uuid, 'accept');
  perform pg_temp.su();
  perform pg_temp.res('47 new total below paid -> credit recorded (no refund)', r #>> '{credit,mode}' = 'credit' and (r #>> '{credit,amount}')::numeric = 80000 - 35400
    and exists (select 1 from public.pkg_credits where quote_id = qa::uuid and kind = 'credit' and amount = 44600 and status = 'open')
    and (select (pricing ->> 'total')::numeric from public.quotes where id = qa::uuid) = 35400, r::text);
  perform pg_temp.res('48 nothing refunded automatically', not exists (select 1 from public.quote_payments where quote_id = qa::uuid and status = 'refunded'), '');

  -- settings
  perform pg_temp.login('pk_viewer@a.test');
  e := pg_temp.try('select public.pkg_settings_set(''{"overpay_mode":"manual_refund"}'')');
  perform pg_temp.res('49 settings need controls edit / admin', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.pkg_settings_set(''{"bogus":1}'')');
  perform pg_temp.res('50 unknown setting refused', e like '22023%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.pkg_settings_set(''{"overpay_mode":"auto_refund"}'')');
  perform pg_temp.res('51 bad overpay mode refused', e like '22023%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_settings_set('{"overpay_mode":"manual_refund"}'::jsonb);
  perform pg_temp.res('52 admin sets overpay_mode; defaults kept', r ->> 'overpay_mode' = 'manual_refund' and r ->> 'pkg_client_channel' = 'email'
    and (r ->> 'pkg_lock_days')::int = 0, r::text);
  perform pg_temp.login('pk_viewer@a.test');
  r := public.pkg_settings_get();
  perform pg_temp.res('53 reviewer reads settings', r ->> 'overpay_mode' = 'manual_refund', r::text);

  -- overpay: manual_refund + single-admin self-approve override (adjust + accept in one go)
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.package_selections set status = 'cancelled' where id = t::uuid;
  update public.event_plan set menu_template = null where quote_id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 60, null);
  perform pg_temp.su(); select id::text into t from public.package_selections where quote_id = qa::uuid and status = 'pending';
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_selection_review(t::uuid, 'accept', 500, null);
  perform pg_temp.su();
  perform pg_temp.res('54 single admin may adjust+approve, override logged', r ->> 'status' = 'accepted'
    and exists (select 1 from public.audit_log where action = 'pkg.self_approve_override' and entity_id = t), r::text);
  perform pg_temp.res('55 manual_refund -> refund_due flagged', exists (select 1 from public.pkg_credits where quote_id = qa::uuid and kind = 'refund_due' and amount = 80000 - 41300), r::text);

  -- decline path
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.package_selections set status = 'cancelled' where id = t::uuid;
  update public.event_plan set menu_template = null where quote_id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 80, null);
  perform pg_temp.su(); select id::text into t from public.package_selections where quote_id = qa::uuid and status = 'pending';
  perform pg_temp.login('a_staff@a.test');
  r := public.pkg_selection_review(t::uuid, 'decline', null, 'Date is fully booked for that menu');
  perform pg_temp.anon();
  r := public.public_booklet_packages(tok::uuid);
  perform pg_temp.res('56 decline shown to client with reason', r #>> '{current_selection,status}' = 'declined'
    and r #>> '{current_selection,decline_reason}' like 'Date is fully%' and r -> 'quote_ready' = 'null'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('57 decline: bell + client message + audit', exists (select 1 from public.notifications where kind = 'pkg_declined' and quote_id = qa::uuid)
    and exists (select 1 from public.pkg_outbox where kind = 'pkg_declined' and audience = 'client') and exists (select 1 from public.audit_log where action = 'pkg.decline' and entity_id = t), '');

  -- OTP
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_settings_set('{"pkg_require_otp":true,"pkg_client_channel":"whatsapp"}'::jsonb);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('58 OTP required when the studio turns it on', e like 'P0001%code%', e);
  r := public.public_booklet_otp_request(tok::uuid);
  perform pg_temp.put('otp', r ->> 'dev_code');
  perform pg_temp.res('59 OTP queued on WhatsApp (dev echo in test env)', (r ->> 'sent')::boolean and r ->> 'channel' = 'whatsapp' and r ->> 'dev_code' ~ '^[0-9]{6}$', r::text);
  perform pg_temp.su();
  perform pg_temp.res('60 OTP stored hashed; outbox row to client phone', not exists (select 1 from public.pkg_otps where code_hash = pg_temp.get('otp'))
    and exists (select 1 from public.pkg_outbox where kind = 'pkg_otp' and channel = 'whatsapp' and recipient = '919876500000'), '');
  perform pg_temp.anon();
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 100, null, '000000');
  perform pg_temp.res('61 wrong code refused', r ->> 'status' = 'otp_invalid' or pg_temp.get('otp') = '000000', r::text);
  r := public.public_booklet_choose(tok::uuid, pk::uuid, 100, null, pg_temp.get('otp'));
  perform pg_temp.su();
  perform pg_temp.res('62 right code -> pending, otp_verified', r ->> 'status' = 'pending'
    and exists (select 1 from public.package_selections where quote_id = qa::uuid and status = 'pending' and otp_verified), r::text);
  perform pg_temp.su();
  insert into public.auth_rate_hits(bucket, key, window_start, n) values ('pkg.otp', md5('pkg:' || tok), now(), 500)
    on conflict (bucket, key) do update set n = 500, window_start = now();
  insert into public.auth_rate_hits(bucket, key, window_start, n) values ('pkg.choose', md5('pkg:' || tok), now(), 500)
    on conflict (bucket, key) do update set n = 500, window_start = now();
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_booklet_otp_request(%L)', tok));
  perform pg_temp.res('63 OTP requests rate-limited', e like 'P0001%too many%', e);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('64 choices rate-limited', e like 'P0001%too many%', e);
  perform pg_temp.su(); delete from public.auth_rate_hits where bucket like 'pkg.%';

  -- locks
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_settings_set('{"pkg_require_otp":false,"pkg_lock_days":5}'::jsonb);
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set event_date = current_date + 3 where id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('65 locked inside pkg_lock_days', e like 'P0001%closed%too_close%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.pkg_settings_set('{"pkg_lock_days":0}'::jsonb);
  perform pg_temp.su(); set local session_replication_role = replica;
  insert into public.event_closure(quote_id, closed_at, org_id) values (qa::uuid, now(), a);
  set local session_replication_role = origin;
  perform pg_temp.anon();
  r := public.public_booklet_packages(tok::uuid);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('66 closed event (D6 freeze) locks selection', (r ->> 'locked')::boolean and e like 'P0001%closed%frozen%', e);
  perform pg_temp.su(); select id::text into t from public.package_selections where quote_id = qa::uuid and status = 'pending';
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.pkg_selection_review(%L, ''accept'')', t));
  perform pg_temp.res('67 review refused on a frozen event', e like 'P0001%frozen%', e);
  perform pg_temp.su(); set local session_replication_role = replica;
  delete from public.event_closure where quote_id = qa::uuid;
  update public.quotes set confirmed_at = now(), status = 'confirmed' where id = qa::uuid;
  set local session_replication_role = origin;
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('68 confirmed event locks selection', e like 'P0001%closed%confirmed%', e);
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set confirmed_at = null, status = 'quote', event_date = current_date + 60 where id = qa::uuid;
  set local session_replication_role = origin;

  -- snapshots: upload rules
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('69 editor may upload own event snapshot', public.booklet_snapshot_upload_ok(a::text || '/' || qa || '/2d.png'), '');
  perform pg_temp.res('70 bad names refused', not public.booklet_snapshot_upload_ok(a::text || '/' || qa || '/evil.svg')
    and not public.booklet_snapshot_upload_ok(a::text || '/' || qa || '/x/2d.png'), '');
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('71 other studio refused (own org folder, foreign quote)', not public.booklet_snapshot_upload_ok('b0000000-0000-4000-8000-000000000001/' || qa || '/2d.png')
    and not public.booklet_snapshot_upload_ok(a::text || '/' || qa || '/2d.png'), '');
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (''booklet-snapshots'', %L)', a::text || '/' || qa || '/3d.png'));
  perform pg_temp.res('72 cross-org upload refused by storage RLS', e like '42501%', e);
  perform pg_temp.login('pk_viewer@a.test');
  perform pg_temp.res('73 view-only role cannot upload', not public.booklet_snapshot_upload_ok(a::text || '/' || qa || '/2d.png'), '');
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name) values (''booklet-snapshots'', %L)', a::text || '/' || qa || '/2d.png'));
  perform pg_temp.res('74 editor upload passes RLS', e = '', e);
  r := public.booklet_set_snapshot(qa::uuid, '2d', a::text || '/' || qa || '/2d.png');
  r := public.booklet_set_snapshot(qa::uuid, '3d', a::text || '/' || qa || '/3d.webp');
  e := pg_temp.try(format('select public.booklet_set_snapshot(%L, ''2d'', %L)', qa, 'b0000000-0000-4000-8000-000000000001/' || qa || '/2d.png'));
  perform pg_temp.res('75 snapshot path must be this studio + event', e like '22023%', e);
  perform pg_temp.anon();
  r := public.public_get_booklet(tok::uuid);
  perform pg_temp.res('76 booklet flags both snapshots (no storage path leaked)', (r #>> '{snapshots,2d}')::boolean and (r #>> '{snapshots,3d}')::boolean
    and r::text not like '%2d.png%', (r -> 'snapshots')::text);

  -- share checklist
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.booklet_share(%L, 30, null, null, null, ''{"menu":true,"secret":true}'')', qa));
  perform pg_temp.res('77 unknown section key refused', e like '22023%', e);
  e := pg_temp.try(format('select public.booklet_share(%L, 30, null, null, null, ''{"menu":"yes"}'')', qa));
  perform pg_temp.res('78 non-boolean section refused', e like '22023%', e);
  r := public.booklet_share(qa::uuid, 30, null, 'TERMS-X', 'NOTE-X',
    '{"menu":false,"payments":false,"quotation":false,"layout2d":false,"note":false,"venue":false,"client":false,"studio":false}'::jsonb);
  tok := r ->> 'token'; perform pg_temp.put('tokh', tok);
  perform pg_temp.res('79 share with sections; snapshots carried to the new link', r -> 'sections' ->> 'menu' = 'false' and r -> 'sections' ->> 'terms' = 'true'
    and (select snap_2d_path is not null from public.client_booklets where token = tok::uuid), r::text);
  perform pg_temp.anon();
  r := public.public_get_booklet(tok::uuid);
  perform pg_temp.res('80 hidden sections never returned', not (r ? 'menu') and not (r ? 'payments') and not (r ? 'quote') and not (r ? 'versions')
    and not (r ? 'layout') and not (r ? 'note') and r ->> 'terms' = 'TERMS-X' and not ((r -> 'event') ? 'venue_name')
    and not ((r -> 'event') ? 'client_name') and not ((r -> 'studio') ? 'email') and r #>> '{studio,name}' = 'Studio A'
    and r::text not like '%NOTE-X%' and r::text not like '%Gold Veg%' and r::text not like '%41300%' and r::text not like '%Alice%', r::text);
  perform pg_temp.res('81 hidden 2D snapshot not flagged, ticked 3D is', not (r #>> '{snapshots,2d}')::boolean and (r #>> '{snapshots,3d}')::boolean, (r -> 'snapshots')::text);
  r := public.public_booklet_packages(tok::uuid);
  perform pg_temp.res('82 packages: menu hidden -> no packages, no totals, locked', r ->> 'mode' = 'hidden' and jsonb_array_length(r -> 'packages') = 0
    and r -> 'totals' = 'null'::jsonb and (r ->> 'locked')::boolean and r -> 'current_selection' = 'null'::jsonb, r::text);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('83 choose refused when menu hidden', e like 'P0001%closed%hidden%', e);
  perform pg_temp.su();
  perform pg_temp.res('84 snapshot path only for ticked sections', public.booklet_snapshot_path(tok::uuid, '2d') is null
    and public.booklet_snapshot_path(tok::uuid, '3d') = a::text || '/' || qa || '/3d.webp'
    and public.booklet_snapshot_path(pg_temp.get('tok')::uuid, '3d') is null, '');

  -- outbox claim / mark
  perform pg_temp.su();
  r := public.pkg_outbox_claim(100);
  perform pg_temp.res('85 outbox claim returns pending rows', jsonb_array_length(r) >= 3, jsonb_array_length(r)::text);
  t := (select r2 ->> 'id' from jsonb_array_elements(r) r2 where r2 ->> 'kind' = 'pkg_otp' limit 1);
  perform public.pkg_outbox_mark(t::uuid, 'sent');
  perform pg_temp.res('86 OTP code wiped from outbox once handled', (select status = 'sent' and not (payload ? 'otp') from public.pkg_outbox where id = t::uuid), coalesce(t, 'no otp row'));
  perform pg_temp.res('87 claimed rows not re-claimed', jsonb_array_length(public.pkg_outbox_claim(100)) = 0, '');

end $$;

-- suspended checks need a clean block (the previous one stops at a refused share)
do $$ declare e text; r jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; pk text := 'a0000000-0000-4000-8000-0000000c0001'; tok text;
begin
  perform pg_temp.su();
  tok := (select token::text from public.client_booklets where revoked_at is null and org_id = a order by created_at desc limit 1);
  -- open menu so only the suspension locks it
  set local session_replication_role = replica;
  update public.client_booklets set sections = public._bk_sections_all() where token = tok::uuid;
  update public.event_plan set menu_template = null where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  update public.package_selections set status = 'cancelled' where status = 'accepted';
  set local session_replication_role = origin;
  insert into public.studio_subscriptions(org_id, status) values (a, 'suspended') on conflict do nothing;
  perform pg_temp.anon();
  r := public.public_booklet_packages(tok::uuid);
  e := pg_temp.try(format('select public.public_booklet_choose(%L, %L, 100, null)', tok, pk));
  perform pg_temp.res('88 suspended studio: read-only, selection disabled', (r ->> 'locked')::boolean and e like '25006%', e || ' / ' || coalesce(r ->> 'locked', 'null'));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.pkg_settings_set(''{"pkg_lock_days":1}'')');
  perform pg_temp.res('89 suspended studio cannot change settings', e like '25006%', e);
end $$;

select name, result from _bk order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'PKG-FLOW: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'PKG-FLOW: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bk;
rollback;
