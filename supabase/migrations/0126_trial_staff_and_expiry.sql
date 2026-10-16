-- 0126_trial_staff_and_expiry.sql - CANONICAL forward-only. REQUIRES 0043 (current_org_id__pre0043),
-- 0116 (_trial_locked), 0028 (mfa_ok).
--
-- In plain words:
--   1) A trial studio can invite its own real staff exactly like a paid studio (nothing to
--      change: invitations / accept_invitation already work per studio). The Staff page now
--      says "Trial: staff access ends when the trial ends on <date>".
--   2) When the 8-day trial ends and the studio has NOT paid (public._trial_locked(org) is
--      true), every member who is NOT the studio owner (organizations.created_by) loses
--      access to that studio. This is done WITHOUT touching memberships: profiles.org_id
--      and profiles.role are left exactly as they are. current_org_id() - the function every
--      RLS policy and studio RPC already uses - simply answers NULL for such a member, the
--      same fail-closed way 0043 handles a member who still has to pass 2FA.
--      The owner keeps a read-only studio (0116 write guard, unchanged): can view + export
--      and pay. The moment the studio pays (subscription active / payment recorded / HQ
--      extends the trial) _trial_locked() turns false and every member's access comes back
--      on its own - no data moved, nothing to restore.
--   3) my_trial_access(): works even for a blocked member (it does not depend on
--      current_org_id()), so the app can show "This studio's trial has ended - ask the owner
--      to subscribe" instead of an empty app, and the Staff-page note for the owner.
--
--   Non-trial studios: organizations.trial_ends_at is null -> _trial_member_blocked() is
--   false on its first check, current_org_id() returns exactly what it did before.
--   Platform operators have no studio; service role (auth.uid() null) is never blocked.
--
--   Changes: 2 functions added, 1 function body replaced (current_org_id, same signature,
--   same OID so every policy keeps pointing at it). No table, column or row is changed or
--   deleted. Additive + idempotent: safe to run twice. ASCII only.

do $do$ begin
  if to_regprocedure('public.current_org_id__pre0043()') is null then
    raise exception '0126: public.current_org_id__pre0043() (0043) is missing on this database';
  end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0126: public._trial_locked(uuid) (0116) is missing on this database';
  end if;
  if to_regprocedure('public.mfa_ok()') is null then
    raise exception '0126: public.mfa_ok() (0028) is missing on this database';
  end if;
end $do$;

-- ---- 1) is the signed-in user a non-owner member of an ended, unpaid trial studio? -------------
create or replace function public._trial_member_blocked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-staff-0126: cheap first test (trial_ends_at in the past) keeps paid studios on the fast path
  select p_org is not null
     and auth.uid() is not null
     and exists (select 1 from public.organizations o
                  where o.id = p_org
                    and o.trial_ends_at is not null and o.trial_ends_at <= now()
                    and o.created_by is not null and o.created_by <> auth.uid())
     and public._trial_locked(p_org);
$$;
revoke all on function public._trial_member_blocked(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._trial_member_blocked(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._trial_member_blocked(uuid) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public._trial_member_blocked(uuid) to service_role'; end if;
end $$;

-- ---- 2) current_org_id(): 0043 body + the trial-staff gate ---------------------------------------
-- Same signature / language / volatility / definer as 0043, so RLS policies (bound by OID) are untouched.
create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = '' as $$
  -- mfa-enforce-0043: an enrolled member at aal1 has no studio until they pass 2FA
  -- trial-staff-0126: a non-owner member of an ended, unpaid trial studio has no studio until it pays
  select case when public.mfa_ok() and not public._trial_member_blocked(x.org) then x.org end
    from (select public.current_org_id__pre0043() as org) x;
$$;

-- ---- 3) my_trial_access(): what the app shows (works while blocked) ------------------------------
create or replace function public.my_trial_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-staff-0126
declare v_org uuid; o public.organizations; v_locked boolean; v_owner boolean;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.mfa_ok() then return jsonb_build_object('is_trial_org', false); end if;
  v_org := public.current_org_id__pre0043();
  if v_org is null then return jsonb_build_object('is_trial_org', false); end if;
  select * into o from public.organizations x where x.id = v_org;
  if o.id is null or o.trial_ends_at is null then return jsonb_build_object('is_trial_org', false); end if;
  v_locked := public._trial_locked(v_org);
  v_owner := o.created_by is not null and o.created_by = auth.uid();
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', o.trial_ends_at,
    'ended', o.trial_ends_at <= now(), 'locked', v_locked, 'is_owner', v_owner,
    'blocked', public._trial_member_blocked(v_org),
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'));
end $$;
revoke all on function public.my_trial_access() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_trial_access() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.my_trial_access() to authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.my_trial_access() to service_role'; end if;
end $$;
