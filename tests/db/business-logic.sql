-- business-logic.sql — 0026 (security audit Phase 7: business logic + cryptography).
-- Every ATTACK case was reproduced against the pre-0026 schema (it FAILS there) and
-- passes after 0026. Every LEGIT case is something the app really does and must
-- keep working. Attackers: a_staff (role 'sales' with quotes/finance edit from the
-- fixture; this suite adds settlement edit), b_admin (another studio), anon (a
-- client-link holder).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _bl; create temp table _bl(name text, result text); grant all on _bl to anon, authenticated;
drop table if exists _bl_ids; create temp table _bl_ids(k text primary key, v uuid); grant all on _bl_ids to anon, authenticated;
drop table if exists _bl_val; create temp table _bl_val(k text primary key, v jsonb); grant all on _bl_val to anon, authenticated;

create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  execute 'reset role'; perform auth.logout(); execute 'reset role';
  select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform auth.login_anon(); end $$;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.id(p text) returns uuid language sql as $$ select v from _bl_ids where k = p $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _bl values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.total(p uuid) returns text language sql as $$ select pricing->>'total' from public.quotes where id = p $$;

-- ---- setup (superuser) --------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        qA uuid := 'a0000000-0000-4000-8000-00000000da01'; qB uuid := 'b0000000-0000-4000-8000-00000000da01';
        k text; q uuid; v_item uuid; v_vendor uuid; v_crew uuid;
begin
  perform pg_temp.su();
  -- leftovers of an interrupted earlier run (org A in context for the archive trigger)
  perform auth.login_as((select id from auth.users where email = 'a_admin@a.test')); execute 'reset role';
  delete from public.leads where notes in ('bl-big','bl-lead');
  delete from public.vendors where org_id = orgA and name in ('bl-badphone','bl-goodvendor','bl-vendor');
  delete from public.inventory_items where org_id = orgA and name = 'bl-item';
  delete from public.crew_members where org_id = orgA and name = 'bl-crew';
  delete from public.event_ratings where name = 'bl-sentinel';
  perform pg_temp.su();
  insert into _bl_ids select 'staff', id from auth.users where email = 'a_staff@a.test';
  insert into _bl_ids select 'admin', id from auth.users where email = 'a_admin@a.test';
  insert into public.role_access(role,area,can_view,can_edit,org_id,updated_at)
    select 'sales', a, true, true, orgA, now() from unnest(array['settlement']) a
    on conflict (role,area,org_id) do update set can_view=true, can_edit=true;
  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18}'::jsonb,
         client = '{"name":"Alice","phone":"+919811100000","email":"alice@a.test"}'::jsonb where id = qA;

  -- test events in studio A (superuser writes; every token is unique to this suite)
  foreach k in array array['free','nan','del1','del2','del3','del4','otp1','otp2','pay','mp'] loop
    insert into public.quotes(code, title, status, client, pricing, current_version, approval_status, org_id,
                              approval_token, approval_token_expires_at, created_at, updated_at)
      values ('BL-'||upper(k), 'bl '||k, 'quote', '{"name":"Alice","phone":"+919811100000"}'::jsonb,
              case when k in ('otp2','pay','mp') then '{"subtotal":100000,"discount":0,"gstPct":18}'::jsonb else '{}'::jsonb end,
              1, case when k in ('pay','mp') then 'approved' else 'sent' end, orgA,
              gen_random_uuid(), now() + interval '30 days', now(), now())
      returning id into q;
    insert into _bl_ids values (k, q);
    insert into _bl_ids select 'tok_'||k, approval_token from public.quotes where id = q;
  end loop;
  -- a legacy event whose stored total is not a number (written with triggers off, as old data could be)
  set local session_replication_role = replica;
  update public.quotes set pricing = '{"total":"NaN"}'::jsonb where id = pg_temp.id('nan');
  set local session_replication_role = origin;

  -- delete-guard fixtures
  insert into public.quote_payments(quote_id, provider, amount, status, simulated, receipt_no, method, paid_at)
    values (pg_temp.id('del1'), 'cash', 100, 'paid', false, 'RCP-BL-DEL1', 'cash', now());
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp)
    values (pg_temp.id('del2'), '+919811100000', 'Alice', 'v1', 'I accept', true, true);
  insert into public.event_refunds(quote_id, kind, amount, reason) values (pg_temp.id('del3'), 'refund', 50, 'bl');
  insert into public.quote_payments(quote_id, provider, amount, status, simulated)
    values (pg_temp.id('del4'), 'simulated', 0, 'created', true);
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (pg_temp.id('del4'), '+919811100044', 'h', now() + interval '10 minutes');

  -- OTP lockout fixture: a known code for a known phone
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (pg_temp.id('otp1'), '+919811100001', extensions.crypt('246810', extensions.gen_salt('bf')), now() + interval '10 minutes');
  -- dev echo so the real request_otp -> verify_and_consent flow can run end to end
  insert into public.app_config(org_id, key, value) values (orgA, 'channels', '{"otp_dev_echo":true}'::jsonb)
    on conflict (org_id, key) do update set value = excluded.value;

  -- mark_paid fixture: two open payment requests for the same event (the duplicate bug)
  insert into public.quote_payments(quote_id, provider, amount, status, simulated, created_at)
    values (pg_temp.id('mp'), 'simulated', 118000, 'created', true, now() - interval '2 minutes'),
           (pg_temp.id('mp'), 'simulated', 118000, 'created', true, now() - interval '1 minute');

  -- studio A records another studio must not be able to point at
  insert into public.inventory_items(name, org_id, total_qty) values ('bl-item', orgA, 10) returning id into v_item;
  insert into public.vendors(name, org_id) values ('bl-vendor', orgA) returning id into v_vendor;
  insert into public.crew_members(name, phone, org_id) values ('bl-crew', '+919811100003', orgA) returning id into v_crew;
  insert into public.event_ratings(quote_id, kind, name, stars) values (qA, 'staff', 'bl-sentinel', 5);
  insert into _bl_ids values ('item', v_item), ('vendor', v_vendor), ('crew', v_crew), ('qA', qA), ('qB', qB), ('orgA', orgA);
