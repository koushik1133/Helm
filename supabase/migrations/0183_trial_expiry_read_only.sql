-- 0183_trial_expiry_read_only.sql - CANONICAL forward-only. REQUIRES 0045 (read-only guard zzz_studio_read_only),
-- 0058 (_trial_paid, subscription_payments), 0116 (_trial_locked, organizations.trial_ends_at), 0120 (my_trial_org),
-- 0126 (_trial_member_blocked, my_trial_access, current_org_id trial gate), 0159 (guard body + payment_pending),
-- 0166 (_is_trial_org, organizations.is_sample_master), 0151 (wa_proposal_* tables, optional).
--
-- In plain words (owner post-trial policy 2026-10-18, items 1, 6 and 10):
--   1) When the free trial ends (8 days, or later if Helm approved an extension) and the studio has not
--      paid, the studio becomes READ-ONLY for EVERYONE in it - the owner and every invited member.
--      Reading stays open; every add / edit / delete of studio data is refused by the database
--      (SQLSTATE 25006, hint 'trial_ended') with the owner's words:
--        "Your trial has ended. Your data is preserved and available in read-only mode.
--         Upgrade now to continue creating and editing records."
--   2) Invited members are no longer locked out after the trial (0126 blocked them): they sign in,
--      land in the studio and see everything read-only, like the owner. Memberships were never
--      touched, so nothing has to be restored.
--   3) Which studios: decided by the SUBSCRIPTION (studio_subscriptions.status), never by
--      organizations.trial_ends_at alone - status 'trial', or a trial that lapsed to 'past_due' /
--      'cancelled' with no paid period and no payment ever recorded. A studio that has paid at least
--      once, or is 'active', is never trial-locked (a paid studio that converted from a trial keeps
--      its old trial date and is now unaffected). organizations.trial_ends_at is used only as the
--      exact end moment of the 8-day free trial (legacy HQ / checkout trials without it keep today's
--      behaviour: never trial-locked). The sample master studio is never locked.
--   4) Extension: _trial_effective_end(org) = the free-trial end, or the end of the day HQ moved
--      studio_subscriptions.trial_ends_at to, whichever is later (same rule 0116 used). An approved
--      extension that moves either date simply moves the lock; nothing else to change.
--   5) Still allowed while read-only (so people can view, upgrade and keep their own account tidy):
--      billing details / Terms (studio_account), the bell (notifications), the caller's OWN profile
--      and personal rows (profiles, member_profiles, dashboard layout, recent records, saved views,
--      notification mutes / personal notification prefs) and marking chat as read (own plain member row +
--      last_read_at only). Another person's
--      profile or role can no longer be changed while read-only.
--   6) Uploads: a restrictive storage policy refuses new / changed / deleted files from a signed-in
--      member of a read-only trial studio (own profile photo still allowed).
--   7) The WhatsApp proposal tables (0151, created after the 0136 catch-up) get the same read-only
--      guard as every other studio table (only if missing).
--   8) my_trial_org() / my_trial_access(): is_trial_org only while the subscription is (or lapsed
--      from) the free trial, ends_at = the effective end, + read_only; blocked is always false.
--
-- ZERO DATA LOSS / paid studios unaffected: additive + idempotent. No table, column or row is created,
-- changed or deleted (only functions, two triggers on the WhatsApp proposal tables if missing, and three
-- storage policies). Every function keeps its signature and grants (create or replace keeps the OID, so
-- RLS policies that call current_org_id() are untouched). The set of studios this locks is a SUBSET of
-- what the 0116 rule locked (plus their invited members, who were fully blocked before). Safe to run twice.
-- ROLLBACK (manual, only if ever needed): re-run 0116 section 2 (_trial_locked), 0159 section 3
-- (tg_studio_read_only), 0120 section 6 (my_trial_org) and 0126 (whole file); drop the
-- trial_ro_storage_* policies and public.trial_storage_write_ok(text). No data is touched either way.
-- ASCII only.

do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is null or to_regprocedure('public._studio_writable(uuid)') is null then
    raise exception '0183: apply 0045 (read-only guard) first'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null or to_regprocedure('public.my_trial_org()') is null then
    raise exception '0183: apply 0116 + 0120 (free trial) first'; end if;
  if to_regprocedure('public._trial_member_blocked(uuid)') is null or to_regprocedure('public.my_trial_access()') is null
     or to_regprocedure('public.current_org_id__pre0043()') is null then
    raise exception '0183: apply 0043 + 0126 (trial staff access) first'; end if;
  if to_regprocedure('public._studio_payment_pending(uuid)') is null then
    raise exception '0183: apply 0159 (direct studio plan gate) first'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                      and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0183: apply 0166 (trial sandbox) first'; end if;
end $$;

