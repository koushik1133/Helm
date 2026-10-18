-- 0179_trial_no_client_messages.sql - CANONICAL forward-only. REQUIRES 0093 (request_otp),
-- 0097 (otp_send_authorize), 0151 (wa_otp_begin / _wa151_token_quote), 0155 (whatsapp_authorize,
-- wa_proposal_prepare), 0166 (_is_trial_org, _sample_outbound_blocked, seat + outbox triggers).
--
-- In plain words:
--   NO REAL CLIENT MESSAGES FROM A FREE-TRIAL STUDIO. 0166 only skipped queued outbox rows; the
--   direct routes (approval OTP by SMS / WhatsApp / e-mail, staff "Send on WhatsApp", proposal
--   WhatsApp) still sent. Now:
--     1) _tb179_no_send(org): true while the studio is in its free trial
--        (studio_subscriptions.status = 'trial', via _is_trial_org) or is the sample master.
--        Paid studios: always false - nothing changes for them.
--     2) otp_send_authorize, request_otp, wa_otp_begin, whatsapp_authorize, wa_proposal_prepare
--        are wrapped (old body kept as <name>__pre0179): a trial studio gets
--        42501 / hint 'trial_no_send'. The 0155 "10 a day to opted-in clients" trial exception is
--        therefore gone (trial = 0 real sends). wa_proposal_prepare still answers a SIMULATED
--        prepare (p_simulate = true: nothing is sent, the share screen shows "Simulated").
--     3) trial_send_blocked(org, quote, token): service-role-only check the edge functions
--        (send-otp, client-mailer, send-whatsapp, wa-proposal) call before sending.
--     4) Outbox guard also on UPDATE: a retry that puts a row back to 'pending' is skipped too.
--     5) Seat limit (admin + 2) also counts a role change client -> staff role (admin_set_role,
--        staff_set_login_role) and a pending invitation whose role changes from client; joining
--        or promoting now also counts the studio's other open staff invitations.
--   Changes: 2 new functions, 5 wrapped, 2 trigger functions replaced, 2 + 3 triggers added, one
--   small bookkeeping table (tb179_grants: which app roles could call each wrapped function, so a
--   re-run gives the wrapper exactly the old callers). No existing table or column changed, no
--   studio row written. Additive + idempotent: safe to run twice. ASCII only.

do $$ begin
  if to_regprocedure('public._is_trial_org(uuid)') is null or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null then
    raise exception '0179: apply 0166 first'; end if;
  if to_regprocedure('public._wa151_token_quote(uuid)') is null or to_regprocedure('public.wa_otp_begin(uuid,text,text)') is null then
    raise exception '0179: apply 0151 first'; end if;
  if to_regprocedure('public.whatsapp_authorize__pre0155(uuid,text)') is null then raise exception '0179: apply 0155 first'; end if;
end $$;

