-- audit-medium-0155.sql -- 0155: security audit run-3 Medium fixes (db group).
-- trial date server-owned, admin-created accounts releasable, booklet byte budget, WhatsApp STOP on
-- every send path + recipient caps, package staff fan-out cap, invitation caps.
-- Fixture: a_admin/a_staff studio A, b_admin studio B, quoteA. Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _mf(name text, result text); grant all on _mf to anon, authenticated, service_role;
create temp table _mkv(k text primary key, v text); grant all on _mkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_sid text default null) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_strip_nulls(jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email,
    'aal', 'aal1', 'session_id', p_sid))::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _mf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _mkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _mkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- ---- 1) trial columns ------------------------------------------------------------------------
do $$ declare e text; orgA uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = orgA;   -- server side: allowed
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$update public.organizations set trial_ends_at = '2099-01-01' where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('01 admin cannot extend the trial by PATCH', e like '42501%trial_ends_at%', e);
  e := pg_temp.try($q$update public.organizations set trial_ends_at = null where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('02 admin cannot clear the trial date', e like '42501%', e);
  e := pg_temp.try($q$update public.organizations set trial_mode = 'own' where id = 'a0000000-0000-4000-8000-000000000001'$q$)
    || pg_temp.try($q$update public.organizations set demo_choice = 'keep' where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('03 trial_mode / demo_choice server-owned', e like '42501%42501%', e);
  e := pg_temp.try($q$update public.organizations set name = 'Studio A' where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('04 other studio fields still editable', e = '', e);
  perform pg_temp.su();
  perform pg_temp.res('05 trial still locks on schedule', (select trial_ends_at < now() + interval '4 days' from public.organizations where id = orgA));
exception when others then perform pg_temp.su(); insert into _mf values ('0x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) admin-created accounts -----------------------------------------------------------------
do $$ declare e text; r jsonb; v_uid uuid; tok text; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  orgB uuid := 'b0000000-0000-4000-8000-000000000001'; i int; begin
  -- studio A is on an unpaid trial (from section 1): direct creation refused
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.admin_create_user('victim@example.test', 'Abcdefghij1!x', 'sales')$q$);
  perform pg_temp.res('06 unpaid trial: create by invitation only', e like '22023%invitation%', e);
  perform pg_temp.su(); update public.organizations set trial_ends_at = null where id = orgA;   -- paid / normal studio
  perform pg_temp.login('a_admin@a.test');
  v_uid := public.admin_create_user('victim@example.test', 'Abcdefghij1!x', 'sales');
  perform pg_temp.put('victim', v_uid::text);
  perform pg_temp.su();
  perform pg_temp.res('07 paid studio: account created + recorded',
    exists (select 1 from public.a155_admin_created a join auth.users u on u.id = a.user_id
             where a.user_id = v_uid and a.org_id = orgA and a.pw_hash = u.encrypted_password)
    and (select org_id from public.profiles where id = v_uid) = orgA);
  -- studio B invites the same e-mail; the mailbox owner accepts
  perform pg_temp.login('b_admin@b.test');
  r := public.create_invitation('victim@example.test', 'planner'); tok := r ->> 'token';
  perform pg_temp.put('tok', tok);
  perform pg_temp.su();
  insert into auth.sessions(user_id) values (v_uid);           -- e.g. the creating admin still signed in as them
  perform pg_temp.login('victim@example.test', gen_random_uuid()::text);
  e := pg_temp.try(format('select public.accept_invitation(%L)', tok));
  perform pg_temp.res('08 another live session -> refused with guidance', e like '42501%another device%', e);
  perform pg_temp.su();
  set local session_replication_role = replica; delete from auth.sessions where user_id = v_uid; set local session_replication_role = origin;
  insert into auth.sessions(id, user_id) values ('c0000000-0000-4000-8000-0000000005e1', v_uid);   -- the person's own session
  perform pg_temp.login('victim@example.test', 'c0000000-0000-4000-8000-0000000005e1');
  r := public.accept_invitation(tok);
  perform pg_temp.su();
  perform pg_temp.res('09 squatted account moves to the inviting studio',
    (r ->> 'ok')::boolean and (r ->> 'moved')::boolean
    and (select org_id = orgB and role = 'planner' from public.profiles where id = v_uid)
    and (select status from public.invitations where token = tok) = 'accepted', r::text);
  perform pg_temp.res('10 must choose a new password (admin-set one retired)',
    (select must_change_password from public.profiles where id = v_uid)
    and exists (select 1 from public.auth_temp_passwords t where t.user_id = v_uid));
  perform pg_temp.res('10b old admin can no longer sign in with the password they chose',
    (select extensions.crypt('Abcdefghij1!x', u.encrypted_password) <> u.encrypted_password from auth.users u where u.id = v_uid)
    and (select u.encrypted_password <> a.pw_hash from auth.users u join public.a155_admin_created a on a.user_id = u.id where u.id = v_uid)
    and (r ->> 'password_reset')::boolean);
  perform pg_temp.res('11 audit row in both studios + released',
    exists (select 1 from public.audit_log where action = 'member.moved_out' and org_id = orgA and entity_id = v_uid::text)
    and exists (select 1 from public.audit_log where action = 'member.moved_in' and org_id = orgB and entity_id = v_uid::text)
    and (select released_to from public.a155_admin_created where user_id = v_uid) = orgB);
  -- a member who JOINED studio A themselves is still refused (one studio per account)
  perform pg_temp.login('b_admin@b.test');
  r := public.create_invitation('a_staff@a.test', 'planner');
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.accept_invitation(%L)', r ->> 'token'));
  perform pg_temp.res('12 self-joined member of another studio still refused', e like '42501%already belong%', e);
  -- daily cap
  perform pg_temp.su();
  insert into public.a155_admin_created(user_id, org_id) select gen_random_uuid(), orgA from generate_series(1, 100);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.admin_create_user('victim2@example.test', 'Abcdefghij1!x', 'sales')$q$);
  perform pg_temp.res('13 100 accounts a day cap', e like '54000%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$select public.admin_create_user('victim3@example.test', 'Abcdefghij1!x', 'sales')$q$);
  perform pg_temp.res('14 non-admin still refused', e like '42501%', e);
exception when others then perform pg_temp.su(); insert into _mf values ('1x accounts', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) booklet byte budget ------------------------------------------------------------------
do $$ declare e text; r jsonb; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  jpg text := encode('\xffd8ffe000104a464946'::bytea, 'base64'); blob bytea; begin
  perform pg_temp.su(); set local session_replication_role = replica;
  update public.quotes set deleted_at = null where id = qa;
  set local session_replication_role = origin;
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_put_image(qa, '3d', 'labels', 'image/jpeg', jpg);
  perform pg_temp.res('15 normal upload still works', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = orgA;   -- unpaid trial: 50 MB a day
  blob := '\xffd8ff'::bytea || decode(repeat('00', 1572860), 'hex');
  insert into public.client_booklet_images(org_id, quote_id, kind, variant, mime, bytes, data)
    select orgA, qa, '3d', 'plain', 'image/jpeg', octet_length(blob), blob from generate_series(1, 34);   -- service side: not budgeted
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.booklet_put_image(%L, ''3d'', ''labels'', ''image/jpeg'', %L)', qa, jpg));
  perform pg_temp.su();
  perform pg_temp.res('16 trial over 50 MB today -> refused, nothing deleted', e like '54000%today%'
    and (select count(*) from public.client_booklet_images where quote_id = qa) = 35, e);
  perform pg_temp.su(); update public.organizations set trial_ends_at = null where id = orgA;
  perform pg_temp.login('a_staff@a.test');
  r := public.booklet_put_image(qa, '3d', 'labels', 'image/jpeg', jpg);
  perform pg_temp.res('17 paid studio: same usage is within budget', (r ->> 'ok')::boolean, r::text);
exception when others then perform pg_temp.su(); insert into _mf values ('2x booklet', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) WhatsApp STOP + recipient caps -------------------------------------------------------
do $$ declare e text; r jsonb; qa uuid := 'a0000000-0000-4000-8000-00000000da01'; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  v_to text; v_id uuid; begin
  perform pg_temp.su();
  update public.quotes set client = '{"name":"Alice","phone":"98765 43210","email":"alice@example.com"}'::jsonb,
         event_date = current_date + 30 where id = qa;
  perform pg_temp.login('a_admin@a.test');
  r := public.whatsapp_authorize(qa, '9876543210');
  perform pg_temp.res('18 staff send to the client number ok', r ->> 'to' = '919876543210', r::text);
  perform pg_temp.su();
  perform pg_temp.res('19 recipient counted for the day', (select count(*) from public.a155_wa_recipients where org_id = orgA and day = current_date) = 1);
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out, source) values ('919876543210', null, true, 'reply');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, ''9876543210'')', qa));
  perform pg_temp.res('20 STOP -> staff send refused (HL451)', e like 'HL451%STOP%', e);
  e := pg_temp.try(format('select public.wa_proposal_prepare(%L, ''proposal_sent'', ''+919876543210'', true, ''Client agreed'', true)', qa));
  perform pg_temp.res('21 STOP -> Send on WhatsApp refused with a clear answer', e like 'HL451%STOP%', e);
  -- outboxes
  perform pg_temp.su();
  insert into public.comms_settings(org_id, fu_enabled, fu_channels, studio_whatsapp) values (orgA, true, array['whatsapp'], '919000000001')
    on conflict (org_id) do update set fu_enabled = true, fu_channels = array['whatsapp'], studio_whatsapp = '919000000001';
  v_to := public._comms_client_to((select client from public.quotes where id = qa), 'whatsapp', orgA);
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status)
    values (orgA, qa, 'follow_up', 'whatsapp', v_to, '{"text":"hi"}', 'a155test:fu:1', 'pending') returning id into v_id;
  perform pg_temp.svc();
  r := public.comms_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('22 comms claim skips a STOP number', v_to = '919876543210' and not (r::text like '%' || v_id::text || '%')
    and (select status from public.comms_outbox where id = v_id) = 'skipped', coalesce(r::text, 'null') || ' to=' || coalesce(v_to, 'null'));
  set local session_replication_role = replica; delete from public.whatsapp_opt_outs where phone = '919876543210'; set local session_replication_role = origin;
  update public.comms_outbox set status = 'pending', sent_at = null, claimed_at = null where id = v_id;
  perform pg_temp.svc();
  r := public.comms_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('23 control: without STOP the same row is handed out', r::text like '%' || v_id::text || '%', coalesce(r::text, 'null'));
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out, source) values ('919876543210', orgA, true, 'reply');
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, payload, dedupe_key, status)
    values (orgA, qa, 'client', 'whatsapp', 'pkg_accepted', '919876543210', '{}', 'a155test:pkg:1', 'pending'),
           (orgA, qa, 'client', 'email', 'pkg_accepted', 'alice@example.com', '{}', 'a155test:pkg:2', 'pending');
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, payload, dedupe_key, status, created_at)
    values (orgA, qa, 'staff', 'whatsapp', 'pkg_payment', '919811110000', '{}', 'a155test:pkg:3', 'pending', now() - interval '2 days');
  perform pg_temp.svc();
  r := public.pkg_outbox_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('24 package claim: STOP + stale staff rows skipped, e-mail still sent',
    jsonb_array_length(r) = 1 and r -> 0 ->> 'channel' = 'email'
    and (select count(*) from public.pkg_outbox where dedupe_key in ('a155test:pkg:1', 'a155test:pkg:3') and status = 'skipped') = 2, r::text);
  perform pg_temp.svc();
  perform pg_temp.res('25 edge last check sees the STOP', public.wa_recipient_opted_out('+91 98765 43210') and not public.wa_recipient_opted_out('919000000002'));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.wa_recipient_opted_out('919876543210')$q$) || pg_temp.try($q$select public._wa_opted_out('919876543210', null)$q$);
  perform pg_temp.res('26 STOP helpers are not callable from the app', e like '42501%42501%', e);
  -- unpaid trial: only opted-in clients
  perform pg_temp.su();
  set local session_replication_role = replica; delete from public.whatsapp_opt_outs where phone = '919876543210'; set local session_replication_role = origin;
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = orgA;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, ''9876543210'')', qa));
  perform pg_temp.res('27 trial: no opt-in on record -> refused', e like '42501%opted in%', e);
  perform pg_temp.su();
  insert into public.wa_proposal_optins(org_id, quote_id, phone_e164, opted_in, consent_text) values (orgA, qa, '+919876543210', true, 'Client agreed');
  perform pg_temp.login('a_admin@a.test');
  r := public.whatsapp_authorize(qa, '9876543210');
  perform pg_temp.res('28 trial: opted-in client ok', r ->> 'to' = '919876543210', r::text);
  perform pg_temp.su();
  insert into public.a155_wa_recipients(org_id, day, phone) values (orgA, current_date, '919800000001'), (orgA, current_date, '919800000002'), (orgA, current_date, '919800000003');
  update public.quotes set client = '{"name":"Alice","phone":"9123456780"}'::jsonb where id = qa;
  insert into public.wa_proposal_optins(org_id, quote_id, phone_e164, opted_in, consent_text) values (orgA, qa, '+919123456780', true, 'Client agreed');
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.whatsapp_authorize(%L, ''9123456780'')', qa));
  perform pg_temp.res('29 trial: more than 3 new numbers a day -> HL429', e like 'HL429%', e);
  perform pg_temp.su(); update public.organizations set trial_ends_at = null where id = orgA;
