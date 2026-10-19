-- r23-quote-validity-0262.sql - 0262: quote "valid until" date (side table), studio settings, client page state,
-- "request a new quote", the SERVER approval lock, one-click extend / custom date (logged), admin "apply to open
-- quotes", list pills / attention ids, reminders (bell + queued client e-mail) + the dispatcher claim re-check,
-- studio isolation, RLS and grants.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
\i supabase/migrations/0262_quote_validity.sql
drop table if exists _g262; create temp table _g262(name text, result text); grant all on _g262 to anon, authenticated;

create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g262 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create or replace function pg_temp.until(p uuid) returns date language sql as $$ select valid_until from public.quote_validity where quote_id = p $$;
-- a known OTP for the quote's approval token (hashed like request_otp)
create or replace function pg_temp.otp(p_quote uuid, p_code text) returns text language plpgsql as $$
declare v_tok uuid; v_phone text;
begin
  select approval_token into v_tok from public.quotes where id = p_quote;
  v_phone := public._otp_canon_phone(v_tok, '9876543210');
  update public.quote_otps set expires_at = now() - interval '1 minute' where quote_id = p_quote and verified_at is null;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id)
    values (p_quote, v_phone, extensions.crypt(p_code, extensions.gen_salt('bf', 4)), now() + interval '10 minutes',
            (select org_id from public.quotes where id = p_quote));
  return v_phone;
end $$;

