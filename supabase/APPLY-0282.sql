-- APPLY-0282.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER 0277 (and after 0281 if PR #268 went first - order-independent of 0278-0281).
-- R32 security review (owner-authorised): QC sign-off follows the access matrix; the invitation e-mail carries a
-- second secret so a studio admin can't pre-make a ready-to-use login for someone else's e-mail; a full studio gets
-- the same answer for every address; no studio while on a temporary password; no self-approval of change requests,
-- discounts and closing-with-money-owed need the new Control Center switches (admin always); a closed event's money
-- side is frozen (late payments still recorded + logged; an admin can re-open); paid plan seat limits for NEW
-- invites / members only (Starter = you + 2 invites, Studio = 15); currency of a paid / approved quote; sample
-- adoption counts in a locked trial; Helm-owned studio settings locked. R32b (review round 2): lowering the price
-- of a confirmed / paid event needs "Approve discounts"; change requests can't take the invoice below what was
-- paid; payments after closing (milestone / Settlement) work and are logged; close requests respect "Close events
-- with money owed"; joining counts only people already in the studio, and a lapsed subscription keeps its plan
-- limit; "Add user" refusals are counted per studio. 2 nullable columns + 1 private table added, new helper
-- functions / triggers, functions re-issued in place (same names / arguments). Nothing dropped, no data deleted.
-- Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the edge functions invite-mailer, invite-signup (mail key), razorpay-webhook (signed-body dedupe),
--      send-whatsapp (link check, R32b: one rewritten rule + bundled TLD list tlds.ts), captcha-verify (action check)
--      and every function that sends e-mail over SMTP (shared smtp.ts: STARTTLS on any port other than 465, R32b:
--      found in a long EHLO too - Gmail on 465 is unchanged).
--   3  Deploy the site (store-api.js?v=285, control.html, login.html, closure.html, auth-confirm.js, telemetry.js,
--      hq.js).
--   4  Check: Control Center -> Users & access -> Manager: the Finance group shows "Approve discounts (price
--      decreases)" and "Close events with money owed" (off). A Starter studio with you + 2 people: Users shows
--      "Your plan allows 2 team invites. Contact sales to add more."
begin;
-- 0282_r32_security_review.sql - CANONICAL forward-only.
-- REQUIRES the base event_tasks / verify_task, 0028 (auth_temp_passwords, clear_password_change_required),
--          0043 + 0126 (current_org_id chain), 0046 (_a46_tg_money_freeze), 0049 + 0148 + 0198 (_a49_close_gate),
--          0052 (consent_stale columns), 0097 + 0182 (_a97_tg_demo_flag_guard), 0131 (invitations e-mail trigger),
--          0155 (a155_admin_created, admin_create_user wrapper), 0166 + 0179 (seat triggers, _trial_seat_limit),
--          0173 + 0181 + 0236 (trial lock + 2-row caps), 0264 (record_payment / record_settlement_payment wrappers),
--          0027 (settle_milestone), 0069 (package selections), 0254 (close requests: decide_event_close, _r22_close_checks).
--
-- In plain words (r32 security review, owner-authorised):
--   ACL-01  QC sign-off (verify_task) also needs the role's "Staff" area in the Control Center matrix (view), and it
--           answers only the task id + QC result - no longer the whole task row (assignee phone / e-mail).
--   AUTH-1  invitations get a nullable mail_key_hash. The invitation e-mail carries a second secret (&k=); only its
--           SHA-256 is stored. invite-signup makes a ready-to-use (confirmed) login ONLY with that key, otherwise
--           the normal confirm-by-e-mail sign-up runs. The studio admin can't set the hash through the API.
--           invite_mail_key_set / invite_signup_record are for the edge functions (service role) only.
--   AUTH-2  admin_create_user checks the seat limit BEFORE it looks the e-mail up, so a full studio gets the same
--           answer for every address (no "this e-mail has an account" oracle).
--   AUTH-3  a member still on the temporary password an admin gave them has no studio (current_org_id is empty)
--           until they choose their own password. The password change itself never needs the studio.
--   BIZ-01  change requests: nobody approves their own request (an admin only when there is no other admin);
--           a price DECREASE needs the new matrix switch "Approve discounts" (admin always); every approval is
--           in the activity log. Closing an event with money still owed needs the new matrix switch "Close events
--           with money owed" (admin always), still with a written reason, still logged.
--   BIZ-02  a CLOSED event's money side is frozen for app users: pricing / currency, change requests, expense claims,
--           payment milestones and refunds - "This event is closed - re-open it first". Recording a late payment
--           still works (and is logged); an admin re-opening the event still works.
--   BIZ-03  helm_plans.seat_limit (people incl. the owner): starter 3 (the owner + 2 invites), studio 15. A paid
--           studio's NEW invitations / NEW members respect it; existing members are never removed or blocked.
--           The owner changes a plan's limit by editing helm_plans.seat_limit (HQ can still set one studio's own
--           organizations.seat_limit, which wins).
--   BIZ-04  a quote's currency can't change once a payment is recorded; changed after approval = client must
--           approve again (consent_stale), same as a price change.
--   BIZ-05  in a locked free trial, renaming a sample ("adopting" it) counts against the 2-row limit like a new row.
--   BIZ-06  is_sample_master / seat_limit / sample_source_org / sample_batch_id / sample_version / sample_cloned_at
--           can't be changed through the API.
-- R32b (review round 2):
--   - lowering the price of a CONFIRMED or PAID event (discount, tax, any pricing field) needs "Approve discounts"
--     (admin always) and is logged; editing before confirmation and the client's package choice are unchanged;
--   - approving a change request that would leave the invoice below what was paid: "record a refund first";
--   - "Mark milestone paid" and Settlement payments after closing work (milestones marked) and are logged;
--   - approving a close request respects "Close events with money owed"; the failed balance check reads
--     "Client balance still due";
--   - seats: joining counts only the people already in the studio (open invitations count when an invitation is
--     made); a studio with ANY subscription row (also cancelled / suspended) keeps its plan's limit - no limit only
--     with no subscription row and no per-studio number (HQ-created studios);
--   - admin_create_user: "send them an invitation instead" refusals are counted per studio (new private table
--     r282_acu_refusals, 20 a day) and answered (null / { refused: true }) instead of raised, so the count is kept.
-- Changes: 2 nullable columns added (invitations.mail_key_hash, helm_plans.seat_limit; seat_limit filled for the two
-- plans only where empty), 1 new private table (r282_acu_refusals), new helper functions / triggers, functions
-- re-issued in place with the same names and arguments (settle_milestone / _r22_close_checks: bodies kept as
-- *__pre0282). No table, column, row or policy is dropped; no data is deleted. Safe to run twice. ASCII only.

