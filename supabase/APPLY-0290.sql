-- APPLY-0290.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0287 (it uses the studio's time zone from 0287; without it the file stops with "STOP 0290" and
-- changes nothing). Run it after 0279 / 0283 / 0285 / 0288 / 0289 too, whatever their order. If APPLY-0279 (referrals) is
-- applied LATER than this file, run this file once more so the referral e-mails get the send window as well.
-- Send window (R41): automatic e-mails / WhatsApps that the night-time jobs queue just after the studio's midnight
-- are HELD until a sensible hour in the studio's own time zone - clients, guests and vendors 09:00-20:00, studio staff
-- 08:00-21:00 - and never dropped. Security alerts, OTP / sign-in / password e-mails, invites and anything a person
-- clicked ("Send now") still go out at once. One optional settings row per studio (studio_send_windows), no UI yet.
-- New table + nullable not_before columns + triggers + helpers; one condition in vendor_request_claim. No row is
-- changed or deleted (messages already waiting keep their timing). Safe to run twice. ASCII only. No temp tables.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Redeploy ONE edge function (it reads the new not_before column; it is dormant until
--      HELM_BILLING_REMINDERS_ENABLED=true, and it keeps working if the SQL is not applied yet):
--        supabase functions deploy billing-reminder --no-verify-jwt --project-ref <ref>
--      comms-dispatch does NOT need a redeploy for this change (the hold is inside the database).
--   3  Check (any time): the INFO query at the end lists the messages waiting for their window right now
--      (expect none straight after applying; after midnight India time it shows tomorrow-morning times).
--   To change one studio's hours or switch the hold off for a studio: see "HOW TO CHANGE" in the comments below.
begin;
-- 0290_send_window.sql - CANONICAL forward-only.
-- REQUIRES 0287 (studio_timezone), 0078 (comms_outbox), 0120 (trial_reminders), 0184 (trial_retention_notices),
--          0244 (helm_notice_outbox), 0256 (vendor_request_sends + vendor_request_claim), 0045 (billing_reminders).
--          OPTIONAL 0279 (referral_notice_queue: covered when it exists - re-run this file if 0279 is applied later).
--
-- In plain words (owner, r41: "send client reminders only at sensible hours"):
--   The date-based jobs work out "today" in the studio's own time zone (0287), so they queue their messages on the
--   first run after the studio's MIDNIGHT. The sender (comms-dispatch, every 5 minutes) then sent them at once, so a
--   client or a studio owner could get an e-mail / WhatsApp at 00:00 - 01:00 India time.
--   1  NEW per-studio SEND WINDOW in the studio's time zone (table studio_send_windows, one optional row per studio;
--      no row = the defaults):  clients / guests / vendors 09:00 - 20:00,  studio staff 08:00 - 21:00.
--   2  A message queued OUTSIDE its window is HELD, never dropped: it stays queued (pending) and gets a NEW column
--      not_before = the next window opening (studio time). The existing claim functions already skip a row whose
--      claimed_at "lease" is younger than 10 minutes, so a held row's lease is set to not_before - 10 minutes: every
--      claim (and every later wrapper of it, e.g. 0283 / 0285) hands the row out exactly when the window opens.
--      ONE central place: a BEFORE INSERT trigger (zz_sw290_send_window) on each queue, with one shared classifier
--      (_sw290_audience). A retry ("mark retry" clears the lease) is re-timed the same way.
--   3  HELD (date-based / automatic):
--        comms_outbox   automatic payment reminders, automatic client follow-ups, "quote expires in N days" client
--                       e-mails (client window); WhatsApp copies of date-based bells - event / trial reminders,
--                       payment overdue, quote expiring / expired, low stock, "viewed but not approved" (staff window)
--        trial_reminders           trial day 5 / 7 / 8 e-mails (staff window; never held past the trial end)
--        trial_retention_notices   "trial ended, upgrade" + deletion warning e-mails (staff window)
--        helm_notice_outbox        the DAILY "missed notifications" digest (staff window)
--        vendor_request_sends      the automatic 24 h / 48 h vendor reminders (client window)
--        billing_reminders         Helm plan "due soon / past due / trial" e-mails (staff window; billing-reminder
--                                  edge function reads not_before - REDEPLOY it)
--        referral_notice_queue     referral e-mails to the referring studio (staff window; dormant, no sender yet)
--      NEVER HELD (go out at once, as today): every security alert (two-step, payment-details changes, admin / team
--      changes, HQ staff, studio name change), OTP / sign-in / password e-mails, invite e-mails, welcome e-mails,
--      package accept / decline, anything a person clicked ("Send now" payment reminder, "Send a nudge", invitation
--      site / booklet send, assignment and open-shift WhatsApps, closure requests, sales / contact forms), instant
--      notification e-mails, and the time-of-day reminders the studio set themselves (run-sheet line reminders,
--      delivery / arrival reminders - they are tied to a clock time, often early morning or late at night).
--      Unknown kinds are NEVER held (fail-open = today's behaviour): a new security kind can never be delayed by this.
--   4  vendor_request_claim: its "older than 12 hours = stale" rule counts from not_before for a held row (one
--      condition changed in place, marker r41-sendwin-0290), so a reminder held overnight is not thrown away.
--   5  The new settings table is on the trial-retention keep list (0184, like comms_settings) and has the studio
--      read-only guard (zzz_studio_read_only) like every other studio table.
--   The window is checked when the message is QUEUED; the claim still re-checks everything it checked before (a quote
--   approved overnight, a paid milestone, a paid trial -> that row is skipped exactly as today).
--   Changing a studio's window (no UI yet - SQL only, see HOW TO CHANGE below) affects messages queued afterwards.
--   Additive + idempotent: 1 new table (RLS on, no API privilege), nullable not_before columns, triggers, helpers.
--   No row is changed or deleted (rows already waiting keep their timing). Safe to run twice. ASCII only.
--
-- HOW TO CHANGE ONE STUDIO'S WINDOW (owner / Claude, SQL editor; no UI yet):
--   insert into public.studio_send_windows(org_id, client_start, client_end, staff_start, staff_end)
--     values ('<studio id>', '10:00', '19:00', '08:00', '21:00')
--   on conflict (org_id) do update set client_start = excluded.client_start, client_end = excluded.client_end,
--     staff_start = excluded.staff_start, staff_end = excluded.staff_end, updated_at = now();
--   Switch the hold off for one studio: update public.studio_send_windows set enabled = false where org_id = '<id>';
--   (insert the row first if it does not exist). Times are the STUDIO's local time (organizations.timezone).
-- ROLLBACK (manual, only if ever needed): drop the zz_sw290_send_window triggers - rows already held keep their lease
--   and go out when it ends; the table and columns can stay.

do $$ begin
  if to_regprocedure('public.studio_timezone(uuid)') is null then
    raise exception 'STOP 0290: 0287 (studio_timezone) is not applied - run APPLY-0287.sql first'; end if;
  if to_regclass('public.comms_outbox') is null or to_regclass('public.helm_notice_outbox') is null
     or to_regclass('public.trial_reminders') is null or to_regclass('public.trial_retention_notices') is null
     or to_regclass('public.vendor_request_sends') is null or to_regclass('public.billing_reminders') is null then
    raise exception 'STOP 0290: a message queue is missing (0045 / 0078 / 0120 / 0184 / 0244 / 0256 not applied)'; end if;
end $$;

-- ---- 1) the per-studio window (optional row; no row = the defaults) --------------------------------------------------
create table if not exists public.studio_send_windows (
  org_id       uuid primary key references public.organizations(id) on delete cascade,
  enabled      boolean     not null default true,
  client_start time        not null default time '09:00',
  client_end   time        not null default time '20:00',
  staff_start  time        not null default time '08:00',
  staff_end    time        not null default time '21:00',
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  constraint studio_send_windows_client_chk check (client_end - client_start >= interval '1 hour'),
  constraint studio_send_windows_staff_chk  check (staff_end - staff_start >= interval '1 hour')
);
comment on table public.studio_send_windows is
  'r41-sendwin-0290: per-studio send window in the studio time zone. Automatic client/guest/vendor messages wait for '
  'client_start..client_end, studio staff reminders/digests for staff_start..staff_end. No row = 09-20 / 08-21. '
  'enabled = false: nothing is held for this studio. Security, OTP, invite and clicked messages are never held.';
