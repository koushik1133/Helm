-- APPLY-0255.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0244 + APPLY-0248 (already applied on production). Order-independent of 0249-0254.
-- ONE sign-up flow (r22): account + "I agree to the Terms of Service and Privacy Policy" (recorded per person, server time,
-- version-checked) -> verify e-mail -> create studio (name, link, city, team size, event types) -> "Pay now" (paid studio,
-- payment-gated until its first payment / HQ activation) / "Try free for 8 days" / "Contact sales" -> studio setup wizard.
-- Also (auditor r22): operators never create a studio, a light per-person limit on new studios / trials, the login profile
-- keeps the sign-in e-mail, Contact sales + "switch to trial" need the current Terms, a waiting / ended studio can save its
-- own Terms on /checkout, and HQ's empty activation placeholder no longer uses up the owner's free trial.
-- 1 new table, 1 new column, new functions, 4 functions wrapped once (old bodies kept as *__pre0255), 2 trigger functions
-- re-issued with their current bodies + one change each. Nothing deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (login.html sign-up flow, signup-flow.js, plan-cards.js/.css, checkout, pricing page).
--   3  Check: /pricing -> "Pay now" on Studio -> create an account (tick the Terms) -> confirm the e-mail -> name the
--      studio -> Step 4 shows Starter / Studio / Enterprise with Pay now, Try free for 8 days, Contact sales.
--      Pay now -> /checkout opens with Studio picked, "waiting for its first payment"; Pay now there shows the UPI /
--      bank details and "Payment pending". HQ -> Requests shows the request; HQ "Activate plan" opens the studio and the
--      owner's next sign-in lands in Studio setup. A second account: Try free for 8 days -> dashboard + trial welcome.
begin;
-- 0255_create_studio_signup.sql - CANONICAL forward-only.
-- REQUIRES 0045 (studio_account, studio_consent_log, _studio_account_apply, tg_studio_read_only),
--          0056 (helm_billing_settings.terms_version, _checkout_plan_price), 0159 (create_studio wrapper,
--          studio_payment_gate, _studio_payment_pending, my_pending_start_trial), 0183 (tg_studio_read_only body),
--          0186 (tg_trial_grant_0186, trial_grants), 0201 (start_self_serve_trial one-trial wrapper),
--          0244 (request_plan_activation, hq_activate_plan), phase rate_hit (auth_rate_hits).
--
-- In plain words (r22, owner: ONE sign-up flow like Slack / Notion / Zoho - account, verify e-mail, create
-- studio, then choose how to start: "Pay now" on a plan card, or "Try free for 8 days", or "Contact sales"):
--   1  Terms at sign-up. New table account_terms_acceptances: one row per (person, Terms version) with the
--      time (server clock), a short browser name and where it was given (signup / google / checkout). It is
--      written by accept_account_terms(version, user_agent, source) BEFORE any studio exists (the person ticked
--      "I agree to the Terms of Service and Privacy Policy" on the sign-up screen). The version is the one HQ
--      sets (helm_billing_settings.terms_version); a stale page with an old version is refused.
--      my_account_terms_status() tells the sign-up page whether to ask again.
--   2  signup_plan_options(): the active plans with their INR prices for the "choose how to start" cards
--      (signed-in people only, no studio needed; the same prices /checkout shows - nothing invented, the
--      Razorpay ids are never returned).
--   3  create_direct_studio(name, plan, interval, terms_version, user_agent): "Pay now" / "Contact sales" on a
--      plan card. In ONE transaction: records the Terms (person + studio: studio_account.terms_version_accepted,
--      terms_accepted_at and a studio_consent_log row, the existing 0045 way), creates the studio through
--      create_studio() (so the 0159 payment gate applies: the studio opens after its first payment / HQ
--      activation) and writes one audit row with the chosen plan. A person who already has a studio gets it
--      back untouched (result 'exists').
--   4  my_studio_signup_details(city, team_size, event_types): the "create studio" step's city, team size and
--      event types, saved on the caller's own studio (admin only; trial and paid alike). New column
--      studio_account.event_types (same codes as venues.event_types).
--   5  Server guards (auditor r22):
--        * create_studio: a Helm platform operator can never create a studio (start_self_serve_trial already
--          refused them); a light per-person limit (10 new-studio attempts an hour); the login profile always
--          gets the sign-in e-mail (p_email is kept only as the studio's business e-mail).
--        * start_self_serve_trial / my_pending_start_trial: the same light per-person limit.
--        * request_plan_activation (Contact sales / Pay by UPI) and my_pending_start_trial now need the current
--          Terms to be accepted (person or studio) - /checkout always asks and records them first.
--        * read-only guard: a studio that is waiting for its first payment, or an ended trial, can now record the
--          caller's OWN consent (studio_consent_log insert with actor = caller). Before this, saving the Terms on
--          /checkout failed for exactly the studios that must accept them before paying.
--        * one-trial rule (0186): the empty 'trial' placeholder row hq_activate_plan writes for a studio with no
--          subscription row (no trial end, no trial source, no period) is no longer counted as a free trial, so a
--          studio HQ activates straight away does not use up its owner's trial.
--   Nothing existing is deleted or rewritten: 1 new table, 1 new column, new functions; create_studio,
--   start_self_serve_trial, my_pending_start_trial and request_plan_activation are wrapped (previous bodies kept as
--   *__pre0255, renamed once, no app grants); tg_studio_read_only and tg_trial_grant_0186 are re-issued with their
--   current bodies plus the one change each. No DROP / DELETE / TRUNCATE. Additive + idempotent: safe to run twice.
--   ASCII only.
-- ROLLBACK (manual, only if ever needed): for each wrapped function drop the wrapper and rename *__pre0255 back
--   (re-grant execute to authenticated); re-run 0183 (tg_studio_read_only) and 0186 (tg_trial_grant_0186). The new
--   table / column can stay (they only hold consent records / sign-up answers).
-- ============================================================================

do $$ begin
  if to_regprocedure('public.create_studio(text,text,text,text)') is null
     and to_regprocedure('public.create_studio__pre0255(text,text,text,text)') is null then
    raise exception 'STOP: create_studio (0159) is missing'; end if;
  if to_regprocedure('public._studio_payment_pending(uuid)') is null or to_regclass('public.studio_payment_gate') is null then
    raise exception 'STOP: 0159 (direct studio payment gate) is not applied'; end if;
  if to_regprocedure('public._studio_account_apply(uuid,jsonb)') is null or to_regclass('public.studio_consent_log') is null then
    raise exception 'STOP: 0045 (studio_account / consent log) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_billing_settings'
                   and column_name = 'terms_version') then raise exception 'STOP: 0056 (terms_version) is not applied'; end if;
  if to_regprocedure('public._checkout_plan_price(text,text)') is null then raise exception 'STOP: _checkout_plan_price is missing'; end if;
  if to_regprocedure('public.tg_trial_grant_0186()') is null then raise exception 'STOP: 0186 (one trial per e-mail) is not applied'; end if;
  if to_regprocedure('public.request_plan_activation(text,text,text,text,text,text,text,text)') is null
     and to_regprocedure('public.request_plan_activation__pre0255(text,text,text,text,text,text,text,text)') is null then
    raise exception 'STOP: 0244 (request_plan_activation) is not applied'; end if;
  if to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is null
     and to_regprocedure('public.start_self_serve_trial__pre0255(text,text,text,text)') is null then
    raise exception 'STOP: start_self_serve_trial (0201) is missing'; end if;
  if to_regprocedure('public.my_pending_start_trial()') is null and to_regprocedure('public.my_pending_start_trial__pre0255()') is null then
    raise exception 'STOP: my_pending_start_trial (0159) is missing'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP: rate_hit is missing'; end if;
