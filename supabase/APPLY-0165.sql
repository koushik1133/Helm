-- APPLY-0165.sql - paste into the Supabase SQL editor (staging first, then production).
-- Additive + idempotent: e-mail unsubscribe (new tables email_optouts + email_unsub_secret, new functions, two BEFORE INSERT triggers created only if missing). No existing table, column or row is changed or removed. Safe to run twice.
begin;
-- 0165_email_unsubscribe.sql
-- E-mail opt-out (unsubscribe) for NON-transactional mail: sales follow-ups, nurture greetings
-- and Helm's own free-trial nudges. Gmail/Yahoo bulk-sender rules (RFC 8058 one-click),
-- CAN-SPAM (opt-out honoured, here immediately) and GDPR / UK GDPR / India DPDP (withdraw
-- consent as easily as it was given). See docs/ops/EMAIL-COMPLIANCE.md.
--   1  public.email_optouts: one row per recipient per sender. org_key = the studio's id, or
--      00000000-0000-0000-0000-000000000000 for mail Helm itself sends (trial nudges).
--      opted_out true/false (re-subscribe flips it back; rows are never deleted).
--   2  public.email_unsub_secret: one random HMAC key, made here, never readable over the API.
--   3  email_unsub_token(org, email): service role only -> "v1.<org>.<email hex>.<hmac>".
--      email_unsub_status(token) / email_unsub_set(token, opt_out, source): service role only
--      (called by the public email-unsubscribe edge function; a forged token is refused).
--      email_is_opted_out(org, email): service role only (senders re-check before sending).
--   4  BEFORE INSERT triggers: a comms_outbox follow_up e-mail to an opted-out address is
--      stored as 'skipped'; a nurture_* e-mail notification as 'suppressed'. Nothing is sent.
--      Transactional mail (codes, invites, approval links, receipts, payment reminders,
--      billing, security) is NOT affected.
-- Additive + idempotent: new tables, new functions, triggers created only if missing.
-- No existing table, column or row is changed or removed. ASCII only. Safe to run twice.

do $$ begin
  if to_regnamespace('extensions') is null or to_regprocedure('extensions.hmac(text, text, text)') is null then
    raise exception '0165: pgcrypto (extensions.hmac) is missing';
  end if;
end $$;

-- ---- 1) tables ----------------------------------------------------------------------------------
create table if not exists public.email_optouts (
  org_key    uuid not null,
  email_lc   text not null check (char_length(email_lc) between 3 and 254 and email_lc = lower(email_lc)),
  opted_out  boolean not null default true,
  source     text not null default 'link' check (source in ('link', 'one_click', 'mailto', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_key, email_lc)
);
create table if not exists public.email_unsub_secret (
  id     integer primary key check (id = 1),
  secret text not null check (char_length(secret) >= 32)
);
insert into public.email_unsub_secret (id, secret)
  values (1, encode(extensions.gen_random_bytes(32), 'hex')) on conflict (id) do nothing;

alter table public.email_optouts enable row level security;
alter table public.email_unsub_secret enable row level security;
revoke all on table public.email_optouts from public;
revoke all on table public.email_unsub_secret from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.email_optouts from anon';
    execute 'revoke all on table public.email_unsub_secret from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.email_optouts from authenticated';
    execute 'revoke all on table public.email_unsub_secret from authenticated';
  end if;
end $$;
-- no policies: only the SECURITY DEFINER functions below and the service role touch these

-- ---- 2) helpers -----------------------------------------------------------------------------------
create or replace function public._eu165_key(p_org uuid)
returns uuid language sql immutable set search_path = '' as $$
  -- email-unsub-0165
  select coalesce(p_org, '00000000-0000-0000-0000-000000000000'::uuid)
$$;

create or replace function public._eu165_norm(p_email text)
returns text language sql immutable set search_path = '' as $$
  -- email-unsub-0165
  select case when lower(btrim(coalesce(p_email, ''))) ~ '^[^[:space:]@<>",;:\\]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$'
              then lower(btrim(p_email)) end
