-- APPLY-0236.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0203.sql (APPLY-RELEASE-1018.sql runs everything in the right order in one paste).
-- Free trial, one meaning of "in the trial" (QA of the release build, B1 / B12 / B13):
--   * a trial started from the plan / checkout page (no organizations.trial_ends_at) now gets the trial screens
--     (my_trial_org / my_trial_access) and its client can use Test mode confirm on the approval page;
--   * package flow settings and automatic client message / follow-up settings cannot be changed in the trial;
--     the sample data cannot be cleared, reset or switched off from the app during the trial;
--   * the admin's own login-linked staff row no longer uses one of the 2 trial staff slots.
-- What it touches: 8 functions wrapped (old bodies kept as <name>__pre0236, no app grants), 7 function bodies
-- re-issued (same signatures + grants), 1 helper. No table, column or policy changed; no row written or deleted.
-- organizations.trial_ends_at is NOT back-filled (read-only lock + trial retention stay as they are).
-- Safe to run twice. ASCII only.
begin;
-- 0236_trial_definition_unify.sql - CANONICAL forward-only.
-- REQUIRES 0166 (_is_trial_org), 0173 (_tl173_trial_locked / _tl173_guard / _tl173_tg_create_cap),
--          0128 + 0176 (_trial_test_mode_ok / trial_test_mode_for_token), 0183 (_trial_effective_end,
--          _trial_locked, my_trial_org, my_trial_access), 0181 (_tl181_used / cap triggers / trial_create_log),
--          0069 (pkg_settings_set), 0078 (comms_settings_set), 0097 / 0100 / 0127 / 0166 / 0185 (sample data RPCs),
--          0041 (crew_members.profile_id).
--
-- In plain words (local QA of the release build, bugs B1 / B12 / B13; paid studios never reach a new check):
--   B1  ONE meaning of "in the free trial". The caps and the lockdown (0173 / 0181 / 0203) ask the
--       subscription (studio_subscriptions.status = 'trial', _is_trial_org). The trial banner data
--       (my_trial_org / my_trial_access) and the client-approval test mode (_trial_test_mode_ok, used by
--       trial_test_mode_for_token / trial_test_approve) still asked organizations.trial_ends_at, which a trial
--       started from the plan / checkout page (0056 my_start_trial, 0058) never sets. Such a studio was locked
--       down like a trial but got no trial screens and its client could not approve (only real OTP channels,
--       which the trial blocks). Now:
--         * _trial_test_mode_ok = the studio is on its free trial by the subscription (_tl173_trial_locked:
--           status 'trial', not the sample master), no active plan, not read-only (_trial_locked), and the
--           trial end - organizations.trial_ends_at (+ an HQ extension) or, when that is empty, the end of the
--           day studio_subscriptions.trial_ends_at - is not past (no end recorded at all = allowed).
--         * my_trial_org / my_trial_access: same answers as 0183 for a self-serve trial; a studio whose
--           organizations.trial_ends_at is empty is a trial when its subscription is 'trial' (not the sample
--           master), with ends_at = the end of studio_subscriptions.trial_ends_at.
--       organizations.trial_ends_at is NOT back-filled on purpose: the 0183 read-only lock and the 0184 trial
--       retention (data deletion after the trial, behind the owner switch) are keyed on it, and filling it
--       would make checkout-started trials eligible for both. _trial_effective_end / _trial_locked /
--       _trial_expired_at are unchanged. Self-serve sign-up (0180 / 0190 / 0201) still sets both dates.
--   B12 More settings refused on the server in the trial (same-signature wrappers, originals kept as
--       <name>__pre0236 with no app grants): package flow settings (pkg_settings_set) and automatic client
--       messages / follow-ups / low-stock / WhatsApp forwarding settings (comms_settings_set) - "Not available
--       in the free trial. Upgrade to use this." (42501, hint trial_locked). The sample data cannot be
--       cleared, reset or switched from the app while the studio is on its free trial: clear_demo_data,
--       clear_sample_data, reset_demo_data, set_trial_mode, trial_demo_choice, delete_all_sample_data
--       (after upgrading they work exactly as before; seed_demo_data - fill-only - is unchanged).
--   B13 Staff cap: the trial admin's own login-linked staff row ("Linked account", crew_members.profile_id set
--       by the 0041 member sync) no longer uses one of the 2 staff slots. _tl181_used, the 0181 cap check +
--       log and the 0173 cap trigger skip / do not count crew_members rows linked to a login, so 2 staff
--       members can be added by hand. The app can never set profile_id itself (0041 guard).
--
-- Changes: 8 RPCs wrapped (originals kept as <name>__pre0236), 7 function bodies re-issued (same
-- signatures + grants). No table, column, index, policy or row is created, changed or deleted. Additive +
-- idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): for each wrapped f: drop function public.f(args);
-- alter function public.f__pre0236(args) rename to f; grant execute on it to authenticated, service_role;
-- re-run 0128 section 1 (_trial_test_mode_ok), 0183 sections 5 + 6 (my_trial_org / my_trial_access),
-- 0181 (_tl181_used / _tl181_tg_cap_check / _tl181_tg_cap_log) and 0173 section 1 (_tl173_tg_create_cap).

