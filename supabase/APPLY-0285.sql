-- APPLY-0285.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER every earlier APPLY file (needs 0075 / 0117 / 0150 / 0156 / 0244 / 0264 / 0266; 0283 is optional - when
-- the r33 team-safety file is applied, the studio owner is told too). Independent of 0282 / 0283 / 0284.
-- R35 PAYMENT-DETAILS CHANGE PROTECTION (owner-approved): if someone takes over one admin account they can no longer
-- quietly swap the UPI ID / bank details your clients pay to.
--   * Changing the UPI ID or payment note needs two-step set up AND a fresh code (entered in the last 15 minutes).
--     No two-step yet -> "Set up two-step first", the change is refused. Checked in the database.
--   * Every admin (+ the studio owner) gets a bell notice and an e-mail at once: who, when, from when clients see it,
--     old vs new MASKED (last 4 characters only - never the full account number).
--   * The new details WAIT 24 HOURS: clients keep the old ones in every reminder and on the client page, then they
--     switch by themselves. A studio that never had payment details: the first set-up is live at once (alerts still go).
--   * "This wasn't us": any admin cancels during the 24 hours -> old details stay, everyone is told at once. When that
--     admin has two-step + a fresh code, the account that made the change is also flagged (and can be signed out
--     everywhere, once per 10 minutes). A flagged account cannot cancel or sign anyone out. Last resort if every
--     admin is flagged: the Helm HQ Owner clears a flag (two-step, fresh code, written reason, audited).
--     "Make it live now": a DIFFERENT admin, two-step.
--   * Everything is in the activity log (masked).
--   * The same two-step + alert (no wait): reply-to address, a confirmed business e-mail, Razorpay keys / on-off,
--     money switches (finance / discount_approve / close_owed), admins added / removed; alert when an admin turns
--     two-step off.
-- Existing payment details keep working exactly as now. New tables / functions / triggers only; no row deleted, nothing
-- dropped. Safe to run twice. ASCII only.
--
-- OWNER STEPS:
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true. (A NOTICE about auth.mfa_factors
--      only means the "two-step turned off" alert could not be added - everything else works.)
--   2  Deploy the site (store-api.js v288, payment-schedule-settings.js v3, payment-schedule.css v2, integrations.js v4,
--      control.html). Deploy the comms-dispatch edge function (the security e-mails; sent once e-mail sending is on).
--   3  pg_cron: the job helm_pay_details_tick (every 5 minutes) is added by itself when pg_cron is installed. Without it,
--      schedule  select public.pay_details_tick();  every 5 minutes by hand when you like - clients already see the
--      right details the moment the 24 hours are over; the job only writes it down and rings the "now live" bell.
--   4  Check (staging): as an admin WITHOUT two-step, Control Center -> Payment schedules -> change the UPI ID -> Save:
--      "Set up two-step first". Set it up, Save again, enter the code: "New payment details are waiting" (clients see
--      the old ones). A second admin gets the bell + e-mail and can press "This wasn't us" or "Make it live now".
--   5  Tell every studio admin to set up two-step now: without it, nobody can change payment details, the reply-to /
--      business e-mail, Razorpay keys, money switches or admins.
begin;
-- 0285_r35_payment_details_safety.sql - CANONICAL forward-only.
-- REQUIRES 0264 (payment_schedule_settings: upi_id + pay_note, _pst_pay_details, payment_schedule_settings_get / _set,
--          comms_tick wrapper), 0244 (helm_notice_outbox + helm_notice_outbox_claim), 0266 (_r23_tz), 0150
--          (studio_email_settings_set: reply-to), 0117 (save_org_payment_account / set_org_integration_status: per-studio
--          Razorpay), 0156 (create_invitation), 0075 (organizations.business_email_confirmed), phase29 / phase57
--          (role_access, admin_set_role_access, has_area, is_admin, current_org_id), the notification catalog (0036 / 0058).
-- OPTIONAL: 0283 (r33 team safety: studio owner, deactivated members) - read when present, never required.
--
-- In plain words (r35, owner-approved: "if someone takes over one admin account they must not be able to quietly swap
-- the UPI ID / bank details our clients pay to"):
--   1  TWO-STEP FOR EVERY CHANGE. Changing the studio's payment details (UPI ID, payment note = bank details) needs a
--      verified two-step authenticator AND a fresh two-step code (aal2 session, code entered in the last 15 minutes).
--      No authenticator -> "Set up two-step first" and the change is refused. Checked in the database, not in the page.
--   2  EVERYONE IS TOLD AT ONCE. Every admin (and the studio owner when 0283 is applied) gets a bell notice and an
--      e-mail (queued in helm_notice_outbox, sent by comms-dispatch): who changed what and when, when clients will see
--      it, old vs new MASKED (last 4 characters only). The full UPI ID / account number is never put in a notice,
--      an e-mail or the activity log.
--   3  24-HOUR WAIT. The new details are stored as PENDING (NEW table pay_detail_changes). For 24 hours every client
--      surface (payment reminders, the client portal's "how to pay") keeps showing the OLD details; then they switch by
--      themselves: pay_details_tick (pg_cron every 5 minutes when installed; also run by comms_tick) writes them, and
--      every read already shows the new details the moment the 24 hours are over (no job needed for clients to see the
--      right thing). A studio that has NEVER had payment details: the first set-up is live at once (alerts still go).
--   4  "THIS WASN'T US". Any admin can cancel a pending change during the 24 hours: the old details stay, everyone is
--      told. When the admin who cancels has a fresh two-step code, the account that made the change is also FLAGGED
--      (NEW studio_account_flags; no sensitive change until a different admin clears it with two-step) and can be
--      signed out everywhere (refresh tokens marked revoked - nothing deleted; at most once per 10 minutes, audited).
--      Without two-step the cancel + alert still happen at once ("cancelled by an admin without two-step"). A flagged
--      account can neither cancel nor sign anyone out. Last resort: the Helm HQ Owner clears a flag
--      (hq_studio_flag_clear: two-step + fresh code, written reason, audited). Any admin can make a pending
--      change live early - only with two-step, and only a DIFFERENT admin than the one who made it.
--   5  EVERYTHING IS LOGGED: audit_log rows (who, when, from -> to masked, request / first set-up / live / early /
--      cancel) + the append-only studio_security_events list behind the notices.
--   6  THE SAME TWO-STEP + ALERT (no 24-hour wait) for the other sensitive studio settings:
--        a  the studio reply-to address (studio_email_settings_set)            - any change of the address
--        b  the studio business e-mail (organizations.business_email)          - changing / clearing / un-confirming
--           a CONFIRMED address (the first time a studio confirms one, e.g. onboarding, is not blocked - it is alerted)
--        c  per-studio Razorpay keys + on / off (save_org_payment_account, set_org_integration_status, 0117)
--        d  Control Center money switches: role access areas finance, discount_approve, close_owed
--           (admin_set_role_access - only when a value really changes)
--        e  two-step turned off for an admin (auth.mfa_factors: a verified authenticator removed / reset) - Supabase
--           itself already asks for a two-step session to remove one; this adds the alert to every admin
--        f  admins added / removed: an invitation as admin (invitations), someone else made admin / no longer admin
--           (profiles.role), an admin account created or deleted by another admin (profiles insert / delete).
--           Self-service steps (accepting an invitation, creating your own studio) are not blocked - alerted only.
--           0283 (r33) applies its own 24-hour admin changes under its 'helm.r283_apply' marker: not blocked twice.
-- Changes: 3 NEW tables (RLS on, no API privilege; read through RPCs), new functions; wrapped ONCE (body kept as
-- *__pre0285, not callable by the app): payment_schedule_settings_get / _set, studio_email_settings_set,
-- save_org_payment_account, set_org_integration_status, admin_set_role_access, comms_tick, notification_catalog,
-- notification_type_of, notify_default; _pst_pay_details re-issued (same answer, plus the 24-hour rule); triggers on
-- organizations, profiles, invitations, auth.mfa_factors (the last one skipped with a NOTICE when not allowed);
-- 3 restrictive policies on notifications (kind studio_security: admins read, app never writes); helm_notice_outbox
-- kind check widened ONCE to a superset + one claim branch; trial retention keeps the new tables.
-- Existing payment details keep working exactly as now until someone changes them: no existing row is updated or
-- deleted, no table / column / policy dropped. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): for each wrapped f: drop function public.f(...);
--   alter function public.f__pre0285(...) rename to f; restore its grants; re-run the 0264 _pst_pay_details body;
--   drop trigger zz_r285_* on public.organizations / public.profiles / public.invitations / auth.mfa_factors;
--   select cron.unschedule('helm_pay_details_tick'). The new tables can stay (unused). A change still pending at
--   rollback simply never goes live.

-- ---- STOP guard: the pieces this builds on ----------------------------------------------------------------------
do $$ begin
  if to_regclass('public.payment_schedule_settings') is null or to_regprocedure('public._pst_pay_details(uuid)') is null
     or to_regprocedure('public.payment_schedule_settings_set(jsonb)') is null or to_regprocedure('public.payment_schedule_settings_get()') is null then
    raise exception 'STOP 0285: 0264 (payment schedules: upi_id / pay_note) is not applied'; end if;
  if to_regprocedure('public.comms_tick()') is null then raise exception 'STOP 0285: comms_tick (0078 / 0264) is missing'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0285: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null then raise exception 'STOP 0285: 0266 (notification inbox: _r23_tz) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text, text, text, jsonb)') is null then raise exception 'STOP 0285: the HQ write gate (0045 / 0277) is missing'; end if;
  if to_regprocedure('public.studio_email_settings_set(text, text)') is null then raise exception 'STOP 0285: 0150 (studio e-mail settings) is not applied'; end if;
  if to_regprocedure('public.save_org_payment_account(text, text, text)') is null or to_regprocedure('public.set_org_integration_status(text, text)') is null then
    raise exception 'STOP 0285: 0117 (per-studio Razorpay accounts) is not applied'; end if;
  if to_regprocedure('public.admin_set_role_access(text, text, boolean, boolean)') is null or to_regprocedure('public.has_area(text, text)') is null
     or to_regprocedure('public.is_admin()') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0285: phase29 / phase57 (role_access, admin_set_role_access, has_area, is_admin) is not applied'; end if;
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text, text)') is null
     or to_regprocedure('public.notify_default(uuid, text, text, text)') is null then
    raise exception 'STOP 0285: the notification catalog (0036 / 0058) is missing'; end if;
  if to_regclass('public.invitations') is null or to_regclass('public.audit_log') is null or to_regclass('public.notifications') is null then
    raise exception 'STOP 0285: invitations / audit_log / notifications are missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations'
                   and column_name = 'business_email_confirmed') then raise exception 'STOP 0285: apply 0075 first (business_email_confirmed)'; end if;
