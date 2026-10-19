-- r23-vendors-0256.sql -- 0256: vendor requests (assign -> accept / reject with a comment -> reassign / cancel) and
-- vendor invoices from the same signed-out link (one-time upload grant, GST rules, unique number per vendor per
-- financial year) reviewed by Finance (approve -> one vendor bill = Actual in the 0246 ledger, query -> resubmit,
-- reject), payments through record_vendor_payout, reminders + "No reply" notice, the dispatcher claim, free trials,
-- sample events, expiry, storage gates and tenants. Rolled back. Local disposable PG only. Nothing is ever sent.
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
-- the ledger line of one booking (0246 _r21_cost_lines)
create or replace function pg_temp.line(p_booking uuid) returns jsonb language sql as $$
  select x from jsonb_array_elements(public._r21_cost_lines('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001')) x
   where x ->> 'key' = 'booking:' || p_booking::text $$;

-- ---- setup ------------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; adm uuid; crd uuid; v1 uuid; v2 uuid; v3 uuid; vb uuid; cv uuid; begin
  crd := pg_temp.member('vr_coord@a.test', 'coordinator', a, 'Ravi Coordinator');
  perform pg_temp.member('vr_crew@a.test', 'crew', a, 'Crew Person');
  perform pg_temp.member('vr_fin@a.test', 'manager', a, 'Fiona Finance');
  perform pg_temp.member('vr_coord@b.test', 'coordinator', b, 'B Coordinator');
  perform pg_temp.su();
  select id into adm from public.profiles where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Asha Admin' where id = adm;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (a, 'coordinator', 'vendors', true, true, now()), (a, 'coordinator', 'finance', false, false, now()),
    (a, 'crew', 'vendors', true, false, now()), (a, 'crew', 'finance', false, false, now()),
    (a, 'manager', 'vendors', true, false, now()), (a, 'manager', 'finance', true, true, now()),
    (b, 'coordinator', 'vendors', true, true, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.quotes set status = 'confirmed', event_date = current_date + 5, title = 'Wedding A' where id = qa;
  insert into public.vendors(id, name, category, email, phone, org_id) values (gen_random_uuid(), 'Deccan Rentals', 'Furniture', 'Orders@Deccan.test', '+919876543210', a) returning id into v1;
  insert into public.vendors(id, name, category, email, org_id) values (gen_random_uuid(), 'Royal Tents', 'Furniture', 'royal@tents.test', a) returning id into v2;
  insert into public.vendors(id, name, category, org_id) values (gen_random_uuid(), 'Sound Co', 'Sound', a) returning id into v3;
  insert into public.vendors(id, name, category, email, org_id) values (gen_random_uuid(), 'B Vendor', 'Furniture', 'b@vendor.test', b) returning id into vb;
  insert into public.chat_conversations(id, org_id, kind, title, quote_id, created_by) values (gen_random_uuid(), a, 'group', 'Event group A-0001', qa, adm) returning id into cv;
  insert into public.chat_members(conversation_id, user_id, org_id) values (cv, adm, a), (cv, crd, a);
  perform pg_temp.put('v1', v1::text); perform pg_temp.put('v2', v2::text); perform pg_temp.put('v3', v3::text); perform pg_temp.put('vb', vb::text);
  perform pg_temp.put('cv', cv::text); perform pg_temp.put('adm', adm::text); perform pg_temp.put('crd', crd::text);
end $$;

-- ---- the migration, twice (safe to re-run) -----------------------------------------------------------------------
\ir ../../supabase/migrations/0256_vendor_requests_invoices.sql
\ir ../../supabase/migrations/0256_vendor_requests_invoices.sql

-- ---- 0) structure + grants ----------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 six new tables, RLS on, no anon / signed-in table privilege',
    (select bool_and(c.relrowsecurity) and count(*) = 6 from pg_class c where c.oid in ('public.vendor_requests'::regclass, 'public.vendor_request_log'::regclass,
       'public.vendor_request_links'::regclass, 'public.vendor_request_sends'::regclass, 'public.vendor_invoices'::regclass, 'public.vendor_invoice_grants'::regclass))
    and not has_table_privilege('authenticated', 'public.vendor_requests', 'select')
    and not has_table_privilege('authenticated', 'public.vendor_invoices', 'insert')
    and not has_table_privilege('anon', 'public.vendor_request_links', 'select')
    and not has_table_privilege('anon', 'public.vendor_invoice_grants', 'select'));
  perform pg_temp.res('02 service-role entry points + helpers are not callable by the app',
    has_function_privilege('service_role', 'public.vendor_requests_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.vendor_requests_tick()', 'execute')
    and not has_function_privilege('anon', 'public.vendor_request_claim(integer,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.vendor_request_mark(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._vr256_announce(uuid,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public._vr256_can(text)', 'execute'));
  perform pg_temp.res('03 studio RPCs signed-in only; the link RPCs also for anon',
    has_function_privilege('authenticated', 'public.vendor_request_save(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.vendor_request_save(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.vendor_invoice_review(uuid,text,text,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.vendor_requests_list(uuid,uuid)', 'execute')
    and has_function_privilege('anon', 'public.vendor_link_get(text)', 'execute')
    and has_function_privilege('anon', 'public.vendor_link_respond(text,text,text)', 'execute')
    and has_function_privilege('anon', 'public.vendor_invoice_submit(text,jsonb)', 'execute'));
  perform pg_temp.res('04 private bucket (10 MB, PDF + images) + 2 storage policies',
    exists (select 1 from storage.buckets where id = 'vendor-invoices' and not public and file_size_limit = 10485760
            and allowed_mime_types @> array['application/pdf', 'image/jpeg'])
    and (select count(*) from pg_policies where schemaname = 'storage' and policyname like 'vendor_invoices_%') = 2);
  perform pg_temp.res('05 trial retention: the request tables purge with the quote',
    to_regprocedure('public._tr184_purge_tables()') is null
    or public._tr184_purge_tables() @> array['vendor_invoice_grants', 'vendor_request_links', 'vendor_request_sends', 'vendor_invoices', 'vendor_request_log', 'vendor_requests']);
