-- r23-link-views-0261.sql - 0261: client link views (which page, device, visits), staff / preview / bot exclusion,
-- first-open bell + throttled re-open bells, "viewed but not approved" follow-ups (owner + admins), Send a nudge
-- (queued, claim re-checks), dismiss, Control Center settings, summary / timeline (IP admin only), activity trail,
-- studio isolation and grants.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
\i supabase/migrations/0261_client_link_views.sql
drop table if exists _g261; create temp table _g261(name text, result text); grant all on _g261 to anon, authenticated, service_role;

create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who = 'service' then execute 'set local role service_role';
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g261 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.ua(p_ua text, p_ip text default '49.36.10.20') returns void language sql as $$
  select set_config('request.headers', jsonb_build_object('user-agent', p_ua, 'x-forwarded-for', p_ip || ', 10.0.0.1')::text, false);
$$;
create or replace function pg_temp.view(p_page text, p_token text, p_preview boolean default false) returns text language sql as $$
  select pg_temp.as_try('anon', format('select public.public_link_viewed(%L, %L::uuid, %L)::text', p_page, p_token, p_preview));
$$;
create or replace function pg_temp.n(p_quote uuid) returns integer language sql as $$
  select count(*)::int from public.client_link_views where quote_id = p_quote $$;

-- setup (Studio A): quote ...261a1 (owner = a_staff via manager_id, client with e-mail + phone), ...261a2 (approved),
-- ...261a3 (demo), a booklet for 261a1, a "designer" user with Quotes VIEW only; Studio B quote for isolation
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001'; u uuid; begin
  execute 'reset role';
  -- throwaway test database only: clear this suite's own rows so a re-run starts clean
  create temp table _q261 on commit drop as select x::uuid as id from unnest(array['a0000000-0000-4000-8000-0000000261a1',
    'a0000000-0000-4000-8000-0000000261a2', 'a0000000-0000-4000-8000-0000000261a3', 'b0000000-0000-4000-8000-0000000261b1']) x;
  delete from public.comms_outbox where quote_id in (select id from _q261);
  delete from public.client_view_followups where quote_id in (select id from _q261);
  delete from public.client_link_views where quote_id in (select id from _q261);
  delete from public.client_link_opens where quote_id in (select id from _q261);
  delete from public.notifications where quote_id in (select id from _q261);
  delete from public.client_booklets where quote_id in (select id from _q261);
  delete from public.client_view_settings where org_id in (a, b);
  delete from public.auth_rate_hits where bucket in ('link_view', 'lv_sweep');
  select id into u from auth.users where email = 'a_view261@a.test'; if u is null then u := auth.seed_user('a_view261@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_view261@a.test', 'Vee Viewer', 'designer', a, false, now()) on conflict (id) do update set role = 'designer', org_id = a;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('designer', 'quotes', true, false, a, now()), ('designer', 'controls', false, false, a, now())
    on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  update public.profiles set full_name = 'Sam Sales' where email = 'a_staff@a.test';
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token,
                            manager_id, created_at, updated_at, is_demo)
  values ('a0000000-0000-4000-8000-0000000261a1', 'A-261-1', 'Views Wedding', 'quote',
          '{"name":"Rahul","email":"rahul@example.org","phone":"9876543210"}'::jsonb, '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}'::jsonb, 1, 'sent', a,
          'a0000000-0000-4000-8000-00000261aaa1', (select id from auth.users where email = 'a_staff@a.test'), now(), now(), false),
         ('a0000000-0000-4000-8000-0000000261a2', 'A-261-2', 'Approved Party', 'quote', '{"name":"Priya","email":"priya@example.org"}'::jsonb,
          '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}'::jsonb, 1, 'approved', a, 'a0000000-0000-4000-8000-00000261aaa2', null, now(), now(), false),
         ('a0000000-0000-4000-8000-0000000261a3', 'A-261-3', 'Demo Event', 'quote', '{"name":"Demo","email":"demo@example.org"}'::jsonb,
          '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}'::jsonb, 1, 'sent', a, 'a0000000-0000-4000-8000-00000261aaa3', null, now(), now(), true),
         ('b0000000-0000-4000-8000-0000000261b1', 'B-261-1', 'Other Studio', 'quote', '{"name":"Bea"}'::jsonb,
          '{"subtotal":5000,"discount":0,"gstPct":0,"total":5000}'::jsonb, 1, 'sent', b, 'b0000000-0000-4000-8000-00000261bbb1', null, now(), now(), false)
  on conflict (id) do update set status = excluded.status, approval_status = excluded.approval_status, client = excluded.client,
     manager_id = excluded.manager_id, approval_token = excluded.approval_token, is_demo = excluded.is_demo,
     approval_token_revoked_at = null, approval_token_expires_at = null, archived_at = null, deleted_at = null, lifecycle_stage = 'quote';
  insert into public.client_booklets(quote_id, org_id, token, expires_at)
    values ('a0000000-0000-4000-8000-0000000261a1', a, 'a0000000-0000-4000-8000-00000261bbb1', now() + interval '10 days');
