-- r22-closure-0254.sql - 0254: live close checklist (per-item inventory), "request to close anyway" + approval
-- (admin / coordinator / manager with Closure edit), decline with a note, withdraw, bell + chat posts, activity
-- trail, studio isolation, and the normal close_event left unchanged.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
\i supabase/migrations/0254_closure_checklist_override.sql
drop table if exists _g254; create temp table _g254(name text, result text); grant all on _g254 to anon, authenticated;

create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _g254 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create or replace function pg_temp.closed(p uuid) returns boolean language sql as $$
  select exists (select 1 from public.event_closure where quote_id = p and closed_at is not null) $$;

-- setup (Studio A, Asia/Kolkata). Quotes:
--   ...254c1 confirmed, paid, yesterday; a pending expense claim + an unreturned reservation + a partial check-in
--   ...254c2 confirmed, UNPAID (server balance blocker), yesterday
--   ...254c3 confirmed, paid, event in 10 days (too early)
--   ...254c4 confirmed, paid, yesterday, nothing open (normal close)
--   ...254c5 confirmed, paid, yesterday, pending claim (decline / withdraw path)
--   Studio B: ...254b1 (isolation)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000002';
              q uuid; u uuid; it uuid; cv uuid; begin
  execute 'reset role';
  select id into b from public.organizations where id <> a and id in (select org_id from public.profiles where email = 'b_admin@b.test') limit 1;
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  -- throwaway test database only: clear this suite's own rows so a re-run starts clean
  create temp table _q254 on commit drop as select x::uuid as id from unnest(array['a0000000-0000-4000-8000-0000000254c1','a0000000-0000-4000-8000-0000000254c2',
    'a0000000-0000-4000-8000-0000000254c3','a0000000-0000-4000-8000-0000000254c4','a0000000-0000-4000-8000-0000000254c5','b0000000-0000-4000-8000-0000000254b1']) x;
  delete from public.helm_notice_outbox where kind in ('close_request', 'close_decision')
    and ref_id in (select id from public.event_close_requests where quote_id in (select id from _q254));
  delete from public.event_close_requests where quote_id in (select id from _q254);
  delete from public.event_close_overrides where quote_id in (select id from _q254);
  delete from public.notifications where quote_id in (select id from _q254);
  delete from public.chat_messages where conversation_id in (select id from public.chat_conversations where quote_id in (select id from _q254));
  delete from public.chat_members where conversation_id in (select id from public.chat_conversations where quote_id in (select id from _q254));
  delete from public.chat_conversations where quote_id in (select id from _q254);
  delete from public.event_closure where quote_id in (select id from _q254);
  delete from public.quote_payments where quote_id in (select id from _q254);
  delete from public.quote_consents where quote_id in (select id from _q254);
  delete from public.expense_claims where quote_id in (select id from _q254);
  delete from public.inventory_checkouts where quote_id in (select id from _q254);
  delete from public.inventory_reservations where quote_id in (select id from _q254);
  update public.quotes set status = 'quote', approval_status = 'sent', lifecycle_stage = 'quote' where id in (select id from _q254);
  -- a coordinator and a manager in Studio A (Closure edit), a second sales user (no approver)
  select id into u from auth.users where email = 'a_coord254@a.test'; if u is null then u := auth.seed_user('a_coord254@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_coord254@a.test', 'Cora Coordinator', 'coordinator', a, false, now()) on conflict (id) do update set role = 'coordinator', org_id = a, full_name = 'Cora Coordinator';
  select id into u from auth.users where email = 'a_mgr254@a.test'; if u is null then u := auth.seed_user('a_mgr254@a.test'); end if;
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'a_mgr254@a.test', 'Manu Manager', 'manager', a, false, now()) on conflict (id) do update set role = 'manager', org_id = a, full_name = 'Manu Manager';
  update public.profiles set full_name = 'Sam Sales' where email = 'a_staff@a.test';
  update public.profiles set full_name = 'Ada Admin' where email = 'a_admin@a.test';
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('sales', 'closure', true, true, a, now()), ('coordinator', 'closure', true, true, a, now()), ('manager', 'closure', true, true, a, now()),
    ('coordinator', 'quotes', true, false, a, now()), ('coordinator', 'finance', false, false, a, now()), ('coordinator', 'settlement', false, false, a, now()),
    ('sales', 'closure', true, true, b, now())
    on conflict (role, area, org_id) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id,
                            approval_token, lifecycle_stage, event_date, created_at, updated_at)
  select x.id::uuid, x.code, x.title, 'quote', '{"name":"C254"}'::jsonb, '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}'::jsonb,
         1, 'sent', x.org, gen_random_uuid(), 'quote', x.d, now(), now()
    from (values ('a0000000-0000-4000-8000-0000000254c1', 'A-254-1', 'Close254 One', a, pg_temp.today() - 1),
                 ('a0000000-0000-4000-8000-0000000254c2', 'A-254-2', 'Close254 Two', a, pg_temp.today() - 1),
                 ('a0000000-0000-4000-8000-0000000254c3', 'A-254-3', 'Close254 Three', a, pg_temp.today() + 10),
                 ('a0000000-0000-4000-8000-0000000254c4', 'A-254-4', 'Close254 Four', a, pg_temp.today() - 1),
                 ('a0000000-0000-4000-8000-0000000254c5', 'A-254-5', 'Close254 Five', a, pg_temp.today() - 1),
                 ('b0000000-0000-4000-8000-0000000254b1', 'B-254-1', 'Close254 B', b, pg_temp.today() - 1)) x(id, code, title, org, d)
  on conflict (id) do nothing;
  foreach q in array array['a0000000-0000-4000-8000-0000000254c1','a0000000-0000-4000-8000-0000000254c2','a0000000-0000-4000-8000-0000000254c3',
                           'a0000000-0000-4000-8000-0000000254c4','a0000000-0000-4000-8000-0000000254c5','b0000000-0000-4000-8000-0000000254b1']::uuid[] loop
    insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, created_at)
      values (q, '9999999999', 'Client', true, true, clock_timestamp());
    update public.quotes set approval_status = 'approved', status = 'confirmed', confirmed_at = now() where id = q;
    if q <> 'a0000000-0000-4000-8000-0000000254c2' then
      insert into public.quote_payments(quote_id, amount, status, provider_ref, org_id)
        values (q, 10000, 'paid', 'g254-' || left(q::text, 8) || right(q::text, 4), (select org_id from public.quotes where id = q));
    end if;
  end loop;
  insert into public.expense_claims(quote_id, who, description, amount, status, org_id) values
    ('a0000000-0000-4000-8000-0000000254c1', 'Ravi', 'Taxi', 800, 'pending', a),
    ('a0000000-0000-4000-8000-0000000254c5', 'Ravi', 'Tea', 120, 'pending', a);
  select id into it from public.inventory_items where org_id = a and name = 'Chiavari chair 254';
  if it is null then insert into public.inventory_items(name, total_qty, org_id) values ('Chiavari chair 254', 200, a) returning id into it; end if;
  insert into public.inventory_reservations(item_id, quote_id, qty, status, org_id) values (it, 'a0000000-0000-4000-8000-0000000254c1', 50, 'reserved', a);
  insert into public.inventory_checkouts(item_id, quote_id, qty_out, qty_in, status, written_off, issued_to, org_id)
    values (it, 'a0000000-0000-4000-8000-0000000254c1', 50, 47, 'partial', 3, 'Crew', a);
  -- the event's team chat group (admin is a member)
  insert into public.chat_conversations(org_id, kind, title, quote_id) values (a, 'group', 'Close254 One team', 'a0000000-0000-4000-8000-0000000254c1') returning id into cv;
  insert into public.chat_members(conversation_id, user_id, org_id) values (cv, (select id from auth.users where email = 'a_admin@a.test'), a);
