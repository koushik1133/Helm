-- r21-security-notices-0250.sql -- 0250: security notices are for Helm HQ (platform operators) only.
-- Studio members (admins included, any studio) no longer receive or see them - old rows are kept but hidden -
-- HQ operators get ONE deduplicated notice per studio + type + India day in their bell, the HQ feed keeps the
-- full log, the e-mail outbox goes to the HQ inbox only, and nothing leaks across studios. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _sn(name text, result text); grant all on _sn to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _sn values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok'; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
-- a person's whole bell_feed answer
create or replace function pg_temp.bell(p_email text) returns jsonb language plpgsql as $$
declare r jsonb; begin perform pg_temp.as_user(p_email); r := public.bell_feed(100); perform pg_temp.su(); return r; end $$;
create or replace function pg_temp.sec(r jsonb) returns int language sql as $$
  select count(*)::int from jsonb_array_elements(coalesce(r -> 'items', '[]'::jsonb)) i where i ->> 'kind' = 'security_alert' $$;
-- a throwaway studio member, then removed (what deleting the auth.users row cascades to)
create or replace function pg_temp.remove_member(p_email text, p_name text, p_org uuid) returns void language plpgsql as $$
declare u uuid; begin
  select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  delete from public.profiles where id = u and org_id is null;   -- a studio-less stub (no alert): start clean
  insert into public.profiles(id, email, full_name, role, org_id) values (u, p_email, p_name, 'crew', p_org)
    on conflict (id) do update set full_name = excluded.full_name, role = excluded.role, org_id = excluded.org_id;
  delete from public.profiles where id = u;
end $$;

-- this suite may run after suites that re-apply 0054 / 0036 over the 0250 wrappers: apply 0250 again (idempotent)
\i supabase/migrations/0250_security_notices_hq_only.sql

do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; B uuid := 'b0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; u uuid;
begin perform pg_temp.su();
  delete from public.hq_security_notices; delete from public.security_alert_throttle;
  delete from public.security_alert_outbox; delete from public.security_alert_events;
  delete from public.notification_prefs where type = 'security_alert';
  update public.helm_hq_settings set hq_require_mfa = false where id;
  -- HQ operator login (admin@helm.events is in platform_admins, 0029)
  select id into u from auth.users where email = 'admin@helm.events';
  if u is null then u := auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  delete from auth.mfa_factors where user_id = u;
  -- everybody's bell last opened an hour ago
  insert into public.notification_seen(user_id, last_seen_at, org_id)
    select x.id, now() - interval '1 hour', (select p.org_id from public.profiles p where p.id = x.id) from auth.users x
     where x.email in ('a_admin@a.test', 'a_staff@a.test', 'b_admin@b.test', 'b_staff@b.test')
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
  delete from public.notification_seen where user_id = u;   -- the HQ operator has no studio here
  delete from public.hq_security_seen;
  -- the owner's screenshot: two identical legacy studio rows "Member removed x3" (unread), one on an event
  insert into public.notifications(channel, kind, status, detail, org_id, created_at) values
    ('in_app', 'security_alert', 'simulated', '{"alert":"member_removed","label":"Member removed","count":3}', A, clock_timestamp()),
    ('in_app', 'security_alert', 'simulated', '{"alert":"member_removed","label":"Member removed","count":3}', A, clock_timestamp());
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id, created_at) values
    (qA, 'in_app', 'security_alert', 'simulated', '{"alert":"admin_override","label":"Admin override used","count":1}', A, clock_timestamp());
end $$;

-- ---- 1) old studio rows: kept, but nobody in the studio sees them ------------------------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; qA uuid := 'a0000000-0000-4000-8000-00000000da01';
  r jsonb; n int; want int; v jsonb;
