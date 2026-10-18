-- APPLY-0184.sql - paste into the Supabase SQL editor (staging first, then production).
-- Free-trial data retention (owner post-trial policy items 2, 3, 9).
-- What it does: one "upgrade" reminder 7 days after a free trial ended (the day 5 / 7 / 8 reminders are
-- unchanged); an owner switch public.helm_trial_retention whose deletion part is OFF (delete_enabled = false);
-- the deletion schedule, the 30 / 7 / 1 day deletion warnings and the deletion job, which all do NOTHING
-- until you switch deletion on; a read-only dry-run report.
-- What it touches: 4 NEW tables (RLS on, no app access), new functions, the venue / studio-template
-- "never deleted" guard functions (same refusal, plus an exception that only the switched-on purge can use),
-- 2 pg_cron jobs when pg_cron is installed. No existing row is changed or deleted by this file.
-- Additive + idempotent. Safe to run twice.
--
-- Read-only report after applying:   select jsonb_pretty(public.trial_retention_dry_run(null, false));
--                         one studio: select jsonb_pretty(public.trial_retention_dry_run('<studio id>'::uuid, true));
-- Switch deletion on LATER (owner decision, after reading the report and redeploying comms-dispatch):
--   update public.helm_trial_retention set delete_enabled = true where id;
-- Keep one studio out of deletion: select public.trial_retention_set_hold('<studio id>'::uuid, true, 'reason');
begin;
-- ============================================================================
-- 0184_trial_retention.sql - CANONICAL forward-only. Free-trial data retention after the trial ends
-- (owner post-trial policy, docs/trial/POST-TRIAL-POLICY.md, items 2, 3 and 9).
-- REQUIRES 0045 (studio_subscriptions, subscription_payments), 0058 (_trial_paid), 0085 (venue
--          no-delete guard), 0096 (studio_layout_templates no-delete guard), 0116 (_trial_locked,
--          organizations.trial_ends_at), 0120 (trial_reminders d5 / d7 / d8 + comms-dispatch claim),
--          0166 (organizations.is_sample_master, helm_sample_template).
--
-- In plain words:
--   * "Expired free trial" = the studio's Helm subscription is still 'trial' or 'past_due' (the
--     subscription status, never organizations.trial_ends_at alone), it was a trial
--     (studio_subscriptions.trial_ends_at set), it NEVER paid (no subscription_payments row at all,
--     no paid period, no checkout subscription), it is not the sample master, and the 0116
--     read-only trial lock is on. Paid studios never match. _trial_retention_block() says why not.
--   * Reminders (item 9): 3 days before / 1 day before / the expiry day stay the 0120 d5 / d7 / d8
--     mails. NEW: one "upgrade" reminder 7 days after the trial ended (kind x7).
--   * Retention (item 2): trial data is kept for helm_trial_retention.retention_days (60) days after
--     the trial's last day and then permanently deleted - ONLY while the owner switch
--     helm_trial_retention.delete_enabled is on. It is OFF here. While it is off nothing is
--     scheduled, no deletion warning is sent and nothing is ever deleted.
--   * When the switch is on, trial_retention_tick() (hourly) gives each expired trial a deletion date
--     (trial_retention_schedule.delete_on) = last trial day + 60, but never sooner than 30 days after
--     the date was first set, so every studio gets all three warnings. The date only ever moves
--     LATER (a longer retention or a missed final notice), never earlier.
--   * Deletion warnings (item 3): 30, 7 and 1 day before delete_on (kinds del30 / del7 / del1), as
--     a bell row for the studio admins + an e-mail to the studio owner: "Your trial data is scheduled
--     for permanent deletion on DD/MM/YYYY. Upgrade now to retain access and continue using your
--     studio." A missed day sends the current warning late; a missed (or 14+ days old) FINAL notice
--     moves the deletion to the next day with a fresh final notice. E-mails go out through comms-dispatch (trial_retention_email_claim, service
--     role only, re-checked at send time) and stay dormant until it is redeployed.
--   * trial_retention_purge_due() (daily, 03:43 India time) does nothing while the switch is off.
--     When on, it deletes a studio's trial data only when ALL hold: still an expired never-paid
--     trial (re-checked under a row lock), schedule 'scheduled' and due, the final notice was
--     recorded 20 hours to 14 days earlier, at least one deletion warning e-mail was actually sent
--     (require_email_notice, default on), and no row of ANOTHER studio links to the rows being
--     deleted. What is deleted: the studio's business rows (_tr184_purge_tables: events/quotes and
--     everything under them, leads, clients, inventory, vendors, staff, venues, menus, layouts,
--     templates, chat, notifications, ...) and the audit-log copies of those rows. What is KEPT: the
--     studio row itself, member logins + profiles, the subscription, billing, consent and security
--     records, settings and opt-outs (_tr184_keep_tables). Uploaded files in Storage are NOT removed
--     by SQL (counted in the report). Each purge runs in its own sub-transaction: any error rolls
--     that studio back completely and is recorded (3 failures -> status 'failed', left alone).
--     Every purge writes a trial_retention_runs row and an audit_log row (counts only, no content).
--   * trial_retention_dry_run(org, with_counts) is the read-only report: who is eligible, why not,
--     dates, notices, what would be deleted / kept, and why a due studio is still waiting.
--   * trial_retention_set_hold(org, true/false, reason): keep one studio out of deletion.
--   * The venue / studio-template "never deleted" guards keep refusing every delete except inside
--     this purge (transaction-local flag + the schedule row of that studio in state 'purging').
--
-- ZERO DATA LOSS: additive + idempotent. New tables (RLS on, no app grants), new functions, two
-- guard functions re-issued with one narrow purge exception, cron jobs only when pg_cron exists.
-- No DROP, no TRUNCATE, no existing row changed or deleted by this file. The only DELETE statements
-- live inside _trial_retention_purge_org(), which refuses to run while delete_enabled is false
-- (the default). The 0120 d5 / d7 / d8 reminders and their claim are unchanged. ASCII only.
-- Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public._trial_paid(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0184: apply 0058 + 0116 (trial helpers) first'; end if;
  if to_regclass('public.trial_reminders') is null or to_regprocedure('public.trial_reminder_email_claim(integer)') is null then
    raise exception '0184: apply 0120 (trial reminders) first'; end if;
  if to_regclass('public.studio_subscriptions') is null or to_regclass('public.subscription_payments') is null then
    raise exception '0184: apply 0045 (subscriptions) first'; end if;
  if to_regclass('public.helm_sample_template') is null or not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0184: apply 0166 (sample master) first'; end if;
  if to_regprocedure('public._a85_tg_venue_no_delete()') is null or to_regprocedure('public._a96_tg_no_delete()') is null then
    raise exception '0184: apply 0085 + 0096 (no-delete guards) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'notifications' and column_name = 'org_id') then
    raise exception '0184: notifications.org_id is missing'; end if;
end $$;

-- ---- 1) the owner switch (one row; deletion OFF) ---------------------------------------------------
create table if not exists public.helm_trial_retention (
  id                   boolean primary key default true check (id),
  retention_days       integer not null default 60 check (retention_days between 30 and 3650),
  delete_enabled       boolean not null default false,
  require_email_notice boolean not null default true,
  max_deletes_per_run  integer not null default 5 check (max_deletes_per_run between 1 and 100),
  notes                text check (notes is null or char_length(notes) <= 2000),
  updated_at           timestamptz not null default now(),
  updated_by           uuid
);
insert into public.helm_trial_retention(id) values (true) on conflict (id) do nothing;
alter table public.helm_trial_retention enable row level security;
revoke all on table public.helm_trial_retention from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.helm_trial_retention from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.helm_trial_retention from authenticated'; end if;
  -- read-only for the service role too: the switch is flipped by the owner in the SQL editor only
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on table public.helm_trial_retention from service_role';
    execute 'grant select on table public.helm_trial_retention to service_role';
  end if;
