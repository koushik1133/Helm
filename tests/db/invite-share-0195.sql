-- invite-share-0195.sql -- 0195: "Send to client" on the Invitation Studio. The PUBLISHED invitation link is
-- queued (comms_outbox purpose 'invite_site') by e-mail / WhatsApp with consent + STOP + caps; a FREE TRIAL
-- studio stores it as skipped and nothing is sent; the dispatcher claim re-checks invite rows. Rolled back.
-- Local disposable PG only. Nothing is ever sent (no dispatcher runs here).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps; re-apply 0195 twice inside this rolled-back tx
\ir ../../supabase/migrations/0195_invite_site_share.sql
\ir ../../supabase/migrations/0195_invite_site_share.sql
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
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.site(p_quote uuid) returns uuid language plpgsql as $$
declare s public.event_sites; begin
  s := public.create_event_site(p_quote, 'wedding', 'eternal');
  update public.event_sites set title = 'Alice and Sam', data = jsonb_build_object('names', 'Alice and Sam', 'date', '2099-06-01') where id = s.id;
  return s.id;
end $$;
-- rows the dispatcher could still hand out for a studio (anything not skipped)
create or replace function pg_temp.live_rows(p_org uuid) returns bigint language sql as $$
  select count(*) from public.comms_outbox where org_id = p_org and purpose = 'invite_site' and status <> 'skipped';
$$;

