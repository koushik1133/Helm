-- APPLY-0153.sql - paste into the Supabase SQL editor (staging first, then prod).
-- Additive + idempotent: re-creates/creates functions, keeps the old bell_feed as bell_feed__pre0153. No rows change. Safe to run twice.
begin;
-- 0153_crew_fixes.sql - CANONICAL forward-only.
-- REQUIRES 0009 (my_tasks) + 0041 (crew_members.profile_id) + 0077 (bell_feed wrapper chain).
--
-- In plain words - crew QA 2026-10-20:
--   1. The bell feed showed quote money (new_total / approved_total on "reapproval required")
--      to crew. For anyone who cannot view quotes, money-type bell items are now dropped and
--      money fields are removed from every other item. A garbled em dash in old messages is
--      shown as a plain hyphen.
--   2. my_tasks found the crew member by e-mail only. It now also uses the real link
--      (crew_members.profile_id), and a task with only a start time is bucketed by that time
--      (so a task starting today shows under Today).
--   3. Crew could not open their own event. New crew_event_brief(quote) returns only the event
--      code, title, date, time and the caller's OWN tasks - and only when the caller is
--      assigned a task on that event. No client name, phone, e-mail or price.
--   4. New crew_task_respond(task, action) lets a signed-in crew member accept / reject /
--      start / complete their OWN task (same rules as the worker link).
--
-- ZERO DATA LOSS: CREATE OR REPLACE of functions, one function rename (kept as
-- bell_feed__pre0153). No table, column, row or policy is removed or changed. ASCII only.
-- Safe to run twice.

do $$ begin
  if to_regprocedure('public.bell_feed(integer)') is null then raise exception 'STOP: apply 0077 first'; end if;
  if to_regprocedure('public.my_tasks()') is null then raise exception 'STOP: apply 0009 first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'crew_members' and column_name = 'profile_id') then
    raise exception 'STOP: apply 0041 first'; end if;
end $$;

-- ---- helper: the caller's crew_members ids (profile link first, then e-mail) -------------
create or replace function public._a153_my_crew_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select cm.id from public.crew_members cm
   where cm.org_id = public.current_org_id() and auth.uid() is not null
     and (cm.profile_id = auth.uid()
          or (cm.email is not null and btrim(cm.email) <> ''
              and lower(cm.email) = (select lower(p.email) from public.profiles p where p.id = auth.uid())))
$$;
revoke all on function public._a153_my_crew_ids() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._a153_my_crew_ids() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._a153_my_crew_ids() from authenticated'; end if;
end $$;

-- ---- 1) bell feed: no money for callers who cannot view quotes ----------------------------
do $$ begin
  if to_regprocedure('public.bell_feed__pre0153(integer)') is null
     and position('crew-money-0153' in (select p.prosrc from pg_proc p where p.oid = 'public.bell_feed(integer)'::regprocedure)) = 0 then
    alter function public.bell_feed(integer) rename to bell_feed__pre0153;
  end if;
  if to_regprocedure('public.bell_feed__pre0153(integer)') is not null then
    revoke all on function public.bell_feed__pre0153(integer) from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.bell_feed__pre0153(integer) from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.bell_feed__pre0153(integer) from authenticated'; end if;
  end if;
end $$;