end $$;

-- every change of the switch leaves an audit row (who / when / old -> new)
create or replace function public._tr184_settings_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-retention-0184
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (auth.uid(), case when auth.uid() is null then 'helm:maintenance' end, 'trial.retention_settings',
            'helm_trial_retention', 'settings',
            jsonb_build_object('delete_enabled', jsonb_build_array(old.delete_enabled, new.delete_enabled),
                               'retention_days', jsonb_build_array(old.retention_days, new.retention_days),
                               'require_email_notice', jsonb_build_array(old.require_email_notice, new.require_email_notice),
                               'max_deletes_per_run', jsonb_build_array(old.max_deletes_per_run, new.max_deletes_per_run)),
            null, now());
  return new;
end $$;
drop trigger if exists tr184_settings_audit on public.helm_trial_retention;
create trigger tr184_settings_audit before update on public.helm_trial_retention
  for each row execute function public._tr184_settings_audit();

-- ---- 2) per-studio schedule, notices (ledger + e-mail outbox), run log -----------------------------
create table if not exists public.trial_retention_schedule (
  org_id      uuid primary key references public.organizations(id) on delete cascade,
  status      text not null default 'scheduled'
              check (status in ('scheduled', 'purging', 'deleted', 'cancelled', 'held', 'failed')),
  expired_at  timestamptz,
  delete_on   date,
  timezone    text not null default 'Asia/Kolkata' check (char_length(timezone) <= 64),
  armed_at    timestamptz not null default now(),
  failures    integer not null default 0,
  last_error  text check (last_error is null or char_length(last_error) <= 400),
  hold_reason text check (hold_reason is null or char_length(hold_reason) <= 500),
  deleted_at  timestamptz,
  updated_at  timestamptz not null default now(),
  check (status not in ('scheduled', 'purging') or (expired_at is not null and delete_on is not null))
);
create index if not exists trial_retention_schedule_due184 on public.trial_retention_schedule(delete_on) where status = 'scheduled';

create table if not exists public.trial_retention_notices (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  kind             text not null check (kind in ('x7', 'del30', 'del7', 'del1')),
  expired_at       timestamptz not null,
  delete_on        date,
  dedupe_key       text not null check (char_length(dedupe_key) <= 200),
  email_status     text not null default 'pending' check (email_status in ('pending', 'sent', 'skipped', 'failed')),
  email_attempts   integer not null default 0,
  email_claimed_at timestamptz,
  email_sent_at    timestamptz,
  created_at       timestamptz not null default now(),
  check (kind = 'x7' or delete_on is not null)
);
create unique index if not exists trial_retention_notices_dedupe184 on public.trial_retention_notices(dedupe_key);
create index if not exists trial_retention_notices_pending184 on public.trial_retention_notices(created_at) where email_sent_at is null;
create index if not exists trial_retention_notices_org184 on public.trial_retention_notices(org_id, kind);

