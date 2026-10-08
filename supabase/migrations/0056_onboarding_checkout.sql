-- ============================================================================
-- 0056_onboarding_checkout.sql — CANONICAL forward-only. Onboarding checkout.
-- REQUIRES 0045 (HQ subscriptions: helm_plans, helm_plan_prices, studio_subscriptions,
-- studio_account incl. terms_version_accepted, _resolve_tax). Independent of 0055.
--
-- In plain words: after "Complete your profile", the OWNER (admin) of a NEW studio
-- picks a Helm plan on /checkout, sees a server-computed tax preview, fills billing
-- details, accepts the Terms, and either pays through Razorpay's hosted page (dormant
-- until the owner turns it on) or starts a 14-day free trial. Members invited into an
-- existing studio never see this step. Studios that existed before this migration are
-- never sent to checkout (checkout_required_after = the moment this first ran).
--
--   * helm_billing_settings: + allow_trial_bypass (default true — HQ can turn the
--     "Skip payment (testing only)" button off), + online_payments_live (default false),
--     + terms_version (current Terms version), + checkout_required_after.
--   * helm_plans: + description, features (what's included), sort_order.
--   * helm_plan_prices: + razorpay_plan_id_monthly / _yearly (HQ fills these in).
--   * studio_subscriptions: + billing_interval, trial_source.
--   * RPCs (studio side, admin-gated inside): my_checkout_status, my_checkout_options,
--     my_checkout_preview, my_checkout_prepare, my_start_trial.
--   * RPCs (service role only): checkout_attach_subscription (edge function).
--   * Creates NO plans and changes no prices: HQ sets those up.
-- Additive + idempotent. NO row is deleted; no existing value is overwritten.
-- ============================================================================

do $$ begin
  if to_regclass('public.helm_plan_prices') is null or to_regclass('public.studio_subscriptions') is null then
    raise exception '0056: 0045 (HQ subscriptions) is not installed on this database'; end if;
  if to_regprocedure('public._resolve_tax(uuid,date,numeric)') is null then
    raise exception '0056: 0045 tax engine (_resolve_tax) is not installed on this database'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_account'
                   and column_name = 'terms_version_accepted') then
    raise exception '0056: studio_account.terms_version_accepted (0045) is missing'; end if;
end $$;

-- ---- 1) columns (additive) ---------------------------------------------------------------
alter table public.helm_billing_settings add column if not exists allow_trial_bypass boolean not null default true;
alter table public.helm_billing_settings add column if not exists online_payments_live boolean not null default false;
alter table public.helm_billing_settings add column if not exists terms_version text not null default '2026-10-08'
  check (terms_version ~ '^[A-Za-z0-9._-]{1,32}$');
alter table public.helm_billing_settings add column if not exists checkout_required_after timestamptz;
-- studios created BEFORE this migration first ran are never sent to checkout (set once, never moved)
update public.helm_billing_settings set checkout_required_after = now() where id and checkout_required_after is null;

alter table public.helm_plans add column if not exists description text check (description is null or length(description) <= 300);
alter table public.helm_plans add column if not exists features jsonb not null default '[]'::jsonb
  check (jsonb_typeof(features) = 'array' and jsonb_array_length(features) <= 20);
alter table public.helm_plans add column if not exists sort_order integer not null default 100;

alter table public.helm_plan_prices add column if not exists razorpay_plan_id_monthly text
  check (razorpay_plan_id_monthly is null or razorpay_plan_id_monthly ~ '^plan_[A-Za-z0-9]{6,40}$');
alter table public.helm_plan_prices add column if not exists razorpay_plan_id_yearly text
  check (razorpay_plan_id_yearly is null or razorpay_plan_id_yearly ~ '^plan_[A-Za-z0-9]{6,40}$');

alter table public.studio_subscriptions add column if not exists billing_interval text
  check (billing_interval is null or billing_interval in ('monthly','yearly'));
alter table public.studio_subscriptions add column if not exists trial_source text
  check (trial_source is null or trial_source in ('bypass','payment_pending','checkout','hq'));

-- ---- 2) plans: NONE are created here (no invented prices). HQ adds plans + prices
--      (hq_upsert_plan / hq_upsert_plan_price) and the checkout details
--      (hq_set_plan_checkout: description, features, Razorpay plan ids).

-- ---- 3) helpers ------------------------------------------------------------------------------
-- the studio's billing currency: studio_account.billing_currency → organizations.currency → INR
create or replace function public._checkout_currency(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select a.billing_currency from public.studio_account a where a.org_id = p_org),
    (select case when o.currency ~ '^[A-Z]{3}$' then o.currency end from public.organizations o where o.id = p_org),
    'INR');
