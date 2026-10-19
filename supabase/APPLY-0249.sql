-- APPLY-0249.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0244 (sales_requests) and APPLY-0248. Needs 0029 / 0042 / 0045 / 0047 (already on production).
-- r21 security posture (top-10 actions #3 + #4, code side). BOTH switches stay OFF - nothing changes for anyone today:
--   - HQ -> Overview shows "HQ two-step readiness" (hq_mfa_readiness): every operator, login yes/no, two-step yes/no.
--   - Turning helm_hq_settings.hq_require_mfa ON is REFUSED while an operator with a login has no authenticator
--     (no lock-out). Turning it off is never blocked.
--   - Dormant captcha on "Contact sales" (helm_hq_settings.rpc_captcha_required, default false).
-- No existing table / row / policy / function is changed or deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (hq.js / store-api.js / checkout.js) - HQ Overview then shows the readiness card.
--   3  LATER, two-step for HQ: each operator opens HQ -> Overview -> "Set up two-step" (or signs in again) and scans
--      the QR code. When the card says "Safe to require two-step", run supabase/audit/R21-SECURITY-PREFLIGHT.sql
--      (read-only) once more, then:   update public.helm_hq_settings set hq_require_mfa = true where id;
--      If an operator is still missing two-step the update stops with "STOP: ... have no two-step authenticator".
--   4  LATER, captcha on Contact sales: only after Turnstile is live on sign-in (docs/security/OWNER-DASHBOARD-STEPS-R21.md
--      section D) AND the captcha-verify edge function is deployed with TURNSTILE_SECRET_KEY:
--        update public.helm_hq_settings set rpc_captcha_required = true where id;
--      Undo at any time:  update public.helm_hq_settings set rpc_captcha_required = false where id;
--
-- ROLLBACK (manual, only if ever needed; no customer data involved):
--   drop trigger if exists a249_hq_require_mfa_guard on public.helm_hq_settings;
--   drop trigger if exists a249_sales_captcha on public.sales_requests;
begin;
-- 0249_security_readiness.sql - CANONICAL forward-only.
-- REQUIRES 0029 (platform_admins, is_platform_admin, _hq_gate), 0042 (platform_admins.user_id),
--          0045 + 0047 (_hq_wgate, helm_hq_settings.hq_require_mfa), 0244 (sales_requests), base audit_log.
--
-- In plain words (r21 security posture checklist, top-10 actions #3 and #4 - the CODE side; the owner flips
-- the switches later):
--   1  HQ two-step READINESS. hq_mfa_readiness() (HQ operators only, read-only, logged as an HQ view) lists
--      every HQ operator with: has a login? has a verified two-step authenticator? last sign-in. Plus how many
--      studio admins have two-step (for the later config.js mfaRequiredForAdmins switch) and whether it is
--      SAFE to require two-step for HQ now. The HQ Overview shows it with a "Set up two-step" button.
--   2  A GUARD on the switch: turning helm_hq_settings.hq_require_mfa ON (false -> true) is REFUSED while any
--      HQ operator WITH a login has no verified authenticator - from HQ and from the SQL editor alike - and
--      the error names them. So flipping the switch can never lock out an operator who has not enrolled.
--      (Operators who never signed in are listed as "pending": the sign-in page makes them set it up first.)
--      Turning it OFF is never blocked. The switch itself stays OFF here (owner flips it later).
--   3  CAPTCHA on the RPC path (Cloudflare Turnstile, DORMANT): a new switch
--      helm_hq_settings.rpc_captcha_required (default FALSE = off, nothing changes). When the owner turns it
--      on (after deploying the captcha-verify edge function with TURNSTILE_SECRET_KEY and putting the site
--      key in public/config.js), a "Contact sales" request (sales_requests insert by a signed-in user) needs a
--      fresh, unused security-check pass for that user, recorded by captcha-verify (service role only,
--      captcha_pass_record) after Cloudflare confirmed the token. Passes live 10 minutes and are used once.
--      Sign-up / sign-in / password reset (and so the free-trial start, which needs a confirmed sign-up) are
--      checked by Supabase Auth itself (Authentication -> Attack Protection -> CAPTCHA), not here.
--   Changes: 1 new table (captcha_passes), 1 new column (helm_hq_settings.rpc_captcha_required, default false),
--   2 new triggers, new functions. No existing row / policy / function is changed or deleted. Additive +
--   idempotent. Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no customer data involved):
--   drop trigger if exists a249_hq_require_mfa_guard on public.helm_hq_settings;
--   drop trigger if exists a249_sales_captcha on public.sales_requests;
--   (the column, table and functions can stay; with the triggers gone they do nothing.)

