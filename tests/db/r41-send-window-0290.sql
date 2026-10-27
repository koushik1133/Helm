-- r41-send-window-0290.sql -- 0290: the studio SEND WINDOW. Automatic client / staff messages queued outside the window
-- (studio time) are HELD (still pending, not_before + claim lease) and handed out when it opens; security alerts, OTPs,
-- invites and clicked sends are never held; Dubai studios use Dubai time; nothing is lost. The fixed-time checks run
-- under six session time zones; the queue checks build a window that is closed / open at the moment the suite runs,
-- so the result does not depend on the hour. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
set local helm.send_window = 'on';   -- run-all.sh switches the hold off for the older suites
create temp table _sw(name text, result text); grant all on _sw to anon, authenticated, service_role;
create temp table _swkv(k text primary key, v text); grant all on _swkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _sw values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _swkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _swkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
-- a window (both audiences) that is CLOSED right now in the studio's zone; the hold must end at its start
create or replace function pg_temp.close_window(p_org uuid) returns time language plpgsql as $$
declare t time := (now() at time zone public.studio_timezone(p_org))::time; s time; e time;
begin
  if t < time '22:00' then s := (date_trunc('minute', date '2000-01-01' + t) + interval '61 minutes')::time; e := time '24:00';
  else s := time '00:00'; e := time '12:00'; end if;
  insert into public.studio_send_windows(org_id, client_start, client_end, staff_start, staff_end, enabled)
    values (p_org, s, e, s, e, true)
  on conflict (org_id) do update set client_start = s, client_end = e, staff_start = s, staff_end = e, enabled = true;
  return s;
end $$;
create or replace function pg_temp.open_window(p_org uuid) returns void language plpgsql as $$
begin
  insert into public.studio_send_windows(org_id, client_start, client_end, staff_start, staff_end, enabled)
    values (p_org, time '00:00', time '24:00', time '00:00', time '24:00', true)
  on conflict (org_id) do update set client_start = time '00:00', client_end = time '24:00', staff_start = time '00:00',
                                     staff_end = time '24:00', enabled = true;
end $$;
-- "the clock reaches the window start": the same as now() passing not_before (the transaction clock cannot move)
create or replace function pg_temp.release(p_table text, p_ids uuid[]) returns void language plpgsql as $$
declare v_lease text := public._sw290_lease_col(p_table);
begin
  execute format('update public.%I set not_before = now() - interval ''1 second'', %I = now() - interval ''10 minutes 1 second'' where id = any ($1)',
                 p_table, v_lease) using p_ids;
end $$;

-- a pending row that exists BEFORE 0290 is (re-)applied must not be touched by it
do $$ begin
  perform pg_temp.su();
  perform set_config('helm.send_window', 'off', true);
  insert into public.comms_outbox(id, org_id, purpose, channel, recipient, payload, dedupe_key)
    values ('a0000000-0000-4000-8000-0000000290f0', 'a0000000-0000-4000-8000-000000000001', 'follow_up', 'email',
            'old@example.test', '{"stage":"fu1"}', 'r41:old-row');
  perform set_config('helm.send_window', 'on', true);
end $$;

-- the migration, twice (safe to re-run)
\ir ../../supabase/migrations/0290_send_window.sql
\ir ../../supabase/migrations/0290_send_window.sql

