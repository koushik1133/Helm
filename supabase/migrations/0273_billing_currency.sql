-- 0273_billing_currency.sql - CANONICAL forward-only.
-- REQUIRES 0045 (helm_plans, helm_plan_prices, studio_account.billing_currency, studio_subscriptions),
--          0056 (_checkout_currency, _checkout_plan_price, my_checkout_options), 0159 (the starter / studio plans),
--          0255 (signup_plan_options).
--
-- In plain words (owner, r25: "the public site prices in US dollars - do what the top companies do"):
--   1  ONE list currency in public: US dollars (Starter $24 / $240, Studio $59 / $590, Enterprise on request).
--      Each plan keeps a FIXED price per currency (helm_plan_prices) - never converted live from an exchange rate.
--      This adds the USD prices next to the existing INR ones (only where a plan has no USD price yet - an HQ
--      price is never overwritten).
--   2  Every studio has ONE billing currency (studio_account.billing_currency), fixed when the studio is created:
--      a studio in India pays in rupees (INR, GST added, Razorpay); a studio anywhere else pays in US dollars.
--        * every studio that already exists keeps paying in INR (set once, only where it was empty);
--        * a new studio: the sign-up page tells the server the browser's time zone ONCE
--          (my_billing_currency_init): India time -> INR, anywhere else -> USD. A studio whose billing country
--          is filled in uses that country instead (IN -> INR, any other -> USD). Nothing known -> INR.
--   3  Once set it never changes by itself. The studio cannot change it (Settings shows it read-only); only Helm HQ
--      can, and never while a paid subscription is running (active / past due) - the same rule Stripe, Figma and
--      Slack follow (cancel, then start again in the other currency).
--   4  The plan cards on sign-up (signup_plan_options_for: new, takes the browser time zone) and on /checkout
--      (my_checkout_options, unchanged) show the studio's own currency. Tax is unchanged: still worked out on the
--      server from the billing country (GST for India; export rules elsewhere).
--   Changes: new rows in helm_plan_prices (USD), studio_account.billing_currency filled where EMPTY for studios that
--   exist when this first runs, one settings column (helm_billing_settings.billing_currency_set_at: when that
--   happened), _checkout_currency re-issued (billing currency -> country / time zone rule -> INR; the studio's own
--   quote currency is no longer used for Helm's bill), 3 new functions, 1 new trigger on studio_account.
--   No row deleted, no price overwritten, no column dropped. Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): drop trigger r25_billing_currency_lock on public.studio_account; re-run the
--   0056 _checkout_currency body. The USD price rows can stay (unused while every studio bills in INR).

do $$ begin
  if to_regclass('public.helm_plan_prices') is null or to_regclass('public.studio_account') is null then
    raise exception 'STOP 0273: 0045 (helm_plan_prices / studio_account) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'studio_account'
                   and column_name = 'billing_currency') then
    raise exception 'STOP 0273: studio_account.billing_currency (0045) is missing'; end if;
  if to_regprocedure('public._checkout_plan_price(text,text)') is null or to_regprocedure('public.my_checkout_options()') is null then
    raise exception 'STOP 0273: 0056 (checkout) is not applied'; end if;
  if to_regprocedure('public.signup_plan_options()') is null then
    raise exception 'STOP 0273: 0255 (signup_plan_options) is not applied'; end if;
end $$;

-- ---- 1) USD list prices (fixed per currency; only where a plan has no USD price yet) ---------------------------------
insert into public.helm_plan_prices(plan_id, currency, price_monthly, price_yearly)
  select hp.id, 'USD', x.m, x.y
    from (values ('starter', 24::numeric, 240::numeric), ('studio', 59::numeric, 590::numeric)) x(code, m, y)
    join public.helm_plans hp on hp.code = x.code
on conflict (plan_id, currency) do nothing;

-- ---- 2) existing studios keep paying in INR (once; only empty values; never overwritten) ------------------------------
alter table public.helm_billing_settings add column if not exists billing_currency_set_at timestamptz;
do $$ declare v_at timestamptz; n int := 0; m int := 0; begin
  select billing_currency_set_at into v_at from public.helm_billing_settings where id;
  if v_at is null then
    v_at := now();
    insert into public.studio_account(org_id, billing_currency)
      select o.id, 'INR' from public.organizations o
       where o.created_at <= v_at and not exists (select 1 from public.studio_account a where a.org_id = o.id)
    on conflict (org_id) do nothing;
    get diagnostics n = row_count;
    update public.studio_account a set billing_currency = 'INR'
      from public.organizations o
     where o.id = a.org_id and o.created_at <= v_at and a.billing_currency is null;
    get diagnostics m = row_count;
    update public.helm_billing_settings set billing_currency_set_at = v_at where id and billing_currency_set_at is null;
    raise notice '0273: % existing studio(s) set to bill in INR (% new account rows)', n + m, n;
  end if;
end $$;

-- ---- 3) the rule: country first (IN -> INR, any other -> USD), else time zone (India -> INR, other -> USD), else INR ----
create or replace function public._r25_currency_for(p_country text, p_timezone text)
returns text language sql immutable set search_path = '' as $$
  -- r25-currency-0273
  select case
    when upper(btrim(coalesce(p_country, ''))) = 'IN' then 'INR'
    when upper(btrim(coalesce(p_country, ''))) ~ '^[A-Z]{2}$' then 'USD'
    when btrim(coalesce(p_timezone, '')) in ('Asia/Kolkata', 'Asia/Calcutta') then 'INR'
    when btrim(coalesce(p_timezone, '')) ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$' then 'USD'
    else 'INR' end;
$$;

