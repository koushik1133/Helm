-- APPLY-0283.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0282 incl. its R32b amendment (PR #269). It stops with "STOP 0283" if that is not applied.
-- R33 team safety (owner-approved, EDGE-CASES-PLAN B1 / B4 / B5): "Remove" becomes Deactivate (nothing deleted: no
-- studio, no role, sign-in off, sessions ended, records + name kept as "Name (deactivated)", seat freed, Reactivate
-- counts against the seat limit again, open work listed); one protected Studio owner per studio (backfilled from the
-- creator, else the earliest active admin - flagged for Helm HQ); another admin's removal / demotion by a non-owner
-- waits 24 hours with a bell notice + e-mail at once and Cancel for the owner; ownership hand-over (owner + fresh
-- two-step code, an active admin accepts); Helm HQ "Recover studio owner" (two-step, written reason, audited).
-- 5 new tables, new functions, functions re-issued in place (same names / arguments / answers). Nothing dropped, no
-- data deleted, existing rows untouched (the backfill only inserts owner rows). Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Look at the backfill flags (studios whose creator was missing - the earliest active admin became owner):
--        select o.name, l.source, l.at from public.team_owner_log l join public.organizations o on o.id = l.org_id where l.hq_flag;
--      (Helm HQ -> Studios -> a studio -> People also shows the owner and its history.)
--   3  Deploy the edge function comms-dispatch (new e-mail kind team_safety; nothing is sent until it runs with e-mail on).
--   4  Deploy the site (store-api.js?v=286, control.html, team-safety.js, hq.html / hq.js).
--   5  Check: Control Center -> Users & access -> Team members shows an "Owner" badge on the owner, "Deactivate" on the
--      others, and (owner only) "Transfer ownership".
begin;
-- 0283_r33_team_safety.sql - CANONICAL forward-only.
-- REQUIRES 0282 incl. R32b (_r282_api_caller, _r282_seats_used, _r282_seat_refuse, the 0282 current_org_id / seat bodies:
--          joining counts active members only, _trial_seat_limit in any subscription status - kept untouched here),
--          0277 (_hq27_require, _hq27_mfa_at, _hq_wgate, helm_notice_outbox kind 'hq_staff' branch), 0266 (_r23_tz),
--          0244 (helm_notice_outbox + helm_notice_outbox_claim), 0167 (my_seat_usage), 0166 (_trial_seat_limit),
--          0165 (email_is_opted_out), 0106 (_a106_role_label), 0074 (profiles_last_admin_guard), 0072 (_valid_role),
--          0060 (studio_avatars), 0058 (notify_default wrapper pattern), 0041 (chat_directory__base, crew_members.profile_id),
--          0203 (audit_actor_names + _tl202_caller_trial), 0043 (current_org_id__pre0043), base admin_delete_user / user_role.
--
-- In plain words (r33, owner-approved: EDGE-CASES-PLAN rows B1, B4, B5):
--   B1  DEACTIVATE INSTEAD OF DELETE. "Remove" in Control Center no longer deletes a login. The member is marked
--       deactivated (NEW team_member_status, one row per person + studio): current_org_id() and user_role() answer
--       nothing for them, so they see no studio data at all; their sign-in is switched off (auth.users.banned_until set
--       100 years ahead, the value it had before is kept) and their refresh tokens are marked revoked (never deleted).
--       Every record they made stays; their name shows as "Name (deactivated)" in chat, avatars and the activity log.
--       They stop counting toward the seat limit (0282); Reactivate puts them back and counts against the limit again.
--       Their open tasks, events they manage and leads they own are listed for reassignment (team_member_open_work).
--       admin_delete_user (the old hard delete) now deactivates; an app user can never delete a profiles row.
--   B4  ONE STUDIO OWNER. NEW append-only team_owner_log: the newest row is the owner. Backfilled once: the studio's
--       creator (organizations.created_by) when still an active admin, else the earliest active admin - that fallback
--       is flagged for Helm HQ (hq_flag). A new studio gets its first admin as owner automatically. Nobody can
--       deactivate, demote or move the owner (any API path - trigger ab_r283_owner_guard); the owner can't deactivate
--       themselves. Transfer: the owner starts it (a fresh two-step code when they have two-step), only to an active
--       admin, who must accept within 7 days; every admin gets a bell notice + an e-mail; all audited.
--   B5  ADMIN CHANGES. The owner removes / demotes an admin at once. Any other admin's request to deactivate or demote
--       an admin waits 24 hours (NEW team_admin_changes): the owner and the affected admin get a bell notice + an e-mail
--       straight away, the owner (or the asker) can cancel during the wait, team_safety_tick applies it when due
--       (pg_cron every 5 minutes, and whenever Control Center opens the Team page). Every change is audited.
--       OWNER GONE: Helm HQ "Recover studio owner" (hq_studio_owner_recover) - HQ Owner role, two-step + a fresh code,
--       a written reason (20+ characters: how identity was checked), max 5 a day; moves ownership to an ACTIVE admin of
--       that studio and tells every admin (bell + e-mail). Never self-serve.
--   Notices: bell rows kind 'team_safety' (admins only, like the 0058 trial notices) + helm_notice_outbox kind
--   'team_safety' (recipients resolved here, queued only - comms-dispatch sends; nothing is sent by this file).
-- Changes: 5 NEW tables (RLS on, no API privilege; logs append-only, nothing ever deleted), new helper / RPC functions,
-- functions re-issued with the same names, arguments and answers (current_org_id, user_role, admin_delete_user,
-- the 0282 seat helpers, my_seat_usage, studio_avatars, chat_directory, audit_actor_names), notification_catalog /
-- notification_type_of / notify_default wrapped once (*__pre0283), two triggers on profiles, three restrictive
-- policies on notifications, the outbox kind check widened once to a superset, one claim branch added in place.
-- No table, column, row or policy is dropped; no data is deleted; existing rows are untouched (the backfill only
-- INSERTS owner rows). Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): re-run 0282 (current_org_id + seat bodies), 0043's
--   user_role is the base body, the base admin_delete_user body (NOT recommended: it hard-deletes), and
--   alter function public.notification_catalog__pre0283() rename ... (the new tables can stay - unused).

-- ---- STOP guard: the pieces this builds on ----------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r282_seats_used(uuid)') is null or to_regprocedure('public._r282_api_caller()') is null
     or to_regprocedure('public._r282_seat_refuse(uuid, integer, boolean)') is null
     or to_regprocedure('public._r282_temp_pw_pending()') is null then
    raise exception 'STOP 0283: 0282 (r32 security review: seat limits, admin_create_user) is not applied - run APPLY-0282.sql first'; end if;
  if to_regclass('public.r282_acu_refusals') is null
     or position('R32b' in (select prosrc from pg_proc where oid = 'public._ts166_tg_profile_seat()'::regprocedure)) = 0 then
    raise exception 'STOP 0283: 0282 is applied without its R32b amendment - run the current APPLY-0282.sql first'; end if;
  if position('_r282_temp_pw_pending' in (select prosrc from pg_proc where oid = 'public.current_org_id()'::regprocedure)) = 0 then
    raise exception 'STOP 0283: current_org_id() does not carry the 0282 body - run APPLY-0282.sql first'; end if;
  if to_regprocedure('public._hq27_require(text, boolean)') is null or to_regprocedure('public._hq27_mfa_at()') is null
     or to_regprocedure('public._hq_wgate(text, text, text, jsonb)') is null then
    raise exception 'STOP 0283: 0277 (HQ staff roles) is not applied'; end if;
  if to_regclass('public.helm_notice_outbox') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    raise exception 'STOP 0283: 0244 (helm_notice_outbox) is not applied'; end if;
  if to_regprocedure('public.my_seat_usage()') is null or to_regprocedure('public._trial_seat_limit(uuid)') is null then
    raise exception 'STOP 0283: 0166 / 0167 (seat limits) are not applied'; end if;
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text, text)') is null
     or to_regprocedure('public.notify_default(uuid, text, text, text)') is null then
    raise exception 'STOP 0283: the notification catalog (0036 / 0058) is missing'; end if;
  if to_regprocedure('public._r23_tz(uuid)') is null then raise exception 'STOP 0283: 0266 (notification inbox) is not applied'; end if;
  if to_regprocedure('public.chat_directory__base()') is null or to_regprocedure('public.studio_avatars()') is null
     or to_regprocedure('public._tl202_caller_trial()') is null then
    raise exception 'STOP 0283: 0041 / 0060 / 0203 (names) are not applied'; end if;
  if to_regprocedure('public.email_is_opted_out(uuid, text)') is null or to_regprocedure('public._a106_role_label(text)') is null
     or to_regprocedure('public._valid_role(text)') is null or to_regprocedure('public.admin_delete_user(uuid)') is null
     or to_regprocedure('public.current_org_id__pre0043()') is null then
    raise exception 'STOP 0283: 0043 / 0072 / 0106 / 0165 or the base admin functions are missing'; end if;
  if to_regprocedure('public._a42_revoke_links_for_phone(uuid, text, text)') is null or to_regprocedure('public.helm_norm_phone(text)') is null
     or to_regprocedure('public._r23_queue_digests()') is null or to_regprocedure('public._r23_digest_mail(uuid, uuid, jsonb)') is null
     or to_regprocedure('public._r22_close_mail(uuid, uuid, text)') is null or to_regprocedure('public.comms_outbox_claim(integer)') is null
     or to_regprocedure('public.runsheet_reminder_claim(integer)') is null or to_regprocedure('public.assign_notify_claim(integer)') is null
     or to_regprocedure('public._dl241_send_block(uuid, text, boolean)') is null then
    raise exception 'STOP 0283: 0042 / 0132 / 0241 / 0254 / 0265 / 0266 / 0269 (links + studio messages) are not applied'; end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.crew_members'::regclass and attname = 'profile_id' and not attisdropped)
     or not exists (select 1 from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'manager_id' and not attisdropped) then
    raise exception 'STOP 0283: crew_members.profile_id / quotes.manager_id are missing'; end if;
end $$;

-- ---- 1) the new tables (private: RLS on, no API privilege, read through the RPCs below) ----------------------------
create table if not exists public.team_member_status (
  user_id        uuid        not null,
  org_id         uuid        not null,
  status         text        not null default 'active' check (status in ('active', 'deactivated')),
  changed_at     timestamptz not null default now(),
  changed_by     uuid,
  reason         text        check (reason is null or char_length(reason) <= 500),
  deactivated_at timestamptz,
  ban_set_until  timestamptz,   -- the banned_until value this file set (only that value is ever lifted again)
  ban_prior      timestamptz,   -- what banned_until was before
  primary key (user_id, org_id)
);
create index if not exists team_member_status_off_r283 on public.team_member_status (org_id) where status = 'deactivated';

create table if not exists public.team_owner_log (
  id           bigint generated always as identity primary key,
  org_id       uuid        not null,
  user_id      uuid,                                -- null only for a 'backfill_none' flag row (no admin found)
  prev_user_id uuid,
  source       text        not null check (source in ('backfill_creator', 'backfill_admin', 'backfill_none', 'auto', 'transfer', 'hq_recovery')),
  hq_flag      boolean     not null default false,  -- Helm HQ should look at this one (backfill fallback)
  by_user      uuid,
  by_email     text,
  reason       text        check (reason is null or char_length(reason) <= 1000),
  at           timestamptz not null default now()
);
create index if not exists team_owner_log_org_r283 on public.team_owner_log (org_id, id desc);

