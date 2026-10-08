-- ============================================================================
-- 0066_notification_task_ref.sql - CANONICAL forward-only. Notification deep
-- links: task notifications carry the id of the task they are about.
--
-- In plain words:
--   * Task notifications (task_assigned, task_reminder, task_due, task_accept,
--     task_reject, task_start, task_complete) are written by older RPCs that
--     only put the task TITLE (or nothing) in detail. The bell needs the task
--     id to open Operations with that exact task highlighted.
--   * A BEFORE INSERT trigger adds detail.task_id when it is missing, looked
--     up in the SAME event (quote_id) only - never another event or studio.
--   * Existing detail keys are never removed or changed; a task_id that is
--     already present is kept. If no task matches, nothing is added. The
--     trigger can never block a notification insert (errors are swallowed).
--
-- Additive + idempotent: 1 new function, 1 new trigger. NO existing row changed.
-- ============================================================================

do $$ begin
  if to_regclass('public.notifications') is null then raise exception '0066: public.notifications is not installed'; end if;
  if to_regclass('public.event_tasks') is null then raise exception '0066: public.event_tasks is not installed'; end if;
end $$;

create or replace function public._n66_tg_task_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_k text;
begin
  v_k := lower(coalesce(new.kind, ''));
  if new.quote_id is null or v_k not in ('task_assigned','task_reminder','task_due','task_accept','task_reject','task_start','task_complete') then
    return new;
  end if;
  if jsonb_typeof(new.detail) = 'object' and new.detail ? 'task_id' then return new; end if;
  if new.detail is not null and jsonb_typeof(new.detail) <> 'object' then return new; end if;
  begin
    if new.detail ? 'task' then
      select t.id into v_id from public.event_tasks t
       where t.quote_id = new.quote_id and t.title = new.detail ->> 'task'
       order by (new.recipient is not null and t.assignee_phone = new.recipient) desc,
                greatest(coalesce(t.completed_at, '-infinity'), coalesce(t.started_at, '-infinity'),
                         coalesce(t.responded_at, '-infinity'), coalesce(t.triggered_at, '-infinity'),
                         coalesce(t.last_reminded_at, '-infinity'), coalesce(t.created_at, '-infinity')) desc,
                t.id
       limit 1;
    elsif v_k = 'task_assigned' and new.recipient is not null then
      select t.id into v_id from public.event_tasks t
       where t.quote_id = new.quote_id and t.assignee_phone = new.recipient and t.status = 'assigned'
       order by t.created_at desc nulls last, t.seq, t.id
       limit 1;
    end if;
    if v_id is not null then
      new.detail := coalesce(new.detail, '{}'::jsonb) || jsonb_build_object('task_id', v_id);
    end if;
  exception when others then null;   -- a deep-link hint must never block the notification
  end;
  return new;
end $$;

revoke all on function public._n66_tg_task_ref() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._n66_tg_task_ref() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._n66_tg_task_ref() from authenticated'; end if;
end $$;

drop trigger if exists zc_n66_task_ref on public.notifications;
create trigger zc_n66_task_ref before insert on public.notifications
  for each row execute function public._n66_tg_task_ref();