$$;

create or replace function public._eu165_sig(p_key uuid, p_email_lc text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare v_secret text;
begin
  select s.secret into v_secret from public.email_unsub_secret s where s.id = 1;
  if v_secret is null then raise exception '0165: unsubscribe secret missing'; end if;
  return encode(extensions.hmac('v1|' || p_key::text || '|' || p_email_lc, v_secret, 'sha256'), 'hex');
end $$;

-- token -> (org_key, email_lc), or nulls when the token is malformed or forged
create or replace function public._eu165_parse(p_token text, out org_key uuid, out email_lc text)
language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare v_parts text[]; v_key uuid; v_email text;
begin
  if p_token is null or char_length(p_token) > 640 or p_token !~ '^v1\.[0-9a-f]{32}\.[0-9a-f]{2,}\.[0-9a-f]{64}$' then return; end if;
  v_parts := string_to_array(p_token, '.');
  begin
    v_key := v_parts[2]::uuid;
    v_email := convert_from(decode(v_parts[3], 'hex'), 'UTF8');
  exception when others then return;
  end;
  v_email := public._eu165_norm(v_email);
  if v_email is null then return; end if;
  if public._eu165_sig(v_key, v_email) <> v_parts[4] then return; end if;
  org_key := v_key; email_lc := v_email;
end $$;

create or replace function public._eu165_sender(p_key uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare v text;
begin
  if p_key = '00000000-0000-0000-0000-000000000000'::uuid then return 'Helm'; end if;
  select o.name into v from public.organizations o where o.id = p_key;
  return coalesce(nullif(btrim(v), ''), 'this studio');
end $$;

-- ---- 3) API (service role only) -----------------------------------------------------------------
create or replace function public.email_unsub_token(p_org uuid, p_email text)
returns text language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare v_key uuid := public._eu165_key(p_org); v_email text := public._eu165_norm(p_email);
begin
  if v_email is null then return null; end if;
  return 'v1.' || replace(v_key::text, '-', '') || '.' || encode(convert_to(v_email, 'UTF8'), 'hex') || '.' || public._eu165_sig(v_key, v_email);
end $$;

create or replace function public.email_is_opted_out(p_org uuid, p_email text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- email-unsub-0165
  select exists (select 1 from public.email_optouts o
                  where o.org_key = public._eu165_key(p_org) and o.email_lc = public._eu165_norm(p_email) and o.opted_out)
$$;

create or replace function public.email_unsub_status(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- email-unsub-0165
declare t record; v_out boolean;
begin
  select * into t from public._eu165_parse(p_token);
  if t.org_key is null then return jsonb_build_object('ok', false); end if;
  select o.opted_out into v_out from public.email_optouts o where o.org_key = t.org_key and o.email_lc = t.email_lc;
  return jsonb_build_object('ok', true, 'sender', public._eu165_sender(t.org_key),
    'email', left(t.email_lc, 1) || '***' || substr(t.email_lc, position('@' in t.email_lc)),
    'opted_out', coalesce(v_out, false));
end $$;

create or replace function public.email_unsub_set(p_token text, p_opt_out boolean, p_source text default 'link')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- email-unsub-0165
declare t record; v_src text := case when p_source in ('link', 'one_click', 'mailto', 'admin') then p_source else 'link' end;
begin
  select * into t from public._eu165_parse(p_token);
  if t.org_key is null or p_opt_out is null then return jsonb_build_object('ok', false); end if;
  insert into public.email_optouts (org_key, email_lc, opted_out, source)
    values (t.org_key, t.email_lc, p_opt_out, v_src)
    on conflict (org_key, email_lc) do update set opted_out = excluded.opted_out, source = excluded.source, updated_at = now();
  return public.email_unsub_status(p_token);
end $$;

-- ---- 4) send-path gates ---------------------------------------------------------------------------
create or replace function public._eu165_tg_comms()
returns trigger language plpgsql security definer set search_path = '' as $$
-- email-unsub-0165: a sales follow-up e-mail to an address that unsubscribed from this studio
begin
  if NEW.purpose = 'follow_up' and NEW.channel = 'email' and public.email_is_opted_out(NEW.org_id, NEW.recipient) then
    NEW.status := 'skipped'; NEW.sent_at := now();
  end if;
  return NEW;
end $$;

create or replace function public._eu165_tg_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
-- email-unsub-0165: a nurture greeting e-mail to an address that unsubscribed from this studio
begin
  if NEW.channel = 'email' and coalesce(NEW.kind, '') like 'nurture\_%' and public.email_is_opted_out(NEW.org_id, NEW.recipient) then
    NEW.status := 'suppressed';
  end if;
  return NEW;
end $$;

do $$ begin
  if to_regclass('public.comms_outbox') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.comms_outbox'::regclass and tgname = 'zzzz_eu165_optout') then
    execute 'create trigger zzzz_eu165_optout before insert on public.comms_outbox for each row execute function public._eu165_tg_comms()';
  end if;
  if to_regclass('public.notifications') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.notifications'::regclass and tgname = 'zzzz_eu165_optout') then
    execute 'create trigger zzzz_eu165_optout before insert on public.notifications for each row execute function public._eu165_tg_notification()';
  end if;
end $$;

-- ---- 5) privileges ----------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._eu165_key(uuid)', 'public._eu165_norm(text)', 'public._eu165_sig(uuid, text)', 'public._eu165_parse(text)',
    'public._eu165_sender(uuid)', 'public._eu165_tg_comms()', 'public._eu165_tg_notification()',
    'public.email_unsub_token(uuid, text)', 'public.email_is_opted_out(uuid, text)',
    'public.email_unsub_status(text)', 'public.email_unsub_set(text, boolean, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['public.email_unsub_token(uuid, text)', 'public.email_is_opted_out(uuid, text)',
                             'public.email_unsub_status(text)', 'public.email_unsub_set(text, boolean, text)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  end if;
end $$;

commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 email_optouts table', to_regclass('public.email_optouts') is not null),
  ('02 email_unsub_secret has one key', (select count(*) from public.email_unsub_secret) = 1),
  ('03 RLS on email_optouts', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.email_optouts')), false)),
  ('04 RLS on email_unsub_secret', coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.email_unsub_secret')), false)),
  ('05 anon cannot read optouts', not has_table_privilege('anon', 'public.email_optouts', 'select')),
  ('06 anon cannot read secret', not has_table_privilege('anon', 'public.email_unsub_secret', 'select')),
  ('07 authenticated cannot read secret', not has_table_privilege('authenticated', 'public.email_unsub_secret', 'select')),
  ('08 service_role can make tokens', has_function_privilege('service_role', 'public.email_unsub_token(uuid, text)', 'execute')),
  ('09 anon cannot set opt-out directly', not has_function_privilege('anon', 'public.email_unsub_set(text, boolean, text)', 'execute')),
  ('10 authenticated cannot set opt-out directly', not has_function_privilege('authenticated', 'public.email_unsub_set(text, boolean, text)', 'execute')),
  ('11 comms_outbox opt-out trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.comms_outbox') and tgname = 'zzzz_eu165_optout')),
  ('12 notifications opt-out trigger', exists (select 1 from pg_trigger where tgrelid = to_regclass('public.notifications') and tgname = 'zzzz_eu165_optout')),
  ('13 token round-trip', (public.email_unsub_status(public.email_unsub_token(null, 'verify@example.com')) ->> 'ok') = 'true'),
  ('14 forged token refused', (public.email_unsub_status('v1.' || repeat('0', 32) || '.' || encode('a@b.co', 'hex') || '.' || repeat('0', 64)) ->> 'ok') = 'false'),
  ('15 0165 marker', position('email-unsub-0165' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.email_unsub_set(text, boolean, text)'))) > 0)
) v(item, ok) order by item;