do $$ begin
  if to_regprocedure('public._is_trial_org(uuid)') is null or to_regprocedure('public._tl173_trial_locked(uuid)') is null
     or to_regprocedure('public._tl173_guard()') is null then raise exception 'STOP: 0166 + 0173 (trial lockdown) are not applied'; end if;
  if to_regprocedure('public._trial_effective_end(uuid)') is null or to_regprocedure('public._trial_locked(uuid)') is null
     or to_regprocedure('public.my_trial_org()') is null or to_regprocedure('public.my_trial_access()') is null then
    raise exception 'STOP: 0183 (trial expiry) is not applied'; end if;
  if to_regprocedure('public._trial_test_mode_ok(uuid)') is null then raise exception 'STOP: 0128 (trial test mode) is not applied'; end if;
  if to_regprocedure('public._tl181_used(uuid,text)') is null or to_regclass('public.trial_create_log') is null then
    raise exception 'STOP: 0181 (trial guards) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'crew_members'
                   and column_name = 'profile_id') then raise exception 'STOP: 0041 (crew_members.profile_id) is not applied'; end if;
end $$;

-- ---- B1) one trial end: organizations.trial_ends_at (+ HQ extension), else the subscription's end day -------
create or replace function public._tu236_trial_end(p_org uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  -- trial-unify-0236: the 0183 effective end (self-serve trial + an approved extension); a trial started from
  -- the plan / checkout page has no organizations.trial_ends_at -> the end of its subscription trial day (UTC)
  select coalesce(public._trial_effective_end(p_org),
                  (select (s.trial_ends_at + 1)::timestamp at time zone 'UTC'
                     from public.studio_subscriptions s where s.org_id = p_org and s.trial_ends_at is not null));
$$;

create or replace function public._trial_test_mode_ok(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- helm-0128-trial-test trial-unify-0236: the same "in the free trial" as the caps and the lockdown
  -- (_tl173_trial_locked = subscription status 'trial', not the sample master); no active plan, not read-only,
  -- the trial end (self-serve or checkout-started) not past
  select p_org is not null
     and public._tl173_trial_locked(p_org)
     and not exists (select 1 from public.studio_subscriptions s where s.org_id = p_org and s.status = 'active')
     and not public._trial_locked(p_org)
     and coalesce(public._tu236_trial_end(p_org) > now(), true);
$$;

-- banner data: the 0183 body; a studio without organizations.trial_ends_at is a trial when its subscription is
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119 trial-reminders-0120 trial-expiry-0183 trial-unify-0236
declare v_org uuid := public.current_org_id(); o public.organizations; s public.studio_subscriptions;
  v_locked boolean; v_end timestamptz; v_paid boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org;
  select * into s from public.studio_subscriptions x where x.org_id = v_org;
  v_paid := exists (select 1 from public.subscription_payments sp where sp.org_id = v_org and sp.voided_at is null);
  if s.org_id is null or v_paid
     or not (s.status = 'trial' or (s.status in ('past_due', 'cancelled') and s.trial_ends_at is not null
                                    and s.current_period_end is null))
     or (o.trial_ends_at is null and not public._tl173_trial_locked(v_org)) then
    return jsonb_build_object('is_trial_org', false, 'read_only', false, 'is_admin', coalesce(public.is_admin(), false));
  end if;
  v_end := public._tu236_trial_end(v_org);
  v_locked := public._trial_locked(v_org);
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', v_end,
    'days_left', case when v_end is null then null else greatest(0, ceil(extract(epoch from (v_end - now())) / 86400.0))::int end,
    'ended', coalesce(v_end <= now(), false), 'locked', v_locked, 'read_only', v_locked, 'trial_mode', o.trial_mode,
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'),
    'is_admin', coalesce(public.is_admin(), false));
end $$;

create or replace function public.my_trial_access()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-staff-0126 trial-expiry-0183 trial-unify-0236
declare v_org uuid; o public.organizations; s public.studio_subscriptions; v_locked boolean; v_owner boolean;
  v_end timestamptz;
begin
  if auth.uid() is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.mfa_ok() then return jsonb_build_object('is_trial_org', false); end if;
  v_org := public.current_org_id__pre0043();
  if v_org is null then return jsonb_build_object('is_trial_org', false); end if;
  select * into o from public.organizations x where x.id = v_org;
  select * into s from public.studio_subscriptions x where x.org_id = v_org;
  if o.id is null or s.org_id is null
     or exists (select 1 from public.subscription_payments sp where sp.org_id = v_org and sp.voided_at is null)
     or not (s.status = 'trial' or (s.status in ('past_due', 'cancelled') and s.trial_ends_at is not null
                                    and s.current_period_end is null))
     or (o.trial_ends_at is null and not public._tl173_trial_locked(v_org)) then
    return jsonb_build_object('is_trial_org', false);
  end if;
  v_end := public._tu236_trial_end(v_org);
  v_locked := public._trial_locked(v_org);
  v_owner := o.created_by is not null and o.created_by = auth.uid();
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', v_end,
    'ended', coalesce(v_end <= now(), false), 'locked', v_locked, 'read_only', v_locked, 'is_owner', v_owner,
    'blocked', false,
    'timezone', coalesce(nullif(btrim(o.timezone), ''), 'Asia/Kolkata'));
