-- audit-run2.sql — 0042 security audit run 2 fixes (RC-1, 2, 3, 4, 5, 7, 8, 9, 10).
-- For every fix: an allowed case, a denied case, Org A own resource vs Org A → Org B,
-- and the authorized role vs a lower role. Fixture: a_admin / a_staff (sales) in studio A,
-- b_admin / b_staff in studio B. ONE transaction, rolled back at the end. Phones are fake.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ar(n serial, name text, result text); grant all on _ar to anon, authenticated;
grant usage on sequence _ar_n_seq to anon, authenticated;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
-- "signed in as X" claims while staying the database owner (a definer / trigger path)
create or replace function pg_temp.claims(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email)::text, false);
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _ar(name, result) values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate||' '||sqlerrm; end $$;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR:'||sqlstate||' '||sqlerrm; end $$;
create or replace function pg_temp.put(p_k text, p_v text) returns void language sql as $$
  insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.try(text), pg_temp.val(text), pg_temp.uid(text), pg_temp.put(text,text), pg_temp.get(text) to anon, authenticated;

-- ---- setup (owner) -------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  -- quote A2 / A3 (studio A) + B2 (studio B) with their own approval links
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at)
  values
   ('a0000000-0000-4000-8000-00000042a002', 'A-0422', 'Party A2', 'quote', '{"name":"Ann"}', '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}', 1, 'sent',
    'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000004200a2', current_date + 30, now(), now()),
   ('a0000000-0000-4000-8000-00000042a003', 'A-0423', 'Party A3', 'quote', '{"name":"Ali"}', '{"subtotal":200000,"discount":0,"gstPct":18,"total":236000}', 1, 'sent',
    'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000004200a3', current_date + 30, now(), now()),
   ('b0000000-0000-4000-8000-00000042b002', 'B-0422', 'Party B2', 'quote', '{"name":"Bo"}', '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}', 1, 'sent',
    'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000004200b2', current_date + 30, now(), now());
  update public.quotes set event_date = current_date + 30 where id in ('a0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-00000000da01');
  -- dev echo ON for both studios (allowed here by the fixture's helm_env_settings row)
  insert into public.app_config(key, value, org_id) values
    ('channels', '{"otp_dev_echo":true,"sms_live":false}', 'a0000000-0000-4000-8000-000000000001'),
    ('channels', '{"otp_dev_echo":true,"sms_live":false}', 'b0000000-0000-4000-8000-000000000001')
  on conflict (org_id, key) do update set value = excluded.value;
  -- a 'crew'-like lower role in studio A: role_access gives it nothing
  perform auth.seed_user('a_crew@a.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (pg_temp.uid('a_crew@a.test'), 'a_crew@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001', false, now())
    on conflict (id) do update set role = 'crew', org_id = excluded.org_id;
end $$;

-- =====================================================================================
-- RC-1 C-01: NULL / malformed OTP code
-- =====================================================================================
do $$ declare j jsonb; n int; a int; begin
  perform pg_temp.anon();
  j := public.request_otp('a0000000-0000-4000-8000-0000004200a2', '9000004201');
  perform pg_temp.put('codeA2', j ->> 'dev_code');
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a2', '9000004201', null, true, 'v1', 'I agree', 'Ann', 'ua');
  perform pg_temp.su();
  select attempts into a from public.quote_otps where quote_id = 'a0000000-0000-4000-8000-00000042a002' order by created_at desc limit 1;
  select count(*) into n from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-00000042a002';
  perform pg_temp.res('RC1-01 denied: anon NULL code is a wrong code (attempt counted, no consent)',
    not coalesce((j ->> 'approved')::boolean, true) and j ->> 'error' = 'incorrect_code' and a = 1 and n = 0, j::text||' attempts='||a||' consents='||n);
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a2', '9000004201', '', true, 'v1', 'I agree', 'Ann', 'ua');
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a2', '9000004201', '12345a', true, 'v1', 'I agree', 'Ann', 'ua');
  perform pg_temp.su();
  select attempts into a from public.quote_otps where quote_id = 'a0000000-0000-4000-8000-00000042a002' order by created_at desc limit 1;
  select count(*) into n from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-00000042a002';
  perform pg_temp.res('RC1-02 denied: empty and "12345a" codes rejected the same way', j ->> 'error' = 'incorrect_code' and a = 3 and n = 0, j::text||' a='||a);
end $$;
do $$ declare j jsonb; v boolean; begin
  perform pg_temp.anon();
  j := public.verify_and_consent('b0000000-0000-4000-8000-0000004200b2', '9000004201', pg_temp.get('codeA2'), true, 'v1', 'I agree', 'Ann', 'ua');
  perform pg_temp.su();
  perform pg_temp.res('RC1-03 Org B link + Org A code: nothing approved on either quote',
    not coalesce((j ->> 'approved')::boolean, true)
    and (select approval_status from public.quotes where id = 'a0000000-0000-4000-8000-00000042a002') = 'sent'
    and (select approval_status from public.quotes where id = 'b0000000-0000-4000-8000-00000042b002') = 'sent',
    j::text||(select string_agg(id::text||'='||approval_status, ',') from public.quotes where id in ('a0000000-0000-4000-8000-00000042a002','b0000000-0000-4000-8000-00000042b002')));
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a2', '9000004201', pg_temp.get('codeA2'), true, 'v1', 'I agree', 'Ann', 'ua');
  perform pg_temp.su();
  select c.verified_via_otp into v from public.quote_consents c where c.quote_id = 'a0000000-0000-4000-8000-00000042a002';
  perform pg_temp.res('RC1-04 allowed: Org A link + the right code approves', coalesce((j ->> 'approved')::boolean, false), j::text);
  perform pg_temp.res('RC1-05 a code shown on screen (dev echo) is recorded verified_via_otp = false', v is false, coalesce(v::text, '∅'));
end $$;
do $$ declare j jsonb; i int; begin
  perform pg_temp.anon();
  j := public.request_otp('a0000000-0000-4000-8000-0000004200a3', '9000004301');
  for i in 1..5 loop
    perform pg_temp.anon();
    j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a3', '9000004301', null, true, 'v1', 'x', 'Ali', 'ua');
  end loop;
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a3', '9000004301', null, true, 'v1', 'x', 'Ali', 'ua');
  perform pg_temp.res('RC1-06 denied: 5 NULL attempts lock the code', j ->> 'error' = 'locked', j::text);
  perform pg_temp.anon();
  j := public.verify_and_consent('a0000000-0000-4000-8000-0000004200a3', '9000004301', '000000', true, 'v1', 'x', 'Ali', 'ua');
  perform pg_temp.res('RC1-07 denied: after the lock even a 6-digit guess is refused', j ->> 'error' = 'locked', j::text);
  perform pg_temp.res('RC1-08 static: the base NULL path is unreachable (wrapper checks p_code first)',
    pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure) like '%p_code is null or p_code !~%', '');
end $$;

-- =====================================================================================
-- RC-1 C-11: dev echo fail-closed (helm_env_settings)
-- =====================================================================================
do $$ declare s text; j jsonb; begin perform pg_temp.su();
  delete from public.helm_env_settings where key = 'allow_otp_dev_echo';      -- like production
  update public.app_config set value = '{"sms_live":false}' where key = 'channels' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.app_config set value = value || '{"otp_dev_echo":true}' where key = 'channels'$q$);
  perform pg_temp.res('RC1-09 denied: an admin (controls edit) can''t switch dev echo on without the env setting', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.app_config set value = value || '{"sms_live":false,"email_live":false}' where key = 'channels'$q$);
  perform pg_temp.res('RC1-10 allowed: other channel settings still save', s = '', s);
  perform pg_temp.anon();
  j := public.request_otp('b0000000-0000-4000-8000-0000004200b2', '9000004401');   -- B still has the old echo=true row
  perform pg_temp.res('RC1-11 denied: an existing echo=true row gives no code without the env setting',
    j -> 'dev_code' = 'null'::jsonb and j ->> 'delivery' = 'unavailable', j::text);
  perform pg_temp.res('RC1-12 helm_env_settings: no API access (anon / authenticated)',
    not has_table_privilege('authenticated', 'public.helm_env_settings', 'select')
    and not has_table_privilege('anon', 'public.helm_env_settings', 'select')
    and not has_table_privilege('authenticated', 'public.helm_env_settings', 'insert'), '');
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.val($q$with u as (update public.app_config set value = '{}' where key = 'channels' and org_id = 'a0000000-0000-4000-8000-000000000001' returning 1) select count(*) from u$q$);
  perform pg_temp.res('RC1-13 Org B admin can''t write Org A app_config (0 rows)', s = '0', s);
  perform pg_temp.su();
  insert into public.helm_env_settings(key, value) values ('allow_otp_dev_echo', 'true');          -- staging
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$update public.app_config set value = value || '{"otp_dev_echo":true}' where key = 'channels'$q$);
  perform pg_temp.res('RC1-14 allowed: with the staging env setting the admin can switch echo on', s = '', s);
  perform pg_temp.anon();
  j := public.request_otp('a0000000-0000-4000-8000-0000000000aa', '9000004501');
  perform pg_temp.res('RC1-15 allowed: staging returns the dev code', length(coalesce(j ->> 'dev_code', '')) = 6, j::text);
