-- event-stages-0198.sql - 0198: no closing before the event day is over (studio time zone),
-- stage moves (confirmed floor, cancelled / closed lock, no-op, planning + event day gates),
-- cancel_event, calendar conflict acknowledgements, grants.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _g198; create temp table _g198(name text, result text); grant all on _g198 to anon, authenticated;

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
  insert into _g198 values (p_name, case when p_ok then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;
create or replace function pg_temp.today() returns date language sql as $$
  select (now() at time zone 'Asia/Kolkata')::date $$;
create or replace function pg_temp.stage(p uuid) returns text language sql as $$
  select lifecycle_stage from public.quotes where id = p $$;

-- setup: org A events (all in Studio A, Asia/Kolkata)
--   ...98c1 confirmed, priced, fully paid, consent, event in 20 days  (close / stage tests)
--   ...98c2 confirmed, priced, unpaid, consent                         (cancel tests)
--   ...98c3 confirmed, priced, fully paid, no event date               (no-date blocker)
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; begin
  execute 'reset role';
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  delete from public.quote_consents where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');
  delete from public.quote_payments where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');
  delete from public.event_closure where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');
  delete from public.event_plan where quote_id in ('a0000000-0000-4000-8000-0000000198c1');
  delete from public.event_close_overrides where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');
  delete from public.quote_versions where quote_id in ('a0000000-0000-4000-8000-0000000198c1');
  delete from public.event_cancellations where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id,
                            approval_token, lifecycle_stage, event_date, created_at, updated_at)
  values ('a0000000-0000-4000-8000-0000000198c1', 'A-198-1', 'Gst198 Stages One', 'quote', '{"name":"Gst198 One"}'::jsonb,
          '{"subtotal":100000,"discount":0,"gstPct":18,"total":118000}'::jsonb, 1, 'sent', a,
          'a0000000-0000-4000-8000-0000000198a1', 'quote', pg_temp.today() + 20, now(), now()),
         ('a0000000-0000-4000-8000-0000000198c2', 'A-198-2', 'Gst198 Stages Two', 'quote', '{"name":"Gst198 Two"}'::jsonb,
          '{"subtotal":50000,"discount":0,"gstPct":18,"total":59000}'::jsonb, 1, 'sent', a,
          'a0000000-0000-4000-8000-0000000198a2', 'quote', pg_temp.today() + 30, now(), now()),
         ('a0000000-0000-4000-8000-0000000198c3', 'A-198-3', 'Gst198 Stages Three', 'quote', '{"name":"Gst198 Three"}'::jsonb,
          '{"subtotal":10000,"discount":0,"gstPct":0,"total":10000}'::jsonb, 1, 'sent', a,
          'a0000000-0000-4000-8000-0000000198a3', 'quote', null, now(), now())
  on conflict (id) do update set status = 'quote', approval_status = 'sent', lifecycle_stage = 'quote',
    event_date = excluded.event_date, pricing = excluded.pricing, consent_stale = false,
    approval_token = excluded.approval_token, approval_token_revoked_at = null, approval_token_expires_at = null;
  foreach q in array array['a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3']::uuid[] loop
    insert into public.quote_consents(quote_id, phone, client_name, agreed, verified_via_otp, created_at)
      values (q, '9999999999', 'Client', true, true, clock_timestamp());
    update public.quotes set approval_status = 'approved', status = 'confirmed', confirmed_at = now() where id = q;
  end loop;
  insert into public.quote_payments(quote_id, amount, status, provider_ref, org_id) values
    ('a0000000-0000-4000-8000-0000000198c1', 118000, 'paid', 'g198-1', a),
    ('a0000000-0000-4000-8000-0000000198c3', 10000, 'paid', 'g198-3', a);
  -- sales (a_staff) gets quotes + closure edit for this suite
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('sales', 'quotes', true, true, a, now()), ('sales', 'closure', true, true, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values
    ('manager', 'quotes', true, true, a, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = true;
end $$;

-- ---- 1) studio-local day ------------------------------------------------------------------
do $$ begin
  perform pg_temp.t('01 studio today = Asia/Kolkata day', public._a198_org_today('a0000000-0000-4000-8000-000000000001') = pg_temp.today(), null);
  update public.organizations set timezone = 'Pacific/Kiritimati' where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.t('02 studio today follows the studio time zone',
    public._a198_org_today('a0000000-0000-4000-8000-000000000001') = (now() at time zone 'Pacific/Kiritimati')::date, null);
  update public.organizations set timezone = 'Not/AZone' where id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.t('03 unknown time zone falls back to Asia/Kolkata', public._a198_org_today('a0000000-0000-4000-8000-000000000001') = pg_temp.today(), null);
  update public.organizations set timezone = 'Asia/Kolkata' where id = 'a0000000-0000-4000-8000-000000000001';
end $$;

-- ---- 2) close gate ------------------------------------------------------------------------
do $$ declare r text; d text; begin
  d := to_char(pg_temp.today() + 20, 'FMDD Mon YYYY');
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c1', true)::text$q$);
  perform pg_temp.t('10 close before the event day -> HL425 with the date', r like 'err:HL425:You can close this event after ' || d || ' (event day).', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c1', true, 'admin wants it closed now')::text$q$);
  perform pg_temp.t('11 admin override reason does NOT pass the event-day rule', r like 'err:HL425%', r);
  perform pg_temp.t('12 refused close left it open', pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') <> 'closed'
    and not exists (select 1 from public.event_closure where quote_id = 'a0000000-0000-4000-8000-0000000198c1' and closed_at is not null), null);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event_blockers('a0000000-0000-4000-8000-0000000198c1')::text$q$);
  perform pg_temp.t('13 blockers explain it (too_early + close_after)', r like '%"too_early": true%' and r like '%"close_after": "' || d || '"%' and r like '%"blocked": true%', r);
  update public.quotes set event_date = pg_temp.today() where id = 'a0000000-0000-4000-8000-0000000198c1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c1', true)::text$q$);
  perform pg_temp.t('14 on the event day itself -> still HL425', r like 'err:HL425%', r);
  update public.quotes set event_date = pg_temp.today() - 1 where id = 'a0000000-0000-4000-8000-0000000198c3';
  update public.quotes set event_date = null where id = 'a0000000-0000-4000-8000-0000000198c3';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c3', true)::text$q$);
  perform pg_temp.t('15 no event date -> blocked (P0001 no date)', r like 'err:P0001%no date yet%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c3', true, 'date never recorded')::text$q$);
  perform pg_temp.t('16 no date: non-admin override -> 42501', r like 'err:42501%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c3', true, 'date never recorded, event done')::text$q$);
  perform pg_temp.t('17 no date: admin override with reason closes it', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c3') = 'closed', r);
  perform pg_temp.t('18 override recorded', exists (select 1 from public.event_close_overrides where quote_id = 'a0000000-0000-4000-8000-0000000198c3'
    and reason = 'date never recorded, event done' and (blockers ->> 'no_event_date')::boolean), null);
  -- balance gate still on the server
  update public.quotes set event_date = pg_temp.today() - 2 where id = 'a0000000-0000-4000-8000-0000000198c2';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c2', true)::text$q$);
  perform pg_temp.t('19 past event with balance owed -> P0001 balance', r like 'err:P0001%balance still owed: 59000.00%', r);
  update public.quotes set event_date = pg_temp.today() + 30 where id = 'a0000000-0000-4000-8000-0000000198c2';
  -- past + paid -> closes
  update public.quotes set event_date = pg_temp.today() - 1 where id = 'a0000000-0000-4000-8000-0000000198c1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event_blockers('a0000000-0000-4000-8000-0000000198c1')::text$q$);
  perform pg_temp.t('20 day after the event, paid: not blocked', r like '%"blocked": false%' and r like '%"too_early": false%', r);
  -- (closing c1 happens at the end so the stage tests can use it)
end $$;

-- ---- 3) stages -------------------------------------------------------------------------------
do $$ declare r text; d text; begin
  update public.quotes set event_date = pg_temp.today() + 20 where id = 'a0000000-0000-4000-8000-0000000198c1';
  d := to_char(pg_temp.today() + 20, 'FMDD Mon YYYY');
  perform pg_temp.t('30 consent moved the event to confirmed', pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'confirmed', pg_temp.stage('a0000000-0000-4000-8000-0000000198c1'));
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'quote')::text$q$);
  perform pg_temp.t('31 confirmed event cannot go back to Quote (22023)', r like 'err:22023:This event is confirmed, so it can''t go back to Quote.%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'lead', 'admin tries to rewind')::text$q$);
  perform pg_temp.t('32 not even an admin override rewinds a confirmed event', r like 'err:22023%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'confirmed', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.lifecycle_stage_blockers('a0000000-0000-4000-8000-0000000198c1', 'proposal')::text$q$);
  perform pg_temp.t('33 blockers: backward below Confirmed is a hard entry', r like '%"hard": true%' and r like '%confirmed_floor%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('34 planning without menu + layout -> HL409 Planning needs: menu locked, layout v1',
    r like 'err:HL409:Can''t move to Planning yet - Planning needs: menu locked, layout v1.%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.lifecycle_stage_blockers('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('35 blockers RPC lists the planning needs', r like '%Planning needs: menu locked, layout v1%' and r like '%"needs": ["menu locked", "layout v1"]%', r);
  insert into public.event_plan(quote_id, menu_locked, org_id) values ('a0000000-0000-4000-8000-0000000198c1', true, 'a0000000-0000-4000-8000-000000000001')
    on conflict (quote_id) do update set menu_locked = true;
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('36 menu locked but no layout -> Planning needs: layout v1', r like 'err:HL409%Planning needs: layout v1.%', r);
  insert into public.quote_versions(quote_id, version_no, label, data, object_count, org_id)
    values ('a0000000-0000-4000-8000-0000000198c1', 1, 'v1', '{}'::jsonb, 12, 'a0000000-0000-4000-8000-000000000001');
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('37 menu locked + layout v1 -> Planning', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'planning', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('38 same stage again is a no-op', r like 'ok:%"unchanged": true%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'ready')::text$q$);
  perform pg_temp.t('39 planning -> ready (no gate)', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'ready', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'event_day')::text$q$);
  perform pg_temp.t('40 event day before the date -> HL409 Event Day opens on <date>', r like 'err:HL409%Event Day opens on ' || d || ' (the event date)%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'settlement')::text$q$);
  perform pg_temp.t('41 settlement before the date -> HL409 has not arrived (one reason only)',
    r like 'err:HL409%has not arrived%' and r not like '%Event Day opens%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'planning')::text$q$);
  perform pg_temp.t('42 backward ready -> planning allowed', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'planning', r);
  update public.quotes set event_date = pg_temp.today() where id = 'a0000000-0000-4000-8000-0000000198c1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'event_day')::text$q$);
  perform pg_temp.t('43 on the event date -> Event Day opens', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'event_day', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'settlement')::text$q$);
  perform pg_temp.t('44 settlement on the event date (studio day)', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'settlement', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'closed', 'skip')::text$q$);
  perform pg_temp.t('45 closed never via set_lifecycle_stage', r like 'err:22023%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c1', 'ready')::text$q$);
  perform pg_temp.t('46 Org B cannot move an Org A event', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.lifecycle_stage_blockers('a0000000-0000-4000-8000-0000000198c1', 'ready')::text$q$);
  perform pg_temp.t('47 Org B cannot read Org A blockers', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c3', 'settlement')::text$q$);
  perform pg_temp.t('48 a closed event stage cannot change', r like 'err:22023:This event is closed%', r);
end $$;

-- ---- 4) cancel event ----------------------------------------------------------------------------
do $$ declare r text; n int; begin
  r := pg_temp.as_try('a_staff@a.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'client postponed')::text$q$);
  perform pg_temp.t('60 sales cannot cancel (admin / manager only)', r like 'err:42501:Only an admin or a manager%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'no')::text$q$);
  perform pg_temp.t('61 reason too short -> 22023', r like 'err:22023%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'cross studio attempt')::text$q$);
  perform pg_temp.t('62 Org B admin cannot cancel an Org A event', r like 'err:42501%' and (select status from public.quotes where id = 'a0000000-0000-4000-8000-0000000198c2') = 'confirmed', r);
  r := pg_temp.as_try('anon', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'anon attempt here')::text$q$);
  perform pg_temp.t('63 anon cannot cancel', r like 'err:42501%', r);
  update public.profiles set role = 'manager' where email = 'a_staff@a.test';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'Client called off the wedding')::text$q$);
  update public.profiles set role = 'sales' where email = 'a_staff@a.test';
  perform pg_temp.t('64 manager cancels with a reason', r like 'ok:%"status": "cancelled"%', r);
  perform pg_temp.t('65 status cancelled, stage + approval kept, link revoked',
    (select status = 'cancelled' and lifecycle_stage = 'confirmed' and approval_status = 'approved' and approval_token_revoked_at is not null
       from public.quotes where id = 'a0000000-0000-4000-8000-0000000198c2'), null);
  select count(*) into n from public.event_cancellations where quote_id = 'a0000000-0000-4000-8000-0000000198c2'
     and reason = 'Client called off the wedding' and prev_status = 'confirmed' and prev_stage = 'confirmed';
  perform pg_temp.t('66 cancellation recorded', n = 1, n::text);
  perform pg_temp.t('67 audit row event_cancelled', exists (select 1 from public.audit_log where action = 'event_cancelled'
     and quote_id = 'a0000000-0000-4000-8000-0000000198c2'), null);
  perform pg_temp.t('68 consent history kept', exists (select 1 from public.quote_consents where quote_id = 'a0000000-0000-4000-8000-0000000198c2'), null);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c2', 'second time round')::text$q$);
  perform pg_temp.t('69 cancelling twice is a no-op', r like 'ok:%"unchanged": true%'
    and (select count(*) from public.event_cancellations where quote_id = 'a0000000-0000-4000-8000-0000000198c2') = 1, r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.set_lifecycle_stage('a0000000-0000-4000-8000-0000000198c2', 'planning')::text$q$);
  perform pg_temp.t('70 a cancelled event stage cannot change', r like 'err:22023:This event is cancelled%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event_blockers('a0000000-0000-4000-8000-0000000198c2')::text$q$);
  perform pg_temp.t('71 cancelled event: no event-day / booking blocker (only the balance)', r like '%"too_early": false%' and r like '%"not_booked": null%' and r like '%"balance_owed": 59000%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c2', true, 'cancelled, nothing to collect')::text$q$);
  perform pg_temp.t('72 a cancelled future event can be closed to settle it (admin override for the balance)', r like 'ok:%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.cancel_event('a0000000-0000-4000-8000-0000000198c3', 'closed event cancel try')::text$q$);
  perform pg_temp.t('73 a closed event cannot be cancelled', r like 'err:22023:This event is closed%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$insert into public.event_cancellations(org_id, quote_id, reason) values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000198c1', 'forged row') returning id::text$q$);
  perform pg_temp.t('74 app cannot forge a cancellation row', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select count(*)::text from public.event_cancellations where quote_id = 'a0000000-0000-4000-8000-0000000198c2'$q$);
  perform pg_temp.t('75 Org B cannot read Org A cancellations', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select count(*)::text from public.event_cancellations where quote_id = 'a0000000-0000-4000-8000-0000000198c2'$q$);
  perform pg_temp.t('76 Org A member reads the cancellation', r = 'ok:1', r);
end $$;

-- ---- 5) conflict acknowledgements --------------------------------------------------------------
do $$ declare r text; r2 text; n int; begin
  delete from public.calendar_conflict_acks where conflict_key like 'g198|%';   -- disposable test DB
  r := pg_temp.as_try('a_staff@a.test', $q$select public.ack_calendar_conflict('a0000000-0000-4000-8000-0000000198c1', 'g198|venue|2026-11-07|lawn|a1,a2', 'Same lawn, different halls')::text$q$);
  perform pg_temp.t('80 member acknowledges a clash', r like 'ok:%"acknowledged": true%', r);
  r2 := pg_temp.as_try('a_admin@a.test', $q$select public.ack_calendar_conflict('a0000000-0000-4000-8000-0000000198c1', 'g198|venue|2026-11-07|lawn|a1,a2', null)::text$q$);
  select count(*) into n from public.calendar_conflict_acks where conflict_key = 'g198|venue|2026-11-07|lawn|a1,a2' and revoked_at is null;
  perform pg_temp.t('81 acknowledging twice keeps one open row', r2 like 'ok:%' and n = 1, n::text);
  r := pg_temp.as_try('b_admin@b.test', $q$select public.ack_calendar_conflict('a0000000-0000-4000-8000-0000000198c1', 'g198|venue|x|y', null)::text$q$);
  perform pg_temp.t('82 Org B cannot acknowledge on an Org A event', r like 'err:42501%', r);
  r := pg_temp.as_try('b_admin@b.test', $q$select count(*)::text from public.calendar_conflict_acks where conflict_key like 'g198|%'$q$);
  perform pg_temp.t('83 Org B cannot read Org A acknowledgements', r = 'ok:0', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select count(*)::text from public.calendar_conflict_acks where conflict_key like 'g198|%' and revoked_at is null$q$);
  perform pg_temp.t('84 Org A member reads them', r = 'ok:1', r);
  r := pg_temp.as_try('a_staff@a.test', $q$insert into public.calendar_conflict_acks(org_id, quote_id, conflict_key) values ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000198c1', 'g198|forged') returning id::text$q$);
  perform pg_temp.t('85 app cannot write acknowledgements directly', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.unack_calendar_conflict('a0000000-0000-4000-8000-0000000198c1', 'g198|venue|2026-11-07|lawn|a1,a2')::text$q$);
  select count(*) into n from public.calendar_conflict_acks where conflict_key = 'g198|venue|2026-11-07|lawn|a1,a2';
  perform pg_temp.t('86 un-acknowledge stamps revoked_at, deletes nothing', r like 'ok:%"revoked": 1%' and n = 1
    and not exists (select 1 from public.calendar_conflict_acks where conflict_key = 'g198|venue|2026-11-07|lawn|a1,a2' and revoked_at is null), r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.ack_calendar_conflict('a0000000-0000-4000-8000-0000000198c1', 'ab', null)::text$q$);
  perform pg_temp.t('87 too-short key refused', r like 'err:22023%', r);
end $$;

-- ---- 6) close the paid event the day after + grants + ASCII ----------------------------------
do $$ declare r text; begin
  update public.quotes set event_date = pg_temp.today() - 1 where id = 'a0000000-0000-4000-8000-0000000198c1';
  r := pg_temp.as_try('a_staff@a.test', $q$select public.close_event('a0000000-0000-4000-8000-0000000198c1', true)::text$q$);
  perform pg_temp.t('90 the day after the event, paid: closes', r like 'ok:%' and pg_temp.stage('a0000000-0000-4000-8000-0000000198c1') = 'closed', r);
  perform pg_temp.t('91 app roles cannot run the helpers',
    not has_function_privilege('authenticated', 'public._a198_org_today(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._a198_stage_blockers(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._a49_close_gate(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public._a49_close_blockers(uuid)', 'execute'), null);
  perform pg_temp.t('92 anon cannot run the new RPCs',
    not has_function_privilege('anon', 'public.cancel_event(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.unack_calendar_conflict(uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public.set_lifecycle_stage(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.lifecycle_stage_blockers(uuid,text)', 'execute'), null);
  perform pg_temp.t('93 signed-in app can run the new RPCs',
    has_function_privilege('authenticated', 'public.cancel_event(uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.ack_calendar_conflict(uuid,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.set_lifecycle_stage(uuid,text)', 'execute'), null);
  perform pg_temp.t('94 messages plain ASCII', (select bool_and(prosrc !~ '[^\x01-\x7e]') from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname = 'public' and p.proname in ('_a198_stage_blockers', 'set_lifecycle_stage', 'lifecycle_stage_blockers', 'cancel_event',
      '_a49_close_gate', '_a49_close_blockers', '_a49_blocker_text', 'ack_calendar_conflict', 'unack_calendar_conflict')), null);
end $$;

-- leave no close overrides behind (other suites count a studio's overrides)
delete from public.event_close_overrides where quote_id in ('a0000000-0000-4000-8000-0000000198c1','a0000000-0000-4000-8000-0000000198c2','a0000000-0000-4000-8000-0000000198c3');

select name, result from _g198 where result <> 'PASS';
select case when not exists (select 1 from _g198 where result <> 'PASS')
            then 'EVENT-STAGES-0198: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'EVENT-STAGES-0198: FAILURES (' || count(*) filter (where result <> 'PASS') || ')' end
  from _g198;