end $$;

-- ================= 1) money: NaN / Infinity / negative =========================
do $$ begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"gstPct":18,"chairs":"NaN","chairPrice":100}'::jsonb where id = pg_temp.id('qA'); exception when others then null; end;
  perform pg_temp.su();
  perform pg_temp.res('money: NaN in quote pricing is refused', pg_temp.total(pg_temp.id('qA')) = '236000', 'total now '||coalesce(pg_temp.total(pg_temp.id('qA')),'null'));
end $$;
do $$ begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"subtotal":"Infinity","gstPct":18}'::jsonb where id = pg_temp.id('qA'); exception when others then null; end;
  perform pg_temp.su();
  perform pg_temp.res('money: Infinity in quote pricing is refused', pg_temp.total(pg_temp.id('qA')) = '236000', 'total now '||coalesce(pg_temp.total(pg_temp.id('qA')),'null'));
end $$;
do $$ begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"gstPct":18,"chairs":10,"chairPrice":1000,"coupon":{"kind":"flat","value":"NaN"}}'::jsonb where id = pg_temp.id('qA'); exception when others then null; end;
  perform pg_temp.su();
  perform pg_temp.res('money: a NaN coupon cannot zero the quote total', pg_temp.total(pg_temp.id('qA')) = '236000', 'total now '||coalesce(pg_temp.total(pg_temp.id('qA')),'null'));