exception when others then perform pg_temp.res('RC1-C11 block crashed', false, sqlerrm);
end $$;

-- =====================================================================================
-- RC-1 f4b/f5a: open OTPs expire on revoke / new link / shelf
-- =====================================================================================
do $$ declare j jsonb; s text; tok uuid; begin
  perform pg_temp.anon();
  j := public.request_otp('a0000000-0000-4000-8000-0000004200a3', '9000004302');
  perform pg_temp.put('codeA3', j ->> 'dev_code');
  perform pg_temp.su();
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.revoke_approval_token('a0000000-0000-4000-8000-00000042a003')$q$);
  perform pg_temp.res('RC4-01 denied: revoke needs quotes edit (sales with quotes edit removed)', s like '42501%', s);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.revoke_approval_token('a0000000-0000-4000-8000-00000042a003')$q$);
  perform pg_temp.res('RC4-02 denied: Org B admin can''t revoke an Org A link', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.revoke_approval_token('a0000000-0000-4000-8000-00000042a003')$q$);
  perform pg_temp.su();
  perform pg_temp.res('RC1-16 allowed: admin revoke expires every open OTP of the quote',
    s = '' and not exists (select 1 from public.quote_otps where quote_id = 'a0000000-0000-4000-8000-00000042a003'
                             and verified_at is null and expires_at > now()), s);
  perform pg_temp.login('a_admin@a.test');
  tok := public.generate_approval_token('a0000000-0000-4000-8000-00000042a003');
  perform pg_temp.anon();
  j := public.verify_and_consent(tok, '9000004302', pg_temp.get('codeA3'), true, 'v1', 'x', 'Ali', 'ua');
  perform pg_temp.res('RC1-17 denied: a code issued before the revoke doesn''t work on the new link', j ->> 'error' = 'no_active_code', j::text);
end $$;

-- =====================================================================================
-- RC-10: per-link limit before the shared studio counter
-- =====================================================================================
do $$ declare i int; s text; n_before int; n_after int; ok2 boolean; begin perform pg_temp.su();
  delete from public.quote_otps where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  select coalesce(sum(hits), 0) into n_before from public.messaging_rate where org_id = 'a0000000-0000-4000-8000-000000000001' and channel = 'sms';
  update public.quotes set client = client || '{"phone":"+91 90000 04601"}' where id = 'a0000000-0000-4000-8000-00000000da01';
  for i in 1..50 loop       -- each edge call is its own request: authorise, then (after the SMS) store
    begin perform public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '919000004601'); exception when others then null; end;
    begin perform public.admin_store_otp('a0000000-0000-4000-8000-0000000000aa', '919000004601', lpad(i::text, 6, '0')); exception when others then null; end;
  end loop;
  select coalesce(sum(hits), 0) into n_after from public.messaging_rate where org_id = 'a0000000-0000-4000-8000-000000000001' and channel = 'sms';
  s := pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '919000004601')$q$);
  perform pg_temp.res('RC10-01 denied: 50 sends on one link use at most 5 of the studio''s SMS budget',
    n_after - n_before <= 5 and s like 'HL429%', (n_after - n_before)||' '||s);
  s := pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000004200a2', '919000004201')$q$);
  perform pg_temp.res('D5-01 denied: no client mobile on file → no real SMS code (clear message)', s like 'HL403%mobile number on file%', s);
  update public.quotes set client = client || '{"phone":"9000004201"}' where id = 'a0000000-0000-4000-8000-00000042a002';
  s := pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000004200a2', '919000004299')$q$);
  perform pg_temp.res('D5-02 denied: a number other than the one on file', s like 'HL403%', s);
  update public.quotes set client = client || '{"phone":"9000004201"}' where id = 'a0000000-0000-4000-8000-00000042a002';
  update public.quotes set client = client || '{"phone":"9000004701"}' where id = 'b0000000-0000-4000-8000-00000000da01';
  s := pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000004200a2', '919000004201')$q$);
  perform pg_temp.res('RC10-02 allowed: another Org A client link is still authorised', s = '', s);
  s := pg_temp.try($q$select public.otp_send_authorize('b0000000-0000-4000-8000-0000000000bb', '919000004701')$q$);
  perform pg_temp.res('RC10-03 Org B link unaffected', s = '', s);
