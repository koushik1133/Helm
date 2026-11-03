-- r122-hq-review-0330.sql -- R122: HQ code-review fixes.
-- Proves (old behaviour reproduced through the kept __pre0330 bodies where it matters, then fixed):
-- (1) suspend + reactivate of a studio with NO subscription row never gives an endless trial (prev_status 'none', back
--     as "no subscription": not trial, not locked, sends allowed, HQ shows 'none'; a directly-created studio waiting
--     for its first payment stays behind the payment gate; the old 'trial' bug row is restored the same way; paid and
--     real trial studios come back as before); (2) hq_set_subscription needs a reason (in the log), refuses trial /
--     trial dates / active without a period end / a new row without a status; (3) no raw PAN / e-mail in the HQ log
--     rows of business details, two-step reset, owner recovery, and hq_audit masks older raw rows on read (rows not
--     rewritten) + e-mail search terms; (4) hq_set_studio_account answers masked; (5) consent keys refused from HQ,
--     the studio path still records consent; (6) hq_overview / hq_billing write nothing (no past-due flip, no reminder,
--     no log row) while hq_refresh_billing_status still does; (7) the paid refresh uses studio_today; (8) owner recovery
--     and (9) rename check the HQ role before any look-up; (10) hq_reveal member refuses HQ staff + no-studio people;
--     (11) e-mail search needs 3+ characters, studio-name search unchanged, the term is in the hq.view row;
--     (12) staff settings keep the IP switch when omitted; (13) record payment refuses a replay and a foreign
--     currency; (14) two-step reset logs "nothing to reset"; (B) total_paid = INR equivalent + paid_by_currency.
-- Re-applies 0330 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0330_r122_hq_review_fixes.sql
\ir ../../supabase/migrations/0330_r122_hq_review_fixes.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
-- an HQ person signed in with two-step (aal2); p_code_age = how long ago the last code was entered (null = no amr list)
create or replace function pg_temp.hq(p_email text, p_code_age interval default null) returns void language plpgsql as $$
declare u uuid; c jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  c := jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal2');
  if p_code_age is not null then
    c := c || jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_code_age)::bigint)));
  end if;
  perform set_config('request.jwt.claims', c::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op() returns void language plpgsql as $$ begin perform pg_temp.hq('admin@helm.events'); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return ''; exception when others then
  get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email;
  return u;
end $$;
create or replace function pg_temp.staff(p_email text, p_role text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r122 test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
-- a plain studio with NO subscription row (an older studio)
create or replace function pg_temp.org(p_name text) returns uuid language plpgsql as $$
declare o uuid; begin perform pg_temp.su(); insert into public.organizations(name) values (p_name) returning id into o; return o; end $$;

-- ---- setup -------------------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.staff('admin@helm.events', 'owner');
  perform pg_temp.staff('r122_viewer@hqstaff.test', 'viewer');
  perform pg_temp.staff('r122_sec@hqstaff.test', 'security');
  perform pg_temp.staff('r122_sales@hqstaff.test', 'sales');
  perform pg_temp.su();
  update public.helm_hq_settings set hq_reauth_minutes = 15, hq_ip_allowlist_on = false where id;
  insert into public.helm_plans(code, name, price_monthly, currency, active) values ('r122studio', 'R122 Studio', 2999, 'INR', true)
    on conflict (code) do update set active = true, name = 'R122 Studio';
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + privileges -------------------------------------------------------------------------------------------
do $$ declare f text; ok boolean := true; pre text; begin
  perform pg_temp.su();
  foreach f in array array['hq_suspend_studio(uuid,text)', 'hq_reactivate_studio(uuid)', 'hq_set_studio_account(uuid,jsonb)',
      'hq_mfa_reset(text,text)', 'hq_studio_owner_recover(uuid,text,text)', 'hq_audit(date,date)', 'hq_overview()', 'hq_billing(date,date)',
      '_billing_refresh()', 'hq_set_studio_identity(uuid,text,text,text)', 'hq_reveal(text,text,text)', 'hq_users(text,integer,integer)',
      'hq_studios(text,text,integer,integer)', 'hq_set_staff_settings(integer,integer,integer,boolean,text[])',
      'hq_record_payment(uuid,numeric,date,text,text,date,date,text,numeric)', '_hq_studio_rows()', 'hq_studio_detail(uuid)',
      '_studio_payment_pending(uuid)'] loop
    pre := 'public.' || replace(f, '(', '__pre0330(');
    ok := ok and position('r122-0330' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || f))) > 0
      and to_regprocedure(pre) is not null
      and position('r122-0330' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure(pre))) = 0
      and not has_function_privilege('anon', pre, 'execute') and not has_function_privilege('authenticated', pre, 'execute')
      and not has_function_privilege('service_role', pre, 'execute')
      and (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.' || f));
  end loop;
  perform pg_temp.res('01 eighteen functions carry the 0330 marker (definer, empty search_path); old bodies kept ONCE as __pre0330 with no app privilege', ok);
  perform pg_temp.res('02 hq_set_subscription: one 8-argument version (p_reason); the 7-argument body kept as __pre0330 with no app privilege',
    to_regprocedure('public.hq_set_subscription(uuid,text,text,date,date,date,text,text)') is not null
    and to_regprocedure('public.hq_set_subscription(uuid,text,text,date,date,date,text)') is null
    and (select count(*) from pg_proc where proname = 'hq_set_subscription' and pronamespace = 'public'::regnamespace) = 1
    and not has_function_privilege('authenticated', 'public.hq_set_subscription__pre0330(uuid,text,text,date,date,date,text)', 'execute'));
  perform pg_temp.res('03 entry points: signed-in yes, anon no; internals: no API role (service role where it was)',
    has_function_privilege('authenticated', 'public.hq_set_subscription(uuid,text,text,date,date,date,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_set_subscription(uuid,text,text,date,date,date,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_audit(date,date)', 'execute') and not has_function_privilege('anon', 'public.hq_users(text,integer,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_record_payment(uuid,numeric,date,text,text,date,date,text,numeric)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq_studio_rows()', 'execute') and has_function_privilege('service_role', 'public._hq_studio_rows()', 'execute')
    and not has_function_privilege('authenticated', 'public._billing_refresh()', 'execute') and has_function_privilege('service_role', 'public._billing_refresh()', 'execute')
    and not has_function_privilege('authenticated', 'public._studio_payment_pending(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._r330_paid_refresh()', 'execute')
    and not has_function_privilege('anon', 'public._r330_mask_changed(jsonb)', 'execute'));
  perform pg_temp.res('04 prev_status check is a superset with none (old values still allowed)',
    (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'studio_subscriptions_prev_status_check') like '%none%'
    and (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'studio_subscriptions_prev_status_check') like '%past_due%');
  -- from here on: let the test reproduce the OLD behaviour through the kept bodies (rolled back at the end)
  grant execute on function public.hq_suspend_studio__pre0330(uuid, text), public.hq_reactivate_studio__pre0330(uuid),
    public.hq_set_subscription__pre0330(uuid, text, text, date, date, date, text), public.hq_set_studio_account__pre0330(uuid, jsonb),
    public.hq_overview__pre0330(), public.hq_record_payment__pre0330(uuid, numeric, date, text, text, date, date, text, numeric),
    public.hq_reveal__pre0330(text, text, text) to authenticated;
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) item 1: suspend + reactivate of a studio with no subscription row ----------------------------------------------
do $$ declare g uuid; h uuid; d uuid; l uuid; p uuid; t uuid; r jsonb; rd jsonb; s record; begin
  -- repro (old bodies): an older studio with no row comes back as an endless trial - client sends switched off
  g := pg_temp.org('R122 Grandfathered Old');
  perform pg_temp.op();
  perform public.hq_suspend_studio__pre0330(g, 'r122 repro');
  perform public.hq_reactivate_studio__pre0330(g);
  perform pg_temp.su();
  perform pg_temp.res('05 REPRO (old body): no-row studio suspended + reactivated = status trial, no end date, _is_trial_org + no client sends',
    (select status from public.studio_subscriptions where org_id = g) = 'trial'
    and (select trial_ends_at from public.studio_subscriptions where org_id = g) is null
    and public._is_trial_org(g) and public._tb179_no_send(g));
  -- fixed: an older studio
  h := pg_temp.org('R122 Grandfathered New'); perform pg_temp.put('H', h::text);
  perform pg_temp.op();
  perform public.hq_suspend_studio(h, 'r122 suspend');
  perform pg_temp.su();
  perform pg_temp.res('06 suspend of a no-row studio records prev_status none (never trial); the studio is read-only',
    (select prev_status from public.studio_subscriptions where org_id = h) = 'none'
    and (select status from public.studio_subscriptions where org_id = h) = 'suspended' and not public._studio_writable(h));
  perform pg_temp.op();
  r := public.hq_reactivate_studio(h);
  rd := public.hq_studio_detail(h);
  perform pg_temp.su();
  select * into s from public.studio_subscriptions where org_id = h;
  perform pg_temp.res('07 reactivate = "no subscription": active, no period, marker kept; not trial, not locked, sends allowed, writable, no payment gate',
    r ->> 'status' = 'none' and r ->> 'restored' = 'no_subscription' and s.status = 'active' and s.prev_status = 'none'
    and s.current_period_end is null and s.trial_ends_at is null and not public._is_trial_org(h) and not public._trial_locked(h)
    and not public._tb179_no_send(h) and public._studio_writable(h) and not public._studio_payment_pending(h), r::text);
  perform pg_temp.res('08 HQ shows it as No plan (list status none, drawer subscription.status none); a second suspend keeps the marker',
    (select x.status from public._hq_studio_rows() x where x.org_id = h) = 'none' and rd ->> 'status' = 'none'
    and rd #>> '{subscription,status}' = 'none' and (rd ->> 'no_subscription')::boolean, rd::text);
  perform pg_temp.op();
  perform public.hq_suspend_studio(h, 'r122 suspend again');
  perform pg_temp.su();
  perform pg_temp.res('09 second suspend of the restored row: prev_status still none', (select prev_status from public.studio_subscriptions where org_id = h) = 'none');
  perform pg_temp.op(); perform public.hq_reactivate_studio(h); perform pg_temp.su();
  -- a directly created studio still waiting for its first payment: still waiting after suspend + reactivate
  d := pg_temp.org('R122 Direct Pending');
  insert into public.studio_payment_gate(org_id) values (d);
  perform pg_temp.res('10a a direct studio without payment is behind the payment gate', public._studio_payment_pending(d));
  perform pg_temp.op(); perform public.hq_suspend_studio(d, 'r122 suspend'); perform public.hq_reactivate_studio(d); perform pg_temp.su();
  perform pg_temp.res('10 after suspend + reactivate it is STILL behind the payment gate (no free access, no trial)',
    public._studio_payment_pending(d) and not public._is_trial_org(d));
  -- the old bug row (suspended, prev_status trial, no trial date anywhere) is restored as no subscription
  l := pg_temp.org('R122 Legacy Bug Row');
  insert into public.studio_subscriptions(org_id, status, prev_status, suspended_at, suspend_reason) values (l, 'suspended', 'trial', now(), 'old');
  perform pg_temp.op(); r := public.hq_reactivate_studio(l); perform pg_temp.su();
  perform pg_temp.res('11 an old bug row (prev trial, no trial date) reactivates as no subscription, not an endless trial',
    r ->> 'status' = 'none' and not public._is_trial_org(l) and (select prev_status from public.studio_subscriptions where org_id = l) = 'none', r::text);
  -- paid + real trial studios come back exactly as before
  p := pg_temp.org('R122 Paid');
  insert into public.studio_subscriptions(org_id, status, current_period_start, current_period_end) values (p, 'active', current_date - 5, current_date + 25);
  t := pg_temp.org('R122 Real Trial');
  insert into public.studio_subscriptions(org_id, status, trial_ends_at) values (t, 'trial', current_date + 5);
  perform pg_temp.op();
  perform public.hq_suspend_studio(p, 'r122'); perform public.hq_reactivate_studio(p);
  perform public.hq_suspend_studio(t, 'r122'); perform public.hq_reactivate_studio(t);
  perform pg_temp.su();
  perform pg_temp.res('12 a paid studio comes back active (period kept, no marker); a real trial comes back trial with its end date',
    (select status || '|' || coalesce(prev_status, '-') || '|' || current_period_end::text from public.studio_subscriptions where org_id = p)
      = 'active|-|' || (current_date + 25)::text
    and (select status || '|' || trial_ends_at::text from public.studio_subscriptions where org_id = t) = 'trial|' || (current_date + 5)::text);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) item 2: "change by hand" -------------------------------------------------------------------------------------------