-- ---- 1) helpers --------------------------------------------------------------------------------
create or replace function public._tb179_no_send(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- tb-msg-0179: free trial (subscription status) or the sample master never sends to clients
  select p_org is not null
     and (public._is_trial_org(p_org)
          or exists (select 1 from public.organizations o where o.id = p_org and o.is_sample_master));
$$;
revoke all on function public._tb179_no_send(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._tb179_no_send(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._tb179_no_send(uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public._tb179_no_send(uuid) to service_role; end if;
end $$;

create or replace function public.trial_send_blocked(p_org uuid default null, p_quote uuid default null, p_token uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  -- tb-msg-0179: edge functions (service role) ask before any real send
  select coalesce(public._tb179_no_send(p_org), false)
      or coalesce((select public._tb179_no_send(q.org_id) from public.quotes q where p_quote is not null and q.id = p_quote), false)
      or coalesce((select bool_or(public._tb179_no_send(q.org_id)) from public.quotes q where p_token is not null and q.approval_token = p_token), false)
      or coalesce((select bool_or(public._tb179_no_send(b.org_id)) from public.client_booklets b where p_token is not null and b.token = p_token), false);
$$;
revoke all on function public.trial_send_blocked(uuid, uuid, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.trial_send_blocked(uuid, uuid, uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.trial_send_blocked(uuid, uuid, uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.trial_send_blocked(uuid, uuid, uuid) to service_role; end if;
end $$;

-- ---- 2) keep each current body as <name>__pre0179 (once); remember who could call it ------------
create table if not exists public.tb179_grants (fn text not null, rolname text not null, primary key (fn, rolname));
alter table public.tb179_grants enable row level security;
revoke all on public.tb179_grants from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on public.tb179_grants from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on public.tb179_grants from authenticated; end if;
end $$;

do $$ declare f text[]; v_old text; v_new text; rl text; begin
  foreach f slice 1 in array array[
    array['otp_send_authorize', 'uuid, text'],
    array['request_otp', 'uuid, text'],
    array['wa_otp_begin', 'uuid, text, text'],
    array['whatsapp_authorize', 'uuid, text'],
    array['wa_proposal_prepare', 'uuid, text, text, boolean, text, boolean']] loop
    v_old := format('public.%s(%s)', f[1], f[2]);
    v_new := format('public.%s(%s)', f[1] || '__pre0179', f[2]);
    if to_regprocedure(v_new) is null and to_regprocedure(v_old) is not null
       and position('tb-msg-0179' in pg_get_functiondef(to_regprocedure(v_old))) = 0 then
      foreach rl in array array['anon', 'authenticated', 'service_role'] loop
        if exists (select 1 from pg_roles where rolname = rl) and has_function_privilege(rl, v_old, 'execute') then
          insert into public.tb179_grants(fn, rolname) values (f[1], rl) on conflict do nothing;
        end if;
      end loop;
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0179');
    end if;
  end loop;
end $$;

-- ---- 3) wrappers -------------------------------------------------------------------------------
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- tb-msg-0179: no approval code is sent from a free-trial studio
begin
  if exists (select 1 from public.quotes q where p_token is not null and q.approval_token = p_token and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.otp_send_authorize__pre0179(p_token, p_phone);
end $$;

create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- tb-msg-0179: no approval code from a free-trial studio (the portal uses Test mode - confirm, 0176)
begin
  if exists (select 1 from public.quotes q where p_token is not null and q.approval_token = p_token and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.request_otp__pre0179(p_token, p_phone);
end $$;

create or replace function public.wa_otp_begin(p_token uuid, p_channel text, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- tb-msg-0179: no WhatsApp / e-mail approval code from a free-trial studio
begin
  if exists (select 1 from public.quotes q where p_token is not null and q.approval_token = p_token and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.wa_otp_begin__pre0179(p_token, p_channel, p_user_agent);
end $$;

create or replace function public.whatsapp_authorize(p_quote uuid, p_recipient text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- tb-msg-0179: a free-trial studio sends 0 real WhatsApp messages (replaces the 0155 opt-in exception)
begin
  if exists (select 1 from public.quotes q where p_quote is not null and q.id = p_quote and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.whatsapp_authorize__pre0179(p_quote, p_recipient);
end $$;

create or replace function public.wa_proposal_prepare(p_quote uuid, p_kind text, p_phone text,
                                                      p_opt_in boolean, p_consent_text text, p_simulate boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- tb-msg-0179: no real proposal WhatsApp from a free-trial studio (a simulated prepare sends nothing)
begin
  if coalesce(p_simulate, false) is not true
     and exists (select 1 from public.quotes q where p_quote is not null and q.id = p_quote and public._tb179_no_send(q.org_id)) then
    raise exception 'Free trial: messages to clients are not sent' using errcode = '42501', hint = 'trial_no_send';
  end if;
  return public.wa_proposal_prepare__pre0179(p_quote, p_kind, p_phone, p_opt_in, p_consent_text, p_simulate);
end $$;

-- grants: wrapper = what the old body had; the kept body is service-role only
do $$ declare f text[]; v_old text; v_new text; rl text; begin
  foreach f slice 1 in array array[
    array['otp_send_authorize', 'uuid, text'],
    array['request_otp', 'uuid, text'],
    array['wa_otp_begin', 'uuid, text, text'],
    array['whatsapp_authorize', 'uuid, text'],
    array['wa_proposal_prepare', 'uuid, text, text, boolean, text, boolean']] loop
    v_old := format('public.%s(%s)', f[1], f[2]);
    v_new := format('public.%s(%s)', f[1] || '__pre0179', f[2]);
    execute format('revoke all on function %s from public', v_old);
    -- Supabase default privileges hand a NEW function to anon / authenticated: take that back first
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_old); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_old); end if;
    for rl in select g.rolname from public.tb179_grants g where g.fn = f[1] loop
      if exists (select 1 from pg_roles where rolname = rl) then execute format('grant execute on function %s to %I', v_old, rl); end if;
    end loop;
    if to_regprocedure(v_new) is not null then
      execute format('revoke all on function %s from public', v_new);
      if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', v_new); end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', v_new); end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', v_new); end if;
    end if;
  end loop;
end $$;

-- ---- 4) outbox guard on UPDATE too (retry back to pending) --------------------------------------
do $$ declare t text; begin
  foreach t in array array['comms_outbox', 'pkg_outbox', 'assign_notify_outbox'] loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_trigger where tgrelid = format('public.%I', t)::regclass and tgname = 'zzzz_tb179_outbox_skip_upd') then
      execute format('create trigger zzzz_tb179_outbox_skip_upd before update of status on public.%I for each row '
                     'when (new.status = ''pending'' and old.status is distinct from ''pending'') '
                     'execute function public._ts166_tg_outbox_skip()', t);
    end if;
  end loop;
end $$;

-- ---- 5) seat limit also on role changes -----------------------------------------------------------
create or replace function public._ts166_tg_profile_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: joining a studio (any path) may not pass the seat limit
-- tb-msg-0179: a role change client -> staff role inside the studio counts as a new seat, and the
-- studio's other open staff invitations count too (admin + 2 = members + pending invitations)
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.org_id is not distinct from new.org_id and coalesce(old.role, '') <> 'client' then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  -- members + the studio's other open staff invitations (not this person's own invitation)
  select (select count(*) from public.profiles p
           where p.org_id = new.org_id and p.id <> new.id and coalesce(p.role, '') <> 'client')
       + (select count(*) from public.invitations i
           where i.org_id = new.org_id and i.status = 'pending' and coalesce(i.role, '') <> 'client'
             and (i.expires_at is null or i.expires_at > now())
             and lower(i.email) is distinct from lower(coalesce(new.email, ''))
             and not exists (select 1 from public.profiles p
                              where p.org_id = new.org_id and p.id <> new.id and lower(p.email) = lower(i.email)))
    into v_used;
  if v_used >= v_lim then
    raise exception 'Your free trial includes % people (you + % more). Upgrade to add more.', v_lim, v_lim - 1
      using errcode = '42501', hint = 'seat_limit';
  end if;
  return new;
end $$;

create or replace function public._ts166_tg_invite_seat()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-sandbox-0166: members + open invitations may not pass the seat limit
-- tb-msg-0179: a pending invitation whose role changes from client counts as a new seat
declare v_lim integer; v_used integer;
begin
  if new.org_id is null or coalesce(new.status, 'pending') <> 'pending' or coalesce(new.role, '') = 'client' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'pending' and old.org_id is not distinct from new.org_id
     and coalesce(old.role, '') <> 'client' then return new; end if;
  v_lim := public._trial_seat_limit(new.org_id);
  if v_lim is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:seat:' || new.org_id::text, 0));
  select (select count(*) from public.profiles p where p.org_id = new.org_id and coalesce(p.role, '') <> 'client')
       + (select count(*) from public.invitations i
           where i.org_id = new.org_id and i.status = 'pending' and i.id is distinct from new.id
             and coalesce(i.role, '') <> 'client' and (i.expires_at is null or i.expires_at > now())
             and not exists (select 1 from public.profiles p where p.org_id = new.org_id and lower(p.email) = lower(i.email)))
    into v_used;
  if v_used >= v_lim then
    raise exception 'Your free trial includes % people (you + % more). Remove an invitation or upgrade to add more.', v_lim, v_lim - 1
      using errcode = '42501', hint = 'seat_limit';
  end if;
  return new;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'zzzz_tb179_seat_role') then
    create trigger zzzz_tb179_seat_role before update of role on public.profiles
      for each row when (old.org_id is not distinct from new.org_id and coalesce(old.role, '') = 'client' and coalesce(new.role, '') <> 'client')
      execute function public._ts166_tg_profile_seat();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.invitations'::regclass and tgname = 'zzzz_tb179_seat_role') then
    create trigger zzzz_tb179_seat_role before update of role on public.invitations
      for each row when (old.org_id is not distinct from new.org_id and old.status is not distinct from new.status
                         and coalesce(old.role, '') = 'client' and coalesce(new.role, '') <> 'client')
      execute function public._ts166_tg_invite_seat();
  end if;
end $$;

-- trigger functions stay internal (create or replace keeps the 0166 grants; said again for a fresh paste)
do $$ declare f text; begin
  foreach f in array array['public._ts166_tg_profile_seat()', 'public._ts166_tg_invite_seat()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