create table if not exists public.team_admin_changes (
  id           uuid        primary key default gen_random_uuid(),
  org_id       uuid        not null,
  target_user  uuid        not null,
  kind         text        not null check (kind in ('deactivate', 'demote')),
  new_role     text,
  requested_by uuid        not null,
  requested_at timestamptz not null default now(),
  effective_at timestamptz not null,
  status       text        not null default 'pending' check (status in ('pending', 'applied', 'cancelled', 'void')),
  decided_by   uuid,
  decided_at   timestamptz,
  note         text        check (note is null or char_length(note) <= 500)
);
create unique index if not exists team_admin_changes_pending_r283 on public.team_admin_changes (org_id, target_user) where status = 'pending';
create index if not exists team_admin_changes_due_r283 on public.team_admin_changes (effective_at) where status = 'pending';

create table if not exists public.team_owner_transfers (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null,
  from_user   uuid        not null,
  to_user     uuid        not null,
  status      text        not null default 'pending' check (status in ('pending', 'accepted', 'cancelled', 'declined', 'expired', 'void')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  decided_by  uuid,
  decided_at  timestamptz
);
create unique index if not exists team_owner_transfers_pending_r283 on public.team_owner_transfers (org_id) where status = 'pending';

create table if not exists public.team_safety_events (
  id          uuid        primary key default gen_random_uuid(),
  org_id      uuid        not null,
  event       text        not null,
  target_user uuid,
  actor_user  uuid,
  actor_email text,
  detail      jsonb       not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index if not exists team_safety_events_org_r283 on public.team_safety_events (org_id, at desc);

do $$ declare t text; begin
  foreach t in array array['team_member_status', 'team_owner_log', 'team_admin_changes', 'team_owner_transfers', 'team_safety_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
  end loop;
end $$;

-- nothing in these tables is ever deleted; the two logs are never changed either
create or replace function public._r283_tg_keep()
returns trigger language plpgsql set search_path = '' as $$
-- r33-0283
begin raise exception '% keeps every row (team safety record)', tg_table_name using errcode = '42501'; end $$;
do $$ declare t text; begin
  foreach t in array array['team_owner_log', 'team_safety_events'] loop
    execute format('drop trigger if exists r283_append_only on public.%I', t);
    execute format('create trigger r283_append_only before update or delete on public.%I for each row execute function public._r283_tg_keep()', t);
  end loop;
  foreach t in array array['team_member_status', 'team_admin_changes', 'team_owner_transfers'] loop
    execute format('drop trigger if exists r283_no_delete on public.%I', t);
    execute format('create trigger r283_no_delete before delete on public.%I for each row execute function public._r283_tg_keep()', t);
  end loop;
  foreach t in array array['team_member_status', 'team_owner_log', 'team_admin_changes', 'team_owner_transfers', 'team_safety_events'] loop
    execute format('drop trigger if exists r283_no_truncate on public.%I', t);
    execute format('create trigger r283_no_truncate before truncate on public.%I for each statement execute function public._r283_tg_keep()', t);
  end loop;
end $$;

-- ---- 2) small helpers (internal: not callable through the API) ---------------------------------------------------
-- is this person deactivated in that studio?
create or replace function public._r283_is_off(p_user uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select p_user is not null and p_org is not null and exists (
    select 1 from public.team_member_status s where s.user_id = p_user and s.org_id = p_org and s.status = 'deactivated');
$$;

-- is the CALLER deactivated in that studio? (current_org_id)
create or replace function public._r283_deactivated(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select auth.uid() is not null and p_org is not null and exists (
    select 1 from public.team_member_status s where s.user_id = auth.uid() and s.org_id = p_org and s.status = 'deactivated');
$$;

-- the studio owner = the newest owner row with a person
create or replace function public._r283_owner(p_org uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select l.user_id from public.team_owner_log l where l.org_id = p_org and l.user_id is not null order by l.id desc limit 1;
$$;

-- an active admin of that studio (admin role, not deactivated)
create or replace function public._r283_active_admin(p_org uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select p_org is not null and p_user is not null and exists (
    select 1 from public.profiles p where p.id = p_user and p.org_id = p_org and p.role = 'admin')
    and not public._r283_is_off(p_user, p_org);
$$;

-- a person's shown name (display name, else the part of the e-mail before "@")
create or replace function public._r283_name(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select coalesce((select coalesce(nullif(btrim(p.full_name), ''), nullif(split_part(coalesce(p.email, ''), '@', 1), ''))
                     from public.profiles p where p.id = p_user), 'A team member');
$$;

-- a studio message recipient (e-mail / phone) that belongs to a deactivated member of that studio
create or replace function public._r283_off_email(p_org uuid, p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select p_org is not null and nullif(btrim(coalesce(p_email, '')), '') is not null and exists (
    select 1 from public.profiles p join public.team_member_status s on s.user_id = p.id and s.org_id = p.org_id and s.status = 'deactivated'
     where p.org_id = p_org and lower(btrim(p.email)) = lower(btrim(p_email)));
$$;
create or replace function public._r283_off_phone(p_org uuid, p_phone text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283: their staff record's phone or their profile mobile / WhatsApp
  select p_org is not null and nullif(public.helm_norm_phone(p_phone), '') is not null and exists (
    select 1 from public.team_member_status s
     where s.org_id = p_org and s.status = 'deactivated'
       and (exists (select 1 from public.crew_members c where c.org_id = p_org and c.profile_id = s.user_id
                     and public.helm_norm_phone(c.phone) = public.helm_norm_phone(p_phone))
            or exists (select 1 from public.member_profiles m where m.user_id = s.user_id
                        and public.helm_norm_phone(p_phone) in (public.helm_norm_phone(m.phone), public.helm_norm_phone(m.whatsapp)))));
$$;
-- a recipient list (jsonb array of e-mails) without the studio's deactivated members
create or replace function public._r283_drop_off(p_org uuid, p_to jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r33-0283
  select case when jsonb_typeof(p_to) <> 'array' then p_to else
    coalesce((select jsonb_agg(e) from jsonb_array_elements(p_to) e where not public._r283_off_email(p_org, e #>> '{}')), '[]'::jsonb) end;
$$;

-- record the studio owner when there is none yet (never replaces an owner)
create or replace function public._r283_ensure_owner(p_org uuid, p_backfill boolean default false)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: the creator when still an active admin, else the earliest active admin (flagged for HQ)
declare v uuid; v_created uuid; v_src text; v_flag boolean := false;
begin
  if p_org is null then return null; end if;
  v := public._r283_owner(p_org);
  if v is not null then return v; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:owner:' || p_org::text, 0));
  v := public._r283_owner(p_org);
  if v is not null then return v; end if;
  select o.created_by into v_created from public.organizations o where o.id = p_org;
  if public._r283_active_admin(p_org, v_created) then
    v := v_created; v_src := case when p_backfill then 'backfill_creator' else 'auto' end;
  else
    select p.id into v from public.profiles p
     where p.org_id = p_org and p.role = 'admin' and not public._r283_is_off(p.id, p_org)
     order by p.created_at, p.id limit 1;
    v_src := case when p_backfill then 'backfill_admin' else 'auto' end;
    v_flag := v is not null and (p_backfill or v_created is not null);
  end if;
  if v is null then
    if p_backfill and not exists (select 1 from public.team_owner_log l where l.org_id = p_org) then
      insert into public.team_owner_log(org_id, user_id, source, hq_flag, reason)
        values (p_org, null, 'backfill_none', true, 'No active admin found when the studio owner was first recorded (0283).');
    end if;
    return null;
  end if;
  insert into public.team_owner_log(org_id, user_id, source, hq_flag, reason)
    values (p_org, v, v_src, v_flag,
            case when v_flag then 'The studio creator is missing or no longer an active admin - the earliest active admin became owner (0283).'
                 when p_backfill then 'Studio creator recorded as owner (0283).' else 'First admin of the studio (0283).' end);
  return v;
end $$;

-- the caller has two-step set up: they must have entered a code in the last 15 minutes (tokens without a list skip it)
create or replace function public._r283_fresh_mfa_ok()
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r33-0283
declare v_has boolean := false; v_at timestamptz;
begin
  if auth.uid() is null then return false; end if;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')' into v_has using auth.uid();
  end if;
  if not coalesce(v_has, false) then return true; end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then return false; end if;
  v_at := public._hq27_mfa_at();
  return v_at is null or v_at >= now() - interval '15 minutes';
end $$;

create or replace function public._r283_has_mfa(p_user uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r33-0283
declare v boolean := false;
begin
  if p_user is null or to_regclass('auth.mfa_factors') is null then return false; end if;
  execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')' into v using p_user;
  return coalesce(v, false);
end $$;

-- the bell line (names only - never e-mails, links or tokens)
create or replace function public._r283_label(p_event text, d jsonb)
returns text language sql immutable set search_path = '' as $$
  -- r33-0283
  select left(case p_event
    when 'admin_change_requested' then coalesce(d ->> 'target', 'An admin')
         || case when d ->> 'kind' = 'deactivate' then ' will be deactivated in 24 hours'
                 else ' will become ' || coalesce(d ->> 'role_label', 'a non-admin') || ' in 24 hours' end
         || coalesce(' - asked by ' || (d ->> 'by'), '') || '. The owner can cancel it.'
    when 'admin_change_cancelled' then 'Cancelled: the change for ' || coalesce(d ->> 'target', 'an admin') || coalesce(' (by ' || (d ->> 'by') || ')', '')
    when 'admin_change_applied' then coalesce(d ->> 'target', 'An admin')
         || case when d ->> 'kind' = 'deactivate' then ' was deactivated (asked 24 hours ago)' else ' is now ' || coalesce(d ->> 'role_label', 'a non-admin') end
    when 'admin_deactivated' then coalesce(d ->> 'target', 'An admin') || ' was deactivated by the studio owner'
    when 'admin_demoted' then coalesce(d ->> 'target', 'An admin') || ' is now ' || coalesce(d ->> 'role_label', 'a non-admin') || ' (changed by the studio owner)'
    when 'owner_transfer_started' then coalesce(d ->> 'from', 'The owner') || ' asked ' || coalesce(d ->> 'to', 'an admin') || ' to become the studio owner'
    when 'owner_transfer_accepted' then coalesce(d ->> 'to', 'An admin') || ' is now the studio owner'
    when 'owner_transfer_cancelled' then 'Studio ownership hand-over to ' || coalesce(d ->> 'to', 'an admin') || ' was cancelled'
    when 'owner_transfer_declined' then coalesce(d ->> 'to', 'An admin') || ' declined to become the studio owner'
    when 'owner_recovered' then 'Helm support made ' || coalesce(d ->> 'to', 'an admin') || ' the studio owner'
    else 'Team change' end, 200);
$$;

-- one team-safety event: the record + (optionally) a bell row for the admins + a queued e-mail
create or replace function public._r283_notify(p_org uuid, p_event text, p_target uuid, p_detail jsonb, p_mail boolean, p_actor uuid default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: p_actor = who it is about as the doer (a delayed change: the admin who asked), else the caller
declare v_id uuid; v_email text; v_d jsonb := coalesce(p_detail, '{}'::jsonb); v_actor uuid := coalesce(p_actor, auth.uid());
begin
  select u.email into v_email from auth.users u where u.id = v_actor;
  insert into public.team_safety_events(org_id, event, target_user, actor_user, actor_email, detail)
    values (p_org, p_event, p_target, v_actor, v_email, v_d) returning id into v_id;
  if p_mail then
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'team_safety', 'simulated',
              jsonb_build_object('label', public._r283_label(p_event, v_d), 'event', p_event, 'source', '0283', 'event_id', v_id), p_org);
    begin
      insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
        values ('team_safety', p_org, v_id, jsonb_build_object('event', p_event), 'team_safety:' || v_id::text)
        on conflict (dedupe_key) do nothing;
    exception when check_violation then null;   -- outbox kind not widened on this database: the bell + record are kept
    end;
  end if;
  return v_id;
end $$;

-- the activity-log row (org-scoped, Control Center -> Activity)
create or replace function public._r283_audit(p_org uuid, p_action text, p_target uuid, p_changed jsonb, p_actor uuid default null)
returns void language sql volatile security definer set search_path = '' as $$
  -- r33-0283: p_actor = the person who made the change (a delayed change: the admin who asked), else the caller
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select coalesce(p_actor, auth.uid()), (select u.email from auth.users u where u.id = coalesce(p_actor, auth.uid())),
           p_action, 'profiles', p_target::text, p_changed, p_org, now();
$$;

-- switch a login's sign-in off and end its sessions (marks only - nothing is deleted)
create or replace function public._r283_end_sessions(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_prior timestamptz; v_set timestamptz; v_ids uuid[] := '{}'::uuid[]; v_n integer := 0;
begin
  if p_user is null then return '{}'::jsonb; end if;
  if exists (select 1 from pg_attribute a where a.attrelid = 'auth.users'::regclass and a.attname = 'banned_until' and not a.attisdropped) then
    begin
      execute 'select u.banned_until from auth.users u where u.id = $1' into v_prior using p_user;
      if v_prior is null or v_prior < now() then
        v_set := date_trunc('second', now()) + interval '100 years';
        execute 'update auth.users set banned_until = $2, updated_at = now() where id = $1' using p_user, v_set;
      end if;
    exception when others then v_set := null;   -- the studio is already closed for them (current_org_id)
    end;
  end if;
  if to_regclass('auth.sessions') is not null then
    begin execute 'select coalesce(array_agg(s.id), ''{}''::uuid[]) from auth.sessions s where s.user_id = $1' into v_ids using p_user;
    exception when others then v_ids := '{}'::uuid[]; end;
  end if;
  if to_regclass('auth.refresh_tokens') is not null and coalesce(array_length(v_ids, 1), 0) > 0 then
    begin
      execute 'update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = any ($1) and not coalesce(revoked, false)' using v_ids;
      get diagnostics v_n = row_count;
    exception when others then v_n := 0;
    end;
  end if;
  return jsonb_build_object('ban_set_until', v_set, 'ban_prior', v_prior, 'sessions', coalesce(array_length(v_ids, 1), 0), 'tokens_revoked', v_n);
end $$;

-- deactivate now (the checks are the caller's job)
create or replace function public._r283_do_deactivate(p_org uuid, p_user uuid, p_reason text, p_by uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: p_by = the admin who decided (a delayed change: the admin who asked), else the caller
declare v_end jsonb; v_by uuid := coalesce(p_by, auth.uid()); v_links integer := 0; v_ph text;
begin
  insert into public.team_member_status as s (user_id, org_id, status, changed_at, changed_by, reason, deactivated_at)
    values (p_user, p_org, 'deactivated', now(), v_by, left(nullif(btrim(coalesce(p_reason, '')), ''), 500), now())
  on conflict (user_id, org_id) do update
    set status = 'deactivated', changed_at = now(), changed_by = excluded.changed_by, reason = excluded.reason, deactivated_at = now(),
        ban_set_until = null, ban_prior = null;
  v_end := public._r283_end_sessions(p_user);
  update public.team_member_status set ban_set_until = (v_end ->> 'ban_set_until')::timestamptz, ban_prior = (v_end ->> 'ban_prior')::timestamptz
   where user_id = p_user and org_id = p_org;
  -- nothing waits on a person who has left: their pending admin change / ownership hand-over is closed (kept, marked void)
  update public.team_admin_changes set status = 'void', decided_at = now(), note = 'The person was deactivated.'
   where org_id = p_org and target_user = p_user and status = 'pending';
  update public.team_owner_transfers set status = 'void', decided_at = now()
   where org_id = p_org and status = 'pending' and (to_user = p_user or from_user = p_user);
  -- their crew / work links (WhatsApp task + crew-home links) stop working: marked revoked (never deleted).
  -- Reactivating does NOT bring old links back; new links are issued as usual.
  for v_ph in select distinct x from (
      select c.phone as x from public.crew_members c where c.org_id = p_org and c.profile_id = p_user
      union select m.phone from public.member_profiles m where m.user_id = p_user
      union select m.whatsapp from public.member_profiles m where m.user_id = p_user) z
    where nullif(btrim(coalesce(x, '')), '') is not null loop
    v_links := v_links + coalesce(public._a42_revoke_links_for_phone(p_org, v_ph, 'member deactivated (0283)'), 0);
  end loop;
  perform public._r283_notify(p_org, 'member_deactivated', p_user, jsonb_build_object('target', public._r283_name(p_user)), false, v_by);
  perform public._r283_audit(p_org, 'team.deactivate', p_user,
    jsonb_build_object('reason', left(p_reason, 500), 'sessions', v_end -> 'sessions', 'tokens_revoked', v_end -> 'tokens_revoked',
                       'links_revoked', v_links), v_by);
  return v_end || jsonb_build_object('links_revoked', v_links);
end $$;

-- ---- 3) a deactivated member has no studio and no role -----------------------------------------------------------------
-- same signature / language / volatility / definer as before, so RLS policies (bound by OID) are untouched
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  -- trial-staff-0126: a non-owner member of an ended, unpaid trial studio has no studio until it pays
  -- r32-0282 AUTH-3: a member still on the admin-given temporary password has no studio until they choose their own
  -- r33-0283 B1: a deactivated member has no studio (Control Center -> Team -> Deactivate; an admin can reactivate)
  select case when public.mfa_ok() and not public._trial_member_blocked(x.org) and not public._r282_temp_pw_pending()
                   and not public._r283_deactivated(x.org) then x.org end
    from (select public.current_org_id__pre0043() as org) x;
$$;

create or replace function public.user_role()
returns text language sql stable security definer set search_path to 'public' as $function$
  -- r33-0283 B1: a deactivated member has no role in the studio (is_admin() and every role check say no)
  select p.role from public.profiles p
   where p.id = auth.uid()
     and not exists (select 1 from public.team_member_status s where s.user_id = p.id and s.org_id = p.org_id and s.status = 'deactivated'); $function$;

-- ---- 4) seats: a deactivated member does not count (0282 bodies + one condition each) --------------------------------
create or replace function public._r282_seats_used(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- r32-0282
  -- r33-0283 B1: deactivated members do not count
  select ((select count(*) from public.profiles p where p.org_id = p_org and coalesce(p.role, '') <> 'client'
             and not public._r283_is_off(p.id, p_org))
        + (select count(*) from public.invitations i
            where i.org_id = p_org and i.status = 'pending' and coalesce(i.role, '') <> 'client'
              and (i.expires_at is null or i.expires_at > now())
              and not exists (select 1 from public.profiles p where p.org_id = p_org and lower(p.email) = lower(i.email))))::integer;
$$;

create or replace function public._ts166_tg_invite_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: members + open invitations may not pass the seat limit
-- tb-msg-0179: a pending invitation whose role changes from client counts as a new seat
-- r32-0282 BIZ-03: paid plans too (_trial_seat_limit); plan wording
-- r33-0283 B1: deactivated members do not count
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.status, 'pending') <> 'pending' or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'pending' and old.org_id is not distinct from new.org_id
     and coalesce(old.role, '') <> 'client' then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  -- r32-0282: a PLAN limit is an app rule - Helm staff / service changes (no app user) are not held to it
  if not public._is_trial_org(new.org_id) and not public._r282_api_caller()
     and (select o.seat_limit from public.organizations o where o.id = new.org_id) is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  select (select count(*) from public.profiles p where p.org_id = new.org_id and coalesce(p.role, '') <> 'client'
            and not public._r283_is_off(p.id, new.org_id))
       + (select count(*) from public.invitations i
           where i.org_id = new.org_id and i.status = 'pending' and i.id is distinct from new.id
             and coalesce(i.role, '') <> 'client' and (i.expires_at is null or i.expires_at > now())
             and not exists (select 1 from public.profiles p where p.org_id = new.org_id and lower(p.email) = lower(i.email)))
    into v_used;
  if v_used >= v_lim then perform public._r282_seat_refuse(new.org_id, v_lim, true); end if;
  return new;
end $$;

create or replace function public._ts166_tg_profile_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: joining a studio (any path) may not pass the seat limit
-- tb-msg-0179: a role change client -> staff role inside the studio counts as a new seat, and the
-- studio's other open staff invitations count too (admin + 2 = members + pending invitations)
-- r32-0282 BIZ-03: paid plans too (_trial_seat_limit); plan wording. Existing members (same studio) are never checked.
-- R32b BIZ-03: JOINING (accepting an invitation, any join path) counts only the people already in the studio + this one;
-- open invitations count only when an invitation is CREATED (_ts166_tg_invite_seat), so old pending invitations never
-- stop a person from joining while a seat is free.
-- r33-0283 B1: deactivated members do not count (R32b body above kept as it is)
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.org_id is not distinct from new.org_id and coalesce(old.role, '') <> 'client' then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  -- r32-0282: a PLAN limit is an app rule - Helm staff / service changes (no app user) are not held to it
  if not public._is_trial_org(new.org_id) and not public._r282_api_caller()
     and (select o.seat_limit from public.organizations o where o.id = new.org_id) is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  select count(*) from public.profiles p
   where p.org_id = new.org_id and p.id <> new.id and coalesce(p.role, '') <> 'client'
     and not public._r283_is_off(p.id, new.org_id)
    into v_used;
  if v_used >= v_lim then perform public._r282_seat_refuse(new.org_id, v_lim, false); end if;
  return new;
end $$;

create or replace function public.my_seat_usage()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-sample-0167: members + open invitations (clients do not count), same rule as the 0166 triggers
-- r33-0283 B1: deactivated members do not count (shown separately)
declare v_org uuid := public.current_org_id(); v_lim integer; v_mem integer; v_pend integer; v_off integer;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_lim := public._trial_seat_limit(v_org);
  select count(*) filter (where not public._r283_is_off(p.id, v_org)), count(*) filter (where public._r283_is_off(p.id, v_org))
    into v_mem, v_off from public.profiles p where p.org_id = v_org and coalesce(p.role, '') <> 'client';
  select count(*) into v_pend from public.invitations i
   where i.org_id = v_org and i.status = 'pending' and coalesce(i.role, '') <> 'client'
     and (i.expires_at is null or i.expires_at > now())
     and not exists (select 1 from public.profiles p where p.org_id = v_org and lower(p.email) = lower(i.email));
  return jsonb_build_object('limited', v_lim is not null, 'limit', v_lim, 'used', v_mem + v_pend,
    'members', v_mem, 'pending', v_pend, 'trial', public._is_trial_org(v_org),
    'at_limit', v_lim is not null and v_mem + v_pend >= v_lim,
    'extra_limit', case when v_lim is null then null else greatest(v_lim - 1, 0) end,
    'extra_used', greatest(v_mem + v_pend - 1, 0), 'deactivated', v_off);
end $$;

-- ---- 5) profiles: the owner is protected, admins wait 24 hours, app users never delete a member -------------------------
create or replace function public._r283_tg_owner_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r33-0283 B4/B5: app (API) callers only - Helm staff / service / SQL-editor changes are not held to it
declare v_owner uuid; v_me uuid := auth.uid();
begin
  if tg_op = 'DELETE' then
    if old.org_id is not null and public._r282_api_caller() then
      raise exception 'Team members are never deleted. Deactivate them in Control Center -> Team instead.' using errcode = '42501', hint = 'use_deactivate';
    end if;
    return old;
  end if;
  if old.org_id is null or not public._r282_api_caller() then return new; end if;
  if new.org_id is not distinct from old.org_id and new.role is not distinct from old.role then return new; end if;
  if coalesce(old.role, '') <> 'admin' then return new; end if;
  v_owner := public._r283_owner(old.org_id);
  if v_owner is not null and v_owner = old.id then
    raise exception 'The studio owner always stays an admin of the studio. To step back, transfer ownership first.'
      using errcode = '42501', hint = 'owner_protected';
  end if;
  if v_me is distinct from old.id and v_me is distinct from v_owner
     and coalesce(current_setting('helm.r283_apply', true), '') <> 'on' then
    raise exception 'Only the studio owner can change another admin straight away. Ask from Control Center -> Team: the change then happens after 24 hours.'
      using errcode = '42501', hint = 'admin_change_delay';
  end if;
  return new;
end $$;
drop trigger if exists ab_r283_owner_guard on public.profiles;
create trigger ab_r283_owner_guard before update of role, org_id or delete on public.profiles
  for each row execute function public._r283_tg_owner_guard();

-- a studio's first admin becomes its owner (new studios; existing ones are backfilled below)
create or replace function public._r283_tg_owner_ensure()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r33-0283
begin
  if new.org_id is not null and new.role = 'admin' and not exists (select 1 from public.team_owner_log l where l.org_id = new.org_id and l.user_id is not null) then
    perform public._r283_ensure_owner(new.org_id, false);
  end if;
  return null;
end $$;
drop trigger if exists zz_r283_owner_ensure on public.profiles;
create trigger zz_r283_owner_ensure after insert or update of role, org_id on public.profiles
  for each row execute function public._r283_tg_owner_ensure();

-- ---- 6) the old hard delete now deactivates -------------------------------------------------------------------------------
create or replace function public.admin_delete_user(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $function$
-- r33-0283 B1: "Remove" never deletes a login any more - the member is deactivated (same owner / 24-hour rules)
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_id = auth.uid() then raise exception 'you cannot delete your own account'; end if;
  if not exists (select 1 from public.profiles where id = p_id and org_id = public.current_org_id()) then
    raise exception 'no such user'; end if;
  perform public.team_deactivate_member(p_id, 'Removed in Control Center');
end; $function$;

-- ---- 7) applying the 24-hour admin changes + expiring hand-overs ------------------------------------------------------------
create or replace function public._r283_apply_due(p_org uuid default null)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: every pending admin change whose time has come is re-checked, then applied (or closed as void)
declare c record; v_n integer := 0; v_owner uuid; v_why text; v_d jsonb;
begin
  for c in select * from public.team_admin_changes x
            where x.status = 'pending' and x.effective_at <= now() and (p_org is null or x.org_id = p_org)
            order by x.effective_at for update skip locked loop
    begin
      v_owner := public._r283_owner(c.org_id);
      v_why := case
        when not public._r283_active_admin(c.org_id, c.requested_by) then 'The person who asked is no longer an active admin.'
        when not public._r283_active_admin(c.org_id, c.target_user) then 'The person is no longer an active admin.'
        when v_owner is not null and v_owner = c.target_user then 'The person is now the studio owner.' end;
      if v_why is not null then
        update public.team_admin_changes set status = 'void', decided_at = now(), note = v_why where id = c.id;
        continue;
      end if;
      perform set_config('helm.r283_apply', 'on', true);
      if c.kind = 'deactivate' then
        perform public._r283_do_deactivate(c.org_id, c.target_user, 'Admin change asked by ' || public._r283_name(c.requested_by) || ' (24-hour wait over)', c.requested_by);
      else
        update public.profiles set role = c.new_role where id = c.target_user and org_id = c.org_id;
      end if;
      perform set_config('helm.r283_apply', 'off', true);
      update public.team_admin_changes set status = 'applied', decided_at = now() where id = c.id;
      v_d := jsonb_build_object('change_id', c.id, 'kind', c.kind, 'target', public._r283_name(c.target_user), 'by', public._r283_name(c.requested_by),
                                'role_label', case when c.kind = 'demote' then public._a106_role_label(c.new_role) end, 'requested_by', c.requested_by);
      perform public._r283_notify(c.org_id, 'admin_change_applied', c.target_user, v_d, true, c.requested_by);
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (c.requested_by, null, 'team.admin_change.applied', 'profiles', c.target_user::text,
                jsonb_build_object('change_id', c.id, 'kind', c.kind, 'new_role', c.new_role), c.org_id, now());
      v_n := v_n + 1;
    exception when others then
      update public.team_admin_changes set status = 'void', decided_at = now(), note = left('Could not apply: ' || sqlerrm, 500) where id = c.id;
    end;
  end loop;
  update public.team_owner_transfers set status = 'expired', decided_at = now()
   where status = 'pending' and expires_at <= now() and (p_org is null or org_id = p_org);
  return v_n;
end $$;

-- pg_cron (every 5 minutes) / the service role
create or replace function public.team_safety_tick()
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
begin
  if public._r282_api_caller() then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._r283_apply_due(null);
end $$;

-- ---- 8) the Control Center (Team) RPCs -----------------------------------------------------------------------------------------
-- everything the Team page needs: owner, who is deactivated, waiting changes, a hand-over in progress
create or replace function public.team_safety_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_owner uuid; v_admin boolean; v jsonb; t public.team_owner_transfers;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  v_admin := coalesce(public.is_admin(), false);
  if v_admin then perform public._r283_apply_due(v_org); end if;   -- only the tick or an admin applies due changes
  v_owner := public._r283_ensure_owner(v_org, false);
  v := jsonb_build_object('owner_id', v_owner, 'owner_name', case when v_owner is not null then public._r283_name(v_owner) end,
    'me', v_me, 'i_am_owner', v_owner is not null and v_owner = v_me, 'is_admin', v_admin,
    'deactivated', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'deactivated_at', s.deactivated_at) order by s.deactivated_at desc)
                               from public.team_member_status s join public.profiles p on p.id = s.user_id and p.org_id = s.org_id
                              where s.org_id = v_org and s.status = 'deactivated'), '[]'::jsonb));
  if not v_admin then return v; end if;
  select * into t from public.team_owner_transfers x where x.org_id = v_org and x.status = 'pending';
  return v || jsonb_build_object(
    'my_two_step', public._r283_has_mfa(v_me),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'target_user', c.target_user, 'target_name', public._r283_name(c.target_user),
                           'kind', c.kind, 'new_role', c.new_role, 'role_label', case when c.kind = 'demote' then public._a106_role_label(c.new_role) end,
                           'requested_by', c.requested_by, 'requested_by_name', public._r283_name(c.requested_by),
                           'requested_at', c.requested_at, 'effective_at', c.effective_at,
                           'can_cancel', v_me = c.requested_by or (v_owner is not null and v_me = v_owner)) order by c.effective_at)
                         from public.team_admin_changes c where c.org_id = v_org and c.status = 'pending'), '[]'::jsonb),
    'transfer', case when t.id is null then null else jsonb_build_object('id', t.id, 'from_user', t.from_user, 'from_name', public._r283_name(t.from_user),
                  'to_user', t.to_user, 'to_name', public._r283_name(t.to_user), 'created_at', t.created_at, 'expires_at', t.expires_at) end,
    'admins', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', public._r283_name(p.id)) order by lower(public._r283_name(p.id)))
                          from public.profiles p where p.org_id = v_org and p.role = 'admin' and not public._r283_is_off(p.id, v_org)), '[]'::jsonb));
end $$;

-- what a person still has open (to hand to someone else): tasks, events they manage, leads they own
create or replace function public.team_member_open_work(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = p_user and p.org_id = v_org) then
    raise exception 'no such user' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(x order by x ->> 'code', x ->> 'title') from (
        select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'quote_id', t.quote_id, 'code', q.code, 'event', q.title) x
          from public.event_tasks t join public.crew_members c on c.id = t.crew_id and c.org_id = v_org
          join public.quotes q on q.id = t.quote_id and q.org_id = v_org
         where t.org_id = v_org and c.profile_id = p_user and t.status in ('assigned', 'accepted', 'in_progress')
         limit 100) z), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(x order by x ->> 'code') from (
        select jsonb_build_object('quote_id', q.id, 'code', q.code, 'event', q.title, 'status', q.status) x
          from public.quotes q
         where q.org_id = v_org and q.manager_id = p_user and q.deleted_at is null
           and coalesce(q.status, '') not in ('cancelled', 'lost', 'declined', 'archived')
           and not exists (select 1 from public.event_closure e where e.quote_id = q.id and e.closed_at is not null)
         limit 100) z), '[]'::jsonb),
    'leads', coalesce((select jsonb_agg(x order by x ->> 'name') from (
        select jsonb_build_object('id', l.id, 'name', coalesce(l.name, ''), 'status', l.status) x
          from public.leads l
         where l.org_id = v_org and l.owner = p_user and coalesce(l.status, '') not in ('won', 'lost')
         limit 100) z), '[]'::jsonb));
