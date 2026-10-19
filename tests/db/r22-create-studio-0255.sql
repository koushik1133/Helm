-- r22-create-studio-0255.sql - 0255: one sign-up flow (account + Terms -> studio -> Pay now / free trial / Contact sales).
-- Each DO block is its own transaction (autocommit) so "later" writes are real. Local disposable PG only.
-- Proves: Terms recorded per person (version-checked, once), plans for the start cards (no Razorpay ids), the paid
-- studio is created with the Terms recorded in the same transaction and stays payment-gated, the waiting studio can
-- now save the Terms on /checkout (own consent row) but nothing else, Contact sales + switch-to-trial need the Terms,
-- operators never get a studio, the login profile keeps the sign-in e-mail, the sign-up answers save on the own studio
-- only, the light limit refuses, HQ's activation placeholder no longer uses up a trial, private tables stay closed.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _r255; create temp table _r255(name text, result text); grant all on _r255 to anon, authenticated;
create or replace function pg_temp.as_try(p_who text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  if p_who = 'anon' then perform auth.login_anon();
  elsif p_who is not null then perform auth.login_as((select id from auth.users where email = p_who)); end if;
  execute p_sql into v;
  perform auth.logout(); execute 'reset role';
  return 'ok:' || coalesce(v, '');
exception when others then
  perform auth.logout(); execute 'reset role';
  return 'err:' || sqlstate || ':' || sqlerrm;
end $$;
create or replace function pg_temp.t(p_name text, p_ok boolean, p_got text) returns void language sql as $$
  insert into _r255 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_got, '<null>') end);
$$;

do $$ begin
  execute 'reset role';
  if not exists (select 1 from auth.users where email = 'r255_paid@d.test') then perform auth.seed_user('r255_paid@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'r255_old@d.test') then perform auth.seed_user('r255_old@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'r255_lim@d.test') then perform auth.seed_user('r255_lim@d.test'); end if;
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  update public.platform_admins set require_mfa = false;
  update public.profiles set org_id = null where email in ('r255_paid@d.test', 'r255_old@d.test', 'r255_lim@d.test');
  delete from public.account_terms_acceptances where user_id in (select id from auth.users where email like 'r255_%');
  -- a re-run: the earlier runs' trial records for these test sign-ups (disposable DB only)
  delete from public.trial_grants where user_id in (select id from auth.users where email like 'r255_%');
  delete from public.auth_rate_hits where bucket = 'studio_create';
  update public.helm_billing_settings set online_payments_live = false where id;
end $$;