begin perform pg_temp.su();
  perform pg_temp.res('01 legacy studio security rows are kept (not deleted)',
    (select count(*) from public.notifications where org_id = A and kind = 'security_alert') = 3);
  r := pg_temp.bell('a_admin@a.test');
  perform pg_temp.res('02 studio admin bell: no security notices', pg_temp.sec(r) = 0, r::text);
  select count(*) into want from public.notifications n where n.org_id = A and coalesce(n.kind, '') <> 'security_alert'
     and n.created_at > now() - interval '1 hour';
  perform pg_temp.res('03 studio admin unread count leaves them out', (r ->> 'unread')::int = want, (r ->> 'unread') || ' vs ' || want);
  perform pg_temp.as_user('a_admin@a.test');
  select count(*) into n from public.notifications where kind = 'security_alert';
  v := public.my_pending();
  perform pg_temp.su();
  perform pg_temp.res('04 studio admin cannot read them directly (RLS)', n = 0, n::text);
  perform pg_temp.res('05 dashboard counter (my_pending) leaves them out', (v ->> 'unread')::int = want, (v ->> 'unread') || ' vs ' || want);
  perform pg_temp.as_user('a_admin@a.test');
  v := public.event_activity(qA);
  perform pg_temp.su();
  perform pg_temp.res('06 event activity trail has no security line',
    not exists (select 1 from jsonb_array_elements(v) e where e ->> 'text' like 'security_alert%'), left(v::text, 200));
  perform pg_temp.res('07 studio staff + other studio see none',
    pg_temp.sec(pg_temp.bell('a_staff@a.test')) = 0 and pg_temp.sec(pg_temp.bell('b_admin@b.test')) = 0);
end $$;

-- ---- 2) new events: no studio notification, ONE HQ notice per studio + type + day ---------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; B uuid := 'b0000000-0000-4000-8000-000000000001';
  n0 int; i int;
begin perform pg_temp.su();
  select count(*) into n0 from public.notifications where kind = 'security_alert';
  for i in 1..3 loop perform pg_temp.remove_member('tmp250_' || i || '@a.test', 'Temp ' || i, A); end loop;
  perform pg_temp.res('08 three members removed: no new studio notification anywhere',
    (select count(*) from public.notifications where kind = 'security_alert') = n0);
  perform pg_temp.res('09 ... ONE HQ notice for Studio A, count 3',
    (select count(*) from public.hq_security_notices where org_id = A and alert_type = 'member_removed') = 1
    and (select count from public.hq_security_notices where org_id = A and alert_type = 'member_removed') = 3);
  -- second batch more than ten minutes later (the cause of the duplicate row before 0250)
  update public.security_alert_throttle set window_start = window_start - interval '11 minutes';
  for i in 4..6 loop perform pg_temp.remove_member('tmp250_' || i || '@a.test', 'Temp ' || i, A); end loop;
  perform pg_temp.res('10 second batch 11 minutes later: still ONE notice (count 6) - no duplicate',
    (select count(*) from public.hq_security_notices where org_id = A and alert_type = 'member_removed') = 1
    and (select count from public.hq_security_notices where org_id = A and alert_type = 'member_removed') = 6);
  perform pg_temp.res('11 HQ event log keeps every event (6)',
    (select count(*) from public.security_alert_events where org_id = A and alert_type = 'member_removed') = 6);
  perform pg_temp.remove_member('tmp250_b@b.test', 'Bea Temp', B);
  perform pg_temp.res('12 Studio B gets its own notice (no mixing)',
    (select count(*) from public.hq_security_notices where org_id = B and alert_type = 'member_removed' and count = 1) = 1
    and (select count from public.hq_security_notices where org_id = A and alert_type = 'member_removed') = 6);
  perform pg_temp.res('13 notices carry names only (no e-mail)', not exists (select 1 from public.hq_security_notices where detail::text like '%@%'));
  -- a new India day starts a new notice
  update public.hq_security_notices set day = day - 1 where org_id = B;
  perform pg_temp.remove_member('tmp250_b2@b.test', 'Ben Temp', B);
  perform pg_temp.res('14 next day = a new notice (grouping is per day)',
    (select count(*) from public.hq_security_notices where org_id = B and alert_type = 'member_removed') = 2);
end $$;

