-- =========================================================================
-- Phase 37 — Cluster C3: task dependencies + time triggers
--
-- Meeting: tasks don't all run in parallel. e.g. carpet laying can't start until
-- the stage is completed AND approved; cleaning must follow foundational work; and
-- dependent tasks should trigger at set times (10:00 AM / 10:00 PM).
--
--   • event_tasks already has depends_on + planned_end; add planned_start +
--     triggered_at.
--   • set_task_schedule() sets a task's start/end time and its prerequisite.
--   • A task is BLOCKED until its prerequisite is completed AND QC-passed, and
--     SCHEDULED until its planned_start time (the app computes this per task).
--   • run_task_triggers() is the periodic job: for each scheduled task whose time
--     has arrived and whose prerequisite is satisfied, it notifies the assignee
--     (outbox) and stamps triggered_at. Live auto-firing = a pg_cron schedule
--     (deferred, like the other channels); until then it queues 'simulated'.
--
-- RUN AFTER phase35 (verify_status) + operations.sql. Idempotent.
-- =========================================================================

alter table public.event_tasks add column if not exists planned_start timestamptz;
alter table public.event_tasks add column if not exists triggered_at  timestamptz;

-- set a task's schedule + prerequisite -------------------------------------
create or replace function public.set_task_schedule(
  p_id uuid, p_start timestamptz, p_end timestamptz, p_depends uuid)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if p_depends = p_id then raise exception 'a task cannot depend on itself'; end if;
  update public.event_tasks
     set planned_start = p_start,
         planned_end   = coalesce(p_end, planned_end),
         depends_on    = p_depends,
         triggered_at  = null            -- re-arm the trigger when rescheduled
   where id = p_id
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
revoke all on function public.set_task_schedule(uuid,timestamptz,timestamptz,uuid) from anon;
grant execute on function public.set_task_schedule(uuid,timestamptz,timestamptz,uuid) to authenticated;

-- the periodic trigger job: fire scheduled tasks whose time has come --------
-- (a prerequisite counts as satisfied when it is completed AND QC-passed)
create or replace function public.run_task_triggers(p_quote uuid default null)
  returns int language plpgsql security definer set search_path = public as $$
declare t record; dep public.event_tasks; cnt int := 0; ok boolean;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where (p_quote is null or quote_id = p_quote)
      and status in ('assigned','accepted')
      and planned_start is not null and planned_start <= now()
      and triggered_at is null
  loop
    ok := true;
    if t.depends_on is not null then
      select * into dep from public.event_tasks where id = t.depends_on;
      ok := found and dep.status = 'completed' and dep.verify_status = 'passed';
    end if;
    if ok then
      perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_due',
        jsonb_build_object('task', t.title, 'category', t.category));
      update public.event_tasks set triggered_at = now() where id = t.id;
      cnt := cnt + 1;
    end if;
  end loop;
  return cnt;
end $$;
revoke all on function public.run_task_triggers(uuid) from anon;
grant execute on function public.run_task_triggers(uuid) to authenticated;

notify pgrst, 'reload schema';

-- =========================================================================
-- GO-LIVE (deferred): fire dependent tasks automatically, e.g. every 5 min:
--   select cron.schedule('task-triggers','*/5 * * * *', $$ select public.run_task_triggers(); $$);
-- Until then, use the "Fire due tasks" button on the Operations page.
-- =========================================================================
