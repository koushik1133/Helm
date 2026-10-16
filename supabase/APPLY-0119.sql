-- ============================================================================
-- 0119_unified_trial.sql - CANONICAL forward-only. ONE free trial for every self-serve studio.
-- REQUIRES 0054 (security alerts), 0056 (checkout), 0058 (trial reminders), 0097 + 0100 (demo seed,
--          organizations.trial_mode), 0116 (start_trial, trial_ends_at, read-only after the trial),
--          0118 (start_trial(text,text): visitor time zone + currency).
--
-- In plain words:
--   * There were two trials: the old "create studio -> profile -> Plan & payment -> 14-day trial"
--     (0056 my_start_trial) and the new "Start free trial -> Demo N, 8 days" (0116 start_trial).
--     Now every self-serve sign-up gets the SAME 8-day free trial:
--       start_self_serve_trial(name, time zone, currency, mode)
--         - name: the studio name the person typed, or "Demo N" when they left it empty
--         - time zone + currency: the visitor's own (validated, 0118 rules)
--         - mode: 'demo' (Try with demo data -> the existing sample studio is seeded) or
--                 'own'  (Start with my own data -> nothing is seeded)
--       It records the trial exactly like 0116 does (organizations.trial_ends_at +
--       studio_subscriptions 'trial'), so the banner, reminders, checkout and the
--       read-only-after-trial guard all keep working, and the owner is never sent through
--       "Plan & payment" before they have seen the app.
--   * helm_billing_settings.trial_days (NEW, default 8) is the one place the length lives.
--     my_start_trial (checkout button), checkout_attach_subscription and my_checkout_options
--     now read it instead of the hard-coded 14.
--   * start_trial() / start_trial(text,text) keep working (they call the new function with an
--     empty name + demo data), so an old cached sign-up page still lands in the same trial.
--   * my_trial_org() also returns trial_mode (the banner words differ for demo vs own data).
--   * Security alert "Member role changed" is no longer raised for a person's FIRST role in a
--     studio (creating a studio / joining one) - only for a real change inside the same studio.
--
-- ZERO DATA LOSS / existing studios unaffected: additive + idempotent. One new column with a
-- default (the only "config" row change: the singleton settings row gets trial_days = 8 through
-- the column default). No DROP / DELETE / TRUNCATE, no backfill, no existing studio, subscription,
-- trial or notification row is changed. Functions are re-issued with the same signatures and
-- grants. A studio that already has a studio is handed back unchanged by every entry point.
-- Safe to run twice.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.start_trial(text,text)') is null or to_regprocedure('public._trial_seed_extra(uuid)') is null then
    raise exception '0119: apply 0116 + 0118 (free-trial studios) first'; end if;
  if to_regprocedure('public._demo_seed(uuid)') is null then
    raise exception '0119: apply 0097 + 0100 (demo seed) first'; end if;
  if to_regprocedure('public.my_start_trial(text,text)') is null or to_regprocedure('public.my_trial_status()') is null then
    raise exception '0119: apply 0056 + 0058 (checkout, trial reminders) first'; end if;
  if to_regprocedure('public._security_alert_safe(uuid,text,text,uuid,jsonb)') is null then
    raise exception '0119: apply 0054 (security alerts) first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'organizations' and column_name = 'trial_mode') then
    raise exception '0119: organizations.trial_mode (0097) is missing'; end if;
end $$;

-- ---- 1) the trial length (config) ----------------------------------------------------------
alter table public.helm_billing_settings add column if not exists trial_days integer not null default 8;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.helm_billing_settings'::regclass
                   and conname = 'helm_billing_settings_trial_days_chk119') then
    alter table public.helm_billing_settings add constraint helm_billing_settings_trial_days_chk119
      check (trial_days between 1 and 60);
  end if;
end $$;

create or replace function public._trial_days()
returns integer language sql stable security definer set search_path = '' as $$
  -- unified-trial-0119
  select coalesce((select b.trial_days from public.helm_billing_settings b where b.id limit 1), 8);
$$;
revoke all on function public._trial_days() from public, anon, authenticated;
grant execute on function public._trial_days() to service_role;

