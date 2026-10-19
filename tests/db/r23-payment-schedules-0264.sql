-- r23-payment-schedules-0264.sql -- 0264: payment schedule templates applied on approval (never overwriting), the
-- arithmetic (adds up to the total, whole rupees, Balance), reminders ON by default (-3 / 0 / +3) with pay details,
-- per-event pause, overdue bell once, recording a payment covers milestones in order (part payments stay open),
-- Control Center settings / templates, manual apply with preview, the client page, finance gating, tenant isolation.
-- The migration is applied twice. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _ps(name text, result text); grant all on _ps to anon, authenticated, service_role;
create temp table _pkv(k text primary key, v text); grant all on _pkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ps values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; begin execute p_sql into v; return v; exception when others then return jsonb_build_object('err', sqlstate || ' ' || sqlerrm); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _pkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _pkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.member(p_email text, p_role text, p_org uuid) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
  return u;
end $$;
-- a new event in a studio: priced, approval sent, event in N days
create or replace function pg_temp.event(p_org uuid, p_code text, p_total numeric, p_days integer, p_demo boolean default false) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid(); begin
  perform pg_temp.su();
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, approval_token, event_date, created_at, updated_at, is_demo)
    values (v, p_code, 'Event ' || p_code, 'quote', '{"name":"Riya","email":"riya@example.com"}'::jsonb,
            jsonb_build_object('subtotal', p_total, 'discount', 0, 'gstPct', 0, 'total', p_total), 1, 'sent', p_org, gen_random_uuid(),
            case when p_days is null then null else pg_temp.today() + p_days end, now(), now(), p_demo);
  return v;
end $$;
create or replace function pg_temp.today() returns date language plpgsql stable as $$ begin return public._pst_today('a0000000-0000-4000-8000-000000000001'); end $$;
grant execute on function pg_temp.today() to anon, authenticated, service_role;
create or replace function pg_temp.ms(p_q uuid) returns text language sql as $$
  select coalesce(string_agg(m.label || '=' || m.amount::numeric(14,2)::text || '@' || coalesce((m.due_date - pg_temp.today())::text, '-') || ':' || m.status, ' | ' order by m.due_date nulls last, m.seq), '')
    from public.payment_milestones m where m.quote_id = p_q $$;

-- ---- setup -----------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.member('ps_crew@a.test', 'crew', a);            -- no finance / controls
  perform pg_temp.su();
  delete from public.comms_settings where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
  perform pg_temp.put('ms_rows0', (select count(*)::text from public.payment_milestones));
end $$;

-- ---- the migration, twice ------------------------------------------------------------------------------------------
\ir ../../supabase/migrations/0264_payment_schedules.sql
\ir ../../supabase/migrations/0264_payment_schedules.sql

-- ---- 1) the arithmetic ---------------------------------------------------------------------------------------------
do $$ declare r jsonb; l jsonb := (select b -> 'lines' from jsonb_array_elements(public._pst_builtins()) b where b ->> 'key' = 'builtin:30-50-20'); begin
  perform pg_temp.su();
  perform pg_temp.res('01 three built-in templates', jsonb_array_length(public._pst_builtins()) = 3);
  r := public._pst_compute(l, 236000, pg_temp.today(), pg_temp.today() + 60);
  perform pg_temp.res('02 30/50/20 of 2,36,000: 70,800 now, 1,18,000 15 days before, 47,200 on the day',
    (r -> 0 ->> 'amount')::numeric = 70800 and (r -> 0 ->> 'due_date')::date = pg_temp.today()
    and (r -> 1 ->> 'amount')::numeric = 118000 and (r -> 1 ->> 'due_date')::date = pg_temp.today() + 45
    and (r -> 2 ->> 'amount')::numeric = 47200 and (r -> 2 ->> 'due_date')::date = pg_temp.today() + 60, r::text);
  r := public._pst_compute(l, 99999.50, pg_temp.today(), pg_temp.today() + 60);
  perform pg_temp.res('03 the rows add up to the total exactly (paise go to the last payment)',
    (select sum((x ->> 'amount')::numeric) from jsonb_array_elements(r) x) = 99999.50 and (r -> 0 ->> 'amount')::numeric = 30000, r::text);
  r := public._pst_compute(l, 100000, pg_temp.today(), pg_temp.today() + 5);
  perform pg_temp.res('04 a due date before the approval day becomes the approval day', (r -> 1 ->> 'due_date')::date = pg_temp.today(), r::text);
  r := public._pst_compute(l, 100000, pg_temp.today(), null);
  perform pg_temp.res('05 no event date: event-based payments have no due date yet', r -> 1 ->> 'due_date' is null and (r -> 0 ->> 'due_date')::date = pg_temp.today(), r::text);
  r := public._pst_compute(public._pst_lines_clean('[{"label":"Booking","kind":"fixed","value":25000},{"label":"Rest","kind":"balance","anchor":"event","offset_days":-3}]'),
                           100000, pg_temp.today(), pg_temp.today() + 30);
  perform pg_temp.res('06 fixed + Balance: 25,000 then the remaining 75,000', (r -> 0 ->> 'amount')::numeric = 25000 and (r -> 1 ->> 'amount')::numeric = 75000, r::text);
  r := public._pst_compute(public._pst_lines_clean('[{"label":"Booking","kind":"fixed","value":150000},{"label":"Rest","kind":"balance"}]'), 100000, pg_temp.today(), null);
  perform pg_temp.res('07 never more than the total (fixed capped, empty balance dropped)',
    jsonb_array_length(r) = 1 and (r -> 0 ->> 'amount')::numeric = 100000, r::text);