-- ---- 0) shape, privileges, nothing changed ---------------------------------------------------------------------------
do $$ declare n integer; begin
  perform pg_temp.su();
  select count(*) into n from pg_trigger where tgname = 'zz_sw290_send_window' and not tgisinternal;
  perform pg_temp.res('00 one trigger on each of the 6 queues (+ referral queue only when 0279 is in)',
    n = 6 + case when to_regclass('public.referral_notice_queue') is null then 0 else 1 end, n::text);
  perform pg_temp.res('01 never on the security / OTP / invite / welcome / package / clock-time queues',
    not exists (select 1 from pg_trigger g where g.tgname = 'zz_sw290_send_window'
                  and g.tgrelid::regclass::text in ('security_alert_outbox', 'pkg_outbox', 'invite_email_outbox', 'welcome_email_outbox',
                                                    'assign_notify_outbox', 'runsheet_reminder_sends', 'delivery_reminder_sends')));
  perform pg_temp.res('02 the window table: RLS on, no API privilege; helpers not callable from the API',
    (select relrowsecurity from pg_class where oid = 'public.studio_send_windows'::regclass)
    and not has_table_privilege('authenticated', 'public.studio_send_windows', 'select')
    and not has_table_privilege('anon', 'public.studio_send_windows', 'select')
    and not has_function_privilege('authenticated', 'public.send_window_next(uuid, text, timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public._sw290_not_before(text, jsonb, timestamptz)', 'execute')
    and has_function_privilege('service_role', 'public.send_window_next(uuid, text, timestamptz)', 'execute'));
  perform pg_temp.res('03 a row waiting before 0290 keeps its timing (no row changed by the migration)',
    exists (select 1 from public.comms_outbox where id = 'a0000000-0000-4000-8000-0000000290f0'
              and not_before is null and claimed_at is null and status = 'pending'));
  perform pg_temp.res('04 vendor reminders: "stale after 12 h" counts from the end of the hold',
    position('coalesce(not_before, created_at) < now() - interval ''12 hours''' in
             pg_get_functiondef('public.vendor_request_claim(integer, text)'::regprocedure)) > 0);
  begin
    insert into public.studio_send_windows(org_id, client_start, client_end) values ('b0000000-0000-4000-8000-000000000001', '10:00', '10:30');
    perform pg_temp.res('05 a window shorter than one hour is refused', false, 'accepted');
  exception when check_violation then perform pg_temp.res('05 a window shorter than one hour is refused', true);
  end;
end $$;

-- ---- 1) the window maths at fixed moments, under six session time zones --------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
  z text; bad text := ''; ok boolean;