-- 1) Terms at sign-up
do $$ declare r text; v text := public._account_terms_version(); begin
  r := pg_temp.as_try('anon', $q$select public.accept_account_terms('x')::text$q$);
  perform pg_temp.t('terms: anonymous refused', r like 'err:42501%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_account_terms_status()::text$q$);
  perform pg_temp.t('terms: not accepted yet', r like '%"accepted": false%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.accept_account_terms('1999-01-01', 'UA', 'signup')::text$q$);
  perform pg_temp.t('terms: stale version refused (terms_outdated)', r like 'err:22023:%Terms were updated%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.accept_account_terms(%L, 'Mozilla/5.0', 'signup')::text$q$, v));
  perform pg_temp.t('terms: accepted', r like '%"accepted": true%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.accept_account_terms(%L, 'Other', 'google')::text$q$, v));
  perform pg_temp.t('terms: second call changes nothing',
    (select count(*) from public.account_terms_acceptances a join auth.users u on u.id = a.user_id where u.email = 'r255_paid@d.test') = 1
    and (select a.source from public.account_terms_acceptances a join auth.users u on u.id = a.user_id where u.email = 'r255_paid@d.test') = 'signup', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_account_terms_status()::text$q$);
  perform pg_temp.t('terms: status accepted with server time', r like '%"accepted": true%' and r like '%"accepted_at": "2%', r);
end $$;

-- 2) plans for the start cards
do $$ declare r text; begin
  r := pg_temp.as_try('anon', $q$select public.signup_plan_options()::text$q$);
  perform pg_temp.t('plans: anonymous refused', r like 'err:42501%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.signup_plan_options()::text$q$);
  perform pg_temp.t('plans: list with INR prices, trial days, no Razorpay ids',
    r like '%"code": "starter"%' and r like '%"monthly": %' and r like '%"trial_days": %' and r not like '%rzp%' and r like '%"currency": "INR"%', r);
end $$;

-- 3) the paid studio ("Pay now" / "Contact sales")
do $$ declare r text; v text := public._account_terms_version(); begin
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.create_direct_studio('R255 Paid', 'studio', 'yearly', 'old-terms')::text$q$);
  perform pg_temp.t('paid: stale Terms refused', r like 'err:22023:%current Terms%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.create_direct_studio('R255 Paid', 'nope', 'yearly', %L)::text$q$, v));
  perform pg_temp.t('paid: unknown plan refused', r like 'err:22023:%Choose a plan%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.create_direct_studio('X', 'studio', 'yearly', %L)::text$q$, v));
  perform pg_temp.t('paid: too-short name refused', r like 'err:22023:%studio name%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.create_direct_studio('R255 Paid Studio', 'studio', 'yearly', %L, 'UA')::text$q$, v));
  perform pg_temp.t('paid: created, waiting for payment', r like '%"result": "created"%' and r like '%"pending_payment": true%', r);
end $$;
do $$ declare r text; v_org uuid; v text := public._account_terms_version(); begin
  select org_id into v_org from public.profiles where email = 'r255_paid@d.test';
  perform pg_temp.t('paid: payment gate marker written', exists (select 1 from public.studio_payment_gate g where g.org_id = v_org), null);
  perform pg_temp.t('paid: studio Terms recorded (version + server time)',
    exists (select 1 from public.studio_account sa where sa.org_id = v_org and sa.terms_version_accepted = v and sa.terms_accepted_at is not null), null);
  perform pg_temp.t('paid: studio consent row', exists (select 1 from public.studio_consent_log c where c.org_id = v_org and c.kind = 'terms' and c.version = v), null);
  perform pg_temp.t('paid: audit row with the plan', exists (select 1 from public.audit_log a where a.org_id = v_org and a.action = 'studio.created_direct'
    and a.changed ->> 'plan' = 'studio' and a.changed ->> 'interval' = 'yearly'), null);
  perform pg_temp.t('paid: not a trial', not public._is_trial_org(v_org)
    and not exists (select 1 from public.organizations o where o.id = v_org and o.trial_ends_at is not null), null);
  perform pg_temp.t('paid: profile keeps the sign-in e-mail', (select email from public.profiles where org_id = v_org and role = 'admin' limit 1) = 'r255_paid@d.test', null);
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.create_direct_studio('Another', 'starter', 'monthly', %L)::text$q$, v));
  perform pg_temp.t('paid: second call returns the same studio', r like '%"result": "exists"%' and r like '%' || v_org::text || '%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_checkout_status()::text$q$);
  perform pg_temp.t('paid: /checkout required', r like '%"required": true%' and r like '%"pending_payment": true%', r);
  -- the waiting studio can save the Terms on /checkout (own consent row) ...
  r := pg_temp.as_try('r255_paid@d.test', format($q$select public.my_studio_account_update(jsonb_build_object('terms_version_accepted', %L, 'legal_business_name', 'R255 Pvt Ltd'))::text$q$, v));
  perform pg_temp.t('pending: Terms + billing save on /checkout (was refused before 0255)', r like 'ok:%', r);
  -- ... but nothing else
  r := pg_temp.as_try('r255_paid@d.test', format($q$insert into public.leads(org_id, name, status) values (%L, 'R255 lead', 'new') returning id::text$q$, v_org));
  perform pg_temp.t('pending: app write still refused', r like 'err:25006:%Choose a plan%', r);
  r := pg_temp.as_try('r255_paid@d.test', format($q$insert into public.studio_consent_log(org_id, kind, version, value, actor) values (%L, 'terms', 'x', true, null) returning id::text$q$, v_org));
  perform pg_temp.t('pending: no direct consent-log writes from the app', r like 'err:%', r);
end $$;

-- 4) sign-up answers on the own studio
do $$ declare r text; begin
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_studio_signup_details('Hyderabad', '2-5', array['wedding','corporate','wedding'])::text$q$);
  perform pg_temp.t('details: saved (city, team size, event types de-duplicated)',
    r like '%"city": "Hyderabad"%' and r like '%"team_size_band": "2-5"%' and r like '%"event_types": ["corporate", "wedding"]%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_studio_signup_details(null, '7', null)::text$q$);
  perform pg_temp.t('details: bad team size refused', r like 'err:22023:%team size%', r);
  r := pg_temp.as_try('r255_paid@d.test', $q$select public.my_studio_signup_details(null, null, array['rave'])::text$q$);
  perform pg_temp.t('details: unknown event type refused', r like 'err:22023:%event type%', r);
  r := pg_temp.as_try('r255_lim@d.test', $q$select public.my_studio_signup_details('X', null, null)::text$q$);
  perform pg_temp.t('details: a person with no studio refused', r like 'err:42501%', r);
  r := pg_temp.as_try('a_staff@a.test', $q$select public.my_studio_signup_details('X', null, null)::text$q$);
  perform pg_temp.t('details: a non-admin member refused', r like 'err:42501%' or r like 'err:%not authorized%', r);
end $$;

-- 5) Contact sales + switch to trial need the Terms
do $$ declare r text; begin
  r := pg_temp.as_try('r255_old@d.test', $q$select public.create_studio('R255 Old Direct', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('old path: create_studio still works (payment-gated)', r like 'ok:%' and length(r) > 10, r);
  r := pg_temp.as_try('r255_old@d.test', $q$select public.request_plan_activation('studio', 'monthly', 'R255 Old', 'Old Owner', 'r255_old@d.test')::text$q$);
  perform pg_temp.t('sales: refused without Terms', r like 'err:22023:%Terms of Service%', r);
  r := pg_temp.as_try('r255_old@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: refused without Terms', r like 'err:22023:%Terms of Service%', r);
  r := pg_temp.as_try('r255_old@d.test', format($q$select public.my_studio_account_update(jsonb_build_object('terms_version_accepted', %L))::text$q$, public._account_terms_version()));
  perform pg_temp.t('sales: Terms saved on /checkout', r like 'ok:%', r);
  r := pg_temp.as_try('r255_old@d.test', $q$select public.request_plan_activation('studio', 'monthly', 'R255 Old', 'Old Owner', 'r255_old@d.test')::text$q$);
  perform pg_temp.t('sales: saved after the Terms', r like '%"status": "received"%', r);
  r := pg_temp.as_try('r255_old@d.test', $q$select public.my_pending_start_trial()::text$q$);
  perform pg_temp.t('switch: works after the Terms (payment off)', r like '%"result": "started"%', r);
  r := pg_temp.as_try('a_admin@a.test', $q$select public.request_plan_activation('studio', 'monthly', 'A', 'A Admin', 'a_admin@a.test')::text$q$);
  perform pg_temp.t('sales: an existing studio without recorded Terms is asked too', r like 'err:22023:%Terms%', r);
end $$;

-- 6) operators, the limit
do $$ declare r text; begin
  r := pg_temp.as_try('admin@helm.events', $q$select public.create_studio('Operator Studio', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('operator: create_studio refused', r like 'err:42501:%HQ accounts%', r);
  r := pg_temp.as_try('admin@helm.events', format($q$select public.create_direct_studio('Operator Studio', null, null, %L)::text$q$, public._account_terms_version()));
  perform pg_temp.t('operator: create_direct_studio refused', r like 'err:42501:%HQ accounts%', r);
  insert into public.auth_rate_hits(bucket, key, window_start, n)
    select 'studio_create', u.id::text, now(), 10 from auth.users u where u.email = 'r255_lim@d.test'
  on conflict (bucket, key) do update set n = 10, window_start = now();
  r := pg_temp.as_try('r255_lim@d.test', $q$select public.create_studio('R255 Limited', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('limit: 11th attempt in an hour refused', r like 'err:22023:%Too many attempts%', r);
  r := pg_temp.as_try('r255_lim@d.test', $q$select public.start_self_serve_trial('R255 Limited', 'Asia/Kolkata', 'INR', 'demo')::text$q$);
  perform pg_temp.t('limit: the trial path too', r like 'err:22023:%Too many attempts%', r);
  delete from public.auth_rate_hits where bucket = 'studio_create';
  r := pg_temp.as_try('r255_lim@d.test', $q$select public.create_studio('R255 Limited', 'Biz@Example.COM', 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.t('limit: fine again after the window', r like 'ok:%', r);
end $$;
do $$ declare v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'r255_lim@d.test';
  perform pg_temp.t('email: business e-mail kept on the studio, login profile keeps the sign-in e-mail',
    (select business_email from public.organizations where id = v_org) = 'biz@example.com'
    and (select email from public.profiles where email = 'r255_lim@d.test') = 'r255_lim@d.test', null);
end $$;

-- 7) one-trial rule: HQ's placeholder is not a free trial; a real trial still is
do $$ declare v_org uuid; begin
  select org_id into v_org from public.profiles where email = 'r255_lim@d.test';
  delete from public.studio_subscriptions where org_id = v_org;
  insert into public.studio_subscriptions(org_id, status, billing_interval, updated_at) values (v_org, 'trial', 'monthly', now());
  perform pg_temp.t('one-trial: HQ activation placeholder not counted', not exists (select 1 from public.trial_grants g where g.org_id = v_org), null);
  delete from public.studio_subscriptions where org_id = v_org;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at) values (v_org, 'trial', current_date + 8, 'bypass', now());
  perform pg_temp.t('one-trial: a real trial still counted', exists (select 1 from public.trial_grants g where g.org_id = v_org), null);
end $$;

-- 8) privacy + grants
do $$ declare r text; begin
  r := pg_temp.as_try('r255_paid@d.test', $q$select count(*)::text from public.account_terms_acceptances$q$);
  perform pg_temp.t('private: account_terms_acceptances not readable by the app', r like 'err:42501%', r);
  perform pg_temp.t('private: old bodies + helpers not callable by the app',
    not has_function_privilege('authenticated', 'public.create_studio__pre0255(text, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.start_self_serve_trial__pre0255(text, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.my_pending_start_trial__pre0255()', 'execute')
    and not has_function_privilege('authenticated', 'public.request_plan_activation__pre0255(text, text, text, text, text, text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public._account_terms_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r22_signup_limit(uuid)', 'execute'), null);
  perform pg_temp.t('grants: new RPCs for signed-in people only',
    has_function_privilege('authenticated', 'public.create_direct_studio(text, text, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.create_direct_studio(text, text, text, text, text)', 'execute')
    and has_function_privilege('authenticated', 'public.accept_account_terms(text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.accept_account_terms(text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.signup_plan_options()', 'execute')
    and has_function_privilege('authenticated', 'public.create_studio(text, text, text, text)', 'execute'), null);
end $$;

do $$ begin execute 'reset role'; delete from public.auth_rate_hits where bucket = 'studio_create'; end $$;

select name, result from _r255 where result <> 'PASS';
select case when count(*) filter (where result <> 'PASS') = 0
            then 'R22-CREATE-STUDIO-0255: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R22-CREATE-STUDIO-0255: FAIL' end as summary from _r255;