end $$;

do $$ declare e text; begin
  perform pg_temp.su();
  e := pg_temp.try($q$select public._pst_lines_clean('[{"label":"A","value":30},{"label":"B","value":30}]')$q$);
  perform pg_temp.res('08 percentages that do not make 100% (no Balance) are refused', e like '22023%add up to 100%', e);
  e := pg_temp.try($q$select public._pst_lines_clean('[{"label":"A","kind":"balance"},{"label":"B","kind":"balance"}]')$q$);
  perform pg_temp.res('09 two Balance payments refused', e like '22023%at most one%', e);
  e := pg_temp.try($q$select public._pst_lines_clean('[{"label":"A","value":0},{"label":"B","kind":"balance"}]')$q$);
  perform pg_temp.res('10 a 0% payment refused', e like '22023%more than 0%', e);
  e := pg_temp.try($q$select public._pst_lines_clean('[{"label":"A","value":100,"anchor":"approval","offset_days":-2}]')$q$);
  perform pg_temp.res('11 due before the approval refused', e like '22023%before the approval%', e);
  e := pg_temp.try($q$select public._pst_lines_clean('[{"label":"<b>","value":100}]')$q$);
  perform pg_temp.res('12 a name with < > refused', e like '22023%name%', e);
end $$;

-- ---- 2) applied automatically on approval -----------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; q2 uuid; q3 uuid; q4 uuid; begin
  q := pg_temp.event(a, 'PS-1', 236000, 60); perform pg_temp.put('q1', q::text);
  update public.quotes set approval_status = 'approved' where id = q;
  perform pg_temp.res('13 approval adds the default 30/50/20 schedule',
    pg_temp.ms(q) = 'Advance (30%)=70800.00@0:due | Second payment (50%)=118000.00@45:due | Final balance (20%)=47200.00@60:due', pg_temp.ms(q));
  perform pg_temp.res('14 marked as applied automatically + audited',
    exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = q and p.applied_source = 'auto' and p.applied_template = '30 / 50 / 20')
    and exists (select 1 from public.audit_log l where l.quote_id = q and l.action = 'payment_schedule.applied'));
  update public.quotes set approval_status = 'sent' where id = q;
  update public.quotes set approval_status = 'approved', status = 'confirmed' where id = q;
  perform pg_temp.res('15 a second approval never adds to / overwrites the schedule', (select count(*) from public.payment_milestones where quote_id = q) = 3);
  -- an event with its own milestone: kept as it is
  q2 := pg_temp.event(a, 'PS-2', 50000, 30); perform pg_temp.put('q2', q2::text);
  insert into public.payment_milestones(quote_id, org_id, label, amount, status) values (q2, a, 'Token', 5000, 'due');
  update public.quotes set approval_status = 'approved' where id = q2;
  perform pg_temp.res('16 an existing schedule is never overwritten', pg_temp.ms(q2) = 'Token=5000.00@-:due', pg_temp.ms(q2));
  q3 := pg_temp.event(a, 'PS-3', 80000, 30, true);
  update public.quotes set approval_status = 'approved' where id = q3;
  perform pg_temp.res('17 demo (sample) events get no schedule', pg_temp.ms(q3) = '');
  q4 := pg_temp.event(a, 'PS-4', 0, 30);
  update public.quotes set pricing = '{}'::jsonb where id = q4;
  update public.quotes set approval_status = 'approved' where id = q4;
  perform pg_temp.res('18 an unpriced event: approval still goes through, no schedule',
    pg_temp.ms(q4) = '' and (select approval_status from public.quotes where id = q4) = 'approved');
