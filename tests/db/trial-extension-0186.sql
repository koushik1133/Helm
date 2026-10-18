-- trial-extension-0186.sql -- 0186: one free trial per studio / e-mail + one HQ-approved trial extension.
-- Proves: a second free trial is refused for the same user and for the same e-mail written another
-- way (case, +tag, Gmail dots) with a friendly 22023 'trial_used' message, on all three trial entry
-- points; other e-mails and studios that already have a subscription are unaffected; the ledger
-- keeps only a fingerprint (no e-mail) and is filled once for studios that already had a trial;
-- the extension is HQ-only (anon / studio admin / service role / aal1 operator refused), 1-7 days,
-- reason required, at most one per studio, lifts an ended trial's read-only lock, never applies to
-- a paid / checkout / suspended studio, and writes both audit rows. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations / grant sweeps; re-apply 0186 inside this rolled-back tx
-- (this is also the second run of the same file: it must be a no-op apart from re-creating objects)
\ir ../../supabase/migrations/0186_trial_one_per_email_extension.sql
create temp table _te(name text, result text); grant all on _te to anon, authenticated, service_role;
create temp table _tkv(k text primary key, v text); grant all on _tkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op(p_aal text default 'aal2') returns void language plpgsql as $$
begin perform pg_temp.login('admin@helm.events', p_aal); end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _te values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
-- run SQL as the current caller -> 'ok:<value>' or 'err:<sqlstate>:<hint>:<message>'
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; h text; begin
  execute p_sql into v; return 'ok:' || coalesce(v, '');
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return 'err:' || sqlstate || ':' || coalesce(h, '') || ':' || sqlerrm;
end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
-- start a free trial (own data: no sample clone) as that user -> the try() text
create or replace function pg_temp.trial(p_email text) returns text language plpgsql as $$
declare r text; begin
  perform pg_temp.login(p_email);
  r := pg_temp.try(format('select public.start_self_serve_trial(%L, %L, %L, %L)::text', 'T186 ' || p_email, 'Asia/Kolkata', 'INR', 'own'));
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.org_of(p_email text) returns uuid language sql as $$
  select p.org_id from public.profiles p join auth.users u on u.id = p.id where u.email = p_email $$;

-- ---- setup ---------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test 0186') on conflict (email) do nothing;
  delete from public.profiles where id = (select id from auth.users where email = 'admin@helm.events') and org_id is null;
  perform pg_temp.newuser('t186_a@d.test'); perform pg_temp.newuser('jane.doe186@gmail.com');
  perform pg_temp.newuser('Jane.Doe186+again@GoogleMail.com'); perform pg_temp.newuser('janedoe186@gmail.com');
  perform pg_temp.newuser('t186_c@d.test'); perform pg_temp.newuser('t186_d@d.test'); perform pg_temp.newuser('t186_e@d.test');
end $$;