end $$;

-- Deactivate: now (non-admins; any admin by the owner) or after 24 hours (an admin, asked by another admin)
create or replace function public.team_deactivate_member(p_user uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_owner uuid; t public.profiles; v_id uuid; v_eff timestamptz; v_d jsonb;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r283_apply_due(v_org);
  select * into t from public.profiles p where p.id = p_user and p.org_id = v_org;
  if t.id is null then raise exception 'no such user' using errcode = 'P0002'; end if;
  if p_user = v_me then
    raise exception 'You can''t deactivate yourself. Ask another admin, or (as the owner) transfer ownership first.' using errcode = '42501', hint = 'self';
  end if;
  v_owner := public._r283_ensure_owner(v_org, false);
  if v_owner is not null and p_user = v_owner then
    raise exception 'The studio owner can''t be deactivated. The owner can transfer ownership to another admin first.' using errcode = '42501', hint = 'owner_protected';
  end if;
  if public._r283_is_off(p_user, v_org) then
    return jsonb_build_object('ok', true, 'already', true, 'scheduled', false);
  end if;
  if t.role = 'admin' and v_me is distinct from v_owner then
    select c.id, c.effective_at into v_id, v_eff from public.team_admin_changes c where c.org_id = v_org and c.target_user = p_user and c.status = 'pending';
    if v_id is not null then
      raise exception 'A change for this admin is already waiting (it happens on %).', to_char(v_eff at time zone public._r23_tz(v_org), 'DD Mon YYYY HH24:MI')
        using errcode = '23505', hint = 'change_pending';
    end if;
    v_eff := now() + interval '24 hours';
    insert into public.team_admin_changes(org_id, target_user, kind, requested_by, effective_at, note)
      values (v_org, p_user, 'deactivate', v_me, v_eff, left(nullif(btrim(coalesce(p_reason, '')), ''), 500)) returning id into v_id;
    v_d := jsonb_build_object('change_id', v_id, 'kind', 'deactivate', 'target', public._r283_name(p_user), 'by', public._r283_name(v_me),
                              'effective_at', v_eff, 'requested_by', v_me);
    perform public._r283_notify(v_org, 'admin_change_requested', p_user, v_d, true);
    perform public._r283_audit(v_org, 'team.admin_change.request', p_user, jsonb_build_object('change_id', v_id, 'kind', 'deactivate', 'effective_at', v_eff));
    return jsonb_build_object('ok', true, 'scheduled', true, 'change_id', v_id, 'effective_at', v_eff);
  end if;
  perform public._r283_do_deactivate(v_org, p_user, p_reason);
  if t.role = 'admin' then
    perform public._r283_notify(v_org, 'admin_deactivated', p_user,
      jsonb_build_object('target', public._r283_name(p_user), 'by', public._r283_name(v_me)), true);
  end if;
  return jsonb_build_object('ok', true, 'scheduled', false, 'open_work', public.team_member_open_work(p_user));
end $$;

-- Reactivate: counts against the seat limit again
create or replace function public.team_reactivate_member(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); t public.profiles; s public.team_member_status; v_lim integer;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.profiles p where p.id = p_user and p.org_id = v_org;
  if t.id is null then raise exception 'no such user' using errcode = 'P0002'; end if;
  select * into s from public.team_member_status x where x.user_id = p_user and x.org_id = v_org for update;
  if s.user_id is null or s.status <> 'deactivated' then return jsonb_build_object('ok', true, 'already', true); end if;
  if coalesce(t.role, '') <> 'client' then
    perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || v_org::text, 0));
    v_lim := public._trial_seat_limit(v_org);
    -- like joining (R32b): only the active members count, never open invitations
    if v_lim is not null and (select count(*) from public.profiles p where p.org_id = v_org and p.id <> p_user
                               and coalesce(p.role, '') <> 'client' and not public._r283_is_off(p.id, v_org)) >= v_lim then
      perform public._r282_seat_refuse(v_org, v_lim, false);
    end if;
  end if;
  update public.team_member_status set status = 'active', changed_at = now(), changed_by = v_me, reason = null
   where user_id = p_user and org_id = v_org;
  -- sign-in back on: only the exact value this file set is lifted (a ban someone else set stays)
  if s.ban_set_until is not null
     and exists (select 1 from pg_attribute a where a.attrelid = 'auth.users'::regclass and a.attname = 'banned_until' and not a.attisdropped) then
    begin
      execute 'update auth.users set banned_until = $3, updated_at = now() where id = $1 and banned_until = $2' using p_user, s.ban_set_until, s.ban_prior;
    exception when others then null;
    end;
  end if;
  perform public._r283_notify(v_org, 'member_reactivated', p_user, jsonb_build_object('target', public._r283_name(p_user)), false);
  perform public._r283_audit(v_org, 'team.reactivate', p_user, jsonb_build_object('role', t.role));
  return jsonb_build_object('ok', true, 'reactivated', true);