end $$;

-- ---- 1) the new tables (private: RLS on, no API privilege, read through the RPCs below) ----------------------------
-- a change of the studio's payment details: pending for 24 hours, then applied - or cancelled ("This wasn't us")
create table if not exists public.pay_detail_changes (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations(id) on delete cascade,
  status        text        not null default 'pending' check (status in ('pending', 'applied', 'cancelled')),
  first_setup   boolean     not null default false,
  old_upi       text,
  old_note      text,
  new_upi       text        check (new_upi is null or new_upi ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$'),
  new_note      text        check (new_note is null or (char_length(new_note) <= 300 and new_note !~ '[<>]')),
  requested_by  uuid        not null,
  requested_at  timestamptz not null default now(),
  effective_at  timestamptz not null,
  applied_at    timestamptz,
  applied_by    uuid,
  applied_how   text        check (applied_how is null or applied_how in ('first_setup', 'auto', 'early')),
  cancelled_at  timestamptz,
  cancelled_by  uuid,
  cancel_kind   text        check (cancel_kind is null or cancel_kind in ('not_us', 'not_us_unverified', 'withdrawn'))
);
create unique index if not exists pay_detail_changes_one_pending_r285 on public.pay_detail_changes (org_id) where status = 'pending';
create index if not exists pay_detail_changes_due_r285 on public.pay_detail_changes (effective_at) where status = 'pending';
create index if not exists pay_detail_changes_org_r285 on public.pay_detail_changes (org_id, requested_at desc);

-- every sensitive-settings event (append-only): the bell / e-mail read it. Masked values only.
create table if not exists public.studio_security_events (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null references public.organizations(id) on delete cascade,
  kind        text        not null check (char_length(kind) between 3 and 40),
  actor       uuid,
  actor_name  text,
  target_user uuid,
  change_id   uuid,
  detail      jsonb       not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index if not exists studio_security_events_org_r285 on public.studio_security_events (org_id, at desc);

-- an account flagged by "This wasn't us": no sensitive change until a different admin clears it (two-step)
create table if not exists public.studio_account_flags (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null references public.organizations(id) on delete cascade,
  user_id     uuid        not null,
  change_id   uuid,
  reason      text        check (reason is null or char_length(reason) <= 300),
  flagged_by  uuid,
  flagged_at  timestamptz not null default now(),
  cleared_by  uuid,
  cleared_at  timestamptz
);
create unique index if not exists studio_account_flags_open_r285 on public.studio_account_flags (org_id, user_id) where cleared_at is null;

do $$ declare t text; begin
  foreach t in array array['pay_detail_changes', 'studio_security_events', 'studio_account_flags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- records are kept: never deleted (the studio itself going away still cascades); the event list is append-only
create or replace function public._r285_tg_keep()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r35-0285
  if tg_op = 'DELETE' and pg_trigger_depth() <= 1 then
    raise exception 'r35: these records are kept (nothing is deleted)' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and tg_table_name = 'studio_security_events' then
    raise exception 'r35: the security event list is append-only' using errcode = '42501'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
do $$ declare t text; begin
  foreach t in array array['pay_detail_changes', 'studio_security_events', 'studio_account_flags'] loop
    execute format('drop trigger if exists zz_r285_keep on public.%I', t);
    execute format('create trigger zz_r285_keep before update or delete on public.%I for each row execute function public._r285_tg_keep()', t);
  end loop;
end $$;

-- ---- 2) helpers --------------------------------------------------------------------------------------------------
-- masked: last 4 characters only ("none" when empty). Never the whole value.
create or replace function public._r285_mask(p text)
returns text language sql immutable set search_path = '' as $$
  -- r35-0285
  select case when nullif(btrim(coalesce(p, '')), '') is null then 'none'
              when char_length(btrim(p)) <= 4 then '****'
              else '****' || right(btrim(p), 4) end;
$$;

-- an e-mail address shown masked: first character + *** + @domain
create or replace function public._r285_mask_email(p text)
returns text language sql immutable set search_path = '' as $$
  -- r35-0285
  select case when nullif(btrim(coalesce(p, '')), '') is null then 'none'
              when position('@' in p) > 1 then left(btrim(p), 1) || '***@' || split_part(btrim(p), '@', 2)
              else public._r285_mask(p) end;
$$;

create or replace function public._r285_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r35-0285: a person's name (or the part before @), never the full address
  select coalesce((select coalesce(nullif(left(btrim(p.full_name), 80), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''))
                     from public.profiles p where p.id = p_user), case when p_user is null then 'Helm (automatic)' else 'A team member' end);
$$;

create or replace function public._r285_has_mfa(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v boolean := false;
begin
  if p_user is null or to_regclass('auth.mfa_factors') is null then return false; end if;
  execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')' into v using p_user;
  return coalesce(v, false);
end $$;

-- newest two-step (TOTP / phone / passkey) time in this token; null = the token says nothing about two-step
create or replace function public._r285_mfa_at()
returns timestamptz language plpgsql stable set search_path = '' as $$
-- r35-0285
declare a jsonb := auth.jwt() -> 'amr'; t timestamptz;
begin
  if a is null or jsonb_typeof(a) <> 'array' then return null; end if;
  select max(to_timestamp((e ->> 'timestamp')::double precision)) into t
    from jsonb_array_elements(a) e
   where jsonb_typeof(e) = 'object' and coalesce(e ->> 'method', '') in ('totp', 'mfa/totp', 'phone', 'mfa/phone', 'webauthn', 'mfa/webauthn')
     and coalesce(e ->> 'timestamp', '') ~ '^[0-9]{1,12}(\.[0-9]+)?$';
  return t;
end $$;

create or replace function public._r285_flagged(p_org uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r35-0285
  select exists (select 1 from public.studio_account_flags f where f.org_id = p_org and f.user_id = p_user and f.cleared_at is null);
$$;

-- where the caller stands (for the page): set up? fresh code? flagged?
create or replace function public._r285_step_up_state(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v_at timestamptz := public._r285_mfa_at();
begin
  return jsonb_build_object('has_2step', public._r285_has_mfa(auth.uid()),
    'aal2', coalesce(auth.jwt() ->> 'aal', '') = 'aal2',
    'fresh', coalesce(auth.jwt() ->> 'aal', '') = 'aal2' and v_at is not null and v_at >= now() - interval '15 minutes',
    'fresh_minutes', 15, 'flagged', p_org is not null and public._r285_flagged(p_org, auth.uid()));
end $$;

-- THE check for every sensitive change: a verified authenticator + an aal2 session + a code from the last 15 minutes,
-- and the account is not flagged. Raises 42501 with a code word the page understands.
create or replace function public._r285_step_up(p_org uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_org is not null and public._r285_flagged(p_org, auth.uid()) then
    raise exception 'R35_FLAGGED: This account was flagged after a "This wasn''t us". Another admin has to clear the flag before it can change sensitive settings.'
      using errcode = '42501', hint = 'flagged';
  end if;
  if not public._r285_has_mfa(auth.uid()) then
    raise exception 'R35_SETUP_2STEP: Set up two-step verification on your account first. Payment details and other sensitive studio settings can only be changed with two-step.'
      using errcode = '42501', hint = 'setup_2step';
  end if;
  v_at := public._r285_mfa_at();
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' or v_at is null or v_at < now() - interval '15 minutes' then
    raise exception 'R35_REAUTH: Enter a fresh two-step code to confirm this change.' using errcode = '42501', hint = 'reauth';
  end if;
end $$;

-- is this a signed-in person's own action that must be gated? (not the database itself, cron, the service role,
-- a Helm HQ operator at two-step, or 0283's own 24-hour admin change being applied)
create or replace function public._r285_user_call()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
begin
  if auth.uid() is null then return false; end if;
  if coalesce(auth.jwt() ->> 'role', '') in ('service_role', 'supabase_admin') then return false; end if;
  if coalesce(current_setting('helm.r283_apply', true), '') = 'on' then return false; end if;
  if to_regprocedure('public.is_platform_admin()') is not null and coalesce(public.is_platform_admin(), false) then return false; end if;
  return true;
end $$;

-- every admin of the studio (and the 0283 owner when present), never a deactivated one
create or replace function public._r285_admins(p_org uuid)
returns setof uuid language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v_owner uuid; v_u uuid; v_off boolean;
begin
  if to_regprocedure('public._r283_owner(uuid)') is not null then
    begin execute 'select public._r283_owner($1)' into v_owner using p_org; exception when others then v_owner := null; end;
  end if;
  for v_u in select x.id from (
      select p.id from public.profiles p where p.org_id = p_org and p.role = 'admin'
      union select v_owner where v_owner is not null) x
  loop
    v_off := false;
    if to_regprocedure('public._r283_is_off(uuid, uuid)') is not null then
      begin execute 'select public._r283_is_off($1, $2)' into v_off using v_u, p_org; exception when others then v_off := false; end;
    end if;
    if not coalesce(v_off, false) then return next v_u; end if;
  end loop;
end $$;

create or replace function public._r285_when(p_org uuid, p_at timestamptz)
returns text language sql stable security definer set search_path = '' as $$
  -- r35-0285: "27 Oct 2026, 04:05 PM (Asia/Kolkata)" in the studio's time zone
  select case when p_at is null then null else
    to_char(p_at at time zone public._r23_tz(p_org), 'DD Mon YYYY, HH12:MI AM') || ' (' || public._r23_tz(p_org) || ')' end;
$$;

-- the bell line (names + times only - never values, links or tokens)
create or replace function public._r285_label(p_kind text, d jsonb)
returns text language sql immutable set search_path = '' as $$
  -- r35-0285
  select left(case p_kind
    when 'pay_details_requested' then 'Payment details for ' || coalesce(d ->> 'studio', 'your studio') || ' were changed by '
         || coalesce(d ->> 'by', 'a team member') || ' at ' || coalesce(d ->> 'at_text', 'just now') || '. Clients will see the new details from '
         || coalesce(d ->> 'effective_text', 'in 24 hours') || '. If this wasn''t you, press ''This wasn''t us''.'
    when 'pay_details_first_set' then 'Payment details for ' || coalesce(d ->> 'studio', 'your studio') || ' were set up by '
         || coalesce(d ->> 'by', 'a team member') || ' at ' || coalesce(d ->> 'at_text', 'just now') || ' (first set-up: live now). If this wasn''t you, tell your admins.'
    when 'pay_details_cancelled' then 'This wasn''t us: ' || coalesce(d ->> 'by', 'an admin') || ' cancelled the payment-details change made by '
         || coalesce(d ->> 'target', 'a team member') || '. Clients keep the old details; that account is flagged.'
    when 'pay_details_cancelled_unverified' then 'Cancelled: ' || coalesce(d ->> 'by', 'an admin') || ' cancelled the payment-details change made by '
         || coalesce(d ->> 'target', 'a team member') || ' (without two-step, so the account was not flagged). Clients keep the old details.'
    when 'pay_details_withdrawn' then coalesce(d ->> 'by', 'A team member') || ' withdrew their payment-details change. Clients keep the old details.'
    when 'pay_details_live' then 'The new payment details are now shown to clients (changed by ' || coalesce(d ->> 'target', 'a team member') || ').'
    when 'pay_details_approved_early' then coalesce(d ->> 'by', 'An admin') || ' made the payment-details change by '
         || coalesce(d ->> 'target', 'a team member') || ' live early. Clients see the new details now.'
    when 'reply_to_changed' then 'The studio reply-to e-mail was changed by ' || coalesce(d ->> 'by', 'a team member') || ' at ' || coalesce(d ->> 'at_text', 'just now') || '.'
    when 'business_email_changed' then 'The studio business e-mail was changed by ' || coalesce(d ->> 'by', 'a team member') || ' at ' || coalesce(d ->> 'at_text', 'just now') || '.'
    when 'razorpay_keys_saved' then 'Online payment (Razorpay) keys were changed by ' || coalesce(d ->> 'by', 'a team member') || ' at ' || coalesce(d ->> 'at_text', 'just now') || '.'
    when 'razorpay_status_changed' then 'Online payments (Razorpay) were switched ' || case when d ->> 'status' = 'disabled' then 'off' else 'back on' end
         || ' by ' || coalesce(d ->> 'by', 'a team member') || '.'
    when 'money_access_changed' then coalesce(d ->> 'by', 'An admin') || ' changed the money access "' || coalesce(d ->> 'area_label', d ->> 'area', 'money') || '" for '
         || coalesce(d ->> 'role', 'a role') || ' (view ' || case when (d ->> 'view')::boolean then 'on' else 'off' end
         || ', edit ' || case when (d ->> 'edit')::boolean then 'on' else 'off' end || ').'
    when 'admin_invited' then coalesce(d ->> 'by', 'An admin') || ' invited ' || coalesce(d ->> 'target_email', 'someone') || ' as an admin.'
    when 'admin_added' then coalesce(d ->> 'target', 'A team member') || ' is now an admin' || coalesce(' (by ' || (d ->> 'by') || ')', '') || '.'
    when 'admin_removed' then coalesce(d ->> 'target', 'An admin') || ' is no longer an admin' || coalesce(' (by ' || (d ->> 'by') || ')', '') || '.'
    when 'two_step_off' then 'Two-step verification was turned off for the admin ' || coalesce(d ->> 'target', 'a team member') || '.'
    when 'flag_cleared' then coalesce(d ->> 'by', 'An admin') || ' cleared the "This wasn''t us" flag on ' || coalesce(d ->> 'target', 'a team member') || '.'
    when 'sessions_ended' then coalesce(d ->> 'by', 'An admin') || ' signed ' || coalesce(d ->> 'target', 'a team member') || ' out on every device.'
    else 'A sensitive studio setting was changed' end, 300);
$$;

-- one event: the record + a bell row for the admins + a queued e-mail (+ the activity-log row)
create or replace function public._r285_event(p_org uuid, p_kind text, p_target uuid, p_change uuid, p_detail jsonb,
                                              p_mail boolean default true, p_audit_action text default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_id uuid; v_d jsonb; v_studio text; v_by text := case when auth.uid() is null then null else public._r285_name(auth.uid()) end;
begin
  select o.name into v_studio from public.organizations o where o.id = p_org;
  v_d := coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('studio', coalesce(v_studio, 'your studio'), 'at_text', public._r285_when(p_org, now()));
  if v_by is not null and not (v_d ? 'by') then v_d := v_d || jsonb_build_object('by', v_by); end if;
  if p_target is not null and not (v_d ? 'target') then v_d := v_d || jsonb_build_object('target', public._r285_name(p_target)); end if;
  insert into public.studio_security_events(org_id, kind, actor, actor_name, target_user, change_id, detail)
    values (p_org, p_kind, auth.uid(), v_by, p_target, p_change, v_d) returning id into v_id;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'studio_security', 'simulated',
              jsonb_build_object('label', public._r285_label(p_kind, v_d), 'event', p_kind, 'source', 'r35', 'event_id', v_id,
                                 'change_id', p_change), p_org);
  exception when others then raise warning 'r35-0285: bell row skipped (%)', sqlstate;
  end;
  if p_mail then
    begin
      insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
        values ('studio_security', p_org, v_id, jsonb_build_object('event', p_kind), 'studio_security:' || v_id::text)
        on conflict (dedupe_key) do nothing;
    exception when check_violation then null;   -- outbox kind not widened on this database: the bell + record are kept
    end;
  end if;
  if p_audit_action is not null then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), p_audit_action, 'studio_security',
              coalesce(p_change, v_id)::text, v_d - 'studio' - 'at_text', p_org, now());
  end if;
  return v_id;
end $$;

-- ---- 3) payment details: live vs pending ---------------------------------------------------------------------------
-- what clients see right now: the live details, or a change whose 24 hours are over (even before the tick wrote it)
create or replace function public._r285_effective(p_org uuid)
returns table(upi text, note text, due_change uuid)
language sql stable security definer set search_path = '' as $$
  -- r35-0285
  select case when c.id is not null then c.new_upi else s.upi_id end,
         case when c.id is not null then c.new_note else s.pay_note end,
         c.id
    from (select 1) one
    left join public.payment_schedule_settings s on s.org_id = p_org
    left join lateral (select x.id, x.new_upi, x.new_note from public.pay_detail_changes x
                        where x.org_id = p_org and x.status = 'pending' and x.effective_at <= now()
                        order by x.requested_at desc limit 1) c on true;
$$;

-- the 0264 body with the 24-hour rule: a change still waiting is NEVER shown to clients
create or replace function public._pst_pay_details(p_quote uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r35-0285: how the client can pay = the open LIVE online link, the LIVE UPI ID + note (never a pending change)
  select jsonb_build_object(
    'link', (select qp.link_url from public.quote_payments qp
              where qp.quote_id = q.id and qp.status = 'created' and not coalesce(qp.simulated, true)
                and coalesce(qp.link_url, '') ~ '^https://[^\s<>"]+$' and char_length(qp.link_url) <= 500
                and (qp.link_expires_at is null or qp.link_expires_at > now())
              order by qp.created_at desc limit 1),
    'upi', e.upi, 'note', e.note)
  from public.quotes q cross join lateral public._r285_effective(q.org_id) e
  where q.id = p_quote;
$$;

-- write one change into the live settings (the caller checked who may)
create or replace function public._r285_apply(p_change uuid, p_how text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare c public.pay_detail_changes;
begin
  select * into c from public.pay_detail_changes x where x.id = p_change and x.status = 'pending' for update;
  if c.id is null then return false; end if;
  perform set_config('helm.r285_apply', 'on', true);
  insert into public.payment_schedule_settings(org_id) values (c.org_id) on conflict (org_id) do nothing;
  update public.payment_schedule_settings s set upi_id = c.new_upi, pay_note = c.new_note, updated_at = now(),
         updated_by = coalesce(case when p_how = 'early' then auth.uid() end, c.requested_by)
   where s.org_id = c.org_id;
  perform set_config('helm.r285_apply', 'off', true);
  update public.pay_detail_changes x set status = 'applied', applied_at = now(), applied_how = p_how,
         applied_by = case when p_how = 'early' then auth.uid() end
   where x.id = c.id;
  return true;
end $$;

-- every pending change whose 24 hours are over is written (and the admins get a bell: "now shown to clients")
create or replace function public._r285_apply_due(p_org uuid default null)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare c record; v_n integer := 0;
begin
  for c in select x.* from public.pay_detail_changes x
            where x.status = 'pending' and x.effective_at <= now() and (p_org is null or x.org_id = p_org)
            order by x.effective_at for update skip locked loop
    begin
      if public._r285_apply(c.id, 'auto') then
        perform public._r285_event(c.org_id, 'pay_details_live', c.requested_by, c.id,
          jsonb_build_object('old_upi', public._r285_mask(c.old_upi), 'new_upi', public._r285_mask(c.new_upi),
                             'old_note', public._r285_mask(c.old_note), 'new_note', public._r285_mask(c.new_note), 'by', 'Helm (automatic)'),
          false, 'payment_details.applied');
        v_n := v_n + 1;
      end if;
    exception when others then raise warning 'r35-0285: pending change % not applied (%)', c.id, sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- pg_cron (every 5 minutes) / the service role / comms_tick
create or replace function public.pay_details_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r35-0285
  return jsonb_build_object('pay_details_applied', public._r285_apply_due(null));
end $$;

-- has this studio EVER had payment details? (no -> the first set-up is live at once)
create or replace function public._r285_ever_had(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r35-0285
  select exists (select 1 from public.payment_schedule_settings s where s.org_id = p_org
                   and (nullif(btrim(coalesce(s.upi_id, '')), '') is not null or nullif(btrim(coalesce(s.pay_note, '')), '') is not null))
      or exists (select 1 from public.pay_detail_changes c where c.org_id = p_org and c.status in ('applied', 'pending'))
      or exists (select 1 from public.audit_log a where a.org_id = p_org and a.action = 'payment_schedule.settings'
                   and (nullif(btrim(coalesce(a.changed ->> 'upi_id', '')), '') is not null
                        or nullif(btrim(coalesce(a.changed ->> 'pay_note', '')), '') is not null));
$$;

-- the request itself (the caller checked the permission and the two-step)
create or replace function public._r285_request(p_org uuid, p_upi text, p_note text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare s public.payment_schedule_settings; v_id uuid; v_first boolean; v_eff timestamptz; v_d jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('r285_pay:' || p_org::text));
  insert into public.payment_schedule_settings(org_id) values (p_org) on conflict (org_id) do nothing;
  -- touches the row: a read-only (suspended / ended-trial) studio is refused here by the 0045 guard
  update public.payment_schedule_settings x set updated_at = now(), updated_by = auth.uid() where x.org_id = p_org returning * into s;
  if exists (select 1 from public.pay_detail_changes c where c.org_id = p_org and c.status = 'pending') then
    raise exception 'A change to the payment details is already waiting. Cancel it first, or wait until it goes live.'
      using errcode = '22023', hint = 'change_pending';
  end if;
  v_first := not public._r285_ever_had(p_org);
  v_eff := case when v_first then now() else now() + interval '24 hours' end;
  insert into public.pay_detail_changes(org_id, status, first_setup, old_upi, old_note, new_upi, new_note, requested_by, effective_at)
    values (p_org, 'pending', v_first, s.upi_id, s.pay_note, p_upi, p_note, auth.uid(), v_eff) returning id into v_id;
  v_d := jsonb_build_object('old_upi', public._r285_mask(s.upi_id), 'new_upi', public._r285_mask(p_upi),
                            'old_note', public._r285_mask(s.pay_note), 'new_note', public._r285_mask(p_note),
                            'effective_at', v_eff, 'effective_text', public._r285_when(p_org, v_eff), 'first_setup', v_first);
  if v_first then
    perform public._r285_apply(v_id, 'first_setup');
    perform public._r285_event(p_org, 'pay_details_first_set', auth.uid(), v_id, v_d, true, 'payment_details.first_set');
  else
    perform public._r285_event(p_org, 'pay_details_requested', auth.uid(), v_id, v_d, true, 'payment_details.change_requested');
  end if;
  return jsonb_build_object('change_id', v_id, 'first_setup', v_first, 'effective_at', v_eff);
end $$;

-- ---- 4) the Control Center RPCs (wrapped once; bodies kept) -------------------------------------------------------
do $$ begin
  if to_regprocedure('public.payment_schedule_settings_get__pre0285()') is null then
    alter function public.payment_schedule_settings_get() rename to payment_schedule_settings_get__pre0285;
  end if;
  if to_regprocedure('public.payment_schedule_settings_set__pre0285(jsonb)') is null then
    alter function public.payment_schedule_settings_set(jsonb) rename to payment_schedule_settings_set__pre0285;
  end if;
end $$;

-- read: what clients see now + the change waiting (full new values for admins only; masked for others) + two-step state
create or replace function public.payment_schedule_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v jsonb; v_org uuid := public.current_org_id(); e record; c public.pay_detail_changes; v_admin boolean := coalesce(public.is_admin(), false);
begin
  v := public.payment_schedule_settings_get__pre0285();   -- permission checks inside (Control Center or Finance view)
  select * into e from public._r285_effective(v_org);
  select * into c from public.pay_detail_changes x where x.org_id = v_org and x.status = 'pending' and x.effective_at > now()
   order by x.requested_at desc limit 1;
  return v || jsonb_build_object(
    'upi_id', e.upi, 'pay_note', e.note,
    'pending', case when c.id is null then null else jsonb_build_object(
      'id', c.id, 'requested_by', public._r285_name(c.requested_by), 'requested_by_me', c.requested_by = auth.uid(),
      'requested_at', c.requested_at, 'effective_at', c.effective_at,
      'new_upi', case when v_admin then c.new_upi else public._r285_mask(c.new_upi) end,
      'new_note', case when v_admin then c.new_note else public._r285_mask(c.new_note) end,
      'masked', not v_admin, 'old_upi_masked', public._r285_mask(c.old_upi), 'old_note_masked', public._r285_mask(c.old_note),
      'can_cancel', v_admin, 'can_approve', v_admin and c.requested_by <> auth.uid()) end,
    'flags', case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('user_id', f.user_id, 'name', public._r285_name(f.user_id),
                    'flagged_at', f.flagged_at, 'by', public._r285_name(f.flagged_by), 'is_me', f.user_id = auth.uid())
                    order by f.flagged_at desc) from public.studio_account_flags f where f.org_id = v_org and f.cleared_at is null), '[]'::jsonb)
                  else '[]'::jsonb end,
    'is_admin', v_admin, 'two_step', public._r285_step_up_state(v_org), 'delay_hours', 24);
end $$;

-- write: the 0264 rules; a change of UPI ID / payment note goes through two-step + the 24-hour wait. Saving the same
-- values again (or the ones already waiting) changes nothing and needs no code.
create or replace function public.payment_schedule_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_upi text; v_note text; e record;
  c public.pay_detail_changes; v_rest jsonb;
begin
  if v_me is null or v_org is null or not public.has_area('controls', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  perform public._r285_apply_due(v_org);
  if p ? 'upi_id' or p ? 'pay_note' then
    select * into e from public._r285_effective(v_org);
    select * into c from public.pay_detail_changes x where x.org_id = v_org and x.status = 'pending' order by x.requested_at desc limit 1;
    -- start from the change already waiting (else the live details); only the keys given change
    if c.id is not null then v_upi := c.new_upi; v_note := c.new_note; else v_upi := e.upi; v_note := e.note; end if;
    if p ? 'upi_id' then
      if jsonb_typeof(p -> 'upi_id') not in ('string', 'null') then raise exception 'upi_id must be text' using errcode = '22023'; end if;
      v_upi := nullif(btrim(coalesce(p ->> 'upi_id', '')), '');
      if v_upi is not null and v_upi !~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z0-9.-]{2,64}$' then
        raise exception 'Enter a UPI ID like studio@okbank.' using errcode = '22023'; end if;
    end if;
    if p ? 'pay_note' then
      if jsonb_typeof(p -> 'pay_note') not in ('string', 'null') then raise exception 'pay_note must be text' using errcode = '22023'; end if;
      v_note := nullif(btrim(regexp_replace(coalesce(p ->> 'pay_note', ''), '\s+', ' ', 'g')), '');
      if v_note is not null and (char_length(v_note) > 300 or v_note ~ '[<>]') then
        raise exception 'Keep the payment note to 300 characters, without < or >.' using errcode = '22023'; end if;
    end if;
    if (v_upi, v_note) is not distinct from (e.upi, e.note)
       or (c.id is not null and (v_upi, v_note) is not distinct from (c.new_upi, c.new_note)) then
      null;   -- nothing new: the live details or the change already waiting
    else
      perform public._r285_step_up(v_org);
      perform public._r285_request(v_org, v_upi, v_note);
    end if;
  end if;
  v_rest := p - 'upi_id' - 'pay_note';
  if v_rest <> '{}'::jsonb then
    perform public.payment_schedule_settings_set__pre0285(v_rest);   -- the 0264 rules + its audit row (never the pay details)
  end if;
  return public.payment_schedule_settings_get();
end $$;

-- "This wasn't us" (any admin, during the 24 hours). The cancel + the alert are ALWAYS instant (no code needed).
-- Flagging the account that made the change and signing it out need the canceller's own fresh two-step (so a hijacked
-- admin account without it cannot flag / sign out the real admins); a flagged account cannot cancel at all.
-- Withdrawing your OWN change never flags you.
create or replace function public.pay_details_cancel(p_change uuid, p_sign_out boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.pay_detail_changes; v_self boolean; v_d jsonb;
  v_out jsonb := null; v_strong boolean := false;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._r285_flagged(v_org, v_me) then
    raise exception 'R35_FLAGGED: This account was flagged after a "This wasn''t us". Another admin has to clear the flag before it can change sensitive settings.'
      using errcode = '42501', hint = 'flagged';
  end if;
  perform public._r285_apply_due(v_org);
  select * into c from public.pay_detail_changes x where x.id = p_change and x.org_id = v_org for update;
  if c.id is null then raise exception 'change not found' using errcode = '42501'; end if;
  if c.status <> 'pending' then
    raise exception 'This change is no longer waiting (it is %). Change the payment details again if they are wrong.', c.status
      using errcode = '22023', hint = 'not_pending';
  end if;
  v_self := c.requested_by = v_me;
  if not v_self then
    begin perform public._r285_step_up(v_org); v_strong := true;
    exception when others then v_strong := false;   -- no (fresh) two-step: cancel + alert only
    end;
  end if;
  update public.pay_detail_changes x set status = 'cancelled', cancelled_at = now(), cancelled_by = v_me,
         cancel_kind = case when v_self then 'withdrawn' when v_strong then 'not_us' else 'not_us_unverified' end where x.id = c.id;
  v_d := jsonb_build_object('old_upi', public._r285_mask(c.old_upi), 'new_upi', public._r285_mask(c.new_upi),
                            'old_note', public._r285_mask(c.old_note), 'new_note', public._r285_mask(c.new_note),
                            'target_id', c.requested_by, 'verified', v_strong);
  if v_self then
    perform public._r285_event(v_org, 'pay_details_withdrawn', c.requested_by, c.id, v_d, true, 'payment_details.withdrawn');
  elsif v_strong then
    insert into public.studio_account_flags(org_id, user_id, change_id, reason, flagged_by)
      values (v_org, c.requested_by, c.id, 'Payment-details change cancelled as "This wasn''t us"', v_me)
      on conflict (org_id, user_id) where cleared_at is null do nothing;
    perform public._r285_event(v_org, 'pay_details_cancelled', c.requested_by, c.id, v_d, true, 'payment_details.cancelled');
    if coalesce(p_sign_out, false) then v_out := public._r285_end_sessions(v_org, c.requested_by); end if;
  else
    perform public._r285_event(v_org, 'pay_details_cancelled_unverified', c.requested_by, c.id, v_d, true, 'payment_details.cancelled_without_two_step');
  end if;
  return jsonb_build_object('cancelled', true, 'flagged', v_strong, 'signed_out', v_out, 'verified', v_self or v_strong,
    'advice', case when v_self then null
                   when v_strong then 'Sign that account out everywhere and reset its password. Check its two-step set-up with the person.'
                   else 'Cancelled. To also flag that account and sign it out, set up two-step on your own account and enter a fresh code.' end);
end $$;

-- make a pending change live now: an admin, with two-step, never the one who made it
create or replace function public.pay_details_approve_now(p_change uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); c public.pay_detail_changes;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into c from public.pay_detail_changes x where x.id = p_change and x.org_id = v_org;
  if c.id is null then raise exception 'change not found' using errcode = '42501'; end if;
  if c.requested_by = v_me then
    raise exception 'Another admin has to approve this - not the person who made the change.' using errcode = '42501', hint = 'same_admin';
  end if;
  perform public._r285_step_up(v_org);
  if c.status <> 'pending' then raise exception 'This change is no longer waiting (it is %).', c.status using errcode = '22023', hint = 'not_pending'; end if;
  if not public._r285_apply(c.id, 'early') then raise exception 'This change is no longer waiting.' using errcode = '22023', hint = 'not_pending'; end if;
  perform public._r285_event(v_org, 'pay_details_approved_early', c.requested_by, c.id,
    jsonb_build_object('old_upi', public._r285_mask(c.old_upi), 'new_upi', public._r285_mask(c.new_upi),
                       'old_note', public._r285_mask(c.old_note), 'new_note', public._r285_mask(c.new_note)), true, 'payment_details.approved_early');
  return jsonb_build_object('applied', true);
end $$;

-- sign an account out on every device: its refresh tokens are marked revoked (never deleted). Its current access
-- token runs out within the hour; a new sign-in needs the password (+ two-step).
create or replace function public._r285_end_sessions(p_org uuid, p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_ids uuid[] := '{}'::uuid[]; v_n integer := 0;
begin
  if p_user is null then return '{}'::jsonb; end if;
  -- at most one sign-out per account per 10 minutes (each one audited)
  if exists (select 1 from public.studio_security_events e where e.org_id = p_org and e.kind = 'sessions_ended' and e.target_user = p_user
               and e.at > now() - interval '10 minutes') then
    return jsonb_build_object('skipped', 'recent');
  end if;
  if to_regclass('auth.sessions') is not null then
    begin execute 'select coalesce(array_agg(s.id), ''{}''::uuid[]) from auth.sessions s where s.user_id = $1' into v_ids using p_user;
    exception when others then v_ids := '{}'::uuid[]; end;
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    begin
      execute 'update auth.refresh_tokens set revoked = true, updated_at = now() where (session_id = any ($1) or user_id = $2::text) and not coalesce(revoked, false)'
        using v_ids, p_user;
      get diagnostics v_n = row_count;
    exception when others then v_n := 0;
    end;
  end if;
  perform public._r285_event(p_org, 'sessions_ended', p_user, null,
    jsonb_build_object('sessions', coalesce(array_length(v_ids, 1), 0), 'tokens_revoked', v_n, 'target_id', p_user), true, 'studio_security.sessions_ended');
  return jsonb_build_object('sessions', coalesce(array_length(v_ids, 1), 0), 'tokens_revoked', v_n);
end $$;

-- an admin signs a FLAGGED account of their studio out everywhere (protective: no code needed)
create or replace function public.studio_flagged_sign_out(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._r285_flagged(v_org, auth.uid()) then
    raise exception 'R35_FLAGGED: This account was flagged after a "This wasn''t us". Another admin has to clear the flag first.'
      using errcode = '42501', hint = 'flagged';
  end if;
  if p_user = auth.uid() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r285_flagged(v_org, p_user) then
    raise exception 'Only an account flagged by "This wasn''t us" can be signed out here.' using errcode = '22023', hint = 'not_flagged';
  end if;
  if exists (select 1 from public.studio_security_events e where e.org_id = v_org and e.kind = 'sessions_ended' and e.target_user = p_user
               and e.at > now() - interval '10 minutes') then
    raise exception 'This account was signed out less than 10 minutes ago. Try again later.' using errcode = '22023', hint = 'rate_limited';
  end if;
  return public._r285_end_sessions(v_org, p_user);
end $$;

-- clear a flag: a DIFFERENT admin, with two-step
create or replace function public.studio_flag_clear(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); n integer;
begin
  if v_me is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_user = v_me then raise exception 'Another admin has to clear your flag.' using errcode = '42501', hint = 'same_admin'; end if;
  perform public._r285_step_up(v_org);
  update public.studio_account_flags f set cleared_at = now(), cleared_by = v_me
   where f.org_id = v_org and f.user_id = p_user and f.cleared_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'This account is not flagged.' using errcode = '22023', hint = 'not_flagged'; end if;
  perform public._r285_event(v_org, 'flag_cleared', p_user, null, jsonb_build_object('target_id', p_user), true, 'studio_security.flag_cleared');
  return jsonb_build_object('cleared', true);
end $$;

-- last resort (e.g. every admin of a studio flagged): the Helm HQ OWNER clears a flag - two-step + a fresh code
-- (_hq_wgate, unknown action = Owner only, audited in HQ), a written reason (20+ characters: how identity was checked),
-- at most 5 a day; the studio's admins are told (bell + e-mail) and the studio's activity log has it.
create or replace function public.hq_studio_flag_clear(p_org uuid, p_user uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_reason text := left(btrim(coalesce(p_reason, '')), 300); n integer;
begin
  if char_length(v_reason) < 20 then
    raise exception 'Write how you checked who you are talking to (at least 20 characters).' using errcode = '22023'; end if;
  perform public._hq_wgate('hq.studio.flag_clear', 'studio_account_flags', p_user::text,
    jsonb_build_object('org_id', p_org, 'user_id', p_user, 'reason', v_reason));
  if (select count(*) from public.audit_log a where a.actor = auth.uid() and a.action = 'hq.studio.flag_clear'
        and a.at > now() - interval '24 hours') > 5 then
    raise exception 'Too many flags cleared in the last 24 hours.' using errcode = 'P0001'; end if;
  update public.studio_account_flags f set cleared_at = now(), cleared_by = auth.uid()
   where f.org_id = p_org and f.user_id = p_user and f.cleared_at is null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'This account is not flagged.' using errcode = '22023', hint = 'not_flagged'; end if;
  perform public._r285_event(p_org, 'flag_cleared', p_user, null,
    jsonb_build_object('target_id', p_user, 'by', 'Helm support (HQ owner)', 'hq', true), true, 'studio_security.flag_cleared_by_hq');
  return jsonb_build_object('cleared', true);
end $$;

-- the studio's own sensitive-settings history (admins; masked values only)
create or replace function public.studio_security_events_list(p_limit integer default 50)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'kind', z.kind, 'at', z.at, 'by', z.actor_name,
                     'label', public._r285_label(z.kind, z.detail)) order by z.at desc)
                     from (select * from public.studio_security_events e where e.org_id = v_org
                           order by e.at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) z), '[]'::jsonb);
end $$;

-- ---- 5) the other sensitive settings: two-step + alert, no wait ----------------------------------------------------
do $$ begin
  if to_regprocedure('public.studio_email_settings_set__pre0285(text, text)') is null then
    alter function public.studio_email_settings_set(text, text) rename to studio_email_settings_set__pre0285; end if;
  if to_regprocedure('public.save_org_payment_account__pre0285(text, text, text)') is null then
    alter function public.save_org_payment_account(text, text, text) rename to save_org_payment_account__pre0285; end if;
  if to_regprocedure('public.set_org_integration_status__pre0285(text, text)') is null then
    alter function public.set_org_integration_status(text, text) rename to set_org_integration_status__pre0285; end if;
  if to_regprocedure('public.admin_set_role_access__pre0285(text, text, boolean, boolean)') is null then
    alter function public.admin_set_role_access(text, text, boolean, boolean) rename to admin_set_role_access__pre0285; end if;