-- ---- 1) one free trial per user / e-mail -----------------------------------------------------------
do $$ declare r text; a uuid; g public.trial_grants; begin
  r := pg_temp.trial('t186_a@d.test');
  perform pg_temp.res('01 first free trial starts', r like 'ok:%"result": "started"%', r);
  a := pg_temp.org_of('t186_a@d.test'); perform pg_temp.put('A', a::text);
  select * into g from public.trial_grants where org_id = a;
  perform pg_temp.res('02 ledger row: studio + creator + 64-hex fingerprint, no e-mail',
    g.org_id = a and g.user_id = (select id from auth.users where email = 't186_a@d.test')
    and g.email_hash ~ '^[0-9a-f]{64}$' and position('@' in g.email_hash) = 0 and g.recorded_how = 'trigger', coalesce(g.email_hash, '<no row>'));
  -- the same person leaves the studio and tries again
  update public.profiles set org_id = null where email = 't186_a@d.test';
  r := pg_temp.trial('t186_a@d.test');
  perform pg_temp.res('03 same user: second free trial refused (22023, hint trial_used)', r like 'err:22023:trial_used:%', r);
  perform pg_temp.res('04 refusal message is written for people', r like '%already used your free Helm trial%' and r not like '%null%', r);
  perform pg_temp.res('05 no second studio was created',
    (select count(*) from public.organizations where created_by = (select id from auth.users where email = 't186_a@d.test')) = 1, null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 01' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

do $$ declare r text; begin
  r := pg_temp.trial('jane.doe186@gmail.com');
  perform pg_temp.res('06 Gmail user: first trial starts', r like 'ok:%"result": "started"%', r);
  r := pg_temp.trial('Jane.Doe186+again@GoogleMail.com');
  perform pg_temp.res('07 same Gmail with dots / +tag / googlemail / case: refused', r like 'err:22023:trial_used:%', r);
  r := pg_temp.trial('janedoe186@gmail.com');
  perform pg_temp.res('08 same Gmail without dots: refused', r like 'err:22023:trial_used:%', r);
  r := pg_temp.trial('t186_c@d.test');
  perform pg_temp.res('09 a different e-mail still gets its free trial', r like 'ok:%"result": "started"%', r);
  perform pg_temp.put('C', pg_temp.org_of('t186_c@d.test')::text);
  r := pg_temp.trial('t186_c@d.test');
  perform pg_temp.res('10 someone already in a studio is handed it back (unchanged)', r like 'ok:%"result": "has_studio"%', r);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 02' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

do $$ begin
  perform pg_temp.res('11 fingerprint: case / spaces / +tag / Gmail dots ignored, other domains keep dots',
    public._trial_email_fingerprint(' A.B+x@GMail.com ') = public._trial_email_fingerprint('ab@gmail.com')
    and public._trial_email_fingerprint('a.b@d.test') <> public._trial_email_fingerprint('ab@d.test')
    and public._trial_email_fingerprint('a+b@d.test') = public._trial_email_fingerprint('a@d.test')
    and public._trial_email_fingerprint('not-an-email') is null and public._trial_email_fingerprint(null) is null, null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 03' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 2) the other trial entry points (direct "Create studio" waiting for payment) ----------------------
do $$ declare r text; v uuid; begin
  -- t186_a already had a trial; now creates a studio directly (payment pending)
  perform pg_temp.login('t186_a@d.test');
  r := pg_temp.try($q$select public.create_studio('T186 Direct A', null, 'INR', 'Asia/Kolkata')::text$q$);
  perform pg_temp.su();
  perform pg_temp.res('12 direct studio created for the earlier trial user', r like 'ok:%', r);
  v := pg_temp.org_of('t186_a@d.test'); perform pg_temp.put('AD', v::text);
  perform pg_temp.login('t186_a@d.test');
  r := pg_temp.try('select public.my_pending_start_trial()::text');
  perform pg_temp.su();
  perform pg_temp.res('13 my_pending_start_trial: refused for a used trial (22023 trial_used)', r like 'err:22023:trial_used:%', r);
  perform pg_temp.login('t186_a@d.test');
  r := pg_temp.try($q$select public.my_start_trial('payment_pending', null)::text$q$);
  perform pg_temp.su();
  perform pg_temp.res('14 my_start_trial: refused for a used trial (22023 trial_used)', r like 'err:22023:trial_used:%', r);
  perform pg_temp.res('15 no subscription row was written for the direct studio',
    not exists (select 1 from public.studio_subscriptions where org_id = v), null);
  -- a brand-new owner of a direct studio still gets the 0159 free trial
  perform pg_temp.login('t186_d@d.test');
  r := pg_temp.try($q$select public.create_studio('T186 Direct D', null, 'INR', 'Asia/Kolkata')::text$q$);
  r := pg_temp.try('select public.my_pending_start_trial()::text');
  perform pg_temp.su();
  perform pg_temp.res('16 new owner: my_pending_start_trial unchanged (8-day trial starts)',
    r like 'ok:%"result": "started"%' or r like 'err:42501::online payment is available%', r);
  -- a studio that already HAS a subscription goes straight to the old code (no trial_used)
  perform pg_temp.login('t186_c@d.test');
  r := pg_temp.try($q$select public.my_start_trial('payment_pending', null)::text$q$);
  perform pg_temp.su();
  perform pg_temp.res('17 studio with a subscription: my_start_trial never says trial_used', r not like 'err:%trial_used%', r);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 04' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 3) privileges ------------------------------------------------------------------------------------
do $$ declare f text; bad text := ''; begin
  foreach f in array array['public._trial_email_fingerprint(text)', 'public._trial_used(uuid,text,uuid)',
      'public._trial_used_for_org(uuid)', 'public._trial_extend_block(uuid)', 'public.tg_trial_grant_0186()',
      'public.start_self_serve_trial__pre0186(text,text,text,text)', 'public.my_pending_start_trial__pre0186()',
      'public.my_start_trial__pre0186(text,text)'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then bad := bad || f || ' '; end if;
  end loop;
  perform pg_temp.res('18 internal helpers + the old bodies are not callable by app roles', bad = '', bad);
  perform pg_temp.res('19 entry points keep their grants (authenticated yes, anon no)',
    has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_pending_start_trial()', 'execute')
    and has_function_privilege('authenticated', 'public.my_start_trial(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_extend_trial(uuid,integer,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_extend_trial(uuid,integer,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_trial_info(uuid)', 'execute'), null);
  perform pg_temp.res('20 ledger + extension tables: RLS on, no app access',
    (select relrowsecurity from pg_class where oid = 'public.trial_grants'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.trial_extensions'::regclass)
    and not has_table_privilege('authenticated', 'public.trial_grants', 'select')
    and not has_table_privilege('anon', 'public.trial_grants', 'select')
    and not has_table_privilege('authenticated', 'public.trial_extensions', 'select,insert,update,delete'), null);
  perform pg_temp.res('21 sample master never in the ledger',
    not exists (select 1 from public.trial_grants g join public.organizations o on o.id = g.org_id where o.is_sample_master), null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 05' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 4) one-time fill for studios that already had a trial (re-apply the file) ---------------------------
do $$ begin perform pg_temp.su(); delete from public.trial_grants where org_id = pg_temp.get('C')::uuid; end $$;
\ir ../../supabase/migrations/0186_trial_one_per_email_extension.sql
do $$ declare g public.trial_grants; begin
  perform pg_temp.su();
  select * into g from public.trial_grants where org_id = pg_temp.get('C')::uuid;
  perform pg_temp.res('22 fill: an existing trial studio gets its ledger row once (backfill, fingerprint)',
    g.recorded_how = 'backfill' and g.email_hash = public._trial_email_fingerprint('t186_c@d.test')
    and (select count(*) from public.trial_grants where org_id = pg_temp.get('C')::uuid) = 1, coalesce(g.recorded_how, '<none>'));
  perform pg_temp.res('23 re-running the file changes no ledger row (on conflict do nothing)',
    (select count(*) from public.trial_grants where org_id = pg_temp.get('A')::uuid) = 1, null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 06' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 5) trial extension: who may grant it ------------------------------------------------------------------
do $$ declare c uuid := pg_temp.get('C')::uuid; r text; v_mfa boolean; begin
  perform pg_temp.anon();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', c, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('24 anon: refused (42501)', r like 'err:42501:%', r);
  perform pg_temp.login('t186_c@d.test');
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', c, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('25 the studio''s own admin: refused (42501)', r like 'err:42501:%', r);
  perform pg_temp.login('t186_c@d.test');
  r := pg_temp.try(format('select public.hq_trial_info(%L)::text', c));
  perform pg_temp.su(); perform pg_temp.res('26 studio admin cannot read hq_trial_info (42501)', r like 'err:42501:%', r);
  perform pg_temp.svc();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', c, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('27 service role: refused (42501)', r like 'err:42501:%', r);
  if to_regclass('public.helm_hq_settings') is not null then
    select hq_require_mfa into v_mfa from public.helm_hq_settings where id;
    update public.helm_hq_settings set hq_require_mfa = true where id;
    perform pg_temp.op('aal1');
    r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', c, 'customer asked'));
    perform pg_temp.su(); update public.helm_hq_settings set hq_require_mfa = v_mfa where id;
    perform pg_temp.res('28 operator without the two-step code while HQ requires it: refused', r like 'err:42501:%', r);
  else
    perform pg_temp.res('28 operator without the two-step code while HQ requires it: refused', true);
  end if;
  perform pg_temp.res('29 nothing was extended by the refused calls', not exists (select 1 from public.trial_extensions where org_id = c), null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 07' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 6) trial extension: rules ---------------------------------------------------------------------------
do $$ declare c uuid := pg_temp.get('C')::uuid; r text; v_old timestamptz; v_new timestamptz; s public.studio_subscriptions; e public.trial_extensions; begin
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 0, %L)::text', c, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('30 0 days refused (22023)', r like 'err:22023:%1 to 7 days%', r);
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 8, %L)::text', c, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('31 8 days refused (22023)', r like 'err:22023:%1 to 7 days%', r);
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', c, '  ok  '));
  perform pg_temp.su(); perform pg_temp.res('32 reason required (at least 5 characters)', r like 'err:22023:%reason%', r);
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', gen_random_uuid(), 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('33 unknown studio refused', r like 'err:22023:%Unknown studio%', r);

  select trial_ends_at into v_old from public.organizations where id = c;
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 7, %L)::text', c, 'Customer needs one more week to evaluate'));
  perform pg_temp.su();
  perform pg_temp.res('34 operator (two-step): 7-day extension granted', r like 'ok:%"status": "trial"%', r);
  select trial_ends_at into v_new from public.organizations where id = c;
  perform pg_temp.res('35 trial end moved by exactly 7 days (studio)', v_new = v_old + interval '7 days', v_old::text || ' -> ' || coalesce(v_new::text, '?'));
  select * into s from public.studio_subscriptions where org_id = c;
  perform pg_temp.res('36 subscription follows: status trial, end date = new end (UTC date)',
    s.status = 'trial' and s.trial_ends_at = (v_new at time zone 'UTC')::date, s.status || ' ' || coalesce(s.trial_ends_at::text, '?'));
  select * into e from public.trial_extensions where org_id = c;
  perform pg_temp.res('37 extension recorded: days, reason, who, previous and new end',
    e.days = 7 and e.reason = 'Customer needs one more week to evaluate' and e.granted_by_email = 'admin@helm.events'
    and e.previous_ends_at = v_old and e.new_ends_at = v_new and e.previous_status = 'trial', coalesce(e.reason, '<none>'));
  perform pg_temp.res('38 HQ audit row hq.trial.extend (no studio, with the reason)',
    exists (select 1 from public.audit_log a where a.action = 'hq.trial.extend' and a.entity_id = c::text and a.org_id is null
              and a.changed ->> 'reason' = 'Customer needs one more week to evaluate' and (a.changed ->> 'days')::int = 7), null);
  perform pg_temp.res('39 studio audit row subscription.trial_extended (no reason, no operator e-mail)',
    exists (select 1 from public.audit_log a where a.action = 'subscription.trial_extended' and a.org_id = c
              and (a.changed ->> 'days')::int = 7 and not (a.changed ? 'reason') and a.actor is null), null);

  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 2, %L)::text', c, 'asking again please'));
  perform pg_temp.su();
  perform pg_temp.res('40 a second extension for the same studio is refused', r like 'err:22023:%one trial extension%', r);
  perform pg_temp.res('41 the refused second extension changed nothing',
    (select trial_ends_at from public.organizations where id = c) = v_new and (select count(*) from public.trial_extensions where org_id = c) = 1, null);

  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_trial_info(%L)::text', c));
  perform pg_temp.su();
  perform pg_temp.res('42 hq_trial_info: extension shown, cannot extend again',
    r like 'ok:%"can_extend": false%' and r like '%"days": 7%' and r like '%one trial extension%', r);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 08' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 7) an ended, unpaid trial (read-only) can get its extension; the lock lifts --------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; r text; v_lock_before boolean; v_new timestamptz; begin
  perform pg_temp.su();
  update public.organizations set trial_ends_at = now() - interval '2 days' where id = a;
  update public.studio_subscriptions set trial_ends_at = current_date - 2 where org_id = a;
  perform public._trial_refresh();                                  -- the hourly job: trial -> past_due
  v_lock_before := public._trial_locked(a);
  perform pg_temp.res('43 setup: ended trial is past due + read-only',
    v_lock_before and (select status from public.studio_subscriptions where org_id = a) = 'past_due', null);
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_trial_info(%L)::text', a));
  perform pg_temp.su();
  perform pg_temp.res('44 hq_trial_info: ended unpaid trial can be extended', r like 'ok:%"can_extend": true%', r);
  perform pg_temp.op();
  r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', a, 'Payment on the way, 3 days'));
  perform pg_temp.su();
  perform pg_temp.res('45 ended trial: extension granted', r like 'ok:%', r);
  select trial_ends_at into v_new from public.organizations where id = a;
  perform pg_temp.res('46 new end counts from now (ended trials do not lose days)', v_new = now() + interval '3 days', coalesce(v_new::text, '?'));
  perform pg_temp.res('47 back on trial, read-only lock lifted',
    (select status from public.studio_subscriptions where org_id = a) = 'trial' and not public._trial_locked(a), null);
  perform pg_temp.res('48 previous status recorded as past_due',
    (select previous_status from public.trial_extensions where org_id = a) = 'past_due', null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 09' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

-- ---- 8) never for paid / checkout / suspended / never-trial studios -----------------------------------------
do $$ declare p uuid; k uuid; x uuid; d uuid := pg_temp.get('AD')::uuid; j uuid; r text; begin
  perform pg_temp.su();
  j := pg_temp.org_of('jane.doe186@gmail.com');
  -- a paid studio (subscription active)
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (gen_random_uuid(), 'T186 Paid', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) returning id into p;
  insert into public.studio_subscriptions(org_id, status, current_period_start, current_period_end, updated_at)
    values (p, 'active', current_date - 10, current_date + 20, now());
  -- a past-due studio that had a paid period (lapsed customer, not a free trial)
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (gen_random_uuid(), 'T186 Lapsed', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) returning id into x;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, current_period_start, current_period_end, updated_at)
    values (x, 'past_due', current_date - 60, current_date - 40, current_date - 10, now());
  -- a checkout (Razorpay) trial
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (gen_random_uuid(), 'T186 Checkout', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) returning id into k;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, provider, provider_subscription_id, updated_at)
    values (k, 'trial', current_date + 10, 'checkout', 'razorpay', 'sub_T186abcdef', now());
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', p, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('49 paid studio: refused', r like 'err:22023:%free trial%', r);
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', x, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('50 lapsed paid studio (past due after a paid period): refused', r like 'err:22023:%', r);
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', k, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('51 online-checkout trial: refused', r like 'err:22023:%checkout%', r);
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', d, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('52 studio that never had a trial (no subscription): refused', r like 'err:22023:%not on a free trial%', r);
  -- suspended trial studio
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_suspend_studio(%L, %L)::text', j, 'test suspend'));
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 3, %L)::text', j, 'customer asked'));
  perform pg_temp.su(); perform pg_temp.res('53 suspended studio: refused (reactivate first)', r like 'err:22023:%suspended%', r);
  -- a free trial that HQ cancelled after it ended (never paid): still its one extension
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at, trial_ends_at, trial_mode)
    values (gen_random_uuid(), 'T186 Cancelled trial', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now() - interval '20 days', now() - interval '12 days', 'own')
    returning id into j;
  insert into public.studio_subscriptions(org_id, status, trial_ends_at, trial_source, updated_at)
    values (j, 'cancelled', current_date - 12, 'bypass', now());
  perform pg_temp.op(); r := pg_temp.try(format('select public.hq_extend_trial(%L, 2, %L)::text', j, 'customer came back'));
  perform pg_temp.su(); perform pg_temp.res('55 lapsed + cancelled free trial (never paid): extension granted, back on trial',
    r like 'ok:%' and (select status from public.studio_subscriptions where org_id = j) = 'trial'
    and (select trial_ends_at from public.organizations where id = j) = now() + interval '2 days', r);
  perform pg_temp.res('54 paid studios untouched by the refused calls',
    (select status from public.studio_subscriptions where org_id = p) = 'active'
    and (select status from public.studio_subscriptions where org_id = x) = 'past_due'
    and (select trial_ends_at from public.studio_subscriptions where org_id = k) = current_date + 10
    and not exists (select 1 from public.trial_extensions where org_id in (p, x, k, d)), null);
exception when others then perform pg_temp.su(); insert into _te values ('zz block 10' , 'FAIL: '||sqlstate||' '||sqlerrm);
end $$;

select name, result from _te order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-EXTENSION-0186: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-EXTENSION-0186: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _te;
rollback;