end $$;

-- the switch off (studio B): no schedule
select pg_temp.login('b_admin@b.test');
do $$ declare r jsonb; q uuid; begin
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"auto_apply": false}'::jsonb)$q$);
  perform pg_temp.res('19 admin switches automatic schedules off', r ->> 'auto_apply' = 'false', r::text);
  q := pg_temp.event('b0000000-0000-4000-8000-000000000001', 'PS-B1', 90000, 30);
  update public.quotes set approval_status = 'approved' where id = q;
  perform pg_temp.res('20 switch off: approval adds nothing', pg_temp.ms(q) = '');
  perform pg_temp.put('qb1', q::text);
end $$;

-- ---- 3) recording payments covers milestones in order ---------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := pg_temp.get('q1')::uuid; r jsonb; s jsonb; begin
  r := pg_temp.j(format($q$select public.record_payment(%L, 70800, 'cash', null, null, null, 'ps-k1')$q$, q));
  perform pg_temp.res('21 the advance pays the first milestone (receipt issued)', r ->> 'receipt_no' is not null
    and pg_temp.ms(q) like 'Advance (30%)=70800.00@0:paid | Second payment (50%)=118000.00@45:due%', r::text || ' / ' || pg_temp.ms(q));
  r := pg_temp.j(format($q$select public.record_payment(%L, 100000, 'upi', null, null, null, 'ps-k2')$q$, q));
  perform pg_temp.res('22 a part payment leaves the next milestone open', pg_temp.ms(q) like '%Second payment (50%)=118000.00@45:due%', pg_temp.ms(q));
  s := pg_temp.j(format($q$select public.payment_schedule_for_quote(%L)$q$, q));
  perform pg_temp.res('23 the schedule shows it as part paid (1,00,000 of 1,18,000, 18,000 left)',
    s -> 'rows' -> 1 ->> 'state' = 'part_paid' and (s -> 'rows' -> 1 ->> 'paid')::numeric = 100000 and (s -> 'rows' -> 1 ->> 'remaining')::numeric = 18000
    and (s ->> 'paid')::numeric = 170800 and jsonb_array_length(s -> 'receipts') = 2 and s -> 'next' ->> 'label' = 'Second payment (50%)', s::text);
  r := pg_temp.j(format($q$select public.record_payment(%L, 18000, 'cash', null, null, null, 'ps-k3')$q$, q));
  perform pg_temp.res('24 the rest of it pays the second milestone', pg_temp.ms(q) like '%Second payment (50%)=118000.00@45:paid | Final balance (20%)=47200.00@60:due', r::text || ' / ' || pg_temp.ms(q));
  r := pg_temp.j(format($q$select public.record_payment(%L, 18000, 'cash', null, null, null, 'ps-k3')$q$, q));
  perform pg_temp.res('25 a replayed submission changes nothing', coalesce((r ->> 'idempotent_replay')::boolean, false)
    and (select count(*) from public.quote_payments where quote_id = q and status = 'paid') = 3, r::text);
  r := pg_temp.j(format($q$select public.record_settlement_payment(%L, 47200, 'bank', null, null, null, 'ps-k4')$q$, q));
  perform pg_temp.res('26 the settlement payment pays the final milestone', pg_temp.ms(q) like '%Final balance (20%)=47200.00@60:paid', r::text || ' / ' || pg_temp.ms(q));
  r := pg_temp.j(format($q$select public.record_payment(%L, 1, 'cash', null, null, null, 'ps-k5')$q$, q));
  perform pg_temp.res('27 the overpayment guard still refuses money beyond the total', r ->> 'err' like '23514%', r::text);
