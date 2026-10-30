-- APPLY-0311.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0299 (and 0282 / 0154 / 0144 / 0038). It stops with "STOP 0311: ..." if a needed table / function is missing.
-- R92 (owner): the crew task lifecycle is checked by the database.
--   * A crew member's Accept / Reject is final (only from "assigned"); a second answer gets a friendly "already answered".
--   * Reassign only while a task is unassigned / assigned / rejected ("Locked: task accepted" after that).
--   * A quality check verdict only for a finished task waiting for QC.
--   * Every task status / QC / assignee change is written to the audit log.
--   Existing tasks are not changed. Nothing is deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (Ops shows a locked "Reassign" for accepted tasks + the new filter bar).
begin;
-- 0311_r92_task_lifecycle.sql - CANONICAL forward-only. R92 (owner: "Ops task lifecycle rules on the server").
--
-- In plain words:
--   A crew task now follows one set of moves, checked by the database itself (not only by the screens):
--     unassigned -> assigned
--     assigned   -> accepted | rejected | in_progress | cancelled   (assigned -> in_progress = "start" shortcut, kept)
--     rejected   -> assigned                                        (the office reassigns it)
--     accepted   -> in_progress | completed | cancelled             (accepted -> completed = "done" shortcut, kept)
--     in_progress-> completed | cancelled
--     completed  -> in_progress                                     (ONLY when quality check fails it)
--     and "no change" (same status) is always fine.
--   * A crew member's Accept / Reject is final: accept / reject only from "assigned". worker_respond,
--     worker_respond_evidence and crew_task_respond answer {ok:false, refused:true, message} instead of an error.
--   * A task can be given to someone else (crew / vendor / phone) only while it is unassigned, assigned or
--     rejected. reassign_task refuses accepted / in progress / completed tasks ("Locked: task accepted") and puts
--     the quality check back to "unverified" for the new person.
--   * A quality verdict (passed / rejected) needs a completed task waiting for QC (verify_status pending);
--     verify_task refuses anything else with a clear message.
--   * Every status / QC / assignee change writes one audit_log row (action task.status / task.verify /
--     task.assignee) - including changes made by hand in the SQL editor.
--   The checks apply to app calls (anon / authenticated / service_role, directly or through any RPC). SQL run by
--   hand (no API role) is NOT refused - only written to the audit log - so the owner can always repair a row.
--   Existing rows are never changed: the trigger only looks at future updates. Nothing is deleted.
--   House "wrap once" pattern (0307 / 0309): the logic lives in NEW _r311_* functions (re-issued every run); each
--   live RPC is renamed ONCE to *__pre0311 (app privileges taken away) and a thin wrapper with the same signature
--   and the same grants takes the name. No table / column / row / policy / index deleted. Safe to run twice.
--   ASCII only. Goes after 0012 + 0033 + 0038 + 0115 + 0144 + 0154 + 0282 + 0299.
do $$
begin
  if to_regclass('public.event_tasks') is null then raise exception 'STOP 0311: public.event_tasks is missing'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP 0311: public.audit_log is missing'; end if;
  if to_regprocedure('public._work_token_live(uuid)') is null then raise exception 'STOP 0311: _work_token_live missing (needs 0012)'; end if;
  if to_regprocedure('public._a153_my_crew_ids()') is null then raise exception 'STOP 0311: _a153_my_crew_ids missing (needs 0153)'; end if;
  if to_regprocedure('public.worker_respond(uuid,uuid,text)') is null then raise exception 'STOP 0311: worker_respond missing'; end if;
  if to_regprocedure('public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])') is null then
    raise exception 'STOP 0311: worker_respond_evidence missing (needs 0038)'; end if;
  if to_regprocedure('public.crew_task_respond(uuid,text)') is null then raise exception 'STOP 0311: crew_task_respond missing (needs 0153)'; end if;
  if to_regprocedure('public.reassign_task(uuid,uuid,text,text)') is null then raise exception 'STOP 0311: reassign_task missing'; end if;
  if to_regprocedure('public.verify_task(uuid,boolean,text)') is null then raise exception 'STOP 0311: verify_task missing'; end if;
end $$;

