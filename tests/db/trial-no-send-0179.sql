-- trial-no-send-0179.sql -- 0179: a free-trial studio sends NO real client message (approval code by
-- SMS / WhatsApp / e-mail, staff WhatsApp, proposal WhatsApp), the edge-function check
-- trial_send_blocked answers for org / quote / link, a queued row put back to 'pending' is skipped
-- again, and the seat limit (admin + 2, open invitations included) also holds on a role change
-- client -> staff role. Paid studio: unchanged. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

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
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text;
begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin', p_org uuid default null) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'own');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;

-- earlier suites in run-all re-apply older migrations over the wrappers: re-run 0179 (also proves a re-run is safe)
\ir ../../supabase/migrations/0179_trial_no_client_messages.sql

-- ---- setup: one trial studio with a real (not demo) event + approval link -------------------------
do $$ declare o uuid; q uuid := gen_random_uuid(); tok uuid := gen_random_uuid(); bt uuid := gen_random_uuid(); begin
  o := pg_temp.trial('tn_admin@t.test');
  perform pg_temp.put('o', o::text); perform pg_temp.put('q', q::text); perform pg_temp.put('tok', tok::text);
  perform set_config('helm.maintenance', 'on', true);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token,
                            event_date, created_at, updated_at)
    values (q, 'TN-0001', 'Trial wedding', 'quote', '{"name":"Tara","phone":"98765 43219","email":"tara@example.com"}'::jsonb,
            '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', o, tok, current_date + 30, now(), now());
  perform set_config('helm.maintenance', 'off', true);
  perform pg_temp.res('00 setup: trial studio is on its free trial', public._is_trial_org(o));
