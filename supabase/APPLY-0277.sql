-- APPLY-0277.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER every earlier APPLY file (needs 0029 / 0037 / 0042 / 0045 / 0047 / 0244 / 0248 / 0249 / 0253 / 0257 / 0263 / 0271).
-- R27 Helm HQ staff roles & security: every HQ person gets a ROLE (Owner / Admin / Sales / Security / Support / Viewer) and a
-- STATUS (invited / active / paused / removed). The database checks the role in EVERY HQ function. Two-step is ALWAYS required
-- for HQ (reads too). HQ sign-ins end after 30 min without use or 12 h; big changes ask for a fresh two-step code (15 min).
-- Owners add people (sales@helm.events, security@helm.events ...), change roles and remove people (kept, never deleted);
-- Owner + Security pause people and sign them out everywhere. The last Owner can never be removed. Every change is in the HQ
-- log and queues an e-mail to the person + every Owner (sent once e-mail sending is on). Optional IP allowlist (OFF).
-- THE THREE HQ ACCOUNTS (set once - running this file again never flips anyone back):
--   admin@helm.events -> Owner (active), k9@helm.events -> second Owner (invited), security@helm.events -> Security,
--   sales@helm.events -> Sales (invited). An invited account becomes active at its first HQ sign-in with that exact e-mail
--   + two-step (create the k9@ / sales@ mailboxes first). An invited Owner never counts as the last active Owner. Any OTHER existing HQ operator keeps full access as Admin and is named
--   in a NOTICE + the last VERIFY row so you can review it in HQ -> Staff access. Nobody is removed.
-- No lock-out: an HQ person without two-step gets the set-up (QR + code) right on the HQ page, then HQ opens.
-- New columns / tables / functions only. No row deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS:
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (hq.html / hq.js / hq-staff.js). Deploy comms-dispatch when e-mail is switched on (staff e-mails).
--   3  Sign in to HQ as admin@helm.events (set up two-step there if asked). Staff access -> HQ team shows you as Owner,
--      k9@ as Owner (invited), security@ as Security and sales@ as Sales (invited). Then sales@ / security@ sign in (HQ-STAFF-ACCESS-STEPS.md).
begin;
-- 0277_hq_staff_roles.sql - CANONICAL forward-only.
-- REQUIRES 0029 + 0037 + 0042 (platform_admins, is_platform_operator__pre0042, _a42_operator_binding_ok), 0045 + 0047
--          (_hq_gate / _hq_wgate, helm_hq_settings), 0244 + 0271 (helm_notice_outbox + helm_notice_outbox_claim),
--          0248 (staff allowlist), 0253 (is_platform_admin r22), 0257 + 0263 (hq_studio_link_check, hq_stage_machine).
--
-- In plain words (owner, r27: "give Helm HQ to sales@helm.events and security@helm.events - securely, with monitoring"):
--   1  HQ STAFF ROLES. Every HQ person (platform_admins row) now has a ROLE and a STATUS:
--        Owner    everything, and the only one who can add / remove staff or change roles
--        Admin    everything except managing HQ staff
--        Sales    Overview, Studios (read), Requests (plan requests, sales enquiries, suggestions), Plans (read)
--                 - no billing changes (activating a plan stays with Owner / Admin unless the owner changes the matrix)
--        Security Overview, Studios (read + suspend / reactivate), People + 2-step reset, Activity log + security
--                 notices, staff list, suspend staff / sign them out everywhere, staff allowlist + reserved domains
--        Support  Overview, Studios (read), Requests, People (read)
--        Viewer   Overview only (read-only)
--      Status: invited (added, has not used HQ yet) -> active (first HQ use) ; suspended ; removed (kept, never deleted).
--      THE THREE HQ ACCOUNTS (owner, r27), set ONCE (marker helm_hq_settings.r27_seeded_at - a re-run never flips anyone
--      back): admin@helm.events -> Owner (active), k9@helm.events -> a SECOND Owner (added as invited: the login does not
--      exist yet; active at its first HQ sign-in with that exact e-mail + two-step; an invited Owner never counts as the
--      "last active Owner"), security@helm.events -> Security, sales@helm.events -> Sales (added as invited when missing;
--      active at its first HQ sign-in with that exact e-mail + two-step). All four may sign up on helm.events (0248). Any OTHER existing
--      operator keeps full access as Admin and is listed in a NOTICE (and a VERIFY info row) for the owner to review.
--      Nobody is removed.
--   2  ENFORCED IN THE DATABASE, in every HQ function: _hq_gate (reads) and _hq_wgate (changes) now look up the
--      permission each HQ function needs (by the name it already passes) and refuse a role without it. Anything
--      unknown is Owner-only (fails closed). hq_stage_machine / hq_studio_link_check (no gate before) get one.
--   3  TWO-STEP ALWAYS: every HQ call - reads too - needs a two-step (aal2) session, for every role. The old on/off
--      switch (0047) is now always on. A staff member without two-step is taken through set-up at sign-in.
--   4  HQ SESSIONS: idle limit (default 30 min without HQ use), max age (default 12 h from sign-in), and a fresh
--      two-step code (default within 15 min) before sensitive changes (staff, billing, security, suspensions,
--      settings). "Sign out everywhere" ends a person's HQ sessions (marks them; Supabase refresh tokens are marked
--      revoked - nothing deleted). Optional IP allowlist (OFF by default; turning it on must include your own IP).
--   5  STAFF MANAGEMENT (Owner): hq_staff_invite / hq_staff_set_role / hq_staff_remove / hq_staff_restore;
--      Owner + Security: hq_staff_suspend / hq_staff_signout. You can't act on yourself, and the LAST active Owner can
--      never be removed, suspended or demoted (also a trigger on the table). Every change: audit_log (via _hq_wgate) +
--      an append-only hq_staff_events row + an e-mail notice (helm_notice_outbox kind 'hq_staff', queued only - sent
--      by the dormant comms-dispatch once e-mail is on) to the affected person and every Owner.
--   6  MONITORING: hq_staff_list() - role, status, 2-step, last sign-in, last active in HQ, current sessions (device,
--      IP shortened, since), recent HQ changes. HQ page views are tracked (throttled, hq_heartbeat) in hq_staff_activity.
--      Never any studio business data.
--   7  hq_me(): the signed-in person's own role / permissions / status (the HQ page hides what they can't use).
-- Additive + idempotent: new columns (with defaults), 4 new tables (RLS on, no API privilege, append-only where it
-- matters), new functions, create-or-replace of the gates; the outbox kind check widened once (superset); one claim
-- branch added in place. No row is deleted. hq_remove_operator no longer deletes the row (marks it removed).
-- Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): re-run the _hq_gate block of 0029, the _hq_require_mfa / _hq_wgate blocks of
--   0047, the is_platform_admin block of 0253, the 0042 is_platform_operator wrapper and the 0045 operator functions.
--   The new columns / tables can stay (unused).

do $$ begin
  if to_regclass('public.platform_admins') is null then raise exception 'STOP 0277: 0029 (platform_admins) is not applied'; end if;
  if to_regprocedure('public.is_platform_operator__pre0042()') is null or to_regprocedure('public._a42_operator_binding_ok()') is null then
    raise exception 'STOP 0277: 0042 (operator binding) is not applied'; end if;
  if to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null or to_regclass('public.helm_hq_settings') is null then
    raise exception 'STOP 0277: 0045 / 0047 (HQ gates + settings) are not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0277: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP 0277: audit_log missing'; end if;
  if to_regprocedure('public._a249_has_factor(uuid)') is null then raise exception 'STOP 0277: 0249 (_a249_has_factor) is not applied'; end if;
  if to_regprocedure('public._r23_link_check(uuid,text)') is null then raise exception 'STOP 0277: 0257 (_r23_link_check) is not applied'; end if;
end $$;

