-- =====================================================================
-- BUILD 3 — my_tasks(): personal task list bucketed TODAY / OVERDUE / BLOCKED / COMPLETED
-- =====================================================================
-- Returns, for the CALLER, the event_tasks assigned to THEM, pre-bucketed.
--
-- Assignment model (schema-confirmed): event_tasks.crew_id -> crew_members.id.
-- A logged-in user is linked to a crew_member by EMAIL within their org
-- (crew_members.email = profiles.email where profiles.id = auth.uid()).
-- There is no assigned_to=auth.uid() column, so the uid->crew join lives here.
-- A user with no matching crew row simply gets empty buckets (expected, not a bug).
--
-- Buckets (precedence: completed > blocked > overdue > today > upcoming):
--   completed : completed_at is not null
--   blocked   : open AND depends_on points at a task that is not completed
--   overdue   : open, not blocked, planned_end < start-of-today
--   today     : open, not blocked, planned_end within today
--   upcoming  : open, not blocked, planned_end in the future or null
--
-- SECURITY DEFINER but SAFE: results are inherently personal (crew_id = the
-- caller's own crew id) and org-scoped (org_id = current_org_id()). auth.uid()
-- and current_org_id() read the request JWT, so identity is honored under definer.
-- Additive, idempotent (create or replace). Revoked from anon.
-- =====================================================================

create or replace function public.my_tasks()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid, public.current_org_id() as org
  ),
  my_crew as (
    select cm.id
    from public.crew_members cm
    join public.profiles p on lower(cm.email) = lower(p.email)
    cross join me
    where p.id = me.uid
      and cm.org_id = me.org
      and cm.email is not null
    limit 1
  ),
  mine as (
    select t.id, t.quote_id, t.title, t.category, t.status, t.note,
           t.planned_start, t.planned_end, t.completed_at, t.depends_on,
           t.verify_status, q.code as event_code, q.title as event_title,
           (t.completed_at is not null) as is_done,
           (t.depends_on is not null and exists (
              select 1 from public.event_tasks d
              where d.id = t.depends_on and d.completed_at is null
           )) as is_blocked
    from public.event_tasks t
    join public.quotes q on q.id = t.quote_id
    cross join me
    where t.org_id = me.org
      and t.crew_id in (select id from my_crew)
  ),
  tagged as (
    select m.*,
      case
        when m.is_done then 'completed'
        when m.is_blocked then 'blocked'
        when m.planned_end is not null and m.planned_end < date_trunc('day', now()) then 'overdue'
        when m.planned_end is not null and m.planned_end < date_trunc('day', now()) + interval '1 day' then 'today'
        else 'upcoming'
      end as bucket
    from mine m
  )
  select jsonb_build_object(
    'today',     coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='today'), '[]'::jsonb),
    'overdue',   coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end) from tagged t where t.bucket='overdue'), '[]'::jsonb),
    'blocked',   coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='blocked'), '[]'::jsonb),
    'upcoming',  coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='upcoming'), '[]'::jsonb),
    'completed', coalesce((select jsonb_agg(to_jsonb(t) order by t.completed_at desc) from tagged t where t.bucket='completed'), '[]'::jsonb),
    'counts',    jsonb_build_object(
        'today',     (select count(*) from tagged where bucket='today'),
        'overdue',   (select count(*) from tagged where bucket='overdue'),
        'blocked',   (select count(*) from tagged where bucket='blocked'),
        'upcoming',  (select count(*) from tagged where bucket='upcoming'),
        'completed', (select count(*) from tagged where bucket='completed')
    ),
    'as_of', now()
  );
$$;

revoke all on function public.my_tasks() from anon, public;
grant execute on function public.my_tasks() to authenticated;

-- Optional additive index for the crew_id + status hot path (safe, idempotent)
create index if not exists ix_event_tasks_crew_status on public.event_tasks (crew_id, status);

-- VERIFY
select 'my_tasks exists + authenticated can execute' as check,
       has_function_privilege('authenticated', 'public.my_tasks()', 'EXECUTE') as ok
union all
select 'anon CANNOT execute my_tasks (want ok=true)',
       not has_function_privilege('anon', 'public.my_tasks()', 'EXECUTE');
