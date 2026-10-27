-- r32b-round2-0282.sql -- review round 2 fixes inside 0282 (owner-authorised): price decrease on a confirmed / paid event
-- (R2-BIZ-NEW-1), change request below paid (R2-BIZ low), close requests + close_owed + the balance label (R2-BIZ / UX),
-- settle_milestone + record_settlement_payment after closing (R2-BIZ-NEW-2 / -3), joining counts members only + any
-- subscription status keeps the plan limit (BIZ-03 / referral reviewer), admin_create_user refusals counted (R2-AUTH-02),
-- sample_version / sample_cloned_at guarded. Every scenario runs in its own sub-transaction that is undone at its end.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
set client_min_messages = error;
\ir ../../supabase/migrations/0282_r32_security_review.sql
\ir ../../supabase/migrations/0282_r32_security_review.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid default 'a0000000-0000-4000-8000-000000000001') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, must_change_password = false;
  return u;
end $$;
create or replace function pg_temp.access(p_role text, p_area text, p_view boolean, p_edit boolean) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    values ('a0000000-0000-4000-8000-000000000001', p_role, p_area, p_view, p_edit, now())
  on conflict (org_id, role, area) do update set can_view = excluded.can_view, can_edit = excluded.can_edit;
end $$;
-- studio A's fixture event: confirmed, priced 236000, event day over, 100000 paid
create or replace function pg_temp.paid_event() returns void language plpgsql as $$
begin
  perform pg_temp.su();
  update public.quotes set status = 'confirmed', approval_status = 'approved', event_date = current_date - 3
   where id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.payment_milestones where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  -- a clean start whatever earlier suites left behind (inside each scenario's undone sub-transaction)
  set local session_replication_role = replica;
  delete from public.quote_payments where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.change_requests where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.event_refunds where quote_id = 'a0000000-0000-4000-8000-00000000da01';
  set local session_replication_role = origin;
  update public.quotes set pricing = '{"total": 236000, "gstPct": 18, "discount": 0, "subtotal": 200000}'::jsonb
   where id = 'a0000000-0000-4000-8000-00000000da01';
  delete from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and area in ('discount_approve', 'close_owed');
  perform pg_temp.login('a_admin@a.test');
  perform public.record_payment('a0000000-0000-4000-8000-00000000da01', 100000, 'cash', null, null, null, 'r32b-k1');
  perform pg_temp.su();
end $$;
-- every scenario: do the work in a sub-transaction, keep the answers in a local array, undo, then record them
create or replace function pg_temp.keep(p_out text[], p_name text, p_ok boolean, p_detail text default '') returns text[] language sql as $$
  select p_out || (p_name || E'\t' || case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end) $$;
grant execute on function pg_temp.keep(text[], text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.flush(p_out text[]) returns void language plpgsql as $$
declare x text; begin
  perform pg_temp.su();
  foreach x in array coalesce(p_out, '{}') loop insert into _rs values (split_part(x, E'\t', 1), split_part(x, E'\t', 2)); end loop;
end $$;

-- ================================================================================= R2-BIZ-NEW-1 price decrease after confirmation
do $$ declare o text[] := '{}'; v text; t0 numeric; begin
  begin
    perform pg_temp.paid_event();
    select (pricing ->> 'total')::numeric into t0 from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01';
    perform pg_temp.login('a_staff@a.test');      -- sales: quotes edit, no "Approve discounts"
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"discount":115254}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    o := pg_temp.keep(o, '01 BIZ-NEW-1 sales cannot lower a confirmed + paid event''s total with a discount (no approval)', v like '42501%lower the price%', v);
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"gstPct":0}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    o := pg_temp.keep(o, '02 BIZ-NEW-1 ... nor by changing the tax', v like '42501%lower the price%', v);
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"taxExempt":true}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    perform pg_temp.su();
    o := pg_temp.keep(o, '03 BIZ-NEW-1 ... nor by marking the client tax-exempt; the total is unchanged',
      v like '42501%' and (select (pricing ->> 'total')::numeric from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01') = t0, v);
    perform pg_temp.login('a_staff@a.test');
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"subtotal":300000}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    o := pg_temp.keep(o, '04 BIZ-NEW-1 a price INCREASE on the confirmed event still works for sales', v = '', v);
    perform pg_temp.access('sales', 'discount_approve', true, true);
    perform pg_temp.login('a_staff@a.test');
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"discount":1000}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    perform pg_temp.su();
    o := pg_temp.keep(o, '05 BIZ-NEW-1 with "Approve discounts" sales may lower it - and it is in the activity log',
      v = '' and exists (select 1 from public.audit_log a where a.action = 'price_decrease' and a.quote_id = 'a0000000-0000-4000-8000-00000000da01'
                          and a.actor = (select id from auth.users where email = 'a_staff@a.test')), v);
    delete from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'sales' and area = 'discount_approve';
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"discount":2000}' where id = 'a0000000-0000-4000-8000-00000000da01'$q$);
    o := pg_temp.keep(o, '06 BIZ-NEW-1 an admin may always lower it (logged)', v = '', v);
    -- before confirmation, nothing paid: editing is free as before
    perform pg_temp.su();
    insert into public.quotes(id, org_id, code, title, status, approval_status, pricing)
      select 'a0000000-0000-4000-8000-0000000082c1', org_id, 'R32B-Q', 'r32b draft', 'quote', 'sent', pricing
        from public.quotes where id = 'a0000000-0000-4000-8000-00000000da01';
    perform pg_temp.login('a_staff@a.test');
    v := pg_temp.try($q$update public.quotes set pricing = pricing || '{"discount":50000}' where id = 'a0000000-0000-4000-8000-0000000082c1'$q$);
    o := pg_temp.keep(o, '07 BIZ-NEW-1 a quote not yet confirmed and not paid: sales lowers the price freely', v = '', v);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '0x', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= R2-BIZ change request below paid
