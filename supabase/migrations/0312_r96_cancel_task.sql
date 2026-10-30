-- 0312_r96_cancel_task.sql - CANONICAL forward-only. R96 (owner: "the office can cancel a crew task").
--
-- In plain words:
--   * NEW RPC cancel_task(p_task, p_reason): someone who can edit Staff (has_area('staff','edit'), the same gate as
--     reassign_task) cancels a task of their own studio that is assigned, accepted or in progress - for example an
--     open shift a crew member claimed (accepted) and can no longer drop himself (0311 made the answer final).
--   * A reason is required (3 - 300 characters, trimmed). Completed / cancelled / rejected / unassigned tasks are
--     refused with a friendly message (the 0311 move table already allows assigned / accepted / in_progress ->
--     cancelled; it is NOT changed).
--   * The task row is kept (never deleted): status = 'cancelled' plus three NEW nullable columns cancel_reason,
--     cancelled_at, cancelled_by. Existing rows are not touched.
--   * One audit_log row 'task.cancel' with the reason (the 0311 trigger also writes its usual task.status row with
--     from / to - the task.cancel row is the one that carries the reason).
--   * The 0265 trigger zz_r23_shift_task_release already frees the open-shift place when a task becomes cancelled
--     (the claim -> withdrawn, a filled shift -> open again). Nothing to change there.
--   * NEW guard zz_r312_cancel_cols: app calls cannot write the three cancel columns directly (only cancel_task
--     can); SQL run by hand is not refused.
--   Grants: cancel_task to authenticated only (revoked from public / anon). Safe to run twice. ASCII only.
--   Goes after 0265 + 0311.
do $$
begin
  if to_regclass('public.event_tasks') is null then raise exception 'STOP 0312: public.event_tasks is missing'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP 0312: public.audit_log is missing'; end if;
  if to_regprocedure('public._r311_app_call()') is null then raise exception 'STOP 0312: _r311_app_call missing (needs 0311)'; end if;
  if to_regprocedure('public._r311_move_ok(text,text)') is null then raise exception 'STOP 0312: _r311_move_ok missing (needs 0311)'; end if;
  if to_regprocedure('public.has_area(text,text)') is null then raise exception 'STOP 0312: has_area missing'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP 0312: current_org_id missing'; end if;
end $$;

-- ---- 1) three new nullable columns (additive; existing rows stay null) ------------------------------------------
alter table public.event_tasks add column if not exists cancel_reason text;
alter table public.event_tasks add column if not exists cancelled_at timestamptz;
alter table public.event_tasks add column if not exists cancelled_by uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.event_tasks'::regclass and conname = 'event_tasks_cancel_reason_len') then
    alter table public.event_tasks add constraint event_tasks_cancel_reason_len
      check (cancel_reason is null or char_length(cancel_reason) <= 300) not valid;
  end if;
end $$;

-- ---- 2) the cancel columns are written only by cancel_task (app calls); SQL by hand is free ----------------------
create or replace function public._r312_tg_cancel_cols()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r96-cancel-task-0312
begin
  if (new.cancel_reason is distinct from old.cancel_reason or new.cancelled_at is distinct from old.cancelled_at
      or new.cancelled_by is distinct from old.cancelled_by)
     and coalesce(current_setting('helm.r312_cancel', true), '') is distinct from new.id::text
     and public._r311_app_call() then
    raise exception 'Use Cancel task to cancel a task.' using errcode = '42501', hint = 'r312_cancel_cols';
  end if;
  return new;
end $$;
drop trigger if exists zz_r312_cancel_cols on public.event_tasks;
create trigger zz_r312_cancel_cols before update on public.event_tasks
  for each row execute function public._r312_tg_cancel_cols();

-- ---- 3) the RPC ----------------------------------------------------------------------------------------------------
create or replace function public.cancel_task(p_task uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r96-cancel-task-0312
declare v_org uuid; v_uid uuid; v_reason text; t record; v_email text;
begin
  v_uid := auth.uid(); v_org := public.current_org_id();
  if v_uid is null or v_org is null or not public.has_area('staff', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_reason := btrim(regexp_replace(coalesce(p_reason, ''), '\s+', ' ', 'g'));
  if char_length(v_reason) < 3 then
    raise exception 'Please give a reason for cancelling (at least 3 characters).' using errcode = '22023', hint = 'r312_reason';
  end if;
  if char_length(v_reason) > 300 then
    raise exception 'The reason is too long (300 characters at most).' using errcode = '22023', hint = 'r312_reason';
  end if;
  select x.id, x.status, x.title, x.quote_id into t from public.event_tasks x
   where x.id = p_task and x.org_id = v_org for update;
  if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if t.status not in ('assigned', 'accepted', 'in_progress') then
    raise exception '%', case t.status
        when 'cancelled'  then 'This task is already cancelled.'
        when 'completed'  then 'This task is already done, so it cannot be cancelled.'
        when 'rejected'   then 'The crew member turned this task down - reassign it instead of cancelling.'
        when 'unassigned' then 'This task is not given to anyone yet, so there is nothing to cancel.'
        else 'This task cannot be cancelled now.' end
      using errcode = '22023', hint = 'r312_not_cancellable';
  end if;
  perform set_config('helm.r312_cancel', p_task::text, true);
  update public.event_tasks
     set status = 'cancelled', cancel_reason = v_reason, cancelled_at = now(), cancelled_by = v_uid
   where id = p_task and org_id = v_org;
  perform set_config('helm.r312_cancel', '', true);
  begin v_email := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'; exception when others then v_email := null; end;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
  values (v_uid, v_email, 'task.cancel', 'event_tasks', p_task::text, t.quote_id,
          jsonb_build_object('from', t.status, 'reason', v_reason, 'title', left(t.title, 200)), v_org);
  return jsonb_build_object('ok', true, 'id', p_task, 'status', 'cancelled', 'from', t.status, 'reason', v_reason);
end $$;

-- ---- 4) privileges -------------------------------------------------------------------------------------------------
do $$
declare v_role text;
begin
  revoke all on function public.cancel_task(uuid, text) from public;
  revoke all on function public._r312_tg_cancel_cols() from public;
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute format('revoke all on function public._r312_tg_cancel_cols() from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    revoke all on function public.cancel_task(uuid, text) from anon;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    grant execute on function public.cancel_task(uuid, text) to authenticated;
  end if;
end $$;