create table if not exists public.trial_retention_runs (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null,      -- no FK on purpose: this record outlives everything else
  action     text not null check (action in ('purge', 'purge_failed', 'hold', 'release')),
  ok         boolean not null,
  delete_on  date,
  counts     jsonb not null default '{}'::jsonb,
  error      text check (error is null or char_length(error) <= 400),
  created_at timestamptz not null default now()
);
create index if not exists trial_retention_runs_org184 on public.trial_retention_runs(org_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['trial_retention_schedule', 'trial_retention_notices', 'trial_retention_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('revoke all on table public.%I from service_role', t);
      execute format('grant select on table public.%I to service_role', t);
    end if;
  end loop;
end $$;
-- no policies: only the SECURITY DEFINER functions below (and the service role, read-only) touch these.
-- Studio tables carry the 0045 suspended / ended-trial read-only guard (it only ever acts on app roles).
do $$ declare t text; begin
  if to_regprocedure('public.tg_studio_read_only()') is not null then
    foreach t in array array['trial_retention_schedule', 'trial_retention_notices', 'trial_retention_runs'] loop
      if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
        execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I '
                       'for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
      end if;
    end loop;
  end if;
end $$;

-- ---- 3) helpers ----------------------------------------------------------------------------------
create or replace function public._tr184_settings()
returns public.helm_trial_retention language plpgsql stable security definer set search_path = '' as $$
-- trial-retention-0184: the switch row (defaults = deletion off when the row is missing)
declare r public.helm_trial_retention;
begin
  select * into r from public.helm_trial_retention x where x.id;
  if not found then
    r.id := true; r.retention_days := 60; r.delete_enabled := false; r.require_email_notice := true; r.max_deletes_per_run := 5;
  end if;
  return r;
end $$;

create or replace function public._tr184_tz(p_tz text)
returns text language plpgsql stable set search_path = '' as $$
-- trial-retention-0184: a usable zone name, else Asia/Kolkata (the free trial is India only)
declare v text := coalesce(nullif(btrim(p_tz), ''), 'Asia/Kolkata'); d date;
begin
  begin d := (now() at time zone v)::date; return v;
  exception when others then return 'Asia/Kolkata'; end;
end $$;

create or replace function public._tr184_local_date(p_ts timestamptz, p_tz text)
returns date language sql stable set search_path = '' as $$
  -- trial-retention-0184
  select (p_ts at time zone public._tr184_tz(p_tz))::date;
$$;

-- the moment the free trial really ended (an HQ extension of studio_subscriptions.trial_ends_at is
-- respected the same way _trial_locked respects it); null = no self-serve trial end recorded
create or replace function public._trial_expired_at(p_org uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184
  select case
           when o.trial_ends_at is null then null
           when s.trial_ends_at is not null and s.trial_ends_at > (o.trial_ends_at at time zone 'UTC')::date
             then greatest(o.trial_ends_at, ((s.trial_ends_at + 1)::timestamp at time zone 'UTC'))
           else o.trial_ends_at end
    from public.organizations o left join public.studio_subscriptions s on s.org_id = o.id
   where o.id = p_org;
$$;

-- the trial's last calendar day in the studio's zone (same rule as the 0120 d8 "ends today" day)
create or replace function public._tr184_last_day(p_org uuid, p_tz text)
returns date language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184
  select public._tr184_local_date(public._trial_expired_at(p_org) - interval '1 microsecond', p_tz);
$$;

-- NULL = an expired, never-paid free-trial studio (retention applies); otherwise the reason it does not
create or replace function public._trial_retention_block(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- trial-retention-0184: trial-ness from studio_subscriptions.status, never from trial_ends_at alone
declare o record; s record; v_master uuid; v_exp timestamptz;
begin
  if p_org is null then return 'no_studio'; end if;
  select x.id, x.is_sample_master, x.trial_ends_at into o from public.organizations x where x.id = p_org;
  if not found then return 'no_studio'; end if;
  if coalesce(o.is_sample_master, false) then return 'sample_master'; end if;
  select t.org_id into v_master from public.helm_sample_template t where t.id;
  if v_master is not null and v_master = p_org then return 'sample_master'; end if;
  select x.status, x.trial_ends_at, x.current_period_start, x.current_period_end, x.provider_subscription_id
    into s from public.studio_subscriptions x where x.org_id = p_org;
  if not found then return 'no_subscription'; end if;
  if s.status not in ('trial', 'past_due') then return 'status_' || coalesce(s.status, 'none'); end if;
  if s.trial_ends_at is null then return 'not_a_trial'; end if;
  if s.current_period_start is not null or s.current_period_end is not null then return 'had_paid_period'; end if;
  if s.provider_subscription_id is not null then return 'checkout_subscription'; end if;
  if exists (select 1 from public.subscription_payments p where p.org_id = p_org) then return 'has_payment'; end if;
  if public._trial_paid(p_org) then return 'paid'; end if;
  if o.trial_ends_at is null then return 'no_trial_end'; end if;
  v_exp := public._trial_expired_at(p_org);
  if v_exp is null or v_exp > now() or not public._trial_locked(p_org) then return 'not_expired'; end if;
  if exists (select 1 from public.trial_retention_schedule r where r.org_id = p_org and r.status = 'deleted') then
    return 'already_deleted'; end if;
  return null;
end $$;

-- the studio business tables the purge empties, parents of money rows first (order is only a
-- hint: the purge retries until nothing is left). A table that does not exist is skipped.
create or replace function public._tr184_purge_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-retention-0184
  select array[
    'quote_payments', 'payment_milestones', 'event_refunds', 'quote_consents', 'pkg_credits', 'package_selections',
    'payment_reconciliation', 'vendor_payouts', 'vendor_bills', 'expense_claims', 'event_costs', 'event_closure',
    'event_close_overrides', 'lifecycle_stage_overrides',
    'quotes',
    'quote_versions', 'quotation_versions', 'quote_otps', 'change_requests', 'client_booklet_images', 'client_booklets',
    'client_link_opens', 'design_stages', 'event_attendees', 'event_checklist', 'event_day', 'event_discovery',
    'event_files', 'event_guests', 'event_issues', 'event_media', 'event_menu_items', 'event_plan', 'event_proposal',
    'event_ratings', 'event_reminders', 'event_requirements', 'event_resources', 'event_resource_needs', 'event_sites',
    'event_stock_requests', 'task_evidence_grants', 'task_evidence', 'event_tasks', 'run_sheet_items', 'proposal_risks',
    'work_tokens', 'inventory_reservations', 'inventory_checkouts', 'inv_shortage_alerts', 'photo_renders',
    'photo_render_usage', 'pkg_otps', 'pkg_outbox', 'comms_outbox', 'assign_notify_outbox',
    'chat_reactions', 'chat_messages', 'chat_members', 'chat_conversations',
    'leads', 'lead_archive', 'nurture', 'nurture_automation', 'nurture_templates', 'layouts', 'studio_layout_templates',
    'layout_rules', 'menu_templates', 'dish_catalog', 'inventory_items', 'item_rate_cards', 'vendors', 'crew_members',
    'venues', 'coupons', 'chair_types', 'plate_types', 'checklist_templates', 'task_templates', 'custom_field_defs',
    'import_mappings', 'invitations', 'saved_views', 'user_recent_records', 'a155_wa_recipients', 'notifications'
  ]::text[];
$$;

-- tables with an org_id that the purge never empties: the account, billing, consent, security,
-- settings, opt-out and platform records (and this feature's own ledgers)
create or replace function public._tr184_keep_tables()
returns text[] language sql immutable set search_path = '' as $$
  -- trial-retention-0184
  select array[
    'profiles', 'studio_subscriptions', 'subscription_payments', 'billing_reminders', 'studio_account',
    'studio_consent_log', 'studio_payment_gate', 'audit_log', 'security_alert_events', 'security_alert_outbox',
    'invite_email_outbox', 'welcome_email_outbox', 'trial_reminders', 'trial_sample_runs', 'helm_sample_template',
    'helm_audit_0044_reverted', 'whatsapp_opt_outs', 'member_wa_optin', 'wa_proposal_optins', 'wa_proposal_audit',
    'integration_webhook_events', 'upload_scans', 'a155_admin_created', 'messaging_rate', 'app_config', 'role_access',
    'comms_settings', 'pkg_settings', 'photo_render_settings', 'privacy_pin', 'privacy_pin_attempts',
    'org_link_autoexpire', 'org_link_expiry_shelf', 'org_payment_accounts', 'org_whatsapp_accounts', 'org_slug_history',
    'notification_prefs', 'notification_mutes', 'notification_seen', 'user_dashboard_prefs',
    'trial_retention_schedule', 'trial_retention_notices', 'trial_retention_runs',
    -- trial bundle: ledgers of the sibling trial migrations (ids / fingerprints only, never purged):
    -- 0181 creation log, 0185 clean-start journal, 0186 one-trial grants + one-extension record
    'trial_create_log', 'studio_clean_start_items', 'trial_grants', 'trial_extensions'
  ]::text[];
$$;

-- every public base table that has an org_id column (read at run time)
create or replace function public._tr184_org_tables()
returns text[] language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184
  select coalesce(array_agg(c.table_name::text order by c.table_name), '{}'::text[])
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE';
$$;

-- the purge must see every row: the function owner needs BYPASSRLS (superuser / Supabase postgres)
create or replace function public._tr184_sees_all()
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184
  select coalesce((select r.rolsuper or r.rolbypassrls from pg_catalog.pg_roles r where r.rolname = current_user), false);
$$;

-- TRUE only inside _trial_retention_purge_org for that one studio (flag + 'purging' schedule row)
create or replace function public._trial_purge_allows(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184
  select p_org is not null
     and coalesce(current_setting('helm.trial_purge_org', true), '') = p_org::text
     and coalesce(auth.jwt() ->> 'role', '') not in ('anon', 'authenticated')
     and exists (select 1 from public.trial_retention_schedule t where t.org_id = p_org and t.status = 'purging');
$$;

create or replace function public._tr184_label(p_kind text, p_delete_on date)
returns text language sql immutable set search_path = '' as $$
  -- trial-retention-0184: bell text (DD/MM/YYYY, the studio's own calendar day)
  select case p_kind
    when 'x7'    then 'Your free trial ended 7 days ago - upgrade to continue'
    when 'del30' then 'Trial data will be permanently deleted on ' || to_char(p_delete_on, 'DD/MM/YYYY')
    when 'del7'  then 'Trial data will be permanently deleted on ' || to_char(p_delete_on, 'DD/MM/YYYY')
    when 'del1'  then 'Final notice: trial data will be permanently deleted on ' || to_char(p_delete_on, 'DD/MM/YYYY')
    else 'Free trial update' end;
$$;

create or replace function public._tr184_notice_key(p_org uuid, p_kind text, p_expired timestamptz, p_delete_on date)
returns text language sql immutable set search_path = '' as $$
  -- trial-retention-0184: one per studio per kind per trial end (x7) / per deletion date (warnings)
  select 'trial184:' || p_kind || ':' || p_org::text || ':' ||
         case when p_kind = 'x7' then to_char(p_expired at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI')
              else to_char(p_delete_on, 'YYYY-MM-DD') end;
$$;

-- one notice row + (only when new) one admin-only bell row (the 0058 / 0120 'trial_reminder' kind)
create or replace function public._tr184_notice(p_org uuid, p_kind text, p_expired timestamptz, p_delete_on date)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184
declare v_id uuid;
begin
  insert into public.trial_retention_notices(org_id, kind, expired_at, delete_on, dedupe_key)
    values (p_org, p_kind, p_expired, p_delete_on, public._tr184_notice_key(p_org, p_kind, p_expired, p_delete_on))
    on conflict (dedupe_key) do nothing
    returning id into v_id;
  if v_id is null then return false; end if;
  begin   -- the bell row must never block the ledger row
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'trial_reminder', 'simulated',
              jsonb_build_object('trial', 'trial_' || p_kind, 'milestone', p_kind, 'label', public._tr184_label(p_kind, p_delete_on),
                                 'expired_at', p_expired, 'delete_on', p_delete_on, 'source', '0184'),
              p_org);
  exception when others then raise warning 'trial-retention-0184: bell row skipped (%)', sqlstate;
  end;
  return true;
end $$;

-- ---- 4) the venue / studio-template no-delete guards: same refusal, one narrow purge exception -----
create or replace function public._a85_tg_venue_no_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
-- venues-0085 trial-retention-0184: venues are never deleted, except by the owner-switched trial purge
begin
  if public._trial_purge_allows(old.org_id) then return old; end if;
  raise exception 'Venues are never deleted - deactivate the venue instead.' using errcode = '42501', hint = 'venue_no_delete';
end $$;

create or replace function public._a96_tg_no_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
-- studio-templates-0096 trial-retention-0184: templates are never deleted, except by the trial purge
begin
  if public._trial_purge_allows(old.org_id) then return old; end if;
  raise exception 'Templates are never deleted - archive the template instead.' using errcode = '42501', hint = 'template_no_delete';
end $$;

-- ---- 5) the tick (pg_cron hourly / service role) -----------------------------------------------------
create or replace function public.trial_retention_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184: service role / pg_cron only. Idempotent (UNIQUE dedupe keys, one schedule per studio).
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  o record; sch public.trial_retention_schedule; v_block text; v_tz text; v_exp timestamptz;
  v_today date; v_last date; v_target date; v_left integer; v_kind text;
  n_x7 integer := 0; n_arm integer := 0; n_cancel integer := 0; n_warn integer := 0; n_moved integer := 0;
begin
  for o in
    select x.id, x.timezone from (
      -- ended trials of the last 10 days (the +7 reminder) ...
      select org.id, org.timezone from public.organizations org join public.studio_subscriptions s on s.org_id = org.id
       where org.trial_ends_at is not null and org.trial_ends_at <= now() and org.trial_ends_at > now() - interval '10 days'
         and s.status in ('trial', 'past_due')
      union
      -- ... every ended trial without a schedule, while the deletion switch is on ...
      select org.id, org.timezone from public.organizations org join public.studio_subscriptions s on s.org_id = org.id
       where cfg.delete_enabled and org.trial_ends_at is not null and org.trial_ends_at <= now()
         and s.status in ('trial', 'past_due')
         and not exists (select 1 from public.trial_retention_schedule t where t.org_id = org.id)
      union
      -- ... and every open schedule (to follow / cancel / re-arm it)
      select org.id, org.timezone from public.trial_retention_schedule t join public.organizations org on org.id = t.org_id
       where t.status in ('scheduled', 'cancelled')
    ) x
  loop
    begin
      v_block := public._trial_retention_block(o.id);
      sch := null;
      select * into sch from public.trial_retention_schedule t where t.org_id = o.id for update;
      if v_block is not null then
        -- paid / extended / converted since: the deletion is called off (re-armed later only if it ends again)
        if sch.status = 'scheduled' then
          update public.trial_retention_schedule set status = 'cancelled', updated_at = now(),
                 last_error = left('not eligible: ' || v_block, 400)
           where org_id = o.id and status = 'scheduled';
          n_cancel := n_cancel + 1;
        end if;
        continue;
      end if;
      v_tz := public._tr184_tz(o.timezone);
      v_exp := public._trial_expired_at(o.id);
      v_today := public._tr184_local_date(now(), v_tz);
      v_last := public._tr184_last_day(o.id, v_tz);

      -- (a) item 9: one upgrade reminder 7 days after the trial's last day
      if v_today - v_last = 7 then
        if public._tr184_notice(o.id, 'x7', v_exp, null) then n_x7 := n_x7 + 1; end if;
      end if;

      -- (b) items 2 + 3: deletion date + warnings, only while the owner switch is on
      if not cfg.delete_enabled then continue; end if;
      v_target := greatest(v_last + cfg.retention_days, v_today + 30);
      if sch.org_id is null then
        insert into public.trial_retention_schedule(org_id, status, expired_at, delete_on, timezone)
          values (o.id, 'scheduled', v_exp, v_target, v_tz)
          on conflict (org_id) do nothing;
        n_arm := n_arm + 1;
        select * into sch from public.trial_retention_schedule t where t.org_id = o.id for update;
      elsif sch.status = 'cancelled' then
        update public.trial_retention_schedule set status = 'scheduled', expired_at = v_exp, delete_on = v_target,
               timezone = v_tz, armed_at = now(), failures = 0, last_error = null, updated_at = now()
         where org_id = o.id and status = 'cancelled'
        returning * into sch;
        n_arm := n_arm + 1;
      end if;
      if sch.status is distinct from 'scheduled' then continue; end if;      -- held / failed / deleted
      -- follow a later trial end or a longer retention; never move the date earlier
      if sch.expired_at is distinct from v_exp or sch.delete_on < v_last + cfg.retention_days then
        update public.trial_retention_schedule
           set expired_at = v_exp, delete_on = greatest(sch.delete_on, v_last + cfg.retention_days), updated_at = now()
         where org_id = o.id
        returning * into sch;
      end if;
      v_left := sch.delete_on - v_today;
      -- the final notice was missed (or is older than 14 days, e.g. the switch was off meanwhile): never
      -- delete without a fresh one - the deletion moves to tomorrow and a new final notice goes out
      if v_left <= 0 and not exists (select 1 from public.trial_retention_notices n where n.org_id = o.id
                                        and n.kind = 'del1' and n.delete_on = sch.delete_on
                                        and n.created_at > now() - interval '14 days') then
        update public.trial_retention_schedule set delete_on = v_today + 1, updated_at = now()
         where org_id = o.id
        returning * into sch;
        v_left := 1; n_moved := n_moved + 1;
      end if;
      v_kind := case when v_left <= 1 then 'del1' when v_left <= 7 then 'del7' when v_left <= 30 then 'del30' else null end;
      if v_kind is not null then
        if public._tr184_notice(o.id, v_kind, sch.expired_at, sch.delete_on) then n_warn := n_warn + 1; end if;
      end if;
    exception when others then raise warning 'trial-retention-0184: studio skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('x7_new', n_x7, 'armed', n_arm, 'cancelled', n_cancel, 'warnings_new', n_warn,
                            'final_notice_moved', n_moved, 'delete_enabled', cfg.delete_enabled);
end $$;

-- ---- 6) e-mail claim / mark (service role; comms-dispatch, DORMANT until redeployed) -----------------
create or replace function public.trial_retention_mail_settings()
returns jsonb language sql stable security definer set search_path = '' as $$
  -- trial-retention-0184: lets the d5 / d7 / d8 copy say "kept for 60 days" only when deletion is on
  select jsonb_build_object('retention_days', (public._tr184_settings()).retention_days,
                            'delete_enabled', (public._tr184_settings()).delete_enabled);
$$;

create or replace function public.trial_retention_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184: studio owner mails (Helm system mail, never a client message)
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  r record; v_out jsonb := '[]'::jsonb; v_to text; v_ok boolean; v_del date;
  v_re constant text := '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$';
begin
  update public.trial_retention_notices set email_status = 'failed', email_sent_at = now()
   where email_sent_at is null and email_attempts >= 5;
  update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now()
   where email_sent_at is null and created_at < now() - interval '2 days';
  for r in
    select n.id, n.org_id, n.kind, n.expired_at, n.delete_on, o.name, o.business_email, o.business_email_confirmed,
           o.created_by, public._tr184_tz(o.timezone) as tz
      from public.trial_retention_notices n join public.organizations o on o.id = n.org_id
     where n.email_sent_at is null and n.email_status = 'pending'
       and (n.email_claimed_at is null or n.email_claimed_at < now() - interval '10 minutes')
     order by n.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of n skip locked
  loop
    -- re-check at send time: still an expired never-paid trial, and (warnings) the same deletion date
    v_ok := public._trial_retention_block(r.org_id) is null;
    v_del := null;
    select t.delete_on into v_del from public.trial_retention_schedule t
     where t.org_id = r.org_id and t.status = 'scheduled' and cfg.delete_enabled;
    if r.kind = 'x7' then
      v_ok := v_ok and public._trial_expired_at(r.org_id) is not distinct from r.expired_at;
    else
      v_ok := v_ok and cfg.delete_enabled and v_del is not null and v_del = r.delete_on;
    end if;
    -- the studio owner's own login e-mail; the studio business e-mail only when it was confirmed
    v_to := (select u.email from auth.users u where u.id = r.created_by);
    if coalesce(v_to, '') !~ v_re and coalesce(r.business_email_confirmed, false) then v_to := r.business_email; end if;
    if not coalesce(v_ok, false) or coalesce(v_to, '') !~ v_re then
      update public.trial_retention_notices set email_status = 'skipped', email_sent_at = now() where id = r.id;
      continue;
    end if;
    update public.trial_retention_notices set email_claimed_at = now(), email_attempts = email_attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', v_to, 'kind', r.kind,
      'studio', coalesce(r.name, ''), 'expired_at', r.expired_at,
      'delete_on', case when r.kind = 'x7' then v_del else r.delete_on end,
      'timezone', r.tz, 'retention_days', cfg.retention_days));
  end loop;
  return v_out;
