-- =========================================================================
-- Client approval: OTP + consent + payment link + notifications.
-- Run ONCE in the Supabase SQL editor (after setup-complete.sql). Idempotent.
--
-- Flow: manager generates a secure approval link (per-quote token) → client opens
-- the public page → reviews T&C → enters phone → gets an OTP → verifies + consents
-- → a payment link is created → on payment, quote is marked paid; client + manager
-- are notified. OTPs are HASHED server-side; anon reaches only its own quote via the
-- unguessable token; consent is stored as an immutable audit row.
--
-- SIMULATION vs LIVE: with app_config.*_live = false (the default), OTP codes are
-- returned to the page for testing and the payment link is a mock. Deploy the Edge
-- Functions and set the flags true to send real SMS/email and real Razorpay links.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- role helpers (redefined so this file stands alone)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- 0) config flags (simulation by default) ---------------------------------
create table if not exists public.app_config (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
insert into public.app_config(key,value) values
  ('channels', '{"sms_live":false,"email_live":false,"pay_live":false,"otp_dev_echo":false}'::jsonb)
  on conflict (key) do nothing;
-- OTP-01: ensure the explicit dev-echo flag exists on pre-existing installs too
-- (defaults false → production never echoes the OTP; see request_otp below).
update public.app_config set value = value || '{"otp_dev_echo":false}'::jsonb
  where key='channels' and not (value ? 'otp_dev_echo');
create or replace function public._flag(p text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>p)::boolean from public.app_config where key='channels'), false); $$;

-- 1) columns on quotes ----------------------------------------------------
alter table public.quotes add column if not exists approval_token   uuid;
alter table public.quotes add column if not exists approval_status  text not null default 'none';
-- TOKEN-01: optional expiry + explicit revocation for the approval/portal bearer
-- token. expires_at NULL = no expiry (existing published links keep working —
-- grace). Revocation nulls the token, which invalidates it across EVERY consumer
-- (they all look it up by approval_token). A default TTL is a PRODUCT DECISION
-- (not invented here); set approval_token_expires_at when the product decides one.
alter table public.quotes add column if not exists approval_token_expires_at timestamptz;
alter table public.quotes add column if not exists approval_token_revoked_at  timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname='quotes_approval_status_chk') then
    alter table public.quotes add constraint quotes_approval_status_chk
      check (approval_status in ('none','sent','approved','paid','cancelled'));
  end if;
end $$;
create unique index if not exists quotes_approval_token_idx on public.quotes(approval_token) where approval_token is not null;

-- 2) tables ---------------------------------------------------------------
create table if not exists public.quote_otps (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists otp_quote_idx on public.quote_otps(quote_id, created_at desc);

create table if not exists public.quote_consents (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text,
  client_name text,
  terms_version text,
  consent_text text,
  agreed boolean not null default false,
  verified_via_otp boolean not null default false,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists consent_quote_idx on public.quote_consents(quote_id, created_at desc);

create table if not exists public.quote_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  provider text not null default 'razorpay',
  amount numeric not null default 0,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','paid','failed','refunded','cancelled')),
  link_url text,
  provider_ref text,
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists pay_quote_idx on public.quote_payments(quote_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references public.quotes(id) on delete cascade,
  channel text not null check (channel in ('sms','email')),
  recipient text,
  kind text,
  status text not null default 'simulated' check (status in ('simulated','sent','failed')),
  detail jsonb,
  created_at timestamptz not null default now()
);

-- 3) RLS: managers (authenticated) read the audit; anon reaches data only via RPCs
alter table public.quote_otps      enable row level security;
alter table public.quote_consents  enable row level security;
alter table public.quote_payments  enable row level security;
alter table public.notifications   enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('quote_otps','quote_consents','quote_payments','notifications')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
-- no OTP read to clients; managers may read consents/payments/notifications for the audit
create policy "mgr read consents"      on public.quote_consents  for select to authenticated using ( true );
create policy "mgr read payments"      on public.quote_payments  for select to authenticated using ( true );
create policy "mgr read notifications" on public.notifications    for select to authenticated using ( true );

-- 4) helper: log a notification (simulated unless the channel is live) ------
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare live boolean;
begin
  live := case p_channel when 'sms' then public._flag('sms_live') when 'email' then public._flag('email_live') else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
  -- NOTE: when live, the Edge Function performs the actual send (this only logs intent).
end; $$;

-- 5) manager: generate / return the per-quote approval link token ----------
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  -- SEC-03 / DEPLOY-01: org-scope this body so it matches phase73 and can never
  -- revert tenant isolation even if this file is re-run after phase73.
  perform public.assert_quote_org(p_quote_id);
  select approval_token into tok from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if tok is null then tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_status = 'sent', updated_at = now()
      where id = p_quote_id and org_id = public.current_org_id();
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end
      where id = p_quote_id and org_id = public.current_org_id();
  end if;
  return tok;
end; $$;

