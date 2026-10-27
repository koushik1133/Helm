-- 0279_referral_program.sql - CANONICAL forward-only.
-- REQUIRES 0045 (studio_subscriptions, subscription_payments, billing_reminders, audit_log rows), 0056 (billing_interval),
--          0058 (notifications kind 'trial_reminder' = admin-only bell rows), 0244 (_sub_activate / hq_activate_plan: the
--          one path that makes a studio paying), 0273 (_checkout_currency: the studio's fixed billing currency, USD list
--          prices), 0186 (trial_grants: one free trial per person), 0277 (HQ staff roles: _hq27_me / _hq27_role_perms / _hq27_require / _hq27_client_ip).
--
-- In plain words (owner, r29: "refer a studio - both get one month free"; REFERRAL-PROGRAM-PLAN.md, owner decisions):
--   1  Every studio gets ONE personal code + link (helm.events/r/SHAADISQ-7K2Q). Only the studio owner / admin sees it
--      (my_referral). Trial studios can share it too; their reward waits for their own first payment (max 6 months).
--   2  HQ makes PARTNER / MARKETING codes ("Priya - Instagram", "Diwali expo"): code + link, an optional offer
--      (free months or a % off), end date, most uses, terms, the ASCI "#ad" promise for influencers. Partners get
--      free months (only when the partner is itself a Helm studio), a discount or tracking only - NEVER cash.
--   3  Sign-up: the new studio's admin attaches ONE code (referral_attach, right after the studio is created).
--      A code typed at sign-up beats a clicked link; the last link clicked within 60 days counts. Support (HQ) can add
--      a forgotten code within 14 days of sign-up and before the first payment (hq_referral_attach). Never later.
--   4  Fraud checks on the server only (hashed fingerprints, never raw values; the referrer never sees the new studio's
--      e-mail): same e-mail / phone / GSTIN / PAN / payment card or UPI -> rejected automatically; same company domain,
--      device, internet address, throw-away e-mail, more than 5 sign-ups on one code in 24 hours -> scored; 1-2 points
--      -> "Needs review" in HQ, 3+ -> rejected. Checked at sign-up and again at the first payment.
--   5  The referral counts after the new studio's FIRST REAL (non-zero) payment + a 14-day hold with no refund
--      (voided payment), chargeback (voided) or cancellation. Never paid within 60 days -> "Did not start paying".
--   6  Then (referral_tick, daily): the new studio gets its free month and the referrer gets one free month (partner
--      codes: the partner's offer). A free month = the studio's plan, one month, in the studio's OWN billing
--      currency, never cash: it is used by moving studio_subscriptions.current_period_end one month later -
--      monthly plans when the renewal is due (that renewal is billed $0 / Rs 0; a waiting "due soon" reminder for it is
--      marked skipped), yearly plans at once (the renewal date moves one month per reward). Several stack, one after
--      another. Cap: 12 free months per referrer in any rolling 12 months (above it: "capped", the new studio still gets
--      its month). Referrer still on trial: held, starts at their first payment, expires after 6 months. Referrer
--      cancels: unused months frozen, back if they return within 6 months. Unused months expire 24 months after earned.
--   7  Refund / chargeback AFTER the reward was confirmed: an unused reward is reversed; a USED one is written off (the
--      referrer is never charged) and flagged for HQ.
--   8  Bell notices to the referrer's admins (sign-up, reward earned, free month used) + e-mails QUEUED in
--      referral_notice_queue (DORMANT: no sender reads it yet). HQ reporting values free months in USD at list price.
--   9  The program starts SWITCHED OFF (referral_settings.program_on = false): HQ switches it on. Existing referrals keep
--      their rules if it is switched off later.
--   New tables: referral_settings, referral_codes, referral_click_days, referral_rate_buckets, referrals,
--   referral_rewards, referral_reward_events (append-only), referral_fingerprints, referral_notice_queue - RLS on,
--   no write privilege for any API role (definer RPCs only); a studio admin may READ its own code and rewards.
--   New triggers (AFTER, never block a payment / subscription change - errors are logged, not raised):
--   r29_payment on subscription_payments (first payment / void), r29_subscription on studio_subscriptions (status).
--   Nothing existing is deleted or rewritten; no existing function is replaced (r29c: the daily job clears only its OWN
--   expired rate-limit counters, referral_rate_buckets older than 2 hours). Columns written on existing rows:
--   studio_subscriptions.current_period_end (+1 month per free month; past_due -> active when that covers today) and
--   billing_reminders.sent_at / channel ('skipped') for a due-soon reminder of a renewal that became free.
--   Additive + idempotent: safe to run twice. ASCII only. The daily schedule is in SCHEDULE-0279.sql (pg_cron only).
-- ROLLBACK (manual, only if ever needed): drop trigger r29_payment on public.subscription_payments; drop trigger
--   r29_subscription on public.studio_subscriptions; select cron.unschedule('helm_referral_tick') (if scheduled);
--   update public.referral_settings set program_on = false. The tables can stay (they only hold referral rows).

do $$ begin
  if to_regclass('public.studio_subscriptions') is null or to_regclass('public.subscription_payments') is null
     or to_regclass('public.billing_reminders') is null then
    raise exception 'STOP 0279: 0045 (HQ subscriptions) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_subscriptions'
                   and column_name = 'billing_interval') then raise exception 'STOP 0279: 0056 (billing_interval) is not applied'; end if;
  if to_regprocedure('public._sub_activate(uuid,uuid,text,date,date,uuid,text)') is null then
    raise exception 'STOP 0279: 0244 (_sub_activate) is not applied'; end if;
  if to_regprocedure('public._checkout_currency(uuid)') is null or to_regclass('public.helm_plan_prices') is null then
    raise exception 'STOP 0279: 0056 / 0273 (_checkout_currency, helm_plan_prices) is not applied'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regprocedure('public._hq27_me()') is null
     or to_regprocedure('public._hq27_role_perms(text)') is null or to_regprocedure('public._hq27_client_ip()') is null then
    raise exception 'STOP 0279: 0277 (HQ staff roles) is not applied'; end if;
  if to_regclass('public.trial_grants') is null or to_regprocedure('public._trial_email_fingerprint(text)') is null then
    raise exception 'STOP 0279: 0186 (trial_grants) is not applied'; end if;
  if to_regclass('public.notifications') is null or to_regclass('public.studio_account') is null then
    raise exception 'STOP 0279: notifications / studio_account are missing'; end if;
end $$;

-- ---- 1) tables ---------------------------------------------------------------------------------------------------------
create table if not exists public.referral_settings (
  id                boolean primary key default true check (id),
  program_on        boolean not null default false,
  hold_days         integer not null default 14 check (hold_days between 0 and 90),
  pay_within_days   integer not null default 60 check (pay_within_days between 7 and 365),
  link_days         integer not null default 60 check (link_days between 1 and 180),
  late_code_days    integer not null default 14 check (late_code_days between 0 and 60),
  self_attach_hours integer not null default 48 check (self_attach_hours between 1 and 336),
  cap_per_year      integer not null default 12 check (cap_per_year between 0 and 24),
  held_months       integer not null default 6 check (held_months between 1 and 24),
  frozen_months     integer not null default 6 check (frozen_months between 1 and 24),
  expiry_months     integer not null default 24 check (expiry_months between 1 and 60),
  velocity_per_day  integer not null default 5 check (velocity_per_day between 1 and 1000),
  apply_days_before integer not null default 8 check (apply_days_before between 0 and 27),
  hash_salt         text not null default (md5(random()::text || clock_timestamp()::text) || md5(gen_random_uuid()::text)),
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);
insert into public.referral_settings(id) values (true) on conflict (id) do nothing;

create table if not exists public.referral_codes (
  code             text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,23}$'),
  kind             text not null check (kind in ('studio', 'partner')),
  studio_id        uuid references public.organizations(id) on delete set null,     -- kind studio: the owner studio
  partner_name     text check (partner_name is null or char_length(partner_name) between 1 and 80),
  partner_kind     text check (partner_kind is null or partner_kind in ('influencer', 'campaign', 'event', 'reseller', 'other')),
  partner_studio   uuid references public.organizations(id) on delete set null,     -- a partner that is a Helm studio
  offer_type       text not null default 'months' check (offer_type in ('months', 'percent', 'none')),
  offer_months     integer not null default 1 check (offer_months between 0 and 3),
  offer_percent    integer not null default 0 check (offer_percent between 0 and 50),
  offer_for_months integer not null default 0 check (offer_for_months between 0 and 12),
  partner_reward   text not null default 'tracking' check (partner_reward in ('none', 'tracking', 'months')),
  max_uses         integer not null default 0 check (max_uses between 0 and 100000),
  uses             integer not null default 0 check (uses >= 0),
  ends_at          timestamptz,
  terms            text check (terms is null or char_length(terms) <= 1000),
  notes            text check (notes is null or char_length(notes) <= 500),
  disclosure_ack   boolean not null default false,
  active           boolean not null default true,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  check (kind <> 'partner' or partner_name is not null)
);
create unique index if not exists referral_codes_one_per_studio on public.referral_codes(studio_id) where kind = 'studio';

-- clicks: a count per code per day only (no address, no person, nothing to clean up)
create table if not exists public.referral_click_days (
  code   text not null references public.referral_codes(code) on delete cascade,
  day    date not null,
  clicks integer not null default 0 check (clicks >= 0),
  primary key (code, day)
);
-- rate limits for the public look-up / click calls: one counter per hashed network per hour (overwritten in place)
create table if not exists public.referral_rate_buckets (
  bucket       text primary key check (char_length(bucket) <= 120),
  n            integer not null default 0,
  window_start timestamptz not null default now()
);

create table if not exists public.referrals (
  id               uuid primary key default gen_random_uuid(),
  code             text not null references public.referral_codes(code) on delete restrict,
  kind             text not null check (kind in ('studio', 'partner')),
  referrer_org     uuid references public.organizations(id) on delete set null,
  referred_org     uuid unique references public.organizations(id) on delete set null,   -- ONE code per new studio
  via              text not null check (via in ('link', 'typed', 'support')),
  consent_name     boolean not null default false,
  link_clicked_at  timestamptz,
  signed_up_at     timestamptz not null default now(),
  plan_started_at  timestamptz,
  first_paid_at    timestamptz,
  first_payment_id uuid,
  hold_until       timestamptz,
  qualified_at     timestamptz,
  status           text not null default 'signed_up'
                   check (status in ('signed_up', 'trial', 'first_month', 'hold', 'review', 'qualified', 'not_qualified')),
  reason           text check (reason is null or reason in ('self_referral', 'existing', 'refunded', 'no_payment', 'cancelled',
                                                            'code_after', 'cap', 'duplicate', 'fraud')),
  flags            jsonb not null default '[]'::jsonb,
  score            integer not null default 0,
  approved         boolean not null default false,
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text check (decision_note is null or char_length(decision_note) <= 500),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((status = 'not_qualified') = (reason is not null))
);
create index if not exists referrals_code_idx on public.referrals(code, signed_up_at);
create index if not exists referrals_referrer_idx on public.referrals(referrer_org);
create index if not exists referrals_open_idx on public.referrals(status) where status in ('signed_up', 'trial', 'first_month', 'hold', 'review');