end $$;

-- ---- B13) staff cap: a login-linked staff row (the admin / a member) is not a staff slot --------------------
create or replace function public._tl181_used(p_org uuid, p_table text)
returns integer language plpgsql stable security definer set search_path = '' as $$
-- trial-guards-0181 trial-unify-0236 (crew_members: rows linked to a login are not counted)
declare n integer;
begin
  if p_org is null or p_table is null
     or p_table not in ('leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues') then return 0; end if;
  if p_table = 'crew_members' then
    select (select count(*) from public.trial_create_log l
             where l.org_id = p_org and l.entity = 'crew_members'
               and not exists (select 1 from public.crew_members c
                                where c.org_id = p_org and c.id::text = l.row_id and c.profile_id is not null))::integer
         + (select count(*) from public.crew_members x
             where x.org_id = p_org and not x.is_demo and x.profile_id is null
               and not exists (select 1 from public.trial_create_log l
                                where l.org_id = p_org and l.entity = 'crew_members' and l.row_id = x.id::text))::integer
      into n;
    return coalesce(n, 0);
  end if;
  execute format('select (select count(*) from public.trial_create_log l where l.org_id = $1 and l.entity = $2)::integer
                       + (select count(*) from public.%I x where x.org_id = $1 and not x.is_demo
                            and not exists (select 1 from public.trial_create_log l
                                             where l.org_id = $1 and l.entity = $2 and l.row_id = x.id::text))::integer', p_table)
    into n using p_org, p_table;
  return coalesce(n, 0);
end $$;

create or replace function public._tl181_tg_cap_check()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: 2 own rows created IN TOTAL per list in the free trial
-- trial-unify-0236: a staff row linked to a login (member sync) is not a slot
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  -- a restored row (same id) that was already counted comes back without using a new slot
  if exists (select 1 from public.trial_create_log l
              where l.org_id = new.org_id and l.entity = tg_table_name and l.row_id = new.id::text) then
    return new;
  end if;
  if public._tl181_used(new.org_id, tg_table_name) >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

create or replace function public._tl181_tg_cap_log()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-guards-0181: remember the own row the trial studio just added (AFTER INSERT: only rows really saved)
-- trial-unify-0236: a staff row linked to a login (member sync) is not logged
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return null; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return null; end if;
  if public._is_system_change() then return null; end if;
  if not public._tl173_trial_locked(new.org_id) then return null; end if;
  insert into public.trial_create_log(org_id, entity, row_id) values (new.org_id, tg_table_name, new.id::text)
    on conflict do nothing;
  return null;
end $$;

create or replace function public._tl173_tg_create_cap()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-lockdown-0173 trial-unify-0236 (crew_members: rows linked to a login are not counted)
declare v_n integer;
begin
  if new.org_id is null or coalesce(new.is_demo, false) then return new; end if;
  if tg_table_name = 'crew_members' and (to_jsonb(new) ->> 'profile_id') is not null then return new; end if;
  if public._is_system_change() then return new; end if;
  if not public._tl173_trial_locked(new.org_id) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:cap:' || tg_table_name || ':' || new.org_id::text, 0));
  if tg_table_name = 'crew_members' then
    select count(*) into v_n from public.crew_members x where x.org_id = new.org_id and not x.is_demo and x.profile_id is null;
  else
    execute format('select count(*) from public.%I x where x.org_id = $1 and not x.is_demo', tg_table_name) into v_n using new.org_id;
  end if;
  if v_n >= 2 then
    raise exception 'Free trial limit reached (2). Upgrade to add more.' using errcode = '42501', hint = 'trial_cap';
  end if;
  return new;
end $$;

-- ---- B12) more trial wrappers (same pattern as 0173 / 0181) -------------------------------------------------
do $$
declare
  f text; v_new boolean; v_old regprocedure; v_pre regprocedure; v_name text; v_args text; v_idargs text; v_ret text; v_call text; n int; g record;
