-- 0274_automations_optin.sql - CANONICAL forward-only.
-- REQUIRES 0078 + 0092 + 0264 (comms_settings, _comms_cfg), 0129 (event_reminders), 0132 (_assign132_enqueue),
--          0241 (delivery_settings), 0256 (vendor_request_sends), 0261 (client_view_settings, _lv261_cfg),
--          0262 (_qv262_cfg, app_config 'quote_validity'), 0264 (payment_schedule_settings, payment_overdue_alerts),
--          0265 (app_config 'crew'), 0266 (inbox_settings, inbox_person_prefs, helm_notice_outbox kind inbox_digest),
--          0269 (automation_settings, runsheet_reminder_sends, _r24_cfg), 0183 (_trial_locked), 0179 (_tb179_no_send).
--
-- In plain words (owner, r25 - "production e-mail is now on; nothing may go out unless the studio admin switched it on"):
--   1  EVERY automation that sends something by itself (e-mail / WhatsApp to clients, vendors or crew, an e-mail digest
--      to the team, or a scheduled bell / chat reminder for the team) is now OFF unless the studio admin turns it on in
--      Control Center -> Automations. That page is the ONE place with the on / off switches:
--        clients : payment reminders, client follow-ups, quote-expiry reminders, enquiry-form thank-you
--        team    : viewed-but-not-approved alert, quote-expiry bell, overdue payment bell, low-stock bell, event
--                  reminders, inbox e-mails (daily digest / instant), WhatsApp copies of notifications
--        vendors : vendor request reminders, delivery & arrival reminders
--        crew    : run-sheet reminders, "you've been assigned" WhatsApp, open-shift WhatsApp notices
--      ("Add the default payment schedule on approval" sends nothing and keeps its own setting.)
--   2  THE DAILY DIGEST IS OFF NOW: inbox e-mails are off for every studio and the studio default is "No e-mails";
--      a person who never picked their own setting follows that. Digest e-mails already waiting are marked skipped.
--   3  EXISTING STUDIOS: every automation that was ON only because it was the default is switched OFF (an automation
--      whose default was already off and that a studio switched on stays on - that was a real choice). Each change is
--      written to automation_optin_backup_0274 (studio, setting, value before / after) so it can be put back. This
--      data step runs ONCE (a marker row); running the file again never undoes a switch an admin turned on since.
--   4  Messages already waiting in a queue for an automation that is now off are marked 'skipped' (status only; no row
--      is deleted). A message someone sent by hand ("Send reminder now", "Send a nudge", a vendor request) is never
--      touched.
--   5  NEW Control Center RPCs: automation_overview() (Control Center view) and automation_switch(key, on) (Control
--      Center edit, audit-logged, refused for a read-only studio). Column defaults and the settings readers now say
--      OFF, so a NEW studio starts with everything off too.
--   6  FIX: 0265 (crew) and 0266 (inbox) both defined public._r23_cfg(uuid); whichever ran last won, so on a database
--      where 0266 ran after 0265 the crew settings read the inbox settings. _r23_cfg now returns both (their keys never
--      overlap), from _r25_inbox_cfg + _r25_crew_cfg.
-- How each automation is held off (no long function body is copied):
--   * settings readers re-issued with OFF defaults: _comms_cfg (pay_enabled, low_stock_enabled), _lv261_cfg
--     (followup_enabled), _qv262_cfg (client_reminders, studio_reminders), _r24_cfg (runsheet_enabled), _r23_cfg
--     (inbox email_enabled / digest_default, crew notifyShifts);
--   * a BEFORE INSERT gate (trigger a274_gate, returns no row while the automation is off) on the ledgers the ticks
--     write first: event_reminders (0129), runsheet_reminder_sends (0269), payment_overdue_alerts (0264) and
--     vendor_request_sends kind 'reminder' (0256) - the tick then sends nothing for that studio;
--   * _assign132_enqueue (0132 "you've been assigned" WhatsApp) renamed ONCE to *__pre0274 and wrapped.
-- Changes: 1 new table (automation_optin_backup_0274, studio_id = Helm's own record; RLS on, no API privilege), 3 new
-- columns on automation_settings (default false), column DEFAULTS flipped to off (comms_settings pay_enabled /
-- low_stock_enabled, client_view_settings followup_enabled, payment_schedule_settings overdue_bell, automation_settings
-- runsheet_enabled, inbox_settings email_enabled / digest_default), stored values switched off (backed up), queued
-- rows marked skipped, new functions + 4 triggers, 1 wrapper. Nothing deleted, no table / column / policy dropped.
-- Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): switch each automation back on in Control Center -> Automations, or put the
--   stored values back from public.automation_optin_backup_0274 (old_value). To remove the gates: drop trigger a274_gate
--   on each of the 4 tables; drop function public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text);
--   alter function public._assign132_enqueue__pre0274(...) rename to _assign132_enqueue.