do $$ declare o text[] := '{}'; v text; cr uuid; begin
  begin
    perform pg_temp.paid_event();
    perform pg_temp.login('a_staff@a.test');
    insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'r32b big', -200000) returning id into cr;
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try(format('update public.change_requests set status = %L, decided_at = now() where id = %L', 'approved', cr));
    perform pg_temp.su();
    o := pg_temp.keep(o, '08 BIZ approving a change that leaves the invoice below what was paid -> "record a refund first"',
      v like '23514%record a refund first%' and (select status from public.change_requests where id = cr) <> 'approved', v);
    perform pg_temp.login('a_staff@a.test');
    insert into public.change_requests(quote_id, title, price_delta) values ('a0000000-0000-4000-8000-00000000da01', 'r32b small', -10000) returning id into cr;
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try(format('update public.change_requests set status = %L, decided_at = now() where id = %L', 'approved', cr));
    o := pg_temp.keep(o, '09 BIZ a decrease that stays above what was paid is approved as before', v = '', v);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '0y', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= close requests + close_owed + label
do $$ declare o text[] := '{}'; v text; req uuid; r jsonb; begin
  begin
    perform pg_temp.paid_event();
    perform pg_temp.member('r32b_mgr@a.test', 'manager');
    perform pg_temp.member('r32b_mgr2@a.test', 'manager');
    perform pg_temp.access('manager', 'closure', true, true);
    perform pg_temp.access('manager', 'finance', true, true);
    perform pg_temp.login('r32b_mgr@a.test');
    r := public.event_closure_review('a0000000-0000-4000-8000-00000000da01');
    o := pg_temp.keep(o, '10 UX the failed balance check reads as the problem ("Client balance still due")',
      exists (select 1 from jsonb_array_elements(r -> 'failed') f where f ->> 'key' = 'balance' and f ->> 'label' = 'Client balance still due')
      and exists (select 1 from jsonb_array_elements(r -> 'checks') f where f ->> 'key' = 'balance' and f ->> 'label' = 'Client balance still due'), r::text);
    req := (public.request_event_close('a0000000-0000-4000-8000-00000000da01', 'client pays next week for sure', null) ->> 'request_id')::uuid;
    perform pg_temp.login('r32b_mgr2@a.test');
    v := pg_temp.try(format('select public.decide_event_close(%L, true, %L)', req, 'ok'));
    o := pg_temp.keep(o, '11 decide_event_close: a manager without "Close events with money owed" cannot approve past the balance', v like '42501%Only an admin%', v);
    perform pg_temp.access('manager', 'close_owed', true, true);
    perform pg_temp.login('r32b_mgr2@a.test');
    v := pg_temp.try(format('select public.decide_event_close(%L, true, %L)', req, 'ok'));
    perform pg_temp.su();
    o := pg_temp.keep(o, '12 decide_event_close: with close_owed the other manager approves - the event closes, override logged',
      v = '' and (select closed_at is not null from public.event_closure where quote_id = 'a0000000-0000-4000-8000-00000000da01')
      and (select status from public.event_close_requests where id = req) = 'approved'
      and exists (select 1 from public.event_close_overrides x where x.quote_id = 'a0000000-0000-4000-8000-00000000da01'), v);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '1x', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