end $$;

-- a) reply-to address: a CHANGE of the address needs two-step (the sender name alone does not)
create or replace function public.studio_email_settings_set(p_from_name text, p_reply_to text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_old text; v_new text := lower(nullif(btrim(coalesce(p_reply_to, '')), '')); v jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.has_area('controls', 'edit'), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select s.email_reply_to into v_old from public.comms_settings s where s.org_id = v_org;
  if v_new is distinct from v_old then perform public._r285_step_up(v_org); end if;
  v := public.studio_email_settings_set__pre0285(p_from_name, p_reply_to);
  if v_new is distinct from v_old then
    perform public._r285_event(v_org, 'reply_to_changed', null, null,
      jsonb_build_object('old', public._r285_mask_email(v_old), 'new', public._r285_mask_email(v_new)), true, 'studio_security.reply_to');
  end if;
  return v;
end $$;

-- c) per-studio Razorpay keys and on / off (admins, 0117) - always two-step
create or replace function public.save_org_payment_account(p_key_id text, p_key_secret text, p_webhook_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); v_old text; v jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not_allowed' using errcode = '42501'; end if;
  perform public._r285_step_up(v_org);
  select a.key_id into v_old from public.org_payment_accounts a where a.org_id = v_org;
  v := public.save_org_payment_account__pre0285(p_key_id, p_key_secret, p_webhook_secret);
  perform public._r285_event(v_org, 'razorpay_keys_saved', null, null,
    jsonb_build_object('old_key', public._r285_mask(v_old), 'new_key', public._r285_mask(btrim(coalesce(p_key_id, '')))), true, 'studio_security.razorpay_keys');
  return v;