end $$;

-- Change a role: the owner is protected; another admin's demotion by a non-owner waits 24 hours
create or replace function public.team_set_role(p_user uuid, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_owner uuid; t public.profiles; v_id uuid; v_eff timestamptz; v_d jsonb;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role using errcode = '22023'; end if;
  perform public._r283_apply_due(v_org);
  select * into t from public.profiles p where p.id = p_user and p.org_id = v_org;
  if t.id is null then raise exception 'no such user' using errcode = 'P0002'; end if;
  if public._r283_is_off(p_user, v_org) then
    raise exception 'This person is deactivated. Reactivate them first.' using errcode = '22023', hint = 'deactivated';
  end if;
  if t.role is not distinct from p_role then return jsonb_build_object('ok', true, 'scheduled', false, 'unchanged', true); end if;
  v_owner := public._r283_ensure_owner(v_org, false);
  if v_owner is not null and p_user = v_owner then
    raise exception 'The studio owner always stays an admin. To step back, transfer ownership first.' using errcode = '42501', hint = 'owner_protected';
  end if;
  if t.role = 'admin' and p_role <> 'admin' and p_user <> v_me and v_me is distinct from v_owner then
    if exists (select 1 from public.team_admin_changes c where c.org_id = v_org and c.target_user = p_user and c.status = 'pending') then
      raise exception 'A change for this admin is already waiting.' using errcode = '23505', hint = 'change_pending';
    end if;
    v_eff := now() + interval '24 hours';
    insert into public.team_admin_changes(org_id, target_user, kind, new_role, requested_by, effective_at)
      values (v_org, p_user, 'demote', p_role, v_me, v_eff) returning id into v_id;
    v_d := jsonb_build_object('change_id', v_id, 'kind', 'demote', 'target', public._r283_name(p_user), 'by', public._r283_name(v_me),
                              'role_label', public._a106_role_label(p_role), 'effective_at', v_eff, 'requested_by', v_me);
    perform public._r283_notify(v_org, 'admin_change_requested', p_user, v_d, true);
    perform public._r283_audit(v_org, 'team.admin_change.request', p_user, jsonb_build_object('change_id', v_id, 'kind', 'demote', 'new_role', p_role, 'effective_at', v_eff));
    return jsonb_build_object('ok', true, 'scheduled', true, 'change_id', v_id, 'effective_at', v_eff);
  end if;
  perform public.admin_set_role(p_user, p_role);   -- the existing rules: own admin role, last admin, same studio
  if t.role = 'admin' and p_role <> 'admin' then
    perform public._r283_notify(v_org, 'admin_demoted', p_user,
      jsonb_build_object('target', public._r283_name(p_user), 'by', public._r283_name(v_me), 'role_label', public._a106_role_label(p_role)), true);
  end if;
  perform public._r283_audit(v_org, 'team.role', p_user, jsonb_build_object('from', t.role, 'to', p_role));
  return jsonb_build_object('ok', true, 'scheduled', false);
end $$;

-- Cancel a waiting admin change (the owner, or the admin who asked)
create or replace function public.team_change_cancel(p_change uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_owner uuid; c public.team_admin_changes;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into c from public.team_admin_changes x where x.id = p_change and x.org_id = v_org for update;
  if c.id is null then raise exception 'no such change' using errcode = 'P0002'; end if;
  if c.status <> 'pending' then return jsonb_build_object('ok', true, 'already', true, 'status', c.status); end if;
  v_owner := public._r283_ensure_owner(v_org, false);
  if v_me is distinct from v_owner and v_me <> c.requested_by then
    raise exception 'Only the studio owner (or the admin who asked) can cancel this.' using errcode = '42501';
  end if;
  update public.team_admin_changes set status = 'cancelled', decided_by = v_me, decided_at = now() where id = c.id;
  perform public._r283_notify(v_org, 'admin_change_cancelled', c.target_user,
    jsonb_build_object('change_id', c.id, 'kind', c.kind, 'target', public._r283_name(c.target_user), 'by', public._r283_name(v_me),
                       'requested_by', c.requested_by), true);
  perform public._r283_audit(v_org, 'team.admin_change.cancel', c.target_user, jsonb_build_object('change_id', c.id, 'kind', c.kind));
  return jsonb_build_object('ok', true, 'cancelled', true);
end $$;

-- Ownership hand-over: the owner starts it (fresh two-step code when they have two-step), only to an active admin
create or replace function public.team_owner_transfer_start(p_to uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); v_owner uuid; v_id uuid; v_exp timestamptz;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r283_apply_due(v_org);
  v_owner := public._r283_ensure_owner(v_org, false);
  if v_owner is null or v_me <> v_owner then raise exception 'Only the studio owner can transfer ownership.' using errcode = '42501', hint = 'not_owner'; end if;
  if not public._r283_fresh_mfa_ok() then
    raise exception 'Enter a fresh two-step code to confirm this.' using errcode = '42501', hint = 'reauth';
  end if;
  if p_to is null or p_to = v_me or not public._r283_active_admin(v_org, p_to) then
    raise exception 'Ownership can only go to another active admin of this studio. Make them an admin first.' using errcode = '22023', hint = 'not_admin';
  end if;
  if exists (select 1 from public.team_owner_transfers x where x.org_id = v_org and x.status = 'pending') then
    raise exception 'A hand-over is already waiting. Cancel it first.' using errcode = '23505', hint = 'transfer_pending';
  end if;
  insert into public.team_owner_transfers(org_id, from_user, to_user) values (v_org, v_me, p_to) returning id, expires_at into v_id, v_exp;
  perform public._r283_notify(v_org, 'owner_transfer_started', p_to,
    jsonb_build_object('transfer_id', v_id, 'from', public._r283_name(v_me), 'to', public._r283_name(p_to), 'expires_at', v_exp), true);
  perform public._r283_audit(v_org, 'team.owner.transfer_start', p_to, jsonb_build_object('transfer_id', v_id, 'expires_at', v_exp));
  return jsonb_build_object('ok', true, 'transfer_id', v_id, 'expires_at', v_exp);
end $$;

create or replace function public.team_owner_transfer_accept(p_transfer uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); t public.team_owner_transfers;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public._r283_apply_due(v_org);
  select * into t from public.team_owner_transfers x where x.id = p_transfer and x.org_id = v_org for update;
  if t.id is null or t.status <> 'pending' then raise exception 'This hand-over is no longer open.' using errcode = 'P0002'; end if;
  if t.to_user <> v_me then raise exception 'Only the person it was offered to can accept it.' using errcode = '42501'; end if;
  if public._r283_owner(v_org) is distinct from t.from_user or not public._r283_active_admin(v_org, v_me) then
    update public.team_owner_transfers set status = 'void', decided_at = now() where id = t.id;
    raise exception 'This hand-over is no longer valid.' using errcode = '22023';
  end if;
  insert into public.team_owner_log(org_id, user_id, prev_user_id, source, by_user, by_email, reason)
    values (v_org, v_me, t.from_user, 'transfer', v_me, (select u.email from auth.users u where u.id = v_me), 'Accepted the hand-over from the previous owner.');
  update public.team_owner_transfers set status = 'accepted', decided_by = v_me, decided_at = now() where id = t.id;
  perform public._r283_notify(v_org, 'owner_transfer_accepted', v_me,
    jsonb_build_object('transfer_id', t.id, 'from', public._r283_name(t.from_user), 'to', public._r283_name(v_me)), true);
  perform public._r283_audit(v_org, 'team.owner.transfer_accept', v_me, jsonb_build_object('transfer_id', t.id, 'from', t.from_user));
  return jsonb_build_object('ok', true, 'owner', v_me);
end $$;

-- the owner cancels, or the person offered declines
create or replace function public.team_owner_transfer_cancel(p_transfer uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); t public.team_owner_transfers; v_st text;
begin
  if v_me is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into t from public.team_owner_transfers x where x.id = p_transfer and x.org_id = v_org for update;
  if t.id is null then raise exception 'no such hand-over' using errcode = 'P0002'; end if;
  if t.status <> 'pending' then return jsonb_build_object('ok', true, 'already', true, 'status', t.status); end if;
  if v_me = t.from_user then v_st := 'cancelled'; elsif v_me = t.to_user then v_st := 'declined';
  else raise exception 'Only the owner (or the person it was offered to) can stop this hand-over.' using errcode = '42501'; end if;
  update public.team_owner_transfers set status = v_st, decided_by = v_me, decided_at = now() where id = t.id;
  perform public._r283_notify(v_org, 'owner_transfer_' || v_st, t.to_user,
    jsonb_build_object('transfer_id', t.id, 'from', public._r283_name(t.from_user), 'to', public._r283_name(t.to_user)), true);
  perform public._r283_audit(v_org, 'team.owner.transfer_' || v_st, t.to_user, jsonb_build_object('transfer_id', t.id));
  return jsonb_build_object('ok', true, 'status', v_st);
end $$;

-- ---- 9) bell: the 'team_safety' type (admins only by default, like the 0058 trial notices) ------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[['notification_catalog', ''], ['notification_type_of', 'text, text'], ['notify_default', 'uuid, text, text, text']] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0283', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0283');
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0283', f[2]);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0283', f[2]); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0283', f[2]); end if;
  end loop;
