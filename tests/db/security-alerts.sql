-- security-alerts.sql — 0054: security events notify the RIGHT studio's admins only,
-- floods are throttled (one alert per type per studio per 10 min, with a count), the
-- original action is never blocked, the HQ feed is operator-only, the e-mail outbox is
-- service-role-only and honours the studio's e-mail switch.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _sa; create temp table _sa(name text, result text); grant all on _sa to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text default null) returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin execute 'reset role';
  insert into _sa values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
grant execute on function pg_temp.t(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.as_user(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- security_alert rows in a person's bell (bell_feed, as that person)
create or replace function pg_temp.bell(p_email text, p_alert text default null) returns int language plpgsql as $$
declare r jsonb; n int;
begin perform pg_temp.as_user(p_email); r := public.bell_feed(100);
  select count(*) into n from jsonb_array_elements(r -> 'items') i
   where i ->> 'kind' = 'security_alert' and (p_alert is null or i -> 'detail' ->> 'alert' = p_alert);
  perform pg_temp.su(); return n; end $$;
create or replace function pg_temp.nrows(p_org uuid, p_alert text) returns int language sql as $$
  select count(*)::int from public.notifications where org_id = p_org and kind = 'security_alert' and detail ->> 'alert' = p_alert $$;

-- clean slate (disposable test DB only)
do $$ begin perform pg_temp.su();
  delete from public.notifications where kind = 'security_alert';
  delete from public.security_alert_throttle; delete from public.security_alert_outbox; delete from public.security_alert_events;
  delete from public.notification_prefs where type = 'security_alert';
  update public.profiles set full_name = 'Asha Admin' where email = 'a_admin@a.test';
  update public.profiles set full_name = 'Sam Sales' where email = 'a_staff@a.test';
end $$;

-- ---- 1) every event type → Org A admins only ------------------------------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; B uuid := 'b0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; aadm uuid; astf uuid; tmp uuid;
begin perform pg_temp.su();
  select id into aadm from auth.users where email = 'a_admin@a.test';
  select id into astf from auth.users where email = 'a_staff@a.test';
  -- admin overrides
  insert into public.event_close_overrides(org_id, quote_id, actor, actor_email, reason) values (A, qA, aadm, 'a_admin@a.test', 'client paid in cash');
  perform pg_temp.t('01 close_event override -> Org A admin alert', pg_temp.nrows(A, 'admin_override') = 1);
  insert into public.lifecycle_stage_overrides(org_id, quote_id, actor, actor_email, from_stage, to_stage, reason)
    values (A, qA, aadm, 'a_admin@a.test', 'quote', 'confirmed', 'verbal approval on call');
  perform pg_temp.t('02 stage override deduped into the same alert (count 2)',
    pg_temp.nrows(A, 'admin_override') = 1
    and (select (detail ->> 'count')::int from public.notifications where org_id = A and detail ->> 'alert' = 'admin_override') = 2);
  -- MFA lockout (0050 writes org_id NULL; org comes from the actor's profile)
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
    values (astf, 'a_staff@a.test', 'auth.mfa.locked', 'auth_mfa_attempts', astf::text, '{"fails":5}', null);
  perform pg_temp.t('03 MFA lockout -> Org A alert', pg_temp.nrows(A, 'mfa_lockout') = 1);
  -- password lockout (0053 names matched defensively)
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id)
    values (null, null, 'auth.password.locked', 'auth.users', astf::text, null);
  perform pg_temp.t('04 password lockout (auth.password.locked) -> Org A alert', pg_temp.nrows(A, 'password_lockout') = 1);
  insert into public.audit_log(actor, action, entity, entity_id, org_id) values (astf, 'auth.login.lockout', 'auth.users', astf::text, null);
  perform pg_temp.t('05 other lockout spelling (auth.login.lockout) counted on the same alert',
    (select (detail ->> 'count')::int from public.notifications where org_id = A and detail ->> 'alert' = 'password_lockout') = 2);
  insert into public.audit_log(actor, action, entity, entity_id, org_id) values (astf, 'auth.password.unlocked', 'auth.users', astf::text, null);
  perform pg_temp.t('06 an UNlock is not an alert',
    (select (detail ->> 'count')::int from public.notifications where org_id = A and detail ->> 'alert' = 'password_lockout') = 2);
  -- rejected upload
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id)
    values (null, null, 'upload.rejected', 'storage.objects', gen_random_uuid()::text,
            jsonb_build_object('bucket', 'event-media', 'name', A::text || '/secret-file.exe', 'reason', 'eicar', 'owner', astf), A);
  perform pg_temp.t('07 rejected upload -> Org A alert', pg_temp.nrows(A, 'upload_rejected') = 1);
  perform pg_temp.t('08 rejected upload alert carries no file name / reason / owner',
    (select not (detail ? 'name') and not (detail ? 'reason') and not (detail ? 'owner') and detail::text not like '%secret-file%'
       from public.notifications where org_id = A and detail ->> 'alert' = 'upload_rejected'));
  -- studio suspend / reactivate (HQ audit rows: org_id NULL, entity_id = studio)
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id) values (null, 'hq.studio.suspend', 'studio_subscriptions', A::text, '{"reason":"unpaid"}', null);
  insert into public.audit_log(actor, action, entity, entity_id, org_id) values (null, 'hq.studio.reactivate', 'studio_subscriptions', A::text, null);
  perform pg_temp.t('09 suspend + reactivate -> Org A alerts', pg_temp.nrows(A, 'studio_suspended') = 1 and pg_temp.nrows(A, 'studio_reactivated') = 1);
  -- role change + member removed
  update public.profiles set role = 'manager' where id = astf;
  perform pg_temp.t('10 role change -> Org A alert with roles + name only',
    (select detail ->> 'old_role' = 'sales' and detail ->> 'new_role' = 'manager' and detail ->> 'subject_name' = 'Sam Sales'
            and detail::text not like '%@%'
       from public.notifications where org_id = A and detail ->> 'alert' = 'role_changed'));
  update public.profiles set role = 'sales' where id = astf;
  select id into tmp from auth.users where email = 'a_temp54@a.test';
  if tmp is null then tmp := auth.seed_user('a_temp54@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id) values (tmp, 'a_temp54@a.test', 'Tara Temp', 'crew', A)
    on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, org_id = excluded.org_id;
  delete from public.profiles where id = tmp;
  perform pg_temp.t('11 member removed -> Org A alert', pg_temp.nrows(A, 'member_removed') = 1);
  -- HQ operator add/remove → HQ feed only, no studio notification
  insert into public.audit_log(actor, action, entity, entity_id, org_id) values (null, 'hq.operator.add', 'platform_admins', 'x@helm.events', null);
  insert into public.audit_log(actor, action, entity, entity_id, org_id) values (null, 'hq.operator.remove', 'platform_admins', 'x@helm.events', null);
  perform pg_temp.t('12 HQ operator change: HQ event recorded, no studio notification',
    (select count(*) from public.security_alert_events where alert_type in ('hq_operator_added', 'hq_operator_removed') and org_id is null) = 2
    and not exists (select 1 from public.notifications where kind = 'security_alert' and detail ->> 'alert' like 'hq_operator%'));
  perform pg_temp.t('13 HQ operator e-mail is not stored in the event', not exists (
    select 1 from public.security_alert_events where detail::text like '%helm.events%'));
  perform pg_temp.t('13b HQ log keeps no event code / quote link', not exists (select 1 from public.security_alert_events where detail ? 'event_code')
    and exists (select 1 from public.notifications where org_id = A and detail ->> 'alert' = 'admin_override' and detail ->> 'event_code' = 'A-0001'));
  perform pg_temp.t('14 Org B got NO security notification', not exists (select 1 from public.notifications where org_id = B and kind = 'security_alert'));
end $$;

-- ---- 2) who sees it --------------------------------------------------------------------------
do $$ declare n int; s text; begin
  perform pg_temp.t('15 Org A admin bell shows the alerts (8 types)', pg_temp.bell('a_admin@a.test') = 8, pg_temp.bell('a_admin@a.test')::text);
  perform pg_temp.t('16 Org A staff (sales) bell shows none', pg_temp.bell('a_staff@a.test') = 0, pg_temp.bell('a_staff@a.test')::text);
  perform pg_temp.t('17 Org B admin bell shows none', pg_temp.bell('b_admin@b.test') = 0, pg_temp.bell('b_admin@b.test')::text);
  perform pg_temp.as_user('a_staff@a.test');
  select count(*) into n from public.notifications where kind = 'security_alert';
  perform pg_temp.t('18 Org A staff cannot read security rows directly (RLS)', n = 0, n::text);
  perform pg_temp.as_user('a_admin@a.test');
  select count(*) into n from public.notifications where kind = 'security_alert';
  perform pg_temp.t('19 Org A admin can read them directly', n = 8, n::text);
  s := pg_temp.try($q$insert into public.notifications(channel, kind, status, detail, org_id) values ('in_app', 'security_alert', 'simulated', '{}', 'a0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.t('20 a member cannot forge a security alert', s <> 'ok', s);
  perform pg_temp.as_user('b_admin@b.test');
  select count(*) into n from public.notifications where kind = 'security_alert';
  perform pg_temp.t('21 Org B admin cannot read Org A alerts', n = 0, n::text);
  perform pg_temp.su();
end $$;

-- ---- 3) opt-in per role (0036 prefs) ---------------------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.as_user('a_admin@a.test');
  r := public.admin_set_notification_pref('security_alert', 'in_app', 'sales', true);
  perform pg_temp.su();
  perform pg_temp.t('22 admin opts sales in -> sales bell shows alerts', pg_temp.bell('a_staff@a.test') = 8);
  perform pg_temp.t('23 Org B sales still sees none', pg_temp.bell('b_staff@b.test') = 0);
  perform pg_temp.as_user('a_admin@a.test');
  r := public.admin_set_notification_pref('security_alert', 'in_app', 'sales', null);
  perform pg_temp.su();
  perform pg_temp.t('24 back to default -> hidden again', pg_temp.bell('a_staff@a.test') = 0);
  perform pg_temp.t('25 catalog lists security_alert once (group Security)',
    (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'security_alert' and e ->> 'group' = 'Security') = 1);
end $$;

-- ---- 4) throttle --------------------------------------------------------------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; i int; begin perform pg_temp.su();
  for i in 1..20 loop
    insert into public.audit_log(action, entity, entity_id, changed, org_id)
      values ('upload.rejected', 'storage.objects', gen_random_uuid()::text, '{"bucket":"event-media"}', A);
  end loop;
  perform pg_temp.t('26 flood of 20 rejects -> still ONE notification', pg_temp.nrows(A, 'upload_rejected') = 1);
  perform pg_temp.t('27 ... with count 21', (select (detail ->> 'count')::int from public.notifications where org_id = A and detail ->> 'alert' = 'upload_rejected') = 21);
  perform pg_temp.t('28 ... and ONE queued e-mail with count 21',
    (select count(*) from public.security_alert_outbox where org_id = A and alert_type = 'upload_rejected') = 1
    and (select count from public.security_alert_outbox where org_id = A and alert_type = 'upload_rejected') = 21);
  perform pg_temp.t('29 every event is still in the HQ log', (select count(*) from public.security_alert_events where org_id = A and alert_type = 'upload_rejected') = 21);
  update public.security_alert_throttle set window_start = window_start - interval '11 minutes' where alert_type = 'upload_rejected';
  insert into public.audit_log(action, entity, entity_id, changed, org_id) values ('upload.rejected', 'storage.objects', gen_random_uuid()::text, '{}', A);
  perform pg_temp.t('30 after the 10-minute window a NEW alert starts (count 1)', pg_temp.nrows(A, 'upload_rejected') = 2
    and exists (select 1 from public.notifications where org_id = A and detail ->> 'alert' = 'upload_rejected' and (detail ->> 'count')::int = 1));