end $$;

create or replace function public.trial_retention_email_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.trial_retention_notices set email_claimed_at = null where id = p_id and email_sent_at is null;
    return 'pending';
  end if;
  update public.trial_retention_notices set email_status = p_status, email_sent_at = now() where id = p_id and email_sent_at is null;
  return p_status;
end $$;

-- ---- 7) why a scheduled studio is not deleted right now (NULL = it would be, if the switch is on) ------
create or replace function public._tr184_wait_reason(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- trial-retention-0184
declare cfg public.helm_trial_retention := public._tr184_settings(); sch public.trial_retention_schedule; v_block text;
begin
  select * into sch from public.trial_retention_schedule t where t.org_id = p_org;
  if not found then return 'not_scheduled'; end if;
  if sch.status <> 'scheduled' then return 'status_' || sch.status; end if;
  v_block := public._trial_retention_block(p_org);
  if v_block is not null then return 'not_eligible_' || v_block; end if;
  if sch.delete_on > public._tr184_local_date(now(), sch.timezone) then return 'not_due'; end if;
  if not exists (select 1 from public.trial_retention_notices n where n.org_id = p_org and n.kind = 'del1'
                    and n.delete_on = sch.delete_on and n.created_at <= now() - interval '20 hours'
                    and n.created_at > now() - interval '14 days') then
    return 'final_notice_pending'; end if;
  if cfg.require_email_notice and not exists (select 1 from public.trial_retention_notices n where n.org_id = p_org
                    and n.kind in ('del30', 'del7', 'del1') and n.email_status = 'sent') then
    return 'no_warning_email_sent'; end if;
  if not public._tr184_sees_all() then return 'owner_cannot_bypass_rls'; end if;
  return null;
end $$;

-- rows of ANOTHER studio that point (foreign key) at this studio's purge rows: must be {} to purge
create or replace function public._tr184_cross_links(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-retention-0184
declare fk record; v_n bigint; v_out jsonb := '{}'::jsonb; v_org_tabs text[] := public._tr184_org_tables();
begin
  -- a multi-column foreign key into a purge table cannot be checked here: report it (blocks the purge)
  select count(*) into v_n from pg_catalog.pg_constraint c join pg_catalog.pg_class pa on pa.oid = c.confrelid
   where c.contype = 'f' and pa.relnamespace = 'public'::regnamespace
     and pa.relname::text = any(public._tr184_purge_tables()) and array_length(c.conkey, 1) > 1;
  if v_n > 0 then v_out := jsonb_build_object('multi_column_foreign_keys', v_n); end if;
  for fk in
    select ch.relname::text as child, ca.attname::text as ccol, pa.relname::text as parent, pk.attname::text as pcol
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class ch on ch.oid = c.conrelid
      join pg_catalog.pg_class pa on pa.oid = c.confrelid
      join pg_catalog.pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = c.conkey[1]
      join pg_catalog.pg_attribute pk on pk.attrelid = c.confrelid and pk.attnum = c.confkey[1]
     where c.contype = 'f' and array_length(c.conkey, 1) = 1
       and ch.relnamespace = 'public'::regnamespace and pa.relnamespace = 'public'::regnamespace
       and pa.relname::text = any(public._tr184_purge_tables())
       and ch.relname::text = any(v_org_tabs) and pa.relname::text = any(v_org_tabs)
  loop
    execute format('select count(*) from public.%I ch join public.%I pa on pa.%I = ch.%I where pa.org_id = $1 and ch.org_id <> $1',
                   fk.child, fk.parent, fk.pcol, fk.ccol) into v_n using p_org;
    if v_n > 0 then v_out := v_out || jsonb_build_object(fk.child || '.' || fk.ccol || '->' || fk.parent, v_n); end if;
  end loop;
  return v_out;
end $$;

-- ---- 8) the purge of ONE studio (only via trial_retention_purge_due; refuses while the switch is off) --
create or replace function public._trial_retention_purge_org(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184: permanent deletion of ONE expired, never-paid trial studio's business rows
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  sch public.trial_retention_schedule; v_wait text; v_cross jsonb;
  v_tabs text[] := public._tr184_purge_tables(); v_org_tabs text[] := public._tr184_org_tables();
  t text; n bigint; v_has boolean; v_before jsonb := '{}'::jsonb; v_counts jsonb := '{}'::jsonb;
  v_left integer := 0; v_blocked text; v_pass integer; v_audit bigint := 0; v_files bigint := 0;
begin
  if p_org is null then raise exception 'no studio' using errcode = '22023'; end if;
  if not cfg.delete_enabled then
    raise exception 'trial data deletion is switched off' using errcode = '42501', hint = 'trial_retention_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:trial_retention:' || p_org::text, 0));
  -- lock the subscription + studio rows: a payment / extension landing now waits, then is re-checked
  perform 1 from public.studio_subscriptions ss where ss.org_id = p_org for update;
  perform 1 from public.organizations oo where oo.id = p_org for update;
  select * into sch from public.trial_retention_schedule trs where trs.org_id = p_org for update;
  v_wait := public._tr184_wait_reason(p_org);
  if v_wait is not null then
    raise exception 'trial purge refused: %', v_wait using errcode = 'P0001', hint = 'trial_retention_not_due'; end if;
  v_cross := public._tr184_cross_links(p_org);
  if v_cross <> '{}'::jsonb then
    raise exception 'trial purge refused: rows of another studio link to this studio (%)', left(v_cross::text, 200)
      using errcode = 'P0001', hint = 'trial_retention_cross_studio'; end if;

  foreach t in array v_org_tabs loop
    execute format('select count(*) from public.%I where org_id = $1', t) into n using p_org;
    v_before := v_before || jsonb_build_object(t, n);
  end loop;

  update public.trial_retention_schedule set status = 'purging', updated_at = now() where org_id = p_org;
  perform set_config('helm.trial_purge_org', p_org::text, true);

  -- delete, retrying in later passes when a row is still referenced (cascades / archive triggers)
  for v_pass in 1..8 loop
    foreach t in array v_tabs loop
      continue when not (t = any(v_org_tabs));
      begin
        execute format('delete from public.%I where org_id = $1', t) using p_org;
      exception when foreign_key_violation or restrict_violation then v_blocked := t;
      end;
    end loop;
    v_left := 0;
    foreach t in array v_tabs loop
      continue when not (t = any(v_org_tabs));
      execute format('select exists (select 1 from public.%I where org_id = $1)', t) into v_has using p_org;
      if v_has then v_left := v_left + 1; v_blocked := t; end if;
    end loop;
    exit when v_left = 0;
  end loop;
  if v_left > 0 then
    raise exception 'trial purge incomplete: % table(s) still hold rows (e.g. %)', v_left, v_blocked
      using errcode = 'P0001', hint = 'trial_retention_incomplete'; end if;

  -- the audit trigger copied every deleted business row into audit_log: remove those copies too
  -- (billing, subscription, studio and member audit rows stay)
  delete from public.audit_log al where al.org_id = p_org and al.entity = any(v_tabs);
  get diagnostics v_audit = row_count;
  perform set_config('helm.trial_purge_org', '', true);

  foreach t in array v_org_tabs loop
    execute format('select count(*) from public.%I where org_id = $1', t) into n using p_org;
    if coalesce((v_before ->> t)::bigint, 0) - n <> 0 then
      v_counts := v_counts || jsonb_build_object(t, coalesce((v_before ->> t)::bigint, 0) - n);
    end if;
  end loop;
  if to_regclass('storage.objects') is not null then
    begin
      execute 'select count(*) from storage.objects where split_part(name, ''/'', 1) = $1' into v_files using p_org::text;
    exception when others then v_files := -1;
    end;
  end if;

  update public.trial_retention_schedule set status = 'deleted', deleted_at = now(), last_error = null, updated_at = now()
   where org_id = p_org;
  insert into public.trial_retention_runs(org_id, action, ok, delete_on, counts)
    values (p_org, 'purge', true, sch.delete_on,
            jsonb_build_object('rows', v_counts, 'audit_log_copies', v_audit, 'storage_objects_left', v_files));
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, 'helm:retention', 'trial.retention_purged', 'organizations', p_org::text,
            jsonb_build_object('delete_on', sch.delete_on, 'expired_at', sch.expired_at, 'retention_days', cfg.retention_days,
                               'rows', v_counts, 'audit_log_copies', v_audit, 'storage_objects_left', v_files),
            p_org, now());
  return jsonb_build_object('org_id', p_org, 'deleted', true, 'rows', v_counts, 'audit_log_copies', v_audit,
                            'storage_objects_left', v_files);