end $$;

-- money in another way (e.g. an online payment written by the service role) is covered by the tick
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; r jsonb; begin
  q := pg_temp.event(a, 'PS-5', 100000, 40); perform pg_temp.put('q5', q::text);
  update public.quotes set approval_status = 'approved' where id = q;
  insert into public.quote_payments(quote_id, org_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at)
    values (q, a, 'razorpay', 30000, 'paid', 'pay_ps5', 'RCP-PS-5-01', 'online', false, now());
  r := public.comms_tick();
  perform pg_temp.res('28 money that came in online covers the advance on the next tick',
    pg_temp.ms(q) like 'Advance (30%)=30000.00@0:paid%' and (r ->> 'milestones_covered')::int >= 1, r::text || ' / ' || pg_temp.ms(q));
end $$;

-- one payment that covers two milestones marks both paid
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; r jsonb; begin
  q := pg_temp.event(a, 'PS-9', 100000, 40);
  update public.quotes set approval_status = 'approved' where id = q;
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format($q$select public.record_payment(%L, 80000, 'bank', null, null, null, 'ps-k9')$q$, q));
  perform pg_temp.res('71 one payment of 80,000 pays the 30% and the 50% milestones',
    pg_temp.ms(q) like 'Advance (30%)=30000.00@0:paid | Second payment (50%)=50000.00@25:paid | Final balance (20%)=20000.00@40:due'
    and (r ->> 'milestones_covered')::int = 1, r::text || ' / ' || pg_temp.ms(q));
end $$;

-- ---- 4) reminders on by default, with pay details; pause -----------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; begin
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "studioa@okaxis", "pay_note": "Bank: HDFC 1234, IFSC HDFC0001"}'::jsonb)$q$);
  perform pg_temp.res('29 admin saves UPI ID + payment note', r ->> 'upi_id' = 'studioa@okaxis' and r -> 'reminders' ->> 'enabled' = 'true', r::text);
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"upi_id": "not a upi"}'::jsonb)$q$);
  perform pg_temp.res('30 a bad UPI ID is refused', r ->> 'err' like '22023%UPI%', r::text);
end $$;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; c jsonb; r jsonb; t text; begin
  perform pg_temp.su();
  c := public._comms_cfg(a);
  perform pg_temp.res('31 a studio that never saved: payment reminders ON, 3 before / on the day / 3 after (once)',
    (c ->> 'pay_enabled')::boolean and (c ->> 'pay_before_days')::int = 3 and (c ->> 'pay_on_due')::boolean
    and (c ->> 'pay_every_days')::int = 3 and (c ->> 'pay_max_overdue')::int = 1, c::text);
  perform pg_temp.res('32 column defaults: a newly saved row starts ON with one overdue step',
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'comms_settings' and column_name = 'pay_enabled') = 'true'
    and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'comms_settings' and column_name = 'pay_max_overdue') = '1');
  q := pg_temp.event(a, 'PS-6', 100000, 40); perform pg_temp.put('q6', q::text);
  insert into public.payment_milestones(quote_id, org_id, label, amount, status, due_date, seq) values
    (q, a, 'Pre', 10000, 'due', pg_temp.today() + 3, 1), (q, a, 'Today', 10000, 'due', pg_temp.today(), 2),
    (q, a, 'Late3', 10000, 'due', pg_temp.today() - 3, 3), (q, a, 'Late6', 10000, 'due', pg_temp.today() - 6, 4);
  r := public.comms_tick();
  perform pg_temp.res('33 tick queues -3 / 0 / +3 reminders, not +6 (max one overdue step)',
    (select count(*) from public.comms_outbox o where o.quote_id = q and o.purpose = 'pay_reminder') = 3
    and exists (select 1 from public.comms_outbox o where o.quote_id = q and o.dedupe_key like '%:pre:email')
    and exists (select 1 from public.comms_outbox o where o.quote_id = q and o.dedupe_key like '%:due:email')
    and exists (select 1 from public.comms_outbox o where o.quote_id = q and o.dedupe_key like '%:od1:email'),
    (select string_agg(o.dedupe_key, ',') from public.comms_outbox o where o.quote_id = q));
  select o.payload ->> 'text' into t from public.comms_outbox o where o.quote_id = q and o.dedupe_key like '%:pre:email';
  perform pg_temp.res('34 the reminder carries the pay details (UPI + note)', t like '%UPI: studioa@okaxis%' and t like '%Bank: HDFC 1234%' and t like '%due in 3 days%', t);
  perform pg_temp.res('35 the bell: one overdue notice per overdue payment (money type)',
    (select count(*) from public.notifications n where n.quote_id = q and n.kind = 'payment_overdue') = 2
    and public.notification_type_of('payment_overdue', 'in_app') = 'payment_overdue'
    and exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'payment_overdue' and (e ->> 'money')::boolean),
    (select count(*)::text from public.notifications n where n.quote_id = q and n.kind = 'payment_overdue'));
  r := public.comms_tick();
  perform pg_temp.res('36 a second tick queues / rings nothing again',
    (select count(*) from public.comms_outbox o where o.quote_id = q and o.purpose = 'pay_reminder') = 3
    and (select count(*) from public.notifications n where n.quote_id = q and n.kind = 'payment_overdue') = 2);
  perform pg_temp.res('37 overdue notice by default: admin + finance viewers, not crew',
    public.notify_default(a, 'admin', 'payment_overdue', 'in_app') and not public.notify_default(a, 'crew', 'payment_overdue', 'in_app'));