$$;

-- one plan's price in a currency → {code,name,currency,monthly,yearly,rzp_monthly,rzp_yearly} or null
create or replace function public._checkout_plan_price(p_code text, p_currency text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', hp.id, 'code', hp.code, 'name', hp.name, 'description', hp.description,
           'features', hp.features, 'sort_order', hp.sort_order, 'currency', p_currency,
           'monthly', coalesce(pp.price_monthly, case when hp.currency = p_currency then hp.price_monthly end),
           'yearly', pp.price_yearly,
           'rzp_monthly', pp.razorpay_plan_id_monthly, 'rzp_yearly', pp.razorpay_plan_id_yearly)
    from public.helm_plans hp
    left join public.helm_plan_prices pp on pp.plan_id = hp.id and pp.currency = p_currency
   where hp.code = p_code and hp.active
     and (pp.plan_id is not null or hp.currency = p_currency);
$$;

-- net price + tax lines, all from the server (prices are net; tax is added on top)
create or replace function public._checkout_quote(p_org uuid, p_plan text, p_interval text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cur text := public._checkout_currency(p_org); pr jsonb; v_net numeric; tx jsonb; v_rate numeric;
  v_tax numeric; v_half numeric; v_comp jsonb := '[]'::jsonb; c jsonb;
begin
  if p_interval is null or p_interval not in ('monthly','yearly') then
    raise exception 'choose monthly or yearly billing' using errcode = '22023'; end if;
  if p_plan is null or p_plan !~ '^[a-z0-9][a-z0-9_-]{1,39}$' then raise exception 'choose a plan' using errcode = '22023'; end if;
  pr := public._checkout_plan_price(p_plan, v_cur);
  if pr is null then raise exception 'that plan is not available' using errcode = '22023'; end if;
  v_net := (pr ->> p_interval)::numeric;
  if v_net is null then raise exception 'that plan has no % price', p_interval using errcode = '22023'; end if;
  tx := public._resolve_tax(p_org, current_date, null);
  v_rate := coalesce((tx ->> 'rate')::numeric, 0);
  v_tax := round(v_net * v_rate / 100, 2);
  if tx ->> 'regime' = 'IN_GST_INTRA' then
    v_half := round(v_tax / 2, 2);
    v_comp := jsonb_build_array(jsonb_build_object('name', 'CGST', 'rate', round(v_rate / 2, 2), 'amount', v_half),
                                jsonb_build_object('name', 'SGST', 'rate', round(v_rate / 2, 2), 'amount', v_tax - v_half));
  else
    for c in select value from jsonb_array_elements(coalesce(tx -> 'components', '[]'::jsonb)) loop
      v_comp := v_comp || jsonb_build_array(c || jsonb_build_object('amount', v_tax));
    end loop;
  end if;
  return jsonb_build_object('plan', pr ->> 'code', 'plan_name', pr ->> 'name', 'interval', p_interval, 'currency', v_cur,
    'net', round(v_net, 2), 'tax', v_tax, 'total', round(v_net, 2) + v_tax, 'rate', v_rate,
    'regime', tx ->> 'regime', 'components', v_comp, 'note', tx ->> 'note',
    'reverse_charge', coalesce((tx ->> 'reverse_charge')::boolean, false),
    'place_of_supply', tx ->> 'place_of_supply',
    'razorpay_plan_id', pr ->> case p_interval when 'monthly' then 'rzp_monthly' else 'rzp_yearly' end);
end $$;

-- ---- 4) studio-side RPCs ---------------------------------------------------------------------
-- Does THIS user have to go through checkout now? Never raises for a signed-in user.
--   required = studio admin + studio created after checkout_required_after + no subscription row
create or replace function public.my_checkout_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; s public.studio_subscriptions;
  v_admin boolean := coalesce(public.is_admin(), false); v_created timestamptz;
begin
  if v_org is null then return jsonb_build_object('required', false, 'reason', 'no_studio'); end if;
  select * into b from public.helm_billing_settings where id;
  select * into s from public.studio_subscriptions where org_id = v_org;
  select o.created_at into v_created from public.organizations o where o.id = v_org;
  return jsonb_build_object(
    'required', v_admin and s.org_id is null and b.checkout_required_after is not null
                and coalesce(v_created, '-infinity'::timestamptz) >= b.checkout_required_after,
    'is_admin', v_admin, 'has_subscription', s.org_id is not null,
    'status', s.status,
    'reason', case when not v_admin then 'member' when s.org_id is not null then 'subscribed'
                   when b.checkout_required_after is null or coalesce(v_created, '-infinity'::timestamptz) < b.checkout_required_after then 'existing_studio'
                   else 'needs_checkout' end);