-- ---- 1) roles + status on platform_admins --------------------------------------------------------------------------
alter table public.platform_admins add column if not exists role text not null default 'admin';
alter table public.platform_admins add column if not exists status text not null default 'active';
alter table public.platform_admins add column if not exists display_name text;
alter table public.platform_admins add column if not exists invited_at timestamptz;
alter table public.platform_admins add column if not exists invited_by text;
alter table public.platform_admins add column if not exists activated_at timestamptz;
alter table public.platform_admins add column if not exists suspended_at timestamptz;
alter table public.platform_admins add column if not exists suspended_by text;
alter table public.platform_admins add column if not exists suspend_reason text;
alter table public.platform_admins add column if not exists removed_at timestamptz;
alter table public.platform_admins add column if not exists removed_by text;
alter table public.platform_admins add column if not exists updated_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.platform_admins'::regclass and conname = 'platform_admins_role_chk') then
    alter table public.platform_admins add constraint platform_admins_role_chk
      check (role in ('owner', 'admin', 'sales', 'security', 'support', 'viewer'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.platform_admins'::regclass and conname = 'platform_admins_status_chk') then
    alter table public.platform_admins add constraint platform_admins_status_chk
      check (status in ('invited', 'active', 'suspended', 'removed'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.platform_admins'::regclass and conname = 'platform_admins_text_chk') then
    alter table public.platform_admins add constraint platform_admins_text_chk
      check ((display_name is null or char_length(display_name) <= 80) and (suspend_reason is null or char_length(suspend_reason) <= 500));
  end if;
end $$;

-- (the three HQ accounts - Owner / Security / Sales - are set ONCE at the end of this file, section 13)

-- ---- 2) new private tables (RLS on, no API privilege) --------------------------------------------------------------
create table if not exists public.hq_staff_events (
  id            uuid primary key default gen_random_uuid(),
  at            timestamptz not null default now(),
  actor_user_id uuid,
  actor_email   text,
  target_email  text not null,
  kind          text not null check (kind in ('invited', 'role_changed', 'suspended', 'restored', 'removed', 'signed_out', 'activated', 'settings')),
  detail        jsonb not null default '{}'::jsonb
);
create index if not exists hq_staff_events_target_idx on public.hq_staff_events (target_email, at desc);

create table if not exists public.hq_staff_sessions (
  session_id   uuid primary key,
  user_id      uuid not null,
  email        text,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ip_short     text,
  user_agent   text check (user_agent is null or char_length(user_agent) <= 300)
);
create index if not exists hq_staff_sessions_user_idx on public.hq_staff_sessions (user_id, last_seen_at desc);

create table if not exists public.hq_staff_activity (
  id      bigint generated always as identity primary key,
  user_id uuid not null,
  email   text,
  page    text not null check (char_length(page) <= 40),
  at      timestamptz not null default now()
);
create index if not exists hq_staff_activity_user_idx on public.hq_staff_activity (user_id, at desc);

create table if not exists public.hq_session_revocations (
  session_id uuid primary key,
  user_id    uuid not null,
  revoked_at timestamptz not null default now(),
  revoked_by text,
  reason     text
);
create index if not exists hq_session_revocations_user_idx on public.hq_session_revocations (user_id);

do $$ declare t text; begin
  foreach t in array array['hq_staff_events', 'hq_staff_sessions', 'hq_staff_activity', 'hq_session_revocations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- append-only: events, page views and revocations are never changed or deleted; sessions are never deleted
create or replace function public.tg_a277_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception '% is append-only', tg_table_name using errcode = '42501'; end $$;
revoke all on function public.tg_a277_append_only() from public;
do $$ declare t text; begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a277_append_only() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a277_append_only() from authenticated; end if;
  foreach t in array array['hq_staff_events', 'hq_staff_activity', 'hq_session_revocations'] loop
    execute format('drop trigger if exists a277_append_only on public.%I', t);
    execute format('create trigger a277_append_only before update or delete on public.%I for each row execute function public.tg_a277_append_only()', t);
  end loop;
  foreach t in array array['hq_staff_events', 'hq_staff_activity', 'hq_session_revocations', 'hq_staff_sessions'] loop
    execute format('drop trigger if exists a277_no_truncate on public.%I', t);
    execute format('create trigger a277_no_truncate before truncate on public.%I for each statement execute function public.tg_a277_append_only()', t);
  end loop;
  drop trigger if exists a277_no_delete on public.hq_staff_sessions;
  create trigger a277_no_delete before delete on public.hq_staff_sessions for each row execute function public.tg_a277_append_only();
end $$;

-- ---- 3) HQ session / security settings (one row, 0047) -------------------------------------------------------------
alter table public.helm_hq_settings add column if not exists hq_idle_minutes integer not null default 30;
alter table public.helm_hq_settings add column if not exists hq_max_hours integer not null default 12;
alter table public.helm_hq_settings add column if not exists hq_reauth_minutes integer not null default 15;
alter table public.helm_hq_settings add column if not exists hq_ip_allowlist_on boolean not null default false;
alter table public.helm_hq_settings add column if not exists hq_ip_allowlist text[] not null default '{}'::text[];
alter table public.helm_hq_settings add column if not exists r27_seeded_at timestamptz;   -- the three HQ accounts were set (once)
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.helm_hq_settings'::regclass and conname = 'helm_hq_settings_r27_chk') then
    alter table public.helm_hq_settings add constraint helm_hq_settings_r27_chk
      check (hq_idle_minutes between 5 and 240 and hq_max_hours between 1 and 24 and hq_reauth_minutes between 5 and 240
             and coalesce(array_length(hq_ip_allowlist, 1), 0) <= 50);
  end if;
end $$;

-- ---- 4) the permission matrix (fixed here; one place) ----------------------------------------------------------------
create or replace function public._hq27_role_perms(p_role text)
returns text[] language sql immutable set search_path = '' as $$
  -- r27-hq-staff-0277
  select case p_role
    when 'owner'    then array['*']
    when 'admin'    then array['self', 'overview.read', 'studios.read', 'studios.edit', 'studios.suspend', 'billing.read', 'billing.write',
                               'plans.read', 'inbox.read', 'inbox.write', 'people.read', 'security.read', 'security.write',
                               'staff.read', 'settings.read', 'settings.write']
    when 'sales'    then array['self', 'overview.read', 'studios.read', 'plans.read', 'inbox.read', 'inbox.write']
    when 'security' then array['self', 'overview.read', 'studios.read', 'studios.suspend', 'people.read', 'security.read', 'security.write',
                               'staff.read', 'staff.suspend']
    when 'support'  then array['self', 'overview.read', 'studios.read', 'inbox.read', 'inbox.write', 'people.read']
    when 'viewer'   then array['self', 'overview.read']
    else array[]::text[] end
$$;

-- what each existing HQ read needs (by the name passed to _hq_gate); unknown -> Owner only
create or replace function public._hq27_read_perm(p_entity text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_entity in ('hq_overview', 'hq_metrics') then 'overview.read'
    when p_entity in ('hq_studios', 'hq_studio_detail', 'hq_studio_usage', 'hq_trial_info') then 'studios.read'
    when p_entity in ('hq_users') then 'people.read'
    when p_entity in ('hq_payments', 'hq_billing', 'hq_invoice', 'hq_billing_settings', 'hq_tax_rules', 'hq_unrealised_exports') then 'billing.read'
    when p_entity in ('hq_plans', 'hq_plan_checkout') then 'plans.read'
    when p_entity in ('hq_audit', 'hq_security_alerts', 'hq_mfa_readiness') then 'security.read'
    when p_entity in ('hq_operators', 'hq_staff_access', 'hq_staff_list', 'hq_staff_settings') then 'staff.read'
    when p_entity in ('hq_sales_requests', 'hq_sales_enquiries', 'hq_suggestions') then 'inbox.read'
    when p_entity in ('hq_stage_machine') then 'settings.read'
    else 'owner.only' end
$$;

-- what each existing HQ change needs (by the action passed to _hq_wgate); unknown -> Owner only
create or replace function public._hq27_write_perm(p_action text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_action in ('hq.studio.suspend', 'hq.studio.reactivate') then 'studios.suspend'
    when p_action in ('hq.studio.identity', 'hq.studio_account.set', 'hq.trial.extend') then 'studios.edit'
    when p_action in ('hq.billing.refresh', 'hq.plan.upsert', 'hq.plan.price', 'hq.plan.checkout', 'hq.subscription.set',
                      'hq.subscription.activate', 'hq.payment.record', 'hq.payment.void', 'hq.payment.realised',
                      'hq.billing.settings', 'hq.checkout.settings', 'hq.tax_rule.upsert') then 'billing.write'
    when p_action in ('hq.sales_request.status', 'hq.suggestion.update', 'hq.sales_enquiry.update') then 'inbox.write'
    when p_action in ('hq.sales_enquiry.settings', 'hq.stage_machine.set', 'hq.settings.require_mfa') then 'settings.write'
    when p_action in ('hq.mfa.reset', 'hq.staff_allowlist.add', 'hq.staff_allowlist.remove',
                      'hq.reserved_domain.add', 'hq.reserved_domain.remove') then 'security.write'
    when p_action in ('hq.operator.add', 'hq.operator.remove', 'hq.staff.invite', 'hq.staff.role', 'hq.staff.remove',
                      'hq.staff.restore', 'hq.staff.settings') then 'staff.manage'
    when p_action in ('hq.staff.suspend', 'hq.staff.signout') then 'staff.suspend'
    else 'owner.only' end
$$;

-- changes that need a FRESH two-step code (sudo mode)
create or replace function public._hq27_sensitive(p_perm text)
returns boolean language sql immutable set search_path = '' as $$
  select p_perm in ('staff.manage', 'staff.suspend', 'billing.write', 'security.write', 'studios.suspend', 'settings.write', 'owner.only')
$$;

create or replace function public._hq27_role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  select case p_role when 'owner' then 'Owner' when 'admin' then 'Admin' when 'sales' then 'Sales' when 'security' then 'Security'
                     when 'support' then 'Support' when 'viewer' then 'Viewer' else coalesce(p_role, '') end
$$;

-- ---- 5) helpers about the caller -------------------------------------------------------------------------------------
-- the caller's own HQ row (bound account first, else the confirmed e-mail; never another account's row)
create or replace function public._hq27_me()
returns public.platform_admins language sql stable security definer set search_path = '' as $$
  select pa.* from public.platform_admins pa join auth.users u on u.id = auth.uid()
   where pa.email = lower(u.email) and u.email_confirmed_at is not null and (pa.user_id is null or pa.user_id = u.id)
   limit 1
$$;

create or replace function public._hq27_client_ip()
returns text language plpgsql stable security definer set search_path = '' as $$
declare h jsonb; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v := nullif(btrim(coalesce(h ->> 'cf-connecting-ip', h ->> 'x-real-ip', split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1), '')), '');
  if v is null then return null; end if;
  begin perform v::inet; exception when others then return null; end;
  return v;
end $$;

-- 203.0.113.42 -> 203.0.x.x ; 2001:db8:1:2::5 -> 2001:db8:x
create or replace function public._hq27_ip_short(p_ip text)
returns text language sql immutable set search_path = '' as $$
  select case when p_ip is null or btrim(p_ip) = '' then null
              when p_ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' then split_part(p_ip, '.', 1) || '.' || split_part(p_ip, '.', 2) || '.x.x'
              when position(':' in p_ip) > 0 then split_part(p_ip, ':', 1) || ':' || split_part(p_ip, ':', 2) || ':x'
              else null end
$$;

create or replace function public._hq27_ip_allowed(p_ip text, p_list text[])
returns boolean language plpgsql immutable set search_path = '' as $$
declare c text;
begin
  if p_ip is null then return false; end if;
  foreach c in array coalesce(p_list, '{}'::text[]) loop
    begin if p_ip::inet <<= c::cidr then return true; end if; exception when others then null; end;
  end loop;
  return false;
end $$;

-- the JWT's session id (Supabase puts it in every user token); null for tokens without it
create or replace function public._hq27_session_id()
returns uuid language plpgsql stable set search_path = '' as $$
declare v text := auth.jwt() ->> 'session_id';
begin
  if v is null or v !~ '^[0-9a-fA-F-]{36}$' then return null; end if;
  return v::uuid;
end $$;

-- newest two-step (TOTP / phone / passkey) time in this token; null = the token carries no amr list at all
create or replace function public._hq27_mfa_at()
returns timestamptz language plpgsql stable set search_path = '' as $$
declare a jsonb := auth.jwt() -> 'amr'; t timestamptz;
begin
  if a is null or jsonb_typeof(a) <> 'array' then return null; end if;
  select max(to_timestamp((e ->> 'timestamp')::double precision)) into t
    from jsonb_array_elements(a) e
   where jsonb_typeof(e) = 'object' and coalesce(e ->> 'method', '') in ('totp', 'mfa/totp', 'phone', 'mfa/phone', 'webauthn', 'mfa/webauthn')
     and coalesce(e ->> 'timestamp', '') ~ '^[0-9]+(\.[0-9]+)?$';
  return coalesce(t, 'epoch'::timestamptz);
end $$;

-- ---- 6) two-step is ALWAYS required for HQ now (the 0047 switch stays in the table but is ignored) -----------------
create or replace function public._hq_require_mfa()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r27-hq-staff-0277: two-step is always required for Helm HQ
  select true
