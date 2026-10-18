-- trial-clone-0190.sql -- 0190: a brand-new free trial, signed up through the REAL RPC
-- (start_self_serve_trial, as the authenticated app role, under Supabase's 8 s statement_timeout),
-- gets the full current sample (4 venues, 165 inventory, 16 vendors, 12 staff, 16 leads, 7 events,
-- 6 packages, 145 dishes, 3 layout templates) - also when create_studio() already copied the Helm
-- library dishes / packages (prod), also on the Google path; 'own' stays empty; the faster clone
-- leaks no master id. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
-- a fresh sign-up exactly like GoTrue + login.html: auth.users row (the 0021 trigger makes the profile)
create or replace function pg_temp.newuser(p_email text, p_provider text default 'email') returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su();
  u := auth.seed_user(p_email);
  if p_provider <> 'email' then
    update auth.users set raw_app_meta_data = jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider)) where id = u;
    update auth.identities set provider = p_provider where user_id = u;
  end if;
  return u;
end $$;
-- the app's call, as the signed-in user; returns the RPC result + its duration
create or replace function pg_temp.signup(p_email text, p_name text, p_mode text, p_provider text default 'email') returns jsonb language plpgsql as $$
declare r jsonb; t0 timestamptz; begin
  perform pg_temp.newuser(p_email, p_provider); perform pg_temp.login(p_email);
  t0 := clock_timestamp();
  r := public.start_self_serve_trial(p_name, 'Asia/Kolkata', 'INR', p_mode);
  r := r || jsonb_build_object('_ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
  perform pg_temp.su();
  perform pg_temp.put(p_email, r::text);
  return r;
end $$;
-- counts the trial user SEES (RLS, as the app role)
create or replace function pg_temp.seen(p_email text) returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email);
  select jsonb_build_object('venues', (select count(*) from public.venues), 'inventory', (select count(*) from public.inventory_items),
    'vendors', (select count(*) from public.vendors), 'staff', (select count(*) from public.crew_members),
    'leads', (select count(*) from public.leads), 'events', (select count(*) from public.quotes),
    'packages', (select count(*) from public.menu_templates), 'dishes', (select count(*) from public.dish_catalog),
    'layouts', (select count(*) from public.studio_layout_templates where not archived)) into j;
  perform pg_temp.su();
  return j;
end $$;
create or replace function pg_temp.full_v(j jsonb) returns boolean language sql as $$
  select (j ->> 'venues')::int = 4 and (j ->> 'inventory')::int = 165 and (j ->> 'vendors')::int = 16 and (j ->> 'staff')::int = 12
     and (j ->> 'leads')::int = 16 and (j ->> 'events')::int = 7 and (j ->> 'packages')::int = 6 and (j ->> 'dishes')::int >= 145
     and (j ->> 'layouts')::int = 3 $$;
