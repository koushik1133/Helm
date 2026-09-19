-- =========================================================================
-- Phase 38 — Cluster C4: recurring alarm for special tasks
--
-- Meeting: some special/critical tasks need a reminder every few minutes until
-- they're marked complete.
--
--   • event_tasks gains is_special + remind_every_min + last_reminded_at.
--   • set_task_special(id, on, every_min) flags a task (default every 5 min).
--   • run_task_reminders() is the periodic job: for each special, not-yet-complete
--     task whose interval has elapsed, it queues a reminder to the assignee (outbox)
--     and stamps last_reminded_at. Live 5-minute firing = a pg_cron schedule
--     (deferred); until then use the "Remind due" button.
--
-- RUN AFTER operations.sql. Idempotent.
-- =========================================================================

alter table public.event_tasks add column if not exists is_special       boolean not null default false;
alter table public.event_tasks add column if not exists remind_every_min int not null default 5;
alter table public.event_tasks add column if not exists last_reminded_at  timestamptz;

-- flag / unflag a task as special (recurring reminder) ----------------------
create or replace function public.set_task_special(p_id uuid, p_on boolean, p_every_min int default 5)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  update public.event_tasks
     set is_special = coalesce(p_on,false),
         remind_every_min = greatest(coalesce(p_every_min,5), 1),
         last_reminded_at = case when coalesce(p_on,false) then last_reminded_at else null end
   where id = p_id
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
revoke all on function public.set_task_special(uuid,boolean,int) from anon;
grant execute on function public.set_task_special(uuid,boolean,int) to authenticated;

-- the periodic reminder job: nudge every special, incomplete task on interval -
create or replace function public.run_task_reminders(p_quote uuid default null)
  returns int language plpgsql security definer set search_path = public as $$
declare t record; cnt int := 0;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where (p_quote is null or quote_id = p_quote)
      and is_special = true
      and status not in ('completed','cancelled')
      and (last_reminded_at is null
           or last_reminded_at <= now() - make_interval(mins => greatest(remind_every_min,1)))
  loop
    perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_reminder',
      jsonb_build_object('task', t.title, 'category', t.category, 'every_min', t.remind_every_min));
    update public.event_tasks set last_reminded_at = now() where id = t.id;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;
revoke all on function public.run_task_reminders(uuid) from anon;
grant execute on function public.run_task_reminders(uuid) to authenticated;

notify pgrst, 'reload schema';

-- =========================================================================
-- GO-LIVE (deferred): remind on the special tasks' cadence every 5 minutes:
--   select cron.schedule('task-reminders','*/5 * * * *', $$ select public.run_task_reminders(); $$);
-- Until then, use the "🔔 Remind due" button on the Operations page.
-- =========================================================================
