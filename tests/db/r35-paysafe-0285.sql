-- r35-paysafe-0285.sql -- r35 payment-details change protection: two-step (verified factor + fresh aal2 code) for every
-- change, PENDING for 24 hours (clients keep the old details), first set-up live at once, every admin alerted (bell +
-- queued e-mail, masked last 4 only), "This wasn't us" cancel + flag, auto-apply after 24 hours (read + tick), early
-- approval by a DIFFERENT admin, the other sensitive settings (reply-to, business e-mail, Razorpay, money switches,
-- admins added / removed, two-step off), tenant isolation, closed tables. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
-- re-run safe: the migration applied again inside the test (the clean install already ran it once)
set client_min_messages = error;
\ir ../../supabase/migrations/0285_r35_payment_details_safety.sql
\ir ../../supabase/migrations/0285_r35_payment_details_safety.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
-- sign in as p_email at p_aal; p_mfa_min = minutes since the two-step code was entered (null = no amr list)
create or replace function pg_temp.as_user(p_email text, p_aal text, p_mfa_min integer default null) returns void language plpgsql as $$
declare u uuid; c jsonb; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  c := auth.jwt() || jsonb_build_object('aal', p_aal);
  if p_mfa_min is not null then
    c := c || jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now()) - 7200),
                                                          jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now()) - p_mfa_min * 60)));
  end if;
  perform set_config('request.jwt.claims', c::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
-- user ids are read once as the superuser (signed-in roles cannot read auth.users)
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select v::uuid from _kv where k = 'uid:' || p_email $$;
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
create or replace function pg_temp.factor(p_email text) returns void language plpgsql as $$
begin perform pg_temp.su();
  if not exists (select 1 from auth.mfa_factors where user_id = pg_temp.uid(p_email) and status = 'verified') then
    insert into auth.mfa_factors(user_id, status) values (pg_temp.uid(p_email), 'verified'); end if; end $$;
-- live settings / pending row as the database sees them
create or replace function pg_temp.live_upi() returns text language sql as $$
  select upi_id from public.payment_schedule_settings where org_id = 'a0000000-0000-4000-8000-000000000001' $$;
create or replace function pg_temp.client_upi() returns text language sql as $$
  select public._pst_pay_details('a0000000-0000-4000-8000-00000000da01') ->> 'upi' $$;
create or replace function pg_temp.pending_id() returns uuid language sql as $$
  select id from public.pay_detail_changes where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'pending' $$;
create or replace function pg_temp.events(p_kind text) returns integer language sql as $$
  select count(*)::int from public.studio_security_events where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = p_kind
     and at >= now() $$;   -- this test's own rows only (earlier suites may have left alerts behind)

-- ---- setup: a second admin in Studio A; a clean slate for Studio A's payment details --------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.member('a_admin2@a.test', 'admin', 'a0000000-0000-4000-8000-000000000001');
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u
   where u.email in ('a_admin@a.test', 'a_admin2@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test') on conflict (k) do nothing;
  update public.profiles set full_name = 'Asha Admin' where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Ravi Admin' where email = 'a_admin2@a.test';
  update public.profiles set full_name = 'Sam Sales' where email = 'a_staff@a.test';
  delete from auth.mfa_factors where user_id in (pg_temp.uid('a_admin@a.test'), pg_temp.uid('a_admin2@a.test'), pg_temp.uid('b_admin@b.test'));
  delete from public.payment_schedule_settings where org_id = 'a0000000-0000-4000-8000-000000000001';   -- test only (rolled back)
  delete from public.audit_log where org_id = 'a0000000-0000-4000-8000-000000000001' and action = 'payment_schedule.settings';
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) objects ---------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 three new tables, RLS on, no API privilege; wrappers keep the old bodies (*__pre0285)',
    (select count(*) from pg_class c where c.relname in ('pay_detail_changes', 'studio_security_events', 'studio_account_flags') and c.relrowsecurity) = 3
    and not has_table_privilege('authenticated', 'public.pay_detail_changes', 'select')
    and not has_table_privilege('anon', 'public.studio_account_flags', 'select')
    and not has_table_privilege('authenticated', 'public.studio_security_events', 'insert')
    and to_regprocedure('public.payment_schedule_settings_set__pre0285(jsonb)') is not null
    and not has_function_privilege('authenticated', 'public.payment_schedule_settings_set__pre0285(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.payment_schedule_settings_set(jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.pay_details_cancel(uuid, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.pay_details_tick()', 'execute')
    and not has_function_privilege('anon', 'public.pay_details_approve_now(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r285_step_up(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r285_mail(uuid)', 'execute'));
  perform pg_temp.res('02 masking keeps the last 4 characters only',
    public._r285_mask('studioa@okaxis') = '****axis' and public._r285_mask('HDFC A/c 50100234567890') = '****7890'
    and public._r285_mask(null) = 'none' and public._r285_mask('abc') = '****' and public._r285_mask_email('owner@studio.in') = 'o***@studio.in');
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) two-step is required: no factor / aal1 / stale code refused --------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis"}'::jsonb)$q$);
  perform pg_temp.res('03 no two-step set up: refused with "set up two-step first"', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.factor('a_admin@a.test');
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis"}'::jsonb)$q$);
  perform pg_temp.res('04 two-step set up but the session is aal1: refused (0043: no studio until the code is entered)', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 40);
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis"}'::jsonb)$q$);
  perform pg_temp.res('05 aal2 but the code is 40 minutes old: refused (fresh code needed)', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis"}'::jsonb)$q$);
  perform pg_temp.res('06 aal2 without any two-step time in the token: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.su();
  perform pg_temp.res('07 nothing was saved or queued by the refused attempts',
    pg_temp.live_upi() is null and not exists (select 1 from public.pay_detail_changes where org_id = 'a0000000-0000-4000-8000-000000000001')
    and pg_temp.events('pay_details_requested') + pg_temp.events('pay_details_first_set') = 0);
  -- saving something else (the default schedule) needs no fresh code
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"default_template": "builtin:50-50"}'::jsonb)$q$);
  perform pg_temp.res('08 other payment settings still save with an old code (signed in hours ago) (no code needed)', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) first set-up: live at once, alerts still sent ---------------------------------------------------------------
do $$ declare r jsonb; v_ev uuid; m jsonb; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 2);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis", "pay_note": "HDFC A/c 50100234567890 IFSC HDFC0001234"}'::jsonb)$q$);
  perform pg_temp.res('09 first set-up (never had payment details): live at once', r ->> 'upi_id' = 'studioa@okaxis' and r -> 'pending' = 'null'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('10 first set-up: clients see it now; change row applied as first_setup',
    pg_temp.live_upi() = 'studioa@okaxis' and pg_temp.client_upi() = 'studioa@okaxis'
    and exists (select 1 from public.pay_detail_changes where org_id = 'a0000000-0000-4000-8000-000000000001' and status = 'applied' and applied_how = 'first_setup' and first_setup));
  select id into v_ev from public.studio_security_events where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'pay_details_first_set' and at >= now();
  m := public._r285_mail(v_ev);
  perform pg_temp.res('11 first set-up alerted: bell row + queued e-mail to BOTH admins, masked only',
    v_ev is not null
    and exists (select 1 from public.helm_notice_outbox o where o.kind = 'studio_security' and o.ref_id = v_ev and o.status = 'pending')
    and exists (select 1 from public.notifications n where n.org_id = 'a0000000-0000-4000-8000-000000000001' and n.kind = 'studio_security' and n.detail ->> 'event_id' = v_ev::text)
    and m -> 'to' @> '["a_admin@a.test", "a_admin2@a.test"]'::jsonb and not (m -> 'to' ? 'a_staff@a.test')
    and m -> 'data' ->> 'new_upi' = '****axis' and m -> 'data' ->> 'new_note' = '****1234'
    and position('studioa@okaxis' in m::text) = 0 and position('50100234567890' in m::text) = 0, coalesce(m::text, 'no mail'));
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) a later change waits 24 hours: clients keep the old details --------------------------------------------------
do $$ declare r jsonb; v_ev uuid; m jsonb; v_lbl text; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "thief9@okicici", "pay_note": "SBI A/c 99990000111122223333"}'::jsonb)$q$);
  perform pg_temp.put('c1', (r -> 'pending' ->> 'id'));
  perform pg_temp.res('12 change saved as PENDING for 24 hours; the answer still shows the live (old) details',
    r ->> 'upi_id' = 'studioa@okaxis' and r -> 'pending' ->> 'new_upi' = 'thief9@okicici'
    and (r -> 'pending' ->> 'effective_at')::timestamptz = now() + interval '24 hours'
    and (r -> 'pending' ->> 'requested_by_me')::boolean and not (r -> 'pending' ->> 'can_approve')::boolean, r::text);
  perform pg_temp.su();
  perform pg_temp.res('13 pending change is INVISIBLE to clients (pay details for reminders + portal = old)',
    pg_temp.live_upi() = 'studioa@okaxis' and pg_temp.client_upi() = 'studioa@okaxis'
    and public._pst_pay_details('a0000000-0000-4000-8000-00000000da01') ->> 'note' like 'HDFC%'
    and public._pst_pay_text(public._pst_pay_details('a0000000-0000-4000-8000-00000000da01')) not like '%thief9%');
  perform pg_temp.anon();
  r := pg_temp.j($q$select public.public_payment_schedule('a0000000-0000-4000-8000-0000000000aa')$q$);
  perform pg_temp.res('14 the client page (signed out) never shows the pending details',
    position('thief9' in coalesce(r::text, '')) = 0 and (r ? 'err' or r -> 'pay' ->> 'upi' = 'studioa@okaxis'), r::text);
  perform pg_temp.su();
  select id into v_ev from public.studio_security_events where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'pay_details_requested' and at >= now();
  m := public._r285_mail(v_ev);
  select n.detail ->> 'label' into v_lbl from public.notifications n where n.kind = 'studio_security' and n.detail ->> 'event_id' = v_ev::text;
  perform pg_temp.res('15 masked alerts: e-mail old vs new last 4 only, both admins; bell text names who / when / from when',
    m -> 'to' @> '["a_admin@a.test", "a_admin2@a.test"]'::jsonb
    and m -> 'data' ->> 'old_upi' = '****axis' and m -> 'data' ->> 'new_upi' = '****cici' and m -> 'data' ->> 'new_note' = '****3333'
    and m -> 'data' ->> 'by' = 'Asha Admin' and m -> 'data' ->> 'effective_text' is not null
    and position('thief9' in m::text) = 0 and position('99990000111122223333' in m::text) = 0
    and v_lbl like 'Payment details for Studio A were changed by Asha Admin at %Clients will see the new details from %This wasn''t us%'
    and position('thief9' in v_lbl) = 0, coalesce(m::text, '') || ' | ' || coalesce(v_lbl, ''));
  perform pg_temp.res('16 nothing logged anywhere holds the full new UPI ID / account number (audit_log, events, bells, outbox)',
    not exists (select 1 from public.audit_log a where a.org_id = 'a0000000-0000-4000-8000-000000000001'
                 and (a.changed::text like '%thief9%' or a.changed::text like '%99990000111122223333%' or a.changed::text like '%50100234567890%'))
    and exists (select 1 from public.audit_log a where a.org_id = 'a0000000-0000-4000-8000-000000000001' and a.action = 'payment_details.change_requested'
                 and a.changed ->> 'new_upi' = '****cici' and a.changed ->> 'old_upi' = '****axis')
    and not exists (select 1 from public.studio_security_events e where e.detail::text like '%thief9%' or e.detail::text like '%9999000011112222%')
    and not exists (select 1 from public.notifications n where n.kind = 'studio_security' and n.detail::text like '%thief9%')
    and not exists (select 1 from public.helm_notice_outbox o where o.payload::text like '%thief9%'));
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) who sees what while it waits; no second change; same values need no code -----------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  r := pg_temp.j($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('17 a Control Center editor who is not an admin sees the pending change MASKED, cannot cancel / approve',
    r -> 'pending' ->> 'new_upi' = '****cici' and (r -> 'pending' ->> 'masked')::boolean and not (r -> 'pending' ->> 'can_cancel')::boolean, r::text);
  e := pg_temp.try(format('select public.pay_details_cancel(%L)', pg_temp.get('c1')));
  perform pg_temp.res('18 a non-admin cannot press "This wasn''t us"', e like '42501%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis", "pay_note": "HDFC A/c 50100234567890 IFSC HDFC0001234", "default_template": "builtin:30-50-20"}'::jsonb)$q$);
  perform pg_temp.su();
  perform pg_temp.res('19 saving the page again with the live values (old code) changes nothing and needs no fresh code', e = '' and pg_temp.pending_id() = pg_temp.get('c1')::uuid, e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "other@okhdfc"}'::jsonb)$q$);
  perform pg_temp.res('20 a second change while one is waiting is refused', e like '22023%already waiting%', e);
  e := pg_temp.try(format('select public.pay_details_approve_now(%L)', pg_temp.get('c1')));
  perform pg_temp.res('21 the admin who made the change cannot make it live early', e like '42501%not the person who made the change%', e);
  perform pg_temp.as_user('b_admin@b.test', 'aal1');
  e := pg_temp.try(format('select public.pay_details_cancel(%L)', pg_temp.get('c1')));
  perform pg_temp.res('22 another studio''s admin cannot cancel (not found)', e like '42501%change not found%', e);
  r := pg_temp.j($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('23 another studio sees nothing of Studio A''s change', r -> 'pending' = 'null'::jsonb or r ? 'err', r::text);
  perform pg_temp.as_user('a_admin2@a.test', 'aal1');
  e := pg_temp.try(format('select public.pay_details_approve_now(%L)', pg_temp.get('c1')));
  perform pg_temp.res('24 a different admin WITHOUT two-step cannot approve early', e like '42501%R35_SETUP_2STEP%', e);
  e := pg_temp.try($q$select count(*) from public.pay_detail_changes$q$);
  perform pg_temp.res('25 the tables are closed to the app (direct read refused)', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) "This wasn't us": cancel keeps the old details, alerts everyone, flags the account -------------------------
do $$ declare r jsonb; e text; v_ev uuid; m jsonb; begin
  -- a) an admin WITHOUT two-step: the cancel + alert are instant, but nobody is flagged or signed out
  perform pg_temp.as_user('a_admin2@a.test', 'aal1');
  r := pg_temp.j(format('select public.pay_details_cancel(%L, true)', pg_temp.get('c1')));
  perform pg_temp.su();
  perform pg_temp.res('26a an admin without two-step cancels at once (old details stay, everyone alerted) but cannot flag / sign out',
    (r ->> 'cancelled')::boolean and not (r ->> 'flagged')::boolean and r -> 'signed_out' = 'null'::jsonb
    and exists (select 1 from public.pay_detail_changes where id = pg_temp.get('c1')::uuid and status = 'cancelled' and cancel_kind = 'not_us_unverified')
    and not public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test'))
    and pg_temp.events('pay_details_cancelled_unverified') = 1 and pg_temp.events('sessions_ended') = 0
    and pg_temp.live_upi() = 'studioa@okaxis' and pg_temp.client_upi() = 'studioa@okaxis'
    and exists (select 1 from public.helm_notice_outbox o join public.studio_security_events v on v.id = o.ref_id where v.kind = 'pay_details_cancelled_unverified')
    and exists (select 1 from public.audit_log where action = 'payment_details.cancelled_without_two_step' and org_id = 'a0000000-0000-4000-8000-000000000001'), r::text);
  -- b) the same change again; this time the second admin has two-step + a fresh code
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "thief9@okicici", "pay_note": "SBI A/c 99990000111122223333"}'::jsonb)$q$);
  perform pg_temp.put('c1', (r -> 'pending' ->> 'id'));
  perform pg_temp.factor('a_admin2@a.test');
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 2);
  r := pg_temp.j(format('select public.pay_details_cancel(%L, true)', pg_temp.get('c1')));
  perform pg_temp.res('26 an admin with two-step cancels: the account is flagged, signed out, advice to reset the password',
    (r ->> 'cancelled')::boolean and (r ->> 'flagged')::boolean and r ->> 'advice' like '%reset its password%' and (r -> 'signed_out') ? 'tokens_revoked', r::text);
  e := pg_temp.try(format('select public.studio_flagged_sign_out(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('26b sign-out of the same account again within 10 minutes is refused (one per 10 minutes)', e like '22023%10 minutes%', e);
  perform pg_temp.su();
  perform pg_temp.res('26c every sign-out is audited (one row)',
    (select count(*) from public.audit_log where action = 'studio_security.sessions_ended' and org_id = 'a0000000-0000-4000-8000-000000000001' and at >= now()) = 1);
  perform pg_temp.su();
  select id into v_ev from public.studio_security_events where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'pay_details_cancelled' and at >= now();
  m := public._r285_mail(v_ev);
  perform pg_temp.res('27 cancel works: old details stay for clients, change cancelled (not_us), requester flagged, everyone alerted',
    pg_temp.live_upi() = 'studioa@okaxis' and pg_temp.client_upi() = 'studioa@okaxis' and pg_temp.pending_id() is null
    and exists (select 1 from public.pay_detail_changes where id = pg_temp.get('c1')::uuid and status = 'cancelled' and cancel_kind = 'not_us'
                  and cancelled_by = pg_temp.uid('a_admin2@a.test'))
    and public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test'))
    and exists (select 1 from public.helm_notice_outbox o where o.ref_id = v_ev and o.kind = 'studio_security')
    and m -> 'to' @> '["a_admin@a.test", "a_admin2@a.test"]'::jsonb and m -> 'data' ->> 'target' = 'Asha Admin'
    and exists (select 1 from public.audit_log where action = 'payment_details.cancelled' and org_id = 'a0000000-0000-4000-8000-000000000001')
    and pg_temp.events('sessions_ended') = 1, coalesce(m::text, ''));
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.payment_schedule_settings_set('{"upi_id": "thief9@okicici"}'::jsonb)$q$);
  perform pg_temp.res('28 the flagged account can make no further sensitive change (even with two-step)', e like '42501%R35_FLAGGED%', e);
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 2);
  e := pg_temp.try(format('select public.pay_details_cancel(%L)', pg_temp.get('c1')));
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  perform pg_temp.res('29 a cancelled change cannot be cancelled again', e like '22023%no longer waiting%', e);
  r := pg_temp.j($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('30 admins see the open flag (with who flagged it)', r -> 'flags' -> 0 ->> 'name' = 'Asha Admin' and (r -> 'flags' -> 0 ->> 'is_me')::boolean, r::text);
  e := pg_temp.try(format('select public.studio_flag_clear(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('31 the flagged admin cannot clear their own flag', e like '42501%Another admin%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) auto-apply after 24 hours (read at once, tick writes it) -----------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 3);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "studioa.new@okaxis"}'::jsonb)$q$);
  perform pg_temp.put('c2', r -> 'pending' ->> 'id');
  -- proof: the FLAGGED admin (even with a fresh code) cannot cancel the other admin's change, nor sign them out
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.pay_details_cancel(%L, true)', pg_temp.get('c2')));
  perform pg_temp.res('31a a flagged admin cannot press "This wasn''t us" on another admin''s change', e like '42501%R35_FLAGGED%', e);
  e := pg_temp.try(format('select public.studio_flagged_sign_out(%L)', pg_temp.uid('a_admin2@a.test')));
  perform pg_temp.res('31b a flagged admin cannot sign anyone out', e like '42501%R35_FLAGGED%', e);
  perform pg_temp.su();
  perform pg_temp.res('31c the refused attempts changed nothing (change still waiting, nobody else flagged / signed out)',
    pg_temp.pending_id() = pg_temp.get('c2')::uuid and not public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'))
    and pg_temp.events('sessions_ended') = 1);
  perform pg_temp.res('32 a change of the UPI ID only keeps the live note (only the keys given change)',
    r -> 'pending' ->> 'new_upi' = 'studioa.new@okaxis' and r -> 'pending' ->> 'new_note' like 'HDFC%', r::text);
  perform pg_temp.su();
  update public.pay_detail_changes set effective_at = now() - interval '1 second' where id = pg_temp.get('c2')::uuid;   -- 24 hours later
  perform pg_temp.res('33 after 24 hours clients see the new details at once (on read), before any job ran',
    pg_temp.client_upi() = 'studioa.new@okaxis' and pg_temp.live_upi() = 'studioa@okaxis');
  r := public.pay_details_tick();
  perform pg_temp.res('34 the tick writes it: live settings updated, change applied (auto), admins get a "now shown" bell (no e-mail)',
    (r ->> 'pay_details_applied')::int = 1 and pg_temp.live_upi() = 'studioa.new@okaxis'
    and exists (select 1 from public.pay_detail_changes where id = pg_temp.get('c2')::uuid and status = 'applied' and applied_how = 'auto')
    and pg_temp.events('pay_details_live') = 1
    and not exists (select 1 from public.helm_notice_outbox o join public.studio_security_events s on s.id = o.ref_id where s.kind = 'pay_details_live')
    and exists (select 1 from public.audit_log where action = 'payment_details.applied' and org_id = 'a0000000-0000-4000-8000-000000000001'), r::text);
  r := public.pay_details_tick();
  perform pg_temp.res('35 the tick again changes nothing; comms_tick runs it too', (r ->> 'pay_details_applied')::int = 0
    and position('pay_details_tick' in pg_get_functiondef('public.comms_tick()'::regprocedure)) > 0, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) a different admin approves early (two-step) -----------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 3);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"pay_note": "ICICI A/c 77770000555566664444"}'::jsonb)$q$);
  perform pg_temp.put('c3', r -> 'pending' ->> 'id');
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.pay_details_approve_now(%L)', pg_temp.get('c3')));
  perform pg_temp.res('36 a flagged admin cannot approve early', e like '42501%R35_FLAGGED%', e);
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.studio_flag_clear(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('37 clearing a flag needs two-step', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 2);
  e := pg_temp.try(format('select public.studio_flag_clear(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('38 a different admin clears the flag with two-step (alerted)', e = '' and pg_temp.events('flag_cleared') = 1
    and not public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test')), e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.pay_details_approve_now(%L)', pg_temp.get('c3')));
  perform pg_temp.res('39 approve early with an old code (signed in hours ago): refused (code needed)', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  r := pg_temp.j(format('select public.pay_details_approve_now(%L)', pg_temp.get('c3')));
  perform pg_temp.su();
  perform pg_temp.res('40 a DIFFERENT admin with two-step makes it live early: applied (early), clients see it, alerted + logged',
    (r ->> 'applied')::boolean
    and (select pay_note from public.payment_schedule_settings where org_id = 'a0000000-0000-4000-8000-000000000001') like 'ICICI%'
    and public._pst_pay_details('a0000000-0000-4000-8000-00000000da01') ->> 'note' like 'ICICI%'
    and exists (select 1 from public.pay_detail_changes where id = pg_temp.get('c3')::uuid and applied_how = 'early' and applied_by = pg_temp.uid('a_admin@a.test'))
    and pg_temp.events('pay_details_approved_early') = 1
    and exists (select 1 from public.audit_log where action = 'payment_details.approved_early' and changed ->> 'new_note' = '****4444'), r::text);
  -- withdrawing your own change: cancelled, NOT flagged
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "studioa.v3@okaxis"}'::jsonb)$q$);
  r := pg_temp.j(format('select public.pay_details_cancel(%L)', r -> 'pending' ->> 'id'));
  perform pg_temp.su();
  perform pg_temp.res('41 withdrawing your own change: cancelled (withdrawn), you are not flagged',
    (r ->> 'cancelled')::boolean and not (r ->> 'flagged')::boolean and pg_temp.events('pay_details_withdrawn') = 1
    and not public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test')), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) the other sensitive settings: two-step + alert, no wait ------------------------------------------------------
do $$ declare e text; v jsonb; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.studio_email_settings_set('Studio A', 'billing@studioa.in')$q$);
  perform pg_temp.res('42 reply-to change with an old code (signed in hours ago): refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.studio_email_settings_set('Studio A', 'billing@studioa.in')$q$);
  perform pg_temp.su();
  select detail into v from public.studio_security_events where kind = 'reply_to_changed' and org_id = 'a0000000-0000-4000-8000-000000000001' and at >= now();
  perform pg_temp.res('43 reply-to change with two-step: saved + alerted (masked address)', e = ''
    and (select email_reply_to from public.comms_settings where org_id = 'a0000000-0000-4000-8000-000000000001') = 'billing@studioa.in'
    and v ->> 'new' = 'b***@studioa.in', e || ' ' || coalesce(v::text, ''));
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.studio_email_settings_set('Studio A Events', 'billing@studioa.in')$q$);
  perform pg_temp.res('44 changing only the sender name needs no code', e = '', e);
  -- business e-mail: the first confirmation is not blocked; changing a confirmed one is
  perform pg_temp.su(); update public.organizations set business_email = 'hello@studioa.in', business_email_confirmed = false where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$update public.organizations set business_email = 'hello@studioa.in', business_email_confirmed = true where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('45 business e-mail: confirming the first address (onboarding) is allowed with an old code (signed in hours ago)', e = '', e);
  e := pg_temp.try($q$update public.organizations set business_email = 'pay@thief.example', business_email_confirmed = true where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('46 business e-mail: changing a confirmed address with an old code (signed in hours ago) is refused', e like '42501%R35_REAUTH%', e);
  e := pg_temp.try($q$update public.organizations set business_email_confirmed = false where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('46b business e-mail: un-confirming a confirmed address first (the way round) is refused too', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$update public.organizations set business_email = 'team@studioa.in', business_email_confirmed = true where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.su();
  perform pg_temp.res('47 business e-mail with two-step: saved + alerted', e = '' and pg_temp.events('business_email_changed') >= 1
    and (select business_email from public.organizations where id = 'a0000000-0000-4000-8000-000000000001') = 'team@studioa.in', e);
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare e text; begin
  -- Control Center money switches
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'finance', true, true)$q$);
  perform pg_temp.res('48 money switch (finance) change with an old code (signed in hours ago): refused', e like '42501%R35_REAUTH%', e);
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'discount_approve', true, true)$q$);
  perform pg_temp.res('49 money switch (discount_approve) with an old code (signed in hours ago): refused', e like '42501%R35_REAUTH%', e);
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'calendar', true, false)$q$);
  perform pg_temp.res('50 a non-money switch still saves with an old code (signed in hours ago)', e = '', e);
  e := pg_temp.try($q$select public.admin_set_role_access('sales', 'finance', true, true)$q$);
  perform pg_temp.res('51 saving a money switch with the SAME values needs no code', e = '', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.admin_set_role_access('planner', 'close_owed', true, true)$q$);
  perform pg_temp.su();
  perform pg_temp.res('52 money switch with two-step: saved + alerted', e = '' and pg_temp.events('money_access_changed') = 1
    and exists (select 1 from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'planner' and area = 'close_owed' and can_edit), e);
  perform pg_temp.as_user('a_staff@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.admin_set_role_access('sales', 'finance', true, true)$q$);
  perform pg_temp.res('53 a non-admin still cannot change the matrix', e like '42501%', e);
  -- Razorpay
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.save_org_payment_account('rzp_live_ABCDEF123456', 'secretsecret', 'whsecwhsec')$q$);
  perform pg_temp.res('54 Razorpay keys with an old code (signed in hours ago): refused before anything is stored', e like '42501%R35_REAUTH%'
    and not exists (select 1 from public.org_payment_accounts where org_id = 'a0000000-0000-4000-8000-000000000001'), e);
  e := pg_temp.try($q$select public.set_org_integration_status('razorpay', 'disabled')$q$);
  perform pg_temp.res('55 Razorpay off with an old code (signed in hours ago): refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.set_org_integration_status('razorpay', 'disabled')$q$);
  perform pg_temp.su();
  perform pg_temp.res('56 Razorpay off with two-step: done + alerted', e = '' and pg_temp.events('razorpay_status_changed') = 1, e);
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare e text; begin
  -- admins added / removed
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.create_invitation('newadmin@studioa.in', 'admin')$q$);
  perform pg_temp.res('57 inviting an ADMIN with an old code: refused', e like '42501%R35_REAUTH%', e);
  e := pg_temp.try($q$select public.create_invitation('newsales@studioa.in', 'sales')$q$);
  perform pg_temp.res('58 inviting a non-admin still works without a fresh code', e = '', e);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''admin'')', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.res('59 making someone an admin with an old code: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try($q$select public.create_invitation('newadmin@studioa.in', 'admin')$q$);
  perform pg_temp.su();
  perform pg_temp.res('60 inviting an admin with two-step: done + alerted (masked address)', e = ''
    and exists (select 1 from public.studio_security_events where kind = 'admin_invited' and detail ->> 'target_email' = 'n***@studioa.in'), e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''admin'')', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('61 making someone an admin with two-step: done + every admin alerted (incl. the new one)', e = ''
    and (select role from public.profiles where id = pg_temp.uid('a_staff@a.test')) = 'admin' and pg_temp.events('admin_added') = 1
    and public._r285_mail((select id from public.studio_security_events where kind = 'admin_added' and org_id = 'a0000000-0000-4000-8000-000000000001' and at >= now())) -> 'to' ? 'a_staff@a.test', e);
  -- since 0283 only the studio owner (a_admin, the first admin) removes another admin at once; anyone else asks from
  -- Control Center -> Team (24 hours, section 11 below). The owner still needs two-step + a fresh code (0285).
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''sales'')', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.res('62 removing an admin with an old code: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''sales'')', pg_temp.uid('a_staff@a.test')));
  perform pg_temp.su();
  perform pg_temp.res('63 removing an admin with two-step: done + alerted (the removed person is told too)', e = '' and pg_temp.events('admin_removed') = 1
    and public._r285_mail((select id from public.studio_security_events where kind = 'admin_removed' and org_id = 'a0000000-0000-4000-8000-000000000001' and at >= now())) -> 'to' ? 'a_staff@a.test', e);
  -- self-service + system: never blocked
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  perform pg_temp.su(); perform set_config('request.jwt.claims', '', false);
  update public.profiles set role = 'admin' where id = pg_temp.uid('b_staff@b.test');
  update public.profiles set role = 'sales' where id = pg_temp.uid('b_staff@b.test');
  perform pg_temp.res('64 database / system changes (no signed-in person) are not blocked and not alerted',
    not exists (select 1 from public.studio_security_events where org_id = 'b0000000-0000-4000-8000-000000000001'));
  -- two-step turned off for an admin
  delete from auth.mfa_factors where user_id = pg_temp.uid('a_admin2@a.test');
  perform pg_temp.res('65 two-step removed for an admin: every admin alerted', pg_temp.events('two_step_off') = 1);
  -- sign out a flagged account only
  perform pg_temp.as_user('a_admin2@a.test', 'aal1');
  e := pg_temp.try(format('select public.studio_flagged_sign_out(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('66 "sign out everywhere" works only for a flagged account', e like '22023%flagged%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try($q$select public.studio_security_events_list(20)$q$);
  perform pg_temp.res('67 admins read their studio''s security history (masked); a non-admin cannot', e = ''
    and pg_temp.try($q$select 1$q$) = '', e);
  perform pg_temp.as_user('a_staff@a.test', 'aal1');
  e := pg_temp.try($q$select public.studio_security_events_list(20)$q$);
  perform pg_temp.res('68 a non-admin cannot read the security history', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('69 every bell row is admin-only (restrictive policy) and the app can never write one',
    exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'r285_sec_read' and permissive = 'RESTRICTIVE')
    and exists (select 1 from pg_policies where tablename = 'notifications' and policyname = 'r285_sec_ins')
    and public.notify_default('a0000000-0000-4000-8000-000000000001', 'admin', 'studio_security', 'in_app')
    and not public.notify_default('a0000000-0000-4000-8000-000000000001', 'sales', 'studio_security', 'in_app')
    and exists (select 1 from jsonb_array_elements(public.notification_catalog()) c where c ->> 'type' = 'studio_security'));
  perform pg_temp.res('70 records are kept: events cannot be changed or deleted',
    pg_temp.try($q$delete from public.pay_detail_changes$q$) like '42501%'
    and pg_temp.try($q$update public.studio_security_events set kind = 'x'$q$) like '42501%');
exception when others then perform pg_temp.su(); insert into _rs values ('Ax', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 10) last resort: every admin flagged -> only the Helm HQ Owner (two-step + fresh code, reason, audited) -----------
do $$ declare e text; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  insert into _kv select 'uid:' || u.email, u.id::text from auth.users u where u.email = 'admin@helm.events' on conflict (k) do nothing;
  insert into public.studio_account_flags(org_id, user_id, reason) values
    ('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test'), 'test: both admins flagged'),
    ('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'), 'test: both admins flagged');
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.studio_flag_clear(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('71 both admins flagged: neither can clear the other (stuck inside the studio)', e like '42501%R35_FLAGGED%', e);
  e := pg_temp.try(format('select public.hq_studio_flag_clear(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'), 'video call, ID checked against the signup'));
  perform pg_temp.res('72 a studio admin cannot use the HQ way out', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 30);
  e := pg_temp.try(format('select public.hq_studio_flag_clear(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'), 'video call, ID checked against the signup'));
  perform pg_temp.res('73 the HQ Owner with an old code is asked for a fresh one', e like '42501%HQ_REAUTH%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 1);
  e := pg_temp.try(format('select public.hq_studio_flag_clear(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'), 'too short'));
  perform pg_temp.res('74 a written reason (20+ characters) is required', e like '22023%20 characters%', e);
  e := pg_temp.try(format('select public.hq_studio_flag_clear(%L, %L, %L)', 'a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'), 'video call, ID checked against the signup'));
  perform pg_temp.su();
  perform pg_temp.res('75 the HQ Owner (two-step, fresh code) clears one flag: audited in HQ + the studio, every admin told',
    e = '' and not public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin2@a.test'))
    and public._r285_flagged('a0000000-0000-4000-8000-000000000001', pg_temp.uid('a_admin@a.test'))
    and exists (select 1 from public.audit_log where action = 'hq.studio.flag_clear' and at >= now())
    and exists (select 1 from public.audit_log where action = 'studio_security.flag_cleared_by_hq' and org_id = 'a0000000-0000-4000-8000-000000000001')
    and exists (select 1 from public.studio_security_events v join public.helm_notice_outbox o on o.ref_id = v.id
                 where v.kind = 'flag_cleared' and v.detail ->> 'by' = 'Helm support (HQ owner)'), e);
  perform pg_temp.factor('a_admin2@a.test');
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.studio_flag_clear(%L)', pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('76 then the cleared admin (two-step) can clear the other one inside the studio', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('Bx', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 11) with 0283 (r33): the Control Center -> Team paths need two-step too; one alert per person -----------------------
-- studio A: a_admin is the owner (first admin), a_admin2 a second admin, a_staff made an admin for these checks
create or replace function pg_temp.sec_bells() returns integer language sql as $$
  select count(*)::int from public.notifications where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'studio_security' $$;
