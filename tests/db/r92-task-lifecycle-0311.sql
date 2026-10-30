-- r92-task-lifecycle-0311.sql - 0311: the crew task lifecycle is enforced by the database.
-- Proves: accept / reject only from assigned (a friendly {ok:false} refusal, answer is final); assigned -> in_progress
-- and accepted -> completed shortcuts kept; reassign refused once accepted and resets QC; a QC verdict needs a
-- completed task waiting for QC; completed -> in_progress only as a failed QC; illegal moves refused for app calls,
-- allowed (but audited) for SQL run by hand; one audit_log row per status / verify / assignee change; grants kept.
-- Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0311_r92_task_lifecycle.sql
\ir ../../supabase/migrations/0311_r92_task_lifecycle.sql
set client_min_messages = warning;
begin;
create temp table _t311(name text, result text); grant all on _t311 to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _t311 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; begin execute p_sql into r; return r;
exception when others then return jsonb_build_object('error', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.st(p uuid) returns text language sql as $$ select status || '/' || verify_status from public.event_tasks where id = p $$;

do $$
declare
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  tok uuid := 'f3110000-0000-4000-8000-000000000001'; p1 text := '+919311000001';
  c1 uuid; c2 uuid; c3 uuid; t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; t6 uuid;
  r jsonb; e text; n int; v_staff uuid;
begin
  perform pg_temp.su();
  select id into orgA from public.organizations where id = orgA;
  select id into v_staff from auth.users where email = 'a_staff@a.test';
  insert into public.crew_members(name, phone, org_id, active) values ('R311 One', p1, orgA, true) returning id into c1;
  insert into public.crew_members(name, phone, org_id, active) values ('R311 Two', '+919311000002', orgA, true) returning id into c2;
  insert into public.crew_members(name, phone, org_id, active, profile_id) values ('R311 Staff', '+919311000003', orgA, true, v_staff) returning id into c3;
  insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at) values (tok, qa, p1, 'R311 One', orgA, now() + interval '5 days');
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t1', 1, c1, 'R311 One', p1, 'assigned') returning id into t1;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t2', 2, c1, 'R311 One', p1, 'assigned') returning id into t2;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t3', 3, c1, 'R311 One', p1, 'assigned') returning id into t3;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t4', 4, c1, 'R311 One', p1, 'accepted') returning id into t4;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t5', 5, c3, 'R311 Staff', '+919311000003', 'assigned') returning id into t5;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R311 t6', 6, c1, 'R311 One', p1, 'assigned') returning id into t6;

  -- (1) worker accept from assigned works; a second answer is refused (final), never an error
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''accept'')', tok, t1));
  perform pg_temp.su();
  perform pg_temp.res('01 worker accept from assigned -> accepted', r ->> 'ok' = 'true' and pg_temp.st(t1) = 'accepted/unverified', r::text);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''reject'')', tok, t1));
  perform pg_temp.su();
  perform pg_temp.res('02 worker reject after accept -> {ok:false, refused} (owner 2a)',
    r ->> 'ok' = 'false' and r ->> 'refused' = 'true' and r ->> 'message' like 'You already accepted%' and pg_temp.st(t1) = 'accepted/unverified', r::text);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond_evidence(%L, %L, ''reject'', ''changed my mind'')', tok, t1));
  perform pg_temp.su();
  perform pg_temp.res('03 reject WITH evidence after accept -> refused, no evidence saved',
    r ->> 'ok' = 'false' and pg_temp.st(t1) = 'accepted/unverified'
    and not exists (select 1 from public.task_evidence x where x.task_id = t1), r::text);

  -- (2) reassign is locked once accepted
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.reassign_task(%L, %L, ''R311 Two'', ''+919311000002'')', t1, c2));
  perform pg_temp.su();
  perform pg_temp.res('04 reassign an accepted task -> Locked: task accepted', e like '22023 r311_reassign_locked | Locked: task accepted%', e);
  -- a direct app write that changes the assignee of an accepted task is refused by the trigger too
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  e := pg_temp.try(format('update public.event_tasks set crew_id = %L where id = %L', c2, t1));
  perform pg_temp.su();
  perform pg_temp.res('05 trigger: new assignee on an accepted task refused', e like '22023 r311_reassign_locked%', e);

  -- (3) start + done + QC fail + done again + QC pass
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''start'')', tok, t1));
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''complete'')', tok, t1));
  perform pg_temp.su();
  perform pg_temp.res('06 accepted -> in_progress -> completed, QC pending', pg_temp.st(t1) = 'completed/pending', pg_temp.st(t1));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.verify_task(%L, false, ''redo'')', t1));
  perform pg_temp.su();
  perform pg_temp.res('07 QC fail: completed -> in_progress, verify rejected', e = '' and pg_temp.st(t1) = 'in_progress/rejected', e || ' ' || pg_temp.st(t1));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.verify_task(%L, true)', t1));
  perform pg_temp.su();
  perform pg_temp.res('08 QC verdict on a task not waiting for QC -> refused', e like '22023 r311_qc_not_pending%' and pg_temp.st(t1) = 'in_progress/rejected', e);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''complete'')', tok, t1));
  perform pg_temp.su();
  perform pg_temp.res('09 done again re-queues QC', pg_temp.st(t1) = 'completed/pending', pg_temp.st(t1));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.verify_task(%L, true)', t1));
  perform pg_temp.su();
  perform pg_temp.res('10 QC pass', e = '' and pg_temp.st(t1) = 'completed/passed', e);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  e := pg_temp.try(format('update public.event_tasks set status = ''in_progress'' where id = %L', t1));
  perform pg_temp.su();
  perform pg_temp.res('11 completed -> in_progress without a QC fail refused', e like '22023 r311_task_flow%', e);
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false);
  e := pg_temp.try(format('update public.event_tasks set status = ''assigned'' where id = %L', t1));
  perform pg_temp.su();
  perform pg_temp.res('12 completed -> assigned refused for app calls', e like '22023 r311_task_flow%', e);

  -- (4) reject from assigned; a later accept is refused; the office reassigns; QC back to unverified
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''reject'')', tok, t2));
  perform pg_temp.su();
  perform pg_temp.res('13 reject from assigned', r ->> 'ok' = 'true' and pg_temp.st(t2) = 'rejected/unverified', r::text);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''accept'')', tok, t2));
  perform pg_temp.su();
  perform pg_temp.res('14 accept after reject -> refused (answer is final)', r ->> 'ok' = 'false' and pg_temp.st(t2) = 'rejected/unverified', r::text);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.reassign_task(%L, %L, ''R311 Two'', ''+919311000002'')', t2, c2));
  perform pg_temp.su();
  perform pg_temp.res('15 reassign a rejected task -> assigned to the new person',
    e = '' and pg_temp.st(t2) = 'assigned/unverified' and (select crew_id from public.event_tasks where id = t2) = c2, e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.reassign_task(%L, %L, ''R311 One'', %L)', t6, c1, p1));
  perform pg_temp.su();
  perform pg_temp.res('16 reassign an assigned task still works', e = '' and pg_temp.st(t6) = 'assigned/unverified', e);

  -- (5) owner 2b: the shortcuts stay
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''start'')', tok, t3));
  perform pg_temp.su();
  perform pg_temp.res('17 shortcut assigned -> in_progress kept', r ->> 'ok' = 'true' and pg_temp.st(t3) = 'in_progress/unverified', r::text);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''complete'')', tok, t4));
  perform pg_temp.su();
  perform pg_temp.res('18 shortcut accepted -> completed kept', r ->> 'ok' = 'true' and pg_temp.st(t4) = 'completed/pending', r::text);

  -- (6) crew_task_respond (signed-in staff) follows the same rule
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.j(format('select public.crew_task_respond(%L, ''accept'')', t5));
  perform pg_temp.su();
  perform pg_temp.res('19 crew_task_respond accept from assigned', r ->> 'ok' = 'true' and pg_temp.st(t5) = 'accepted/unverified', r::text);
  perform pg_temp.login('a_staff@a.test');
  r := pg_temp.j(format('select public.crew_task_respond(%L, ''reject'')', t5));
  perform pg_temp.su();
  perform pg_temp.res('20 crew_task_respond reject after accept -> {ok:false, refused}', r ->> 'ok' = 'false' and r ->> 'refused' = 'true' and pg_temp.st(t5) = 'accepted/unverified', r::text);

  -- (7) the move table + SQL by hand (no API role) is not refused, only audited
  perform pg_temp.res('21 move table', public._r311_move_ok('rejected', 'assigned') and public._r311_move_ok('assigned', 'in_progress')
    and public._r311_move_ok('accepted', 'completed') and public._r311_move_ok('done', 'done')
    and not public._r311_move_ok('accepted', 'rejected') and not public._r311_move_ok('rejected', 'accepted')
    and not public._r311_move_ok('completed', 'assigned') and not public._r311_move_ok('cancelled', 'assigned'), '');
  e := pg_temp.try(format('update public.event_tasks set status = ''cancelled'' where id = %L', t4));
  perform pg_temp.res('22 SQL by hand: completed -> cancelled not refused, audited as db:',
    e = '' and exists (select 1 from public.audit_log a where a.entity_id = t4::text and a.action = 'task.status'
                       and a.changed ->> 'to' = 'cancelled' and a.actor_email like 'db:%'), e);

  -- (8) audit: one row per status / verify / assignee change
  select count(*) into n from public.audit_log a where a.entity = 'event_tasks' and a.entity_id = t1::text and a.action = 'task.status';
  perform pg_temp.res('23 audit task.status rows for t1 (accept, start, done, QC fail, done again = 5)', n = 5, n::text);
  select count(*) into n from public.audit_log a where a.entity_id = t1::text and a.action = 'task.verify';
  perform pg_temp.res('24 audit task.verify rows for t1 (pending, rejected, pending, passed = 4)', n = 4, n::text);
  perform pg_temp.res('25 audit task.assignee row for the reassign of t2 + org / quote set',
    exists (select 1 from public.audit_log a where a.entity_id = t2::text and a.action = 'task.assignee'
            and a.quote_id = qa and a.org_id = orgA and (a.changed -> 'to' ->> 'crew_id')::uuid = c2), '');

  -- (9) shape + grants
  perform pg_temp.res('26 trigger zzzz_r311_task_flow on event_tasks, sorts after the existing BEFORE UPDATE triggers',
    exists (select 1 from pg_trigger where tgname = 'zzzz_r311_task_flow' and tgrelid = 'public.event_tasks'::regclass)
    and (select max(tgname::text) from pg_trigger where tgrelid = 'public.event_tasks'::regclass and not tgisinternal
          and tgname::text <> 'zzzz_r311_task_flow' and (tgtype & 2) = 2 and (tgtype & 16) = 16) < 'zzzz_r311_task_flow', '');
  perform pg_temp.res('27 grants kept on live names; kept bodies + logic not callable by the app',
    has_function_privilege('anon', 'public.worker_respond(uuid,uuid,text)', 'execute')
    and has_function_privilege('anon', 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])', 'execute')
    and has_function_privilege('authenticated', 'public.crew_task_respond(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.crew_task_respond(uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.reassign_task(uuid,uuid,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.verify_task(uuid,boolean,text)', 'execute')
    and not has_function_privilege('anon', 'public.worker_respond__pre0311(uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.reassign_task__pre0311(uuid,uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.verify_task__pre0311(uuid,boolean,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r311_tg_task_flow()', 'execute')
    and not has_function_privilege('anon', 'public._r311_worker_respond(uuid,uuid,text)', 'execute'), '');
  perform pg_temp.res('28 live wrappers: marker + empty search_path',
    (select bool_and(position('r92-task-lifecycle-0311' in p.prosrc) > 0 and array_to_string(p.proconfig, ',') like '%search_path=""%')
       from pg_proc p where p.oid in ('public.worker_respond(uuid,uuid,text)'::regprocedure, 'public.crew_task_respond(uuid,text)'::regprocedure,
         'public.reassign_task(uuid,uuid,text,text)'::regprocedure, 'public.verify_task(uuid,boolean,text)'::regprocedure,
         'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'::regprocedure)), '');
end $$;

select name, result from _t311 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R92-TASK-LIFECYCLE-0311: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R92-TASK-LIFECYCLE-0311: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t311;
rollback;