end $$;

create or replace function public.set_org_integration_status(p_kind text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r35-0285: Razorpay on / off needs two-step + alert; WhatsApp on / off is unchanged
declare v_org uuid := public.current_org_id(); v jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_kind = 'razorpay' then perform public._r285_step_up(v_org); end if;
  v := public.set_org_integration_status__pre0285(p_kind, p_status);
  if p_kind = 'razorpay' then
    perform public._r285_event(v_org, 'razorpay_status_changed', null, null, jsonb_build_object('status', p_status), true, 'studio_security.razorpay_status');
  end if;
  return v;
end $$;

-- d) Control Center money switches (finance / discount_approve / close_owed): only a REAL change needs two-step
create or replace function public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
returns public.role_access language plpgsql security definer set search_path = '' as $$
-- r35-0285
declare v_org uuid := public.current_org_id(); r public.role_access; v_money boolean := p_area in ('finance', 'discount_approve', 'close_owed');
  v_v boolean := coalesce(p_view, false); v_e boolean := coalesce(p_edit, false) and coalesce(p_view, false); v_changed boolean := false;
begin
  if v_money then
    if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
    select * into r from public.role_access x where x.org_id = v_org and x.role = p_role and x.area = p_area;
    v_changed := r.area is null or (r.can_view, r.can_edit) is distinct from (v_v, v_e);
    if v_changed then perform public._r285_step_up(v_org); end if;
  end if;
  r := public.admin_set_role_access__pre0285(p_role, p_area, p_view, p_edit);
  if v_money and v_changed then
    perform public._r285_event(v_org, 'money_access_changed', null, null,
      jsonb_build_object('role', p_role, 'area', p_area, 'view', v_v, 'edit', v_e,
                         'area_label', case p_area when 'finance' then 'Budget & finance' when 'discount_approve' then 'Approve discounts'
                                                   else 'Close with balance owed' end), true, 'studio_security.money_access');
  end if;
  return r;
