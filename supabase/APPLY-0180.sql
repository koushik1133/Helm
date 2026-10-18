-- APPLY-0180.sql - paste into the Supabase SQL editor (staging first, then production).
-- Trial sign-up flow: every NEW free trial gets the sample data + India defaults (no "own data"
-- choice any more), a server-side welcome flag so the 2-step welcome + tour also show when the
-- e-mail confirm link is opened on another device, and the free-trial owner is not forced
-- through /profile-setup before the welcome.
-- What it touches: organizations gets ONE new nullable column (trial_welcome_pending); 2 new
-- functions (my_trial_welcome_pending, trial_welcome_set); 2 replaced with the same signature
-- (start_self_serve_trial, my_profile_status). No existing row is changed. Paid studios are
-- unaffected. No DROP / DELETE / TRUNCATE. Safe to run twice (the 2nd run changes nothing).
begin;
-- 0180_trial_signup_flow.sql - CANONICAL forward-only.
-- REQUIRES 0041 (my_profile_status), 0116 (_trial_locked), 0119 (start_self_serve_trial),
--          0166 (_is_trial_org, organizations.is_sample_master), 0177 (India trigger on organizations).
--
-- In plain words:
--   * Sign-up no longer asks "demo data or own data". start_self_serve_trial() always starts the
--     free trial WITH the sample data and always on INR / Asia/Kolkata, whatever the browser
--     sends (an old cached page that still sends 'own' or a US time zone gets the same trial).
--     Same signature and grants, so the app keeps working while the new page loads.
--   * New nullable column organizations.trial_welcome_pending (the "show the 2-step welcome"
--     flag). start_self_serve_trial() sets it to true for the studio it has just created. The
--     dashboard asks my_trial_welcome_pending(), so the welcome (and then the tour) also shows
--     when the e-mail confirm link is opened on another device. trial_welcome_set(false) clears
--     it when the welcome is finished; trial_welcome_set(true) turns it on again (admin of a
--     studio on its free trial only). Existing studios stay NULL = no welcome.
--   * my_profile_status(): the admin of a studio ON its free trial (studio_subscriptions.status =
--     'trial', via _is_trial_org) is never forced to /profile-setup first: required = false, and
--     no profile nudge while the welcome is still pending. Invited members and paid studios:
--     unchanged (0041 rules).
--   No existing row is updated by this file. Additive + idempotent: add column if not exists,
--   create or replace. No DROP, DELETE or TRUNCATE. Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.start_self_serve_trial(text, text, text, text)') is null then
    raise exception '0180: start_self_serve_trial (0119) is missing'; end if;
  if to_regprocedure('public._is_trial_org(uuid)') is null then
    raise exception '0180: _is_trial_org (0166) is missing'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then
    raise exception '0180: _trial_locked (0116) is missing'; end if;
  if to_regprocedure('public.my_profile_status()') is null or to_regprocedure('public._mp_is_operator()') is null then
    raise exception '0180: my_profile_status (0041) is missing'; end if;
  if to_regprocedure('public.tg_org_trial_india()') is null then
    raise exception '0180: the India trial trigger (0177) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0180: organizations.is_sample_master (0166) is missing'; end if;
end $$;

alter table public.organizations add column if not exists trial_welcome_pending boolean;
comment on column public.organizations.trial_welcome_pending is
  '0180: true = the free-trial owner has not finished the 2-step welcome yet (server-side, works across devices); NULL/false = no welcome';

-- ---- 1) the ONE self-serve free trial: always sample data, always India ------------------------
-- 0119 body; changed: p_mode / p_timezone / p_currency are accepted but ignored (always 'demo',
-- Asia/Kolkata, INR) and the new studio gets trial_welcome_pending = true.
create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119 trial-signup-0180: always sample data + India; the welcome flag is set
declare
  v_uid uuid := auth.uid();
  v_tz text := 'Asia/Kolkata'; v_cur text := 'INR';
  v_mode text := 'demo';
  v_name text := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
  v_had uuid; v_org uuid; v_n bigint; v_end timestamptz;
  v_seed jsonb; v_extra jsonb; o public.organizations;