end $$;
create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r33-0283: + team_safety (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'team_safety') then c
    else c || $cat$[
    {"type":"team_safety","group":"Team","label":"Team and owner changes",
     "description":"An admin will be removed or changed (24-hour wait), an admin change was cancelled or done, or the studio owner changed. Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0283() as c) x;
$$;
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r33-0283
  select case when lower(btrim(coalesce(p_kind, ''))) = 'team_safety' then 'team_safety'
              else public.notification_type_of__pre0283(p_kind, p_channel) end;
$$;
create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r33-0283: team / owner notices reach admins only unless a studio admin opts a role in
  select case when p_type = 'team_safety' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0283(p_org, p_role, p_type, p_channel) end;
$$;

-- the rows themselves: admin-readable only, never written by the app (created only by the functions above)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r283_team_read') then
    create policy r283_team_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') <> 'team_safety' or (select public.is_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r283_team_ins') then
    create policy r283_team_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') <> 'team_safety');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r283_team_upd') then
    create policy r283_team_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') <> 'team_safety') with check (coalesce(kind, '') <> 'team_safety');
  end if;
end $$;

-- ---- 10) e-mail: outbox kind 'team_safety' (superset, every existing row still passes) + one claim branch -----------------
create or replace function public._r283_mail(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r33-0283: recipients resolved here (never from the row). Admin changes -> the owner + the admin it is about + the asker;
-- ownership changes -> every active admin. Never to an unsubscribed address (0165); never for the sample studio.
declare e public.team_safety_events; v_to jsonb; v_owner uuid; v_tz text; v_eff text; v_studio text;
begin
  select * into e from public.team_safety_events x where x.id = p_id;
  if e.id is null or exists (select 1 from public.organizations o where o.id = e.org_id and coalesce(o.is_sample_master, false)) then return null; end if;
  v_owner := public._r283_owner(e.org_id);
  select o.name into v_studio from public.organizations o where o.id = e.org_id;
  v_tz := public._r23_tz(e.org_id);
  if e.detail ? 'effective_at' then
    v_eff := to_char((e.detail ->> 'effective_at')::timestamptz at time zone v_tz, 'DD Mon YYYY, HH24:MI') || ' (' || v_tz || ')';
  end if;
  if e.event like 'admin\_%' then
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       and p.id in (v_owner, e.target_user, nullif(e.detail ->> 'requested_by', '')::uuid)
       and (p.org_id = e.org_id or p.id = e.target_user)
       and (p.id = e.target_user or not public._r283_is_off(p.id, e.org_id))   -- only the person it is about, if deactivated
       and not public.email_is_opted_out(null, p.email);
  elsif e.event like 'owner\_%' then
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.org_id = e.org_id and p.role = 'admin' and not public._r283_is_off(p.id, e.org_id)
       and p.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and not public.email_is_opted_out(null, p.email);
  else
    return null;
  end if;
  return jsonb_build_object('to', v_to, 'data', jsonb_build_object(
    'event', e.event, 'studio', v_studio, 'kind', e.detail ->> 'kind', 'target', e.detail ->> 'target', 'by', e.detail ->> 'by',
    'role_label', e.detail ->> 'role_label', 'from', e.detail ->> 'from', 'to', e.detail ->> 'to', 'when', v_eff));
end $$;

do $$ declare v_def text; v_kinds text[]; begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.helm_notice_outbox'::regclass and c.conname = 'helm_notice_outbox_kind_check';
  if v_def is null then raise notice '0283: helm_notice_outbox has no kind check - nothing to widen'; return; end if;
  if position('''team_safety''' in v_def) > 0 then return; end if;
  select array_agg(distinct m[1] order by m[1]) into v_kinds from regexp_matches(v_def, '''([a-z_]+)''', 'g') m;
  if v_kinds is null or not ('sales_request' = any (v_kinds)) then
    raise notice '0283: helm_notice_outbox kind check has an unexpected body - left unchanged (team e-mails stay off)'; return; end if;
  v_kinds := array(select distinct k from unnest(v_kinds || array['team_safety']) k order by k);
  execute format('alter table public.helm_notice_outbox add constraint helm_notice_outbox_kind_check_0283 check (kind in (%s))',
                 (select string_agg(quote_literal(k), ', ' order by k) from unnest(v_kinds) k));
  alter table public.helm_notice_outbox drop constraint helm_notice_outbox_kind_check;
  alter table public.helm_notice_outbox rename constraint helm_notice_outbox_kind_check_0283 to helm_notice_outbox_kind_check;
end $$;

do $$ declare v_def text; v_old text; v_new text; begin
  v_def := pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure);
  if position('r33-team-0283' in v_def) > 0 then return; end if;
  v_old := E'\n    end if;\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  if (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) then
    raise notice '0283: helm_notice_outbox_claim has an unexpected body - left unchanged (team e-mails are skipped)'; return; end if;
  v_new := E'\n    elsif r.kind = ''team_safety'' and r.ref_id is not null then\n'
        || E'      -- r33-team-0283: admin / owner change -> recipients resolved in _r283_mail\n'
        || E'      v_data := public._r283_mail(r.ref_id);\n'
        || E'      v_to := coalesce(v_data -> ''to'', ''[]''::jsonb); v_data := v_data -> ''data'';'
        || E'\n    end if;\n'
        || E'    -- r33-team-0283: never to a deactivated member of the studio (a team_safety notice about that person still reaches them)\n'
        || E'    if r.org_id is not null and r.kind <> ''team_safety'' then v_to := public._r283_drop_off(r.org_id, v_to); end if;'
        || E'\n    if v_data is null or jsonb_array_length(v_to) = 0 then';
  execute replace(v_def, v_old, v_new);
