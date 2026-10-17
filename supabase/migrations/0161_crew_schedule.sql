-- 0161_crew_schedule.sql
-- Crew schedule calendar (Week / Month / Team week grid).
--
-- Crew cannot read quotes (no quotes RLS for them), so the calendar and run-sheet
-- had no event data for them. This adds ONE read-only SECURITY DEFINER RPC that
-- returns schedule fields only - which event, date, start/end time, venue name,
-- the crew member's role and their assigned shift/task - and never any money,
-- pricing, client name, client phone/email or venue contact.
--
-- Assignment model (schema-confirmed, see 0153): event_tasks.crew_id -> crew_members.id;
-- a login is linked to a crew row by crew_members.profile_id (or matching email),
-- resolved by the existing private helper public._a153_my_crew_ids().
--
-- Who sees what (org-scoped by current_org_id() in every branch):
--   * anyone signed in: their own assignments only
--   * has_area('staff','view') or has_area('calendar','view') AND not crew-only:
--     any crew member in the caller's org (optionally one, via p_staff)
--   Crew have calendar view (0143) but are crew-linked; a caller whose role is
--   'crew' is always limited to their own rows, whatever p_staff says.
--
-- Additive + idempotent: create or replace function, grants only. No table, no
-- column, no row is created, changed or removed. Range capped at 62 days.

create or replace function public.crew_schedule(p_from date, p_to date, p_staff uuid default null)
returns table (
  crew_id uuid, crew_name text, crew_role text, department text,
  quote_id uuid, event_code text, event_title text, event_date date, event_time text,
  venue_name text, task_id uuid, task_title text, category text, status text,
  planned_start timestamptz, planned_end timestamptz, sched_date date
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
-- crew-schedule-0161: schedule fields only, no client / money fields, ever
declare
  v_org uuid := public.current_org_id();
  v_role text;
  v_team boolean := false;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'invalid date range' using errcode = '22023'; end if;
  if p_to - p_from > 62 then raise exception 'date range too long (max 62 days)' using errcode = '22023'; end if;
  select lower(coalesce(pr.role, '')) into v_role from public.profiles pr where pr.id = auth.uid();
  v_team := coalesce(v_role, '') not in ('crew', 'worker')
            and (public.has_area('staff', 'view') or public.has_area('calendar', 'view'));
  return query
    select cm.id, cm.name, cm.role, cm.department,
           q.id, q.code, q.title, q.event_date, q.event_time,
           ep.venue_name, t.id, t.title, t.category, t.status,
           t.planned_start, t.planned_end,
           coalesce((t.planned_start at time zone 'UTC')::date, q.event_date) as sched_date
      from public.event_tasks t
      join public.crew_members cm on cm.id = t.crew_id and cm.org_id = v_org
      join public.quotes q on q.id = t.quote_id and q.org_id = v_org
      left join public.event_plan ep on ep.quote_id = q.id and ep.org_id = v_org
     where t.org_id = v_org
       and coalesce(t.status, '') <> 'cancelled'
       and coalesce(q.status, '') not in ('cancelled', 'lost')
       and coalesce((t.planned_start at time zone 'UTC')::date, q.event_date) between p_from and p_to
       and (case when v_team then (p_staff is null or t.crew_id = p_staff)
                 else t.crew_id in (select public._a153_my_crew_ids())
                      and (p_staff is null or t.crew_id = p_staff) end)
     order by 17, t.planned_start nulls last, cm.name, t.seq;
end $$;

revoke all on function public.crew_schedule(date, date, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.crew_schedule(date, date, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.crew_schedule(date, date, uuid) to authenticated'; end if;
end $$;

-- VERIFY
select item, ok from (values
  ('01 crew_schedule exists', to_regprocedure('public.crew_schedule(date, date, uuid)') is not null),
  ('02 security definer', coalesce((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.crew_schedule(date, date, uuid)')), false)),
  ('03 search_path pinned', coalesce((select array_to_string(p.proconfig, ',') like '%search_path=%' from pg_proc p where p.oid = to_regprocedure('public.crew_schedule(date, date, uuid)')), false)),
  ('04 authenticated can execute', has_function_privilege('authenticated', 'public.crew_schedule(date, date, uuid)', 'execute')),
  ('05 anon cannot execute', not has_function_privilege('anon', 'public.crew_schedule(date, date, uuid)', 'execute')),
  ('06 org scoped', position('current_org_id' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.crew_schedule(date, date, uuid)'))) > 0),
  ('07 own-rows helper used', position('_a153_my_crew_ids' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.crew_schedule(date, date, uuid)'))) > 0)
) v(item, ok) order by item;
