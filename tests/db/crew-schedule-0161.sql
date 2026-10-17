-- crew-schedule-0161.sql - 0161: crew_schedule(p_from, p_to, p_staff) read RPC.
-- Proves: crew see only their own assignments (p_staff cannot widen it), an admin sees every crew
-- member in their own org and can pick one, nothing crosses orgs, cancelled tasks are hidden, the
-- event date is used when a task has no start time, range guard, anon refused, no money/client fields.
-- Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _c161; create temp table _c161(name text, result text); grant all on _c161 to anon, authenticated;
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
  insert into _c161 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

-- setup (superuser): two crew logins in org A, one crew row in org B, tasks on the fixture quotes
do $$ declare
  orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
  qA uuid := 'a0000000-0000-4000-8000-00000000da01'; qB uuid := 'b0000000-0000-4000-8000-00000000da01';
  u1 uuid; u2 uuid;
begin
  execute 'reset role';
  select id into u1 from auth.users where email = 'c161_one@a.test'; if u1 is null then u1 := auth.seed_user('c161_one@a.test'); end if;
  select id into u2 from auth.users where email = 'c161_two@a.test'; if u2 is null then u2 := auth.seed_user('c161_two@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values
    (u1, 'c161_one@a.test', 'crew', orgA, false, now()), (u2, 'c161_two@a.test', 'crew', orgA, false, now())
  on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at)
    values ('crew', 'calendar', true, false, orgA, now())
  on conflict (role, area, org_id) do update set can_view = true;
  update public.quotes set event_date = date '2026-11-10', event_time = '18:00' where id in (qA, qB);
  insert into public.crew_members(id, name, phone, role, org_id, profile_id) values
    ('a0000000-0000-4000-8000-0000000c1611', 'C161 One', '+910000001611', 'Captain', orgA, u1),
    ('a0000000-0000-4000-8000-0000000c1612', 'C161 Two', '+910000001612', 'Waiter', orgA, u2),
    ('b0000000-0000-4000-8000-0000000c1613', 'C161 Bee', '+910000001613', 'Chef', orgB, null)
  on conflict (id) do nothing;
  delete from public.event_tasks where id::text like '%c16100%';
  insert into public.event_tasks(id, quote_id, category, title, crew_id, status, planned_start, planned_end, org_id) values
    ('a0000000-0000-4000-8000-00000c161001', qA, 'service', 'Captain shift', 'a0000000-0000-4000-8000-0000000c1611', 'assigned', '2026-11-10 12:30+00', '2026-11-10 18:30+00', orgA),
    ('a0000000-0000-4000-8000-00000c161002', qA, 'service', 'Setup (no time)', 'a0000000-0000-4000-8000-0000000c1611', 'accepted', null, null, orgA),
    ('a0000000-0000-4000-8000-00000c161003', qA, 'service', 'Cancelled shift', 'a0000000-0000-4000-8000-0000000c1611', 'cancelled', '2026-11-10 10:00+00', null, orgA),
    ('a0000000-0000-4000-8000-00000c161004', qA, 'service', 'Waiter shift', 'a0000000-0000-4000-8000-0000000c1612', 'assigned', '2026-11-10 13:00+00', '2026-11-10 19:00+00', orgA),
    ('b0000000-0000-4000-8000-00000c161005', qB, 'kitchen', 'Chef shift', 'b0000000-0000-4000-8000-0000000c1613', 'assigned', '2026-11-10 11:00+00', null, orgB);
end $$;

do $$ declare r text; begin
  r := pg_temp.as_try('c161_one@a.test', $q$select string_agg(task_title, '|' order by task_title) from public.crew_schedule('2026-11-01', '2026-11-30')$q$);
  perform pg_temp.t('crew: sees only own, non-cancelled tasks', r = 'ok:Captain shift|Setup (no time)', r);
  r := pg_temp.as_try('c161_one@a.test', $q$select count(*)::text from public.crew_schedule('2026-11-01', '2026-11-30', 'a0000000-0000-4000-8000-0000000c1612')$q$);
  perform pg_temp.t('crew: p_staff of a teammate returns nothing', r = 'ok:0', r);
  r := pg_temp.as_try('c161_one@a.test', $q$select sched_date::text from public.crew_schedule('2026-11-01', '2026-11-30') where task_title = 'Setup (no time)'$q$);
  perform pg_temp.t('crew: task without start uses the event date', r = 'ok:2026-11-10', r);
  r := pg_temp.as_try('c161_one@a.test', $q$select event_code || '/' || event_time || '/' || crew_role from public.crew_schedule('2026-11-01', '2026-11-30') limit 1$q$);
  perform pg_temp.t('crew: event code, time and role returned', r = 'ok:A-0001/18:00/Captain', r);
  r := pg_temp.as_try('c161_one@a.test', $q$select count(*)::text from public.crew_schedule('2026-12-01', '2026-12-31')$q$);
  perform pg_temp.t('crew: outside the range returns nothing', r = 'ok:0', r);

  r := pg_temp.as_try('a_admin@a.test', $q$select string_agg(task_title, '|' order by task_title) from public.crew_schedule('2026-11-01', '2026-11-30')$q$);
  perform pg_temp.t('admin: sees every crew member in own org only', r = 'ok:Captain shift|Setup (no time)|Waiter shift', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select string_agg(task_title, '|') from public.crew_schedule('2026-11-01', '2026-11-30', 'a0000000-0000-4000-8000-0000000c1612')$q$);
  perform pg_temp.t('admin: can pick one crew member', r = 'ok:Waiter shift', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select count(*)::text from public.crew_schedule('2026-11-01', '2026-11-30', 'b0000000-0000-4000-8000-0000000c1613')$q$);
  perform pg_temp.t('admin: other-org crew id returns nothing', r = 'ok:0', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select string_agg(task_title, '|') from public.crew_schedule('2026-11-01', '2026-11-30')$q$);
  perform pg_temp.t('org B admin: sees only org B', r = 'ok:Chef shift', r);

  r := pg_temp.as_try('a_admin@a.test', $q$select count(*)::text from public.crew_schedule('2026-01-01', '2026-12-31')$q$);
  perform pg_temp.t('range over 62 days refused', r like 'err:22023:%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select count(*)::text from public.crew_schedule('2026-11-30', '2026-11-01')$q$);
  perform pg_temp.t('reversed range refused', r like 'err:22023:%', r);
  r := pg_temp.as_try('anon', $q$select count(*)::text from public.crew_schedule('2026-11-01', '2026-11-30')$q$);
  perform pg_temp.t('anon refused', r like 'err:%', r);

  perform pg_temp.t('no money / client columns in the result',
    not exists (select 1 from unnest((select p.proargnames from pg_proc p where p.oid = to_regprocedure('public.crew_schedule(date, date, uuid)'))) a
                 where a ~* '(price|total|amount|pricing|client|phone|email|contact|rate)'), null);
  perform pg_temp.t('grants: authenticated yes, anon no',
    has_function_privilege('authenticated', 'public.crew_schedule(date, date, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.crew_schedule(date, date, uuid)', 'execute'), null);
end $$;

-- cleanup (disposable DB): remove only what this file created
do $$ begin
  execute 'reset role';
  delete from public.event_tasks where id::text like '%c16100%';
  delete from public.crew_members where id::text like '%0c161%';
end $$;

select case when count(*) filter (where result <> 'PASS') = 0
            then 'CREW-SCHEDULE-0161: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'CREW-SCHEDULE-0161: FAIL' end as summary from _c161;
select name, result from _c161 where result <> 'PASS';