do $$ declare o text[] := '{}'; v text; req uuid; begin
  begin
    perform pg_temp.paid_event();
    perform pg_temp.member('r32b_mgr@a.test', 'manager');
    perform pg_temp.member('r32b_mgr2@a.test', 'manager');
    perform pg_temp.access('manager', 'closure', true, true);
    perform pg_temp.access('manager', 'close_owed', true, true);
    perform pg_temp.su();
    update public.quotes set status = 'quote' where id = 'a0000000-0000-4000-8000-00000000da01';   -- not booked: an admin-only blocker too
    perform pg_temp.login('r32b_mgr@a.test');
    req := (public.request_event_close('a0000000-0000-4000-8000-00000000da01', 'client pays next week for sure', null) ->> 'request_id')::uuid;
    perform pg_temp.login('r32b_mgr2@a.test');
    v := pg_temp.try(format('select public.decide_event_close(%L, true, %L)', req, 'ok'));
    o := pg_temp.keep(o, '13 decide_event_close: close_owed covers money owed ONLY (an unconfirmed booking still needs an admin)', v like '42501%Only an admin%', v);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '1y', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= payments after closing
do $$ declare o text[] := '{}'; v text; m1 uuid; m2 uuid; m3 uuid; begin
  begin
    perform pg_temp.paid_event();
    perform pg_temp.su();
    insert into public.payment_milestones(quote_id, org_id, label, amount, seq, status)
      values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'r32b final', 36000, 5, 'due') returning id into m1;
    insert into public.payment_milestones(quote_id, org_id, label, amount, seq, status)
      values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'r32b extra', 1000, 6, 'due') returning id into m2;
    insert into public.payment_milestones(quote_id, org_id, label, amount, seq, status)
      values ('a0000000-0000-4000-8000-00000000da01', 'a0000000-0000-4000-8000-000000000001', 'r32b later', 200000, 7, 'due') returning id into m3;
    perform pg_temp.login('a_admin@a.test');
    perform public.close_event('a0000000-0000-4000-8000-00000000da01', true, 'client pays next week');
    v := pg_temp.try(format('select public.settle_milestone(%L, %L, %L)', m1, 'cash', 'r32b-sm1'));
    perform pg_temp.su();
    o := pg_temp.keep(o, '14 BIZ-NEW-2 "mark milestone paid" works after closing: milestone paid + receipt recorded',
      v = '' and (select status from public.payment_milestones where id = m1) = 'paid'
      and exists (select 1 from public.quote_payments p where p.quote_id = 'a0000000-0000-4000-8000-00000000da01' and p.idempotency_key = 'r32b-sm1'), v);
    o := pg_temp.keep(o, '15 BIZ-NEW-2 ... and it is logged as payment_after_close',
      exists (select 1 from public.audit_log a where a.action = 'payment_after_close' and a.quote_id = 'a0000000-0000-4000-8000-00000000da01'
                and a.changed ->> 'via' = 'settle_milestone'));
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try(format('select public.record_settlement_payment(%L, 1000, %L, null, %L, null, %L)',
                            'a0000000-0000-4000-8000-00000000da01', 'cash', m2, 'r32b-rs1'));
    perform pg_temp.su();
    o := pg_temp.keep(o, '16 BIZ-NEW-3 a Settlement payment after closing is logged and its milestone is marked paid',
      v = '' and (select status from public.payment_milestones where id = m2) = 'paid'
      and exists (select 1 from public.audit_log a where a.action = 'payment_after_close' and a.quote_id = 'a0000000-0000-4000-8000-00000000da01'
                    and a.changed ->> 'via' = 'record_settlement_payment'), v || ' ms=' || coalesce((select status from public.payment_milestones where id = m2), '?'));
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try(format('update public.payment_milestones set amount = 1 where id = %L', m3));
    o := pg_temp.keep(o, '17 BIZ-02 still frozen: editing a milestone of the closed event by hand is refused', v like '42501%event is closed%', v);
    perform pg_temp.su();
    o := pg_temp.keep(o, '18 settle_milestone keeps its API grant; its old body is not callable',
      has_function_privilege('authenticated', 'public.settle_milestone(uuid, text, text)', 'execute')
      and not has_function_privilege('authenticated', 'public.settle_milestone__pre0282(uuid, text, text)', 'execute')
      and not has_function_privilege('anon', 'public.settle_milestone(uuid, text, text)', 'execute'));
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '1z', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= BIZ-03 seats: joining + any subscription status
do $$ declare o text[] := '{}'; v text; t1 text; t2 text; outs text := ''; i int; begin
  begin
    perform pg_temp.su();
    update public.organizations set seat_limit = null where id = 'b0000000-0000-4000-8000-000000000001';
    delete from public.invitations where org_id = 'b0000000-0000-4000-8000-000000000001';
    insert into public.studio_subscriptions(org_id, plan_id, status, current_period_end, updated_at)
      select 'b0000000-0000-4000-8000-000000000001', id, 'active', current_date + 30, now() from public.helm_plans where code = 'starter'
    on conflict (org_id) do update set plan_id = excluded.plan_id, status = 'active';
    -- B = owner + b_staff (2 people) + 3 OLD open invitations (made before the plan limit; as the service)
    insert into public.invitations(org_id, email, role, token, status, invited_by, expires_at)
      select 'b0000000-0000-4000-8000-000000000001', 'r32b_j' || g || '@b.test', 'sales', md5('r32b' || g), 'pending',
             (select id from auth.users where email = 'b_admin@b.test'), now() + interval '7 days'
        from generate_series(1, 3) g;
    perform auth.seed_user('r32b_j1@b.test'); perform auth.seed_user('r32b_j2@b.test');
    perform pg_temp.login('r32b_j1@b.test');
    t1 := pg_temp.try(format('select public.accept_invitation(%L)', md5('r32b1')));
    perform pg_temp.login('r32b_j2@b.test');
    t2 := pg_temp.try(format('select public.accept_invitation(%L)', md5('r32b2')));
    perform pg_temp.su();
    o := pg_temp.keep(o, '19 BIZ-03 joining counts only the people already in the studio: with a free seat the invitee gets in (old open invitations do not block)',
      t1 = '' and (select org_id from public.profiles where email = 'r32b_j1@b.test') = 'b0000000-0000-4000-8000-000000000001', t1);
    o := pg_temp.keep(o, '20 BIZ-03 ... and once the plan''s 3 people are in, the next one is refused with the plan wording',
      t2 like '42501%Your plan allows 2 team invites%', t2);
    -- referral reviewer: a CANCELLED studio keeps its plan's limit (no stacking invitations while lapsed)
    update public.studio_subscriptions set status = 'cancelled' where org_id = 'b0000000-0000-4000-8000-000000000001';
    o := pg_temp.keep(o, '21 BIZ-03 a cancelled Starter studio still has the plan limit (3)', public._trial_seat_limit('b0000000-0000-4000-8000-000000000001') = 3,
      coalesce(public._trial_seat_limit('b0000000-0000-4000-8000-000000000001')::text, 'null'));
    update public.studio_subscriptions set status = 'suspended' where org_id = 'b0000000-0000-4000-8000-000000000001';
    o := pg_temp.keep(o, '22 BIZ-03 ... and so does a suspended one', public._trial_seat_limit('b0000000-0000-4000-8000-000000000001') = 3);
    update public.studio_subscriptions set status = 'cancelled' where org_id = 'b0000000-0000-4000-8000-000000000001';
    delete from public.invitations where org_id = 'b0000000-0000-4000-8000-000000000001';
    update public.profiles set org_id = null where email = 'r32b_j1@b.test';
    perform pg_temp.login('b_admin@b.test');
    for i in 1..3 loop outs := outs || '|' || pg_temp.try(format('select public.create_invitation(%L, %L)', 'r32b_c' || i || '@b.test', 'sales')); end loop;
    perform pg_temp.su();
    o := pg_temp.keep(o, '23 BIZ-03 cancelled studio: 1 invite fits (owner + b_staff + 1), the next is refused - no stacking to resubscribe with',
      outs like '||42501 Your plan allows 2 team invites%', outs);
    delete from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001';
    update public.organizations set seat_limit = null where id = 'a0000000-0000-4000-8000-000000000001';
    o := pg_temp.keep(o, '24 BIZ-03 no subscription row and no per-studio number (HQ-created studio A) = still no limit',
      public._trial_seat_limit('a0000000-0000-4000-8000-000000000001') is null
      and not exists (select 1 from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001'));
    o := pg_temp.keep(o, '25 BIZ-03 existing members are never removed', (select count(*) from public.profiles where email in ('b_admin@b.test', 'b_staff@b.test')
      and org_id = 'b0000000-0000-4000-8000-000000000001') = 2);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '2x', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= R2-AUTH-02 admin_create_user refusals counted
do $$ declare o text[] := '{}'; v text; r jsonb; u uuid; begin
  begin
    perform pg_temp.su();
    delete from public.r282_acu_refusals;
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try($q$select public.admin_create_user_temp('b_staff@b.test', 'sales')$q$);
    r := public.admin_create_user_temp('b_staff@b.test', 'sales');
    perform pg_temp.su();
    o := pg_temp.keep(o, '26 AUTH-02 an address that has a login elsewhere is refused (answered, not raised) and counted',
      v = '' and (r ->> 'refused')::boolean and r ->> 'error' like '%send them an invitation instead%' and r ->> 'temp_password' is null
      and (select count(*) from public.r282_acu_refusals where studio_id = 'a0000000-0000-4000-8000-000000000001') = 2
      and (select profiles.org_id from public.profiles where email = 'b_staff@b.test') = 'b0000000-0000-4000-8000-000000000001', v || ' ' || coalesce(r::text, ''));
    o := pg_temp.keep(o, '27 AUTH-02 only a fingerprint of the address is kept; the table is private',
      not exists (select 1 from public.r282_acu_refusals where email_hash like '%@%')
      and not has_table_privilege('authenticated', 'public.r282_acu_refusals', 'select')
      and not has_table_privilege('anon', 'public.r282_acu_refusals', 'select'));
    perform pg_temp.login('a_admin@a.test');
    u := public.admin_create_user('r32b-new@example.org', 'Abcdefghij1!x', 'sales');
    perform pg_temp.su();
    o := pg_temp.keep(o, '28 AUTH-02 the legitimate flow still creates a new address', u is not null
      and (select org_id from public.profiles where id = u) = 'a0000000-0000-4000-8000-000000000001');
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try($q$select public.admin_create_user('a_staff@a.test', 'Abcdefghij1!x', 'sales')$q$);
    o := pg_temp.keep(o, '29 AUTH-02 someone already in YOUR studio still gets the plain answer (no cross-studio oracle)', v like '23505%', v);
    perform pg_temp.su();
    insert into public.r282_acu_refusals(studio_id, email_hash) select 'a0000000-0000-4000-8000-000000000001', md5(g::text) from generate_series(1, 18) g;
    perform pg_temp.login('a_admin@a.test');
    v := pg_temp.try($q$select public.admin_create_user_temp('r32b-other@example.org', 'sales')$q$);
    perform pg_temp.su();
    o := pg_temp.keep(o, '30 AUTH-02 after 20 refusals in a day the studio''s Add user waits (54000), even for an unknown address',
      v like '54000%' and not exists (select 1 from auth.users where email = 'r32b-other@example.org'), v);
    perform pg_temp.login('b_admin@b.test');
    v := pg_temp.try($q$select public.admin_create_user_temp('r32b-b@example.org', 'sales')$q$);
    o := pg_temp.keep(o, '31 AUTH-02 the count is per studio (studio B is not affected)', v not like '54000%', v);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '3x', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

-- ================================================================================= BIZ-06 + sample fields
do $$ declare o text[] := '{}'; a text; b text; begin
  begin
    perform pg_temp.login('a_admin@a.test');
    a := pg_temp.try($q$update public.organizations set sample_version = 99 where id = 'a0000000-0000-4000-8000-000000000001'$q$);
    b := pg_temp.try($q$update public.organizations set sample_cloned_at = now() where id = 'a0000000-0000-4000-8000-000000000001'$q$);
    o := pg_temp.keep(o, '32 BIZ-06 sample_version / sample_cloned_at refused through the API', a like '42501%' and b like '42501%', a || '|' || b);
    raise exception 'r32b-undo';
  exception when others then if sqlerrm <> 'r32b-undo' then o := pg_temp.keep(o, '3y', false, sqlstate || ' ' || sqlerrm); end if;
  end;
  perform pg_temp.flush(o);
end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R32B-ROUND2-0282: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R32B-ROUND2-0282: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
