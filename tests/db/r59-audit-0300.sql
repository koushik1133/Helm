-- r59-audit-0300.sql -- R59 audit fixes (0300): pricing checked + gated + audited and never written straight through
-- the API; the access matrix / studio billing details only for the right people; known matrix areas only; privacy PIN
-- reset needs a fresh two-step code; more audit redaction; the vendor link names the event by type; vendor invoice
-- files checked on the server; chat quote cards rebuilt from the real quote; search / chat directory privacy; the
-- WhatsApp test target and the billing e-mail rule. Each finding proven fixed + the legitimate path still works.
-- Re-applies 0300 twice (re-run safe). Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
set client_min_messages = error;
\ir ../../supabase/migrations/0300_r59_settings_money_hardening.sql
\ir ../../supabase/migrations/0300_r59_settings_money_hardening.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.claims(p_email text, p_aal2 boolean default false) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  if p_aal2 then perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', 'aal2', 'amr',
    jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now())))))::text, false); end if;
  execute 'reset role'; end $$;   -- claims only: the caller stays the database owner (server-side writes as that person)
create or replace function pg_temp.as_user(p_email text, p_aal2 boolean default false) returns void language plpgsql as $$
begin perform pg_temp.claims(p_email, p_aal2); execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at, full_name)
    values (u, p_email, p_role, p_org, false, now(), initcap(split_part(p_email, '@', 1)))
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name;
  return u;
end $$;