begin
  foreach f in array array[
    'public.pkg_settings_set(jsonb)', 'public.comms_settings_set(jsonb)',
    'public.clear_demo_data()', 'public.clear_sample_data()', 'public.reset_demo_data()',
    'public.set_trial_mode(text)', 'public.trial_demo_choice(text)', 'public.delete_all_sample_data()'] loop
    v_old := to_regprocedure(f);
    if v_old is null then continue; end if;
    select p.proname, pg_get_function_arguments(p.oid), oidvectortypes(p.proargtypes), pg_get_function_result(p.oid), p.pronargs
      into v_name, v_args, v_idargs, v_ret, n from pg_proc p where p.oid = v_old;
    v_pre := to_regprocedure(format('public.%I(%s)', v_name || '__pre0236', v_idargs));
    v_new := false;
    if v_pre is null then
      -- first run: keep the original under __pre0236 (its grants move with it), then build the wrapper
      execute format('alter function public.%I(%s) rename to %I', v_name, v_idargs, v_name || '__pre0236');
      v_new := true;
    end if;
    select string_agg('$' || i, ', ' order by i) into v_call from generate_series(1, greatest(n, 1)) i where i <= n;
    execute format($w$create or replace function public.%I(%s) returns %s language plpgsql volatile security definer set search_path = '' as $b$
-- trial-unify-0236: free trial check, then the original
begin
  perform public._tl173_guard();
  return public.%I(%s);
end $b$
$w$, v_name, v_args, v_ret, v_name || '__pre0236', coalesce(v_call, ''));
    -- grants (only when the wrapper is new; a re-run keeps what is there): wrapper = the original's
    -- grants; the kept original = definer only
    continue when not v_new;
    execute format('revoke all on function public.%I(%s) from public', v_name, v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name, v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name, v_idargs); end if;
    for g in select distinct r.rolname from pg_proc p, lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
              where p.oid = to_regprocedure(format('public.%I(%s)', v_name || '__pre0236', v_idargs)) and a.privilege_type = 'EXECUTE'
                and r.rolname in ('anon', 'authenticated', 'service_role') loop
      execute format('grant execute on function public.%I(%s) to %I', v_name, v_idargs, g.rolname);
    end loop;
    execute format('revoke all on function public.%I(%s) from public', v_name || '__pre0236', v_idargs);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function public.%I(%s) from anon', v_name || '__pre0236', v_idargs); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function public.%I(%s) from authenticated', v_name || '__pre0236', v_idargs); end if;
  end loop;
