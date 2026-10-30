-- 0306_r82_referral_pilot.sql - CANONICAL forward-only.
-- REQUIRES 0279 (referral program) and 0298 (referral_lookup without an existence oracle).
--
-- In plain words (R82 owner: "turn Refer a studio on for ONE studio only, as a pilot"):
--   The referral program has one global switch (referral_settings.program_on, default OFF). This adds a small
--   per-studio PILOT LIST next to it: referral_settings.pilot_org_ids (uuid[], empty by default). Only the SQL editor /
--   HQ owner can change it - referral_settings has no API privilege at all (0279), and no new RPC writes it.
--   "Is the program on for this studio?" now means: program_on OR the studio is on the pilot list.
--     * my_referral        - the "Refer a studio" page: the code + numbers show for a pilot studio even while OFF.
--     * _r29_code_problem  - a studio code works while OFF only when its OWNER studio is on the pilot list
--                            (partner codes still need program_on).
--     * referral_attach    - a new studio may attach a code while OFF if any pilot exists; the code itself must
--                            still pass _r29_code_problem (so only pilot codes work), plus every 0279 check.
--     * referral_lookup    - the sign-up page check; while OFF a non-pilot code answers "unknown" (no oracle), and a
--                            working STUDIO code now also returns the referring studio's name ("referrer") so the
--                            sign-up page can say "You were referred by <studio>". Partner codes: no name.
--   Every other rule (one code per new studio, self-referral / fraud checks, 48 h attach window, 60-day link window,
--   14-day hold after the first real payment, pay within 60 days, 12-per-12-months cap, held months for a trial
--   referrer, rate limits) is unchanged - those bodies are not touched. With an empty pilot list every answer is
--   exactly what it was before.
--   Previous bodies are kept once as <name>__pre0306 (no app privilege). Existing grants on live names are preserved
--   (CREATE OR REPLACE keeps privileges). No table / row is deleted; one nullable-safe column is added. Safe to run
--   twice. ASCII only.
-- Goes after 0279 + 0298. [numbering: 0306 = R82 referral pilot brief]

-- ---- 0) preflight ---------------------------------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.referral_settings') is null or to_regprocedure('public.my_referral(text)') is null
     or to_regprocedure('public._r29_code_problem(public.referral_codes)') is null
     or to_regprocedure('public.referral_attach(text,text,timestamptz,boolean,text)') is null
     or to_regprocedure('public.referral_lookup(text)') is null then
    raise exception 'STOP 0306: 0279 (referral program) is not applied'; end if;
  if to_regprocedure('public._r57_ref_misses_over(text)') is null then
    raise exception 'STOP 0306: 0298 (referral_lookup hardening) is not applied'; end if;
end $$;

-- ---- 1) the pilot list (HQ / SQL editor only; referral_settings has no API privilege) -----------------------------------
alter table public.referral_settings add column if not exists pilot_org_ids uuid[] not null default '{}'::uuid[];

-- ---- 2) keep each function's current body once as <name>__pre0306 (no API privilege) -----------------------------------
create or replace function public._r306_keep(p_fn text)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r82-referral-pilot-0306: copy the current body once (never rename)
declare v_oid oid := to_regprocedure(p_fn); v_name text; v_types text; v_def text; v_pre text;
begin
  if v_oid is null then return; end if;
  select p.proname, pg_catalog.oidvectortypes(p.proargtypes) into v_name, v_types from pg_catalog.pg_proc p where p.oid = v_oid;
  v_pre := pg_catalog.format('public.%I(%s)', v_name || '__pre0306', v_types);
  if to_regprocedure(v_pre) is not null then return; end if;
  v_def := pg_catalog.pg_get_functiondef(v_oid);
  v_def := pg_catalog.regexp_replace(v_def, '^CREATE OR REPLACE FUNCTION public\.' || v_name || '\(',
                                     'CREATE OR REPLACE FUNCTION public.' || v_name || '__pre0306(');
  if position(v_name || '__pre0306(' in v_def) = 0 then raise exception 'r82-0306: could not keep %', p_fn; end if;
  execute v_def;
  execute pg_catalog.format('revoke all on function %s from public', v_pre);
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then
    execute pg_catalog.format('revoke all on function %s from anon', v_pre); end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then
    execute pg_catalog.format('revoke all on function %s from authenticated', v_pre); end if;