begin
  if v_uid is null then raise exception 'must be signed in to start a trial' using errcode = '42501'; end if;
  -- already in a studio: hand it back, create / seed / change nothing
  select p.org_id into v_had from public.profiles p where p.id = v_uid;
  if v_had is not null then
    select * into o from public.organizations x where x.id = v_had;
    return jsonb_build_object('result', 'has_studio', 'org_id', v_had, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;
  if coalesce(public.is_platform_admin(), false) then
    raise exception 'Helm operators do not get a studio' using errcode = '42501'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 80) then
    raise exception 'studio name must be 2 to 80 characters' using errcode = '22023'; end if;

  if v_name is null then
    -- one "Demo N" at a time across the whole database (same lock as 0116)
    perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
    v_n := public._trial_next_demo_number();
    v_name := 'Demo ' || v_n::text;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + make_interval(days => public._trial_days());
  -- the 0177 trigger stamps trial_region 'IN' and keeps INR / Asia/Kolkata / IN / GST on this update
  update public.organizations
     set trial_ends_at = v_end, trial_mode = v_mode, trial_welcome_pending = true
   where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  -- sample data: a failure here never blocks the trial (that block alone is rolled back)
  begin v_seed := public._demo_seed(v_org);
  exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  begin v_extra := public._trial_seed_extra(v_org);
  exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_self_serve_trial', 'name', v_name, 'mode', v_mode,
                              'requested_mode', left(coalesce(p_mode, ''), 20),
                              'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'mode', v_mode,
                            'currency', v_cur, 'timezone', v_tz, 'welcome', true,
                            'trial_ends_at', v_end, 'trial_days', public._trial_days(), 'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_self_serve_trial(text, text, text, text) from public, anon;
grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated, service_role;

-- ---- 2) server-side welcome flag ---------------------------------------------------------------
-- true only for an admin of the caller's own studio that is ON its free trial (not locked, not the
-- sample master) and still has the flag set. Paid studios: always false, even with a stray flag.
create or replace function public.my_trial_welcome_pending()
returns boolean language sql stable security definer set search_path = '' as $$
  -- trial-signup-0180
  select coalesce((
    select o.trial_welcome_pending is true
      from public.organizations o
     where o.id = public.current_org_id()
       and not coalesce(o.is_sample_master, false)
       and coalesce(public.is_admin(), false)
       and public._is_trial_org(o.id)
       and not coalesce(public._trial_locked(o.id), false)), false);
$$;
revoke all on function public.my_trial_welcome_pending() from public, anon;
grant execute on function public.my_trial_welcome_pending() to authenticated;

-- false: the welcome is finished (Skip / Send invites). true: show it again (the trial owner
-- removed the samples and names the studio once more). Admin of the caller's own studio only;
-- turning it ON needs a studio on its free trial. A studio that never had the flag stays NULL.
create or replace function public.trial_welcome_set(p_pending boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-signup-0180
declare v_org uuid := public.current_org_id(); v_want boolean := coalesce(p_pending, false); v_n int;
begin
  if auth.uid() is null or v_org is null or not coalesce(public.is_admin(), false) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if v_want and not (public._is_trial_org(v_org)
                     and not coalesce((select o.is_sample_master from public.organizations o where o.id = v_org), false)) then
    raise exception 'only a free-trial studio uses this welcome step' using errcode = '22023'; end if;
  update public.organizations o
     set trial_welcome_pending = v_want
   where o.id = v_org
     and o.trial_welcome_pending is distinct from v_want
     and (v_want or o.trial_welcome_pending is not null);
  get diagnostics v_n = row_count;
  return jsonb_build_object('result', 'ok', 'pending', v_want, 'changed', v_n > 0);
end $$;
revoke all on function public.trial_welcome_set(boolean) from public, anon;
grant execute on function public.trial_welcome_set(boolean) to authenticated;

-- ---- 3) profile gate: the free-trial owner goes to the welcome, not /profile-setup -------------
-- 0041 body; added: an admin of a studio on its free trial is never required (nudge only after
-- the welcome is done). Everyone else: the 0041 rules, unchanged.
create or replace function public.my_profile_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- member-profile-0041 trial-signup-0180
declare v_me uuid := auth.uid(); v_p record; v_complete boolean; v_cut timestamptz; v_new boolean;
begin
  if v_me is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.org_id, p.role, p.full_name, p.created_at, m.phone into v_p
    from public.profiles p left join public.member_profiles m on m.user_id = p.id where p.id = v_me;
  if not found then return jsonb_build_object('complete', false, 'required', false, 'nudge', false); end if;
  v_complete := nullif(btrim(coalesce(v_p.full_name, '')), '') is not null and v_p.phone is not null;
  if v_complete or v_p.org_id is null or v_p.role = 'client' or public._mp_is_operator() then
    return jsonb_build_object('complete', v_complete, 'required', false, 'nudge', false);
  end if;
  if v_p.role = 'admin' and public._is_trial_org(v_p.org_id) then
    return jsonb_build_object('complete', false, 'required', false,
      'nudge', not coalesce((select o.trial_welcome_pending from public.organizations o where o.id = v_p.org_id), false));
  end if;
  select s.gate_cutoff into v_cut from public.member_profile_settings s where s.id;
  v_new := v_cut is not null and v_p.created_at >= v_cut;
  return jsonb_build_object('complete', false, 'required', v_new, 'nudge', not v_new);
