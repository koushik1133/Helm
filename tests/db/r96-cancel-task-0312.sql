-- r96-cancel-task-0312.sql - 0312: the office cancels a crew task with a reason.
-- Proves: Staff edit only (sales / other studio / anon refused); assigned / accepted / in_progress -> cancelled;
-- completed / cancelled / rejected / unassigned refused with a friendly message; reason required + trimmed, 3-300;
-- row kept with cancel_reason / cancelled_at / cancelled_by; one task.cancel audit row with the reason; an open-shift
-- claim is withdrawn and the filled shift opens again; the cancel columns cannot be written directly by the app;
-- the crew link refuses to act on a cancelled task; grants. Re-applies itself twice. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0312_r96_cancel_task.sql
\ir ../../supabase/migrations/0312_r96_cancel_task.sql
set client_min_messages = warning;
begin;
create temp table _t312(name text, result text); grant all on _t312 to anon, authenticated, service_role;
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
begin insert into _t312 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return '';
exception when others then get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || coalesce(h, '') || ' | ' || sqlerrm; end $$;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; begin execute p_sql into r; return r;
exception when others then return jsonb_build_object('error', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.st(p uuid) returns text language sql as $$ select status from public.event_tasks where id = p $$;

do $$
declare
  qa uuid := 'a0000000-0000-4000-8000-00000000da01'; orgA uuid := 'a0000000-0000-4000-8000-000000000001';
  tok uuid := 'f3120000-0000-4000-8000-000000000001'; p1 text := '+919312000001';
  c1 uuid; c2 uuid; ta uuid; tb uuid; tc uuid; td uuid; te uuid; tf uuid; tg uuid; th uuid; sh uuid;
  r jsonb; e text; n int; v_admin uuid; v_cnt int;
begin
  perform pg_temp.su();
  select id into v_admin from auth.users where email = 'a_admin@a.test';
  insert into public.crew_members(name, phone, org_id, active) values ('R312 One', p1, orgA, true) returning id into c1;
  insert into public.crew_members(name, phone, org_id, active) values ('R312 Two', '+919312000002', orgA, true) returning id into c2;
  insert into public.work_tokens(token, quote_id, phone, name, org_id, expires_at) values (tok, qa, p1, 'R312 One', orgA, now() + interval '5 days');
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 a', 1, c1, 'R312 One', p1, 'assigned') returning id into ta;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 b', 2, c1, 'R312 One', p1, 'accepted') returning id into tb;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 c', 3, c1, 'R312 One', p1, 'in_progress') returning id into tc;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 d', 4, c1, 'R312 One', p1, 'completed') returning id into td;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 e', 5, c1, 'R312 One', p1, 'rejected') returning id into te;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, status)
    values (qa, orgA, 'Decor', 'R312 f', 6, 'unassigned') returning id into tf;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Crew', 'R312 shift', 7, c2, 'R312 Two', '+919312000002', 'accepted') returning id into tg;
  insert into public.event_tasks(quote_id, org_id, category, title, seq, crew_id, assignee_name, assignee_phone, status)
    values (qa, orgA, 'Decor', 'R312 h', 8, c1, 'R312 One', p1, 'assigned') returning id into th;
  -- an open shift (1 place) filled by c2's claim, which made task tg (accepted)
  insert into public.open_shifts(org_id, quote_id, title, shift_date, needed, status, closed_at)
    values (orgA, qa, 'R312 Waiter', current_date + 3, 1, 'filled', now()) returning id into sh;
  insert into public.open_shift_claims(org_id, shift_id, quote_id, crew_id, status, task_id, decided_at)
    values (orgA, sh, qa, c2, 'approved', tg, now());

  -- (1) permissions
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.cancel_task(%L, ''no longer needed'')', ta));
  perform pg_temp.su();
  perform pg_temp.res('01 anon refused (no execute)', e like '42501%' and pg_temp.st(ta) = 'assigned', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format('select public.cancel_task(%L, ''no longer needed'')', ta));
  perform pg_temp.su();
  perform pg_temp.res('02 sales (no Staff edit) refused', e like '42501%' and pg_temp.st(ta) = 'assigned', e);
  perform pg_temp.login('b_admin@b.test');
  e := pg_temp.try(format('select public.cancel_task(%L, ''no longer needed'')', ta));
  perform pg_temp.su();
  perform pg_temp.res('03 admin of another studio: task not found', e like 'P0002%' and pg_temp.st(ta) = 'assigned', e);

  -- (2) reason validation
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.cancel_task(%L, null)', ta));
  perform pg_temp.res('04 reason missing refused', e like '22023 r312_reason%', e);
  e := pg_temp.try(format('select public.cancel_task(%L, ''   ab   '')', ta));
  perform pg_temp.res('05 reason under 3 chars after trim refused', e like '22023 r312_reason%', e);
  e := pg_temp.try(format('select public.cancel_task(%L, %L)', ta, repeat('x', 301)));
  perform pg_temp.res('06 reason over 300 chars refused', e like '22023 r312_reason%', e);
  perform pg_temp.su();
  perform pg_temp.res('07 refused calls left the task alone', pg_temp.st(ta) = 'assigned'
    and (select cancel_reason from public.event_tasks where id = ta) is null, pg_temp.st(ta));

  -- (3) allowed moves
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format('select public.cancel_task(%L, ''  Client   moved the date  '')', ta));
  perform pg_temp.su();
  perform pg_temp.res('08 assigned -> cancelled, reason trimmed + spaces squeezed, who / when stored',
    r ->> 'ok' = 'true' and pg_temp.st(ta) = 'cancelled'
    and (select cancel_reason = 'Client moved the date' and cancelled_by = v_admin and cancelled_at is not null
           from public.event_tasks where id = ta), r::text);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format('select public.cancel_task(%L, %L)', tb, repeat('y', 300)));
  perform pg_temp.su();
  perform pg_temp.res('09 accepted -> cancelled (300 chars ok)', r ->> 'ok' = 'true' and pg_temp.st(tb) = 'cancelled', r::text);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format('select public.cancel_task(%L, ''rain'')', tc));
  perform pg_temp.su();
  perform pg_temp.res('10 in_progress -> cancelled', r ->> 'ok' = 'true' and pg_temp.st(tc) = 'cancelled', r::text);

  -- (4) refused states
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.cancel_task(%L, ''again please'')', ta));
  perform pg_temp.res('11 already cancelled refused (friendly)', e like '22023 r312_not_cancellable | This task is already cancelled%', e);
  e := pg_temp.try(format('select public.cancel_task(%L, ''too late'')', td));
  perform pg_temp.res('12 completed refused', e like '22023 r312_not_cancellable | This task is already done%', e);
  e := pg_temp.try(format('select public.cancel_task(%L, ''not needed'')', te));
  perform pg_temp.res('13 rejected refused (reassign instead)', e like '22023 r312_not_cancellable%reassign%', e);
  e := pg_temp.try(format('select public.cancel_task(%L, ''not needed'')', tf));
  perform pg_temp.su();
  perform pg_temp.res('14 unassigned refused; states unchanged', e like '22023 r312_not_cancellable%'
    and pg_temp.st(td) = 'completed' and pg_temp.st(te) = 'rejected' and pg_temp.st(tf) = 'unassigned', e);

  -- (5) audit: one task.cancel row with the reason; 0311 still writes task.status
  select count(*) into n from public.audit_log a where a.entity_id = ta::text and a.action = 'task.cancel';
  perform pg_temp.res('15 one task.cancel audit row with reason, from, org, quote, actor', n = 1 and exists (
    select 1 from public.audit_log a where a.entity_id = ta::text and a.action = 'task.cancel'
      and a.changed ->> 'reason' = 'Client moved the date' and a.changed ->> 'from' = 'assigned'
      and a.org_id = orgA and a.quote_id = qa and a.actor = v_admin), n::text);
  perform pg_temp.res('16 0311 task.status row (assigned -> cancelled) still written',
    exists (select 1 from public.audit_log a where a.entity_id = ta::text and a.action = 'task.status' and a.changed ->> 'to' = 'cancelled'), '');

  -- (6) open shift: cancelling the claimed (accepted) task frees the place
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format('select public.cancel_task(%L, ''crew member is sick'')', tg));
  perform pg_temp.su();
  perform pg_temp.res('17 cancel an accepted open-shift task', r ->> 'ok' = 'true' and pg_temp.st(tg) = 'cancelled', r::text);
  perform pg_temp.res('18 the claim is withdrawn (task cancelled)', exists (select 1 from public.open_shift_claims c
    where c.shift_id = sh and c.status = 'withdrawn' and c.decline_reason = 'the task was cancelled'), '');
  perform pg_temp.res('19 the filled shift is open again', (select status = 'open' and closed_at is null from public.open_shifts where id = sh), '');

  -- (7) the cancel columns cannot be written directly by the app; SQL by hand is free
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('update public.event_tasks set cancel_reason = ''sneaky'' where id = %L', th));
  perform pg_temp.su();
  perform pg_temp.res('20 direct app write of cancel_reason refused', e like '42501 r312_cancel_cols%'
    and (select cancel_reason from public.event_tasks where id = th) is null, e);
  e := pg_temp.try(format('update public.event_tasks set cancel_reason = ''fixed by hand'' where id = %L', th));
  perform pg_temp.res('21 SQL by hand can repair the column', e = '', e);
  update public.event_tasks set cancel_reason = null where id = th;

  -- (8) the crew link cannot act on a cancelled task
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''accept'')', tok, ta));
  perform pg_temp.su();
  perform pg_temp.res('22 crew accept on a cancelled task refused, still cancelled',
    coalesce(r ->> 'ok', 'false') = 'false' and pg_temp.st(ta) = 'cancelled', r::text);
  perform pg_temp.anon();
  r := pg_temp.j(format('select public.worker_respond(%L, %L, ''complete'')', tok, tb));
  perform pg_temp.su();
  perform pg_temp.res('23 crew "done" on a cancelled task refused, still cancelled', pg_temp.st(tb) = 'cancelled', r::text);

  -- (9) nothing deleted + shape + grants
  select count(*) into v_cnt from public.event_tasks where id in (ta, tb, tc, td, te, tf, tg, th);
  perform pg_temp.res('24 every task row kept', v_cnt = 8, v_cnt::text);
  perform pg_temp.res('25 grants: authenticated yes, anon / public no; guard not callable',
    has_function_privilege('authenticated', 'public.cancel_task(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.cancel_task(uuid,text)', 'execute')
    and not exists (select 1 from pg_proc p, aclexplode(p.proacl) x where p.oid = 'public.cancel_task(uuid,text)'::regprocedure and x.grantee = 0)
    and not has_function_privilege('authenticated', 'public._r312_tg_cancel_cols()', 'execute'), '');
  perform pg_temp.res('26 cancel_task: definer, empty search_path, marker; 0311 trigger still sorts last',
    (select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r96-cancel-task-0312' in p.prosrc) > 0
       from pg_proc p where p.oid = 'public.cancel_task(uuid,text)'::regprocedure)
    and (select max(tgname::text) from pg_trigger where tgrelid = 'public.event_tasks'::regclass and not tgisinternal
          and (tgtype & 2) = 2 and (tgtype & 16) = 16) = 'zzzz_r311_task_flow', '');
  perform pg_temp.res('27 applied twice: one guard trigger, one cancel_task, one length check',
    (select count(*) from pg_trigger where tgname = 'zz_r312_cancel_cols') = 1
    and (select count(*) from pg_proc where proname = 'cancel_task' and pronamespace = 'public'::regnamespace) = 1
    and (select count(*) from pg_constraint where conname = 'event_tasks_cancel_reason_len') = 1, '');
end $$;

select name, result from _t312 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R96-CANCEL-TASK-0312: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R96-CANCEL-TASK-0312: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _t312;
rollback;