end $$;

-- ---- 1) Terms at sign-up -----------------------------------------------------------------------------------
create table if not exists public.account_terms_acceptances (
  user_id     uuid        not null,
  version     text        not null check (version ~ '^[A-Za-z0-9._-]{1,32}$'),
  accepted_at timestamptz not null default now(),
  user_agent  text        check (user_agent is null or char_length(user_agent) <= 160),
  source      text        not null default 'signup' check (source in ('signup', 'google', 'checkout', 'studio')),
  primary key (user_id, version)
);
comment on table public.account_terms_acceptances is
  '0255: Terms of Service + Privacy Policy accepted at sign-up (per person, per Terms version, server time). Definer functions only.';
alter table public.account_terms_acceptances enable row level security;
revoke all on table public.account_terms_acceptances from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.account_terms_acceptances from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.account_terms_acceptances from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select on table public.account_terms_acceptances to service_role'; end if;
end $$;

create or replace function public._account_terms_version()
returns text language sql stable security definer set search_path = '' as $$
  -- r22-signup-0255
  select b.terms_version from public.helm_billing_settings b where b.id;
$$;

-- the caller (or their studio) has accepted the CURRENT Terms
create or replace function public._account_terms_ok(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r22-signup-0255
  select p_uid is not null and (
       exists (select 1 from public.account_terms_acceptances a where a.user_id = p_uid and a.version = public._account_terms_version())
    or exists (select 1 from public.profiles p join public.studio_account sa on sa.org_id = p.org_id
                where p.id = p_uid and sa.terms_version_accepted is not distinct from public._account_terms_version()
                  and sa.terms_version_accepted is not null));
$$;
revoke all on function public._account_terms_version() from public;
revoke all on function public._account_terms_ok(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._account_terms_version() from anon';
    execute 'revoke all on function public._account_terms_ok(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._account_terms_version() from authenticated';
    execute 'revoke all on function public._account_terms_ok(uuid) from authenticated'; end if;
end $$;

create or replace function public.my_account_terms_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-signup-0255
declare v_uid uuid := auth.uid(); v_ver text := public._account_terms_version(); v_at timestamptz;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select a.accepted_at into v_at from public.account_terms_acceptances a where a.user_id = v_uid and a.version = v_ver;
  return jsonb_build_object('version', v_ver, 'accepted', public._account_terms_ok(v_uid), 'accepted_at', v_at);
end $$;
revoke all on function public.my_account_terms_status() from public, anon;
grant execute on function public.my_account_terms_status() to authenticated;

create or replace function public.accept_account_terms(p_version text, p_user_agent text default null, p_source text default 'signup')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: the person's own "I agree" (no studio needed); insert once, a second call changes nothing
declare v_uid uuid := auth.uid(); v_ver text := public._account_terms_version(); v_ua text; v_src text; v_at timestamptz;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p_version is null or p_version is distinct from v_ver then
    raise exception 'These Terms were updated - reload the page and agree to the current version'
      using errcode = '22023', hint = 'terms_outdated'; end if;
  v_ua := nullif(left(regexp_replace(coalesce(p_user_agent, ''), '[^\x20-\x7e]', '', 'g'), 160), '');
  v_src := case when p_source in ('signup', 'google', 'checkout', 'studio') then p_source else 'signup' end;
  insert into public.account_terms_acceptances(user_id, version, user_agent, source)
    values (v_uid, v_ver, v_ua, v_src)
  on conflict (user_id, version) do nothing;
  select a.accepted_at into v_at from public.account_terms_acceptances a where a.user_id = v_uid and a.version = v_ver;
  return jsonb_build_object('version', v_ver, 'accepted', true, 'accepted_at', v_at);
end $$;
revoke all on function public.accept_account_terms(text, text, text) from public, anon;
grant execute on function public.accept_account_terms(text, text, text) to authenticated;

-- ---- 2) plans for the "choose how to start" cards -----------------------------------------------------------
create or replace function public.signup_plan_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r22-signup-0255: same rows + prices as my_checkout_options (INR), no Razorpay ids, no studio needed
declare b public.helm_billing_settings; v_plans jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into b from public.helm_billing_settings where id;
  select coalesce(jsonb_agg(x - 'id' - 'rzp_monthly' - 'rzp_yearly' order by (x ->> 'sort_order')::int, x ->> 'code'), '[]'::jsonb)
    into v_plans
    from (select public._checkout_plan_price(hp.code, 'INR') x from public.helm_plans hp where hp.active) q
   where x is not null;
  return jsonb_build_object('currency', 'INR', 'plans', v_plans, 'trial_days', public._trial_days(),
    'online_payments_live', coalesce(b.online_payments_live, false), 'terms_version', b.terms_version);
end $$;
revoke all on function public.signup_plan_options() from public, anon;
grant execute on function public.signup_plan_options() to authenticated;

-- ---- 3) create_studio: operators refused, light limit, the login profile keeps the sign-in e-mail -------------
do $$ begin
  if to_regprocedure('public.create_studio__pre0255(text,text,text,text)') is null then
    alter function public.create_studio(text, text, text, text) rename to create_studio__pre0255;
  end if;
