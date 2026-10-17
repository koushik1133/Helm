-- APPLY-0155.sql - paste into the Supabase SQL editor (staging first, then prod). Apply BEFORE deploying the edge functions of this change.
-- Additive + idempotent: 3 new record/counter tables, new indexes + triggers, 8 functions kept as <name>__pre0155 and wrapped. No rows change. Safe to run twice.
begin;
-- 0155_audit_medium_fixes.sql - CANONICAL forward-only. Security audit run-3, Medium findings (db group).
-- REQUIRES 0032 (tg_mass_assign_guard) + 0042 (accept_invitation / admin_create_user / create_invitation
-- wrappers, _a42_is_operator_email) + 0058 (_trial_paid) + 0069 (pkg_outbox) + 0083 (client_booklet_images)
-- + 0092 (comms_outbox_claim) + 0095 (photo_renders) + 0097 (whatsapp_authorize) + 0117 (whatsapp_opt_outs)
-- + 0127 (demo_choice) + 0131 (invite_email_outbox) + 0151 (wa_proposal_prepare / wa_proposal_optins).
--
-- In plain words:
--   1. Free-trial end date (db/organizations/trial_ends_at-self-extend-paywall-bypass): a studio admin
--      could PATCH organizations.trial_ends_at (or trial_mode / demo_choice) from the browser and keep the
--      trial open for ever. These columns are now server-owned like plan and created_by: only Helm's own
--      functions (start_trial, checkout, the trial mode switch, HQ) can change them.
--   2. Pre-confirmed accounts (db/admin_create_user/preconfirmed-email-identity-squat): during an unpaid
--      free trial, staff are added by INVITATION only (the invitee confirms their own mailbox). Paid
--      studios can still create accounts directly (max 100 a day), and every such account is recorded. If
--      the real owner of that e-mail later accepts another studio's invitation, the account moves to
--      that studio (audit row in both studios). In the SAME transaction the password is replaced by a
--      random one nobody knows (so the old studio's admin, who chose the first password, can no longer
--      sign in), and the person chooses a new password - so a studio can no longer lock a person out of
--      Helm by creating an account for their e-mail first, nor keep a way into the new studio.
--   3. Booklet pictures (db/booklet_put_image/unbounded-bytea-growth): pictures stay capped at 1.5 MB
--      each; now each studio also has a byte budget (free trial: 50 MB a day, 150 MB in total including
--      AI photos; paid: 1 GB a day, 20 GB in total) and "use this AI photo in the booklet" is rate
--      limited (60 an hour). Nothing is deleted - over the budget a new upload is refused with a message.
--   4. WhatsApp STOP (edge/whatsapp/stop-opt-outs-not-enforced): a number that replied STOP is skipped on
--      every send path - staff sends (whatsapp_authorize), payment reminders / follow-ups / bell copies
--      (comms_outbox_claim), package messages (pkg_outbox_claim) and "Send on WhatsApp" (wa_proposal_prepare,
--      clear message). Helper _wa_opted_out(phone, org) is internal; wa_recipient_opted_out(phone) is for
--      the edge functions (service role) as a last check right before sending.
--   5. Shared-number relay (edge-functions-6): send-whatsapp may now message at most 200 different numbers
--      a day per studio; an unpaid trial studio only numbers that opted in on the proposal screen, at
--      most 3 new numbers and 10 messages a day.
--   6. Package fan-out (business-logic-9): staff "client picked a package" WhatsApps are coalesced to one
--      per person per event per 10 minutes, at most 30 per person per hour (extra rows are kept as
--      'skipped'), and staff rows older than a day are no longer sent.
--   7. Invitation e-mail volume (business-logic-10): new invitations per studio per 24 hours (trial 20,
--      paid 200) and open invitations (trial 50, paid 500) are capped (the ONLY invitation caps - 0156
--      adds the admin-first check and no caps of its own), and the mailer sends at most
--      20 (trial) / 200 (paid) invitation e-mails per studio per 24 hours (the rest wait, nothing dropped).
--   NOT changed here (owner decisions): update_my_profile stays aal1 (no 2FA for profile edits - accepted);
--   tg_a52_consent_stale for paid quotes (decision pending).
--
-- ZERO DATA LOSS: three new tables (records / counters only), new indexes, new triggers, CREATE OR
-- REPLACE functions, eight function renames (old bodies kept as <name>__pre0155), one trigger re-created
-- with more protected columns. No existing table, column, row or policy is removed. No DELETE / DROP
-- TABLE / TRUNCATE. ASCII only. Safe to run twice.