end $$;

-- b) business e-mail: changing / clearing a CONFIRMED address needs two-step; every change by a person is alerted
create or replace function public._r285_tg_org_email_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r35-0285: a CONFIRMED address may not be changed, cleared or un-confirmed (the way round the rule) without two-step
  if coalesce(old.business_email_confirmed, false) and nullif(btrim(coalesce(old.business_email, '')), '') is not null
     and (new.business_email is distinct from old.business_email or not coalesce(new.business_email_confirmed, false))
     and public._r285_user_call() then
    perform public._r285_step_up(old.id);
  end if;
  return new;
end $$;
create or replace function public._r285_tg_org_email_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r35-0285
  if new.business_email is distinct from old.business_email and auth.uid() is not null
     and (coalesce(old.business_email_confirmed, false) or coalesce(new.business_email_confirmed, false)) then
    perform public._r285_event(new.id, 'business_email_changed', null, null,
      jsonb_build_object('old', public._r285_mask_email(old.business_email), 'new', public._r285_mask_email(new.business_email)), true, 'studio_security.business_email');
  end if;
  return null;
end $$;
drop trigger if exists zz_r285_email_gate on public.organizations;
create trigger zz_r285_email_gate before update of business_email, business_email_confirmed on public.organizations
  for each row execute function public._r285_tg_org_email_gate();