end $$;

-- ---- 9) the daily deletion job (pg_cron / service role). Switch off -> returns at once, touches nothing --
create or replace function public.trial_retention_purge_due(p_limit integer default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  r record; v_lim integer; n_ok integer := 0; n_fail integer := 0; n_wait integer := 0; v_msg text; v_state text;
begin
  if not cfg.delete_enabled then return jsonb_build_object('delete_enabled', false, 'deleted', 0); end if;
  v_lim := greatest(1, least(coalesce(p_limit, cfg.max_deletes_per_run), cfg.max_deletes_per_run));
  for r in
    select t.org_id, t.delete_on from public.trial_retention_schedule t
     where t.status = 'scheduled' and t.delete_on <= (now() at time zone 'UTC')::date + 1
     order by t.delete_on, t.org_id
  loop
    exit when n_ok + n_fail >= v_lim;
    if public._tr184_wait_reason(r.org_id) is not null then n_wait := n_wait + 1; continue; end if;
    begin
      perform public._trial_retention_purge_org(r.org_id);
      n_ok := n_ok + 1;
    exception when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
      n_fail := n_fail + 1;
      update public.trial_retention_schedule
         set failures = failures + 1, last_error = left(v_state || ' ' || v_msg, 400), updated_at = now(),
             status = case when failures + 1 >= 3 then 'failed' else status end
       where org_id = r.org_id and status = 'scheduled';
      insert into public.trial_retention_runs(org_id, action, ok, delete_on, error)
        values (r.org_id, 'purge_failed', false, r.delete_on, left(v_state || ' ' || v_msg, 400));
    end;
  end loop;
  return jsonb_build_object('delete_enabled', true, 'deleted', n_ok, 'failed', n_fail, 'waiting', n_wait);
end $$;

-- ---- 10) the dry-run report (read-only) -----------------------------------------------------------------
create or replace function public.trial_retention_dry_run(p_org uuid default null, p_with_counts boolean default false)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-retention-0184: who would be deleted when, and why not. Writes nothing.
declare
  cfg public.helm_trial_retention := public._tr184_settings();
  o record; sch public.trial_retention_schedule; v_block text; v_wait text; v_tz text; v_last date; v_today date;
  v_item jsonb; v_out jsonb := '[]'::jsonb; v_purge jsonb; v_keep jsonb; v_other jsonb; v_cnt jsonb; t text; n bigint;
  v_org_tabs text[] := public._tr184_org_tables(); v_files bigint; v_audit bigint;
  n_c integer := 0; n_e integer := 0; n_s integer := 0; n_due integer := 0;
