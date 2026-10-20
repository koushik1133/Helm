-- r25-currency-0273.sql -- 0273: USD list prices next to INR (fixed per currency, never converted), one billing currency per
-- studio fixed at sign-up (India -> INR, elsewhere -> USD; existing studios keep INR), the sign-up and /checkout plan lists
-- in that currency, and the lock (studio cannot change it; HQ can, never during a paid subscription).
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _tc(name text, result text); grant all on _tc to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = 'admin@helm.events';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', 'admin@helm.events', 'aal', 'aal2')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _tc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '<null>') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
-- runs p_sql as whoever is logged in; 'ok:<value>' or 'err:<sqlstate>:<message>'
create or replace function pg_temp.q(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return 'ok:' || coalesce(v, ''); exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.q(text) to anon, authenticated, service_role;

-- ---- the backfill: a studio that exists before 0273 first runs keeps INR --------------------------------------------
do $$ begin
  perform pg_temp.su();
  update public.helm_billing_settings set billing_currency_set_at = null where id;
  -- pre-existing studios with an empty billing currency, and one already set to USD
  update public.studio_account set billing_currency = null where org_id in (select id from public.organizations);
  insert into public.studio_account(org_id, billing_currency)
    select o.id, 'USD' from public.organizations o join public.profiles p on p.org_id = o.id where p.email = 'b_admin@b.test' limit 1
  on conflict (org_id) do update set billing_currency = 'USD';
end $$;

-- ---- the migration, twice (safe to re-run) -------------------------------------------------------------------------
\ir ../../supabase/migrations/0273_billing_currency.sql
\ir ../../supabase/migrations/0273_billing_currency.sql

do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set require_mfa = false;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  if not exists (select 1 from auth.users where email = 'r273_us@d.test') then perform auth.seed_user('r273_us@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'r273_in@d.test') then perform auth.seed_user('r273_in@d.test'); end if;
  update public.profiles set org_id = null where email in ('r273_us@d.test', 'r273_in@d.test');
  delete from public.auth_rate_hits where bucket = 'studio_create';
end $$;

-- ---- 1) prices -------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 USD list prices: Starter 24 / 240, Studio 59 / 590',
    (select pp.price_monthly = 24 and pp.price_yearly = 240 from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id
      where hp.code = 'starter' and pp.currency = 'USD')
    and (select pp.price_monthly = 59 and pp.price_yearly = 590 from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id
      where hp.code = 'studio' and pp.currency = 'USD'));
  perform pg_temp.res('02 INR prices untouched (1999 / 19990, 4999 / 49990), one row per plan + currency',
    (select pp.price_monthly = 1999 and pp.price_yearly = 19990 from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id
      where hp.code = 'starter' and pp.currency = 'INR')
    and (select pp.price_monthly = 4999 from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id
      where hp.code = 'studio' and pp.currency = 'INR')
    and (select count(*) from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id
         where pp.currency = 'USD' and hp.code in ('starter', 'studio')) = 2);
end $$;
-- an HQ-changed USD price is never overwritten by a re-run
update public.helm_plan_prices set price_monthly = 25 where currency = 'USD' and plan_id = (select id from public.helm_plans where code = 'starter');
\ir ../../supabase/migrations/0273_billing_currency.sql
do $$ begin
  perform pg_temp.res('03 re-run keeps an HQ price (25 stays 25)',
    (select pp.price_monthly from public.helm_plan_prices pp join public.helm_plans hp on hp.id = pp.plan_id where hp.code = 'starter' and pp.currency = 'USD') = 25);
end $$;
update public.helm_plan_prices set price_monthly = 24 where currency = 'USD' and plan_id = (select id from public.helm_plans where code = 'starter');

-- ---- 2) backfill ----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('04 every existing studio has a billing currency (empty ones -> INR)',
    not exists (select 1 from public.organizations o left join public.studio_account a on a.org_id = o.id where a.billing_currency is null));
  perform pg_temp.res('05 a value already set is never overwritten (USD stays USD)',
    (select a.billing_currency from public.studio_account a join public.profiles p on p.org_id = a.org_id where p.email = 'b_admin@b.test' limit 1) = 'USD');
  perform pg_temp.res('06 the backfill runs once (time recorded)',
    (select billing_currency_set_at is not null from public.helm_billing_settings where id));
end $$;

-- ---- 3) the rule -----------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('07 rule: IN -> INR, other country -> USD, India time -> INR, other time zone -> USD, unknown -> INR',
    public._r25_currency_for('IN', 'America/New_York') = 'INR' and public._r25_currency_for('ae', 'Asia/Kolkata') = 'USD'
    and public._r25_currency_for(null, 'Asia/Kolkata') = 'INR' and public._r25_currency_for(null, 'Asia/Calcutta') = 'INR'
    and public._r25_currency_for(null, 'Europe/London') = 'USD' and public._r25_currency_for(null, 'America/Argentina/Buenos_Aires') = 'USD'
    and public._r25_currency_for(null, null) = 'INR' and public._r25_currency_for('', '') = 'INR' and public._r25_currency_for(null, '<x>') = 'INR');