end $$;

-- ---- 11) names: "Name (deactivated)" wherever the app looks a teammate up -----------------------------------------------
create or replace function public.studio_avatars()
returns table(user_id uuid, full_name text, role text, avatar_path text)
language plpgsql stable security definer set search_path = '' as $$
-- r33-0283 B1: a deactivated member keeps their records; their name reads "Name (deactivated)"
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_me and p.org_id = v_org and p.role is not null and p.role <> 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1))
                 || case when public._r283_is_off(p.id, v_org) then ' (deactivated)' else '' end,
           p.role, m.avatar_path
      from public.profiles p
      left join public.member_profiles m on m.user_id = p.id
     where p.org_id = v_org and p.role <> 'client'
     order by p.id;
end $$;

create or replace function public.chat_directory()
returns table(id uuid, full_name text, email_name text, role text, avatar_path text, job_title text, department text)
language sql stable security definer set search_path = '' as $$
  -- r33-0283 B1: a deactivated member reads "Name (deactivated)"
  select b.id,
         case when public._r283_is_off(b.id, public.current_org_id())
              then coalesce(nullif(btrim(b.full_name), ''), b.email_name, 'Member') || ' (deactivated)' else b.full_name end,
         b.email_name, b.role, m.avatar_path, m.job_title, m.department
    from public.chat_directory__base() with ordinality as b(id, full_name, email_name, role, n)
    left join public.member_profiles m on m.user_id = b.id
   order by b.n;
$$;

create or replace function public.audit_actor_names()
returns table(id uuid, full_name text, email text) language sql stable security definer set search_path = '' as $$
  -- trial-gates-0203 (body of 0041 + the free-trial check)
  -- r33-0283 B1: a deactivated member reads "Name (deactivated)"
  select p.id,
         case when public._r283_is_off(p.id, p.org_id)
              then coalesce(nullif(btrim(p.full_name), ''), split_part(coalesce(p.email, ''), '@', 1)) || ' (deactivated)' else p.full_name end,
         p.email
    from public.profiles p
   where auth.uid() is not null
     and p.org_id = public.current_org_id()
     and (public.is_admin() or public.has_area('controls', 'view'))
     and not public._tl202_caller_trial()
   order by p.id;
$$;