do $$ begin
  if to_regprocedure('public.tg_mass_assign_guard()') is null then raise exception 'STOP: apply 0032 first'; end if;
  if to_regprocedure('public._a42_is_operator_email(text)') is null then raise exception 'STOP: apply 0042 first'; end if;
  if to_regprocedure('public._trial_paid(uuid)') is null then raise exception 'STOP: apply 0058 first'; end if;
  if to_regclass('public.pkg_outbox') is null then raise exception 'STOP: apply 0069 first'; end if;
  if to_regclass('public.client_booklet_images') is null then raise exception 'STOP: apply 0083 first'; end if;
  if to_regclass('public.photo_renders') is null then raise exception 'STOP: apply 0095 first'; end if;
  if to_regprocedure('public.whatsapp_authorize__pre0097(uuid,text)') is null then raise exception 'STOP: apply 0097 first'; end if;
  if to_regclass('public.whatsapp_opt_outs') is null then raise exception 'STOP: apply 0117 first'; end if;
  if to_regclass('public.invite_email_outbox') is null then raise exception 'STOP: apply 0131 first'; end if;
  if to_regprocedure('public.wa_proposal_prepare(uuid,text,text,boolean,text,boolean)') is null
     and to_regprocedure('public.wa_proposal_prepare__pre0155(uuid,text,text,boolean,text,boolean)') is null then raise exception 'STOP: apply 0151 first'; end if;
end $$;

-- ---- 1) trial columns are server-owned ---------------------------------------------------
-- tg_mass_assign_guard (0032) refuses a change of each named column when the caller is the browser
-- (anon / authenticated); SECURITY DEFINER functions run as their owner and pass through.
drop trigger if exists ab_mass_assign_guard on public.organizations;
create trigger ab_mass_assign_guard before insert or update on public.organizations
  for each row execute function public.tg_mass_assign_guard('plan', 'created_by', 'trial_ends_at', 'trial_mode', 'demo_choice', 'demo_choice_at');

-- ---- 2) helper: an unpaid free-trial studio ------------------------------------------------
create or replace function public._a155_unpaid_trial(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-p1-0155
  select p_org is not null
     and exists (select 1 from public.organizations o left join public.studio_subscriptions s on s.org_id = o.id
                  where o.id = p_org and o.trial_ends_at is not null and coalesce(s.status, '') <> 'active')
     and not public._trial_paid(p_org);
$$;

-- ---- 3a) apply order safety: 0156 wraps accept_invitation / create_invitation ON TOP of 0155.
-- If this file runs again after 0156: park the 0156 wrapper as <name>__a155hold and bring the 0155
-- layer (<name>__pre0156) back to <name> so the CREATE OR REPLACE below refreshes it in place; 3c
-- then swaps both back. Renames only - nothing is dropped, no rows touched.
do $$ declare f text[]; begin
  foreach f slice 1 in array array[array['accept_invitation', 'text'], array['create_invitation', 'text, text']] loop
    if to_regprocedure(format('public.%s(%s)', f[1], f[2])) is not null
       and to_regprocedure(format('public.%s__pre0156(%s)', f[1], f[2])) is not null
       and position('audit-p2-0156' in pg_get_functiondef(to_regprocedure(format('public.%s(%s)', f[1], f[2])))) > 0
       and to_regprocedure(format('public.%s__a155hold(%s)', f[1], f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__a155hold');
      execute format('alter function public.%I(%s) rename to %I', f[1] || '__pre0156', f[2], f[1]);
    end if;
  end loop;
end $$;

-- ---- 3) renames: keep every current body as <name>__pre0155 (once) ---------------------------
do $$ declare f text[]; v_old text; v_new text; begin
  foreach f slice 1 in array array[
    array['admin_create_user', 'text, text, text'],
    array['accept_invitation', 'text'],
    array['create_invitation', 'text, text'],
    array['whatsapp_authorize', 'uuid, text'],
    array['comms_outbox_claim', 'integer'],
    array['pkg_outbox_claim', 'integer'],
    array['invite_email_outbox_claim', 'integer, uuid'],
    array['wa_proposal_prepare', 'uuid, text, text, boolean, text, boolean']] loop
    v_old := format('public.%s(%s)', f[1], f[2]);
    v_new := format('public.%s(%s)', f[1] || '__pre0155', f[2]);
    if to_regprocedure(v_new) is null and to_regprocedure(v_old) is not null
       and position('audit-p1-0155' in pg_get_functiondef(to_regprocedure(v_old))) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0155');
    end if;
    if to_regprocedure(v_new) is not null then
      execute format('revoke all on function %s from public', v_new);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_new); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_new); end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_new); end if;
    end if;
  end loop;