begin
  perform pg_temp.su();
  update public.organizations set timezone = 'Asia/Kolkata' where id = a;
  update public.organizations set timezone = 'Asia/Dubai' where id = b;
  delete from public.studio_send_windows where org_id in (a, b);   -- test rows only (rolled back): the defaults
  foreach z in array array['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'] loop
    perform set_config('TimeZone', z, true);
    ok :=
      -- client, India: 23:30 IST (18:00 UTC) -> 09:00 IST next day (03:30 UTC)
      public.send_window_next(a, 'client', '2026-10-27 18:00:00+00') = timestamptz '2026-10-28 03:30:00+00'
      -- 00:37 IST (the trial / quote-expiry job) -> 09:00 IST the same day
      and public.send_window_next(a, 'client', '2026-10-27 19:07:00+00') = timestamptz '2026-10-28 03:30:00+00'
      -- edges: 08:59 -> 09:00; 09:00 and 19:59 go at once; 20:00 -> next 09:00
      and public.send_window_next(a, 'client', '2026-10-28 03:29:00+00') = timestamptz '2026-10-28 03:30:00+00'
      and public.send_window_next(a, 'client', '2026-10-28 03:30:00+00') = timestamptz '2026-10-28 03:30:00+00'
      and public.send_window_next(a, 'client', '2026-10-28 14:29:00+00') = timestamptz '2026-10-28 14:29:00+00'
      and public.send_window_next(a, 'client', '2026-10-28 14:30:00+00') = timestamptz '2026-10-29 03:30:00+00'
      -- staff, India: 07:00 IST -> 08:00 IST; 20:30 IST still inside the staff window (not the client one)
      and public.send_window_next(a, 'staff', '2026-10-28 01:30:00+00') = timestamptz '2026-10-28 02:30:00+00'
      and public.send_window_next(a, 'staff', '2026-10-28 15:00:00+00') = timestamptz '2026-10-28 15:00:00+00'
      and public.send_window_next(a, 'client', '2026-10-28 15:00:00+00') = timestamptz '2026-10-29 03:30:00+00'
      -- Dubai uses Dubai time: 23:30 GST (19:30 UTC) -> 09:00 GST (05:00 UTC); 07:15 GST -> 09:00 GST while India is open
      and public.send_window_next(b, 'client', '2026-10-27 19:30:00+00') = timestamptz '2026-10-28 05:00:00+00'
      and public.send_window_next(b, 'client', '2026-10-28 03:15:00+00') = timestamptz '2026-10-28 05:00:00+00'
      and public.send_window_next(a, 'client', '2026-10-28 03:45:00+00') = timestamptz '2026-10-28 03:45:00+00'
      -- any other audience is never held
      and public.send_window_next(a, 'security', '2026-10-27 20:30:00+00') = timestamptz '2026-10-27 20:30:00+00'
      and public.send_window_next(a, null, '2026-10-27 20:30:00+00') = timestamptz '2026-10-27 20:30:00+00';
    if not coalesce(ok, false) then bad := bad || z || ' '; end if;
  end loop;
  perform set_config('TimeZone', 'America/New_York', true);
  perform pg_temp.res('10 India / Dubai window maths are the same in 6 session zones (UTC, US, IST, +14, -11)', bad = '', bad);
  -- per-studio setting
  insert into public.studio_send_windows(org_id, client_start, client_end) values (b, '10:00', '18:00');
  perform pg_temp.res('11 a Dubai studio with its own 10:00-18:00 window: 09:30 GST -> 10:00 GST; 17:59 at once; 18:00 -> next 10:00',
    public.send_window_next(b, 'client', '2026-10-28 05:30:00+00') = timestamptz '2026-10-28 06:00:00+00'
    and public.send_window_next(b, 'client', '2026-10-28 13:59:00+00') = timestamptz '2026-10-28 13:59:00+00'
    and public.send_window_next(b, 'client', '2026-10-28 14:00:00+00') = timestamptz '2026-10-29 06:00:00+00'
    and public.send_window_next(b, 'staff', '2026-10-28 03:30:00+00') = timestamptz '2026-10-28 04:00:00+00');   -- staff keeps 08:00
  update public.studio_send_windows set enabled = false where org_id = b;
  perform pg_temp.res('12 a studio that switched the hold off: never held',
    public.send_window_next(b, 'client', '2026-10-27 19:30:00+00') = timestamptz '2026-10-27 19:30:00+00');
  delete from public.studio_send_windows where org_id = b;
end $$;

-- ---- 2) what is held and what is never held (classifier at 02:00 IST = 20:30 UTC) ------------------------------------
do $$ declare a text := 'a0000000-0000-4000-8000-000000000001'; t timestamptz := '2026-10-27 20:30:00+00';
  n9 timestamptz := '2026-10-28 03:30:00+00'; n8 timestamptz := '2026-10-28 02:30:00+00'; k text; bad text := '';
