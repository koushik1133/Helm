-- 0308_r86_profile_trial_gate.sql - CANONICAL forward-only. R86 (owner, production): "Couldn't save your profile.
-- Your trial has ended..." on the "Complete your profile" step.
-- Bug: complete_my_profile / update_my_profile (0041 _mp_apply) save the caller's OWN profiles + member_profiles
-- rows - which the ended-trial guard (0183 / 0255 tg_studio_read_only) deliberately allows - and then call
-- _mp_sync_staff, which INSERTS / UPDATES the studio's crew_members (Staff) row. crew_members is a studio record, so
-- in a studio whose free trial has ended the guard refuses it and the WHOLE profile save rolls back with the
-- trial_ended text. Seen by an account that is still a member of an old, ended trial studio.
-- Fix: _mp_sync_staff is wrapped ONCE (house 0262 / 0307 pattern). When the member's studio is trial-locked
-- (_trial_locked) and the caller is not a platform admin, the staff sync is SKIPPED (no crew_members write; the
-- already-linked staff id is returned, or null). The personal profile still saves, as 0183 intends. The read-only
-- guard itself is NOT changed: every studio record (crew_members included) in an ended trial stays read-only; the
-- staff row simply catches up the next time the profile is saved after the studio upgrades.
-- No table / column / row / policy / index / trigger is created, changed or deleted. Safe to run twice. ASCII only.
do $$
begin
  if to_regprocedure('public._mp_sync_staff(uuid,jsonb)') is null then
    raise exception 'STOP 0308: public._mp_sync_staff(uuid,jsonb) is missing (needs 0041 + 0042)'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception 'STOP 0308: public._trial_locked(uuid) is missing (needs 0116 + 0183)'; end if;
end $$;

-- ---- 1) the logic (re-issued on every run; not callable by the app) ----------------------------------------------
create or replace function public._r308_sync_staff(p_user uuid, p_admin jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r86-profile-trial-0308: an ended-trial studio is read-only - skip the Staff (crew_members) sync, keep the profile
declare v_org uuid; v_id uuid;
begin
  select p.org_id into v_org from public.profiles p where p.id = p_user;
  if v_org is not null and public._trial_locked(v_org) and not public.is_platform_admin() then
    select c.id into v_id from public.crew_members c
     where c.profile_id = p_user and c.org_id = v_org order by c.created_at, c.id limit 1;
    return v_id;                                     -- no studio write while the trial is over
  end if;
  return public._mp_sync_staff__pre0308(p_user, p_admin);
end $$;

-- ---- 2) wrap once: a 2nd run never replaces what is there --------------------------------------------------------
do $$ begin
  if to_regprocedure('public._mp_sync_staff__pre0308(uuid,jsonb)') is null then
    alter function public._mp_sync_staff(uuid, jsonb) rename to _mp_sync_staff__pre0308;
    create function public._mp_sync_staff(p_user uuid, p_admin jsonb)
      returns uuid language sql volatile security definer set search_path = ''
      as 'select public._r308_sync_staff(p_user, p_admin) /* r86-profile-trial-0308 */';
  end if;
end $$;

-- ---- 3) privileges: same as before (service_role only); nothing here is callable by the app -----------------------
revoke all on function public._mp_sync_staff(uuid, jsonb) from public;
revoke all on function public._mp_sync_staff__pre0308(uuid, jsonb) from public;
revoke all on function public._r308_sync_staff(uuid, jsonb) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._mp_sync_staff(uuid, jsonb) from %I', r);
      execute format('revoke all on function public._mp_sync_staff__pre0308(uuid, jsonb) from %I', r);
      execute format('revoke all on function public._r308_sync_staff(uuid, jsonb) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._mp_sync_staff(uuid, jsonb) to service_role';
  end if;
end $$;