-- ---- 1) the free trial's end, including an approved extension ---------------------------------------
create or replace function public._trial_effective_end(p_org uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- trial-expiry-0183: the 8-day free-trial end (organizations.trial_ends_at), or the end of the day HQ moved
  -- studio_subscriptions.trial_ends_at to (an approved extension), whichever is later. NULL = no free trial.
  select case
           when o.trial_ends_at is null then null
           when s.trial_ends_at is not null and s.trial_ends_at > (o.trial_ends_at at time zone 'UTC')::date
             then greatest(o.trial_ends_at, ((s.trial_ends_at + 1)::timestamp at time zone 'UTC'))
           else o.trial_ends_at
         end
    from public.organizations o
    left join public.studio_subscriptions s on s.org_id = o.id
   where o.id = p_org;
$$;

-- ---- 2) read-only after the free trial (same name + signature as 0116; every caller follows) ----------
-- true = the subscription is the free trial (or lapsed from it unpaid), the effective end has passed and
-- the studio has never paid. Paid / active / converted studios: always false.
create or replace function public._trial_locked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-orgs-0116 trial-expiry-0183: status-based (studio_subscriptions), never trial_ends_at alone
  select p_org is not null
     and exists (select 1 from public.organizations o
                   join public.studio_subscriptions s on s.org_id = o.id
                  where o.id = p_org
                    and not coalesce(o.is_sample_master, false)
                    and (s.status = 'trial'
                         or (s.status in ('past_due', 'cancelled') and s.trial_ends_at is not null
                             and s.current_period_end is null)))
     and not exists (select 1 from public.subscription_payments sp where sp.org_id = p_org and sp.voided_at is null)
     and coalesce(public._trial_effective_end(p_org) <= now(), false);
$$;

-- ---- 3) invited members keep READ-ONLY access (policy 6): nobody is blocked from the studio ------------
-- current_org_id() (0126) still asks this; it now always answers false, so a member of an ended trial
-- gets the studio back (reads per RLS) and the write guard below refuses every change.
create or replace function public._trial_member_blocked(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-staff-0126 trial-expiry-0183: never blocked; an ended trial is read-only for everyone instead
  select false;
$$;

-- ---- 4) the read-only guard: 0159 body; trial branch = owner's text + own-rows-only exceptions -----------
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios are read-only
-- direct-studio-0159: + a directly created studio is read-only until its first payment
-- trial-expiry-0183: ended trial = read-only for EVERYONE; only billing / bell / the caller's own rows pass
declare
  v_role text := coalesce(auth.jwt() ->> 'role', '');
  v_how text := tg_argv[0];
  v_orgs uuid[] := '{}';
  v_key text; r jsonb; o uuid;
  v_uid text := auth.uid()::text;
  v_new jsonb; v_old jsonb; v_free boolean := null;
begin
  if v_role not in ('authenticated', 'anon') then return coalesce(new, old); end if;      -- service role / maintenance
  if not exists (select 1 from public.studio_subscriptions s where s.status = 'suspended')
     and not exists (select 1 from public.organizations x where x.trial_ends_at is not null and x.trial_ends_at <= now())
     and not exists (select 1 from public.studio_payment_gate g join public.organizations x on x.id = g.org_id
                      where x.trial_ends_at is null) then
    return coalesce(new, old); end if;                                                      -- fast path
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
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
      v_free := tg_table_name in ('studio_account', 'notifications')
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
    -- direct studio, not paid yet: only billing details / Terms / own profile / the studio row.
    -- The rows create_studio writes in the SAME transaction that created the studio still go in
    -- (organizations.created_at defaults to now(), the transaction start time).
    if tg_table_name not in ('studio_account', 'profiles', 'user_dashboard_prefs', 'notifications', 'organizations')
       and public._studio_payment_pending(o) and not public.is_platform_admin()
       and not exists (select 1 from public.organizations x where x.id = o and x.created_at = now()) then
      raise exception 'Choose a plan and complete payment to start using Helm - or start a free trial instead.'
        using errcode = '25006', hint = 'payment_pending';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