begin
  perform pg_temp.su();
  delete from public.studio_send_windows where org_id = a::uuid;
  -- security alerts at 02:00: out at once (R33 team safety, R35 payment details, HQ staff, studio name, closure, sales)
  foreach k in array array['team_safety', 'studio_security', 'hq_staff', 'studio_identity', 'close_request', 'close_decision',
                           'sales_request', 'sales_enquiry', 'sales_enquiry_ack', 'suggestion', 'upgrade_ask', 'some_new_kind'] loop
    if public._sw290_not_before('helm_notice_outbox', jsonb_build_object('kind', k, 'org_id', a, 'status', 'pending'), t) is not null then
      bad := bad || k || ' '; end if;
  end loop;
  perform pg_temp.res('20 security alert at 02:00 (two-step, payment details, admin / team, HQ staff, studio name) goes out at once', bad = '', bad);
  perform pg_temp.res('21 instant notification e-mails are never held; the daily digest waits for 08:00 IST',
    public._sw290_not_before('helm_notice_outbox', jsonb_build_object('kind', 'inbox_digest', 'org_id', a, 'payload', jsonb_build_object('mode', 'instant_important')), t) is null
    and public._sw290_not_before('helm_notice_outbox', jsonb_build_object('kind', 'inbox_digest', 'org_id', a, 'status', 'pending', 'payload', jsonb_build_object('mode', 'daily')), t) = n8);
  -- OTP / sign-in / password / invites / welcome / package replies have their own queues (no trigger) or no queue at all
  bad := '';
  foreach k in array array['pkg_outbox', 'security_alert_outbox', 'invite_email_outbox', 'welcome_email_outbox', 'assign_notify_outbox',
                           'runsheet_reminder_sends', 'delivery_reminder_sends', 'upload_scan'] loop
    if public._sw290_not_before(k, jsonb_build_object('org_id', a, 'status', 'pending', 'payload', jsonb_build_object('otp', '123456')), t) is not null then
      bad := bad || k || ' '; end if;
  end loop;
  perform pg_temp.res('22 an OTP (and every other security / invite / clock-time queue) goes out at once', bad = '', bad);
  perform pg_temp.res('23 a WhatsApp copy of an OTP / security alert / announcement is never held',
    public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'wa_forward', 'status', 'pending', 'payload', jsonb_build_object('kind', 'otp', 'type', 'otp')), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'wa_forward', 'status', 'pending', 'payload', jsonb_build_object('kind', 'security', 'type', 'security_alert')), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'wa_forward', 'status', 'pending', 'payload', jsonb_build_object('type', 'admin_message', '__chat', true)), t) is null);
  perform pg_temp.res('24 clicked sends go at once: "Send now" payment reminder, "Send a nudge", invitation site, booklet, vendor request',
    public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'pay_reminder', 'status', 'pending', 'payload', jsonb_build_object('manual', true)), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'follow_up', 'status', 'pending', 'payload', jsonb_build_object('manual', true, 'r23', 'nudge')), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'invite_site', 'status', 'pending'), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'booklet_link', 'status', 'pending'), t) is null
    and public._sw290_not_before('vendor_request_sends', jsonb_build_object('org_id', a, 'kind', 'request', 'status', 'pending'), t) is null);
  perform pg_temp.res('25 automatic client messages at 02:00 wait for 09:00 IST (payment reminder, follow-up, quote expiry, vendor reminder)',
    public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'pay_reminder', 'status', 'pending', 'payload', jsonb_build_object('manual', false)), t) = n9
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'follow_up', 'status', 'pending', 'payload', '{}'::jsonb), t) = n9
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'quote_expiry', 'status', 'pending'), t) = n9
    and public._sw290_not_before('vendor_request_sends', jsonb_build_object('org_id', a, 'kind', 'reminder', 'status', 'pending'), t) = n9);
  perform pg_temp.res('26 automatic staff messages at 02:00 wait for 08:00 IST (trial, retention, billing, referral, date-based WhatsApp copies)',
    public._sw290_not_before('trial_reminders', jsonb_build_object('org_id', a, 'email_status', 'pending', 'trial_ends_at', '2026-10-29 10:00:00+00'), t) = n8
    and public._sw290_not_before('trial_retention_notices', jsonb_build_object('org_id', a, 'email_status', 'pending'), t) = n8
    and public._sw290_not_before('billing_reminders', jsonb_build_object('org_id', a), t) = n8
    and public._sw290_not_before('referral_notice_queue', jsonb_build_object('studio_id', a, 'status', 'queued'), t) = n8
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'wa_forward', 'status', 'pending', 'payload', jsonb_build_object('kind', 'event_reminder', 'type', 'other')), t) = n8
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'wa_forward', 'status', 'pending', 'payload', jsonb_build_object('kind', 'trial_reminder', 'type', 'billing_trial')), t) = n8);
  perform pg_temp.res('27 "your trial ends today" is never held past the end of the trial (sent now instead of skipped)',
    public._sw290_not_before('trial_reminders', jsonb_build_object('org_id', a, 'email_status', 'pending', 'trial_ends_at', '2026-10-27 21:30:00+00'), t) is null
    and public._sw290_not_before('trial_reminders', jsonb_build_object('org_id', a, 'email_status', 'pending', 'trial_ends_at', '2026-10-28 09:00:00+00'), t) = n8);
  perform pg_temp.res('28 a bad value never delays or blocks (no studio, bad id, already sent)',
    public._sw290_not_before('comms_outbox', jsonb_build_object('purpose', 'pay_reminder', 'status', 'pending'), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', 'not-a-uuid', 'purpose', 'pay_reminder'), t) is null
    and public._sw290_not_before('comms_outbox', jsonb_build_object('org_id', a, 'purpose', 'pay_reminder', 'status', 'sent'), t) is null);
end $$;

-- ---- 3) the real queue: a client reminder queued while the window is closed is HELD, then claimed when it opens -------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; s time; v_ids uuid[]; r jsonb; n integer; v_nb timestamptz;
  v_exp timestamptz;