-- ---- 3) who sees what ---------------------------------------------------------------------------------------
do $$ declare r jsonb; n int; s text; A uuid := 'a0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.res('15 studio A admin bell: still nothing', pg_temp.sec(pg_temp.bell('a_admin@a.test')) = 0);
  perform pg_temp.res('16 studio A staff / studio B admin + staff: nothing',
    pg_temp.sec(pg_temp.bell('a_staff@a.test')) = 0 and pg_temp.sec(pg_temp.bell('b_admin@b.test')) = 0
    and pg_temp.sec(pg_temp.bell('b_staff@b.test')) = 0);
  -- even a studio admin who opts a role in (0036 prefs) gets nothing
  perform pg_temp.as_user('a_admin@a.test');
  perform public.admin_set_notification_pref('security_alert', 'in_app', 'sales', true);
  perform pg_temp.su();
  perform pg_temp.res('17 opt-in for a role does not bring them back',
    pg_temp.sec(pg_temp.bell('a_staff@a.test')) = 0 and pg_temp.sec(pg_temp.bell('a_admin@a.test')) = 0);
  delete from public.notification_prefs where type = 'security_alert';
  -- Helm HQ
  r := pg_temp.bell('admin@helm.events');
  perform pg_temp.res('18 HQ operator bell shows the notices (3: A x6, B today, B yesterday)', pg_temp.sec(r) = 3, left(r::text, 400));
  perform pg_temp.res('19 ... Studio A member_removed appears ONCE with count 6, marked HQ',
    (select count(*) from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'security_alert'
       and i -> 'detail' ->> 'studio' = 'Studio A' and i -> 'detail' ->> 'alert' = 'member_removed'
       and (i -> 'detail' ->> 'count')::int = 6 and (i -> 'detail' ->> 'hq')::boolean) = 1);
  perform pg_temp.res('20 ... unread counted, no e-mails in the items, grouped rows name nobody',
    (r ->> 'unread')::int >= 3
    and not exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'security_alert' and i::text like '%@%')
    and not exists (select 1 from jsonb_array_elements(r -> 'items') i where i ->> 'kind' = 'security_alert'
                      and (i -> 'detail' ->> 'count')::int > 1 and i -> 'detail' ? 'subject_name'));
  perform pg_temp.res('21 ... a single event names the person',
    exists (select 1 from jsonb_array_elements(r -> 'items') i where i -> 'detail' ->> 'studio' = 'Studio B'
              and (i -> 'detail' ->> 'count')::int = 1 and i -> 'detail' ->> 'subject_name' in ('Bea Temp', 'Ben Temp')));
  perform pg_temp.as_user('admin@helm.events'); s := pg_temp.try('select public.bell_mark_seen()'); perform pg_temp.su();
  perform pg_temp.res('22a HQ operator without a studio can mark the bell read', s = 'ok', s);
  -- (now() is fixed inside this test transaction; move the mark past the notices' clock times)
  update public.hq_security_seen set last_seen_at = clock_timestamp() where user_id = (select id from auth.users where email = 'admin@helm.events');
  r := pg_temp.bell('admin@helm.events');
  perform pg_temp.res('22 HQ operator: opening the bell clears the unread', (r ->> 'unread')::int = 0 and pg_temp.sec(r) = 3, r ->> 'unread');
  -- HQ log (full list) still works for operators
  perform pg_temp.as_user('admin@helm.events');
  r := public.hq_security_alerts(current_date - 2, current_date + 1);
  perform pg_temp.su();
  perform pg_temp.res('23 HQ Security log lists the removals across studios',
    (select (x ->> 'count')::int from jsonb_array_elements(r -> 'by_type') x where x ->> 'type' = 'member_removed') = 8, left(r::text, 300));
  -- no direct access to the HQ table
  perform pg_temp.as_user('a_admin@a.test');
  s := pg_temp.try('select count(*) from public.hq_security_notices');
  perform pg_temp.su();
  perform pg_temp.res('24 studio admin cannot read hq_security_notices', s = '42501', s);
  perform pg_temp.as_user('admin@helm.events');
  s := pg_temp.try('select count(*) from public.hq_security_notices');
  perform pg_temp.su();
  perform pg_temp.res('25 ... nor can an operator outside the RPCs (no API grant)', s = '42501', s);
  perform auth.login_anon(); execute 'set role anon';
  s := pg_temp.try('select public.bell_feed(20)');
  perform pg_temp.su();
  perform pg_temp.res('26 anon cannot call bell_feed', s = '42501', s);
end $$;

-- ---- 4) e-mail outbox: HQ inbox only -------------------------------------------------------------------------
do $$ declare r jsonb; begin perform pg_temp.su();
  execute 'set role service_role';
  r := public.security_alert_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('27 outbox rows all go to HQ (hq=true, no studio recipients)',
    jsonb_array_length(r) >= 3
    and not exists (select 1 from jsonb_array_elements(r) x where not (x ->> 'hq')::boolean or x -> 'to' <> '[]'::jsonb)
    and r::text not like '%a_admin%' and r::text not like '%b_admin%', left(r::text, 300));
  perform pg_temp.res('28 ... and still name the studio for the HQ mail',
    exists (select 1 from jsonb_array_elements(r) x where x ->> 'studio' = 'Studio A'));
  perform pg_temp.res('29 e-mail throttle unchanged: Studio A removals queued as 2 mails (two 10-minute windows)',
    (select count(*) from public.security_alert_outbox where org_id = 'a0000000-0000-4000-8000-000000000001' and alert_type = 'member_removed') = 2);