drop trigger if exists zz_r285_email_alert on public.organizations;
create trigger zz_r285_email_alert after update of business_email on public.organizations
  for each row execute function public._r285_tg_org_email_alert();

-- f) admins added / removed by SOMEONE ELSE: two-step + alert. Self-service (accept an invitation, create a studio): alert only.
create or replace function public._r285_tg_profile_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- r35-0285
  v_was boolean := tg_op in ('UPDATE', 'DELETE') and coalesce(old.role, '') = 'admin';
  v_is boolean := tg_op in ('UPDATE', 'INSERT') and coalesce(new.role, '') = 'admin';
  v_id uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_org uuid := case when tg_op = 'DELETE' then old.org_id else coalesce(new.org_id, case when tg_op = 'UPDATE' then old.org_id end) end;
begin
  if v_was = v_is or v_org is null then return case when tg_op = 'DELETE' then old else new end; end if;
  if tg_when = 'BEFORE' then
    if public._r285_user_call() and auth.uid() <> v_id then perform public._r285_step_up(v_org); end if;
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- a brand-new studio's own first admin (creating your studio) is not news for anyone
  if auth.uid() is not null and not (auth.uid() = v_id and v_is
       and not exists (select 1 from public.profiles p where p.org_id = v_org and p.role = 'admin' and p.id <> v_id)) then
    perform public._r285_event(v_org, case when v_is then 'admin_added' else 'admin_removed' end, v_id, null,
      jsonb_build_object('target_id', v_id, 'self', auth.uid() = v_id), true,
      case when v_is then 'studio_security.admin_added' else 'studio_security.admin_removed' end);
  end if;
  return null;