end $$;

-- =====================================================================================
-- RC-3: shelf gate on every client-link entry point; restore revives
-- =====================================================================================
do $$ declare s text; j jsonb; begin perform pg_temp.su();
  insert into public.event_proposal(quote_id, org_id, share_token, published)
    values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000004200fe', true)
    on conflict (quote_id) do update set share_token = excluded.share_token, published = true;
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')$q$);
  perform pg_temp.res('RC3-01 allowed: Org A approval link opens', s = '', s);
  perform pg_temp.login('a_staff@a.test');                -- sales: no delete right → can only archive
  s := pg_temp.try($q$select public.move_quote_to_shelf('a0000000-0000-4000-8000-00000000da01', 'archive')$q$);
  perform pg_temp.res('RC3-02 allowed: quotes-edit role moves the quote to Archive', s = '', s);
  perform pg_temp.anon();
  perform pg_temp.res('RC3-03 denied (shelf): public_get_quote',  pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')$q$) like '%expired%', '');
  perform pg_temp.anon();
  perform pg_temp.res('RC3-04 denied (shelf): public_get_portal', pg_temp.try($q$select public.public_get_portal('a0000000-0000-4000-8000-0000000000aa')$q$) like '%expired%', '');
  perform pg_temp.anon();
  perform pg_temp.res('RC3-05 denied (shelf): request_otp',       pg_temp.try($q$select public.request_otp('a0000000-0000-4000-8000-0000000000aa', '9000004801')$q$) like '%expired%', '');
  perform pg_temp.anon();
  perform pg_temp.res('RC3-06 denied (shelf): verify_and_consent', pg_temp.try($q$select public.verify_and_consent('a0000000-0000-4000-8000-0000000000aa', '9000004801', '123456', true, 'v', 'x', 'x', 'x')$q$) like '%expired%', '');
  perform pg_temp.anon();
  perform pg_temp.res('RC3-07 denied (shelf): create_payment',    pg_temp.try($q$select public.create_payment('a0000000-0000-4000-8000-0000000000aa')$q$) like '%expired%', '');
  perform pg_temp.anon();
  perform pg_temp.res('RC3-08 denied (shelf): public_get_proposal', pg_temp.try($q$select public.public_get_proposal('a0000000-0000-4000-8000-0000004200fe')$q$) like '%expired%', '');
  perform pg_temp.su();
  perform pg_temp.res('RC3-09 denied (shelf): payment_link_begin (service role)',
    public.payment_link_begin('a0000000-0000-4000-8000-0000000000aa', 60) ->> 'action' = 'invalid', '');
  perform pg_temp.res('RC3-10 denied (shelf): otp_send_authorize (service role)',
    pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '919000004801')$q$) like 'HL404%', '');
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.public_get_quote('b0000000-0000-4000-8000-0000000000bb')$q$);
  perform pg_temp.res('RC3-11 Org B link unaffected by Org A shelving', s = '', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.restore_quote_from_shelf('a0000000-0000-4000-8000-00000000da01')$q$);
  perform pg_temp.res('RC3-12 denied: Org B admin can''t restore an Org A quote', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  j := public.restore_quote_from_shelf('a0000000-0000-4000-8000-00000000da01');
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')$q$);
  perform pg_temp.res('RC3-13 allowed: after restore the link works again', s = '', s);
end $$;

-- =====================================================================================
-- RC-3: crew links die on deactivation; admin_revoke_work_links
-- =====================================================================================
do $$ declare s text; begin perform pg_temp.su();
  insert into public.crew_members(id, name, phone, org_id, active) values
    ('a0000000-0000-4000-8000-0000004200c1', 'Crew One', '+91 90000 05001', 'a0000000-0000-4000-8000-000000000001', true),
    ('a0000000-0000-4000-8000-0000004200c2', 'Crew Two', '+91 90000 05002', 'a0000000-0000-4000-8000-000000000001', true),
    ('b0000000-0000-4000-8000-0000004200c1', 'Crew B',   '+91 90000 05003', 'b0000000-0000-4000-8000-000000000001', true);
  insert into public.work_tokens(token, quote_id, phone, name, org_id) values
    ('a0000000-0000-4000-8000-0000004200d1', 'a0000000-0000-4000-8000-00000000da01', '+919000005001', 'Crew One', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000004200d2', 'a0000000-0000-4000-8000-00000000da01', '+919000005002', 'Crew Two', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000004200d3', 'a0000000-0000-4000-8000-00000000da01', '+919000005099', 'Ad hoc',   'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.res('RC9-01 the expiry trigger still stamps new crew links (definer path, no EXECUTE needed)',
    (select expires_at from public.work_tokens where token = 'a0000000-0000-4000-8000-0000004200d1') is not null, '');
  s := pg_temp.try($q$select public._work_token_live('a0000000-0000-4000-8000-0000004200d1')$q$);
  perform pg_temp.res('RC3-14 allowed: an active crew member''s link works', s = '', s);
  s := pg_temp.try($q$select public._work_token_live('a0000000-0000-4000-8000-0000004200d3')$q$);
  perform pg_temp.res('RC3-15 allowed: an ad-hoc number (no staff row) keeps working', s = '', s);
  perform pg_temp.login('a_admin@a.test');                         -- what Staff → Deactivate does
  update public.crew_members set active = false where id = 'a0000000-0000-4000-8000-0000004200c1';
  perform pg_temp.su();
  s := pg_temp.try($q$select public._work_token_live('a0000000-0000-4000-8000-0000004200d1')$q$);
  perform pg_temp.res('RC3-16 denied: after deactivation the link is revoked (row stamped, RPC refuses)',
    s like '42501%' and (select revoked_at from public.work_tokens where token = 'a0000000-0000-4000-8000-0000004200d1') is not null, s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.worker_get_tasks('a0000000-0000-4000-8000-0000004200d1')$q$);
  perform pg_temp.res('RC3-17 denied: worker_get_tasks on the revoked link', s <> '', s);
  perform pg_temp.login('a_admin@a.test');
  update public.crew_members set active = true where id = 'a0000000-0000-4000-8000-0000004200c1';
  perform pg_temp.su();
  perform pg_temp.res('RC3-18 reactivating does NOT revive the old link (revoked is final)',
    pg_temp.try($q$select public._work_token_live('a0000000-0000-4000-8000-0000004200d1')$q$) like '42501%', '');
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_revoke_work_links('a0000000-0000-4000-8000-0000004200c2')$q$);
  perform pg_temp.res('RC3-19 denied: a role without staff edit can''t revoke crew links', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_revoke_work_links('b0000000-0000-4000-8000-0000004200c1')$q$);
  perform pg_temp.res('RC3-20 denied: Org A admin on an Org B staff member', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.val($q$select public.admin_revoke_work_links('a0000000-0000-4000-8000-0000004200c2') ->> 'revoked'$q$);
  perform pg_temp.res('RC3-21 allowed: Org A admin revokes an Org A staff member''s links', s = '1', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.admin_revoke_work_links('a0000000-0000-4000-8000-0000004200c2')$q$);
  perform pg_temp.res('RC3-22 denied: visitors can''t call admin_revoke_work_links', s like '42501%', s);
  perform pg_temp.su();
  perform pg_temp.res('RC3-23 proof-upload grant check also applies the link age + shelf gate',
    pg_get_functiondef('public.task_proof_upload_ok(text)'::regprocedure) like '%link_age_expired(public.work_link_age_until(g.work_token))%'
    and pg_get_functiondef('public.task_proof_upload_ok(text)'::regprocedure) like '%_a42_quote_shelved%'
    and has_function_privilege('anon', 'public.task_proof_upload_ok(text)', 'execute'), '');
end $$;

-- =====================================================================================
-- RC-2: no bearer secrets in the bell; RC-8 notification studio
-- =====================================================================================
do $$ declare j jsonb; d jsonb; s text; begin perform pg_temp.su();
  alter table public.notifications disable trigger za_a42_notify_row;      -- a row stored before 0042
  insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
    values ('a0000000-0000-4000-8000-00000000da01', 'in_app', null, 'task_assigned', 'simulated',
            '{"count":2,"token":"a0000000-0000-4000-8000-0000004200d2","url":"https://x.test/work.html?t=secret"}', 'a0000000-0000-4000-8000-000000000001');
  alter table public.notifications enable trigger za_a42_notify_row;
  perform public._notify('a0000000-0000-4000-8000-00000000da01', 'sms', '+919000005002', 'approval_link',
                         '{"url":"https://x.test/approve.html?t=secret2","code":"A-0001"}');
  select n.detail into d from public.notifications n where n.kind = 'approval_link' order by n.created_at desc limit 1;
  perform pg_temp.res('RC2-01 new rows are stored without url / token (other keys kept)',
    not (d ? 'url') and not (d ? 'token') and d ->> 'code' = 'A-0001', coalesce(d::text, '∅'));
  perform pg_temp.login('a_admin@a.test');
  j := public.bell_feed(50);
  perform pg_temp.res('RC2-02 allowed: Org A admin still sees the item (kind, event code, other detail)',
    exists (select 1 from jsonb_array_elements(j -> 'items') i where i ->> 'kind' = 'task_assigned' and i ->> 'event_code' = 'A-0001'
              and (i -> 'detail' ->> 'count') = '2'), left(j::text, 300));
  perform pg_temp.res('RC2-03 denied: no bell item carries a token or url (even rows stored before 0042)',
    not exists (select 1 from jsonb_array_elements(j -> 'items') i where (i -> 'detail') ?| array['token', 'url']), left(j::text, 300));
  perform pg_temp.login('a_crew@a.test');                          -- lower role, same studio
  j := public.bell_feed(50);
  perform pg_temp.res('RC2-04 denied: a crew-role member''s bell has no token / url either',
    not exists (select 1 from jsonb_array_elements(j -> 'items') i where (i -> 'detail') ?| array['token', 'url']), left(j::text, 200));
  perform pg_temp.login('b_admin@b.test');
  j := public.bell_feed(50);
  perform pg_temp.res('RC2-05 Org B bell shows no Org A item',
    not exists (select 1 from jsonb_array_elements(j -> 'items') i where i ->> 'event_code' like 'A-%'), left(j::text, 200));
  perform pg_temp.su();
  s := pg_temp.try($q$insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
                     values ('a0000000-0000-4000-8000-00000000da01', 'in_app', 'payment', 'simulated', '{}', 'b0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('RC8-01 a notification about an Org A event is filed under Org A (not the caller''s studio)',
    s = '' and (select org_id from public.notifications where kind = 'payment' order by created_at desc limit 1) = 'a0000000-0000-4000-8000-000000000001', s);
end $$;

-- =====================================================================================
-- RC-8: audit rows carry the row's studio; hq.* rows no studio
-- =====================================================================================
do $$ declare v uuid; n int; begin
  perform pg_temp.claims('b_admin@b.test');                       -- signed in as Studio B, change reaches an Org A row
  update public.crew_members set notes = 'touched by B session' where id = 'a0000000-0000-4000-8000-0000004200c2';
  select a.org_id into v from public.audit_log a where a.entity = 'crew_members' and a.entity_id = 'a0000000-0000-4000-8000-0000004200c2'
   order by a.at desc limit 1;
  perform pg_temp.res('RC8-02 the audit row has the changed row''s studio (A), not the caller''s (B)',
    v = 'a0000000-0000-4000-8000-000000000001', coalesce(v::text, '∅'));
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.audit_log a where a.entity_id = 'a0000000-0000-4000-8000-0000004200c2';
  perform pg_temp.res('RC8-03 denied: Org B admin reads 0 of those rows', n = 0, n::text);
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.audit_log a where a.entity_id = 'a0000000-0000-4000-8000-0000004200c2' and a.changed ? 'notes';
  perform pg_temp.res('RC8-04 allowed: Org A admin reads it', n >= 1, n::text);
  perform pg_temp.claims('a_admin@a.test');
  insert into public.audit_log(actor, action, entity, entity_id) values (pg_temp.uid('a_admin@a.test'), 'hq.view', 'organizations', 'x');
  perform pg_temp.res('RC8-05 an hq.* audit row belongs to no studio',
    (select org_id from public.audit_log where action = 'hq.view' order by at desc limit 1) is null, '');
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.audit_log where action = 'hq.view';
  perform pg_temp.res('RC8-06 denied: no studio admin can read hq.* rows', n = 0, n::text);
  perform pg_temp.login('b_admin@b.test');                          -- signed-in B user opens an Org A approval link
  perform pg_temp.put('rc807', pg_temp.try($q$select public.request_otp('a0000000-0000-4000-8000-0000004200a2', '9000004201')$q$));
  perform pg_temp.su();
  perform pg_temp.res('RC8-07 an OTP requested on an Org A link by a Studio B session is filed under Org A',
    pg_temp.get('rc807') = ''
    and (select org_id from public.quote_otps where phone = '9000004201' order by created_at desc limit 1) = 'a0000000-0000-4000-8000-000000000001',
    pg_temp.get('rc807'));
end $$;

-- =====================================================================================
-- RC-4: stricter role checks, milestone amount rule, quotes delete / insert
-- =====================================================================================
do $$ declare s text; m uuid := 'a0000000-0000-4000-8000-0000004200e1'; st text; begin perform pg_temp.su();
  insert into public.payment_milestones(id, quote_id, org_id, label, amount, status, seq)
    values (m, 'a0000000-0000-4000-8000-00000042a002', 'a0000000-0000-4000-8000-000000000001', 'Advance', 100000, 'due', 1);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('select public.record_payment(%L, 1, %L, null, %L)', 'a0000000-0000-4000-8000-00000042a002', 'cash', m));
  perform pg_temp.su(); select status into st from public.payment_milestones where id = m;
  perform pg_temp.res('RC4-03 denied: a payment of 1 doesn''t mark a 100000 milestone paid', s = '' and st = 'due', s||' '||st);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('select public.record_payment(%L, 100000, %L, null, %L)', 'a0000000-0000-4000-8000-00000042a002', 'cash', m));
  perform pg_temp.su(); select status into st from public.payment_milestones where id = m;
  perform pg_temp.res('RC4-04 allowed: paying the full 100000 marks it paid', s = '' and st = 'paid', s||' '||st);
  perform pg_temp.login('a_staff@a.test');                    -- sales: finance edit, no settlement edit
  s := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000042a002', 10)$q$);
  perform pg_temp.res('RC4-05 denied: settlement payment needs finance AND settlement edit (sales)', s like '42501%', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000042a002', 10)$q$);
  perform pg_temp.res('RC4-06 denied: Org B admin on an Org A event', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000042a002', 10)$q$);
  perform pg_temp.res('RC4-07 allowed: Org A admin records a settlement payment', s = '', s);
end $$;
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');                    -- can_edit() true, but no closure edit
  s := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000042a002', true)$q$);
  perform pg_temp.res('RC4-08 denied: close_event needs closure edit (sales)', s like '42501%', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.set_closure('a0000000-0000-4000-8000-00000042a002', 5, 'x', null, false, null)$q$);
  perform pg_temp.res('RC4-09 denied: set_closure needs closure edit (sales)', s like '42501%', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000042a002', true)$q$);
  perform pg_temp.res('RC4-10 denied: Org B admin closes an Org A event', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000042a002', true)$q$);
  perform pg_temp.res('RC4-11 allowed: Org A admin closes the event', s = '', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000042a003', 'closed')$q$);
  perform pg_temp.res('RC4-12 denied for everyone: set_lifecycle_stage can''t jump to closed', s like '22023%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000042a003', 'planning')$q$);
  perform pg_temp.res('RC4-13 allowed: admin sets an ordinary stage', s = '', s);
  perform pg_temp.su();
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-00000042a003', 'resources')$q$);
  perform pg_temp.res('RC4-14 denied: set_lifecycle_stage needs quotes edit', s like '42501%', s);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  update public.profiles set role = 'manager' where email = 'a_staff@a.test';
  update public.role_access set can_edit = false where role = 'manager' and area = 'finance' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.mark_paid('a0000000-0000-4000-8000-00000042a002', 'ref')$q$);
  perform pg_temp.res('RC4-15 denied: mark_paid needs finance edit even for a manager', s like '42501%', s);
  perform pg_temp.su();
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
end $$;
do $$ declare n int; s text; begin perform pg_temp.su();
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at) values
    ('a0000000-0000-4000-8000-0000004200f1', 'A-0431', 'Draft F1', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', 'a0000000-0000-4000-8000-000000000001', now(), now()),
    ('b0000000-0000-4000-8000-0000004200f1', 'B-0431', 'Draft BF1', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none', 'b0000000-0000-4000-8000-000000000001', now(), now());
  perform pg_temp.login('a_staff@a.test');
  delete from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.login('a_admin@a.test');
  delete from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.su(); select count(*) into n from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.res('RC4-16 denied: a direct delete of a quote that is not on the Deleted shelf (sales and admin) → 0 rows', n = 1, n::text);
  update public.quotes set deleted_at = now() where id in ('a0000000-0000-4000-8000-0000004200f1', 'b0000000-0000-4000-8000-0000004200f1');
  perform pg_temp.login('a_staff@a.test');
  delete from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.su(); select count(*) into n from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.res('RC4-17 denied: sales (no can_delete) can''t hard-delete even from the shelf', n = 1, n::text);
  perform pg_temp.login('a_admin@a.test');
  delete from public.quotes where id = 'b0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.su(); select count(*) into n from public.quotes where id = 'b0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.res('RC4-18 denied: Org A admin can''t delete an Org B shelved quote', n = 1, n::text);
  perform pg_temp.login('a_admin@a.test');
  delete from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.su(); select count(*) into n from public.quotes where id = 'a0000000-0000-4000-8000-0000004200f1';
  perform pg_temp.res('RC4-19 allowed: admin deletes an Org A quote from the Deleted shelf', n = 0, n::text);
  update public.profiles set role = 'operations' where email = 'a_staff@a.test';   -- quotes edit, outside can_create
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$insert into public.quotes(code, title, status, client, pricing, current_version, approval_status) values ('A-0432', 'x', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none')$q$);
  perform pg_temp.res('RC4-20 denied: a role outside can_create() can''t insert a quote', s like '42501%', s);
  perform pg_temp.su(); update public.profiles set role = 'sales' where email = 'a_staff@a.test';
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$insert into public.quotes(code, title, status, client, pricing, current_version, approval_status) values ('A-0433', 'x', 'quote', '{}', '{"subtotal":0,"discount":0,"gstPct":18,"total":0}', 1, 'none')$q$);
  perform pg_temp.res('RC4-21 allowed: sales (can_create) inserts a quote', s = '', s);
end $$;

-- =====================================================================================
-- RC-5: approved / processed refunds frozen
-- =====================================================================================
do $$ declare s text; rid uuid; n text; begin perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('sales', 'settlement', true, true, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  perform pg_temp.login('a_staff@a.test');
  insert into public.event_refunds(quote_id, kind, amount, reason) values ('a0000000-0000-4000-8000-00000042a002', 'refund', 500, 'x') returning id into rid;
  perform pg_temp.put('rid', rid::text);
  s := pg_temp.try(format('update public.event_refunds set amount = 600 where id = %L', rid));
  perform pg_temp.res('RC5-01 allowed: the maker edits a PENDING refund', s = '', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_refunds set status = %L where id = %L', 'approved', rid));
  perform pg_temp.res('RC5-02 allowed: another person approves it', s = '', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('update public.event_refunds set amount = 60000 where id = %L', rid));
  perform pg_temp.res('RC5-03 denied: the maker can''t change the amount after approval', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_refunds set kind = %L where id = %L', 'deduction', rid));
  perform pg_temp.res('RC5-04 denied: the approver (admin) can''t change it either', s like '42501%', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try(format('delete from public.event_refunds where id = %L', rid));
  perform pg_temp.res('RC5-05 denied: an approved refund can''t be deleted', s like '42501%', s);
  perform pg_temp.login('b_admin@b.test');
  n := pg_temp.val(format('with u as (update public.event_refunds set status = %L where id = %L returning 1) select count(*) from u', 'rejected', rid));
  perform pg_temp.res('RC5-06 denied: Org B admin updates 0 Org A refunds', n = '0', n);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_refunds set status = %L where id = %L', 'processed', rid));
  perform pg_temp.res('RC5-07 allowed: approved → processed by the checker', s = '', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('update public.event_refunds set status = %L where id = %L', 'pending', rid));
  perform pg_temp.res('RC5-08 denied: a processed refund can''t be reverted', s like '42501%', s);
end $$;

-- =====================================================================================
-- RC-7: identity binding
-- =====================================================================================
do $$ declare s text; c record; begin perform pg_temp.su();
  insert into public.crew_members(id, name, phone, org_id, active)
    values ('a0000000-0000-4000-8000-0000004200c7', 'Freelancer', '+91 90000 06001', 'a0000000-0000-4000-8000-000000000001', true);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Asha Staff","phone":"9000006001"}')$q$);
  perform pg_temp.su(); select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000004200c7';
  perform pg_temp.res('RC7-01 denied: typing an unlinked staff row''s mobile doesn''t take it over',
    s = '' and c.profile_id is null and c.name = 'Freelancer', s||' '||coalesce(c.profile_id::text, '∅'));
  perform pg_temp.res('RC7-02 … and no duplicate staff row was created for that number',
    (select count(*) from public.crew_members where org_id = 'a0000000-0000-4000-8000-000000000001'
       and public.helm_norm_phone(phone) = '919000006001') = 1, '');
  perform pg_temp.login('b_staff@b.test');
  s := pg_temp.try($q$select public.complete_my_profile('{"full_name":"Bea Staff","phone":"9000006001"}')$q$);
  perform pg_temp.su(); select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000004200c7';
  perform pg_temp.res('RC7-03 Org B member with the same number: the Org A row is untouched', c.profile_id is null and c.name = 'Freelancer', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try(format('select public.admin_update_member_profile(%L, %L::jsonb)', pg_temp.uid('a_staff@a.test'), '{"job_title":"Chef"}'));
  perform pg_temp.su(); select * into c from public.crew_members where id = 'a0000000-0000-4000-8000-0000004200c7';
  perform pg_temp.res('RC7-04 allowed: an admin (staff edit) links it from User control',
    s = '' and c.profile_id = pg_temp.uid('a_staff@a.test'), s||' '||coalesce(c.profile_id::text, '∅'));
end $$;
do $$ declare s text; u uuid; u2 uuid; begin perform pg_temp.su();
  u := auth.seed_user('new_unconf@a.test'); update auth.users set email_confirmed_at = null where id = u;
  u2 := auth.seed_user('new_conf@a.test');
  perform auth.seed_user('ops@helm.test');
  insert into public.platform_admins(email, added_by) values ('ops@helm.test', 'test') on conflict do nothing;
  insert into public.invitations(org_id, email, role, token) values
    ('a0000000-0000-4000-8000-000000000001', 'new_unconf@a.test', 'sales', 'inv-unconf-0042'),
    ('a0000000-0000-4000-8000-000000000001', 'new_conf@a.test',   'sales', 'inv-conf-0042'),
    ('a0000000-0000-4000-8000-000000000001', 'ops@helm.test',     'sales', 'inv-ops-0042');
  perform pg_temp.login('new_unconf@a.test');
  s := pg_temp.try($q$select public.accept_invitation('inv-unconf-0042')$q$);
  perform pg_temp.res('RC7-05 denied: an unconfirmed e-mail can''t accept an invitation', s like '42501%Confirm%', s);
  perform pg_temp.login('ops@helm.test');
  s := pg_temp.try($q$select public.accept_invitation('inv-ops-0042')$q$);
  perform pg_temp.res('RC7-06 denied: a platform operator can''t join a studio', s like '42501%', s);
  perform pg_temp.login('new_conf@a.test');
  s := pg_temp.try($q$select public.accept_invitation('inv-unconf-0042')$q$);
  perform pg_temp.res('RC7-07 denied: someone else''s invitation token', s like '42501%', s);
  perform pg_temp.login('new_conf@a.test');
  s := pg_temp.try($q$select public.accept_invitation('inv-conf-0042')$q$);
  perform pg_temp.su();
  perform pg_temp.res('RC7-08 allowed: a confirmed invitee joins Studio A',
    s = '' and (select org_id from public.profiles where id = u2) = 'a0000000-0000-4000-8000-000000000001', s);
  s := pg_temp.try(format('update public.profiles set org_id = %L where id = %L', 'b0000000-0000-4000-8000-000000000001', pg_temp.uid('ops@helm.test')));
  perform pg_temp.res('RC7-09 denied: an operator profile can''t get a studio even by a direct write', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_create_user('ops@helm.test', 'Abcdefghij1!xy', 'sales')$q$);
  perform pg_temp.res('RC7-10 denied: admin_create_user with a platform operator e-mail', s like '22023%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.create_invitation('OPS@helm.test', 'sales')$q$);
  perform pg_temp.res('RC7-11 denied: inviting a platform operator e-mail', s like '22023%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_create_user('fresh0042@a.test', 'Abcdefghij1!xy', 'sales')$q$);
  perform pg_temp.res('RC7-12 allowed: admin_create_user with an ordinary e-mail', s = '', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.create_invitation('someone@a.test', 'sales')$q$);
  perform pg_temp.res('RC7-13 denied: a non-admin can''t invite', s like '42501%', s);
end $$;
do $$ declare t1 text; t2 text; r text; n int; begin
  perform pg_temp.login('a_admin@a.test');
  t1 := public.create_invitation('reinv@a.test', 'admin') ->> 'token';
  perform pg_temp.login('a_admin@a.test');
  t2 := public.create_invitation('reinv@a.test', 'crew') ->> 'token';
  perform pg_temp.su();
  select role, count(*) over () into r, n from public.invitations where email = 'reinv@a.test';
  perform pg_temp.res('RC7-14 a re-invite at a lower role lowers the stored role and rotates the token (still one row)',
    r = 'crew' and n = 1 and t1 is distinct from t2 and t2 = (select token from public.invitations where email = 'reinv@a.test'), r||' '||n);
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('sales', 'users', true, false, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  perform pg_temp.login('a_staff@a.test');
  select count(*) into n from public.invitations;
  perform pg_temp.res('RC7-15 denied: users-VIEW only can''t read invitation rows (tokens)', n = 0, n::text);
  perform pg_temp.login('a_admin@a.test');
  select count(*) into n from public.invitations where email = 'reinv@a.test';
  perform pg_temp.res('RC7-16 allowed: an admin (users edit) still lists them', n = 1, n::text);
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.invitations where email = 'reinv@a.test';
  perform pg_temp.res('RC7-17 denied: Org B admin sees no Org A invitations', n = 0, n::text);
end $$;

-- =====================================================================================
-- RC-9: org binding + EXECUTE revokes
-- =====================================================================================
do $$ declare s text; begin perform pg_temp.su();
  perform pg_temp.claims('a_admin@a.test');
  insert into public.event_sites(id, org_id, quote_id, slug, status, data) values
    ('a0000000-0000-4000-8000-0000004200b9', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000042a002', 'a42-site-a', 'draft', '{}');
  perform pg_temp.claims('b_admin@b.test');
  insert into public.event_sites(id, org_id, quote_id, slug, status, data) values
    ('b0000000-0000-4000-8000-0000004200b9', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000042b002', 'a42-site-b', 'draft', '{}');
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.val($q$select public.event_site_live_until('a0000000-0000-4000-8000-0000004200b9')::text$q$);
  perform pg_temp.res('RC9-02 allowed: own studio''s site gives its date', s is not null and s not like 'ERR%', coalesce(s, '∅'));
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.val($q$select public.event_site_live_until('b0000000-0000-4000-8000-0000004200b9')::text$q$);
  perform pg_temp.res('RC9-03 denied: another studio''s unpublished site gives no answer', s is null, coalesce(s, '∅'));
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.val($q$select public.event_site_live_until('b0000000-0000-4000-8000-0000004200b9')::text$q$);
  perform pg_temp.res('RC9-04 allowed: Org B admin on its own site', s is not null and s not like 'ERR%', coalesce(s, '∅'));
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.work_token_expiry_for('a0000000-0000-4000-8000-00000000da01')$q$);
  perform pg_temp.res('RC9-05 denied: work_token_expiry_for not callable by signed-in users', s like '42501%', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.client_link_deadline(current_date, 'b0000000-0000-4000-8000-000000000001', 7)$q$);
  perform pg_temp.res('RC9-06 denied: client_link_deadline not callable by signed-in users', s like '42501%', s);
  perform pg_temp.su();
  perform pg_temp.res('RC9-07 trigger functions are not callable by anon / authenticated',
    not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), '');
end $$;

-- =====================================================================================
-- D2: the role_access matrix is the single authority
-- =====================================================================================
do $$ declare s text; n int; v_c uuid := 'c0000000-0000-4000-8000-000000000042'; begin perform pg_temp.su();
  update public.profiles set role = 'manager' where email = 'a_staff@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('manager', 'settlement', true, true, 'a0000000-0000-4000-8000-000000000001', now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000042a002', 5)$q$);
  perform pg_temp.res('D2-01 allowed: a manager with settlement edit in the matrix records a settlement payment (was blocked by the role list)', s = '', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.close_event('a0000000-0000-4000-8000-00000042a003', true)$q$);
  perform pg_temp.res('D2-02 denied: the same manager without closure edit can''t close', s like '42501%', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.record_settlement_payment('a0000000-0000-4000-8000-00000042a002', 5)$q$);
  perform pg_temp.res('D2-03 denied: matrix rights never cross studios (Org B admin)', s like '42501%', s);
  perform pg_temp.su();
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
  perform pg_temp.res('D2-04 the hardcoded role lists are neutralised in the kept bodies',
    pg_get_functiondef('public.record_settlement_payment__pre0042(uuid,numeric,text,text,uuid,text,text)'::regprocedure) like '%a42-d2%'
    and pg_get_functiondef('public.close_event__pre0042(uuid,boolean)'::regprocedure) like '%a42-d2%'
    and pg_get_functiondef('public.mark_paid__base(uuid,text)'::regprocedure) like '%a42-d2%'
    and pg_get_functiondef('public.close_event(uuid,boolean)'::regprocedure) like '%has_area(''closure'', ''edit'')%', '');
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at) values (v_c, 'Studio C', 'INR', 'Asia/Kolkata', '{}', 'pro', now());
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('planner', 'settlement', true, false, v_c, now());
  n := public._a42_seed_matrix_defaults();
  perform pg_temp.res('D2-05 rollout: missing matrix rows for the old role-list roles are added (nobody loses access)',
    (select count(*) from public.role_access where org_id = v_c and can_edit) = 9, n::text);
  perform pg_temp.res('D2-06 … but a studio''s explicit "no edit" row is kept as chosen',
    (select can_edit from public.role_access where org_id = v_c and role = 'planner' and area = 'settlement') = false, '');
  perform pg_temp.res('D2-07 seeding is idempotent', public._a42_seed_matrix_defaults() = 0, '');
end $$;

-- =====================================================================================
-- NV-08 / NV-10
-- =====================================================================================
do $$ declare s text; v uuid; u uuid; begin perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values ('00000000-0000-4000-8000-000000000001', 'Template', 'INR', 'Asia/Kolkata', '{}', 'pro', now()) on conflict (id) do nothing;
  alter table public.app_config disable trigger a42_cfg_no_dev_echo;
  insert into public.app_config(key, value, org_id) values ('channels', '{"sms_live":true,"pay_live":true,"otp_dev_echo":true}', '00000000-0000-4000-8000-000000000001')
    on conflict (org_id, key) do update set value = excluded.value;
  alter table public.app_config enable trigger a42_cfg_no_dev_echo;
  u := auth.seed_user('founder0042@c.test');
  perform pg_temp.login('founder0042@c.test');
  v := public.create_studio('Founder Studio', 'founder0042@c.test', 'INR', 'Asia/Kolkata');
  perform pg_temp.su();
  perform pg_temp.res('NV08-01 a new studio starts with every channel off (template switches not copied)',
    coalesce((select value from public.app_config where org_id = v and key = 'channels'), '{}'::jsonb) = '{}'::jsonb, '');
  perform pg_temp.login('ops@helm.test');
  perform pg_temp.put('op1', public.is_platform_operator()::text);
  perform pg_temp.su();
  update public.platform_admins set user_id = pg_temp.uid('a_admin@a.test') where email = 'ops@helm.test';
  perform pg_temp.login('ops@helm.test');
  perform pg_temp.put('op2', public.is_platform_operator()::text);
  perform pg_temp.res('NV10-02 allowed: the bound account is an operator', pg_temp.get('op1') = 'true', pg_temp.get('op1'));
  perform pg_temp.res('NV10-03 denied: another account with that e-mail is not', pg_temp.get('op2') = 'false', pg_temp.get('op2'));
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('NV10-04 a studio admin is never an operator', not public.is_platform_operator(), '');
  perform pg_temp.su(); update public.platform_admins set user_id = null where email = 'ops@helm.test';   -- re-bound by the re-apply below
end $$;

-- =====================================================================================
-- D1 / D4 backfills: plant legacy rows, re-apply 0042, check (UPDATE-only, nothing deleted)
-- =====================================================================================
do $$ begin perform pg_temp.su();
  delete from public.helm_env_settings where key = 'allow_otp_dev_echo';          -- production-like
  alter table public.app_config disable trigger a42_cfg_no_dev_echo;
  update public.app_config set value = '{"otp_dev_echo":true}' where key = 'channels' and org_id = 'b0000000-0000-4000-8000-000000000001';
  alter table public.app_config enable trigger a42_cfg_no_dev_echo;
  insert into public.quote_otps(id, quote_id, phone, code_hash, expires_at, org_id)
    values ('b0000000-0000-4000-8000-0000004200e7', 'b0000000-0000-4000-8000-00000042b002', '9000007001', 'x', now() + interval '10 minutes',
            'b0000000-0000-4000-8000-000000000001');
  alter table public.audit_log disable trigger zz_a42_audit_org;
  insert into public.audit_log(id, action, entity, entity_id, quote_id, org_id) values
    ('a0000000-0000-4000-8000-0000004200a7', 'update', 'quotes', 'x', 'a0000000-0000-4000-8000-00000000da01', 'b0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000004200a8', 'hq.view', 'organizations', 'x', null, 'a0000000-0000-4000-8000-000000000001');
  alter table public.audit_log enable trigger zz_a42_audit_org;
  update public.quotes set approval_token_expires_at = null where id = 'b0000000-0000-4000-8000-00000000da01';
  perform pg_temp.claims('a_admin@a.test');
  insert into public.event_sites(id, org_id, quote_id, slug, status, data, published_at)
    values ('a0000000-0000-4000-8000-0000004200b8', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-00000042a003',
            'party-a1b2c3', 'published', '{}', now());
  perform pg_temp.su();
  insert into _ar(name, result) select 'D4-00 setup: legacy rows planted (counts)', 'PASS';
  perform pg_temp.put('rows_before', (select (select count(*) from public.notifications) + (select count(*) from public.audit_log where action <> 'event_site.reslugged')
                                           + (select count(*) from public.quote_otps) + (select count(*) from public.event_sites))::text);
end $$;

-- =====================================================================================
-- shape: wrappers keep grants, bodies kept once, idempotent re-apply
-- =====================================================================================
do $$ declare s text; begin perform pg_temp.su();
  perform pg_temp.res('SHAPE-01 every wrapped body kept as a private __pre0042',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0042') = 29
    and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0042'
                      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))), '');
  perform pg_temp.res('SHAPE-02 client entry points still open to visitors; studio ones signed-in only',
    has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
    and has_function_privilege('anon', 'public.request_otp(uuid,text)', 'execute')
    and has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
    and not has_function_privilege('anon', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._work_token_live(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._mp_sync_staff(uuid,jsonb)', 'execute'), '');
end $$;
\ir ../../supabase/migrations/0042_audit_run2_fixes.sql
do $$ declare s text; begin perform pg_temp.su();
  perform pg_temp.res('D1-01 echo switched off where not allowed, open codes of that studio expired',
    (select value ->> 'otp_dev_echo' from public.app_config where key = 'channels' and org_id = 'b0000000-0000-4000-8000-000000000001') = 'false'
    and (select expires_at <= now() from public.quote_otps where id = 'b0000000-0000-4000-8000-0000004200e7'), '');
  perform pg_temp.res('D4-01 stored notification details no longer hold tokens / urls',
    not exists (select 1 from public.notifications where detail ?| array['token', 'url']), '');
  perform pg_temp.res('D4-02 misfiled audit row corrected to the event''s studio',
    (select org_id from public.audit_log where id = 'a0000000-0000-4000-8000-0000004200a7') = 'a0000000-0000-4000-8000-000000000001', '');
  perform pg_temp.res('D4-03 hq.* audit row moved out of every studio',
    (select org_id from public.audit_log where id = 'a0000000-0000-4000-8000-0000004200a8') is null, '');
  perform pg_temp.res('D4-04 NV-05: an approval link without an expiry gets one',
    (select approval_token_expires_at from public.quotes where id = 'b0000000-0000-4000-8000-00000000da01') is not null, '');
  perform pg_temp.res('D4-05 NV-06: the 24-bit invitation slug is now 64-bit, same prefix',
    (select slug from public.event_sites where id = 'a0000000-0000-4000-8000-0000004200b8') ~ '^party-[0-9a-f]{16}$', '');
  perform pg_temp.anon();
  s := pg_temp.val($q$select count(*)::text from public.public_event_site('party-a1b2c3')$q$);
  perform pg_temp.res('D4-06 NV-06: the old guessable slug no longer opens the invitation', s = '0' or s like 'ERR%', s);
  perform pg_temp.su();
  perform pg_temp.res('D4-07 nothing was deleted by the backfills (row counts never go down, planted rows all present)',
    ((select count(*) from public.notifications) + (select count(*) from public.audit_log where action <> 'event_site.reslugged')
     + (select count(*) from public.quote_otps) + (select count(*) from public.event_sites)) >= pg_temp.get('rows_before')::bigint
    and (select count(*) from public.audit_log where id in ('a0000000-0000-4000-8000-0000004200a7', 'a0000000-0000-4000-8000-0000004200a8')) = 2
    and exists (select 1 from public.quote_otps where id = 'b0000000-0000-4000-8000-0000004200e7')
    and exists (select 1 from public.event_sites where id = 'a0000000-0000-4000-8000-0000004200b8'), '');
  perform pg_temp.res('NV10-01 the re-apply binds operator rows to the confirmed account id',
    (select user_id from public.platform_admins where email = 'ops@helm.test') = pg_temp.uid('ops@helm.test'), '');
end $$;
do $$ begin perform pg_temp.su();
  perform pg_temp.res('SHAPE-03 re-applying 0042 keeps one __pre0042 per function and the same wrappers',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0042') = 29
    and pg_get_functiondef('public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure) like '%__pre0042%'
    and pg_get_functiondef('public.verify_and_consent__pre0042(uuid,text,text,boolean,text,text,text,text)'::regprocedure) like '%__pre0039%', '');
end $$;

-- ---- summary ---------------------------------------------------------------------------
select n, name, result from _ar order by n;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'AUDIT-RUN2: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'AUDIT-RUN2: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary
  from _ar;
rollback;
