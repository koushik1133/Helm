-- notification-task-ref.sql - 0066: task notifications carry detail.task_id (same event only).
-- Fixture: quoteA (org A), quoteB (org B). Rolled back at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tr(name text, result text);
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.ins(p_q uuid, p_kind text, p_to text, p_detail jsonb) returns jsonb language plpgsql as $$
declare d jsonb; begin
  insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id)
    values (p_q, 'sms', p_to, p_kind, 'simulated', p_detail, (select org_id from public.quotes where id = p_q))
    returning detail into d;
  return d; end $$;

do $$ declare qa uuid; qb uuid; oa uuid; ob uuid; t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); t3 uuid := gen_random_uuid(); tb uuid := gen_random_uuid(); d jsonb; begin
  set local session_replication_role = origin;
  select id, org_id into qa, oa from public.quotes where code = 'A-0001';
  select id, org_id into qb, ob from public.quotes where code = 'B-0001';
  insert into public.event_tasks(id, quote_id, category, title, seq, assignee_name, assignee_phone, status, org_id, created_at) values
    (t1, qa, 'decor', 'Stage setup', 1, 'Ravi', '+919000000001', 'assigned', oa, now() - interval '1 hour'),
    (t2, qa, 'decor', 'Lights', 2, 'Ravi', '+919000000001', 'assigned', oa, now()),
    (t3, qa, 'decor', 'Stage setup', 3, 'Sita', '+919000000002', 'accepted', oa, now()),
    (tb, qb, 'decor', 'Stage setup', 1, 'Ravi', '+919000000001', 'assigned', ob, now());

  d := pg_temp.ins(qa, 'task_accept', null, jsonb_build_object('task', 'Lights', 'worker', 'Ravi'));
  perform pg_temp.res('01 task_accept gets task_id by title', d ->> 'task_id' = t2::text, d::text);
  perform pg_temp.res('02 existing keys kept', d ->> 'task' = 'Lights' and d ->> 'worker' = 'Ravi', d::text);
  d := pg_temp.ins(qa, 'task_reminder', '+919000000002', jsonb_build_object('task', 'Stage setup'));
  perform pg_temp.res('03 same title: recipient phone wins', d ->> 'task_id' = t3::text, d::text);
  d := pg_temp.ins(qa, 'task_assigned', '+919000000001', jsonb_build_object('count', 2, 'token', 'x'));
  perform pg_temp.res('04 task_assigned -> newest assigned task for that phone', d ->> 'task_id' = t2::text, d::text);
  perform pg_temp.res('05 token still redacted (0042 untouched)', not (d ? 'token'), d::text);
  d := pg_temp.ins(qa, 'task_complete', null, jsonb_build_object('task', 'Nope'));
  perform pg_temp.res('06 no match -> nothing added', not (d ? 'task_id'), d::text);
  d := pg_temp.ins(qa, 'task_start', null, jsonb_build_object('task', 'Stage setup', 'task_id', tb));
  perform pg_temp.res('07 existing task_id never overwritten', d ->> 'task_id' = tb::text, d::text);
  d := pg_temp.ins(qb, 'task_due', null, jsonb_build_object('task', 'Lights'));
  perform pg_temp.res('08 other event task never used', not (d ? 'task_id'), d::text);
  d := pg_temp.ins(qa, 'payment_link', null, jsonb_build_object('amount', 5));
  perform pg_temp.res('09 non-task kinds untouched', d = '{"amount":5}'::jsonb, d::text);
  d := pg_temp.ins(qa, 'task_assigned', null, null);
  perform pg_temp.res('10 null detail ok', d is null, coalesce(d::text, 'null'));
  perform pg_temp.res('11 authenticated cannot execute', not has_function_privilege('authenticated', 'public._n66_tg_task_ref()', 'EXECUTE'));
  perform pg_temp.res('12 trigger installed', exists (select 1 from pg_trigger where tgname = 'zc_n66_task_ref' and tgrelid = 'public.notifications'::regclass));
end $$;

select name, result from _tr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 and count(*) = 12
            then format('NOTIFICATION-TASK-REF: ALL PASS (%s/%s)', count(*), count(*))
            else format('NOTIFICATION-TASK-REF: %s FAILED of %s', count(*) filter (where result <> 'PASS'), count(*)) end as summary
  from _tr;
rollback;
