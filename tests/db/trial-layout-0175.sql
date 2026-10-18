-- trial-layout-0175.sql -- 0175: trial studios + sample master get exactly the owner's 3 layout templates (theatre archived,
-- reception added once), manifest v6 published once, paid studios untouched. Rolled back. Local disposable PG only.
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


do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; a uuid; b uuid; p uuid;
  CTH constant text := E'Demo · Corporate — Theatre/conference';
  REC constant text := E'Demo · Reception — Lawn reception with sofa lounge (450 guests)';
begin
  perform pg_temp.su();
  perform pg_temp.res('01 master: 3 live owner templates, reception once, theatre archived (kept)',
    (select count(*) from public.studio_layout_templates where org_id = M and not archived) = 3
    and (select count(*) from public.studio_layout_templates where org_id = M and name = REC and not archived) = 1
    and exists (select 1 from public.studio_layout_templates where org_id = M and name = CTH and archived));
  perform pg_temp.res('02 manifest v6 published (current is v6 or a later one, e.g. 0182)', exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'v6: owner 3 layout templates'
    and (m.is_current or exists (select 1 from public.helm_trial_seed_manifest x where x.is_current and x.version > m.version))));

  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('tl175_a@t.test');
  perform pg_temp.res('03 new trial: 3 live templates incl. reception, theatre not live',
    (select count(*) from public.studio_layout_templates where org_id = a and not archived) = 3
    and exists (select 1 from public.studio_layout_templates where org_id = a and name = REC and not archived)
    and not exists (select 1 from public.studio_layout_templates where org_id = a and name = CTH and not archived),
    (select string_agg(name || ':' || archived, ', ') from public.studio_layout_templates where org_id = a));

  -- an older trial (pre-0175 set: theatre live, no reception) and a PAID studio with the same names
  update public.helm_sample_template set active = false where id;
  b := pg_temp.trial('tl175_b@t.test');
  p := pg_temp.trial('tl175_p@t.test');
  update public.studio_subscriptions set status = 'active' where org_id = p;
  update public.organizations set trial_ends_at = coalesce(trial_ends_at, now() + interval '3 days') where id = p;
  insert into public.studio_layout_templates(org_id, name, event_type, description, data)
    values (b, CTH, 'corporate', 'old', '{"items":[]}'::jsonb), (p, CTH, 'corporate', 'old', '{"items":[]}'::jsonb);
end $$;
\i supabase/migrations/0175_trial_layout_templates.sql
\i supabase/migrations/0175_trial_layout_templates.sql
do $$ declare b uuid; p uuid;
  CTH constant text := E'Demo · Corporate — Theatre/conference';
  REC constant text := E'Demo · Reception — Lawn reception with sofa lounge (450 guests)';
begin
  perform pg_temp.su();
  select org_id into b from public.profiles where email = 'tl175_b@t.test';
  select org_id into p from public.profiles where email = 'tl175_p@t.test';
  perform pg_temp.res('04 existing trial: theatre archived (row kept), reception added exactly once after 2 runs',
    exists (select 1 from public.studio_layout_templates where org_id = b and name = CTH and archived)
    and (select count(*) from public.studio_layout_templates where org_id = b and name = REC) = 1);
  perform pg_temp.res('05 paid studio (stale trial_ends_at) untouched',
    exists (select 1 from public.studio_layout_templates where org_id = p and name = CTH and not archived)
    and not exists (select 1 from public.studio_layout_templates where org_id = p and name = REC));
  perform pg_temp.res('06 re-run publishes no extra manifest',
    (select count(*) from public.helm_trial_seed_manifest where notes = 'v6: owner 3 layout templates') = 1);
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-LAYOUT-0175: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-LAYOUT-0175: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