end $$;

-- ---- 5) never blocks the original action -------------------------------------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; n0 int; n1 int; s text; begin perform pg_temp.su();
  alter table public.security_alert_events rename to security_alert_events_x;     -- break the alert path
  select count(*) into n0 from public.audit_log where entity_id = 'x54';
  s := pg_temp.try($q$insert into public.audit_log(action, entity, entity_id, org_id) values ('upload.rejected', 'storage.objects', 'x54', 'a0000000-0000-4000-8000-000000000001')$q$);
  s := s || '|' || pg_temp.try($q$update public.profiles set role = 'manager' where email = 'a_staff@a.test'$q$);
  select count(*) into n1 from public.audit_log where entity_id = 'x54';
  alter table public.security_alert_events_x rename to security_alert_events;
  perform pg_temp.t('31 alert failure does not block the audit insert / role change', s = 'ok|ok' and n1 = n0 + 1, s);
  perform pg_temp.t('32 ... and the role change really happened', (select role from public.profiles where email = 'a_staff@a.test') = 'manager');
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
end $$;

-- ---- 6) HQ feed: operators only ------------------------------------------------------------------
do $$ declare r jsonb; s text; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'security@helm.events') then perform auth.seed_user('security@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'security@helm.events';
  delete from auth.mfa_factors where user_id in (select id from auth.users where email = 'security@helm.events');
  update public.helm_hq_settings set hq_require_mfa = false where id;
  perform pg_temp.as_user('security@helm.events', 'aal1');
  r := public.hq_security_alerts(current_date - 1, current_date);
  perform pg_temp.t('33 operator gets the cross-studio feed',
    (r ->> 'total')::int >= 30 and jsonb_array_length(r -> 'by_type') >= 9 and jsonb_array_length(r -> 'latest') > 0, left(r::text, 200));
  perform pg_temp.t('34 feed names the studio, no e-mail addresses',
    exists (select 1 from jsonb_array_elements(r -> 'by_studio') x where x ->> 'studio' = 'Studio A') and r::text not like '%@%');
  perform pg_temp.su();
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  s := pg_temp.try('select public.hq_security_alerts(null, null)');
  perform pg_temp.t('35 studio admin refused (42501)', s = '42501', s);
  perform pg_temp.su(); perform auth.login_anon(); execute 'set role anon';
  s := pg_temp.try('select public.hq_security_alerts(null, null)');
  perform pg_temp.t('36 anon refused', s = '42501', s);
  perform pg_temp.su();
end $$;

-- ---- 7) outbox: service role only, admin recipients, studio e-mail switch -------------------------
do $$ declare r jsonb; s text; A uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.as_user('a_admin@a.test');
  s := pg_temp.try('select public.security_alert_outbox_claim(10)');
  perform pg_temp.t('37 a studio admin cannot claim the outbox', s = '42501', s);
  s := pg_temp.try('select count(*) from public.security_alert_outbox');
  perform pg_temp.t('38 ... nor read it', s = '42501', s);
  perform pg_temp.su(); execute 'set role service_role';
  r := public.security_alert_outbox_claim(100);
  perform pg_temp.t('39 service role claims; studio rows go to that studio''s admins only',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'studio' = 'Studio A' and x -> 'to' = '["a_admin@a.test"]'::jsonb)
    and not exists (select 1 from jsonb_array_elements(r) x where x::text like '%a_staff%' or x::text like '%b_admin%'), left(r::text, 300));
  perform pg_temp.t('40 HQ rows have no studio recipients', exists (select 1 from jsonb_array_elements(r) x where (x ->> 'hq')::boolean and x -> 'to' = '[]'::jsonb));
  perform public.security_alert_outbox_mark(((r -> 0) ->> 'id')::uuid, 'sent');
  perform pg_temp.su();
  perform pg_temp.t('41 mark sent is final', (select status from public.security_alert_outbox where id = ((r -> 0) ->> 'id')::uuid) = 'sent');
  -- studio switches security e-mail off → queued rows are skipped, not sent
  perform pg_temp.as_user('a_admin@a.test');
  perform public.admin_set_notification_pref('security_alert', 'email', null, false);
  perform pg_temp.su();
  update public.security_alert_throttle set window_start = window_start - interval '11 minutes' where org_key = A;
  insert into public.audit_log(action, entity, entity_id, org_id) values ('upload.rejected', 'storage.objects', 'y', A);
  execute 'set role service_role';
  r := public.security_alert_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.t('42 studio e-mail switched off -> row skipped, not handed to the mailer',
    not exists (select 1 from jsonb_array_elements(r) x where x ->> 'studio' = 'Studio A')
    and exists (select 1 from public.security_alert_outbox where org_id = A and status = 'skipped'), left(r::text, 200));
  delete from public.notification_prefs where type = 'security_alert';