exception when others then perform pg_temp.su(); insert into _mf values ('3x whatsapp', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) package staff fan-out ----------------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; orgA uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; i int; begin
  perform pg_temp.su();
  select id into u from auth.users where email = 'a_admin@a.test';
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, user_id, payload, dedupe_key, status)
    values (orgA, qa, 'staff', 'whatsapp', 'pkg_selected', '919811112233', u, '{}', 'sel-1:staff:' || u, 'pending') on conflict (dedupe_key) do nothing;
  insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, user_id, payload, dedupe_key, status)
    values (orgA, qa, 'staff', 'whatsapp', 'pkg_selected', '919811112233', u, '{}', 'sel-2:staff:' || u, 'pending') on conflict (dedupe_key) do nothing;
  perform pg_temp.res('30 repeated package choices -> one staff WhatsApp per 10 minutes',
    (select count(*) from public.pkg_outbox where user_id = u and kind = 'pkg_selected') = 1);
  for i in 1..30 loop
    insert into public.pkg_outbox(org_id, quote_id, audience, channel, kind, recipient, user_id, payload, dedupe_key, status)
      values (orgA, qa, 'staff', 'whatsapp', 'pkg_payment', '919811112233', u, '{}', 'a155test:pay:' || i, 'pending');
  end loop;
  perform pg_temp.res('31 at most 30 staff WhatsApps per person per hour (rest kept as skipped)',
    (select count(*) from public.pkg_outbox where user_id = u and status = 'pending') = 30
    and (select count(*) from public.pkg_outbox where user_id = u and status = 'skipped') = 1);