create table if not exists public.referral_rewards (
  id              uuid primary key default gen_random_uuid(),
  referral_id     uuid references public.referrals(id) on delete set null,
  studio_id       uuid references public.organizations(id) on delete set null,
  side            text not null check (side in ('referrer', 'referred', 'partner')),
  kind            text not null default 'month' check (kind in ('month', 'discount')),
  percent         integer check (percent is null or percent between 1 and 50),
  for_months      integer check (for_months is null or for_months between 1 and 12),
  state           text not null check (state in ('held', 'scheduled', 'applied', 'frozen', 'expired', 'reversed',
                                                 'written_off', 'capped', 'forfeited')),
  state_reason    text check (state_reason is null or char_length(state_reason) <= 200),
  earned_at       timestamptz not null default now(),
  held_until      timestamptz,
  frozen_at       timestamptz,
  expires_at      timestamptz,
  applied_at      timestamptz,
  applied_from    date,
  applied_to      date,
  plan_code       text,
  billing_interval text,
  currency        text check (currency is null or currency ~ '^[A-Z]{3}$'),
  value_minor     bigint,
  value_usd       numeric(10,2),
  flagged         boolean not null default false,
  note            text check (note is null or char_length(note) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists referral_rewards_studio_idx on public.referral_rewards(studio_id, state);
create index if not exists referral_rewards_referral_idx on public.referral_rewards(referral_id);

-- every reward state change, kept for ever (append-only: no update, no delete)
create table if not exists public.referral_reward_events (
  id         bigserial primary key,
  reward_id  uuid not null,
  from_state text,
  to_state   text not null,
  reason     text check (reason is null or char_length(reason) <= 200),
  actor      uuid,
  at         timestamptz not null default now()
);
create index if not exists referral_reward_events_reward_idx on public.referral_reward_events(reward_id, at);

-- hashed signals per studio (salted sha256; never a raw e-mail / phone / card / address)
create table if not exists public.referral_fingerprints (
  studio_id uuid not null references public.organizations(id) on delete cascade,
  kind      text not null check (kind in ('email', 'domain', 'phone', 'gstin', 'pan', 'card', 'upi', 'device', 'ip')),
  hash      text not null check (hash ~ '^[0-9a-f]{64}$'),
  at        timestamptz not null default now(),
  primary key (studio_id, kind, hash)
);
create index if not exists referral_fingerprints_hash_idx on public.referral_fingerprints(kind, hash);

-- e-mails to the referrer, QUEUED only (dormant: no sender claims this queue yet; recipients are resolved when sending)
create table if not exists public.referral_notice_queue (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid references public.organizations(id) on delete set null,
  kind       text not null check (kind in ('referral_signed_up', 'referral_qualified', 'reward_applied', 'welcome_month')),
  ref_id     uuid,
  status     text not null default 'queued' check (status in ('queued', 'sent', 'skipped')),
  dedupe_key text not null unique check (char_length(dedupe_key) <= 200),
  created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['referral_settings', 'referral_codes', 'referral_click_days', 'referral_rate_buckets', 'referrals',
                           'referral_rewards', 'referral_reward_events', 'referral_fingerprints', 'referral_notice_queue'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
  end loop;
  revoke all on sequence public.referral_reward_events_id_seq from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on sequence public.referral_reward_events_id_seq from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on sequence public.referral_reward_events_id_seq from authenticated;
    -- a studio admin may READ its own code and its own rewards (RLS below); every write is a definer RPC
    grant select on table public.referral_codes to authenticated;
    grant select on table public.referral_rewards to authenticated;
  end if;
end $$;
drop policy if exists r29_codes_own on public.referral_codes;
create policy r29_codes_own on public.referral_codes for select to authenticated
  using (kind = 'studio' and studio_id is not null and studio_id = (select public.current_org_id()) and (select public.is_admin()));
drop policy if exists r29_rewards_own on public.referral_rewards;
create policy r29_rewards_own on public.referral_rewards for select to authenticated
  using (studio_id is not null and studio_id = (select public.current_org_id()) and (select public.is_admin()));

-- the reward event log can never be changed or removed
create or replace function public.tg_r29_events_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'referral reward events are append-only' using errcode = '42501';
end $$;
drop trigger if exists r29_events_append_only on public.referral_reward_events;
create trigger r29_events_append_only before update or delete on public.referral_reward_events
  for each row execute function public.tg_r29_events_append_only();

-- ---- 2) small helpers (nobody may call them directly) ----------------------------------------------------------------
create or replace function public._r29_cfg()
returns public.referral_settings language sql stable security definer set search_path = '' as $$
  select s from public.referral_settings s where s.id;
$$;

-- salted sha256 of a normalised value
create or replace function public._r29_hash(p_kind text, p_value text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v text := btrim(coalesce(p_value, '')); l text; d text;
begin
  if v = '' then return null; end if;
  if p_kind = 'email' then
    v := lower(v); l := split_part(v, '@', 1); d := split_part(v, '@', 2);
    if d = '' then return null; end if;
    l := split_part(l, '+', 1);
    if d in ('gmail.com', 'googlemail.com') then l := replace(l, '.', ''); d := 'gmail.com'; end if;
    v := l || '@' || d;
  elsif p_kind = 'domain' then v := lower(v);
  elsif p_kind = 'phone' then v := right(regexp_replace(v, '[^0-9]', '', 'g'), 10); if length(v) < 8 then return null; end if;
  elsif p_kind in ('gstin', 'pan') then v := upper(regexp_replace(v, '\s', '', 'g'));
  else v := left(v, 200);
  end if;
  return encode(sha256(convert_to((select s.hash_salt from public.referral_settings s where s.id) || '|' || p_kind || '|' || v, 'UTF8')), 'hex');
end $$;

create or replace function public._r29_public_domain(p_domain text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(coalesce(p_domain, '')) ~ '^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|proton|protonmail|pm|rediffmail|rediff|aol|zoho|zohomail|gmx|mail|yandex|hey|fastmail)\.'
$$;

create or replace function public._r29_disposable(p_domain text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(coalesce(p_domain, '')) ~ '(^|\.)(mailinator|guerrillamail|guerrillamailblock|sharklasers|10minutemail|tempmail|temp-mail|tempmailo|yopmail|trashmail|getnada|dispostable|maildrop|throwawaymail|fakeinbox|mintemail|mohmal|emailondeck|mailnesia|spamgourmet|burnermail|tempr|discard)\.'
$$;

-- one hashed signal for a studio (kept once)
create or replace function public._r29_fp(p_studio uuid, p_kind text, p_value text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare h text;
begin
  if p_studio is null then return; end if;
  h := public._r29_hash(p_kind, p_value);
  if h is null then return; end if;
  insert into public.referral_fingerprints(studio_id, kind, hash) values (p_studio, p_kind, h)
  on conflict (studio_id, kind, hash) do nothing;
end $$;

-- refresh a studio's signals from what Helm already holds (admins' e-mails + company domain, contact phones, GSTIN / PAN)
create or replace function public._r29_fp_collect(p_studio uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare r record; d text;
begin
  if p_studio is null then return; end if;
  for r in select lower(btrim(p.email)) e from public.profiles p where p.org_id = p_studio and p.role = 'admin' and p.email is not null loop
    perform public._r29_fp(p_studio, 'email', r.e);
    d := split_part(r.e, '@', 2);
    if d <> '' and not public._r29_public_domain(d) then perform public._r29_fp(p_studio, 'domain', d); end if;
  end loop;
  for r in select a.primary_contact_phone p1, a.secondary_contact_phone p2, a.gstin g, a.pan pn, a.primary_contact_email e1
             from public.studio_account a where a.org_id = p_studio loop
    perform public._r29_fp(p_studio, 'phone', r.p1);
    perform public._r29_fp(p_studio, 'phone', r.p2);
    perform public._r29_fp(p_studio, 'gstin', r.g);
    if r.g is not null and length(r.g) = 15 then perform public._r29_fp(p_studio, 'pan', substr(r.g, 3, 10)); end if;
    perform public._r29_fp(p_studio, 'pan', r.pn);
    perform public._r29_fp(p_studio, 'email', r.e1);
  end loop;
  for r in select o.gst_number g from public.organizations o where o.id = p_studio and o.gst_number is not null loop
    if r.g ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      perform public._r29_fp(p_studio, 'gstin', r.g); perform public._r29_fp(p_studio, 'pan', substr(r.g, 3, 10));
    end if;
  end loop;
end $$;

-- the fraud check for one referral: plain-words flags + a score + what to do (the same rules as referral-rules.js)
create or replace function public._r29_signals(p_referral uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.referrals; c public.referral_codes; v_other uuid; v_flags jsonb := '[]'::jsonb; v_score int := 0; v_hard boolean := false;
  v_n int; s public.referral_settings := public._r29_cfg();
begin
  select * into r from public.referrals where id = p_referral;
  if r.id is null then return null; end if;
  select * into c from public.referral_codes where code = r.code;
  v_other := case when r.kind = 'studio' then c.studio_id else c.partner_studio end;
  if v_other is not null and r.referred_org is not null then
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind = 'email') then
      v_flags := v_flags || '["Same e-mail address"]'::jsonb; v_hard := true; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind = 'domain') then
      v_flags := v_flags || '["Same company e-mail domain"]'::jsonb; v_score := v_score + 2; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind in ('card', 'upi')) then
      v_flags := v_flags || '["Same payment card or UPI"]'::jsonb; v_hard := true; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind = 'device') then
      v_flags := v_flags || '["Same device"]'::jsonb; v_score := v_score + 2; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind = 'ip') then
      v_flags := v_flags || '["Same internet address"]'::jsonb; v_score := v_score + 1; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind = 'phone') then
      v_flags := v_flags || '["Same phone number"]'::jsonb; v_hard := true; end if;
    if exists (select 1 from public.referral_fingerprints a join public.referral_fingerprints b on b.kind = a.kind and b.hash = a.hash
                where a.studio_id = r.referred_org and b.studio_id = v_other and a.kind in ('gstin', 'pan')) then
      v_flags := v_flags || '["Same GSTIN / PAN"]'::jsonb; v_hard := true; end if;
  end if;
  select count(*) into v_n from public.referrals x
   where x.code = r.code and x.signed_up_at > r.signed_up_at - interval '24 hours' and x.signed_up_at <= r.signed_up_at;
  if v_n > s.velocity_per_day then
    v_flags := v_flags || jsonb_build_array('Many sign-ups on this code in 24 hours (' || v_n || ')'); v_score := v_score + 1; end if;
  if exists (select 1 from public.profiles p where p.org_id = r.referred_org and p.role = 'admin'
               and public._r29_disposable(split_part(lower(coalesce(p.email, '')), '@', 2))) then
    v_flags := v_flags || '["Throw-away e-mail service"]'::jsonb; v_score := v_score + 2; end if;
  return jsonb_build_object('flags', v_flags, 'score', case when v_hard then 9 else v_score end, 'hard', v_hard,
    'action', case when v_hard or v_score >= 3 then 'reject' when v_score >= 1 then 'review' else 'auto' end);
end $$;

-- is the studio a paying studio right now (an active / past-due plan with a real payment that is not voided)
create or replace function public._r29_paying(p_studio uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.studio_subscriptions s where s.org_id = p_studio and s.status in ('active', 'past_due'))
     and exists (select 1 from public.subscription_payments sp where sp.org_id = p_studio and sp.voided_at is null and sp.amount > 0);
$$;

-- what one free month is worth for this studio NOW (its own plan + billing currency; Enterprise = one Studio month)
create or replace function public._r29_value(p_studio uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_code text; v_int text; v_cur text; v_m numeric; v_y numeric; v_usd numeric; v_plan uuid;
begin
  select hp.code, s.billing_interval into v_code, v_int
    from public.studio_subscriptions s left join public.helm_plans hp on hp.id = s.plan_id where s.org_id = p_studio;
  if v_code is null or v_code not in ('starter', 'studio') then v_code := 'studio'; end if;
  v_int := coalesce(v_int, 'monthly');
  v_cur := coalesce(public._checkout_currency(p_studio), 'INR');
  select hp.id into v_plan from public.helm_plans hp where hp.code = v_code;
  select pp.price_monthly, pp.price_yearly into v_m, v_y from public.helm_plan_prices pp where pp.plan_id = v_plan and pp.currency = v_cur;
  if v_m is null then select hp.price_monthly, hp.currency into v_m, v_cur from public.helm_plans hp where hp.id = v_plan; end if;
  select pp.price_monthly into v_usd from public.helm_plan_prices pp where pp.plan_id = v_plan and pp.currency = 'USD';
  v_usd := coalesce(v_usd, case v_code when 'starter' then 24 else 59 end);
  return jsonb_build_object('plan_code', v_code, 'interval', v_int, 'currency', v_cur,
    'value_minor', round(coalesce(case when v_int = 'yearly' and v_y is not null then v_y / 12 else v_m end, 0) * 100)::bigint,
    'value_usd', v_usd);
end $$;

-- a bell notice for the studio's admins (the 0058 admin-only 'trial_reminder' kind, source r29_referral -> /refer) +
-- one queued e-mail (dormant). Once per dedupe key. Never blocks the caller.
create or replace function public._r29_notify(p_studio uuid, p_kind text, p_ref uuid, p_label text, p_key text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare n int := 0;
begin
  if p_studio is null then return; end if;
  begin
    insert into public.referral_notice_queue(studio_id, kind, ref_id, dedupe_key) values (p_studio, p_kind, p_ref, left(p_key, 200))
    on conflict (dedupe_key) do nothing;
    get diagnostics n = row_count;
  exception when others then n := 0; end;
  if n = 0 then return; end if;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (null, 'in_app', 'trial_reminder', 'simulated',
              jsonb_build_object('label', left(p_label, 160), 'source', 'r29_referral', 'path', 'refer.html', 'referral_kind', p_kind), p_studio);
  exception when others then null; end;
end $$;

-- one reward state change + its event row
create or replace function public._r29_set_state(p_reward uuid, p_state text, p_reason text, p_actor uuid default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_old text;
begin
  select state into v_old from public.referral_rewards where id = p_reward for update;
  if v_old is null or v_old = p_state then return; end if;
  update public.referral_rewards set state = p_state, state_reason = left(p_reason, 200), updated_at = now(),
         frozen_at = case when p_state = 'frozen' then now() else frozen_at end,
         flagged = flagged or p_state = 'written_off'
   where id = p_reward;
  insert into public.referral_reward_events(reward_id, from_state, to_state, reason, actor) values (p_reward, v_old, p_state, left(p_reason, 200), p_actor);
end $$;

create or replace function public._r29_add_reward(p_referral uuid, p_studio uuid, p_side text, p_kind text, p_state text,
  p_reason text, p_percent int default null, p_for int default null)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; s public.referral_settings := public._r29_cfg();
begin
  insert into public.referral_rewards(referral_id, studio_id, side, kind, percent, for_months, state, state_reason, earned_at,
                                      held_until, frozen_at, expires_at)
    values (p_referral, p_studio, p_side, p_kind, p_percent, p_for, p_state, left(p_reason, 200), now(),
            case when p_state = 'held' then now() + make_interval(months => s.held_months) end,
            case when p_state = 'frozen' then now() end,
            now() + make_interval(months => s.expiry_months))
    returning id into v_id;
  insert into public.referral_reward_events(reward_id, from_state, to_state, reason) values (v_id, null, p_state, left(p_reason, 200));
  return v_id;
end $$;

-- free months earned by this studio in the last 12 months (the cap counts every month that was earned, used or not)
create or replace function public._r29_earned_12m(p_studio uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.referral_rewards r
   where r.studio_id = p_studio and r.side in ('referrer', 'partner') and r.kind = 'month'
     and r.state in ('held', 'scheduled', 'applied', 'frozen', 'written_off', 'expired', 'forfeited')
     and r.earned_at > now() - interval '12 months';
$$;

-- a studio code (created once, on first need): the studio name in capitals (max 8) + '-' + 4 characters without look-alikes
create or replace function public._r29_studio_code(p_studio uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v text; b text; i int; j int; safe constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; t text;
begin
  select code into v from public.referral_codes where kind = 'studio' and studio_id = p_studio;
  if v is not null then return v; end if;
  select left(regexp_replace(upper(coalesce(o.name, '')), '[^A-Z0-9]', '', 'g'), 8) into b from public.organizations o where o.id = p_studio;
  if coalesce(b, '') = '' then b := 'HELM'; end if;
  if length(b) < 2 then b := b || 'HELM'; end if;
  for i in 1..20 loop
    t := '';
    for j in 1..4 loop t := t || substr(safe, 1 + floor(random() * length(safe))::int, 1); end loop;
    begin
      insert into public.referral_codes(code, kind, studio_id, offer_type, offer_months, partner_reward, created_by)
        values (b || '-' || t, 'studio', p_studio, 'months', 1, 'months', auth.uid());
      return b || '-' || t;
    exception when unique_violation then
      select code into v from public.referral_codes where kind = 'studio' and studio_id = p_studio;
      if v is not null then return v; end if;
    end;
  end loop;
  raise exception 'could not make a referral code - try again' using errcode = '40001';
end $$;

-- the label a referrer sees for a studio they referred: its name only with that studio's consent, else its city
create or replace function public._r29_label(p_referral uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when r.consent_name and o.name is not null then jsonb_build_object('label', o.name, 'masked', false, 'city', a.city)
              when coalesce(a.city, '') <> '' then jsonb_build_object('label', 'A studio in ' || a.city, 'masked', true, 'city', a.city)
              else jsonb_build_object('label', 'A studio', 'masked', true, 'city', null) end
    from public.referrals r left join public.organizations o on o.id = r.referred_org
    left join public.studio_account a on a.org_id = r.referred_org
   where r.id = p_referral;
$$;

-- the offer text the sign-up page shows (never who owns the code)
create or replace function public._r29_offer(c public.referral_codes)
returns text language sql immutable set search_path = '' as $$
  select case
    when c.kind = 'studio' then '1 free month after your first payment'
    when c.offer_type = 'months' and c.offer_months > 0 then c.offer_months || ' free month' || case when c.offer_months = 1 then '' else 's' end || ' after your first payment'
    when c.offer_type = 'percent' and c.offer_percent > 0 then c.offer_percent || '% off for ' || c.offer_for_months || ' month' || case when c.offer_for_months = 1 then '' else 's' end || ' after your first payment'
    else '' end;
$$;

-- can a code be used right now? '' = yes, else the reason (inactive / expired / full / off)
create or replace function public._r29_code_problem(c public.referral_codes)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if c.code is null then return 'unknown'; end if;
  if not (public._r29_cfg()).program_on then return 'off'; end if;
  if not c.active then return 'inactive'; end if;
  if c.kind = 'studio' and (c.studio_id is null or exists (select 1 from public.studio_subscriptions s where s.org_id = c.studio_id and s.status = 'suspended')) then
    return 'inactive'; end if;
  if c.ends_at is not null and c.ends_at < now() then return 'expired'; end if;
  if c.max_uses > 0 and c.uses >= c.max_uses then return 'full'; end if;
  return '';
end $$;

-- ---- 3) attach a code to a NEW studio (sign-up / support) -------------------------------------------------------------
create or replace function public._r29_attach(p_org uuid, p_code text, p_via text, p_consent boolean, p_device text,
  p_link_at timestamptz, p_actor uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare c public.referral_codes; v_prob text; v_id uuid; v_sig jsonb; v_status text; v_reason text; v_ref uuid; v_sub text;
  v_ip text := public._hq27_client_ip(); v_existing boolean := false;
begin
  if exists (select 1 from public.referrals r where r.referred_org = p_org) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate'); end if;
  select * into c from public.referral_codes where code = p_code for update;
  if c.code is null then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  v_prob := public._r29_code_problem(c);
  if v_prob <> '' then return jsonb_build_object('ok', false, 'reason', v_prob); end if;
  v_ref := case when c.kind = 'studio' then c.studio_id else c.partner_studio end;
  if v_ref = p_org then return jsonb_build_object('ok', false, 'reason', 'self_referral'); end if;
  if exists (select 1 from public.organizations o where o.id = p_org and coalesce(o.is_sample_master, false)) then
    return jsonb_build_object('ok', false, 'reason', 'existing'); end if;
  -- an existing / earlier customer: already paid Helm, or the creator had another Helm free trial in the last 12 months
  v_existing := exists (select 1 from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null and sp.amount > 0)
    or exists (select 1 from public.trial_grants g join public.organizations o on o.id = p_org join auth.users u on u.id = o.created_by
                where g.org_id <> p_org and g.started_at > now() - interval '12 months'
                  and g.email_hash = public._trial_email_fingerprint(u.email));
  select s.status into v_sub from public.studio_subscriptions s where s.org_id = p_org;
  insert into public.referrals(code, kind, referrer_org, referred_org, via, consent_name, link_clicked_at, signed_up_at, status, created_by,
                               plan_started_at)
    values (c.code, c.kind, v_ref, p_org, p_via, coalesce(p_consent, false), case when p_via = 'link' then p_link_at end,
            coalesce((select o.created_at from public.organizations o where o.id = p_org), now()),
            case when v_sub = 'trial' then 'trial' when v_sub in ('active', 'past_due') then 'first_month' else 'signed_up' end, p_actor,
            case when v_sub in ('active', 'past_due') then now() end)
    returning id into v_id;
  update public.referral_codes set uses = uses + 1 where code = c.code;
  -- hashed signals of both studios, then the check
  perform public._r29_fp_collect(p_org);
  if p_device is not null and p_device ~ '^[A-Za-z0-9_-]{8,64}$' then perform public._r29_fp(p_org, 'device', p_device); end if;
  if v_ip is not null and p_via <> 'support' then perform public._r29_fp(p_org, 'ip', v_ip); end if;
  if v_ref is not null then perform public._r29_fp_collect(v_ref); end if;
  v_sig := public._r29_signals(v_id);
  v_status := null; v_reason := null;
  if v_existing then v_status := 'not_qualified'; v_reason := 'existing';
  elsif v_sig ->> 'action' = 'reject' then v_status := 'not_qualified'; v_reason := 'self_referral';
  elsif v_sig ->> 'action' = 'review' then v_status := 'review';
  end if;
  update public.referrals set flags = coalesce(v_sig -> 'flags', '[]'::jsonb), score = coalesce((v_sig ->> 'score')::int, 0),
         status = coalesce(v_status, status), reason = v_reason, updated_at = now()
   where id = v_id;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (p_actor, (select u.email from auth.users u where u.id = p_actor), 'referral.attach', 'referrals', v_id::text,
            jsonb_build_object('code', c.code, 'kind', c.kind, 'via', p_via, 'check', v_sig ->> 'action', 'score', v_sig -> 'score'), p_org, now());
  if c.kind = 'studio' and coalesce(v_status, '') <> 'not_qualified' then
    perform public._r29_notify(v_ref, 'referral_signed_up', v_id, 'A studio signed up with your referral link', 'r29:signed:' || v_id::text);
  end if;
  -- the new studio keeps its trial either way; only the reward is refused
  return jsonb_build_object('ok', true, 'id', v_id, 'kind', case when c.kind = 'studio' then 'referral' else 'partner' end,
    'status', coalesce(v_status, (select r.status from public.referrals r where r.id = v_id)),
    'offer', case when coalesce(v_status, '') = 'not_qualified' then '' else public._r29_offer(c) end);
end $$;

-- the sign-up flow, once, right after the new studio is created: a typed code beats a link; a link counts for 60 days
create or replace function public.referral_attach(p_typed text default null, p_link text default null, p_link_at timestamptz default null,
  p_consent boolean default false, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v_org uuid := public.current_org_id(); s public.referral_settings := public._r29_cfg(); v_t text; v_l text; o record;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if public.is_platform_operator() then return jsonb_build_object('ok', false, 'reason', 'existing'); end if;
  if not s.program_on then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  -- r29c REF-02: at most 10 tries an hour per person (a sign-up attaches once; this stops code guessing)
  if not public._r29_rate('at:' || auth.uid()::text, 10) then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select x.created_at, x.created_by into o from public.organizations x where x.id = v_org;
  -- only the person who created the studio, and only while it is new (team members who join never attach a code)
  if o.created_by is distinct from auth.uid() or o.created_at < now() - make_interval(hours => s.self_attach_hours) then
    return jsonb_build_object('ok', false, 'reason', 'code_after'); end if;
  v_t := upper(btrim(coalesce(p_typed, ''))); v_l := upper(btrim(coalesce(p_link, '')));
  if v_t <> '' and v_t !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then v_t := ''; end if;
  if v_l <> '' and (v_l !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' or p_link_at is null or p_link_at < now() - make_interval(days => s.link_days)
                    or p_link_at > now() + interval '1 hour') then v_l := ''; end if;
  if v_t <> '' and exists (select 1 from public.referral_codes c where c.code = v_t) then
    return public._r29_attach(v_org, v_t, 'typed', p_consent, left(p_device, 64), null, auth.uid());
  end if;
  if v_l <> '' then return public._r29_attach(v_org, v_l, 'link', p_consent, left(p_device, 64), p_link_at, auth.uid()); end if;
  return jsonb_build_object('ok', false, 'reason', case when v_t <> '' or btrim(coalesce(p_typed, '')) <> '' then 'unknown' else 'none' end);
end $$;

-- public: is this code usable, and what does it offer? (rate-limited; never says who owns it)
create or replace function public._r29_rate(p_bucket text, p_max int)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_n int;
begin
  insert into public.referral_rate_buckets(bucket, n, window_start) values (left(p_bucket, 120), 1, now())
  on conflict (bucket) do update set
    n = case when public.referral_rate_buckets.window_start < now() - interval '1 hour' then 1 else public.referral_rate_buckets.n + 1 end,
    window_start = case when public.referral_rate_buckets.window_start < now() - interval '1 hour' then now() else public.referral_rate_buckets.window_start end
  returning n into v_n;
  return v_n <= p_max;
end $$;

create or replace function public.referral_lookup(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v text := upper(btrim(coalesce(p_code, ''))); c public.referral_codes; v_prob text;
  v_net text := coalesce(public._r29_hash('ip', public._hq27_client_ip()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', false, 'reason', 'shape'); end if;
  -- r29c REF-03: per network only - a shared "everyone" counter let one sender block the look-up for all visitors
  if not public._r29_rate('lk:' || left(v_net, 32), 60) then
    return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select * into c from public.referral_codes where code = v;
  v_prob := public._r29_code_problem(c);
  if v_prob <> '' then return jsonb_build_object('ok', false, 'reason', v_prob); end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', case when c.kind = 'studio' then 'referral' else 'partner' end,
    'offer', public._r29_offer(c), 'offer_type', c.offer_type, 'months', c.offer_months, 'percent', c.offer_percent,
    'for_months', c.offer_for_months, 'ends_at', c.ends_at, 'terms', c.terms);
end $$;

-- public: count one click on a link (a number per code per day; nothing about the person)
create or replace function public.referral_click(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v text := upper(btrim(coalesce(p_code, ''))); v_net text := coalesce(public._r29_hash('ip', public._hq27_client_ip()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' or not exists (select 1 from public.referral_codes c where c.code = v) then
    return jsonb_build_object('ok', false); end if;
  if not public._r29_rate('ck:' || left(v_net, 32) || ':' || v, 3) or not public._r29_rate('ck:all', 20000) then
    return jsonb_build_object('ok', true); end if;
  insert into public.referral_click_days(code, day, clicks) values (v, (now() at time zone 'Asia/Kolkata')::date, 1)
  on conflict (code, day) do update set clicks = public.referral_click_days.clicks + 1;
  return jsonb_build_object('ok', true);
end $$;

-- ---- 4) the money events: first real payment, refund / chargeback (void), cancellation ---------------------------------
create or replace function public._r29_on_payment(p_org uuid, p_payment uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare r public.referrals; v_sig jsonb; s public.referral_settings := public._r29_cfg(); w record;
begin
  -- 1) this studio was referred: its first real payment starts the 14-day hold (checked again for fraud)
  select * into r from public.referrals where referred_org = p_org for update;
  if r.id is not null and r.first_paid_at is null and r.status in ('signed_up', 'trial', 'first_month', 'review') then
    perform public._r29_fp_collect(p_org);
    if r.referrer_org is not null then perform public._r29_fp_collect(r.referrer_org); end if;
    v_sig := public._r29_signals(r.id);
    update public.referrals set first_paid_at = now(), first_payment_id = p_payment,
           hold_until = now() + make_interval(days => s.hold_days),
           plan_started_at = coalesce(plan_started_at, now()),
           flags = coalesce(v_sig -> 'flags', flags), score = coalesce((v_sig ->> 'score')::int, score),
           status = case
             when r.signed_up_at < now() - make_interval(days => s.pay_within_days) then 'not_qualified'
             when v_sig ->> 'action' = 'reject' then 'not_qualified'
             when not r.approved and (r.status = 'review' or v_sig ->> 'action' = 'review') then 'review'
             else 'hold' end,
           reason = case
             when r.signed_up_at < now() - make_interval(days => s.pay_within_days) then 'no_payment'
             when v_sig ->> 'action' = 'reject' then 'self_referral' end,
           updated_at = now()
     where id = r.id;
  end if;
  -- 2) this studio is a referrer / partner that now pays: its held months start counting
  for w in select x.id from public.referral_rewards x where x.studio_id = p_org and x.state = 'held' loop
    perform public._r29_set_state(w.id, 'scheduled', 'the studio started paying');
  end loop;
end $$;

-- a reward that is taken back: unused -> reversed; already used -> written off (never charged) + flagged for HQ
create or replace function public._r29_reverse(p_referral uuid, p_reason text, p_actor uuid default null)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare w record; n int := 0;
begin
  for w in select x.id, x.state from public.referral_rewards x where x.referral_id = p_referral
             and x.state in ('held', 'scheduled', 'frozen', 'capped', 'applied') loop
    perform public._r29_set_state(w.id, case when w.state = 'applied' then 'written_off' else 'reversed' end, p_reason, p_actor);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public._r29_on_void(p_org uuid, p_payment uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare r public.referrals;
begin
  select * into r from public.referrals where referred_org = p_org and first_payment_id = p_payment for update;
  if r.id is null then return; end if;
  if r.status in ('hold', 'review', 'qualified') then
    update public.referrals set status = 'not_qualified', reason = 'refunded', updated_at = now() where id = r.id;
    perform public._r29_reverse(r.id, 'the new studio''s first payment was refunded or disputed');
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), null, 'referral.reversed', 'referrals', r.id::text,
              jsonb_build_object('reason', 'refunded', 'was', r.status), p_org, now());
  end if;
end $$;

create or replace function public.tg_r29_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r29-referrals-0279: never blocks a payment - a referral error is logged, the payment always goes through
begin
  begin
    if tg_op = 'INSERT' then
      if new.amount > 0 and new.voided_at is null then perform public._r29_on_payment(new.org_id, new.id); end if;
    elsif old.voided_at is null and new.voided_at is not null then
      perform public._r29_on_void(new.org_id, new.id);
    end if;
  exception when others then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'referral.error', 'subscription_payments', new.id::text,
              jsonb_build_object('step', tg_op, 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
  end;
  return null;
end $$;
drop trigger if exists r29_payment on public.subscription_payments;
create trigger r29_payment after insert or update of voided_at on public.subscription_payments
  for each row execute function public.tg_r29_payment();

create or replace function public.tg_r29_subscription()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r29-referrals-0279: cancellation / return; never blocks the subscription change
declare w record; s public.referral_settings;
begin
  if new.status is not distinct from old.status then return null; end if;
  begin
    s := public._r29_cfg();
    -- the referred studio
    if new.status = 'cancelled' then
      update public.referrals set status = 'not_qualified', reason = 'cancelled', updated_at = now()
       where referred_org = new.org_id and status in ('signed_up', 'trial', 'first_month', 'hold', 'review');
    elsif new.status in ('active', 'past_due') then
      update public.referrals set status = 'first_month', plan_started_at = coalesce(plan_started_at, now()), updated_at = now()
       where referred_org = new.org_id and status in ('signed_up', 'trial') and first_paid_at is null;
    end if;
    -- the referrer / partner studio
    if new.status = 'cancelled' then
      for w in select x.id from public.referral_rewards x where x.studio_id = new.org_id and x.state in ('held', 'scheduled') loop
        perform public._r29_set_state(w.id, 'frozen', 'the studio cancelled its plan');
      end loop;
    elsif old.status = 'cancelled' and new.status in ('active', 'past_due') then
      for w in select x.id from public.referral_rewards x where x.studio_id = new.org_id and x.state = 'frozen'
                 and x.frozen_at > now() - make_interval(months => s.frozen_months) loop
        perform public._r29_set_state(w.id, 'scheduled', 'the studio came back');
      end loop;
    end if;
  exception when others then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'referral.error', 'studio_subscriptions', new.org_id::text,
              jsonb_build_object('step', 'status', 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
  end;
  return null;
end $$;
drop trigger if exists r29_subscription on public.studio_subscriptions;
create trigger r29_subscription after update of status on public.studio_subscriptions
  for each row execute function public.tg_r29_subscription();

-- ---- 5) confirm a referral (after the hold) and use free months ------------------------------------------------------
create or replace function public._r29_qualify(p_referral uuid, p_actor uuid default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare r public.referrals; c public.referral_codes; s public.referral_settings := public._r29_cfg(); v_sub text; v_to uuid;
  v_state text; i int; v_cap boolean;
begin
  select * into r from public.referrals where id = p_referral for update;
  if r.id is null or r.status <> 'hold' then return 'skipped'; end if;
  if r.hold_until is null or r.hold_until > now() then return 'waiting'; end if;
  if r.first_payment_id is null or exists (select 1 from public.subscription_payments sp where sp.id = r.first_payment_id and sp.voided_at is not null) then
    update public.referrals set status = 'not_qualified', reason = 'refunded', updated_at = now() where id = r.id;
    return 'refunded'; end if;
  select st.status into v_sub from public.studio_subscriptions st where st.org_id = r.referred_org;
  if v_sub = 'cancelled' then
    update public.referrals set status = 'not_qualified', reason = 'cancelled', updated_at = now() where id = r.id;
    return 'cancelled'; end if;
  select * into c from public.referral_codes where code = r.code;
  update public.referrals set status = 'qualified', qualified_at = now(), updated_at = now() where id = r.id;
  -- the new studio's offer (studio code: 1 month; partner code: its own offer)
  if r.referred_org is not null then
    if c.kind = 'studio' then
      perform public._r29_add_reward(r.id, r.referred_org, 'referred', 'month', 'scheduled', 'welcome month (referred by a studio)');
    elsif c.offer_type = 'months' and c.offer_months > 0 then
      for i in 1..c.offer_months loop
        perform public._r29_add_reward(r.id, r.referred_org, 'referred', 'month', 'scheduled', 'partner offer ' || c.code);
      end loop;
    elsif c.offer_type = 'percent' and c.offer_percent > 0 then
      perform public._r29_add_reward(r.id, r.referred_org, 'referred', 'discount', 'scheduled', 'partner offer ' || c.code,
                                     c.offer_percent, greatest(1, c.offer_for_months));
    end if;
    perform public._r29_notify(r.referred_org, 'welcome_month', r.id, 'Your welcome offer from Helm is confirmed', 'r29:welcome:' || r.id::text);
  end if;
  -- the referrer (studio code) / the partner studio (partner code with "1 free month per paying studio")
  v_to := case when c.kind = 'studio' then c.studio_id when c.partner_reward = 'months' then c.partner_studio end;
  if v_to is not null then
    perform pg_advisory_xact_lock(hashtext('r29_cap:' || v_to::text));
    v_cap := public._r29_earned_12m(v_to) >= s.cap_per_year;
    v_state := case when v_cap then 'capped'
                    when exists (select 1 from public.studio_subscriptions st where st.org_id = v_to and st.status = 'suspended') then 'held'
                    when exists (select 1 from public.studio_subscriptions st where st.org_id = v_to and st.status = 'cancelled') then 'frozen'
                    when public._r29_paying(v_to) then 'scheduled'
                    else 'held' end;
    perform public._r29_add_reward(r.id, v_to, case when c.kind = 'studio' then 'referrer' else 'partner' end, 'month', v_state,
      case v_state when 'capped' then 'cap reached (' || s.cap_per_year || ' in 12 months)'
                   when 'held' then 'waiting for the studio''s first payment'
                   when 'frozen' then 'the studio''s plan is cancelled' else 'earned' end);
    perform public._r29_notify(v_to, 'referral_qualified', r.id,
      case when v_cap then 'A studio you referred became a paying customer (free-month limit reached)'
           when v_state = 'held' then 'You earned a free month - it starts after your first payment'
           else 'You earned a free month of Helm' end, 'r29:qualified:' || r.id::text);
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (p_actor, (select u.email from auth.users u where u.id = p_actor), 'referral.qualified', 'referrals', r.id::text,
            jsonb_build_object('code', r.code, 'referrer', v_to), r.referred_org, now());
  return 'qualified';
end $$;

-- use this studio's scheduled free months: monthly -> when the renewal is due (within apply_days_before days),
-- yearly -> at once; each one moves current_period_end one month later. Returns how many were used.
create or replace function public._r29_apply(p_studio uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare sub public.studio_subscriptions; s public.referral_settings := public._r29_cfg(); w record; v_old date; v_new date; v jsonb; n int := 0;
begin
  select * into sub from public.studio_subscriptions where org_id = p_studio for update;
  if sub.org_id is null or sub.status not in ('active', 'past_due') or sub.current_period_end is null then return 0; end if;
  if not exists (select 1 from public.subscription_payments sp where sp.org_id = p_studio and sp.voided_at is null and sp.amount > 0) then return 0; end if;
  for w in select x.id from public.referral_rewards x where x.studio_id = p_studio and x.state = 'scheduled' and x.kind = 'month'
            order by x.earned_at, x.id for update loop
    if not (coalesce(sub.billing_interval, 'monthly') = 'yearly' or sub.current_period_end <= current_date + s.apply_days_before) then exit; end if;
    v_old := sub.current_period_end; v_new := (v_old + interval '1 month')::date;
    v := public._r29_value(p_studio);
    update public.studio_subscriptions set current_period_end = v_new,
           status = case when status = 'past_due' and v_new >= current_date then 'active' else status end, updated_at = now()
     where org_id = p_studio;
    update public.referral_rewards set applied_at = now(), applied_from = v_old + 1, applied_to = v_new,
           plan_code = v ->> 'plan_code', billing_interval = v ->> 'interval', currency = v ->> 'currency',
           value_minor = (v ->> 'value_minor')::bigint, value_usd = (v ->> 'value_usd')::numeric
     where id = w.id;
    perform public._r29_set_state(w.id, 'applied', case when coalesce(sub.billing_interval, 'monthly') = 'yearly'
                                    then 'renewal moved one month later' else 'renewal billed 0' end);
    -- a "renews soon" reminder for the renewal that just became free is kept, not sent
    update public.billing_reminders set sent_at = now(), channel = 'skipped'
     where org_id = p_studio and kind = 'due_soon' and period_end = v_old and sent_at is null;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'referral.reward.applied', 'studio_subscriptions', p_studio::text,
              jsonb_build_object('reward', w.id, 'period_end_was', v_old, 'period_end', v_new, 'interval', sub.billing_interval), null, now());
    perform public._r29_notify(p_studio, 'reward_applied', w.id,
      'Free month used: your next Helm renewal is now ' || to_char(v_new + 1, 'DD/MM/YYYY'), 'r29:applied:' || w.id::text);
    sub.current_period_end := v_new;
    if sub.status = 'past_due' and v_new >= current_date then sub.status := 'active'; end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- the daily job (pg_cron via SCHEDULE-0279.sql / service role / HQ "Run now")
create or replace function public.referral_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare s public.referral_settings := public._r29_cfg(); r record; v text; n_q int := 0; n_np int := 0; n_x int := 0; n_a int := 0; n_e int := 0; n int;
  n_rb int := 0;
begin
  -- 0) r29c REF-03: expired rate-limit counters (hour windows, nothing about a person) are cleared after 2 hours
  delete from public.referral_rate_buckets where window_start < now() - interval '2 hours';
  get diagnostics n_rb = row_count;
  -- 1) holds that are over -> confirmed (or refunded / cancelled)
  for r in select x.id from public.referrals x where x.status = 'hold' and x.hold_until <= now() order by x.hold_until limit 2000 loop
    begin v := public._r29_qualify(r.id); if v = 'qualified' then n_q := n_q + 1; end if;
    exception when others then n_e := n_e + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (null, null, 'referral.error', 'referrals', r.id::text, jsonb_build_object('step', 'qualify', 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
    end;
  end loop;
  -- 2) never paid within the window
  update public.referrals set status = 'not_qualified', reason = 'no_payment', updated_at = now()
   where status in ('signed_up', 'trial', 'first_month', 'review') and first_paid_at is null
     and signed_up_at < now() - make_interval(days => s.pay_within_days);
  get diagnostics n_np = row_count;
  -- 3) a plan started without a payment yet -> "paid plan, free month"
  update public.referrals x set status = 'first_month', plan_started_at = coalesce(x.plan_started_at, now()), updated_at = now()
   where x.status in ('signed_up', 'trial') and x.first_paid_at is null
     and exists (select 1 from public.studio_subscriptions st where st.org_id = x.referred_org and st.status in ('active', 'past_due'));
  -- 4) held: the studio pays now -> scheduled; waited too long -> expired
  for r in select x.id, x.studio_id, x.held_until from public.referral_rewards x where x.state = 'held' loop
    if public._r29_paying(r.studio_id) then perform public._r29_set_state(r.id, 'scheduled', 'the studio started paying');
    elsif r.held_until is not null and r.held_until < now() then perform public._r29_set_state(r.id, 'expired', 'no payment within the held time'); n_x := n_x + 1;
    end if;
  end loop;
  -- 5) frozen too long / unused for 24 months -> expired
  for r in select x.id from public.referral_rewards x where x.state = 'frozen' and x.frozen_at < now() - make_interval(months => s.frozen_months) loop
    perform public._r29_set_state(r.id, 'expired', 'the studio did not come back in time'); n_x := n_x + 1;
  end loop;
  for r in select x.id from public.referral_rewards x where x.state in ('held', 'scheduled', 'frozen') and x.expires_at < now() loop
    perform public._r29_set_state(r.id, 'expired', 'unused for ' || s.expiry_months || ' months'); n_x := n_x + 1;
  end loop;
  -- 6) use free months that are due
  for r in select distinct x.studio_id from public.referral_rewards x where x.state = 'scheduled' and x.kind = 'month' and x.studio_id is not null loop
    begin n := public._r29_apply(r.studio_id); n_a := n_a + n;
    exception when others then n_e := n_e + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
        values (null, null, 'referral.error', 'studio_subscriptions', r.studio_id::text, jsonb_build_object('step', 'apply', 'error', left(sqlstate || ' ' || sqlerrm, 300)), null, now());
    end;
  end loop;
  return jsonb_build_object('qualified', n_q, 'not_paid', n_np, 'expired', n_x, 'applied', n_a, 'errors', n_e,
                            'rate_buckets_cleared', n_rb, 'at', now());
end $$;

-- ---- 6) the studio page (owner / admin only) ----------------------------------------------------------------------------
create or replace function public.my_referral(p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v_org uuid := public.current_org_id(); s public.referral_settings := public._r29_cfg(); v_code text; sub record;
  v_ip text := public._hq27_client_ip();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not s.program_on then return jsonb_build_object('program_on', false); end if;
  v_code := public._r29_studio_code(v_org);
  -- the referrer's own signals (hashed), so a self-referral from this browser / network is spotted
  if p_device is not null and p_device ~ '^[A-Za-z0-9_-]{8,64}$' then perform public._r29_fp(v_org, 'device', p_device); end if;
  if v_ip is not null then perform public._r29_fp(v_org, 'ip', v_ip); end if;
  select st.status, st.billing_interval, st.current_period_end, hp.code plan_code into sub
    from public.studio_subscriptions st left join public.helm_plans hp on hp.id = st.plan_id where st.org_id = v_org;
  return jsonb_build_object(
    'program_on', true, 'code', v_code, 'link_path', '/r/' || v_code,
    'studio', (select o.name from public.organizations o where o.id = v_org),
    'subscription', jsonb_build_object('status', sub.status, 'interval', sub.billing_interval, 'plan_code', sub.plan_code,
                                       'current_period_end', sub.current_period_end, 'paying', public._r29_paying(v_org)),
    'rules', jsonb_build_object('hold_days', s.hold_days, 'pay_within_days', s.pay_within_days, 'link_days', s.link_days,
      'late_code_days', s.late_code_days, 'cap_per_year', s.cap_per_year, 'held_months', s.held_months,
      'frozen_months', s.frozen_months, 'expiry_months', s.expiry_months),
    'clicks', coalesce((select sum(d.clicks) from public.referral_click_days d where d.code = v_code), 0),
    'earned_12m', public._r29_earned_12m(v_org),
    'referrals', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason,
          'signed_up_at', r.signed_up_at, 'first_paid_at', r.first_paid_at, 'hold_until', r.hold_until, 'qualified_at', r.qualified_at,
          'reward_state', (select x.state from public.referral_rewards x where x.referral_id = r.id and x.studio_id = v_org
                            and x.side in ('referrer', 'partner') order by x.created_at desc limit 1))
          || public._r29_label(r.id) order by r.signed_up_at desc)
        from public.referrals r where r.referrer_org = v_org), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'side', x.side, 'kind', x.kind, 'state', x.state,
          'earned_at', x.earned_at, 'applied_at', x.applied_at, 'applied_from', x.applied_from, 'applied_to', x.applied_to,
          'expires_at', x.expires_at, 'held_until', x.held_until, 'percent', x.percent, 'for_months', x.for_months,
          'from', case when x.side = 'referred' then 'Welcome offer'
                       else coalesce((public._r29_label(x.referral_id)) ->> 'label', 'A studio') end)
          order by x.earned_at, x.id)
        from public.referral_rewards x where x.studio_id = v_org), '[]'::jsonb));
end $$;

-- ---- 7) Helm HQ (staff roles from 0277; every call audited) -------------------------------------------------------------
-- p_perms: the first permission the caller's role has is used (e.g. billing.read OR inbox.read); none -> the HQ_ROLE refusal
create or replace function public._r29_hq(p_perms text[], p_write boolean, p_name text, p_entity_id text default null, p_changed jsonb default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare me public.platform_admins; v_perms text[]; v_perm text;
begin
  if not public.is_platform_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into me from public._hq27_me();
  v_perms := public._hq27_role_perms(me.role);
  select p into v_perm from unnest(p_perms) p where '*' = any (v_perms) or p = any (v_perms) limit 1;
  perform public._hq27_require(coalesce(v_perm, p_perms[1]), p_write);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, case when p_write then p_name else 'hq.view' end, case when p_write then 'referrals' else p_name end,
           p_entity_id, p_changed, null, now()
      from auth.users u where u.id = auth.uid();
end $$;

create or replace function public._r29_mask_email(p text)
returns text language sql immutable set search_path = '' as $$
  select case when coalesce(p, '') !~ '@' then null
              else left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2) end;