alter table public.studio_send_windows enable row level security;
revoke all on table public.studio_send_windows from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.studio_send_windows from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.studio_send_windows from authenticated'; end if;
end $$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.studio_send_windows to service_role'; end if;
  -- a read-only (past-due / suspended) studio keeps its settings as they are, like every other studio table
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.studio_send_windows'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.studio_send_windows for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;
-- no policies: only SECURITY DEFINER functions and the service role read it (no UI yet)

-- ---- 2) not_before on every queue that can carry a date-based message ------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['comms_outbox', 'helm_notice_outbox', 'trial_reminders', 'trial_retention_notices',
                           'vendor_request_sends', 'billing_reminders', 'referral_notice_queue'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I add column if not exists not_before timestamptz', t);
      execute format('comment on column public.%I.not_before is %L', t,
        'r41-sendwin-0290: held until this moment (the studio send window); null = sent as soon as it is claimed');
    end if;
  end loop;
end $$;

-- ---- 3) the window maths --------------------------------------------------------------------------------------------
-- the first moment at or after p_at inside the studio's window for that audience ('client' / 'staff');
-- p_at itself when it is inside, when the studio switched the hold off, or for any other audience
create or replace function public.send_window_next(p_org uuid, p_audience text, p_at timestamptz default now())
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
-- r41-sendwin-0290
declare w public.studio_send_windows; v_tz text; v_loc timestamp; v_t time; v_s time; v_e time;
begin
  if p_at is null then return null; end if;
  if p_audience is null or p_audience not in ('client', 'staff') then return p_at; end if;
  select * into w from public.studio_send_windows s where s.org_id = p_org;
  if found and not w.enabled then return p_at; end if;
  if p_audience = 'client' then v_s := coalesce(w.client_start, time '09:00'); v_e := coalesce(w.client_end, time '20:00');
  else v_s := coalesce(w.staff_start, time '08:00'); v_e := coalesce(w.staff_end, time '21:00'); end if;
  v_tz := public.studio_timezone(p_org);
  v_loc := p_at at time zone v_tz;
  v_t := v_loc::time;
  if v_t >= v_s and v_t < v_e then return p_at; end if;
  if v_t < v_s then return (v_loc::date + v_s) at time zone v_tz; end if;
  return ((v_loc::date + 1) + v_s) at time zone v_tz;