-- ---- 5) banner data: status-based trial, effective end, read_only (0120 body otherwise) ----------------
-- {is_trial_org, name, ends_at, days_left, ended, locked, read_only, trial_mode, timezone, is_admin}; members only.
-- is_trial_org is false once the studio is paid / active (a converted studio keeps its old trial date).
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119 trial-reminders-0120 trial-expiry-0183
declare v_org uuid := public.current_org_id(); o public.organizations; s public.studio_subscriptions;
  v_locked boolean; v_end timestamptz; v_paid boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org;
  select * into s from public.studio_subscriptions x where x.org_id = v_org;
  v_paid := exists (select 1 from public.subscription_payments sp where sp.org_id = v_org and sp.voided_at is null);
  if o.trial_ends_at is null or s.org_id is null or v_paid
     or not (s.status = 'trial' or (s.status in ('past_due', 'cancelled') and s.trial_ends_at is not null
                                    and s.current_period_end is null)) then
    return jsonb_build_object('is_trial_org', false, 'read_only', false, 'is_admin', coalesce(public.is_admin(), false));
  end if;
  v_end := coalesce(public._trial_effective_end(v_org), o.trial_ends_at);
  v_locked := public._trial_locked(v_org);
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', v_end,
    'days_left', greatest(0, ceil(extract(epoch from (v_end - now())) / 86400.0))::int,
    'ended', v_end <= now(), 'locked', v_locked, 'read_only', v_locked, 'trial_mode', o.trial_mode,
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'),
    'is_admin', coalesce(public.is_admin(), false));
end $$;

-- ---- 6) my_trial_access: 0126 body; nobody is blocked; same trial rule + effective end -------------------
create or replace function public.my_trial_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-staff-0126 trial-expiry-0183
declare v_org uuid; o public.organizations; s public.studio_subscriptions; v_locked boolean; v_owner boolean;
  v_end timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.mfa_ok() then return jsonb_build_object('is_trial_org', false); end if;
  v_org := public.current_org_id__pre0043();
  if v_org is null then return jsonb_build_object('is_trial_org', false); end if;
  select * into o from public.organizations x where x.id = v_org;
  select * into s from public.studio_subscriptions x where x.org_id = v_org;
  if o.id is null or o.trial_ends_at is null or s.org_id is null
     or exists (select 1 from public.subscription_payments sp where sp.org_id = v_org and sp.voided_at is null)
     or not (s.status = 'trial' or (s.status in ('past_due', 'cancelled') and s.trial_ends_at is not null
                                    and s.current_period_end is null)) then
    return jsonb_build_object('is_trial_org', false);
  end if;
  v_end := coalesce(public._trial_effective_end(v_org), o.trial_ends_at);
  v_locked := public._trial_locked(v_org);
  v_owner := o.created_by is not null and o.created_by = auth.uid();
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', v_end,
    'ended', v_end <= now(), 'locked', v_locked, 'read_only', v_locked, 'is_owner', v_owner,
    'blocked', false,
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'));
end $$;

-- ---- 7) uploads: refused from a signed-in member of a read-only trial studio (own avatar allowed) ---------
create or replace function public.trial_storage_write_ok(p_bucket text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-expiry-0183
  select coalesce(p_bucket, '') = 'member-avatars'
      or auth.uid() is null
      or not public._trial_locked(public.current_org_id());
$$;

do $$ begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists trial_ro_storage_insert on storage.objects';
  execute 'create policy trial_ro_storage_insert on storage.objects as restrictive for insert to anon, authenticated '
          'with check (public.trial_storage_write_ok(bucket_id))';
  execute 'drop policy if exists trial_ro_storage_update on storage.objects';
  execute 'create policy trial_ro_storage_update on storage.objects as restrictive for update to anon, authenticated '
          'using (public.trial_storage_write_ok(bucket_id)) with check (public.trial_storage_write_ok(bucket_id))';
  execute 'drop policy if exists trial_ro_storage_delete on storage.objects';
  execute 'create policy trial_ro_storage_delete on storage.objects as restrictive for delete to anon, authenticated '
          'using (public.trial_storage_write_ok(bucket_id))';
end $$;

-- ---- 8) the WhatsApp proposal tables get the read-only guard (only if missing) ---------------------------
do $$ declare t text; begin
  foreach t in array array['wa_proposal_optins', 'wa_proposal_audit'] loop
    if to_regclass('public.' || t) is not null
       and exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || t) and a.attname = 'org_id' and not a.attisdropped)
       and not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass('public.' || t) and g.tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
end $$;

-- ---- 9) privileges (same as before for the re-issued functions) -----------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._trial_effective_end(uuid)', 'public._trial_locked(uuid)', 'public._trial_member_blocked(uuid)',
                           'public.my_trial_org()', 'public.my_trial_access()', 'public.trial_storage_write_ok(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_trial_org() to authenticated';
    execute 'grant execute on function public.my_trial_access() to authenticated';
    execute 'grant execute on function public.trial_storage_write_ok(text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.trial_storage_write_ok(text) to anon';   -- storage policy runs as the caller
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._trial_effective_end(uuid) to service_role';
    execute 'grant execute on function public._trial_locked(uuid) to service_role';
    execute 'grant execute on function public._trial_member_blocked(uuid) to service_role';
    execute 'grant execute on function public.my_trial_org() to service_role';
    execute 'grant execute on function public.my_trial_access() to service_role';
    execute 'grant execute on function public.trial_storage_write_ok(text) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
