-- 0314_r103_profile_payment_gate.sql - CANONICAL forward-only. R103 (owner, production): a new owner who signed up
-- for a paid plan ("Pay now" / "Contact sales") is stuck on "Complete your profile" with "Couldn't save your
-- profile. Choose a plan and complete payment to start using Helm - or start a free trial instead."
-- Bug: create_direct_studio (0255) creates the studio + studio_payment_gate row at sign-up, BEFORE the profile step.
-- complete_my_profile / update_my_profile (0041 _mp_apply) then write the caller's OWN member_profiles row, and
-- the payment-pending branch of tg_studio_read_only (0255, section 7) only exempted studio_account / profiles /
-- user_dashboard_prefs / notifications / organizations - NOT member_profiles - so the whole save rolled back with
-- payment_pending. Right after that, _mp_sync_staff (0308 wrapper) would also write crew_members (a studio record),
-- which the same branch refuses.
-- Fix (narrow):
--   1) tg_studio_read_only re-issued = the 0255 body + ONE exemption in the payment-pending branch: the caller's OWN
--      member_profiles row (user_id = caller on both the new and the old row). Every other table, every other
--      person's member_profiles row, the suspended lock and the ended-trial lock are unchanged.
--   2) _mp_sync_staff wrapped once more (house 0308 pattern): while the member's studio is payment-pending (and the
--      caller is not a platform admin) the Staff (crew_members) sync is SKIPPED, exactly as 0308 does for an ended
--      trial; the staff row catches up on the next profile save after payment.
-- No table / column / row / policy / index / trigger is created, changed or deleted. Safe to run twice. ASCII only.
-- Goes after 0255 + 0308.
do $$
begin
  if to_regprocedure('public.tg_studio_read_only()') is null then
    raise exception 'STOP 0314: public.tg_studio_read_only() is missing (needs 0045 + 0255)'; end if;
  if to_regprocedure('public._studio_payment_pending(uuid)') is null then
    raise exception 'STOP 0314: public._studio_payment_pending(uuid) is missing (needs 0159)'; end if;
  if to_regprocedure('public._mp_sync_staff__pre0308(uuid,jsonb)') is null then
    raise exception 'STOP 0314: 0308 (_mp_sync_staff__pre0308) is missing - run APPLY-0308 first'; end if;
end $$;

