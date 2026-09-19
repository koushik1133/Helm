-- =========================================================================
-- Phase 35 — Cluster C1: quality-engineer task verification (pass / reject)
--
-- Meeting: a quality engineer verifies completed tasks (e.g. stage setup) and
-- marks them PASSED or REJECTED. A reject sends the task back to the event
-- manager for revision. Tasks must pass before the event is finalized. (No photos.)
--
--   • event_tasks gains verify_status / verified_by / verified_at / verify_note.
--   • When a task is marked completed it auto-enters the QE queue (verify_status
--     = 'pending') via a trigger — no change to the worker/assign RPCs.
--   • verify_task(id, pass, note): quality/manager/planner/admin only. Pass →
--     'passed'. Reject → 'rejected' AND the task returns to 'in_progress'.
--   • task_verify_summary(quote): counts for readiness/closure gating.
--
-- RUN AFTER phase29 + operations.sql. Idempotent.
-- =========================================================================

alter table public.event_tasks add column if not exists verify_status text not null default 'unverified';
alter table public.event_tasks drop constraint if exists event_tasks_verify_status_check;
alter table public.event_tasks add constraint event_tasks_verify_status_check
  check (verify_status in ('unverified','pending','passed','rejected'));
alter table public.event_tasks add column if not exists verified_by uuid references auth.users(id);
alter table public.event_tasks add column if not exists verified_at timestamptz;
alter table public.event_tasks add column if not exists verify_note text;

-- a completed task automatically enters the QE queue (pending) --------------
create or replace function public.tg_task_verify() returns trigger
  language plpgsql set search_path = public as $$
begin
  if new.status = 'completed' and (old.status is distinct from 'completed')
     and new.verify_status = 'unverified' then
    new.verify_status := 'pending';
  end if;
  return new;
end $$;
drop trigger if exists task_verify_trg on public.event_tasks;
create trigger task_verify_trg before update on public.event_tasks
  for each row execute function public.tg_task_verify();

-- quality engineer (or manager/planner/admin) passes or rejects a task ------
create or replace function public.verify_task(p_id uuid, p_pass boolean, p_note text default null)
  returns public.event_tasks language plpgsql security definer set search_path = public as $$
declare row public.event_tasks;
begin
  if not (public.user_role() in ('admin','manager','planner','quality')) then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
  end if;
  update public.event_tasks set
    verify_status = case when p_pass then 'passed' else 'rejected' end,
    verified_by   = auth.uid(),
    verified_at   = now(),
    verify_note   = nullif(btrim(coalesce(p_note,'')),''),
    -- a reject bounces the task back to the event manager for rework
    status        = case when p_pass then status else 'in_progress' end,
    completed_at  = case when p_pass then completed_at else null end
  where id = p_id
  returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $$;
revoke all on function public.verify_task(uuid,boolean,text) from anon;
grant execute on function public.verify_task(uuid,boolean,text) to authenticated;

-- summary for readiness / closure ("all critical tasks passed?") -----------
create or replace function public.task_verify_summary(p_quote uuid)
  returns table(total int, completed int, pending int, passed int, rejected int)
  language sql stable security definer set search_path = public as $$
  select count(*)::int,
         count(*) filter (where status = 'completed')::int,
         count(*) filter (where verify_status = 'pending')::int,
         count(*) filter (where verify_status = 'passed')::int,
         count(*) filter (where verify_status = 'rejected')::int
  from public.event_tasks where quote_id = p_quote;
$$;
revoke all on function public.task_verify_summary(uuid) from anon;
grant execute on function public.task_verify_summary(uuid) to authenticated;

notify pgrst, 'reload schema';