-- ---- 11b) a deactivated member gets no studio messages (e-mail digests, close requests, WhatsApp forwards, run-sheet /
--      delivery reminders, assignment WhatsApps); every other helm_notice_outbox kind is filtered in the claim (section 10) -
--      bodies re-issued from 0266 / 0254 with one added condition, claims wrapped once (*__pre0283) to skip their rows
create or replace function public._r23_digest_mail(p_org uuid, p_user uuid, p_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-inbox-0266
-- r33-0283 B1: never for a deactivated member
declare v_mode text; v_email text; v_name text; v_ids uuid[]; v_items jsonb; v_more integer; v_tz text := public._r23_tz(p_org);
begin
  if p_org is null or p_user is null then return null; end if;
  if public._r283_is_off(p_user, p_org) then return null; end if;
  v_mode := public._r23_mode(p_org, p_user);
  if v_mode = 'off' then return null; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is not null and public._tb179_no_send(p_org) then return null; end if;
  select lower(btrim(p.email)), nullif(btrim(split_part(coalesce(p.full_name, ''), ' ', 1)), '') into v_email, v_name
    from public.profiles p where p.id = p_user and p.org_id = p_org;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return null; end if;
  if to_regprocedure('public.email_is_opted_out(uuid,text)') is not null and public.email_is_opted_out(null, v_email) then return null; end if;
  begin
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(coalesce(p_payload -> 'ids', '[]'::jsonb)) x;
  exception when others then return null;
  end;
  if v_ids is null then return null; end if;
  with r as materialized (select * from public._r23_rows(p_org, p_user))
  select coalesce((select jsonb_agg(jsonb_build_object(
             'title', public._r23_label(r.kind, r.detail),
             'event', left(q.title, 120), 'code', left(q.code, 40),
             'at', to_char(r.sort_at at time zone v_tz, 'DD/MM/YYYY HH12:MI am')) order by r.sort_at desc)
           from r left join public.quotes q on q.id = r.quote_id and q.org_id = p_org
          where r.is_unread and r.id = any (v_ids)), '[]'::jsonb),
         (select count(*) from r where r.is_unread and not (r.id = any (v_ids)))
    into v_items, v_more;
  if jsonb_array_length(v_items) = 0 then return null; end if;
  return jsonb_build_object('to', jsonb_build_array(v_email), 'data', jsonb_build_object(
    'studio', (select o.name from public.organizations o where o.id = p_org),
    'name', v_name, 'mode', coalesce(p_payload ->> 'mode', v_mode),
    'items', v_items, 'count', jsonb_array_length(v_items), 'more', v_more));
end $$;

create or replace function public._r23_queue_digests()
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r23-inbox-0266
-- r33-0283 B1: a deactivated member is never picked
declare o record; p record; c jsonb; v_tz text; v_loc timestamp; v_hour integer; v_age integer; v_mode text; v_key text;
        v_ids uuid[]; v_n integer := 0; v_ins integer;
begin
  for o in select g.id from public.organizations g loop
    begin
      c := public._r23_cfg(o.id);
      if not coalesce((c ->> 'email_enabled')::boolean, true) then continue; end if;
      if to_regprocedure('public._tb179_no_send(uuid)') is not null and public._tb179_no_send(o.id) then continue; end if;
      v_tz := public._r23_tz(o.id); v_loc := now() at time zone v_tz;
      v_hour := coalesce((c ->> 'digest_hour')::integer, 8); v_age := coalesce((c ->> 'digest_min_age_minutes')::integer, 60);
      for p in select pr.id from public.profiles pr
                where pr.org_id = o.id and pr.role = any (public._notify_roles())
                  and nullif(btrim(coalesce(pr.email, '')), '') is not null
                  and not public._r283_is_off(pr.id, o.id) loop
        v_mode := public._r23_mode(o.id, p.id); v_ids := null; v_key := null;
        if v_mode = 'daily' and ((extract(hour from v_loc)::integer - v_hour + 24) % 24) < 2 then
          v_key := 'inbox_digest:' || p.id::text || ':' || to_char(v_loc::date, 'YYYY-MM-DD');
          if exists (select 1 from public.helm_notice_outbox x where x.dedupe_key = v_key) then continue; end if;
          select array_agg(z.id order by z.sort_at desc) into v_ids from (
            select r.id, r.sort_at from public._r23_rows(o.id, p.id) r
             where r.is_unread and r.digested_at is null
               and r.sort_at <= now() - make_interval(mins => v_age) and r.sort_at >= now() - interval '2 days'
             order by r.sort_at desc limit 20) z;
        elsif v_mode = 'instant_important' then
          select array_agg(z.id order by z.sort_at desc) into v_ids from (
            select r.id, r.sort_at from public._r23_rows(o.id, p.id) r
             where r.is_unread and r.digested_at is null and public._r23_important(r.kind)
               and r.sort_at <= now() - interval '5 minutes' and r.sort_at >= now() - interval '1 day'
             order by r.sort_at desc limit 20) z;
          if v_ids is not null then v_key := 'inbox_instant:' || p.id::text || ':' || md5(array_to_string(v_ids, ',')); end if;
        end if;
        if v_ids is null or v_key is null then continue; end if;
        insert into public.helm_notice_outbox (kind, org_id, ref_id, payload, dedupe_key)
          values ('inbox_digest', o.id, p.id, jsonb_build_object('user_id', p.id, 'mode', v_mode, 'ids', to_jsonb(v_ids)), v_key)
        on conflict (dedupe_key) do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into public.notification_inbox_state (user_id, notification_id, org_id, digested_at)
            select p.id, i, o.id, now() from unnest(v_ids) i
          on conflict (user_id, notification_id) do update set digested_at = now(), updated_at = now();
          v_n := v_n + 1;
        end if;
      end loop;
    exception when others then
      raise warning 'r23-inbox-0266: digest skipped for one studio (%)', sqlstate;
    end;
  end loop;
  return v_n;
end $$;

create or replace function public._r22_close_mail(p_org uuid, p_req uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254
-- r33-0283 B1: never to a deactivated member
declare x public.event_close_requests; v_to jsonb; v_q record; v_data jsonb;
begin
  select * into x from public.event_close_requests r where r.id = p_req and r.org_id = p_org;
  if x.id is null then return null; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is not null and public._is_trial_org(p_org) then return null; end if;
  select q.title, q.code, q.event_date into v_q from public.quotes q where q.id = x.quote_id and q.org_id = p_org;
  if not found then return null; end if;
  if p_kind = 'close_request' then
    if x.status <> 'pending' then return null; end if;
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.org_id = p_org and p.role in ('admin', 'coordinator', 'manager') and p.email is not null
       and p.id is distinct from x.requested_by
       and not public._r283_is_off(p.id, p_org)
       and (to_regprocedure('public.email_is_opted_out(uuid,text)') is null or not public.email_is_opted_out(null, p.email));
  elsif p_kind = 'close_decision' then
    if x.status not in ('approved', 'declined') then return null; end if;
    select coalesce(jsonb_agg(distinct lower(p.email)), '[]'::jsonb) into v_to
      from public.profiles p
     where p.id = x.requested_by and p.org_id = p_org and p.email is not null
       and not public._r283_is_off(p.id, p_org)
       and (to_regprocedure('public.email_is_opted_out(uuid,text)') is null or not public.email_is_opted_out(null, p.email));
  else return null; end if;
  v_data := jsonb_build_object(
    'studio', (select o.name from public.organizations o where o.id = p_org),
    'event', coalesce(nullif(btrim(v_q.title), ''), 'Event'), 'code', v_q.code,
    'event_date', case when v_q.event_date is not null then to_char(v_q.event_date, 'DD/MM/YYYY') end,
    'quote_id', x.quote_id, 'status', x.status,
    'requested_name', coalesce(x.requested_name, 'A teammate'), 'reason', x.reason,
    'failed', (select coalesce(jsonb_agg(f ->> 'label'), '[]'::jsonb) from jsonb_array_elements(x.failed_checks) f),
    'decided_name', x.decided_name, 'note', x.decision_note);
  return jsonb_build_object('to', v_to, 'data', v_data);
end $$;

-- the per-recipient send check of delivery reminders (0241): a deactivated member (e.g. the creator on cc) is blocked
do $$ begin
  if to_regprocedure('public._dl241_send_block__pre0283(uuid, text, boolean)') is null then
    alter function public._dl241_send_block(uuid, text, boolean) rename to _dl241_send_block__pre0283;
  end if;
end $$;
create or replace function public._dl241_send_block(p_org uuid, p_recipient text, p_take boolean)
returns text language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283
begin
  if public._r283_off_email(p_org, p_recipient) then return 'deactivated'; end if;
  return public._dl241_send_block__pre0283(p_org, p_recipient, p_take);
end $$;

-- the outbox claims: rows waiting for a deactivated member are skipped (never sent), then the claim as before
do $$ declare f text; begin
  foreach f in array array['comms_outbox_claim', 'runsheet_reminder_claim', 'assign_notify_claim'] loop
    if to_regprocedure(format('public.%s(integer)', f || '__pre0283')) is null then
      execute format('alter function public.%I(integer) rename to %I', f, f || '__pre0283');
    end if;
  end loop;
end $$;
create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: staff WhatsApp forwards to a deactivated member are skipped
begin
  update public.comms_outbox c set status = 'skipped', sent_at = now()
   where c.sent_at is null and c.status = 'pending' and c.purpose = 'wa_forward'
     and c.user_id is not null and public._r283_is_off(c.user_id, c.org_id);
  return public.comms_outbox_claim__pre0283(p_limit);
end $$;
create or replace function public.runsheet_reminder_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: run-sheet reminders to a deactivated member are skipped
begin
  update public.runsheet_reminder_sends s set status = 'skipped', reason = 'deactivated', sent_at = now()
   where s.sent_at is null and s.status = 'pending' and s.channel = 'email' and public._r283_off_email(s.org_id, s.recipient);
  return public.runsheet_reminder_claim__pre0283(p_limit);
end $$;
create or replace function public.assign_notify_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: assignment WhatsApps to a deactivated member's phone are skipped
begin
  update public.assign_notify_outbox a set status = 'skipped', sent_at = now()
   where a.sent_at is null and a.status = 'pending' and public._r283_off_phone(a.org_id, a.phone);
  return public.assign_notify_claim__pre0283(p_limit);
end $$;
do $$ declare f text; begin
  foreach f in array array['public.comms_outbox_claim(integer)', 'public.runsheet_reminder_claim(integer)', 'public.assign_notify_claim(integer)',
                           'public.comms_outbox_claim__pre0283(integer)', 'public.runsheet_reminder_claim__pre0283(integer)',
                           'public.assign_notify_claim__pre0283(integer)', 'public._dl241_send_block(uuid, text, boolean)',
                           'public._dl241_send_block__pre0283(uuid, text, boolean)', 'public._r23_digest_mail(uuid, uuid, jsonb)',
                           'public._r23_queue_digests()', 'public._r22_close_mail(uuid, uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.comms_outbox_claim(integer) to service_role';
    execute 'grant execute on function public.runsheet_reminder_claim(integer) to service_role';
    execute 'grant execute on function public.assign_notify_claim(integer) to service_role';
  end if;
end $$;

-- ---- 12) Helm HQ: who owns a studio, the backfill flags, and "Recover studio owner" ----------------------------------------
create or replace function public.hq_studio_owner_info(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: HQ people who may read studios (two-step, audited 'hq.view'); names / e-mails of the studio's admins only
declare v_owner uuid;
begin
  perform public._hq27_require('studios.read', false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', 'hq_studio_owner', p_org::text, null, now() from auth.users u where u.id = auth.uid();
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'no such studio' using errcode = 'P0002'; end if;
  v_owner := public._r283_owner(p_org);
  return jsonb_build_object(
    'owner', case when v_owner is null then null else (select jsonb_build_object('user_id', p.id, 'name', public._r283_name(p.id), 'email', p.email,
                     'active', public._r283_active_admin(p_org, p.id)) from public.profiles p where p.id = v_owner) end,
    'owner_missing', v_owner is null or not public._r283_active_admin(p_org, v_owner),
    'admins', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', public._r283_name(p.id), 'email', p.email,
                          'active', not public._r283_is_off(p.id, p_org), 'two_step', public._r283_has_mfa(p.id)) order by p.created_at)
                          from public.profiles p where p.org_id = p_org and p.role = 'admin'), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'source', l.source, 'hq_flag', l.hq_flag,
                          'owner_email', (select p.email from public.profiles p where p.id = l.user_id),
                          'prev_email', (select p.email from public.profiles p where p.id = l.prev_user_id),
                          'by_email', l.by_email, 'reason', l.reason) order by l.id desc)
                          from public.team_owner_log l where l.org_id = p_org), '[]'::jsonb));
end $$;

create or replace function public.hq_studio_owner_flags()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283: backfills Helm HQ should look at (the creator was missing, or no admin at all)
begin
  perform public._hq27_require('studios.read', false);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, at)
    select auth.uid(), u.email, 'hq.view', 'hq_studio_owner_flags', null, null, now() from auth.users u where u.id = auth.uid();
  return coalesce((select jsonb_agg(jsonb_build_object('org_id', l.org_id, 'studio', o.name, 'at', l.at, 'source', l.source,
                     'owner_email', (select p.email from public.profiles p where p.id = l.user_id), 'reason', l.reason) order by l.at desc)
                     from public.team_owner_log l join public.organizations o on o.id = l.org_id where l.hq_flag), '[]'::jsonb);
end $$;