$$;

-- an HQ "operator" = my confirmed e-mail is on the HQ list and NOT removed (suspended people stay operators so the app
-- still routes them to HQ - where they see "access paused" - and they can never create a studio)
create or replace function public.is_platform_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r27-hq-staff-0277
begin
  if not (public.is_platform_operator__pre0042() and public._a42_operator_binding_ok()) then return false; end if;
  return coalesce((select me.status <> 'removed' from public._hq27_me() me where me.email is not null), true);
end $$;

-- HQ access = operator + status invited / active + two-step (aal2) session. Always - every role, every call.
create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  -- r27-hq-staff-0277: aal2 always (r22-mfa-0253 rule with the switch permanently on) + active / invited staff only
  v_uid uuid := auth.uid(); v_st text;
begin
  if v_uid is null or not public.is_platform_operator() then return false; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  select me.status into v_st from public._hq27_me() me;
  return coalesce(v_st, '') in ('active', 'invited');
end $$;

-- the one check every HQ call goes through: staff + aal2, role permission, IP allowlist, session limits, fresh code
create or replace function public._hq27_require(p_perm text, p_write boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r27-hq-staff-0277
  me public.platform_admins; s public.helm_hq_settings; v_sid uuid := public._hq27_session_id();
  v_ip text; v_row public.hq_staff_sessions; v_auth_start timestamptz; v_found boolean := true; v_mfa timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into me from public._hq27_me();
  if me.email is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not (coalesce(p_perm, 'owner.only') = any (public._hq27_role_perms(me.role)) or '*' = any (public._hq27_role_perms(me.role))) then
    raise exception 'not authorized: HQ_ROLE your HQ role (%) can''t do this', public._hq27_role_label(me.role) using errcode = '42501',
      hint = 'Ask the Helm HQ owner if you need this.';
  end if;
  select * into s from public.helm_hq_settings x where x.id;
  v_ip := public._hq27_client_ip();
  if coalesce(s.hq_ip_allowlist_on, false) and not public._hq27_ip_allowed(v_ip, s.hq_ip_allowlist) then
    raise exception 'not authorized: HQ_IP Helm HQ can''t be used from this network' using errcode = '42501';
  end if;
  -- sessions (Supabase user tokens always carry session_id; a token without one skips these checks)
  if v_sid is not null then
    if exists (select 1 from public.hq_session_revocations r where r.session_id = v_sid) then
      raise exception 'not authorized: HQ_SESSION_ENDED this sign-in was ended - sign in again' using errcode = '42501';
    end if;
    if to_regclass('auth.sessions') is not null then
      begin
        execute 'select true, s.created_at from auth.sessions s where s.id = $1' into v_found, v_auth_start using v_sid;
        v_found := coalesce(v_found, false);
      exception when others then v_found := true; v_auth_start := null;   -- unreadable: the other checks still apply
      end;
      if not v_found then
        raise exception 'not authorized: HQ_SESSION_ENDED this sign-in has ended - sign in again' using errcode = '42501';
      end if;
    end if;
    select * into v_row from public.hq_staff_sessions x where x.session_id = v_sid;
    if v_row.session_id is not null then
      if v_row.user_id <> auth.uid() then raise exception 'not authorized' using errcode = '42501'; end if;
      if v_row.last_seen_at < now() - make_interval(mins => coalesce(s.hq_idle_minutes, 30)) then
        raise exception 'not authorized: HQ_SESSION_IDLE Helm HQ signed you out after % minutes without use - sign in again',
          coalesce(s.hq_idle_minutes, 30) using errcode = '42501';
      end if;
    end if;
    if least(coalesce(v_auth_start, v_row.started_at, now()), coalesce(v_row.started_at, now()))
         < now() - make_interval(hours => coalesce(s.hq_max_hours, 12)) then
      raise exception 'not authorized: HQ_SESSION_EXPIRED Helm HQ sign-ins last at most % hours - sign in again',
        coalesce(s.hq_max_hours, 12) using errcode = '42501';
    end if;
    if v_row.session_id is null then
      insert into public.hq_staff_sessions(session_id, user_id, email, started_at, last_seen_at, ip_short, user_agent)
      values (v_sid, auth.uid(), me.email, coalesce(least(v_auth_start, now()), now()), now(), public._hq27_ip_short(v_ip),
              left(nullif(current_setting('request.headers', true), '')::jsonb ->> 'user-agent', 300))
      on conflict (session_id) do nothing;
    elsif v_row.last_seen_at < now() - interval '60 seconds' then
      update public.hq_staff_sessions set last_seen_at = now() where session_id = v_sid;
    end if;
  end if;
  -- sensitive change: a two-step code entered within the last N minutes (a token without an amr list skips this)
  if p_write and public._hq27_sensitive(p_perm) then
    v_mfa := public._hq27_mfa_at();
    if v_mfa is not null and v_mfa < now() - make_interval(mins => coalesce(s.hq_reauth_minutes, 15)) then
      raise exception 'not authorized: HQ_REAUTH enter a fresh two-step code to confirm this change' using errcode = '42501';
    end if;
  end if;
  -- first HQ use of an invited person: active from now on, bound to this login
  if me.status = 'invited' then
    update public.platform_admins set status = 'active', activated_at = now(), updated_at = now(), user_id = coalesce(user_id, auth.uid())
     where email = me.email;
    insert into public.hq_staff_events(actor_user_id, actor_email, target_email, kind, detail)
      values (auth.uid(), me.email, me.email, 'activated', jsonb_build_object('role', me.role));
  end if;
end $$;

-- the gates every existing hq_* function already calls: same names / arguments / audit rows, plus the role check
create or replace function public._hq_gate(p_entity text, p_entity_id text default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r27-hq-staff-0277
  perform public._hq27_require(public._hq27_read_perm(p_entity), false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', p_entity, p_entity_id, null, now()
      from auth.users u where u.id = auth.uid();
end $$;

create or replace function public._hq_wgate(p_action text, p_entity text, p_entity_id text, p_changed jsonb default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  -- r27-hq-staff-0277
  perform public._hq27_require(public._hq27_write_perm(p_action), true);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, p_action, p_entity, p_entity_id, p_changed, null, now()
      from auth.users u where u.id = auth.uid();
end $$;

-- ---- 7) the last active Owner can never go (any route, SQL editor included) ----------------------------------------------
create or replace function public.tg_a277_last_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active')
     and not exists (select 1 from public.platform_admins pa where pa.role = 'owner' and pa.status = 'active' and pa.email <> old.email) then
    raise exception 'Helm HQ must keep at least one active Owner. Add another Owner first.' using errcode = '22023';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
revoke all on function public.tg_a277_last_owner() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a277_last_owner() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a277_last_owner() from authenticated; end if;
end $$;
drop trigger if exists a277_last_owner on public.platform_admins;
create trigger a277_last_owner before update or delete on public.platform_admins
  for each row execute function public.tg_a277_last_owner();

-- ---- 8) staff events: log row + queued e-mail (to the person + every Owner) -------------------------------------------
create or replace function public._hq27_event(p_kind text, p_target text, p_detail jsonb default '{}'::jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_me text;
begin
  select lower(u.email) into v_me from auth.users u where u.id = auth.uid();
  insert into public.hq_staff_events(actor_user_id, actor_email, target_email, kind, detail)
    values (auth.uid(), v_me, p_target, p_kind, coalesce(p_detail, '{}'::jsonb)) returning id into v_id;
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('hq_staff', null, v_id, jsonb_build_object('kind', p_kind), 'hq_staff:' || v_id::text)
      on conflict (dedupe_key) do nothing;
  exception when check_violation then null;   -- outbox kind not widened on this database: the log row is kept
  end;
  return v_id;
end $$;

create or replace function public._hq27_staff_mail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r27-hq-staff-0277: recipients resolved here (never from the row): the affected person + every active Owner
declare e public.hq_staff_events; v_to jsonb; pa public.platform_admins;
begin
  select * into e from public.hq_staff_events x where x.id = p_id;
  if e.id is null or e.kind = 'activated' then return null; end if;
  select * into pa from public.platform_admins x where x.email = e.target_email;
  select coalesce(jsonb_agg(distinct z.m), '[]'::jsonb) into v_to from (
    select e.target_email as m where e.target_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and e.kind <> 'settings'
    union select o.email from public.platform_admins o where o.role = 'owner' and o.status = 'active') z;
  return jsonb_build_object('to', v_to, 'data', jsonb_build_object(
    'event', e.kind, 'email', e.target_email, 'role', public._hq27_role_label(coalesce(e.detail ->> 'role', pa.role)),
    'old_role', case when e.detail ? 'old_role' then public._hq27_role_label(e.detail ->> 'old_role') end,
    'by', e.actor_email, 'reason', left(e.detail ->> 'reason', 300), 'at', e.at));
end $$;

-- the e-mail lane: kind 'hq_staff' added once (superset, every existing row still passes) + one claim branch
do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0277: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('''hq_staff''' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0277: helm_notice_outbox kind check has an unexpected body - left unchanged (staff e-mails stay off)'; return; end if;
  v_kinds := array(select distinct k from unnest(v_kinds || array['hq_staff']) k order by k);
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0277 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0277 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r27-hq-staff-0277' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0277: helm_notice_outbox_claim has an unexpected body - left unchanged (staff e-mails are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind = ''hq_staff'' and r.ref_id is not null then\n'
        || E'      -- r27-hq-staff-0277: HQ staff change -> the person + every Owner (resolved in _hq27_staff_mail)\n'
        || E'      v_data := public._hq27_staff_mail(r.ref_id);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || v_old;
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 9) sign a person out of HQ everywhere (marks; never deletes) -----------------------------------------------------
create or replace function public._hq27_end_sessions(p_user uuid, p_reason text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_by text; v_ids uuid[] := '{}'::uuid[]; n integer := 0;
begin
  if p_user is null then return 0; end if;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  if to_regclass('auth.sessions') is not null then
    begin execute 'select coalesce(array_agg(s.id), ''{}''::uuid[]) from auth.sessions s where s.user_id = $1' into v_ids using p_user;
    exception when others then v_ids := '{}'::uuid[]; end;
  end if;
  v_ids := v_ids || coalesce((select array_agg(x.session_id) from public.hq_staff_sessions x where x.user_id = p_user), '{}'::uuid[]);
  insert into public.hq_session_revocations(session_id, user_id, revoked_by, reason)
    select distinct i, p_user, v_by, left(p_reason, 200) from unnest(v_ids) i where i is not null
    on conflict (session_id) do nothing;
  get diagnostics n = row_count;
  -- Supabase refresh tokens of those sessions: marked revoked (never deleted) so the sign-in can't be renewed
  if to_regclass('auth.refresh_tokens') is not null and array_length(v_ids, 1) > 0 then
    begin
      execute 'update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = any ($1) and not coalesce(revoked, false)'
        using v_ids;
    exception when others then null;   -- HQ already refuses those sessions (hq_session_revocations)
    end;
  end if;
  return n;
end $$;

-- ---- 10) the HQ page's own RPCs ------------------------------------------------------------------------------------
-- who am I in HQ (works before two-step, so the page can say "set up two-step first" / "access paused")
create or replace function public.hq_me()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare me public.platform_admins; s public.helm_hq_settings; v_factor boolean := false;
begin
  if auth.uid() is null or not public.is_platform_operator() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into me from public._hq27_me();
  select * into s from public.helm_hq_settings x where x.id;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')' into v_factor using auth.uid();
  end if;
  return jsonb_build_object('email', me.email, 'role', me.role, 'role_label', public._hq27_role_label(me.role), 'status', me.status,
    'perms', to_jsonb(public._hq27_role_perms(me.role)), 'has_2step', v_factor,
    'needs_2step', coalesce(auth.jwt() ->> 'aal', '') <> 'aal2',
    'idle_minutes', coalesce(s.hq_idle_minutes, 30), 'max_hours', coalesce(s.hq_max_hours, 12),
    'reauth_minutes', coalesce(s.hq_reauth_minutes, 15));
end $$;

-- page view / "still here" ping (throttled: one row per person + page per 5 minutes; no audit row)
create or replace function public.hq_heartbeat(p_page text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_page text := lower(left(btrim(coalesce(p_page, 'hq')), 40)); me public.platform_admins;
begin
  perform public._hq27_require('self', false);
  if v_page !~ '^[a-z][a-z0-9_-]{0,39}$' then v_page := 'hq'; end if;
  select * into me from public._hq27_me();
  if not exists (select 1 from public.hq_staff_activity a where a.user_id = auth.uid() and a.page = v_page and a.at > now() - interval '5 minutes') then
    insert into public.hq_staff_activity(user_id, email, page) values (auth.uid(), me.email, v_page);
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- the HQ team list with monitoring (staff.read). HQ people only - never studio data.
create or replace function public.hq_staff_list(p_include_removed boolean default false)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare r jsonb; v_mfa boolean := to_regclass('auth.mfa_factors') is not null; v_sess boolean := to_regclass('auth.sessions') is not null;
begin
  perform public._hq_gate('hq_staff_list');
  select coalesce(jsonb_agg(x order by x ->> 'sort', x ->> 'email'), '[]'::jsonb) into r from (
    select jsonb_build_object(
      'sort', case pa.status when 'active' then '1' when 'invited' then '2' when 'suspended' then '3' else '4' end
              || case pa.role when 'owner' then '1' when 'admin' then '2' else '3' end,
      'email', pa.email, 'name', pa.display_name, 'role', pa.role, 'role_label', public._hq27_role_label(pa.role), 'status', pa.status,
      'added_at', pa.added_at, 'invited_at', pa.invited_at, 'invited_by', coalesce(pa.invited_by, pa.added_by), 'activated_at', pa.activated_at,
      'suspended_at', pa.suspended_at, 'suspended_by', pa.suspended_by, 'suspend_reason', pa.suspend_reason,
      'removed_at', pa.removed_at, 'is_me', u.id is not null and u.id = auth.uid(),
      'has_login', u.id is not null, 'last_sign_in_at', u.last_sign_in_at,
      'has_2step', case when v_mfa and u.id is not null then public._a249_has_factor(u.id) else false end,
      'last_active_at', greatest((select max(ss.last_seen_at) from public.hq_staff_sessions ss where ss.user_id = u.id),
                                 (select max(a.at) from public.hq_staff_activity a where a.user_id = u.id)),
      'views_7d', (select count(*) from public.hq_staff_activity a where a.user_id = u.id and a.at > now() - interval '7 days'),
      'sessions', case when u.id is null then '[]'::jsonb else public._hq27_sessions_of(u.id) end,
      'recent', coalesce((select jsonb_agg(jsonb_build_object('at', z.at, 'action', z.action) order by z.at desc) from (
                  select a.at, a.action from public.audit_log a
                   where a.actor = u.id and a.org_id is null and a.action like 'hq.%' and a.action <> 'hq.view'
                   order by a.at desc limit 8) z), '[]'::jsonb)) as x
      from public.platform_admins pa
      left join lateral (
        select au.id, au.last_sign_in_at from auth.users au
         where (pa.user_id is not null and au.id = pa.user_id)
            or (pa.user_id is null and lower(au.email) = pa.email and au.email_confirmed_at is not null)
         order by (au.id = pa.user_id) desc nulls last, au.created_at limit 1) u on true
     where coalesce(p_include_removed, false) or pa.status <> 'removed') q;
  return jsonb_build_object('staff', r, 'settings', public._hq27_settings_json(), 'generated_at', now(),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'email', e.target_email, 'by', e.actor_email,
                         'role', e.detail ->> 'role', 'reason', left(e.detail ->> 'reason', 300)) order by e.at desc)
                        from (select * from public.hq_staff_events order by at desc limit 30) e), '[]'::jsonb));