end $$;

-- which window a queued row waits for: 'client', 'staff' or null (= never held). Only the date-based / automatic
-- messages listed in the header; every other (and every unknown) kind -> null.
create or replace function public._sw290_audience(p_table text, r jsonb)
returns text language plpgsql immutable set search_path = '' as $$
-- r41-sendwin-0290
declare v_kind text; v_type text;
begin
  if r is null then return null; end if;
  if p_table = 'comms_outbox' then
    if coalesce(r ->> 'status', 'pending') <> 'pending' or (r ->> 'sent_at') is not null then return null; end if;
    if lower(coalesce(r -> 'payload' ->> 'manual', 'false')) = 'true' then return null; end if;   -- "Send now" / "Send a nudge"
    if r ->> 'purpose' in ('pay_reminder', 'follow_up', 'quote_expiry') then return 'client'; end if;
    if r ->> 'purpose' = 'wa_forward' then
      v_kind := lower(coalesce(r -> 'payload' ->> 'kind', '')); v_type := lower(coalesce(r -> 'payload' ->> 'type', ''));
      if v_kind in ('event_reminder', 'trial_reminder', 'payment_overdue', 'quote_expiring', 'quote_expired',
                    'inventory_low_stock', 'client_view_followup')
         or v_type in ('billing_trial', 'payment_overdue', 'inventory_low_stock', 'client_view_followup') then
        return 'staff';
      end if;
    end if;
    return null;
  elsif p_table = 'helm_notice_outbox' then
    if coalesce(r ->> 'status', 'pending') <> 'pending' or (r ->> 'sent_at') is not null then return null; end if;
    if r ->> 'kind' = 'inbox_digest' and coalesce(r -> 'payload' ->> 'mode', '') = 'daily' then return 'staff'; end if;
    return null;
  elsif p_table in ('trial_reminders', 'trial_retention_notices') then
    if coalesce(r ->> 'email_status', 'pending') <> 'pending' or (r ->> 'email_sent_at') is not null then return null; end if;
    return 'staff';
  elsif p_table = 'vendor_request_sends' then
    if coalesce(r ->> 'status', 'pending') <> 'pending' or (r ->> 'sent_at') is not null then return null; end if;
    if r ->> 'kind' = 'reminder' then return 'client'; end if;   -- the first request is sent when someone clicks Send
    return null;
  elsif p_table = 'billing_reminders' then
    if (r ->> 'sent_at') is not null then return null; end if;
    return 'staff';
  elsif p_table = 'referral_notice_queue' then
    if coalesce(r ->> 'status', 'queued') <> 'queued' then return null; end if;
    return 'staff';
  end if;
  return null;
