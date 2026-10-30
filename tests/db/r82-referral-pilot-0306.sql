-- r82-referral-pilot-0306.sql -- 0306 referral PILOT list: the program is on for a pilot studio only while the global
-- switch is OFF. Proves: empty list = exactly the old answers (off for everyone); a pilot studio sees its code; a
-- non-pilot studio stays off; a pilot's code works on the sign-up page (with the referring studio's name) and attaches
-- to a NEW studio; a non-pilot / partner code answers "unknown" (no oracle) and cannot attach; the 14-day hold after the
-- first payment still applies; the old bodies are kept as *__pre0306 with no app privilege; switch ON behaves as 0279.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
set client_min_messages = error;
\ir ../../supabase/migrations/0306_r82_referral_pilot.sql
\ir ../../supabase/migrations/0306_r82_referral_pilot.sql
set client_min_messages = warning;
create temp table _rr(name text, result text); grant all on _rr to anon, authenticated, service_role;
create temp table _rk(k text primary key, v text); grant all on _rk to anon, authenticated, service_role;
create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
create or replace function pg_temp.login(p_email text, p_ip text default null) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip)::text, false); end if;
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.op(p_email text default 'admin@helm.events', p_aal text default 'aal2') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon(p_ip text default null) returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  if p_ip is not null then perform set_config('request.headers', jsonb_build_object('x-forwarded-for', p_ip)::text, false); end if;
  perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rr values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _rk values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _rk where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_org uuid default null, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, p_org, false, now())
    on conflict (id) do update set org_id = p_org, role = p_role, email = p_email;
  return u;
