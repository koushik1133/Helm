-- onboarding-checkout.sql — 0056 onboarding checkout: who must check out, plans + prices
-- per studio currency, server tax preview, terms recorded server-side, the 14-day trial
-- (testing bypass + payment-pending) and the service-role attach used by the edge function.
-- Uses its OWN studios (C, D, E) so no other suite's rows are touched; global billing
-- settings are saved first and restored at the end.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _oc; create temp table _oc(name text, result text); grant all on _oc to anon, authenticated, service_role;
drop table if exists _oct; create temp table _oct as select clock_timestamp() as t;
drop table if exists _ocs; create temp table _ocs as select * from public.helm_billing_settings where id;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); execute 'set role service_role'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
declare c text := current_setting('request.jwt.claims', true); r text := current_user;
begin execute 'reset role'; insert into _oc values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end);
  if coalesce(c, '') <> '' then perform set_config('request.jwt.claims', c, false); end if;
  if r in ('anon', 'authenticated', 'service_role') then execute format('set role %I', r); end if; end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.j(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb; begin execute 'select (' || p_sql || ')::jsonb' into r; return r; exception when others then return jsonb_build_object('err', sqlstate); end $$;
grant execute on function pg_temp.j(text) to anon, authenticated, service_role;

-- ---- fixtures: studios C (IN, intra-state), D (US, USD), E (created before the cutoff) ----
do $$ declare c uuid := 'c0000000-0000-4000-8000-0000000000c1'; d uuid := 'd0000000-0000-4000-8000-0000000000d1';
  e uuid := 'e0000000-0000-4000-8000-0000000000e1'; u uuid; em text; o uuid; r text;
begin
  perform pg_temp.su();
  insert into public.organizations(id,name,currency,timezone,brand,plan,created_at) values
    (c,'Studio C','INR','Asia/Kolkata','{}'::jsonb,'pro',now()),
    (d,'Studio D','USD','America/New_York','{}'::jsonb,'pro',now()),
    (e,'Studio E','INR','Asia/Kolkata','{}'::jsonb,'pro','2020-01-01')
  on conflict (id) do nothing;
  for em, o, r in values ('c_admin@c.test', c, 'admin'), ('c_staff@c.test', c, 'sales'), ('d_admin@d.test', d, 'admin'), ('e_admin@e.test', e, 'admin') loop
    select id into u from auth.users where email = em;
    if u is null then u := auth.seed_user(em); end if;
    insert into public.profiles(id,email,role,org_id,must_change_password,created_at) values (u, em, r, o, false, now())
      on conflict (id) do update set role = excluded.role, org_id = excluded.org_id;
  end loop;
  delete from public.studio_subscriptions where org_id in (c, d, e);   -- this suite's own studios only
  update public.helm_billing_settings set seller_state = 'Telangana', seller_country = 'IN', lut_number = null,
    allow_trial_bypass = true, online_payments_live = false where id;
  insert into public.studio_account(org_id, country, state) values (c, 'IN', 'Telangana') on conflict (org_id) do update set country = 'IN', state = 'Telangana', terms_version_accepted = null, terms_accepted_at = null;
  insert into public.studio_account(org_id, country, state, billing_currency) values (d, 'US', 'NY', 'USD') on conflict (org_id) do update set country = 'US', state = 'NY', billing_currency = 'USD', terms_version_accepted = null, terms_accepted_at = null;
  insert into public.helm_plans(code, name, price_monthly, currency, active, features, sort_order)
    values ('zz-co-basic', 'Basic', 1000, 'INR', true, '["A","B"]', 1) on conflict (code) do update set active = true, price_monthly = 1000;
  insert into public.helm_plan_prices(plan_id, currency, price_monthly, price_yearly)
    select id, 'INR', 1000, 10000 from public.helm_plans where code = 'zz-co-basic'
    on conflict (plan_id, currency) do update set price_monthly = 1000, price_yearly = 10000, razorpay_plan_id_monthly = null, razorpay_plan_id_yearly = null;
  insert into public.helm_plan_prices(plan_id, currency, price_monthly, price_yearly)
    select id, 'USD', 20, null from public.helm_plans where code = 'zz-co-basic'
    on conflict (plan_id, currency) do update set price_monthly = 20, price_yearly = null;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('zz-co-off', 'Off', 5, 'INR', false) on conflict (code) do nothing;
end $$;

-- ---- 1) checkout gate ------------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('c_admin@c.test'); j := public.my_checkout_status();
  perform pg_temp.res('01 new studio admin must check out', (j ->> 'required')::boolean and j ->> 'reason' = 'needs_checkout', j::text);
  perform pg_temp.login('c_staff@c.test'); j := public.my_checkout_status();
  perform pg_temp.res('02 invited member never checks out', not (j ->> 'required')::boolean and j ->> 'reason' = 'member', j::text);
  perform pg_temp.login('e_admin@e.test'); j := public.my_checkout_status();
  perform pg_temp.res('03 studio older than 0056 is never sent to checkout', not (j ->> 'required')::boolean and j ->> 'reason' = 'existing_studio', j::text);
  perform pg_temp.su(); execute 'set role anon';
  perform pg_temp.res('04 anon cannot call checkout RPCs',
    pg_temp.try('select public.my_checkout_status()') = '42501' and pg_temp.try('select public.my_checkout_options()') = '42501'
    and pg_temp.try('select public.my_start_trial(''bypass'')') = '42501');
