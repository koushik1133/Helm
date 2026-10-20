-- r23-inbox-0266.sql - 0266: per-person notification inbox (read / unread / Done / Snooze), the inbox feed equals the
-- bell's own visibility rules for several roles, bulk actions, snooze presets in IST, snoozes come back by themselves,
-- e-mail digests only for still-unread items (queued in the Helm notice outbox, re-checked at claim), settings,
-- studio isolation, grants, trial retention lists and a safe re-run.
-- Time-independent (r24 CI): the daily-digest window (default 8-10 am studio time) is closed for every studio in the
-- setup and only opened (digest hour = now) for the digest checks, so the inbox_tick in check 30 never queues today's
-- digest early - at 08:00-09:59 IST it used to, and check 55 then failed (the digest was already queued + deduped).
-- 0270 (rules worked out once per call, not per row) is applied after every 0266 re-run.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
\i supabase/migrations/0266_notification_inbox.sql
\i supabase/migrations/0270_inbox_visible_speed.sql
drop table if exists _g266; create temp table _g266(name text, result text); grant all on _g266 to anon, authenticated;

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
  insert into _g266 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.tsz(r text) returns timestamptz language plpgsql as $$
begin return case when r like 'ok:_%' then substr(r, 4)::timestamptz end; exception when others then return null; end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
-- the ids a person's bell shows / the inbox shows (sorted text), studio rows only
create or replace function pg_temp.bell_ids(p_email text) returns text language plpgsql as $$
declare r text;
begin
  r := pg_temp.as_try(p_email, $q$select coalesce(string_agg(e ->> 'id', ',' order by e ->> 'id'), '') from jsonb_array_elements(public.bell_feed(100) -> 'items') e
                                 where coalesce(e -> 'detail' ->> 'hq', '') <> 'true' and (e ->> 'id') like 'c0000000-0000-4000-8000-000000266%'$q$);
  return r;
end $$;
create or replace function pg_temp.inbox_ids(p_email text, p_tab text) returns text language plpgsql as $$
begin
  return pg_temp.as_try(p_email, format($q$select coalesce(string_agg(e ->> 'id', ',' order by e ->> 'id'), '') from jsonb_array_elements(public.inbox_feed(%L, null, null, 100, null) -> 'items') e
                                          where (e ->> 'id') like 'c0000000-0000-4000-8000-000000266%%'$q$, p_tab));
end $$;

