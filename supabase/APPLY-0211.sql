-- APPLY-0211.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Free trial: quotes / events are no longer capped (the 2-new cap stays for leads, inventory items, vendors, staff
-- and venues); my_trial_limits() leaves quotes out; the trial terms version becomes 'trial-2026-10-19' (the
-- trial owner is asked to agree once more - deploy the site with public/trial-facts.js VERSION 'trial-2026-10-19'
-- right after this); NEW clear_menu_template(quote) for "No package / decide later" (dishes kept).
-- No row is written or deleted here. Safe to run twice (the 2nd run changes nothing). ASCII only.
-- No edge function to redeploy.
begin;
-- 0211_trial_quotes_uncapped.sql - CANONICAL forward-only.
-- REQUIRES 0173 (zzzz_tl173_cap / my_trial_limits / _tl173_trial_locked), 0181 (zzzz_tl181_cap + _cap_log /
--          _tl181_used), 0207 (_trial_terms_version), base (event_plan, has_area, assert_quote_org).
--
-- In plain words (owner, r19 "quotes in the trial and the flow"):
--   1  A FREE TRIAL studio may create as many quotes / events as it likes. The 2-new-records cap stays for
--      leads (clients), inventory items, vendors, staff and venues - unchanged. Only the three cap triggers on
--      public.quotes are removed (zzzz_tl173_cap, zzzz_tl181_cap, zzzz_tl181_cap_log); the trigger functions
--      stay (they still serve the other five lists). trial_create_log rows already written for quotes are kept
--      (bookkeeping only, nothing reads them for quotes any more). No row is written or deleted.
--   2  my_trial_limits() no longer lists quotes under "used" and says {"uncapped": ["quotes"]}, so the app
--      never shows "2 of 2 quotes used".
--   3  The free-trial terms changed (events & quotes are no longer capped): _trial_terms_version() becomes
--      'trial-2026-10-19' (= public/trial-facts.js VERSION). As 0207 designed, the trial owner is asked once
--      more to agree (one-time window); earlier agreements stay recorded under their own version.
--   4  NEW clear_menu_template(quote): "No package / decide later" in the flow and the builder. It clears the
--      event's applied menu package (event_plan.package, menu_template, menu_plate_price -> null) so the quote
--      is priced at the studio's default plate price again. Same checks as apply_menu_template (plan edit,
--      own studio's quote, menu not locked). The event's dishes (event_menu_items) are NEVER deleted.
-- Order: on a clean install 0211 runs after 0173 / 0181 and before 0236; 0236 only re-creates the cap trigger
-- FUNCTIONS (not the triggers), so the quotes triggers stay removed. Re-applying 0173 / 0181 by hand would add
-- them back: re-run this file afterwards.
-- Additive + idempotent (drop trigger if exists / create or replace). Safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): re-run 0173 section 1 + 0181 section 4 trigger
-- blocks (they add the quotes triggers when missing) and 0181's my_trial_limits; re-issue
-- _trial_terms_version() = 'trial-2026-10-18'; drop function public.clear_menu_template(uuid).

do $$ begin
  if to_regprocedure('public._tl173_trial_locked(uuid)') is null or to_regprocedure('public.my_trial_limits()') is null then
    raise exception 'STOP: 0173 (trial lockdown) is not applied'; end if;
  if to_regprocedure('public._tl181_used(uuid,text)') is null or to_regclass('public.trial_create_log') is null then
    raise exception 'STOP: 0181 (trial guards) is not applied'; end if;
  if to_regprocedure('public._trial_terms_version()') is null then raise exception 'STOP: 0207 (trial terms) is not applied'; end if;
  if to_regclass('public.event_plan') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.assert_quote_org(uuid)') is null then
    raise exception 'STOP: base (event_plan / has_area / assert_quote_org) is not installed'; end if;
end $$;

-- ---- 1) quotes are not capped in the free trial -------------------------------------------------------------
drop trigger if exists zzzz_tl173_cap on public.quotes;
drop trigger if exists zzzz_tl181_cap on public.quotes;
drop trigger if exists zzzz_tl181_cap_log on public.quotes;