$$;

create or replace function public.hq_referral_overview()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare s public.referral_settings;
begin
  perform public._r29_hq(array['billing.read', 'inbox.read'], false, 'hq_referral_overview');
  s := public._r29_cfg();
  return jsonb_build_object(
    'settings', to_jsonb(s) - 'hash_salt',
    'signups', (select count(*) from public.referrals),
    'signups_90d', (select count(*) from public.referrals where signed_up_at > now() - interval '90 days'),
    'studio_signups', (select count(*) from public.referrals where kind = 'studio'),
    'partner_signups', (select count(*) from public.referrals where kind = 'partner'),
    'paid', (select count(*) from public.referrals where first_paid_at is not null and status <> 'not_qualified'),
    'qualified', (select count(*) from public.referrals where status = 'qualified'),
    'partner_qualified', (select count(*) from public.referrals where status = 'qualified' and kind = 'partner'),
    'review', (select count(*) from public.referrals where status = 'review'),
    'hold', (select count(*) from public.referrals where status = 'hold'),
    'months_given', (select count(*) from public.referral_rewards where kind = 'month' and state in ('scheduled', 'applied')),
    'months_applied', (select count(*) from public.referral_rewards where kind = 'month' and state = 'applied'),
    'usd_applied', coalesce((select sum(value_usd) from public.referral_rewards where state in ('applied', 'written_off')), 0),
    'usd_upcoming', coalesce((select sum((public._r29_value(x.studio_id) ->> 'value_usd')::numeric) from public.referral_rewards x
                               where x.state = 'scheduled' and x.kind = 'month'), 0),
    'held_frozen', (select count(*) from public.referral_rewards where state in ('held', 'frozen')),
    'written_off', (select count(*) from public.referral_rewards where state = 'written_off'),
    'flagged', (select count(*) from public.referral_rewards where flagged),
    'partner_codes', (select count(*) from public.referral_codes where kind = 'partner'),
    'clicks_90d', coalesce((select sum(clicks) from public.referral_click_days where day > current_date - 90), 0));