end $$;
-- a new free-trial studio made by p_email
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('R29 ' || split_part(p_email, '@', 1), 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- HQ records a payment + activates the plan (the one path that makes a studio paying, 0244)
create or replace function pg_temp.pay(p_org uuid, p_amt numeric, p_interval text default 'monthly', p_plan text default 'studio') returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.op();
  r := public.hq_activate_plan(p_org, p_plan, p_interval, p_amt, 'upi', current_date, current_date, 'R29-' || p_amt || '-' || left(p_org::text, 8), 'INR', null);
  perform pg_temp.su(); return r;
end $$;
-- a new studio signs up with a code (typed), optionally from a network / device
create or replace function pg_temp.referred(p_email text, p_code text, p_consent boolean default false, p_ip text default null, p_device text default null)
returns uuid language plpgsql as $$
declare o uuid; r jsonb; begin
  o := pg_temp.trial(p_email); perform pg_temp.login(p_email, p_ip);
  r := public.referral_attach(p_code, null, null, p_consent, p_device);
  perform pg_temp.su(); perform pg_temp.put('att:' || p_email, r::text); return o;
end $$;
create or replace function pg_temp.endhold(p_org uuid) returns void language plpgsql as $$
begin perform pg_temp.su(); update public.referrals set hold_until = now() - interval '1 minute' where referred_org = p_org; end $$;
create or replace function pg_temp.tick() returns jsonb language plpgsql as $$
begin perform pg_temp.su(); return public.referral_tick(); end $$;
create or replace function pg_temp.st(p_org uuid) returns text language sql as $$ select status from public.referrals where referred_org = p_org $$;
create or replace function pg_temp.rsn(p_org uuid) returns text language sql as $$ select reason from public.referrals where referred_org = p_org $$;
create or replace function pg_temp.rw(p_studio uuid, p_state text) returns int language sql as $$
  select count(*)::int from public.referral_rewards where studio_id = p_studio and state = p_state $$;
create or replace function pg_temp.pe(p_org uuid) returns date language sql as $$ select current_period_end from public.studio_subscriptions where org_id = p_org $$;
create or replace function pg_temp.code(p_email text) returns text language plpgsql as $$
declare r jsonb; begin perform pg_temp.login(p_email); r := public.my_referral('dev-' || md5(p_email)); perform pg_temp.su(); return r ->> 'code'; end $$;

-- ---- setup: A = pilot studio, B = another studio, both on trial; switch OFF, pilot list empty ------------------------
do $$ declare a uuid; b uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  update public.helm_sample_template set active = true where id;
  update public.referral_settings set program_on = false, pilot_org_ids = '{}' where id;
  a := pg_temp.trial('pa@r82a.test'); perform pg_temp.put('A', a::text);
  b := pg_temp.trial('pb@r82b.test'); perform pg_temp.put('B', b::text);
  perform pg_temp.put('codeB', public._r29_studio_code(b));
  perform pg_temp.put('codeA', public._r29_studio_code(a));
  insert into public.referral_codes(code, kind, partner_name) values ('R82-PARTNER', 'partner', 'R82 partner') on conflict do nothing;
end $$;

-- ---- 01 empty pilot list = the old answers ----------------------------------------------------------------------------
do $$ declare r jsonb; l jsonb; begin
  perform pg_temp.login('pa@r82a.test'); r := public.my_referral('dev-r82-aaaaaaaa'); perform pg_temp.su();
  perform pg_temp.anon('203.0.113.10'); l := public.referral_lookup(pg_temp.get('codeA')); perform pg_temp.su();
  perform pg_temp.res('01 empty pilot list + switch off: page off, look-up off', r ->> 'program_on' = 'false' and l ->> 'reason' = 'off', r::text || l::text);
exception when others then perform pg_temp.su(); insert into _rr values ('01x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 02 pilot A on: A sees its code, B stays off ------------------------------------------------------------------------
do $$ declare ra jsonb; rb jsonb; begin
  perform pg_temp.su();
  update public.referral_settings set pilot_org_ids = array[pg_temp.get('A')::uuid] where id;
  perform pg_temp.login('pa@r82a.test'); ra := public.my_referral('dev-r82-aaaaaaaa'); perform pg_temp.su();
  perform pg_temp.login('pb@r82b.test'); rb := public.my_referral('dev-r82-bbbbbbbb'); perform pg_temp.su();
  perform pg_temp.res('02a pilot studio sees its code, link and rules, flagged pilot',
    ra ->> 'program_on' = 'true' and ra ->> 'code' = pg_temp.get('codeA') and ra ->> 'link_path' = '/r/' || pg_temp.get('codeA')
    and (ra ->> 'pilot')::boolean and (ra -> 'rules' ->> 'hold_days')::int = 14, ra::text);
  perform pg_temp.res('02b every other studio stays off', rb ->> 'program_on' = 'false' and not (rb ? 'code'), rb::text);
exception when others then perform pg_temp.su(); insert into _rr values ('02x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 03 sign-up look-up -----------------------------------------------------------------------------------------------
do $$ declare la jsonb; lb jsonb; lp jsonb; lu jsonb; begin
  perform pg_temp.anon('203.0.113.11');
  la := public.referral_lookup(pg_temp.get('codeA')); lb := public.referral_lookup(pg_temp.get('codeB'));
  lp := public.referral_lookup('R82-PARTNER'); lu := public.referral_lookup('NOPE-R82X');
  perform pg_temp.su();
  perform pg_temp.res('03a pilot code works signed out and names the referring studio',
    (la ->> 'ok')::boolean and la ->> 'kind' = 'referral' and la ->> 'referrer' = 'R29 pa', la::text);
  perform pg_temp.res('03b non-pilot studio code, partner code and a missing code give the same "unknown"',
    lb = lu and lp = lu and lu ->> 'reason' = 'unknown', lb::text || lp::text || lu::text);
exception when others then perform pg_temp.su(); insert into _rr values ('03x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 04 a NEW studio signs up with the pilot's code; a non-pilot code does not attach -----------------------------------
do $$ declare c uuid; d uuid; ra jsonb; begin
  c := pg_temp.referred('pc@r82c.test', pg_temp.get('codeA'), true, '198.51.100.21', 'dev-r82-cccccccc'); perform pg_temp.put('C', c::text);
  d := pg_temp.referred('pd@r82d.test', pg_temp.get('codeB'), true, '198.51.100.22', 'dev-r82-dddddddd'); perform pg_temp.put('D', d::text);
  perform pg_temp.res('04a pilot code attaches to the new studio (trial)',
    (pg_temp.get('att:pc@r82c.test')::jsonb ->> 'ok')::boolean and pg_temp.st(c) = 'trial', pg_temp.get('att:pc@r82c.test'));
  perform pg_temp.res('04b non-pilot code is refused (off) and nothing is recorded',
    pg_temp.get('att:pd@r82d.test')::jsonb ->> 'reason' = 'off' and pg_temp.st(d) is null, pg_temp.get('att:pd@r82d.test'));
  perform pg_temp.login('pa@r82a.test'); ra := public.my_referral('dev-r82-aaaaaaaa'); perform pg_temp.su();
  perform pg_temp.res('04c the referral shows on the pilot studio page (name, since they agreed)',
    jsonb_array_length(ra -> 'referrals') = 1 and ra -> 'referrals' -> 0 ->> 'label' = 'R29 pc' and ra -> 'referrals' -> 0 ->> 'status' = 'trial', ra::text);
  perform pg_temp.res('04d HQ sees the referral (row exists for HQ lists)',
    exists (select 1 from public.referrals r where r.referred_org = c and r.referrer_org = pg_temp.get('A')::uuid and r.via = 'typed'));
exception when others then perform pg_temp.su(); insert into _rr values ('04x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 05 the reward rules still apply: first payment -> 14-day hold, no reward yet ----------------------------------------
do $$ declare c uuid := pg_temp.get('C')::uuid; begin
  perform pg_temp.pay(c, 2999);
  perform pg_temp.tick();
  perform pg_temp.res('05 first payment starts the 14-day hold; no free month before it ends',
    pg_temp.st(c) = 'hold' and (select hold_until > now() + interval '13 days' from public.referrals where referred_org = c)
    and pg_temp.rw(pg_temp.get('A')::uuid, 'scheduled') + pg_temp.rw(pg_temp.get('A')::uuid, 'held') = 0, pg_temp.st(c));
exception when others then perform pg_temp.su(); insert into _rr values ('05x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 06 kept copies + grants --------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('06a old bodies kept once as *__pre0306, no app privilege',
    to_regprocedure('public.my_referral__pre0306(text)') is not null and to_regprocedure('public.referral_lookup__pre0306(text)') is not null
    and to_regprocedure('public.referral_attach__pre0306(text,text,timestamptz,boolean,text)') is not null
    and to_regprocedure('public._r29_code_problem__pre0306(public.referral_codes)') is not null
    and not has_function_privilege('anon', 'public.referral_lookup__pre0306(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.my_referral__pre0306(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.referral_attach__pre0306(text,text,timestamptz,boolean,text)', 'execute'));
  perform pg_temp.res('06b live grants unchanged; helpers internal; settings not readable by the app',
    has_function_privilege('anon', 'public.referral_lookup(text)', 'execute') and not has_function_privilege('anon', 'public.my_referral(text)', 'execute')
    and has_function_privilege('authenticated', 'public.my_referral(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r29_on_for(uuid)', 'execute') and not has_function_privilege('anon', 'public._r29_any_on()', 'execute')
    and not has_table_privilege('authenticated', 'public.referral_settings', 'select') and not has_table_privilege('authenticated', 'public.referral_settings', 'update'));
exception when others then perform pg_temp.su(); insert into _rr values ('06x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 07 switch ON = 0279 behaviour for everyone; list emptied again = off for everyone ----------------------------------
do $$ declare rb jsonb; lb jsonb; lb2 jsonb; ra jsonb; begin
  perform pg_temp.su(); update public.referral_settings set program_on = true where id;
  perform pg_temp.login('pb@r82b.test'); rb := public.my_referral('dev-r82-bbbbbbbb'); perform pg_temp.su();
  perform pg_temp.anon('203.0.113.12'); lb := public.referral_lookup(pg_temp.get('codeB')); perform pg_temp.su();
  perform pg_temp.res('07a switch on: every studio has its page and its code works', rb ->> 'program_on' = 'true' and not (rb ->> 'pilot')::boolean and (lb ->> 'ok')::boolean, rb::text || lb::text);
  update public.referral_settings set program_on = false, pilot_org_ids = '{}' where id;
  perform pg_temp.login('pa@r82a.test'); ra := public.my_referral('dev-r82-aaaaaaaa'); perform pg_temp.su();
  perform pg_temp.anon('203.0.113.13'); lb2 := public.referral_lookup(pg_temp.get('codeA')); perform pg_temp.su();
  perform pg_temp.res('07b switch off + pilot removed: off again for the former pilot too', ra ->> 'program_on' = 'false' and lb2 ->> 'reason' = 'off', ra::text || lb2::text);
exception when others then perform pg_temp.su(); insert into _rr values ('07x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R82-REFERRAL-PILOT-0306: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R82-REFERRAL-PILOT-0306: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rr;
rollback;