end $$;
do $$ begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set pricing = '{"gstPct":18,"chairs":100,"chairPrice":500,"guests":0,"platePrice":0}'::jsonb where id = pg_temp.id('qA');
  exception when others then perform pg_temp.res('money: normal pricing edit still works (server total)', false, sqlerrm); return; end;
  perform pg_temp.su();
  perform pg_temp.res('money: normal pricing edit still works (server total)', pg_temp.total(pg_temp.id('qA')) = '59000', 'total '||coalesce(pg_temp.total(pg_temp.id('qA')),'null'));
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin perform public.record_payment(pg_temp.id('free'), 'NaN'::numeric, 'cash', 'RCP-BL-NAN'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where quote_id = pg_temp.id('free') and amount = 'NaN';
  perform pg_temp.res('money: record_payment refuses a NaN amount', n = 0, n||' NaN receipt(s)');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin perform public.record_payment(pg_temp.id('free'), 'Infinity'::numeric, 'cash', 'RCP-BL-INF'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where quote_id = pg_temp.id('free') and amount = 'Infinity';
  perform pg_temp.res('money: record_payment refuses an Infinity amount', n = 0, n||' Infinity receipt(s)');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.payment_milestones(quote_id, label, amount, status) values (pg_temp.id('free'), 'bl-ms', 'NaN', 'due'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.payment_milestones where quote_id = pg_temp.id('free') and label = 'bl-ms';
  perform pg_temp.res('money: a NaN payment milestone is refused', n = 0, 'stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.expense_claims(quote_id, who, amount) values (pg_temp.id('free'), 'bl-neg', -500); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.expense_claims where who = 'bl-neg';
  perform pg_temp.res('money: a negative expense claim is refused', n = 0, 'stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.event_refunds(quote_id, kind, amount, reason) values (pg_temp.id('free'), 'refund', 'NaN', 'bl-nan'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_refunds where reason = 'bl-nan';
  perform pg_temp.res('money: a NaN refund is refused', n = 0, 'stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin perform public.record_payment(pg_temp.id('nan'), 999999999, 'cash', 'RCP-BL-OVER'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where quote_id = pg_temp.id('nan') and status = 'paid';
  perform pg_temp.res('money: a NaN quote total no longer switches off the overpayment cap', n = 0, n||' payment(s) accepted');
end $$;
do $$ declare r jsonb; begin
  perform pg_temp.su();   -- back to the fixture price (236000) so the balance has room
  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18}'::jsonb where id = pg_temp.id('qA');
  perform pg_temp.login('a_staff@a.test');
  begin r := public.record_payment(pg_temp.id('qA'), 1000, 'cash', 'RCP-BL-OK');
  exception when others then perform pg_temp.res('money: recording a normal payment still works', false, sqlerrm); return; end;
  perform pg_temp.res('money: recording a normal payment still works', r->>'receipt_no' = 'RCP-BL-OK', r::text);
end $$;
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from pg_constraint where conname like '%\_finite\_chk' and contype = 'c' and not convalidated;
  perform pg_temp.res('money: finite/non-negative checks on money columns (NOT VALID, old rows untouched)', n >= 25, n||' checks');
end $$;

-- ================= 2) deleting an event with money / consent / refunds ===========
do $$ declare n int; p int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.quotes where id = pg_temp.id('del1'); exception when others then null; end;
  perform pg_temp.su();
  select count(*) into n from public.quotes where id = pg_temp.id('del1');
  select count(*) into p from public.quote_payments where receipt_no = 'RCP-BL-DEL1';
  perform pg_temp.res('delete: an event with a paid receipt cannot be deleted', n = 1 and p = 1, 'event '||n||', receipt '||p);
end $$;
do $$ declare n int; c int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.quotes where id = pg_temp.id('del2'); exception when others then null; end;
  perform pg_temp.su();
  select count(*) into n from public.quotes where id = pg_temp.id('del2');
  select count(*) into c from public.quote_consents where quote_id = pg_temp.id('del2');
  perform pg_temp.res('delete: an event with a client consent cannot be deleted', n = 1 and c = 1, 'event '||n||', consent '||c);
end $$;
do $$ declare n int; r int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.quotes where id = pg_temp.id('del3'); exception when others then null; end;
  perform pg_temp.su();
  select count(*) into n from public.quotes where id = pg_temp.id('del3');
  select count(*) into r from public.event_refunds where quote_id = pg_temp.id('del3');
  perform pg_temp.res('delete: an event with refunds cannot be deleted', n = 1 and r = 1, 'event '||n||', refund '||r);
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_staff@a.test');
  begin delete from public.quotes where id = pg_temp.id('del4');
  exception when others then perform pg_temp.res('delete: an unpaid draft still deletes', false, sqlerrm); return; end;
  perform pg_temp.su(); select count(*) into n from public.quotes where id = pg_temp.id('del4');
  perform pg_temp.res('delete: an unpaid draft still deletes', n = 0, 'still there');
end $$;

-- ================= 3) OTP lockout persists ========================================
do $$ declare i int; r jsonb; begin
  perform pg_temp.anon();
  for i in 1..5 loop
    begin perform public.verify_and_consent(pg_temp.id('tok_otp1'), '+919811100001', '000000', true, 'v1', 'I accept', 'Alice', 'ua');
    exception when others then null; end;
  end loop;
  begin r := public.verify_and_consent(pg_temp.id('tok_otp1'), '+919811100001', '246810', true, 'v1', 'I accept', 'Alice', 'ua');
  exception when others then r := jsonb_build_object('approved', false, 'error', sqlerrm); end;
  perform pg_temp.res('otp: after 5 wrong codes the right code is refused (locked)', coalesce(r->>'approved','') <> 'true', r::text);
end $$;
do $$ declare a int; begin
  perform pg_temp.su(); select attempts into a from public.quote_otps where quote_id = pg_temp.id('otp1') and phone = '+919811100001';
  perform pg_temp.res('otp: wrong attempts are counted and kept', a = 5, 'attempts '||coalesce(a::text,'null'));
end $$;
do $$ declare r jsonb; v jsonb; begin
  perform pg_temp.anon();
  r := public.request_otp(pg_temp.id('tok_otp2'), '+919811100002');
  v := public.verify_and_consent(pg_temp.id('tok_otp2'), '+919811100002', r->>'dev_code', true, 'v3', 'I accept the quote', 'Alice', repeat('U', 3000));
  perform pg_temp.res('otp: request code -> enter it -> approved still works', (r->>'dev_code') ~ '^[0-9]{6}$' and v->>'approved' = 'true', r::text||' / '||v::text);
exception when others then perform pg_temp.res('otp: request code -> enter it -> approved still works', false, sqlerrm);
end $$;
do $$ declare d text; begin
  perform pg_temp.su(); d := pg_get_functiondef('public.request_otp(uuid,text)'::regprocedure);
  perform pg_temp.res('otp: code comes from gen_random_bytes, not random()', d ilike '%gen_random_bytes%' and d not ilike '%random()%', 'insecure generator');
end $$;
do $$ declare c record; begin
  perform pg_temp.su();
  begin
    execute 'select quote_total, quote_version, consent_text_sha256, length(user_agent) as ua, phone_matches_client from public.quote_consents where quote_id = $1'
      into c using pg_temp.id('otp2');
  exception when others then perform pg_temp.res('consent: records the total, version and text hash that were approved', false, sqlerrm); return; end;
  perform pg_temp.res('consent: records the total, version and text hash that were approved',
    c.quote_total = 118000 and c.quote_version = 1 and c.consent_text_sha256 = encode(sha256(convert_to('I accept the quote','UTF8')),'hex')
    and c.ua <= 1000 and c.phone_matches_client is false, row_to_json(c)::text);
end $$;
do $$ declare n int; begin
  perform pg_temp.su(); select count(*) into n from public.audit_log where entity = 'quote_consents' and quote_id = pg_temp.id('otp2');
  perform pg_temp.res('audit: the client consent is written to the audit log', n >= 1, n||' audit row(s)');
end $$;

-- ================= 5) payment requests ===============================================
do $$ declare i int; r jsonb; first jsonb; n int; begin
  perform pg_temp.anon();
  for i in 1..3 loop r := public.create_payment(pg_temp.id('tok_pay')); if i = 1 then first := r; end if; end loop;
  perform pg_temp.su(); select count(*) into n from public.quote_payments where quote_id = pg_temp.id('pay') and status = 'created';
  perform pg_temp.res('payment: repeated "pay" clicks reuse one open request', n = 1 and first->>'link_url' is not null, n||' request(s); '||coalesce(first::text,''));
exception when others then perform pg_temp.res('payment: repeated "pay" clicks reuse one open request', false, sqlerrm);
end $$;
do $$ declare n int; begin
  perform pg_temp.su(); select count(*) into n from public.notifications where quote_id = pg_temp.id('pay') and kind = 'payment_link';
  perform pg_temp.res('payment: repeated clicks send one payment-link SMS', n = 1, n||' message(s)');
end $$;
do $$ declare p int; c int; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.mark_paid(pg_temp.id('mp'), 'ref-bl');
  exception when others then perform pg_temp.res('payment: mark paid settles one request when duplicates exist', false, sqlerrm); return; end;
  perform pg_temp.su();
  select count(*) filter (where status = 'paid'), count(*) filter (where status = 'cancelled') into p, c
    from public.quote_payments where quote_id = pg_temp.id('mp');
  perform pg_temp.res('payment: mark paid settles one request when duplicates exist', p = 1 and c = 1, p||' paid, '||c||' cancelled');
end $$;

-- ================= 6) cross-studio references =======================================
do $$ declare n int; begin
  perform pg_temp.login('b_admin@b.test');
  begin insert into public.inventory_reservations(item_id, quote_id, qty) values (pg_temp.id('item'), pg_temp.id('qB'), 1); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.inventory_reservations where item_id = pg_temp.id('item') and quote_id = pg_temp.id('qB');
  perform pg_temp.res('tenant: another studio cannot reserve our stock item', n = 0, 'planted');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('b_admin@b.test');
  begin insert into public.event_resources(quote_id, label, vendor_id) values (pg_temp.id('qB'), 'bl-plant', pg_temp.id('vendor')); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_resources where vendor_id = pg_temp.id('vendor');
  perform pg_temp.res('tenant: another studio cannot book our vendor record', n = 0, 'planted');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('b_admin@b.test');
  begin insert into public.event_tasks(quote_id, category, title, crew_id) values (pg_temp.id('qB'), 'setup', 'bl-plant', pg_temp.id('crew')); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_tasks where crew_id = pg_temp.id('crew');
  perform pg_temp.res('tenant: another studio cannot assign our crew member', n = 0, 'planted');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.inventory_reservations(item_id, quote_id, qty) values (pg_temp.id('item'), pg_temp.id('qA'), 2);
  exception when others then perform pg_temp.res('tenant: reserving our own stock still works', false, sqlerrm); return; end;
  perform pg_temp.su(); select count(*) into n from public.inventory_reservations where item_id = pg_temp.id('item') and quote_id = pg_temp.id('qA');
  perform pg_temp.res('tenant: reserving our own stock still works', n = 1, n||' rows');
end $$;

-- ================= 7) TRUNCATE / TRIGGER / REFERENCES ================================
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('TRUNCATE','TRIGGER','REFERENCES');
  perform pg_temp.res('grants: API roles hold no TRUNCATE/TRIGGER/REFERENCES', n = 0, n||' grant(s)');
