-- r87-referral-attach-unknown-0309.sql -- 0309: while the switch is OFF (pilot mode) referral_attach answers "unknown"
-- for a real non-pilot studio code / partner code exactly like a missing code (no oracle); a pilot code still attaches;
-- switch fully off = "off" for all; switch ON = unchanged ("inactive" stays "inactive"); kept copy + grants.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
set client_min_messages = error;
\ir ../../supabase/migrations/0309_r87_referral_attach_unknown.sql
\ir ../../supabase/migrations/0309_r87_referral_attach_unknown.sql
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
create or replace function pg_temp.att(p_email text, p_code text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.trial(p_email); perform pg_temp.login(p_email);
  r := public.referral_attach(p_code, null, null, true, 'dev-' || md5(p_email));
  perform pg_temp.su(); return r;
end $$;

do $$ declare a uuid; b uuid; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  insert into public.platform_admins(email) values ('admin@helm.events') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'admin@helm.events';
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('pa@r87a.test'); perform pg_temp.put('A', a::text);
  b := pg_temp.trial('pb@r87b.test'); perform pg_temp.put('B', b::text);
  perform pg_temp.put('codeA', public._r29_studio_code(a)); perform pg_temp.put('codeB', public._r29_studio_code(b));
  insert into public.referral_codes(code, kind, partner_name) values ('R87-PARTNER', 'partner', 'R87 partner') on conflict do nothing;
  insert into public.referral_codes(code, kind, partner_name, active) values ('R87-OFFP', 'partner', 'R87 off', false) on conflict do nothing;
  update public.referral_settings set program_on = false, pilot_org_ids = array[a] where id;
end $$;

do $$ declare rb jsonb; rp jsonb; ri jsonb; ru jsonb; begin
  rb := pg_temp.att('c1@r87.test', pg_temp.get('codeB'));
  rp := pg_temp.att('c2@r87.test', 'R87-PARTNER');
  ri := pg_temp.att('c3@r87.test', 'R87-OFFP');
  ru := pg_temp.att('c4@r87.test', 'NOPE-R87X');
  perform pg_temp.res('01 pilot mode: non-pilot studio code, partner, inactive partner, missing code -> same "unknown"',
    rb = ru and rp = ru and ri = ru and ru ->> 'reason' = 'unknown', rb::text || rp::text || ri::text || ru::text);
  perform pg_temp.res('02 nothing recorded for the refused codes',
    not exists (select 1 from public.referrals r join public.organizations o on o.id = r.referred_org where o.created_by in
      (select id from auth.users where email like 'c_@r87.test')));
exception when others then perform pg_temp.su(); insert into _rr values ('01x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; begin
  r := pg_temp.att('c5@r87.test', pg_temp.get('codeA'));
  perform pg_temp.res('03 pilot code still attaches', (r ->> 'ok')::boolean, r::text);
exception when others then perform pg_temp.su(); insert into _rr values ('03x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; begin
  perform pg_temp.su(); update public.referral_settings set pilot_org_ids = '{}' where id;
  r := pg_temp.att('c6@r87.test', pg_temp.get('codeB'));
  perform pg_temp.res('04 switch fully off, no pilot: "off" for every code (unchanged)', r ->> 'reason' = 'off', r::text);
  perform pg_temp.su(); update public.referral_settings set program_on = true where id;
  r := pg_temp.att('c7@r87.test', 'R87-OFFP');
  perform pg_temp.res('05 switch on: inactive code still answers "inactive" (unchanged)', r ->> 'reason' = 'inactive', r::text);
  r := pg_temp.att('c8@r87.test', pg_temp.get('codeB'));
  perform pg_temp.res('06 switch on: real studio code attaches', (r ->> 'ok')::boolean, r::text);
  perform pg_temp.su(); update public.referral_settings set program_on = false where id;
exception when others then perform pg_temp.su(); insert into _rr values ('04x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('07 live name: definer, empty search_path, marker; authenticated can call, anon cannot',
    coalesce((select p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=""%' and position('r87-attach-unknown-0309' in p.prosrc) > 0
      from pg_proc p where p.oid = to_regprocedure('public.referral_attach(text,text,timestamptz,boolean,text)')), false)
    and has_function_privilege('authenticated', 'public.referral_attach(text,text,timestamptz,boolean,text)', 'execute')
    and not has_function_privilege('anon', 'public.referral_attach(text,text,timestamptz,boolean,text)', 'execute'));
  perform pg_temp.res('08 previous body kept once as referral_attach__pre0309 (real body), logic + copy not callable by the app',
    coalesce((select position('r87-attach-unknown-0309' in p.prosrc) = 0 and position('_r29_any_on' in p.prosrc) > 0 from pg_proc p
      where p.oid = to_regprocedure('public.referral_attach__pre0309(text,text,timestamptz,boolean,text)')), false)
    and not has_function_privilege('authenticated', 'public.referral_attach__pre0309(text,text,timestamptz,boolean,text)', 'execute')
    and not has_function_privilege('anon', 'public.referral_attach__pre0309(text,text,timestamptz,boolean,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r309_attach(text,text,timestamptz,boolean,text)', 'execute'));
exception when others then perform pg_temp.su(); insert into _rr values ('07x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rr order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R87-REFERRAL-ATTACH-UNKNOWN-0309: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R87-REFERRAL-ATTACH-UNKNOWN-0309: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rr;
rollback;