end $$;

-- pause
select pg_temp.login('a_admin@a.test');
do $$ declare q uuid := pg_temp.get('q6')::uuid; r jsonb; s jsonb; v jsonb; begin
  r := pg_temp.j(format($q$select public.payment_schedule_pause(%L, true)$q$, q));
  perform pg_temp.res('38 pause automatic reminders for the event', (r ->> 'paused')::boolean, r::text);
  s := pg_temp.j(format($q$select public.payment_schedule_for_quote(%L)$q$, q));
  perform pg_temp.res('39 the schedule says paused; overdue rows say overdue',
    (s ->> 'paused')::boolean and s -> 'rows' -> 0 ->> 'state' = 'overdue' and s -> 'rows' -> 3 ->> 'state' = 'due', s::text);
  perform pg_temp.su();
  insert into public.payment_milestones(quote_id, org_id, label, amount, status, due_date, seq) values (q, 'a0000000-0000-4000-8000-000000000001', 'Soon', 5000, 'due', pg_temp.today() + 2, 5);
  perform public.comms_tick();
  perform pg_temp.res('40 paused: no new automatic reminder', not exists (select 1 from public.comms_outbox o
    join public.payment_milestones m on m.id = o.milestone_id where m.label = 'Soon' and m.quote_id = q));
  v := public.comms_outbox_claim(100);
  perform pg_temp.res('41 paused: the waiting automatic reminders are skipped, never handed out',
    (select count(*) from public.comms_outbox o where o.quote_id = q and o.status = 'skipped') = 3
    and not exists (select 1 from jsonb_array_elements(v) x join public.comms_outbox o on o.id = (x ->> 'id')::uuid where o.quote_id = q), v::text);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format($q$select public.payment_reminder_send_now(%L)$q$, (select id from public.payment_milestones where quote_id = q and label = 'Soon')));
  perform pg_temp.res('42 "Send reminder now" still works while paused', (r ->> 'queued')::int = 1, r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_pause(%L, false)$q$, q));
  perform pg_temp.res('43 resume', not (r ->> 'paused')::boolean and exists (select 1 from public.audit_log l where l.quote_id = q and l.action = 'payment_reminders.resumed'), r::text);
end $$;