end $$;

-- a person's current Supabase sessions (device text, IP shortened, since, last HQ use); revoked ones left out
create or replace function public._hq27_sessions_of(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb := '[]'::jsonb;
begin
  if p_user is null then return '[]'::jsonb; end if;
  if to_regclass('auth.sessions') is not null then
    begin
      execute $q$
        select coalesce(jsonb_agg(z.j order by z.seen desc), '[]'::jsonb) from (
          select jsonb_build_object('since', s.created_at, 'seen', coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at),
                   'device', left(coalesce(to_jsonb(s) ->> 'user_agent', h.user_agent, ''), 200),
                   'ip', coalesce(public._hq27_ip_short(host(nullif(to_jsonb(s) ->> 'ip', '')::inet)), h.ip_short),
                   'hq_last', h.last_seen_at, 'current', s.id = public._hq27_session_id()) as j,
                 coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at) as seen
            from auth.sessions s
            left join public.hq_staff_sessions h on h.session_id = s.id
           where s.user_id = $1
             and not exists (select 1 from public.hq_session_revocations v where v.session_id = s.id)
             and (nullif(to_jsonb(s) ->> 'not_after', '') is null or (to_jsonb(s) ->> 'not_after')::timestamptz > now())
             and coalesce(nullif(to_jsonb(s) ->> 'refreshed_at', '')::timestamptz, s.updated_at, s.created_at) > now() - interval '7 days'
           order by 2 desc limit 10) z$q$ into r using p_user;
    exception when others then r := null;
    end;
  end if;
  if r is null or r = '[]'::jsonb then
    select coalesce(jsonb_agg(jsonb_build_object('since', h.started_at, 'seen', h.last_seen_at, 'device', coalesce(h.user_agent, ''),
             'ip', h.ip_short, 'hq_last', h.last_seen_at, 'current', h.session_id = public._hq27_session_id()) order by h.last_seen_at desc), '[]'::jsonb)
      into r from (select * from public.hq_staff_sessions x where x.user_id = p_user
                     and not exists (select 1 from public.hq_session_revocations v where v.session_id = x.session_id)
                     and x.last_seen_at > now() - interval '7 days' order by x.last_seen_at desc limit 10) h;
  end if;
  return coalesce(r, '[]'::jsonb);