-- every uuid in a studio's cloned rows; none may be a master / manifest id
create or replace function pg_temp.leaks(p_org uuid) returns integer language plpgsql as $$
declare t text; n integer := 0; c integer; begin
  foreach t in array public._sample_clone_tables() loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format($q$ select count(*) from public.%I x,
        regexp_matches(to_jsonb(x)::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'g') u(v)
       where x.org_id = $1 and (u.v[1] = 'a5a5a5a5-0166-4000-8000-000000000001'
         or exists (select 1 from public.helm_trial_seed_manifest m, jsonb_array_elements(coalesce(m.payload #> array['tables', %L], '[]'::jsonb)) e(j)
                     where m.is_current and e.j ->> 'id' = u.v[1])) $q$, t, t) into c using p_org;
    n := n + c;
  end loop;
  return n;
end $$;

do $$ begin perform pg_temp.su(); end $$;
update public.helm_sample_template set active = true where id;
-- Supabase API limit for the app role: every sign-up below runs as ONE statement under it
set local statement_timeout = '8s';

-- ---- 0x: what is installed --------------------------------------------------------------------
do $$ begin
  perform pg_temp.res('01 0190 clone + trial start installed',
    position('trial-clone-0190' in (select prosrc from pg_proc where oid = 'public._sample_clone_into__pre0168(uuid)'::regprocedure)) > 0
    and position('trial-clone-0190' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) > 0
    and position('pg_timezone_names' in (select prosrc from pg_proc where oid = 'public.start_self_serve_trial(text,text,text,text)'::regprocedure)) = 0);
  perform pg_temp.res('02 app roles cannot run the clone / tz helper; can start a trial',
    not has_function_privilege('authenticated', 'public._sample_clone_into__pre0168(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._sample_clone_into__pre0168(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._sample_clone_into(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tz_name_ok(text)', 'execute')
    and has_function_privilege('authenticated', 'public.start_self_serve_trial(text,text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.start_self_serve_trial(text,text,text,text)', 'execute'));
  perform pg_temp.res('03 time zone names: IANA yes, offsets / unknown no',
    public._tz_name_ok('Asia/Kolkata') and public._tz_name_ok('America/Argentina/Buenos_Aires') and public._tz_name_ok('UTC')
    and public._tz_name_ok('Etc/GMT+5') and public._tz_name_ok('Europe/London')
    and not public._tz_name_ok('+05:30') and not public._tz_name_ok('UTC+5') and not public._tz_name_ok('Mars/Olympus')
    and not public._tz_name_ok('') and not public._tz_name_ok(null) and not public._tz_name_ok('Asia/Kolkata; select 1'));
  perform pg_temp.res('04 switch on + a current manifest', public._sample_template_ready());
exception when others then perform pg_temp.su(); insert into _uf values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1x: brand-new demo trial (no Helm library studio, like CI) --------------------------------
do $$ begin perform pg_temp.signup('tc90_demo@t.test', 'Aurora Events', 'demo');
exception when others then perform pg_temp.su(); insert into _uf values ('signup ' || 'tc90_demo@t.test', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare r jsonb := pg_temp.get('tc90_demo@t.test')::jsonb; a uuid; j jsonb; begin
  a := (r ->> 'org_id')::uuid;
  perform pg_temp.res('10 sign-up started + cloned from the current manifest', r ->> 'result' = 'started'
    and (r #>> '{seed,cloned}')::boolean and (r #>> '{seed,version}')::int = (select version from public.helm_trial_seed_manifest where is_current)
    and r #> '{seed,error}' is null, r::text);
  perform pg_temp.res('11 sign-up well inside the 8 s API limit (< 4 s here)', (r ->> '_ms')::int < 4000, r ->> '_ms');
  j := pg_temp.seen('tc90_demo@t.test');
  perform pg_temp.res('12 the trial user sees the full sample (4/165/16/12/16/7/6/145/3)', pg_temp.full_v(j) and (j ->> 'dishes')::int = 145, j::text);
  perform pg_temp.res('13 main lists all is_demo', not exists (select 1 from public.inventory_items where org_id = a and not is_demo)
    and not exists (select 1 from public.venues where org_id = a and not is_demo) and not exists (select 1 from public.leads where org_id = a and not is_demo)
    and not exists (select 1 from public.quotes where org_id = a and not is_demo) and not exists (select 1 from public.crew_members where org_id = a and not is_demo)
    and not exists (select 1 from public.vendors where org_id = a and not is_demo));
  perform pg_temp.res('14 packages at the published prices', (select string_agg(tier || '/' || diet || '=' || price_per_plate::int, ',' order by tier, diet)
      from public.menu_templates where org_id = a)
    = (select string_agg((e.j ->> 'tier') || '/' || (e.j ->> 'diet') || '=' || (e.j ->> 'price_per_plate')::numeric::int, ',' order by e.j ->> 'tier', e.j ->> 'diet')
         from public.helm_trial_seed_manifest m, jsonb_array_elements(m.payload #> '{tables,menu_templates}') e(j) where m.is_current),
    (select string_agg(tier || '/' || diet || '=' || price_per_plate, ',') from public.menu_templates where org_id = a));
  perform pg_temp.res('15 owner package prices 450/700/1000/650/950/1400', (select string_agg(price_per_plate::int::text, '/' order by diet desc, price_per_plate)
      from public.menu_templates where org_id = a) = '450/700/1000/650/950/1400');
  perform pg_temp.res('16 no master / manifest id in any cloned row', pg_temp.leaks(a) = 0, pg_temp.leaks(a)::text);
  perform pg_temp.res('17 contacts stay dummy', not exists (select 1 from public.leads where org_id = a
      and (email not like '%@example.com' or right(regexp_replace(phone, '\D', '', 'g'), 10) not like '00000%')));
  perform pg_temp.res('18 subscription is trial, studio flagged cloned', exists (select 1 from public.studio_subscriptions where org_id = a and status = 'trial')
    and exists (select 1 from public.organizations where id = a and sample_cloned_at is not null and trial_mode = 'demo'));
  perform pg_temp.res('19 audit has the clone with counts', exists (select 1 from public.audit_log where org_id = a and action = 'trial.sample_cloned'
    and (changed #>> '{counts,inventory_items}')::int = 165 and changed ? 'kept_existing'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x demo', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- welcome step 1 on top (rename) keeps every row
do $$ declare r jsonb; j jsonb; begin
  perform pg_temp.login('tc90_demo@t.test');
  r := public.trial_welcome_setup('Aurora Weddings', 'Hyderabad', null);
  perform pg_temp.su();
  j := pg_temp.seen('tc90_demo@t.test');
  perform pg_temp.res('20 trial_welcome_setup ok, sample unchanged', r ->> 'result' = 'ok' and pg_temp.full_v(j), coalesce(r::text, '') || ' ' || j::text);
exception when others then perform pg_temp.su(); insert into _uf values ('20 welcome', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2x: Google sign-up, no studio name ("Demo N") -----------------------------------------------
do $$ begin perform pg_temp.signup('tc90_google@t.test', null, 'demo', 'google');
exception when others then perform pg_temp.su(); insert into _uf values ('signup ' || 'tc90_google@t.test', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare r jsonb := pg_temp.get('tc90_google@t.test')::jsonb; j jsonb; begin
  j := pg_temp.seen('tc90_google@t.test');
  perform pg_temp.res('21 Google path: Demo N studio with the full sample', r ->> 'result' = 'started' and r ->> 'name' like 'Demo %'
    and (r #>> '{seed,cloned}')::boolean and pg_temp.full_v(j), r::text || ' ' || j::text);
  perform pg_temp.res('22 two trials share no row', pg_temp.leaks((r ->> 'org_id')::uuid) = 0
    and not exists (select 1 from public.inventory_items a join public.inventory_items b on a.id = b.id and a.org_id <> b.org_id));
exception when others then perform pg_temp.su(); insert into _uf values ('2x google', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3x: 'own data' stays empty (by design); "Load demo data" later clones the same sample --------
do $$ begin perform pg_temp.signup('tc90_own@t.test', 'ABCD', 'own');
exception when others then perform pg_temp.su(); insert into _uf values ('signup ' || 'tc90_own@t.test', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare r jsonb := pg_temp.get('tc90_own@t.test')::jsonb; j jsonb; s jsonb; begin
  j := pg_temp.seen('tc90_own@t.test');
  perform pg_temp.res('30 own: started, nothing seeded', r ->> 'result' = 'started' and r -> 'seed' = 'null'::jsonb
    and (j ->> 'inventory')::int = 0 and (j ->> 'leads')::int = 0 and (j ->> 'events')::int = 0, r::text || ' ' || j::text);
  perform pg_temp.login('tc90_own@t.test');
  s := public.seed_demo_data();
  perform pg_temp.su();
  j := pg_temp.seen('tc90_own@t.test');
  perform pg_temp.res('31 own -> Load demo data: full sample', (s ->> 'cloned')::boolean and pg_temp.full_v(j), coalesce(s::text, '') || ' ' || j::text);
exception when others then perform pg_temp.su(); insert into _uf values ('3x own', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4x: prod shape - create_studio() copies the Helm library studio's dishes + packages ---------
do $$ declare L uuid := '00000000-0000-4000-8000-000000000001'; M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; begin
  perform pg_temp.su();
  insert into public.organizations(id, name, slug) values (L, 'Helm', 'helm-library-tc90') on conflict (id) do nothing;
  insert into public.dish_catalog(org_id, category, name, kind, active)
    select L, category, name, kind, true from public.dish_catalog where org_id = M on conflict do nothing;
  insert into public.dish_catalog(org_id, category, name, kind, active) values (L, 'Library', 'Library only dish', 'veg', true) on conflict do nothing;
  insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, seq, dishes)
    select L, tier, diet, name, price_per_plate, seq, dishes from public.menu_templates where org_id = M on conflict do nothing;
exception when others then perform pg_temp.su(); insert into _uf values ('40 library setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ begin perform pg_temp.signup('tc90_lib@t.test', 'Uma Studio', 'demo');
exception when others then perform pg_temp.su(); insert into _uf values ('signup ' || 'tc90_lib@t.test', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare r jsonb := pg_temp.get('tc90_lib@t.test')::jsonb; a uuid; j jsonb; begin
  a := (r ->> 'org_id')::uuid;
  j := pg_temp.seen('tc90_lib@t.test');
  perform pg_temp.res('41 library studio present: clone still complete', (r #>> '{seed,cloned}')::boolean and pg_temp.full_v(j), r::text || ' ' || j::text);
  perform pg_temp.res('42 library dishes/packages reported as kept, not missing', (r #>> '{seed,kept_existing,dish_catalog}')::int = 145
    and (r #>> '{seed,kept_existing,menu_templates}')::int = 6 and (r #>> '{seed,counts,inventory_items}')::int = 165, r -> 'seed' ->> 'kept_existing');
  perform pg_temp.res('43 every published dish present + packages at published prices',
    not exists (select 1 from public.helm_trial_seed_manifest m, jsonb_array_elements(m.payload #> '{tables,dish_catalog}') e(j)
                 where m.is_current and not exists (select 1 from public.dish_catalog d where d.org_id = a and d.name = e.j ->> 'name'))
    and (select string_agg(price_per_plate::int::text, '/' order by diet desc, price_per_plate) from public.menu_templates where org_id = a) = '450/700/1000/650/950/1400');
  perform pg_temp.res('44 inside the 8 s limit', (r ->> '_ms')::int < 4000, r ->> '_ms');
exception when others then perform pg_temp.su(); insert into _uf values ('4x library', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5x: odd visitor time zones never fail the sign-up ---------------------------------------------
do $$ declare r jsonb; begin
  perform pg_temp.newuser('tc90_tz@t.test'); perform pg_temp.login('tc90_tz@t.test');
  r := public.start_self_serve_trial('Offset Studio', '+05:30', 'INR', 'own');
  perform pg_temp.su();
  perform pg_temp.res('50 offset time zone -> started (falls back)', r ->> 'result' = 'started'
    and (select timezone from public.organizations where id = (r ->> 'org_id')::uuid) in ('UTC', 'Asia/Kolkata'), r::text);
exception when others then perform pg_temp.su(); insert into _uf values ('50 tz', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

reset statement_timeout;
select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-CLONE-0190: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-CLONE-0190: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