-- ---- 5) Control Center templates + settings ---------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; t jsonb; s jsonb; begin
  t := pg_temp.j($q$select public.payment_schedule_template_save(null, 'Corporate 40/60', '[{"label":"Booking 40%","kind":"percent","value":40},{"label":"Balance","kind":"balance","anchor":"event","offset_days":-10}]'::jsonb)$q$);
  perform pg_temp.res('44 admin adds a custom template', t ->> 'id' is not null and jsonb_array_length(t -> 'lines') = 2, t::text);
  perform pg_temp.put('tpl', t ->> 'id');
  r := pg_temp.j($q$select public.payment_schedule_template_save(null, 'corporate 40/60', '[{"label":"All","value":100}]'::jsonb)$q$);
  perform pg_temp.res('45 the same name twice is refused', r ->> 'err' like '22023%already%', r::text);
  r := pg_temp.j($q$select public.payment_schedule_template_save(null, 'Bad', '[{"label":"A","value":50}]'::jsonb)$q$);
  perform pg_temp.res('46 a template that does not add up is refused', r ->> 'err' like '22023%100%', r::text);
  s := pg_temp.j(format($q$select public.payment_schedule_settings_set(jsonb_build_object('default_template', %L))$q$, t ->> 'id'));
  perform pg_temp.res('47 it becomes the default', s ->> 'default_template' = t ->> 'id' and jsonb_array_length(s -> 'templates') = 1, s::text);
end $$;
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; begin
  q := pg_temp.event(a, 'PS-7', 200000, 50);
  update public.quotes set approval_status = 'approved' where id = q;
  perform pg_temp.res('48 the studio default is what approval applies', pg_temp.ms(q) = 'Booking 40%=80000.00@0:due | Balance=120000.00@40:due', pg_temp.ms(q));
end $$;
select pg_temp.login('b_admin@b.test');
do $$ declare r jsonb; begin
  r := pg_temp.j(format($q$select public.payment_schedule_settings_set(jsonb_build_object('default_template', %L))$q$, pg_temp.get('tpl')));
  perform pg_temp.res('49 another studio''s template can''t be picked', r ->> 'err' like '22023%', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_template_archive(%L)$q$, pg_temp.get('tpl')));
  perform pg_temp.res('50 another studio can''t archive it', r ->> 'err' like '42501%', r::text);
  r := pg_temp.j($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('51 studio B does not see studio A''s templates', jsonb_array_length(r -> 'templates') = 0 and r ->> 'auto_apply' = 'false', r::text);
end $$;
select pg_temp.login('ps_crew@a.test');
do $$ declare r jsonb; begin
  r := pg_temp.j($q$select public.payment_schedule_settings_set('{"auto_apply": false}'::jsonb)$q$);
  perform pg_temp.res('52 crew can''t change the settings', r ->> 'err' like '42501%', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_for_quote(%L)$q$, pg_temp.get('q1')));
  perform pg_temp.res('53 crew (no Finance view) can''t read an event''s schedule', r ->> 'err' like '42501%', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_pause(%L, true)$q$, pg_temp.get('q1')));
  perform pg_temp.res('54 crew can''t pause reminders', r ->> 'err' like '42501%', r::text);
end $$;
select pg_temp.login('a_admin@a.test');
do $$ declare r jsonb; s jsonb; begin
  r := pg_temp.j(format($q$select public.payment_schedule_template_archive(%L)$q$, pg_temp.get('tpl')));
  s := pg_temp.j($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('55 archive (kept, not deleted): the default falls back to 30 / 50 / 20',
    (r ->> 'archived')::boolean and s ->> 'default_template' = 'builtin:30-50-20'
    and exists (select 1 from public.payment_schedule_templates t where t.id = pg_temp.get('tpl')::uuid and t.archived_at is not null), s::text);
end $$;

-- ---- 6) manual apply with preview ---------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid; r jsonb; begin
  q := pg_temp.event(a, 'PS-8', 120000, 20); perform pg_temp.put('q8', q::text);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.j(format($q$select public.payment_schedule_apply(%L, 'builtin:50-50', true)$q$, q));
  perform pg_temp.res('56 preview shows the rows and writes nothing',
    (r ->> 'preview')::boolean and jsonb_array_length(r -> 'schedule') = 2 and (r -> 'schedule' -> 0 ->> 'amount')::numeric = 60000 and pg_temp.ms(q) = '', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_apply(%L, 'builtin:50-50')$q$, q));
  perform pg_temp.res('57 apply writes the schedule (manual)', (r ->> 'applied')::boolean
    and pg_temp.ms(q) = 'Advance (50%)=60000.00@0:due | Balance (50%)=60000.00@13:due'
    and exists (select 1 from public.payment_schedule_quote_prefs p where p.quote_id = q and p.applied_source = 'manual'), r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_apply(%L, 'builtin:100-upfront')$q$, q));
  perform pg_temp.res('58 a second apply is refused (never overwrites)', r ->> 'err' like '22023%already has a payment schedule%', r::text);
  perform pg_temp.login('b_admin@b.test');
  r := pg_temp.j(format($q$select public.payment_schedule_apply(%L, 'builtin:50-50', true)$q$, pg_temp.get('q1')));
  perform pg_temp.res('59 another studio can''t preview / apply on this event', r ->> 'err' like '42501%', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_for_quote(%L)$q$, pg_temp.get('q1')));
  perform pg_temp.res('60 another studio can''t read this event''s schedule', r ->> 'err' like '42501%', r::text);
  r := pg_temp.j(format($q$select public.payment_schedule_pause(%L, true)$q$, pg_temp.get('q1')));
  perform pg_temp.res('61 another studio can''t pause this event', r ->> 'err' like '42501%', r::text);