-- ---- 1) paid studio: e-mail ----------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; qa uuid := 'a0000000-0000-4000-8000-00000000da01';
  sid uuid; r jsonb; e text; c record; begin
  perform pg_temp.su();
  update public.quotes set client = client || '{"email":"alice@client.test","phone":"98765 43210"}'::jsonb, status = 'confirmed' where id = qa;
  perform pg_temp.login('a_admin@a.test');
  sid := pg_temp.site(qa); perform pg_temp.put('SA', sid::text);
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'alice@client.test'));
  perform pg_temp.res('01 draft site: refused - publish first', e like 'P0001%Publish the invitation first%', e);
  perform public.publish_event_site(sid, true);
  r := public.event_site_send(sid, 'email', ' Alice@Client.test ');
  perform pg_temp.res('02 published + e-mail: queued, masked answer', r ->> 'status' = 'queued' and r ->> 'masked' = 'a***@client.test', r::text);
  perform pg_temp.su();
  select * into c from public.comms_outbox where id = (r ->> 'id')::uuid;
  perform pg_temp.res('03 outbox row: invite_site / pending / lower-cased address / link path only',
    c.purpose = 'invite_site' and c.status = 'pending' and c.recipient = 'alice@client.test'
    and c.payload ->> 'link_path' = coalesce((select o.public_slug || '/invite/' from public.organizations o where o.id = a), 'i/')
                                    || (select slug from public.event_sites where id = sid)
    and c.payload ->> 'body' = 'Hi Alice, here is your invitation website:' and not (c.payload ? 'text')
    and (c.payload ->> 'to_is_client')::boolean, row_to_json(c)::text);
  perform pg_temp.res('04 log: audit event_site.link_sent with masked address',
    exists (select 1 from public.audit_log where action = 'event_site.link_sent' and entity_id = sid::text
            and changed ->> 'to' = 'a***@client.test' and changed ->> 'status' = 'queued'));
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send(sid, 'email', 'alice@client.test');
  perform pg_temp.res('05 double click: already_queued (one row)', r ->> 'status' = 'already_queued', r::text);
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'not-an-email'));
  perform pg_temp.res('06 bad e-mail refused', e like '22023%', e);
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'sms', 'x'));
  perform pg_temp.res('07 unknown channel refused', e like '22023%', e);
  r := public.event_site_send(sid, 'email', 'other.person@client.test');
  perform pg_temp.su();
  perform pg_temp.res('08 edited address (not the quote one) is accepted + flagged', r ->> 'status' = 'queued'
    and (select (payload ->> 'to_is_client')::boolean = false from public.comms_outbox where id = (r ->> 'id')::uuid), r::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send_log(sid);
  perform pg_temp.res('09 send log: 2 rows, masked, newest first', jsonb_array_length(r) = 2 and r -> 0 ->> 'to' = 'o***@client.test'
    and r -> 0 ->> 'status' = 'queued', r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('0x email', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) paid studio: WhatsApp (opt-in, studio number, STOP) ------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; sid uuid := pg_temp.get('SA')::uuid; r jsonb; e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'whatsapp', '98765 43210'));
  perform pg_temp.res('10 WhatsApp without opt-in refused', e like 'P0001%Client agreed%', e);
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L, true, %L)', sid, 'whatsapp', '98765 43210', 'Client agreed (test)'));
  perform pg_temp.res('11 opt-in but no studio WhatsApp number: clear refusal', e like 'P0001%not set up%', e);
  perform pg_temp.su();
  perform pg_temp.res('12 the refused call stored nothing (opt-in rolled back with it)',
    not exists (select 1 from public.wa_proposal_optins where org_id = a and source = 'invite_site_send'));
  insert into public.comms_settings(org_id, studio_whatsapp) values (a, '919000000001')
    on conflict (org_id) do update set studio_whatsapp = excluded.studio_whatsapp;
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send(sid, 'whatsapp', '98765 43210', true, 'Client agreed (test)');
  perform pg_temp.res('13 WhatsApp queued to the E.164 number, masked', r ->> 'status' = 'queued' and r ->> 'masked' = '+91******3210', r::text);
  perform pg_temp.su();
  perform pg_temp.res('14 opt-in recorded with who / source',
    exists (select 1 from public.wa_proposal_optins where org_id = a and phone_e164 = '+919876543210' and source = 'invite_site_send' and recorded_by is not null));
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out) values ('919876543299', null, true);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L, true, %L)', sid, 'whatsapp', '+91 98765 43299', 'Client agreed (test)'));
  perform pg_temp.res('15 a number that replied STOP is refused', e like 'HL451%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('1x whatsapp', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) who may send ----------------------------------------------------------------------------------
do $$ declare sid uuid := pg_temp.get('SA')::uuid; e text; begin
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'x@y.test'));
  perform pg_temp.res('20 another studio cannot send this site', e like '42501%', e);
  e := pg_temp.try(format('select public.event_site_send_log(%L::uuid)', sid));
  perform pg_temp.res('21 another studio cannot read its send log', e like '42501%', e);
  perform pg_temp.su(); perform set_config('role', 'anon', false);
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'x@y.test'));
  perform pg_temp.res('22 anon has no execute', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('23 grants: app calls send + log; claim is service role only',
    has_function_privilege('authenticated', 'public.event_site_send(uuid,text,text,boolean,text)', 'execute')
    and not has_function_privilege('anon', 'public.event_site_send(uuid,text,text,boolean,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim__pre0195(integer)', 'execute')
    and has_function_privilege('service_role', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._is195_link_path(uuid)', 'execute'));
  update public.role_access set can_edit = false where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'x@y.test'));
  perform pg_temp.res('24 a member without quotes EDIT cannot send', e like '42501%', e);
  perform pg_temp.su();
  update public.role_access set can_edit = true where role = 'sales' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
exception when others then perform pg_temp.su(); insert into _uf values ('2x who', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) dispatcher claim + activity row ---------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; sid uuid := pg_temp.get('SA')::uuid; r jsonb; v_id uuid; v_n int; begin
  perform pg_temp.su(); perform set_config('role', 'service_role', false);
  r := public.comms_outbox_claim(25);
  perform pg_temp.su();
  select count(*) into v_n from jsonb_array_elements(r) x where x ->> 'purpose' = 'invite_site';
  perform pg_temp.res('30 claim hands out the 3 queued invite rows with link path + body', v_n = 3
    and (select bool_and(x -> 'payload' ? 'link_path' and x -> 'payload' ? 'body') from jsonb_array_elements(r) x where x ->> 'purpose' = 'invite_site'), r::text);
  select (x ->> 'id')::uuid into v_id from jsonb_array_elements(r) x where x ->> 'purpose' = 'invite_site' and x ->> 'channel' = 'email' limit 1;
  perform set_config('role', 'service_role', false);
  perform public.comms_outbox_mark(v_id, 'sent');
  perform pg_temp.su();
  perform pg_temp.res('31 sent row -> one activity row (sent)', (select count(*) from public.notifications
    where kind = 'invite_site_link' and status = 'sent' and detail ->> 'outbox_id' = v_id::text) = 1);
  -- unpublish after queueing -> the claim skips it
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send(sid, 'email', 'third@client.test');
  perform public.publish_event_site(sid, false);
  perform pg_temp.su(); perform set_config('role', 'service_role', false);
  r := public.comms_outbox_claim(25);
  perform pg_temp.su();
  perform pg_temp.res('32 unpublished before sending: not handed out, stored skipped',
    not exists (select 1 from jsonb_array_elements(r) x where x ->> 'to' = 'third@client.test')
    and exists (select 1 from public.comms_outbox where recipient = 'third@client.test' and status = 'skipped' and sent_at is not null), r::text);
  perform pg_temp.res('33 skipped at claim -> activity row (suppressed)', exists (select 1 from public.notifications
    where kind = 'invite_site_link' and status = 'suppressed' and recipient = 'third@client.test'));
  perform pg_temp.res('34 previous claim kept + still used for other rows',
    to_regprocedure('public.comms_outbox_claim__pre0195(integer)') is not null
    and position('comms_outbox_claim__pre0195' in pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure)) > 0
    and position('comms_outbox_claim__pre0155' in pg_get_functiondef('public.comms_outbox_claim__pre0195(integer)'::regprocedure)) > 0);
  perform pg_temp.res('35 purpose CHECK keeps every old value + invite_site',
    (select pg_get_constraintdef(oid) from pg_constraint where conname = 'comms_outbox_purpose_check' and conrelid = 'public.comms_outbox'::regclass)
      ~ 'follow_up.*invite_site.*pay_reminder.*wa_forward');
  perform pg_temp.login('a_admin@a.test');
  perform public.publish_event_site(sid, true);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('3x claim', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) caps + studio link name ------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; sid uuid := pg_temp.get('SA')::uuid; e text; i int; r jsonb; begin
  perform pg_temp.su();
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send(sid, 'email', 'fourth@client.test');
  perform pg_temp.su();
  perform pg_temp.res('40 link path follows the app rule (<studio>/invite/<slug>, else i/<slug>)',
    (select payload ->> 'link_path' from public.comms_outbox where id = (r ->> 'id')::uuid)
    = coalesce((select o.public_slug || '/invite/' from public.organizations o where o.id = a), 'i/') || (select slug from public.event_sites where id = sid)
    and (select public_slug from public.organizations where id = a) is not null, r::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'sixth@client.test'));
  perform pg_temp.res('41 6th different person in a day refused', e like 'HL429%5 different%', e);
  perform pg_temp.su();
  -- earlier rows of this site an hour ago (past the 2-minute double-click window, inside the day)
  update public.comms_outbox set created_at = now() - interval '1 hour' where purpose = 'invite_site' and payload ->> 'site_id' = sid::text;
  for i in 1..5 loop
    insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, status, created_at)
      values (a, 'a0000000-0000-4000-8000-00000000da01', 'invite_site', 'email', 'alice@client.test',
              jsonb_build_object('site_id', sid), 'test-cap-' || i, 'skipped', now() - interval '1 hour');
  end loop;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.event_site_send(%L::uuid, %L, %L)', sid, 'email', 'alice@client.test'));
  perform pg_temp.res('42 10 sends of one invitation in a day: refused', e like 'HL429%10 times%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('4x caps', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) FREE TRIAL: nothing is sent, recorded as skipped -----------------------------------------------
do $$ declare t uuid; q uuid; sid uuid; r jsonb; r2 jsonb; c record; e text; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true, block_trial_outbound = true where id;
  t := pg_temp.trial('is_t@t.test');
  select id into q from public.quotes where org_id = t order by created_at limit 1;
  perform pg_temp.res('50 trial studio has an event to try it on', q is not null);
  update public.quotes set client = coalesce(client, '{}'::jsonb) || '{"name":"Riya","email":"riya@example.com","phone":"+91 90000 11111"}'::jsonb where id = q;
  perform pg_temp.login('is_t@t.test');
  sid := pg_temp.site(q);
  perform pg_temp.res('58 trial: the editor saves the details (title + data round-trip)',
    (select data ->> 'names' = 'Alice and Sam' and data ->> 'date' = '2099-06-01' and title = 'Alice and Sam' from public.event_sites where id = sid));
  e := pg_temp.try(format('insert into storage.objects(bucket_id, name, owner, metadata) values (%L, %L, auth.uid(), %L::jsonb)',
    'invite-media', t || '/' || q || '/' || gen_random_uuid() || '.png', '{"size":"2048","mimetype":"image/png"}'));
  perform pg_temp.res('59 trial: invitation photo upload allowed (own studio path)', e = '', e);
  perform public.publish_event_site(sid, true);
  r := public.event_site_send(sid, 'email', 'riya@example.com');
  r2 := public.event_site_send(sid, 'whatsapp', '+91 90000 11111', true, 'Client agreed (test)');
  perform pg_temp.su();
  perform pg_temp.res('51 trial e-mail: skipped, reason free_trial', r ->> 'status' = 'skipped' and r ->> 'reason' = 'free_trial', r::text);
  perform pg_temp.res('52 trial WhatsApp: skipped (no studio number needed, nothing sent)', r2 ->> 'status' = 'skipped' and r2 ->> 'reason' = 'free_trial', r2::text);
  perform pg_temp.res('53 nothing the dispatcher could send for the trial studio', pg_temp.live_rows(t) = 0, pg_temp.live_rows(t)::text);
  select * into c from public.comms_outbox where id = (r ->> 'id')::uuid;
  perform pg_temp.res('54 trial row finished as skipped (sent_at stamped, never claimable)', c.status = 'skipped' and c.sent_at is not null, row_to_json(c)::text);
  perform pg_temp.res('55 trial log: activity row suppressed / skipped free_trial + audit skipped',
    exists (select 1 from public.notifications where kind = 'invite_site_link' and status = 'suppressed' and detail ->> 'skipped' = 'free_trial' and quote_id = q)
    and exists (select 1 from public.audit_log where action = 'event_site.link_sent' and entity_id = sid::text and changed ->> 'status' = 'skipped'));
  perform set_config('role', 'service_role', false);
  r := public.comms_outbox_claim(25);
  perform pg_temp.su();
  perform pg_temp.res('56 claim never hands out a trial row', not exists (select 1 from jsonb_array_elements(r) x
    join public.comms_outbox o on o.id = (x ->> 'id')::uuid where o.org_id = t), r::text);
  perform pg_temp.res('57 trial skip row logged once (no second activity row)',
    (select count(*) from public.notifications where kind = 'invite_site_link' and quote_id = q and channel = 'email') = 1);
exception when others then perform pg_temp.su(); insert into _uf values ('5x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) paid studio demo event: skipped ----------------------------------------------------------------
do $$ declare qa uuid := 'a0000000-0000-4000-8000-00000000da01'; sid uuid := pg_temp.get('SA')::uuid; r jsonb; begin
  perform pg_temp.su();
  -- age this site's earlier test rows past the 1-day caps (nothing deleted; the suite is rolled back)
  update public.comms_outbox set created_at = now() - interval '2 days' where purpose = 'invite_site' and payload ->> 'site_id' = sid::text;
  update public.quotes set is_demo = true where id = qa;
  perform pg_temp.login('a_admin@a.test');
  r := public.event_site_send(sid, 'email', 'alice@client.test');
  perform pg_temp.su();
  perform pg_temp.res('60 demo event in a paid studio: skipped, reason demo', r ->> 'status' = 'skipped' and r ->> 'reason' = 'demo', r::text);
  update public.quotes set is_demo = false where id = qa;
exception when others then perform pg_temp.su(); insert into _uf values ('6x demo', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'INVITE-SHARE-0195: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'INVITE-SHARE-0195: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