do $$ begin
  if to_regclass('public.platform_admins') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'STOP: 0029 (platform_admins / is_platform_admin) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'platform_admins' and column_name = 'user_id') then
    raise exception 'STOP: 0042 (platform_admins.user_id) is not applied'; end if;
  if to_regprocedure('public._hq_gate(text,text)') is null or to_regprocedure('public._hq_wgate(text,text,text,jsonb)') is null then
    raise exception 'STOP: 0029 / 0045 / 0047 (_hq_gate / _hq_wgate) is not applied'; end if;
  if to_regclass('public.helm_hq_settings') is null then raise exception 'STOP: 0047 (helm_hq_settings) is not applied'; end if;
  if to_regclass('public.sales_requests') is null then raise exception 'STOP: 0244 (sales_requests) is not applied'; end if;
  if to_regclass('public.audit_log') is null then raise exception 'STOP: base audit_log table missing'; end if;
  if to_regclass('auth.users') is null then raise exception 'STOP: auth.users missing'; end if;
end $$;

-- ---- 1) who has two-step (private helpers; the service role / definer functions only) --------------------
create or replace function public._a249_has_factor(p_uid uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v boolean := false;
begin
  if p_uid is null or to_regclass('auth.mfa_factors') is null then return false; end if;
  execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')'
    into v using p_uid;
  return coalesce(v, false);
end $$;
revoke all on function public._a249_has_factor(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._a249_has_factor(uuid) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._a249_has_factor(uuid) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public._a249_has_factor(uuid) to service_role; end if;
end $$;

-- every HQ operator: the login it is bound to (user_id first, else the confirmed login with that e-mail)
create or replace function public._a249_operator_rows()
returns table(email text, user_id uuid, has_login boolean, has_2step boolean, last_sign_in_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select pa.email, u.id, u.id is not null, public._a249_has_factor(u.id), u.last_sign_in_at
    from public.platform_admins pa
    left join lateral (
      select au.id, au.last_sign_in_at from auth.users au
       where (pa.user_id is not null and au.id = pa.user_id)
          or (pa.user_id is null and lower(au.email) = pa.email and au.email_confirmed_at is not null)
       order by (au.id = pa.user_id) desc nulls last, au.created_at
       limit 1) u on true
$$;
revoke all on function public._a249_operator_rows() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._a249_operator_rows() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._a249_operator_rows() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public._a249_operator_rows() to service_role; end if;
end $$;

-- ---- 2) HQ readiness report (operators only; read-only; logged as an HQ view) ------------------------------
create or replace function public.hq_mfa_readiness()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r21-security-0249
declare v_ops jsonb; v_block int; v_pending int; v_ok int; v_adm int; v_adm2 int;
begin
  perform public._hq_gate('hq_mfa_readiness');
  select coalesce(jsonb_agg(jsonb_build_object('email', o.email, 'has_login', o.has_login, 'has_2step', o.has_2step,
           'last_sign_in_at', o.last_sign_in_at, 'is_me', o.user_id is not null and o.user_id = auth.uid())
           order by o.email), '[]'::jsonb),
         count(*) filter (where o.has_login and not o.has_2step),
         count(*) filter (where not o.has_login),
         count(*) filter (where o.has_2step)
    into v_ops, v_block, v_pending, v_ok
    from public._a249_operator_rows() o;
  select count(*), count(*) filter (where public._a249_has_factor(p.id))
    into v_adm, v_adm2
    from public.profiles p where p.role = 'admin' and p.org_id is not null;
  return jsonb_build_object(
    'hq_require_mfa', coalesce((select s.hq_require_mfa from public.helm_hq_settings s where s.id), true),
    'rpc_captcha_required', coalesce((select s.rpc_captcha_required from public.helm_hq_settings s where s.id), false),
    'operators', v_ops,
    'operators_without_2step', v_block,
    'operators_never_signed_in', v_pending,
    'operators_with_2step', v_ok,
    'safe_to_require', v_block = 0 and v_ok > 0,
    'studio_admins', jsonb_build_object('total', v_adm, 'with_2step', v_adm2, 'without_2step', v_adm - v_adm2));
end $$;
revoke all on function public.hq_mfa_readiness() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hq_mfa_readiness() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.hq_mfa_readiness() to authenticated; end if;
end $$;

-- ---- 3) the captcha switch (new column, default OFF) + guard / audit on helm_hq_settings -------------------
alter table public.helm_hq_settings add column if not exists rpc_captcha_required boolean not null default false;

create or replace function public.tg_a249_hq_settings_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_list text; n int;
begin
  -- turning HQ two-step ON while an operator with a login has no authenticator would lock them out of HQ writes.
  -- (helm.allow_hq_mfa_lockout = 'on' skips this check: for the local DB test harness only, which turns the switch on
  -- with fake operators. A PostgREST / app session can't set it; the owner never needs it.)
  if coalesce(new.hq_require_mfa, false) and not coalesce(old.hq_require_mfa, false)
     and coalesce(current_setting('helm.allow_hq_mfa_lockout', true), '') <> 'on' then
    select count(*), string_agg(o.email, ', ' order by o.email) into n, v_list
      from public._a249_operator_rows() o where o.has_login and not o.has_2step;
    if n > 0 then
      raise exception 'STOP: % HQ operator(s) have no two-step authenticator yet: %. Ask them to open Helm HQ -> Overview -> "Set up two-step" first (or remove the operator), then turn the switch on.', n, v_list
        using errcode = 'P0001', hint = 'hq_mfa_not_ready';
    end if;
  end if;
  if new.rpc_captcha_required is distinct from old.rpc_captcha_required then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'hq.settings.rpc_captcha',
              'helm_hq_settings', null,
              jsonb_build_object('rpc_captcha_required', jsonb_build_object('from', old.rpc_captcha_required, 'to', new.rpc_captcha_required)),
              null, now());
  end if;
  return new;
end $$;
revoke all on function public.tg_a249_hq_settings_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a249_hq_settings_guard() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a249_hq_settings_guard() from authenticated; end if;
end $$;
drop trigger if exists a249_hq_require_mfa_guard on public.helm_hq_settings;
create trigger a249_hq_require_mfa_guard before update on public.helm_hq_settings
  for each row execute function public.tg_a249_hq_settings_guard();

-- ---- 4) captcha passes (private; written only by the captcha-verify edge function via the service role) ----
create table if not exists public.captcha_passes (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  action     text not null check (action in ('sales')),
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists captcha_passes_user_idx on public.captcha_passes (user_id, action, created_at desc);
alter table public.captcha_passes enable row level security;
-- no policies on purpose: the API can't read or write it; the definer functions below and the service role can
revoke all on table public.captcha_passes from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.captcha_passes from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.captcha_passes from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, insert on table public.captcha_passes to service_role; end if;
end $$;

-- the edge function records a pass after Cloudflare confirmed the token (service role only)
create or replace function public.captcha_pass_record(p_user uuid, p_action text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_user is null or p_action is null or p_action not in ('sales') then
    raise exception 'bad captcha pass' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'bad captcha pass' using errcode = '22023'; end if;
  insert into public.captcha_passes(user_id, action) values (p_user, p_action);
  return true;
end $$;
revoke all on function public.captcha_pass_record(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.captcha_pass_record(uuid, text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.captcha_pass_record(uuid, text) from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.captcha_pass_record(uuid, text) to service_role; end if;
end $$;

-- true when the switch is off; else uses (marks used_at on) the newest unused pass of the caller, <= 10 min old
create or replace function public._captcha_consume(p_action text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_id bigint;
begin
  if not coalesce((select s.rpc_captcha_required from public.helm_hq_settings s where s.id), false) then return true; end if;
  if auth.uid() is null then return true; end if;   -- service role / SQL editor / cron: no browser, no captcha
  select c.id into v_id from public.captcha_passes c
   where c.user_id = auth.uid() and c.action = p_action and c.used_at is null and c.created_at > now() - interval '10 minutes'
   order by c.created_at desc limit 1 for update skip locked;
  if v_id is null then return false; end if;
  update public.captcha_passes set used_at = now() where id = v_id;
  return true;
end $$;
revoke all on function public._captcha_consume(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._captcha_consume(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._captcha_consume(text) from authenticated; end if;
end $$;

create or replace function public.tg_a249_sales_captcha()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public._captcha_consume('sales') then
    raise exception 'Please complete the security check and send your request again.'
      using errcode = '42501', hint = 'captcha_required';
  end if;
  return new;
end $$;
revoke all on function public.tg_a249_sales_captcha() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a249_sales_captcha() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a249_sales_captcha() from authenticated; end if;
end $$;
drop trigger if exists a249_sales_captcha on public.sales_requests;
create trigger a249_sales_captcha before insert on public.sales_requests
  for each row execute function public.tg_a249_sales_captcha();

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 hq_mfa_readiness exists, HQ-gated, callable by signed-in users only',
     to_regprocedure('public.hq_mfa_readiness()') is not null
     and position('_hq_gate(' in (select prosrc from pg_proc where oid = to_regprocedure('public.hq_mfa_readiness()'))) > 0
     and has_function_privilege('authenticated', 'public.hq_mfa_readiness()', 'execute')
     and not has_function_privilege('anon', 'public.hq_mfa_readiness()', 'execute')),
  ('02 guard trigger on helm_hq_settings is installed',
     exists (select 1 from pg_trigger where tgrelid = 'public.helm_hq_settings'::regclass and tgname = 'a249_hq_require_mfa_guard' and not tgisinternal)),
  ('03 HQ two-step switch unchanged by this file (still the value it had)',
     (select count(*) from public.helm_hq_settings) = 1),
  ('04 captcha switch exists (default OFF; only the owner turns it on)',
     (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'helm_hq_settings'
       and column_name = 'rpc_captcha_required') = 'false'),
  ('05 captcha_passes private (RLS on, no policies, no app grants)',
     (select relrowsecurity from pg_class where oid = 'public.captcha_passes'::regclass)
     and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'captcha_passes')
     and not has_table_privilege('authenticated', 'public.captcha_passes', 'select')
     and not has_table_privilege('anon', 'public.captcha_passes', 'select')),
  ('06 only the service role can record a pass',
     has_function_privilege('service_role', 'public.captcha_pass_record(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.captcha_pass_record(uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.captcha_pass_record(uuid,text)', 'execute')),
  ('07 Contact sales trigger installed (dormant while the switch is off)',
     exists (select 1 from pg_trigger where tgrelid = 'public.sales_requests'::regclass and tgname = 'a249_sales_captcha' and not tgisinternal))
) v(item, ok) order by item;