do $$ begin
  if to_regclass('public.comms_settings') is null or to_regprocedure('public._comms_cfg(uuid)') is null
     or to_regprocedure('public._comms_default_pay_template()') is null or to_regprocedure('public._comms_default_fu_template()') is null then
    raise exception 'STOP 0274: apply 0078 (comms automation) first'; end if;
  if to_regclass('public.event_reminders') is null then raise exception 'STOP 0274: apply 0129 (event reminders) first'; end if;
  if to_regprocedure('public._assign132_enqueue(uuid,uuid,text,uuid,text,text,text,text,text)') is null
     or to_regclass('public.assign_notify_outbox') is null then raise exception 'STOP 0274: apply 0132 (assignment notify) first'; end if;
  if to_regclass('public.delivery_settings') is null then raise exception 'STOP 0274: apply 0241 (delivery reminders) first'; end if;
  if to_regclass('public.vendor_request_sends') is null then raise exception 'STOP 0274: apply 0256 (vendor requests) first'; end if;
  if to_regclass('public.client_view_settings') is null or to_regprocedure('public._lv261_cfg(uuid)') is null then
    raise exception 'STOP 0274: apply 0261 (client link views) first'; end if;
  if to_regprocedure('public._qv262_cfg(uuid)') is null or to_regclass('public.app_config') is null then
    raise exception 'STOP 0274: apply 0262 (quote validity) first'; end if;
  if to_regclass('public.payment_schedule_settings') is null or to_regclass('public.payment_overdue_alerts') is null then
    raise exception 'STOP 0274: apply 0264 (payment schedules) first'; end if;
  if to_regprocedure('public.get_crew_settings()') is null then raise exception 'STOP 0274: apply 0265 (crew) first'; end if;
  if to_regclass('public.inbox_settings') is null or to_regclass('public.inbox_person_prefs') is null
     or to_regclass('public.helm_notice_outbox') is null then raise exception 'STOP 0274: apply 0266 (notification inbox) first'; end if;
  if to_regclass('public.automation_settings') is null or to_regclass('public.runsheet_reminder_sends') is null
     or to_regprocedure('public._r24_cfg(uuid)') is null then raise exception 'STOP 0274: apply 0269 (r24 automation) first'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null or to_regprocedure('public._tb179_no_send(uuid)') is null then
    raise exception 'STOP 0274: apply 0179 + 0183 first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null then raise exception 'STOP 0274: has_area / current_org_id / user_role missing'; end if;
end $$;

