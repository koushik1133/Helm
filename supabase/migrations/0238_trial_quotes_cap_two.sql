-- 0238_trial_quotes_cap_two.sql - CANONICAL forward-only.
-- REQUIRES 0173 (_tl173_trial_locked / _tl173_tg_create_cap / my_trial_limits), 0181 (_tl181_used /
--          _tl181_tg_cap_check / _tl181_tg_cap_log / trial_create_log), 0207 + 0212 (_trial_terms_version),
--          0236 (the cap trigger function bodies this file hangs back on public.quotes).
--
-- In plain words (owner, live on the trial, r20: "make sure you are limiting this quotations to two"):
--   1  A FREE TRIAL studio may again create at most 2 NEW quotes / events, exactly as before 0211. The three
--      cap triggers 0211 removed from public.quotes come back - only when missing, with the same definitions
--      0173 / 0181 used: zzzz_tl173_cap + zzzz_tl181_cap (before insert: the 3rd own quote is refused with
--      "Free trial limit reached (2). Upgrade to add more.", 42501, hint trial_cap) and zzzz_tl181_cap_log
--      (after insert: remembers the new quote in trial_create_log, so deleting a quote never frees a slot).
--      The trigger FUNCTIONS are not changed (0236 bodies, shared with the other five capped lists).
--      What counts: the studio's OWN quotes (is_demo = false), soft-deleted / shelved ones included. The sample
--      events every trial is given (SMP-1000 .. SMP-1006, is_demo = true) never count, and Helm's own system
--      work (trial seed / sample clone, no API claims) is never checked. A sample event the studio RENAMES out
--      of the "Demo" prefix becomes its own event (0097 rule, unchanged) and then counts.
--      Quotes a trial created while 0211 was live are kept as they are (nothing deleted or changed); they count
--      as own quotes, so a trial that already has 2 or more simply cannot add another one.
--      Reusing my untouched blank quote (start_blank_quote, 0220) inserts nothing, so it is never refused.
--      Paid studios and the sample master never reach the check (_tl173_trial_locked = false).
--   2  my_trial_limits() lists quotes under "used" again (the 0181 shape, no "uncapped" key), so the app can
--      say "Free trial: 1 of 2 new quotes used" before the server refuses.
--   3  The free-trial terms wording changed back (2 new quotes / events): _trial_terms_version() becomes
--      'trial-2026-10-20' (= public/trial-facts.js VERSION). As 0207 designed, the trial owner is asked once more
--      to agree (one-time window); earlier agreements stay recorded under their own version.
-- Order: after 0211 / 0212 (which it supersedes for these three points) and 0236 (cap function bodies).
-- Additive + idempotent (triggers created only when missing, create or replace). Safe to run twice. No row is
-- written or deleted, no table / column / policy is changed. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): re-run 0211 (drops the three quotes triggers again,
-- my_trial_limits without quotes) and re-issue _trial_terms_version() = 'trial-2026-10-19' (0212 body).

do $$ begin
  if to_regprocedure('public._tl173_trial_locked(uuid)') is null or to_regprocedure('public._tl173_tg_create_cap()') is null
     or to_regprocedure('public.my_trial_limits()') is null then
    raise exception 'STOP: 0173 (trial lockdown) is not applied'; end if;
  if to_regprocedure('public._tl181_used(uuid,text)') is null or to_regprocedure('public._tl181_tg_cap_check()') is null
     or to_regprocedure('public._tl181_tg_cap_log()') is null or to_regclass('public.trial_create_log') is null then
    raise exception 'STOP: 0181 (trial guards) is not applied'; end if;
  if position('''quotes''' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public._tl181_used(uuid,text)'))) = 0 then
    raise exception 'STOP: _tl181_used does not count quotes (expected the 0181 / 0236 body)'; end if;
  if to_regprocedure('public._trial_terms_version()') is null then raise exception 'STOP: 0207 (trial terms) is not applied'; end if;
  if to_regclass('public.quotes') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes'
                      and column_name = 'is_demo') then
    raise exception 'STOP: public.quotes.is_demo (0097) is not installed'; end if;
end $$;

-- ---- 1) quotes are capped at 2 new in the free trial again (same trigger definitions as 0173 / 0181) --------
do $$ begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl173_cap') then
    create trigger zzzz_tl173_cap before insert on public.quotes for each row execute function public._tl173_tg_create_cap();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl181_cap') then
    create trigger zzzz_tl181_cap before insert on public.quotes for each row execute function public._tl181_tg_cap_check();
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = 'zzzz_tl181_cap_log') then
    create trigger zzzz_tl181_cap_log after insert on public.quotes for each row execute function public._tl181_tg_cap_log();
  end if;
end $$;

-- ---- 2) what the app may show before the server refuses (quotes back under "used") ----------------------------
create or replace function public.my_trial_limits()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-lockdown-0173 + trial-guards-0181 + trial-quotes-cap-0238 (quotes / events capped at 2 again)
declare v_org uuid := public.current_org_id(); v_used jsonb := '{}'::jsonb; t text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._tl173_trial_locked(v_org) then return jsonb_build_object('trial', false); end if;
  foreach t in array array['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'] loop
    v_used := v_used || jsonb_build_object(t, public._tl181_used(v_org, t));
  end loop;
  return jsonb_build_object('trial', true, 'cap', 2, 'used', v_used);
end $$;

-- ---- 3) the trial terms wording changed: a new version ---------------------------------------------------------
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207 trial-quotes-0211 trial-email-0212 trial-quotes-cap-0238: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-10-20'::text;
$$;

-- ---- privileges --------------------------------------------------------------------------------------------
do $$
begin
  execute 'revoke all on function public.my_trial_limits() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.my_trial_limits() from anon'; end if;
  -- 0207: the version helper is read by the definer functions + the service role only
  execute 'revoke all on function public._trial_terms_version() from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._trial_terms_version() from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._trial_terms_version() from authenticated';
    execute 'grant execute on function public.my_trial_limits() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._trial_terms_version() to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