end $$;

create or replace function public.hq_referrals(p_status text default null, p_q text default null, p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v_q text := lower(btrim(coalesce(p_q, '')));
begin
  perform public._r29_hq(array['billing.read', 'inbox.read'], false, 'hq_referrals');
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.signed_up_at desc) from (
    select r.id, r.code, r.kind, r.via, r.status, r.reason, r.flags, r.score, r.approved, r.consent_name,
           r.signed_up_at, r.plan_started_at, r.first_paid_at, r.hold_until, r.qualified_at, r.decided_at, r.decision_note,
           r.referrer_org, ro.name referrer_name,
           case when public._r29_paying(r.referrer_org) then 'paying' else coalesce(rs.status, 'none') end referrer_state,
           r.referred_org, nw.name referred_name, na.city referred_city,
           public._r29_mask_email((select p.email from public.profiles p where p.org_id = r.referred_org and p.role = 'admin'
                                    order by p.created_at limit 1)) referred_email,
           (select c.partner_name from public.referral_codes c where c.code = r.code) partner_name,
           (select jsonb_agg(jsonb_build_object('id', x.id, 'side', x.side, 'state', x.state, 'kind', x.kind) order by x.created_at)
              from public.referral_rewards x where x.referral_id = r.id) rewards
      from public.referrals r
      left join public.organizations ro on ro.id = r.referrer_org
      left join public.studio_subscriptions rs on rs.org_id = r.referrer_org
      left join public.organizations nw on nw.id = r.referred_org
      left join public.studio_account na on na.org_id = r.referred_org
     where (p_status is null or p_status = 'all' or r.status = p_status
            or (p_status = 'progress' and r.status in ('signed_up', 'trial', 'first_month')))
       and (v_q = '' or lower(coalesce(ro.name, '') || ' ' || coalesce(nw.name, '') || ' ' || r.code) like '%' || v_q || '%')
     order by r.signed_up_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(0, coalesce(p_offset, 0))) t), '[]'::jsonb);