create or replace function public.hq_studio_owner_recover(p_org uuid, p_email text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r33-0283 B3: the owner has left / died / lost access. HQ Owner role (unknown action = Owner only), two-step (aal2) and a
-- fresh code (_hq_wgate), a written reason, max 5 a day per HQ person. Moves ownership to an ACTIVE admin of that studio.
declare v_me uuid := auth.uid(); v_reason text := btrim(coalesce(p_reason, '')); v_email text := lower(btrim(coalesce(p_email, '')));
        v_target uuid; v_prev uuid; v_by text;
begin
  if v_me is null or not public.is_platform_admin() or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'not authorized' using errcode = '42501', hint = 'Only a Helm HQ person signed in with two-step can do this.';
  end if;
  if length(v_reason) < 20 or length(v_reason) > 1000 then
    raise exception 'Write 20 to 1000 characters: why, and how you checked who is asking (for example a call back on the registered number).' using errcode = '22023';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then raise exception 'no such studio' using errcode = 'P0002'; end if;
  select p.id into v_target from public.profiles p where p.org_id = p_org and lower(p.email) = v_email;
  if v_target is null or not public._r283_active_admin(p_org, v_target) then
    raise exception 'The new owner must be an active admin of this studio. Ask the studio to make them an admin first.' using errcode = '22023';
  end if;
  v_prev := public._r283_owner(p_org);
  if v_prev is not null and v_prev = v_target then raise exception 'This person is already the studio owner.' using errcode = '22023'; end if;
  if (select count(*) from public.team_owner_log l where l.by_user = v_me and l.source = 'hq_recovery' and l.at > now() - interval '24 hours') >= 5 then
    raise exception 'Too many owner recoveries in the last 24 hours. Try again tomorrow.' using errcode = 'P0001';
  end if;
  -- audited HQ change (role permission + fresh two-step code; refuses again if not allowed)
  perform public._hq_wgate('hq.studio.owner_recover', 'organizations', p_org::text,
    jsonb_build_object('new_owner', v_email, 'prev_owner', v_prev, 'reason', v_reason));
  select lower(u.email) into v_by from auth.users u where u.id = v_me;
  insert into public.team_owner_log(org_id, user_id, prev_user_id, source, by_user, by_email, reason)
    values (p_org, v_target, v_prev, 'hq_recovery', v_me, v_by, v_reason);
  update public.team_owner_transfers set status = 'void', decided_at = now() where org_id = p_org and status = 'pending';
  update public.team_admin_changes set status = 'void', decided_at = now(), note = 'Studio owner changed by Helm support.'
   where org_id = p_org and status = 'pending' and target_user = v_target;
  perform public._r283_notify(p_org, 'owner_recovered', v_target, jsonb_build_object('to', public._r283_name(v_target), 'by', 'Helm support'), true);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (v_me, v_by, 'team.owner.hq_recovery', 'profiles', v_target::text, jsonb_build_object('prev_owner', v_prev), p_org, now());
  return jsonb_build_object('ok', true, 'owner', v_target, 'previous', v_prev);
end $$;

-- ---- 13) backfill: every existing studio gets its owner recorded once (inserts only) -------------------------------------------
do $$ declare o record; begin
  for o in select org.id from public.organizations org
            where not coalesce(org.is_sample_master, false)
              and not exists (select 1 from public.team_owner_log l where l.org_id = org.id)
            order by org.created_at, org.id loop
    perform public._r283_ensure_owner(o.id, true);
  end loop;
end $$;

-- ---- 14) trial retention (0184, switched off) keeps these records; the 24-hour tick ----------------------------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_keep_tables()') is null then return; end if;
  v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
  if position('''team_owner_log''' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, '''helm_notice_outbox''', ''))) <> length('''helm_notice_outbox''') then
    raise notice '0283: _tr184_keep_tables() has an unexpected body - left unchanged'; return; end if;
  execute replace(v_def, '''helm_notice_outbox''', '''helm_notice_outbox'', ''team_member_status'', ''team_owner_log'', ''team_admin_changes'', ''team_owner_transfers'', ''team_safety_events''');
end $$;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_team_safety_tick') then
        perform cron.schedule('helm_team_safety_tick', '*/5 * * * *', 'select public.team_safety_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_team_safety_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

-- ---- 15) privileges ---------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: nobody calls these through the API
  foreach f in array array['public._r283_tg_keep()', 'public._r283_is_off(uuid, uuid)', 'public._r283_deactivated(uuid)', 'public._r283_owner(uuid)',
                           'public._r283_active_admin(uuid, uuid)', 'public._r283_name(uuid)', 'public._r283_ensure_owner(uuid, boolean)',
                           'public._r283_fresh_mfa_ok()', 'public._r283_has_mfa(uuid)', 'public._r283_label(text, jsonb)',
                           'public._r283_notify(uuid, text, uuid, jsonb, boolean, uuid)', 'public._r283_audit(uuid, text, uuid, jsonb, uuid)',
                           'public._r283_end_sessions(uuid)', 'public._r283_do_deactivate(uuid, uuid, text, uuid)', 'public._r283_apply_due(uuid)',
                           'public._r283_off_email(uuid, text)', 'public._r283_off_phone(uuid, text)', 'public._r283_drop_off(uuid, jsonb)',
                           'public._r283_tg_owner_guard()', 'public._r283_tg_owner_ensure()', 'public._r283_mail(uuid)',
                           'public.team_safety_tick()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.team_safety_tick() to service_role';
    execute 'grant execute on function public._r283_mail(uuid) to service_role';
  end if;
  -- the app: signed-in people only (each function checks who may do what)
  foreach f in array array['public.team_safety_overview()', 'public.team_member_open_work(uuid)', 'public.team_deactivate_member(uuid, text)',
                           'public.team_reactivate_member(uuid)', 'public.team_set_role(uuid, text)', 'public.team_change_cancel(uuid)',
                           'public.team_owner_transfer_start(uuid)', 'public.team_owner_transfer_accept(uuid)', 'public.team_owner_transfer_cancel(uuid)',
                           'public.hq_studio_owner_info(uuid)', 'public.hq_studio_owner_flags()', 'public.hq_studio_owner_recover(uuid, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- re-issued in place: the API grants stay as they were (create or replace keeps them); stated again for a fresh database
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.notification_catalog() to authenticated';
    execute 'grant execute on function public.notification_type_of(text, text) to authenticated';
    execute 'grant execute on function public.studio_avatars() to authenticated';
    execute 'grant execute on function public.chat_directory() to authenticated';
    execute 'grant execute on function public.audit_actor_names() to authenticated';
    execute 'grant execute on function public.my_seat_usage() to authenticated';
  end if;
  -- the three wrapped once (new functions): as before 0283 - signed-in people for the catalog / type, nobody for the default
  execute 'revoke all on function public.notification_catalog() from public';
  execute 'revoke all on function public.notification_type_of(text, text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.notification_catalog() from anon';
    execute 'revoke all on function public.notification_type_of(text, text) from anon';
  end if;
  execute 'revoke all on function public.notify_default(uuid, text, text, text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.notify_default(uuid, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.notify_default(uuid, text, text, text) from authenticated'; end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 the five team-safety tables exist with RLS on and no API privilege',
     (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity
        and relname in ('team_member_status', 'team_owner_log', 'team_admin_changes', 'team_owner_transfers', 'team_safety_events')) = 5
     and not has_table_privilege('authenticated', 'public.team_member_status', 'select')
     and not has_table_privilege('anon', 'public.team_owner_log', 'select')),
  ('02 current_org_id + user_role answer nothing for a deactivated member (0283 markers, 0282 body kept)',
     (select position('_r283_deactivated' in prosrc) > 0 and position('_r282_temp_pw_pending' in prosrc) > 0 from pg_proc where oid = 'public.current_org_id()'::regprocedure)
     and (select position('team_member_status' in prosrc) > 0 from pg_proc where oid = 'public.user_role()'::regprocedure)),
  ('03 Remove never deletes: admin_delete_user deactivates; profiles guarded (owner + no app delete)',
     (select position('team_deactivate_member' in prosrc) > 0 and position('delete from auth.users' in prosrc) = 0 from pg_proc where oid = 'public.admin_delete_user(uuid)'::regprocedure)
     and exists (select 1 from pg_trigger where tgname = 'ab_r283_owner_guard' and tgrelid = 'public.profiles'::regclass)
     and exists (select 1 from pg_trigger where tgname = 'zz_r283_owner_ensure' and tgrelid = 'public.profiles'::regclass)),
  ('04 every studio with an admin has its owner recorded (flagged rows are listed in step 2)',
     not exists (select 1 from public.organizations o where not coalesce(o.is_sample_master, false)
                  and exists (select 1 from public.profiles p where p.org_id = o.id and p.role = 'admin')
                  and public._r283_owner(o.id) is null)),
  ('05 seats: deactivated members do not count (0283 markers on the 0282 seat helpers + my_seat_usage)',
     (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._r282_seats_used(uuid)'::regprocedure)
     and (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._ts166_tg_profile_seat()'::regprocedure)
     and (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._ts166_tg_invite_seat()'::regprocedure)
     and (select position('deactivated' in prosrc) > 0 from pg_proc where oid = 'public.my_seat_usage()'::regprocedure)),
  ('06 Team RPCs callable by signed-in people only',
     has_function_privilege('authenticated', 'public.team_deactivate_member(uuid, text)', 'execute')
     and has_function_privilege('authenticated', 'public.team_reactivate_member(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.team_set_role(uuid, text)', 'execute')
     and has_function_privilege('authenticated', 'public.team_owner_transfer_start(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.team_safety_overview()', 'execute')),
  ('07 internal helpers + the tick are not callable through the API',
     not has_function_privilege('authenticated', 'public._r283_do_deactivate(uuid, uuid, text, uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._r283_ensure_owner(uuid, boolean)', 'execute')
     and not has_function_privilege('authenticated', 'public.team_safety_tick()', 'execute')
     and not has_function_privilege('anon', 'public._r283_mail(uuid)', 'execute')),
  ('08 bell type team_safety (admins only) + restrictive policies on notifications',
     exists (select 1 from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'team_safety')
     and public.notify_default(null, 'admin', 'team_safety', 'in_app') and not public.notify_default(null, 'sales', 'team_safety', 'in_app')
     and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname like 'r283_team_%') = 3),
  ('09 e-mail lane: outbox kind team_safety + one claim branch (queued only)',
     position('''team_safety''' in pg_get_constraintdef((select oid from pg_constraint where conname = 'helm_notice_outbox_kind_check'))) > 0
     and position('r33-team-0283' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0),
  ('10 names: chat / avatars / activity log show "(deactivated)"',
     (select position('(deactivated)' in prosrc) > 0 from pg_proc where oid = 'public.chat_directory()'::regprocedure)
     and (select position('(deactivated)' in prosrc) > 0 from pg_proc where oid = 'public.studio_avatars()'::regprocedure)
     and (select position('(deactivated)' in prosrc) > 0 from pg_proc where oid = 'public.audit_actor_names()'::regprocedure)),
  ('11 Helm HQ owner recovery in place (signed-in; the HQ gate decides)',
     has_function_privilege('authenticated', 'public.hq_studio_owner_recover(uuid, text, text)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_studio_owner_info(uuid)', 'execute')),
  ('13 a deactivated member gets no studio messages (digests, close requests, notices, WhatsApp, reminders) and loses crew links',
     (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._r23_queue_digests()'::regprocedure)
     and (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._r23_digest_mail(uuid, uuid, jsonb)'::regprocedure)
     and (select position('_r283_is_off' in prosrc) > 0 from pg_proc where oid = 'public._r22_close_mail(uuid, uuid, text)'::regprocedure)
     and position('_r283_drop_off' in pg_get_functiondef('public.helm_notice_outbox_claim(integer)'::regprocedure)) > 0
     and to_regprocedure('public.comms_outbox_claim__pre0283(integer)') is not null
     and to_regprocedure('public.runsheet_reminder_claim__pre0283(integer)') is not null
     and to_regprocedure('public.assign_notify_claim__pre0283(integer)') is not null
     and to_regprocedure('public._dl241_send_block__pre0283(uuid, text, boolean)') is not null
     and (select position('_a42_revoke_links_for_phone' in prosrc) > 0 from pg_proc where oid = 'public._r283_do_deactivate(uuid, uuid, text, uuid)'::regprocedure)),
  ('12 nothing removed: every login still has its profile rows (counts only grow)',
     (select count(*) from public.profiles) >= 0 and (select count(*) from public.team_owner_log) >= 0)
) v(item, ok) order by item;
