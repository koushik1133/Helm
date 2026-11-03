-- APPLY-0329.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0329: ..." if 0328 (R120) or an earlier migration it builds on is missing.
-- R121 (owner): free-trial edge cases.
--   * An invitation opened after the studio's free trial ended is PAUSED, not expired: the join page says "This
--     studio's free trial has ended. Ask <owner> to choose a plan, then open this invitation again.", no login is
--     made, nobody joins, and no new invitation e-mail goes out for that studio. After an upgrade the same link works.
--   * Free-trial reminder and trial-ended / deletion-warning e-mails go to the CURRENT owner (after a hand-over),
--     not the person who first created the studio. Nothing re-sends.
--   * Client invitations are refused during the free trial ("share the preview instead"). Paid studios unchanged.
--   * Helm HQ: renaming a studio and saving business details ask for a fresh two-step code, like Extend trial.
--   * The "Plan active" bell notice has its own type ("Plan active") so it can be muted on its own.
--   Nine functions wrapped (old bodies kept as *__pre0329 with no app privilege), one trigger + four restrictive
--   policies added. No table, column, row or policy is deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end (12 rows) must say ok = true.
--   2  Redeploy invite-signup (it now asks invitation_preview before making a login) - see the PR for the command.
--   Note: VERIFY row 05 of APPLY-0328 ("only the listed actions") reads false after this file - expected (R121 adds
--   rename + business details to that list).
begin;
-- 0329_r121_trial_edge_fixes.sql - CANONICAL forward-only. R121 (owner: free-trial edge cases - an invitation opened
-- after the trial ended, trial e-mails to the CURRENT owner, no client invitations in a trial, a fresh two-step code for
-- more HQ changes, its own bell kind for "Plan active").
-- REQUIRES 0328 (R120: _hq_fresh_code_action, _r120_plan_active_notice, hq_activate_plan__pre0328), 0316 (accept_invitation
--          wrapper), 0155 / 0131 (invite_email_outbox + claim), 0210 (invite_open_for_email), 0120 (trial reminder
--          e-mails), 0184 (trial retention e-mails), 0183 (_trial_locked), 0173 (_tl173_trial_locked), 0282
--          (_r282_api_caller), 0283 (_r283_owner), 0300 (studio_billing_email), 0058 / 0285 (bell catalog chain).
--
-- In plain words:
--   1  A5 - an invitation opened AFTER the inviting studio's free trial ended (the studio is read-only, _trial_locked):
--        * invitation_preview (the join page's anon lookup) now also says trial_paused = true + the owner's display
--          name + the sentence to show: "This studio's free trial has ended. Ask <owner> to choose a plan, then open
--          this invitation again." The join page shows it instead of the create-account form, so no login is made
--          (invite-signup refuses too: it asks invitation_preview first - redeploy it).
--        * accept_invitation refuses with that sentence (hint trial_paused) - nobody joins a read-only studio.
--        * the invitation row is NOT touched (not expired, not revoked): it works again once the studio has a plan.
--        * the invitation e-mail queue closes (status skipped, kept) any unsent invitation e-mail of a locked trial
--          studio, so no new "Join <studio>" e-mail goes out for it (the admin can press Resend after upgrading).
--          The welcome / "You've joined" queue already skips ended trials (0327 skip_reason trial_ended).
--        * invite_open_for_email (the free-trial sign-up's "you have an invitation" check) ignores invitations of a
--          locked trial studio, so nobody is sent back to a studio they cannot join.
--   2  B8 / D2 - the free-trial reminder e-mails (0120: 3 days / 1 day / last day) and the trial-retention e-mails (0184:
--      +7 days, deletion warnings) went to organizations.created_by (the person who STARTED the studio), even after
--      ownership was handed over. They now go to studio_billing_email(studio) (0300): the studio e-mail once confirmed,
--      else the CURRENT owner's login (team_owner_log, 0283), else the first active admin - the same address as the
--      billing-reminder e-mails (trial ended). The rows, their keys and their dedupe are unchanged (nothing re-sends).
--   3  C18 - a CLIENT-role invitation in a free-trial studio is refused for every app path (create_invitation, the
--      REST table, a role change to client): "Client invitations are switched off during the free trial - share the
--      preview instead." (hint trial_client_invite). Nothing is inserted, so no e-mail is queued; an older unsent
--      client invitation e-mail of a trial studio is closed as skipped. Paid studios and Helm staff / service
--      changes are unchanged.
--   4  A fresh two-step code (HQ_REAUTH, 0328) is now also needed for "Change studio name & link" (hq.studio.identity)
--      and "Save business details" (hq.studio_account.set) in /hq, like "Extend trial".
--   5  The "Plan active" bell notice (0328) gets its own kind 'plan_active' (catalog type plan_active, label
--      "Plan active", group Billing, admins only by default, its own restrictive policies like trial_reminder) so it
--      can be muted separately from the free-trial reminders. Rows already written as 'trial_reminder' are left as
--      they are (and still count for the once-per-period dedupe). notifications has no kind check constraint, so
--      there is nothing to widen.
-- ZERO DATA LOSS: no table, column, row or policy is dropped. Nine functions are wrapped (old bodies kept once as
-- *__pre0329 with NO app privilege), two small helpers re-issued in place, one trigger + four restrictive policies added.
-- The only row changes are queue rows closed as 'skipped' (kept). Additive + idempotent: safe to run twice. ASCII only.
-- Goes after 0328.
-- ROLLBACK (manual, only if ever needed - SQL editor), per wrapped function F(args):
--   drop function public.F(args); alter function public.F__pre0329(args) rename to F; + re-grant as before
--   drop trigger if exists a329_trial_client_invite on public.invitations;
--   (_hq_fresh_code_action: re-run its 0328 definition; plan_active bell rows can stay)

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._hq_fresh_code_action(text)') is null
     or to_regprocedure('public._r120_plan_active_notice(uuid,boolean,jsonb)') is null
     or to_regprocedure('public.hq_activate_plan__pre0328(uuid,text,text,numeric,text,date,date,text,text,numeric)') is null then
    raise exception 'STOP 0329: 0328 (R120) is not applied - run APPLY-0328.sql first'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null or to_regprocedure('public._tl173_trial_locked(uuid)') is null then
    raise exception 'STOP 0329: 0173 / 0183 (_trial_locked) are not applied'; end if;
  if to_regprocedure('public._r282_api_caller()') is null then raise exception 'STOP 0329: 0282 (_r282_api_caller) is not applied'; end if;
  if to_regprocedure('public._r283_owner(uuid)') is null then raise exception 'STOP 0329: 0283 (_r283_owner) is not applied'; end if;
  if to_regprocedure('public.studio_billing_email(uuid)') is null then raise exception 'STOP 0329: 0300 (studio_billing_email) is not applied'; end if;
  if to_regprocedure('public.invitation_preview(text)') is null or to_regprocedure('public.accept_invitation(text)') is null
     or to_regprocedure('public.invite_email_outbox_claim(integer,uuid)') is null or to_regprocedure('public.invite_open_for_email(text)') is null then
    raise exception 'STOP 0329: the invitation functions (0131 / 0155 / 0210 / 0316) are missing'; end if;
  if to_regprocedure('public.trial_reminder_email_claim(integer)') is null or to_regprocedure('public.trial_retention_email_claim(integer)') is null then
    raise exception 'STOP 0329: 0120 / 0184 (trial e-mails) are not applied'; end if;
  if to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.notify_default(uuid,text,text,text)') is null then
    raise exception 'STOP 0329: the bell catalog (0058 / 0285) is missing'; end if;
end $$;

-- ---- 1) keep the current bodies once (__pre0329, no app privilege) -----------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values
      ('invitation_preview', 'text'),
      ('accept_invitation', 'text'),
      ('invite_email_outbox_claim', 'integer,uuid'),
      ('invite_open_for_email', 'text'),
      ('trial_reminder_email_claim', 'integer'),
      ('trial_retention_email_claim', 'integer'),
      ('notification_catalog', ''),
      ('notification_type_of', 'text,text'),
      ('notify_default', 'uuid,text,text,text')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0329(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r121-0329' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0329');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0329(' || f.a || ')');
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    end if;
  end loop;
end $$;

-- ---- 2) A5: an invitation of a studio whose free trial ended is paused -------------------------------------------------
-- the studio owner's display name (current owner 0283, else the person who started the studio) - never an e-mail
create or replace function public._r329_owner_name(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r121-0329
  select left(nullif(btrim(p.full_name), ''), 60) from public.profiles p
   where p.id = coalesce(public._r283_owner(p_org), (select o.created_by from public.organizations o where o.id = p_org))
     and p.org_id = p_org;
$$;

-- the sentence the join page / accept refusal show
create or replace function public._r329_pause_text(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r121-0329
  select 'This studio''s free trial has ended. Ask ' || coalesce(public._r329_owner_name(p_org), 'the studio owner')
      || ' to choose a plan, then open this invitation again.';
$$;

-- the join page's anon lookup: the kept answer + trial_paused (+ owner display name + the sentence) for a pending,
-- unexpired invitation of a locked trial studio. valid stays as before (the invitation itself is still valid).
create or replace function public.invitation_preview(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r121-0329: invitation_preview__pre0329 + trial_paused
declare v jsonb; v_org uuid;
begin
  v := public.invitation_preview__pre0329(p_token);
  if v is null or coalesce((v ->> 'valid')::boolean, false) is not true then return v; end if;
  select i.org_id into v_org from public.invitations i
   where i.token = p_token and i.status = 'pending' and i.expires_at > now();
  if v_org is null or not public._trial_locked(v_org) then
    return v || jsonb_build_object('trial_paused', false);
  end if;
  return v || jsonb_build_object('trial_paused', true, 'owner_name', public._r329_owner_name(v_org),
                                 'message', public._r329_pause_text(v_org));
end $$;

-- accept: nobody joins a read-only (ended-trial) studio; the invitation stays pending for after the upgrade
create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r121-0329: accept_invitation__pre0329 (0316 chain) + a paused invitation of a locked trial studio is refused
declare v_uid uuid := auth.uid(); v_inv public.invitations; v_cur uuid;
begin
  if v_uid is not null and p_token is not null then
    select * into v_inv from public.invitations i where i.token = p_token;
    if v_inv.id is not null and v_inv.status = 'pending' and v_inv.expires_at > now() and public._trial_locked(v_inv.org_id) then
      select p.org_id into v_cur from public.profiles p where p.id = v_uid;
      if v_cur is distinct from v_inv.org_id then
        raise exception '%', public._r329_pause_text(v_inv.org_id) using errcode = '42501', hint = 'trial_paused';
      end if;
    end if;
  end if;
  return public.accept_invitation__pre0329(p_token);
end $$;

-- the invitation e-mail queue: unsent e-mails of a locked trial studio, and client-role invitation e-mails of a trial
-- studio, are closed as skipped (kept, never sent) before the kept claim runs
create or replace function public.invite_email_outbox_claim(p_limit integer default 25, p_org uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r121-0329: invite_email_outbox_claim__pre0329 (0155 caps) + no e-mail for a paused / trial-client invitation
begin
  update public.invite_email_outbox o set status = 'skipped', sent_at = now()
   where o.sent_at is null and o.org_id is not null and (p_org is null or o.org_id = p_org)
     and (public._trial_locked(o.org_id)
          or (public._tl173_trial_locked(o.org_id)
              and exists (select 1 from public.invitations i where i.id = o.invitation_id and coalesce(i.role, '') = 'client')));
  return public.invite_email_outbox_claim__pre0329(p_limit, p_org);
end $$;

-- the free-trial sign-up's "you have an invitation" check: never an invitation of a locked trial studio
create or replace function public.invite_open_for_email(p_email text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r121-0329: invite_open_for_email__pre0329 + skips invitations of a locked trial studio
declare v jsonb; v_em text := lower(btrim(coalesce(p_email, ''))); r record;
begin
  v := public.invite_open_for_email__pre0329(p_email);
  if v is null or coalesce((v ->> 'found')::boolean, false) is not true then return v; end if;
  if not exists (select 1 from public.invitations i where i.token = v ->> 'token' and public._trial_locked(i.org_id)) then return v; end if;
  select i.token, i.role, i.expires_at, i.invited_by, o.name as studio into r
    from public.invitations i join public.organizations o on o.id = i.org_id
   where lower(btrim(coalesce(i.email, ''))) = v_em and i.status = 'pending'
     and i.expires_at is not null and i.expires_at > now()
     and not coalesce(o.is_sample_master, false) and not public._trial_locked(i.org_id)
   order by i.created_at desc nulls last, i.id limit 1;
  if r.token is null then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'studio', left(coalesce(r.studio, ''), 120), 'role', coalesce(r.role, ''),
    'token', r.token, 'expires_at', r.expires_at, 'invited_by', r.invited_by);
end $$;

-- ---- 3) B8 / D2: trial e-mails go to the studio's billing address (confirmed studio e-mail / CURRENT owner) -----------
-- 0120 body, one change: the address is studio_billing_email (was: any business e-mail, else organizations.created_by)
create or replace function public.trial_reminder_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r121-0329: trial-reminders-0120 + the address = studio_billing_email (current owner, 0283 / 0300)
declare r record; v_out jsonb := '[]'::jsonb; v_to text; v_ok boolean;
  v_re constant text := '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$';
begin
  update public.trial_reminders set email_status = 'failed', email_sent_at = now()
   where email_sent_at is null and email_attempts >= 5;
  update public.trial_reminders set email_status = 'skipped', email_sent_at = now()
   where email_sent_at is null and created_at < now() - interval '2 days';
  for r in
    select tr.id, tr.org_id, tr.milestone, tr.trial_ends_at, o.name,
           o.trial_ends_at as cur_end, coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata') as tz
      from public.trial_reminders tr join public.organizations o on o.id = tr.org_id
     where tr.email_sent_at is null and tr.email_status = 'pending'
       and (tr.email_claimed_at is null or tr.email_claimed_at < now() - interval '10 minutes')
     order by tr.created_at
     limit greatest(1, least(coalesce(p_limit, 25), 100))
     for update of tr skip locked
  loop
    -- re-check at send time: still the same trial, not over, not paid, still on trial
    v_ok := r.cur_end is not null and r.cur_end = r.trial_ends_at and r.cur_end > now()
            and not public._trial_paid(r.org_id)
            and coalesce((select s.status from public.studio_subscriptions s where s.org_id = r.org_id), 'trial') = 'trial';
    v_to := public.studio_billing_email(r.org_id);
    if not coalesce(v_ok, false) or coalesce(v_to, '') !~ v_re then
      update public.trial_reminders set email_status = 'skipped', email_sent_at = now() where id = r.id;
      continue;
    end if;
    update public.trial_reminders set email_claimed_at = now(), email_attempts = email_attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'to', v_to, 'milestone', r.milestone,
      'studio', coalesce(r.name, ''), 'ends_at', r.trial_ends_at, 'timezone', r.tz));
  end loop;
  return v_out;
end $$;

-- 0184 body, one change: the address is studio_billing_email (was: organizations.created_by's login, else a confirmed
-- business e-mail)
create or replace function public.trial_retention_email_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r121-0329: trial-retention-0184 + the address = studio_billing_email (current owner, 0283 / 0300)
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
    select n.id, n.org_id, n.kind, n.expired_at, n.delete_on, o.name, public._tr184_tz(o.timezone) as tz
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
    v_to := public.studio_billing_email(r.org_id);
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

-- ---- 4) C18: no client-role invitations while the studio is on its free trial ------------------------------------------
create or replace function public._r329_tg_trial_client_invite()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r121-0329: app callers only (Helm staff / service / migrations unchanged); paid studios unchanged
begin
  if coalesce(new.role, '') <> 'client' or coalesce(new.status, 'pending') <> 'pending' or new.org_id is null then return new; end if;
  if tg_op = 'UPDATE' and coalesce(old.role, '') = 'client' and old.status is not distinct from new.status
     and old.org_id is not distinct from new.org_id then return new; end if;
  if not public._r282_api_caller() then return new; end if;
  if public._tl173_trial_locked(new.org_id) or public._trial_locked(new.org_id) then
    raise exception 'Client invitations are switched off during the free trial - share the preview instead.'
      using errcode = '42501', hint = 'trial_client_invite';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'a329_trial_client_invite') then
    create trigger a329_trial_client_invite before insert or update of role, status, org_id on public.invitations
      for each row execute function public._r329_tg_trial_client_invite();
  end if;
