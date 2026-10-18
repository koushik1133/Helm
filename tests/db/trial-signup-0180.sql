-- trial-signup-0180.sql -- 0180: every new free trial is sample data + India whatever the page sends
-- (no "own data" choice), the 2-step welcome is driven by a server-side org flag (works across
-- devices), and the free-trial owner is never forced to /profile-setup first. Paid studios unchanged.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- earlier suites re-apply old migrations (0041 / 0119 bodies); re-apply 0180 inside this rolled-back tx
\ir ../../supabase/migrations/0180_trial_signup_flow.sql
create temp table _ts(name text, result text); grant all on _ts to anon, authenticated, service_role;
create temp table _tkv(k text primary key, v text); grant all on _tkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ts values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _tkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _tkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, null, false, now())
    on conflict (id) do update set org_id = null, role = p_role;
  return u;
end $$;
-- start a trial the way the sign-up page does, with whatever an old / foreign browser might send
create or replace function pg_temp.trial(p_email text, p_name text, p_tz text, p_cur text, p_mode text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial(p_name, p_tz, p_cur, p_mode);
  perform pg_temp.su(); return r;
end $$;

-- ---- 1) an old page asks for 'own' from a US browser: sample data + India anyway ------------------
do $$ declare r jsonb; o public.organizations; s text; a jsonb; begin
  r := pg_temp.trial('ts_own@t.test', null, 'America/Chicago', 'USD', 'own');
  perform pg_temp.put('A', r ->> 'org_id');
  perform pg_temp.res('01 own request: trial started', r ->> 'result' = 'started', r::text);
  perform pg_temp.res('02 own request: mode forced to demo', r ->> 'mode' = 'demo' and r ->> 'currency' = 'INR' and r ->> 'timezone' = 'Asia/Kolkata', r::text);
  select * into o from public.organizations where id = (r ->> 'org_id')::uuid;
  perform pg_temp.res('03 studio: trial_mode demo', o.trial_mode = 'demo', coalesce(o.trial_mode, '<null>'));
  perform pg_temp.res('04 studio: INR / Asia/Kolkata / IN / GST region / trial_region IN',
    o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.country = 'IN'
    and nullif(btrim(coalesce(o.tax_region, '')), '') is not null and o.trial_region = 'IN',
    concat_ws(' ', o.currency, o.timezone, o.country, o.tax_region, o.trial_region));
  perform pg_temp.res('05 studio: welcome flag set', o.trial_welcome_pending is true, coalesce(o.trial_welcome_pending::text, '<null>'));
  select s2.status into s from public.studio_subscriptions s2 where s2.org_id = o.id;
  perform pg_temp.res('06 subscription row is the free trial', s = 'trial', coalesce(s, '<none>'));
  perform pg_temp.res('07 sample seeding ran (seed result recorded, never blocks)', r ? 'seed' and r ? 'extra', r::text);
  select x.changed into a from public.audit_log x where x.org_id = o.id and x.action = 'subscription.trial_started' order by x.at desc limit 1;
  perform pg_temp.res('08 audit: mode demo, the ignored request noted', a ->> 'mode' = 'demo' and a ->> 'requested_mode' = 'own', coalesce(a::text, '<none>'));
exception when others then perform pg_temp.su(); insert into _ts values ('0x own request', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) unknown mode / other currency are no longer refused: same trial ---------------------------
do $$ declare r jsonb; o public.organizations; begin
  r := pg_temp.trial('ts_zzz@t.test', '  Aurora   Events ', 'Asia/Dubai', 'AED', 'zzz');
  perform pg_temp.res('09 bad mode: trial started as demo', r ->> 'result' = 'started' and r ->> 'mode' = 'demo', r::text);
  select * into o from public.organizations where id = (r ->> 'org_id')::uuid;
  perform pg_temp.res('10 own name kept (spaces tidied), still INR / Kolkata',
    o.name = 'Aurora Events' and o.currency = 'INR' and o.timezone = 'Asia/Kolkata', concat_ws(' ', o.name, o.currency, o.timezone));
  r := pg_temp.trial('ts_null@t.test', null, null, null, null);
  perform pg_temp.res('11 null mode: Demo N trial as demo', r ->> 'result' = 'started' and r ->> 'mode' = 'demo' and r ->> 'name' ~ '^Demo [0-9]+$', r::text);
  -- a second call from someone already in a studio changes nothing
  perform pg_temp.login('ts_own@t.test');
  r := public.start_self_serve_trial('Other', 'Europe/London', 'GBP', 'own');
  perform pg_temp.su();
  perform pg_temp.res('12 already in a studio: has_studio, nothing created', r ->> 'result' = 'has_studio' and r ->> 'org_id' = pg_temp.get('A'), r::text);
