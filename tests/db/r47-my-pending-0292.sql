-- r47-my-pending-0292.sql -- r47: POST /rpc/my_pending answered 500 in production (statement timeout: the hidden
-- notification types were worked out again for every unread row). 0292 re-issues my_pending: hidden types once per call,
-- unread grouped by kind / channel, an empty answer (never an error) for signed out / no studio / deactivated / two-step
-- not finished / malformed token, a failing part degrades to empty with "degraded": true. Same answer as the old body.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;

-- re-apply twice (earlier suites may re-apply 0036 over my_pending; proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0292_r47_my_pending_speed.sql
\ir ../../supabase/migrations/0292_r47_my_pending_speed.sql
set client_min_messages = warning;

-- call my_pending as the API would (role authenticated + the JWT claims); returns the answer or {"error": SQLSTATE}
create or replace function pg_temp.mp(p_claims jsonb, p_fn text default 'my_pending') returns jsonb language plpgsql as $$
declare r jsonb; st text;
begin
  perform set_config('request.jwt.claims', coalesce(p_claims, '{}'::jsonb)::text, true);
  begin
    if p_fn = 'my_pending' then execute 'set local role authenticated'; end if;   -- the kept old body: owner only
    execute format('select public.%I()', p_fn) into r;
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
create or replace function pg_temp.empty(j jsonb) returns boolean language sql as $$
  select j ? 'as_of' and not (j ? 'error') and j -> 'upcoming' = '[]'::jsonb and (j ->> 'unread')::int = 0;
$$;
-- the event list holds the fixture event (earlier suites may leave more events / notifications behind)
create or replace function pg_temp.has(j jsonb, p_code text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(coalesce(j -> 'upcoming', '[]'::jsonb)) e where e ->> 'code' = p_code);
$$;
-- old vs new: same unread + same events (the old body's order of events on the same date was not fixed)
create or replace function pg_temp.same(j jsonb, k jsonb) returns boolean language sql as $$
  select (j ->> 'unread') = (k ->> 'unread')
     and (select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(j -> 'upcoming') e)
       = (select coalesce(jsonb_agg(e order by e ->> 'id'), '[]'::jsonb) from jsonb_array_elements(k -> 'upcoming') e);
$$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default null) returns void language sql as $$
  insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL ' || coalesce(p_detail, '') end);
$$;
create or replace function pg_temp.notes(p_org uuid, p_n integer, p_kind text default 'payment') returns void language plpgsql as $$
begin
  set local session_replication_role = replica;      -- bulk fixture rows only (no notify triggers)
  insert into public.notifications(org_id, channel, kind, status, created_at)
  select p_org, 'in_app', p_kind, 'simulated', now() + (g || ' microseconds')::interval from generate_series(1, p_n) g;
  set local session_replication_role = origin;
end $$;

do $$
declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  a_admin uuid := (select id from auth.users where email = 'a_admin@a.test');
  a_staff uuid := (select id from auth.users where email = 'a_staff@a.test');
  b_staff uuid := (select id from auth.users where email = 'b_staff@b.test');
  j jsonb; k jsonb; c0 bigint; c1 bigint; t0 timestamptz; ms numeric;
begin
  -- start from "bell opened now" for the fixture people, so only the rows made below count as unread
  insert into public.notification_seen(user_id, last_seen_at, org_id)
    select u, now(), o from (values (a_admin, orgA), (a_staff, orgA), (b_staff, orgB)) v(u, o)
  on conflict (user_id) do update set last_seen_at = excluded.last_seen_at;
  delete from public.notification_prefs where user_id in (a_admin, a_staff, b_staff);
  delete from public.team_member_status where user_id in (a_admin, a_staff, b_staff);
  delete from auth.mfa_factors where user_id in (a_admin, a_staff, b_staff);

  -- 01 shape + grants
  perform pg_temp.res('01 my_pending carries the 0292 marker, plpgsql, security definer, empty search path',
    (select position('r47-my-pending-0292' in p.prosrc) > 0 and p.prosecdef and l.lanname = 'plpgsql'
            and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=""%'
       from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = 'public.my_pending()'::regprocedure));
  perform pg_temp.res('02 signed-in users may call it, anon / public may not; the kept old body is private',
    has_function_privilege('authenticated', 'public.my_pending()', 'execute')
    and not has_function_privilege('anon', 'public.my_pending()', 'execute')
    and to_regprocedure('public.my_pending__pre0292()') is not null
    and not has_function_privilege('authenticated', 'public.my_pending__pre0292()', 'execute')
    and not has_function_privilege('anon', 'public.my_pending__pre0292()', 'execute'));

  -- 03-05 admin / sales see their studio's events; nothing from the other studio
  j := pg_temp.mp(pg_temp.cl('a_admin@a.test'));
  perform pg_temp.res('03 admin: upcoming has the studio event, unread 0, no error',
    not (j ? 'error') and pg_temp.has(j, 'A-0001') and (j ->> 'unread')::int = 0 and not (j ? 'degraded'), j::text);
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  perform pg_temp.res('04 sales (quotes view): same studio event, open / done task counts present',
    not (j ? 'error') and pg_temp.has(j, 'A-0001') and j -> 'upcoming' -> 0 ? 'open_tasks'
    and j -> 'upcoming' -> 0 ? 'done_tasks' and jsonb_array_length(j -> 'upcoming') <= 25, j::text);
  perform pg_temp.res('05 org scoping: studio A never sees studio B events',
    not exists (select 1 from jsonb_array_elements(j -> 'upcoming') e where e ->> 'code' = 'B-0001'), j::text);

  -- 06 unread + a switched-off type + a security row, identical to the old body (an admin may see 3 or 4: suites that re-apply 0036 drop the 0250 wrapper)
  perform pg_temp.notes(orgA, 2, 'payment');
  perform pg_temp.notes(orgA, 1, 'security_alert');
  perform pg_temp.notes(orgA, 1, 'chat_message');
  insert into public.notification_prefs(org_id, user_id, role, type, channel, enabled)
    values (orgA, a_staff, '*', 'chat_message', 'in_app', false);
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  perform pg_temp.res('06 unread counts new rows minus switched-off types and security alerts (2)',
    (j ->> 'unread')::int = 2, j::text);
  k := pg_temp.mp(pg_temp.cl('a_staff@a.test'), 'my_pending__pre0292');
  perform pg_temp.res('07 same answer as the previous body (upcoming + unread)',
    pg_temp.same(j, k), j::text || ' vs ' || k::text);
  set local track_functions = 'all';
  j := pg_temp.mp(pg_temp.cl('a_admin@a.test'));
  c0 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  k := pg_temp.mp(pg_temp.cl('a_admin@a.test'), 'my_pending__pre0292');
  c1 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  -- the production 500: the old body works the hidden types out again for EVERY unread row (here 4 rows)
  perform pg_temp.res('24 root cause: the previous body worked the hidden types out once per unread row',
    c1 - c0 >= 4, 'calls=' || (c1 - c0));
  perform pg_temp.res('08 same answer as the previous body for an admin',
    pg_temp.same(j, k) and (j ->> 'unread')::int >= 3, j::text || ' vs ' || k::text);

  -- 09 opening the bell clears the count
  update public.notification_seen set last_seen_at = now() + interval '1 minute' where user_id = a_staff;
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  perform pg_temp.res('09 after the bell was opened: unread 0, events still listed',
    (j ->> 'unread')::int = 0 and pg_temp.has(j, 'A-0001'), j::text);
  update public.notification_seen set last_seen_at = now() where user_id = a_staff;

  -- 10-15 empty / unauthorised states answer an empty result, never an error
  perform pg_temp.res('10 signed out (no token): empty answer', pg_temp.empty(pg_temp.mp('{}'::jsonb)));
  perform pg_temp.res('11 anon token: empty answer', pg_temp.empty(pg_temp.mp('{"role":"anon"}'::jsonb)));
  j := pg_temp.mp('{"sub":"not-a-uuid","role":"authenticated"}'::jsonb);
  perform pg_temp.res('12 malformed token subject: empty answer, not 22P02', pg_temp.empty(j), j::text);
  perform pg_temp.res('13 unknown user: empty answer',
    pg_temp.empty(pg_temp.mp(jsonb_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated'))));
  insert into auth.mfa_factors(id, user_id, status, factor_type) values (gen_random_uuid(), a_staff, 'verified', 'totp');
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  perform pg_temp.res('14 two-step member at aal1 (no studio yet): empty answer', pg_temp.empty(j), j::text);
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test', '{"aal":"aal2"}'::jsonb));
  perform pg_temp.res('15 same member at aal2: full answer', pg_temp.has(j, 'A-0001') and (j ->> 'unread')::int = 2, j::text);
  delete from auth.mfa_factors where user_id = a_staff;

  -- 16 deactivated member (0283): empty answer
  insert into public.team_member_status(user_id, org_id, status, deactivated_at) values (a_staff, orgA, 'deactivated', now());
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  perform pg_temp.res('16 deactivated member: empty answer', pg_temp.empty(j), j::text);
  update public.team_member_status set status = 'active' where user_id = a_staff and org_id = orgA;

  -- 17 no studio on the profile: empty answer
  update public.profiles set org_id = null where id = b_staff;
  j := pg_temp.mp(pg_temp.cl('b_staff@b.test'));
  perform pg_temp.res('17 profile without a studio: empty answer', pg_temp.empty(j), j::text);
  update public.profiles set org_id = orgB where id = b_staff;

  -- 18 crew (no quotes view): no events, unread still counted (as before), no error
  update public.profiles set role = 'crew' where id = b_staff;
  perform pg_temp.notes(orgB, 2, 'payment');
  j := pg_temp.mp(pg_temp.cl('b_staff@b.test'));
  k := pg_temp.mp(pg_temp.cl('b_staff@b.test'), 'my_pending__pre0292');
  perform pg_temp.res('18 crew: no events, unread by the crew role''s settings, same as the previous body',
    not (j ? 'error') and j -> 'upcoming' = '[]'::jsonb and pg_temp.same(j, k), j::text || ' vs ' || k::text);
  update public.profiles set role = 'sales' where id = b_staff;

  -- 19 ended trial (read-only studio): still answers, no error
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = orgA;
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = orgA;
  j := pg_temp.mp(pg_temp.cl('a_admin@a.test'));
  perform pg_temp.res('19 ended trial / read-only studio: answers, no error',
    not (j ? 'error') and pg_temp.has(j, 'A-0001'), j::text);

  -- 20 SPEED: the hidden types are worked out ONCE per call, whatever the number of unread rows
  perform pg_temp.notes(orgA, 2000, 'task_assigned');
  c0 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  t0 := clock_timestamp();
  j := pg_temp.mp(pg_temp.cl('a_staff@a.test'));
  ms := extract(epoch from clock_timestamp() - t0) * 1000;
  c1 := coalesce(pg_stat_get_xact_function_calls('public._notify_hidden_types(uuid,uuid)'::regprocedure), 0);
  perform pg_temp.res('20 2,000+ unread: hidden types worked out once (was once per row), right count',
    c1 - c0 = 1 and (j ->> 'unread')::int = 2002, 'calls=' || (c1 - c0) || ' ' || j::text);
  perform pg_temp.res('21 2,000+ unread answers well inside the 8 s API limit',
    ms < 6000, round(ms) || ' ms');

  -- 22 a failing part degrades to empty / 0 with "degraded", never a 500 (the rename is undone right after)
  begin
    alter table public.notification_seen rename to notification_seen_r47;
    j := pg_temp.mp(pg_temp.cl('a_admin@a.test'));
    raise exception 'r47-undo';
  exception when others then
    if sqlerrm <> 'r47-undo' then j := jsonb_build_object('error', sqlstate, 'message', sqlerrm); end if;
  end;
  perform pg_temp.res('22 unread part fails (42P01): unread 0 + degraded, events still listed, no error',
    not (j ? 'error') and (j ->> 'unread')::int = 0 and (j ->> 'degraded')::boolean and pg_temp.has(j, 'A-0001'), j::text);
  perform pg_temp.res('23 the table rename above was undone', to_regclass('public.notification_seen') is not null);
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R47-MY-PENDING-0292: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R47-MY-PENDING-0292: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