begin
  for o in
    select x.id, x.name, x.timezone from public.organizations x
     where (p_org is not null and x.id = p_org)
        or (p_org is null and (exists (select 1 from public.trial_retention_schedule trs where trs.org_id = x.id)
             or (x.trial_ends_at is not null and x.trial_ends_at <= now()
                 and exists (select 1 from public.studio_subscriptions s where s.org_id = x.id and s.status in ('trial', 'past_due')))))
     order by x.trial_ends_at nulls last, x.id
  loop
    n_c := n_c + 1;
    v_block := public._trial_retention_block(o.id);
    sch := null;
    select * into sch from public.trial_retention_schedule trs where trs.org_id = o.id;
    v_tz := public._tr184_tz(coalesce(sch.timezone, o.timezone));
    v_today := public._tr184_local_date(now(), v_tz);
    v_last := case when public._trial_expired_at(o.id) is not null then public._tr184_last_day(o.id, v_tz) end;
    v_wait := case when sch.org_id is null then 'not_scheduled' else public._tr184_wait_reason(o.id) end;
    if v_block is null then n_e := n_e + 1; end if;
    if sch.status = 'scheduled' then n_s := n_s + 1; end if;
    if v_wait is null then n_due := n_due + 1; end if;
    v_item := jsonb_build_object(
      'org_id', o.id, 'name', o.name, 'eligible', v_block is null, 'block_reason', v_block,
      'expired_at', public._trial_expired_at(o.id), 'last_trial_day', v_last,
      'days_since_trial_end', case when v_last is not null then v_today - v_last end,
      'schedule_status', sch.status, 'delete_on', sch.delete_on, 'armed_at', sch.armed_at, 'failures', sch.failures,
      'last_error', sch.last_error, 'hold_reason', sch.hold_reason,
      'projected_delete_on', case when v_block is null and sch.org_id is null and v_last is not null
                                  then greatest(v_last + cfg.retention_days, v_today + 30) end,
      'wait_reason', v_wait,
      'would_delete_if_enabled', v_wait is null,
      'would_delete_now', cfg.delete_enabled and v_wait is null,
      'notices', coalesce((select jsonb_agg(jsonb_build_object('kind', trn.kind, 'delete_on', trn.delete_on, 'email', trn.email_status,
                                                               'created_at', trn.created_at) order by trn.created_at)
                             from public.trial_retention_notices trn where trn.org_id = o.id), '[]'::jsonb));
    if p_with_counts or p_org is not null then
      v_purge := '{}'::jsonb; v_keep := '{}'::jsonb; v_other := '{}'::jsonb;
      foreach t in array v_org_tabs loop
        execute format('select count(*) from public.%I where org_id = $1', t) into n using o.id;
        continue when n = 0;
        if t = any(public._tr184_purge_tables()) then v_purge := v_purge || jsonb_build_object(t, n);
        elsif t = any(public._tr184_keep_tables()) then v_keep := v_keep || jsonb_build_object(t, n);
        else v_other := v_other || jsonb_build_object(t, n); end if;
      end loop;
      select count(*) into v_audit from public.audit_log al where al.org_id = o.id and al.entity = any(public._tr184_purge_tables());
      v_files := null;
      if to_regclass('storage.objects') is not null then
        begin
          execute 'select count(*) from storage.objects where split_part(name, ''/'', 1) = $1' into v_files using o.id::text;
        exception when others then v_files := null;
        end;
      end if;
      v_item := v_item || jsonb_build_object('would_delete_rows', v_purge, 'audit_log_copies', v_audit,
        'kept_rows', v_keep, 'unclassified_rows_kept', v_other, 'storage_objects_not_deleted', v_files,
        'cross_studio_links', public._tr184_cross_links(o.id));
    end if;
    v_out := v_out || jsonb_build_array(v_item);
  end loop;
  return jsonb_build_object(
    'settings', jsonb_build_object('delete_enabled', cfg.delete_enabled, 'retention_days', cfg.retention_days,
                                   'require_email_notice', cfg.require_email_notice, 'max_deletes_per_run', cfg.max_deletes_per_run),
    'owner_can_bypass_rls', public._tr184_sees_all(),
    'unclassified_tables', coalesce((select jsonb_agg(u.tab order by u.tab) from unnest(v_org_tabs) as u(tab)
                                      where not (u.tab = any(public._tr184_purge_tables())) and not (u.tab = any(public._tr184_keep_tables()))), '[]'::jsonb),
    'summary', jsonb_build_object('studios', n_c, 'eligible', n_e, 'scheduled', n_s, 'due_now_if_enabled', n_due),
    'studios', v_out);