end $$;
revoke all on function public.my_profile_status() from public, anon;
grant execute on function public.my_profile_status() to authenticated;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row should say ok = true)
select item, ok from (values
  ('01 column organizations.trial_welcome_pending (nullable boolean)', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'trial_welcome_pending' and data_type = 'boolean' and is_nullable = 'YES')),
  ('02 start_self_serve_trial is the 0180 body (always demo + India, sets the welcome flag)', coalesce((select pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text, text, text, text)')) like '%trial-signup-0180%' and pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text, text, text, text)')) like '%trial_welcome_pending = true%'), false)),
  ('03 start_self_serve_trial no longer refuses own / no browser time zone or currency', coalesce((select pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text, text, text, text)')) not like '%choose demo or own%' and pg_get_functiondef(to_regprocedure('public.start_self_serve_trial(text, text, text, text)')) not like '%pg_timezone_names%'), false)),
  ('04 my_profile_status: trial owner via _is_trial_org (not trial_ends_at)', coalesce((select pg_get_functiondef(to_regprocedure('public.my_profile_status()')) like '%trial-signup-0180%' and pg_get_functiondef(to_regprocedure('public.my_profile_status()')) like '%_is_trial_org%' and pg_get_functiondef(to_regprocedure('public.my_profile_status()')) not like '%trial_ends_at%'), false)),
  ('05 welcome functions: signed-in users only', has_function_privilege('authenticated', 'public.my_trial_welcome_pending()', 'execute') and has_function_privilege('authenticated', 'public.trial_welcome_set(boolean)', 'execute') and not has_function_privilege('anon', 'public.my_trial_welcome_pending()', 'execute') and not has_function_privilege('anon', 'public.trial_welcome_set(boolean)', 'execute')),
  ('06 start trial / profile status: signed-in users only', has_function_privilege('authenticated', 'public.start_self_serve_trial(text, text, text, text)', 'execute') and not has_function_privilege('anon', 'public.start_self_serve_trial(text, text, text, text)', 'execute') and has_function_privilege('authenticated', 'public.my_profile_status()', 'execute') and not has_function_privilege('anon', 'public.my_profile_status()', 'execute')),
  ('07 all four are SECURITY DEFINER with an empty search_path', (select count(*) = 4 from pg_proc p where p.oid in (to_regprocedure('public.start_self_serve_trial(text, text, text, text)'), to_regprocedure('public.my_trial_welcome_pending()'), to_regprocedure('public.trial_welcome_set(boolean)'), to_regprocedure('public.my_profile_status()')) and p.prosecdef and p.proconfig @> array['search_path=""'])),
  ('08 no paid studio has the welcome flag on', not exists (select 1 from public.organizations o join public.studio_subscriptions s on s.org_id = o.id where o.trial_welcome_pending is true and s.status <> 'trial')),
  ('09 the India trigger (0177) is still in place', exists (select 1 from pg_trigger where tgrelid = 'public.organizations'::regclass and tgname = 'zzz_org_trial_india_0177' and not tgisinternal))
) v(item, ok) order by item;