end $$;

-- ---- 8) grants ---------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.t('43 anon/authenticated cannot call internals',
    not has_function_privilege('authenticated', 'public._security_alert(uuid,text,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('anon', 'public._security_alert_safe(uuid,text,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.security_alert_outbox_mark(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_security_alerts(date,date)', 'execute'));
  perform pg_temp.t('44 no API role can touch the alert tables',
    not has_table_privilege('authenticated', 'public.security_alert_events', 'select')
    and not has_table_privilege('anon', 'public.security_alert_throttle', 'select')
    and not has_table_privilege('authenticated', 'public.security_alert_outbox', 'insert'));
end $$;

-- ---- 9) re-apply is idempotent (drift test) ---------------------------------------------------
do $$ begin perform pg_temp.su(); end $$;
\i supabase/migrations/0054_security_alerts.sql
\i supabase/migrations/0054_security_alerts.sql
do $$ begin perform pg_temp.su();
  perform pg_temp.t('45 re-apply twice: catalog still has ONE security_alert, prior bodies kept',
    (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'security_alert') = 1
    and to_regprocedure('public.notification_catalog__pre0054()') is not null
    and to_regprocedure('public.notification_catalog__pre0054__pre0054()') is null
    and public.notification_type_of('task_accept') = 'task_update' and public.notification_type_of('security_alert') = 'security_alert');
  perform pg_temp.t('46 re-apply twice: one trigger each, no data lost',
    (select count(*) from pg_trigger where tgname like 'zzz_sa54_%') = 5
    and (select count(*) from public.security_alert_events) >= 30);
end $$;

select name, result from _sa where result <> 'PASS';
select case when not exists (select 1 from _sa where result <> 'PASS')
            then 'SECURITY-ALERTS: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'SECURITY-ALERTS: FAILURES (' || count(*) filter (where result <> 'PASS') || ')' end
  from _sa;
