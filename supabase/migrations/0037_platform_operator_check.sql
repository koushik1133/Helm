-- ============================================================================
-- 0037_platform_operator_check.sql — CANONICAL forward-only.
-- is_platform_admin() is false for an HQ operator who still owes a two-step code
-- (require_mfa / enrolled factor at aal1). The app then mistook them for a new user
-- with no studio and offered studio setup. This adds:
--   is_platform_operator() — "is MY confirmed e-mail on the HQ list", ignoring the
--     two-step state. Only answers for the caller (no argument), so it reveals nothing
--     about anyone else. It grants NO access: every hq_* RPC still requires
--     is_platform_admin() (allowlist + two-step).
--   the 0034 studio backstop now uses it, so an operator can never create a studio,
--   whatever their two-step state.
-- Additive, idempotent, changes no rows.
-- ============================================================================
create or replace function public.is_platform_operator()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_email text; v_confirmed timestamptz;
begin
  if v_uid is null then return false; end if;
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then return false; end if;
  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_uid;
  if v_email is null or v_confirmed is null then return false; end if;
  return exists (select 1 from public.platform_admins pa where pa.email = v_email);
end $$;
revoke all on function public.is_platform_operator() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.is_platform_operator() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.is_platform_operator() to authenticated'; end if;
end $$;

create or replace function public.tg_no_studio_for_operator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and public.is_platform_operator() then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.tg_no_studio_for_operator() from public, anon, authenticated;
drop trigger if exists ab_no_studio_for_operator on public.organizations;
create trigger ab_no_studio_for_operator before insert on public.organizations
  for each row execute function public.tg_no_studio_for_operator();
