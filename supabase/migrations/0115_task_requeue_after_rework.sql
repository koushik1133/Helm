-- 0115_task_requeue_after_rework.sql - CANONICAL forward-only.
--
-- In plain words:
--   When quality REJECTS a task it goes back to the worker (status in_progress, verify_status
--   'rejected'). When the worker marks it done again, tg_task_verify only queued tasks that
--   were 'unverified', so the redone task stayed "QC rework" forever: no Pass/Reject buttons
--   on Operations, and the event Ready check (needs completed + passed) could never go green.
--   Fix: re-completing a 'rejected' task puts it back in the QC queue ('pending'). The
--   rejection note is kept as history. Nothing else changes.
--
--   Changes: 1 trigger function body replaced. No table / column / row / trigger / policy
--   changed or deleted. Additive + idempotent (create or replace). Safe to run twice.
--   Existing stuck rows are NOT touched (they re-queue the next time they are completed).

create or replace function public.tg_task_verify() returns trigger
  language plpgsql set search_path = public as $$
-- task-requeue-0115
begin
  if new.status = 'completed' and (old.status is distinct from 'completed')
     and new.verify_status in ('unverified', 'rejected') then
    new.verify_status := 'pending';
  end if;
  return new;
end $$;
