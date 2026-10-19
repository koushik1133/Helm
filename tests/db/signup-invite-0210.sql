-- signup-invite-0210.sql -- 0210: invite_open_for_email (service role only: the newest pending + unexpired
-- invitation of exactly one e-mail - studio + role; nothing for any other e-mail; nothing written) and
-- trial_welcome_save (the trial welcome's "Name your studio" with City + State + Country India: own free-trial
-- studio admin only; state from the Indian list; other billing keys kept; country / tax_region mirrored).
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- re-apply 0210 twice inside this rolled-back tx (also proves a re-run is safe)
\ir ../../supabase/migrations/0210_signup_invite_location.sql
\ir ../../supabase/migrations/0210_signup_invite_location.sql
create temp table _si(name text, result text); grant all on _si to anon, authenticated, service_role;
create temp table _sikv(k text primary key, v text); grant all on _sikv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _si values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _sikv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _sikv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text, p_role text default 'admin') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, p_role, null, false, now())
    on conflict (id) do update set org_id = null, role = p_role;
  return u;
end $$;
create or replace function pg_temp.trial(p_email text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial(null, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.inv(p_org uuid, p_email text, p_status text default 'pending', p_exp interval default interval '7 days',
                                       p_role text default 'planner', p_created timestamptz default now())
returns text language plpgsql as $$
declare t text; begin
  insert into public.invitations(org_id, email, role, status, expires_at, created_at)
    values (p_org, p_email, p_role, p_status, now() + p_exp, p_created) returning token into t;
  return t;
end $$;
create or replace function pg_temp.look(p_email text) returns jsonb language plpgsql as $$
declare r jsonb; begin perform pg_temp.svc(); r := public.invite_open_for_email(p_email); perform pg_temp.su(); return r; end $$;
create or replace function pg_temp.fp() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(i)::text, ',' order by i.id) from public.invitations i),
    (select string_agg(to_jsonb(o)::text, ',' order by o.id) from public.organizations o),
    (select count(*)::text from public.audit_log)));
$$;
create or replace function pg_temp.org(p_id uuid) returns jsonb language sql as $$
  select to_jsonb(o) from public.organizations o where o.id = p_id $$;