begin
  perform pg_temp.su();
  insert into public.comms_settings(org_id, pay_enabled, pay_max_overdue) values (a, true, 3)
    on conflict (org_id) do update set pay_enabled = true, pay_max_overdue = 3;
  update public.comms_settings set pay_enabled = false where org_id <> a;
  insert into public.quotes(id, code, title, status, client, pricing, org_id, event_date, approval_status) values
    ('a0000000-0000-4000-8000-0000000290e1', 'SW-1', 'Window One', 'confirmed', '{"name":"Riya","email":"riya.sw@example.test"}',
     '{"subtotal":100000,"discount":0,"gstPct":0,"total":100000}', a, public.studio_today(a) + 10, 'approved');
  insert into public.payment_milestones(id, quote_id, label, due_date, amount, status, org_id) values
    ('a0000000-0000-4000-8000-0000000290a1', 'a0000000-0000-4000-8000-0000000290e1', 'Advance', public.studio_today(a) + 2, 30000, 'due', a),
    ('a0000000-0000-4000-8000-0000000290a2', 'a0000000-0000-4000-8000-0000000290e1', 'Second', public.studio_today(a) - 7, 40000, 'due', a);
  s := pg_temp.close_window(a);
  v_exp := public.send_window_next(a, 'client', now());
  perform public.comms_tick();
  select array_agg(id) into v_ids from public.comms_outbox where quote_id = 'a0000000-0000-4000-8000-0000000290e1' and purpose = 'pay_reminder';
  perform pg_temp.put('held', array_to_string(v_ids, ','));
  perform pg_temp.res('30 the automatic job queued the client reminders (window closed now)', coalesce(array_length(v_ids, 1), 0) >= 1,
    coalesce(array_length(v_ids, 1), 0)::text);
  perform pg_temp.res('31 queued outside the window -> HELD: still pending, not_before = the window start (studio time), lease = start - 10 min',
    v_exp > now() and (v_exp at time zone public.studio_timezone(a))::time = s
    and not exists (select 1 from public.comms_outbox where id = any (v_ids)
                      and not (status = 'pending' and sent_at is null and attempts = 0 and not_before = v_exp
                               and claimed_at = v_exp - interval '10 minutes')), v_exp::text);
  perform pg_temp.svc();
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('32 the sender takes nothing while the window is closed (and skips / fails nothing)',
    not exists (select 1 from jsonb_array_elements(coalesce(r, '[]'::jsonb)) e where (e ->> 'id')::uuid = any (v_ids))
    and not exists (select 1 from public.comms_outbox where id = any (v_ids) and (status <> 'pending' or sent_at is not null or attempts <> 0)), r::text);
  -- the clock reaches 09:00 IST (the window start)
  perform pg_temp.release('comms_outbox', v_ids);
  perform pg_temp.svc();
  r := public.comms_outbox_claim(100);
  perform pg_temp.su();
  select count(*) into n from jsonb_array_elements(coalesce(r, '[]'::jsonb)) e where (e ->> 'id')::uuid = any (v_ids);
  perform pg_temp.res('33 at the window start every held reminder is claimed (nothing lost)', n = array_length(v_ids, 1),
    n::text || '/' || array_length(v_ids, 1)::text || ' ' || coalesce(r::text, ''));
  -- a failed send while the window is closed again: the retry waits for the next opening too
  perform pg_temp.svc();
  perform public.comms_outbox_mark(v_ids[1], 'retry');
  perform pg_temp.su();
  select not_before into v_nb from public.comms_outbox where id = v_ids[1];
  perform pg_temp.res('34 a retry outside the window is held again (still pending, lease = next start - 10 min)',
    exists (select 1 from public.comms_outbox where id = v_ids[1] and status = 'pending' and sent_at is null
              and not_before = v_exp and claimed_at = v_exp - interval '10 minutes'), coalesce(v_nb::text, 'null'));
  perform pg_temp.svc();
  for n in 2 .. coalesce(array_length(v_ids, 1), 1) loop perform public.comms_outbox_mark(v_ids[n], 'sent'); end loop;
  perform pg_temp.su();
  -- "Send now" (manual) at the same moment: not held
  insert into public.comms_outbox(org_id, quote_id, milestone_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, 'a0000000-0000-4000-8000-0000000290e1', 'a0000000-0000-4000-8000-0000000290a1', 'pay_reminder', 'email',
            'riya.sw@example.test', '{"manual":true,"text":"x"}', 'r41:manual');
  perform pg_temp.res('35 "Send now" while the window is closed goes at once (no hold, no lease)',
    exists (select 1 from public.comms_outbox where dedupe_key = 'r41:manual' and not_before is null and claimed_at is null));
  -- inside the window nothing is held
  perform pg_temp.open_window(a);
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, 'a0000000-0000-4000-8000-0000000290e1', 'follow_up', 'email', 'riya.sw@example.test', '{"stage":"fu1"}', 'r41:inside');
  perform pg_temp.res('36 queued inside the window: sent at once as before',
    exists (select 1 from public.comms_outbox where dedupe_key = 'r41:inside' and not_before is null and claimed_at is null));
  update public.studio_send_windows set enabled = false where org_id = a;
  perform pg_temp.close_window(a);
  update public.studio_send_windows set enabled = false where org_id = a;
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key)
    values (a, 'a0000000-0000-4000-8000-0000000290e1', 'follow_up', 'email', 'riya.sw@example.test', '{"stage":"fu2"}', 'r41:off');
  perform pg_temp.res('37 a studio that switched the hold off: sent at once',
    exists (select 1 from public.comms_outbox where dedupe_key = 'r41:off' and not_before is null and claimed_at is null));
