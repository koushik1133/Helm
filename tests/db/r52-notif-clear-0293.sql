-- r52-notif-clear-0293.sql -- r52 bug report "notifications are not clearing". 0293: the dashboard "N unread"
-- (my_pending) = the bell badge = the /inbox unread count, per person (own read / Done / snooze, mutes, role
-- visibility); the bell list, badge and inbox agree for admin / manager / coordinator / crew, incl. client link view
-- rows (0261). Every clearing path (row read, Done, bell "Mark all read", filtered "Mark all read") brings all three to
-- 0, per person only; new rows after clearing count again exactly once; two-step / deactivated / read-only studio;
-- hidden types once per call; a failing inbox part degrades to the old count. The notification catalog (audit I-01)
-- gives the same list, runs the oldest layer once per read, and the bell / Control Center settings answer fast.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

-- re-apply twice (earlier suites may re-apply 0266 / 0285 / 0292 over these bodies; proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0293_r52_notifications_clear.sql
\ir ../../supabase/migrations/0293_r52_notifications_clear.sql
set client_min_messages = warning;

-- run p_sql as the API would (role authenticated + JWT claims); returns jsonb or {"error": SQLSTATE}
create or replace function pg_temp.q(p_claims jsonb, p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; st text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, '{}'::jsonb)::text, true);
  begin
    execute 'set local role authenticated';
    execute p_sql into r;
    execute 'reset role';
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    execute 'reset role';
    r := jsonb_build_object('error', st, 'message', sqlerrm);
  end;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;
create or replace function pg_temp.cl(p_email text, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $$
  select jsonb_build_object('sub', (select id from auth.users where email = p_email)::text, 'role', 'authenticated') || p_extra;
$$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;
-- bell badge / unread rows in the bell list / inbox unread / dashboard unread for one person
create or replace function pg_temp.n4(p_email text, p_extra jsonb default '{}'::jsonb) returns jsonb language plpgsql as $$
declare b jsonb; i jsonb; p jsonb;
begin
  b := pg_temp.q(pg_temp.cl(p_email, p_extra), 'select public.bell_feed(100)');
  i := pg_temp.q(pg_temp.cl(p_email, p_extra), 'select public.inbox_feed(''unread'', null, null, 100, null)');
  p := pg_temp.q(pg_temp.cl(p_email, p_extra), 'select public.my_pending()');
  return jsonb_build_object('badge', (b ->> 'unread')::int,
    'list', (select count(*) from jsonb_array_elements(coalesce(b -> 'items', '[]'::jsonb)) e where coalesce((e ->> 'unread')::boolean, false)),
    'items', jsonb_array_length(coalesce(b -> 'items', '[]'::jsonb)),
    'inbox', (i -> 'counts' ->> 'unread')::int, 'pending', (p ->> 'unread')::int,
    'err', coalesce(b ->> 'error', i ->> 'error', p ->> 'error'), 'degraded', coalesce((p ->> 'degraded')::boolean, false));
end $$;
create or replace function pg_temp.same(j jsonb, n int default null) returns boolean language sql as $$
  select j ->> 'err' is null and not (j ->> 'degraded')::boolean
     and (j ->> 'badge')::int = (j ->> 'list')::int and (j ->> 'badge')::int = (j ->> 'inbox')::int and (j ->> 'badge')::int = (j ->> 'pending')::int
     and (n is null or (j ->> 'badge')::int = n);
$$;
-- ids of everything in a person's bell list
create or replace function pg_temp.ids(p_email text) returns uuid[] language sql as $$
  select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(pg_temp.q(pg_temp.cl(p_email), 'select public.bell_feed(100)') -> 'items') e
   where (e ->> 'id') ~ '^[0-9a-f-]{36}$' and coalesce(e -> 'detail' ->> 'hq', '') <> 'true';
$$;
create or replace function pg_temp.act(p_email text, p_ids uuid[], p_action text) returns jsonb language sql as $$
  select pg_temp.q(pg_temp.cl(p_email), format('select public.inbox_act(%L::uuid[], %L)', p_ids, p_action));
$$;
create or replace function pg_temp.notes(p_tag text, p_ago interval) returns void language plpgsql as $$
declare o uuid := 'e0000000-0000-4000-8000-000000000293'; q uuid := 'e0000000-0000-4000-8000-0000000c0293';
        adm text := (select id from auth.users where email = 'r52_admin@r.test')::text;
        mgr text := (select id from auth.users where email = 'r52_mgr@r.test')::text;
begin
  insert into public.notifications(quote_id, channel, kind, status, detail, org_id, created_at)
  select q, 'in_app', x.k, 'simulated',
         case when x.k = 'client_view_followup' and x.n = 2 then jsonb_build_object('notify', jsonb_build_array(adm), 'tag', p_tag)
              when x.k = 'client_view_followup' then jsonb_build_object('notify', jsonb_build_array(mgr), 'tag', p_tag)
              else jsonb_build_object('tag', p_tag) end,
         o, now() - p_ago + (x.n || ' seconds')::interval
    from unnest(array['task_accept', 'client_view_followup', 'task_complete', 'advance_paid', 'price_change', 'event_close_request',
                      'design_revise', 'client_link_viewed', 'task_reject', 'payment_received', 'client_view_followup', 'event_reminder'])
         with ordinality x(k, n);
end $$;

do $$
declare o uuid := 'e0000000-0000-4000-8000-000000000293'; q uuid := 'e0000000-0000-4000-8000-0000000c0293'; e text; u uuid;
begin
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (o, 'Studio R52', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) on conflict (id) do nothing;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at) values
    (o, 'manager', 'quotes', true, true, now()), (o, 'manager', 'finance', true, true, now()),
    (o, 'coordinator', 'quotes', true, false, now()), (o, 'crew', 'calendar', true, false, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  foreach e in array array['r52_admin@r.test:admin', 'r52_mgr@r.test:manager', 'r52_coord@r.test:coordinator', 'r52_crew@r.test:crew'] loop
    select id into u from auth.users where email = split_part(e, ':', 1);
    if u is null then u := auth.seed_user(split_part(e, ':', 1)); end if;
    insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
      values (u, split_part(e, ':', 1), 'R52 ' || split_part(e, ':', 2), split_part(e, ':', 2), o, false, now())
    on conflict (id) do update set role = excluded.role, org_id = excluded.org_id, full_name = excluded.full_name, must_change_password = false;
    delete from public.notification_seen where user_id = u;
    delete from public.notification_mutes where user_id = u;
    delete from public.notification_prefs where user_id = u;
    update public.team_member_status set status = 'active' where user_id = u;
    delete from auth.mfa_factors where user_id = u;
  end loop;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, created_at, updated_at)
    values (q, 'R-0293', 'Wedding R52', 'quote', '{"name":"R"}'::jsonb, '{"subtotal":1000,"discount":0,"gstPct":0,"total":1000}'::jsonb, 1, 'sent', o,
            gen_random_uuid(), now(), now()) on conflict (id) do nothing;
  delete from public.auth_rate_hits where bucket = 'inbox_act';
  perform pg_temp.notes('first', interval '1 hour');