end $$;

-- ---- 4) admin-created accounts: recorded, capped, releasable ---------------------------------
create table if not exists public.a155_admin_created (
  user_id      uuid primary key,
  org_id       uuid not null,
  created_by   uuid,
  pw_hash      text,                       -- the password hash the creating admin set (never shown)
  created_at   timestamptz not null default now(),
  released_at  timestamptz,                -- the e-mail owner accepted another studio's invitation
  released_to  uuid
);
create index if not exists a155_admin_created_org_idx on public.a155_admin_created (org_id, created_at desc);
alter table public.a155_admin_created enable row level security;
revoke all on table public.a155_admin_created from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.a155_admin_created from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.a155_admin_created from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.a155_admin_created to service_role'; end if;
end $$;

create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155 wrapper over the audit-run2-0042 / auth-hardening-0028 chain (admin_create_user__pre0155):
-- unpaid trial studios add people by invitation; paid studios max 100 new accounts a day; recorded.
declare v_org uuid := public.current_org_id(); v_uid uuid; v_n int;
begin
  if v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._a155_unpaid_trial(v_org) then
    raise exception 'During the free trial, add people with an invitation - they confirm their own e-mail and choose their own password.'
      using errcode = '22023', hint = 'use_invitation';
  end if;
  perform pg_advisory_xact_lock(hashtext('a155:acu:' || v_org::text));
  select count(*) into v_n from public.a155_admin_created a where a.org_id = v_org and a.created_at > now() - interval '24 hours';
  if v_n >= 100 then
    raise exception 'too many new accounts today - try again tomorrow, or send invitations instead' using errcode = '54000';
  end if;
  v_uid := public.admin_create_user__pre0155(p_email, p_password, p_role);
  insert into public.a155_admin_created(user_id, org_id, created_by, pw_hash)
    select v_uid, v_org, auth.uid(), u.encrypted_password from auth.users u where u.id = v_uid
  on conflict (user_id) do nothing;
  return v_uid;
end $$;