-- setup (Studio A, Asia/Kolkata). Quotes 262q1..262q8 in A, 262b1 in B. All inserted AFTER 0262, so each gets an
-- automatic row; the suite then shapes the dates it needs.
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid; u uuid; begin
  execute 'reset role';
  select org_id into b from public.profiles where email = 'b_admin@b.test';
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  -- throwaway test database only: clear this suite's own rows so a re-run starts clean
  create temp table _q262 on commit drop as select x::uuid as id from unnest(array[
    'a0000000-0000-4000-8000-0000000262a1','a0000000-0000-4000-8000-0000000262a2','a0000000-0000-4000-8000-0000000262a3',
    'a0000000-0000-4000-8000-0000000262a4','a0000000-0000-4000-8000-0000000262a5','a0000000-0000-4000-8000-0000000262a6',
    'a0000000-0000-4000-8000-0000000262a7','a0000000-0000-4000-8000-0000000262a8','b0000000-0000-4000-8000-0000000262b1']) x;
  delete from public.comms_outbox where quote_id in (select id from _q262);
  delete from public.notifications where quote_id in (select id from _q262);
  delete from public.quote_validity_log where quote_id in (select id from _q262);
  delete from public.quote_validity where quote_id in (select id from _q262);
  delete from public.quote_consents where quote_id in (select id from _q262);
  delete from public.quote_otps where quote_id in (select id from _q262);
  delete from public.client_booklets where quote_id in (select id from _q262);
  delete from public.app_config where key = 'quote_validity';
  delete from public.auth_rate_hits where bucket in ('qv_read', 'qv_renew');
  -- a crew member in A with no quotes view (bell filter check)
  select id into u from auth.users where email = 'a_crew262@a.test'; if u is null then u := auth.seed_user('a_crew262@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_crew262@a.test', 'Cal Crew', 'crew', a, false, now()) on conflict (id) do update set role = 'crew', org_id = a;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('crew', 'quotes', false, false, a, now()) on conflict (role, area, org_id) do update set can_view = false, can_edit = false;
  update public.organizations set public_slug = 'studio-a262' where id = a and coalesce(public_slug, '') = '';
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id,
                            approval_token, approval_token_expires_at, lifecycle_stage, event_date, created_at, updated_at)
  select x.id::uuid, x.code, x.title, 'quote',
         jsonb_build_object('name', 'Priya', 'email', 'priya262@example.org', 'phone', '9876543210'),
         '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}'::jsonb, 1, x.st, x.org,
         gen_random_uuid(), now() + interval '30 days', 'quote', x.d, now(), now()
    from (values ('a0000000-0000-4000-8000-0000000262a1', 'A-262-1', 'Valid262 One',   'sent', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a2', 'A-262-2', 'Valid262 Two',   'sent', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a3', 'A-262-3', 'Valid262 Three', 'none', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a4', 'A-262-4', 'Valid262 Four',  'sent', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a5', 'A-262-5', 'Valid262 Five',  'sent', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a6', 'A-262-6', 'Valid262 Six',   'sent', a, pg_temp.today() + 40),
                 ('a0000000-0000-4000-8000-0000000262a7', 'A-262-7', 'Valid262 Seven', 'sent', a, pg_temp.today() - 5),
                 ('a0000000-0000-4000-8000-0000000262a8', 'A-262-8', 'Valid262 Eight', 'sent', a, pg_temp.today() + 40),
                 ('b0000000-0000-4000-8000-0000000262b1', 'B-262-1', 'Valid262 B',     'sent', b, pg_temp.today() + 40)) x(id, code, title, st, org, d)
  on conflict (id) do nothing;
  -- a re-run: back to the starting state (status / approval / an automatic date from today)
  update public.quotes q set approval_status = case when q.id = 'a0000000-0000-4000-8000-0000000262a3' then 'none' else 'sent' end,
                             status = 'quote', approval_token_revoked_at = null, approval_token_expires_at = now() + interval '30 days'
   where q.id in (select id from _q262);
  insert into public.quote_validity(quote_id, org_id, valid_until, source)
    select q.id, q.org_id, pg_temp.today() + 14, 'auto' from public.quotes q where q.id in (select id from _q262)
  on conflict (quote_id) do nothing;
end $$;

-- ---- 1) automatic dates ----------------------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.t('01 a new quote gets today + 14 (auto)', pg_temp.until('a0000000-0000-4000-8000-0000000262a1') = pg_temp.today() + 14
    and (select source from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000262a1') = 'auto', pg_temp.until('a0000000-0000-4000-8000-0000000262a1')::text);
  -- unsent quote with an old automatic date: the first send counts the default from today
  update public.quote_validity set valid_until = pg_temp.today() + 2 where quote_id = 'a0000000-0000-4000-8000-0000000262a3';
  update public.quotes set approval_status = 'sent' where id = 'a0000000-0000-4000-8000-0000000262a3';
  perform pg_temp.t('02 first send moves an AUTO date to today + default (logged)', pg_temp.until('a0000000-0000-4000-8000-0000000262a3') = pg_temp.today() + 14
    and exists (select 1 from public.quote_validity_log where quote_id = 'a0000000-0000-4000-8000-0000000262a3' and action = 'auto'), pg_temp.until('a0000000-0000-4000-8000-0000000262a3')::text);
  -- a manual date is never moved by the send
  update public.quotes set approval_status = 'none' where id = 'a0000000-0000-4000-8000-0000000262a3';
  update public.quote_validity set valid_until = pg_temp.today() + 2, source = 'manual' where quote_id = 'a0000000-0000-4000-8000-0000000262a3';
  update public.quotes set approval_status = 'sent' where id = 'a0000000-0000-4000-8000-0000000262a3';
  perform pg_temp.t('03 a manual date is kept on send', pg_temp.until('a0000000-0000-4000-8000-0000000262a3') = pg_temp.today() + 2, pg_temp.until('a0000000-0000-4000-8000-0000000262a3')::text);
  -- a garbage settings row never blocks creating a quote (defaults are used)
  insert into public.app_config(org_id, key, value, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quote_validity', '"junk"'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  perform pg_temp.t('04 garbage settings read as the defaults', (public._qv262_cfg('a0000000-0000-4000-8000-000000000001') ->> 'default_days')::int = 14
    and public._qv262_cfg('a0000000-0000-4000-8000-000000000001') -> 'reminder_days' = '[3, 1]'::jsonb, public._qv262_cfg('a0000000-0000-4000-8000-000000000001')::text);
  delete from public.app_config where key = 'quote_validity';
  -- an existing quote with NO row = no expiry (state none)
  delete from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000262a6';
  perform pg_temp.t('05 no row = no expiry (state none)', public._qv262_state('a0000000-0000-4000-8000-0000000262a6') ->> 'state' = 'none', null);
end $$;

-- ---- 2) client pages -------------------------------------------------------------------------------------------
do $$ declare r text; j jsonb; v_tok text; begin
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a1';
  r := pg_temp.as_try('anon', format($q$select public.public_quote_validity('quote', %L)::text$q$, v_tok));
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('06 anon: valid, 14 days left, dd/mm/yyyy label, studio name, no ids', r like 'ok:%' and j ->> 'state' = 'valid'
    and (j ->> 'days_left')::int = 14 and j ->> 'valid_until_label' = to_char(pg_temp.today() + 14, 'DD/MM/YYYY')
    and j ->> 'studio' = 'Studio A' and not (j ? 'quote_id') and not (j::text like '%0262a1%'), r);
  update public.quote_validity set valid_until = pg_temp.today() - 1 where quote_id = 'a0000000-0000-4000-8000-0000000262a2';
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a2';
  r := pg_temp.as_try('anon', format($q$select public.public_quote_validity('quote', %L)::text$q$, v_tok));
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('07 anon: expired + locked (default lock on)', j ->> 'state' = 'expired' and (j ->> 'locked')::boolean and (j ->> 'days_left')::int = -1, r);
  r := pg_temp.as_try('anon', $q$select coalesce(public.public_quote_validity('quote', 'a0000000-0000-4000-8000-00000000ffff')::text, 'null')$q$);
  perform pg_temp.t('08 unknown token -> nothing', r = 'ok:null', r);
  insert into public.client_booklets(org_id, quote_id, token, expires_at)
    values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000262a2', 'a0000000-0000-4000-8000-00000262b00c', now() + interval '10 days');
  r := pg_temp.as_try('anon', $q$select public.public_quote_validity('booklet', 'a0000000-0000-4000-8000-00000262b00c')::text$q$);
  perform pg_temp.t('09 booklet link shows the same expired state', substr(r, 4)::jsonb ->> 'state' = 'expired', r);
end $$;

-- ---- 3) the SERVER approval lock --------------------------------------------------------------------------------
do $$ declare r text; v_tok text; v_phone text; begin
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a2';
  v_phone := pg_temp.otp('a0000000-0000-4000-8000-0000000262a2', '424242');
  r := pg_temp.as_try('anon', format($q$select public.verify_and_consent(%L, %L, '424242', true, 'v1', 'I agree', 'Priya', 'UA')::text$q$, v_tok, v_phone));
  perform pg_temp.t('10 approve refused after expiry (quote_expired, plain message)', substr(r, 4)::jsonb ->> 'error' = 'quote_expired'
    and substr(r, 4)::jsonb ->> 'message' like 'This quote expired on % Ask Studio A for an updated quote.'
    and (select approval_status from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a2') = 'sent'
    and not exists (select 1 from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-0000000262a2'), r);
  perform pg_temp.t('11 the refusal is logged once a day; the code is not used up', exists (select 1 from public.quote_validity_log where quote_id = 'a0000000-0000-4000-8000-0000000262a2' and action = 'approve_refused')
    and exists (select 1 from public.quote_otps where quote_id = 'a0000000-0000-4000-8000-0000000262a2' and verified_at is null and expires_at > now() and coalesce(attempts, 0) = 0), null);
  r := pg_temp.as_try('anon', format($q$select public.wa_verify_and_consent(%L, 'email', '424242', true, 'v1', 'I agree', 'Priya', 'UA')::text$q$, v_tok));
  perform pg_temp.t('12 the WhatsApp / e-mail code path is refused too', r like '%quote_expired%' or r like 'err:%', r);
  -- the studio switches the lock off -> the same code approves
  insert into public.app_config(org_id, key, value, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quote_validity', '{"auto_lock": false}'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  r := pg_temp.as_try('anon', format($q$select public.verify_and_consent(%L, %L, '424242', true, 'v1', 'I agree', 'Priya', 'UA')::text$q$, v_tok, v_phone));
  perform pg_temp.t('13 lock off: the same code approves', (substr(r, 4)::jsonb ->> 'approved')::boolean
    and (select approval_status from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a2') = 'approved', r);
  delete from public.app_config where key = 'quote_validity';
  perform pg_temp.t('14 an approved quote no longer expires (state done)', public._qv262_state('a0000000-0000-4000-8000-0000000262a2') ->> 'state' = 'done', null);
  -- a valid quote approves normally through the wrapper
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a8';
  v_phone := pg_temp.otp('a0000000-0000-4000-8000-0000000262a8', '515151');
  r := pg_temp.as_try('anon', format($q$select public.verify_and_consent(%L, %L, '515151', true, 'v1', 'I agree', 'Priya', 'UA')::text$q$, v_tok, v_phone));
  perform pg_temp.t('15 a valid quote approves as before', (substr(r, 4)::jsonb ->> 'approved')::boolean, r);
end $$;

-- ---- 4) "Request a new quote" ------------------------------------------------------------------------------------
do $$ declare r text; v_tok text; begin
  update public.quote_validity set valid_until = pg_temp.today() - 3 where quote_id = 'a0000000-0000-4000-8000-0000000262a4';
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a4';
  r := pg_temp.as_try('anon', format($q$select public.public_request_new_quote('quote', %L, E'Please\nupdate the menu')::text$q$, v_tok));
  perform pg_temp.t('16 anon request -> sent + one bell row for the studio', substr(r, 4)::jsonb ->> 'status' = 'sent'
    and (select count(*) from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000262a4' and kind = 'quote_renew_request') = 1
    and (select note from public.quote_validity_log where quote_id = 'a0000000-0000-4000-8000-0000000262a4' and action = 'renew_request') = 'Please update the menu', r);
  r := pg_temp.as_try('anon', format($q$select public.public_request_new_quote('quote', %L, null)::text$q$, v_tok));
  perform pg_temp.t('17 the same day again -> already (no 2nd bell row)', substr(r, 4)::jsonb ->> 'status' = 'already'
    and (select count(*) from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000262a4' and kind = 'quote_renew_request') = 1, r);
  r := pg_temp.as_try('anon', format($q$select public.public_quote_validity('quote', %L)::text$q$, v_tok));
  perform pg_temp.t('18 the page then says "requested"', (substr(r, 4)::jsonb ->> 'requested')::boolean, r);
  select approval_token::text into v_tok from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a1';
  r := pg_temp.as_try('anon', format($q$select public.public_request_new_quote('quote', %L, null)::text$q$, v_tok));
  perform pg_temp.t('19 a quote that has not expired cannot be "renewed"', r like 'err:22023%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('20 the admin bell shows it', r like '%quote_renew_request%', r);
  r := pg_temp.as_try('a_crew262@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('21 a crew member without quotes view does not see quote_* rows', r like 'ok:%' and r not like '%quote_renew_request%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('22 another studio never sees it', r like 'ok:%' and r not like '%quote_renew_request%', r);
end $$;

-- ---- 5) staff: read / extend / custom date -------------------------------------------------------------------------
do $$ declare r text; j jsonb; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_get('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('23 staff read: expired, can edit + override, log', j ->> 'state' = 'expired' and (j ->> 'can_edit')::boolean
    and (j ->> 'can_override')::boolean and jsonb_array_length(j -> 'log') >= 1 and (j ->> 'default_days')::int = 14, r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('24 one-click extend: from today + 14, logged + audited', substr(r, 4)::jsonb ->> 'state' = 'valid'
    and pg_temp.until('a0000000-0000-4000-8000-0000000262a4') = pg_temp.today() + 14
    and exists (select 1 from public.quote_validity_log where quote_id = 'a0000000-0000-4000-8000-0000000262a4' and action = 'extended' and actor_name is not null)
    and exists (select 1 from public.audit_log where quote_id = 'a0000000-0000-4000-8000-0000000262a4' and action = 'quote_validity.extended'), r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('25 extending a valid quote adds to its current date', pg_temp.until('a0000000-0000-4000-8000-0000000262a4') = pg_temp.today() + 28, r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.quote_validity_set('a0000000-0000-4000-8000-0000000262a4', %L, 'client asked')::text$q$, pg_temp.today() + 30));
  perform pg_temp.t('26 custom date (allowed by default)', pg_temp.until('a0000000-0000-4000-8000-0000000262a4') = pg_temp.today() + 30
    and (select source from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000262a4') = 'manual', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.quote_validity_set('a0000000-0000-4000-8000-0000000262a4', %L)::text$q$, pg_temp.today() - 1));
  perform pg_temp.t('27 a past date is refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.quote_validity_set('a0000000-0000-4000-8000-0000000262a4', %L)::text$q$, pg_temp.today() + 400));
  perform pg_temp.t('28 more than a year ahead is refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a2')::text$q$);
  perform pg_temp.t('29 an approved quote cannot be extended', r like 'err:22023%', r);
  -- custom dates switched off: only admins pick a date; everyone with quotes edit can still extend by the default
  insert into public.app_config(org_id, key, value, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quote_validity', '{"allow_override": false}'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.quote_validity_set('a0000000-0000-4000-8000-0000000262a4', %L)::text$q$, pg_temp.today() + 20));
  perform pg_temp.t('30 override off: staff custom date refused (42501)', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4', 30)::text$q$);
  perform pg_temp.t('31 override off: staff custom length refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('32 override off: staff default extend still works', r like 'ok:%', r);
  r := pg_temp.as_try('a_admin@a.test', format($q$select public.quote_validity_set('a0000000-0000-4000-8000-0000000262a4', %L)::text$q$, pg_temp.today() + 20));
  perform pg_temp.t('33 override off: an admin can still pick a date', pg_temp.until('a0000000-0000-4000-8000-0000000262a4') = pg_temp.today() + 20, r);
  delete from public.app_config where key = 'quote_validity';
  r := pg_temp.as_try('b_admin@b.test', $q$select public.quote_validity_get('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('34 another studio cannot read it', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('35 another studio cannot extend it', r like 'err:42501%', r);
  r := pg_temp.as_try('a_crew262@a.test', $q$select public.quote_validity_get('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('36 no quotes view -> refused', r like 'err:42501%', r);
  r := pg_temp.as_try('anon', $q$select public.quote_validity_extend('a0000000-0000-4000-8000-0000000262a4')::text$q$);
  perform pg_temp.t('37 anon cannot call staff RPCs', r like 'err:42501%', r);
end $$;

-- ---- 6) settings + apply to open quotes ---------------------------------------------------------------------------
do $$ declare r text; j jsonb; n int; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_settings_set('{"default_days": 21, "reminder_days": [1, 7, 3], "client_reminders": false}'::jsonb)::text$q$);
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('38 settings saved (Control Center edit), reminder days sorted', (j ->> 'default_days')::int = 21
    and j -> 'reminder_days' = '[7, 3, 1]'::jsonb and not (j ->> 'client_reminders')::boolean and (j ->> 'enabled')::boolean, r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_settings_set('{"default_days": 0}'::jsonb)::text$q$);
  perform pg_temp.t('39 0 days refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_settings_set('{"reminder_days": [1, 2, 3, 4, 5, 6]}'::jsonb)::text$q$);
  perform pg_temp.t('40 more than 5 reminder days refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_settings_set('{"auto_lock": "yes"}'::jsonb)::text$q$);
  perform pg_temp.t('41 a non-boolean switch refused', r like 'err:22023%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.quote_validity_settings_get()::text$q$);
  perform pg_temp.t('42 studio B still has its own defaults', (substr(r, 4)::jsonb ->> 'default_days')::int = 14, r);
  r := pg_temp.as_try('a_crew262@a.test', $q$select public.quote_validity_settings_set('{"default_days": 5}'::jsonb)::text$q$);
  perform pg_temp.t('43 no Control Center edit -> refused', r like 'err:42501%', r);
  delete from public.app_config where key = 'quote_validity';
  -- apply to open quotes: a6 has no row (open), a7 has no row but its event is past, b1 belongs to B
  delete from public.quote_validity where quote_id in ('a0000000-0000-4000-8000-0000000262a7');
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_apply_open(false)::text$q$);
  perform pg_temp.t('44 apply to open quotes: admin only', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.quote_validity_apply_open(false)::text$q$);
  n := (substr(r, 4)::jsonb ->> 'count')::int;
  perform pg_temp.t('45 dry run counts only, changes nothing', n >= 1 and not (substr(r, 4)::jsonb ->> 'applied')::boolean
    and not exists (select 1 from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000262a6'), r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.quote_validity_apply_open(true)::text$q$);
  perform pg_temp.t('46 apply adds today + default to open quotes without a date (logged)', (substr(r, 4)::jsonb ->> 'applied')::boolean
    and pg_temp.until('a0000000-0000-4000-8000-0000000262a6') = pg_temp.today() + 14
    and (select source from public.quote_validity where quote_id = 'a0000000-0000-4000-8000-0000000262a6') = 'bulk'
    and exists (select 1 from public.quote_validity_log where quote_id = 'a0000000-0000-4000-8000-0000000262a6' and action = 'bulk')
    and pg_temp.until('a0000000-0000-4000-8000-0000000262a7') is null
    and pg_temp.until('a0000000-0000-4000-8000-0000000262a4') = pg_temp.today() + 20, r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.quote_validity_apply_open(false)::text$q$);
  perform pg_temp.t('47 a 2nd run finds nothing more', (substr(r, 4)::jsonb ->> 'count')::int = 0, r);
end $$;

-- ---- 7) list pills + attention ids ------------------------------------------------------------------------------------
do $$ declare r text; j jsonb; begin
  update public.quote_validity set valid_until = pg_temp.today() + 2 where quote_id = 'a0000000-0000-4000-8000-0000000262a5';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quote_validity_list(array['a0000000-0000-4000-8000-0000000262a5','a0000000-0000-4000-8000-0000000262a2','b0000000-0000-4000-8000-0000000262b1']::uuid[])::text$q$);
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('48 list: own open quote with 2 days left; approved + other studio left out', (j #>> '{a0000000-0000-4000-8000-0000000262a5,days_left}')::int = 2
    and not (j ? 'a0000000-0000-4000-8000-0000000262a2') and not (j ? 'b0000000-0000-4000-8000-0000000262b1'), r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.quotes_expiring_soon()::text$q$);
  perform pg_temp.t('49 attention ids: expiring in 2 days included, 14 days not', r like '%0262a5%' and r not like '%0262a1%' and r not like '%0262a2%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.quotes_expiring_soon(60)::text$q$);
  perform pg_temp.t('50 another studio gets none of A''s ids', r like 'ok:%' and r not like '%0262a%', r);
end $$;

-- ---- 8) reminders + the dispatcher claim -------------------------------------------------------------------------------
do $$ declare r jsonb; c jsonb; e record; v_new uuid; begin
  execute 'reset role';
  update public.quote_validity set valid_until = pg_temp.today() + 3 where quote_id = 'a0000000-0000-4000-8000-0000000262a5';
  update public.quote_validity set valid_until = pg_temp.today() - 1 where quote_id = 'a0000000-0000-4000-8000-0000000262a6';
  delete from public.notifications where quote_id in ('a0000000-0000-4000-8000-0000000262a5', 'a0000000-0000-4000-8000-0000000262a6');
  r := public.quote_validity_tick();
  perform pg_temp.t('51 3 days before: studio bell "expires in 3 days"', exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000262a5'
    and kind = 'quote_expiring' and detail ->> 'label' like 'Quote A-262-5 expires in 3 days (%'), r::text);
  perform pg_temp.t('52 client e-mail QUEUED (pending, purpose quote_expiry, fixed text, no token)', exists (select 1 from public.comms_outbox where quote_id = 'a0000000-0000-4000-8000-0000000262a5'
    and purpose = 'quote_expiry' and channel = 'email' and recipient = 'priya262@example.org' and status = 'pending'
    and payload ->> 'body' = 'Hi Priya, your quote A-262-5 from Studio A is valid until ' || to_char(pg_temp.today() + 3, 'DD/MM/YYYY') || '.'
    and payload::text not like '%' || (select approval_token::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a5') || '%'), r::text);
  perform pg_temp.t('53 the day after expiry: studio bell "expired"', exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000262a6' and kind = 'quote_expired'), r::text);
  r := public.quote_validity_tick();
  perform pg_temp.t('54 a 2nd tick sends nothing again', (r ->> 'studio')::int = 0 and (r ->> 'client')::int = 0 and (r ->> 'expired')::int = 0
    and (select count(*) from public.comms_outbox where quote_id = 'a0000000-0000-4000-8000-0000000262a5' and purpose = 'quote_expiry') = 1, r::text);
  c := public.comms_outbox_claim(100);
  select x into e from jsonb_array_elements(c) x where x ->> 'purpose' = 'quote_expiry' limit 1;
  perform pg_temp.t('55 claim hands it out with the approval link path', e is not null
    and (select x ->> 'payload' from jsonb_array_elements(c) x where x ->> 'purpose' = 'quote_expiry' limit 1)::jsonb ->> 'link_path'
        = (select public_slug from public.organizations where id = 'a0000000-0000-4000-8000-000000000001') || '/quote/' || (select approval_token::text from public.quotes where id = 'a0000000-0000-4000-8000-0000000262a5'), c::text);
  -- re-checked at claim time: extended after queuing -> skipped (never a stale date)
  update public.comms_outbox set claimed_at = null, status = 'pending', sent_at = null where quote_id = 'a0000000-0000-4000-8000-0000000262a5' and purpose = 'quote_expiry';
  update public.quote_validity set valid_until = pg_temp.today() + 10 where quote_id = 'a0000000-0000-4000-8000-0000000262a5';
  c := public.comms_outbox_claim(100);
  perform pg_temp.t('56 claim skips a row whose date changed', (select status from public.comms_outbox where quote_id = 'a0000000-0000-4000-8000-0000000262a5' and purpose = 'quote_expiry') = 'skipped', c::text);
  -- client reminders off -> bell only
  insert into public.app_config(org_id, key, value, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quote_validity', '{"client_reminders": false, "reminder_days": [10]}'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  r := public.quote_validity_tick();
  perform pg_temp.t('57 client reminders off: bell only', exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000262a5' and kind = 'quote_expiring' and detail ->> 'label' like '%10 days%')
    and (select count(*) from public.comms_outbox where quote_id = 'a0000000-0000-4000-8000-0000000262a5' and purpose = 'quote_expiry') = 1, r::text);
  -- switched off: no new dates, nothing shown, nothing locked
  insert into public.app_config(org_id, key, value, updated_at) values ('a0000000-0000-4000-8000-000000000001', 'quote_validity', '{"enabled": false}'::jsonb, now())
    on conflict (org_id, key) do update set value = excluded.value;
  perform pg_temp.t('58 switched off: state off (no expiry anywhere)', public._qv262_state('a0000000-0000-4000-8000-0000000262a6') ->> 'state' = 'off', null);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, created_at, updated_at)
    values (gen_random_uuid(), 'A-262-F' || floor(random() * 100000)::int, 'Valid262 Off', 'quote', '{"name":"Off"}'::jsonb,
            '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}'::jsonb, 1, 'none', 'a0000000-0000-4000-8000-000000000001', now(), now())
    returning id into v_new;
  perform pg_temp.t('59 switched off: a new quote gets no date', pg_temp.until(v_new) is null, null);
  delete from public.app_config where key = 'quote_validity';
end $$;

-- ---- 9) RLS + grants -------------------------------------------------------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('b_admin@b.test', $q$select count(*)::text from public.quote_validity where quote_id::text like '%0262a%'$q$);
  perform pg_temp.t('60 RLS: another studio reads 0 rows', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select count(*)::text from public.quote_validity where quote_id::text like '%0262a%'$q$);
  perform pg_temp.t('61 RLS: own studio reads its rows', r like 'ok:%' and r <> 'ok:0', r);
  r := pg_temp.as_try('a_crew262@a.test', $q$select count(*)::text from public.quote_validity_log$q$);
  perform pg_temp.t('62 RLS: no quotes view -> 0 log rows', r = 'ok:0', r);
  r := pg_temp.as_try('a_admin@a.test', $q$update public.quote_validity set valid_until = valid_until + 100 returning quote_id::text$q$);
  perform pg_temp.t('63 no direct update from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$insert into public.quote_validity_log(org_id, quote_id, action) values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000262a1', 'set') returning id::text$q$);
  perform pg_temp.t('64 no direct insert into the log', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$delete from public.quote_validity_log returning id::text$q$);
  perform pg_temp.t('65 no delete from the log', r like 'err:42501%', r);
  perform pg_temp.t('66 internal helpers / tick / claim not callable by the app', not has_function_privilege('authenticated', 'public._qv262_state(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._qv262_verify(uuid, text, text, boolean, text, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.quote_validity_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.verify_and_consent__pre0262(uuid, text, text, boolean, text, text, text, text)', 'execute'), null);
  perform pg_temp.t('67 client RPCs open to anon; staff RPCs not', has_function_privilege('anon', 'public.public_quote_validity(text, uuid)', 'execute')
    and has_function_privilege('anon', 'public.public_request_new_quote(text, uuid, text)', 'execute')
    and has_function_privilege('anon', 'public.verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.quote_validity_get(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.quote_validity_extend(uuid, integer)', 'execute'), null);
  perform pg_temp.t('68 wrappers in place (verify + claim), the 0156 price check still in the chain',
    position('_qv262_verify' in (select prosrc from pg_proc where oid = 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)'::regprocedure)) > 0
    and position('_qv262_claim' in (select prosrc from pg_proc where oid = 'public.comms_outbox_claim(integer)'::regprocedure)) > 0
    and position('price_changed' in (select prosrc from pg_proc where oid = 'public.verify_and_consent__pre0262(uuid,text,text,boolean,text,text,text,text)'::regprocedure)) > 0, null);
  perform pg_temp.t('69 purpose check is a superset (old values kept)', (select pg_get_constraintdef(oid) from pg_constraint where conname = 'comms_outbox_purpose_check')
    ~ 'booklet_link.*invite_site.*pay_reminder.*quote_expiry.*wa_forward', null);
end $$;

select name, result from _g262 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-QUOTE-VALIDITY-0262: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-QUOTE-VALIDITY-0262: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g262;