end $$;

-- ---- 5) never blocks the original action ---------------------------------------------------------------------
do $$ declare s text; begin perform pg_temp.su();
  alter table public.hq_security_notices rename to hq_security_notices_x;
  s := pg_temp.try($q$select pg_temp.remove_member('tmp250_x@a.test', 'X Temp', 'a0000000-0000-4000-8000-000000000001')$q$);
  alter table public.hq_security_notices_x rename to hq_security_notices;
  perform pg_temp.res('30 a broken notice path never blocks the removal',
    s = 'ok' and not exists (select 1 from public.profiles where email = 'tmp250_x@a.test'), s);
end $$;

-- ---- 6) grants, catalog, idempotency -------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.res('31 internals not callable by the app',
    not has_function_privilege('authenticated', 'public._security_alert(uuid,text,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.security_alert_outbox_claim(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.bell_feed__pre0250(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.event_activity__pre0250(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._notify_hidden_types__pre0250(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.bell_feed(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.event_activity(uuid)', 'execute'));
  perform pg_temp.res('32 catalog keeps ONE security_alert type, now marked Helm HQ only',
    (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'security_alert'
       and e ->> 'audience' = 'hq' and e ->> 'group' = 'Security') = 1
    and (select count(*) from jsonb_array_elements(public.notification_catalog())) = (select count(*) from jsonb_array_elements(public.notification_catalog__pre0250())));
end $$;
\i supabase/migrations/0250_security_notices_hq_only.sql
\i supabase/migrations/0250_security_notices_hq_only.sql
do $$ begin perform pg_temp.su();
  perform pg_temp.res('33 re-apply twice: wrapped once, data kept, still hidden from studios',
    to_regprocedure('public.bell_feed__pre0250__pre0250(integer)') is null
    and to_regprocedure('public.bell_feed__pre0153(integer)') is not null
    and (select count(*) from public.hq_security_notices where org_id = 'a0000000-0000-4000-8000-000000000001') = 1
    and (select count(*) from public.notifications where kind = 'security_alert') = 3
    and pg_temp.sec(pg_temp.bell('a_admin@a.test')) = 0 and pg_temp.sec(pg_temp.bell('admin@helm.events')) = 3
    and (select count(*) from pg_policy where polname = 'sa250_read') = 1);
end $$;

-- a signed-in studio user can read the catalog directly (and gets the HQ-only label); signed out cannot
do $$ declare v text; c int; begin
  perform pg_temp.as_user('a_admin@a.test');
  v := pg_temp.try('select public.notification_catalog()');
  c := (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'security_alert' and e ->> 'audience' = 'hq');
  perform pg_temp.su();
  perform pg_temp.res('34b signed-in user can call notification_catalog(); security entry says Helm HQ only', v = 'ok' and c = 1, v);
exception when others then perform pg_temp.su(); perform pg_temp.res('34b signed-in user can call notification_catalog(); security entry says Helm HQ only', false, sqlerrm);
end $$;

select name, result from _sn order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-SECURITY-NOTICES-0250: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-SECURITY-NOTICES-0250: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _sn;
rollback;