end $$;

-- ---- 1) the checklist ------------------------------------------------------------------------------------------
do $$ declare r text; j jsonb; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('01 review readable by a closure viewer', r like 'ok:%', r);
  j := substr(r, 4)::jsonb;
  perform pg_temp.t('02 claims check fails (any approver)', exists (select 1 from jsonb_array_elements(j -> 'checks') c
    where c ->> 'key' = 'claims' and c ->> 'status' = 'fail' and c ->> 'override' = 'any' and (c ->> 'amount')::numeric = 800), r);
  perform pg_temp.t('03 inventory fails: reservation not marked returned', exists (select 1 from jsonb_array_elements(j -> 'checks') c
    where c ->> 'key' = 'inventory' and c ->> 'status' = 'fail' and c ->> 'override' = 'any'), r);
  perform pg_temp.t('04 per-item table: out 50 / in 47 / missing 3 / written off 3 / reserved open 50', exists (select 1 from jsonb_array_elements(j -> 'inventory') i
    where i ->> 'item' = 'Chiavari chair 254' and (i ->> 'checked_out')::numeric = 50 and (i ->> 'checked_in')::numeric = 47
      and (i ->> 'missing')::numeric = 3 and (i ->> 'written_off')::numeric = 3 and (i ->> 'reserved_open')::numeric = 50 and i ->> 'status' = 'fail'), r);
  perform pg_temp.t('05 balance / event day ok; server not blocked', not (j ->> 'server_blocked')::boolean
    and exists (select 1 from jsonb_array_elements(j -> 'checks') c where c ->> 'key' = 'balance' and c ->> 'status' = 'ok')
    and exists (select 1 from jsonb_array_elements(j -> 'checks') c where c ->> 'key' = 'event_day' and c ->> 'status' = 'ok'), r);
  r := pg_temp.as_try('a_coord254@a.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('06 no finance view -> no amounts in the checklist', r like 'ok:%' and not exists (select 1 from jsonb_array_elements(substr(r, 4)::jsonb -> 'checks') c where c ? 'amount')
    and (substr(r, 4)::jsonb ->> 'can_approve')::boolean, r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c2')::text$q$);
  perform pg_temp.t('07 unpaid: balance fails, admin only, server blocked', (substr(r, 4)::jsonb ->> 'server_blocked')::boolean
    and exists (select 1 from jsonb_array_elements(substr(r, 4)::jsonb -> 'checks') c where c ->> 'key' = 'balance' and c ->> 'override' = 'admin'), r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('08 another studio cannot read the review', r like 'err:42501%', r);
  r := pg_temp.as_try('anon', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('09 anon cannot read the review', r like 'err:42501%', r);
end $$;

-- ---- 2) normal close unchanged ----------------------------------------------------------------------------------
do $$ declare r text; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000254c1', true)::text$q$);
  perform pg_temp.t('10 close_event ignores the new soft checks (unchanged behaviour)', r like 'ok:%' and pg_temp.closed('a0000000-0000-4000-8000-0000000254c1'), r);
  update public.event_closure set closed_at = null where quote_id = 'a0000000-0000-4000-8000-0000000254c1';
  update public.quotes set lifecycle_stage = 'settlement' where id = 'a0000000-0000-4000-8000-0000000254c1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000254c2', true)::text$q$);
  perform pg_temp.t('11 close_event still refuses a balance owed (P0001)', r like 'err:P0001%balance still owed%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000254c4', true)::text$q$);
  perform pg_temp.t('12 a clean event closes normally', r like 'ok:%' and pg_temp.closed('a0000000-0000-4000-8000-0000000254c4'), r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c4', 'nothing to ask for here')::text$q$);
  perform pg_temp.t('13 request on a closed event -> 22023', r like 'err:22023%already closed%', r);
end $$;

-- ---- 3) request -----------------------------------------------------------------------------------------------
do $$ declare r text; n int; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c1', null)::text$q$);
  perform pg_temp.t('20 no reason -> 22023', r like 'err:22023%10 to 1000%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c1', '  short  ')::text$q$);
  perform pg_temp.t('21 reason under 10 characters -> 22023', r like 'err:22023%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c3', 'event not over but asking anyway')::text$q$);
  perform pg_temp.t('22 before the event day -> HL425 (no request)', r like 'err:HL425%', r);
  r := pg_temp.as_try('b_staff@b.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c1', 'other studio trying to close')::text$q$);
  perform pg_temp.t('23 another studio cannot request', r like 'err:42501%', r);
  perform pg_temp.t('24 nothing stored by the refused requests', not exists (select 1 from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c1'), null);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c1', 'Ravi will submit the receipt tomorrow, chairs counted',
       '[{"key":"claims","status":"fail","label":"No expense claims waiting"}]'::jsonb)::text$q$);
  perform pg_temp.t('25 request with a reason -> pending', r like 'ok:%"status": "pending"%', r);
  perform pg_temp.t('26 request does NOT close the event', not pg_temp.closed('a0000000-0000-4000-8000-0000000254c1'), null);
  perform pg_temp.t('27 stored: who / reason / failed checks snapshot / client copy', exists (select 1 from public.event_close_requests x
    where x.quote_id = 'a0000000-0000-4000-8000-0000000254c1' and x.status = 'pending' and x.requested_name = 'Sam Sales'
      and x.requested_role = 'sales' and x.reason like 'Ravi will submit%'
      and x.failed_checks @> '[{"key":"claims"}]'::jsonb and x.failed_checks @> '[{"key":"inventory"}]'::jsonb
      and x.client_checks @> '[{"key":"claims"}]'::jsonb), null);
  perform pg_temp.t('28 audit row close_request', exists (select 1 from public.audit_log where action = 'close_request' and quote_id = 'a0000000-0000-4000-8000-0000000254c1'), null);
  select count(*) into n from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000254c1' and kind = 'event_close_request';
  perform pg_temp.t('29 bell row for the approvers (admin + coordinator + manager)', n = 1 and exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000254c1'
    and kind = 'event_close_request' and detail -> 'notify' @> to_jsonb(array[(select id from auth.users where email = 'a_admin@a.test')::text, (select id from auth.users where email = 'a_coord254@a.test')::text])), n::text);
  perform pg_temp.t('30 system post in the event team chat, admin mentioned', exists (select 1 from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id
    where c.quote_id = 'a0000000-0000-4000-8000-0000000254c1' and m.kind = 'system' and m.sender_id is null and m.body like '%Sam Sales asked to close%'
      and m.meta -> 'mentions' @> to_jsonb(array[(select id from auth.users where email = 'a_admin@a.test')::text])), null);
  perform pg_temp.t('34 request e-mail: admins + coordinator + manager, never the requester; reason + open checks', (select
      j -> 'to' @> '["a_admin@a.test", "a_coord254@a.test", "a_mgr254@a.test"]'::jsonb and not (j -> 'to' @> '["a_staff@a.test"]'::jsonb)
      and j #>> '{data,reason}' like 'Ravi will submit%' and j #>> '{data,requested_name}' = 'Sam Sales'
      and j -> 'data' -> 'failed' @> '["No expense claims waiting"]'::jsonb
    from (select public._r22_close_mail('a0000000-0000-4000-8000-000000000001', x.id, 'close_request') as j
            from public.event_close_requests x where x.quote_id = 'a0000000-0000-4000-8000-0000000254c1' and x.status = 'pending') z), null);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c1', 'second request for the same event')::text$q$);
  perform pg_temp.t('31 one pending request per event (23505)', r like 'err:23505%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('32 review shows the pending request; requester cannot decide it', (substr(r, 4)::jsonb #>> '{pending,status}') = 'pending'
    and not (substr(r, 4)::jsonb #>> '{pending,can_decide}')::boolean and (substr(r, 4)::jsonb #>> '{pending,can_withdraw}')::boolean, r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.event_activity('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('33 activity trail: "Close requested by Sam Sales ... waiting for approval", no raw bell row',
    r like '%Close requested by Sam Sales: Ravi will submit%waiting for approval%' and r not like '%event_close_request ->%', r);
end $$;

-- ---- 4) who may decide --------------------------------------------------------------------------------------------
do $$ declare r text; v_req uuid; begin
  select id into v_req from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c1' and status = 'pending';
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.decide_event_close(%L, true)::text$q$, v_req));
  perform pg_temp.t('40 requester (not admin, not coordinator) cannot approve', r like 'err:42501%', r);
  update public.profiles set role = 'coordinator' where email = 'a_staff@a.test';
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.decide_event_close(%L, true)::text$q$, v_req));
  perform pg_temp.t('41 requester who is a coordinator still cannot approve their own request', r like 'err:42501%own close request%', r);
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
  r := pg_temp.as_try('b_admin@b.test', format($q$select public.decide_event_close(%L, true)::text$q$, v_req));
  perform pg_temp.t('42 another studio''s admin cannot decide', r like 'err:42501%' and not pg_temp.closed('a0000000-0000-4000-8000-0000000254c1'), r);
  update public.role_access set can_edit = false where role = 'coordinator' and area = 'closure' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('a_coord254@a.test', format($q$select public.decide_event_close(%L, true)::text$q$, v_req));
  perform pg_temp.t('43 coordinator without Closure edit (role matrix) cannot approve', r like 'err:42501%', r);
  update public.role_access set can_edit = true where role = 'coordinator' and area = 'closure' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('a_coord254@a.test', format($q$select public.decide_event_close(%L, false, null)::text$q$, v_req));
  perform pg_temp.t('44 decline needs a note', r like 'err:22023%', r);
  perform pg_temp.t('45 still pending + open after refused decisions', exists (select 1 from public.event_close_requests where id = v_req and status = 'pending')
    and not pg_temp.closed('a0000000-0000-4000-8000-0000000254c1'), null);
  -- coordinator approves (only soft checks fail)
  r := pg_temp.as_try('a_coord254@a.test', format($q$select public.decide_event_close(%L, true, 'receipt promised')::text$q$, v_req));
  perform pg_temp.t('46 coordinator with Closure edit approves -> event closed', r like 'ok:%"status": "approved"%' and pg_temp.closed('a0000000-0000-4000-8000-0000000254c1'), r);
  perform pg_temp.t('47 request stamped approved by Cora, decided checks kept', exists (select 1 from public.event_close_requests where id = v_req
    and status = 'approved' and decided_name = 'Cora Coordinator' and decided_role = 'coordinator' and decided_at is not null
    and decision_note = 'receipt promised' and decided_checks @> '[{"key":"claims","status":"fail"}]'::jsonb and not server_override), null);
  perform pg_temp.t('48 audit close_request_approved', exists (select 1 from public.audit_log where action = 'close_request_approved' and quote_id = 'a0000000-0000-4000-8000-0000000254c1'), null);
  perform pg_temp.t('49 requester told (bell decision row lists the requester)', exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000254c1'
    and kind = 'event_close_decision' and detail ->> 'decision' = 'approved'
    and detail -> 'notify' @> to_jsonb(array[(select id from auth.users where email = 'a_staff@a.test')::text])), null);
  r := pg_temp.as_try('a_admin@a.test', format($q$select public.decide_event_close(%L, false, 'too late now')::text$q$, v_req));
  perform pg_temp.t('50 a decided request cannot be decided again', r like 'err:22023%already approved%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.event_activity('a0000000-0000-4000-8000-0000000254c1')::text$q$);
  perform pg_temp.t('51 activity: Closed with override approved by Cora; requested by Sam', r like '%Closed with override approved by Cora Coordinator; requested by Sam Sales: Ravi will submit%', r);
end $$;

-- ---- 4b) e-mail queued in the 0244 Helm notice outbox (recipients resolved at claim time) ------------------------
do $$ declare v_req uuid; j jsonb; v jsonb; v_err text; a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  select id into v_req from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c1' and status = 'approved';
  perform pg_temp.t('52 outbox: one close_request + one close_decision row queued', (select count(*) from public.helm_notice_outbox
    where ref_id = v_req and kind in ('close_request', 'close_decision') and status = 'pending') = 2
    and exists (select 1 from public.helm_notice_outbox where dedupe_key = 'close_decision:' || v_req::text), null);
  j := public._r22_close_mail(a, v_req, 'close_decision');
  perform pg_temp.t('53 decision e-mail goes to the requester only, with who / note / event', j -> 'to' = jsonb_build_array('a_staff@a.test')
    and j #>> '{data,decided_name}' = 'Cora Coordinator' and j #>> '{data,note}' = 'receipt promised' and j #>> '{data,event}' = 'Close254 One'
    and j #>> '{data,status}' = 'approved' and j #>> '{data,event_date}' ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$', j::text);
  perform pg_temp.t('54 request e-mail skipped once the request is no longer pending', public._r22_close_mail(a, v_req, 'close_request') is null, null);
  perform pg_temp.t('55 another studio id resolves nothing', public._r22_close_mail('b0000000-0000-4000-8000-000000000002', v_req, 'close_decision') is null, null);
  -- the patched 0244 claim hands the decision row out (inside a rolled-back block: nothing is claimed for real)
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v := public.helm_notice_outbox_claim(100);
    raise exception 'r254-rollback';
  exception when others then v_err := sqlerrm;
  end;
  perform pg_temp.t('56 claim: decision row out to the requester; request row skipped', v_err = 'r254-rollback'
    and exists (select 1 from jsonb_array_elements(v) e where e ->> 'kind' = 'close_decision' and e -> 'to' = jsonb_build_array('a_staff@a.test')
                  and e #>> '{data,requested_name}' = 'Sam Sales')
    and not exists (select 1 from jsonb_array_elements(v) e where e ->> 'kind' = 'close_request' and (e -> 'data' ->> 'quote_id') = 'a0000000-0000-4000-8000-0000000254c1'),
    coalesce(v_err, '') || ' ' || coalesce(v::text, ''));
  perform pg_temp.t('57 outbox rows untouched by the test claim', (select count(*) from public.helm_notice_outbox where ref_id = v_req and claimed_at is null and sent_at is null) = 2, null);
end $$;

-- ---- 5) server blockers need an admin approver -------------------------------------------------------------------
do $$ declare r text; v_req uuid; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c2', 'Client pays the balance by bank next week')::text$q$);
  perform pg_temp.t('60 request on an unpaid event -> pending', r like 'ok:%pending%', r);
  select id into v_req from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c2' and status = 'pending';
  r := pg_temp.as_try('a_mgr254@a.test', format($q$select public.decide_event_close(%L, true)::text$q$, v_req));
  perform pg_temp.t('61 manager cannot approve past the balance gate (admin only)', r like 'err:42501%Only an admin can approve closing past: Client balance is 0%'
    and not pg_temp.closed('a0000000-0000-4000-8000-0000000254c2'), r);
  r := pg_temp.as_try('a_admin@a.test', format($q$select public.decide_event_close(%L, true, 'agreed with owner')::text$q$, v_req));
  perform pg_temp.t('62 admin approves -> closed, server override recorded', r like 'ok:%approved%' and pg_temp.closed('a0000000-0000-4000-8000-0000000254c2')
    and exists (select 1 from public.event_close_requests where id = v_req and server_override), r);
  perform pg_temp.t('63 the 0049 override row is written too (same reason)', exists (select 1 from public.event_close_overrides
    where quote_id = 'a0000000-0000-4000-8000-0000000254c2' and reason like 'Close request approved by Ada Admin (requested by Sam Sales): Client pays%'), null);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.event_closure_review('a0000000-0000-4000-8000-0000000254c2')::text$q$);
  perform pg_temp.t('64 review: the 0049 row is not listed twice', r like 'ok:%' and jsonb_array_length(substr(r, 4)::jsonb -> 'overrides') = 0, r);