end $$;
drop trigger if exists zz_r285_admin_gate on public.profiles;
create trigger zz_r285_admin_gate before insert or update of role, org_id or delete on public.profiles
  for each row execute function public._r285_tg_profile_admin();
drop trigger if exists zz_r285_admin_alert on public.profiles;
create trigger zz_r285_admin_alert after insert or update of role, org_id or delete on public.profiles
  for each row execute function public._r285_tg_profile_admin();

create or replace function public._r285_tg_invite_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- r35-0285: an invitation AS ADMIN needs two-step (+ alert)
  if coalesce(new.role, '') <> 'admin' or (tg_op = 'UPDATE' and coalesce(old.role, '') = 'admin') or new.org_id is null then return new; end if;
  if tg_when = 'BEFORE' then
    if public._r285_user_call() then perform public._r285_step_up(new.org_id); end if;
    return new;
  end if;
  if auth.uid() is not null then
    perform public._r285_event(new.org_id, 'admin_invited', null, null,
      jsonb_build_object('target_email', public._r285_mask_email(new.email)), true, 'studio_security.admin_invited');
  end if;
  return null;
end $$;
drop trigger if exists zz_r285_invite_gate on public.invitations;
create trigger zz_r285_invite_gate before insert or update of role on public.invitations
  for each row execute function public._r285_tg_invite_admin();
drop trigger if exists zz_r285_invite_alert on public.invitations;
create trigger zz_r285_invite_alert after insert or update of role on public.invitations
  for each row execute function public._r285_tg_invite_admin();

-- e) two-step turned off for an admin: alert every admin (never blocks Supabase Auth; any error is swallowed)
create or replace function public._r285_tg_mfa_off()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_uid uuid;
begin
  -- r35-0285
  begin
    v_uid := old.user_id;
    if old.status::text <> 'verified' or (tg_op = 'UPDATE' and new.status::text = 'verified') then return null; end if;
    if public._r285_has_mfa(v_uid) then return null; end if;   -- another authenticator is still on
    select p.org_id into v_org from public.profiles p where p.id = v_uid and p.role = 'admin';
    if v_org is null then return null; end if;
    perform public._r285_event(v_org, 'two_step_off', v_uid, null, jsonb_build_object('target_id', v_uid), true, 'studio_security.two_step_off');
  exception when others then raise warning 'r35-0285: two-step-off alert skipped (%)', sqlstate;
  end;
  return null;
end $$;
do $$ begin
  if to_regclass('auth.mfa_factors') is null then raise notice '0285: auth.mfa_factors not found - the two-step-off alert is off'; return; end if;
  begin
    execute 'drop trigger if exists zz_r285_mfa_off on auth.mfa_factors';
    execute 'create trigger zz_r285_mfa_off after update of status or delete on auth.mfa_factors for each row execute function public._r285_tg_mfa_off()';
  exception when others then
    raise notice '0285: could not add the two-step-off alert on auth.mfa_factors (%) - everything else works', sqlerrm;
  end;
end $$;

-- ---- 6) bell: the 'studio_security' type (admins only by default) --------------------------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[['notification_catalog', ''], ['notification_type_of', 'text, text'], ['notify_default', 'uuid, text, text, text']] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0285', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0285');
    end if;
  end loop;
end $$;
create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r35-0285: + studio_security (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'studio_security') then c
    else c || $cat$[
    {"type":"studio_security","group":"System","label":"Payment details and sensitive settings",
     "description":"Payment details (UPI / bank) changed, cancelled or live; reply-to or business e-mail, online-payment keys, money access, admins added or removed, two-step turned off. Admins only.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0285() as c) x;
$$;
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r35-0285
  select case when lower(btrim(coalesce(p_kind, ''))) = 'studio_security' then 'studio_security'
              else public.notification_type_of__pre0285(p_kind, p_channel) end;
$$;
create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r35-0285: sensitive-settings notices reach admins only unless a studio admin opts a role in
  select case when p_type = 'studio_security' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0285(p_org, p_role, p_type, p_channel) end;
$$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r285_sec_read') then
    create policy r285_sec_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') <> 'studio_security' or (select public.is_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r285_sec_ins') then
    create policy r285_sec_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') <> 'studio_security');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r285_sec_upd') then
    create policy r285_sec_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') <> 'studio_security') with check (coalesce(kind, '') <> 'studio_security');
  end if;
end $$;

-- ---- 7) e-mail: outbox kind 'studio_security' (superset) + one claim branch ---------------------------------------
-- recipients resolved here (never from the row): every admin + the owner; the person an admin change is about.
-- Masked values only. Never for the sample studio.
create or replace function public._r285_mail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r35-0285
declare e public.studio_security_events; v_to jsonb; v_extra uuid;
begin
  select * into e from public.studio_security_events x where x.id = p_id;
  if e.id is null or exists (select 1 from public.organizations o where o.id = e.org_id and coalesce(o.is_sample_master, false)) then return null; end if;
  v_extra := case when e.kind in ('admin_removed', 'admin_added', 'sessions_ended', 'flag_cleared') then e.target_user end;
  select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
    from public.profiles p
   where p.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     and (p.id in (select a from public._r285_admins(e.org_id) a) or (v_extra is not null and p.id = v_extra));
  return jsonb_build_object('to', v_to, 'data', (e.detail - 'target_id' - 'effective_at') || jsonb_build_object('event', e.kind,
    'by', coalesce(e.detail ->> 'by', e.actor_name), 'target', e.detail ->> 'target'));
end $$;