end $$;

create or replace function public._hq27_settings_json()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('idle_minutes', coalesce(s.hq_idle_minutes, 30), 'max_hours', coalesce(s.hq_max_hours, 12),
           'reauth_minutes', coalesce(s.hq_reauth_minutes, 15), 'ip_allowlist_on', coalesce(s.hq_ip_allowlist_on, false),
           'ip_allowlist', to_jsonb(coalesce(s.hq_ip_allowlist, '{}'::text[])), 'my_ip', public._hq27_client_ip(),
           'two_step_required', true)
    from (select 1) one left join public.helm_hq_settings s on s.id
$$;

create or replace function public.hq_staff_settings()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_gate('hq_staff_settings');
  return public._hq27_settings_json();
end $$;

create or replace function public._hq27_norm_email(p text)
returns text language sql immutable set search_path = '' as $$ select lower(btrim(coalesce(p, ''))) $$;

-- Owner: add a person to the HQ team (invited until their first HQ use)
create or replace function public.hq_staff_invite(p_email text, p_role text, p_name text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_role text := lower(btrim(coalesce(p_role, '')));
        v_name text := nullif(left(btrim(coalesce(p_name, '')), 80), ''); v_by text; v_uid uuid; v_row public.platform_admins;
begin
  perform public._hq_wgate('hq.staff.invite', 'platform_admins', v_email, jsonb_build_object('role', v_role));
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'Enter a valid e-mail address.' using errcode = '22023'; end if;
  if v_role not in ('owner', 'admin', 'sales', 'security', 'support', 'viewer') then raise exception 'Choose a role.' using errcode = '22023'; end if;
  if exists (select 1 from public.profiles p where lower(p.email) = v_email and p.org_id is not null)
     or exists (select 1 from public.profiles p join auth.users u on u.id = p.id where lower(u.email) = v_email and p.org_id is not null) then
    raise exception 'This e-mail belongs to a studio member. Helm HQ staff need their own e-mail (for example sales@helm.events).' using errcode = '22023';
  end if;
  select * into v_row from public.platform_admins where email = v_email for update;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  select u.id into v_uid from auth.users u where lower(u.email) = v_email and u.email_confirmed_at is not null order by u.created_at limit 1;
  if v_row.email is not null and v_row.status <> 'removed' then
    raise exception 'This person is already on the HQ team (%). Change their role instead.', v_row.status using errcode = '22023';
  end if;
  if v_row.email is null then
    insert into public.platform_admins(email, added_by, user_id, role, status, display_name, invited_at, invited_by, updated_at)
      values (v_email, coalesce(v_by, 'hq'), v_uid, v_role, 'invited', v_name, now(), v_by, now());
  else
    update public.platform_admins set role = v_role, status = 'invited', display_name = coalesce(v_name, display_name),
           invited_at = now(), invited_by = v_by, removed_at = null, removed_by = null, suspended_at = null, suspended_by = null,
           suspend_reason = null, user_id = coalesce(user_id, v_uid), updated_at = now()
     where email = v_email;
  end if;
  -- their address may sign up even when the reserved-domain protection is on (0248)
  if to_regclass('public.staff_email_allowlist') is not null then
    begin
      execute 'insert into public.staff_email_allowlist(email, note, added_by) values ($1, $2, $3) on conflict do nothing'
        using v_email, 'Helm HQ staff (' || public._hq27_role_label(v_role) || ')', coalesce(v_by, 'hq');
    exception when others then null;   -- platform_admins already counts as allowlisted
    end;
  end if;
  perform public._hq27_event('invited', v_email, jsonb_build_object('role', v_role));
  return jsonb_build_object('email', v_email, 'role', v_role, 'status', 'invited', 'has_login', v_uid is not null);
end $$;

-- Owner: change a role (never your own; never the last active Owner)
create or replace function public.hq_staff_set_role(p_email text, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_role text := lower(btrim(coalesce(p_role, ''))); v_row public.platform_admins; me public.platform_admins;
begin
  select * into v_row from public.platform_admins where email = v_email;
  perform public._hq_wgate('hq.staff.role', 'platform_admins', v_email, jsonb_build_object('role', v_role, 'old_role', v_row.role));
  select * into me from public._hq27_me();
  if v_row.email is null or v_row.status = 'removed' then raise exception 'This person is not on the HQ team.' using errcode = '22023'; end if;
  if v_role not in ('owner', 'admin', 'sales', 'security', 'support', 'viewer') then raise exception 'Choose a role.' using errcode = '22023'; end if;
  if v_email = me.email then raise exception 'You can''t change your own role. Ask another Owner.' using errcode = '22023'; end if;
  if v_row.role = v_role then return jsonb_build_object('email', v_email, 'role', v_role, 'changed', false); end if;
  update public.platform_admins set role = v_role, updated_at = now() where email = v_email;   -- last-Owner trigger guards
  perform public._hq27_event('role_changed', v_email, jsonb_build_object('role', v_role, 'old_role', v_row.role));
  return jsonb_build_object('email', v_email, 'role', v_role, 'changed', true);
end $$;

-- Owner + Security: pause a person's HQ access now (and end their sessions). Security can't pause an Owner.
create or replace function public.hq_staff_suspend(p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_reason text := btrim(coalesce(p_reason, '')); v_row public.platform_admins;
        me public.platform_admins; v_uid uuid; n int;
begin
  select * into v_row from public.platform_admins where email = v_email;
  perform public._hq_wgate('hq.staff.suspend', 'platform_admins', v_email, jsonb_build_object('reason', left(v_reason, 300)));
  select * into me from public._hq27_me();
  if v_row.email is null or v_row.status in ('removed', 'suspended') then raise exception 'This person is not active on the HQ team.' using errcode = '22023'; end if;
  if v_email = me.email then raise exception 'You can''t pause your own access.' using errcode = '22023'; end if;
  if v_row.role = 'owner' and me.role <> 'owner' then raise exception 'Only an Owner can pause another Owner.' using errcode = '42501'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then raise exception 'Give a short reason (5 to 500 characters).' using errcode = '22023'; end if;
  update public.platform_admins set status = 'suspended', suspended_at = now(), suspended_by = me.email, suspend_reason = v_reason, updated_at = now()
   where email = v_email;
  select u.id into v_uid from auth.users u where u.id = v_row.user_id or (v_row.user_id is null and lower(u.email) = v_email) order by u.created_at limit 1;
  n := public._hq27_end_sessions(v_uid, 'suspended');
  perform public._hq27_event('suspended', v_email, jsonb_build_object('role', v_row.role, 'reason', v_reason, 'sessions_ended', n));
  return jsonb_build_object('email', v_email, 'status', 'suspended', 'sessions_ended', n);
end $$;

-- Owner: give access back (suspended -> active, removed -> invited)
create or replace function public.hq_staff_restore(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_row public.platform_admins; v_new text;
begin
  select * into v_row from public.platform_admins where email = v_email;
  perform public._hq_wgate('hq.staff.restore', 'platform_admins', v_email);
  if v_row.email is null or v_row.status not in ('suspended', 'removed') then raise exception 'Nothing to restore for this person.' using errcode = '22023'; end if;
  v_new := case when v_row.status = 'removed' then 'invited' else 'active' end;
  update public.platform_admins set status = v_new, suspended_at = null, suspended_by = null, suspend_reason = null,
         removed_at = null, removed_by = null, updated_at = now() where email = v_email;
  perform public._hq27_event('restored', v_email, jsonb_build_object('role', v_row.role));
  return jsonb_build_object('email', v_email, 'status', v_new);
end $$;

-- Owner: take a person off the HQ team (kept as 'removed' - never deleted; can be restored)
create or replace function public.hq_staff_remove(p_email text, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_reason text := left(btrim(coalesce(p_reason, '')), 500); v_row public.platform_admins;
        me public.platform_admins; v_uid uuid; n int;
begin
  select * into v_row from public.platform_admins where email = v_email;
  perform public._hq_wgate('hq.staff.remove', 'platform_admins', v_email, jsonb_build_object('reason', v_reason, 'role', v_row.role));
  select * into me from public._hq27_me();
  if v_row.email is null or v_row.status = 'removed' then raise exception 'This person is not on the HQ team.' using errcode = '22023'; end if;
  if v_email = me.email then raise exception 'You can''t remove yourself. Ask another Owner.' using errcode = '22023'; end if;
  update public.platform_admins set status = 'removed', removed_at = now(), removed_by = me.email, updated_at = now()
   where email = v_email;   -- last-Owner trigger guards
  select u.id into v_uid from auth.users u where u.id = v_row.user_id or (v_row.user_id is null and lower(u.email) = v_email) order by u.created_at limit 1;
  n := public._hq27_end_sessions(v_uid, 'removed');
  perform public._hq27_event('removed', v_email, jsonb_build_object('role', v_row.role, 'reason', nullif(v_reason, ''), 'sessions_ended', n));
  return jsonb_build_object('email', v_email, 'status', 'removed', 'sessions_ended', n);
end $$;

-- Owner + Security: sign a person out of HQ everywhere (not yourself - use Sign out)
create or replace function public.hq_staff_signout(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_email text := public._hq27_norm_email(p_email); v_row public.platform_admins; me public.platform_admins; v_uid uuid; n int;
begin
  select * into v_row from public.platform_admins where email = v_email;
  perform public._hq_wgate('hq.staff.signout', 'platform_admins', v_email);
  select * into me from public._hq27_me();
  if v_row.email is null then raise exception 'This person is not on the HQ team.' using errcode = '22023'; end if;
  if v_email = me.email then raise exception 'To end your own sign-in, use Sign out.' using errcode = '22023'; end if;
  if v_row.role = 'owner' and me.role <> 'owner' then raise exception 'Only an Owner can sign out another Owner.' using errcode = '42501'; end if;
  select u.id into v_uid from auth.users u where u.id = v_row.user_id or (v_row.user_id is null and lower(u.email) = v_email) order by u.created_at limit 1;
  n := public._hq27_end_sessions(v_uid, 'signed out by ' || coalesce(me.email, 'hq'));
  perform public._hq27_event('signed_out', v_email, jsonb_build_object('role', v_row.role, 'sessions_ended', n));
  return jsonb_build_object('email', v_email, 'sessions_ended', n);
end $$;

-- Owner: HQ session limits + optional IP allowlist (turning it on must keep your own IP inside)
create or replace function public.hq_set_staff_settings(p_idle_minutes integer, p_max_hours integer, p_reauth_minutes integer,
  p_ip_allowlist_on boolean, p_ip_allowlist text[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_list text[] := '{}'::text[]; c text; v_ip text := public._hq27_client_ip(); v_old jsonb := public._hq27_settings_json();
begin
  perform public._hq_wgate('hq.staff.settings', 'helm_hq_settings', 'staff', jsonb_build_object('idle', p_idle_minutes, 'max_hours', p_max_hours,
    'reauth', p_reauth_minutes, 'ip_on', p_ip_allowlist_on, 'ip_count', coalesce(array_length(p_ip_allowlist, 1), 0)));
  if p_idle_minutes is not null and (p_idle_minutes < 5 or p_idle_minutes > 240) then raise exception 'Idle limit: 5 to 240 minutes.' using errcode = '22023'; end if;
  if p_max_hours is not null and (p_max_hours < 1 or p_max_hours > 24) then raise exception 'Longest sign-in: 1 to 24 hours.' using errcode = '22023'; end if;
  if p_reauth_minutes is not null and (p_reauth_minutes < 5 or p_reauth_minutes > 240) then raise exception 'Fresh code: 5 to 240 minutes.' using errcode = '22023'; end if;
  foreach c in array coalesce(p_ip_allowlist, '{}'::text[]) loop
    c := btrim(c); if c = '' then continue; end if;
    begin perform c::cidr; exception when others then raise exception 'Not an IP address or range: %', left(c, 60) using errcode = '22023'; end;
    v_list := v_list || c;
  end loop;
  if coalesce(array_length(v_list, 1), 0) > 50 then raise exception 'At most 50 IP addresses / ranges.' using errcode = '22023'; end if;
  if coalesce(p_ip_allowlist_on, false) and not public._hq27_ip_allowed(v_ip, v_list) then
    raise exception 'Your current IP address (%) is not in the list - add it first so you are not locked out.', coalesce(v_ip, 'unknown') using errcode = '22023';
  end if;
  update public.helm_hq_settings set hq_idle_minutes = coalesce(p_idle_minutes, hq_idle_minutes), hq_max_hours = coalesce(p_max_hours, hq_max_hours),
         hq_reauth_minutes = coalesce(p_reauth_minutes, hq_reauth_minutes), hq_ip_allowlist_on = coalesce(p_ip_allowlist_on, false),
         hq_ip_allowlist = case when p_ip_allowlist is null then hq_ip_allowlist else v_list end
   where id;
  perform public._hq27_event('settings', coalesce((select me.email from public._hq27_me() me), 'hq'), jsonb_build_object('before', v_old - 'my_ip', 'after', public._hq27_settings_json() - 'my_ip'));
  return public._hq27_settings_json();
end $$;

-- ---- 11) older HQ functions brought under the matrix ------------------------------------------------------------------
-- 0045 operators list: removed people left out, role / status added
create or replace function public.hq_operators()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v_mfa boolean := to_regclass('auth.mfa_factors') is not null; r jsonb;
begin
  perform public._hq_gate('hq_operators');
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('email', pa.email, 'bound', pa.user_id is not null, 'added_at', pa.added_at,
             'added_by', pa.added_by, 'require_mfa', pa.require_mfa, 'last_sign_in_at', u.last_sign_in_at, 'role', pa.role, 'status', pa.status,
             'mfa_enabled', %s, 'is_me', u.id is not null and u.id = auth.uid()) order by pa.added_at, pa.email), '[]'::jsonb)
      from public.platform_admins pa left join auth.users u on lower(u.email) = pa.email
     where pa.status <> 'removed'$q$,
    case when v_mfa then 'exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = ''verified'')' else 'false' end)
    into r;
  return r;
end $$;

-- 0045 "add operator" = invite as Admin; "remove operator" = mark removed (never deletes the row any more)
create or replace function public.hq_add_operator(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare r jsonb;
begin
  r := public.hq_staff_invite(p_email, 'admin', null);
  return jsonb_build_object('email', r ->> 'email', 'bound', coalesce((r ->> 'has_login')::boolean, false));
end $$;

create or replace function public.hq_remove_operator(p_email text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare r jsonb;
begin
  r := public.hq_staff_remove(p_email, 'removed from the HQ operators list');
  return jsonb_build_object('email', r ->> 'email', 'removed', true);
end $$;

-- 0257: live link check -> studios.edit (was: any operator)
create or replace function public.hq_studio_link_check(p_org uuid, p_slug text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-studio-name-0257 + r27-hq-staff-0277: HQ staff who may edit a studio's name / link
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._hq27_require('studios.edit', false);
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'Studio not found.' using errcode = 'P0002'; end if;
  return public._r23_link_check(p_org, p_slug);
end $$;

-- 0263: stage-machine switches -> settings.read (Owner / Admin)
do $$ declare v_def text; v_old text := 'if not public.is_platform_admin() then raise exception ''not authorized'' using errcode = ''42501''; end if;'; begin
  if to_regprocedure('public.hq_stage_machine()') is null then return; end if;
  v_def := pg_get_functiondef('public.hq_stage_machine()'::regprocedure);
  if position('r27-hq-staff-0277' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0277: hq_stage_machine has an unexpected body - left unchanged'; return; end if;
  v_def := replace(v_def, v_old, '-- r27-hq-staff-0277' || E'\n  perform public._hq27_require(''settings.read'', false);');
  v_def := replace(v_def, ' STABLE ', ' VOLATILE ');
  execute v_def;
end $$;

-- ---- 11b) sign-up page: may this helm.events address make a login? (pre-authorised HQ staff: k9@, sales@, security@ ...)
-- The SAME answer the server gives when the person tries (0248 hook / auth.users guard use email_is_reserved), so it reveals
-- nothing new. Lets the sign-up form accept a pre-authorised HQ address instead of refusing every @helm.events early.
create or replace function public.signup_email_preauthorised(p_email text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r27-hq-staff-0277
declare v text := lower(btrim(coalesce(p_email, '')));
begin
  if v = '' or length(v) > 254 or position('@' in v) < 2 then return false; end if;
  if to_regprocedure('public.email_is_reserved(text)') is null or to_regprocedure('public.reserved_email_domain(text)') is null then return false; end if;
  return public.reserved_email_domain(v) is not null and not public.email_is_reserved(v);
end $$;
revoke all on function public.signup_email_preauthorised(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then grant execute on function public.signup_email_preauthorised(text) to anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.signup_email_preauthorised(text) to authenticated; end if;
end $$;

-- ---- 12) grants ------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: nobody calls these through the API
  foreach f in array array['public._hq27_role_perms(text)', 'public._hq27_read_perm(text)', 'public._hq27_write_perm(text)',
      'public._hq27_sensitive(text)', 'public._hq27_role_label(text)', 'public._hq27_me()', 'public._hq27_client_ip()',
      'public._hq27_ip_short(text)', 'public._hq27_ip_allowed(text, text[])', 'public._hq27_session_id()', 'public._hq27_mfa_at()',
      'public._hq27_require(text, boolean)', 'public._hq27_event(text, text, jsonb)', 'public._hq27_staff_mail(uuid)',
      'public._hq27_end_sessions(uuid, text)', 'public._hq27_sessions_of(uuid)', 'public._hq27_settings_json()',
      'public._hq27_norm_email(text)', 'public._hq_gate(text, text)', 'public._hq_wgate(text, text, text, jsonb)',
      'public._hq_require_mfa()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- signed-in only (each checks HQ staff + permission inside); never anon
  foreach f in array array['public.hq_me()', 'public.hq_heartbeat(text)', 'public.hq_staff_list(boolean)', 'public.hq_staff_settings()',
      'public.hq_staff_invite(text, text, text)', 'public.hq_staff_set_role(text, text)', 'public.hq_staff_suspend(text, text)',
      'public.hq_staff_restore(text)', 'public.hq_staff_remove(text, text)', 'public.hq_staff_signout(text)',
      'public.hq_set_staff_settings(integer, integer, integer, boolean, text[])', 'public.hq_operators()', 'public.hq_add_operator(text)',
      'public.hq_remove_operator(text)', 'public.hq_studio_link_check(uuid, text)', 'public.is_platform_admin()', 'public.is_platform_operator()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  if to_regprocedure('public.hq_stage_machine()') is not null then
    revoke all on function public.hq_stage_machine() from public;
    if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hq_stage_machine() from anon; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.hq_stage_machine() to authenticated; end if;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public._hq27_staff_mail(uuid) to service_role;
  end if;
end $$;

-- ---- 13) the three HQ accounts (owner, r27) - ONCE; a re-run changes nobody ------------------------------------------
--   admin@helm.events    -> Owner (active)
--   k9@helm.events       -> Owner (second Owner; invited until its first HQ sign-in with that exact e-mail + two-step)
--   security@helm.events -> Security (kept active if it already is; added as invited when missing)
--   sales@helm.events    -> Sales (added as invited when missing; active at the first HQ use: exact e-mail + two-step)
--   anyone else already on the HQ list -> stays Admin (full access, as before) and is named in a NOTICE for review.
do $$ declare v_new_sales integer := 0; v_new_sec integer := 0; v_new_k9 integer := 0; v_others text; begin
  if not exists (select 1 from public.helm_hq_settings s where s.id) then
    raise notice '0277: helm_hq_settings has no row - the three HQ accounts were not set (run 0047 first)'; return;
  end if;
  if (select s.r27_seeded_at from public.helm_hq_settings s where s.id) is null then
    insert into public.platform_admins(email, added_by, role, status, display_name, updated_at)
      values ('admin@helm.events', 'migration 0277', 'owner', 'active', 'Helm owner', now())
      on conflict (email) do update set role = 'owner', status = 'active', removed_at = null, suspended_at = null, updated_at = now();
    -- the second Owner, pre-authorised by e-mail (its login is created later by signing in with exactly this address)
    insert into public.platform_admins(email, added_by, role, status, display_name, invited_at, invited_by, updated_at)
      values ('k9@helm.events', 'migration 0277', 'owner', 'invited', 'Owner (k9)', now(), 'migration 0277', now())
      on conflict (email) do nothing;
    get diagnostics v_new_k9 = row_count;
    update public.platform_admins set role = 'owner', updated_at = now()
     where email = 'k9@helm.events' and role <> 'owner' and status <> 'removed';
    insert into public.platform_admins(email, added_by, role, status, display_name, invited_at, invited_by, updated_at)
      values ('security@helm.events', 'migration 0277', 'security', 'invited', 'Security team', now(), 'migration 0277', now())
      on conflict (email) do nothing;
    get diagnostics v_new_sec = row_count;
    update public.platform_admins set role = 'security', display_name = coalesce(display_name, 'Security team'), updated_at = now()
     where email = 'security@helm.events' and role <> 'security';
    insert into public.platform_admins(email, added_by, role, status, display_name, invited_at, invited_by, updated_at)
      values ('sales@helm.events', 'migration 0277', 'sales', 'invited', 'Sales team', now(), 'migration 0277', now())
      on conflict (email) do nothing;
    get diagnostics v_new_sales = row_count;
    update public.platform_admins set role = 'sales', display_name = coalesce(display_name, 'Sales team'), updated_at = now()
     where email = 'sales@helm.events' and role <> 'sales';
    -- their addresses may sign up even with the reserved-domain protection on (0248; HQ people count as allowlisted anyway)
    if to_regclass('public.staff_email_allowlist') is not null then
      begin
        execute $q$insert into public.staff_email_allowlist(email, note, added_by)
                   values ('sales@helm.events', 'Helm HQ staff (Sales)', 'migration 0277'), ('security@helm.events', 'Helm HQ staff (Security)', 'migration 0277'),
                          ('k9@helm.events', 'Helm HQ staff (Owner)', 'migration 0277')
                   on conflict do nothing$q$;
      exception when others then null;
      end;
    end if;
    -- the log + a queued e-mail for each NEW account (sent only once e-mail sending is on)
    if v_new_k9 > 0 then perform public._hq27_event('invited', 'k9@helm.events', jsonb_build_object('role', 'owner', 'by_migration', true)); end if;
    if v_new_sales > 0 then perform public._hq27_event('invited', 'sales@helm.events', jsonb_build_object('role', 'sales', 'by_migration', true)); end if;
    if v_new_sec > 0 then perform public._hq27_event('invited', 'security@helm.events', jsonb_build_object('role', 'security', 'by_migration', true)); end if;
    update public.helm_hq_settings set r27_seeded_at = now() where id;
  end if;
  select string_agg(pa.email, ', ' order by pa.email) into v_others from public.platform_admins pa
   where pa.email not in ('admin@helm.events', 'k9@helm.events', 'sales@helm.events', 'security@helm.events') and pa.status <> 'removed';
  if v_others is not null then
    raise notice '0277: other HQ operators kept with full access as Admin - please review them in HQ -> Staff access: %', v_others;
  end if;
end $$;
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 roles + status columns with checks', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'platform_admins' and column_name = 'role')
     and exists (select 1 from pg_constraint where conrelid = 'public.platform_admins'::regclass and conname = 'platform_admins_status_chk')),
  ('02 at least one ACTIVE Owner', exists (select 1 from public.platform_admins where role = 'owner' and status = 'active')),
  ('03 nobody lost access: every pre-0277 operator is active (Owner or Admin)', not exists (select 1 from public.platform_admins
     where invited_at is null and status <> 'active' and removed_at is null and suspended_at is null)),
  ('04 the gates are the r27 ones (role checked in every HQ function)',
     position('r27-hq-staff-0277' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._hq_gate(text,text)')), '')) > 0
     and position('r27-hq-staff-0277' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._hq_wgate(text,text,text,jsonb)')), '')) > 0
     and position('r27-hq-staff-0277' in coalesce((select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.is_platform_admin()')), '')) > 0),
  ('05 two-step always required for HQ', public._hq_require_mfa()),
  ('06 every HQ function a signed-in user can call goes through a gate', not exists (select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname like 'hq\_%' and p.proname <> 'hq_me'
       and has_function_privilege('authenticated', p.oid, 'execute')
       and p.prosrc !~ '(_hq_gate|_hq_wgate|_hq27_require|_hq_studio_detail_core|hq_staff_invite|hq_staff_remove)\(')),
  ('07 new staff functions: signed-in only, never anon', has_function_privilege('authenticated', 'public.hq_staff_invite(text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_staff_invite(text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_me()', 'execute')
     and not has_function_privilege('authenticated', 'public._hq27_require(text,boolean)', 'execute')),
  ('08 new tables private (RLS on, no app access)', (select bool_and(c.relrowsecurity) from pg_class c
     where c.oid in ('public.hq_staff_events'::regclass, 'public.hq_staff_sessions'::regclass, 'public.hq_staff_activity'::regclass, 'public.hq_session_revocations'::regclass))
     and not has_table_privilege('authenticated', 'public.hq_staff_sessions', 'select')),
  ('09 last-Owner guard + append-only triggers', exists (select 1 from pg_trigger where tgname = 'a277_last_owner')
     and exists (select 1 from pg_trigger where tgname = 'a277_append_only' and tgrelid = 'public.hq_staff_events'::regclass)),
  ('10 staff e-mails can be queued (outbox kind hq_staff + claim branch)',
     position('''hq_staff''' in coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check'), '''hq_staff''')) > 0
     and position('r27-hq-staff-0277' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0),
  ('11 session rules set (idle 5-240 min, max 1-24 h), IP allowlist OFF unless chosen', exists (select 1 from public.helm_hq_settings s
     where s.id and s.hq_idle_minutes between 5 and 240 and s.hq_max_hours between 1 and 24)),
  ('12 admin@helm.events = Owner (' || coalesce((select role || ', ' || status from public.platform_admins where email = 'admin@helm.events'), 'missing') || ')',
     exists (select 1 from public.platform_admins where email = 'admin@helm.events' and role = 'owner' and status = 'active')),
  ('12b k9@helm.events = second Owner (' || coalesce((select role || ', ' || status from public.platform_admins where email = 'k9@helm.events'), 'missing') || '; invited = waits for its first sign-in + two-step)',
     exists (select 1 from public.platform_admins where email = 'k9@helm.events' and role = 'owner' and status in ('invited', 'active'))),
  ('12c k9@helm.events / sales@ / security@ may sign up on helm.events (reserved-domain rules); other helm.events addresses may not',
     to_regprocedure('public.email_is_reserved(text)') is null
     or (public.signup_email_preauthorised('k9@helm.events') and public.signup_email_preauthorised('sales@helm.events')
         and public.signup_email_preauthorised('security@helm.events') and not public.signup_email_preauthorised('nobody-r27@helm.events'))),
  ('13 security@helm.events = Security (' || coalesce((select role || ', ' || status from public.platform_admins where email = 'security@helm.events'), 'missing') || ')',
     exists (select 1 from public.platform_admins where email = 'security@helm.events' and role = 'security' and status in ('active', 'invited'))),
  ('14 sales@helm.events = Sales (' || coalesce((select role || ', ' || status from public.platform_admins where email = 'sales@helm.events'), 'missing') || '; invited = waits for its first sign-in)',
     exists (select 1 from public.platform_admins where email = 'sales@helm.events' and role = 'sales' and status in ('invited', 'active'))),
  ('15 the four HQ accounts were set once (a re-run changes nobody)', (select r27_seeded_at from public.helm_hq_settings where id) is not null),
  ('16 INFO other HQ operators kept as Admin - review in HQ -> Staff access: ' || coalesce((select string_agg(pa.email || ' (' || pa.role || ')', ', ' order by pa.email)
     from public.platform_admins pa where pa.email not in ('admin@helm.events', 'k9@helm.events', 'sales@helm.events', 'security@helm.events') and pa.status <> 'removed'), 'none'), true)
) v(item, ok) order by item;