create or replace function public._a153_money_key(k text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(lower(k), '') ~ '(^|_)(total|totals|amount|amounts|price|prices|paid|balance|subtotal|cost|costs|fee|fees|refund|credit|discount|tax|invoice|budget|rate|owed|money|margin|profit)(_|$)'
$$;

create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- crew-money-0153: money kinds / fields only for quote viewers; mojibake dash cleaned
declare v jsonb; v_drop integer; v_bad text := chr(8218) || chr(196) || chr(238);
begin
  v := public.bell_feed__pre0153(p_limit);
  if v is null then return v; end if;
  if position(v_bad in v::text) > 0 then v := replace(v::text, v_bad, '-')::jsonb; end if;
  if public.has_area('quotes', 'view') or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  select count(*) into v_drop from jsonb_array_elements(v -> 'items') e(i)
   where coalesce(e.i ->> 'kind', '') ~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)'
     and coalesce((e.i ->> 'unread')::boolean, false);
  return v || jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(case when jsonb_typeof(e.i -> 'detail') = 'object'
                            then e.i || jsonb_build_object('detail', coalesce((
                                   select jsonb_object_agg(d.key, d.value) from jsonb_each(e.i -> 'detail') d(key, value)
                                    where not public._a153_money_key(d.key)
                                      and not (d.key = 'message' and coalesce(d.value #>> '{}', '') ~* '(price|total|amount|paid|rs\.|inr)')), '{}'::jsonb))
                            else e.i end order by e.ord)
        from jsonb_array_elements(v -> 'items') with ordinality e(i, ord)
       where coalesce(e.i ->> 'kind', '') !~ '(price|reapproval|payment|refund|invoice|bill|settle|pkg_pay|quote_|discount|budget)'), '[]'::jsonb),
    'unread', greatest(coalesce((v ->> 'unread')::integer, 0) - v_drop, 0));
end $$;
revoke all on function public.bell_feed(integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.bell_feed(integer) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.bell_feed(integer) to authenticated'; end if;
end $$;

-- ---- 2) my_tasks: profile link + start-time bucketing --------------------------------------
create or replace function public.my_tasks()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- crew-1020-0153
  with mine as (
    select t.id, t.quote_id, t.title, t.category, t.status, t.note,
           t.planned_start, t.planned_end, t.completed_at, t.depends_on,
           t.verify_status, q.code as event_code, q.title as event_title,
           coalesce(t.planned_end, t.planned_start) as due_at,
           (t.completed_at is not null or t.status = 'completed') as is_done,
           (t.depends_on is not null and exists (
              select 1 from public.event_tasks d where d.id = t.depends_on and d.completed_at is null)) as is_blocked
      from public.event_tasks t
      join public.quotes q on q.id = t.quote_id
     where t.org_id = public.current_org_id()
       and t.crew_id in (select public._a153_my_crew_ids())
       and coalesce(t.status, '') not in ('cancelled')
  ),
  tagged as (
    select m.*,
      case
        when m.is_done then 'completed'
        when m.is_blocked then 'blocked'
        when m.due_at is not null and m.due_at < date_trunc('day', now()) then 'overdue'
        when m.due_at is not null and m.due_at < date_trunc('day', now()) + interval '1 day' then 'today'
        else 'upcoming'
      end as bucket
    from mine m
  )
  select jsonb_build_object(
    'today',     coalesce((select jsonb_agg(to_jsonb(t) - 'due_at' order by t.due_at nulls last) from tagged t where t.bucket='today'), '[]'::jsonb),
    'overdue',   coalesce((select jsonb_agg(to_jsonb(t) - 'due_at' order by t.due_at) from tagged t where t.bucket='overdue'), '[]'::jsonb),
    'blocked',   coalesce((select jsonb_agg(to_jsonb(t) - 'due_at' order by t.due_at nulls last) from tagged t where t.bucket='blocked'), '[]'::jsonb),
    'upcoming',  coalesce((select jsonb_agg(to_jsonb(t) - 'due_at' order by t.due_at nulls last) from tagged t where t.bucket='upcoming'), '[]'::jsonb),
    'completed', coalesce((select jsonb_agg(to_jsonb(t) - 'due_at' order by t.completed_at desc nulls last) from tagged t where t.bucket='completed'), '[]'::jsonb),
    'counts', jsonb_build_object(
      'today',     (select count(*) from tagged where bucket='today'),
      'overdue',   (select count(*) from tagged where bucket='overdue'),
      'blocked',   (select count(*) from tagged where bucket='blocked'),
      'upcoming',  (select count(*) from tagged where bucket='upcoming'),
      'completed', (select count(*) from tagged where bucket='completed')),
    'as_of', now())
$$;
revoke all on function public.my_tasks() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_tasks() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_tasks() to authenticated'; end if;
end $$;

-- ---- 3) crew_event_brief: safe event header + my own tasks ---------------------------------
create or replace function public.crew_event_brief(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- crew-1020-0153: no client / money fields, ever
declare v_org uuid := public.current_org_id(); q record; v_tasks jsonb;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.code, x.title, x.event_date, to_jsonb(x) ->> 'event_time' as event_time
    into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null or not exists (select 1 from public.event_tasks t where t.quote_id = p_quote
        and t.crew_id in (select public._a153_my_crew_ids())) then
    raise exception 'event not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'category', t.category,
           'status', t.status, 'planned_start', t.planned_start, 'planned_end', t.planned_end, 'note', t.note)
           order by t.category, t.seq), '[]'::jsonb)
    into v_tasks from public.event_tasks t
   where t.quote_id = p_quote and t.crew_id in (select public._a153_my_crew_ids());
  return jsonb_build_object('id', q.id, 'code', q.code, 'title', q.title, 'event_date', q.event_date,
                            'event_time', q.event_time, 'tasks', v_tasks);