end $$;

-- ---- 4) sign-up cards (no studio yet) -----------------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.anon(); r := pg_temp.q($q$select public.signup_plan_options_for('Europe/London')::text$q$);
  perform pg_temp.res('08 sign-up list: anonymous refused', r like 'err:42501%' or r like 'err:%permission%', r);
  perform pg_temp.login('r273_us@d.test'); r := pg_temp.q($q$select public.signup_plan_options_for('America/New_York')::text$q$);
  perform pg_temp.res('09 sign-up list from New York: USD, Starter 24, no Razorpay ids, trial days kept',
    r like '%"currency": "USD"%' and r like '%"monthly": 24%' and r not like '%rzp%' and r like '%"trial_days": %' and r not like '%1999%', r);
  perform pg_temp.login('r273_in@d.test'); r := pg_temp.q($q$select public.signup_plan_options_for('Asia/Kolkata')::text$q$);
  perform pg_temp.res('10 sign-up list from India: INR, Starter 1999', r like '%"currency": "INR"%' and r like '%"monthly": 1999%', r);
  r := pg_temp.q($q$select public.signup_plan_options_for(null)::text$q$);
  perform pg_temp.res('11 sign-up list with no time zone: INR (India-first)', r like '%"currency": "INR"%', r);
  r := pg_temp.q($q$select public.signup_plan_options()::text$q$);
  perform pg_temp.res('12 the old 0255 list is unchanged (INR)', r like '%"currency": "INR"%' and r like '%"monthly": 1999%', r);
  perform pg_temp.su();
end $$;

-- ---- 5) a new studio abroad: USD, fixed --------------------------------------------------------------------------------
do $$ declare r text; v_org uuid; v text := public._account_terms_version(); begin
  perform pg_temp.login('r273_us@d.test');
  r := pg_temp.q(format($q$select public.create_direct_studio('R273 New York Events', 'studio', 'monthly', %L, 'UA')::text$q$, v));
  perform pg_temp.res('13 a new direct studio is created', r like '%"result": "created"%', r);
  perform pg_temp.su(); select org_id into v_org from public.profiles where email = 'r273_us@d.test';
  perform pg_temp.res('14 a brand-new studio starts with an empty billing currency (India time default until set)',
    (select billing_currency from public.studio_account where org_id = v_org) is null and public._checkout_currency(v_org) = 'INR');
  perform pg_temp.login('r273_us@d.test');
  r := pg_temp.q($q$select public.my_billing_currency_init('America/New_York')::text$q$);
  perform pg_temp.res('15 sign-up sets it once from the browser time zone: USD', r like '%"currency": "USD"%' and r like '%"set": true%', r);
  r := pg_temp.q($q$select public.my_billing_currency_init('Asia/Kolkata')::text$q$);
  perform pg_temp.res('16 a second call changes nothing (still USD)', r like '%"currency": "USD"%' and r like '%"set": false%', r);
  r := pg_temp.q($q$select public.my_checkout_options()::text$q$);
  perform pg_temp.res('17 /checkout plans in USD (Studio 59 / 590)', r like '%"currency": "USD"%' and r like '%"monthly": 59%' and r like '%"yearly": 590%' and r not like '%4999%', r);
  r := pg_temp.q($q$select public.signup_plan_options_for('Asia/Kolkata')::text$q$);
  perform pg_temp.res('18 once the studio exists, the sign-up list follows the studio (USD), not the time zone', r like '%"currency": "USD"%', r);
  r := pg_temp.q($q$select public.my_checkout_preview('starter', 'yearly')::text$q$);
  perform pg_temp.res('19 the server preview is in USD (net 240)', r like '%"currency": "USD"%' and r like '%"net": 240%', r);
  r := pg_temp.q($q$select public.my_studio_account_update('{"billing_currency": "INR"}'::jsonb)::text$q$);
  perform pg_temp.res('20 the studio cannot change its billing currency', r like 'err:42501:%fixed%', r);
  r := pg_temp.q($q$select public.my_studio_account_update('{"billing_currency": ""}'::jsonb)::text$q$);
  perform pg_temp.res('21 ... nor clear it', r like 'err:22023:%cleared%', r);
  r := pg_temp.q($q$select public.my_studio_account_update('{"city": "New York"}'::jsonb)::text$q$);
  perform pg_temp.res('22 other billing details still save', r like 'ok:%', r);
  perform pg_temp.su();
  perform pg_temp.res('23 audit row for the sign-up choice', exists (select 1 from public.audit_log a where a.org_id = v_org
    and a.action = 'studio_account.billing_currency' and a.changed ->> 'billing_currency' = 'USD'));
