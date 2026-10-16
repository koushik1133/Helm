-- DO NOT RUN YET. 0117 integration accounts (Razorpay/WhatsApp per studio). Not run on staging either. Run only when the owner turns integrations on (after staging test).

-- APPLY-0117.sql — paste into the Supabase SQL editor (staging first). Same body as migrations/0117_integration_accounts.sql. Safe to run twice.

-- ============================================================================
-- 0117_integration_accounts.sql - CANONICAL forward-only. Per-studio Razorpay + WhatsApp
-- accounts (DORMANT plumbing: nothing goes live by applying this).
-- REQUIRES 0027 (quote_payments, razorpay_settle), public.current_org_id(), public.is_admin().
-- OPTIONAL: Supabase Vault (schema "vault"). Without Vault the save_* RPCs refuse with
--           'vault_unavailable' and every studio simply keeps the current env behaviour.
--
-- In plain words:
--   * org_payment_accounts / org_whatsapp_accounts: one row per studio. Only NON-secret
--     fields live in the table (Razorpay key id, WABA / phone-number id, status, quality).
--     Secrets (key secret, webhook secret, WhatsApp token) live in Supabase Vault; the table
--     holds only the Vault secret ids, and those id columns are not even readable by
--     signed-in users (column-level grants).
--   * A studio admin sees their OWN studio's row (RLS: org = current_org_id() and is_admin()).
--     Nobody else, no other studio. Writes only through the admin-only save RPCs, which put
--     the secret into Vault and mark the row 'pending'. A row becomes 'connected' only via
--     the service-role helper (after the edge function has validated the keys).
--   * org_razorpay_creds / org_whatsapp_creds: service role only - the edge functions read
--     the decrypted secrets for a CONNECTED studio. No row / not connected -> NULL -> the
--     function falls back to today's global env keys (unchanged behaviour).
--   * integration_webhook_events: idempotent log of provider events (Razorpay
--     payment.failed / payment_link.cancelled / payment_link.expired / refund.processed,
--     WhatsApp delivery statuses). Unique (provider, event_id) -> a replay is a no-op.
--   * whatsapp_opt_outs: STOP / START replies recorded per phone (+ studio when known).
--   * razorpay_settle_for_org: cross-tenant guard for per-studio webhooks - the quote the
--     payment resolves to must belong to the studio whose webhook secret signed it.
--
-- ZERO DATA LOSS: additive + idempotent. New tables / functions only. No DROP, no DELETE,
-- no TRUNCATE, no change to any existing row except: a payment_link.cancelled/expired
-- event moves THAT link's quote_payments row from 'created' to 'cancelled' (the same
-- transition payment_link_begin / razorpay_settle already make), only inside the
-- signing studio. Quotes are never modified here. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regclass('public.quote_payments') is null or to_regprocedure('public.razorpay_settle(uuid,text,text,bigint,text)') is null then
    raise exception '0117: apply 0027 (payments) first'; end if;
  if to_regprocedure('public.current_org_id()') is null or to_regprocedure('public.is_admin()') is null then
    raise exception '0117: current_org_id() / is_admin() missing'; end if;
end $$;