end $$;

-- ---- 11) keep one studio out of deletion (or release it: it is re-scheduled with >= 30 days notice) -------
create or replace function public.trial_retention_set_hold(p_org uuid, p_hold boolean, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-retention-0184
declare v_tz text; v_n integer;
begin
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:trial_retention:' || p_org::text, 0));
  if coalesce(p_hold, false) then
    select public._tr184_tz(o.timezone) into v_tz from public.organizations o where o.id = p_org;
    insert into public.trial_retention_schedule(org_id, status, expired_at, delete_on, timezone, hold_reason)
      values (p_org, 'held', public._trial_expired_at(p_org), null, v_tz, left(nullif(btrim(coalesce(p_reason, '')), ''), 500))
      on conflict (org_id) do update set status = 'held', hold_reason = excluded.hold_reason, updated_at = now()
      where public.trial_retention_schedule.status not in ('deleted', 'purging');
  else
    update public.trial_retention_schedule set status = 'cancelled', hold_reason = null, failures = 0, last_error = null,
           updated_at = now()
     where org_id = p_org and status in ('held', 'failed');
  end if;
  get diagnostics v_n = row_count;
  insert into public.trial_retention_runs(org_id, action, ok, counts)
    values (p_org, case when coalesce(p_hold, false) then 'hold' else 'release' end, v_n > 0,
            jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)));
  return jsonb_build_object('org_id', p_org, 'held', coalesce(p_hold, false), 'changed', v_n > 0,
    'status', (select t.status from public.trial_retention_schedule t where t.org_id = p_org));
end $$;

