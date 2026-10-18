-- APPLY-0223.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0186.sql (any time after the 1018-c release). Free trial dates, one end date on every screen (L9):
--   * my_trial_status() gives the trial's last day and the days left in the STUDIO's time zone (was the UTC day,
--     so Plan & billing said "trial ends 26 Oct" while the Staff page and the trial strip said 27 Oct), plus the
--     exact end moment (ends_at_exact) and the zone (timezone);
--   * hq_trial_info() (Helm HQ studio page) also returns the studio's time zone.
-- What it touches: 1 internal helper, 2 function bodies re-issued (same signatures + grants). No table, column or
-- policy changed; no row written or deleted. Safe to run twice. ASCII only. No edge function to redeploy.
begin;
-- 0223_trial_dates_studio_zone.sql - CANONICAL forward-only.
-- REQUIRES 0045 (studio_subscriptions), 0058 (my_trial_status, _trial_paid), 0116 (organizations.trial_ends_at),
--          0183 (_trial_effective_end), 0186 (hq_trial_info, trial_extensions, _trial_extend_block, trial_grants).
--
-- In plain words (live production QA, bug L9 - the trial end date differed between screens):
--   A self-serve trial ends at an exact moment, organizations.trial_ends_at = sign-up + 8 days, e.g.
--   2026-10-26 22:00 UTC = Tuesday 27 Oct 03:30 in India. The subscription row keeps only a calendar day,
--   and sign-up stored the UTC day of that moment (26 Oct). my_trial_status() returned that UTC day as
--   ends_at (and counted days_left in UTC), so the plan / billing card said "trial ends 26 Oct" while the
--   Staff page, the trial strip and the reminders (studio zone) said 27 Oct.
--   Now my_trial_status() counts in the STUDIO's time zone (organizations.timezone, default Asia/Kolkata),
--   from the same trial end every other trial screen uses: the 0183 effective end (self-serve end + an
--   approved extension) or, for a trial started from the plan / checkout page (no organizations.trial_ends_at),
--   the end of its subscription trial day (UTC) - the same end as 0236's _tu236_trial_end, written out here so
--   this migration does not depend on 0236:
--     * ends_at    = the last calendar day of the trial in the studio's zone ("2026-10-27"; the day the end
--                    moment falls on - an end at exactly midnight belongs to the day before);
--     * days_left  = calendar days from today (studio zone) to that day, never below 0;
--     * state      = 'ended' from the exact end moment (was: from midnight UTC after the stored day, up to
--                    a day late; for a checkout-started trial the two are the same moment);
--     * NEW keys   ends_at_exact (the end moment) and timezone (the zone the day was counted in).
--   hq_trial_info() (Helm HQ studio page) also returns the studio's timezone, so HQ shows the end in the
--   studio's zone instead of the operator's browser zone. Same body as 0186 plus that one key.
--
-- Changes: 1 helper (_td223_zone), 2 function bodies re-issued with the same signatures (my_trial_status,
-- hq_trial_info); grants re-stated, unchanged. No table, column, index, policy or row is created, changed or
-- deleted. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): re-run 0058 section 6 (my_trial_status) and the
-- hq_trial_info section of 0186; drop function public._td223_zone(uuid).

do $$ begin
  if to_regprocedure('public.my_trial_status()') is null or to_regprocedure('public._trial_paid(uuid)') is null then
    raise exception 'STOP: 0058 (trial status) is not applied'; end if;
  if to_regprocedure('public._trial_effective_end(uuid)') is null then raise exception 'STOP: 0183 (trial expiry) is not applied'; end if;
  if to_regprocedure('public.hq_trial_info(uuid)') is null or to_regprocedure('public._trial_extend_block(uuid)') is null then
    raise exception 'STOP: 0186 (trial extension) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations'
                   and column_name = 'timezone') then raise exception 'STOP: organizations.timezone is missing'; end if;
end $$;

