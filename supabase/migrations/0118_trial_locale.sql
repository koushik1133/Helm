-- ============================================================================
-- 0118_trial_locale.sql - CANONICAL forward-only. REQUIRES 0116.
-- In plain words: a free-trial "Demo N" studio now starts in the VISITOR's own time zone
-- and currency (sent by the sign-up page from the browser), instead of always India/INR.
--   * NEW start_trial(p_timezone, p_currency): same body as 0116's start_trial(), only the
--     create_studio() call uses the validated values (unknown zone -> UTC, unknown currency -> USD).
--   * start_trial() (no arguments) is kept and behaves exactly as before (INR / Asia/Kolkata).
-- Additive + idempotent: no table change, no existing row touched, safe to run twice.
-- ============================================================================
create or replace function public.start_trial(p_timezone text, p_currency text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 trial-locale-0118
declare
  v_tz text := 'Asia/Kolkata'; v_cur text := 'INR';
  v_uid uuid := auth.uid();
  v_had uuid; v_org uuid; v_n bigint; v_name text; v_end timestamptz;
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

  -- one "Demo N" at a time across the whole database
  perform pg_advisory_xact_lock(hashtextextended('helm:start_trial:demo_n', 0));
  v_n := public._trial_next_demo_number();
  v_name := 'Demo ' || v_n::text;
  -- visitor's own time zone + currency (validated; unknown values fall back to UTC / USD)
  if p_timezone is not null then
    v_tz := case when exists (select 1 from pg_catalog.pg_timezone_names t where t.name = btrim(p_timezone)) then btrim(p_timezone) else 'UTC' end;
  end if;
  if p_currency is not null then
    v_cur := case when upper(btrim(p_currency)) in ('INR','USD','AED','GBP','SGD','AUD','CAD','EUR') then upper(btrim(p_currency)) else 'USD' end;
  end if;
  v_org := public.create_studio(v_name, null, v_cur, v_tz);
  select * into o from public.organizations x where x.id = v_org;
  -- never touch a studio this call did not just create
  if o.id is null or o.created_by is distinct from v_uid or o.name <> v_name or o.trial_ends_at is not null then
    return jsonb_build_object('result', 'has_studio', 'org_id', v_org, 'name', o.name, 'trial_ends_at', o.trial_ends_at);
  end if;

  v_end := now() + interval '8 days';
  update public.organizations set trial_ends_at = v_end where id = v_org and trial_ends_at is null;
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
           jsonb_build_object('source', 'start_trial', 'name', v_name, 'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'trial_ends_at', v_end,
                            'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_trial(text, text) from public, anon;
grant execute on function public.start_trial(text, text) to authenticated, service_role;

notify pgrst, 'reload schema';