-- 5b) manager: REVOKE a quote's approval/portal token (TOKEN-01) ------------
-- Nulls the token, so it immediately stops working in EVERY consumer
-- (public_get_quote/request_otp/verify_and_consent/create_payment/portal).
-- Org-scoped; a new link can be minted later via generate_approval_token.
create or replace function public.revoke_approval_token(p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quotes
     set approval_token = null,
         approval_token_revoked_at = now(),
         approval_status = case when approval_status in ('sent','none') then 'cancelled' else approval_status end,
         updated_at = now()
   where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'no such event' using errcode='42501'; end if;
  return jsonb_build_object('revoked', true);
end; $$;
revoke all on function public.revoke_approval_token(uuid) from anon;
grant execute on function public.revoke_approval_token(uuid) to authenticated;

-- 6) public: fetch the safe, client-facing view of a quote by token --------
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());  -- TOKEN-01: expiry-if-set
  if q.id is null then raise exception 'invalid link'; end if;
  return jsonb_build_object(
    'code', q.code, 'title', q.title, 'event_type', q.event_type,
    'status', q.status, 'approval_status', q.approval_status,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing);
end; $$;

-- 7) public: request an OTP for this quote+phone ---------------------------
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());  -- TOKEN-01: expiry-if-set
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- Generate a random 6-digit code (never a hardcoded/predictable PIN). In
  -- simulation the code is still echoed to the caller via dev_code below; when
  -- sms_live is on, MSG91 generates the real code via the send-otp Edge Function.
  -- SECURITY (PR-AUTH-01): a fixed PIN such as 123456 must never be used — a
  -- token holder could otherwise guess it. See scripts/check-otp-safety.mjs.
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  -- SECURITY (OTP-01): the plaintext code is returned to the anon caller ONLY
  -- when an EXPLICIT non-production echo flag is enabled (otp_dev_echo, default
  -- false) AND SMS is not live. In production both are false, so the code is
  -- NEVER echoed — `sms_live=false` alone must not turn the OTP into a bypass.
  -- With no real SMS provider configured, the flow reports 'unavailable' (fail
  -- closed) instead of silently leaking the code to whoever holds the token.
  if live then
    -- LIVE: SMS carries the code; never return it.
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    -- LOCAL DEV ONLY (explicit opt-in): echo the code so it can be read back.
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    -- Fail closed: no live provider and no dev echo → the flow is unavailable.
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $$;

-- 7b) service-role: store an externally-generated OTP hash (used by the live
--     send-otp Edge Function, which generates the code and sends it via MSG91).
create or replace function public.admin_store_otp(p_token uuid, p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; recent int;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());  -- TOKEN-01: expiry-if-set
  if q.id is null then raise exception 'invalid link'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests'; end if;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(p_code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  return jsonb_build_object('stored', true);
end; $$;
revoke all on function public.admin_store_otp(uuid,text,text) from public, anon, authenticated;

-- 8) public: verify OTP + record consent (approves the quote) --------------
create or replace function public.verify_and_consent(
  p_token uuid, p_phone text, p_code text, p_agreed boolean,
  p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());  -- TOKEN-01: expiry-if-set
  if q.id is null then raise exception 'invalid link'; end if;
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then raise exception 'no active code — request a new OTP'; end if;
  if rec.attempts >= 5 then raise exception 'too many attempts — request a new OTP'; end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    raise exception 'incorrect code';
  end if;
  if p_agreed is not true then raise exception 'you must accept the terms to confirm'; end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $$;

-- 9) public: create a payment link (simulated unless pay is live) ----------
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; amt numeric; pid uuid; link text; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());  -- TOKEN-01: expiry-if-set
  if q.id is null then raise exception 'invalid link'; end if;
  if q.approval_status not in ('approved','paid') then raise exception 'approve the terms first'; end if;
  amt := coalesce((q.pricing->>'total')::numeric, 0);
  live := public._flag('pay_live');
  if live then
    -- LIVE: the Edge Function must create the real Razorpay link and update this row.
    insert into public.quote_payments(quote_id, provider, amount, status, simulated)
      values (q.id,'razorpay',amt,'created',false) returning id into pid;
    return jsonb_build_object('payment_id', pid, 'pending_provider', true, 'amount', amt);
  else
    link := 'sim-pay.html?ref='||q.code||'&amount='||amt::text;
    insert into public.quote_payments(quote_id, provider, amount, status, link_url, simulated)
      values (q.id,'simulated',amt,'created',link,true) returning id into pid;
    perform public._notify(q.id,'sms', q.client->>'phone','payment_link', jsonb_build_object('url',link,'amount',amt));
    return jsonb_build_object('payment_id', pid, 'link_url', link, 'amount', amt, 'live', false);
  end if;
end; $$;

-- 10) mark paid (webhook via Edge Function in live; dev button for managers)
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  -- allowed for managers (dev button) — the live webhook Edge Function uses the service role
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  -- SEC-03 / DEPLOY-01: org-scope so this cannot mark another tenant's payment
  -- paid even if this file is re-applied after phase73.
  perform public.assert_quote_org(p_quote_id);
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $$;

-- grants: token-scoped public flow reachable by anon; manager ops by authenticated
grant execute on function public.public_get_quote(uuid)                               to anon, authenticated;
grant execute on function public.request_otp(uuid,text)                               to anon, authenticated;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated;
grant execute on function public.create_payment(uuid)                                 to anon, authenticated;
revoke all on function public.generate_approval_token(uuid) from anon;
revoke all on function public.mark_paid(uuid,text)          from anon;
grant execute on function public.generate_approval_token(uuid) to authenticated;
grant execute on function public.mark_paid(uuid,text)          to authenticated;

-- verify
select 'quote_otps' t, count(*) n from public.quote_otps
union all select 'quote_consents', count(*) from public.quote_consents
union all select 'quote_payments', count(*) from public.quote_payments
union all select 'notifications', count(*) from public.notifications
union all select 'config', count(*) from public.app_config;