exception when others then perform pg_temp.su(); insert into _mf values ('4x pkg', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) invitation caps ------------------------------------------------------------------------
do $$ declare e text; r jsonb; orgA uuid := 'a0000000-0000-4000-8000-000000000001'; a uuid; begin
  perform pg_temp.su();
  select id into a from auth.users where email = 'a_admin@a.test';
  update public.organizations set trial_ends_at = now() + interval '3 days' where id = orgA;
  insert into public.invitations(org_id, email, role, invited_by)
    select orgA, 'cap' || g || '@example.test', 'sales', a from generate_series(1, 20) g;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.create_invitation('cap99@example.test', 'sales')$q$);
  perform pg_temp.res('32 trial: 20 new invitations a day', e like '54000%', e);
  r := public.create_invitation('cap1@example.test', 'sales');
  perform pg_temp.res('33 re-inviting an open invitation still works', (r ->> 'reused')::boolean, r::text);
  perform pg_temp.su();
  update public.invite_email_outbox set status = 'sent', sent_at = now()
   where id in (select id from public.invite_email_outbox where org_id = orgA order by created_at limit 20);
  update public.invitations set created_at = now() - interval '2 days' where org_id = orgA;
  perform pg_temp.login('a_admin@a.test');
  r := public.create_invitation('cap21@example.test', 'sales');
  perform pg_temp.svc();
  r := public.invite_email_outbox_claim(100, orgA);
  perform pg_temp.su();
  perform pg_temp.res('34 trial: max 20 invitation e-mails a day, the rest wait (not dropped)',
    jsonb_array_length(r) = 0 and exists (select 1 from public.invite_email_outbox o join public.invitations i on i.id = o.invitation_id
      where i.email = 'cap21@example.test' and o.sent_at is null and o.status = 'pending' and o.claimed_at > now()), r::text);
  update public.organizations set trial_ends_at = null where id = orgA;
  update public.invite_email_outbox set claimed_at = null where org_id = orgA and sent_at is null;
  perform pg_temp.svc();
  r := public.invite_email_outbox_claim(100, orgA);
  perform pg_temp.su();
  perform pg_temp.res('35 paid studio: queued e-mail goes out', jsonb_array_length(r) >= 1, r::text);
exception when others then perform pg_temp.su(); insert into _mf values ('5x invites', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) privileges ---------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('36 grants', has_function_privilege('authenticated', 'public.admin_create_user(text, text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.accept_invitation(text)', 'execute')
    and has_function_privilege('authenticated', 'public.create_invitation(text, text)', 'execute')
    and not has_function_privilege('anon', 'public.whatsapp_authorize(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.admin_create_user__pre0155(text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.pkg_outbox_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.pkg_outbox_claim(integer)', 'execute')
    and has_function_privilege('service_role', 'public.wa_recipient_opted_out(text)', 'execute')
    and not has_table_privilege('authenticated', 'public.a155_wa_recipients', 'select'));
exception when others then perform pg_temp.su(); insert into _mf values ('6x grants', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _mf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'AUDIT-MEDIUM-0155: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'AUDIT-MEDIUM-0155: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _mf;
rollback;