-- ---- 0x: structure ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 both functions exist: SECURITY DEFINER with an empty search_path',
    (select bool_and(prosecdef and 'search_path=""' = any(proconfig)) from pg_proc
      where oid in (to_regprocedure('public.invite_open_for_email(text)'),
                    to_regprocedure('public.trial_welcome_save(text,text,text,text,text)')))
    and to_regprocedure('public.invite_open_for_email(text)') is not null
    and to_regprocedure('public.trial_welcome_save(text,text,text,text,text)') is not null);
  perform pg_temp.res('02 invite_open_for_email: service role only (anon / signed-in app cannot call it)',
    has_function_privilege('service_role', 'public.invite_open_for_email(text)', 'execute')
    and not has_function_privilege('anon', 'public.invite_open_for_email(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_open_for_email(text)', 'execute'));
  perform pg_temp.res('03 trial_welcome_save: signed-in only; the list helper is not an API',
    has_function_privilege('authenticated', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.trial_welcome_save(text,text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public._in_states_0210()', 'execute')
    and not has_function_privilege('authenticated', 'public._in_states_0210()', 'execute'));
  perform pg_temp.res('04 the Indian states list: 36 names, Telangana + Maharashtra + Delhi in it, no duplicates',
    array_length(public._in_states_0210(), 1) = 36 and 'Telangana' = any(public._in_states_0210())
    and 'Maharashtra' = any(public._in_states_0210()) and 'Delhi' = any(public._in_states_0210())
    and (select count(distinct s) from unnest(public._in_states_0210()) s) = 36);
  perform pg_temp.res('05 the old 3-argument welcome step is still there (cached pages keep working)',
    to_regprocedure('public.trial_welcome_setup(text,text,text)') is not null
    and has_function_privilege('authenticated', 'public.trial_welcome_setup(text,text,text)', 'execute'));
end $$;

-- ---- 1x: open invitation for one e-mail ----------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; r jsonb; e text; f0 text; begin
  perform pg_temp.su();
  perform pg_temp.put('tOpen', pg_temp.inv(a, 'Open.Person@SI.test', 'pending', interval '7 days', 'planner', now() - interval '2 hours'));
  perform pg_temp.put('tNewer', pg_temp.inv(a, 'open.person@si.test', 'pending', interval '7 days', 'coordinator', now() - interval '1 hour'));
  perform pg_temp.inv(a, 'late@si.test', 'pending', interval '-1 minute');
  perform pg_temp.inv(a, 'gone@si.test', 'revoked');
  perform pg_temp.inv(a, 'done@si.test', 'accepted');
  f0 := pg_temp.fp();
  r := pg_temp.look('  OPEN.person@si.TEST ');
  perform pg_temp.res('10 an open invitation is found (case / spaces ignored): studio + role',
    r ->> 'found' = 'true' and r ->> 'studio' = (select name from public.organizations where id = a) and r ->> 'role' = 'coordinator', r::text);
  perform pg_temp.res('11 two open invitations: the NEWEST one', r ->> 'token' = pg_temp.get('tNewer'), r::text);
  perform pg_temp.res('12 the answer carries only studio / role / token / expiry / inviter (no e-mail, no org id)',
    (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['expires_at', 'found', 'invited_by', 'role', 'studio', 'token'], r::text);
  perform pg_temp.res('13 expired invitation -> nothing', pg_temp.look('late@si.test') = '{"found": false}'::jsonb);
  perform pg_temp.res('14 revoked invitation -> nothing', pg_temp.look('gone@si.test') = '{"found": false}'::jsonb);
  perform pg_temp.res('15 accepted invitation -> nothing', pg_temp.look('done@si.test') = '{"found": false}'::jsonb);
  perform pg_temp.res('16 an e-mail without any invitation -> nothing', pg_temp.look('nobody@si.test') = '{"found": false}'::jsonb);
  perform pg_temp.res('17 malformed / empty / null / overlong e-mail -> nothing',
    pg_temp.look('not-an-email') = '{"found": false}'::jsonb and pg_temp.look('') = '{"found": false}'::jsonb
    and pg_temp.look(null) = '{"found": false}'::jsonb and pg_temp.look(repeat('a', 250) || '@si.test') = '{"found": false}'::jsonb);
  perform pg_temp.res('18 no wildcard match (LIKE characters are plain text)',
    pg_temp.look('%@si.test') = '{"found": false}'::jsonb and pg_temp.look('open.person@si.tes_') = '{"found": false}'::jsonb);
  perform pg_temp.res('19 a lookup writes nothing', pg_temp.fp() = f0);
  -- the sample master studio never answers
  update public.organizations set is_sample_master = true where id = a;
  perform pg_temp.res('20 an invitation of the sample master studio is never offered', pg_temp.look('open.person@si.test') = '{"found": false}'::jsonb);
  update public.organizations set is_sample_master = false where id = a;
  -- callers
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.invite_open_for_email('open.person@si.test')$q$);
  perform pg_temp.res('21 anon is refused', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.newuser('si_member@si.test', 'planner');
  update public.profiles set org_id = a where email = 'si_member@si.test';
  perform pg_temp.login('si_member@si.test');
  e := pg_temp.try($q$select public.invite_open_for_email('open.person@si.test')$q$);
  perform pg_temp.res('22 a signed-in studio member is refused', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _si values ('1x lookup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3x: trial welcome with City + State + Country --------------------------------------------------------------
do $$ declare r jsonb; o uuid; e text; g jsonb; f0 text; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  r := pg_temp.trial('si_owner@si.test'); o := (r ->> 'org_id')::uuid; perform pg_temp.put('T', o::text);
  perform pg_temp.res('30 trial started', r ->> 'result' = 'started' and o is not null, left(r::text, 200));
  -- an existing billing key the welcome must keep
  update public.organizations set brand = coalesce(brand, '{}'::jsonb) || jsonb_build_object('billing',
    coalesce(brand -> 'billing', '{}'::jsonb) || '{"legal_name":"Keep Me Pvt Ltd","pin":"500001"}'::jsonb) where id = o;
  perform pg_temp.login('si_owner@si.test');
  f0 := (select md5(to_jsonb(x)::text) from public.organizations x where x.id = o);
  e := pg_temp.try($q$select public.trial_welcome_save('Aurora Events', 'Pune', 'Atlantis', null, 'IN')$q$);
  perform pg_temp.res('31 a state not in the Indian list is refused', e like '22023%', e);
  e := pg_temp.try($q$select public.trial_welcome_save('Aurora Events', 'Dubai', 'Maharashtra', null, 'AE')$q$);
  perform pg_temp.res('32 another country is refused (the free trial is India only)', e like '22023%', e);
  e := pg_temp.try($q$select public.trial_welcome_save('Aurora Events', '  ', 'Maharashtra', null, 'IN')$q$);
  perform pg_temp.res('33 an empty city is refused', e like '22023%', e);
  e := pg_temp.try($q$select public.trial_welcome_save('Aurora Events', 'Pune', '', null, 'IN')$q$);
  perform pg_temp.res('34 an empty state is refused', e like '22023%', e);
  e := pg_temp.try($q$select public.trial_welcome_save('A', 'Pune', 'Maharashtra', null, 'IN')$q$);
  perform pg_temp.res('35 a too-short studio name is refused (0167 rule)', e like '22023%', e);
  e := pg_temp.try($q$select public.trial_welcome_save('Aurora Events', 'Pune', 'Maharashtra', 'call me', 'IN')$q$);
  perform pg_temp.res('36 a bad phone is refused (0167 rule)', e like '22023%', e);
  perform pg_temp.su();
  perform pg_temp.res('37 refusals changed nothing', (select md5(to_jsonb(x)::text) from public.organizations x where x.id = o) = f0);
  perform pg_temp.login('si_owner@si.test');
  r := public.trial_welcome_save('Aurora Events', ' Pune ', 'maharashtra', null);
  perform pg_temp.res('38 saved: the list spelling of the state, country IN', r ->> 'result' = 'ok' and r ->> 'state' = 'Maharashtra'
    and r ->> 'country' = 'IN' and r ->> 'city' = 'Pune' and r ->> 'name' = 'Aurora Events', r::text);
  perform pg_temp.su();
  g := pg_temp.org(o);
  perform pg_temp.res('39 studio: name + city (location) saved', g ->> 'name' = 'Aurora Events' and g ->> 'location' = 'Pune', g ->> 'name');
  perform pg_temp.res('40 brand.billing: city / state / country merged, the other keys kept',
    g -> 'brand' -> 'billing' ->> 'city' = 'Pune' and g -> 'brand' -> 'billing' ->> 'state' = 'Maharashtra'
    and g -> 'brand' -> 'billing' ->> 'country' = 'IN' and g -> 'brand' -> 'billing' ->> 'legal_name' = 'Keep Me Pvt Ltd'
    and g -> 'brand' -> 'billing' ->> 'pin' = '500001', (g -> 'brand' -> 'billing')::text);
  perform pg_temp.res('41 the 0089 mirror: organizations.country = IN, tax_region = the state',
    g ->> 'country' = 'IN' and g ->> 'tax_region' = 'Maharashtra', concat_ws(' / ', g ->> 'country', g ->> 'tax_region'));
  perform pg_temp.res('42 phone left empty: no phone written', coalesce(g -> 'brand' ->> 'phone', '') = '', g -> 'brand' ->> 'phone');
  perform pg_temp.res('43 one audit row for the welcome step',
    (select count(*) from public.audit_log where entity_id = o::text and action = 'trial.welcome_named') = 1);
  perform pg_temp.login('si_owner@si.test');
  r := public.trial_welcome_save('Aurora Events', 'Nagpur', 'Maharashtra', '+91 98765 43210', 'India');
  perform pg_temp.su();
  g := pg_temp.org(o);
  perform pg_temp.res('44 saving again updates city + phone, still one billing object',
    g ->> 'location' = 'Nagpur' and g -> 'brand' -> 'billing' ->> 'city' = 'Nagpur' and g -> 'brand' ->> 'phone' = '+91 98765 43210'
    and jsonb_typeof(g -> 'brand' -> 'billing') = 'object' and g -> 'brand' -> 'billing' ->> 'legal_name' = 'Keep Me Pvt Ltd', (g -> 'brand')::text);
  -- the old 3-argument step still works for a cached page (no state)
  perform pg_temp.login('si_owner@si.test');
  r := public.trial_welcome_setup('Aurora Events Two', 'Pune', null);
  perform pg_temp.su();
  perform pg_temp.res('45 old 3-argument step still saves (state kept)', r ->> 'result' = 'ok'
    and pg_temp.org(o) ->> 'name' = 'Aurora Events Two' and pg_temp.org(o) -> 'brand' -> 'billing' ->> 'state' = 'Maharashtra', r::text);
exception when others then perform pg_temp.su(); insert into _si values ('3x welcome', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5x: who may save --------------------------------------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('T')::uuid; p uuid; e text; f0 text; begin
  perform pg_temp.su();
  -- a teammate (not admin) of the trial studio
  perform pg_temp.newuser('si_coord@si.test', 'coordinator');
  update public.profiles set org_id = o where email = 'si_coord@si.test';
  f0 := (select md5(to_jsonb(x)::text) from public.organizations x where x.id = o);
  perform pg_temp.login('si_coord@si.test');
  e := pg_temp.try($q$select public.trial_welcome_save('Hijack', 'Pune', 'Goa', null, 'IN')$q$);
  perform pg_temp.res('50 a teammate (not admin) is refused', e like '42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('51 ... and nothing changed', (select md5(to_jsonb(x)::text) from public.organizations x where x.id = o) = f0);
  -- a paid studio admin
  perform pg_temp.newuser('si_paid@si.test');
  perform pg_temp.login('si_paid@si.test');
  p := public.create_studio('SI Paid Studio', null, 'INR', 'Asia/Kolkata');
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values (p, 'active') on conflict (org_id) do update set status = 'active';
  perform pg_temp.login('si_paid@si.test');
  e := pg_temp.try($q$select public.trial_welcome_save('SI Paid Renamed', 'Pune', 'Goa', null, 'IN')$q$);
  perform pg_temp.res('52 a paid studio cannot use the trial welcome step', e like '22023%', e);
  perform pg_temp.su();
  perform pg_temp.res('53 ... and the paid studio is unchanged', pg_temp.org(p) ->> 'name' = 'SI Paid Studio'
    and coalesce(pg_temp.org(p) -> 'brand' -> 'billing' ->> 'state', '') <> 'Goa');
  -- signed out
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.trial_welcome_save('Anon', 'Pune', 'Goa', null, 'IN')$q$);
  perform pg_temp.res('54 anon is refused', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _si values ('5x callers', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- report ----------------------------------------------------------------------------------------------------
select name, result from _si order by name;
select case when count(*) filter (where result <> 'PASS') = 0
            then 'SIGNUP-INVITE-0210: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'SIGNUP-INVITE-0210: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _si;
rollback;