-- ---- 1) the studio's time zone (a missing or unknown zone name -> Asia/Kolkata, never an error) ---------------
create or replace function public._td223_zone(p_org uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
-- trial-dates-0223
declare v text;
begin
  select nullif(btrim(o.timezone), '') into v from public.organizations o where o.id = p_org;
  v := coalesce(v, 'Asia/Kolkata');
  perform now() at time zone v;            -- an unknown zone name raises here
  return v;
exception when others then
  return 'Asia/Kolkata';
end $$;

-- ---- 2) my_trial_status: the end day + days left in the studio's zone ------------------------------------------
create or replace function public.my_trial_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-reminders-0058 trial-dates-0223
declare v_org uuid := public.current_org_id(); s public.studio_subscriptions; v_admin boolean; v_state text := 'none';
  v_tz text; v_end timestamptz; v_day date; v_today date;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_admin := coalesce(public.is_admin(), false);
  select * into s from public.studio_subscriptions where org_id = v_org;
  if s.org_id is not null and s.trial_ends_at is not null and not public._trial_paid(v_org) then
    v_tz := public._td223_zone(v_org);
    -- the one trial end: self-serve end (+ an approved extension), else the end of the subscription's trial day (UTC)
    v_end := coalesce(public._trial_effective_end(v_org), ((s.trial_ends_at + 1)::timestamp at time zone 'UTC'));
    v_day := ((v_end - interval '1 microsecond') at time zone v_tz)::date;
    v_today := (now() at time zone v_tz)::date;
    if s.status = 'trial' then v_state := case when v_end <= now() then 'ended' else 'trial' end;
    elsif s.status = 'past_due' and s.current_period_end is null then v_state := 'ended';
    end if;
  end if;
  return jsonb_build_object('state', v_state, 'status', s.status,
    'ends_at', case when v_state <> 'none' then v_day end,
    'ends_at_exact', case when v_state <> 'none' then v_end end,
    'timezone', case when v_state <> 'none' then v_tz end,
    'days_left', case when v_state = 'trial' then greatest(0, v_day - v_today) when v_state = 'ended' then 0 end,
    'is_admin', v_admin, 'can_pay', v_admin and v_state <> 'none');
end $$;

-- ---- 3) hq_trial_info: + the studio's timezone (0186 body otherwise unchanged) ---------------------------------
create or replace function public.hq_trial_info(p_org uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- one-trial-0186 trial-dates-0223: trial state + the one extension, for the HQ studio page
declare o public.organizations; s public.studio_subscriptions; e public.trial_extensions; v_block text;
begin
  perform public._hq_gate('hq_trial_info', p_org::text);
  select * into o from public.organizations x where x.id = p_org;
  if o.id is null then raise exception 'Unknown studio.' using errcode = '22023'; end if;
  select * into s from public.studio_subscriptions x where x.org_id = p_org;
  select * into e from public.trial_extensions x where x.org_id = p_org;
  v_block := public._trial_extend_block(p_org);
  return jsonb_build_object(
    'org_id', p_org, 'status', s.status, 'trial_source', s.trial_source,
    'is_trial', public._is_trial_org(p_org), 'trial_mode', o.trial_mode,
    'trial_ends_at', coalesce(o.trial_ends_at, (s.trial_ends_at::timestamp at time zone 'UTC')),
    'timezone', public._td223_zone(p_org),
    'locked', public._trial_locked(p_org),
    'had_trial', exists (select 1 from public.trial_grants g where g.org_id = p_org),
    'can_extend', v_block is null, 'why_not', v_block, 'max_days', 7,
    'extension', case when e.org_id is null then null else jsonb_build_object(
      'days', e.days, 'reason', e.reason, 'previous_status', e.previous_status,
      'previous_ends_at', e.previous_ends_at, 'new_ends_at', e.new_ends_at,
      'granted_at', e.granted_at, 'granted_by_email', e.granted_by_email) end);
end $$;

-- ---- 4) grants (unchanged: the helper is internal; the two RPCs signed-in only, gates inside) -------------------
do $$ begin
  revoke all on function public._td223_zone(uuid) from public;
  revoke all on function public.my_trial_status() from public;
  revoke all on function public.hq_trial_info(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._td223_zone(uuid) from anon';
    execute 'revoke all on function public.my_trial_status() from anon';
    execute 'revoke all on function public.hq_trial_info(uuid) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._td223_zone(uuid) from authenticated';
    execute 'grant execute on function public.my_trial_status() to authenticated';
    execute 'grant execute on function public.hq_trial_info(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._td223_zone(uuid) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 my_trial_status + hq_trial_info re-issued (studio zone)',
     position('trial-dates-0223' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_status()')), '')) > 0
     and position('trial-dates-0223' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.hq_trial_info(uuid)')), '')) > 0
     and position('_td223_zone' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_status()')), '')) > 0),
  ('02 grants: the RPCs signed-in only, the helper internal',
     has_function_privilege('authenticated', 'public.my_trial_status()', 'execute')
     and not has_function_privilege('anon', 'public.my_trial_status()', 'execute')
     and has_function_privilege('authenticated', 'public.hq_trial_info(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.hq_trial_info(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public._td223_zone(uuid)', 'execute')
     and not has_function_privilege('anon', 'public._td223_zone(uuid)', 'execute')),
  ('03 zone helper: a bad / missing zone falls back to Asia/Kolkata',
     public._td223_zone(null) = 'Asia/Kolkata'),
  ('04 days counted in the studio zone; ended from the exact end moment',
     position('at time zone v_tz' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_status()')), '')) > 0
     and position('v_end <= now()' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_status()')), '')) > 0
     and position('''timezone'', public._td223_zone(p_org)' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.hq_trial_info(uuid)')), '')) > 0)
) v(item, ok) order by item;