create or replace function public.accept_invitation(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: an account another studio CREATED for this e-mail (admin_create_user) no longer
-- blocks its real owner: holding this invitation (sent to the mailbox) moves the account to the
-- inviting studio, audited in both studios, and the person must choose a new password.
declare v_uid uuid := auth.uid(); v_inv record; v_cur uuid; v_ac record; v_sid text; v_hash text;
        v_moved boolean := false; v_out jsonb;
begin
  if v_uid is not null then
    select i.id, i.org_id, i.role, i.status, i.expires_at, lower(i.email) as email into v_inv
      from public.invitations i where i.token = p_token;
    select p.org_id into v_cur from public.profiles p where p.id = v_uid;
    if v_inv.id is not null and v_inv.status = 'pending' and v_inv.expires_at > now()
       and v_cur is not null and v_cur <> v_inv.org_id then
      select a.* into v_ac from public.a155_admin_created a where a.user_id = v_uid and a.org_id = v_cur and a.released_at is null;
      if v_ac.user_id is not null
         and exists (select 1 from auth.users u where u.id = v_uid and u.email_confirmed_at is not null and lower(u.email) = v_inv.email)
         and not public._a42_is_operator_email(v_inv.email) then
        v_sid := nullif(btrim(coalesce(auth.jwt() ->> 'session_id', '')), '');
        if exists (select 1 from auth.sessions s where s.user_id = v_uid and (v_sid is null or s.id::text <> v_sid)) then
          raise exception 'This account is still signed in on another device. Sign out of other devices (or reset your password), then open the invitation again.'
            using errcode = '42501', hint = 'other_sessions';
        end if;
        if exists (select 1 from public.profiles p where p.id = v_uid and p.role = 'admin')
           and not exists (select 1 from public.profiles p where p.org_id = v_cur and p.role = 'admin' and p.id <> v_uid) then
          raise exception 'This account is the only admin of the studio that created it - ask Helm support to move it.' using errcode = '42501';
        end if;
        update public.profiles set org_id = v_inv.org_id, role = v_inv.role where id = v_uid;
        update public.a155_admin_created set released_at = now(), released_to = v_inv.org_id where user_id = v_uid;
        insert into public.audit_log(actor, action, entity, entity_id, changed, org_id) values
          (v_uid, 'member.moved_out', 'profiles', v_uid::text, jsonb_build_object('reason', 'accepted another studio''s invitation', 'admin_created', true), v_cur),
          (v_uid, 'member.moved_in', 'profiles', v_uid::text, jsonb_build_object('invitation', v_inv.id, 'admin_created_elsewhere', true), v_inv.org_id);
        v_moved := true;
      end if;
    end if;
  end if;
  v_out := public.accept_invitation__pre0155(p_token);
  if v_moved then
    -- same transaction as the move: whatever password the old studio's admin set (or later reset) is
    -- replaced by a random one nobody knows, so they can never sign in to the moved account. The
    -- person keeps the session they accepted with and must choose their own password next.
    v_hash := extensions.crypt(encode(extensions.gen_random_bytes(32), 'hex'), extensions.gen_salt('bf', 10));
    update auth.users set encrypted_password = v_hash, updated_at = now() where id = v_uid;
    update public.profiles set must_change_password = true where id = v_uid;
    insert into public.auth_temp_passwords(user_id, pw_hash) values (v_uid, v_hash)
      on conflict (user_id) do update set pw_hash = excluded.pw_hash, created_at = now();
    v_out := coalesce(v_out, '{}'::jsonb) || jsonb_build_object('moved', true, 'password_reset', true);
  end if;
  return v_out;
end $$;

-- ---- 5) booklet pictures: per-studio byte budget + photo copy rate limit ----------------------
create index if not exists client_booklet_images_org_at_idx155 on public.client_booklet_images (org_id, created_at desc);

create or replace function public._a155_tg_booklet_quota()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p1-0155: never deletes; over the budget the NEW picture is refused
declare v_trial boolean; v_day bigint; v_total bigint; v_wait int;
begin
  if coalesce(auth.jwt() ->> 'role', '') not in ('authenticated', 'anon') then return new; end if;   -- service role / maintenance
  if new.kind = 'photo' then
    v_wait := public.rate_hit('booklet.img_photo', md5('bkph:' || new.org_id::text), 3600, 60);
    if v_wait > 0 then raise exception 'too many photos added - try again in % seconds', v_wait using errcode = 'P0001'; end if;
  end if;
  v_trial := public._a155_unpaid_trial(new.org_id);
  select coalesce(sum(i.bytes), 0) into v_day from public.client_booklet_images i
   where i.org_id = new.org_id and i.created_at > now() - interval '24 hours';
  if v_day + new.bytes > (case when v_trial then 52428800 else 1073741824 end) then
    raise exception 'booklet picture limit for today reached - try again tomorrow' using errcode = '54000', hint = 'booklet_quota_day';
  end if;
  select coalesce((select sum(i.bytes) from public.client_booklet_images i where i.org_id = new.org_id), 0)
       + coalesce((select sum(r.bytes) from public.photo_renders r where r.org_id = new.org_id), 0) into v_total;
  if v_total + new.bytes > (case when v_trial then 157286400 else 21474836480 end) then
    raise exception 'booklet picture storage for this studio is full - contact Helm support' using errcode = '54000', hint = 'booklet_quota_total';
  end if;
  return new;
end $$;
drop trigger if exists zz_a155_booklet_quota on public.client_booklet_images;
create trigger zz_a155_booklet_quota before insert on public.client_booklet_images
  for each row execute function public._a155_tg_booklet_quota();