-- ---- 1) the backup of every value this file switches off (Helm's own record: studio_id, never purged) ------------------
create table if not exists public.automation_optin_backup_0274 (
  id          bigint generated always as identity primary key,
  studio_id   uuid,                          -- the studio (null = this file's own marker row)
  store       text not null check (char_length(store) <= 60),      -- where the setting lives
  setting     text not null check (char_length(setting) <= 60),
  old_value   jsonb,                         -- {"stored": <value or null = no row / no key>, "effective": <what it did>}
  new_value   jsonb,
  created_at  timestamptz not null default now()
);
alter table public.automation_optin_backup_0274 enable row level security;
revoke all on table public.automation_optin_backup_0274 from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.automation_optin_backup_0274 from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.automation_optin_backup_0274 from authenticated'; end if;
end $$;
create index if not exists automation_optin_backup_0274_studio on public.automation_optin_backup_0274(studio_id);

-- ---- 2) the three automations that had no switch of their own (default OFF) -----------------------------------------
alter table public.automation_settings add column if not exists event_reminders_enabled boolean not null default false;
alter table public.automation_settings add column if not exists vendor_reminders_enabled boolean not null default false;
alter table public.automation_settings add column if not exists assign_whatsapp_enabled boolean not null default false;

-- ---- 3) ONCE: existing studios - everything that was on only by default goes off (backed up first) ------------------
-- Runs before the readers below are re-issued, so "effective before" is what each automation really did until now.
do $$
declare o record; v jsonb; v_b boolean; v_t text; n integer := 0;
begin
  if exists (select 1 from public.automation_optin_backup_0274 b where b.studio_id is null and b.store = '0274' and b.setting = 'data_step_done') then
    raise notice '0274: data step already done - stored settings left as they are'; return;
  end if;
  for o in select org.id from public.organizations org order by org.id loop
    -- a) comms_settings (0078 / 0264): payment reminders (default ON since 0264), low-stock bell (default ON)
    v := public._comms_cfg(o.id);
    if coalesce((v ->> 'pay_enabled')::boolean, false) then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'comms_settings', 'pay_enabled',
                jsonb_build_object('stored', (select to_jsonb(s.pay_enabled) from public.comms_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    if coalesce((v ->> 'low_stock_enabled')::boolean, false) then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'comms_settings', 'low_stock_enabled',
                jsonb_build_object('stored', (select to_jsonb(s.low_stock_enabled) from public.comms_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    -- b) client_view_settings (0261): viewed-but-not-approved alert (default ON)
    if coalesce((public._lv261_cfg(o.id) ->> 'followup_enabled')::boolean, false) then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'client_view_settings', 'followup_enabled',
                jsonb_build_object('stored', (select to_jsonb(s.followup_enabled) from public.client_view_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    -- c) app_config 'quote_validity' (0262): client e-mail + studio bell before a quote expires (both default ON)
    v := public._qv262_cfg(o.id);
    foreach v_t in array array['client_reminders', 'studio_reminders'] loop
      if coalesce((v ->> v_t)::boolean, false) then
        insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
          values (o.id, 'app_config:quote_validity', v_t,
                  jsonb_build_object('stored', (select c.value -> v_t from public.app_config c where c.org_id = o.id and c.key = 'quote_validity'), 'effective', true),
                  jsonb_build_object('stored', false, 'effective', false));
        n := n + 1;
      end if;
    end loop;
    -- d) payment_schedule_settings (0264): overdue bell (default ON)
    select coalesce((select s.overdue_bell from public.payment_schedule_settings s where s.org_id = o.id), true) into v_b;
    if v_b then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'payment_schedule_settings', 'overdue_bell',
                jsonb_build_object('stored', (select to_jsonb(s.overdue_bell) from public.payment_schedule_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    -- e) automation_settings (0269): run-sheet reminders (default ON); 0129 / 0256 / 0132 had no switch (always on)
    if coalesce((public._r24_cfg(o.id) ->> 'runsheet_enabled')::boolean, false) then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'automation_settings', 'runsheet_enabled',
                jsonb_build_object('stored', (select to_jsonb(s.runsheet_enabled) from public.automation_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
      select o.id, 'automation_settings', x.k, jsonb_build_object('stored', null, 'effective', true),
             jsonb_build_object('stored', false, 'effective', false)
        from unnest(array['event_reminders_enabled', 'vendor_reminders_enabled', 'assign_whatsapp_enabled']) x(k);
    n := n + 3;
    -- f) inbox_settings (0266): inbox e-mails (default ON) + the studio default (default "Daily digest")
    select coalesce((select s.email_enabled from public.inbox_settings s where s.org_id = o.id), true),
           coalesce((select s.digest_default from public.inbox_settings s where s.org_id = o.id), 'daily') into v_b, v_t;
    if v_b then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'inbox_settings', 'email_enabled',
                jsonb_build_object('stored', (select to_jsonb(s.email_enabled) from public.inbox_settings s where s.org_id = o.id), 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
    if v_t = 'daily' then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'inbox_settings', 'digest_default',
                jsonb_build_object('stored', (select to_jsonb(s.digest_default) from public.inbox_settings s where s.org_id = o.id), 'effective', 'daily'),
                jsonb_build_object('stored', 'off', 'effective', 'off'));
      n := n + 1;
    end if;
    -- g) app_config 'crew' (0265): open-shift WhatsApp notices (default ON)
    select c.value into v from public.app_config c where c.org_id = o.id and c.key = 'crew';
    if coalesce(case when jsonb_typeof(v -> 'notifyShifts') = 'boolean' then (v ->> 'notifyShifts')::boolean end, true) then
      insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
        values (o.id, 'app_config:crew', 'notifyShifts', jsonb_build_object('stored', v -> 'notifyShifts', 'effective', true),
                jsonb_build_object('stored', false, 'effective', false));
      n := n + 1;
    end if;
  end loop;

  -- the stored values (rows that do not exist simply follow the new OFF defaults below)
  update public.comms_settings set pay_enabled = false, updated_at = now() where pay_enabled;
  update public.comms_settings set low_stock_enabled = false, updated_at = now() where low_stock_enabled;
  update public.client_view_settings set followup_enabled = false, updated_at = now() where followup_enabled;
  update public.app_config c set value = c.value || jsonb_build_object('client_reminders', false), updated_at = now()
   where c.key = 'quote_validity' and jsonb_typeof(c.value) = 'object' and c.value -> 'client_reminders' = 'true'::jsonb;
  update public.app_config c set value = c.value || jsonb_build_object('studio_reminders', false), updated_at = now()
   where c.key = 'quote_validity' and jsonb_typeof(c.value) = 'object' and c.value -> 'studio_reminders' = 'true'::jsonb;
  update public.payment_schedule_settings set overdue_bell = false, updated_at = now() where overdue_bell;
  update public.automation_settings set runsheet_enabled = false, updated_at = now() where runsheet_enabled;
  update public.inbox_settings set email_enabled = false, updated_at = now() where email_enabled;
  update public.inbox_settings set digest_default = 'off', updated_at = now() where digest_default = 'daily';
  update public.app_config c set value = c.value || jsonb_build_object('notifyShifts', false), updated_at = now()
   where c.key = 'crew' and jsonb_typeof(c.value) = 'object' and c.value -> 'notifyShifts' = 'true'::jsonb;

  insert into public.automation_optin_backup_0274(studio_id, store, setting, old_value, new_value)
    values (null, '0274', 'data_step_done', null, jsonb_build_object('rows', n, 'at', now()));
  raise notice '0274: % setting(s) switched off and backed up', n;
end $$;

-- ---- 4) new studios start with everything off: column defaults ---------------------------------------------------
alter table public.comms_settings alter column pay_enabled set default false;
alter table public.comms_settings alter column low_stock_enabled set default false;
alter table public.client_view_settings alter column followup_enabled set default false;
alter table public.payment_schedule_settings alter column overdue_bell set default false;
alter table public.automation_settings alter column runsheet_enabled set default false;
alter table public.inbox_settings alter column email_enabled set default false;
alter table public.inbox_settings alter column digest_default set default 'off';

-- ---- 5) the settings readers: OFF when a studio never switched it on ------------------------------------------------
create or replace function public._comms_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r25-automations-0274: payment reminders + low-stock bell OFF unless the studio switched them on (0264 cadence kept)
  select jsonb_build_object(
    'pay_enabled', coalesce(s.pay_enabled, false),
    'pay_channels', to_jsonb(coalesce(s.pay_channels, array['email']::text[])),
    'pay_before_days', coalesce(s.pay_before_days, 3),
    'pay_on_due', coalesce(s.pay_on_due, true),
    'pay_every_days', coalesce(s.pay_every_days, 3),
    'pay_max_overdue', coalesce(s.pay_max_overdue, 1),
    'pay_template', coalesce(s.pay_template, public._comms_default_pay_template()),
    'fu_enabled', coalesce(s.fu_enabled, false),
    'fu_channels', to_jsonb(coalesce(s.fu_channels, array['email']::text[])),
    'fu_delay_days', coalesce(s.fu_delay_days, 3),
    'fu_max', coalesce(s.fu_max, 2),
    'fu_template', coalesce(s.fu_template, public._comms_default_fu_template()),
    'low_stock_enabled', coalesce(s.low_stock_enabled, false),
    'wa_forward_enabled', coalesce(s.wa_forward_enabled, false),
    'wa_forward_roles', coalesce(s.wa_forward_roles, '{}'::jsonb),
    'studio_whatsapp', s.studio_whatsapp,
    'updated_at', s.updated_at)
  from (select 1) one left join public.comms_settings s on s.org_id = p_org;
$$;

create or replace function public._lv261_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-link-views-0261 + r25-automations-0274: the viewed-but-not-approved alert is OFF unless switched on
  select jsonb_build_object(
    'track_enabled', coalesce(s.track_enabled, true),
    'bell_first', coalesce(s.bell_first, true),
    'bell_repeat', coalesce(s.bell_repeat, false),
    'repeat_hours', coalesce(s.repeat_hours, 12),
    'followup_enabled', coalesce(s.followup_enabled, false),
    'followup_days', coalesce(s.followup_days, 2),
    'updated_at', s.updated_at)
  from (select 1) one left join public.client_view_settings s on s.org_id = p_org;
$$;

create or replace function public._qv262_cfg(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-quote-validity-0262 + r25-automations-0274: client e-mail + studio bell reminders OFF unless switched on
declare v jsonb; d integer; r integer[];
begin
  select c.value into v from public.app_config c where c.org_id = p_org and c.key = 'quote_validity';
  if jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;
  d := case when jsonb_typeof(v -> 'default_days') = 'number' and (v ->> 'default_days') ~ '^[0-9]{1,3}$'
            then (v ->> 'default_days')::integer end;
  if d is null or d < 1 or d > 365 then d := 14; end if;
  if jsonb_typeof(v -> 'reminder_days') = 'array' then
    select coalesce(array_agg(distinct (e #>> '{}')::integer order by (e #>> '{}')::integer desc), '{}'::integer[]) into r
      from jsonb_array_elements(v -> 'reminder_days') e
     where jsonb_typeof(e) = 'number' and (e #>> '{}') ~ '^[0-9]{1,2}$' and (e #>> '{}')::integer between 0 and 60;
    r := r[1:5];
  else r := array[3, 1]; end if;
  return jsonb_build_object(
    'enabled', coalesce(case when jsonb_typeof(v -> 'enabled') = 'boolean' then (v ->> 'enabled')::boolean end, true),
    'default_days', d,
    'reminder_days', to_jsonb(coalesce(r, '{}'::integer[])),
    'auto_lock', coalesce(case when jsonb_typeof(v -> 'auto_lock') = 'boolean' then (v ->> 'auto_lock')::boolean end, true),
    'allow_override', coalesce(case when jsonb_typeof(v -> 'allow_override') = 'boolean' then (v ->> 'allow_override')::boolean end, true),
    'client_reminders', coalesce(case when jsonb_typeof(v -> 'client_reminders') = 'boolean' then (v ->> 'client_reminders')::boolean end, false),
    'studio_reminders', coalesce(case when jsonb_typeof(v -> 'studio_reminders') = 'boolean' then (v ->> 'studio_reminders')::boolean end, false));
end $$;

create or replace function public._r24_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r24-automation-0269 + r25-automations-0274: the studio's settings, or the defaults (everything OFF)
  select coalesce((select jsonb_build_object('runsheet_enabled', s.runsheet_enabled, 'runsheet_offsets', to_jsonb(s.runsheet_offsets),
                     'runsheet_email', s.runsheet_email, 'runsheet_whatsapp', s.runsheet_whatsapp,
                     'enquiry_enabled', s.enquiry_enabled, 'enquiry_reply', s.enquiry_reply, 'enquiry_reply_text', s.enquiry_reply_text,
                     'enquiry_notify', s.enquiry_notify, 'event_reminders_enabled', s.event_reminders_enabled,
                     'vendor_reminders_enabled', s.vendor_reminders_enabled, 'assign_whatsapp_enabled', s.assign_whatsapp_enabled,
                     'updated_at', s.updated_at)
                     from public.automation_settings s where s.org_id = p_org),
                  jsonb_build_object('runsheet_enabled', false, 'runsheet_offsets', to_jsonb(array[15, 0]), 'runsheet_email', true,
                     'runsheet_whatsapp', true, 'enquiry_enabled', false, 'enquiry_reply', true, 'enquiry_reply_text', null,
                     'enquiry_notify', true, 'event_reminders_enabled', false, 'vendor_reminders_enabled', false,
                     'assign_whatsapp_enabled', false, 'updated_at', null));
$$;

-- 0266 inbox settings (studio without a row = the defaults: inbox e-mails OFF, default "No e-mails")
create or replace function public._r25_inbox_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r25-automations-0274 (the 0266 _r23_cfg body, defaults OFF)
  select jsonb_build_object(
    'email_enabled', coalesce(s.email_enabled, false),
    'digest_default', coalesce(s.digest_default, 'off'),
    'digest_hour', coalesce(s.digest_hour, 8),
    'digest_min_age_minutes', coalesce(s.digest_min_age_minutes, 60),
    'bell_open_marks_read', coalesce(s.bell_open_marks_read, false),
    'timezone', coalesce((select o.timezone from public.organizations o where o.id = p_org), 'Asia/Kolkata'),
    'saved', s.org_id is not null)
  from (select 1) one left join public.inbox_settings s on s.org_id = p_org;
$$;

-- 0265 crew settings (defaults filled in, every value type / range checked; open-shift WhatsApp notices OFF)
create or replace function public._r25_crew_cfg(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r25-automations-0274 (the 0265 _r23_cfg body, notifyShifts default OFF)
declare v jsonb; d jsonb := jsonb_build_object(
  'availability', true, 'openShifts', true, 'claimMode', 'first_come', 'notifyShifts', false,
  'selfCheckin', true, 'geofence', false, 'geofenceRadiusM', 300, 'lateGraceMin', 15, 'noShowAfterMin', 60,
  'payBasis', 'day', 'dayHours', 8);
  k text; n numeric;
begin
  select c.value into v from public.app_config c where c.org_id = p_org and c.key = 'crew';
  if v is null or jsonb_typeof(v) <> 'object' then return d; end if;
  foreach k in array array['availability', 'openShifts', 'notifyShifts', 'selfCheckin', 'geofence'] loop
    if jsonb_typeof(v -> k) = 'boolean' then d := d || jsonb_build_object(k, v -> k); end if;
  end loop;
  if v ->> 'claimMode' in ('first_come', 'approval') then d := d || jsonb_build_object('claimMode', v ->> 'claimMode'); end if;
  if v ->> 'payBasis' in ('day', 'hours') then d := d || jsonb_build_object('payBasis', v ->> 'payBasis'); end if;
  if jsonb_typeof(v -> 'geofenceRadiusM') = 'number' then n := (v ->> 'geofenceRadiusM')::numeric;
    if n between 50 and 5000 then d := d || jsonb_build_object('geofenceRadiusM', round(n)); end if; end if;
  if jsonb_typeof(v -> 'lateGraceMin') = 'number' then n := (v ->> 'lateGraceMin')::numeric;
    if n between 0 and 240 then d := d || jsonb_build_object('lateGraceMin', round(n)); end if; end if;
  if jsonb_typeof(v -> 'noShowAfterMin') = 'number' then n := (v ->> 'noShowAfterMin')::numeric;
    if n between 15 and 720 then d := d || jsonb_build_object('noShowAfterMin', round(n)); end if; end if;
  if jsonb_typeof(v -> 'dayHours') = 'number' then n := (v ->> 'dayHours')::numeric;
    if n between 1 and 24 then d := d || jsonb_build_object('dayHours', round(n, 1)); end if; end if;
  return d;
end $$;

-- the shared name both 0265 and 0266 used: both answers (the key sets never overlap)
create or replace function public._r23_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r25-automations-0274: inbox (0266) + crew (0265) settings in one answer
  select public._r25_inbox_cfg(p_org) || public._r25_crew_cfg(p_org);
$$;

-- ---- 6) one answer: is this automation switched on for this studio? (default OFF) --------------------------------
create or replace function public._auto274_on(p_org uuid, p_key text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r25-automations-0274
declare v boolean; j jsonb;
begin
  if p_org is null or p_key is null then return false; end if;
  case p_key
    when 'pay_reminders' then select s.pay_enabled into v from public.comms_settings s where s.org_id = p_org;
    when 'client_followups' then select s.fu_enabled into v from public.comms_settings s where s.org_id = p_org;
    when 'low_stock' then select s.low_stock_enabled into v from public.comms_settings s where s.org_id = p_org;
    when 'wa_forward' then select s.wa_forward_enabled into v from public.comms_settings s where s.org_id = p_org;
    when 'viewed_alert' then select s.followup_enabled into v from public.client_view_settings s where s.org_id = p_org;
    when 'quote_expiry_client', 'quote_expiry_team' then
      select c.value into j from public.app_config c where c.org_id = p_org and c.key = 'quote_validity';
      j := j -> (case p_key when 'quote_expiry_client' then 'client_reminders' else 'studio_reminders' end);
      v := case when jsonb_typeof(j) = 'boolean' then (j #>> '{}')::boolean end;
    when 'overdue_bell' then select s.overdue_bell into v from public.payment_schedule_settings s where s.org_id = p_org;
    when 'auto_schedule' then
      select s.auto_apply into v from public.payment_schedule_settings s where s.org_id = p_org;
      return coalesce(v, true);   -- sends nothing; keeps its 0264 default
    when 'runsheet' then select s.runsheet_enabled into v from public.automation_settings s where s.org_id = p_org;
    when 'enquiry' then select s.enquiry_enabled into v from public.automation_settings s where s.org_id = p_org;
    when 'event_reminders' then select s.event_reminders_enabled into v from public.automation_settings s where s.org_id = p_org;
    when 'vendor_reminders' then select s.vendor_reminders_enabled into v from public.automation_settings s where s.org_id = p_org;
    when 'assign_whatsapp' then select s.assign_whatsapp_enabled into v from public.automation_settings s where s.org_id = p_org;
    when 'crew_shifts' then
      select c.value -> 'notifyShifts' into j from public.app_config c where c.org_id = p_org and c.key = 'crew';
      v := case when jsonb_typeof(j) = 'boolean' then (j #>> '{}')::boolean end;
    when 'delivery' then select s.enabled into v from public.delivery_settings s where s.org_id = p_org;
    when 'inbox_email' then select s.email_enabled into v from public.inbox_settings s where s.org_id = p_org;
    else return false;
  end case;
  return coalesce(v, false);
end $$;

-- ---- 7) gates: the ledger row a tick writes first is not written while the automation is off ------------------------
create or replace function public.tg_auto274_gate()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r25-automations-0274: BEFORE INSERT; no row = the tick sends nothing for this studio (tg_argv[0] = the automation)
begin
  if tg_table_name = 'vendor_request_sends' then
    if coalesce(to_jsonb(new) ->> 'kind', '') <> 'reminder' then return new; end if;   -- a request sent by hand
  end if;
  if public._auto274_on(new.org_id, tg_argv[0]) then return new; end if;
  return null;
end $$;

do $$
declare t record;
begin
  for t in select * from (values ('event_reminders', 'event_reminders'), ('runsheet_reminder_sends', 'runsheet'),
                                 ('payment_overdue_alerts', 'overdue_bell'), ('vendor_request_sends', 'vendor_reminders')) x(tab, k) loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t.tab)::regclass and tgname = 'a274_gate') then
      execute format('create trigger a274_gate before insert on public.%I for each row execute function public.tg_auto274_gate(%L)', t.tab, t.k);
    end if;
  end loop;
end $$;

-- "you've been assigned" WhatsApp (0132): only while the studio switched it on
do $$ begin
  if to_regprocedure('public._assign132_enqueue__pre0274(uuid,uuid,text,uuid,text,text,text,text,text)') is null
     and position('r25-automations-0274' in coalesce((select prosrc from pg_proc
           where oid = to_regprocedure('public._assign132_enqueue(uuid,uuid,text,uuid,text,text,text,text,text)')), '')) = 0 then
    alter function public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text) rename to _assign132_enqueue__pre0274;
  end if;
  if to_regprocedure('public._assign132_enqueue__pre0274(uuid,uuid,text,uuid,text,text,text,text,text)') is null then
    raise exception '0274: _assign132_enqueue__pre0274 missing after rename'; end if;
end $$;
create or replace function public._assign132_enqueue(p_org uuid, p_quote uuid, p_kind text, p_item uuid,
  p_phone text, p_name text, p_activity text, p_when text, p_location text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r25-automations-0274: queued only while "Tell staff when they are assigned work" is on (the 0132 body is *__pre0274)
begin
  if not public._auto274_on(p_org, 'assign_whatsapp') then return false; end if;
  return public._assign132_enqueue__pre0274(p_org, p_quote, p_kind, p_item, p_phone, p_name, p_activity, p_when, p_location);
end $$;
do $$
declare f text;
begin
  foreach f in array array['public._assign132_enqueue(uuid, uuid, text, uuid, text, text, text, text, text)',
                           'public._assign132_enqueue__pre0274(uuid, uuid, text, uuid, text, text, text, text, text)',
                           'public._auto274_on(uuid, text)', 'public._r25_inbox_cfg(uuid)', 'public._r25_crew_cfg(uuid)',
                           'public._r23_cfg(uuid)', 'public._comms_cfg(uuid)', 'public._lv261_cfg(uuid)', 'public._qv262_cfg(uuid)',
                           'public._r24_cfg(uuid)', 'public.tg_auto274_gate()'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || f || ' from authenticated'; end if;
  end loop;
end $$;

-- ---- 8) Control Center -> Automations: one list, one switch each ------------------------------------------------------
create or replace function public.automation_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r25-automations-0274: Control Center VIEW reads; every automation with its on / off (default off) and a few details
declare v_org uuid := public.current_org_id(); c jsonb; q jsonb; k text; v_list jsonb := '{}'::jsonb; d jsonb;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  foreach k in array array['pay_reminders', 'client_followups', 'quote_expiry_client', 'enquiry', 'viewed_alert', 'quote_expiry_team',
                           'overdue_bell', 'low_stock', 'event_reminders', 'inbox_email', 'wa_forward', 'vendor_reminders', 'delivery',
                           'runsheet', 'assign_whatsapp', 'crew_shifts', 'auto_schedule'] loop
    v_list := v_list || jsonb_build_object(k, public._auto274_on(v_org, k));
  end loop;
  c := public._comms_cfg(v_org);
  q := public._qv262_cfg(v_org);
  select jsonb_build_object('offsets', to_jsonb(s.offsets)) into d from public.delivery_settings s where s.org_id = v_org;
  return jsonb_build_object(
    'on', v_list,
    'can_edit', public.has_area('controls', 'edit') and coalesce(public.user_role(), '') <> 'client'
                and not coalesce(public._trial_locked(v_org), false),
    'trial_no_send', coalesce(public._tb179_no_send(v_org), false),
    'details', jsonb_build_object(
      'pay', jsonb_build_object('before_days', c -> 'pay_before_days', 'on_due', c -> 'pay_on_due', 'every_days', c -> 'pay_every_days',
                                'max_overdue', c -> 'pay_max_overdue', 'channels', c -> 'pay_channels'),
      'followups', jsonb_build_object('delay_days', c -> 'fu_delay_days', 'max', c -> 'fu_max', 'channels', c -> 'fu_channels'),
      'studio_whatsapp', (c ->> 'studio_whatsapp') is not null,
      'quote_validity', jsonb_build_object('enabled', q -> 'enabled', 'reminder_days', q -> 'reminder_days'),
      'viewed_days', public._lv261_cfg(v_org) -> 'followup_days',
      'event_days', (select coalesce(o.event_reminder_days, 7) from public.organizations o where o.id = v_org),
      'runsheet_offsets', public._r24_cfg(v_org) -> 'runsheet_offsets',
      'inbox', (select jsonb_build_object('digest_default', x -> 'digest_default', 'digest_hour', x -> 'digest_hour')
                  from (select public._r25_inbox_cfg(v_org) as x) y),
      'delivery_offsets', coalesce(d -> 'offsets', '[60, 30, 0]'::jsonb),
      'public_slug', (select o.public_slug from public.organizations o where o.id = v_org)));
end $$;

create or replace function public.automation_switch(p_key text, p_on boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r25-automations-0274: Control Center EDIT only; one automation on / off, written where its settings already live
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_old boolean; v_patch jsonb;
begin
  if v_me is null or v_org is null or coalesce(public.user_role(), '') = 'client' or not public.has_area('controls', 'edit') then
    raise exception 'Only a studio admin (or someone allowed to edit Control Center) can switch automations on or off.' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_on is null then raise exception 'Choose on or off.' using errcode = '22023'; end if;
  if p_key is null or p_key not in ('pay_reminders', 'client_followups', 'quote_expiry_client', 'enquiry', 'viewed_alert', 'quote_expiry_team',
        'overdue_bell', 'low_stock', 'event_reminders', 'inbox_email', 'wa_forward', 'vendor_reminders', 'delivery', 'runsheet',
        'assign_whatsapp', 'crew_shifts', 'auto_schedule') then
    raise exception 'unknown automation' using errcode = '22023'; end if;
  v_old := public._auto274_on(v_org, p_key);
  if p_key in ('pay_reminders', 'client_followups', 'low_stock', 'wa_forward') then
    if p_key = 'wa_forward' and p_on
       and (select s.studio_whatsapp from public.comms_settings s where s.org_id = v_org) is null then
      raise exception 'Add your studio WhatsApp number first (Control Center -> Reminders & client messages).' using errcode = '22023'; end if;
    insert into public.comms_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
    update public.comms_settings s set
      pay_enabled        = case when p_key = 'pay_reminders' then p_on else s.pay_enabled end,
      pay_channels       = case when p_key = 'pay_reminders' and p_on and cardinality(s.pay_channels) = 0 then array['email']::text[] else s.pay_channels end,
      fu_enabled         = case when p_key = 'client_followups' then p_on else s.fu_enabled end,
      fu_channels        = case when p_key = 'client_followups' and p_on and cardinality(s.fu_channels) = 0 then array['email']::text[] else s.fu_channels end,
      low_stock_enabled  = case when p_key = 'low_stock' then p_on else s.low_stock_enabled end,
      wa_forward_enabled = case when p_key = 'wa_forward' then p_on else s.wa_forward_enabled end,
      updated_at = now(), updated_by = v_me
     where s.org_id = v_org;
  elsif p_key = 'viewed_alert' then
    insert into public.client_view_settings(org_id, updated_by, updated_at) values (v_org, v_me, now()) on conflict (org_id) do nothing;
    update public.client_view_settings set followup_enabled = p_on, updated_by = v_me, updated_at = now() where org_id = v_org;
  elsif p_key in ('quote_expiry_client', 'quote_expiry_team', 'crew_shifts') then
    v_patch := jsonb_build_object(case p_key when 'quote_expiry_client' then 'client_reminders' when 'quote_expiry_team' then 'studio_reminders'
                                             else 'notifyShifts' end, p_on);
    insert into public.app_config(org_id, key, value, updated_at)
      values (v_org, case when p_key = 'crew_shifts' then 'crew' else 'quote_validity' end, v_patch, now())
    on conflict (org_id, key) do update
      set value = (case when jsonb_typeof(public.app_config.value) = 'object' then public.app_config.value else '{}'::jsonb end) || v_patch,
          updated_at = now();
  elsif p_key in ('overdue_bell', 'auto_schedule') then
    insert into public.payment_schedule_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
    update public.payment_schedule_settings s set
      overdue_bell = case when p_key = 'overdue_bell' then p_on else s.overdue_bell end,
      auto_apply   = case when p_key = 'auto_schedule' then p_on else s.auto_apply end,
      updated_at = now(), updated_by = v_me
     where s.org_id = v_org;
  elsif p_key in ('runsheet', 'enquiry', 'event_reminders', 'vendor_reminders', 'assign_whatsapp') then
    insert into public.automation_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
    update public.automation_settings s set
      runsheet_enabled         = case when p_key = 'runsheet' then p_on else s.runsheet_enabled end,
      enquiry_enabled          = case when p_key = 'enquiry' then p_on else s.enquiry_enabled end,
      event_reminders_enabled  = case when p_key = 'event_reminders' then p_on else s.event_reminders_enabled end,
      vendor_reminders_enabled = case when p_key = 'vendor_reminders' then p_on else s.vendor_reminders_enabled end,
      assign_whatsapp_enabled  = case when p_key = 'assign_whatsapp' then p_on else s.assign_whatsapp_enabled end,
      updated_at = now(), updated_by = v_me
     where s.org_id = v_org;
  elsif p_key = 'delivery' then
    insert into public.delivery_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
    update public.delivery_settings set enabled = p_on, updated_at = now(), updated_by = v_me where org_id = v_org;
  elsif p_key = 'inbox_email' then
    -- on: inbox e-mails on, and a studio default of "No e-mails" becomes the daily digest (else switching on does nothing)
    insert into public.inbox_settings(org_id, updated_by) values (v_org, v_me) on conflict (org_id) do nothing;
    update public.inbox_settings s set email_enabled = p_on,
      digest_default = case when p_on and s.digest_default = 'off' then 'daily' else s.digest_default end,
      updated_by = v_me, updated_at = now()
     where s.org_id = v_org;
  end if;
  begin
    insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
      values (v_me, 'automation.switch', 'automation', p_key, jsonb_build_object('key', p_key, 'from', v_old, 'to', p_on), v_org);
  exception when others then raise warning 'r25-automations-0274: audit skipped (%)', sqlstate;
  end;
  return public.automation_overview();
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.automation_overview()', 'public.automation_switch(text, boolean)'] loop
    execute 'revoke all on function ' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || f || ' to authenticated'; end if;
  end loop;
end $$;

-- ---- 9) messages already waiting for an automation that is now off: 'skipped' (status only, nothing deleted) ---------
-- Hand-sent messages are never touched: "Send reminder now" (payload manual), "Send a nudge" (payload r23 = nudge),
-- a vendor request itself (kind request). Re-running this only skips rows of automations that are STILL off.
update public.comms_outbox c set status = 'skipped'
 where c.status = 'pending' and c.sent_at is null
   and ((c.purpose = 'pay_reminder' and not coalesce((c.payload ->> 'manual')::boolean, false) and not public._auto274_on(c.org_id, 'pay_reminders'))
     or (c.purpose = 'follow_up' and coalesce(c.payload ->> 'r23', '') <> 'nudge' and not public._auto274_on(c.org_id, 'client_followups'))
     or (c.purpose = 'quote_expiry' and not public._auto274_on(c.org_id, 'quote_expiry_client'))
     or (c.purpose = 'wa_forward' and not public._auto274_on(c.org_id, 'wa_forward')));
update public.helm_notice_outbox h set status = 'skipped'
 where h.kind = 'inbox_digest' and h.status = 'pending' and h.sent_at is null
   and not public._auto274_on(h.org_id, 'inbox_email');
update public.runsheet_reminder_sends r set status = 'skipped', reason = 'automation_off'
 where r.status = 'pending' and r.sent_at is null and not public._auto274_on(r.org_id, 'runsheet');
update public.assign_notify_outbox a set status = 'skipped'
 where a.status = 'pending' and a.sent_at is null
   and ((a.item_kind = 'open_shift' and not public._auto274_on(a.org_id, 'crew_shifts'))
     or (a.item_kind in ('runsheet', 'task') and not public._auto274_on(a.org_id, 'runsheet')
         and not public._auto274_on(a.org_id, 'assign_whatsapp')));
update public.vendor_request_sends v set status = 'skipped', reason = 'automation_off'
 where v.kind = 'reminder' and v.status = 'pending' and v.sent_at is null and not public._auto274_on(v.org_id, 'vendor_reminders');

notify pgrst, 'reload schema';