-- ---- STOP guard: the pieces this builds on ----------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.verify_task(uuid, boolean, text)') is null then raise exception 'STOP 0282: verify_task (base schema) is missing'; end if;
  if to_regprocedure('public.current_org_id__pre0043()') is null or to_regprocedure('public._trial_member_blocked(uuid)') is null then
    raise exception 'STOP 0282: 0043 / 0126 (current_org_id chain) are not applied'; end if;
  if to_regclass('public.auth_temp_passwords') is null then raise exception 'STOP 0282: 0028 (auth_temp_passwords) is not applied'; end if;
  if to_regprocedure('public.admin_create_user__pre0155(text, text, text)') is null or to_regclass('public.a155_admin_created') is null then
    raise exception 'STOP 0282: 0155 (admin_create_user wrapper, a155_admin_created) is not applied'; end if;
  if to_regprocedure('public._a49_close_blockers(uuid)') is null or to_regprocedure('public._a198_org_today(uuid)') is null
     or to_regclass('public.event_close_overrides') is null then
    raise exception 'STOP 0282: 0049 / 0198 (close gate) are not applied'; end if;
  if to_regprocedure('public.record_payment__pre0264(uuid, numeric, text, text, uuid, text, text)') is null or to_regprocedure('public._pst_allocate(uuid)') is null then
    raise exception 'STOP 0282: 0264 (payment schedules) is not applied'; end if;
  if to_regprocedure('public._ts166_tg_invite_seat()') is null or to_regprocedure('public._is_trial_org(uuid)') is null then
    raise exception 'STOP 0282: 0166 (seat limits) is not applied'; end if;
  if to_regprocedure('public._tl181_used(uuid, text)') is null or to_regprocedure('public._tl173_trial_locked(uuid)') is null
     or to_regprocedure('public._is_system_change()') is null then
    raise exception 'STOP 0282: 0173 / 0181 (trial caps) are not applied'; end if;
  if not exists (select 1 from pg_attribute where attrelid = 'public.quotes'::regclass and attname = 'consent_stale' and not attisdropped) then
    raise exception 'STOP 0282: 0052 (consent_stale) is not applied'; end if;
  if to_regprocedure('public.tg_mass_assign_guard()') is null or to_regclass('public.helm_plans') is null or to_regclass('public.studio_subscriptions') is null then
    raise exception 'STOP 0282: mass-assignment guard / plans are missing'; end if;
end $$;

-- ---- 0) shared helpers --------------------------------------------------------------------------------------------
-- an app (API) caller, read from the JWT (works inside SECURITY DEFINER code too)
create or replace function public._r282_api_caller()
returns boolean language sql stable set search_path = '' as $$
  -- r32-0282
  select coalesce(auth.jwt() ->> 'role', '') in ('anon', 'authenticated');
$$;
revoke all on function public._r282_api_caller() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r282_api_caller() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r282_api_caller() from authenticated'; end if;
end $$;

