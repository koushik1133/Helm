-- APPLY-0210.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Trial sign-up + welcome (round 19):
--   * invite_open_for_email(email) - service role only, used by the invite-signup edge function: before a
--     free-trial sign-up creates anything, "does this e-mail have an OPEN invitation?" -> studio name + role
--     only for the page ("You've been invited to join <Studio> as <role>"); the token never reaches the browser
--     (the function e-mails the Join link to that same address). Any other e-mail -> nothing.
--   * trial_welcome_save(name, city, state, phone, country) - the trial welcome's "Name your studio" step with
--     City + State (Indian states list) + Country India (fixed for the free trial); phone stays optional.
--     Saved to the studio (name, location, brand.billing city / state / country; the 0089 trigger mirrors
--     organizations.country / tax_region). The old 3-argument step keeps working for cached pages.
-- No table / column is created or changed, no row is deleted, no existing function body changes.
-- Safe to run twice (the 2nd run changes nothing). ASCII only.
-- After it: redeploy the edge function invite-signup, then deploy the app (login.html, auth-confirm, trial-demo.js,
-- store-api.js ...). Without this file the app still works (the invite check is skipped, the welcome falls back
-- to the old step).
begin;
-- 0210_signup_invite_location.sql - CANONICAL forward-only.
-- REQUIRES phase83 (public.invitations), 0089 (organizations.country / tax_region + the brand.billing sync
--          trigger zz_org_country_sync), 0166 (organizations.is_sample_master), 0167 (trial_welcome_setup).
--
-- In plain words (owner round 19, trial sign-up + welcome):
--   * invite_open_for_email(email) - SERVICE ROLE ONLY (the invite-signup edge function). Before a free-trial
--     sign-up creates anything, the sign-up page asks "does this e-mail have an OPEN invitation?" (pending,
--     not expired). For ONE e-mail it returns the newest open invitation's studio name + role (+ its token and
--     expiry, which the edge function uses ONLY to e-mail the Join link to that same address - the token is
--     never sent to the browser). Any other e-mail -> {"found": false}. Nothing is written. Rate limiting is
--     done by the edge function (per IP + per e-mail). anon / authenticated cannot call it.
--   * trial_welcome_save(name, city, state, phone, country) - the trial welcome's "Name your studio" step now
--     also asks the State (Indian states list = public/country-profile.js IN_STATES) and shows Country = India
--     (fixed for the free trial: any other country is refused, 22023). It runs the existing 0167
--     trial_welcome_setup (same checks: signed-in admin of their OWN free-trial studio; name, city, phone,
--     link slug, audit row) and then MERGES city / state / country 'IN' into organizations.brand.billing
--     (every other billing key kept); the 0089 trigger mirrors them into organizations.country /
--     tax_region. Phone stays optional. A wrong state is refused (22023) before anything is saved.
--   No table or column is created, changed or dropped; no row is deleted; no existing function body changes.
--   Additive + idempotent: create or replace of two NEW functions + grants. Safe to run twice. ASCII only.
-- ============================================================================

do $$ begin
  if to_regclass('public.invitations') is null then
    raise exception '0210: public.invitations (phase83) is missing'; end if;
  if to_regprocedure('public.trial_welcome_setup(text, text, text)') is null then
    raise exception '0210: trial_welcome_setup (0167) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0210: organizations.is_sample_master (0166) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'tax_region') then
    raise exception '0210: organizations.tax_region (0089) is missing'; end if;
end $$;

-- ---- 1) the Indian states + union territories (same list as public/country-profile.js IN_STATES) ----------
create or replace function public._in_states_0210()
returns text[] language sql immutable set search_path = '' as $$
  -- signup-invite-0210: the 36 Indian states / union territories (trial welcome "State")
  select array['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh',
    'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
    'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra',
    'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal']::text[]
$$;

-- ---- 2) open invitation for ONE e-mail (service role only) --------------------------------------------------
create or replace function public.invite_open_for_email(p_email text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- signup-invite-0210: the newest pending + unexpired invitation for exactly this e-mail (service role only).
-- Studio name + role for the sign-up page; token + expiry only for the edge function's own Join e-mail.
declare v_em text := lower(btrim(coalesce(p_email, ''))); v record;
begin
  if v_em = '' or char_length(v_em) > 254 or v_em !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}$' then
    return jsonb_build_object('found', false);
  end if;
  select i.token, i.role, i.expires_at, i.invited_by, o.name as studio
    into v
    from public.invitations i
    join public.organizations o on o.id = i.org_id
   where lower(btrim(coalesce(i.email, ''))) = v_em
     and i.status = 'pending'
     and i.expires_at is not null and i.expires_at > now()
     and not coalesce(o.is_sample_master, false)
   order by i.created_at desc nulls last, i.id
   limit 1;
  if v.token is null then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object('found', true, 'studio', left(coalesce(v.studio, ''), 120), 'role', coalesce(v.role, ''),
    'token', v.token, 'expires_at', v.expires_at, 'invited_by', v.invited_by);