end $$;

-- ---- 1) access ------------------------------------------------------------------------------------------------------
do $$ declare e text; p jsonb; begin
  p := jsonb_build_object('quote_id', 'a0000000-0000-4000-8000-00000000da01', 'vendor_id', pg_temp.get('v1'), 'what', 'Chairs', 'qty', 120,
         'when_at', (now() + interval '4 days')::text, 'where_text', 'Lawn gate 2', 'details', 'White chiavari', 'agreed_amount', 18000);
  perform pg_temp.put('p1', p::text);
  perform pg_temp.login('vr_crew@a.test');
  e := pg_temp.err(format('select public.vendor_request_save(%L::jsonb)', p::text));
  perform pg_temp.res('10 crew (vendors view only) cannot send a request', e like '42501%', e);
  perform pg_temp.login('vr_coord@b.test');
  e := pg_temp.err(format('select public.vendor_request_save(%L::jsonb)', p::text));
  perform pg_temp.res('11 another studio cannot send a request on this event', e like 'P0002%', e);
  perform pg_temp.login('vr_coord@a.test');
  e := pg_temp.err(format('select public.vendor_request_save(%L::jsonb)', (p || jsonb_build_object('vendor_id', pg_temp.get('vb')))::text));
  perform pg_temp.res('12 another studio''s vendor is refused', e like 'P0002%', e);
  e := pg_temp.err(format('select public.vendor_request_save(%L::jsonb)', (p || '{"what":"<b>x</b>"}'::jsonb)::text));
  perform pg_temp.res('13 markup in "what" is refused', e like '22023%', e);
  e := pg_temp.err(format('select public.vendor_request_save(%L::jsonb)', (p || '{"evil":1}'::jsonb)::text));
  perform pg_temp.res('14 unknown fields are refused', e like '22023%', e);
  perform pg_temp.su();
end $$;