-- ---- 1) tables ----------------------------------------------------------------------------
create table if not exists public.org_payment_accounts (
  org_id              uuid primary key references public.organizations(id),
  provider            text not null default 'razorpay',
  mode                text not null default 'test',
  key_id              text,
  key_secret_id       uuid,           -- vault.secrets.id (never readable by authenticated)
  webhook_secret_id   uuid,           -- vault.secrets.id
  status              text not null default 'pending',
  last_error          text,
  connected_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint org_payment_accounts_provider_chk check (provider in ('razorpay')),
  constraint org_payment_accounts_mode_chk check (mode in ('test', 'live')),
  constraint org_payment_accounts_status_chk check (status in ('pending', 'connected', 'disabled', 'error')),
  constraint org_payment_accounts_key_chk check (key_id is null or key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$')
);

create table if not exists public.org_whatsapp_accounts (
  org_id              uuid primary key references public.organizations(id),
  waba_id             text,
  phone_number_id     text,
  display_phone       text,
  verified_name       text,
  token_secret_id     uuid,           -- vault.secrets.id
  status              text not null default 'pending',
  quality             text,
  last_error          text,
  connected_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  updated_by          uuid,
  constraint org_whatsapp_accounts_status_chk check (status in ('pending', 'connected', 'disabled', 'error')),
  constraint org_whatsapp_accounts_ids_chk check ((waba_id is null or waba_id ~ '^[0-9]{5,30}$') and (phone_number_id is null or phone_number_id ~ '^[0-9]{5,30}$'))
);
create unique index if not exists org_whatsapp_accounts_phone_uk117 on public.org_whatsapp_accounts (phone_number_id) where phone_number_id is not null;

create table if not exists public.integration_webhook_events (
  id            bigint generated always as identity primary key,
  provider      text not null,
  event_id      text not null,
  event_type    text not null,
  org_id        uuid,
  quote_id      uuid,
  ref           text,                 -- plink_ / pay_ / rfnd_ / wamid
  status        text,
  amount_paise  bigint,
  detail        jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now(),
  constraint integration_webhook_events_provider_chk check (provider in ('razorpay', 'whatsapp'))
);
create unique index if not exists integration_webhook_events_uk117 on public.integration_webhook_events (provider, event_id);
create index if not exists integration_webhook_events_org_idx117 on public.integration_webhook_events (org_id, received_at desc);

create table if not exists public.whatsapp_opt_outs (
  id            bigint generated always as identity primary key,
  phone         text not null,
  org_id        uuid,                 -- NULL = Helm shared number
  opted_out     boolean not null default true,
  source        text not null default 'reply',
  updated_at    timestamptz not null default now(),
  constraint whatsapp_opt_outs_phone_chk check (phone ~ '^[0-9]{8,15}$')
);
create unique index if not exists whatsapp_opt_outs_uk117
  on public.whatsapp_opt_outs (phone, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---- 2) RLS + grants (admin of the studio sees non-secret fields only) ---------------------
alter table public.org_payment_accounts enable row level security;
alter table public.org_whatsapp_accounts enable row level security;
alter table public.integration_webhook_events enable row level security;
alter table public.whatsapp_opt_outs enable row level security;

revoke all on public.org_payment_accounts, public.org_whatsapp_accounts,
              public.integration_webhook_events, public.whatsapp_opt_outs from public, anon, authenticated;
grant all on public.org_payment_accounts, public.org_whatsapp_accounts,
             public.integration_webhook_events, public.whatsapp_opt_outs to service_role;
-- column-level: the Vault id columns are NOT granted
grant select (org_id, provider, mode, key_id, status, last_error, connected_at, updated_at)
  on public.org_payment_accounts to authenticated;
grant select (org_id, waba_id, phone_number_id, display_phone, verified_name, status, quality, last_error, connected_at, updated_at)
  on public.org_whatsapp_accounts to authenticated;
grant select (id, provider, event_type, org_id, quote_id, ref, status, amount_paise, received_at)
  on public.integration_webhook_events to authenticated;

drop policy if exists org_payment_accounts_admin_read on public.org_payment_accounts;
create policy org_payment_accounts_admin_read on public.org_payment_accounts for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.is_admin(), false));
drop policy if exists org_whatsapp_accounts_admin_read on public.org_whatsapp_accounts;
create policy org_whatsapp_accounts_admin_read on public.org_whatsapp_accounts for select to authenticated
  using (org_id = public.current_org_id() and coalesce(public.is_admin(), false));
drop policy if exists integration_webhook_events_admin_read on public.integration_webhook_events;
create policy integration_webhook_events_admin_read on public.integration_webhook_events for select to authenticated
  using (org_id is not null and org_id = public.current_org_id() and coalesce(public.is_admin(), false));
-- whatsapp_opt_outs: service role only (no authenticated policy)