end $$;

-- ---- 2) options + preview per studio ------------------------------------------------------------
do $$ declare j jsonb; p jsonb; begin
  perform pg_temp.login('c_admin@c.test'); j := public.my_checkout_options();
  select x into p from jsonb_array_elements(j -> 'plans') x where x ->> 'code' = 'zz-co-basic';
  perform pg_temp.res('05 options: INR studio gets INR prices', j ->> 'currency' = 'INR' and (p ->> 'monthly')::numeric = 1000 and (p ->> 'yearly')::numeric = 10000, j::text);
  perform pg_temp.res('06 options: inactive plans hidden, no provider ids leak',
    not exists (select 1 from jsonb_array_elements(j -> 'plans') x where x ->> 'code' = 'zz-co-off')
    and position('rzp_' in j::text) = 0 and position('"id"' in j::text) = 0 and (p -> 'features') = '["A","B"]'::jsonb, j::text);
  perform pg_temp.res('07 options: flags + terms version', (j ->> 'bypass_allowed')::boolean and not (j ->> 'online_payments_live')::boolean
    and j ->> 'terms_version' is not null and not (j ->> 'terms_accepted')::boolean, j::text);
  j := public.my_checkout_preview('zz-co-basic', 'monthly');
  perform pg_temp.res('08 preview intra-state: CGST+SGST split, total server-side',
    (j ->> 'net')::numeric = 1000 and (j ->> 'tax')::numeric = 180 and (j ->> 'total')::numeric = 1180 and j ->> 'regime' = 'IN_GST_INTRA'
    and j -> 'components' -> 0 ->> 'name' = 'CGST' and (j -> 'components' -> 1 ->> 'amount')::numeric = 90 and j ->> 'currency' = 'INR'
    and not (j ? 'razorpay_plan_id'), j::text);
  j := public.my_checkout_preview('zz-co-basic', 'yearly');
  perform pg_temp.res('09 preview yearly', (j ->> 'total')::numeric = 11800, j::text);
  perform pg_temp.res('10 preview rejects bad interval / unknown / inactive plan',
    pg_temp.try('select public.my_checkout_preview(''zz-co-basic'', ''weekly'')') = '22023'
    and pg_temp.try('select public.my_checkout_preview(''nope-plan'', ''monthly'')') = '22023'
    and pg_temp.try('select public.my_checkout_preview(''zz-co-off'', ''monthly'')') = '22023'
    and pg_temp.try('select public.my_checkout_preview(''x''''; drop table x; --'', ''monthly'')') = '22023');
  perform pg_temp.login('c_staff@c.test');
  perform pg_temp.res('11 member cannot read options / preview',
    pg_temp.try('select public.my_checkout_options()') = '42501' and pg_temp.try('select public.my_checkout_preview(''zz-co-basic'', ''monthly'')') = '42501');
  perform pg_temp.login('d_admin@d.test'); j := public.my_checkout_options();
  select x into p from jsonb_array_elements(j -> 'plans') x where x ->> 'code' = 'zz-co-basic';
  perform pg_temp.res('12 Org B isolation: USD studio sees its own currency + price', j ->> 'currency' = 'USD' and (p ->> 'monthly')::numeric = 20 and p ->> 'yearly' is null, j::text);
  j := public.my_checkout_preview('zz-co-basic', 'monthly');
  perform pg_temp.res('13 export preview (no LUT): IGST on export, USD, place of supply US',
    j ->> 'regime' = 'EXPORT_IGST_PAID' and j ->> 'currency' = 'USD' and (j ->> 'total')::numeric = 23.6 and j ->> 'place_of_supply' = 'US' and j ->> 'note' is not null, j::text);
  perform pg_temp.res('14 no yearly price in USD → refused', pg_temp.try('select public.my_checkout_preview(''zz-co-basic'', ''yearly'')') = '22023');
  perform pg_temp.res('15 checkout RPCs take no studio id (cannot target another studio)',
    not exists (select 1 from pg_proc where proname in ('my_checkout_options','my_checkout_preview','my_checkout_prepare','my_start_trial','my_checkout_status')
                 and pg_get_function_identity_arguments(oid) ~ 'uuid'));
end $$;

-- ---- 3) terms recorded server-side --------------------------------------------------------------
do $$ declare tv text; a jsonb; begin
  perform pg_temp.su(); select terms_version into tv from public.helm_billing_settings where id;
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('16 trial before terms → refused', pg_temp.try('select public.my_start_trial(''bypass'')') = '22023');
  perform pg_temp.res('17 client cannot send the acceptance timestamp',
    pg_temp.try('select public.my_studio_account_update(''{"terms_accepted_at":"2001-01-01"}'')') = '22023');
  a := public.my_studio_account_update(jsonb_build_object('terms_version_accepted', tv, 'legal_business_name', '  Studio C Pvt Ltd  '));
  perform pg_temp.su();
  perform pg_temp.res('18 terms version + server timestamp + consent log',
    (select terms_version_accepted = tv and terms_accepted_at > now() - interval '1 minute' and legal_business_name = 'Studio C Pvt Ltd'
       from public.studio_account where org_id = 'c0000000-0000-4000-8000-0000000000c1')
    and exists (select 1 from public.studio_consent_log where org_id = 'c0000000-0000-4000-8000-0000000000c1' and kind = 'terms' and version = tv));
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('19 options now report terms accepted', (public.my_checkout_options() ->> 'terms_accepted')::boolean);
  perform pg_temp.login('c_staff@c.test');
  perform pg_temp.res('20 member cannot accept terms for the studio',
    pg_temp.try(format('select public.my_studio_account_update(%L)', jsonb_build_object('terms_version_accepted', tv))) = '42501');
  perform pg_temp.login('d_admin@d.test'); perform public.my_studio_account_update(jsonb_build_object('terms_version_accepted', tv));
end $$;

-- ---- 4) trial bypass ---------------------------------------------------------------------------------
do $$ declare j jsonb; j2 jsonb; begin
  perform pg_temp.login('c_staff@c.test');
  perform pg_temp.res('21 member cannot start a trial', pg_temp.try('select public.my_start_trial(''bypass'')') = '42501');
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('22 unknown source / plan refused',
    pg_temp.try('select public.my_start_trial(''free-forever'')') = '22023' and pg_temp.try('select public.my_start_trial(''bypass'', ''nope-plan'')') = '22023');
  j := public.my_start_trial('bypass', 'zz-co-basic');
  perform pg_temp.res('23 bypass starts a 14-day trial', j ->> 'result' = 'started' and (j ->> 'trial_ends_at')::date = current_date + 14, j::text);
  j2 := public.my_start_trial('bypass');
  perform pg_temp.res('24 idempotent: second call returns the same trial', j2 ->> 'result' = 'already_trial' and j2 ->> 'trial_ends_at' = j ->> 'trial_ends_at', j2::text);
  perform pg_temp.res('25 gate: subscribed studio no longer sent to checkout', not (public.my_checkout_status() ->> 'required')::boolean);
  perform pg_temp.su();
  perform pg_temp.res('26 one row, trial_source bypass, audited once',
    (select count(*) = 1 and bool_and(status = 'trial' and trial_source = 'bypass') from public.studio_subscriptions where org_id = 'c0000000-0000-4000-8000-0000000000c1')
    and (select count(*) from public.audit_log where action = 'subscription.trial_started' and org_id = 'c0000000-0000-4000-8000-0000000000c1' and at >= (select t from _oct)) = 1);
  perform pg_temp.res('27 Org B untouched by Org A trial', not exists (select 1 from public.studio_subscriptions where org_id = 'd0000000-0000-4000-8000-0000000000d1'));
  update public.studio_subscriptions set status = 'active' where org_id = 'c0000000-0000-4000-8000-0000000000c1';
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('28 paid/active subscription → trial refused', pg_temp.try('select public.my_start_trial(''bypass'')') = '22023');
  -- HQ switches
  perform pg_temp.su(); update public.helm_billing_settings set allow_trial_bypass = false where id;
  perform pg_temp.login('d_admin@d.test');
  perform pg_temp.res('29 bypass blocked when HQ flag is off', pg_temp.try('select public.my_start_trial(''bypass'')') = '42501');
  perform pg_temp.res('30 options report bypass off', not (public.my_checkout_options() ->> 'bypass_allowed')::boolean);
  perform pg_temp.su(); update public.helm_billing_settings set online_payments_live = true where id;
  perform pg_temp.login('d_admin@d.test');
  perform pg_temp.res('31 payment-pending trial blocked once online payment is live', pg_temp.try('select public.my_start_trial(''payment_pending'')') = '42501');
  perform pg_temp.su(); update public.helm_billing_settings set online_payments_live = false where id;
  perform pg_temp.login('d_admin@d.test'); j := public.my_start_trial('payment_pending');
  perform pg_temp.res('32 payment-pending trial while payment is dormant', j ->> 'result' = 'started', j::text);
  perform pg_temp.su(); execute 'set role authenticated';
  perform pg_temp.res('33 clients still cannot write studio_subscriptions directly',
    pg_temp.try('insert into public.studio_subscriptions(org_id, status) values (''e0000000-0000-4000-8000-0000000000e1'', ''active'')') = '42501');
end $$;

-- ---- 5) prepare (edge function, as the caller) + attach (service role) --------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su(); update public.studio_subscriptions set status = 'trial' where org_id = 'c0000000-0000-4000-8000-0000000000c1';
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('34 prepare refuses a plan with no Razorpay plan id', pg_temp.try('select public.my_checkout_prepare(''zz-co-basic'', ''monthly'')') = '22023');
  perform pg_temp.su();
  update public.helm_plan_prices set razorpay_plan_id_monthly = 'plan_TEST123456' where currency = 'INR' and plan_id = (select id from public.helm_plans where code = 'zz-co-basic');
  perform pg_temp.login('c_admin@c.test'); j := public.my_checkout_prepare('zz-co-basic', 'monthly');
  perform pg_temp.res('35 prepare returns caller studio + server total + provider plan',
    j ->> 'org_id' = 'c0000000-0000-4000-8000-0000000000c1' and (j ->> 'total')::numeric = 1180 and j ->> 'razorpay_plan_id' = 'plan_TEST123456', j::text);
  perform pg_temp.login('c_staff@c.test');
  perform pg_temp.res('36 member cannot prepare', pg_temp.try('select public.my_checkout_prepare(''zz-co-basic'', ''monthly'')') = '42501');
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('37 attach is service-role only', pg_temp.try('select public.checkout_attach_subscription(''c0000000-0000-4000-8000-0000000000c1'', ''sub_ABCDEF123'', ''zz-co-basic'', ''monthly'')') = '42501');
  perform pg_temp.svc();
  perform pg_temp.res('38 attach validates the subscription id', pg_temp.try('select public.checkout_attach_subscription(''c0000000-0000-4000-8000-0000000000c1'', ''x;--'', ''zz-co-basic'', ''monthly'')') = '22023');
  perform pg_temp.res('39 attach records the provider subscription',
    public.checkout_attach_subscription('c0000000-0000-4000-8000-0000000000c1', 'sub_ABCDEF123', 'zz-co-basic', 'monthly'));
  perform pg_temp.su();
  perform pg_temp.res('40 webhook can now map sub → studio',
    (select org_id from public.studio_subscriptions where provider_subscription_id = 'sub_ABCDEF123') = 'c0000000-0000-4000-8000-0000000000c1'
    and (select billing_interval from public.studio_subscriptions where org_id = 'c0000000-0000-4000-8000-0000000000c1') = 'monthly');
  update public.studio_subscriptions set status = 'active' where org_id = 'c0000000-0000-4000-8000-0000000000c1';
  perform pg_temp.svc();
  perform pg_temp.res('41 attach never overwrites an active subscription',
    not public.checkout_attach_subscription('c0000000-0000-4000-8000-0000000000c1', 'sub_ZZZZZZ999', 'zz-co-basic', 'monthly'));
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('42 prepare refuses an already-active studio', pg_temp.try('select public.my_checkout_prepare(''zz-co-basic'', ''monthly'')') = '22023');
  perform pg_temp.res('43 HQ checkout switches are operator-only',
    pg_temp.try('select public.hq_set_checkout_settings(true, true)') = '42501'
    and pg_temp.try('select public.hq_set_plan_checkout(''zz-co-basic'', ''INR'', null, null)') = '42501');
end $$;

-- ---- 6) HQ operator UI writes/reads ------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.login('admin@helm.events');
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', 'aal2'))::text, false);
  j := public.hq_set_checkout_settings(false, true, '2026-11');
  perform pg_temp.res('44 HQ: checkout switches saved', not (j ->> 'allow_trial_bypass')::boolean and (j ->> 'online_payments_live')::boolean and j ->> 'terms_version' = '2026-11', j::text);
  perform public.hq_set_plan_checkout('zz-co-basic', 'INR', 'Basic plan', '["One","Two"]'::jsonb, null, 'plan_HQSET12345', 'plan_HQYEAR12345');
  select x into j from jsonb_array_elements(public.hq_plan_checkout()) x where x ->> 'code' = 'zz-co-basic';
  perform pg_temp.res('45 HQ: plan checkout details saved + listed',
    j ->> 'description' = 'Basic plan' and j -> 'features' = '["One","Two"]'::jsonb
    and exists (select 1 from jsonb_array_elements(j -> 'prices') p where p ->> 'currency' = 'INR' and p ->> 'razorpay_plan_id_monthly' = 'plan_HQSET12345' and p ->> 'razorpay_plan_id_yearly' = 'plan_HQYEAR12345'), j::text);
  perform pg_temp.res('46 HQ: bad Razorpay id / features refused',
    pg_temp.try('select public.hq_set_plan_checkout(''zz-co-basic'', ''INR'', null, null, null, ''pay_x'', null)') = '22023'
    and pg_temp.try('select public.hq_set_plan_checkout(''zz-co-basic'', ''INR'', null, ''[1]''::jsonb)') = '22023');
  perform pg_temp.login('c_admin@c.test');
  perform pg_temp.res('47 studio admin cannot read HQ plan checkout', pg_temp.try('select public.hq_plan_checkout()') = '42501');
end $$;

-- ---- restore --------------------------------------------------------------------------------------
do $$ begin perform pg_temp.su();
  update public.helm_billing_settings b set seller_state = s.seller_state, seller_country = s.seller_country, lut_number = s.lut_number,
    allow_trial_bypass = s.allow_trial_bypass, online_payments_live = s.online_payments_live, terms_version = s.terms_version from _ocs s where b.id;
end $$;
select pg_temp.su();
select name, result from _oc order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 47 then 'ONBOARDING-CHECKOUT: ALL PASS (47/47)'
            else 'ONBOARDING-CHECKOUT: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/47 ran' end from _oc;