end $$;

-- the hold for one queued row at p_at: the next window opening, or null (send as soon as claimed). Never raises.
create or replace function public._sw290_not_before(p_table text, r jsonb, p_at timestamptz default now())
returns timestamptz language plpgsql stable security definer set search_path = '' as $$
-- r41-sendwin-0290
declare v_aud text; v_org uuid; v_next timestamptz; v_end timestamptz;
begin
  v_aud := public._sw290_audience(p_table, r);
  if v_aud is null or p_at is null then return null; end if;
  v_org := nullif(coalesce(r ->> 'org_id', r ->> 'studio_id'), '')::uuid;
  if v_org is null then return null; end if;
  v_next := public.send_window_next(v_org, v_aud, p_at);
  if v_next is null or v_next <= p_at then return null; end if;
  -- "your trial ends today": never hold it past the end of the trial (the claim would then skip it)
  if p_table = 'trial_reminders' and (r ->> 'trial_ends_at') is not null then
    v_end := (r ->> 'trial_ends_at')::timestamptz;
    if v_next >= v_end - interval '1 hour' then return null; end if;
  end if;
  return v_next;
exception when others then
  return null;   -- a bad value never blocks or delays a message (today's behaviour)
end $$;

-- the claimed_at column each queue's claim uses as its 10-minute lease (null = no claim function reads it)
create or replace function public._sw290_lease_col(p_table text)
returns text language sql immutable set search_path = '' as $$
  -- r41-sendwin-0290
  select case p_table
    when 'comms_outbox' then 'claimed_at' when 'helm_notice_outbox' then 'claimed_at'
    when 'vendor_request_sends' then 'claimed_at'
    when 'trial_reminders' then 'email_claimed_at' when 'trial_retention_notices' then 'email_claimed_at'
    else null end;
$$;

-- ---- 4) the ONE central place: a trigger on each queue -------------------------------------------------------------
create or replace function public._sw290_tg()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r41-sendwin-0290: hold a date-based message queued outside the studio's send window (never drops, never raises)
declare r jsonb; v_lease text; v_nb timestamptz; v_patch jsonb;
begin
  -- test harness only (scripts/db-test/run-all.sh): the older suites expect the queue to behave as before 0290
  if coalesce(current_setting('helm.send_window', true), '') = 'off' then return NEW; end if;
  begin
    v_lease := public._sw290_lease_col(TG_TABLE_NAME);
    r := to_jsonb(NEW);
    if TG_OP = 'UPDATE' then
      -- only a retry is re-timed: the lease was just cleared on a row that is still waiting
      if v_lease is null or (to_jsonb(OLD) ->> v_lease) is null or (r ->> v_lease) is not null then return NEW; end if;
    end if;
    v_nb := public._sw290_not_before(TG_TABLE_NAME, r, now());
    if v_nb is null then return NEW; end if;
    v_patch := jsonb_build_object('not_before', v_nb);
    if v_lease is not null then
      -- every claim skips a row whose lease is younger than 10 minutes -> handed out from v_nb on
      v_patch := v_patch || jsonb_build_object(v_lease, v_nb - interval '10 minutes');
    end if;
    NEW := jsonb_populate_record(NEW, v_patch);
  exception when others then
    raise warning 'r41-sendwin-0290: send window not applied (%)', sqlstate;
  end;
  return NEW;