end $$;

-- plans + prices in the studio's billing currency (admins only)
create or replace function public.my_checkout_options()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
    'trial_days', 14, 'has_subscription', s.org_id is not null, 'status', s.status);
end $$;

create or replace function public.my_checkout_preview(p_plan text, p_interval text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  return public._checkout_quote(v_org, p_plan, p_interval) - 'razorpay_plan_id';
end $$;

-- the edge function asks this AS THE CALLER before it creates anything at Razorpay
create or replace function public.my_checkout_prepare(p_plan text, p_interval text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; q jsonb;
begin
  if v_org is null or not coalesce(public.is_admin(), false) then raise exception 'not authorized' using errcode = '42501'; end if;
  select * into b from public.helm_billing_settings where id;
  select * into a from public.studio_account where org_id = v_org;
  if a.terms_version_accepted is null or a.terms_version_accepted is distinct from b.terms_version then
    raise exception 'please accept the Terms of Service first' using errcode = '22023'; end if;
  select * into s from public.studio_subscriptions where org_id = v_org;
  if s.status in ('active','past_due','suspended') then
    raise exception 'this studio already has a subscription' using errcode = '22023'; end if;
  q := public._checkout_quote(v_org, p_plan, p_interval);
  if q ->> 'razorpay_plan_id' is null then
    raise exception 'online payment is not set up for this plan yet' using errcode = '22023'; end if;
  return q || jsonb_build_object('org_id', v_org);
end $$;

-- 14-day trial. p_source: 'bypass' (testing button — needs allow_trial_bypass) or
-- 'payment_pending' (online payment not live yet — needs online_payments_live = false).
-- Idempotent: an existing trial is returned unchanged; any other subscription refuses.
create or replace function public.my_start_trial(p_source text default 'bypass', p_plan text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); b public.helm_billing_settings; a public.studio_account;
  s public.studio_subscriptions; v_plan uuid; v_src text := coalesce(nullif(btrim(p_source), ''), 'bypass');
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
  insert into public.studio_subscriptions(org_id, plan_id, status, trial_ends_at, trial_source, updated_at, updated_by)
    values (v_org, v_plan, 'trial', current_date + 14, v_src, now(), auth.uid());
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), (select u.email from auth.users u where u.id = auth.uid()), 'subscription.trial_started',
           'studio_subscriptions', v_org::text,
           jsonb_build_object('source', v_src, 'plan', p_plan, 'trial_ends_at', current_date + 14), v_org, now();
  return jsonb_build_object('result', 'started', 'status', 'trial', 'trial_ends_at', current_date + 14);
end $$;

-- ---- 5) service role: remember the Razorpay subscription the edge function created -----------
create or replace function public.checkout_attach_subscription(p_org uuid, p_subscription_id text, p_plan text, p_interval text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
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
    values (p_org, v_plan, 'trial', current_date + 14, 'checkout', p_interval, 'razorpay', p_subscription_id, now())
  on conflict (org_id) do update set plan_id = excluded.plan_id, billing_interval = excluded.billing_interval,
      provider = 'razorpay', provider_subscription_id = excluded.provider_subscription_id, updated_at = now()
    where public.studio_subscriptions.status not in ('active','past_due','suspended');
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
      values (null, null, 'subscription.checkout_created', 'studio_subscriptions', p_org::text,
              jsonb_build_object('plan', p_plan, 'interval', p_interval, 'provider_subscription_id', p_subscription_id), p_org, now());
  end if;
  return v_n > 0;
end $$;

-- ---- 5b) HQ: checkout switches + plan checkout details (operator write gate) ------------------
create or replace function public.hq_set_checkout_settings(p_allow_trial_bypass boolean, p_online_payments_live boolean,
  p_terms_version text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_wgate('hq.checkout.settings', 'helm_billing_settings', 'singleton',
    jsonb_build_object('allow_trial_bypass', p_allow_trial_bypass, 'online_payments_live', p_online_payments_live, 'terms_version', p_terms_version));
  if p_terms_version is not null and p_terms_version !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception 'terms version is not valid' using errcode = '22023'; end if;
  update public.helm_billing_settings set
    allow_trial_bypass = coalesce(p_allow_trial_bypass, allow_trial_bypass),
    online_payments_live = coalesce(p_online_payments_live, online_payments_live),
    terms_version = coalesce(p_terms_version, terms_version), updated_at = now(), updated_by = auth.uid()
   where id;
  return (select jsonb_build_object('allow_trial_bypass', b.allow_trial_bypass, 'online_payments_live', b.online_payments_live,
            'terms_version', b.terms_version, 'checkout_required_after', b.checkout_required_after) from public.helm_billing_settings b where b.id);
end $$;

create or replace function public.hq_plan_checkout()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  perform public._hq_gate('hq_plan_checkout');
  return coalesce((select jsonb_agg(jsonb_build_object('code', hp.code, 'name', hp.name, 'active', hp.active,
      'description', hp.description, 'features', hp.features, 'sort_order', hp.sort_order,
      'prices', coalesce((select jsonb_agg(jsonb_build_object('currency', pp.currency, 'monthly', pp.price_monthly, 'yearly', pp.price_yearly,
                 'razorpay_plan_id_monthly', pp.razorpay_plan_id_monthly, 'razorpay_plan_id_yearly', pp.razorpay_plan_id_yearly)
                 order by pp.currency) from public.helm_plan_prices pp where pp.plan_id = hp.id), '[]'::jsonb))
    order by hp.sort_order, hp.code) from public.helm_plans hp), '[]'::jsonb);
end $$;

create or replace function public.hq_set_plan_checkout(p_code text, p_currency text, p_description text, p_features jsonb,
  p_sort_order integer default null, p_razorpay_plan_id_monthly text default null, p_razorpay_plan_id_yearly text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_plan uuid; v_cur text := upper(coalesce(nullif(btrim(p_currency), ''), 'INR'));
begin
  perform public._hq_wgate('hq.plan.checkout', 'helm_plans', p_code,
    jsonb_build_object('currency', v_cur, 'rzp_monthly', p_razorpay_plan_id_monthly, 'rzp_yearly', p_razorpay_plan_id_yearly));
  select id into v_plan from public.helm_plans where code = p_code;
  if v_plan is null then raise exception 'unknown plan' using errcode = '22023'; end if;
  if p_features is not null and (jsonb_typeof(p_features) <> 'array' or exists (
       select 1 from jsonb_array_elements(p_features) e where jsonb_typeof(e) <> 'string' or length(e #>> '{}') > 120)) then
    raise exception 'features must be a list of short texts' using errcode = '22023'; end if;
  begin
    update public.helm_plans set description = coalesce(nullif(btrim(p_description), ''), description),
      features = coalesce(p_features, features), sort_order = coalesce(p_sort_order, sort_order), updated_at = now()
     where id = v_plan;
    update public.helm_plan_prices set
      razorpay_plan_id_monthly = coalesce(nullif(btrim(p_razorpay_plan_id_monthly), ''), razorpay_plan_id_monthly),
      razorpay_plan_id_yearly = coalesce(nullif(btrim(p_razorpay_plan_id_yearly), ''), razorpay_plan_id_yearly),
      updated_at = now()
     where plan_id = v_plan and currency = v_cur;
  exception when check_violation then raise exception 'a value is not valid' using errcode = '22023';
  end;
  return (select to_jsonb(hp) from public.helm_plans hp where hp.id = v_plan);
end $$;

-- ---- 6) grants -------------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._checkout_currency(uuid)', 'public._checkout_plan_price(text, text)', 'public._checkout_quote(uuid, text, text)',
    'public.my_checkout_status()', 'public.my_checkout_options()', 'public.my_checkout_preview(text, text)',
    'public.my_checkout_prepare(text, text)', 'public.my_start_trial(text, text)',
    'public.checkout_attach_subscription(uuid, text, text, text)',
    'public.hq_set_checkout_settings(boolean, boolean, text)',
    'public.hq_set_plan_checkout(text, text, text, jsonb, integer, text, text)', 'public.hq_plan_checkout()'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.my_checkout_status() to authenticated;
    grant execute on function public.my_checkout_options() to authenticated;            -- admin gate inside
    grant execute on function public.my_checkout_preview(text, text) to authenticated;  -- admin gate inside
    grant execute on function public.my_checkout_prepare(text, text) to authenticated;  -- admin gate inside
    grant execute on function public.my_start_trial(text, text) to authenticated;       -- admin + flag gate inside
    grant execute on function public.hq_set_checkout_settings(boolean, boolean, text) to authenticated;   -- operator gate inside
    grant execute on function public.hq_set_plan_checkout(text, text, text, jsonb, integer, text, text) to authenticated;
    grant execute on function public.hq_plan_checkout() to authenticated;                -- operator gate inside
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.checkout_attach_subscription(uuid, text, text, text) to service_role;
  end if;
end $$;