exception when others then perform pg_temp.su(); insert into _ts values ('0x bad mode', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) welcome flag: trial admin only; done / again; members never ------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; v boolean; r jsonb; e text; begin
  perform pg_temp.login('ts_own@t.test');
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('13 welcome pending for the trial admin', v is true, coalesce(v::text, '<null>'));
  -- a non-admin member of the same trial studio
  perform pg_temp.newuser('ts_member@t.test', 'coordinator');
  update public.profiles set org_id = a where email = 'ts_member@t.test';
  perform pg_temp.login('ts_member@t.test');
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('14 member: no welcome', v is false, coalesce(v::text, '<null>'));
  e := pg_temp.try($q$select public.trial_welcome_set(false)$q$);
  perform pg_temp.res('15 member cannot clear the flag', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('16 flag untouched by the member', (select trial_welcome_pending from public.organizations where id = a) is true, null);
  perform pg_temp.login('ts_own@t.test');
  r := public.trial_welcome_set(false);
  perform pg_temp.res('17 admin finishes the welcome: cleared', r ->> 'changed' = 'true' and r ->> 'pending' = 'false', r::text);
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('18 no longer pending (other devices too)', v is false, coalesce(v::text, '<null>'));
  r := public.trial_welcome_set(false);
  perform pg_temp.res('19 clearing twice is a no-op', r ->> 'changed' = 'false', r::text);
  r := public.trial_welcome_set(true);
  perform pg_temp.res('20 again (start fresh): pending once more', r ->> 'changed' = 'true' and public.my_trial_welcome_pending() is true, r::text);
  perform public.trial_welcome_set(false);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ts values ('1x welcome flag', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) profile gate: the trial owner is never forced; a trial member keeps the 0041 rule ----------
do $$ declare a uuid := pg_temp.get('A')::uuid; r jsonb; begin
  perform pg_temp.su();
  update public.member_profile_settings set gate_cutoff = now() - interval '1 day' where id;
  update public.organizations set trial_welcome_pending = true where id = a;
  perform pg_temp.login('ts_own@t.test');
  r := public.my_profile_status();
  perform pg_temp.res('21 trial owner: not required, no nudge during the welcome', r ->> 'required' = 'false' and r ->> 'nudge' = 'false', r::text);
  perform public.trial_welcome_set(false);
  r := public.my_profile_status();
  perform pg_temp.res('22 trial owner after the welcome: nudge only', r ->> 'required' = 'false' and r ->> 'nudge' = 'true', r::text);
  perform pg_temp.login('ts_member@t.test');
  r := public.my_profile_status();
  perform pg_temp.res('23 invited trial member: 0041 rule unchanged (required)', r ->> 'required' = 'true', r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ts values ('2x profile gate', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) paid "Create studio" studio: no welcome, profile gate unchanged, flag never written --------
do $$ declare p uuid; r jsonb; v boolean; e text; begin
  perform pg_temp.newuser('ts_paid@t.test');
  perform pg_temp.login('ts_paid@t.test');
  p := public.create_studio('TS Paid Studio', null, 'USD', 'America/Chicago');
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values (p, 'active') on conflict (org_id) do update set status = 'active';
  update public.member_profile_settings set gate_cutoff = now() - interval '1 day' where id;
  perform pg_temp.res('24 paid: welcome flag NULL, currency kept', (select trial_welcome_pending is null and currency = 'USD' from public.organizations where id = p), null);
  perform pg_temp.login('ts_paid@t.test');
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('25 paid: no welcome', v is false, coalesce(v::text, '<null>'));
  e := pg_temp.try($q$select public.trial_welcome_set(true)$q$);
  perform pg_temp.res('26 paid: cannot turn the welcome on', e like '22023%', e);
  r := public.trial_welcome_set(false);
  perform pg_temp.res('27 paid: clearing writes nothing (stays NULL)', r ->> 'changed' = 'false'
    and (select trial_welcome_pending is null from public.organizations where id = p), r::text);
  r := public.my_profile_status();
  perform pg_temp.res('28 paid owner: profile gate unchanged (required)', r ->> 'required' = 'true', r::text);
  perform pg_temp.su();
  -- even a stray flag on a paid studio never shows the welcome
  update public.organizations set trial_welcome_pending = true where id = p;
  perform pg_temp.login('ts_paid@t.test');
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('29 paid + stray flag: still no welcome', v is false, coalesce(v::text, '<null>'));
  perform pg_temp.su();
  update public.organizations set trial_welcome_pending = null where id = p;
exception when others then perform pg_temp.su(); insert into _ts values ('3x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) tenant isolation + ended trial ------------------------------------------------------------
do $$ declare a uuid := pg_temp.get('A')::uuid; b uuid; v boolean; begin
  perform pg_temp.su();
  update public.organizations set trial_welcome_pending = true where id = a;
  select p.org_id into b from public.profiles p where p.email = 'ts_zzz@t.test';
  -- B finishes its own welcome: A's flag is untouched
  perform pg_temp.login('ts_zzz@t.test');
  perform public.trial_welcome_set(false);
  perform pg_temp.su();
  perform pg_temp.res('30 another studio''s call never touches this studio', (select trial_welcome_pending from public.organizations where id = a) is true
    and (select trial_welcome_pending from public.organizations where id = b) is false, null);
  -- the trial ended (read-only): no welcome even with the flag on
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = a;
  update public.studio_subscriptions set trial_ends_at = current_date - 1 where org_id = a;
  perform pg_temp.login('ts_own@t.test');
  v := public.my_trial_welcome_pending();
  perform pg_temp.res('31 ended trial: no welcome', v is false, coalesce(v::text, '<null>'));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ts values ('4x isolation', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) privileges ----------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('32 anon cannot read / set the welcome flag or start a trial',
    not has_function_privilege('anon', 'public.my_trial_welcome_pending()', 'execute')
    and not has_function_privilege('anon', 'public.trial_welcome_set(boolean)', 'execute')
    and not has_function_privilege('anon', 'public.start_self_serve_trial(text, text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.my_profile_status()', 'execute'), null);
  perform pg_temp.res('33 signed-in users can call them',
    has_function_privilege('authenticated', 'public.my_trial_welcome_pending()', 'execute')
    and has_function_privilege('authenticated', 'public.trial_welcome_set(boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.my_profile_status()', 'execute'), null);
end $$;

select name, result from _ts order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-SIGNUP-0180: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-SIGNUP-0180: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ts;
rollback;