create or replace function pg_temp.team_bells(p_event text) returns integer language sql as $$
  select count(*)::int from public.notifications where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'team_safety'
     and detail ->> 'event' = p_event $$;
-- the r33-routed removal asked by p_asker in this test (one transaction: every row has the same now(), so not by time)
create or replace function pg_temp.removed_by(p_asker text) returns uuid language sql as $$
  select id from public.studio_security_events where org_id = 'a0000000-0000-4000-8000-000000000001' and kind = 'admin_removed'
     and at >= now() and detail ->> 'r33_asker' = pg_temp.uid(p_asker)::text limit 1 $$;
do $$ declare e text; r jsonb; s uuid; ch uuid; n_sec int; n_ev int; m jsonb; t uuid; begin
  perform pg_temp.su();
  s := pg_temp.uid('a_staff@a.test');
  perform pg_temp.factor('a_admin@a.test'); perform pg_temp.factor('a_admin2@a.test');
  update public.studio_account_flags set cleared_at = now(), cleared_by = pg_temp.uid('a_admin@a.test') where org_id = 'a0000000-0000-4000-8000-000000000001' and cleared_at is null;
  update public.profiles set role = 'admin' where id = s;   -- the database itself: not gated, not alerted
  -- a) a non-owner admin's 24-hour removal request (team_set_role)
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_set_role(%L, ''sales'')', s));
  perform pg_temp.su();
  perform pg_temp.res('77 r33 24-hour removal request by a non-owner admin with an old code: refused, nothing scheduled',
    e like '42501%R35_REAUTH%' and not exists (select 1 from public.team_admin_changes where target_user = s and status = 'pending'), e);
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 1);
  r := pg_temp.j(format('select public.team_set_role(%L, ''sales'')', s));
  perform pg_temp.su();
  ch := (r ->> 'change_id')::uuid;
  perform pg_temp.res('78 ... with two-step: scheduled for 24 hours (r33 rules unchanged), still an admin now',
    (r ->> 'scheduled')::boolean and (select role from public.profiles where id = s) = 'admin'
    and (select requested_by from public.team_admin_changes where id = ch) = pg_temp.uid('a_admin2@a.test'), r::text);
  -- b) the 24 hours pass and the Team page applies it: r33 tells the owner / that admin / the asker; r35 adds no second bell
  update public.team_admin_changes set effective_at = now() - interval '1 minute' where id = ch;
  n_sec := pg_temp.sec_bells(); n_ev := pg_temp.events('admin_removed');
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 1);
  perform public.team_safety_overview();
  perform pg_temp.su();
  m := public._r285_mail(pg_temp.removed_by('a_admin2@a.test'));
  perform pg_temp.res('79 applied after 24 hours: demoted; r35 records it (marked r33) but rings no second bell and e-mails nobody r33 already told',
    (select role from public.profiles where id = s) = 'sales' and (select status from public.team_admin_changes where id = ch) = 'applied'
    and pg_temp.events('admin_removed') = n_ev + 1 and pg_temp.sec_bells() = n_sec
    and (select (detail ->> 'via_r33')::boolean from public.studio_security_events where id = pg_temp.removed_by('a_admin2@a.test'))
    and jsonb_array_length(m -> 'to') = 0 and not (m -> 'data' ? 'via_r33')
    and exists (select 1 from public.team_safety_events x where x.event = 'admin_change_applied' and (x.detail ->> 'change_id')::uuid = ch),
    coalesce(m::text, 'no mail'));
  -- c) the owner removes an admin at once through Team
  update public.profiles set role = 'admin' where id = s;
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_set_role(%L, ''sales'')', s));
  perform pg_temp.res('80 the owner removing an admin through Team with an old code: refused', e like '42501%R35_REAUTH%', e);
  n_sec := pg_temp.sec_bells();
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.team_set_role(%L, ''sales'')', s));
  perform pg_temp.su();
  m := public._r285_mail(pg_temp.removed_by('a_admin@a.test'));
  perform pg_temp.res('81 ... with two-step: done at once; ONE bell (r33 admin_demoted), r35 e-mails only the admins r33 did not (a_admin2)',
    e = '' and (select role from public.profiles where id = s) = 'sales' and pg_temp.team_bells('admin_demoted') >= 1 and pg_temp.sec_bells() = n_sec
    and m -> 'to' = '["a_admin2@a.test"]'::jsonb, e || ' ' || coalesce(m::text, 'no mail'));
  -- d) making someone an admin through Team: r33 sends nothing for it, so the r35 alert (bell + e-mail) still goes
  n_sec := pg_temp.sec_bells();
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_set_role(%L, ''admin'')', s));
  perform pg_temp.res('82 making an admin through Team with an old code: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.team_set_role(%L, ''admin'')', s));
  perform pg_temp.su();
  perform pg_temp.res('83 ... with two-step: done + the r35 admin_added bell (no r33 notice for a promotion)',
    e = '' and (select role from public.profiles where id = s) = 'admin' and pg_temp.sec_bells() = n_sec + 1, e);
  -- e) deactivating / reactivating an admin; a non-admin is not gated
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_deactivate_member(%L)', s));
  perform pg_temp.su();
  perform pg_temp.res('84 deactivating an admin with an old code: refused (still active)',
    e like '42501%R35_REAUTH%' and not public._r283_is_off(s, 'a0000000-0000-4000-8000-000000000001'), e);
  perform pg_temp.su(); delete from auth.mfa_factors where user_id = pg_temp.uid('a_admin2@a.test');
  perform pg_temp.as_user('a_admin2@a.test', 'aal1');
  e := pg_temp.try(format('select public.team_deactivate_member(%L)', s));
  perform pg_temp.res('85 an admin with no two-step at all is told to set it up (deactivating an admin)', e like '42501%R35_SETUP_2STEP%', e);
  perform pg_temp.factor('a_admin2@a.test');
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.team_deactivate_member(%L)', s));
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  t := pg_temp.member('r35_crew@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001');
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := e || pg_temp.try(format('select public.team_deactivate_member(%L)', t));
  perform pg_temp.su();
  perform pg_temp.res('86 ... with two-step the owner deactivates the admin at once; a non-admin needs no fresh code',
    e = '' and public._r283_is_off(s, 'a0000000-0000-4000-8000-000000000001') and public._r283_is_off(t, 'a0000000-0000-4000-8000-000000000001'), e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_reactivate_member(%L)', s));
  perform pg_temp.res('87 reactivating an admin with an old code: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.team_reactivate_member(%L)', s));
  perform pg_temp.su();
  perform pg_temp.res('88 ... with two-step: reactivated', e = '' and not public._r283_is_off(s, 'a0000000-0000-4000-8000-000000000001'), e);
  -- f) the ownership hand-over: starting and accepting both need two-step
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_owner_transfer_start(%L)', pg_temp.uid('a_admin2@a.test')));
  perform pg_temp.res('89 starting an ownership hand-over with an old code: refused', e like '42501%R35_REAUTH%', e);
  perform pg_temp.as_user('a_admin@a.test', 'aal2', 1);
  r := pg_temp.j(format('select public.team_owner_transfer_start(%L)', pg_temp.uid('a_admin2@a.test')));
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 300);
  e := pg_temp.try(format('select public.team_owner_transfer_accept(%L)', r ->> 'transfer_id'));
  perform pg_temp.su();
  perform pg_temp.res('90 accepting it with an old code: refused (the owner is unchanged)',
    e like '42501%R35_REAUTH%' and public._r283_owner('a0000000-0000-4000-8000-000000000001') = pg_temp.uid('a_admin@a.test'), e || ' ' || r::text);
  perform pg_temp.as_user('a_admin2@a.test', 'aal2', 1);
  e := pg_temp.try(format('select public.team_owner_transfer_accept(%L)', r ->> 'transfer_id'));
  perform pg_temp.su();
  perform pg_temp.res('91 ... with two-step on both sides: a_admin2 is the owner',
    e = '' and public._r283_owner('a0000000-0000-4000-8000-000000000001') = pg_temp.uid('a_admin2@a.test'), e);
  -- g) one notification catalog with both types; the r33 bodies kept underneath, not callable by the app
  perform pg_temp.res('92 the bell catalog keeps team_safety (0283) AND studio_security (0285); both admin-only by default',
    (select count(*) from jsonb_array_elements(public.notification_catalog()) x where x ->> 'type' in ('team_safety', 'studio_security')) = 2
    and public.notification_type_of('team_safety', 'in_app') = 'team_safety' and public.notification_type_of('studio_security', 'in_app') = 'studio_security'
    and public.notify_default('a0000000-0000-4000-8000-000000000001', 'admin', 'studio_security', 'in_app')
    and public.notify_default('a0000000-0000-4000-8000-000000000001', 'admin', 'team_safety', 'in_app')
    and not public.notify_default('a0000000-0000-4000-8000-000000000001', 'sales', 'studio_security', 'in_app')
    and not public.notify_default('a0000000-0000-4000-8000-000000000001', 'sales', 'team_safety', 'in_app'));
  perform pg_temp.res('93 one e-mail lane each: team_safety + studio_security in the outbox kinds and the claim; the r33 Team bodies kept, not callable',
    position('''team_safety''' in pg_get_constraintdef((select oid from pg_constraint where conname = 'helm_notice_outbox_kind_check'))) > 0
    and position('''studio_security''' in pg_get_constraintdef((select oid from pg_constraint where conname = 'helm_notice_outbox_kind_check'))) > 0
    and position('''team_safety''' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
    and position('''studio_security''' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
    and position('r33-0283' in pg_get_functiondef('public.team_set_role__pre0285(uuid, text)'::regprocedure)) > 0
    and position('r33-0283' in pg_get_functiondef('public.team_owner_transfer_start__pre0285(uuid)'::regprocedure)) > 0
    and not has_function_privilege('authenticated', 'public.team_set_role__pre0285(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.team_deactivate_member__pre0285(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.team_set_role(uuid, text)', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('Cx', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.su();
select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R35-PAYSAFE-0285: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R35-PAYSAFE-0285: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