end $$;

-- ---- 4) security alert / OTP at night: never held; the daily digest next to it is held -------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; s time; v_exp timestamptz; begin
  perform pg_temp.su();
  s := pg_temp.close_window(a);
  v_exp := public.send_window_next(a, 'staff', now());
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('studio_identity', a, gen_random_uuid(), '{}'::jsonb, 'r41:sec');
    perform pg_temp.res('40 a security notice queued while the window is closed goes out at once',
      exists (select 1 from public.helm_notice_outbox where dedupe_key = 'r41:sec' and not_before is null and claimed_at is null));
  exception when check_violation then perform pg_temp.res('40 a security notice queued while the window is closed goes out at once', false, 'kind check');
  end;
  insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
    values ('inbox_digest', a, gen_random_uuid(), '{"mode":"instant_important","ids":[]}'::jsonb, 'r41:instant'),
           ('inbox_digest', a, gen_random_uuid(), '{"mode":"daily","ids":[]}'::jsonb, 'r41:daily');
  perform pg_temp.res('41 instant notification e-mail at once; the daily digest held to the staff window start',
    exists (select 1 from public.helm_notice_outbox where dedupe_key = 'r41:instant' and not_before is null and claimed_at is null)
    and exists (select 1 from public.helm_notice_outbox where dedupe_key = 'r41:daily' and not_before = v_exp
                  and claimed_at = v_exp - interval '10 minutes' and status = 'pending')
    and (v_exp at time zone public.studio_timezone(a))::time = s);
  perform pg_temp.svc();
  perform public.helm_notice_outbox_claim(100);
  perform pg_temp.su();
  perform pg_temp.res('42 the notice claim leaves the held digest waiting (pending, not skipped, no attempt)',
    exists (select 1 from public.helm_notice_outbox where dedupe_key = 'r41:daily' and status = 'pending' and sent_at is null and attempts = 0));
  perform pg_temp.res('43 OTP: the send-otp path has no queue and the OTP-carrying package queue has no send-window trigger',
    not exists (select 1 from pg_trigger where tgname = 'zz_sw290_send_window' and tgrelid = to_regclass('public.pkg_outbox'))
    and not exists (select 1 from pg_trigger where tgname = 'zz_sw290_send_window' and tgrelid = to_regclass('public.security_alert_outbox')));