end $$;

-- ---- 7) the client page -----------------------------------------------------------------------------------------------------
select pg_temp.anon();
do $$ declare r jsonb; tok uuid; begin
  perform pg_temp.su(); select approval_token into tok from public.quotes where id = pg_temp.get('q6')::uuid;
  perform pg_temp.anon();
  r := pg_temp.j(format($q$select public.public_payment_schedule(%L)$q$, tok));
  perform pg_temp.res('62 client page: schedule with overdue / due + how to pay (UPI)',
    r -> 'rows' -> 0 ->> 'state' = 'overdue' and r -> 'pay' ->> 'upi' = 'studioa@okaxis' and r -> 'pay' ->> 'link' is null
    and jsonb_array_length(r -> 'rows') = 5, r::text);
  r := pg_temp.j($q$select public.public_payment_schedule('00000000-0000-4000-8000-000000000000')$q$);
  perform pg_temp.res('63 client page: a wrong link is refused', r ? 'err', r::text);
end $$;

-- ---- 8) closed tables -------------------------------------------------------------------------------------------------------
select pg_temp.login('a_admin@a.test');
do $$ declare e text; begin
  e := pg_temp.try($q$insert into public.payment_schedule_templates(org_id, name, lines) values ('a0000000-0000-4000-8000-000000000001', 'x', '[{}]')$q$);
  perform pg_temp.res('64 no direct writes to the templates table', e like '42501%', e);
  e := pg_temp.try($q$update public.payment_schedule_quote_prefs set reminders_paused = false$q$);
  perform pg_temp.res('65 no direct writes to the per-event prefs', e like '42501%', e);
  e := pg_temp.try($q$select * from public.payment_overdue_alerts$q$);
  perform pg_temp.res('66 the bell bookkeeping is not readable by the app', e like '42501%', e);
end $$;
select pg_temp.anon();
do $$ declare e text; begin
  e := pg_temp.try($q$select * from public.payment_schedule_settings$q$);
  perform pg_temp.res('67 signed-out callers can''t read studio settings', e like '42501%', e);
  e := pg_temp.try($q$select public.payment_schedule_settings_get()$q$);
  perform pg_temp.res('68 signed-out callers can''t call the staff RPCs', e like '42501%', e);
end $$;
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('69 the trial retention lists know the new tables',
    position('payment_schedule_quote_prefs' in pg_get_functiondef('public._tr184_purge_tables()'::regprocedure)) > 0
    and position('payment_schedule_settings' in pg_get_functiondef('public._tr184_keep_tables()'::regprocedure)) > 0);
  perform pg_temp.res('70 the wrapped bodies are kept and not callable by the app',
    not has_function_privilege('authenticated', 'public.record_payment__pre0264(uuid,numeric,text,text,uuid,text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.comms_tick()', 'execute')
    and has_function_privilege('authenticated', 'public.record_payment(uuid,numeric,text,text,uuid,text,text)', 'execute')
    and has_function_privilege('anon', 'public.public_payment_schedule(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.payment_schedule_for_quote(uuid)', 'execute'));
end $$;

select pg_temp.su();
select name, result from _ps order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R23-PAYMENT-SCHEDULES-0264: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R23-PAYMENT-SCHEDULES-0264: ' || count(*) filter (where result <> 'PASS') || ' FAILED' end as summary
  from _ps;
rollback;