-- ---- 2) the ONE self-serve trial -------------------------------------------------------------
create or replace function public.start_self_serve_trial(p_name text, p_timezone text, p_currency text, p_mode text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare
  v_uid uuid := auth.uid();
  v_tz text := 'UTC'; v_cur text := 'USD';
  v_mode text := lower(btrim(coalesce(p_mode, 'demo')));
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
  if v_mode not in ('demo', 'own') then raise exception 'choose demo or own' using errcode = '22023'; end if;
  if v_name is not null and (char_length(v_name) < 2 or char_length(v_name) > 80) then
    raise exception 'studio name must be 2 to 80 characters' using errcode = '22023'; end if;
  -- visitor's own time zone + currency (0118 rules: unknown values fall back to UTC / USD)
  if p_timezone is not null and exists (select 1 from pg_catalog.pg_timezone_names t where t.name = btrim(p_timezone)) then
    v_tz := btrim(p_timezone); end if;
  if p_currency is not null and upper(btrim(p_currency)) in ('INR','USD','AED','GBP','SGD','AUD','CAD','EUR') then
    v_cur := upper(btrim(p_currency)); end if;

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
  update public.organizations set trial_ends_at = v_end, trial_mode = v_mode
   where id = v_org and trial_ends_at is null;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, 'trial', (v_end at time zone 'UTC')::date, 'bypass', now(), v_uid)
  on conflict (org_id) do nothing;

  if v_mode = 'demo' then
    -- sample data: a failure here never blocks the trial (that block alone is rolled back)
    begin v_seed := public._demo_seed(v_org);
    exception when others then v_seed := jsonb_build_object('seeded', false, 'error', sqlstate); end;
    begin v_extra := public._trial_seed_extra(v_org);
    exception when others then v_extra := jsonb_build_object('seeded', false, 'error', sqlstate); end;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select v_uid, (select u.email from auth.users u where u.id = v_uid), 'subscription.trial_started',
           'organizations', v_org::text,
           jsonb_build_object('source', 'start_self_serve_trial', 'name', v_name, 'mode', v_mode,
                              'trial_ends_at', v_end, 'seed', v_seed, 'extra', v_extra),
           v_org, now();
  return jsonb_build_object('result', 'started', 'org_id', v_org, 'name', v_name, 'mode', v_mode,
                            'trial_ends_at', v_end, 'trial_days', public._trial_days(), 'seed', v_seed, 'extra', v_extra);
end $$;
revoke all on function public.start_self_serve_trial(text, text, text, text) from public, anon;
grant execute on function public.start_self_serve_trial(text, text, text, text) to authenticated, service_role;

-- the 0116 / 0118 entry points land in the same trial (Demo N + demo data)
create or replace function public.start_trial()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119
begin
  return public.start_self_serve_trial(null, 'Asia/Kolkata', 'INR', 'demo');
end $$;
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated, service_role;

create or replace function public.start_trial(p_timezone text, p_currency text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- trial-orgs-0116 trial-locale-0118 unified-trial-0119
begin
  return public.start_self_serve_trial(null, p_timezone, p_currency, 'demo');
end $$;
revoke all on function public.start_trial(text, text) from public, anon;
grant execute on function public.start_trial(text, text) to authenticated, service_role;

-- ---- 3) checkout paths: the configured length instead of 14 ---------------------------------
-- 0056 body; only the length changed (+ a NEW studio that starts its trial here gets the same
-- trial_ends_at as a sign-up trial; studios older than checkout are never given one).
create or replace function public.my_start_trial(p_source text default 'bypass', p_plan text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; v_plan uuid; v_src text := coalesce(nullif(btrim(p_source), ''), 'bypass');
  v_days integer := public._trial_days(); v_end date;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  if v_src not in ('bypass','payment_pending') then raise exception 'unknown trial source' using errcode = '22023'; end if;
  select * into b from public.helm_billing_settings where id;
  if v_src = 'bypass' and not coalesce(b.allow_trial_bypass, false) then
    raise exception 'skipping payment is turned off' using errcode = '42501'; end if;
  if v_src = 'payment_pending' and coalesce(b.online_payments_live, false) then
    raise exception 'online payment is available — please pay to continue' using errcode = '42501'; end if;
  select * into a from public.studio_account where org_id = v_org;
  if a.terms_version_accepted is null or a.terms_version_accepted is distinct from b.terms_version then
    raise exception 'please accept the Terms of Service first' using errcode = '22023'; end if;
  if p_plan is not null then
    select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan and hp.active;
    if v_plan is null then raise exception 'that plan is not available' using errcode = '22023'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('helm_trial:' || v_org::text));
  select * into s from public.studio_subscriptions where org_id = v_org for update;
  if found then
    if s.status = 'trial' then
      return jsonb_build_object('result', 'already_trial', 'status', s.status, 'trial_ends_at', s.trial_ends_at);
    end if;
    raise exception 'this studio already has a subscription' using errcode = '22023';
  end if;
  if exists (select 1 from public.subscription_payments p where p.org_id = v_org and p.voided_at is null) then
    raise exception 'this studio already has a subscription' using errcode = '22023'; end if;
  v_end := current_date + v_days;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, v_plan, 'trial', v_end, v_src, now(), auth.uid());
  update public.organizations o set trial_ends_at = now() + make_interval(days => v_days)
   where o.id = v_org and o.trial_ends_at is null
     and b.checkout_required_after is not null and o.created_at >= b.checkout_required_after;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'subscription.trial_started',
           'studio_subscriptions', v_org::text,
           jsonb_build_object('source', v_src, 'plan', p_plan, 'trial_ends_at', v_end), v_org, now();
  return jsonb_build_object('result', 'started', 'status', 'trial', 'trial_ends_at', v_end);