end $$;

do $$ declare t text; v_lease text; begin
  foreach t in array array['comms_outbox', 'helm_notice_outbox', 'trial_reminders', 'trial_retention_notices',
                           'vendor_request_sends', 'billing_reminders', 'referral_notice_queue'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    v_lease := public._sw290_lease_col(t);
    execute format('drop trigger if exists zz_sw290_send_window on public.%I', t);
    if v_lease is null then
      execute format('create trigger zz_sw290_send_window before insert on public.%I for each row execute function public._sw290_tg()', t);
    else
      execute format('create trigger zz_sw290_send_window before insert or update of %I on public.%I for each row execute function public._sw290_tg()', v_lease, t);
    end if;
  end loop;
end $$;

-- ---- 5) vendor reminders: "stale after 12 hours" counts from the end of the hold -------------------------------------
do $$ declare v_def text; v_old text := 'where sent_at is null and channel = p_channel and created_at < now() - interval ''12 hours'';';
  v_new text := 'where sent_at is null and channel = p_channel and coalesce(not_before, created_at) < now() - interval ''12 hours'' /* r41-sendwin-0290 */;';
begin
  if to_regprocedure('public.vendor_request_claim(integer, text)') is null then return; end if;
  v_def := pg_get_functiondef('public.vendor_request_claim(integer, text)'::regprocedure);
  if position('r41-sendwin-0290' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0290: vendor_request_claim has an unexpected body - left unchanged (a vendor reminder held more than 12 hours would be skipped)';
    return;
  end if;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 6) trial retention (0184, switched off) keeps this settings table, like comms_settings ---------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''studio_send_windows''' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, '''comms_settings''', ''))) <> length('''comms_settings''') then
    raise notice '0290: _tr184_keep_tables() has an unexpected body - left unchanged'; return; end if;
  execute replace(v_def, '''comms_settings''', '''comms_settings'', ''studio_send_windows''');
end $$;

-- ---- 7) privileges: internal only (callers are triggers / SECURITY DEFINER functions) --------------------------------
do $$ declare f text; begin
  foreach f in array array['public.send_window_next(uuid, text, timestamptz)', 'public._sw290_audience(text, jsonb)',
                           'public._sw290_not_before(text, jsonb, timestamptz)', 'public._sw290_lease_col(text)',
                           'public._sw290_tg()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.send_window_next(uuid, text, timestamptz) to service_role';
  end if;
end $$;

commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 send-window table + helpers exist',
     to_regclass('public.studio_send_windows') is not null
     and to_regprocedure('public.send_window_next(uuid, text, timestamptz)') is not null
     and to_regprocedure('public._sw290_not_before(text, jsonb, timestamptz)') is not null
     and to_regprocedure('public._sw290_tg()') is not null),
  ('02 client message at 23:30 India time waits for 09:00 India time; 10:00 goes at once',
     public.send_window_next('00000000-0000-4000-8000-0000000000ff', 'client', '2026-10-27 18:00:00+00') = timestamptz '2026-10-28 03:30:00+00'
     and public.send_window_next('00000000-0000-4000-8000-0000000000ff', 'client', '2026-10-28 04:30:00+00') = timestamptz '2026-10-28 04:30:00+00'),
  ('03 staff message at 07:00 India time waits for 08:00; 20:30 goes at once',
     public.send_window_next('00000000-0000-4000-8000-0000000000ff', 'staff', '2026-10-28 01:30:00+00') = timestamptz '2026-10-28 02:30:00+00'
     and public.send_window_next('00000000-0000-4000-8000-0000000000ff', 'staff', '2026-10-28 15:00:00+00') = timestamptz '2026-10-28 15:00:00+00'),
  ('04 the send-window trigger is on all 6 queues (+ the referral queue when 0279 is applied)',
     (select count(*) from pg_trigger g where g.tgname = 'zz_sw290_send_window' and not g.tgisinternal)
       = 6 + case when to_regclass('public.referral_notice_queue') is null then 0 else 1 end),
  ('05 never on the security / OTP / invite / welcome / package / clock-time queues',
     not exists (select 1 from pg_trigger g where g.tgname = 'zz_sw290_send_window'
                   and g.tgrelid::regclass::text in ('security_alert_outbox', 'pkg_outbox', 'invite_email_outbox', 'welcome_email_outbox',
                                                     'assign_notify_outbox', 'runsheet_reminder_sends', 'delivery_reminder_sends'))),
  ('06 security notices at 02:00 India time go out at once (team, payment details, HQ staff, studio name)',
     public._sw290_not_before('helm_notice_outbox', '{"kind":"team_safety","org_id":"00000000-0000-4000-8000-0000000000ff","status":"pending"}'::jsonb, '2026-10-27 20:30:00+00') is null
     and public._sw290_not_before('helm_notice_outbox', '{"kind":"studio_security","org_id":"00000000-0000-4000-8000-0000000000ff","status":"pending"}'::jsonb, '2026-10-27 20:30:00+00') is null
     and public._sw290_not_before('helm_notice_outbox', '{"kind":"hq_staff","org_id":"00000000-0000-4000-8000-0000000000ff","status":"pending"}'::jsonb, '2026-10-27 20:30:00+00') is null
     and public._sw290_not_before('comms_outbox', '{"purpose":"pay_reminder","org_id":"00000000-0000-4000-8000-0000000000ff","status":"pending","payload":{"manual":true}}'::jsonb, '2026-10-27 20:30:00+00') is null),
  ('07 vendor reminders: "stale after 12 hours" counts from the end of the hold',
     position('r41-sendwin-0290' in pg_get_functiondef('public.vendor_request_claim(integer, text)'::regprocedure)) > 0),
  ('08 not callable from the app (anon / signed-in); the table has no API privilege',
     not has_function_privilege('anon', 'public.send_window_next(uuid, text, timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public.send_window_next(uuid, text, timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'public._sw290_not_before(text, jsonb, timestamptz)', 'execute')
     and not has_table_privilege('authenticated', 'public.studio_send_windows', 'select')
     and not has_table_privilege('anon', 'public.studio_send_windows', 'select')),
  ('09 not_before column on every queue (billing-reminder reads it)',
     (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'not_before'
        and table_name in ('comms_outbox', 'helm_notice_outbox', 'trial_reminders', 'trial_retention_notices',
                           'vendor_request_sends', 'billing_reminders')) = 6)
) v(item, ok) order by item;

-- INFO (not a pass/fail): messages waiting for their send window right now (India time shown)
select 'comms_outbox' as queue, purpose as what, count(*) as waiting, to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST' as first_release
  from public.comms_outbox where sent_at is null and not_before > now() group by purpose
union all select 'helm_notice_outbox', kind, count(*), to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST'
  from public.helm_notice_outbox where sent_at is null and not_before > now() group by kind
union all select 'trial_reminders', 'trial e-mail', count(*), to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST'
  from public.trial_reminders where email_sent_at is null and not_before > now() having count(*) > 0
union all select 'trial_retention_notices', 'trial ended e-mail', count(*), to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST'
  from public.trial_retention_notices where email_sent_at is null and not_before > now() having count(*) > 0
union all select 'vendor_request_sends', 'vendor reminder', count(*), to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST'
  from public.vendor_request_sends where sent_at is null and not_before > now() having count(*) > 0
union all select 'billing_reminders', 'Helm plan e-mail', count(*), to_char(min(not_before) at time zone 'Asia/Kolkata', 'DD Mon HH24:MI') || ' IST'
  from public.billing_reminders where sent_at is null and not_before > now() having count(*) > 0;
