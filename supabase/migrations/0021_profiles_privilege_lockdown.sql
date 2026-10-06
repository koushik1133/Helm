-- ============================================================================
-- 0021_profiles_privilege_lockdown.sql — CANONICAL forward-only (security audit
-- Phase 5, finding P5-01 — CRITICAL on any DB built from canonical, e.g. staging).
-- Problem: 0006 created profiles_self_update (USING/WITH CHECK id = auth.uid()) and
-- the authenticated role kept column UPDATE on every profiles column. So ANY signed-in
-- member could run  update profiles set role='admin', org_id='<other studio>'  on
-- their own row → instant admin, and a hop into another studio's data (verified on
-- the disposable DB: crew → admin → read studio B's quotes).
-- The app never writes profiles directly; every legitimate write goes through a
-- SECURITY DEFINER RPC (create_studio, admin_set_role, accept_invitation,
-- admin_create_user[_temp], clear_password_change_required, handle_new_user).
-- Fix (belt and braces):
--   1. drop the self-update policy;
--   2. revoke INSERT/UPDATE/DELETE on profiles from anon + authenticated;
--   3. a guard trigger rejects any role/org/id/email/must_change_password change,
--      and any insert/delete, made directly by anon/authenticated — so even a policy
--      or grant re-added by a legacy script can't re-open the hole. Definer RPCs run
--      as the function owner and are unaffected.
-- Idempotent. Additive (no data touched). Forward-only.
-- ============================================================================

drop policy if exists profiles_self_update on public.profiles;
revoke insert, update, delete on public.profiles from anon, authenticated;

create or replace function public.profiles_privilege_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- direct API callers only; SECURITY DEFINER RPCs run as their owner and pass through
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'UPDATE' then
      if new.id is distinct from old.id
         or new.role is distinct from old.role
         or new.org_id is distinct from old.org_id
         or new.email is distinct from old.email
         or new.must_change_password is distinct from old.must_change_password then
        raise exception 'a profile''s role or studio can only be changed by an admin' using errcode = '42501';
      end if;
    else
      raise exception 'profiles are managed by admins' using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists profiles_privilege_guard_biud on public.profiles;
create trigger profiles_privilege_guard_biud before insert or update or delete on public.profiles
  for each row execute function public.profiles_privilege_guard();

-- ---- VERIFY (read-only) ----------------------------------------------------
-- select policyname, cmd from pg_policies where schemaname='public' and tablename='profiles';      -- SELECT only
-- select has_table_privilege('authenticated','public.profiles','UPDATE');                           -- false
-- select tgname from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal;    -- includes the guard