end $$;

-- ---- privileges (same as before for the re-issued functions) -------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._tu236_trial_end(uuid)', 'public._trial_test_mode_ok(uuid)', 'public.my_trial_org()',
                           'public.my_trial_access()', 'public._tl181_used(uuid,text)', 'public._tl181_tg_cap_check()',
                           'public._tl181_tg_cap_log()', 'public._tl173_tg_create_cap()'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_trial_org() to authenticated';
    execute 'grant execute on function public.my_trial_access() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._tu236_trial_end(uuid) to service_role';
    execute 'grant execute on function public._trial_test_mode_ok(uuid) to service_role';
    execute 'grant execute on function public.my_trial_org() to service_role';
    execute 'grant execute on function public.my_trial_access() to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 8 trial wrappers in place, old bodies kept',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0236') = 8
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.pkg_settings_set(jsonb)')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.comms_settings_set(jsonb)')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.clear_sample_data()')), '')) > 0),
  ('02 wrappers: signed-in users only; kept bodies not callable by the app',
     has_function_privilege('authenticated', 'public.pkg_settings_set(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'public.comms_settings_set(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.clear_demo_data()', 'execute')
     and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0236'
                      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  ('03 one trial definition: test mode + banner data + staff cap re-issued',
     position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._trial_test_mode_ok(uuid)')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_org()')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_access()')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._tl181_used(uuid,text)')), '')) > 0
     and position('trial-unify-0236' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public._tl173_tg_create_cap()')), '')) > 0),
  ('04 every studio on its free trial (subscription) and not ended is in test mode; no paid studio is',
     not exists (select 1 from public.studio_subscriptions s join public.organizations o on o.id = s.org_id
                  where s.status = 'trial' and not coalesce(o.is_sample_master, false) and not public._trial_locked(s.org_id)
                    and coalesce(public._tu236_trial_end(s.org_id) > now(), true) and not public._trial_test_mode_ok(s.org_id))
     and not exists (select 1 from public.studio_subscriptions s where s.status = 'active' and public._trial_test_mode_ok(s.org_id))),
  ('05 helpers internal; banner data signed-in only',
     not has_function_privilege('authenticated', 'public._tu236_trial_end(uuid)', 'execute')
     and not has_function_privilege('anon', 'public._trial_test_mode_ok(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.my_trial_org()', 'execute')
     and not has_function_privilege('anon', 'public.my_trial_org()', 'execute'))
) v(item, ok) order by item;