-- the event (quote) exists and is closed
create or replace function public._r282_event_closed(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r32-0282
  select p_quote is not null and exists (
    select 1 from public.event_closure c join public.quotes q on q.id = c.quote_id
     where c.quote_id = p_quote and c.closed_at is not null);
$$;
revoke all on function public._r282_event_closed(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r282_event_closed(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r282_event_closed(uuid) from authenticated'; end if;
end $$;

-- ---- 1) ACL-01: verify_task honours the access matrix and answers only the QC fields ----------------------------------
create or replace function public.verify_task(p_id uuid, p_pass boolean, p_note text default null)
returns public.event_tasks language plpgsql security definer set search_path = 'public' as $$
-- r32-0282 ACL-01: role list AND the Staff area (the Ops page needs it to show tasks at all); answer = id + QC result only
declare row public.event_tasks; v_out public.event_tasks;
begin
  if not (public.user_role() in ('admin','manager','planner','quality')) or not public.has_area('staff', 'view') then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
  end if;
  update public.event_tasks set
    verify_status = case when p_pass then 'passed' else 'rejected' end,
    verified_by   = auth.uid(),
    verified_at   = now(),
    verify_note   = nullif(btrim(coalesce(p_note,'')),''),
    status        = case when p_pass then status else 'in_progress' end,
    completed_at  = case when p_pass then completed_at else null end
  where id = p_id and org_id = public.current_org_id()
  returning * into row;
  if not found then raise exception 'task not found'; end if;
  v_out.id := row.id; v_out.verify_status := row.verify_status; v_out.verified_at := row.verified_at;
  return v_out;
end $$;

-- ---- 2) AUTH-1: the invitation e-mail's second secret ---------------------------------------------------------------
alter table public.invitations add column if not exists mail_key_hash text;

-- only the edge functions (service role) set it; the studio admin's API update can't
create or replace function public._r282_tg_invite_key_guard()
returns trigger language plpgsql set search_path = '' as $$
-- r32-0282 AUTH-1
begin
  if current_user in ('anon', 'authenticated') and new.mail_key_hash is distinct from old.mail_key_hash then
    raise exception 'an invitation can only be revoked here' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists ab_r282_invite_key_guard on public.invitations;
create trigger ab_r282_invite_key_guard before update on public.invitations
  for each row execute function public._r282_tg_invite_key_guard();

create or replace function public.invite_mail_key_set(p_token text, p_hash text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r32-0282 AUTH-1: invite-mailer / invite-signup store SHA-256(mail key) of the e-mail they are about to send
begin
  if p_token is null or p_token !~ '^[0-9a-f]{16,128}$' or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  update public.invitations set mail_key_hash = p_hash where token = p_token and status = 'pending';
  return found;
end $$;
revoke all on function public.invite_mail_key_set(text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.invite_mail_key_set(text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.invite_mail_key_set(text, text) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.invite_mail_key_set(text, text) to service_role'; end if;
end $$;

create or replace function public.invite_signup_record(p_token text, p_user uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- r32-0282 AUTH-1: a login invite-signup made ready-to-use is recorded like an admin-made one (0155)
begin
  if p_token is null or p_user is null then return false; end if;
  insert into public.a155_admin_created(user_id, org_id, created_by, pw_hash)
    select u.id, i.org_id, i.invited_by, u.encrypted_password
      from public.invitations i join auth.users u on u.id = p_user and lower(u.email) = lower(i.email)
     where i.token = p_token
  on conflict (user_id) do nothing;
  return found;
end $$;
revoke all on function public.invite_signup_record(text, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.invite_signup_record(text, uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.invite_signup_record(text, uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.invite_signup_record(text, uuid) to service_role'; end if;
end $$;

-- ---- 3) BIZ-03: plan seat limits (people incl. the owner) -------------------------------------------------------------
alter table public.helm_plans add column if not exists seat_limit integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'helm_plans_seat_limit_r282' and conrelid = 'public.helm_plans'::regclass) then
    alter table public.helm_plans add constraint helm_plans_seat_limit_r282 check (seat_limit is null or seat_limit between 1 and 10000) not valid;
  end if;
end $$;
-- set once for the two plans, only where nobody chose a number yet (an owner's later change is never overwritten)
update public.helm_plans set seat_limit = 3  where code = 'starter' and seat_limit is null;
update public.helm_plans set seat_limit = 15 where code = 'studio'  and seat_limit is null;

create or replace function public._trial_seat_limit(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- trial-sandbox-0166: null = no limit
  -- r32-0282 BIZ-03: a studio with a subscription row gets its plan's seat_limit in ANY status (active, past_due,
  -- cancelled, suspended, ...), so a lapsed studio can't stack invitations and keep them on re-subscribing (R32b).
  -- HQ's per-studio number still wins; NULL (no limit) only with no subscription row and no per-studio number
  -- (HQ-created studios). Existing members are never removed.
  select case when public._is_trial_org(p_org) then coalesce(o.seat_limit, 3)
              else coalesce(o.seat_limit, (select p.seat_limit from public.studio_subscriptions s
                                             join public.helm_plans p on p.id = s.plan_id
                                            where s.org_id = p_org
                                            order by (s.status in ('active', 'past_due')) desc limit 1)) end
    from public.organizations o where o.id = p_org;
$$;

-- the refusal text: free trial (unchanged) or a paid plan (BIZ-03, owner's wording)
create or replace function public._r282_seat_refuse(p_org uuid, p_lim integer, p_invite boolean)
returns void language plpgsql stable set search_path = '' as $$
-- r32-0282
begin
  if public._is_trial_org(p_org) then
    if p_invite then
      raise exception 'Your free trial includes % people (you + % more). Remove an invitation or upgrade to add more.', p_lim, p_lim - 1
        using errcode = '42501', hint = 'seat_limit';
    end if;
    raise exception 'Your free trial includes % people (you + % more). Upgrade to add more.', p_lim, p_lim - 1
      using errcode = '42501', hint = 'seat_limit';
  end if;
  raise exception 'Your plan allows % team invite%. Contact sales to add more.', greatest(p_lim - 1, 0), case when p_lim - 1 = 1 then '' else 's' end
    using errcode = '42501', hint = 'plan_seat_limit', detail = jsonb_build_object('limit', p_lim)::text;
end $$;
revoke all on function public._r282_seat_refuse(uuid, integer, boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r282_seat_refuse(uuid, integer, boolean) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r282_seat_refuse(uuid, integer, boolean) from authenticated'; end if;
end $$;

-- members (clients don't count) + open staff invitations - the same count as the 0166 triggers / my_seat_usage
create or replace function public._r282_seats_used(p_org uuid)
returns integer language sql stable security definer set search_path = '' as $$
  -- r32-0282
  select ((select count(*) from public.profiles p where p.org_id = p_org and coalesce(p.role, '') <> 'client')
        + (select count(*) from public.invitations i
            where i.org_id = p_org and i.status = 'pending' and coalesce(i.role, '') <> 'client'
              and (i.expires_at is null or i.expires_at > now())
              and not exists (select 1 from public.profiles p where p.org_id = p_org and lower(p.email) = lower(i.email))))::integer;
$$;
revoke all on function public._r282_seats_used(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r282_seats_used(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r282_seats_used(uuid) from authenticated'; end if;
end $$;

-- the 0166 / 0179 seat triggers: same checks (only NEW invitations / NEW members), wording per trial / plan
create or replace function public._ts166_tg_invite_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: members + open invitations may not pass the seat limit
-- tb-msg-0179: a pending invitation whose role changes from client counts as a new seat
-- r32-0282 BIZ-03: paid plans too (_trial_seat_limit); plan wording
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
  select (select count(*) from public.profiles p where p.org_id = new.org_id and coalesce(p.role, '') <> 'client')
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
    into v_used;
  if v_used >= v_lim then perform public._r282_seat_refuse(new.org_id, v_lim, false); end if;
  return new;
end $$;

-- ---- 4) AUTH-2: admin_create_user - seat limit first, then the address --------------------------------------------
-- R32b (R2-AUTH-02): an address that can't be used ("send them an invitation instead": it has a login elsewhere or is
-- a Helm operator) is a REFUSAL that is now counted per studio, so the answer can't be used to test address after
-- address: 20 refusals in 24 hours (or 100 new accounts + refusals) and the studio's "Add user" waits until tomorrow.
-- To keep the count, a refusal is ANSWERED (admin_create_user -> null, admin_create_user_temp -> { refused: true,
-- error }) instead of raised (a raised error would roll the count back). Only a fingerprint of the address is kept.
-- (column studio_id, not org_id: an anti-abuse counter, not studio data - trial retention / read-only guards don't apply)
create table if not exists public.r282_acu_refusals (
  id bigserial primary key,
  studio_id uuid not null,
  actor uuid,
  email_hash text,
  created_at timestamptz not null default now()
);
create index if not exists r282_acu_refusals_org_idx on public.r282_acu_refusals (studio_id, created_at);
alter table public.r282_acu_refusals enable row level security;
revoke all on table public.r282_acu_refusals from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.r282_acu_refusals from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.r282_acu_refusals from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on sequence public.r282_acu_refusals_id_seq from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on sequence public.r282_acu_refusals_id_seq from authenticated'; end if;
end $$;

create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155 wrapper over the audit-run2-0042 / auth-hardening-0028 chain (admin_create_user__pre0155):
-- unpaid trial studios add people by invitation; paid studios max 100 new accounts a day; recorded.
-- r32-0282 AUTH-2: a studio with no free seat gets the seat answer BEFORE any e-mail lookup (same answer for every address)
-- R32b R2-AUTH-02: "send them an invitation instead" refusals are counted (r282_acu_refusals) and answered with null
declare v_org uuid := public.current_org_id(); v_uid uuid; v_n int; v_lim int; v_ref int; v_state text; v_msg text;
begin
  if v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._a155_unpaid_trial(v_org) then
    raise exception 'During the free trial, add people with an invitation - they confirm their own e-mail and choose their own password.'
      using errcode = '22023', hint = 'use_invitation';
  end if;
  perform pg_advisory_xact_lock(hashtext('a155:acu:' || v_org::text));
  if coalesce(p_role, '') <> 'client' then
    v_lim := public._trial_seat_limit(v_org);
    if v_lim is not null and public._r282_seats_used(v_org) >= v_lim then perform public._r282_seat_refuse(v_org, v_lim, false); end if;
  end if;
  select count(*) into v_n from public.a155_admin_created a where a.org_id = v_org and a.created_at > now() - interval '24 hours';
  select count(*) into v_ref from public.r282_acu_refusals r where r.studio_id = v_org and r.created_at > now() - interval '24 hours';
  if v_n + v_ref >= 100 or v_ref >= 20 then
    raise exception 'too many new accounts today - try again tomorrow, or send invitations instead' using errcode = '54000';
  end if;
  begin
    v_uid := public.admin_create_user__pre0155(p_email, p_password, p_role);
  exception when invalid_parameter_value then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if position('send them an invitation instead' in v_msg) = 0 then raise; end if;
    insert into public.r282_acu_refusals(studio_id, actor, email_hash)
      values (v_org, auth.uid(), encode(extensions.digest(lower(btrim(coalesce(p_email, ''))), 'sha256'), 'hex'));
    return null;
  end;
  insert into public.a155_admin_created(user_id, org_id, created_by, pw_hash)
    select v_uid, v_org, auth.uid(), u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do nothing;
  return v_uid;
end $$;

-- auth-hardening-0028 / password-rule-0030 body, unchanged except: a refused address (null from admin_create_user,
-- R32b R2-AUTH-02) answers { refused: true, error } - nothing is created and no temporary password is made
create or replace function public.admin_create_user_temp(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- auth-hardening-0028 / password-rule-0030
-- R32b R2-AUTH-02: refusal answered, not raised (so the per-studio refusal count is kept)
declare v_uid uuid; v_temp text; v_sym text := '!#%*-_+=?';
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  -- 'H' (upper) + 'm' (lower) + 16 random base64 chars (96 bits) + one random digit
  -- + one random symbol: always >= 12 chars with all four kinds.
  v_temp := 'Hm' || translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9')
         || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text
         || substr(v_sym, 1 + get_byte(extensions.gen_random_bytes(1), 0) % length(v_sym), 1);
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  if v_uid is null then
    return jsonb_build_object('refused', true, 'code', '22023',
                              'error', 'could not create this user - send them an invitation instead');
  end if;
  update public.profiles set must_change_password = true where id = v_uid;
  insert into public.auth_temp_passwords (user_id, pw_hash)
    select u.id, u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $$;

-- ---- 5) AUTH-3: no studio while the admin-given temporary password is still in use ---------------------------------
create or replace function public._r282_temp_pw_pending()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r32-0282 AUTH-3: must_change_password AND the login still has exactly the temporary password it was given
  select auth.uid() is not null and exists (
    select 1 from public.profiles p
      join public.auth_temp_passwords t on t.user_id = p.id
      join auth.users u on u.id = p.id
     where p.id = auth.uid() and coalesce(p.must_change_password, false) and u.encrypted_password = t.pw_hash);
$$;
revoke all on function public._r282_temp_pw_pending() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r282_temp_pw_pending() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public._r282_temp_pw_pending() to authenticated'; end if;
end $$;

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  -- trial-staff-0126: a non-owner member of an ended, unpaid trial studio has no studio until it pays
  -- r32-0282 AUTH-3: a member still on the admin-given temporary password has no studio until they choose their own
  select case when public.mfa_ok() and not public._trial_member_blocked(x.org) and not public._r282_temp_pw_pending() then x.org end
    from (select public.current_org_id__pre0043() as org) x;
$$;

-- ---- 6) BIZ-01: change-request approvals ----------------------------------------------------------------------------
create or replace function public._r282_tg_cr_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r32-0282 BIZ-01: no self-approval (an admin only when the studio has no other admin); a price decrease needs
-- "Approve discounts" (matrix area discount_approve, edit; admin always); every approval is logged
-- R32b (R2-BIZ low): an approval that would leave the invoice (quote total + approved changes) below what the client
-- has already paid (net of refunds) is refused - "record a refund first", the same rule as a quote's own total
declare v_me uuid := auth.uid(); v_role text := coalesce(public.user_role(), ''); v_self boolean;
        v_inv numeric; v_paid numeric;
begin
  if not public._r282_api_caller() then return new; end if;
  if new.status is not distinct from old.status or new.status <> 'approved' then return new; end if;
  v_self := old.created_by is not null and old.created_by = v_me;
  if v_self and not (v_role = 'admin' and not exists (
        select 1 from public.profiles p where p.org_id = old.org_id and p.role = 'admin' and p.id <> v_me)) then
    raise exception 'Someone else must approve a change request you entered.' using errcode = '42501', hint = 'self_approval';
  end if;
  if coalesce(new.price_delta, 0) < 0 and not public.has_area('discount_approve', 'edit') then
    raise exception 'Only an admin (or a role allowed to approve discounts) can approve a change that lowers the price.'
      using errcode = '42501', hint = 'discount_approval';
  end if;
  if coalesce(new.price_delta, 0) < 0 then
    perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || old.quote_id::text, 0));
    v_inv := public.helm_invoice_total(old.quote_id) + coalesce(new.price_delta, 0);
    v_paid := public.helm_total_paid(old.quote_id, null, null)
              - coalesce((select sum(r.amount) from public.event_refunds r
                           where r.quote_id = old.quote_id and r.kind = 'refund' and r.status in ('approved', 'processed')), 0);
    if v_paid > 0 and v_inv < v_paid - 0.5 then
      raise exception 'Approving this change would make the invoice (%) lower than what the client has already paid (%) - record a refund first.',
        round(v_inv, 2), round(v_paid, 2) using errcode = '23514', hint = 'below_paid';
    end if;
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, (select u.email from auth.users u where u.id = v_me), 'change_request_approved', 'change_requests',
            old.id::text, old.quote_id,
            jsonb_build_object('price_delta', new.price_delta, 'cost_delta', new.cost_delta, 'title', left(coalesce(new.title, ''), 200),
                               'created_by', old.created_by, 'self_approved', v_self, 'role', v_role),
            old.org_id);
  return new;
end $$;
drop trigger if exists ad_r282_cr_approval on public.change_requests;
create trigger ad_r282_cr_approval before update on public.change_requests
  for each row execute function public._r282_tg_cr_approval();

-- closing with something outstanding: admin, or (money owed ONLY) a role with "Close events with money owed"
create or replace function public._a49_close_gate(p_quote uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
-- close-gate-0148: ASCII-only messages; helm-0198-stages: no closing before the event day is over
-- r32-0282 BIZ-01: a balance owed (nothing else outstanding) may also be overridden by a role with close_owed (edit)
declare b jsonb; v_org uuid := public.current_org_id(); v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
        v_status text; v_date date; v_today date; v_owed_only boolean;
begin
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then
    raise exception 'not authorized for this event' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || p_quote::text, 0));
  select q.status, q.event_date into v_status, v_date from public.quotes q where q.id = p_quote for update;
  -- 0198: hard rule, no override - an event that will not happen is cancelled instead
  v_today := public._a198_org_today(v_org);
  if coalesce(v_status, '') <> 'cancelled' and v_date is not null and v_date >= v_today then
    raise exception 'You can close this event after % (event day).', public._a198_day(v_date)
      using errcode = 'HL425', hint = 'event_not_over',
            detail = jsonb_build_object('event_date', v_date, 'studio_today', v_today)::text;
  end if;
  b := public._a49_close_blockers(p_quote);
  if not (b ->> 'blocked')::boolean then return; end if;
  if v_reason is null then
    raise exception 'Can''t close this event yet: %.', public._a49_blocker_text(b)
      using errcode = 'P0001', detail = b::text,
            hint = 'Collect the balance or return the equipment first, or an admin can close with an override reason.';
  end if;
  v_owed_only := coalesce((b ->> 'open_checkouts')::int, 0) = 0 and (b ->> 'not_booked') is null
                 and not coalesce((b ->> 'no_event_date')::boolean, false) and not coalesce((b ->> 'too_early')::boolean, false);
  if coalesce(public.user_role(), '') <> 'admin' and not (v_owed_only and public.has_area('close_owed', 'edit')) then
    raise exception 'Only an admin can close an event with something outstanding (%).', public._a49_blocker_text(b)
      using errcode = '42501';
  end if;
  if length(v_reason) < 5 or length(v_reason) > 1000 then
    raise exception 'override reason must be 5 to 1000 characters' using errcode = '22023';
  end if;
  insert into public.event_close_overrides(org_id, quote_id, actor, actor_email, reason, balance_owed, open_checkouts, blockers)
    values (v_org, p_quote, auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), v_reason,
            (b ->> 'balance_owed')::numeric, (b ->> 'open_checkouts')::int, b);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'close_override', 'event_closure',
            p_quote::text, p_quote, jsonb_build_object('reason', v_reason, 'blockers', b, 'role', public.user_role()), v_org);
end $$;

-- ---- 7) BIZ-02: a closed event's money side is frozen for app users -------------------------------------------------
create or replace function public._r282_tg_closed_freeze()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r32-0282 BIZ-02
declare v_q uuid; v_q2 uuid;
begin
  if not public._r282_api_caller() then return coalesce(new, old); end if;
  if tg_table_name = 'quotes' then
    if new.pricing is not distinct from old.pricing and new.currency is not distinct from old.currency then return new; end if;
    v_q := new.id;
  elsif tg_op = 'DELETE' then v_q := old.quote_id;
  elsif tg_op = 'UPDATE' then v_q := new.quote_id; v_q2 := old.quote_id;
  else v_q := new.quote_id;
  end if;
  -- record_payment (allowed after closing, logged) marks the milestones its money covers
  if coalesce(current_setting('helm.r282_pay', true), '') <> '' and current_setting('helm.r282_pay', true) = coalesce(v_q::text, '') then
    return coalesce(new, old);
  end if;
  if public._r282_event_closed(v_q) or (v_q2 is distinct from v_q and public._r282_event_closed(v_q2)) then
    raise exception 'This event is closed - re-open it first (an admin can re-open it from its Closure page).'
      using errcode = '42501', hint = 'event_closed';
  end if;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['change_requests', 'expense_claims', 'payment_milestones', 'event_refunds'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists aa_r282_closed_freeze on public.%I', t);
      execute format('create trigger aa_r282_closed_freeze before insert or update or delete on public.%I for each row execute function public._r282_tg_closed_freeze()', t);
    end if;
  end loop;
end $$;
drop trigger if exists aa_r282_closed_freeze on public.quotes;
create trigger aa_r282_closed_freeze before update on public.quotes
  for each row execute function public._r282_tg_closed_freeze();

-- record_payment: still allowed on a closed event (a late payment after an admin's override close), now logged
create or replace function public.record_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                 p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- pay-schedule-0264: the receipt row is written to quote_payments by record_payment__pre0264 (ledger + caps unchanged),
-- then every milestone the money now fully covers is paid
-- r32-0282 BIZ-02: allowed after closing (the closed-event freeze lets this call mark milestones) and logged
declare v_out jsonb; v_n integer := 0; v_closed boolean := public._r282_event_closed(p_quote);
begin
  if v_closed then perform set_config('helm.r282_pay', p_quote::text, true); end if;
  v_out := public.record_payment__pre0264(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false) then
    begin v_n := public._pst_allocate(p_quote);
    exception when others then v_n := 0; raise warning 'pay-schedule-0264: milestone cover skipped (%)', sqlstate;
    end;
    if v_n > 0 then v_out := v_out || jsonb_build_object('milestones_covered', v_n); end if;
    if v_closed then
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
        select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'payment_after_close', 'quote_payments',
               p_quote::text, p_quote, jsonb_build_object('amount', p_amount, 'method', p_method, 'receipt_no', p_receipt_no), q.org_id
          from public.quotes q where q.id = p_quote;
    end if;
  end if;
  if v_closed then perform set_config('helm.r282_pay', '', true); end if;
  return v_out;
end $$;

-- ---- 8) BIZ-04: the currency of a paid / approved quote -----------------------------------------------------------
create or replace function public._r282_tg_quote_currency()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r32-0282 BIZ-04: refused once a payment is recorded; after approval = the client must approve again
declare v_def text; v_old text; v_new text;
begin
  if not public._r282_api_caller() then return new; end if;
  if new.pricing is not distinct from old.pricing and new.currency is not distinct from old.currency then return new; end if;
  select upper(coalesce(nullif(btrim(o.currency), ''), 'INR')) into v_def from public.organizations o where o.id = new.org_id;
  v_old := upper(coalesce(nullif(btrim(old.pricing ->> 'currency'), ''), nullif(btrim(old.currency), ''), v_def, 'INR'));
  v_new := upper(coalesce(nullif(btrim(new.pricing ->> 'currency'), ''), nullif(btrim(new.currency), ''), v_def, 'INR'));
  if v_old = v_new then return new; end if;
  if exists (select 1 from public.quote_payments p where p.quote_id = new.id and (p.status = 'paid' or p.paid_at is not null)) then
    raise exception 'The currency can''t be changed after a payment is recorded on this event.' using errcode = '42501', hint = 'currency_locked';
  end if;
  if old.approval_status = 'approved' or coalesce(old.consent_stale, false) then
    if new.approval_status = 'approved' then new.approval_status := 'sent'; end if;
    if not coalesce(old.consent_stale, false) then new.consent_stale_at := now(); end if;
    new.consent_stale := true;
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (auth.uid(), 'consent_stale', 'quotes', new.id::text, new.id,
              jsonb_build_object('reason', 'currency', 'from', v_old, 'to', v_new), new.org_id);
  end if;
  return new;
end $$;
drop trigger if exists zzzz_a52c_r282_currency on public.quotes;
create trigger zzzz_a52c_r282_currency before update on public.quotes
  for each row execute function public._r282_tg_quote_currency();

-- ---- 9) BIZ-05: adopting a sample in a locked free trial uses a slot ------------------------------------------------
create or replace function public._r282_tg_adopt_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r32-0282 BIZ-05: runs after _a97_tg_demo_flag_guard turned a renamed sample into a real row
begin
  if new.org_id is null or coalesce(new.is_demo, false) or not coalesce(old.is_demo, false) then return new; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  if exists (select 1 from public.trial_create_log l
              where l.org_id = new.org_id and l.entity = tg_table_name and l.row_id = new.id::text) then
    return new;
  end if;
  if public._tl181_used(new.org_id, tg_table_name) >= 2 then
    raise exception 'Free trial limit reached (2). A renamed sample counts as your own - upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  insert into public.trial_create_log(org_id, entity, row_id) values (new.org_id, tg_table_name, new.id::text)
    on conflict do nothing;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    if to_regclass('public.' || t) is not null
       and exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'is_demo' and not a.attisdropped) then
      execute format('drop trigger if exists zzzz_r282_adopt_cap on public.%I', t);
      execute format('create trigger zzzz_r282_adopt_cap before update on public.%I for each row execute function public._r282_tg_adopt_cap()', t);
    end if;
  end loop;
end $$;

-- ---- 10) BIZ-06: Helm-owned studio settings can't be changed through the API ----------------------------------------
drop trigger if exists ab_mass_assign_guard_r282 on public.organizations;
create trigger ab_mass_assign_guard_r282 before update on public.organizations
  for each row execute function public.tg_mass_assign_guard('is_sample_master', 'seat_limit', 'sample_source_org', 'sample_batch_id',
                                                           'sample_version', 'sample_cloned_at');

-- ---- 12) R32b round-2 fixes -----------------------------------------------------------------------------------------
-- 12a R2-BIZ-NEW-1: lowering the price of a CONFIRMED or PAID event (any pricing field: discount, tax, items, ...) needs
--     "Approve discounts" (discount_approve, edit; admin always) and is logged. Editing before confirmation is unchanged,
--     and a client's package choice accepted by the studio (pkg_selection_review: the price comes from the package, with
--     its own maker-checker for adjusted prices) is not held to it. Runs after the server recomputes the total.
--     The package exemption is recognised ONLY by a transaction-local flag (helm.r282_pkg = the selection id) that the
--     pkg_selection_review wrapper below sets around its own call - never by "a version saved in this transaction"
--     (a member's save_quotation_version must not ride on a pending package choice).
do $$ begin
  if to_regprocedure('public.pkg_selection_review__pre0282(uuid, text, numeric, text)') is null then
    alter function public.pkg_selection_review(uuid, text, numeric, text) rename to pkg_selection_review__pre0282;
  end if;
end $$;
revoke all on function public.pkg_selection_review__pre0282(uuid, text, numeric, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.pkg_selection_review__pre0282(uuid, text, numeric, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.pkg_selection_review__pre0282(uuid, text, numeric, text) from authenticated'; end if;
end $$;
create or replace function public.pkg_selection_review(p_id uuid, p_action text, p_price_override numeric default null, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r32-0282 R32b: the 0069 body (pkg_selection_review__pre0282) runs unchanged; this only marks, for this transaction,
-- that the quote's new pricing comes from THIS package selection (checked by _r282_tg_price_decrease)
declare v_out jsonb;
begin
  perform set_config('helm.r282_pkg', coalesce(p_id::text, ''), true);
  v_out := public.pkg_selection_review__pre0282(p_id, p_action, p_price_override, p_reason);
  perform set_config('helm.r282_pkg', '', true);
  return v_out;
end $$;
revoke all on function public.pkg_selection_review(uuid, text, numeric, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.pkg_selection_review(uuid, text, numeric, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.pkg_selection_review(uuid, text, numeric, text) to authenticated'; end if;
end $$;

create or replace function public._r282_tg_price_decrease()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r32-0282 R32b R2-BIZ-NEW-1
declare v_old numeric; v_new numeric; v_paid boolean; v_pkg boolean; v_flag text := nullif(current_setting('helm.r282_pkg', true), '');
begin
  if not public._r282_api_caller() then return new; end if;
  if new.pricing is not distinct from old.pricing then return new; end if;
  v_old := case when jsonb_typeof(old.pricing) = 'object' then public.helm_pricing_num(old.pricing -> 'total') end;
  v_new := case when jsonb_typeof(new.pricing) = 'object' then public.helm_pricing_num(new.pricing -> 'total') end;
  if v_old is null or v_old <= 0 then return new; end if;                 -- not priced before: nothing to protect
  if v_new is not null and v_new >= v_old - 0.005 then return new; end if;  -- same or higher
  v_paid := exists (select 1 from public.quote_payments p where p.quote_id = new.id and p.status = 'paid');
  if not (coalesce(old.status, '') = 'confirmed' or coalesce(old.approval_status, '') = 'paid' or v_paid) then return new; end if;
  -- only inside pkg_selection_review (flag = that selection, pending, of THIS event)
  v_pkg := v_flag is not null and v_flag ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           and exists (select 1 from public.package_selections s
                        where s.id = v_flag::uuid and s.quote_id = new.id and s.status = 'pending');
  if not v_pkg and not public.has_area('discount_approve', 'edit') then
    raise exception 'Only an admin (or a role allowed to approve discounts) can lower the price of a confirmed or paid event.'
      using errcode = '42501', hint = 'discount_approval';
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'price_decrease', 'quotes', new.id::text, new.id,
            jsonb_build_object('from', v_old, 'to', v_new, 'role', public.user_role(), 'package_choice', v_pkg,
                               'discount', new.pricing -> 'discount', 'discountPct', new.pricing -> 'discountPct', 'gstPct', new.pricing -> 'gstPct'),
            new.org_id);
  return new;
end $$;
drop trigger if exists zzzz_a52d_r282_price_down on public.quotes;
create trigger zzzz_a52d_r282_price_down before update on public.quotes
  for each row execute function public._r282_tg_price_decrease();

-- 12b R2-BIZ-NEW-2: settle_milestone ("mark this milestone paid") works after closing (the closed-event freeze lets it
--     mark the milestone) and is logged as payment_after_close - the same as record_payment. Body kept as __pre0282.
do $$ begin
  if to_regprocedure('public.settle_milestone__pre0282(uuid, text, text)') is null then
    alter function public.settle_milestone(uuid, text, text) rename to settle_milestone__pre0282;
  end if;
end $$;
revoke all on function public.settle_milestone__pre0282(uuid, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.settle_milestone__pre0282(uuid, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.settle_milestone__pre0282(uuid, text, text) from authenticated'; end if;
end $$;
create or replace function public.settle_milestone(p_milestone uuid, p_method text default 'cash', p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- r32-0282 R32b R2-BIZ-NEW-2: allowed after closing (logged); every check of the original (settle_milestone__pre0282) runs
declare v_q uuid; v_closed boolean := false; v_out jsonb;
begin
  select m.quote_id into v_q from public.payment_milestones m where m.id = p_milestone and m.org_id = public.current_org_id();
  v_closed := v_q is not null and public._r282_event_closed(v_q);
  if v_closed then perform set_config('helm.r282_pay', v_q::text, true); end if;
  v_out := public.settle_milestone__pre0282(p_milestone, p_method, p_idempotency_key);
  if v_closed and not coalesce((v_out ->> 'idempotent_replay')::boolean, false) then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'payment_after_close', 'quote_payments',
             v_q::text, v_q, jsonb_build_object('amount', v_out -> 'amount', 'method', v_out -> 'method', 'receipt_no', v_out -> 'receipt_no',
                                                'milestone', p_milestone, 'via', 'settle_milestone'), q.org_id
        from public.quotes q where q.id = v_q;
  end if;
  if v_closed then perform set_config('helm.r282_pay', '', true); end if;
  return v_out;
end $$;
revoke all on function public.settle_milestone(uuid, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.settle_milestone(uuid, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.settle_milestone(uuid, text, text) to authenticated'; end if;
end $$;

-- 12c R2-BIZ-NEW-3: record_settlement_payment (Settlement page) after closing: its milestone match works and it is logged
create or replace function public.record_settlement_payment(p_quote uuid, p_amount numeric, p_method text default 'cash', p_receipt_no text default null,
                                                            p_milestone uuid default null, p_note text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- pay-schedule-0264: the receipt row is written to quote_payments by record_settlement_payment__pre0264 (ledger + caps
-- unchanged), then every milestone the money now fully covers is paid
-- r32-0282 R32b R2-BIZ-NEW-3: allowed after closing (the closed-event freeze lets this call mark milestones) and logged
declare v_out jsonb; v_n integer := 0; v_closed boolean := public._r282_event_closed(p_quote);
begin
  if v_closed then perform set_config('helm.r282_pay', p_quote::text, true); end if;
  v_out := public.record_settlement_payment__pre0264(p_quote, p_amount, p_method, p_receipt_no, p_milestone, p_note, p_idempotency_key);
  if not coalesce((v_out ->> 'idempotent_replay')::boolean, false) then
    begin v_n := public._pst_allocate(p_quote);
    exception when others then v_n := 0; raise warning 'pay-schedule-0264: milestone cover skipped (%)', sqlstate;
    end;
    if v_n > 0 then v_out := v_out || jsonb_build_object('milestones_covered', v_n); end if;
    if v_closed then
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
        select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'payment_after_close', 'quote_payments',
               p_quote::text, p_quote, jsonb_build_object('amount', p_amount, 'method', p_method, 'receipt_no', p_receipt_no,
                                                          'milestone', p_milestone, 'via', 'record_settlement_payment'), q.org_id
          from public.quotes q where q.id = p_quote;
    end if;
  end if;
  if v_closed then perform set_config('helm.r282_pay', '', true); end if;
  return v_out;
end $$;

-- 12d decide_event_close: the closure checklist's balance line reads as the problem when it fails ("Client balance still
--     due", not "Client balance is 0"); the original checklist body is kept as _r22_close_checks__pre0282
do $$ begin
  if to_regprocedure('public._r22_close_checks__pre0282(uuid, uuid)') is null then
    alter function public._r22_close_checks(uuid, uuid) rename to _r22_close_checks__pre0282;
  end if;
end $$;
create or replace function public._r22_close_checks(p_quote uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-closure-0254 body in _r22_close_checks__pre0282; r32-0282 R32b: a FAILED balance check is labelled as the problem
declare r jsonb;
begin
  r := public._r22_close_checks__pre0282(p_quote, p_org);
  if r is null then return null; end if;
  return r || jsonb_build_object(
    'checks', (select coalesce(jsonb_agg(case when c ->> 'key' = 'balance' and c ->> 'status' = 'fail'
                                              then c || jsonb_build_object('label', 'Client balance still due') else c end order by o), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(r -> 'checks', '[]'::jsonb)) with ordinality e(c, o)),
    'failed', (select coalesce(jsonb_agg(case when c ->> 'key' = 'balance'
                                              then c || jsonb_build_object('label', 'Client balance still due') else c end order by o), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(r -> 'failed', '[]'::jsonb)) with ordinality e(c, o)));
end $$;
do $$ declare f text; begin
  foreach f in array array['_r22_close_checks(uuid, uuid)', '_r22_close_checks__pre0282(uuid, uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
end $$;

-- ... and approving a close request respects "Close events with money owed": when the client balance is the ONLY
--     server blocker, an approver whose role has close_owed (edit) may approve (the close gate checks it again)
create or replace function public.decide_event_close(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-closure-0254: approve (closes through close_event - every gate still runs) or decline (note required)
-- r32-0282 R32b: money owed only + close_owed (edit) may approve past the server gate (not only an admin)
declare
  v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); v_admin boolean := coalesce(public.user_role(), '') = 'admin';
  q public.event_close_requests; r jsonb; v_server boolean; v_email text; v_name text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_admin_only text; v_txt text; b jsonb; v_owed_only boolean;
begin
  if v_uid is null or v_org is null or not public._r22_can_approve() then
    raise exception 'Only an admin, or a coordinator / manager who can close events, can approve or decline a close request.' using errcode = '42501'; end if;
  select * into q from public.event_close_requests x where x.id = p_request_id and x.org_id = v_org for update;
  if q.id is null then raise exception 'not authorized for this request' using errcode = '42501'; end if;
  if q.status <> 'pending' then raise exception 'This request was already %.', q.status using errcode = '22023'; end if;
  if q.requested_by = v_uid and not v_admin then
    raise exception 'You can''t decide your own close request - ask an admin or a coordinator.' using errcode = '42501'; end if;
  if p_approve is null then raise exception 'approve or decline?' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) > 1000 then raise exception 'Keep the note under 1000 characters.' using errcode = '22023'; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  v_name := coalesce(public._sa54_name(v_uid), v_email, 'Someone');

  if not p_approve then
    if v_note is null or length(v_note) < 3 then
      raise exception 'Say why you are declining (at least 3 characters) - the requester sees it.' using errcode = '22023'; end if;
    update public.event_close_requests set status = 'declined', decided_by = v_uid, decided_email = v_email, decided_name = v_name,
           decided_role = public.user_role(), decided_at = now(), decision_note = v_note
     where id = q.id;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
      values (v_uid, v_email, 'close_request_declined', 'event_closure', q.quote_id::text, q.quote_id,
              jsonb_build_object('request_id', q.id, 'note', v_note, 'requested_by', q.requested_by), v_org);
    perform public._r22_announce(v_org, q.quote_id, q.id, 'event_close_decision',
      left(chr(10006) || ' Close request declined by ' || v_name || ': ' || v_note || ' (requested by ' || coalesce(q.requested_name, 'someone') || ')', 600),
      case when q.requested_by is not null then jsonb_build_array(to_jsonb(q.requested_by)) else '[]'::jsonb end,
      jsonb_build_object('decision', 'declined', 'actor_name', v_name));
    perform public._r22_mail_enqueue(v_org, q.id, 'close_decision');
    return jsonb_build_object('request_id', q.id, 'status', 'declined', 'closed', false);
  end if;

  -- approve: the checklist is re-computed now; past a 0049 server blocker only an admin may approve - or, when the
  -- client balance is the only server blocker, a role with "Close events with money owed" (R32b)
  perform pg_advisory_xact_lock(hashtextextended('helm:pay:quote:' || q.quote_id::text, 0));
  perform 1 from public.quotes x where x.id = q.quote_id for update;
  r := public._r22_close_checks(q.quote_id, v_org);
  v_server := coalesce((r ->> 'server_blocked')::boolean, false);
  if v_server and not v_admin then
    b := public._a49_close_blockers(q.quote_id);
    v_owed_only := coalesce((b ->> 'balance_owed')::numeric, 0) > 0 and coalesce((b ->> 'open_checkouts')::int, 0) = 0
                   and (b ->> 'not_booked') is null and not coalesce((b ->> 'no_event_date')::boolean, false)
                   and not coalesce((b ->> 'too_early')::boolean, false);
    if not (v_owed_only and public.has_area('close_owed', 'edit')) then
      select string_agg(f ->> 'label', ', ') into v_admin_only from jsonb_array_elements(r -> 'failed') f where f ->> 'override' in ('admin', 'none');
      raise exception 'Only an admin can approve closing past: %.', coalesce(v_admin_only, 'a server check') using errcode = '42501';
    end if;
  end if;
  if v_server then perform public.close_event(q.quote_id, true,
      left('Close request approved by ' || v_name || ' (requested by ' || coalesce(q.requested_name, 'someone') || '): ' || q.reason, 1000));
  else perform public.close_event(q.quote_id, true); end if;
  update public.event_close_requests set status = 'approved', decided_by = v_uid, decided_email = v_email, decided_name = v_name,
         decided_role = public.user_role(), decided_at = now(), decision_note = v_note,
         decided_checks = coalesce(r -> 'checks', '[]'::jsonb), server_override = v_server
   where id = q.id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, v_email, 'close_request_approved', 'event_closure', q.quote_id::text, q.quote_id,
            jsonb_build_object('request_id', q.id, 'reason', q.reason, 'note', v_note, 'requested_by', q.requested_by,
                               'server_override', v_server,
                               'failed_checks', (select jsonb_agg(f ->> 'key') from jsonb_array_elements(r -> 'failed') f)), v_org);
  v_txt := left(chr(9989) || ' Closed with override approved by ' || v_name || '; requested by ' || coalesce(q.requested_name, 'someone')
                || ': ' || q.reason || coalesce(' - ' || v_note, ''), 600);
  perform public._r22_announce(v_org, q.quote_id, q.id, 'event_close_decision', v_txt,
    (select coalesce(jsonb_agg(distinct e), '[]'::jsonb) from jsonb_array_elements(public._r22_approver_ids(v_org)
       || case when q.requested_by is not null then jsonb_build_array(to_jsonb(q.requested_by)) else '[]'::jsonb end) e),
    jsonb_build_object('decision', 'approved', 'actor_name', v_name));
  perform public._r22_mail_enqueue(v_org, q.id, 'close_decision');
  return jsonb_build_object('request_id', q.id, 'status', 'approved', 'closed', true, 'server_override', v_server);
end $$;

-- ---- 11) trigger functions are never called directly ------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public._r282_tg_invite_key_guard()', 'public._r282_tg_cr_approval()', 'public._r282_tg_closed_freeze()',
                           'public._r282_tg_quote_currency()', 'public._r282_tg_adopt_cap()', 'public._r282_tg_price_decrease()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 ACL-01 verify_task needs the Staff area (0282 marker), same signature',
     (select position('r32-0282 ACL-01' in prosrc) > 0 and prorettype = 'public.event_tasks'::regtype from pg_proc where oid = 'public.verify_task(uuid, boolean, text)'::regprocedure)),
  ('02 AUTH-1 invitations.mail_key_hash added (nullable), key functions service-role only, admin cannot set it',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invitations' and column_name = 'mail_key_hash' and is_nullable = 'YES')
     and has_function_privilege('service_role', 'public.invite_mail_key_set(text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_mail_key_set(text, text)', 'execute')
     and not has_function_privilege('anon', 'public.invite_signup_record(text, uuid)', 'execute')
     and exists (select 1 from pg_trigger where tgname = 'ab_r282_invite_key_guard' and tgrelid = 'public.invitations'::regclass)),
  ('03 AUTH-2 admin_create_user checks the seat limit first (0282 marker)',
     (select position('r32-0282 AUTH-2' in prosrc) > 0 from pg_proc where oid = 'public.admin_create_user(text, text, text)'::regprocedure)),
  ('04 AUTH-3 current_org_id is empty on a temporary password (0282 marker)',
     (select position('_r282_temp_pw_pending' in prosrc) > 0 from pg_proc where oid = 'public.current_org_id()'::regprocedure)),
  ('05 BIZ-01 change-request approval trigger + close gate (close_owed) in place',
     exists (select 1 from pg_trigger where tgname = 'ad_r282_cr_approval' and tgrelid = 'public.change_requests'::regclass)
     and (select position('close_owed' in prosrc) > 0 from pg_proc where oid = 'public._a49_close_gate(uuid, text)'::regprocedure)),
  ('06 BIZ-02 closed-event freeze on the 5 money tables; record_payment still callable',
     (select count(*) from pg_trigger where tgname = 'aa_r282_closed_freeze') = 5
     and has_function_privilege('authenticated', 'public.record_payment(uuid, numeric, text, text, uuid, text, text)', 'execute')),
  ('07 BIZ-03 plan seat limits: starter 3, studio 15 (or the owner''s own number)',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_plans' and column_name = 'seat_limit')
     and coalesce((select seat_limit from public.helm_plans where code = 'starter'), 3) > 0
     and coalesce((select seat_limit from public.helm_plans where code = 'studio'), 15) > 0),
  ('08 BIZ-04 currency trigger, BIZ-05 adoption cap, BIZ-06 settings guard attached',
     exists (select 1 from pg_trigger where tgname = 'zzzz_a52c_r282_currency' and tgrelid = 'public.quotes'::regclass)
     and exists (select 1 from pg_trigger where tgname = 'zzzz_r282_adopt_cap' and tgrelid = 'public.quotes'::regclass)
     and exists (select 1 from pg_trigger where tgname = 'ab_mass_assign_guard_r282' and tgrelid = 'public.organizations'::regclass)),
  ('09 new helpers / trigger functions are not callable through the API',
     not has_function_privilege('authenticated', 'public._r282_tg_cr_approval()', 'execute')
     and not has_function_privilege('authenticated', 'public._r282_seat_refuse(uuid, integer, boolean)', 'execute')
     and not has_function_privilege('anon', 'public._r282_event_closed(uuid)', 'execute')),
  ('10 nothing removed: every table / column this touches is still there, and the original bodies are kept',
     (select count(*) from information_schema.columns where table_schema = 'public' and (table_name, column_name) in (
        ('invitations', 'token'), ('invitations', 'email'), ('invitations', 'status'), ('invitations', 'mail_key_hash'),
        ('helm_plans', 'code'), ('helm_plans', 'seat_limit'), ('organizations', 'seat_limit'), ('organizations', 'sample_version'),
        ('organizations', 'sample_cloned_at'), ('change_requests', 'price_delta'), ('change_requests', 'status'),
        ('quote_payments', 'amount'), ('quote_payments', 'status'), ('payment_milestones', 'amount'), ('payment_milestones', 'status'),
        ('quotes', 'pricing'), ('quotes', 'currency'), ('event_closure', 'closed_at'), ('event_close_requests', 'status'),
        ('studio_subscriptions', 'status'), ('a155_admin_created', 'user_id'), ('auth_temp_passwords', 'pw_hash'))) = 22
     and to_regprocedure('public.record_payment__pre0264(uuid, numeric, text, text, uuid, text, text)') is not null
     and to_regprocedure('public.record_settlement_payment__pre0264(uuid, numeric, text, text, uuid, text, text)') is not null
     and to_regprocedure('public.admin_create_user__pre0155(text, text, text)') is not null
     and to_regprocedure('public.settle_milestone__pre0282(uuid, text, text)') is not null
     and to_regprocedure('public._r22_close_checks__pre0282(uuid, uuid)') is not null
     and (select count(*) from public.helm_plans where code in ('starter', 'studio')) = 2),
  ('11 R32b price decrease on a confirmed / paid event needs Approve discounts (trigger on quotes; package flag only from pkg_selection_review)',
     exists (select 1 from pg_trigger where tgname = 'zzzz_a52d_r282_price_down' and tgrelid = 'public.quotes'::regclass)
     and (select position('discount_approve' in prosrc) > 0 from pg_proc where oid = 'public._r282_tg_price_decrease()'::regprocedure)
     and not has_function_privilege('authenticated', 'public._r282_tg_price_decrease()', 'execute')
     and (select position('helm.r282_pkg' in prosrc) > 0 from pg_proc where oid = 'public.pkg_selection_review(uuid, text, numeric, text)'::regprocedure)
     and to_regprocedure('public.pkg_selection_review__pre0282(uuid, text, numeric, text)') is not null
     and has_function_privilege('authenticated', 'public.pkg_selection_review(uuid, text, numeric, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.pkg_selection_review__pre0282(uuid, text, numeric, text)', 'execute')),
  ('12 R32b change-request approval refuses an invoice below what was paid',
     (select position('record a refund first' in prosrc) > 0 from pg_proc where oid = 'public._r282_tg_cr_approval()'::regprocedure)),
  ('13 R32b settle_milestone + record_settlement_payment after closing: allowed + logged; old body not callable',
     (select position('R2-BIZ-NEW-2' in prosrc) > 0 from pg_proc where oid = 'public.settle_milestone(uuid, text, text)'::regprocedure)
     and (select position('R2-BIZ-NEW-3' in prosrc) > 0 from pg_proc where oid = 'public.record_settlement_payment(uuid, numeric, text, text, uuid, text, text)'::regprocedure)
     and has_function_privilege('authenticated', 'public.settle_milestone(uuid, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.settle_milestone__pre0282(uuid, text, text)', 'execute')
     and not has_function_privilege('anon', 'public.settle_milestone(uuid, text, text)', 'execute')),
  ('14 R32b close requests respect Close events with money owed; failed balance label fixed',
     (select position('close_owed' in prosrc) > 0 from pg_proc where oid = 'public.decide_event_close(uuid, boolean, text)'::regprocedure)
     and (select position('Client balance still due' in prosrc) > 0 from pg_proc where oid = 'public._r22_close_checks(uuid, uuid)'::regprocedure)
     and not has_function_privilege('authenticated', 'public._r22_close_checks__pre0282(uuid, uuid)', 'execute')),
  ('15 R32b seats: joining counts members only; any subscription status keeps the plan limit',
     (select position('R32b BIZ-03' in prosrc) > 0 from pg_proc where oid = 'public._ts166_tg_profile_seat()'::regprocedure)
     and (select position('ANY status' in prosrc) > 0 from pg_proc where oid = 'public._trial_seat_limit(uuid)'::regprocedure)),
  ('16 R32b admin_create_user refusals counted in a private table',
     to_regclass('public.r282_acu_refusals') is not null
     and (select relrowsecurity from pg_class where oid = 'public.r282_acu_refusals'::regclass)
     and not has_table_privilege('authenticated', 'public.r282_acu_refusals', 'select')
     and not has_table_privilege('anon', 'public.r282_acu_refusals', 'select')
     and (select position('R2-AUTH-02' in prosrc) > 0 from pg_proc where oid = 'public.admin_create_user(text, text, text)'::regprocedure)
     and (select position('R2-AUTH-02' in prosrc) > 0 from pg_proc where oid = 'public.admin_create_user_temp(text, text)'::regprocedure)
     and has_function_privilege('authenticated', 'public.admin_create_user_temp(text, text)', 'execute')),
  ('17 R32b sample_version / sample_cloned_at guarded from the API',
     (select position('sample_cloned_at' in encode(tgargs, 'escape')) > 0 from pg_trigger
       where tgname = 'ab_mass_assign_guard_r282' and tgrelid = 'public.organizations'::regclass))
) v(item, ok) order by item;