end $$;
revoke all on function public._r306_keep(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public._r306_keep(text) from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public._r306_keep(text) from authenticated; end if;
end $$;

select public._r306_keep(f) from unnest(array[
  'public.my_referral(text)',
  'public._r29_code_problem(public.referral_codes)',
  'public.referral_attach(text,text,timestamptz,boolean,text)',
  'public.referral_lookup(text)']) f;

-- ---- 3) helpers (internal only) -----------------------------------------------------------------------------------------
create or replace function public._r29_pilot(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r82-referral-pilot-0306: is this studio on the referral pilot list?
  select p_org is not null and coalesce(p_org = any((public._r29_cfg()).pilot_org_ids), false)
$$;

create or replace function public._r29_on_for(p_org uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r82-referral-pilot-0306: the program is on for this studio (switch on, or the studio is a pilot)
  select coalesce((public._r29_cfg()).program_on, false) or public._r29_pilot(p_org)
$$;

create or replace function public._r29_any_on()
returns boolean language sql stable security definer set search_path = '' as $$
  -- r82-referral-pilot-0306: on for anyone at all (switch on, or at least one pilot studio)
  select coalesce((public._r29_cfg()).program_on, false)
      or coalesce(cardinality((public._r29_cfg()).pilot_org_ids), 0) > 0
$$;

-- ---- 4) can a code be used right now? (0279 body; the off check is per owner studio) ------------------------------------
create or replace function public._r29_code_problem(c public.referral_codes)
returns text language plpgsql stable security definer set search_path = '' as $$
-- r82-referral-pilot-0306 (r29-referrals-0279 body): off = program off AND the code's owner studio is not a pilot
begin
  if c.code is null then return 'unknown'; end if;
  if not public._r29_on_for(case when c.kind = 'studio' then c.studio_id end) then return 'off'; end if;
  if not c.active then return 'inactive'; end if;
  if c.kind = 'studio' and (c.studio_id is null or exists (select 1 from public.studio_subscriptions s where s.org_id = c.studio_id and s.status = 'suspended')) then
    return 'inactive'; end if;
  if c.ends_at is not null and c.ends_at < now() then return 'expired'; end if;
  if c.max_uses > 0 and c.uses >= c.max_uses then return 'full'; end if;
  return '';
end $$;

-- ---- 5) the sign-up attach (0279 body; only the first "off" gate changes) -----------------------------------------------
create or replace function public.referral_attach(p_typed text default null, p_link text default null, p_link_at timestamptz default null,
  p_consent boolean default false, p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279 r82-referral-pilot-0306: off only when the switch is off AND there is no pilot studio; the code
-- itself is still checked by _r29_code_problem (a non-pilot code answers off)
declare v_org uuid := public.current_org_id(); s public.referral_settings := public._r29_cfg(); v_t text; v_l text; o record;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if public.is_platform_operator() then return jsonb_build_object('ok', false, 'reason', 'existing'); end if;
  if not public._r29_any_on() then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  if not public._r29_rate('at:' || auth.uid()::text, 10) then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  select x.created_at, x.created_by into o from public.organizations x where x.id = v_org;
  if o.created_by is distinct from auth.uid() or o.created_at < now() - make_interval(hours => s.self_attach_hours) then
    return jsonb_build_object('ok', false, 'reason', 'code_after'); end if;
  v_t := upper(btrim(coalesce(p_typed, ''))); v_l := upper(btrim(coalesce(p_link, '')));
  if v_t <> '' and v_t !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then v_t := ''; end if;
  if v_l <> '' and (v_l !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' or p_link_at is null or p_link_at < now() - make_interval(days => s.link_days)
                    or p_link_at > now() + interval '1 hour') then v_l := ''; end if;
  if v_t <> '' and exists (select 1 from public.referral_codes c where c.code = v_t) then
    return public._r29_attach(v_org, v_t, 'typed', p_consent, left(p_device, 64), null, auth.uid());
  end if;
  if v_l <> '' then return public._r29_attach(v_org, v_l, 'link', p_consent, left(p_device, 64), p_link_at, auth.uid()); end if;
  return jsonb_build_object('ok', false, 'reason', case when v_t <> '' or btrim(coalesce(p_typed, '')) <> '' then 'unknown' else 'none' end);
end $$;

-- ---- 6) the sign-up look-up (0298 body; pilot aware + the referring studio's name) --------------------------------------
create or replace function public.referral_lookup(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r57-0298 (r29-referrals-0279) r82-referral-pilot-0306: switch off and no pilot -> "off" for every code; with a pilot,
-- a code that is not a pilot's answers "unknown" exactly like a code that does not exist (no oracle). A working STUDIO
-- code returns the referring studio's name (the referrer shares the link on purpose); partner codes never do.
declare v text := upper(btrim(coalesce(p_code, ''))); c public.referral_codes; v_prob text;
  v_net text := coalesce(public._r29_hash('ip', public._r29_net()), 'none');
begin
  if v !~ '^[A-Z0-9][A-Z0-9_-]{2,23}$' then return jsonb_build_object('ok', false, 'reason', 'shape'); end if;
  if not public._r29_rate('lk:' || left(v_net, 32), 60) or public._r57_ref_misses_over(v_net) then
    return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  if not public._r29_any_on() then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  select * into c from public.referral_codes where code = v;
  v_prob := public._r29_code_problem(c);
  if v_prob in ('unknown', 'inactive') or (v_prob = 'off' and not coalesce((public._r29_cfg()).program_on, false)) then
    perform public._r29_rate('lkm:' || left(v_net, 32), 1000000);
    return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if v_prob <> '' then return jsonb_build_object('ok', false, 'reason', v_prob); end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', case when c.kind = 'studio' then 'referral' else 'partner' end,
    'offer', public._r29_offer(c), 'offer_type', c.offer_type, 'months', c.offer_months, 'percent', c.offer_percent,
    'for_months', c.offer_for_months, 'ends_at', c.ends_at, 'terms', c.terms,
    'referrer', case when c.kind = 'studio' then (select left(o.name, 80) from public.organizations o where o.id = c.studio_id) end);
end $$;

-- ---- 7) the studio page (0279 body; on for a pilot studio; says whether it is a pilot) ----------------------------------
create or replace function public.my_referral(p_device text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r29-referrals-0279 r82-referral-pilot-0306: shown when the program is on for THIS studio (switch on, or a pilot)
declare v_org uuid := public.current_org_id(); s public.referral_settings := public._r29_cfg(); v_code text; sub record;
  v_ip text := public._hq27_client_ip();
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public._r29_on_for(v_org) then return jsonb_build_object('program_on', false); end if;
  v_code := public._r29_studio_code(v_org);
  if p_device is not null and p_device ~ '^[A-Za-z0-9_-]{8,64}$' then perform public._r29_fp(v_org, 'device', p_device); end if;
  if v_ip is not null then perform public._r29_fp(v_org, 'ip', v_ip); end if;
  select st.status, st.billing_interval, st.current_period_end, hp.code plan_code into sub
    from public.studio_subscriptions st left join public.helm_plans hp on hp.id = st.plan_id where st.org_id = v_org;
  return jsonb_build_object(
    'program_on', true, 'pilot', public._r29_pilot(v_org) and not coalesce(s.program_on, false),
    'code', v_code, 'link_path', '/r/' || v_code,
    'studio', (select o.name from public.organizations o where o.id = v_org),
    'subscription', jsonb_build_object('status', sub.status, 'interval', sub.billing_interval, 'plan_code', sub.plan_code,
                                       'current_period_end', sub.current_period_end, 'paying', public._r29_paying(v_org)),
    'rules', jsonb_build_object('hold_days', s.hold_days, 'pay_within_days', s.pay_within_days, 'link_days', s.link_days,
      'late_code_days', s.late_code_days, 'cap_per_year', s.cap_per_year, 'held_months', s.held_months,
      'frozen_months', s.frozen_months, 'expiry_months', s.expiry_months),
    'clicks', coalesce((select sum(d.clicks) from public.referral_click_days d where d.code = v_code), 0),
    'earned_12m', public._r29_earned_12m(v_org),
    'referrals', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason,
          'signed_up_at', r.signed_up_at, 'first_paid_at', r.first_paid_at, 'hold_until', r.hold_until, 'qualified_at', r.qualified_at,
          'reward_state', (select x.state from public.referral_rewards x where x.referral_id = r.id and x.studio_id = v_org
                            and x.side in ('referrer', 'partner') order by x.created_at desc limit 1))
          || public._r29_label(r.id) order by r.signed_up_at desc)
        from public.referrals r where r.referrer_org = v_org), '[]'::jsonb),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'side', x.side, 'kind', x.kind, 'state', x.state,
          'earned_at', x.earned_at, 'applied_at', x.applied_at, 'applied_from', x.applied_from, 'applied_to', x.applied_to,
          'expires_at', x.expires_at, 'held_until', x.held_until, 'percent', x.percent, 'for_months', x.for_months,
          'from', case when x.side = 'referred' then 'Welcome offer'
                       else coalesce((public._r29_label(x.referral_id)) ->> 'label', 'A studio') end)
          order by x.earned_at, x.id)
        from public.referral_rewards x where x.studio_id = v_org), '[]'::jsonb));
end $$;

-- ---- 8) grants: helpers internal only; live names keep their 0279 grants (re-stated, same as 0279) ---------------------
do $$
declare fn text;
begin
  foreach fn in array array['public._r29_pilot(uuid)', 'public._r29_on_for(uuid)', 'public._r29_any_on()',
                            'public._r29_code_problem(public.referral_codes)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || fn || ' from authenticated'; end if;
  end loop;
  foreach fn in array array['public.my_referral(text)', 'public.referral_attach(text,text,timestamptz,boolean,text)'] loop
    execute 'revoke all on function ' || fn || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || fn || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function ' || fn || ' to authenticated'; end if;
  end loop;
  execute 'revoke all on function public.referral_lookup(text) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.referral_lookup(text) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.referral_lookup(text) to authenticated'; end if;
end $$;

notify pgrst, 'reload schema';