end $$;
do $$ declare n int; begin
  perform pg_temp.anon();
  begin truncate public.event_ratings; exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.event_ratings where name = 'bl-sentinel';
  perform pg_temp.res('grants: a visitor cannot TRUNCATE a table', n = 1, 'table wiped');
end $$;

-- ================= 8) audit coverage ================================================
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from pg_trigger where tgname = 'audit_trg'
     and tgrelid in ('public.quote_consents'::regclass, 'public.payment_milestones'::regclass, 'public.event_refunds'::regclass,
                     'public.event_resources'::regclass, 'public.inventory_checkouts'::regclass, 'public.event_closure'::regclass,
                     'public.quotation_versions'::regclass);
  perform pg_temp.res('audit: consents, milestones, refunds, bookings, check-outs, closure, versions are audited', n = 7, n||'/7');
end $$;

-- ================= 9) refund maker-checker ==========================================
do $$ declare cb uuid; begin
  perform pg_temp.login('a_staff@a.test');
  begin insert into public.event_refunds(quote_id, kind, amount, reason, created_by)
          values (pg_temp.id('free'), 'refund', 500, 'bl-mc', pg_temp.id('admin'));
  exception when others then perform pg_temp.res('refund: who entered it is stamped by the server', false, sqlerrm); return; end;
  perform pg_temp.su(); select created_by into cb from public.event_refunds where reason = 'bl-mc';
  perform pg_temp.res('refund: who entered it is stamped by the server', cb = pg_temp.id('staff'), 'created_by '||coalesce(cb::text,'null'));
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.event_refunds set status = 'approved' where reason = 'bl-mc'; exception when others then null; end;
  perform pg_temp.su(); select status into s from public.event_refunds where reason = 'bl-mc';
  perform pg_temp.res('refund: the person who entered it cannot approve it', s = 'pending', 'status '||s);
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  begin update public.event_refunds set status = 'approved' where reason = 'bl-mc';
  exception when others then perform pg_temp.res('refund: someone else can approve it', false, sqlerrm); return; end;
  perform pg_temp.su(); select status into s from public.event_refunds where reason = 'bl-mc';
  perform pg_temp.res('refund: someone else can approve it', s = 'approved', 'status '||s);