-- ---- 12) privileges: platform only (service role / pg_cron / SQL editor) ---------------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public._tr184_settings_audit()', 'public._tr184_settings()', 'public._tr184_tz(text)', 'public._tr184_local_date(timestamptz, text)',
    'public._trial_expired_at(uuid)', 'public._tr184_last_day(uuid, text)', 'public._trial_retention_block(uuid)',
    'public._tr184_purge_tables()', 'public._tr184_keep_tables()', 'public._tr184_org_tables()', 'public._tr184_sees_all()',
    'public._trial_purge_allows(uuid)', 'public._tr184_label(text, date)', 'public._tr184_notice_key(uuid, text, timestamptz, date)',
    'public._tr184_notice(uuid, text, timestamptz, date)', 'public._a85_tg_venue_no_delete()', 'public._a96_tg_no_delete()',
    'public.trial_retention_tick()', 'public.trial_retention_mail_settings()', 'public.trial_retention_email_claim(integer)',
    'public.trial_retention_email_mark(uuid, text)', 'public._tr184_wait_reason(uuid)', 'public._tr184_cross_links(uuid)',
    'public._trial_retention_purge_org(uuid)', 'public.trial_retention_purge_due(integer)',
    'public.trial_retention_dry_run(uuid, boolean)', 'public.trial_retention_set_hold(uuid, boolean, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    -- internals too: the service role only gets the seven entry points below
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('revoke all on function %s from service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.trial_retention_tick() to service_role';
    execute 'grant execute on function public.trial_retention_mail_settings() to service_role';
    execute 'grant execute on function public.trial_retention_email_claim(integer) to service_role';
    execute 'grant execute on function public.trial_retention_email_mark(uuid, text) to service_role';
    execute 'grant execute on function public.trial_retention_purge_due(integer) to service_role';
    execute 'grant execute on function public.trial_retention_dry_run(uuid, boolean) to service_role';
    execute 'grant execute on function public.trial_retention_set_hold(uuid, boolean, text) to service_role';
  end if;
end $$;

-- ---- 13) pg_cron, ONLY if it is already installed (never created here) -----------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_trial_retention') then
        perform cron.schedule('helm_trial_retention', '27 * * * *', 'select public.trial_retention_tick()');
      end if;
      -- does nothing until helm_trial_retention.delete_enabled is switched on by the owner
      if not exists (select 1 from cron.job where jobname = 'helm_trial_retention_purge') then
        perform cron.schedule('helm_trial_retention_purge', '13 22 * * *', 'select public.trial_retention_purge_due()');
      end if;
    exception when others then
      raise notice 'pg_cron present but the trial retention jobs could not be scheduled (%); schedule them by hand', sqlerrm;
    end;
  else
    raise notice '0184: pg_cron not installed - run select public.trial_retention_tick() hourly and select public.trial_retention_purge_due() daily from a service caller';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true; row 03 turns false once you switch deletion on - that is expected)
select item, ok from (values
  ('01 four new tables', to_regclass('public.helm_trial_retention') is not null and to_regclass('public.trial_retention_schedule') is not null
     and to_regclass('public.trial_retention_notices') is not null and to_regclass('public.trial_retention_runs') is not null),
  ('02 owner switch row present (60 days)', exists (select 1 from public.helm_trial_retention where id and retention_days >= 30)),
  ('03 deletion is switched OFF', not coalesce((select delete_enabled from public.helm_trial_retention where id), true)),
  ('04 row level security on the new tables', (select bool_and(relrowsecurity) from pg_class where oid in ('public.helm_trial_retention'::regclass,
     'public.trial_retention_schedule'::regclass, 'public.trial_retention_notices'::regclass, 'public.trial_retention_runs'::regclass))),
  ('05 app roles cannot read the new tables', not has_table_privilege('authenticated', 'public.helm_trial_retention', 'select')
     and not has_table_privilege('authenticated', 'public.trial_retention_schedule', 'select')
     and not has_table_privilege('authenticated', 'public.trial_retention_notices', 'select')
     and not has_table_privilege('anon', 'public.trial_retention_runs', 'select')),
  ('06 entry points are SECURITY DEFINER', (select bool_and(prosecdef) from pg_proc where oid in (
     'public.trial_retention_tick()'::regprocedure, 'public.trial_retention_email_claim(integer)'::regprocedure,
     'public.trial_retention_purge_due(integer)'::regprocedure, 'public._trial_retention_purge_org(uuid)'::regprocedure,
     'public.trial_retention_dry_run(uuid, boolean)'::regprocedure, 'public.trial_retention_set_hold(uuid, boolean, text)'::regprocedure))),
  ('07 app roles cannot run them', not has_function_privilege('authenticated', 'public.trial_retention_tick()', 'execute')
     and not has_function_privilege('authenticated', 'public.trial_retention_purge_due(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public._trial_retention_purge_org(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.trial_retention_dry_run(uuid, boolean)', 'execute')
     and not has_function_privilege('anon', 'public.trial_retention_email_claim(integer)', 'execute')
     and not has_function_privilege('anon', 'public.trial_retention_set_hold(uuid, boolean, text)', 'execute')),
  ('08 service role runs the jobs + comms-dispatch claim', has_function_privilege('service_role', 'public.trial_retention_tick()', 'execute')
     and has_function_privilege('service_role', 'public.trial_retention_email_claim(integer)', 'execute')
     and has_function_privilege('service_role', 'public.trial_retention_email_mark(uuid, text)', 'execute')
     and has_function_privilege('service_role', 'public.trial_retention_mail_settings()', 'execute')
     and has_function_privilege('service_role', 'public.trial_retention_purge_due(integer)', 'execute')),
  ('09 the single-studio purge is internal only; the switch is flipped in the SQL editor only',
     not has_function_privilege('service_role', 'public._trial_retention_purge_org(uuid)', 'execute')
     and not has_table_privilege('service_role', 'public.helm_trial_retention', 'update')),
  ('10 venue + template guards re-issued with the purge-only exception',
     position('trial-retention-0184' in (select prosrc from pg_proc where oid = 'public._a85_tg_venue_no_delete()'::regprocedure)) > 0
     and position('trial-retention-0184' in (select prosrc from pg_proc where oid = 'public._a96_tg_no_delete()'::regprocedure)) > 0),
  ('11 dry-run report works (read-only)', public.trial_retention_dry_run(null, false) ? 'summary'),
  ('12 every studio table is classified delete / keep', public.trial_retention_dry_run(null, false) -> 'unclassified_tables' = '[]'::jsonb),
  ('13 the deletion job owner can see every row (BYPASSRLS)', (public.trial_retention_dry_run(null, false) ->> 'owner_can_bypass_rls')::boolean),
  ('14 day 5 / 7 / 8 reminders unchanged', to_regprocedure('public.trial_reminder_email_claim(integer)') is not null
     and to_regprocedure('public.trial_reminders_tick()') is not null),
  ('15 nothing scheduled for deletion while the switch is off', coalesce((select delete_enabled from public.helm_trial_retention where id), false)
     or not exists (select 1 from public.trial_retention_schedule where status in ('scheduled', 'purging')))
) v(item, ok) order by item;
