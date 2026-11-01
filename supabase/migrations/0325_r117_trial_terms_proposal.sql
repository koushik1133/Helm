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