do $$ declare o uuid; e text; r jsonb; begin
  o := pg_temp.org('R122 By Hand');
  -- repro: the old body happily made a trial without an end date
  perform pg_temp.op();
  r := public.hq_set_subscription__pre0330(o, null, 'trial', null, null, null, null);
  perform pg_temp.su();
  perform pg_temp.res('13 REPRO (old body): status trial with no end date and no reason was accepted', r ->> 'status' = 'trial' and public._is_trial_org(o), r::text);
  o := pg_temp.org('R122 By Hand 2'); perform pg_temp.put('BH', o::text);
  perform pg_temp.op();
  e := pg_temp.try(format($q$select public.hq_set_subscription(%L::uuid, null, 'cancelled', null, null, null, null)$q$, o));
  perform pg_temp.res('14 no reason: refused', e like '22023 Give a reason of at least 5 characters%', e);
  e := pg_temp.try(format($q$select public.hq_set_subscription(%L::uuid, null, 'trial', null, null, null, null, 'owner asked')$q$, o));
  perform pg_temp.res('15 status trial: refused (use Extend trial)', e like '22023 The free trial is not changed here - use Extend trial%[use_extend_trial]', e);
  e := pg_temp.try(format($q$select public.hq_set_subscription(%L::uuid, null, null, current_date + 30, null, null, null, 'owner asked')$q$, o));
  perform pg_temp.res('16 a trial end date: refused (use Extend trial)', e like '%use_extend_trial%', e);
  e := pg_temp.try(format($q$select public.hq_set_subscription(%L::uuid, 'r122studio', null, null, null, null, null, 'owner asked')$q$, o));
  perform pg_temp.res('17 a new subscription with no status: refused (no silent trial row)', e like '22023 This studio has no subscription yet%', e);
  e := pg_temp.try(format($q$select public.hq_set_subscription(%L::uuid, 'r122studio', 'active', null, current_date, null, null, 'owner asked')$q$, o));
  perform pg_temp.res('18 active with no period end: refused', e like '22023 An active plan needs a period end%', e);
  perform pg_temp.su();
  perform pg_temp.res('19 nothing was written by the refused calls', not exists (select 1 from public.studio_subscriptions where org_id = o));
  perform pg_temp.op();
  r := public.hq_set_subscription(o, 'r122studio', 'active', null, current_date, current_date + 30, null, 'paid by bank transfer');
  perform pg_temp.su();
  perform pg_temp.res('20 a valid change goes through; the HQ log row carries the reason',
    r ->> 'status' = 'active' and (r ->> 'current_period_end')::date = current_date + 30
    and exists (select 1 from public.audit_log a where a.action = 'hq.subscription.set' and a.entity_id = o::text
                 and a.changed ->> 'reason' = 'paid by bank transfer'), r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) items 3 + 4 + 5: business details from HQ ----------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; e text; n0 int; ch jsonb; begin
  perform pg_temp.su();
  -- repro: the old body logged + returned PAN / e-mails raw
  perform pg_temp.op();
  r := public.hq_set_studio_account__pre0330(a, '{"pan":"ABCDE1234F","billing_contact_email":"secret.billing@studio.test"}');
  perform pg_temp.su();
  perform pg_temp.res('21 REPRO (old body): raw PAN in the answer and in the HQ log',
    r::text like '%ABCDE1234F%' and exists (select 1 from public.audit_log x where x.action = 'hq.studio_account.set'
      and x.entity_id = a::text and x.changed::text like '%ABCDE1234F%'));
  delete from public.audit_log x where x.action = 'hq.studio_account.set' and x.entity_id = a::text;   -- (test only, rolled back)
  perform pg_temp.op();
  r := public.hq_set_studio_account(a, '{"pan":"ABCDE1234F","billing_contact_email":"secret.billing@studio.test","primary_contact_phone":"+919876543210","billing_address":"12 Secret Lane","city":"Pune"}');
  perform pg_temp.su();
  select x.changed into ch from public.audit_log x where x.action = 'hq.studio_account.set' and x.entity_id = a::text order by x.at desc limit 1;
  perform pg_temp.res('22 the HQ log keeps field names + masked values only (no PAN, e-mail, phone, address)',
    ch is not null and ch -> 'fields' ? 'pan' and ch -> 'fields' ? 'billing_address' and ch::text not like '%ABCDE1234F%'
    and ch::text not like '%secret.billing%' and ch::text not like '%9876543210%' and ch::text not like '%Secret Lane%'
    and ch #>> '{values,city}' = 'Pune', coalesce(ch::text, 'no row'));
  perform pg_temp.res('23 the answer is masked (PAN, e-mail, phone) while the stored values are real',
    r::text not like '%ABCDE1234F%' and r::text not like '%secret.billing%' and r::text not like '%9876543210%'
    and r ->> 'pan' like 'AB%4F' and r ->> 'pan' <> 'ABCDE1234F'
    and (select pan from public.studio_account where org_id = a) = 'ABCDE1234F', r::text);
  select count(*) into n0 from public.studio_consent_log where org_id = a;
  perform pg_temp.op();
  e := pg_temp.try(format($q$select public.hq_set_studio_account(%L::uuid, '{"terms_version_accepted":"v9","city":"X"}')$q$, a));
  perform pg_temp.res('24 HQ cannot record terms acceptance', e like '22023 Terms, data-processing consent and marketing choices are given by the studio itself%[consent_studio_only]', e);
  e := pg_temp.try(format($q$select public.hq_set_studio_account(%L::uuid, '{"marketing_opt_in":"true"}')$q$, a));
  perform pg_temp.res('25 HQ cannot set marketing opt-in or data consent', e like '%consent_studio_only%'
    and pg_temp.try(format($q$select public.hq_set_studio_account(%L::uuid, '{"consent_version":"c1"}')$q$, a)) like '%consent_studio_only%', e);
  perform pg_temp.su();
  perform pg_temp.res('26 no consent row was written by HQ, the city change in the refused call did not land',
    (select count(*) from public.studio_consent_log where org_id = a) = n0 and (select city from public.studio_account where org_id = a) = 'Pune');
  -- the studio path (_studio_account_apply as the studio itself) still records consent
  e := pg_temp.try(format($q$select public._studio_account_apply(%L::uuid, '{"marketing_opt_in":"false"}')$q$, a));
  perform pg_temp.res('27 the studio-side apply path still accepts consent keys',
    e = '' and (select count(*) from public.studio_consent_log where org_id = a) = n0 + 1, e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) item 3: hq_audit masks on read (older rows untouched); items 14 + 3: two-step reset log -------------------------
do $$ declare r jsonb; u uuid; e text; ch jsonb; begin
  perform pg_temp.su();
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, 'old@helm.events', 'hq.studio_account.set', 'studio_account', 'r122-old', '{"pan":"ZZZZZ9999Z","billing_contact_email":"older.raw@studio.test","gstin":"27ABCDE1234F1Z5","city":"Old"}', null, now()),
           (null, 'old@helm.events', 'hq.view', 'hq_users', 'someone.private@gmail.com', null, null, now()),
           (null, 'old@helm.events', 'hq.view', 'hq_studios', 'priv.person@mail.test|trial', null, null, now());
  perform pg_temp.hq('r122_sec@hqstaff.test');
  r := public.hq_audit(null, null);
  perform pg_temp.su();
  perform pg_temp.res('28 hq_audit (security role): older raw PAN / GSTIN / e-mail rows and e-mail search terms are masked on read',
    r::text not like '%ZZZZZ9999Z%' and r::text not like '%older.raw%' and r::text not like '%27ABCDE1234F1Z5%'
    and r::text not like '%someone.private%' and r::text not like '%priv.person%' and r::text like '%|trial%'
    and r::text like '%"city": "Old"%', left(r::text, 300));
  perform pg_temp.res('29 the stored rows are NOT rewritten (masked on read only)',
    exists (select 1 from public.audit_log where entity_id = 'r122-old' and changed ->> 'pan' = 'ZZZZZ9999Z'));
  -- two-step reset of an account with no two-step: refused nothing, but the log row is written (masked e-mail)
  u := pg_temp.newuser('r122.nomfa.person@studio.test', 'a0000000-0000-4000-8000-000000000001'::uuid, 'sales');
  perform pg_temp.op();
  r := public.hq_mfa_reset('r122.nomfa.person@studio.test', 'called them back on the registered number');
  perform pg_temp.su();
  select a.changed into ch from public.audit_log a where a.action = 'hq.mfa.reset' and a.entity_id = u::text order by a.at desc limit 1;
  perform pg_temp.res('30 two-step reset with nothing to reset still writes its HQ log row (result nothing_to_reset)',
    (r ->> 'factors_reset')::int = 0 and ch ->> 'result' = 'nothing_to_reset', coalesce(ch::text, 'no row'));
  perform pg_temp.res('31 the reset log row has the e-mail masked', ch::text not like '%r122.nomfa.person%' and ch ->> 'email' like 'r1%@studio.test', coalesce(ch::text, ''));
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) items 3 + 8: owner recovery - role first, masked log -----------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; e text; ch jsonb; begin
  perform pg_temp.hq('r122_viewer@hqstaff.test');
  e := pg_temp.try($q$select public.hq_studio_owner_recover('00000000-0000-4000-8000-0000000000ff', 'x@y.test', 'short')$q$);
  perform pg_temp.res('32 owner recovery by a Viewer: the HQ role is refused BEFORE the reason / studio / e-mail are checked',
    e like '42501 not authorized: HQ_ROLE%', e);
  u := pg_temp.newuser('r122.newowner@a.test', a, 'admin');
  perform pg_temp.op();
  e := pg_temp.try(format($q$select public.hq_studio_owner_recover(%L::uuid, 'r122.newowner@a.test', 'owner left the company; confirmed by call back on registered number')$q$, a));
  perform pg_temp.su();
  select x.changed into ch from public.audit_log x where x.action = 'hq.studio.owner_recover' and x.entity_id = a::text order by x.at desc limit 1;
  perform pg_temp.res('33 owner recovery by the HQ Owner works; its log row has the user id + a masked e-mail only',
    e = '' and ch ->> 'new_owner_id' = u::text and ch::text not like '%r122.newowner@%' and ch ->> 'new_owner' like '%@a.test', e || coalesce(ch::text, ''));
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) items 6 + 7: read pages write nothing; the paid refresh on the studio's day -------------------------------------------
do $$ declare o uuid; n0 int; a0 int; r jsonb; begin
  o := pg_temp.org('R122 Overdue');
  insert into public.studio_subscriptions(org_id, status, plan_id, current_period_start, current_period_end)
    values (o, 'active', (select id from public.helm_plans where code = 'r122studio'), current_date - 40, current_date - 10);
  -- repro: the old overview flipped it to past due (a read page that writes)
  perform pg_temp.hq('r122_viewer@hqstaff.test');
  perform public.hq_overview__pre0330();
  perform pg_temp.su();
  perform pg_temp.res('34 REPRO (old body): a Viewer opening the overview flipped a studio to past due', (select status from public.studio_subscriptions where org_id = o) = 'past_due');
  update public.studio_subscriptions set status = 'active' where org_id = o;
  delete from public.billing_reminders where org_id = o;                                          -- (test only, rolled back)
  select count(*) into n0 from public.billing_reminders;
  select count(*) into a0 from public.audit_log where action = 'hq.billing.auto_past_due';
  perform pg_temp.hq('r122_viewer@hqstaff.test');
  r := public.hq_overview();
  perform pg_temp.op();
  r := public.hq_billing(null, null);
  perform pg_temp.su();
  perform pg_temp.res('35 hq_overview + hq_billing write nothing: still active, no reminder, no auto past-due log row',
    (select status from public.studio_subscriptions where org_id = o) = 'active'
    and (select count(*) from public.billing_reminders) = n0
    and (select count(*) from public.audit_log where action = 'hq.billing.auto_past_due') = a0);
  perform pg_temp.op();
  r := public.hq_refresh_billing_status();
  perform pg_temp.su();
  perform pg_temp.res('36 "Refresh past-due" (hq_refresh_billing_status) still flips it + queues the reminder',
    (select status from public.studio_subscriptions where org_id = o) = 'past_due'
    and exists (select 1 from public.billing_reminders where org_id = o and kind = 'past_due'), r::text);
  -- studio day: a period ending on the studio's today is not over; ending the studio's yesterday is
  o := pg_temp.org('R122 Zone');
  update public.organizations set timezone = 'Pacific/Kiritimati' where id = o;
  insert into public.studio_subscriptions(org_id, status, current_period_start, current_period_end)
    values (o, 'active', public.studio_today(o) - 30, public.studio_today(o));
  perform public._billing_refresh();
  perform pg_temp.res('37 paid refresh: a period ending on the studio''s own today is still active',
    (select status from public.studio_subscriptions where org_id = o) = 'active');
  update public.studio_subscriptions set current_period_end = public.studio_today(o) - 1 where org_id = o;
  perform public._billing_refresh();
  perform pg_temp.res('38 paid refresh: a period that ended the studio''s yesterday goes past due; the body uses studio_today, not current_date',
    (select status from public.studio_subscriptions where org_id = o) = 'past_due'
    and (select p.prosrc from pg_proc p where p.oid = 'public._r330_paid_refresh()'::regprocedure) like '%studio_today(s.org_id)%'
    and (select p.prosrc from pg_proc p where p.oid = 'public._r330_paid_refresh()'::regprocedure) not like '%current_date%');
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) items 9 + 10 + 11 + 12 --------------------------------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; e text; u uuid; n int; r jsonb; st jsonb; begin
  perform pg_temp.hq('r122_viewer@hqstaff.test');
  e := pg_temp.try(format($q$select public.hq_set_studio_identity(%L::uuid, 'X', 'zz', 'short')$q$, a));
  perform pg_temp.res('39 rename by a Viewer: the HQ role is refused before the slug / name / reason checks', e like '42501 not authorized: HQ_ROLE%', e);
  e := pg_temp.try($q$select public.hq_set_studio_identity('00000000-0000-4000-8000-0000000000ff', 'Xyz', null, 'reason long enough here')$q$);
  perform pg_temp.res('40 rename of an unknown studio by a Viewer: still the role refusal (nothing looked up)', e like '42501 not authorized: HQ_ROLE%', e);
  -- hq_reveal member
  u := pg_temp.newuser('r122.nostudio@t.test', null, 'admin');
  perform pg_temp.put('AADMIN', (select id::text from auth.users where email = 'a_admin@a.test'));
  perform pg_temp.put('HQOWNER', (select id::text from auth.users where email = 'admin@helm.events'));
  perform pg_temp.hq('r122_sec@hqstaff.test');
  e := pg_temp.try(format($q$select public.hq_reveal('member', %L, 'email')$q$, pg_temp.get('HQOWNER')));
  perform pg_temp.res('41 hq_reveal member: an HQ team person is refused', e like '22023 This person is not a studio member.%', e);
  e := pg_temp.try(format($q$select public.hq_reveal('member', %L, 'email')$q$, u));
  perform pg_temp.res('42 hq_reveal member: a person with no studio is refused', e like '22023 This person is not a studio member.%', e);
  r := public.hq_reveal('member', pg_temp.get('AADMIN'), 'email');
  perform pg_temp.res('43 hq_reveal member: a studio member is shown (and logged)', r ->> 'value' = 'a_admin@a.test', r::text);
  perform pg_temp.hq('r122_viewer@hqstaff.test');
  e := pg_temp.try(format($q$select public.hq_reveal('member', %L, 'email')$q$, u));
  perform pg_temp.res('44 hq_reveal member by a Viewer: the role is refused first (no membership answer)', e like '42501 not authorized: HQ_ROLE%', e);
  -- search
  perform pg_temp.op();
  select count(*) into n from public.hq_users('a.', 25, 0) x where x.email like 'a_%@a.test';
  perform pg_temp.res('45 people search: a 2-character term never matches on e-mail', n = 0, n::text);
  select count(*) into n from public.hq_users('a_admin@a', 25, 0);
  perform pg_temp.res('46 people search: 3+ characters match on e-mail (masked in the answer)', n = 1
    and (select x.email from public.hq_users('a_admin@a', 25, 0) x limit 1) not like 'a_admin@%', n::text);
  perform pg_temp.su();
  update public.organizations set name = 'Ze R122 Studio' where id = a;
  perform pg_temp.op();
  select count(*) into n from public.hq_users('Ze', 25, 0);
  perform pg_temp.res('47 people search: a short studio-name term still matches', n >= 2, n::text);
  select count(*) into n from public.hq_studios('a_', null, 25, 0) x where x.org_id = a;
  perform pg_temp.res('48 studio search: a 2-character term never matches on an e-mail; a studio-name term does',
    n = 0 and (select count(*) from public.hq_studios('Ze', null, 25, 0) x where x.org_id = a) = 1
    and (select count(*) from public.hq_studios('a_admin@', null, 25, 0) x where x.org_id = a) = 1, n::text);
  perform pg_temp.su();
  perform pg_temp.res('49 the search term is in the hq.view log row (shortened)',
    exists (select 1 from public.audit_log x where x.action = 'hq.view' and x.entity = 'hq_users' and x.entity_id = 'a_admin@a'));
  -- staff settings: an omitted allow-list switch keeps its value
  update public.helm_hq_settings set hq_ip_allowlist_on = true, hq_ip_allowlist = array['10.0.0.0/8'] where id;
  perform pg_temp.op();
  perform set_config('request.headers', '{"x-real-ip":"10.1.2.3"}', false);
  st := public.hq_set_staff_settings(45, null, null, null, null);
  perform pg_temp.su();
  perform pg_temp.res('50 staff settings with the switch left out: the IP allow-list stays ON (idle changed)',
    (select hq_ip_allowlist_on from public.helm_hq_settings where id) and (select hq_idle_minutes from public.helm_hq_settings where id) = 45, coalesce(st::text, ''));
  update public.helm_hq_settings set hq_ip_allowlist_on = false where id;
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) item 13 + B: record payment ---------------------------------------------------------------------------------------------
do $$ declare o uuid; e text; r jsonb; d jsonb; begin
  o := pg_temp.org('R122 Payer');
  insert into public.studio_account(org_id, billing_currency) values (o, 'INR') on conflict (org_id) do update set billing_currency = 'INR';
  -- repro: the old body recorded the same payment twice
  perform pg_temp.op();
  perform public.hq_record_payment__pre0330(o, 1000, current_date, 'bank', 'INR', null, null, 'NEFT-R122-A', null);
  perform public.hq_record_payment__pre0330(o, 1000, current_date, 'bank', 'INR', null, null, 'NEFT-R122-A', null);
  perform pg_temp.su();
  perform pg_temp.res('51 REPRO (old body): the same payment was recorded twice',
    (select count(*) from public.subscription_payments where org_id = o and reference = 'NEFT-R122-A') = 2);
  update public.subscription_payments set voided_at = now(), void_reason = 'r122 test' where org_id = o;   -- (test only, rolled back)
  perform pg_temp.op();
  r := public.hq_record_payment(o, 1000, current_date, 'bank', 'INR', null, null, 'NEFT-R122-B', null);
  e := pg_temp.try(format($q$select public.hq_record_payment(%L::uuid, 1000, current_date, 'bank', 'INR', null, null, 'NEFT-R122-B', null)$q$, o));
  perform pg_temp.res('52 the same payment again within a day is refused (names the invoice)', e like '22023 This payment is already recorded (HELM-%[replay]', e);
  e := pg_temp.try(format($q$select public.hq_record_payment(%L::uuid, 1000, current_date, 'bank', 'INR', null, null, 'NEFT-R122-C', null)$q$, o));
  perform pg_temp.res('53 a second payment with its own reference goes through', e = '', e);
  e := pg_temp.try(format($q$select public.hq_record_payment(%L::uuid, 50, current_date, 'bank', 'USD', null, null, 'WIRE-1', 84)$q$, o));
  perform pg_temp.res('54 a currency other than the studio''s billing currency is refused', e like '22023 This studio is billed in INR - record the payment in INR%[billing_currency]', e);
  perform pg_temp.su();
  update public.studio_account set billing_currency = null where org_id = o;
  perform pg_temp.op();
  e := pg_temp.try(format($q$select public.hq_record_payment(%L::uuid, 50, current_date, 'bank', 'USD', null, null, 'WIRE-1', 84)$q$, o));
  perform pg_temp.res('55 with no billing currency set, a USD payment with a rate is accepted (as before)', e = '', e);
  d := public.hq_studio_detail(o);
  perform pg_temp.su();
  perform pg_temp.res('56 Paid to Helm = the INR equivalent (2000 + 50 x 84), per-currency totals listed',
    (d ->> 'total_paid')::numeric = 6200 and (d ->> 'total_paid_inr')::numeric = 6200
    and (select x.total_paid from public._hq_studio_rows() x where x.org_id = o) = 6200
    and d -> 'paid_by_currency' = '[{"amount": 2000, "currency": "INR"}, {"amount": 50, "currency": "USD"}]'::jsonb, coalesce(d::text, ''));
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 10) re-run safety ---------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('57 re-run safe: one __pre0330 per function, the current bodies carry the marker',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0330') = 19
    and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0330\_\_pre0330') = 0);
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R122-HQ-REVIEW-0330: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R122-HQ-REVIEW-0330: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