end $$;

-- ---- 5) trial e-mails (the Helm-level job that runs today): held at night, claimed at the window start ----------------
-- a fresh trial studio (the fixture studios may carry plan payments from earlier suites)
do $$ declare a uuid := 'c0000000-0000-4000-8000-000000000290'; s time; v_exp timestamptz; v_id uuid; r jsonb; v_tz text; begin
  perform pg_temp.su();
  insert into public.organizations(id, name, timezone) values (a, 'Window Trial Studio', 'Asia/Kolkata');
  v_tz := public.studio_timezone(a);
  -- one day left in the studio's own calendar ("ends tomorrow", d7), ending at 15:00 studio time tomorrow
  update public.organizations set trial_ends_at = (((now() at time zone v_tz)::date + 1) + time '15:00') at time zone v_tz,
         business_email = 'owner.sw@c.test' where id = a;
  s := pg_temp.close_window(a);
  v_exp := public.send_window_next(a, 'staff', now());
  perform public.trial_reminders_tick();
  select id into v_id from public.trial_reminders where org_id = a order by created_at desc limit 1;
  perform pg_temp.res('50 trial reminder queued while the window is closed is held (pending, email lease = start - 10 min)',
    exists (select 1 from public.trial_reminders where id = v_id and email_status = 'pending' and email_sent_at is null
              and not_before = v_exp and email_claimed_at = v_exp - interval '10 minutes'
              and (v_exp at time zone v_tz)::time = s), coalesce(v_id::text, 'no row'));
  perform pg_temp.svc();
  r := public.trial_reminder_email_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('51 the sender takes nothing yet (and does not skip it)',
    not exists (select 1 from jsonb_array_elements(coalesce(r, '[]'::jsonb)) e where (e ->> 'id')::uuid = v_id)
    and exists (select 1 from public.trial_reminders where id = v_id and email_status = 'pending' and email_attempts = 0), r::text);
  perform pg_temp.release('trial_reminders', array[v_id]);
  perform pg_temp.svc();
  r := public.trial_reminder_email_claim(50);
  perform pg_temp.su();
  perform pg_temp.res('52 at the window start the trial e-mail is claimed',
    exists (select 1 from jsonb_array_elements(coalesce(r, '[]'::jsonb)) e where (e ->> 'id')::uuid = v_id), coalesce(r::text, ''));
end $$;