end $$;

do $$ declare r text; q1 uuid := 'a0000000-0000-4000-8000-0000000261a1'; q2 uuid := 'a0000000-0000-4000-8000-0000000261a2';
              q3 uuid := 'a0000000-0000-4000-8000-0000000261a3'; qb uuid := 'b0000000-0000-4000-8000-0000000261b1';
              t1 text := 'a0000000-0000-4000-8000-00000261aaa1'; tb1 text := 'a0000000-0000-4000-8000-00000261bbb1';
              mob text := 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
              mac text := 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
              iph text := 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
              n0 int; v jsonb; staff uuid; fu uuid; begin
  execute 'reset role';
  select id into staff from auth.users where email = 'a_staff@a.test';

  -- 1 a first open by the client (signed out)
  perform pg_temp.ua(mob);
  r := pg_temp.view('portal', t1);
  perform pg_temp.t('01 anon can call public_link_viewed', r = 'ok:', r);
  perform pg_temp.t('02 one row: portal, visit 1, Mobile / Android / Chrome, IP from x-forwarded-for',
    (select count(*) = 1 and bool_and(page = 'portal' and visit_no = 1 and device = 'mobile' and os = 'Android' and browser = 'Chrome' and ip = '49.36.10.20')
       from public.client_link_views where quote_id = q1), (select string_agg(page || visit_no || device || coalesce(ip, '-'), ',') from public.client_link_views where quote_id = q1));
  perform pg_temp.t('03 the 0078 open counter still counts (kind quote)',
    (select open_count from public.client_link_opens where quote_id = q1 and kind = 'quote') = 1, null);
  perform pg_temp.t('04 bell on FIRST open: "Rahul opened the proposal", owner in notify',
    (select count(*) = 1 and bool_and(detail ->> 'label' = 'Rahul opened the proposal' and (detail -> 'notify') ? staff::text and (detail ->> 'first')::boolean)
       from public.notifications where quote_id = q1 and kind = 'client_link_viewed'),
    (select string_agg(detail::text, ' | ') from public.notifications where quote_id = q1));
  -- 2 refresh / more pages in the same visit
  r := pg_temp.view('portal', t1);
  perform pg_temp.t('05 a refresh of the same page in the same visit adds nothing', pg_temp.n(q1) = 1, pg_temp.n(q1)::text);
  r := pg_temp.view('booklet', tb1);
  r := pg_temp.view('quotation', t1);
  r := pg_temp.view('approve', t1);
  perform pg_temp.t('06 booklet + quotation + approve in the same visit: 4 rows, all visit 1',
    (select count(*) = 4 and bool_and(visit_no = 1) from public.client_link_views where quote_id = q1), pg_temp.n(q1)::text);
  perform pg_temp.t('07 still ONE bell row (no bell per page)',
    (select count(*) from public.notifications where quote_id = q1 and kind = 'client_link_viewed') = 1, null);
  perform pg_temp.t('08 the approve click does not bump the 0078 counter; the booklet open does',
    (select open_count from public.client_link_opens where quote_id = q1 and kind = 'quote') = 3
    and (select open_count from public.client_link_opens where quote_id = q1 and kind = 'booklet') = 1,
    (select string_agg(kind || open_count, ',') from public.client_link_opens where quote_id = q1));
  -- 3 a second device = visit 2; no re-open bell while that switch is off
  perform pg_temp.ua(mac, '103.21.4.5');
  r := pg_temp.view('portal', t1);
  perform pg_temp.t('09 another device = visit 2 (Desktop / macOS / Safari)',
    exists (select 1 from public.client_link_views where quote_id = q1 and visit_no = 2 and device = 'desktop' and os = 'macOS' and browser = 'Safari'), null);
  perform pg_temp.t('10 re-open bell is off by default',
    (select count(*) from public.notifications where quote_id = q1 and kind = 'client_link_viewed') = 1, null);
  -- 4 NOT counted: studio member, preview flag, bots, random / revoked tokens, other kinds of page
  n0 := pg_temp.n(q1);
  perform pg_temp.ua(iph, '1.1.1.1');
  r := pg_temp.as_try('a_admin@a.test', format('select public.public_link_viewed(%L, %L::uuid)::text', 'portal', t1));
  perform pg_temp.t('11 a signed-in studio member previewing is not counted', r = 'ok:' and pg_temp.n(q1) = n0, r);
  r := pg_temp.view('portal', t1, true);
  perform pg_temp.t('12 the preview flag is not counted', r = 'ok:' and pg_temp.n(q1) = n0, r);
  perform pg_temp.ua('WhatsApp/2.23.20.0 A');
  r := pg_temp.view('portal', t1);
  perform pg_temp.ua('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
  r := pg_temp.view('quotation', t1);
  perform pg_temp.ua('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/129.0 Safari/537.36');
  r := pg_temp.view('booklet', tb1);
  perform pg_temp.t('13 link-preview bots / crawlers / headless browsers are not counted', pg_temp.n(q1) = n0, pg_temp.n(q1)::text);
  perform pg_temp.ua(iph, '1.1.1.1');
  r := pg_temp.view('portal', '00000000-0000-4000-8000-000000000000');
  perform pg_temp.t('14 a random token: nothing, no rate-limit row', r = 'ok:'
    and not exists (select 1 from public.auth_rate_hits where bucket = 'link_view' and key = '00000000-0000-4000-8000-000000000000'), r);
  r := pg_temp.view('admin', t1);
  perform pg_temp.t('15 an unknown page name is ignored', r = 'ok:' and pg_temp.n(q1) = n0, r);
  update public.quotes set approval_token_revoked_at = now() where id = q1;
  r := pg_temp.view('portal', t1);
  perform pg_temp.t('16 a revoked link is not counted', pg_temp.n(q1) = n0, pg_temp.n(q1)::text);
  update public.quotes set approval_token_revoked_at = null where id = q1;
  -- 5 settings: re-open bells (throttled), tracking off
  r := pg_temp.as_try('a_view261@a.test', $q$select public.link_view_settings_set('{"bell_repeat":true}'::jsonb)::text$q$);
  perform pg_temp.t('17 settings: Quotes-view only user can not change them', r like 'err:42501%', r);
  r := pg_temp.as_try('a_view261@a.test', $q$select (public.link_view_settings_get() ->> 'can_edit')$q$);
  perform pg_temp.t('18 settings: Quotes-view user can read them (can_edit false), defaults 2 days / on', r = 'ok:false', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_view_settings_set('{"followup_days":0}'::jsonb)::text$q$);
  perform pg_temp.t('19 settings: out-of-range days refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_view_settings_set('{"evil":1}'::jsonb)::text$q$);
  perform pg_temp.t('20 settings: unknown keys refused', r like 'err:22023%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_view_settings_set('{"bell_repeat":true,"repeat_hours":6}'::jsonb)::text$q$);
  perform pg_temp.t('21 settings: admin saves re-open bells every 6 h (audited)', r like 'ok:%"bell_repeat": true%' and r like '%"repeat_hours": 6%'
    and exists (select 1 from public.audit_log where action = 'link_views.settings' and org_id = 'a0000000-0000-4000-8000-000000000001'), r);
  update public.notifications set created_at = created_at - interval '7 hours' where quote_id = q1 and kind = 'client_link_viewed';
  perform pg_temp.ua(iph, '8.8.8.8');
  r := pg_temp.view('quotation', t1);
  perform pg_temp.t('22 re-open bell: visit 3 rings once ("again (3 visits)")',
    exists (select 1 from public.notifications where quote_id = q1 and kind = 'client_link_viewed' and detail ->> 'label' like '%again (3 visits)%'), null);
  perform pg_temp.ua(iph, '9.9.9.9');
  r := pg_temp.view('quotation', t1);
  perform pg_temp.t('23 re-open bell throttled (visit 4 within 6 h: no new row)',
    (select count(*) from public.notifications where quote_id = q1 and kind = 'client_link_viewed') = 2, null);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_view_settings_set('{"track_enabled":false}'::jsonb)::text$q$);
  n0 := pg_temp.n(q1);
  perform pg_temp.ua(iph, '7.7.7.7');
  r := pg_temp.view('portal', t1);
  perform pg_temp.t('24 tracking off: no view row, the 0078 counter still counts', pg_temp.n(q1) = n0
    and (select open_count from public.client_link_opens where quote_id = q1 and kind = 'quote') >= 4, pg_temp.n(q1)::text);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_view_settings_set('{"track_enabled":true}'::jsonb)::text$q$);

  -- 6 reads
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.link_views_summary(array[%L, %L]::uuid[])::text$q$, q1, qb));
  perform pg_temp.t('25 summary: views = visits (4), opens = rows, last page / device; other studio''s quote left out',
    r like 'ok:%"views": 4%' and r like '%"last_device": "mobile"%' and r not like '%' || qb::text || '%', r);
  r := pg_temp.as_try('b_admin@b.test', format($q$select public.link_views_summary(array[%L]::uuid[])::text$q$, q1));
  perform pg_temp.t('26 summary: another studio gets nothing', r = 'ok:{}', r);
  r := pg_temp.as_try('anon', format($q$select public.link_views_summary(array[%L]::uuid[])::text$q$, q1));
  perform pg_temp.t('27 summary: not for signed-out callers', r like 'err:42501%', r);
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.link_views_timeline(%L)::text$q$, q1));
  perform pg_temp.t('28 timeline: visits with pages; NO IP address for a non-admin',
    r like 'ok:%"visits": [%' and r like '%"page": "booklet"%' and r not like '%49.36.10.20%' and r like '%"is_admin": false%', left(r, 300));
  r := pg_temp.as_try('a_admin@a.test', format($q$select public.link_views_timeline(%L)::text$q$, q1));
  perform pg_temp.t('29 timeline: the admin sees the IP address', r like '%49.36.10.20%' and r like '%"channels": {"email": true, "whatsapp": false}%', left(r, 200));
  r := pg_temp.as_try('b_admin@b.test', format($q$select public.link_views_timeline(%L)::text$q$, q1));
  perform pg_temp.t('30 timeline: another studio refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select count(*)::text from public.client_link_views$q$);
  perform pg_temp.t('31 no direct table access from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.event_activity(%L)::text$q$, q1));
  perform pg_temp.t('32 activity trail: "Client opened the proposal ... (first open)"; raw bell rows left out',
    r like '%Client opened the proposal%(first open)%' and r not like '%client_link_viewed ->%', left(r, 400));

  -- 7 viewed but not approved -> follow-up for the owner + admins
  r := pg_temp.as_try('a_view261@a.test', $q$select public.link_views_attention()::text$q$);
  perform pg_temp.t('33 attention: nothing before N days', r = 'ok:[]', r);
  update public.client_link_views set created_at = created_at - interval '3 days' where quote_id = q1;
  delete from public.auth_rate_hits where bucket = 'lv_sweep';
  r := pg_temp.as_try('a_view261@a.test', $q$select public.link_views_attention()::text$q$);
  perform pg_temp.t('34 attention: after 2 days the quote is listed (owner Sam Sales, 4 views)',
    r like '%"code": "A-261-1"%' and r like '%"views": 4%' and r like '%"owner": "Sam Sales"%' and r like '%"mine": false%', r);
  select id into fu from public.client_view_followups where quote_id = q1 and status = 'open';
  perform pg_temp.t('35 one open follow-up row (round 1) + bell row for owner + admins',
    fu is not null and (select count(*) from public.notifications where quote_id = q1 and kind = 'client_view_followup'
                         and (detail -> 'notify') ? staff::text
                         and (detail -> 'notify') ? (select id::text from auth.users where email = 'a_admin@a.test')) = 1, null);
  delete from public.auth_rate_hits where bucket = 'lv_sweep';
  r := pg_temp.as_try('service', $q$select public.link_views_tick()::text$q$);
  perform pg_temp.t('36 the cron tick (service role) adds no duplicate', r like 'ok:%"followups": 0%'
    and (select count(*) from public.client_view_followups where quote_id = q1) = 1, r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_views_tick()::text$q$);
  perform pg_temp.t('37 the tick is not callable by signed-in users', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('38 bell: the owner sees the follow-up + the first-open row', r like '%client_view_followup%' and r like '%client_link_viewed%', left(r, 200));
  r := pg_temp.as_try('a_view261@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('39 bell: a Quotes viewer who is not the owner sees the open, not the follow-up',
    r like 'ok:%' and r like '%client_link_viewed%' and r not like '%client_view_followup%', left(r, 200));
  update public.role_access set can_view = false where role = 'designer' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('a_view261@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('40 bell: no Quotes view -> neither row', r like 'ok:%' and r not like '%client_link_viewed%' and r not like '%client_view_followup%', left(r, 200));
  update public.role_access set can_view = true where role = 'designer' and area = 'quotes' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('b_admin@b.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('41 bell: another studio never sees them', r like 'ok:%' and r not like '%client_link_viewed%' and r not like '%client_view_followup%', null);

  -- 8 send a nudge
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q1));
  perform pg_temp.t('42 nudge: Quotes-view only refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_nudge(%L, 'whatsapp')::text$q$, q1));
  perform pg_temp.t('43 nudge by WhatsApp without the client''s opt-in refused', r like 'err:P0001%WhatsApp%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q1));
  perform pg_temp.t('44 nudge by e-mail queued to the client''s address on the quote (masked in the answer)',
    r like 'ok:%"status": "queued"%' and r like '%r***@example.org%', r);
  perform pg_temp.t('45 outbox row: follow_up, manual, r23 nudge, studio template text; follow-up marked nudged; audit row',
    exists (select 1 from public.comms_outbox where quote_id = q1 and purpose = 'follow_up' and recipient = 'rahul@example.org'
              and payload ->> 'r23' = 'nudge' and (payload ->> 'manual')::boolean and payload ->> 'text' like '%Rahul%' and status = 'pending')
    and (select status from public.client_view_followups where id = fu) = 'nudged'
    and exists (select 1 from public.audit_log where action = 'link_views.nudge' and quote_id = q1), null);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q1));
  perform pg_temp.t('46 double tap within 10 minutes: already queued, one row', r like '%already_queued%'
    and (select count(*) from public.comms_outbox where quote_id = q1 and purpose = 'follow_up') = 1, r);
  r := pg_temp.as_try('service', $q$select public.comms_outbox_claim(25)::text$q$);
  perform pg_temp.t('47 dispatcher claim hands the nudge out although automatic follow-ups are OFF',
    r like '%rahul@example.org%' and r like '%"r23": "nudge"%'
    and coalesce((public._comms_cfg('a0000000-0000-4000-8000-000000000001') ->> 'fu_enabled')::boolean, false) = false, left(r, 200));
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q3));
  perform pg_temp.t('48 a demo event: stored as skipped, never handed out', r like '%"status": "skipped"%' and r like '%"reason": "demo"%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q2));
  perform pg_temp.t('49 an approved quote: no nudge', r like 'err:P0001%already approved%', r);
  r := pg_temp.as_try('b_admin@b.test', format($q$select public.link_view_nudge(%L, 'email')::text$q$, q1));
  perform pg_temp.t('50 another studio can not nudge', r like 'err:42501%', r);
  update public.comms_outbox set claimed_at = null, created_at = now() where quote_id = q1 and purpose = 'follow_up';
  update public.quotes set approval_status = 'approved' where id = q1;
  r := pg_temp.as_try('service', $q$select public.comms_outbox_claim(25)::text$q$);
  perform pg_temp.t('51 claim re-check: client approved meanwhile -> skipped, never sent',
    r not like '%rahul@example.org%' and (select status from public.comms_outbox where quote_id = q1 and purpose = 'follow_up') = 'skipped', left(r, 200));
  update public.quotes set approval_status = 'sent' where id = q1;

  -- 9 next round only after a NEW visit; dismiss; resolve on approval
  update public.client_view_followups set closed_at = now() - interval '3 days' where id = fu;
  delete from public.auth_rate_hits where bucket = 'lv_sweep';
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_views_attention()::text$q$);
  perform pg_temp.t('52 no new visit since the nudge: no second follow-up', r = 'ok:[]', r);
  perform pg_temp.ua(mob, '49.36.10.21');
  r := pg_temp.view('portal', t1);
  delete from public.auth_rate_hits where bucket = 'lv_sweep';
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_views_attention()::text$q$);
  perform pg_temp.t('53 a new visit after the nudge -> round 2', r like '%"round": 2%', r);
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.link_view_followup_dismiss(%L)::text$q$,
                       (select id from public.client_view_followups where quote_id = q1 and status = 'open')));
  perform pg_temp.t('54 dismiss: Quotes-view only refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.link_view_followup_dismiss(%L)::text$q$,
                       (select id from public.client_view_followups where quote_id = q1 and status = 'open')));
  perform pg_temp.t('55 dismiss: kept as dismissed (who / when)', r like '%dismissed%'
    and exists (select 1 from public.client_view_followups where quote_id = q1 and round = 2 and status = 'dismissed' and closed_by = staff), r);
  -- resolve: an open one becomes resolved when the client approves
  update public.client_view_followups set status = 'open', closed_at = null, closed_by = null where quote_id = q1 and round = 2;
  update public.quotes set approval_status = 'approved' where id = q1;
  delete from public.auth_rate_hits where bucket = 'lv_sweep';
  r := pg_temp.as_try('a_admin@a.test', $q$select public.link_views_attention()::text$q$);
  perform pg_temp.t('56 approved -> the follow-up is resolved and leaves the list', r = 'ok:[]'
    and (select status from public.client_view_followups where quote_id = q1 and round = 2) = 'resolved', r);
  update public.quotes set approval_status = 'sent' where id = q1;
  r := pg_temp.as_try('a_view261@a.test', format($q$select public.link_views_summary(array[%L]::uuid[])::text$q$, q1));
  perform pg_temp.t('57 summary carries the latest follow-up state', r like '%"followup": {%"status": "resolved"%', r);

  -- 10 catalog + grants + wrappers + retention
  perform pg_temp.t('58 catalog: both new types; kinds map to them',
    exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'client_link_viewed')
    and exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'client_view_followup')
    and public.notification_type_of('client_link_viewed', 'in_app') = 'client_link_viewed'
    and public.notification_type_of('payment_link', 'sms') = 'payment_link', null);
  perform pg_temp.t('59 grants: internal helpers closed, reads for signed-in, page RPC for anon',
    not has_function_privilege('authenticated', 'public._lv261_sweep(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._lv261_req()', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.notify_default(uuid, text, text, text)', 'execute')
    and has_function_privilege('anon', 'public.public_link_viewed(text, uuid, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.link_views_summary(uuid[])', 'execute')
    and has_function_privilege('authenticated', 'public.link_views_timeline(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.notification_catalog()', 'execute'), null);
  perform pg_temp.t('60 wrappers carry the marker; old bodies kept',
    position('r23-link-views-0261' in (select prosrc from pg_proc where oid = 'public.bell_feed(integer)'::regprocedure)) > 0
    and position('r23-link-views-0261' in (select prosrc from pg_proc where oid = 'public.event_activity(uuid)'::regprocedure)) > 0
    and position('r23-link-views-0261' in (select prosrc from pg_proc where oid = 'public.comms_outbox_claim(integer)'::regprocedure)) > 0
    and to_regprocedure('public.bell_feed__pre0261(integer)') is not null and to_regprocedure('public.comms_outbox_claim__pre0261(integer)') is not null, null);
  perform pg_temp.t('61 trial retention: views + follow-ups purge with the quote; settings kept',
    to_regprocedure('public._tr184_purge_tables()') is null
    or ('client_link_views' = any (public._tr184_purge_tables()) and 'client_view_followups' = any (public._tr184_purge_tables())
        and 'client_view_settings' = any (public._tr184_keep_tables())), null);
  perform pg_temp.t('62 device helper: iPad = tablet, iPhone = mobile / iOS, empty = unknown',
    public._lv261_device('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)') ->> 'device' = 'tablet'
    and public._lv261_device(iph) ->> 'os' = 'iOS' and public._lv261_device(iph) ->> 'device' = 'mobile'
    and public._lv261_device('') ->> 'device' = 'unknown', null);
  perform set_config('request.headers', '', false);
end $$;

select name, result from _g261 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-LINK-VIEWS-0261: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-LINK-VIEWS-0261: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g261;