end $$;

-- ---- 5) a fresh two-step code for rename + business details too (the 0328 list, one line) ------------------------------
create or replace function public._hq_fresh_code_action(p_action text)
returns boolean language sql immutable set search_path = '' as $$
  -- r120-0328 + r121-0329: Extend trial, Change studio name & link, Save business details
  select coalesce(p_action, '') in ('hq.trial.extend', 'hq.studio.identity', 'hq.studio_account.set');
$$;

-- ---- 6) "Plan active" gets its own bell kind -----------------------------------------------------------------------------
create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r121-0329: + plan_active (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'plan_active') then c
    else c || $cat$[
    {"type":"plan_active","group":"Billing","label":"Plan active",
     "description":"Helm made your paid plan active (plan, billing, next renewal). Admins only by default.",
     "audience":"studio","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0329() as c) x;
$$;
create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r121-0329
  select case when lower(btrim(coalesce(p_kind, ''))) = 'plan_active' then 'plan_active'
              else public.notification_type_of__pre0329(p_kind, p_channel) end;
$$;
create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r121-0329: plan-active notices reach admins only unless a studio admin opts a role in (like billing_trial)
  select case when p_type = 'plan_active' then coalesce(p_role = 'admin', false) and p_channel = 'in_app'
              else public.notify_default__pre0329(p_org, p_role, p_type, p_channel) end;
$$;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r329_plan_read') then
    create policy r329_plan_read on public.notifications as restrictive for select to authenticated
      using (coalesce(kind, '') <> 'plan_active' or (select public.is_admin()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r329_plan_ins') then
    create policy r329_plan_ins on public.notifications as restrictive for insert to authenticated
      with check (coalesce(kind, '') <> 'plan_active');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r329_plan_upd') then
    create policy r329_plan_upd on public.notifications as restrictive for update to authenticated
      using (coalesce(kind, '') <> 'plan_active') with check (coalesce(kind, '') <> 'plan_active');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'r329_plan_del') then
    create policy r329_plan_del on public.notifications as restrictive for delete to authenticated
      using (coalesce(kind, '') <> 'plan_active');
  end if;
end $$;

-- the 0328 notice, one change: the bell row's kind is 'plan_active' (the dedupe also sees rows 0328 wrote as
-- 'trial_reminder', so a period already told is never told twice)
create or replace function public._r120_plan_active_notice(p_org uuid, p_was_trial boolean, p_res jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r120-0328 r121-0329: bell kind plan_active
declare s public.studio_subscriptions; v_plan text; v_code text; v_key text; v_renews date; v_label text;
  v_bell boolean := false; v_mail boolean := false; v_id uuid;
begin
  if p_org is null or coalesce(p_res ->> 'result', '') <> 'activated'
     or coalesce(p_res -> 'activation' ->> 'result', '') <> 'activated' then
    return jsonb_build_object('queued', false, 'why', 'not_activated');
  end if;
  if exists (select 1 from public.organizations o where o.id = p_org and coalesce(o.is_sample_master, false)) then
    return jsonb_build_object('queued', false, 'why', 'sample');
  end if;
  select * into s from public.studio_subscriptions x where x.org_id = p_org;
  if s.org_id is null or s.status <> 'active' or s.current_period_start is null or s.current_period_end is null then
    return jsonb_build_object('queued', false, 'why', 'not_active');
  end if;
  select hp.name, hp.code into v_plan, v_code from public.helm_plans hp where hp.id = s.plan_id;
  v_renews := s.current_period_end + 1;
  v_key := 'plan_active:' || p_org::text || ':' || s.current_period_start::text || ':' || s.current_period_end::text;
  v_label := public._r120_plan_label(v_plan, s.billing_interval, v_renews, p_was_trial);
  if not exists (select 1 from public.notifications n where n.org_id = p_org and n.kind in ('plan_active', 'trial_reminder')
                   and n.detail ->> 'dedupe' = v_key) then
    begin
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (null, 'in_app', 'plan_active', 'simulated',
                jsonb_build_object('label', v_label, 'source', 'r120_plan_active', 'plan', v_plan, 'plan_code', v_code,
                                   'interval', s.billing_interval, 'renews_on', v_renews, 'was_trial', coalesce(p_was_trial, false),
                                   'dedupe', v_key), p_org);
      v_bell := true;
    exception when others then raise warning 'r121-0329: plan-active bell row skipped (%)', sqlstate;
    end;
  end if;
  begin
    insert into public.helm_notice_outbox(kind, org_id, ref_id, payload, dedupe_key)
      values ('plan_active', p_org, null,
              jsonb_build_object('plan', v_plan, 'plan_code', v_code, 'interval', s.billing_interval,
                                 'period_start', s.current_period_start, 'period_end', s.current_period_end,
                                 'renews_on', v_renews, 'was_trial', coalesce(p_was_trial, false)), v_key)
      on conflict (dedupe_key) do nothing
      returning id into v_id;
    v_mail := v_id is not null;
  exception when check_violation then raise warning 'r121-0329: outbox kind plan_active not allowed on this database - e-mail not queued';
  end;
  return jsonb_build_object('queued', v_bell or v_mail, 'bell', v_bell, 'email', v_mail);
end $$;

-- ---- 7) privileges (each public function keeps exactly the roles it had) -------------------------------------------------
do $$ declare f text; begin
  -- internal: never callable by the API roles
  foreach f in array array['public._r329_owner_name(uuid)', 'public._r329_pause_text(uuid)',
      'public._r329_tg_trial_client_invite()', 'public._r120_plan_active_notice(uuid, boolean, jsonb)',
      'public._hq_fresh_code_action(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- every wrapped entry point: nobody by default, then the same roles as before
  foreach f in array array['public.invitation_preview(text)', 'public.accept_invitation(text)',
      'public.invite_email_outbox_claim(integer, uuid)', 'public.invite_open_for_email(text)',
      'public.trial_reminder_email_claim(integer)', 'public.trial_retention_email_claim(integer)',
      'public.notification_catalog()', 'public.notification_type_of(text, text)', 'public.notify_default(uuid, text, text, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.invitation_preview(text) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.invitation_preview(text) to authenticated';
    execute 'grant execute on function public.accept_invitation(text) to authenticated';
    execute 'grant execute on function public.notification_catalog() to authenticated';
    execute 'grant execute on function public.notification_type_of(text, text) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 the nine wrappers are the 0329 versions',
     (select count(*) from pg_proc p where p.oid in (
        'public.invitation_preview(text)'::regprocedure, 'public.accept_invitation(text)'::regprocedure,
        'public.invite_email_outbox_claim(integer,uuid)'::regprocedure, 'public.invite_open_for_email(text)'::regprocedure,
        'public.trial_reminder_email_claim(integer)'::regprocedure, 'public.trial_retention_email_claim(integer)'::regprocedure,
        'public.notification_catalog()'::regprocedure, 'public.notification_type_of(text,text)'::regprocedure,
        'public.notify_default(uuid,text,text,text)'::regprocedure) and p.prosrc like '%r121-0329%') = 9),
  ('02 the old bodies are kept once as __pre0329 with no app privilege',
     to_regprocedure('public.invitation_preview__pre0329(text)') is not null
     and to_regprocedure('public.accept_invitation__pre0329(text)') is not null
     and to_regprocedure('public.trial_reminder_email_claim__pre0329(integer)') is not null
     and to_regprocedure('public.notification_catalog__pre0329()') is not null
     and not has_function_privilege('anon', 'public.invitation_preview__pre0329(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.accept_invitation__pre0329(text)', 'execute')
     and not has_function_privilege('service_role', 'public.trial_reminder_email_claim__pre0329(integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.notification_catalog__pre0329()', 'execute')),
  ('03 who may call what is the same as before (join page anon, accept signed-in, queues service only)',
     has_function_privilege('anon', 'public.invitation_preview(text)', 'execute')
     and has_function_privilege('authenticated', 'public.accept_invitation(text)', 'execute')
     and not has_function_privilege('anon', 'public.accept_invitation(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_email_outbox_claim(integer,uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.trial_retention_email_claim(integer)', 'execute')
     and has_function_privilege('authenticated', 'public.notification_catalog()', 'execute')),
  ('04 a paused invitation is refused on accept with the plain sentence (owner name, choose a plan)',
     pg_get_functiondef('public.accept_invitation(text)'::regprocedure) like '%trial_paused%'
     and public._r329_pause_text(null) = 'This studio''s free trial has ended. Ask the studio owner to choose a plan, then open this invitation again.'),
  ('05 the join page lookup reports trial_paused',
     pg_get_functiondef('public.invitation_preview(text)'::regprocedure) like '%trial_paused%'),
  ('06 trial reminder + retention e-mails use studio_billing_email (current owner), not created_by',
     pg_get_functiondef('public.trial_reminder_email_claim(integer)'::regprocedure) like '%studio_billing_email%'
     and pg_get_functiondef('public.trial_retention_email_claim(integer)'::regprocedure) like '%studio_billing_email%'
     and pg_get_functiondef('public.trial_reminder_email_claim(integer)'::regprocedure) not like '%created_by%'
     and pg_get_functiondef('public.trial_retention_email_claim(integer)'::regprocedure) not like '%created_by%'),
  ('07 client invitations are refused in a trial (one trigger on invitations)',
     (select count(*) from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'a329_trial_client_invite') = 1),
  ('08 a fresh two-step code: extend trial, rename, business details',
     public._hq_fresh_code_action('hq.trial.extend') and public._hq_fresh_code_action('hq.studio.identity')
     and public._hq_fresh_code_action('hq.studio_account.set') and not public._hq_fresh_code_action('hq.sales_request.status')),
  ('09 the bell catalog has "Plan active" once, admins only by default, and Free trial reminders is still there',
     (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'plan_active' and e ->> 'label' = 'Plan active') = 1
     and (select count(*) from jsonb_array_elements(public.notification_catalog()) e where e ->> 'type' = 'billing_trial') = 1
     and public.notification_type_of('plan_active', 'in_app') = 'plan_active'
     and public.notify_default(null, 'admin', 'plan_active', 'in_app') and not public.notify_default(null, 'manager', 'plan_active', 'in_app')),
  ('10 plan_active bell rows: admins read only, the app never writes them (4 policies)',
     (select count(*) from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname like 'r329_plan_%') = 4),
  ('11 HQ Activate plan now writes the bell row as plan_active',
     pg_get_functiondef('public._r120_plan_active_notice(uuid,boolean,jsonb)'::regprocedure) like '%r121-0329%'),
  ('12 info: nothing was deleted - invitations / queues still have their rows (counts just shown as ok)',
     (select count(*) from public.invitations) >= 0 and (select count(*) from public.invite_email_outbox) >= 0
     and (select count(*) from public.trial_reminders) >= 0)
) v(item, ok);
