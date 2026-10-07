-- ============================================================================
-- 0047_hq_mfa_optional.sql — CANONICAL forward-only. REQUIRES 0029, 0037, 0042, 0045.
-- Owner decision (temporary): two-step verification is OPTIONAL for Helm HQ operators,
-- behind ONE platform switch so it can be turned back on later.
--
--   helm_hq_settings.hq_require_mfa  (one row, default FALSE)
--     false → an operator WITHOUT an authenticator reaches HQ and may use every HQ
--             write at aal1. An operator who HAS set one up is still asked for the code
--             (aal2) — exactly as before. platform_admins.require_mfa is ignored.
--     true  → the pre-0047 rules: factor OR require_mfa ⇒ aal2 for HQ, and every HQ
--             write needs aal2.
--   Writable only by the service role (SQL editor) or hq_set_require_mfa() (an HQ
--   operator through the HQ write gate). Every change is written to audit_log.
--   operator_mfa_required() — the switch, readable by a signed-in caller (the sign-in page
--   uses it to decide whether to force set-up). It reveals nothing about any account.
-- Studio-member two-step (0043) is NOT touched. Non-operators are never admitted.
-- Additive, idempotent, changes no existing row (inserts the one settings row).
-- ============================================================================
create table if not exists public.helm_hq_settings (
  id             boolean primary key default true check (id),
  hq_require_mfa boolean not null default false,
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
insert into public.helm_hq_settings(id) values (true) on conflict (id) do nothing;
alter table public.helm_hq_settings enable row level security;
revoke all on table public.helm_hq_settings from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.helm_hq_settings from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.helm_hq_settings from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant select, update on table public.helm_hq_settings to service_role; end if;
end $$;

-- every change to the switch is audited (also direct service-role / SQL-editor updates)
create or replace function public.tg_a47_hq_settings_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.hq_require_mfa is distinct from old.hq_require_mfa then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'hq.settings.require_mfa',
              'helm_hq_settings', null,
              jsonb_build_object('hq_require_mfa', jsonb_build_object('from', old.hq_require_mfa, 'to', new.hq_require_mfa)),
              null, now());
  end if;
  return new;
end $$;
revoke all on function public.tg_a47_hq_settings_audit() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a47_hq_settings_audit() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a47_hq_settings_audit() from authenticated; end if;
end $$;
drop trigger if exists a47_hq_settings_audit on public.helm_hq_settings;
create trigger a47_hq_settings_audit before update on public.helm_hq_settings
  for each row execute function public.tg_a47_hq_settings_audit();
-- the single row can't be removed or duplicated
create or replace function public.tg_a47_hq_settings_fixed()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'helm_hq_settings has exactly one row' using errcode = '42501'; end $$;
revoke all on function public.tg_a47_hq_settings_fixed() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.tg_a47_hq_settings_fixed() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.tg_a47_hq_settings_fixed() from authenticated; end if;
end $$;
drop trigger if exists a47_hq_settings_fixed on public.helm_hq_settings;
create trigger a47_hq_settings_fixed before delete or truncate on public.helm_hq_settings
  for each statement execute function public.tg_a47_hq_settings_fixed();

-- the switch (missing row ⇒ required: fail closed)
create or replace function public._hq_require_mfa()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.hq_require_mfa from public.helm_hq_settings s where s.id), true)
$$;
revoke all on function public._hq_require_mfa() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._hq_require_mfa() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._hq_require_mfa() from authenticated; end if;
end $$;

create or replace function public.operator_mfa_required()
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null then return true; end if;
  return public._hq_require_mfa();
end $$;
revoke all on function public.operator_mfa_required() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.operator_mfa_required() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.operator_mfa_required() to authenticated; end if;
end $$;

-- HQ access: operator (allowlist + account binding, 0037/0042) and the two-step rule
create or replace function public.is_platform_admin()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_email text; v_req boolean; v_has_factor boolean := false;
  v_aal text := coalesce(auth.jwt() ->> 'aal', '');
begin
  if v_uid is null or not public.is_platform_operator() then return false; end if;
  if v_aal = 'aal2' then return true; end if;
  if to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors f where f.user_id = $1 and f.status::text = ''verified'')'
      into v_has_factor using v_uid;
  end if;
  if v_has_factor then return false; end if;               -- set up ⇒ must enter the code, always
  if not public._hq_require_mfa() then return true; end if; -- 0047 switch off: aal1 allowed
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  select pa.require_mfa into v_req from public.platform_admins pa where pa.email = v_email;
  return not coalesce(v_req, false);
end $$;
revoke all on function public.is_platform_admin() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.is_platform_admin() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.is_platform_admin() to authenticated; end if;
end $$;

-- HQ write gate (0045): aal2 only while the switch is on
create or replace function public._hq_wgate(p_action text, p_entity text, p_entity_id text, p_changed jsonb default null)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_platform_admin()
     or (public._hq_require_mfa() and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, p_action, p_entity, p_entity_id, p_changed, null, now()
      from auth.users u where u.id = auth.uid();
end $$;
revoke all on function public._hq_wgate(text, text, text, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._hq_wgate(text, text, text, jsonb) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._hq_wgate(text, text, text, jsonb) from authenticated; end if;
end $$;

-- HQ: flip the switch (gated + audited)
create or replace function public.hq_set_require_mfa(p_on boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_on is null then raise exception 'on/off required' using errcode = '22023'; end if;
  perform public._hq_wgate('hq.settings.require_mfa', 'helm_hq_settings', null, jsonb_build_object('hq_require_mfa', p_on));
  update public.helm_hq_settings set hq_require_mfa = p_on where id;
  return p_on;
end $$;
revoke all on function public.hq_set_require_mfa(boolean) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.hq_set_require_mfa(boolean) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then grant execute on function public.hq_set_require_mfa(boolean) to authenticated; end if;
end $$;