-- ---- 2) send -> booking (Estimated) + queued messages + link ------------------------------------------------------
do $$ declare r jsonb; v_book uuid; l jsonb; begin
  perform pg_temp.login('vr_coord@a.test');
  r := public.vendor_request_save(pg_temp.get('p1')::jsonb);
  perform pg_temp.su();
  perform pg_temp.put('r1', r ->> 'id'); perform pg_temp.put('tok1', r #>> '{link,token}');
  v_book := (r ->> 'booking_id')::uuid; perform pg_temp.put('b1', v_book::text);
  perform pg_temp.res('20 request sent: status sent, booking made (enquiry, cost = agreed, vendor set)',
    r ->> 'status' = 'sent' and exists (select 1 from public.event_resources b where b.id = v_book and b.status = 'enquiry' and b.cost = 18000
      and b.vendor_id = pg_temp.get('v1')::uuid and b.org_id = 'a0000000-0000-4000-8000-000000000001'), r::text);
  perform pg_temp.res('21 ledger: the booking is an Estimated line at the agreed amount (not committed)',
    (pg_temp.line(v_book) ->> 'estimated')::numeric = 18000 and pg_temp.line(v_book) -> 'committed' = 'null'::jsonb, pg_temp.line(v_book)::text);
  perform pg_temp.res('22 one e-mail + one WhatsApp row QUEUED (pending), contact from the vendor card',
    (select count(*) from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.status = 'pending') = 2
    and exists (select 1 from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.channel = 'email' and s.recipient = 'orders@deccan.test')
    and exists (select 1 from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.channel = 'whatsapp' and s.recipient = '+919876543210'));
  perform pg_temp.res('23 the link is 64 hex, only its sha-256 is stored, it expires',
    (r #>> '{link,token}') ~ '^[0-9a-f]{64}$'
    and exists (select 1 from public.vendor_request_links k where k.token_hash = encode(sha256(convert_to(r #>> '{link,token}', 'UTF8')), 'hex')
                  and k.expires_at > now() + interval '90 days' and k.expires_at < now() + interval '181 days')
    and not exists (select 1 from public.vendor_request_links k where k.token_hash = r #>> '{link,token}'));
  perform pg_temp.res('24 the coordinator sees the agreed amount (vendors edit = money)', (r ->> 'agreed_amount')::numeric = 18000 and r ->> 'can_money' = 'true');
  perform pg_temp.login('vr_crew@a.test');
  l := public.vendor_requests_list('a0000000-0000-4000-8000-00000000da01', null);
  perform pg_temp.su();
  perform pg_temp.res('25 crew can see the request but not the money', jsonb_array_length(l) = 1 and l -> 0 -> 'agreed_amount' = 'null'::jsonb
    and l -> 0 -> 'invoices' = '[]'::jsonb, l::text);
  perform pg_temp.login('vr_coord@b.test');
  l := public.vendor_requests_list(null, null);
  perform pg_temp.su();
  perform pg_temp.res('26 another studio lists none of them', jsonb_array_length(l) = 0, l::text);
  perform pg_temp.login('vr_coord@a.test');
  perform pg_temp.res('27 one live request per booking', pg_temp.err(format('select public.vendor_request_save(%L::jsonb)',
    (pg_temp.get('p1')::jsonb || jsonb_build_object('booking_id', v_book))::text)) like '23505%');
  perform pg_temp.su();
end $$;

-- ---- 3) the vendor's link: view, reject needs a comment, accept ---------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.anon();
  r := public.vendor_link_get(pg_temp.get('tok1'));
  perform pg_temp.su();
  perform pg_temp.res('30 the link shows the request (what, when, where, agreed) and the studio',
    r ->> 'ok' = 'true' and r ->> 'what' = 'Chairs' and r ->> 'where_text' = 'Lawn gate 2' and (r ->> 'agreed_amount')::numeric = 18000
    and r ->> 'studio' = 'Studio A' and r ->> 'can_respond' = 'true' and r ->> 'can_invoice' = 'false', r::text);
  perform pg_temp.res('31 the link shows no client, no booking id, no other vendor',
    position('Alice' in r::text) = 0 and not (r ? 'booking_id') and not (r ? 'quote_id') and position('Royal' in r::text) = 0, r::text);
  perform pg_temp.anon();
  r := public.vendor_link_get(repeat('a', 64));
  e := pg_temp.err(format('select public.vendor_link_respond(%L, %L, null)', pg_temp.get('tok1'), 'reject'));
  perform pg_temp.su();
  perform pg_temp.res('32 a wrong token shows nothing', r ->> 'ok' = 'false', r::text);
  perform pg_temp.res('33 declining needs a comment', e like '22023%', e);
  perform pg_temp.anon();
  r := public.vendor_link_respond(pg_temp.get('tok1'), 'accept', 'Will deliver by 3 pm');
  perform pg_temp.su();
  perform pg_temp.res('34 accepted from the link: status, note, via link',
    r ->> 'status' = 'accepted' and r ->> 'can_invoice' = 'true'
    and exists (select 1 from public.vendor_requests x where x.id = pg_temp.get('r1')::uuid and x.responded_via = 'link' and x.response_note = 'Will deliver by 3 pm'), r::text);
  perform pg_temp.res('35 booking confirmed -> Committed at the agreed amount in the ledger',
    exists (select 1 from public.event_resources b where b.id = pg_temp.get('b1')::uuid and b.status = 'confirmed' and b.cost = 18000)
    and (pg_temp.line(pg_temp.get('b1')::uuid) ->> 'committed')::numeric = 18000, pg_temp.line(pg_temp.get('b1')::uuid)::text);
  perform pg_temp.res('36 a 0241 delivery assignment was added for the time (r21 reminder engine)',
    exists (select 1 from public.delivery_commitments d join public.vendor_requests x on x.delivery_id = d.id
             where x.id = pg_temp.get('r1')::uuid and d.party_kind = 'vendor' and d.vendor_id = pg_temp.get('v1')::uuid and d.status = 'scheduled'
               and d.booking_id = pg_temp.get('b1')::uuid and d.contact_email = 'orders@deccan.test'));
  perform pg_temp.res('37 Helm posted in the event chat (@ admins + coordinators) and the bell',
    exists (select 1 from public.chat_messages m where m.conversation_id = pg_temp.get('cv')::uuid and m.kind = 'system'
             and m.body like '%Deccan Rentals accepted: Chairs x120%' and m.meta -> 'mentions' @> to_jsonb(pg_temp.get('crd'))
             and m.meta -> 'mentions' @> to_jsonb(pg_temp.get('adm')) and position('18000' in m.body) = 0)
    and exists (select 1 from public.notifications n where n.detail ->> 'source' = '0256' and n.detail ->> 'event' = 'accepted'));
  perform pg_temp.anon();
  r := public.vendor_link_respond(pg_temp.get('tok1'), 'reject', 'changed my mind');
  perform pg_temp.su();
  perform pg_temp.res('38 an answered request cannot be answered again from the link', r ->> 'ok' = 'false' and r ->> 'reason' = 'closed'
    and exists (select 1 from public.vendor_requests x where x.id = pg_temp.get('r1')::uuid and x.status = 'accepted'), r::text);
  perform pg_temp.res('39 every step is in the request log', (select count(*) from public.vendor_request_log l where l.request_id = pg_temp.get('r1')::uuid) >= 3);
end $$;

-- ---- 4) invoices: upload grant, GST rules, uniqueness ---------------------------------------------------------------
do $$ declare g jsonb; e text; r jsonb; begin
  perform pg_temp.anon();
  e := pg_temp.err(format('select public.vendor_invoice_upload(%L, %L)', pg_temp.get('tok1'), 'text/html'));
  perform pg_temp.res('40 only PDF / images may be uploaded', e like '22023%', e);
  g := public.vendor_invoice_upload(pg_temp.get('tok1'), 'application/pdf');
  perform pg_temp.put('path1', g ->> 'path');
  perform pg_temp.res('41 the grant names a private org / event / request key', g ->> 'bucket' = 'vendor-invoices'
    and (g ->> 'path') like 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || pg_temp.get('r1') || '/%.pdf', g::text);
  e := pg_temp.err(format('select public.vendor_invoice_submit(%L, %L::jsonb)', pg_temp.get('tok1'),
    jsonb_build_object('invoice_no', 'DR/101', 'invoice_date', current_date::text, 'taxable_amount', 15000, 'cgst', 1350, 'sgst', 1350,
      'vendor_gstin', '36ABCDE1234F1Z5', 'file_path', g ->> 'path')::text));
  perform pg_temp.res('42 submit before the file arrived is refused', e like '22023%', e);
  -- the storage upload itself, as the anonymous link holder (the insert policy checks the grant)
  e := pg_temp.err(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'vendor-invoices', g ->> 'path'));
  perform pg_temp.res('43 anon may write exactly the granted key', e = '', e);
  e := pg_temp.err(format('insert into storage.objects(bucket_id, name) values (%L, %L)', 'vendor-invoices',
    'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || pg_temp.get('r1') || '/' || gen_random_uuid() || '.pdf'));
  perform pg_temp.res('44 anon may not write any other key', e like '42501%', e);
  e := pg_temp.err(format('select public.vendor_invoice_submit(%L, %L::jsonb)', pg_temp.get('tok1'),
    jsonb_build_object('invoice_no', 'DR/101', 'invoice_date', current_date::text, 'taxable_amount', 15000, 'cgst', 1350, 'igst', 2700,
      'vendor_gstin', '36ABCDE1234F1Z5', 'file_path', g ->> 'path')::text));
  perform pg_temp.res('45 IGST and CGST together are refused', e like '22023%', e);
  e := pg_temp.err(format('select public.vendor_invoice_submit(%L, %L::jsonb)', pg_temp.get('tok1'),
    jsonb_build_object('invoice_no', 'DR/101', 'invoice_date', current_date::text, 'taxable_amount', 15000, 'cgst', 1350, 'sgst', 1350, 'file_path', g ->> 'path')::text));
  perform pg_temp.res('46 GST without a GSTIN is refused', e like '22023%', e);
  e := pg_temp.err(format('select public.vendor_invoice_submit(%L, %L::jsonb)', pg_temp.get('tok1'),
    jsonb_build_object('invoice_no', 'THIS-NUMBER-IS-TOO-LONG', 'invoice_date', current_date::text, 'taxable_amount', 15000, 'file_path', g ->> 'path')::text));
  perform pg_temp.res('47 an invoice number over 16 characters is refused', e like '22023%', e);
  r := public.vendor_invoice_submit(pg_temp.get('tok1'), jsonb_build_object('invoice_no', 'dr/101', 'invoice_date', current_date::text,
         'taxable_amount', 15000, 'cgst', 1350, 'sgst', 1350, 'vendor_gstin', '36abcde1234f1z5', 'notes', 'Chairs + delivery', 'file_path', g ->> 'path'));
  perform pg_temp.su();
  perform pg_temp.res('48 invoice submitted: number upper-cased, total = taxable + GST, FY set, grant used',
    r ->> 'submitted' = 'DR/101'
    and exists (select 1 from public.vendor_invoices i where i.request_id = pg_temp.get('r1')::uuid and i.invoice_no = 'DR/101' and i.total_amount = 17700
                  and i.status = 'submitted' and i.vendor_gstin = '36ABCDE1234F1Z5' and i.fy = public._vr256_fy(current_date))
    and exists (select 1 from public.vendor_invoice_grants x where x.path = pg_temp.get('path1') and x.used_at is not null), r::text);
  perform pg_temp.res('49 the vendor sees their invoice + status on the link', r -> 'invoices' -> 0 ->> 'status' = 'submitted'
    and not (r -> 'invoices' -> 0 ? 'storage_path'), r::text);
  perform pg_temp.res('4A Helm told the team a new invoice is waiting', exists (select 1 from public.chat_messages m
    where m.conversation_id = pg_temp.get('cv')::uuid and m.body like '%sent invoice DR/101 for Chairs x120%'));
  -- the same number again in the same financial year
  perform pg_temp.anon();
  g := public.vendor_invoice_upload(pg_temp.get('tok1'), 'image/png');
  perform pg_temp.su(); insert into storage.objects(bucket_id, name) values ('vendor-invoices', g ->> 'path'); perform pg_temp.put('path2', g ->> 'path');
  perform pg_temp.anon();
  e := pg_temp.err(format('select public.vendor_invoice_submit(%L, %L::jsonb)', pg_temp.get('tok1'),
    jsonb_build_object('invoice_no', 'DR/101', 'invoice_date', current_date::text, 'taxable_amount', 1000, 'file_path', g ->> 'path')::text));
  perform pg_temp.su();
  perform pg_temp.res('4B the same invoice number twice in a financial year is refused', e like '23505%', e);
  perform pg_temp.res('4C FY: 15/03/2027 -> 2026-27, 01/04/2027 -> 2027-28', public._vr256_fy('2027-03-15') = '2026-27' and public._vr256_fy('2027-04-01') = '2027-28');
end $$;

-- ---- 5) review: access, query -> resubmit, over-agreed gate, approve -> bill -> ledger, payments --------------------
do $$ declare i1 uuid; e text; r jsonb; g jsonb; i2 uuid; v_bill uuid; begin
  select id into i1 from public.vendor_invoices where request_id = pg_temp.get('r1')::uuid and invoice_no = 'DR/101';
  perform pg_temp.login('vr_coord@a.test');
  e := pg_temp.err(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', i1, 'approve', '{}'));
  perform pg_temp.res('50 a coordinator without Finance edit cannot approve', e like '42501%', e);
  perform pg_temp.login('vr_fin@a.test');
  e := pg_temp.err(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', i1, 'query', '{}'));
  perform pg_temp.res('51 a query needs a note for the vendor', e like '22023%', e);
  r := public.vendor_invoice_review(i1, 'query', 'Please add the delivery challan number', '{}');
  perform pg_temp.res('52 queried', r ->> 'status' = 'queried', r::text);
  perform pg_temp.su();
  -- the vendor resubmits a corrected invoice with the same number
  perform pg_temp.anon();
  r := public.vendor_link_get(pg_temp.get('tok1'));
  perform pg_temp.res('53 the vendor sees the query note', r -> 'invoices' -> 0 ->> 'review_note' = 'Please add the delivery challan number', r::text);
  r := public.vendor_invoice_submit(pg_temp.get('tok1'), jsonb_build_object('invoice_no', 'DR/101', 'invoice_date', current_date::text,
         'taxable_amount', 20000, 'cgst', 1800, 'sgst', 1800, 'vendor_gstin', '36ABCDE1234F1Z5', 'notes', 'Challan 778', 'file_path', pg_temp.get('path2'), 'replaces_id', i1));
  perform pg_temp.su();
  select id into i2 from public.vendor_invoices where request_id = pg_temp.get('r1')::uuid and status = 'submitted';
  perform pg_temp.res('54 the resubmission supersedes the queried invoice (kept)', i2 is not null
    and exists (select 1 from public.vendor_invoices where id = i1 and status = 'superseded')
    and exists (select 1 from public.vendor_invoices where id = i2 and replaces_id = i1 and total_amount = 23600), r::text);
  perform pg_temp.res('55 a submitted invoice cannot be edited (guard)', pg_temp.err(format('update public.vendor_invoices set total_amount = 1 where id = %L', i2)) like '42501%');
  perform pg_temp.login('vr_fin@a.test');
  e := pg_temp.err(format('select public.vendor_invoice_review(%L, %L, null, %L::jsonb)', i2, 'approve', '{}'));
  perform pg_temp.res('56 above the agreed amount (23,600 > 18,000) needs the explicit tick', e like '23514%', e);
  r := public.vendor_invoice_review(i2, 'approve', null, '{"allow_over": true, "tds_section": "194C", "tds_amount": 400}');
  perform pg_temp.su();
  v_bill := (r ->> 'bill_id')::uuid; perform pg_temp.put('bill', v_bill::text);
  perform pg_temp.res('57 approved -> one vendor bill (amount, GST, booking, vendor, number)',
    r ->> 'status' = 'approved' and r ->> 'pay_status' = 'due'
    and exists (select 1 from public.vendor_bills b where b.id = v_bill and b.amount = 23600 and b.gst_amount = 3600 and b.bill_no = 'DR/101'
                  and b.booking_id = pg_temp.get('b1')::uuid and b.vendor_id = pg_temp.get('v1')::uuid and b.status = 'open'), r::text);
  perform pg_temp.res('58 ledger: the booking''s Actual = the bill less claimable GST (20,000), input tax 3,600',
    (pg_temp.line(pg_temp.get('b1')::uuid) ->> 'actual')::numeric = 20000 and (pg_temp.line(pg_temp.get('b1')::uuid) ->> 'input_tax')::numeric = 3600
    and (pg_temp.line(pg_temp.get('b1')::uuid) ->> 'bills')::int = 1, pg_temp.line(pg_temp.get('b1')::uuid)::text);
  perform pg_temp.res('59 TDS kept on the invoice (information only)', exists (select 1 from public.vendor_invoices where id = i2 and tds_section = '194C' and tds_amount = 400));
  perform pg_temp.login('vr_fin@a.test');
  e := pg_temp.err(format('select public.vendor_invoice_review(%L, %L, %L, %L::jsonb)', i2, 'reject', 'too late', '{}'));
  perform pg_temp.res('5A an approved invoice cannot be reviewed again', e like '22023%', e);
  -- a part payment through the existing payout RPC
  perform public.record_vendor_payout(v_bill, 10000, current_date, 'upi', 'UTR123', 'vr-test-1');
  r := public.vendor_requests_list('a0000000-0000-4000-8000-00000000da01', null);
  perform pg_temp.su();
  perform pg_temp.res('5B part payment -> partial, balance 13,600', (select x from jsonb_array_elements(r -> 0 -> 'invoices') x where x ->> 'status' = 'approved') ->> 'pay_status' = 'partial'
    and ((select x from jsonb_array_elements(r -> 0 -> 'invoices') x where x ->> 'status' = 'approved') ->> 'balance')::numeric = 13600, r::text);
  perform pg_temp.res('5C event P&L bills due = 13,600 (closure "vendor amount unsettled")',
    to_regprocedure('public._vb_event_pnl(uuid,uuid)') is null
    or coalesce((public._vb_event_pnl('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001') ->> 'bills_due')::numeric, -1) = 13600,
    coalesce(public._vb_event_pnl('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001')::text, 'no fn'));
  -- storage read: finance yes, crew no, other studio no
  perform pg_temp.login('vr_fin@a.test');
  perform pg_temp.res('5D Finance can read the invoice file', public.vendor_invoice_file_visible(pg_temp.get('path2')));
  perform pg_temp.login('vr_crew@a.test');
  perform pg_temp.res('5E crew cannot read the invoice file', not public.vendor_invoice_file_visible(pg_temp.get('path2')));
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('5F another studio cannot read the invoice file', not public.vendor_invoice_file_visible(pg_temp.get('path2')));
  perform pg_temp.su();
end $$;

-- ---- 6) reassign + cancel ---------------------------------------------------------------------------------------------
do $$ declare r jsonb; n jsonb; e text; b uuid; begin
  perform pg_temp.login('vr_coord@a.test');
  e := pg_temp.err(format('select public.vendor_request_reassign(%L, %L, null, null)', pg_temp.get('r1'), pg_temp.get('v2')));
  perform pg_temp.res('60 a vendor who already invoiced cannot be reassigned', e like '22023%', e);
  r := public.vendor_request_save(pg_temp.get('p1')::jsonb || jsonb_build_object('what', 'Tent 40x60', 'qty', 1, 'agreed_amount', 50000));
  perform pg_temp.put('r2', r ->> 'id'); perform pg_temp.put('tok2', r #>> '{link,token}'); b := (r ->> 'booking_id')::uuid; perform pg_temp.put('b2', b::text);
  perform pg_temp.su();
  perform pg_temp.anon();
  r := public.vendor_link_respond(pg_temp.get('tok2'), 'reject', 'Fully booked that day');
  perform pg_temp.su();
  perform pg_temp.res('61 declined with a comment (kept on the request, announced)', r ->> 'status' = 'rejected' and r ->> 'response_note' = 'Fully booked that day'
    and exists (select 1 from public.chat_messages m where m.conversation_id = pg_temp.get('cv')::uuid and m.body like '%Deccan Rentals declined: Tent 40x60 x1 - Fully booked that day%'), r::text);
  perform pg_temp.login('vr_coord@a.test');
  n := public.vendor_request_reassign(pg_temp.get('r2')::uuid, pg_temp.get('v2')::uuid, 52000, 'Deccan is full');
  perform pg_temp.su();
  perform pg_temp.put('r3', n ->> 'id'); perform pg_temp.put('tok3', n #>> '{link,token}');
  perform pg_temp.res('62 reassigned: new request to Royal Tents on the SAME booking, old one kept + linked',
    n ->> 'status' = 'sent' and n ->> 'vendor_name' = 'Royal Tents' and (n ->> 'booking_id')::uuid = b and (n ->> 'replaces_id')::uuid = pg_temp.get('r2')::uuid
    and exists (select 1 from public.vendor_requests x where x.id = pg_temp.get('r2')::uuid and x.status = 'rejected' and x.replaced_by = (n ->> 'id')::uuid), n::text);
  perform pg_temp.res('63 the booking moved to the new vendor at the new amount (back to enquiry), old values logged',
    exists (select 1 from public.event_resources x where x.id = b and x.vendor_id = pg_temp.get('v2')::uuid and x.cost = 52000 and x.status = 'enquiry')
    and exists (select 1 from public.vendor_request_log l where l.request_id = pg_temp.get('r2')::uuid and l.event = 'booking_moved' and l.note like '%Deccan Rentals -> Royal Tents%'));
  perform pg_temp.res('64 the old vendor''s link can no longer answer', (public.vendor_link_respond(pg_temp.get('tok2'), 'accept', null)) ->> 'ok' = 'false');
  -- accept, then reassign an ACCEPTED request (its delivery assignment is cancelled)
  perform pg_temp.login('vr_coord@a.test');
  r := public.vendor_request_set_status(pg_temp.get('r3')::uuid, 'accepted', 'Confirmed by phone');
  perform pg_temp.su();
  perform pg_temp.res('65 a planner can record the answer given by phone', r ->> 'status' = 'accepted' and r ->> 'responded_via' = 'studio' and r ->> 'delivery_id' is not null, r::text);
  perform pg_temp.put('d3', r ->> 'delivery_id');
  perform pg_temp.login('vr_coord@a.test');
  n := public.vendor_request_reassign(pg_temp.get('r3')::uuid, pg_temp.get('v3')::uuid, null, null);
  perform pg_temp.su();
  perform pg_temp.res('66 reassigning an accepted request: old = reassigned, its delivery cancelled; Sound Co has no e-mail -> nothing queued',
    exists (select 1 from public.vendor_requests x where x.id = pg_temp.get('r3')::uuid and x.status = 'reassigned')
    and exists (select 1 from public.delivery_commitments d where d.id = pg_temp.get('d3')::uuid and d.status = 'cancelled')
    and (n ->> 'agreed_amount')::numeric = 52000 and (n ->> 'queued')::int = 0
    and not exists (select 1 from public.vendor_request_sends s where s.request_id = (n ->> 'id')::uuid), n::text);
  perform pg_temp.login('vr_coord@a.test');
  e := pg_temp.err(format('select public.vendor_request_cancel(%L, %L)', n ->> 'id', 'x'));
  perform pg_temp.res('67 cancelling needs a reason', e like '22023%', e);
  r := public.vendor_request_cancel((n ->> 'id')::uuid, 'Client dropped the tent');
  perform pg_temp.su();
  perform pg_temp.res('68 cancelled: the booking made for it is cancelled too (kept) -> off the ledger',
    r ->> 'status' = 'cancelled' and exists (select 1 from public.event_resources x where x.id = b and x.status = 'cancelled')
    and pg_temp.line(b) is null, r::text);
  perform pg_temp.res('69 a closed request cannot be re-opened (guard)', pg_temp.err(format('update public.vendor_requests set status = %L where id = %L', 'sent', n ->> 'id')) like '22023%');
end $$;

-- ---- 7) reminders, "No reply" notice, the dispatcher claim ------------------------------------------------------------
do $$ declare r jsonb; t jsonb; c jsonb; v_id uuid; begin
  perform pg_temp.login('vr_coord@a.test');
  r := public.vendor_request_save(pg_temp.get('p1')::jsonb || jsonb_build_object('what', 'Lights', 'agreed_amount', 9000, 'vendor_id', pg_temp.get('v2')));
  perform pg_temp.su();
  v_id := (r ->> 'id')::uuid; perform pg_temp.put('r4', v_id::text);
  -- 25 hours later, not answered
  update public.vendor_requests set created_at = now() - interval '25 hours', respond_by = now() + interval '20 hours' where id = v_id;
  perform pg_temp.svc(); t := public.vendor_requests_tick(); t := public.vendor_requests_tick(); perform pg_temp.su();
  perform pg_temp.res('70 a reminder is queued 24 h after sending, once (dedupe)',
    (select count(*) from public.vendor_request_sends s where s.request_id = v_id and s.kind = 'reminder' and s.channel = 'email') = 1, t::text);
  update public.vendor_requests set respond_by = now() - interval '1 minute' where id = v_id;
  perform pg_temp.svc(); t := public.vendor_requests_tick(); t := public.vendor_requests_tick(); perform pg_temp.su();
  perform pg_temp.res('71 no reply by the reply-by time -> ONE "No reply" notice in chat + bell',
    (select count(*) from public.chat_messages m where m.conversation_id = pg_temp.get('cv')::uuid and m.body like '%No reply from Royal Tents to the request for Lights%') = 1
    and exists (select 1 from public.vendor_requests x where x.id = v_id and x.no_response_at is not null)
    and exists (select 1 from public.notifications n where n.detail ->> 'event' = 'no_response'), t::text);
  perform pg_temp.svc(); c := public.vendor_request_claim(50, 'email'); perform pg_temp.su();
  perform pg_temp.res('72 the dispatcher gets the pending e-mails of open requests, each with a fresh link',
    exists (select 1 from jsonb_array_elements(c) x where x ->> 'what' = 'Lights' and x ->> 'token' ~ '^[0-9a-f]{64}$' and x ->> 'channel' = 'email')
    and not exists (select 1 from jsonb_array_elements(c) x where x ->> 'channel' = 'whatsapp'), c::text);
  perform pg_temp.res('73 answered / closed requests are skipped at claim time (recheck)',
    not exists (select 1 from jsonb_array_elements(c) x where x ->> 'what' in ('Chairs', 'Tent 40x60'))
    and exists (select 1 from public.vendor_request_sends s where s.request_id = pg_temp.get('r1')::uuid and s.channel = 'email' and s.reason = 'recheck'), c::text);
  perform pg_temp.res('74 WhatsApp rows stay queued (dormant lane)',
    exists (select 1 from public.vendor_request_sends s where s.request_id = pg_temp.get('r2')::uuid and s.channel = 'whatsapp' and s.status = 'pending'));
  perform pg_temp.svc(); perform public.vendor_request_mark((c -> 0 ->> 'id')::uuid, 'sent'); perform pg_temp.su();
  perform pg_temp.res('75 mark sent', exists (select 1 from public.vendor_request_sends s where s.id = (c -> 0 ->> 'id')::uuid and s.status = 'sent'));
  perform pg_temp.login('vr_coord@a.test');
  r := public.vendor_requests_summary('a0000000-0000-4000-8000-00000000da01');
  perform pg_temp.su();
  perform pg_temp.res('76 workspace summary: 1 awaiting (late), 1 accepted, 1 approved invoice unpaid',
    (r ->> 'awaiting')::int = 1 and (r ->> 'late')::int = 1 and (r ->> 'accepted')::int = 1 and (r ->> 'invoices_unpaid')::int = 1
    and (r ->> 'invoices_to_review')::int = 0, r::text);
end $$;

-- ---- 8) sample events, free trials, expiry ---------------------------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.su();
  update public.quotes set is_demo = true where id = 'a0000000-0000-4000-8000-00000000da01';
  perform pg_temp.login('vr_coord@a.test');
  r := public.vendor_request_save(pg_temp.get('p1')::jsonb || jsonb_build_object('what', 'Demo plates', 'agreed_amount', 100));
  perform pg_temp.su();
  perform pg_temp.res('80 a sample event never queues a message (skipped: sample_event)',
    (r ->> 'queued')::int = 0 and not exists (select 1 from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.status = 'pending')
    and exists (select 1 from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.reason = 'sample_event'), r::text);
  update public.quotes set is_demo = false where id = 'a0000000-0000-4000-8000-00000000da01';
  update public.vendor_request_links set expires_at = now() - interval '1 minute' where token_hash = encode(sha256(convert_to(pg_temp.get('tok1'), 'UTF8')), 'hex');
  perform pg_temp.anon();
  r := public.vendor_link_get(pg_temp.get('tok1'));
  perform pg_temp.su();
  perform pg_temp.res('81 an expired link shows nothing', r ->> 'ok' = 'false', r::text);
end $$;

do $$ declare r jsonb; u uuid; t uuid; tq uuid := gen_random_uuid(); tv uuid; begin
  -- an active free trial: the request works (link to copy) but no e-mail / WhatsApp is ever queued
  perform pg_temp.su(); select id into u from auth.users where email = 'vr_trial@t.test';
  if u is null then u := auth.seed_user('vr_trial@t.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'vr_trial@t.test', 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login('vr_trial@t.test');
  r := public.start_self_serve_trial('T vr', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); t := (r ->> 'org_id')::uuid;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values (tq, 'T-0001', 'Trial event', 'confirmed', '{}'::jsonb, '{}'::jsonb, 1, 'none', t, now(), now());
  insert into public.vendors(id, name, email, phone, org_id) values (gen_random_uuid(), 'Trial Vendor', 'tv@vendor.test', '+919811111111', t) returning id into tv;
  perform pg_temp.login('vr_trial@t.test');
  r := public.vendor_request_save(jsonb_build_object('quote_id', tq, 'vendor_id', tv, 'what', 'Chairs', 'when_at', (now() + interval '3 days')::text, 'agreed_amount', 1000));
  perform pg_temp.su();
  perform pg_temp.res('82 free trial: request + link work, every message is skipped (trial_no_send)',
    r ->> 'status' = 'sent' and (r #>> '{link,token}') ~ '^[0-9a-f]{64}$' and (r ->> 'queued')::int = 0
    and (select count(*) from public.vendor_request_sends s where s.request_id = (r ->> 'id')::uuid and s.status = 'skipped' and s.reason = 'trial_no_send') = 2, r::text);
end $$;

select name, result from _dr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R23-VENDORS-0256: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-VENDORS-0256: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _dr;
rollback;