exception when others then perform pg_temp.su(); insert into _uf values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) trial: every direct send path refuses --------------------------------------------------------
do $$ declare e text; o uuid := pg_temp.get('o')::uuid; q uuid := pg_temp.get('q')::uuid; tok uuid := pg_temp.get('tok')::uuid;
  A uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.svc();
  perform pg_temp.res('01 trial_send_blocked(org) = true for the trial studio', public.trial_send_blocked(o, null, null));
  perform pg_temp.res('02 trial_send_blocked(quote) / (token) = true', public.trial_send_blocked(null, q, null) and public.trial_send_blocked(null, null, tok));
  perform pg_temp.res('03 paid studio: trial_send_blocked = false (org / quote / token)',
    not public.trial_send_blocked(A, null, null) and not public.trial_send_blocked(null, qA, null)
    and not public.trial_send_blocked(null, null, 'a0000000-0000-4000-8000-0000000000aa'::uuid)
    and not public.trial_send_blocked(null, null, null));
  perform pg_temp.res('04 sample master never sends', public.trial_send_blocked('a5a5a5a5-0166-4000-8000-000000000001'::uuid, null, null));
  e := pg_temp.try(format('select public.otp_send_authorize(%L, %L)', tok, '9876543219'));
  perform pg_temp.res('10 trial: SMS code authorize refused (trial_no_send)', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.wa_otp_begin(%L, ''whatsapp'', null)', tok));
  perform pg_temp.res('11 trial: WhatsApp code refused', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.wa_otp_begin(%L, ''email'', null)', tok));
  perform pg_temp.res('12 trial: e-mail code refused', e like '42501%[trial_no_send]', e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.request_otp(%L, %L)', tok, '9876543219'));
  perform pg_temp.res('13 trial: request_otp (portal) refused', e like '42501%[trial_no_send]', e);
  -- (service role: an earlier run-all suite may re-apply older grants on wa_request_otp)
  perform pg_temp.svc();
  e := pg_temp.try(format('select public.wa_request_otp(%L, ''whatsapp'', null)', tok));
  perform pg_temp.res('14 trial: wa_request_otp (simulated portal path) refused', e like '42501%[trial_no_send]', e);
  perform pg_temp.login('tn_admin@t.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, ''9876543219'')', q));
  perform pg_temp.res('15 trial: staff Send on WhatsApp refused (0155 opt-in exception gone)', e like '42501%[trial_no_send]', e);
  perform pg_temp.su();
  insert into public.wa_proposal_optins(org_id, quote_id, phone_e164, opted_in, consent_text) values (o, q, '+919876543219', true, 'Client agreed');
  perform pg_temp.login('tn_admin@t.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, ''9876543219'')', q));
  perform pg_temp.res('16 trial: refused even with an opt-in on record', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.wa_proposal_prepare(%L, ''proposal_sent'', ''+919876543219'', true, ''Client agreed'', false)', q));
  perform pg_temp.res('17 trial: real proposal WhatsApp prepare refused', e like '42501%[trial_no_send]', e);
  e := pg_temp.try(format('select public.wa_proposal_prepare(%L, ''proposal_sent'', ''+919876543219'', true, ''Client agreed'', true)', q));
  perform pg_temp.res('18 trial: SIMULATED prepare is not trial-blocked (nothing is sent)', e not like '%trial_no_send%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('1x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) paid studio: unchanged ----------------------------------------------------------------------
do $$ declare e text; r jsonb; qA uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.su();
  update public.quotes set client = '{"name":"Alice","phone":"98765 43210","email":"alice@example.com"}'::jsonb,
         event_date = current_date + 30 where id = qA;
  perform pg_temp.svc();
  e := pg_temp.try($q$select public.otp_send_authorize('a0000000-0000-4000-8000-0000000000aa', '9876543210')$q$);
  perform pg_temp.res('20 paid: SMS code authorize not trial-blocked', e not like '%trial_no_send%', e);
  e := pg_temp.try($q$select public.wa_otp_begin('a0000000-0000-4000-8000-0000000000aa', 'email', null)$q$);
  perform pg_temp.res('21 paid: e-mail code not trial-blocked', e not like '%trial_no_send%', e);
  perform pg_temp.login('a_admin@a.test');
  r := public.whatsapp_authorize(qA, '9876543210');
  perform pg_temp.res('22 paid: staff WhatsApp authorized', r ->> 'to' = '919876543210', r::text);
  e := pg_temp.try(format('select public.wa_proposal_prepare(%L, ''proposal_sent'', ''+919876543210'', true, ''Client agreed'', false)', qA));
  perform pg_temp.res('23 paid: real proposal prepare not trial-blocked', e not like '%trial_no_send%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) outbox: back to pending is skipped again (trial), paid untouched -----------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; q uuid := pg_temp.get('q')::uuid; v uuid; w uuid;
  A uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01'; begin
  perform pg_temp.su();
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (o, q, 'follow_up', 'whatsapp', '919876543219', '{"text":"hi"}', 'tb179:fu:1', 'pending') returning id into v;
  perform pg_temp.res('30 trial: queued row stored as skipped', (select status from public.comms_outbox where id = v) = 'skipped');
  update public.comms_outbox set status = 'pending', sent_at = null, claimed_at = null where id = v;
  perform pg_temp.res('31 trial: put back to pending -> skipped again', (select status from public.comms_outbox where id = v) = 'skipped',
    (select status from public.comms_outbox where id = v));
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, payload, dedupe_key, status)
    values (o, q, 'client', 'email', 'pkg_accepted', 'tara@example.com', '{}', 'tb179:pkg:1', 'pending') returning id into w;
  update public.pkg_outbox set status = 'pending', sent_at = null where id = w;
  perform pg_temp.res('32 trial: package row back to pending -> skipped', (select status from public.pkg_outbox where id = w) = 'skipped');
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (A, qA, 'follow_up', 'email', 'alice@example.com', '{"text":"hi"}', 'tb179:fu:paid', 'failed') returning id into v;
  update public.comms_outbox set status = 'pending' where id = v;
  perform pg_temp.res('33 paid: retry back to pending stays pending', (select status from public.comms_outbox where id = v) = 'pending',
    (select status from public.comms_outbox where id = v));
exception when others then perform pg_temp.su(); insert into _uf values ('3x outbox', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) seats: role change client -> staff counts (admin + 2, open invitations included) -----------
do $$ declare e text; o uuid := pg_temp.get('o')::uuid; c1 uuid; c2 uuid; c3 uuid; inv uuid; A uuid := 'a0000000-0000-4000-8000-000000000001'; pc uuid; begin
  c1 := pg_temp.newuser('tn_c1@t.test', 'client', o);
  c2 := pg_temp.newuser('tn_c2@t.test', 'client', o);
  c3 := pg_temp.newuser('tn_c3@t.test', 'client', o);
  perform pg_temp.res('40 clients do not use seats', (select count(*) from public.profiles where org_id = o and role = 'client') = 3);
  perform pg_temp.login('tn_admin@t.test');
  e := pg_temp.try('select public.create_invitation(''tn_s1@t.test'', ''sales'')');
  perform pg_temp.res('41 trial: 1 staff invitation OK', e = '', e);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''manager'')', c1));
  perform pg_temp.res('42 trial: promote client 1 -> manager OK (admin + invite + 1 = 3)', e = '', e);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''manager'')', c2));
  perform pg_temp.res('43 trial: promote client 2 refused (seat_limit, pending invite counted)', e like '42501%[seat_limit]', e);
  perform pg_temp.su();
  perform pg_temp.res('44 refused promotion left the role unchanged', (select role from public.profiles where id = c2) = 'client');
  -- an open client invitation switched to a staff role when the seats are full
  perform pg_temp.su();
  insert into public.invitations(org_id, email, role, status, expires_at)
    values (o, 'tn_cinv@t.test', 'client', 'pending', now() + interval '7 days') returning id into inv;
  e := pg_temp.try(format('update public.invitations set role = ''sales'' where id = %L', inv));
  perform pg_temp.res('45 trial: client invitation -> sales refused when full', e like '42501%[seat_limit]', e);
  -- joining through another path also counts the open invitation
  e := pg_temp.try(format('update public.profiles set role = ''sales'' where id = %L', c3));
  perform pg_temp.res('46 trial: direct role change client -> sales refused when full', e like '42501%[seat_limit]', e);
  -- revoke the open invitation: a seat is free again
  update public.invitations set status = 'revoked' where org_id = o and email = 'tn_s1@t.test';
  perform pg_temp.login('tn_admin@t.test');
  e := pg_temp.try(format('select public.admin_set_role(%L, ''sales'')', c2));
  perform pg_temp.res('47 trial: after revoking the invite, promotion OK', e = '', e);
  e := pg_temp.try(format('select public.admin_set_role(%L, ''operations'')', c2));
  perform pg_temp.res('48 trial: staff -> other staff role is not a new seat', e = '', e);
  perform pg_temp.su();
  -- paid studio: no limit
  pc := pg_temp.newuser('tn_paidc@t.test', 'client', A);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.admin_set_role(%L, ''manager'')', pc));
  perform pg_temp.res('49 paid: client -> manager OK (no seat limit)', e = '', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('4x seats', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) shape / privileges ---------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('50 each wrapped body kept once as __pre0179',
    to_regprocedure('public.otp_send_authorize__pre0179(uuid, text)') is not null
    and to_regprocedure('public.request_otp__pre0179(uuid, text)') is not null
    and to_regprocedure('public.wa_otp_begin__pre0179(uuid, text, text)') is not null
    and to_regprocedure('public.whatsapp_authorize__pre0179(uuid, text)') is not null
    and to_regprocedure('public.wa_proposal_prepare__pre0179(uuid, text, text, boolean, text, boolean)') is not null
    and to_regprocedure('public.otp_send_authorize__pre0179__pre0179(uuid, text)') is null);
  perform pg_temp.res('51 wrappers keep their callers',
    has_function_privilege('anon', 'public.request_otp(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.whatsapp_authorize(uuid, text)', 'execute')
    and has_function_privilege('authenticated', 'public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)', 'execute')
    and has_function_privilege('service_role', 'public.otp_send_authorize(uuid, text)', 'execute')
    and has_function_privilege('service_role', 'public.wa_otp_begin(uuid, text, text)', 'execute'));
  perform pg_temp.res('52 server-only entry points stay closed to the app',
    not has_function_privilege('anon', 'public.otp_send_authorize(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.otp_send_authorize(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.wa_otp_begin(uuid, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_otp_begin(uuid, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.whatsapp_authorize(uuid, text)', 'execute'));
  perform pg_temp.res('53 kept bodies + helpers: service role only',
    not has_function_privilege('anon', 'public.request_otp__pre0179(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.whatsapp_authorize__pre0179(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.wa_proposal_prepare__pre0179(uuid, text, text, boolean, text, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_send_blocked(uuid, uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.trial_send_blocked(uuid, uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tb179_no_send(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.trial_send_blocked(uuid, uuid, uuid)', 'execute'));
  perform pg_temp.res('54 triggers present (role change seats, outbox retry)',
    (select count(*) from pg_trigger where tgname = 'zzzz_tb179_seat_role' and not tgisinternal) = 2
    and (select count(*) from pg_trigger where tgname = 'zzzz_tb179_outbox_skip_upd' and not tgisinternal) = 3);
  perform pg_temp.res('55 bookkeeping table closed to the app',
    not has_table_privilege('authenticated', 'public.tb179_grants', 'select') and not has_table_privilege('anon', 'public.tb179_grants', 'select'));
exception when others then perform pg_temp.su(); insert into _uf values ('5x shape', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) trial bundle: an ENDED unpaid trial (read-only, _trial_locked) does not start sending ----------
do $$ declare o uuid; q uuid := gen_random_uuid(); tok uuid := gen_random_uuid(); e text; begin
  o := pg_temp.trial('tn_ended@t.test');
  perform set_config('helm.maintenance', 'on', true);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token,
                            event_date, created_at, updated_at)
    values (q, 'TN-0002', 'Ended trial wedding', 'quote', '{"name":"Tara","phone":"98765 43219","email":"tara@example.com"}'::jsonb,
            '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', o, tok, current_date + 30, now(), now());
  update public.organizations set trial_ends_at = now() - interval '3 days' where id = o;
  update public.studio_subscriptions set status = 'past_due', trial_ends_at = current_date - 3 where org_id = o;
  perform set_config('helm.maintenance', 'off', true);
  perform pg_temp.svc();
  perform pg_temp.res('60 ended unpaid trial (past_due, read-only): trial_send_blocked = true (org / quote / token)',
    public._trial_locked(o) and not public._is_trial_org(o)
    and public.trial_send_blocked(o, null, null) and public.trial_send_blocked(null, q, null) and public.trial_send_blocked(null, null, tok));
  e := pg_temp.try(format('select public.otp_send_authorize(%L, %L)', tok, '9876543219'));
  perform pg_temp.res('61 ended unpaid trial: SMS code authorize refused (trial_no_send)', e like '42501%[trial_no_send]', e);
  perform pg_temp.su();
  perform set_config('helm.maintenance', 'on', true);
  update public.studio_subscriptions set status = 'active', current_period_start = current_date, current_period_end = current_date + 30 where org_id = o;
  perform set_config('helm.maintenance', 'off', true);
  perform pg_temp.svc();
  perform pg_temp.res('62 the same studio once on a paid plan: not blocked', not public.trial_send_blocked(o, null, null));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('6x ended trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select pg_temp.su();
select name, result from _uf order by name;
select case when (select count(*) from _uf where result <> 'PASS') = 0
            then 'TRIAL-NO-SEND-0179: ALL PASS (' || (select count(*) from _uf) || '/' || (select count(*) from _uf) || ')'
            else 'TRIAL-NO-SEND-0179: FAILURES ' || (select count(*) from _uf where result <> 'PASS') end as verdict;
rollback;