-- ---- 1) helpers (re-issued on every run; never callable by the app) --------------------------------------------
-- is this an app call? (PostgREST sets ROLE + request.jwt.claims; a SECURITY DEFINER RPC keeps both)
create or replace function public._r311_app_call()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r92-task-lifecycle-0311
declare v_claims jsonb; v_role text;
begin
  begin v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then v_claims := null; end;
  v_role := coalesce(v_claims ->> 'role', '');
  return coalesce(current_setting('role', true), '') in ('anon', 'authenticated', 'service_role')
      or v_role in ('anon', 'authenticated', 'service_role');
end $$;

-- the allowed status moves (same status = no move, always fine)
create or replace function public._r311_move_ok(p_from text, p_to text)
returns boolean language sql immutable security definer set search_path = '' as $$
  select p_from is not distinct from p_to or (coalesce(p_from, '') || '>' || coalesce(p_to, '')) = any (array[
    'unassigned>assigned',
    'assigned>accepted', 'assigned>rejected', 'assigned>in_progress', 'assigned>cancelled',
    'rejected>assigned',
    'accepted>in_progress', 'accepted>completed', 'accepted>cancelled',
    'in_progress>completed', 'in_progress>cancelled',
    'completed>in_progress']) /* r92-task-lifecycle-0311 */
$$;

-- the friendly answer when a crew member answers a task that is no longer waiting for an answer
create or replace function public._r311_respond_refusal(p_status text, p_action text)
returns text language sql immutable security definer set search_path = '' as $$
  select case when p_action in ('accept', 'reject') and p_status is distinct from 'assigned' then
    case p_status
      when 'accepted'    then 'You already accepted this task. Your answer is final - please call the office if something changed.'
      when 'rejected'    then 'You already turned this task down. Your answer is final - please call the office if something changed.'
      when 'in_progress' then 'This task has already started.'
      when 'completed'   then 'This task is already done.'
      when 'cancelled'   then 'This task was cancelled by the office.'
      else 'This task is not waiting for your answer.' end
  end /* r92-task-lifecycle-0311 */
$$;

-- ---- 2) the lifecycle guard + audit (BEFORE UPDATE, sorts after every existing event_tasks trigger) --------------
create or replace function public._r311_tg_task_flow()
returns trigger language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311
declare
  v_claims jsonb; v_actor uuid; v_email text; v_app boolean;
  v_status boolean; v_verify boolean; v_assign boolean; v_cleared boolean;
begin
  v_status := new.status is distinct from old.status;
  v_verify := new.verify_status is distinct from old.verify_status;
  v_assign := (new.crew_id is distinct from old.crew_id and new.crew_id is not null)
           or (new.vendor_id is distinct from old.vendor_id and new.vendor_id is not null)
           or (new.assignee_phone is distinct from old.assignee_phone and nullif(btrim(coalesce(new.assignee_phone, '')), '') is not null);
  v_cleared := (new.crew_id is null and old.crew_id is not null) or (new.vendor_id is null and old.vendor_id is not null);
  if not (v_status or v_verify or v_assign or v_cleared) then return new; end if;
  v_app := public._r311_app_call();

  if v_app then
    if v_status then
      if not public._r311_move_ok(old.status, new.status) then
        raise exception 'This task cannot move from % to %.', replace(old.status, '_', ' '), replace(new.status, '_', ' ')
          using errcode = '22023', hint = 'r311_task_flow';
      end if;
      -- completed -> in_progress only as a failed quality check of a task that was waiting for QC
      if old.status = 'completed' and new.status = 'in_progress'
         and not (old.verify_status = 'pending' and new.verify_status = 'rejected') then
        raise exception 'A finished task goes back to work only when the quality check fails it.'
          using errcode = '22023', hint = 'r311_task_flow';
      end if;
    end if;
    if v_assign and old.status not in ('unassigned', 'assigned', 'rejected') then
      raise exception 'Locked: task accepted - it cannot be given to someone else now.'
        using errcode = '22023', hint = 'r311_reassign_locked';
    end if;
    if v_verify and new.verify_status in ('passed', 'rejected') and old.verify_status is distinct from 'pending' then
      raise exception 'This task is not waiting for a quality check.' using errcode = '22023', hint = 'r311_qc_not_pending';
    end if;
  end if;

  begin v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb; exception when others then v_claims := null; end;
  if (v_claims ->> 'sub') ~* '^[0-9a-f-]{36}$' then v_actor := (v_claims ->> 'sub')::uuid; end if;
  v_email := coalesce(v_claims ->> 'email', case when v_app then null else 'db:' || session_user::text end);
  if v_status then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, 'task.status', 'event_tasks', new.id::text, new.quote_id,
            jsonb_build_object('from', old.status, 'to', new.status, 'title', left(new.title, 200)), new.org_id);
  end if;
  if v_verify then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, 'task.verify', 'event_tasks', new.id::text, new.quote_id,
            jsonb_build_object('from', old.verify_status, 'to', new.verify_status, 'title', left(new.title, 200),
                               'verified_by', old.verified_by, 'verified_at', old.verified_at), new.org_id);
  end if;
  if v_assign or v_cleared then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_actor, v_email, 'task.assignee', 'event_tasks', new.id::text, new.quote_id,
            jsonb_build_object('from', jsonb_build_object('crew_id', old.crew_id, 'vendor_id', old.vendor_id, 'name', old.assignee_name),
                               'to', jsonb_build_object('crew_id', new.crew_id, 'vendor_id', new.vendor_id, 'name', new.assignee_name),
                               'status', old.status, 'title', left(new.title, 200)), new.org_id);
  end if;
  return new;
