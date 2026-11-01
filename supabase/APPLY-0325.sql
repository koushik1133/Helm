-- APPLY-0325.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0325: ..." if an earlier migration it builds on is missing (0022 / 0039 / 0042 / 0179 / 0207 /
-- 0260 / 0323 - run APPLY-0323.sql first).
-- R117: the agreed free-trial terms now say "nothing is sent to clients" (new version trial-2026-11-01: trial owners are
--   asked to agree once more with the same one-time window - nobody is locked out, old agreements are kept), and the
--   client proposal page can show the trial banner (one new read-only function). Nothing is deleted. Paid studios:
--   nothing changes. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Make sure APPLY-0323.sql (and 0324) have been run on this database (this file stops otherwise).
--   2  Deploy the site (public/trial-facts.js VERSION = trial-2026-11-01) at about the same time: until both match,
--      the "Agree and continue" button answers "These free-trial terms are out of date. Reload the page" (no lock-out:
--      the window can be reloaded and every other page keeps working).
--   3  Paste this whole file and Run. Every VERIFY row at the end (5 rows) must say ok = true.
--   4  In a trial studio: open the dashboard -> the "Free-trial terms" window asks once ("Agree and continue"); open a
--      published proposal link (/<studio>/proposal/<token>) -> the red "Trial simulation" banner is at the top.
begin;
-- 0325_r117_trial_terms_proposal.sql - CANONICAL forward-only. R117 (owner approved): the AGREED free-trial terms
-- now say "nothing is sent to clients" (new version -> re-acceptance), and the client proposal page can show the
-- trial banner. Additive. Safe to run twice. ASCII only.
--
-- In plain words:
--   1) Since 0322 / 0323 / 0324 a free trial is a full SIMULATION: nothing reaches a client (previews instead), the
--      client approves with the test code 000000 and payments are simulated TEST receipts. The agreed trial terms
--      (public/trial-facts.js + terms.html) still said trial e-mail really reaches clients (0212). The wording is
--      fixed, so the terms version moves: _trial_terms_version() = 'trial-2026-11-01' (= HelmTrialFacts.VERSION).
--      Existing trial owners see the SAME one-time "Agree and continue" window on their next dashboard visit
--      (my_trial_terms_status().must_agree is true until they agree to the new version). Nobody is locked out:
--      the window only asks; earlier agreements (trial_terms_acceptances rows) are kept untouched as consent records.
--   2) NEW read-only public RPC public_trial_simulation_for_proposal(p_token) -> {simulation:true|false} only, for the
--      client proposal page (/<studio>/proposal/<token>, proposal-view.html), which uses a proposal share token, not
--      an approval token. An unknown / malformed / unpublished / expired / shelved / cancelled / deleted link -> null.
--      Same posture as 0323 public_trial_simulation: security definer, empty search_path, no write, no rate-limit
--      row, nothing but one boolean is returned.
-- No table / column / row / policy is changed or deleted. Only _trial_terms_version() (a one-line constant, last set
-- by 0238) is re-issued. Goes after 0022 + 0039 + 0042 + 0179 + 0207 + 0238 + 0260 + 0323.
-- ROLLBACK (manual, only if ever needed; no data involved): re-issue _trial_terms_version() = 'trial-2026-10-20' (0238
-- body) with the 0238 public/trial-facts.js; drop function public.public_trial_simulation_for_proposal(text).

do $$
begin
  if to_regprocedure('public._trial_terms_version()') is null or to_regclass('public.trial_terms_acceptances') is null
     or to_regprocedure('public.my_trial_terms_status()') is null then
    raise exception 'STOP 0325: 0207 (trial terms) is not applied'; end if;
  if to_regclass('public.event_proposal') is null or to_regclass('public.quotes') is null then
    raise exception 'STOP 0325: event_proposal / quotes missing'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0325: _tb179_no_send missing - run 0179 first'; end if;
  if to_regprocedure('public.public_trial_simulation(text,text)') is null then
    raise exception 'STOP 0325: 0323 (trial simulation) missing - run APPLY-0323.sql first'; end if;
  if to_regprocedure('public._a260_quote_cancelled(uuid)') is null then raise exception 'STOP 0325: _a260_quote_cancelled missing - run 0260 first'; end if;
  if to_regprocedure('public._a42_quote_shelved(uuid)') is null then raise exception 'STOP 0325: _a42_quote_shelved missing - run 0042 first'; end if;
  if to_regprocedure('public.client_link_deadline(date,uuid,integer)') is null or to_regprocedure('public.client_link_window_days(text)') is null then
    raise exception 'STOP 0325: client_link_deadline / client_link_window_days missing - run 0022 first'; end if;
  if to_regprocedure('public.link_age_expired(timestamptz)') is null or to_regprocedure('public.proposal_link_age_until(uuid)') is null then
    raise exception 'STOP 0325: link_age_expired / proposal_link_age_until missing - run 0039 first'; end if;