end $$;

create or replace function public.hq_referral_rewards(p_state text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
begin
  perform public._r29_hq(array['billing.read', 'inbox.read'], false, 'hq_referral_rewards');
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc) from (
    select x.id, x.referral_id, x.studio_id, o.name studio_name, x.side, x.kind, x.percent, x.for_months, x.state, x.state_reason,
           x.earned_at, x.held_until, x.frozen_at, x.expires_at, x.applied_at, x.applied_from, x.applied_to, x.plan_code,
           x.billing_interval, x.currency, x.value_minor,
           coalesce(x.value_usd, (public._r29_value(x.studio_id) ->> 'value_usd')::numeric) value_usd, x.flagged, x.note, x.created_at,
           (select r.code from public.referrals r where r.id = x.referral_id) code
      from public.referral_rewards x left join public.organizations o on o.id = x.studio_id
     where p_state is null or p_state = 'all' or x.state = p_state or (p_state = 'flagged' and x.flagged)
     order by x.created_at desc limit 1000) t), '[]'::jsonb);
end $$;

create or replace function public.hq_referral_decide(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279: Approve / Reject a referral (review queue; reject also works on a confirmed one = fraud found later)
declare r public.referrals; v_res text := 'unchanged'; v_sub text;
begin
  perform public._r29_hq(array['billing.write'], true, case when p_approve then 'hq.referral.approve' else 'hq.referral.reject' end,
                         p_id::text, jsonb_build_object('note', left(p_note, 500)));
  select * into r from public.referrals where id = p_id for update;
  if r.id is null then raise exception 'unknown referral' using errcode = '22023'; end if;
  if p_approve then
    if r.status not in ('review', 'hold') then raise exception 'only a referral under review or on hold can be approved' using errcode = '22023'; end if;
    select st.status into v_sub from public.studio_subscriptions st where st.org_id = r.referred_org;
    update public.referrals set approved = true, decided_by = auth.uid(), decided_at = now(), decision_note = left(p_note, 500),
           status = case when r.first_paid_at is null then (case when v_sub = 'trial' then 'trial' when v_sub in ('active', 'past_due') then 'first_month' else 'signed_up' end)
                         else 'hold' end,
           updated_at = now()
     where id = r.id;
    v_res := 'approved';
    if r.first_paid_at is not null and r.hold_until <= now() then v_res := public._r29_qualify(r.id, auth.uid()); end if;
  else
    if r.status = 'not_qualified' then raise exception 'this referral is already not qualified' using errcode = '22023'; end if;
    update public.referrals set status = 'not_qualified', reason = 'fraud', approved = false, decided_by = auth.uid(), decided_at = now(),
           decision_note = left(p_note, 500), updated_at = now() where id = r.id;
    perform public._r29_reverse(r.id, 'rejected by Helm HQ', auth.uid());
    v_res := 'rejected';
  end if;
  return jsonb_build_object('result', v_res, 'status', (select x.status from public.referrals x where x.id = p_id));
end $$;

-- support: add a forgotten code (within 14 days of sign-up, before the first payment)
create or replace function public.hq_referral_attach(p_org uuid, p_code text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare s public.referral_settings; v text := upper(btrim(coalesce(p_code, ''))); v_created timestamptz;
begin
  perform public._r29_hq(array['billing.write', 'inbox.write'], true, 'hq.referral.attach', p_org::text,
                         jsonb_build_object('code', v, 'note', left(p_note, 300)));
  s := public._r29_cfg();
  select o.created_at into v_created from public.organizations o where o.id = p_org;
  if v_created is null then raise exception 'unknown studio' using errcode = '22023'; end if;
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if v_created < now() - make_interval(days => s.late_code_days) then return jsonb_build_object('ok', false, 'reason', 'code_after'); end if;
  if exists (select 1 from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null and sp.amount > 0) then
    return jsonb_build_object('ok', false, 'reason', 'code_after'); end if;
  return public._r29_attach(p_org, v, 'support', false, null, null, auth.uid());
end $$;

-- a reward by hand: forfeit (rule breaking), mark a % discount as given on the bill
create or replace function public.hq_referral_reward_action(p_id uuid, p_action text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare x public.referral_rewards;
begin
  perform public._r29_hq(array['billing.write'], true, 'hq.referral.reward.' || left(coalesce(p_action, ''), 20), p_id::text,
                         jsonb_build_object('note', left(p_note, 300)));
  select * into x from public.referral_rewards where id = p_id for update;
  if x.id is null then raise exception 'unknown reward' using errcode = '22023'; end if;
  if p_action = 'forfeit' then
    if x.state not in ('held', 'scheduled', 'frozen') then raise exception 'only an unused reward can be forfeited' using errcode = '22023'; end if;
    perform public._r29_set_state(x.id, 'forfeited', coalesce(nullif(left(p_note, 200), ''), 'forfeited by Helm HQ'), auth.uid());
  elsif p_action = 'mark_applied' then
    if x.kind <> 'discount' or x.state <> 'scheduled' then raise exception 'only a scheduled discount can be marked as given' using errcode = '22023'; end if;
    update public.referral_rewards set applied_at = now(), note = left(p_note, 300) where id = x.id;
    perform public._r29_set_state(x.id, 'applied', 'discount given on the bill by Helm HQ', auth.uid());
  elsif p_action = 'clear_flag' then
    update public.referral_rewards set flagged = false, note = coalesce(left(p_note, 300), note), updated_at = now() where id = x.id;
  else raise exception 'action must be forfeit, mark_applied or clear_flag' using errcode = '22023';
  end if;
  return (select to_jsonb(r) from public.referral_rewards r where r.id = p_id);
end $$;

-- partner / marketing codes ---------------------------------------------------------------------------------------------
create or replace function public.hq_partner_codes()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
begin
  perform public._r29_hq(array['billing.read', 'inbox.read'], false, 'hq_partner_codes');
  return coalesce((select jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc) from (
    select c.code, c.partner_name, c.partner_kind, c.partner_studio, (select o.name from public.organizations o where o.id = c.partner_studio) partner_studio_name,
           c.offer_type, c.offer_months, c.offer_percent, c.offer_for_months, c.partner_reward, c.max_uses, c.uses, c.ends_at,
           c.terms, c.notes, c.disclosure_ack, c.active, c.created_at, c.updated_at, public._r29_offer(c) offer,
           public._r29_code_problem(c) problem,
           coalesce((select sum(d.clicks) from public.referral_click_days d where d.code = c.code), 0) clicks,
           (select count(*) from public.referrals r where r.code = c.code) signups,
           (select count(*) from public.referrals r where r.code = c.code and r.first_paid_at is not null and r.status <> 'not_qualified') paid,
           (select count(*) from public.referrals r where r.code = c.code and r.status = 'qualified') qualified
      from public.referral_codes c where c.kind = 'partner') t), '[]'::jsonb);
end $$;

-- who signed up through one marketing link: studio name, sign-up date, status, paid yes / no. "share" = what may go to the
-- partner: counts only, plus the names of studios that agreed to be named
create or replace function public.hq_partner_signups(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v text := upper(btrim(coalesce(p_code, '')));
begin
  perform public._r29_hq(array['billing.read', 'inbox.read'], false, 'hq_partner_signups', v);
  if not exists (select 1 from public.referral_codes c where c.code = v and c.kind = 'partner') then
    raise exception 'unknown partner code' using errcode = '22023'; end if;
  return jsonb_build_object(
    'code', v,
    'signups', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'studio', o.name, 'signed_up_at', r.signed_up_at, 'status', r.status,
                 'reason', r.reason, 'paid', r.first_paid_at is not null and r.status <> 'not_qualified', 'consent_name', r.consent_name)
                 order by r.signed_up_at desc)
               from public.referrals r left join public.organizations o on o.id = r.referred_org where r.code = v), '[]'::jsonb),
    'share', jsonb_build_object(
      'signups', (select count(*) from public.referrals r where r.code = v),
      'paid', (select count(*) from public.referrals r where r.code = v and r.first_paid_at is not null and r.status <> 'not_qualified'),
      'qualified', (select count(*) from public.referrals r where r.code = v and r.status = 'qualified'),
      'clicks', coalesce((select sum(d.clicks) from public.referral_click_days d where d.code = v), 0),
      'named_studios', coalesce((select jsonb_agg(o.name order by r.signed_up_at) from public.referrals r join public.organizations o on o.id = r.referred_org
                                 where r.code = v and r.consent_name), '[]'::jsonb)));