end $$;
revoke all on function public.create_studio__pre0255(text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.create_studio__pre0255(text, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.create_studio__pre0255(text, text, text, text) from authenticated'; end if;
end $$;

-- 10 new-studio / new-trial attempts an hour per person (a person can only ever have one studio anyway)
create or replace function public._r22_signup_limit(p_uid uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255
declare v_wait int;
begin
  if p_uid is null then return; end if;
  v_wait := public.rate_hit('studio_create', p_uid::text, 3600, 10);
  if v_wait > 0 then
    raise exception 'Too many attempts - please wait a few minutes and try again' using errcode = '22023', hint = 'rate_limited';
  end if;
end $$;
revoke all on function public._r22_signup_limit(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public._r22_signup_limit(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public._r22_signup_limit(uuid) from authenticated'; end if;
end $$;

create or replace function public.create_studio(p_name text, p_email text default null,
                                                p_currency text default 'INR', p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: operators never get a studio; light per-person limit; p_email is only the business e-mail
declare v_uid uuid := auth.uid(); v_had uuid; v_org uuid; v_biz text;
begin
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then return public.create_studio__pre0255(p_name, null, p_currency, p_timezone); end if;
  if v_uid is not null and coalesce(public.is_platform_operator(), false) then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501', hint = 'operator'; end if;
  perform public._r22_signup_limit(v_uid);
  v_org := public.create_studio__pre0255(p_name, null, p_currency, p_timezone);
  v_biz := lower(btrim(coalesce(p_email, '')));
  if v_org is not null and v_biz ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(v_biz) <= 254 then
    update public.organizations o set business_email = v_biz where o.id = v_org and o.business_email is null and o.created_at = now();
  end if;
  return v_org;
end $$;
revoke all on function public.create_studio(text, text, text, text) from public, anon;
grant execute on function public.create_studio(text, text, text, text) to authenticated, service_role;

-- ---- 4) "Pay now" / "Contact sales": the paid studio, Terms recorded in the same transaction ------------------
create or replace function public.create_direct_studio(p_name text, p_plan text default null, p_interval text default null,
                                                       p_terms_version text default null, p_user_agent text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255
declare v_uid uuid := auth.uid(); v_had uuid; v_org uuid; v_ver text := public._account_terms_version();
  v_plan text; v_iv text; v_name text; v_email text;
begin
  if v_uid is null then raise exception 'must be signed in to create a studio' using errcode = '42501'; end if;
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    return jsonb_build_object('result', 'exists', 'org_id', v_had, 'pending_payment', public._studio_payment_pending(v_had)); end if;
  if coalesce(public.is_platform_operator(), false) then
    raise exception 'Helm HQ accounts can''t create or join a studio.' using errcode = '42501', hint = 'operator'; end if;
  if p_terms_version is null or p_terms_version is distinct from v_ver then
    raise exception 'Please agree to the current Terms of Service and Privacy Policy' using errcode = '22023', hint = 'terms_required'; end if;
  v_name := btrim(regexp_replace(coalesce(p_name, ''), '[\x00-\x1f\x7f]', ' ', 'g'));
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Enter your studio name (2 to 80 characters)' using errcode = '22023'; end if;
  v_plan := nullif(lower(btrim(coalesce(p_plan, ''))), '');
  if v_plan is not null and not exists (select 1 from public.helm_plans hp where hp.code = v_plan and hp.active)
     and v_plan not in ('starter', 'studio', 'enterprise') then
    raise exception 'Choose a plan' using errcode = '22023'; end if;
  v_iv := case when p_interval = 'yearly' then 'yearly' else 'monthly' end;
  -- the person's own record first (kept even if they later leave the studio)
  insert into public.account_terms_acceptances(user_id, version, user_agent, source)
    values (v_uid, v_ver, nullif(left(regexp_replace(coalesce(p_user_agent, ''), '[^\x20-\x7e]', '', 'g'), 160), ''), 'studio')
  on conflict (user_id, version) do nothing;
  v_org := public.create_studio(v_name, null, 'INR', 'Asia/Kolkata');
  if v_org is null then raise exception 'The studio could not be created' using errcode = '22023'; end if;
  select u.email into v_email from auth.users u where u.id = v_uid;
  -- the studio's record, the 0045 way (terms_accepted_at = now() + one studio_consent_log row); same transaction,
  -- so the 0159 payment gate lets these rows in
  perform public._studio_account_apply(v_org, jsonb_build_object('terms_version_accepted', v_ver, 'signup_source', 'direct')
            || case when v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then jsonb_build_object('primary_contact_email', lower(v_email)) else '{}'::jsonb end);
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (v_uid, v_email, 'studio.created_direct', 'organizations', v_org::text,
            jsonb_build_object('plan', v_plan, 'interval', v_iv, 'terms_version', v_ver), v_org, now());
  return jsonb_build_object('result', 'created', 'org_id', v_org, 'plan', v_plan, 'interval', v_iv,
    'terms_version', v_ver, 'pending_payment', public._studio_payment_pending(v_org));
end $$;
revoke all on function public.create_direct_studio(text, text, text, text, text) from public, anon;
grant execute on function public.create_direct_studio(text, text, text, text, text) to authenticated;

-- ---- 5) the "create studio" step's answers ---------------------------------------------------------------------
alter table public.studio_account add column if not exists event_types text[];
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'studio_account_event_types_ck') then
    alter table public.studio_account add constraint studio_account_event_types_ck check (event_types is null or (
      cardinality(event_types) <= 11 and event_types <@ array['wedding', 'reception', 'engagement', 'birthday', 'corporate',
        'product_launch', 'conference', 'political', 'concert', 'festival', 'other']::text[])); end if;
end $$;

create or replace function public.my_studio_signup_details(p_city text default null, p_team_size text default null,
                                                           p_event_types text[] default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: the caller's OWN studio only (admin); every value optional
declare v_org uuid := public.current_org_id(); v_city text; v_types text[]; v_patch jsonb := '{}'::jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  v_city := nullif(btrim(regexp_replace(coalesce(p_city, ''), '[\x00-\x1f\x7f]', ' ', 'g')), '');
  if v_city is not null and char_length(v_city) > 80 then raise exception 'Please keep the city to 80 characters' using errcode = '22023'; end if;
  if p_team_size is not null and p_team_size not in ('1', '2-5', '6-15', '16-50', '51+') then
    raise exception 'Choose a team size' using errcode = '22023'; end if;
  if p_event_types is not null then
    select array_agg(distinct t order by t) into v_types from unnest(p_event_types) t where t is not null;
    if v_types is not null and not (v_types <@ array['wedding', 'reception', 'engagement', 'birthday', 'corporate',
        'product_launch', 'conference', 'political', 'concert', 'festival', 'other']::text[]) then
      raise exception 'Unknown event type' using errcode = '22023'; end if;
  end if;
  if v_city is not null then v_patch := v_patch || jsonb_build_object('city', v_city); end if;
  if p_team_size is not null then v_patch := v_patch || jsonb_build_object('team_size_band', p_team_size); end if;
  if v_patch <> '{}'::jsonb then perform public._studio_account_apply(v_org, v_patch); end if;
  if p_event_types is not null then
    insert into public.studio_account(org_id) values (v_org) on conflict (org_id) do nothing;
    update public.studio_account set event_types = v_types, updated_at = now(), updated_by = auth.uid() where org_id = v_org;
  end if;
  return (select jsonb_build_object('city', sa.city, 'team_size_band', sa.team_size_band, 'event_types', sa.event_types)
            from public.studio_account sa where sa.org_id = v_org);
end $$;
revoke all on function public.my_studio_signup_details(text, text, text[]) from public, anon;
grant execute on function public.my_studio_signup_details(text, text, text[]) to authenticated;

-- ---- 6) light limit on the trial paths + Terms before Contact sales / switch to trial ---------------------------
do $$ begin
  if to_regprocedure('public.start_self_serve_trial__pre0255(text,text,text,text)') is null then
    alter function public.start_self_serve_trial(text, text, text, text) rename to start_self_serve_trial__pre0255;
  end if;
  if to_regprocedure('public.my_pending_start_trial__pre0255()') is null then
    alter function public.my_pending_start_trial() rename to my_pending_start_trial__pre0255;
  end if;
  if to_regprocedure('public.request_plan_activation__pre0255(text,text,text,text,text,text,text,text)') is null then
    alter function public.request_plan_activation(text, text, text, text, text, text, text, text) rename to request_plan_activation__pre0255;
  end if;
end $$;
revoke all on function public.start_self_serve_trial__pre0255(text, text, text, text) from public;
revoke all on function public.my_pending_start_trial__pre0255() from public;
revoke all on function public.request_plan_activation__pre0255(text, text, text, text, text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.start_self_serve_trial__pre0255(text, text, text, text) from anon';
    execute 'revoke all on function public.my_pending_start_trial__pre0255() from anon';
    execute 'revoke all on function public.request_plan_activation__pre0255(text, text, text, text, text, text, text, text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.start_self_serve_trial__pre0255(text, text, text, text) from authenticated';
    execute 'revoke all on function public.my_pending_start_trial__pre0255() from authenticated';
    execute 'revoke all on function public.request_plan_activation__pre0255(text, text, text, text, text, text, text, text) from authenticated'; end if;
end $$;

create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: light per-person limit for a NEW trial; everything else as before (0186 / 0201)
begin
  if auth.uid() is not null and not exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id is not null) then
    perform public._r22_signup_limit(auth.uid());
  end if;
  return public.start_self_serve_trial__pre0255(p_name, p_timezone, p_currency, p_mode);
end $$;
revoke all on function public.start_self_serve_trial(text, text, text, text) from public, anon;
grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated, service_role;

create or replace function public.my_pending_start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: Terms first, light limit; then the 0159 body
begin
  if auth.uid() is not null and public._studio_payment_pending(public.current_org_id()) then
    if not public._account_terms_ok(auth.uid()) then
      raise exception 'Please agree to the Terms of Service and Privacy Policy first' using errcode = '22023', hint = 'terms_required'; end if;
    perform public._r22_signup_limit(auth.uid());
  end if;
  return public.my_pending_start_trial__pre0255();
end $$;
revoke all on function public.my_pending_start_trial() from public, anon;
grant execute on function public.my_pending_start_trial() to authenticated, service_role;

create or replace function public.request_plan_activation(p_plan text, p_interval text, p_studio text, p_name text,
                                                          p_email text, p_phone text default null, p_message text default null,
                                                          p_source text default 'checkout')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r22-signup-0255: a signed-in studio admin must have accepted the current Terms; then the 0244 body
begin
  if auth.uid() is not null and public.current_org_id() is not null and coalesce(public.is_admin(), false)
     and not public._account_terms_ok(auth.uid()) then
    raise exception 'Please agree to the Terms of Service and Privacy Policy first' using errcode = '22023', hint = 'terms_required'; end if;
  return public.request_plan_activation__pre0255(p_plan, p_interval, p_studio, p_name, p_email, p_phone, p_message, p_source);
end $$;
revoke all on function public.request_plan_activation(text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.request_plan_activation(text, text, text, text, text, text, text, text) to authenticated, service_role;

-- ---- 7) read-only guard: 0183 body + the caller's OWN consent record passes ------------------------------------
create or replace function public.tg_studio_read_only()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-orgs-0116: 0045 body; + ended trial studios are read-only
-- direct-studio-0159: + a directly created studio is read-only until its first payment
-- trial-expiry-0183: ended trial = read-only for EVERYONE; only billing / bell / the caller's own rows pass
-- r22-signup-0255: + the caller's OWN consent record (studio_consent_log insert, actor = caller) passes both locks
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
       and public._studio_payment_pending(o) and not public.is_platform_admin()
       and not exists (select 1 from public.organizations x where x.id = o and x.created_at = now()) then
      raise exception 'Choose a plan and complete payment to start using Helm - or start a free trial instead.'
        using errcode = '25006', hint = 'payment_pending';
    end if;
  end loop;
  return coalesce(new, old);
end $$;
revoke all on function public.tg_studio_read_only() from public;

-- ---- 8) one-trial rule: HQ's empty activation placeholder is not a free trial -----------------------------------
create or replace function public.tg_trial_grant_0186()
returns trigger language plpgsql security definer set search_path = '' as $$
-- one-trial-0186
-- r22-signup-0255: the empty 'trial' placeholder hq_activate_plan inserts right before it activates the plan
--                  (no trial end, no trial source, no period) is not a free trial
declare v_uid uuid; v_email text; v_master boolean;
begin
  if new.status is distinct from 'trial' then return null; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'trial' then return null; end if;
  if tg_op = 'INSERT' and new.trial_ends_at is null and new.trial_source is null
     and new.current_period_start is null and new.current_period_end is null then return null; end if;
  begin
    select o.created_by, coalesce(o.is_sample_master, false) into v_uid, v_master
      from public.organizations o where o.id = new.org_id;
    if not found or v_master then return null; end if;
    if v_uid is not null then select u.email into v_email from auth.users u where u.id = v_uid; end if;
    insert into public.trial_grants(org_id, user_id, email_hash, source, started_at, recorded_how)
      values (new.org_id, v_uid, public._trial_email_fingerprint(v_email),
              left(coalesce(new.trial_source, 'trial'), 40), now(), 'trigger')
    on conflict (org_id) do nothing;
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.tg_trial_grant_0186() from public;

notify pgrst, 'reload schema';

commit;

-- VERIFY (read-only; every row must say ok = true)
select item, ok from (values
  ('01 account_terms_acceptances: RLS on, no app grants',
     (select relrowsecurity from pg_class where oid = 'public.account_terms_acceptances'::regclass)
     and not has_table_privilege('authenticated', 'public.account_terms_acceptances', 'select')
     and not has_table_privilege('anon', 'public.account_terms_acceptances', 'select')),
  ('02 new sign-up RPCs: signed-in people only',
     has_function_privilege('authenticated', 'public.accept_account_terms(text, text, text)', 'execute')
     and has_function_privilege('authenticated', 'public.my_account_terms_status()', 'execute')
     and has_function_privilege('authenticated', 'public.signup_plan_options()', 'execute')
     and has_function_privilege('authenticated', 'public.create_direct_studio(text, text, text, text, text)', 'execute')
     and has_function_privilege('authenticated', 'public.my_studio_signup_details(text, text, text[])', 'execute')
     and not has_function_privilege('anon', 'public.accept_account_terms(text, text, text)', 'execute')
     and not has_function_privilege('anon', 'public.create_direct_studio(text, text, text, text, text)', 'execute')
     and not has_function_privilege('anon', 'public.signup_plan_options()', 'execute')),
  ('03 wrappers installed once; the old bodies are not callable by the app',
     position('r22-signup-0255' in (select prosrc from pg_proc where oid = 'public.create_studio(text,text,text,text)'::regprocedure)) > 0
     and position('r22-signup-0255' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) > 0
     and position('r22-signup-0255' in (select prosrc from pg_proc where oid = 'public.my_pending_start_trial()'::regprocedure)) > 0
     and position('r22-signup-0255' in (select prosrc from pg_proc where oid = 'public.request_plan_activation(text,text,text,text,text,text,text,text)'::regprocedure)) > 0
     and not has_function_privilege('authenticated', 'public.create_studio__pre0255(text, text, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.start_self_serve_trial__pre0255(text, text, text, text)', 'execute')
     and not has_function_privilege('authenticated', 'public.my_pending_start_trial__pre0255()', 'execute')
     and not has_function_privilege('authenticated', 'public.request_plan_activation__pre0255(text, text, text, text, text, text, text, text)', 'execute')
     and has_function_privilege('authenticated', 'public.create_studio(text, text, text, text)', 'execute')
     and has_function_privilege('authenticated', 'public.start_self_serve_trial(text, text, text, text)', 'execute')),
  ('04 read-only guard: every lock kept + the own-consent pass',
     (select prosrc from pg_proc where oid = 'public.tg_studio_read_only()'::regprocedure) like '%r22-signup-0255%'
     and (select prosrc from pg_proc where oid = 'public.tg_studio_read_only()'::regprocedure) like '%studio_suspended%'
     and (select prosrc from pg_proc where oid = 'public.tg_studio_read_only()'::regprocedure) like '%trial_ended%'
     and (select prosrc from pg_proc where oid = 'public.tg_studio_read_only()'::regprocedure) like '%payment_pending%'),
  ('05 one-trial rule skips only the empty HQ placeholder',
     (select prosrc from pg_proc where oid = 'public.tg_trial_grant_0186()'::regprocedure) like '%r22-signup-0255%'
     and (select prosrc from pg_proc where oid = 'public.tg_trial_grant_0186()'::regprocedure) like '%trial_grants%'),
  ('06 studio_account.event_types with its check',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_account' and column_name = 'event_types')
     and exists (select 1 from pg_constraint where conname = 'studio_account_event_types_ck')),
  ('07 a Terms version is set (what sign-ups agree to)', coalesce(public._account_terms_version(), '') <> '')
) v(item, ok) order by item;