-- ---- setup: Studio A admin / sales (fixture), + a coordinator with nothing switched on -----------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.member('a_coord@a.test', 'coordinator', 'a0000000-0000-4000-8000-000000000001');
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    select 'coordinator', a, false, false, 'a0000000-0000-4000-8000-000000000001', now()
      from unnest(array['quotes', 'finance', 'users', 'controls', 'discount_approve']) a
    on conflict (role, area, org_id) do update set can_view = false, can_edit = false;
  update public.profiles set full_name = 'Asha Admin' where id = pg_temp.uid('a_admin@a.test');
  update public.profiles set full_name = 'Sanjay Sales' where id = pg_temp.uid('a_staff@a.test');
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) objects + grants -----------------------------------------------------------------------------------------
do $$ declare f text; ok boolean := true; bad text := ''; begin
  perform pg_temp.su();
  foreach f in array array['set_pricing_config__pre0300(jsonb)', 'admin_get_role_access__pre0300()', 'my_studio_account__pre0300()',
      'admin_set_role_access__pre0300(text,text,boolean,boolean)', 'privacy_pin_reset__pre0300()', '_audit_redact__pre0300(jsonb,boolean)',
      '_vr256_public__pre0300(public.vendor_requests)', 'studio_search__pre0300(text,integer)', 'chat_directory__pre0300()',
      'upload_scan_bucket__pre0300(text)'] loop
    if to_regprocedure('public.' || f) is null or has_function_privilege('authenticated', 'public.' || f, 'execute')
       or has_function_privilege('anon', 'public.' || f, 'execute') then ok := false; bad := bad || f || ' '; end if;
  end loop;
  perform pg_temp.res('01 every re-issued function kept once as *__pre0300, not callable by the app', ok, bad);
  perform pg_temp.res('02 grants: wa test target for signed-in people only; billing e-mail + helpers never from the app',
    has_function_privilege('authenticated', 'public.integrations_wa_test_target()', 'execute')
    and not has_function_privilege('anon', 'public.integrations_wa_test_target()', 'execute')
    and not has_function_privilege('authenticated', 'public.studio_billing_email(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.studio_billing_email(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.studio_billing_email(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r300_keep(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r300_pricing_clean(jsonb)', 'execute'));
  perform pg_temp.res('03 the live functions are still callable as before (same grants)',
    has_function_privilege('authenticated', 'public.set_pricing_config(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.admin_get_role_access()', 'execute')
    and has_function_privilege('authenticated', 'public.my_studio_account()', 'execute')
    and has_function_privilege('authenticated', 'public.studio_search(text,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.chat_directory()', 'execute')
    and has_function_privilege('authenticated', 'public.privacy_pin_reset()', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) F-2 pricing --------------------------------------------------------------------------------------------------
do $$ declare v jsonb; e text; n int; begin
  perform pg_temp.as_user('a_admin@a.test');
  v := pg_temp.j($q$select public.set_pricing_config('{"chairPrice": 250, "platePrice": "900", "gstPct": 18, "serviceChargePct": 5, "assetPrices": {"stage": 45000, "tent": "1200"}, "taxCountry": "IN"}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('04 an admin saves good pricing; numeric text is stored as a number',
    not (v ? 'err') and (select jsonb_typeof(c.value -> 'platePrice') = 'number' and (c.value ->> 'platePrice')::numeric = 900
                                 and jsonb_typeof(c.value -> 'assetPrices' -> 'tent') = 'number'
                            from public.app_config c where c.org_id = 'a0000000-0000-4000-8000-000000000001' and c.key = 'pricing'), v::text);
  perform pg_temp.res('05 the save is audited with old -> new for each changed field',
    exists (select 1 from public.audit_log a where a.org_id = 'a0000000-0000-4000-8000-000000000001' and a.action = 'pricing.update'
             and a.actor = pg_temp.uid('a_admin@a.test') and (a.changed -> 'chairPrice' ->> 'new')::numeric = 250 and a.changed -> 'chairPrice' ? 'old'
             and (a.changed -> 'assetPrices' ->> 'changed_items')::int >= 2));
  perform pg_temp.as_user('a_admin@a.test');
  e := pg_temp.try($q$select public.set_pricing_config('{"chairPrice": -1}'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('{"platePrice": "abc"}'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('{"gstPct": 29}'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('{"serviceChargePct": 26}'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('{"assetPrices": {"stage": -5}}'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('[1,2]'::jsonb)$q$) || ' | '
    || pg_temp.try($q$select public.set_pricing_config('{"gstPct": true}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('06 negative / text / GST over 28 / service charge over 25 / negative item price / not an object / boolean: all refused (22023)',
    (select count(*) from regexp_split_to_table(e, ' \| ') x where x like '22023%') = 7, e);
  perform pg_temp.res('07 a refused save changes nothing (still the admin''s 250)',
    (select (c.value ->> 'chairPrice')::numeric from public.app_config c where c.org_id = 'a0000000-0000-4000-8000-000000000001' and c.key = 'pricing') = 250);
  perform pg_temp.res('08 GST 28 / service charge 25 / zero prices are still allowed (the edges)',
    (select pg_temp.j($q$select public._r300_pricing_clean('{"gstPct": 28, "cateringGstPct": 0, "serviceChargePct": 25, "chairPrice": 0, "layoutBase": 100000000, "conflictBufferHours": 48}'::jsonb)$q$) ? 'gstPct'));
  -- sales has Settings edit in the fixture but not "Approve discounts"
  perform pg_temp.as_user('a_staff@a.test');
  e := pg_temp.try($q$select public.set_pricing_config('{"gstPct": 0}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('09 Settings edit WITHOUT "Approve discounts" cannot change pricing (42501)', e like '42501%Approve discounts%', e);
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('sales', 'discount_approve', true, true, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  perform pg_temp.as_user('a_staff@a.test');
  v := pg_temp.j($q$select public.set_pricing_config('{"chairPrice": 260, "gstPct": 18}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('10 ... and can once "Approve discounts" is switched on for the role', not (v ? 'err'), v::text);
  perform pg_temp.as_user('a_coord@a.test');
  e := pg_temp.try($q$select public.set_pricing_config('{"chairPrice": 1}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('11 no Settings edit: refused as before (42501)', e like '42501%', e);
  -- direct writes through the API (RLS "cfg write")
  perform pg_temp.as_user('a_admin@a.test');
  e := pg_temp.try($q$update public.app_config set value = '{"gstPct": 0}'::jsonb where key = 'pricing' and org_id = 'a0000000-0000-4000-8000-000000000001'$q$) || ' | '
    || pg_temp.try($q$delete from public.app_config where key = 'pricing' and org_id = 'a0000000-0000-4000-8000-000000000001'$q$) || ' | '
    || pg_temp.try($q$update public.app_config set key = 'pricing_x' where key = 'pricing' and org_id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.su();
  perform pg_temp.res('12 the pricing row cannot be updated, deleted or renamed straight through the API (42501)',
    (select count(*) from regexp_split_to_table(e, ' \| ') x where x like '42501%') = 3
    and (select (c.value ->> 'gstPct')::numeric from public.app_config c where c.org_id = 'a0000000-0000-4000-8000-000000000001' and c.key = 'pricing') = 18, e);
  perform pg_temp.as_user('a_admin@a.test');
  e := pg_temp.try($q$insert into public.app_config(org_id, key, value) values ('a0000000-0000-4000-8000-000000000001', 'r59_other_key', '{}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('13 other settings rows are unaffected by the pricing guard', e = '', e);
  update public.app_config set value = value || '{"r59": 1}'::jsonb where org_id = 'a0000000-0000-4000-8000-000000000001' and key = 'pricing';
  get diagnostics n = row_count;
  perform pg_temp.res('14 the database itself (migrations, cron, service code) can still write it', n = 1);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) F-3 + F-4 + F-9a ----------------------------------------------------------------------------------------------
do $$ declare e text; n int; v jsonb; w jsonb; begin
  perform pg_temp.as_user('a_coord@a.test'); e := pg_temp.try('select count(*) from public.admin_get_role_access()'); perform pg_temp.su();
  perform pg_temp.res('15 the access matrix is refused to a member without Users view (42501)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test'); select count(*) into n from public.admin_get_role_access(); perform pg_temp.su();
  perform pg_temp.res('16 ... and still answers a studio admin, own studio only',
    n > 0 and n = (select count(*) from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001'));
  insert into public.studio_account(org_id, gstin, billing_address, legal_business_name, primary_contact_email, primary_contact_name, city)
    values ('a0000000-0000-4000-8000-000000000001', '36ABCDE1234F1Z5', '1 Main Road', 'A Events Pvt Ltd', 'boss@a.test', 'Boss', 'Hyderabad')
    on conflict (org_id) do update set gstin = excluded.gstin, billing_address = excluded.billing_address,
      legal_business_name = excluded.legal_business_name, primary_contact_email = excluded.primary_contact_email, primary_contact_name = excluded.primary_contact_name, city = excluded.city;
  perform pg_temp.as_user('a_coord@a.test'); v := pg_temp.j('select public.my_studio_account()'); perform pg_temp.su();
  perform pg_temp.as_user('a_admin@a.test'); w := pg_temp.j('select public.my_studio_account()'); perform pg_temp.su();
  perform pg_temp.res('17 a member without Finance / Users rights gets no GSTIN, billing address, legal name or contact e-mails',
    not (v ? 'err') and not (v ? 'gstin') and not (v ? 'billing_address') and not (v ? 'legal_business_name') and not (v ? 'primary_contact_email')
    and not (v ? 'primary_contact_phone') and v ->> 'city' = 'Hyderabad' and (v ->> 'can_edit')::boolean = false, v::text);
  perform pg_temp.res('18 the admin still gets everything', w ->> 'gstin' = '36ABCDE1234F1Z5' and w ->> 'billing_address' = '1 Main Road'
    and w ->> 'primary_contact_email' = 'boss@a.test' and (w ->> 'can_edit')::boolean, w::text);
  perform pg_temp.as_user('a_staff@a.test'); v := pg_temp.j('select public.my_studio_account()'); perform pg_temp.su();
  perform pg_temp.res('19 Finance view (sales in the fixture) still sees the billing details (pays the bills)', v ->> 'gstin' = '36ABCDE1234F1Z5', v::text);
  perform pg_temp.as_user('a_admin@a.test');
  e := pg_temp.try($q$select public.admin_set_role_access('sales', 'junk_area', true, true)$q$) || ' | '
    || pg_temp.try($q$select public.admin_set_role_access('sales', 'Leads; drop', true, true)$q$);
  v := pg_temp.j($q$select to_jsonb(public.admin_set_role_access('sales', 'leads', true, false))$q$);
  perform pg_temp.su();
  perform pg_temp.res('20 an unknown area name is refused (22023), no junk row stored',
    (select count(*) from regexp_split_to_table(e, ' \| ') x where x like '22023%') = 2
    and not exists (select 1 from public.role_access where area in ('junk_area', 'Leads; drop')), e);
  perform pg_temp.res('21 a known area is still saved', not (v ? 'err') and v ->> 'area' = 'leads', v::text);
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'legacy_x', true, false, 'a0000000-0000-4000-8000-000000000001', now());
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j($q$select to_jsonb(public.admin_set_role_access('sales', 'legacy_x', false, false))$q$); perform pg_temp.su();
  perform pg_temp.res('22 an area the studio already has a row for can still be switched (old rows stay editable)', not (v ? 'err'), v::text);
  perform pg_temp.as_user('a_staff@a.test'); e := pg_temp.try($q$select public.admin_set_role_access('sales', 'leads', true, true)$q$); perform pg_temp.su();
  perform pg_temp.res('23 a non-admin still cannot change the matrix (42501)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test'); e := pg_temp.try($q$select public.admin_set_role_access('sales', 'finance', false, false)$q$); perform pg_temp.su();
  perform pg_temp.res('24 the 0285 money-switch two-step still applies underneath (R35_*)', e like '42501%R35_%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) F-9b privacy PIN reset ----------------------------------------------------------------------------------------
do $$ declare e text; v jsonb; begin
  perform pg_temp.su();
  delete from auth.mfa_factors where user_id = pg_temp.uid('a_admin@a.test');
  perform pg_temp.as_user('a_admin@a.test'); e := pg_temp.try('select public.privacy_pin_reset()'); perform pg_temp.su();
  perform pg_temp.res('25 PIN reset by an admin with no two-step set up: refused (R35_SETUP_2STEP), even right after sign-in', e like '42501%R35_SETUP_2STEP%', e);
  insert into auth.mfa_factors(user_id, status) values (pg_temp.uid('a_admin@a.test'), 'verified');
  perform pg_temp.as_user('a_admin@a.test'); e := pg_temp.try('select public.privacy_pin_reset()'); perform pg_temp.su();
  perform pg_temp.res('26 two-step set up but no fresh code (aal1): refused (42501 - not even in the studio until the code is entered)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', true); v := pg_temp.j('select public.privacy_pin_reset()'); perform pg_temp.su();
  perform pg_temp.res('27 with a fresh two-step code: reset to 0000 and audited', (v ->> 'ok')::boolean and (v ->> 'is_default')::boolean
    and exists (select 1 from public.audit_log a where a.action = 'privacy_pin.reset' and a.actor = pg_temp.uid('a_admin@a.test') and (a.changed ->> 'two_step')::boolean), v::text);
  perform pg_temp.as_user('a_staff@a.test', true); e := pg_temp.try('select public.privacy_pin_reset()'); perform pg_temp.su();
  perform pg_temp.res('28 a non-admin still cannot reset (42501)', e like '42501%', e);
  delete from auth.mfa_factors where user_id = pg_temp.uid('a_admin@a.test');   -- test only (rolled back): back to a plain admin
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) E-08 redaction + E-06 vendor link + E-05 invoice files ----------------------------------------------------
do $$ declare v jsonb; r public.vendor_requests; e text; v_obj uuid; v_path text; begin
  perform pg_temp.su();
  v := public._audit_redact('{"mail_key_hash": "h1", "key_secret": "s", "webhook_secret": "w", "upi_id": "x@upi", "anything_hash": "z", "name": "Kept", "token": "t"}'::jsonb, false);
  perform pg_temp.res('29 audit redaction hides mail_key_hash, key_secret, webhook_secret, upi_id, *_hash (and still token); other fields kept',
    v ->> 'mail_key_hash' = '[redacted]' and v ->> 'key_secret' = '[redacted]' and v ->> 'webhook_secret' = '[redacted]' and v ->> 'upi_id' = '[redacted]'
    and v ->> 'anything_hash' = '[redacted]' and v ->> 'token' = '[redacted]' and v ->> 'name' = 'Kept', v::text);
  v := public._audit_redact('{"upi_id": ["a@upi", "b@upi"]}'::jsonb, true);
  perform pg_temp.res('30 a diff pair is redacted on both sides', v -> 'upi_id' = '["[redacted]", "[redacted]"]'::jsonb, v::text);

  update public.quotes set title = 'Priya Sharma wedding', event_type = 'wedding' where id = 'a0000000-0000-4000-8000-00000000da01';
  insert into public.vendor_requests(org_id, quote_id, vendor_name, what, when_at, agreed_amount, respond_by, status)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', 'Tent Co', 'Tent', now() + interval '10 days', 5000, now() + interval '2 days', 'accepted')
    returning * into r;
  v := public._vr256_public(r);
  perform pg_temp.res('31 the public vendor link shows the event TYPE, never the quote title with the client''s name',
    v ->> 'event' = 'Wedding' and position('Priya' in v::text) = 0 and position('Sharma' in v::text) = 0 and v ? 'event_date' and (v ->> 'ok')::boolean, v::text);
  update public.quotes set event_type = 'Sharma family function' where id = 'a0000000-0000-4000-8000-00000000da01';
  v := public._vr256_public(r);
  perform pg_temp.res('32 a free-text event type (could hold a name) reads just "Event"', v ->> 'event' = 'Event', v::text);
  perform pg_temp.res('33 vendor-invoices is part of the upload check', public.upload_scan_bucket('vendor-invoices') and public.upload_scan_bucket('event-docs')
    and not public.upload_scan_bucket('somewhere-else'));

  insert into _kv values ('rid', r.id::text);
  v_path := 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/' || r.id::text || '/' || gen_random_uuid()::text || '.pdf';
  insert into _kv values ('path', v_path);
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-1', current_date, '2026-27', 100, 100, %L, 'application/pdf')$q$, r.id, v_path));
  perform pg_temp.res('34 an invoice whose file never arrived is refused (22023)', e like '22023%', e);
  insert into storage.buckets(id, name) values ('vendor-invoices', 'vendor-invoices') on conflict (id) do nothing;
  insert into storage.objects(bucket_id, name, metadata) values ('vendor-invoices', v_path, '{"mimetype": "text/html", "size": 2000}') returning id into v_obj;
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-2', current_date, '2026-27', 100, 100, %L, 'application/pdf')$q$, r.id, v_path));
  perform pg_temp.res('35 a file uploaded as text/html behind a .pdf name is refused (22023)', e like '22023%type does not match%', e);
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-3', current_date, '2026-27', 100, 100, %L, 'image/png')$q$, r.id, v_path));
  perform pg_temp.res('36 a row claiming PNG for a .pdf file is refused', e like '22023%', e);
  update storage.objects set metadata = '{"mimetype": "application/pdf", "size": 20000000}' where id = v_obj;
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-4', current_date, '2026-27', 100, 100, %L, 'application/pdf')$q$, r.id, v_path));
  perform pg_temp.res('37 a file over 10 MB is refused', e like '22023%10 MB%', e);
  update storage.objects set metadata = '{"mimetype": "application/pdf", "size": 20000}' where id = v_obj;
  update public.upload_scans set status = 'rejected' where object_id = v_obj;
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-5', current_date, '2026-27', 100, 100, %L, 'application/pdf')$q$, r.id, v_path));
  perform pg_temp.res('38 a file the upload check rejected is refused (and the new object was queued for the check)', e like '22023%refused by the upload check%', e);
  update public.upload_scans set status = 'pending' where object_id = v_obj;
  e := pg_temp.try(format($q$insert into public.vendor_invoices(org_id, quote_id, request_id, invoice_no, invoice_date, fy, taxable_amount, total_amount, storage_path, mime)
         values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000000da01', %L, 'INV-6', current_date, '2026-27', 100, 100, %L, 'application/pdf')$q$, r.id, v_path));
  perform pg_temp.res('39 a real PDF invoice is still accepted', e = '' and exists (select 1 from public.vendor_invoices where invoice_no = 'INV-6'), e);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- existing vendor invoice files are grandfathered as clean by a (re-)run
do $$ declare v_obj uuid; begin
  perform pg_temp.su();
  set local session_replication_role = replica;   -- an object stored before 0300 had no upload_scans row
  insert into storage.objects(bucket_id, name, metadata) values ('vendor-invoices', 'r59-old/file.pdf', '{"mimetype": "application/pdf"}') returning id into v_obj;
  set local session_replication_role = origin;
  insert into _kv values ('oldobj', v_obj::text);
exception when others then perform pg_temp.su(); insert into _rs values ('4y', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
set client_min_messages = error;
\ir ../../supabase/migrations/0300_r59_settings_money_hardening.sql
set client_min_messages = warning;
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('40 an invoice file stored before 0300 is grandfathered clean (stays visible), nothing deleted',
    exists (select 1 from public.upload_scans where object_id = (select v from _kv where k = 'oldobj')::uuid and status = 'clean')
    and exists (select 1 from storage.objects where id = (select v from _kv where k = 'oldobj')::uuid));
exception when others then perform pg_temp.su(); insert into _rs values ('4z', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) BS-04 chat quote cards ---------------------------------------------------------------------------------------
do $$ declare c uuid; m jsonb; e text; begin
  perform pg_temp.su();
  insert into public.chat_conversations(org_id, kind, title) values ('a0000000-0000-4000-8000-000000000001', 'group', 'Everyone r59') returning id into c;
  insert into _kv values ('conv', c::text);
  perform pg_temp.claims('a_staff@a.test');
  insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
    values (c, 'a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_staff@a.test'), 'card', '',
            jsonb_build_object('kind', 'quote', 'ref_id', 'a0000000-0000-4000-8000-00000000da01', 'code', 'FAKE-9', 'title', 'Quote Rs 1',
                               'total', 1, 'client', 'Someone', 'status', 'paid'))
    returning meta into m;
  perform pg_temp.su();
  perform pg_temp.res('41 a forged quote card is rebuilt from the real quote: real code / title, no total, no client',
    m ->> 'code' = 'A-0001' and m ->> 'kind' = 'quote' and not (m ? 'total') and not (m ? 'client') and m ->> 'title' <> 'Quote Rs 1', m::text);
  perform pg_temp.claims('a_staff@a.test');
  e := pg_temp.try(format($q$insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
         values (%L, 'a0000000-0000-4000-8000-000000000001', %L, 'card', '', '{"kind": "quote", "ref_id": "b0000000-0000-4000-8000-00000000da01"}')$q$, c, pg_temp.uid('a_staff@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('42 a card pointing at another studio''s quote is refused', e like '22023%', e);
  perform pg_temp.claims('a_coord@a.test');
  e := pg_temp.try(format($q$insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
         values (%L, 'a0000000-0000-4000-8000-000000000001', %L, 'card', '', '{"kind": "quote", "ref_id": "a0000000-0000-4000-8000-00000000da01"}')$q$, c, pg_temp.uid('a_coord@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('43 someone who cannot view Quotes cannot post a quote card (42501)', e like '42501%', e);
  perform pg_temp.claims('a_staff@a.test');
  e := pg_temp.try(format($q$insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
         values (%L, 'a0000000-0000-4000-8000-000000000001', %L, 'text', 'hello', '{"kind": "layout", "ref_id": "x"}')$q$, c, pg_temp.uid('a_staff@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('44 other messages / cards are untouched by the quote-card rule', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) BS-05 search + BS-06 directory ------------------------------------------------------------------------------
do $$ declare v jsonb; n int; nm int; begin
  perform pg_temp.su();
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j($q$select public.studio_search('Sanjay', 5)$q$); perform pg_temp.su();
  perform pg_temp.res('45 an active member is found under Team', jsonb_array_length(coalesce(v -> 'team', '[]')) = 1, v::text);
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (pg_temp.uid('a_staff@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now())
    on conflict (user_id, org_id) do update set status = 'deactivated';
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j($q$select public.studio_search('Sanjay', 5)$q$); perform pg_temp.su();
  perform pg_temp.res('46 a deactivated member is no longer listed under Team', jsonb_array_length(coalesce(v -> 'team', '[]')) = 0 and not (v ? 'err'), v::text);
  update public.team_member_status set status = 'active', deactivated_at = null where user_id = pg_temp.uid('a_staff@a.test');   -- test only (rolled back)

  perform pg_temp.as_user('a_coord@a.test');
  select count(*), count(email_name) into n, nm from public.chat_directory();
  perform pg_temp.su();
  perform pg_temp.res('47 chat directory for a member without Users view: every teammate, no e-mail local part', n >= 3 and nm = 0, n || ' / ' || nm);
  perform pg_temp.as_user('a_admin@a.test');
  select count(*), count(email_name) into n, nm from public.chat_directory();
  perform pg_temp.su();
  perform pg_temp.res('48 an admin still gets the e-mail local part', n >= 3 and nm = n, n || ' / ' || nm);
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) F-1 WhatsApp test target + E-03 billing e-mail + F-5 labels -------------------------------------------------
do $$ declare v jsonb; e text; t text; begin
  perform pg_temp.su();
  perform pg_temp.as_user('a_staff@a.test'); e := pg_temp.try('select public.integrations_wa_test_target()'); perform pg_temp.su();
  perform pg_temp.res('49 the WhatsApp test target is refused to a non-admin (42501), even with Settings edit', e like '42501%', e);
  insert into public.comms_settings(org_id, studio_whatsapp) values ('a0000000-0000-4000-8000-000000000001', '15550001111')
    on conflict (org_id) do update set studio_whatsapp = excluded.studio_whatsapp;
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j('select public.integrations_wa_test_target()'); perform pg_temp.su();
  perform pg_temp.res('50 a number that is nobody''s on the team is not a test target', v ->> 'reason' = 'not_team_number' and not (v ? 'studio_whatsapp'), v::text);
  insert into public.member_profiles(user_id, phone) values (pg_temp.uid('a_staff@a.test'), '+919800000001')
    on conflict (user_id) do update set phone = excluded.phone;
  update public.comms_settings set studio_whatsapp = '919800000001' where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j('select public.integrations_wa_test_target()'); perform pg_temp.su();
  perform pg_temp.res('51 a teammate''s own saved mobile is a valid target (admin)', (v ->> 'ok')::boolean and v ->> 'studio_whatsapp' = '919800000001', v::text);
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (pg_temp.uid('a_staff@a.test'), 'a0000000-0000-4000-8000-000000000001', 'deactivated', now())
    on conflict (user_id, org_id) do update set status = 'deactivated';
  perform pg_temp.as_user('a_admin@a.test'); v := pg_temp.j('select public.integrations_wa_test_target()'); perform pg_temp.su();
  perform pg_temp.res('52 a deactivated member''s mobile is no longer a target', v ->> 'reason' = 'not_team_number', v::text);
  update public.team_member_status set status = 'active', deactivated_at = null where user_id = pg_temp.uid('a_staff@a.test');

  update public.organizations set business_email = 'someone-else@evil.test', business_email_confirmed = false where id = 'a0000000-0000-4000-8000-000000000001';
  t := public.studio_billing_email('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('53 billing mail never goes to an UNCONFIRMED studio e-mail (falls back to the owner / an admin login)',
    t is distinct from 'someone-else@evil.test' and t in (select u.email from auth.users u join public.profiles p on p.id = u.id
                                                          where p.org_id = 'a0000000-0000-4000-8000-000000000001' and p.role = 'admin'), coalesce(t, 'null'));
  update public.organizations set business_email = 'studio@a.test' where id = 'a0000000-0000-4000-8000-000000000001';
  update public.organizations set business_email_confirmed = true where id = 'a0000000-0000-4000-8000-000000000001';   -- (a new address starts unconfirmed)
  perform pg_temp.res('54 a CONFIRMED studio e-mail is used', public.studio_billing_email('a0000000-0000-4000-8000-000000000001') = 'studio@a.test');
  perform pg_temp.as_user('a_admin@a.test'); e := pg_temp.try($q$select public.studio_billing_email('a0000000-0000-4000-8000-000000000001')$q$); perform pg_temp.su();
  perform pg_temp.res('55 the billing e-mail rule is not callable from the app', e like '42501%', e);

  perform pg_temp.res('56 no live database function says "Control Center" to people any more (comments aside)',
    not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname !~ '__pre[0-9]'
                 and position('Control Center' in regexp_replace(p.prosrc, '--[^\n]*', '', 'g')) > 0));
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.su();
select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R59-AUDIT-0300: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R59-AUDIT-0300: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
