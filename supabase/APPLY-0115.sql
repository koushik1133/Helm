-- APPLY-0115.sql — paste into the Supabase SQL editor (staging first). Same body as migrations/0115_task_requeue_after_rework.sql. Safe to run twice.

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

-- ---- VERIFY (expect every ok = true) ----
select 'tg_task_verify re-queues reworked tasks' as item, pg_get_functiondef('public.tg_task_verify()'::regprocedure) like '%task-requeue-0115%' as ok
union all
select 'tg_task_verify still queues unverified tasks', pg_get_functiondef('public.tg_task_verify()'::regprocedure) like '%''unverified'', ''rejected''%'
union all
select 'task_verify_trg still attached', exists (select 1 from pg_trigger where tgname = 'task_verify_trg' and tgrelid = 'public.event_tasks'::regclass and not tgisinternal);