-- ---- 6) Dubai studio: its own zone and its own window ----------------------------------------------------------------
do $$ declare b uuid := 'b0000000-0000-4000-8000-000000000001'; s time; v_exp timestamptz; z text; bad text := ''; v_nb timestamptz; i integer := 0; begin
  perform pg_temp.su();
  update public.organizations set timezone = 'Asia/Dubai' where id = b;
  s := pg_temp.close_window(b);
  foreach z in array array['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'] loop
    i := i + 1;
    perform set_config('TimeZone', z, true);
    insert into public.comms_outbox(org_id, purpose, channel, recipient, payload, dedupe_key)
      values (b, 'quote_expiry', 'email', 'zed@example.test', '{}'::jsonb, 'r41:dubai:' || i)
      returning not_before into v_nb;
    if v_nb is null or (v_nb at time zone 'Asia/Dubai')::time <> s or v_nb <> public.send_window_next(b, 'client', now()) then
      bad := bad || z || ' '; end if;
  end loop;
  perform set_config('TimeZone', 'America/New_York', true);
  perform pg_temp.res('60 Dubai studio: held to ITS window start in Dubai time, under 5 session zones', bad = '', bad);
end $$;

-- ---- 7) vendor reminder held overnight is not thrown away as "stale" --------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; v_req uuid; v_h uuid; v_old uuid; r jsonb; begin
  perform pg_temp.su();
  begin
    insert into public.automation_settings(org_id, vendor_reminders_enabled) values (a, true)
      on conflict (org_id) do update set vendor_reminders_enabled = true;
    insert into public.vendor_requests(org_id, quote_id, vendor_name, contact_email, what, when_at, agreed_amount, respond_by)
      values (a, 'a0000000-0000-4000-8000-0000000290e1', 'Chairs Co', 'vendor.sw@example.test', 'Chairs', now() + interval '3 days', 1000,
              now() + interval '1 day') returning id into v_req;
    perform pg_temp.close_window(a);
    insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key)
      values (a, v_req, 'reminder', 'email', 'vendor.sw@example.test', 'r41:vr:held') returning id into v_h;
    perform pg_temp.res('70 automatic vendor reminder queued at night is held',
      exists (select 1 from public.vendor_request_sends where id = v_h and not_before is not null and status = 'pending'));
    -- held 13 hours (queued 20:01, window opens 09:00) - it must still be sent, not marked stale
    update public.vendor_request_sends set created_at = now() - interval '13 hours' where id = v_h;
    perform pg_temp.release('vendor_request_sends', array[v_h]);
    perform set_config('helm.send_window', 'off', true);
    insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key, created_at)
      values (a, v_req, 'reminder', 'email', 'vendor.sw@example.test', 'r41:vr:old', now() - interval '13 hours') returning id into v_old;
    perform set_config('helm.send_window', 'on', true);
    perform pg_temp.svc();
    r := public.vendor_request_claim(50, 'email');
    perform pg_temp.su();
    perform pg_temp.res('71 a reminder held 13 h is not dropped as stale (the stale rule counts from the end of the hold)',
      exists (select 1 from public.vendor_request_sends where id = v_h and coalesce(reason, '') <> 'stale')
      and exists (select 1 from public.vendor_request_sends where id = v_old and reason = 'stale'),
      (select string_agg(dedupe_key || '=' || status || '/' || coalesce(reason, '-'), ' ') from public.vendor_request_sends where id in (v_h, v_old)));
  exception when others then
    perform pg_temp.su(); perform pg_temp.res('70/71 vendor reminder', false, sqlstate || ' ' || sqlerrm);
  end;
end $$;

-- ---- 8) nothing lost: every row this suite queued is still there; held rows are pending, never skipped / failed ------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('80 nothing lost: no held row was skipped or failed, every queued row still exists',
    not exists (select 1 from public.comms_outbox where not_before is not null and status in ('skipped', 'failed'))
    and not exists (select 1 from public.helm_notice_outbox where not_before is not null and status in ('skipped', 'failed'))
    and not exists (select 1 from public.trial_reminders where not_before is not null and email_status in ('skipped', 'failed'))
    and (select count(*) from public.comms_outbox where dedupe_key like 'r41:dubai:%') = 5
    and exists (select 1 from public.comms_outbox where id = 'a0000000-0000-4000-8000-0000000290f0'));
end $$;

select name, result from _sw where result <> 'PASS';
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R41-SEND-WINDOW-0290: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R41-SEND-WINDOW-0290: FAIL' end as summary from _sw;
rollback;
