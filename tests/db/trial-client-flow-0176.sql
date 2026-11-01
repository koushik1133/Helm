-- trial-client-flow-0176.sql -- 0176: in an ACTIVE trial studio the client on the approval portal
-- (not signed in) can "Test mode - confirm" without any OTP; the event then moves to Confirmed so the
-- event group, adding members and the booklet link work; nothing is sent (outbox rows skipped).
-- Paid studios still require the real OTP. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps; re-apply 0176 inside this rolled-back tx
\ir ../../supabase/migrations/0176_trial_client_flow.sql
-- R113: the 0322 test-mode RPC + triggers (grant sweeps in earlier suites; re-applied inside this rolled-back tx)
\ir ../../supabase/migrations/0322_r113_trial_approval_test_mode.sql
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.sent(p_org uuid) returns bigint language sql as $$
  select (select count(*) from public.comms_outbox where org_id = p_org and status <> 'skipped')
       + (select count(*) from public.pkg_outbox where org_id = p_org and status <> 'skipped')
       + (select count(*) from public.assign_notify_outbox where org_id = p_org and status <> 'skipped');
$$;

-- ---- 1) trial: the client (not signed in) confirms without OTP ------------------------------------
do $$ declare a uuid; q record; r jsonb; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true, block_trial_outbound = true where id;
  a := pg_temp.trial('tc_a@t.test'); perform pg_temp.put('A', a::text);
  select * into q from public.quotes where org_id = a and approval_status = 'sent' limit 1;
  perform pg_temp.put('AQ', q.id::text); perform pg_temp.put('AT', q.approval_token::text);
  perform pg_temp.anon();
  perform pg_temp.res('01 portal (anon) sees Test mode in trial', public.trial_test_mode_for_token(q.approval_token));
  -- R113 (0322): the old confirm without a code is refused in a trial (no code row may be stored outside the test)
  r := null;
  begin r := public.trial_test_approve(q.approval_token, null, E'Demo · Client', 'v1', 'I agree (test)', 'test');
  exception when others then r := jsonb_build_object('err', sqlstate, 'hint', 'raised'); end;
  perform pg_temp.su();
  perform pg_temp.res('06 R113: trial_test_approve without the test code is refused', coalesce(r ->> 'err', '') = '42501', coalesce(r::text, '<null>'));
  perform pg_temp.anon();
  -- R113 (0322): the client page's "Simulate approval" with the test code 000000
  r := public.trial_test_approve_code(q.approval_token, '000000', null, E'Demo · Client', 'v1', 'I agree (test)', 'test');
  perform pg_temp.su();
  perform pg_temp.res('02 portal (anon) Test mode - simulate approval (code 000000) approves', coalesce((r ->> 'approved')::boolean, false), r::text);
  select * into q from public.quotes where id = q.id;
  perform pg_temp.res('03 event moved on: approved + stage confirmed + status confirmed',
    q.approval_status = 'approved' and q.lifecycle_stage = 'confirmed' and q.status = 'confirmed',
    q.approval_status || '/' || q.lifecycle_stage || '/' || q.status);
  perform pg_temp.res('04 consent recorded honestly (verified_via_otp false) + audit skip row',
    exists (select 1 from public.quote_consents where quote_id = q.id and not verified_via_otp)
    and exists (select 1 from public.audit_log where entity_id = q.id::text and action = 'approval.trial_test_skip'));
  perform pg_temp.res('05 nothing queued to send (outbox rows skipped)', pg_temp.sent(a) = 0, pg_temp.sent(a)::text);
  perform pg_temp.res('07 R113: the consent is flagged test_mode + audit approval.test_mode',
    exists (select 1 from public.quote_consents where quote_id = q.id and test_mode)
    and exists (select 1 from public.audit_log where entity_id = q.id::text and action = 'approval.test_mode'));
exception when others then perform pg_temp.su(); insert into _uf values ('0x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) next steps: event group, add members, booklet link, portal --------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; qid uuid := pg_temp.get('AQ')::uuid; cid uuid; u2 uuid; r jsonb; e text; begin
  perform pg_temp.su();
  u2 := pg_temp.newuser('tc_a2@t.test'); update public.profiles set org_id = a, role = 'manager' where id = u2;
  perform pg_temp.login('tc_a@t.test');
  cid := public.create_event_group(qid, null);
  perform pg_temp.res('10 event group created after the trial confirm', cid is not null);
  e := pg_temp.try(format('select public.chat_add_members(%L::uuid, array[%L::uuid])', cid, u2));
  perform pg_temp.su();
  perform pg_temp.res('11 member added to the group', e = '' and exists (select 1 from public.chat_members where conversation_id = cid and user_id = u2), e);
  perform pg_temp.login('tc_a@t.test');
  e := pg_temp.try(format('select public.booklet_share(%L::uuid, 30, null, null, null)', qid));
  perform pg_temp.su();
  perform pg_temp.res('12 client booklet link created', e = '', e);
  perform pg_temp.anon();
  e := pg_temp.try(format('select public.public_get_portal(%L::uuid)', pg_temp.get('AT')));
  perform pg_temp.su();
  perform pg_temp.res('13 client portal opens after confirm', e = '', e);
  perform pg_temp.res('14 still nothing sent for the trial studio', pg_temp.sent(a) = 0, pg_temp.sent(a)::text);
exception when others then perform pg_temp.su(); insert into _uf values ('1x next', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) refusals: other studio member, paid studio, ended trial ----------------------------------
do $$ declare b uuid; q record; r jsonb; begin
  perform pg_temp.su();
  b := pg_temp.trial('tc_b@t.test');
  select * into q from public.quotes where org_id = b and approval_status = 'sent' limit 1;
  perform pg_temp.login('tc_a@t.test');
  r := public.trial_test_approve(q.approval_token, null, 'x', 'v1', 'x', 'x');
  perform pg_temp.su();
  perform pg_temp.res('20 signed-in member of another studio is refused', r ->> 'error' = 'trial_test_unavailable', r::text);
  -- paid studio (fixture org A, quote sent with a token)
  select * into q from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01';
  perform pg_temp.anon();
  perform pg_temp.res('21 paid studio: portal shows no Test mode', not public.trial_test_mode_for_token(q.approval_token));
  r := public.trial_test_approve(q.approval_token, '+919876543210', 'x', 'v1', 'x', 'x');
  perform pg_temp.su();
  perform pg_temp.res('22 paid studio: skip refused, OTP still required', r ->> 'error' = 'trial_test_unavailable', r::text);
  perform pg_temp.res('23 paid studio: quote untouched', (select approval_status = 'sent' and status = 'quote' from public.quotes where id = q.id));
  perform pg_temp.login('a_admin@a.test');
  r := public.trial_test_approve(q.approval_token, '+919876543210', 'x', 'v1', 'x', 'x');
  perform pg_temp.su();
  perform pg_temp.res('24 paid studio: even its own admin cannot skip', r ->> 'error' = 'trial_test_unavailable', r::text);
  -- ended trial
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = b;
  -- 0236: test mode follows the 0183 effective end; a later subscription end day is an approved extension
  update public.studio_subscriptions set trial_ends_at = current_date - 2 where org_id = b;
  select * into q from public.quotes where org_id = b and approval_status = 'sent' limit 1;
  perform pg_temp.anon();
  r := public.trial_test_approve(q.approval_token, null, 'x', 'v1', 'x', 'x');
  perform pg_temp.su();
  perform pg_temp.res('25 ended trial: skip refused', r ->> 'error' = 'trial_test_unavailable', r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('2x refuse', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-CLIENT-FLOW-0176: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-CLIENT-FLOW-0176: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