-- ---- 3) Vault helper (private) -------------------------------------------------------------
create or replace function public._integ_vault_put(p_existing uuid, p_secret text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v uuid;
begin
  if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     and to_regprocedure('vault.create_secret(text,text,text)') is null then
    raise exception 'vault_unavailable' using errcode = 'P0001'; end if;
  if p_existing is not null and exists (select 1 from vault.secrets where id = p_existing) then
    perform vault.update_secret(p_existing, p_secret);
    return p_existing;
  end if;
  select vault.create_secret(p_secret, p_name || ':' || gen_random_uuid()::text, 'helm integration 0117') into v;
  return v;
end $$;
revoke all on function public._integ_vault_put(uuid, text, text) from public, anon, authenticated;
grant execute on function public._integ_vault_put(uuid, text, text) to service_role;

create or replace function public._integ_vault_get(p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare v text;
begin
  if p_id is null or to_regclass('vault.decrypted_secrets') is null then return null; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where id = $1' into v using p_id;
  return v;
end $$;
revoke all on function public._integ_vault_get(uuid) from public, anon, authenticated;
grant execute on function public._integ_vault_get(uuid) to service_role;

-- ---- 4) admin save RPCs (status -> 'pending'; secrets only into Vault) ---------------------
create or replace function public.save_org_payment_account(p_key_id text, p_key_secret text, p_webhook_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id(); r public.org_payment_accounts; v_ks uuid; v_ws uuid;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  p_key_id := btrim(coalesce(p_key_id, ''));
  if p_key_id !~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$' then raise exception 'invalid_key_id' using errcode = '22023'; end if;
  if length(coalesce(p_key_secret, '')) not between 8 and 200 then raise exception 'invalid_key_secret' using errcode = '22023'; end if;
  if length(coalesce(p_webhook_secret, '')) not between 8 and 200 then raise exception 'invalid_webhook_secret' using errcode = '22023'; end if;
  select * into r from public.org_payment_accounts where org_id = v_org for update;
  v_ks := public._integ_vault_put(r.key_secret_id, p_key_secret, 'rzp_key:' || v_org::text);
  v_ws := public._integ_vault_put(r.webhook_secret_id, p_webhook_secret, 'rzp_whsec:' || v_org::text);
  insert into public.org_payment_accounts as a (org_id, key_id, mode, key_secret_id, webhook_secret_id, status, updated_by, updated_at)
    values (v_org, p_key_id, case when p_key_id like 'rzp_live_%' then 'live' else 'test' end, v_ks, v_ws, 'pending', auth.uid(), now())
  on conflict (org_id) do update set key_id = excluded.key_id, mode = excluded.mode, key_secret_id = excluded.key_secret_id,
    webhook_secret_id = excluded.webhook_secret_id, status = 'pending', last_error = null,
    updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'status', 'pending', 'key_id', p_key_id);
end $$;
revoke all on function public.save_org_payment_account(text, text, text) from public, anon;
grant execute on function public.save_org_payment_account(text, text, text) to authenticated, service_role;

create or replace function public.save_org_whatsapp_account(p_waba_id text, p_phone_number_id text, p_token text, p_display_phone text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id(); r public.org_whatsapp_accounts; v_t uuid;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  p_waba_id := btrim(coalesce(p_waba_id, '')); p_phone_number_id := btrim(coalesce(p_phone_number_id, ''));
  if p_waba_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_waba_id' using errcode = '22023'; end if;
  if p_phone_number_id !~ '^[0-9]{5,30}$' then raise exception 'invalid_phone_number_id' using errcode = '22023'; end if;
  if length(coalesce(p_token, '')) not between 20 and 1000 then raise exception 'invalid_token' using errcode = '22023'; end if;
  if exists (select 1 from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id and org_id <> v_org) then
    raise exception 'phone_in_use' using errcode = '23505'; end if;
  select * into r from public.org_whatsapp_accounts where org_id = v_org for update;
  v_t := public._integ_vault_put(r.token_secret_id, p_token, 'wa_token:' || v_org::text);
  insert into public.org_whatsapp_accounts as a (org_id, waba_id, phone_number_id, display_phone, token_secret_id, status, updated_by, updated_at)
    values (v_org, p_waba_id, p_phone_number_id, left(nullif(btrim(coalesce(p_display_phone, '')), ''), 30), v_t, 'pending', auth.uid(), now())
  on conflict (org_id) do update set waba_id = excluded.waba_id, phone_number_id = excluded.phone_number_id,
    display_phone = excluded.display_phone, token_secret_id = excluded.token_secret_id, status = 'pending',
    last_error = null, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;
revoke all on function public.save_org_whatsapp_account(text, text, text, text) from public, anon;
grant execute on function public.save_org_whatsapp_account(text, text, text, text) to authenticated, service_role;

-- admin may pause their own studio's account (never deletes anything)
create or replace function public.set_org_integration_status(p_kind text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_status not in ('disabled', 'pending') then raise exception 'invalid_status' using errcode = '22023'; end if;
  if p_kind = 'razorpay' then
    update public.org_payment_accounts set status = p_status, updated_at = now(), updated_by = auth.uid() where org_id = v_org;
  elsif p_kind = 'whatsapp' then
    update public.org_whatsapp_accounts set status = p_status, updated_at = now(), updated_by = auth.uid() where org_id = v_org;
  else raise exception 'invalid_kind' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;
revoke all on function public.set_org_integration_status(text, text) from public, anon;
grant execute on function public.set_org_integration_status(text, text) to authenticated, service_role;

-- ---- 5) service-role credential lookups + status marking ------------------------------------
create or replace function public.org_razorpay_creds(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare r public.org_payment_accounts;
begin
  select * into r from public.org_payment_accounts where org_id = p_org and status = 'connected';
  if r.org_id is null then return null; end if;
  return jsonb_build_object('org_id', r.org_id, 'key_id', r.key_id, 'mode', r.mode,
    'key_secret', public._integ_vault_get(r.key_secret_id),
    'webhook_secret', public._integ_vault_get(r.webhook_secret_id));
end $$;
revoke all on function public.org_razorpay_creds(uuid) from public, anon, authenticated;
grant execute on function public.org_razorpay_creds(uuid) to service_role;

create or replace function public.org_whatsapp_creds(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare r public.org_whatsapp_accounts;
begin
  select * into r from public.org_whatsapp_accounts where org_id = p_org and status = 'connected';
  if r.org_id is null then return null; end if;
  return jsonb_build_object('org_id', r.org_id, 'waba_id', r.waba_id, 'phone_number_id', r.phone_number_id,
    'token', public._integ_vault_get(r.token_secret_id));
end $$;
revoke all on function public.org_whatsapp_creds(uuid) from public, anon, authenticated;
grant execute on function public.org_whatsapp_creds(uuid) to service_role;

create or replace function public.mark_org_integration(p_org uuid, p_kind text, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
-- integration-accounts-0117
begin
  if p_status not in ('pending', 'connected', 'disabled', 'error') then raise exception 'invalid_status'; end if;
  if p_kind = 'razorpay' then
    update public.org_payment_accounts set status = p_status, last_error = left(p_error, 200), updated_at = now(),
      connected_at = case when p_status = 'connected' then now() else connected_at end where org_id = p_org;
  elsif p_kind = 'whatsapp' then
    update public.org_whatsapp_accounts set status = p_status, last_error = left(p_error, 200), updated_at = now(),
      connected_at = case when p_status = 'connected' then now() else connected_at end where org_id = p_org;
  end if;
end $$;
revoke all on function public.mark_org_integration(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.mark_org_integration(uuid, text, text, text) to service_role;

-- ---- 6) Razorpay: cross-tenant settle guard + idempotent non-settle events -----------------
create or replace function public.razorpay_settle_for_org(
  p_org uuid, p_quote uuid, p_link_ref text, p_payment_ref text, p_paid_paise bigint, p_event text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_quote uuid := p_quote; v_org uuid; v_link text := nullif(btrim(coalesce(p_link_ref, '')), '');
begin
  if p_org is null then return public.razorpay_settle(p_quote, p_link_ref, p_payment_ref, p_paid_paise, p_event); end if;
  if v_link is not null then
    select quote_id into v_quote from public.quote_payments
     where provider = 'razorpay' and provider_ref = v_link order by created_at desc limit 1;
    v_quote := coalesce(v_quote, p_quote);
  end if;
  if v_quote is null then return jsonb_build_object('result', 'unmatched'); end if;
  select org_id into v_org from public.quotes where id = v_quote;
  if v_org is null then return jsonb_build_object('result', 'unmatched'); end if;
  if v_org <> p_org then return jsonb_build_object('result', 'org_mismatch'); end if;
  return public.razorpay_settle(v_quote, p_link_ref, p_payment_ref, p_paid_paise, p_event);
end $$;
revoke all on function public.razorpay_settle_for_org(uuid, uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.razorpay_settle_for_org(uuid, uuid, text, text, bigint, text) to service_role;

create or replace function public.razorpay_record_event(
  p_event_id text, p_org uuid, p_type text, p_link_ref text, p_payment_ref text, p_refund_ref text,
  p_amount_paise bigint, p_status text, p_quote_hint uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_quote uuid; v_org uuid; v_id bigint; v_link text := nullif(btrim(coalesce(p_link_ref, '')), '');
        v_pay text := nullif(btrim(coalesce(p_payment_ref, '')), '');
begin
  if coalesce(p_type, '') not in ('payment.failed', 'payment_link.cancelled', 'payment_link.expired', 'refund.processed') then
    return jsonb_build_object('result', 'ignored'); end if;
  if nullif(btrim(coalesce(p_event_id, '')), '') is null then return jsonb_build_object('result', 'ignored'); end if;
  if v_link is not null then
    select quote_id into v_quote from public.quote_payments where provider = 'razorpay' and provider_ref = v_link order by created_at desc limit 1;
  end if;
  if v_quote is null and v_pay is not null then
    select quote_id into v_quote from public.quote_payments where provider = 'razorpay' and provider_payment_ref = v_pay limit 1;
  end if;
  v_quote := coalesce(v_quote, p_quote_hint);
  if v_quote is not null then select org_id into v_org from public.quotes where id = v_quote; end if;
  if p_org is not null and v_org is not null and v_org <> p_org then return jsonb_build_object('result', 'org_mismatch'); end if;
  if v_org is null then v_quote := null; end if;

  insert into public.integration_webhook_events(provider, event_id, event_type, org_id, quote_id, ref, status, amount_paise, detail)
    values ('razorpay', left(p_event_id, 120), p_type, coalesce(v_org, p_org), v_quote,
            left(coalesce(nullif(p_refund_ref, ''), v_pay, v_link), 80), left(p_status, 40), p_amount_paise,
            jsonb_strip_nulls(jsonb_build_object('link', v_link, 'payment', v_pay, 'refund', nullif(p_refund_ref, ''))))
  on conflict (provider, event_id) do nothing returning id into v_id;
  if v_id is null then return jsonb_build_object('result', 'replay'); end if;

  -- a link Razorpay closed can no longer be paid: the open reservation stops being reused
  if p_type in ('payment_link.cancelled', 'payment_link.expired') and v_link is not null and v_org is not null then
    update public.quote_payments set status = 'cancelled'
     where provider = 'razorpay' and provider_ref = v_link and status = 'created' and org_id = v_org;
  end if;
  return jsonb_build_object('result', 'recorded', 'quote_id', v_quote, 'org_id', v_org);
end $$;
revoke all on function public.razorpay_record_event(text, uuid, text, text, text, text, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.razorpay_record_event(text, uuid, text, text, text, text, bigint, text, uuid) to service_role;

-- ---- 7) WhatsApp: statuses + opt-outs -------------------------------------------------------
create or replace function public.wa_record_event(
  p_event_id text, p_phone_number_id text, p_type text, p_ref text, p_status text, p_recipient text, p_detail jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_org uuid; v_id bigint;
begin
  if nullif(btrim(coalesce(p_event_id, '')), '') is null then return jsonb_build_object('result', 'ignored'); end if;
  select org_id into v_org from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id;
  insert into public.integration_webhook_events(provider, event_id, event_type, org_id, ref, status, detail)
    values ('whatsapp', left(p_event_id, 160), left(coalesce(p_type, 'status'), 60), v_org, left(p_ref, 120), left(p_status, 40),
            coalesce(p_detail, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('recipient_tail', right(regexp_replace(coalesce(p_recipient, ''), '\D', '', 'g'), 4))))
  on conflict (provider, event_id) do nothing returning id into v_id;
  return jsonb_build_object('result', case when v_id is null then 'replay' else 'recorded' end, 'org_id', v_org);
end $$;
revoke all on function public.wa_record_event(text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.wa_record_event(text, text, text, text, text, text, jsonb) to service_role;

create or replace function public.wa_set_opt_out(p_phone_number_id text, p_phone text, p_opted_out boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
-- integration-accounts-0117
declare v_org uuid; v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if v_phone !~ '^[0-9]{8,15}$' then return jsonb_build_object('result', 'ignored'); end if;
  select org_id into v_org from public.org_whatsapp_accounts where phone_number_id = p_phone_number_id;
  insert into public.whatsapp_opt_outs(phone, org_id, opted_out, source, updated_at)
    values (v_phone, v_org, coalesce(p_opted_out, true), 'reply', now())
  on conflict (phone, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set opted_out = excluded.opted_out, updated_at = now();
  return jsonb_build_object('result', 'recorded', 'opted_out', coalesce(p_opted_out, true));
end $$;
revoke all on function public.wa_set_opt_out(text, text, boolean) from public, anon, authenticated;
grant execute on function public.wa_set_opt_out(text, text, boolean) to service_role;

-- my studio's integration summary for the Settings panel (admin only, non-secret)
create or replace function public.my_integration_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- integration-accounts-0117
declare v_org uuid := public.current_org_id(); p public.org_payment_accounts; w public.org_whatsapp_accounts;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    return jsonb_build_object('is_admin', false); end if;
  select * into p from public.org_payment_accounts where org_id = v_org;
  select * into w from public.org_whatsapp_accounts where org_id = v_org;
  return jsonb_build_object('is_admin', true, 'org_id', v_org,
    'vault', to_regclass('vault.decrypted_secrets') is not null,
    'razorpay', case when p.org_id is null then null else jsonb_build_object('key_id', p.key_id, 'mode', p.mode, 'status', p.status, 'last_error', p.last_error, 'connected_at', p.connected_at) end,
    'whatsapp', case when w.org_id is null then null else jsonb_build_object('waba_id', w.waba_id, 'phone_number_id', w.phone_number_id, 'display_phone', w.display_phone, 'status', w.status, 'quality', w.quality, 'last_error', w.last_error, 'connected_at', w.connected_at) end);
end $$;
revoke all on function public.my_integration_accounts() from public, anon;
grant execute on function public.my_integration_accounts() to authenticated, service_role;