end $$;

-- create / edit a marketing link. A blank code on create is made from the name (PRIYAINS-7K2Q).
create or replace function public.hq_partner_code_upsert(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v_code text := upper(btrim(coalesce(p ->> 'code', ''))); v_name text := btrim(coalesce(p ->> 'name', ''));
  v_kind text := lower(coalesce(nullif(p ->> 'kind', ''), 'campaign')); v_offer text := lower(coalesce(nullif(p ->> 'offer_type', ''), 'none'));
  v_m int := coalesce(nullif(p ->> 'offer_months', '')::int, 0); v_pct int := coalesce(nullif(p ->> 'offer_percent', '')::int, 0);
  v_for int := coalesce(nullif(p ->> 'offer_for_months', '')::int, 0); v_pr text := lower(coalesce(nullif(p ->> 'partner_reward', ''), 'tracking'));
  v_max int := coalesce(nullif(p ->> 'max_uses', '')::int, 0); v_end timestamptz; v_ps uuid; v_ack boolean := coalesce((p ->> 'disclosure_ack')::boolean, false);
  v_terms text := nullif(btrim(coalesce(p ->> 'terms', '')), ''); v_notes text := nullif(btrim(coalesce(p ->> 'notes', '')), '');
  v_exists public.referral_codes; v_base text; i int; j int; t text; safe constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
begin
  perform public._r29_hq(array['billing.write', 'inbox.write'], true, 'hq.referral.partner_code', nullif(v_code, ''), p - 'terms' - 'notes');
  if char_length(v_name) < 1 or char_length(v_name) > 80 then raise exception 'enter the partner or campaign name (up to 80 letters)' using errcode = '22023'; end if;
  if v_kind not in ('influencer', 'campaign', 'event', 'reseller', 'other') then raise exception 'type must be influencer, campaign, event, reseller or other' using errcode = '22023'; end if;
  if v_offer not in ('months', 'percent', 'none') then raise exception 'offer must be months, percent or none' using errcode = '22023'; end if;
  if v_offer = 'months' and v_m not between 1 and 3 then raise exception 'free months must be 1 to 3' using errcode = '22023'; end if;
  if v_offer = 'percent' and (v_pct not between 5 and 50 or v_for not between 1 and 12) then
    raise exception 'a discount is 5 to 50 percent for 1 to 12 months' using errcode = '22023'; end if;
  if v_pr not in ('none', 'tracking', 'months') then raise exception 'partner reward must be none, tracking or months (never cash)' using errcode = '22023'; end if;
  if v_max not between 0 and 100000 then raise exception 'most uses must be 0 to 100000' using errcode = '22023'; end if;
  if char_length(coalesce(v_terms, '')) > 1000 or char_length(coalesce(v_notes, '')) > 500 then raise exception 'terms up to 1000 letters, notes up to 500' using errcode = '22023'; end if;
  if v_kind = 'influencer' and not v_ack then
    raise exception 'an influencer code needs the partner''s promise to label every post as an ad (ASCI)' using errcode = '22023'; end if;
  if nullif(p ->> 'ends_on', '') is not null then
    if (p ->> 'ends_on') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'end date must be a date' using errcode = '22023'; end if;
    v_end := (((p ->> 'ends_on')::date + 1)::timestamp at time zone 'Asia/Kolkata') - interval '1 second';
  end if;
  if nullif(p ->> 'partner_studio', '') is not null then
    if (p ->> 'partner_studio') !~* '^[0-9a-f-]{36}$' or not exists (select 1 from public.organizations o where o.id = (p ->> 'partner_studio')::uuid) then
      raise exception 'the partner studio was not found' using errcode = '22023'; end if;
    v_ps := (p ->> 'partner_studio')::uuid;
  end if;
  if v_pr = 'months' and v_ps is null then raise exception 'free months for the partner need the partner''s Helm studio' using errcode = '22023'; end if;
  if v_code <> '' then select * into v_exists from public.referral_codes where code = v_code for update; end if;
  if v_exists.code is not null then
    if v_exists.kind <> 'partner' then raise exception 'that code is already taken' using errcode = '23505'; end if;
    update public.referral_codes set partner_name = v_name, partner_kind = v_kind, partner_studio = v_ps, offer_type = v_offer,
           offer_months = case when v_offer = 'months' then v_m else 0 end, offer_percent = case when v_offer = 'percent' then v_pct else 0 end,
           offer_for_months = case when v_offer = 'percent' then v_for else 0 end, partner_reward = v_pr, max_uses = v_max, ends_at = v_end,
           terms = v_terms, notes = v_notes, disclosure_ack = v_ack, active = coalesce((p ->> 'active')::boolean, active),
           updated_at = now(), updated_by = auth.uid()
     where code = v_code;
    return jsonb_build_object('result', 'updated', 'code', v_code);
  end if;
  if v_code <> '' and v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then raise exception 'a code is 3 to 24 letters, numbers, - or _' using errcode = '22023'; end if;
  if v_code = '' then
    v_base := left(regexp_replace(upper(v_name), '[^A-Z0-9]', '', 'g'), 8);
    if char_length(v_base) < 2 then v_base := 'HELM'; end if;
    for i in 1..20 loop
      t := ''; for j in 1..4 loop t := t || substr(safe, 1 + floor(random() * length(safe))::int, 1); end loop;
      if not exists (select 1 from public.referral_codes c where c.code = v_base || '-' || t) then v_code := v_base || '-' || t; exit; end if;
    end loop;
    if v_code = '' then raise exception 'could not make a code - try again' using errcode = '40001'; end if;
  end if;
  insert into public.referral_codes(code, kind, partner_name, partner_kind, partner_studio, offer_type, offer_months, offer_percent,
                                    offer_for_months, partner_reward, max_uses, ends_at, terms, notes, disclosure_ack, active, created_by, updated_by)
    values (v_code, 'partner', v_name, v_kind, v_ps, v_offer, case when v_offer = 'months' then v_m else 0 end,
            case when v_offer = 'percent' then v_pct else 0 end, case when v_offer = 'percent' then v_for else 0 end, v_pr, v_max, v_end,
            v_terms, v_notes, v_ack, coalesce((p ->> 'active')::boolean, true), auth.uid(), auth.uid());
  return jsonb_build_object('result', 'created', 'code', v_code);
exception when unique_violation then raise exception 'that code is already taken' using errcode = '23505';
end $$;

create or replace function public.hq_partner_code_set_active(p_code text, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
declare v text := upper(btrim(coalesce(p_code, '')));
begin
  perform public._r29_hq(array['billing.write', 'inbox.write'], true, case when p_active then 'hq.referral.code_on' else 'hq.referral.code_off' end, v);
  update public.referral_codes set active = coalesce(p_active, false), updated_at = now(), updated_by = auth.uid() where code = v and kind = 'partner';
  if not found then raise exception 'unknown partner code' using errcode = '22023'; end if;
  return jsonb_build_object('code', v, 'active', coalesce(p_active, false));
end $$;

-- a studio code can be switched off by HQ (abuse) - the studio keeps its earned months
create or replace function public.hq_studio_code_set_active(p_studio uuid, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
begin
  perform public._r29_hq(array['billing.write'], true, case when p_active then 'hq.referral.code_on' else 'hq.referral.code_off' end, p_studio::text);
  update public.referral_codes set active = coalesce(p_active, false), updated_at = now(), updated_by = auth.uid() where kind = 'studio' and studio_id = p_studio;
  return jsonb_build_object('studio', p_studio, 'active', coalesce(p_active, false), 'found', found);
end $$;

create or replace function public.hq_referral_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279: the program switch + its numbers (Owner / Admin: settings.write; fresh two-step code)
declare s public.referral_settings;
begin
  perform public._r29_hq(array['settings.write'], true, 'hq.referral.settings', null, p);
  s := public._r29_cfg();
  update public.referral_settings set
    program_on = coalesce((p ->> 'program_on')::boolean, s.program_on),
    hold_days = coalesce((p ->> 'hold_days')::int, s.hold_days),
    pay_within_days = coalesce((p ->> 'pay_within_days')::int, s.pay_within_days),
    link_days = coalesce((p ->> 'link_days')::int, s.link_days),
    late_code_days = coalesce((p ->> 'late_code_days')::int, s.late_code_days),
    cap_per_year = coalesce((p ->> 'cap_per_year')::int, s.cap_per_year),
    held_months = coalesce((p ->> 'held_months')::int, s.held_months),
    frozen_months = coalesce((p ->> 'frozen_months')::int, s.frozen_months),
    expiry_months = coalesce((p ->> 'expiry_months')::int, s.expiry_months),
    velocity_per_day = coalesce((p ->> 'velocity_per_day')::int, s.velocity_per_day),
    updated_at = now(), updated_by = auth.uid()
   where id;
  return to_jsonb(public._r29_cfg()) - 'hash_salt';
exception when check_violation then raise exception 'a value is outside its allowed range' using errcode = '22023';
end $$;

create or replace function public.hq_referral_run_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
begin
  perform public._r29_hq(array['billing.write'], true, 'hq.referral.tick');
  return public.referral_tick();
end $$;

-- the payment provider's card / UPI fingerprint for a studio (dormant webhook, service role only; stored hashed)
create or replace function public.referral_payment_fingerprint(p_org uuid, p_kind text, p_fingerprint text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_kind not in ('card', 'upi') then raise exception 'kind must be card or upi' using errcode = '22023'; end if;
  perform public._r29_fp(p_org, p_kind, left(p_fingerprint, 200));
end $$;

-- ---- 8) grants ----------------------------------------------------------------------------------------------------------
do $$
declare fn text;
begin
  -- signed-in callers (each checks the caller itself)
  foreach fn in array array['public.my_referral(text)', 'public.referral_attach(text,text,timestamptz,boolean,text)',
      'public.hq_referral_overview()', 'public.hq_referrals(text,text,integer,integer)', 'public.hq_referral_rewards(text)',
      'public.hq_referral_decide(uuid,boolean,text)', 'public.hq_referral_attach(uuid,text,text)',
      'public.hq_referral_reward_action(uuid,text,text)', 'public.hq_partner_codes()', 'public.hq_partner_signups(text)',
      'public.hq_partner_code_upsert(jsonb)', 'public.hq_partner_code_set_active(text,boolean)',
      'public.hq_studio_code_set_active(uuid,boolean)', 'public.hq_referral_settings_set(jsonb)', 'public.hq_referral_run_tick()'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  -- public (signed-out sign-up page): the look-up and the click counter only
  foreach fn in array array['public.referral_lookup(text)', 'public.referral_click(text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function ' || fn || ' to anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  -- internal only
  foreach fn in array array['public._r29_cfg()', 'public._r29_hash(text,text)', 'public._r29_public_domain(text)', 'public._r29_disposable(text)',
      'public._r29_fp(uuid,text,text)', 'public._r29_fp_collect(uuid)', 'public._r29_signals(uuid)', 'public._r29_paying(uuid)',
      'public._r29_value(uuid)', 'public._r29_notify(uuid,text,uuid,text,text)', 'public._r29_set_state(uuid,text,text,uuid)',
      'public._r29_add_reward(uuid,uuid,text,text,text,text,integer,integer)', 'public._r29_earned_12m(uuid)', 'public._r29_studio_code(uuid)',
      'public._r29_label(uuid)', 'public._r29_offer(public.referral_codes)', 'public._r29_code_problem(public.referral_codes)',
      'public._r29_attach(uuid,text,text,boolean,text,timestamptz,uuid)', 'public._r29_rate(text,integer)',
      'public._r29_on_payment(uuid,uuid)', 'public._r29_reverse(uuid,text,uuid)', 'public._r29_on_void(uuid,uuid)',
      'public.tg_r29_payment()', 'public.tg_r29_subscription()', 'public.tg_r29_events_append_only()',
      'public._r29_qualify(uuid,uuid)', 'public._r29_apply(uuid)', 'public.referral_tick()',
      'public._r29_hq(text[],boolean,text,text,jsonb)', 'public._r29_mask_email(text)',
      'public.referral_payment_fingerprint(uuid,text,text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.referral_tick() to service_role;
    grant execute on function public.referral_payment_fingerprint(uuid,text,text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