end $$;

-- ---- 1) the trial terms wording changed ("nothing is sent to clients"): a new version -------------------------------
create or replace function public._trial_terms_version()
returns text language sql immutable set search_path = '' as $$
  -- trial-terms-0207 trial-quotes-0211 trial-email-0212 trial-quotes-cap-0238 r117-trial-terms-0325: = HelmTrialFacts.VERSION (public/trial-facts.js)
  select 'trial-2026-11-01'::text;
$$;

-- ---- 2) the client proposal page: is this studio on a free trial (simulation)? ------------------------------------------
create or replace function public.public_trial_simulation_for_proposal(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r117-trial-proposal-0325: {simulation} only; an unknown / unpublished / expired / shelved / cancelled link -> null
declare v_ref text := btrim(coalesce(p_token, '')); v_tok uuid; v_q uuid; v_org uuid; v_date date; v_until timestamptz;
begin
  if v_ref = '' or length(v_ref) > 200 then return null; end if;
  if v_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  v_tok := v_ref::uuid;
  select pr.quote_id, q.org_id, q.event_date into v_q, v_org, v_date
    from public.event_proposal pr join public.quotes q on q.id = pr.quote_id
   where pr.share_token = v_tok and pr.published = true and q.deleted_at is null
   limit 1;
  if v_q is null or v_org is null then return null; end if;
  -- the same link checks public_get_proposal makes (0022 window, 0039 auto-expire, 0042 shelved, 0260 cancelled)
  v_until := public.client_link_deadline(v_date, v_org, public.client_link_window_days('proposal'));
  if v_until is not null and now() >= v_until then return null; end if;
  if coalesce(public.link_age_expired(public.proposal_link_age_until(v_tok)), false) then return null; end if;
  if coalesce(public._a42_quote_shelved(v_q), false) or coalesce(public._a260_quote_cancelled(v_q), false) then return null; end if;
  return jsonb_build_object('simulation', coalesce(public._tb179_no_send(v_org), false));
end $$;

-- ---- 3) privileges -------------------------------------------------------------------------------------------------
do $$ declare r text; begin
  -- 0207: the version helper is read by the definer functions + the service role only
  execute 'revoke all on function public._trial_terms_version() from public';
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then execute 'revoke all on function public._trial_terms_version() from anon'; end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._trial_terms_version() from authenticated'; end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public._trial_terms_version() to service_role'; end if;
  -- the proposal page answer: the client pages (anon), like 0323 public_trial_simulation
  execute 'revoke all on function public.public_trial_simulation_for_proposal(text) from public';
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = r) then
      execute format('grant execute on function public.public_trial_simulation_for_proposal(text) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 trial terms version = trial-2026-11-01 (= public/trial-facts.js VERSION)', public._trial_terms_version() = 'trial-2026-11-01'),
  ('02 version helper still closed to the app (anon / authenticated), open to service_role',
     not has_function_privilege('anon', 'public._trial_terms_version()', 'execute')
     and not has_function_privilege('authenticated', 'public._trial_terms_version()', 'execute')
     and has_function_privilege('service_role', 'public._trial_terms_version()', 'execute')),
  ('03 public_trial_simulation_for_proposal(text) exists and is the 0325 body',
     to_regprocedure('public.public_trial_simulation_for_proposal(text)') is not null
     and pg_get_functiondef('public.public_trial_simulation_for_proposal(text)'::regprocedure) like '%r117-trial-proposal-0325%'),
  ('04 the client pages (anon) can call it; read-only (stable), security definer, empty search_path',
     has_function_privilege('anon', 'public.public_trial_simulation_for_proposal(text)', 'execute')
     and (select p.provolatile = 's' and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%'
            from pg_proc p where p.oid = 'public.public_trial_simulation_for_proposal(text)'::regprocedure)),
  ('05 an unknown / malformed link answers null (nothing leaks); earlier agreements are kept',
     public.public_trial_simulation_for_proposal('00000000-0000-4000-8000-000000000000') is null
     and public.public_trial_simulation_for_proposal('not-a-token') is null
     and to_regclass('public.trial_terms_acceptances') is not null)
) v(item, ok);