end $$;

-- ================= 10) server-side text / contact bounds ============================
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.leads(name, notes) values (repeat('x', 100000), 'bl-big'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.leads where notes = 'bl-big';
  perform pg_temp.res('validation: a 100k-character lead name is refused', n = 0, 'stored');
end $$;
do $$ declare e text; begin
  perform pg_temp.login('a_staff@a.test');
  begin update public.quotes set client = '{"name":"Alice","email":"alice@a.test, boss@evil.example"}'::jsonb where id = pg_temp.id('qA'); exception when others then null; end;
  perform pg_temp.su(); select client->>'email' into e from public.quotes where id = pg_temp.id('qA');
  perform pg_temp.res('validation: a client email list (several recipients) is refused', e = 'alice@a.test', 'email now '||coalesce(e,'null'));
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin insert into public.vendors(name, phone) values ('bl-badphone', 'call <b>me</b>'); exception when others then null; end;
  perform pg_temp.su(); select count(*) into n from public.vendors where name = 'bl-badphone';
  perform pg_temp.res('validation: a phone number with letters/markup is refused', n = 0, 'stored');
end $$;
do $$ declare n int; begin
  perform pg_temp.login('a_admin@a.test');
  begin
    insert into public.vendors(name, phone, email) values ('bl-goodvendor', '+91 98480-12345', 'shop@vendor.example');
    insert into public.leads(name, phone, email, notes) values ('bl-lead', '(040) 2345 6789', 'lead@example.com', 'bl-lead');
  exception when others then perform pg_temp.res('validation: normal phones and emails are still accepted', false, sqlerrm); return; end;
  perform pg_temp.su();
  select (select count(*) from public.vendors where name = 'bl-goodvendor') + (select count(*) from public.leads where notes = 'bl-lead') into n;
  perform pg_temp.res('validation: normal phones and emails are still accepted', n = 2, n||'/2');
end $$;

-- ---- cleanup (superuser; owner maintenance switch for the guarded test events) ----
do $$ declare k text; begin
  perform pg_temp.su();
  perform auth.login_as(pg_temp.id('admin')); execute 'reset role';   -- org A in context (archive triggers)
  perform set_config('helm.allow_financial_delete', 'on', true);
  delete from public.quote_payments where quote_id = pg_temp.id('qA') and receipt_no = 'RCP-BL-OK';
  delete from public.inventory_reservations where item_id = pg_temp.id('item');
  delete from public.event_resources where vendor_id = pg_temp.id('vendor');
  delete from public.event_tasks where crew_id = pg_temp.id('crew');
  foreach k in array array['free','nan','del1','del2','del3','del4','otp1','otp2','pay','mp'] loop
    delete from public.quotes where id = pg_temp.id(k);
  end loop;
  delete from public.inventory_items where id = pg_temp.id('item');
  delete from public.vendors where id = pg_temp.id('vendor') or name in ('bl-badphone','bl-goodvendor');
  delete from public.crew_members where id = pg_temp.id('crew');
  delete from public.event_ratings where name = 'bl-sentinel';
  delete from public.leads where notes in ('bl-big','bl-lead');
  delete from public.app_config where org_id = pg_temp.id('orgA') and key = 'channels';
  delete from public.role_access where role = 'sales' and area = 'settlement' and org_id = pg_temp.id('orgA');
  update public.quotes set pricing = '{"subtotal":200000,"discount":0,"gstPct":18}'::jsonb, client = '{"name":"Alice"}'::jsonb
   where id = pg_temp.id('qA');
end $$;
select name, result from _bl order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 39 then 'BUSINESS-LOGIC: ALL PASS'
            else 'BUSINESS-LOGIC: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/39 ran' end from _bl;