-- setup: Studio A (Asia/Kolkata) - admin, sales (quotes + finance + controls), a crew member (no quote view).
-- 12 notifications of different kinds on quote A, all 2 hours old (old enough for a digest).
do $$ declare a uuid := 'c0000000-0000-4000-8000-000000000266'; qa uuid := 'c0000000-0000-4000-8000-00000000c266'; u uuid; v_em text; begin
  execute 'reset role';
  -- this suite's own studio C (other suites leave notifications in Studio A)
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (a, 'Studio C266', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) on conflict (id) do update set timezone = 'Asia/Kolkata';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    select r, x, true, true, a, now() from (values ('sales')) rr(r), (values ('quotes'), ('finance'), ('proposal'), ('controls')) aa(x)
  on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  foreach v_em in array array['c_admin266@c.test', 'c_sales266@c.test'] loop
    select id into u from auth.users where email = v_em; if u is null then u := auth.seed_user(v_em); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, v_em, case when v_em like 'c_admin%' then 'Ada Admin' else 'Sam Sales' end, case when v_em like 'c_admin%' then 'admin' else 'sales' end, a, false, now())
    on conflict (id) do update set role = excluded.role, org_id = a, full_name = excluded.full_name;
  end loop;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, created_at, updated_at)
    values (qa, 'C-0266', 'Wedding C', 'quote', '{"name":"Cara"}'::jsonb, '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}'::jsonb, 1, 'sent', a,
            gen_random_uuid(), now(), now()) on conflict (id) do nothing;
  -- throwaway test database only: clear this suite's own rows so a re-run starts clean
  delete from public.helm_notice_outbox where kind = 'inbox_digest';
  delete from public.notification_inbox_state where notification_id::text like 'c0000000-0000-4000-8000-000000266%';
  delete from public.notifications where id::text like 'c0000000-0000-4000-8000-000000266%';
  delete from public.inbox_person_prefs; delete from public.inbox_settings;
  -- every studio's daily-digest window closed now (digest hour 12 h away from the studio's local hour); the digest
  -- checks open Studio C266's window themselves, so the result never depends on the time of day the suite runs
  insert into public.inbox_settings(org_id, digest_hour, updated_at)
    select g.id, ((extract(hour from now() at time zone public._r23_tz(g.id))::integer + 12) % 24), now() from public.organizations g
  on conflict (org_id) do update set digest_hour = excluded.digest_hour;
  delete from public.notification_seen where user_id in (select id from auth.users where email in ('c_admin266@c.test', 'c_sales266@c.test', 'c_crew266@c.test', 'b_admin@b.test'));
  delete from public.notification_mutes where user_id in (select id from auth.users where email in ('c_admin266@c.test', 'c_sales266@c.test', 'c_crew266@c.test'));
  delete from public.auth_rate_hits where bucket = 'inbox_act';
  select id into u from auth.users where email = 'c_crew266@c.test'; if u is null then u := auth.seed_user('c_crew266@c.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'c_crew266@c.test', 'Chotu Crew', 'crew', a, false, now()) on conflict (id) do update set role = 'crew', org_id = a;
  insert into public.notifications(id, quote_id, channel, kind, status, detail, org_id, created_at) values
    ('c0000000-0000-4000-8000-000000266001', qa, 'in_app', 'task_accept', 'simulated', '{"worker":"Ravi","amount":5000,"token":"secret-tok"}', a, now() - interval '2 hours'),
    ('c0000000-0000-4000-8000-000000266002', qa, 'in_app', 'task_complete', 'simulated', '{"worker":"Ravi"}', a, now() - interval '2 hours' + interval '1 minute'),
    ('c0000000-0000-4000-8000-000000266003', qa, 'email', 'advance_paid', 'simulated', '{"amount":25000}', a, now() - interval '2 hours' + interval '2 minutes'),
    ('c0000000-0000-4000-8000-000000266004', qa, 'in_app', 'price_change', 'simulated', '{"event_code":"A-0001"}', a, now() - interval '2 hours' + interval '3 minutes'),
    ('c0000000-0000-4000-8000-000000266005', qa, 'in_app', 'event_close_request', 'simulated', '{"actor_name":"Sam"}', a, now() - interval '2 hours' + interval '4 minutes'),
    ('c0000000-0000-4000-8000-000000266006', qa, 'in_app', 'design_revise', 'simulated', '{}', a, now() - interval '2 hours' + interval '5 minutes'),
    ('c0000000-0000-4000-8000-000000266007', qa, 'in_app', 'event_reminder', 'simulated', '{"label":"Wedding A is in 7 days"}', a, now() - interval '2 hours' + interval '6 minutes'),
    ('c0000000-0000-4000-8000-000000266008', null, 'in_app', 'trial_reminder', 'simulated', '{"label":"Trial ends soon"}', a, now() - interval '2 hours' + interval '7 minutes'),
    ('c0000000-0000-4000-8000-000000266009', null, 'in_app', 'security_alert', 'simulated', '{"label":"Member removed"}', a, now() - interval '2 hours' + interval '8 minutes'),
    ('c0000000-0000-4000-8000-000000266010', qa, 'in_app', 'task_reject', 'simulated', '{"worker":"Ravi"}', a, now() - interval '2 hours' + interval '9 minutes'),
    ('c0000000-0000-4000-8000-000000266011', qa, 'in_app', 'inventory_low_stock', 'simulated', '{"item":"Chairs"}', a, now() - interval '2 hours' + interval '10 minutes'),
    ('c0000000-0000-4000-8000-000000266012', qa, 'in_app', 'task_start', 'simulated', '{"worker":"Ravi"}', a, now() - interval '2 hours' + interval '11 minutes');
end $$;

do $$ declare r text; r2 text; v jsonb; n int; at timestamptz; ns int; nq int;
  a uuid := 'c0000000-0000-4000-8000-000000000266'; n1 text := 'c0000000-0000-4000-8000-000000266001';
begin
  -- ---- schema + grants ----
  perform pg_temp.t('01 three new tables, RLS on, read-only for the app',
    (select bool_and(relrowsecurity) from pg_class where oid in ('public.notification_inbox_state'::regclass, 'public.inbox_settings'::regclass, 'public.inbox_person_prefs'::regclass))
    and has_table_privilege('authenticated', 'public.notification_inbox_state', 'select')
    and not has_table_privilege('authenticated', 'public.notification_inbox_state', 'insert')
    and not has_table_privilege('authenticated', 'public.notification_inbox_state', 'update')
    and not has_table_privilege('authenticated', 'public.notification_inbox_state', 'delete')
    and not has_table_privilege('authenticated', 'public.inbox_settings', 'update')
    and not has_table_privilege('authenticated', 'public.inbox_person_prefs', 'insert')
    and not has_table_privilege('anon', 'public.notification_inbox_state', 'select'), null);
  perform pg_temp.t('02 RPCs for signed-in users; helpers + tick not callable by the app',
    has_function_privilege('authenticated', 'public.inbox_feed(text,text,uuid,integer,text)', 'execute')
    and has_function_privilege('authenticated', 'public.inbox_act(uuid[],text,timestamptz,text)', 'execute')
    and has_function_privilege('authenticated', 'public.inbox_read_all(text,uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.inbox_set_my_digest(text)', 'execute')
    and has_function_privilege('authenticated', 'public.admin_set_inbox_settings(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.inbox_feed(text,text,uuid,integer,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.inbox_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_rows(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_digest_mail(uuid,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_queue_digests()', 'execute')
    and not has_function_privilege('authenticated', 'public.bell_feed__pre0266(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.bell_feed(integer)', 'execute'), null);
  perform pg_temp.t('03 bell_feed is the 0266 wrapper over the kept body',
    position('r23-inbox-0266' in (select prosrc from pg_proc where oid = 'public.bell_feed(integer)'::regprocedure)) > 0
    -- the kept body is the 0254 wrapper, or 0261's (link views) which itself keeps the 0254 one
    and (position('r22-closure-0254' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0266(integer)'::regprocedure)) > 0
         or (position('bell_feed__pre0261' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0266(integer)'::regprocedure)) > 0
             and position('r22-closure-0254' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.bell_feed__pre0261(integer)')), '')) > 0)), null);

  -- ---- the inbox shows exactly what the bell shows (per role) ----
  r := pg_temp.bell_ids('c_admin266@c.test'); r2 := pg_temp.inbox_ids('c_admin266@c.test', 'all');
  perform pg_temp.t('04 admin: inbox = bell (same rows)', r = r2 and r like 'ok:%' and length(r) > 300, r || ' / ' || r2);
  perform pg_temp.t('05 admin never sees a studio security row; sees trial + close + price rows',
    r not like '%266009%' and r like '%266008%' and r like '%266005%' and r like '%266004%', r);
  r := pg_temp.bell_ids('c_sales266@c.test'); r2 := pg_temp.inbox_ids('c_sales266@c.test', 'all');
  perform pg_temp.t('06 sales: inbox = bell; no close rows', r = r2 and r like 'ok:%' and r not like '%266005%' and r like '%266003%', r || ' / ' || r2);
  -- how many rows sales sees (trial / low-stock rows follow the studio's role defaults, which other suites may re-set)
  ns := array_length(string_to_array(substr(r2, 4), ','), 1); nq := ns - (case when r2 like '%266008%' then 1 else 0 end);
  r := pg_temp.bell_ids('c_crew266@c.test'); r2 := pg_temp.inbox_ids('c_crew266@c.test', 'all');
  perform pg_temp.t('07 crew: inbox = bell; no money / price / close rows', r = r2 and r like 'ok:%' and r not like '%266003%' and r not like '%266004%' and r not like '%266005%' and r like '%266001%', r || ' / ' || r2);
  r := pg_temp.as_try('c_crew266@c.test', format($q$select (select e -> 'detail' from jsonb_array_elements(public.inbox_feed('all', null, null, 100, null) -> 'items') e where e ->> 'id' = %L)::text$q$, n1));
  perform pg_temp.t('08 crew: money fields + bearer tokens stripped from details', r like 'ok:%Ravi%' and r not like '%amount%' and r not like '%secret-tok%', r);
  r := pg_temp.as_try('c_admin266@c.test', format($q$select (select e -> 'detail' from jsonb_array_elements(public.inbox_feed('all', null, null, 100, null) -> 'items') e where e ->> 'id' = %L)::text$q$, n1));
  perform pg_temp.t('09 admin: amount kept, token stripped', r like '%amount%' and r not like '%secret-tok%', r);
  r := pg_temp.inbox_ids('b_admin@b.test', 'all');
  perform pg_temp.t('10 another studio sees none of these rows', r = 'ok:', r);

  -- ---- feed shape, tabs, counts, filters, paging ----
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_feed('unread') -> 'counts')::text$q$);
  perform pg_temp.t('11 sales: everything starts unread (no read time yet)', r like 'ok:%"unread": ' || ns || ',%' and r like '%"done": 0%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select jsonb_array_length(public.inbox_feed('all', 'operations') -> 'items')::text$q$);
  perform pg_temp.t('12 group filter (Operations = task updates)', r = 'ok:4', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select jsonb_array_length(public.inbox_feed('all', null, 'c0000000-0000-4000-8000-00000000c266') -> 'items')::text$q$);
  perform pg_temp.t('13 event filter', r = 'ok:' || nq, r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (select string_agg(e ->> 'id', ',') from jsonb_array_elements(public.inbox_feed('all', null, null, 4, null) -> 'items') e)
                                         || '#' || (select string_agg(e ->> 'id', ',') from jsonb_array_elements(public.inbox_feed('all', null, null, 4, public.inbox_feed('all', null, null, 4, null) ->> 'next_cursor') -> 'items') e)$q$);
  perform pg_temp.t('14 cursor paging: page 2 continues after page 1, newest first', r like 'ok:%266012%#%' and split_part(r, '#', 2) <> '' and position(split_part(split_part(r, '#', 2), ',', 1) in split_part(r, '#', 1)) = 0, r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_feed('all') -> 'items' -> 0 ->> 'event_code') || '|' || (public.inbox_feed('all') -> 'items' -> 0 ->> 'group')$q$);
  perform pg_temp.t('15 items carry the event code + group', r = 'ok:C-0266|Operations', r);

  -- ---- actions ----
  r := pg_temp.as_try('c_sales266@c.test', format($q$select (public.inbox_act(array[%L]::uuid[], 'read') -> 'counts' ->> 'unread')$q$, n1));
  perform pg_temp.t('16 read: one less unread', r = 'ok:' || (ns - 1), r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select (public.inbox_act(array[%L]::uuid[], 'unread') -> 'counts' ->> 'unread')$q$, n1));
  perform pg_temp.t('17 unread: back to unread', r = 'ok:' || ns, r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select (public.inbox_act(array[%L, 'c0000000-0000-4000-8000-000000266002']::uuid[], 'done') -> 'counts')::text$q$, n1));
  perform pg_temp.t('18 done (bulk): leaves the inbox, counted in Done', r like '%"done": 2%' and r like '%"all": ' || (ns - 2) || ',%' and r like '%"unread": ' || (ns - 2) || ',%', r);
  r := pg_temp.inbox_ids('c_sales266@c.test', 'done');
  perform pg_temp.t('19 Done tab lists them', r = 'ok:c0000000-0000-4000-8000-000000266001,c0000000-0000-4000-8000-000000266002', r);
  r := pg_temp.bell_ids('c_sales266@c.test');
  perform pg_temp.t('20 Done rows leave the bell', r not like '%266001%' and r not like '%266002%' and r like '%266012%', r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select (public.inbox_act(array[%L]::uuid[], 'undone') -> 'counts' ->> 'done')$q$, n1));
  perform pg_temp.t('21 undone: back in the inbox', r = 'ok:1', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_act(array['c0000000-0000-4000-8000-000000266010']::uuid[], 'snooze', null, 'tomorrow') ->> 'snoozed_until')$q$);
  perform pg_temp.t('22 snooze "tomorrow" = 9:00 am IST tomorrow',
    r like 'ok:%' and to_char((pg_temp.tsz(r)) at time zone 'Asia/Kolkata', 'HH24:MI') = '09:00'
    and ((pg_temp.tsz(r)) at time zone 'Asia/Kolkata')::date = ((now() at time zone 'Asia/Kolkata')::date + 1), r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_act(array['c0000000-0000-4000-8000-000000266007']::uuid[], 'snooze', null, 'next_week') ->> 'snoozed_until')$q$);
  perform pg_temp.t('23 snooze "next week" = next Monday 9:00 am IST',
    r like 'ok:%' and extract(isodow from (pg_temp.tsz(r)) at time zone 'Asia/Kolkata') = 1
    and to_char((pg_temp.tsz(r)) at time zone 'Asia/Kolkata', 'HH24:MI') = '09:00'
    and (pg_temp.tsz(r)) > now() and (pg_temp.tsz(r)) <= now() + interval '7 days 10 hours', r);
  r := pg_temp.inbox_ids('c_sales266@c.test', 'snoozed');
  perform pg_temp.t('24 Snoozed tab; snoozed rows leave Unread + the bell',
    r = 'ok:c0000000-0000-4000-8000-000000266007,c0000000-0000-4000-8000-000000266010'
    and pg_temp.inbox_ids('c_sales266@c.test', 'unread') not like '%266010%' and pg_temp.bell_ids('c_sales266@c.test') not like '%266007%', r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select public.inbox_act(array[%L]::uuid[], 'snooze', now() - interval '1 hour')::text$q$, n1));
  perform pg_temp.t('25 a snooze time in the past is refused', r like 'err:22023%', r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select public.inbox_act(array[%L]::uuid[], 'snooze', now() + interval '400 days')::text$q$, n1));
  perform pg_temp.t('26 a snooze more than 6 months ahead is refused', r like 'err:22023%', r);
  r := pg_temp.as_try('c_sales266@c.test', format($q$select (public.inbox_act(array[%L]::uuid[], 'snooze', now() + interval '2 hours') ->> 'action')$q$, n1));
  perform pg_temp.t('27 custom snooze time', r = 'ok:snooze', r);
  -- the snooze runs out (moved into the past by the test): back as unread at once, before the job runs
  update public.notification_inbox_state set snoozed_until = now() - interval '1 minute'
   where user_id = pg_temp.uid('c_sales266@c.test') and notification_id = 'c0000000-0000-4000-8000-000000266010';
  r := pg_temp.as_try('c_sales266@c.test', $q$select (select (e ->> 'unread') || '/' || (e ->> 'returned') from jsonb_array_elements(public.inbox_feed('unread') -> 'items') e where e ->> 'id' = 'c0000000-0000-4000-8000-000000266010')$q$);
  perform pg_temp.t('28 a passed snooze is back in Unread (marked "back") even before the job', r = 'ok:true/true', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (select (e ->> 'returned') from jsonb_array_elements(public.bell_feed(20) -> 'items') e where e ->> 'id' = 'c0000000-0000-4000-8000-000000266010')$q$);
  perform pg_temp.t('29 ... and back in the bell', r = 'ok:true', r);
  v := public.inbox_tick();
  perform pg_temp.t('30 inbox_tick (cron) turns the passed snooze into unread again',
    (v ->> 'returned')::int >= 1 and exists (select 1 from public.notification_inbox_state s where s.user_id = pg_temp.uid('c_sales266@c.test')
      and s.notification_id = 'c0000000-0000-4000-8000-000000266010' and s.snoozed_until is null and s.snooze_returned_at is not null and s.unread_at is not null), v::text);
  r := pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_tick()::text$q$);
  perform pg_temp.t('31 the app cannot run the tick', r like 'err:42501%', r);
  -- "mark all read" (the bell's time) then mark one unread again
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_read_all() -> 'counts' ->> 'unread')$q$);
  perform pg_temp.t('32 mark all read: nothing unread (snoozed stays snoozed)', r = 'ok:0'
    and pg_temp.inbox_ids('c_sales266@c.test', 'snoozed') like '%266007%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_act(array['c0000000-0000-4000-8000-000000266012']::uuid[], 'unread') -> 'counts' ->> 'unread')$q$);
  perform pg_temp.t('33 marking unread after "mark all read" wins', r = 'ok:1', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.bell_feed(20) ->> 'unread')$q$);
  perform pg_temp.t('34 bell badge = inbox unread', r = 'ok:1', r);
  r2 := pg_temp.as_try('c_admin266@c.test', $q$select (public.inbox_feed('unread') -> 'counts' ->> 'unread')$q$);
  r := pg_temp.as_try('c_admin266@c.test', $q$select (public.inbox_read_all('finance') -> 'counts' ->> 'unread')$q$);
  perform pg_temp.t('35 admin: "mark read" for one group only touches that group (the one payment row)', r2 ~ '^ok:\d+$' and r = 'ok:' || (substr(r2, 4)::int - 1)::text, r2 || ' -> ' || r);

  -- ---- isolation + direct access ----
  r := pg_temp.as_try('b_admin@b.test', format($q$select (public.inbox_act(array[%L]::uuid[], 'done') ->> 'changed')$q$, 'c0000000-0000-4000-8000-000000266012'));
  perform pg_temp.t('36 another studio cannot mark these rows', r = 'ok:0'
    and not exists (select 1 from public.notification_inbox_state s where s.user_id = pg_temp.uid('b_admin@b.test')), r);
  r := pg_temp.as_try('c_crew266@c.test', $q$select (public.inbox_act(array['c0000000-0000-4000-8000-000000266003']::uuid[], 'done') ->> 'changed')$q$);
  perform pg_temp.t('37 a row the person cannot see cannot be marked (crew + payment row)', r = 'ok:0', r);
  r := pg_temp.as_try('c_admin266@c.test', $q$select count(*)::text from public.notification_inbox_state$q$);
  perform pg_temp.t('38 RLS: a person reads only their own marks', r = 'ok:' || (select count(*) from public.notification_inbox_state s where s.user_id = pg_temp.uid('c_admin266@c.test'))::text
    and (select count(*) from public.notification_inbox_state s where s.user_id = pg_temp.uid('c_sales266@c.test')) > 0, r);
  r := pg_temp.as_try('c_sales266@c.test', $q$update public.notification_inbox_state set done_at = null returning 1::text$q$);
  perform pg_temp.t('39 no direct update from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$insert into public.notification_inbox_state(user_id, notification_id, org_id) values (auth.uid(), 'c0000000-0000-4000-8000-000000266012', 'c0000000-0000-4000-8000-000000000266') returning 1::text$q$);
  perform pg_temp.t('40 no direct insert from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_act(array['c0000000-0000-4000-8000-000000266012']::uuid[], 'delete')::text$q$);
  perform pg_temp.t('41 unknown action refused', r like 'err:22023%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_feed('trash')::text$q$);
  perform pg_temp.t('42 unknown tab refused', r like 'err:22023%', r);
  r := pg_temp.as_try('anon', $q$select public.inbox_feed('all')::text$q$);
  perform pg_temp.t('43 anon refused', r like 'err:42501%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_act((select array_agg(gen_random_uuid()) from generate_series(1, 501)), 'read')::text$q$);
  perform pg_temp.t('44 more than 500 at once refused', r like 'err:22023%', r);
  -- 0063 personal mute: hidden from the inbox too
  insert into public.notification_mutes(user_id, org_id, type) values (pg_temp.uid('c_crew266@c.test'), a, 'task_update') on conflict do nothing;
  r := pg_temp.inbox_ids('c_crew266@c.test', 'all');
  perform pg_temp.t('45 a muted type (task updates) leaves the person''s inbox', r not like '%266001%' and r not like '%266012%' and r like '%266006%', r);
  delete from public.notification_mutes where user_id = pg_temp.uid('c_crew266@c.test');

  -- ---- settings ----
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_my_settings() ->> 'mode') || '|' || coalesce(public.inbox_my_settings() ->> 'mine', 'null')$q$);
  perform pg_temp.t('46 default e-mail mode = daily digest (studio default, nothing chosen)', r = 'ok:daily|null', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_set_my_digest('off') ->> 'mode')$q$);
  perform pg_temp.t('47 a person can switch e-mails off', r = 'ok:off', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_set_my_digest('weekly') ->> 'mode')$q$);
  perform pg_temp.t('48 unknown e-mail mode refused', r like 'err:22023%', r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.inbox_set_my_digest('default') ->> 'mode')$q$);
  perform pg_temp.t('49 back to the studio default', r = 'ok:daily', r);
  r := pg_temp.as_try('c_crew266@c.test', $q$select public.admin_set_inbox_settings('{"digest_default":"off"}')::text$q$);
  perform pg_temp.t('50 Control Center edit needed to change the studio settings', r like 'err:42501%', r);
  r := pg_temp.as_try('c_admin266@c.test', $q$select public.admin_set_inbox_settings('{"digest_hour":25}')::text$q$);
  perform pg_temp.t('51 bad digest hour refused', r like 'err:22023%', r);
  r := pg_temp.as_try('c_admin266@c.test', $q$select (public.admin_set_inbox_settings('{"bell_open_marks_read":true}') ->> 'bell_open_marks_read')$q$);
  perform pg_temp.t('52 admin saves a setting (audit logged)', r = 'ok:true'
    and exists (select 1 from public.audit_log al where al.action = 'inbox_settings.set' and al.org_id = a), r);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.bell_feed(20) -> 'inbox' ->> 'open_marks_read')$q$);
  perform pg_temp.t('53 the bell tells the page whether opening it marks read', r = 'ok:true', r);
  perform pg_temp.as_try('c_admin266@c.test', $q$select public.admin_set_inbox_settings('{"bell_open_marks_read":false}')::text$q$);

  -- ---- digests ----
  -- the studio's digest hour = now (IST) so the daily window is open; staff: the 12 rows are unread again (marks cleared)
  delete from public.notification_inbox_state where user_id = pg_temp.uid('c_sales266@c.test');
  delete from public.notification_seen where user_id = pg_temp.uid('c_sales266@c.test');
  perform pg_temp.as_try('c_admin266@c.test', format($q$select public.admin_set_inbox_settings('{"digest_hour":%s}')::text$q$, extract(hour from now() at time zone 'Asia/Kolkata')::int));
  perform public._r23_queue_digests();
  select count(*) into n from public.helm_notice_outbox where kind = 'inbox_digest' and ref_id = pg_temp.uid('c_sales266@c.test') and dedupe_key like 'inbox_digest:%';
  perform pg_temp.t('54 daily digest queued for a person with unread items (once)', n = 1, n::text);
  perform pg_temp.t('55 the listed items are marked digested (never twice)',
    (select count(*) from public.notification_inbox_state s where s.user_id = pg_temp.uid('c_sales266@c.test') and s.digested_at is not null) = ns
    and (select count(*) from public.notification_inbox_state s where s.user_id = pg_temp.uid('c_sales266@c.test') and s.read_at is not null) = 0, null);
  perform public._r23_queue_digests();
  select count(*) into n from public.helm_notice_outbox where kind = 'inbox_digest' and ref_id = pg_temp.uid('c_sales266@c.test');
  perform pg_temp.t('56 a second run the same day queues nothing more', n = 1, n::text);
  perform pg_temp.t('57 crew: own digest has only rows the crew member can see',
    not exists (select 1 from public.helm_notice_outbox x, jsonb_array_elements_text(x.payload -> 'ids') i
                 where x.kind = 'inbox_digest' and x.ref_id = pg_temp.uid('c_crew266@c.test') and i in ('c0000000-0000-4000-8000-000000266003', 'c0000000-0000-4000-8000-000000266004')), null);
  -- at send time: the claim re-checks. Staff reads everything -> skipped; admin still unread -> sent to the admin only
  perform pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_read_all()::text$q$);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v := public.helm_notice_outbox_claim(100);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.t('58 claim: the read person''s digest is skipped (nothing still unread)',
    (select status from public.helm_notice_outbox where kind = 'inbox_digest' and ref_id = pg_temp.uid('c_sales266@c.test')) = 'skipped'
    and not exists (select 1 from jsonb_array_elements(v) e where e ->> 'kind' = 'inbox_digest' and e -> 'to' ? 'c_sales266@c.test'), v::text);
  perform pg_temp.t('59 claim: the admin''s digest goes to the admin with still-unread items (labels, dd/mm/yyyy)',
    exists (select 1 from jsonb_array_elements(v) e where e ->> 'kind' = 'inbox_digest' and e -> 'to' = '["c_admin266@c.test"]'::jsonb
              and (e -> 'data' ->> 'count')::int >= 5 and (e -> 'data' -> 'items' -> 0 ->> 'at') ~ '^\d\d/\d\d/\d{4} '
              and (e -> 'data')::text not like '%secret-tok%' and (e -> 'data')::text not like '%Member removed%'), v::text);
  -- instant (important only)
  perform pg_temp.as_try('c_admin266@c.test', $q$select public.inbox_set_my_digest('instant_important')::text$q$);
  insert into public.notifications(id, quote_id, channel, kind, status, detail, org_id, created_at)
    values ('c0000000-0000-4000-8000-000000266013', 'c0000000-0000-4000-8000-00000000c266', 'in_app', 'payment_received', 'simulated', '{}', a, now() - interval '10 minutes'),
           ('c0000000-0000-4000-8000-000000266014', 'c0000000-0000-4000-8000-00000000c266', 'in_app', 'task_start', 'simulated', '{}', a, now() - interval '10 minutes');
  perform public._r23_queue_digests();
  perform pg_temp.t('60 instant: the important item is queued at once, the ordinary one is not',
    exists (select 1 from public.helm_notice_outbox x where x.kind = 'inbox_digest' and x.ref_id = pg_temp.uid('c_admin266@c.test') and x.dedupe_key like 'inbox_instant:%'
              and x.payload -> 'ids' ? 'c0000000-0000-4000-8000-000000266013' and not (x.payload -> 'ids' ? 'c0000000-0000-4000-8000-000000266014')), null);
  -- off / studio switch
  delete from public.helm_notice_outbox where kind = 'inbox_digest';
  delete from public.notification_inbox_state where user_id = pg_temp.uid('c_sales266@c.test');
  delete from public.notification_seen where user_id = pg_temp.uid('c_sales266@c.test');
  perform pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_set_my_digest('off')::text$q$);
  perform public._r23_queue_digests();
  perform pg_temp.t('61 "off" queues nothing for that person', not exists (select 1 from public.helm_notice_outbox where kind = 'inbox_digest' and ref_id = pg_temp.uid('c_sales266@c.test')), null);
  perform pg_temp.as_try('c_sales266@c.test', $q$select public.inbox_set_my_digest('default')::text$q$);
  perform pg_temp.as_try('c_admin266@c.test', $q$select public.admin_set_inbox_settings('{"email_enabled":false}')::text$q$);
  perform public._r23_queue_digests();
  perform pg_temp.t('62 studio switch off: nothing queued for anyone', not exists (select 1 from public.helm_notice_outbox where kind = 'inbox_digest' and org_id = a), null);
  perform pg_temp.as_try('c_admin266@c.test', $q$select public.admin_set_inbox_settings('{"email_enabled":true}')::text$q$);

  -- ---- lanes, retention, re-run ----
  perform pg_temp.t('63 outbox kinds widened to a superset + claim branch',
    position('inbox_digest' in (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check')) > 0
    and position('close_decision' in (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check')) > 0
    and position('sales_request' in (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check')) > 0
    and position('r23-inbox-0266' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
    and position('r22-closure-0254' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0, null);
  perform pg_temp.t('64 trial retention: state purged with notifications, settings kept',
    to_regprocedure('public._tr184_purge_tables()') is null
    or ('notification_inbox_state' = any (public._tr184_purge_tables()) and 'inbox_settings' = any (public._tr184_keep_tables())
        and 'inbox_person_prefs' = any (public._tr184_keep_tables())), null);
end $$;

-- a second run of the migration changes nothing and the bell still works
\i supabase/migrations/0266_notification_inbox.sql
\i supabase/migrations/0270_inbox_visible_speed.sql
do $$ declare r text; begin
  perform pg_temp.t('65 re-run: one wrapper (no double wrap), one claim branch, bell works',
    to_regprocedure('public.bell_feed__pre0266(integer)') is not null
    and position('r23-inbox-0266' in (select prosrc from pg_proc where oid = 'public.bell_feed__pre0266(integer)'::regprocedure)) = 0
    and (length(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure))
         - length(replace(pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure), 'r23-inbox-0266', ''))) = length('r23-inbox-0266'), null);
  r := pg_temp.as_try('c_sales266@c.test', $q$select (public.bell_feed(20) ->> 'unread')$q$);
  perform pg_temp.t('66 bell after re-run', r ~ '^ok:\d+$', r);
  perform pg_temp.t('67 0270: the person''s rules are worked out once per call (materialized), still the 0266 rules, still private',
    position('r24-ci-0270' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
    and position('with me as materialized (' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
    and position('r23-inbox-0266' in (select prosrc from pg_proc where oid = 'public._r23_visible(uuid,uuid)'::regprocedure)) > 0
    and not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute'), null);
end $$;

select name, result from _g266 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-INBOX-0266: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-INBOX-0266: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g266;