end $$;
revoke all on function public.crew_event_brief(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.crew_event_brief(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.crew_event_brief(uuid) to authenticated'; end if;
end $$;

-- ---- 4) crew_task_respond: act on MY task (same rules as worker_respond) --------------------
create or replace function public.crew_task_respond(p_task uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- crew-1020-0153
declare tsk record; newst text;
begin
  if auth.uid() is null or public.current_org_id() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select t.id, t.quote_id, t.title, t.status into tsk from public.event_tasks t
   where t.id = p_task and t.org_id = public.current_org_id()
     and t.crew_id in (select public._a153_my_crew_ids());
  if tsk.id is null then raise exception 'task not found' using errcode = 'P0002'; end if;
  newst := case p_action when 'accept' then 'accepted' when 'reject' then 'rejected'
                         when 'start' then 'in_progress' when 'complete' then 'completed' else null end;
  if newst is null then raise exception 'invalid action' using errcode = '22023'; end if;
  if tsk.status in ('completed', 'cancelled') then raise exception 'this task is already closed' using errcode = '22023'; end if;
  if p_action in ('accept', 'reject') and tsk.status not in ('assigned', 'accepted', 'rejected') then
    raise exception 'this task has already started' using errcode = '22023'; end if;
  if p_action = 'start' and tsk.status not in ('accepted', 'assigned') then raise exception 'accept the task first' using errcode = '22023'; end if;
  if p_action = 'complete' and tsk.status not in ('in_progress', 'accepted') then raise exception 'start the task first' using errcode = '22023'; end if;
  update public.event_tasks set status = newst,
    responded_at = case when p_action in ('accept', 'reject') then now() else responded_at end,
    started_at   = case when p_action = 'start' then now() else started_at end,
    completed_at = case when p_action = 'complete' then now() else completed_at end
   where id = tsk.id;
  return jsonb_build_object('ok', true, 'status', newst);
end $$;
revoke all on function public.crew_task_respond(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.crew_task_respond(uuid, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.crew_task_respond(uuid, text) to authenticated'; end if;
end $$;
commit;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 bell_feed wrapper 0153', position('crew-money-0153' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.bell_feed(integer)'))) > 0),
  ('02 bell_feed previous body kept', to_regprocedure('public.bell_feed__pre0153(integer)') is not null),
  ('03 money key filter', public._a153_money_key('new_total') and public._a153_money_key('approved_total') and not public._a153_money_key('created_at') and not public._a153_money_key('feedback')),
  ('04 my_tasks uses profile link', position('_a153_my_crew_ids' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.my_tasks()'))) > 0),
  ('05 crew_event_brief callable', has_function_privilege('authenticated', 'public.crew_event_brief(uuid)', 'execute')),
  ('06 crew_task_respond callable', has_function_privilege('authenticated', 'public.crew_task_respond(uuid, text)', 'execute')),
  ('07 helpers closed', not has_function_privilege('authenticated', 'public._a153_my_crew_ids()', 'execute')
       and not has_function_privilege('authenticated', 'public.bell_feed__pre0153(integer)', 'execute')),
  ('08 anon cannot call crew rpcs', not has_function_privilege('anon', 'public.crew_task_respond(uuid, text)', 'execute'))
) v(item, ok) order by item;
