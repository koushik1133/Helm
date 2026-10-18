-- trial-seed-0174.sql -- 0174: with the switch on every trial seed (signup, Load / Reset demo data, AE) uses the current manifest;
-- an old-seed trial is not cloned on top; Clear -> Load re-clones. Rolled back. Local disposable PG only.
-- Rolled back. Local disposable PG only.
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
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.newuser(p_email text) returns uuid language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  return u;
end $$;
create or replace function pg_temp.trial(p_email text, p_tz text default 'Asia/Kolkata', p_cur text default 'INR') returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, p_tz, p_cur, 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;


-- 0236: the app wrappers refuse Clear / Reset sample data while the studio is on its free trial; this suite
-- tests what the clear / reset itself does, so it calls the kept bodies (<name>__pre0236) as the studio admin
do $$ declare f text; begin
  foreach f in array array['public.clear_sample_data__pre0236()', 'public.reset_demo_data__pre0236()', 'public.clear_demo_data__pre0236()'] loop
    if to_regprocedure(f) is not null then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;
do $$ declare a uuid; b uuid; c uuid; r jsonb; mv int; begin
  perform pg_temp.su();
  select version into mv from public.helm_trial_seed_manifest where is_current;
  perform pg_temp.res('01 functions carry 0174 marker (0166/0167 markers kept)',
    position('trial-seed-0174' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0
    and position('trial-sandbox-0166' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0
    and position('trial-sample-0167' in (select prosrc from pg_proc where oid = 'public._demo_seed(uuid)'::regprocedure)) > 0
    and position('trial-seed-0174' in (select prosrc from pg_proc where oid = 'public._demo_seed_for(uuid)'::regprocedure)) > 0);

  -- switch OFF: a trial gets the old built-in seed (unchanged behaviour)
  update public.helm_sample_template set active = false where id;
  b := pg_temp.trial('ts174_old@t.test');
  perform pg_temp.res('02 switch off: old seed, not cloned', (select sample_cloned_at from public.organizations where id = b) is null
    and exists (select 1 from public.venues where org_id = b and is_demo and name = E'Demo \u00b7 Banjara Lawns'));

  -- switch ON
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('ts174_new@t.test');
  perform pg_temp.res('03 new trial: current manifest cloned, no old venues',
    (select sample_version from public.organizations where id = a) = mv
    and (select sample_cloned_at from public.organizations where id = a) is not null
    and not exists (select 1 from public.venues where org_id = a and name in (E'Demo \u00b7 Banjara Lawns', E'Demo \u00b7 Sitara Convention Hall'))
    and (select count(*) from public.venues where org_id = a and is_demo and active) = 4);

  -- old-seed trial: Load demo data does not pile the manifest on top
  perform pg_temp.login('ts174_old@t.test');
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('04 old-seed trial: load refuses to mix', r ->> 'reason' = 'old_sample_present'
    and (select sample_cloned_at from public.organizations where id = b) is null, r::text);
  -- Clear -> Load: current manifest; old venues switched off, never deleted
  perform pg_temp.login('ts174_old@t.test');
  perform public.clear_sample_data__pre0236();
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('05 clear -> load re-clones current manifest', coalesce((r ->> 'cloned')::boolean, false)
    and (select sample_version from public.organizations where id = b) = mv
    and not exists (select 1 from public.venues where org_id = b and active and name in (E'Demo \u00b7 Banjara Lawns', E'Demo \u00b7 Sitara Convention Hall'))
    and exists (select 1 from public.venues where org_id = b and not active and name = E'Demo \u00b7 Banjara Lawns')
    and (select count(*) from public.venues where org_id = b and is_demo and active) = 4, r::text);
  -- Reset demo data on a cloned trial: clear + clone again, still current manifest
  perform pg_temp.login('ts174_old@t.test');
  r := public.reset_demo_data__pre0236();
  perform pg_temp.su();
  perform pg_temp.res('06 reset re-clones current manifest', coalesce((r #>> '{seeded,cloned}')::boolean, false)
    and (select count(*) from public.venues where org_id = b and is_demo and active) = 4, r::text);

  -- AE trial: Load demo data uses the manifest, not the Dubai seed
  c := pg_temp.trial('ts174_ae@t.test', 'Asia/Dubai', 'AED');
  update public.organizations set country = 'AE' where id = c;
  perform pg_temp.login('ts174_ae@t.test');
  perform public.clear_sample_data__pre0236();
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('07 AE trial load -> manifest', coalesce((r ->> 'cloned')::boolean, false), r::text);

  -- switch on but no current manifest: no old seed, reason logged
  update public.helm_trial_seed_manifest set is_current = false where is_current;
  perform pg_temp.res('08 ready() false without manifest -> old path only via switch', not public._sample_template_ready());
  update public.helm_trial_seed_manifest set is_current = true where version = mv;
  -- privileges
  perform pg_temp.login('ts174_new@t.test');
  perform pg_temp.res('09 app cannot call _demo_seed / _demo_seed_for',
    pg_temp.try('select public._demo_seed(''' || a || ''')') like '42501%' and pg_temp.try('select public._demo_seed_for(''' || a || ''')') like '42501%');
  perform pg_temp.su();
  -- paid studio: untouched (old seed path)
  perform pg_temp.res('10 non-trial studio still uses old path', position('_demo_seed_ae' in (select prosrc from pg_proc where oid = 'public._demo_seed_for(uuid)'::regprocedure)) > 0);
  -- I-12: trial = studio_subscriptions.status 'trial' (_is_trial_org), never organizations.trial_ends_at
  update public.studio_subscriptions set status = 'active' where org_id = c;
  update public.organizations set trial_ends_at = coalesce(trial_ends_at, now() + interval '5 days') where id = c;
  perform pg_temp.login('ts174_ae@t.test');
  perform public.clear_sample_data();
  r := public.seed_demo_data();
  perform pg_temp.su();
  perform pg_temp.res('11 paid studio with a stale trial_ends_at: not cloned from the manifest',
    not coalesce((r ->> 'cloned')::boolean, false) and not public._is_trial_org(c), coalesce(r::text, 'null'));
  update public.organizations set trial_ends_at = null where id = a;
  perform public._demo_clear(a);
  r := public._demo_seed(a);
  perform pg_temp.res('12 trial (status trial) with trial_ends_at null still gets the manifest',
    coalesce((r ->> 'cloned')::boolean, false) and (select sample_version from public.organizations where id = a) = mv, coalesce(r::text, 'null'));
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-SEED-0174: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-SEED-0174: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