-- ---- 1) read-only guard: 0255 body + the caller's OWN member_profiles row passes the payment-pending lock --------
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios are read-only
-- direct-studio-0159: + a directly created studio is read-only until its first payment
-- trial-expiry-0183: ended trial = read-only for EVERYONE; only billing / bell / the caller's own rows pass
-- r22-signup-0255: + the caller's OWN consent record (studio_consent_log insert, actor = caller) passes both locks
-- r103-profile-payment-0314: + the caller's OWN member_profiles row passes the payment-pending lock
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
  v_uid text := auth.uid()::text;
  v_new jsonb; v_old jsonb; v_free boolean := null; v_consent boolean;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended')
     and not exists (select 1 from public.organizations x where x.trial_ends_at is not null and x.trial_ends_at <= now())
     and not exists (select 1 from public.studio_payment_gate g join public.organizations x on x.id = g.org_id
                      where x.trial_ends_at is null) then
    return coalesce(new, old); end if;                                                      -- fast path
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  v_consent := tg_table_name = 'studio_consent_log' and tg_op = 'INSERT' and v_uid is not null and v_new ->> 'actor' = v_uid;
  foreach r in array (case tg_op when 'INSERT' then array[v_new]
                                  when 'DELETE' then array[v_old]
                                  else array[v_new, v_old] end) loop
    v_key := r ->> v_how; o := null;
    if v_key is not null and v_key ~* '^[0-9a-f-]{36}$' then
      if v_how in ('org_id', 'id') then o := v_key::uuid;
      elsif v_how in ('user_id', 'owner') then select p.org_id into o from public.profiles p where p.id = v_key::uuid;
      elsif v_how = 'quote_id' then select q.org_id into o from public.quotes q where q.id = v_key::uuid;
      end if;
    end if;
    if o is not null then v_orgs := v_orgs || o; end if;
  end loop;
  foreach o in array v_orgs loop
    if not public._studio_writable(o) and not public.is_platform_admin() then
      raise exception 'Read-only: this studio''s Helm subscription is suspended - contact Helm'
        using errcode = '25006', hint = 'studio_suspended';
    end if;
    -- ended free trial: read-only for everyone. Still allowed: billing details / Terms, the bell, and the
    -- caller's OWN profile + personal rows (never another person's), and marking chat as read.
    if v_free is null then
      v_free := v_consent or tg_table_name in ('studio_account', 'notifications')
        or (v_uid is not null and (
              (tg_table_name = 'profiles'
                 and (v_new is null or v_new ->> 'id' = v_uid) and (v_old is null or v_old ->> 'id' = v_uid))
           or (tg_table_name in ('member_profiles', 'user_dashboard_prefs', 'user_recent_records', 'saved_views',
                                 'notification_mutes', 'notification_prefs')
                 and (v_new is null or v_new ->> 'user_id' = v_uid) and (v_old is null or v_old ->> 'user_id' = v_uid))
           -- chat_mark_read: the caller's own plain 'member' row + its last_read_at, nothing else
           or (tg_table_name = 'chat_members' and tg_op = 'INSERT'
                 and v_new ->> 'user_id' = v_uid and coalesce(v_new ->> 'member_role', 'member') = 'member')
           or (tg_table_name = 'chat_members' and tg_op = 'UPDATE'
                 and v_new ->> 'user_id' = v_uid and v_old ->> 'user_id' = v_uid
                 and (v_new - 'last_read_at') = (v_old - 'last_read_at'))));
    end if;
    if not v_free and public._trial_locked(o) and not public.is_platform_admin() then
      raise exception 'Your trial has ended. Your data is preserved and available in read-only mode. Upgrade now to continue creating and editing records.'
        using errcode = '25006', hint = 'trial_ended';
    end if;
    -- direct studio, not paid yet: only billing details / Terms / own profile / the studio row / own consent.
    -- The rows create_studio writes in the SAME transaction that created the studio still go in
    -- (organizations.created_at defaults to now(), the transaction start time).
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications', 'organizations')
       and not v_consent
       -- r103 (0314): the caller's OWN member_profiles row (profile step / avatar) is personal, not business data
       and not (v_uid is not null and tg_table_name = 'member_profiles'
                and (v_new is null or v_new ->> 'user_id' = v_uid) and (v_old is null or v_old ->> 'user_id' = v_uid))
       and public._studio_payment_pending(o) and not public.is_platform_admin()
       and not exists (select 1 from public.organizations x where x.id = o and x.created_at = now()) then
      raise exception 'Choose a plan and complete payment to start using Helm - or start a free trial instead.'
        using errcode = '25006', hint = 'payment_pending';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

-- ---- 2) Staff sync skipped while the studio waits for its first payment (re-issued on every run) ----------------
create or replace function public._r314_sync_staff(p_user uuid, p_admin jsonb)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r103-profile-payment-0314: a payment-pending studio is read-only - skip the Staff (crew_members) sync, keep the profile
declare v_org uuid; v_id uuid;
begin
  select p.org_id into v_org from public.profiles p where p.id = p_user;
  if v_org is not null and public._studio_payment_pending(v_org) and not public.is_platform_admin() then
    select c.id into v_id from public.crew_members c
     where c.profile_id = p_user and c.org_id = v_org order by c.created_at, c.id limit 1;
    return v_id;                                     -- no studio write until the first payment
  end if;
  return public._mp_sync_staff__pre0314(p_user, p_admin);
end $$;

do $$ begin
  if to_regprocedure('public._mp_sync_staff__pre0314(uuid,jsonb)') is null then
    alter function public._mp_sync_staff(uuid, jsonb) rename to _mp_sync_staff__pre0314;
    create function public._mp_sync_staff(p_user uuid, p_admin jsonb)
      returns uuid language sql volatile security definer set search_path = ''
      as 'select public._r314_sync_staff(p_user, p_admin) /* r103-profile-payment-0314 */';
  end if;
end $$;

revoke all on function public._mp_sync_staff(uuid, jsonb) from public;
revoke all on function public._mp_sync_staff__pre0314(uuid, jsonb) from public;
revoke all on function public._r314_sync_staff(uuid, jsonb) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('revoke all on function public._mp_sync_staff(uuid, jsonb) from %I', r);
      execute format('revoke all on function public._mp_sync_staff__pre0314(uuid, jsonb) from %I', r);
      execute format('revoke all on function public._r314_sync_staff(uuid, jsonb) from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._mp_sync_staff(uuid, jsonb) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