end $$;
revoke all on function public.my_start_trial(text, text) from public, anon;
grant execute on function public.my_start_trial(text, text) to authenticated;

-- 0058 body; only the length changed
create or replace function public.checkout_attach_subscription(p_org uuid, p_subscription_id text, p_plan text, p_interval text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
-- unified-trial-0119
declare v_plan uuid; v_n int;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]{6,40}$' then
    raise exception 'bad subscription id' using errcode = '22023'; end if;
  if p_interval not in ('monthly','yearly') then raise exception 'bad interval' using errcode = '22023'; end if;
  select hp.id into v_plan from public.helm_plans hp where hp.code = p_plan;
  if v_plan is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'unknown studio or plan' using errcode = '22023'; end if;
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, billing_interval,
                                          provider, provider_subscription_id, updated_at)
    values (p_org, v_plan, 'trial', current_date + public._trial_days(), 'checkout', p_interval, 'razorpay', p_subscription_id, now())
  on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
      provider = 'razorpay', provider_subscription_id = excluded.provider_subscription_id, updated_at = now()
    where public.studio_subscriptions.status not in ('active','past_due','suspended')
       or (public.studio_subscriptions.status = 'past_due' and public.studio_subscriptions.trial_ends_at is not null
           and public.studio_subscriptions.current_period_end is null
           and not exists (select 1 from public.subscription_payments p where p.org_id = excluded.org_id and p.voided_at is null));
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'subscription.checkout_created', 'studio_subscriptions', p_org::text,
              jsonb_build_object('plan', p_plan, 'interval', p_interval, 'provider_subscription_id', p_subscription_id), p_org, now());
  end if;
  return v_n > 0;
end $$;
revoke all on function public.checkout_attach_subscription(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.checkout_attach_subscription(uuid, text, text, text) to service_role;

-- 0056 body; trial_days from the settings
create or replace function public.my_checkout_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- unified-trial-0119
declare v_org uuid := public.current_org_id(); v_cur text; b public.helm_billing_settings; s public.studio_subscriptions;
  a public.studio_account; v_plans jsonb;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  v_cur := public._checkout_currency(v_org);
  select * into b from public.helm_billing_settings where id;
  select * into s from public.studio_subscriptions where org_id = v_org;
  select * into a from public.studio_account where org_id = v_org;
  select coalesce(jsonb_agg(x - 'id' - 'rzp_monthly' - 'rzp_yearly'
                              || jsonb_build_object('online_monthly', x ->> 'rzp_monthly' is not null,
                                                    'online_yearly', x ->> 'rzp_yearly' is not null)
                            order by (x ->> 'sort_order')::int, x ->> 'code'), '[]'::jsonb)
    into v_plans
    from (select public._checkout_plan_price(hp.code, v_cur) x from public.helm_plans hp where hp.active) q
   where x is not null and x ->> 'monthly' is not null;
  return jsonb_build_object('currency', v_cur, 'plans', v_plans,
    'terms_version', b.terms_version, 'terms_accepted', a.terms_version_accepted is not distinct from b.terms_version and a.terms_version_accepted is not null,
    'bypass_allowed', coalesce(b.allow_trial_bypass, false), 'online_payments_live', coalesce(b.online_payments_live, false),
    'trial_days', public._trial_days(), 'has_subscription', s.org_id is not null, 'status', s.status);
end $$;
revoke all on function public.my_checkout_options() from public, anon;
grant execute on function public.my_checkout_options() to authenticated;

-- ---- 4) banner data: + trial_mode (0116 body otherwise) ----------------------------------------
create or replace function public.my_trial_org()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- trial-orgs-0116 unified-trial-0119
declare v_org uuid := public.current_org_id(); o public.organizations; v_locked boolean;
begin
  if auth.uid() is null or v_org is null or coalesce(public.user_role(), '') in ('', 'client') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select * into o from public.organizations x where x.id = v_org;
  if o.trial_ends_at is null then
    return jsonb_build_object('is_trial_org', false, 'is_admin', coalesce(public.is_admin(), false));
  end if;
  v_locked := public._trial_locked(v_org);
  return jsonb_build_object('is_trial_org', true, 'name', o.name, 'ends_at', o.trial_ends_at,
    'days_left', greatest(0, ceil(extract(epoch from (o.trial_ends_at - now())) / 86400.0))::int,
    'ended', o.trial_ends_at <= now(), 'locked', v_locked, 'trial_mode', o.trial_mode,
    'is_admin', coalesce(public.is_admin(), false));