-- the studio's billing currency: studio_account.billing_currency -> the rule above (account country / time zone) -> INR
create or replace function public._checkout_currency(p_org uuid)
returns text language sql stable security definer set search_path = '' as $$
  -- r25-currency-0273: the studio's own quote currency (organizations.currency) is no longer Helm's billing currency
  select coalesce(
    (select a.billing_currency from public.studio_account a where a.org_id = p_org),
    (select public._r25_currency_for(a.country, coalesce(a.timezone, o.timezone))
       from public.organizations o left join public.studio_account a on a.org_id = o.id where o.id = p_org),
    'INR');
$$;

-- ---- 4) fixed: the studio cannot change it; HQ can, but never during a paid subscription -----------------------------
create or replace function public.tg_r25_billing_currency_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r25-currency-0273
declare v_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if new.billing_currency is not distinct from old.billing_currency then return new; end if;
  if v_role not in ('authenticated', 'anon') then return new; end if;                -- service role / maintenance
  if new.billing_currency is null then
    raise exception 'The billing currency cannot be cleared' using errcode = '22023'; end if;
  if not (new.billing_currency in ('INR', 'USD')
          or (public.is_platform_admin() and exists (select 1 from public.helm_plan_prices pp where pp.currency = new.billing_currency))) then
    raise exception 'Billing currency must be INR or USD' using errcode = '22023'; end if;
  if old.billing_currency is not null and not public.is_platform_admin() then
    raise exception 'Your billing currency is fixed when the studio is created. Contact Helm to change it.'
      using errcode = '42501', hint = 'billing_currency_fixed'; end if;
  if old.billing_currency is not null and exists (select 1 from public.studio_subscriptions s
       where s.org_id = new.org_id and s.status in ('active', 'past_due')) then
    raise exception 'The billing currency cannot change during a paid subscription. Cancel it first, then start the new plan in the other currency.'
      using errcode = '22023', hint = 'billing_currency_fixed'; end if;
  return new;
end $$;
revoke all on function public.tg_r25_billing_currency_lock() from public;
drop trigger if exists r25_billing_currency_lock on public.studio_account;
create trigger r25_billing_currency_lock before update of billing_currency on public.studio_account
  for each row execute function public.tg_r25_billing_currency_lock();

-- ---- 5) sign-up: set the new studio's billing currency ONCE from the browser time zone --------------------------------
create or replace function public.my_billing_currency_init(p_timezone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r25-currency-0273: admin of the caller's own studio; only while it is empty; never changes a set value
declare v_org uuid := public.current_org_id(); v_now text; v_cur text; v_tz text := btrim(coalesce(p_timezone, ''));
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then raise exception 'not authorized' using errcode = '42501'; end if;
  if length(v_tz) > 64 or v_tz !~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+){1,2}$' then v_tz := null; end if;
  select a.billing_currency into v_now from public.studio_account a where a.org_id = v_org;
  if v_now is not null then return jsonb_build_object('currency', v_now, 'set', false); end if;
  if exists (select 1 from public.studio_subscriptions s where s.org_id = v_org and s.status in ('active', 'past_due'))
     or exists (select 1 from public.subscription_payments sp where sp.org_id = v_org and sp.voided_at is null) then
    v_cur := public._checkout_currency(v_org);                      -- already paying: keep what they were shown
  else
    v_cur := public._r25_currency_for((select a.country from public.studio_account a where a.org_id = v_org), v_tz);
  end if;
  insert into public.studio_account(org_id, billing_currency) values (v_org, v_cur)
  on conflict (org_id) do update set billing_currency = excluded.billing_currency, updated_at = now(), updated_by = auth.uid()
   where public.studio_account.billing_currency is null;
  select a.billing_currency into v_cur from public.studio_account a where a.org_id = v_org;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'studio_account.billing_currency', 'studio_account', v_org::text,
           jsonb_build_object('billing_currency', v_cur, 'timezone', v_tz), v_org, now()
      from auth.users u where u.id = auth.uid();
  return jsonb_build_object('currency', v_cur, 'set', true);
end $$;
revoke all on function public.my_billing_currency_init(text) from public;

-- ---- 6) sign-up plan cards in the visitor's currency (no studio needed; no Razorpay ids) ------------------------------
create or replace function public.signup_plan_options_for(p_timezone text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r25-currency-0273: signup_plan_options (0255) in the currency this person will be billed in
declare v_org uuid; v_cur text; v_base jsonb; v_plans jsonb;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  v_org := (select p.org_id from public.profiles p where p.id = auth.uid());
  v_cur := case when v_org is not null then public._checkout_currency(v_org)
                else public._r25_currency_for(null, left(btrim(coalesce(p_timezone, '')), 64)) end;
  v_base := public.signup_plan_options();
  select coalesce(jsonb_agg(x - 'id' - 'rzp_monthly' - 'rzp_yearly' order by (x ->> 'sort_order')::int, x ->> 'code'), '[]'::jsonb)
    into v_plans
    from (select public._checkout_plan_price(hp.code, v_cur) x from public.helm_plans hp where hp.active) q
   where x is not null;
  return v_base || jsonb_build_object('currency', v_cur, 'plans', v_plans);
end $$;
revoke all on function public.signup_plan_options_for(text) from public;

do $$ begin
  revoke all on function public._r25_currency_for(text, text) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.my_billing_currency_init(text) from anon';
    execute 'revoke all on function public.signup_plan_options_for(text) from anon';
    execute 'revoke all on function public._r25_currency_for(text, text) from anon';
    execute 'revoke all on function public.tg_r25_billing_currency_lock() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.my_billing_currency_init(text) to authenticated';
    execute 'grant execute on function public.signup_plan_options_for(text) to authenticated';
    execute 'revoke all on function public._r25_currency_for(text, text) from authenticated';
    execute 'revoke all on function public.tg_r25_billing_currency_lock() from authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