end $$;

-- ---- 6) a new studio in India: INR; country beats time zone -------------------------------------------------------------
do $$ declare r text; v_org uuid; v text := public._account_terms_version(); begin
  perform pg_temp.login('r273_in@d.test');
  r := pg_temp.q(format($q$select public.create_direct_studio('R273 Hyderabad Decor', 'starter', 'monthly', %L, 'UA')::text$q$, v));
  perform pg_temp.res('24 an Indian direct studio is created', r like '%"result": "created"%', r);
  r := pg_temp.q($q$select public.my_studio_account_update('{"country": "IN"}'::jsonb)::text$q$);
  r := pg_temp.q($q$select public.my_billing_currency_init('Europe/London')::text$q$);
  perform pg_temp.res('25 billing country IN beats a travelling browser: INR', r like '%"currency": "INR"%', r);
  r := pg_temp.q($q$select public.my_checkout_options()::text$q$);
  perform pg_temp.res('26 /checkout plans in INR (Starter 1999)', r like '%"currency": "INR"%' and r like '%"monthly": 1999%', r);
  perform pg_temp.su();
end $$;

-- ---- 7) who may call --------------------------------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.login('a_staff@a.test'); r := pg_temp.q($q$select public.my_billing_currency_init('Europe/London')::text$q$);
  perform pg_temp.res('27 a non-admin member cannot set it', r like 'err:42501%', r);
  perform pg_temp.anon(); r := pg_temp.q($q$select public.my_billing_currency_init('Europe/London')::text$q$);
  perform pg_temp.res('28 anonymous cannot set it', r like 'err:42501%' or r like 'err:%permission%', r);
  perform pg_temp.su();
  perform pg_temp.res('29 grants: new RPCs signed-in only; the rule helper nobody',
    has_function_privilege('authenticated', 'public.my_billing_currency_init(text)', 'execute')
    and not has_function_privilege('anon', 'public.my_billing_currency_init(text)', 'execute')
    and has_function_privilege('authenticated', 'public.signup_plan_options_for(text)', 'execute')
    and not has_function_privilege('anon', 'public.signup_plan_options_for(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r25_currency_for(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.tg_r25_billing_currency_lock()', 'execute'));
end $$;

-- ---- 8) HQ: may change it, never during a paid subscription; INR / USD only ---------------------------------------------
do $$ declare r text; v_org uuid; begin
  perform pg_temp.su(); select org_id into v_org from public.profiles where email = 'r273_us@d.test';
  perform pg_temp.op();
  r := pg_temp.q(format($q$select public.hq_set_studio_account(%L, '{"billing_currency": "INR"}'::jsonb)::text$q$, v_org));
  perform pg_temp.res('30 HQ can correct it before any paid subscription', r like 'ok:%' and r like '%"billing_currency": "INR"%', r);
  r := pg_temp.q(format($q$select public.hq_set_studio_account(%L, '{"billing_currency": "EUR"}'::jsonb)::text$q$, v_org));
  perform pg_temp.res('31 a currency with no prices is refused', r like 'err:22023:%INR or USD%', r);
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status, updated_at) values (v_org, 'active', now())
  on conflict (org_id) do update set status = 'active';
  perform pg_temp.op();
  r := pg_temp.q(format($q$select public.hq_set_studio_account(%L, '{"billing_currency": "USD"}'::jsonb)::text$q$, v_org));
  perform pg_temp.res('32 not even HQ during an active subscription', r like 'err:22023:%paid subscription%', r);
  perform pg_temp.su();
  perform pg_temp.res('33 the value is unchanged after the refusal (INR)', (select billing_currency from public.studio_account where org_id = v_org) = 'INR');
  -- maintenance (no API role) is never blocked
  update public.studio_account set billing_currency = 'USD' where org_id = v_org;
  perform pg_temp.res('34 direct maintenance (SQL editor) is not blocked', (select billing_currency from public.studio_account where org_id = v_org) = 'USD');
end $$;

-- ---- 9) a quote currency is no longer the bill currency ----------------------------------------------------------------
do $$ declare v_org uuid; begin
  perform pg_temp.su();
  select o.id into v_org from public.organizations o join public.profiles p on p.org_id = o.id where p.email = 'a_admin@a.test' limit 1;
  update public.organizations set currency = 'AED' where id = v_org;
  perform pg_temp.res('35 an existing studio quoting in AED still bills in INR', public._checkout_currency(v_org) = 'INR');
end $$;

select name, result from _tc where result <> 'PASS';
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R25-CURRENCY-0273: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R25-CURRENCY-0273: FAIL' end as summary from _tc;
rollback;