end $$;
revoke all on function public.my_trial_org() from public, anon;
grant execute on function public.my_trial_org() to authenticated, service_role;

-- ---- 5) security alert: no "Member role changed" for a person's FIRST role in a studio ----------
-- 0054 body; the UPDATE branch now needs the person to have been in THIS studio already
-- (creating a studio / accepting an invite sets org_id + role together: that is not a change).
create or replace function public.tg_sa54_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
-- unified-trial-0119
begin
  begin
    if TG_OP = 'UPDATE' then
      if new.org_id is not null and old.org_id is not null and old.org_id = new.org_id
         and old.role is distinct from new.role then
        perform public._security_alert_safe(new.org_id, 'role_changed', 'profiles.role', null,
          jsonb_build_object('subject_name', left(nullif(btrim(new.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()),
                             'old_role', left(old.role, 20), 'new_role', left(new.role, 20)));
      end if;
    elsif TG_OP = 'DELETE' then
      if old.org_id is not null and coalesce(old.role, '') <> 'client'
         and exists (select 1 from public.organizations o where o.id = old.org_id) then
        perform public._security_alert_safe(old.org_id, 'member_removed', 'profiles.delete', null,
          jsonb_build_object('subject_name', left(nullif(btrim(old.full_name), ''), 80),
                             'actor_name', public._sa54_name(auth.uid()), 'old_role', left(old.role, 20)));
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.tg_sa54_profile() from public;

notify pgrst, 'reload schema';

-- VERIFY 0119 (read-only; expect every ok = true)
select '0119 trial_days column exists' as item, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'helm_billing_settings' and column_name = 'trial_days') as ok
union all select '0119 trial length is 8 days', (select b.trial_days = 8 from public.helm_billing_settings b where b.id limit 1)
union all select '0119 start_self_serve_trial exists', to_regprocedure('public.start_self_serve_trial(text,text,text,text)') is not null
union all select '0119 start_self_serve_trial is security definer', coalesce((select prosecdef from pg_proc where oid = to_regprocedure('public.start_self_serve_trial(text,text,text,text)')), false)
union all select '0119 authenticated may start a trial', has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 anon may NOT start a trial', not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
union all select '0119 start_trial() -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial()')) like '%start_self_serve_trial(%', false)
union all select '0119 start_trial(text,text) -> unified trial', coalesce(pg_get_functiondef(to_regprocedure('public.start_trial(text,text)')) like '%start_self_serve_trial(%', false)
union all select '0119 my_start_trial uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) like '%_trial_days()%', false)
union all select '0119 my_start_trial no longer 14 days', coalesce(pg_get_functiondef(to_regprocedure('public.my_start_trial(text,text)')) not like '%current_date + 14%', false)
union all select '0119 checkout_attach uses trial_days', coalesce(pg_get_functiondef(to_regprocedure('public.checkout_attach_subscription(uuid,text,text,text)')) like '%_trial_days()%', false)
union all select '0119 checkout_attach service role only', not has_function_privilege('authenticated', 'public.checkout_attach_subscription(uuid,text,text,text)', 'execute')
union all select '0119 my_checkout_options trial_days from settings', coalesce(pg_get_functiondef(to_regprocedure('public.my_checkout_options()')) like '%''trial_days'', public._trial_days()%', false)
union all select '0119 my_trial_org returns trial_mode', coalesce(pg_get_functiondef(to_regprocedure('public.my_trial_org()')) like '%''trial_mode''%', false)
union all select '0119 role alert skips first role', coalesce(pg_get_functiondef(to_regprocedure('public.tg_sa54_profile()')) like '%old.org_id is not null and old.org_id = new.org_id%', false)
union all select '0119 role-change trigger still attached', exists (select 1 from pg_trigger where tgname = 'zzz_sa54_profile_role' and tgrelid = 'public.profiles'::regclass)
union all select '0119 _trial_days not callable by users', not has_function_privilege('authenticated', 'public._trial_days()', 'execute');