end $$;

do $$
declare j jsonb; k jsonb; w text; ids uuid[]; c0 bigint; c1 bigint; n0 int; n1 int; t0 timestamptz; ms numeric;
  o uuid := 'e0000000-0000-4000-8000-000000000293';
  a_mgr uuid := (select id from auth.users where email = 'r52_mgr@r.test');
  a_crew uuid := (select id from auth.users where email = 'r52_crew@r.test');
begin
  -- 01-02 shape + grants
  perform pg_temp.res('01 my_pending + _r23_visible carry the 0293 marker, security definer, empty search path',
    (select bool_and(position('r52-notif-0293' in p.prosrc) > 0 and p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%')
       from pg_proc p where p.oid in ('public.my_pending()'::regprocedure, 'public._r23_visible(uuid,uuid)'::regprocedure)));
  perform pg_temp.res('02 grants: my_pending for signed-in users only; _r23_visible + both kept bodies not callable by the app',
    has_function_privilege('authenticated', 'public.my_pending()', 'execute')
    and not has_function_privilege('anon', 'public.my_pending()', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_visible(uuid,uuid)', 'execute')
    and to_regprocedure('public.my_pending__pre0293()') is not null and to_regprocedure('public._r23_visible__pre0293(uuid,uuid)') is not null
    and not has_function_privilege('authenticated', 'public.my_pending__pre0293()', 'execute')
    and not has_function_privilege('anon', 'public.my_pending__pre0293()', 'execute')
    and not has_function_privilege('authenticated', 'public._r23_visible__pre0293(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public._r23_visible__pre0293(uuid,uuid)', 'execute'));

  -- 03 fresh: badge = bell list = inbox = dashboard, for each role
  foreach w in array array['r52_admin@r.test', 'r52_mgr@r.test', 'r52_coord@r.test', 'r52_crew@r.test'] loop
    j := pg_temp.n4(w);
    perform pg_temp.res('03 fresh ' || split_part(w, '@', 1) || ': badge = bell list = inbox = dashboard (> 0)',
      pg_temp.same(j) and (j ->> 'badge')::int > 0, j::text);
  end loop;
  -- 07-08 root cause 2: a manager's badge counted client follow-ups addressed to someone else (hidden from the list)
  perform pg_temp.res('07 root cause 2: before 0293 the inbox counted a follow-up addressed to the admin for the manager',
    exists (select 1 from public._r23_visible__pre0293(o, a_mgr) v where v.kind = 'client_view_followup' and v.detail -> 'notify' ? (select id from auth.users where email = 'r52_admin@r.test')::text));
  perform pg_temp.res('08 now: the manager keeps the follow-up addressed to them, not the one for the admin; crew sees no client link rows',
    exists (select 1 from public._r23_visible(o, a_mgr) v where v.kind = 'client_view_followup' and v.detail -> 'notify' ? a_mgr::text)
    and not exists (select 1 from public._r23_visible(o, a_mgr) v where v.kind = 'client_view_followup' and not (v.detail -> 'notify' ? a_mgr::text))
    and not exists (select 1 from public._r23_visible(o, a_crew) v where v.kind in ('client_link_viewed', 'client_view_followup')));

  -- 09 path A: read every row in the bell, one by one (bell click / "Mark read") -> 0 everywhere, every role
  foreach w in array array['r52_admin@r.test', 'r52_mgr@r.test', 'r52_coord@r.test', 'r52_crew@r.test'] loop
    perform pg_temp.act(w, pg_temp.ids(w), 'read');
    j := pg_temp.n4(w);
    perform pg_temp.res('09 row reads ' || split_part(w, '@', 1) || ': badge, list, inbox AND dashboard all 0', pg_temp.same(j, 0), j::text);
  end loop;
  perform set_config('request.jwt.claims', pg_temp.cl('r52_crew@r.test')::text, true);   -- the kept body: owner only
  j := public.my_pending__pre0293();
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.res('10 root cause 1: the previous dashboard count still said unread after every row was read (crew)',
    (j ->> 'unread')::int > 0, j::text);

  -- 11 one row marked unread again -> 1 everywhere
  ids := pg_temp.ids('r52_mgr@r.test');
  perform pg_temp.act('r52_mgr@r.test', ids[1:1], 'unread');
  j := pg_temp.n4('r52_mgr@r.test');
  perform pg_temp.res('11 manager marks one row unread: 1 everywhere', pg_temp.same(j, 1), j::text);

  -- 12 path B: Done on everything -> 0, the bell list is empty
  perform pg_temp.act('r52_mgr@r.test', ids, 'done');
  j := pg_temp.n4('r52_mgr@r.test');
  perform pg_temp.res('12 manager Done on all: 0 everywhere, bell list empty', pg_temp.same(j, 0) and (j ->> 'items')::int = 0, j::text);
  perform pg_temp.act('r52_mgr@r.test', ids, 'undone');

  -- 13-15 new rows after clearing count again exactly once; per person only
  perform pg_temp.notes('second', interval '10 minutes');
  j := pg_temp.n4('r52_coord@r.test'); n0 := (j ->> 'badge')::int;
  perform pg_temp.res('13 new rows after clearing: coordinator counts only the new ones (> 0), all four agree',
    pg_temp.same(j) and n0 > 0, j::text);
  -- path C: the bell's "Mark all read" (inbox_read_all without a filter)
  j := pg_temp.q(pg_temp.cl('r52_coord@r.test'), 'select public.inbox_read_all(null, null)');
  j := pg_temp.n4('r52_coord@r.test');
  perform pg_temp.res('14 coordinator "Mark all read": 0 everywhere', pg_temp.same(j, 0), j::text);
  j := pg_temp.n4('r52_admin@r.test');
  perform pg_temp.res('15 per person: the admin still has the new rows unread (one person clearing never clears another)',
    pg_temp.same(j) and (j ->> 'badge')::int > 0, j::text);

  -- 16 path D: filtered "Mark all read" (the /inbox page with a group / type filter) lowers the dashboard too
  n0 := (pg_temp.n4('r52_admin@r.test') ->> 'pending')::int;
  perform pg_temp.q(pg_temp.cl('r52_admin@r.test'), 'select public.inbox_read_all(''task_accept'', null)');
  j := pg_temp.n4('r52_admin@r.test');
  perform pg_temp.res('16 admin filtered "Mark all read" (task_accept): dashboard drops by exactly those rows, all agree',
    pg_temp.same(j) and (j ->> 'pending')::int = n0 - 1, n0 || ' -> ' || j::text);

  -- 17 a personal mute: the muted type leaves the dashboard count as it leaves the bell
  n0 := (pg_temp.n4('r52_admin@r.test') ->> 'pending')::int;
  insert into public.notification_mutes(user_id, org_id, type)
    values ((select id from auth.users where email = 'r52_admin@r.test'), o, public.notification_type_of('task_complete', 'in_app')) on conflict do nothing;
  j := pg_temp.n4('r52_admin@r.test');
  perform pg_temp.res('17 admin mutes "task complete": dashboard count follows the inbox (lower), inbox = dashboard',
    j ->> 'err' is null and (j ->> 'pending')::int < n0 and (j ->> 'pending')::int = (j ->> 'inbox')::int, n0 || ' -> ' || j::text);
  delete from public.notification_mutes where user_id = (select id from auth.users where email = 'r52_admin@r.test');

  -- 18 snooze one unread row (Later today): it leaves the badge, the list, the inbox and the dashboard together
  n0 := (pg_temp.n4('r52_admin@r.test') ->> 'pending')::int;
  ids := (select array_agg((e ->> 'id')::uuid) from jsonb_array_elements(pg_temp.q(pg_temp.cl('r52_admin@r.test'), 'select public.inbox_feed(''unread'', null, null, 1, null)') -> 'items') e);
  j := pg_temp.q(pg_temp.cl('r52_admin@r.test'), format('select public.inbox_act(%L::uuid[], ''snooze'', null, ''later_today'')', ids));
  j := pg_temp.n4('r52_admin@r.test');
  perform pg_temp.res('18 admin snoozes one unread row: one less everywhere', pg_temp.same(j) and (j ->> 'pending')::int = n0 - 1, n0 || ' -> ' || j::text);

  -- 19-20 speed: nothing unread -> nothing worked out; something unread -> rules once per call
  set local track_functions = 'all';
  perform pg_temp.q(pg_temp.cl('r52_crew@r.test'), 'select public.inbox_read_all(null, null)');
  c0 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  j := pg_temp.q(pg_temp.cl('r52_crew@r.test'), 'select public.my_pending()');
  c1 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  perform pg_temp.res('19 nothing can be unread: unread 0 without working the hidden types out', (j ->> 'unread')::int = 0 and c1 = c0, 'calls=' || (c1 - c0) || ' ' || j::text);
  j := pg_temp.q(pg_temp.cl('r52_admin@r.test'), 'select public.my_pending()');
  c0 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0) - c1;
  perform pg_temp.res('20 something unread: hidden types worked out once per call', (j ->> 'unread')::int > 0 and c0 = 1, 'calls=' || c0);

  -- 21-23 empty states unchanged (signed out / two-step aal1 / deactivated), aal2 answers
  perform pg_temp.res('21 signed out: empty answer, not an error',
    (select (r -> 'upcoming') = '[]'::jsonb and (r ->> 'unread')::int = 0 from (select pg_temp.q('{}'::jsonb, 'select public.my_pending()') r) x));
  insert into auth.mfa_factors(id, user_id, status, factor_type) values (gen_random_uuid(), a_mgr, 'verified', 'totp');
  j := pg_temp.q(pg_temp.cl('r52_mgr@r.test'), 'select public.my_pending()');
  k := pg_temp.n4('r52_mgr@r.test', '{"aal":"aal2"}'::jsonb);
  perform pg_temp.res('22 two-step member: aal1 empty answer; aal2 full answer that agrees with the bell',
    not (j ? 'error') and (j ->> 'unread')::int = 0 and pg_temp.same(k), j::text || ' / ' || k::text);
  delete from auth.mfa_factors where user_id = a_mgr;
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (a_mgr, o, 'deactivated', now());
  j := pg_temp.q(pg_temp.cl('r52_mgr@r.test'), 'select public.my_pending()');
  perform pg_temp.res('23 deactivated member: empty answer', not (j ? 'error') and (j ->> 'unread')::int = 0, j::text);
  update public.team_member_status set status = 'active' where user_id = a_mgr and org_id = o;

  -- 24 ended trial (read-only studio): clearing still works
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = o;
  perform pg_temp.notes('third', interval '5 minutes');
  perform pg_temp.act('r52_mgr@r.test', pg_temp.ids('r52_mgr@r.test'), 'read');
  j := pg_temp.n4('r52_mgr@r.test');
  perform pg_temp.res('24 read-only (ended trial) studio: reading every row still clears to 0 everywhere', pg_temp.same(j, 0), j::text);
  update public.organizations set trial_ends_at = null where id = o;

  -- 25-26 a failing inbox part: the previous count + degraded, never an error (rename undone right after)
  begin
    alter table public.notification_inbox_state rename to notification_inbox_state_r52;
    j := pg_temp.q(pg_temp.cl('r52_admin@r.test'), 'select public.my_pending()');
    raise exception 'r52-undo';
  exception when others then
    if sqlerrm <> 'r52-undo' then j := jsonb_build_object('error', sqlstate, 'message', sqlerrm); end if;
  end;
  perform pg_temp.res('25 inbox part fails: degraded, falls back to the previous count, no error',
    not (j ? 'error') and (j ->> 'degraded')::boolean and (j ->> 'unread')::int >= 0, j::text);
  perform pg_temp.res('26 the table rename above was undone', to_regclass('public.notification_inbox_state') is not null);

  -- 27-32 the catalog (audit I-01): same list, each layer read once, the bell / settings fast
  perform pg_temp.res('27 catalog: plpgsql now, same list byte for byte as the kept previous body',
    (select l.lanname = 'plpgsql' and p.prosecdef from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.notification_catalog()'::regprocedure)
    and public.notification_catalog()::text = public.notification_catalog__pre0293()::text
    and jsonb_array_length(public.notification_catalog()) > 20);
  perform pg_temp.res('28 every kept catalog layer that reads the one below does it once (offset 0 marker)',
    not exists (select 1 from pg_proc p where p.proname ~ '^notification_catalog__pre\d{4}$' and p.proname <> 'notification_catalog__pre0293'
                 and p.prosrc ~ 'select\s+public\.notification_catalog__pre\d{4}\(\)\s+as\s+c\s*\)'));
  c0 := coalesce(pg_stat_get_xact_function_calls('public.notification_catalog__pre0261()'::regprocedure), 0);
  perform public.notification_catalog__pre0285();   -- a fresh statement (the plpgsql catalog itself is folded once per session)
  c1 := coalesce(pg_stat_get_xact_function_calls('public.notification_catalog__pre0261()'::regprocedure), 0);
  perform pg_temp.res('29 one read of the kept 0285 layer reads the 0250 layer once (was 27 times; the oldest list 81 times)', c1 - c0 = 1, 'calls=' || (c1 - c0));
  perform pg_temp.res('30 grants: catalog for signed-in users; kept body + the two 0078 bodies (audit I-06) not callable by the app',
    has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')
    and not has_function_privilege('anon', 'public.notification_catalog()', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_catalog__pre0293()', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_catalog__pre0078()', 'execute')
    and not has_function_privilege('authenticated', 'public.notification_type_of__pre0078(text,text)', 'execute')
    and not has_function_privilege('anon', 'public.notification_type_of__pre0078(text,text)', 'execute'));
  t0 := clock_timestamp();
  j := pg_temp.q(pg_temp.cl('r52_mgr@r.test'), 'select public.bell_feed(20)');
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  perform pg_temp.res('31 bell_feed answers in under 500 ms (was ~5 s)', j ->> 'error' is null and ms < 500, round(ms) || ' ms');
  t0 := clock_timestamp();
  j := pg_temp.q(pg_temp.cl('r52_admin@r.test'), 'select public.admin_get_notification_prefs()');
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  perform pg_temp.res('32 Control Center notification settings answer in under 2 s (was ~30 s, over the 8 s API limit)',
    j ->> 'error' is null and ms < 2000, round(ms) || ' ms ' || left(j::text, 120));
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R52-NOTIF-CLEAR-0293: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R52-NOTIF-CLEAR-0293: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