end $$;

-- ---- 3) the trial welcome "Name your studio" step with City + State + Country (India) ------------------------
create or replace function public.trial_welcome_save(p_name text, p_city text, p_state text,
                                                     p_phone text default null, p_country text default 'IN')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- signup-invite-0210: 0167 trial_welcome_setup + state / country (India only) merged into brand.billing
declare v_org uuid := public.current_org_id(); v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_state text := nullif(btrim(coalesce(p_state, '')), ''); v_cc text := upper(btrim(coalesce(p_country, 'IN'))); r jsonb;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_cc not in ('IN', 'INDIA') then
    raise exception 'The free trial is for studios in India.' using errcode = '22023'; end if;
  if v_city is null then
    raise exception 'Enter your city.' using errcode = '22023'; end if;
  if v_state is null then
    raise exception 'Choose your state.' using errcode = '22023'; end if;
  -- the exact list name (case-insensitive input)
  select s into v_state from unnest(public._in_states_0210()) s where lower(s) = lower(v_state) limit 1;
  if v_state is null then
    raise exception 'Choose a state from the list.' using errcode = '22023'; end if;
  -- name / city / phone / slug / audit: exactly the 0167 step (its own trial + admin checks)
  r := public.trial_welcome_setup(p_name, v_city, p_phone);
  update public.organizations o
     set brand = coalesce(case when jsonb_typeof(o.brand) = 'object' then o.brand else null end, '{}'::jsonb)
               || jsonb_build_object('billing',
                    coalesce(case when jsonb_typeof(o.brand -> 'billing') = 'object' then o.brand -> 'billing' else null end, '{}'::jsonb)
                    || jsonb_build_object('city', v_city, 'state', v_state, 'country', 'IN'))
   where o.id = v_org;
  return coalesce(r, '{}'::jsonb) || jsonb_build_object('state', v_state, 'country', 'IN');
end $$;

-- ---- 4) privileges --------------------------------------------------------------------------------------------
revoke all on function public._in_states_0210() from public;
revoke all on function public.invite_open_for_email(text) from public;
revoke all on function public.trial_welcome_save(text, text, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public._in_states_0210() from anon';
    execute 'revoke all on function public.invite_open_for_email(text) from anon';
    execute 'revoke all on function public.trial_welcome_save(text, text, text, text, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public._in_states_0210() from authenticated';
    execute 'revoke all on function public.invite_open_for_email(text) from authenticated';
    execute 'grant execute on function public.trial_welcome_save(text, text, text, text, text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.invite_open_for_email(text) to service_role';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 invite_open_for_email exists, SECURITY DEFINER, empty search_path',
     coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.invite_open_for_email(text)')), false)),
  ('02 invite_open_for_email: service role only (anon / authenticated cannot call it)',
     has_function_privilege('service_role', 'public.invite_open_for_email(text)', 'execute')
     and not has_function_privilege('anon', 'public.invite_open_for_email(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.invite_open_for_email(text)', 'execute')),
  ('03 trial_welcome_save exists, SECURITY DEFINER, signed-in only',
     coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.trial_welcome_save(text,text,text,text,text)')), false)
     and has_function_privilege('authenticated', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')),
  ('04 Indian states list: 36 names, not callable by the app',
     array_length(public._in_states_0210(), 1) = 36
     and not has_function_privilege('anon', 'public._in_states_0210()', 'execute')
     and not has_function_privilege('authenticated', 'public._in_states_0210()', 'execute')),
  ('05 the old welcome step trial_welcome_setup(text,text,text) is unchanged and still callable',
     to_regprocedure('public.trial_welcome_setup(text,text,text)') is not null
     and has_function_privilege('authenticated', 'public.trial_welcome_setup(text,text,text)', 'execute')),
  ('06 an unknown e-mail answers nothing', public.invite_open_for_email('nobody-0210-verify@example.invalid') = '{"found": false}'::jsonb),
  ('07 the 0089 billing mirror trigger is in place', exists (select 1 from pg_trigger where tgname = 'zz_org_country_sync' and tgrelid = 'public.organizations'::regclass))
) v(item, ok) order by item;