end $$;

-- ---- 6) decline + withdraw ----------------------------------------------------------------------------------------
do $$ declare r text; v_req uuid; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c5', 'Tea claim is fine, close it please')::text$q$);
  select id into v_req from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c5' and status = 'pending';
  r := pg_temp.as_try('a_mgr254@a.test', format($q$select public.decide_event_close(%L, false, 'Approve the claim first')::text$q$, v_req));
  perform pg_temp.t('70 manager declines with a note', r like 'ok:%declined%' and not pg_temp.closed('a0000000-0000-4000-8000-0000000254c5'), r);
  perform pg_temp.t('71 declined row: who / note; requester told', exists (select 1 from public.event_close_requests where id = v_req and status = 'declined'
    and decided_name = 'Manu Manager' and decision_note = 'Approve the claim first')
    and exists (select 1 from public.notifications where quote_id = 'a0000000-0000-4000-8000-0000000254c5' and kind = 'event_close_decision'
      and detail ->> 'decision' = 'declined' and detail -> 'notify' = to_jsonb(array[(select id from auth.users where email = 'a_staff@a.test')::text])), null);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.event_activity('a0000000-0000-4000-8000-0000000254c5')::text$q$);
  perform pg_temp.t('72 activity: declined by Manu', r like '%Close request declined by Manu Manager: Approve the claim first%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.request_event_close('a0000000-0000-4000-8000-0000000254c5', 'Asking again after the decline')::text$q$);
  perform pg_temp.t('73 a new request after a decline is allowed', r like 'ok:%pending%', r);
  select id into v_req from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c5' and status = 'pending';
  r := pg_temp.as_try('b_admin@b.test', format($q$select public.withdraw_event_close_request(%L)::text$q$, v_req));
  perform pg_temp.t('74 another studio cannot withdraw', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', format($q$select public.withdraw_event_close_request(%L)::text$q$, v_req));
  perform pg_temp.t('75 requester withdraws; row kept', r like 'ok:%withdrawn%' and exists (select 1 from public.event_close_requests where id = v_req and status = 'withdrawn'), r);
  perform pg_temp.t('76 every request row kept (2 on this event)', (select count(*) from public.event_close_requests where quote_id = 'a0000000-0000-4000-8000-0000000254c5') = 2, null);
end $$;

-- ---- 7) bell visibility, isolation, write lockdown, grants ----------------------------------------------------------
do $$ declare r text; begin
  update public.role_access set can_view = false, can_edit = false where role = 'sales' and area = 'closure' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('80 bell hides close request rows from a non-approver without Closure view', r like 'ok:%' and r not like '%event_close_request%' and r not like '%event_close_decision%', r);
  update public.role_access set can_view = true, can_edit = true where role = 'sales' and area = 'closure' and org_id = 'a0000000-0000-4000-8000-000000000001';
  r := pg_temp.as_try('a_admin@a.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('81 admin bell shows the request', r like '%event_close_request%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.bell_feed(100)::text$q$);
  perform pg_temp.t('82 another studio''s bell never sees it', r like 'ok:%' and r not like '%event_close_%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select count(*)::text from public.event_close_requests$q$);
  perform pg_temp.t('83 RLS: another studio reads 0 requests', r = 'ok:0', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select count(*)::text from public.event_close_requests where quote_id::text like '%254c%'$q$);
  perform pg_temp.t('84 RLS: own studio reads its requests', r = 'ok:4', r);
  r := pg_temp.as_try('a_admin@a.test', $q$insert into public.event_close_requests(org_id, quote_id, reason) values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000254c3', 'direct insert attempt') returning id::text$q$);
  perform pg_temp.t('85 no direct insert from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$update public.event_close_requests set status = 'pending' where quote_id = 'a0000000-0000-4000-8000-0000000254c5' returning id::text$q$);
  perform pg_temp.t('86 no direct update from the API', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$delete from public.event_close_requests returning id::text$q$);
  perform pg_temp.t('87 no delete from the API', r like 'err:42501%', r);
  perform pg_temp.t('88 internal helpers not callable by authenticated', not has_function_privilege('authenticated', 'public._r22_close_checks(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r22_announce(uuid, uuid, uuid, text, text, jsonb, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.request_event_close(uuid, text, jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.decide_event_close(uuid, boolean, text)', 'execute'), null);
  perform pg_temp.t('89 wrappers carry the marker', position('r22-closure-0254' in (select prosrc from pg_proc where oid = 'public.bell_feed(integer)'::regprocedure)) > 0
    and position('r22-closure-0254' in (select prosrc from pg_proc where oid = 'public.event_activity(uuid)'::regprocedure)) > 0, null);
end $$;

select name, result from _g254 order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R22-CLOSURE-0254: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R22-CLOSURE-0254: FAILURES ' || count(*) filter (where result <> 'PASS') || '/' || count(*) end as summary from _g254;