-- ---- 2) what the app may show before the server refuses (quotes left out) ------------------------------------
create or replace function public.my_trial_limits()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-lockdown-0173 + trial-guards-0181 + trial-quotes-0211 (quotes / events are not capped)
declare v_org uuid := public.current_org_id(); v_used jsonb := '{}'::jsonb; t text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._tl173_trial_locked(v_org) then return jsonb_build_object('trial', false); end if;
  foreach t in array array['leads', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    v_used := v_used || jsonb_build_object(t, public._tl181_used(v_org, t));
  end loop;
  return jsonb_build_object('trial', true, 'cap', 2, 'used', v_used, 'uncapped', jsonb_build_array('quotes'));
end $$;

-- ---- 3) the trial terms wording changed: a new version ---------------------------------------------------------
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207 trial-quotes-0211: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-10-19'::text;
$$;

-- ---- 4) "No package / decide later": clear the applied menu package (dishes kept) --------------------------
create or replace function public.clear_menu_template(p_quote uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
-- trial-quotes-0211: the reverse of apply_menu_template for the plan row only; event_menu_items untouched
declare v_locked boolean; v_n integer := 0;
begin
  if auth.uid() is null or not public.has_area('plan', 'edit') then raise exception 'not authorized' using errcode = '42501'; end if;
  perform public.assert_quote_org(p_quote);
  select p.menu_locked into v_locked from public.event_plan p where p.quote_id = p_quote;
  if coalesce(v_locked, false) then
    raise exception 'menu is locked - unlock it to change the package' using errcode = '42501', hint = 'menu_locked';
  end if;
  update public.event_plan p
     set package = null, menu_template = null, menu_plate_price = null, updated_at = now(), updated_by = auth.uid()
   where p.quote_id = p_quote and p.org_id = public.current_org_id()
     and (p.package is not null or p.menu_template is not null or p.menu_plate_price is not null);
  get diagnostics v_n = row_count;
  return jsonb_build_object('cleared', v_n > 0);
end $$;

-- ---- privileges --------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['public.my_trial_limits()', 'public.clear_menu_template(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
  end loop;
  -- 0207: the version helper is read by the definer functions + the service role only
  execute 'revoke all on function public._trial_terms_version() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._trial_terms_version() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._trial_terms_version() from authenticated';
    execute 'grant execute on function public.my_trial_limits() to authenticated';
    execute 'grant execute on function public.clear_menu_template(uuid) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._trial_terms_version() to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 no trial cap trigger on quotes (zzzz_tl173_cap / zzzz_tl181_cap / zzzz_tl181_cap_log)',
     not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass
                  and tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log'))),
  ('02 the cap triggers stay on leads, inventory_items, vendors, crew_members and venues (15)',
     (select count(*) from pg_trigger t where t.tgname in ('zzzz_tl173_cap', 'zzzz_tl181_cap', 'zzzz_tl181_cap_log')
        and t.tgrelid in ('public.leads'::regclass, 'public.inventory_items'::regclass, 'public.vendors'::regclass,
                          'public.crew_members'::regclass, 'public.venues'::regclass)) = 15),
  ('03 my_trial_limits() is the 0211 body (quotes uncapped), signed-in only',
     position('trial-quotes-0211' in (select prosrc from pg_proc where oid = to_regprocedure('public.my_trial_limits()'))) > 0
     and has_function_privilege('authenticated', 'public.my_trial_limits()', 'execute')
     and not has_function_privilege('anon', 'public.my_trial_limits()', 'execute')),
  ('04 trial terms version = trial-2026-10-19 (= public/trial-facts.js VERSION)',
     public._trial_terms_version() = 'trial-2026-10-19'),
  ('05 clear_menu_template(uuid) installed, signed-in only',
     to_regprocedure('public.clear_menu_template(uuid)') is not null
     and has_function_privilege('authenticated', 'public.clear_menu_template(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.clear_menu_template(uuid)', 'execute')),
  ('06 clear_menu_template never deletes dishes (no delete in its body)',
     position('delete' in lower((select prosrc from pg_proc where oid = to_regprocedure('public.clear_menu_template(uuid)')))) = 0)
) v(item, ok) order by item;