do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0285: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('''studio_security''' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0285: helm_notice_outbox kind check has an unexpected body - left unchanged (security e-mails stay off; bells still work)'; return; end if;
  v_kinds := array(select distinct k from unnest(v_kinds || array['studio_security']) k order by k);
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0285 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0285 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r35-paysafe-0285' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0285: helm_notice_outbox_claim has an unexpected body - left unchanged (security e-mails are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind = ''studio_security'' and r.ref_id is not null then\n'
        || E'      -- r35-paysafe-0285: payment details / sensitive settings -> every admin (resolved in _r285_mail)\n'
        || E'      v_data := public._r285_mail(r.ref_id);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 8) the 24-hour switch: comms_tick also runs it; pg_cron every 5 minutes when installed ------------------------
do $$ begin
  if to_regprocedure('public.comms_tick__pre0285()') is null then
    alter function public.comms_tick() rename to comms_tick__pre0285;
  end if;
end $$;
create or replace function public.comms_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r35-0285
declare v jsonb; v2 jsonb;
begin
  v := public.comms_tick__pre0285();
  begin v2 := public.pay_details_tick();
  exception when others then v2 := jsonb_build_object('pay_details_error', sqlstate);
  end;
  return coalesce(v, '{}'::jsonb) || coalesce(v2, '{}'::jsonb);
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_pay_details_tick') then
        perform cron.schedule('helm_pay_details_tick', '*/5 * * * *', 'select public.pay_details_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_pay_details_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

-- ---- 9) trial retention (0184, switched off) keeps these records ----------------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''pay_detail_changes''' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, '''helm_notice_outbox''', ''))) <> length('''helm_notice_outbox''') then
    raise notice '0285: _tr184_keep_tables() has an unexpected body - left unchanged'; return; end if;
  execute replace(v_def, '''helm_notice_outbox''', '''helm_notice_outbox'', ''pay_detail_changes'', ''studio_security_events'', ''studio_account_flags''');
end $$;

-- ---- 10) privileges ------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: nobody calls these through the API
  foreach f in array array['public._r285_tg_keep()', 'public._r285_mask(text)', 'public._r285_mask_email(text)', 'public._r285_name(uuid)',
                           'public._r285_has_mfa(uuid)', 'public._r285_mfa_at()', 'public._r285_flagged(uuid, uuid)',
                           'public._r285_step_up_state(uuid)', 'public._r285_step_up(uuid)', 'public._r285_user_call()',
                           'public._r285_admins(uuid)', 'public._r285_when(uuid, timestamptz)', 'public._r285_label(text, jsonb)',
                           'public._r285_event(uuid, text, uuid, uuid, jsonb, boolean, text)', 'public._r285_effective(uuid)',
                           'public._pst_pay_details(uuid)', 'public._r285_apply(uuid, text)', 'public._r285_apply_due(uuid)',
                           'public._r285_ever_had(uuid)', 'public._r285_request(uuid, text, text)', 'public._r285_end_sessions(uuid, uuid)',
                           'public._r285_tg_org_email_gate()', 'public._r285_tg_org_email_alert()', 'public._r285_tg_profile_admin()',
                           'public._r285_tg_invite_admin()', 'public._r285_tg_mfa_off()', 'public._r285_mail(uuid)',
                           'public.pay_details_tick()', 'public.comms_tick()', 'public.comms_tick__pre0285()',
                           'public.payment_schedule_settings_get__pre0285()', 'public.payment_schedule_settings_set__pre0285(jsonb)',
                           'public.studio_email_settings_set__pre0285(text, text)', 'public.save_org_payment_account__pre0285(text, text, text)',
                           'public.set_org_integration_status__pre0285(text, text)',
                           'public.admin_set_role_access__pre0285(text, text, boolean, boolean)',
                           'public.notification_catalog__pre0285()', 'public.notification_type_of__pre0285(text, text)',
                           'public.notify_default__pre0285(uuid, text, text, text)', 'public.notify_default(uuid, text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.pay_details_tick() to service_role';
    execute 'grant execute on function public.comms_tick() to service_role';
    execute 'grant execute on function public._r285_mail(uuid) to service_role';
    execute 'grant execute on function public.save_org_payment_account(text, text, text) to service_role';
    execute 'grant execute on function public.set_org_integration_status(text, text) to service_role';
  end if;
  -- the app: signed-in people only (each function checks who may do what)
  foreach f in array array['public.payment_schedule_settings_get()', 'public.payment_schedule_settings_set(jsonb)',
                           'public.pay_details_cancel(uuid, boolean)', 'public.pay_details_approve_now(uuid)',
                           'public.studio_flagged_sign_out(uuid)', 'public.studio_flag_clear(uuid)', 'public.studio_security_events_list(integer)',
                           'public.hq_studio_flag_clear(uuid, uuid, text)',
                           'public.studio_email_settings_set(text, text)', 'public.save_org_payment_account(text, text, text)',
                           'public.set_org_integration_status(text, text)', 'public.admin_set_role_access(text, text, boolean, boolean)',
                           'public.notification_catalog()', 'public.notification_type_of(text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- VERIFY (read-only) ------------------------------------------------------------------------------------------------
-- select count(*) from public.pay_detail_changes where status = 'pending';                 -- changes waiting their 24 hours
-- select kind, at, actor_name from public.studio_security_events order by at desc limit 20;  -- the alerts (masked)
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 three new tables with row security on (pay_detail_changes, studio_security_events, studio_account_flags)',
     (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
        and c.relname in ('pay_detail_changes', 'studio_security_events', 'studio_account_flags') and c.relrowsecurity) = 3),
  ('02 the app cannot read or write them directly',
     not has_table_privilege('authenticated', 'public.pay_detail_changes', 'select')
     and not has_table_privilege('authenticated', 'public.studio_account_flags', 'insert')
     and not has_table_privilege('anon', 'public.studio_security_events', 'select')),
  ('03 the payment settings save goes through two-step + the 24-hour wait (old body kept, not callable)',
     position('r35-0285' in pg_get_functiondef('public.payment_schedule_settings_set(jsonb)'::regprocedure)) > 0
     and to_regprocedure('public.payment_schedule_settings_set__pre0285(jsonb)') is not null
     and not has_function_privilege('authenticated', 'public.payment_schedule_settings_set__pre0285(jsonb)', 'execute')),
  ('04 clients see only LIVE details (reminders + client page read _r285_effective)',
     position('_r285_effective' in pg_get_functiondef('public._pst_pay_details(uuid)'::regprocedure)) > 0),
  ('05 existing payment details unchanged: what clients see = what is stored, for every studio',
     not exists (select 1 from public.payment_schedule_settings s cross join lateral public._r285_effective(s.org_id) e
                  where (e.upi, e.note) is distinct from (s.upi_id, s.pay_note))),
  ('06 the other sensitive settings are gated (reply-to, Razorpay keys + on / off, money switches)',
     position('_r285_step_up' in pg_get_functiondef('public.studio_email_settings_set(text, text)'::regprocedure)) > 0
     and position('_r285_step_up' in pg_get_functiondef('public.save_org_payment_account(text, text, text)'::regprocedure)) > 0
     and position('_r285_step_up' in pg_get_functiondef('public.set_org_integration_status(text, text)'::regprocedure)) > 0
     and position('_r285_step_up' in pg_get_functiondef('public.admin_set_role_access(text, text, boolean, boolean)'::regprocedure)) > 0),
  ('07 business e-mail + admins added / removed are gated (triggers on organizations, profiles, invitations)',
     (select count(*) from pg_trigger where tgname in ('zz_r285_email_gate', 'zz_r285_email_alert') and tgrelid = 'public.organizations'::regclass) = 2
     and (select count(*) from pg_trigger where tgname in ('zz_r285_admin_gate', 'zz_r285_admin_alert') and tgrelid = 'public.profiles'::regclass) = 2
     and (select count(*) from pg_trigger where tgname in ('zz_r285_invite_gate', 'zz_r285_invite_alert') and tgrelid = 'public.invitations'::regclass) = 2),
  ('08 alerts: e-mail kind studio_security allowed + claim branch, bell rows admins only',
     position('''studio_security''' in coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check'), '''studio_security''')) > 0
     and position('r35-paysafe-0285' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
     and (select count(*) from pg_policies where tablename = 'notifications' and policyname in ('r285_sec_read', 'r285_sec_ins', 'r285_sec_upd')) = 3),
  ('09 the app can call the new buttons; nobody can call the tick or the internals',
     has_function_privilege('authenticated', 'public.pay_details_cancel(uuid, boolean)', 'execute')
     and has_function_privilege('authenticated', 'public.pay_details_approve_now(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.pay_details_tick()', 'execute')
     and not has_function_privilege('authenticated', 'public._r285_step_up(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.payment_schedule_settings_get()', 'execute')),
  ('10 the 24-hour switch also runs inside comms_tick',
     position('pay_details_tick' in pg_get_functiondef('public.comms_tick()'::regprocedure)) > 0)
) v(item, ok) order by item;
-- optional (informational): the "two-step turned off" alert -> 1 row when Supabase allowed the trigger
-- select tgname from pg_trigger where tgname = 'zz_r285_mfa_off';