end $$;
drop trigger if exists zzzz_r311_task_flow on public.event_tasks;
create trigger zzzz_r311_task_flow before update on public.event_tasks
  for each row execute function public._r311_tg_task_flow();

-- ---- 3) the RPC logic (re-issued on every run) -------------------------------------------------------------------
create or replace function public._r311_worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311: accept / reject only from assigned; a friendly refusal instead of an error
declare w public.work_tokens; v_st text; v_msg text;
begin
  if p_action in ('accept', 'reject') then
    w := public._work_token_live(p_token);
    select t.status into v_st from public.event_tasks t
     where t.id = p_task_id and t.quote_id = w.quote_id and t.assignee_phone = w.phone for update;
    if found then
      v_msg := public._r311_respond_refusal(v_st, p_action);
      if v_msg is not null then
        return jsonb_build_object('ok', false, 'refused', true, 'status', v_st, 'message', v_msg);
      end if;
    end if;
  end if;
  return public.worker_respond__pre0311(p_token, p_task_id, p_action);
end $$;

create or replace function public._r311_worker_respond_evidence(p_token uuid, p_task_id uuid, p_action text, p_reason text,
  p_voice_path text, p_voice_seconds integer, p_photo_paths text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311: a reject with evidence follows the same "answer is final" rule
declare w public.work_tokens; v_st text; v_msg text;
begin
  if p_action = 'reject' then
    w := public._work_token_live(p_token);
    select t.status into v_st from public.event_tasks t
     where t.id = p_task_id and t.quote_id = w.quote_id and t.assignee_phone = w.phone for update;
    if found then
      v_msg := public._r311_respond_refusal(v_st, p_action);
      if v_msg is not null then
        return jsonb_build_object('ok', false, 'refused', true, 'status', v_st, 'message', v_msg, 'evidence', 0);
      end if;
    end if;
  end if;
  return public.worker_respond_evidence__pre0311(p_token, p_task_id, p_action, p_reason, p_voice_path, p_voice_seconds, p_photo_paths);
end $$;

create or replace function public._r311_crew_task_respond(p_task uuid, p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311: accept / reject only from assigned; a friendly refusal instead of an error
declare v_st text; v_msg text;
begin
  if p_action in ('accept', 'reject') and auth.uid() is not null and public.current_org_id() is not null then
    select t.status into v_st from public.event_tasks t
     where t.id = p_task and t.org_id = public.current_org_id() and t.crew_id in (select public._a153_my_crew_ids()) for update;
    if found then
      v_msg := public._r311_respond_refusal(v_st, p_action);
      if v_msg is not null then
        return jsonb_build_object('ok', false, 'refused', true, 'status', v_st, 'message', v_msg);
      end if;
    end if;
  end if;
  return public.crew_task_respond__pre0311(p_task, p_action);
end $$;

create or replace function public._r311_reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311: no reassign once the crew member accepted; QC starts again for the new person
declare v_st text; v_out jsonb;
begin
  if not public.has_area('staff', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  select t.status into v_st from public.event_tasks t where t.id = p_task_id and t.org_id = public.current_org_id() for update;
  if v_st in ('accepted', 'in_progress', 'completed') then
    raise exception 'Locked: task accepted - the crew member already accepted this task, so it cannot be reassigned.'
      using errcode = '22023', hint = 'r311_reassign_locked';
  end if;
  if v_st = 'cancelled' then
    raise exception 'This task was cancelled, so it cannot be reassigned.' using errcode = '22023', hint = 'r311_reassign_locked';
  end if;
  v_out := public.reassign_task__pre0311(p_task_id, p_crew_id, p_name, p_phone);
  update public.event_tasks set verify_status = 'unverified', verified_by = null, verified_at = null
   where id = p_task_id and org_id = public.current_org_id() and verify_status is distinct from 'unverified';
  return v_out;
end $$;

create or replace function public._r311_verify_task(p_id uuid, p_pass boolean, p_note text)
returns public.event_tasks language plpgsql volatile security definer set search_path = '' as $$
-- r92-task-lifecycle-0311: a verdict only for a completed task waiting for QC
declare v record;
begin
  if not (public.user_role() in ('admin', 'manager', 'planner', 'quality')) or not public.has_area('staff', 'view') then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode = '42501';
  end if;
  select t.status, t.verify_status into v from public.event_tasks t where t.id = p_id and t.org_id = public.current_org_id() for update;
  if not found then raise exception 'task not found'; end if;
  if v.status is distinct from 'completed' or v.verify_status is distinct from 'pending' then
    raise exception 'This task is not waiting for a quality check (it must be done and waiting for QC).'
      using errcode = '22023', hint = 'r311_qc_not_pending';
  end if;
  return public.verify_task__pre0311(p_id, p_pass, p_note);
end $$;

-- ---- 4) wrap once: rename the live RPC to *__pre0311 (only when that name is missing), a thin wrapper takes the
--         name with the SAME grants; a 2nd run (or a run after a later wrapper) never replaces what is there ---------
do $$
declare r record; v_src text; v_role text;
begin
  for r in select * from (values
      ('worker_respond',          'uuid,uuid,text',
       'p_token uuid, p_task_id uuid, p_action text', 'jsonb',
       'select public._r311_worker_respond(p_token, p_task_id, p_action) /* r92-task-lifecycle-0311 */'),
      ('worker_respond_evidence', 'uuid,uuid,text,text,text,integer,text[]',
       'p_token uuid, p_task_id uuid, p_action text, p_reason text default null, p_voice_path text default null, p_voice_seconds integer default null, p_photo_paths text[] default null', 'jsonb',
       'select public._r311_worker_respond_evidence(p_token, p_task_id, p_action, p_reason, p_voice_path, p_voice_seconds, p_photo_paths) /* r92-task-lifecycle-0311 */'),
      ('crew_task_respond',       'uuid,text',
       'p_task uuid, p_action text', 'jsonb',
       'select public._r311_crew_task_respond(p_task, p_action) /* r92-task-lifecycle-0311 */'),
      ('reassign_task',           'uuid,uuid,text,text',
       'p_task_id uuid, p_crew_id uuid, p_name text, p_phone text', 'jsonb',
       'select public._r311_reassign_task(p_task_id, p_crew_id, p_name, p_phone) /* r92-task-lifecycle-0311 */'),
      ('verify_task',             'uuid,boolean,text',
       'p_id uuid, p_pass boolean, p_note text default null', 'public.event_tasks',
       'select public._r311_verify_task(p_id, p_pass, p_note) /* r92-task-lifecycle-0311 */')
    ) t(fn, args, sig, ret, body) loop
    if to_regprocedure(format('public.%s__pre0311(%s)', r.fn, r.args)) is null then
      execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0311');
      execute format('create function public.%I(%s) returns %s language sql volatile security definer set search_path = '''' as %L',
                     r.fn, r.sig, r.ret, r.body);
      execute format('revoke all on function public.%I(%s) from public', r.fn, r.args);
      -- the live name gets exactly the grants the kept body had
      foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
        if exists (select 1 from pg_catalog.pg_roles where rolname = v_role)
           and has_function_privilege(v_role, format('public.%I(%s)', r.fn || '__pre0311', r.args)::regprocedure, 'execute') then
          execute format('grant execute on function public.%I(%s) to %I', r.fn, r.args, v_role);
        end if;
      end loop;
    else
      select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure(format('public.%s(%s)', r.fn, r.args));
      if position('r92-task-lifecycle-0311' in coalesce(v_src, '')) = 0 then
        raise notice '0311: %(%) was re-issued after 0311 - left unchanged (check the chain still reaches _r311_%)', r.fn, r.args, r.fn;
      end if;
    end if;
    -- the kept body is not callable by the app any more (service_role keeps it)
    execute format('revoke all on function public.%I(%s) from public', r.fn || '__pre0311', r.args);
    foreach v_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
        execute format('revoke all on function public.%I(%s) from %I', r.fn || '__pre0311', r.args, v_role);
      end if;
    end loop;
  end loop;
end $$;

-- ---- 5) privileges of the new helpers: never callable by the app --------------------------------------------------
do $$
declare f text; v_role text;
begin
  foreach f in array array['public._r311_app_call()', 'public._r311_move_ok(text,text)', 'public._r311_respond_refusal(text,text)',
                           'public._r311_tg_task_flow()', 'public._r311_worker_respond(uuid,uuid,text)',
                           'public._r311_worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])',
                           'public._r311_crew_task_respond(uuid,text)', 'public._r311_reassign_task(uuid,uuid,text,text)',
                           'public._r311_verify_task(uuid,boolean,text)'] loop
    execute format('revoke all on function %s from public', f);
    foreach v_role in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
        execute format('revoke all on function %s from %I', f, v_role);
      end if;
    end loop;
    if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 lifecycle trigger zzzz_r311_task_flow on event_tasks',
     exists (select 1 from pg_trigger where tgname = 'zzzz_r311_task_flow' and tgrelid = 'public.event_tasks'::regclass)),
  ('02 the five RPCs are the 0311 wrappers (marker + empty search_path)',
     coalesce((select bool_and(position('r92-task-lifecycle-0311' in p.prosrc) > 0 and array_to_string(p.proconfig, ',') like '%search_path=""%')
                 from pg_proc p where p.oid in (to_regprocedure('public.worker_respond(uuid,uuid,text)'),
                   to_regprocedure('public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'),
                   to_regprocedure('public.crew_task_respond(uuid,text)'), to_regprocedure('public.reassign_task(uuid,uuid,text,text)'),
                   to_regprocedure('public.verify_task(uuid,boolean,text)'))), false)),
  ('03 previous bodies kept once as *__pre0311',
     to_regprocedure('public.worker_respond__pre0311(uuid,uuid,text)') is not null
     and to_regprocedure('public.worker_respond_evidence__pre0311(uuid,uuid,text,text,text,integer,text[])') is not null
     and to_regprocedure('public.crew_task_respond__pre0311(uuid,text)') is not null
     and to_regprocedure('public.reassign_task__pre0311(uuid,uuid,text,text)') is not null
     and to_regprocedure('public.verify_task__pre0311(uuid,boolean,text)') is not null),
  ('04 app grants kept on the live names (crew link anon, studio authenticated)',
     has_function_privilege('anon', 'public.worker_respond(uuid,uuid,text)', 'execute')
     and has_function_privilege('anon', 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])', 'execute')
     and has_function_privilege('authenticated', 'public.crew_task_respond(uuid,text)', 'execute')
     and has_function_privilege('authenticated', 'public.reassign_task(uuid,uuid,text,text)', 'execute')
     and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute')),
  ('05 kept bodies + new logic not callable by the app',
     not has_function_privilege('anon', 'public.worker_respond__pre0311(uuid,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.reassign_task__pre0311(uuid,uuid,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.verify_task__pre0311(uuid,boolean,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r311_tg_task_flow()', 'execute')
     and not has_function_privilege('anon', 'public._r311_worker_respond(uuid,uuid,text)', 'execute')),
  ('06 move table: accept/reject final, reassign from rejected, QC-fail reopen',
     public._r311_move_ok('rejected', 'assigned') and public._r311_move_ok('completed', 'in_progress')
     and not public._r311_move_ok('accepted', 'rejected') and not public._r311_move_ok('rejected', 'accepted'))
) v(item, ok);