-- ---- 6) WhatsApp STOP: one helper, enforced on every send path -------------------------------
-- A row with org_id NULL is a STOP to the shared Helm number; it blocks every studio (as 0132 / 0151 do).
create or replace function public._wa_opted_out(p_phone text, p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-p1-0155
  select exists (select 1 from public.whatsapp_opt_outs o
                  where o.opted_out
                    and o.phone in (regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), public.helm_norm_phone(p_phone))
                    and (o.org_id is null or p_org is null or o.org_id = p_org));
$$;

-- for the edge functions (service role): last check right before a send (any studio's STOP counts)
create or replace function public.wa_recipient_opted_out(p_phone text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- audit-p1-0155
  select public._wa_opted_out(p_phone, null);
$$;

-- distinct WhatsApp recipients per studio per day (counter rows only)
create table if not exists public.a155_wa_recipients (
  org_id   uuid not null,
  day      date not null,
  phone    text not null,
  first_at timestamptz not null default now(),
  primary key (org_id, day, phone)
);
alter table public.a155_wa_recipients enable row level security;
revoke all on table public.a155_wa_recipients from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.a155_wa_recipients from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.a155_wa_recipients from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.a155_wa_recipients to service_role'; end if;
  -- suspended / ended-trial studios are read-only (0045 / 0116 guard), like every studio table
  if not exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.a155_wa_recipients'::regclass) then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.a155_wa_recipients for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: previous checks first (demo, quotes edit, own event, number on the event, hourly cap),
-- then STOP, the unpaid-trial opt-in rule and the daily distinct-recipient cap
declare v jsonb; v_to text; v_org uuid; v_trial boolean; v_n int;
begin
  v := public.whatsapp_authorize__pre0155(p_quote, p_recipient);
  v_to := v ->> 'to';
  v_org := nullif(v ->> 'org_id', '')::uuid;
  if v_to is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if public._wa_opted_out(v_to, v_org) then
    raise exception 'this person replied STOP to WhatsApp messages' using errcode = 'HL451', hint = 'opted_out';
  end if;
  v_trial := public._a155_unpaid_trial(v_org);
  if v_trial then
    if (select o.opted_in from public.wa_proposal_optins o
         where o.org_id = v_org and o.phone_e164 = '+' || v_to order by o.recorded_at desc, o.id desc limit 1) is not true then
      raise exception 'during the free trial, WhatsApp goes only to clients who opted in on the proposal share screen'
        using errcode = '42501', hint = 'trial_optin';
    end if;
    if not public.messaging_rate_hit(v_org, 'whatsapp_trial_day', 10, 86400) then
      raise exception 'whatsapp limit reached for this studio - try again later' using errcode = 'HL429';
    end if;
  end if;
  insert into public.a155_wa_recipients(org_id, day, phone) values (v_org, current_date, v_to) on conflict do nothing;
  if found then
    select count(*) into v_n from public.a155_wa_recipients r where r.org_id = v_org and r.day = current_date;
    if v_n > (case when v_trial then 3 else 200 end) then
      raise exception 'whatsapp limit of new numbers for today reached - try again tomorrow' using errcode = 'HL429';
    end if;
  end if;
  return v;
end $$;

create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: previous claim (recipient + switches re-checked), then STOP: a WhatsApp row to a
-- number that replied STOP is marked skipped and not handed out
declare e jsonb; v_in jsonb; v_out jsonb := '[]'::jsonb; v_org uuid; v_to text;
begin
  v_in := public.comms_outbox_claim__pre0155(p_limit);
  for e in select x from jsonb_array_elements(coalesce(v_in, '[]'::jsonb)) x loop
    if e ->> 'channel' = 'whatsapp' then
      select c.org_id, c.recipient into v_org, v_to from public.comms_outbox c where c.id = (e ->> 'id')::uuid;
      if public._wa_opted_out(coalesce(v_to, e ->> 'to'), v_org) then
        update public.comms_outbox set status = 'skipped', sent_at = now() where id = (e ->> 'id')::uuid and sent_at is null;
        continue;
      end if;
    end if;
    v_out := v_out || jsonb_build_array(e);
  end loop;
  return v_out;
end $$;

create or replace function public.pkg_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: previous claim, then STOP (WhatsApp) and a 1-day age limit for staff copies
declare e jsonb; v_in jsonb; v_out jsonb := '[]'::jsonb; o record;
begin
  v_in := public.pkg_outbox_claim__pre0155(p_limit);
  for e in select x from jsonb_array_elements(coalesce(v_in, '[]'::jsonb)) x loop
    select p.org_id, p.recipient, p.audience, p.channel, p.created_at into o from public.pkg_outbox p where p.id = (e ->> 'id')::uuid;
    if (o.channel = 'whatsapp' and public._wa_opted_out(coalesce(o.recipient, e ->> 'to'), o.org_id))
       or (o.audience = 'staff' and o.created_at < now() - interval '1 day') then
      update public.pkg_outbox set status = 'skipped', sent_at = now(), payload = payload - 'otp'
       where id = (e ->> 'id')::uuid and sent_at is null;
      continue;
    end if;
    v_out := v_out || jsonb_build_array(e);
  end loop;
  return v_out;
end $$;

create or replace function public.wa_proposal_prepare(p_quote uuid, p_kind text, p_phone text,
                                                      p_opt_in boolean, p_consent_text text, p_simulate boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: a clear answer when the client replied STOP (the 0151 body also refuses it)
declare v_org uuid; v_to text;
begin
  if auth.uid() is not null then
    select q.org_id into v_org from public.quotes q where q.id = p_quote and q.org_id = public.current_org_id();
    if v_org is not null and public.has_area('quotes', 'edit') then
      v_to := public._wa151_quote_e164(p_quote);
      if v_to is not null and public._wa_opted_out(v_to, v_org) then
        raise exception 'the client replied STOP to WhatsApp messages - send the link another way' using errcode = 'HL451', hint = 'opted_out';
      end if;
    end if;
  end if;
  return public.wa_proposal_prepare__pre0155(p_quote, p_kind, p_phone, p_opt_in, p_consent_text, p_simulate);
end $$;

-- ---- 7) package staff WhatsApp fan-out: coalesce + per-person cap ------------------------------
create index if not exists pkg_outbox_staff_user_idx155 on public.pkg_outbox (user_id, created_at desc) where audience = 'staff';

create or replace function public._a155_tg_pkg_staff_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- audit-p1-0155: one "client picked a package" WhatsApp per person per event per 10 minutes
-- (same dedupe key -> the insert's ON CONFLICT DO NOTHING drops the repeat); at most 30 staff
-- WhatsApps per person per hour (extra rows are kept, as skipped)
begin
  if new.audience = 'staff' and new.channel = 'whatsapp' then
    if new.kind = 'pkg_selected' and new.quote_id is not null and new.user_id is not null then
      new.dedupe_key := 'a155:' || new.quote_id::text || ':' || new.kind || ':' || new.user_id::text || ':'
                        || floor(extract(epoch from now()) / 600)::bigint::text;
    end if;
    if new.status = 'pending' and new.user_id is not null
       and (select count(*) from public.pkg_outbox o
             where o.user_id = new.user_id and o.audience = 'staff' and o.channel = 'whatsapp'
               and o.created_at > now() - interval '1 hour') >= 30 then
      new.status := 'skipped';
      new.sent_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists zz_a155_pkg_staff_cap on public.pkg_outbox;
create trigger zz_a155_pkg_staff_cap before insert on public.pkg_outbox
  for each row execute function public._a155_tg_pkg_staff_cap();

-- ---- 8) invitations: per-studio caps on creating and on e-mailing ------------------------------
create index if not exists invitations_org_created_idx155 on public.invitations (org_id, created_at desc);

create or replace function public.create_invitation(p_email text, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: previous checks (operator e-mail, existing member, re-invite at a new role), then
-- caps for a NEW invitation: per 24 hours trial 20 / paid 200; open (pending) trial 50 / paid 500
declare v_org uuid := public.current_org_id(); v_trial boolean; v_day int; v_open int;
begin
  if public.is_admin() and v_org is not null
     and not exists (select 1 from public.invitations i
                      where i.org_id = v_org and lower(i.email) = lower(btrim(coalesce(p_email, '')))
                        and i.status = 'pending' and i.expires_at > now()) then
    perform pg_advisory_xact_lock(hashtext('a155:inv:' || v_org::text));
    v_trial := public._a155_unpaid_trial(v_org);
    select count(*) into v_day from public.invitations i where i.org_id = v_org and i.created_at > now() - interval '24 hours';
    select count(*) into v_open from public.invitations i where i.org_id = v_org and i.status = 'pending' and i.expires_at > now();
    if v_day >= (case when v_trial then 20 else 200 end) then
      raise exception 'too many invitations today - try again tomorrow' using errcode = '54000';
    end if;
    if v_open >= (case when v_trial then 50 else 500 end) then
      raise exception 'too many open invitations - revoke ones that are no longer needed first' using errcode = '54000';
    end if;
  end if;
  return public.create_invitation__pre0155(p_email, p_role);
end $$;

create or replace function public.invite_email_outbox_claim(p_limit integer default 25, p_org uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- audit-p1-0155: previous claim, then at most 20 (trial) / 200 (paid) invitation e-mails per studio per
-- 24 hours; a row over the cap waits (claimed again in an hour, the try is not counted) - nothing dropped
declare e jsonb; v_in jsonb; v_out jsonb := '[]'::jsonb; v_org uuid; v_sent int; v_seen jsonb := '{}'::jsonb; v_k text;
begin
  v_in := public.invite_email_outbox_claim__pre0155(p_limit, p_org);
  for e in select x from jsonb_array_elements(coalesce(v_in, '[]'::jsonb)) x loop
    select o.org_id into v_org from public.invite_email_outbox o where o.id = (e ->> 'id')::uuid;
    if v_org is not null then
      v_k := v_org::text;
      if not (v_seen ? v_k) then
        select count(*) into v_sent from public.invite_email_outbox o
         where o.org_id = v_org and o.status = 'sent' and o.sent_at > now() - interval '24 hours';
        v_seen := v_seen || jsonb_build_object(v_k, v_sent);
      end if;
      if (v_seen ->> v_k)::int >= (case when public._a155_unpaid_trial(v_org) then 20 else 200 end) then
        update public.invite_email_outbox set claimed_at = now() + interval '50 minutes', attempts = greatest(attempts - 1, 0)
         where id = (e ->> 'id')::uuid and sent_at is null;
        continue;
      end if;
      v_seen := jsonb_set(v_seen, array[v_k], to_jsonb((v_seen ->> v_k)::int + 1));
    end if;
    v_out := v_out || jsonb_build_array(e);
  end loop;
  return v_out;
end $$;

-- ---- 9) privileges ---------------------------------------------------------------------------
do $$ declare s text; begin
  -- internal helpers / triggers: nobody calls them directly
  foreach s in array array['public._a155_unpaid_trial(uuid)', 'public._a155_tg_booklet_quota()', 'public._wa_opted_out(text, uuid)',
                           'public._a155_tg_pkg_staff_cap()', 'public.wa_recipient_opted_out(text)',
                           'public.comms_outbox_claim(integer)', 'public.pkg_outbox_claim(integer)',
                           'public.invite_email_outbox_claim(integer, uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  -- signed-in entry points (same as before)
  foreach s in array array['public.admin_create_user(text, text, text)', 'public.accept_invitation(text)', 'public.create_invitation(text, text)',
                           'public.whatsapp_authorize(uuid, text)', 'public.wa_proposal_prepare(uuid, text, text, boolean, text, boolean)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.wa_recipient_opted_out(text) to service_role;
    grant execute on function public.comms_outbox_claim(integer) to service_role;
    grant execute on function public.pkg_outbox_claim(integer) to service_role;
    grant execute on function public.invite_email_outbox_claim(integer, uuid) to service_role;
  end if;
end $$;

-- ---- 3c) apply order safety (see 3a): the refreshed 0155 layer goes back under the 0156 wrapper
do $$ declare f text[]; begin
  foreach f slice 1 in array array[array['accept_invitation', 'text'], array['create_invitation', 'text, text']] loop
    if to_regprocedure(format('public.%s__a155hold(%s)', f[1], f[2])) is not null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0156');
      execute format('alter function public.%I(%s) rename to %I', f[1] || '__a155hold', f[2], f[1]);
      execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0156', f[2]);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', f[1] || '__pre0156', f[2]); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', f[1] || '__pre0156', f[2]); end if;
    end if;
  end loop;
end $$;

-- VERIFY (read-only): every row must say ok = true
select item, ok from (values
  ('01 trial columns server-owned', (select pg_get_triggerdef(t.oid) like '%trial_ends_at%trial_mode%demo_choice%'
       from pg_trigger t where t.tgrelid = 'public.organizations'::regclass and t.tgname = 'ab_mass_assign_guard')),
  ('02 admin_create_user wrapped', position('audit-p1-0155' in pg_get_functiondef('public.admin_create_user(text,text,text)'::regprocedure)) > 0
       and to_regprocedure('public.admin_create_user__pre0155(text,text,text)') is not null),
  ('03 accept_invitation wrapped', position('audit-p1-0155' in pg_get_functiondef(coalesce(to_regprocedure('public.accept_invitation__pre0156(text)'), 'public.accept_invitation(text)'::regprocedure))) > 0
       and position('gen_random_bytes' in pg_get_functiondef(coalesce(to_regprocedure('public.accept_invitation__pre0156(text)'), 'public.accept_invitation(text)'::regprocedure))) > 0
       and to_regprocedure('public.accept_invitation__pre0155(text)') is not null),
  ('04 admin-created table private', (select c.relrowsecurity from pg_class c where c.oid = 'public.a155_admin_created'::regclass)
       and not has_table_privilege('authenticated', 'public.a155_admin_created', 'select')),
  ('05 booklet quota trigger', exists (select 1 from pg_trigger t where t.tgrelid = 'public.client_booklet_images'::regclass and t.tgname = 'zz_a155_booklet_quota')),
  ('06 STOP helper closed', not has_function_privilege('authenticated', 'public._wa_opted_out(text, uuid)', 'execute')
       and not has_function_privilege('authenticated', 'public.wa_recipient_opted_out(text)', 'execute')),
  ('07 send paths check STOP', position('_wa_opted_out' in pg_get_functiondef('public.whatsapp_authorize(uuid,text)'::regprocedure)) > 0
       and position('_wa_opted_out' in pg_get_functiondef('public.comms_outbox_claim(integer)'::regprocedure)) > 0
       and position('_wa_opted_out' in pg_get_functiondef('public.pkg_outbox_claim(integer)'::regprocedure)) > 0
       and position('_wa_opted_out' in pg_get_functiondef('public.wa_proposal_prepare(uuid,text,text,boolean,text,boolean)'::regprocedure)) > 0),
  ('08 claims service-role only', not has_function_privilege('authenticated', 'public.comms_outbox_claim(integer)', 'execute')
       and not has_function_privilege('authenticated', 'public.pkg_outbox_claim(integer)', 'execute')
       and not has_function_privilege('authenticated', 'public.invite_email_outbox_claim(integer, uuid)', 'execute')),
  ('09 pkg staff cap trigger', exists (select 1 from pg_trigger t where t.tgrelid = 'public.pkg_outbox'::regclass and t.tgname = 'zz_a155_pkg_staff_cap')),
  ('10 invitation caps', position('audit-p1-0155' in pg_get_functiondef(coalesce(to_regprocedure('public.create_invitation__pre0156(text,text)'), 'public.create_invitation(text,text)'::regprocedure))) > 0
       and to_regprocedure('public.accept_invitation__a155hold(text)') is null and to_regprocedure('public.create_invitation__a155hold(text,text)') is null
       and position('audit-p1-0155' in pg_get_functiondef('public.invite_email_outbox_claim(integer,uuid)'::regprocedure)) > 0),
  ('11 previous bodies kept + private', to_regprocedure('public.whatsapp_authorize__pre0155(uuid,text)') is not null
       and to_regprocedure('public.create_invitation__pre0155(text,text)') is not null
       and not has_function_privilege('authenticated', 'public.whatsapp_authorize__pre0155(uuid, text)', 'execute')
       and not has_function_privilege('authenticated', 'public.admin_create_user__pre0155(text, text, text)', 'execute')),
  ('12 entry points still callable', has_function_privilege('authenticated', 'public.admin_create_user(text, text, text)', 'execute')
       and has_function_privilege('authenticated', 'public.accept_invitation(text)', 'execute')
       and has_function_privilege('authenticated', 'public.whatsapp_authorize(uuid, text)', 'execute')
       and not has_function_privilege('anon', 'public.whatsapp_authorize(uuid, text)', 'execute'))
) v(item, ok);

commit;
