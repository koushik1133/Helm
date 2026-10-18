-- trial-lockdown-0173.sql -- 0173: free-trial lockdown. Trial studio: 20-row cap, no new catalog rows (prices editable),
-- studio settings / export / import / render refused, 3rd invite refused. Paid studio: unchanged.
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


-- earlier suites in run-all re-apply older migrations over the wrappers: re-run 0173 (also proves a re-run is safe)
\ir ../../supabase/migrations/0173_trial_lockdown.sql

do $$ declare o uuid; e text; A uuid := 'a0000000-0000-4000-8000-000000000001'; mt uuid; begin
  o := pg_temp.trial('tl_trial@t.test'); perform pg_temp.put('o', o::text);
  perform pg_temp.res('01 trial studio is trial', public._is_trial_org(o));
  perform pg_temp.res('02 paid fixture studio is not trial', not public._is_trial_org(A));
  -- creation cap
  perform pg_temp.login('tl_trial@t.test');
  e := '';
  for i in 1..20 loop
    e := e || pg_temp.try(format('insert into public.vendors(name) values (%L)', 'TL vendor ' || i));
  end loop;
  perform pg_temp.res('10 trial: 20 own vendors OK', e = '', e);
  e := pg_temp.try('insert into public.vendors(name) values (''TL vendor 21'')');
  perform pg_temp.res('11 trial: 21st vendor refused (trial_cap)', e like '42501%Free trial limit reached (20)%', e);
  e := '';
  for i in 1..20 loop e := e || pg_temp.try(format('insert into public.leads(name) values (%L)', 'TL lead ' || i)); end loop;
  perform pg_temp.res('12 trial: 20 own leads OK', e = '', e);
  e := pg_temp.try('insert into public.leads(name) values (''TL lead 21'')');
  perform pg_temp.res('13 trial: 21st lead refused', e like '42501%Free trial limit%', e);
  perform pg_temp.res('14 my_trial_limits reports the cap', (public.my_trial_limits() -> 'used' ->> 'vendors')::int = 20
    and (public.my_trial_limits() ->> 'cap')::int = 20);
  -- catalog: no new rows, prices editable
  e := pg_temp.try('insert into public.dish_catalog(category, name) values (''Starters'', ''TL dish'')');
  perform pg_temp.res('20 trial: new dish refused', e like '42501%not add new menu%', e);
  e := pg_temp.try('insert into public.menu_templates(tier, diet, name) values (''gold'', ''veg'', ''TL pkg'')');
  perform pg_temp.res('21 trial: new menu package refused', e like '42501%', e);
  e := pg_temp.try('insert into public.chair_types(name, price) values (''TL chair'', 10)');
  perform pg_temp.res('22 trial: new chair type refused', e like '42501%', e);
  perform pg_temp.su();
  select id into mt from public.menu_templates where org_id = o order by seq limit 1;
  perform pg_temp.put('mt', mt::text);
  perform pg_temp.login('tl_trial@t.test');
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 777 where id = %L', mt));
  perform pg_temp.su();
  perform pg_temp.res('23 trial: package price edit allowed', e = '' and (select price_per_plate from public.menu_templates where id = mt) = 777, e);
  -- studio settings / downloads / import / render
  perform pg_temp.login('tl_trial@t.test');
  e := pg_temp.try(format('update public.organizations set name = ''Renamed'' where id = %L', o));
  perform pg_temp.res('30 trial: studio / branding edit refused', e like '42501%Studio settings are fixed%', e);
  e := pg_temp.try('select public.export_org_data()');
  perform pg_temp.res('31 trial: data export refused', e like '42501%Not available in the free trial%', e);
  e := pg_temp.try('select public.export_tenant_organization_package()');
  perform pg_temp.res('32 trial: data archive refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.set_studio_link_name(''tl-link'')');
  perform pg_temp.res('33 trial: client link name refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.admin_set_link_autoexpire(true, 30)');
  perform pg_temp.res('34 trial: auto-expire refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.admin_reset_notification_prefs()');
  perform pg_temp.res('35 trial: notification rules refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.photo_render_settings_set(true, 10, 5)');
  perform pg_temp.res('36 trial: photo render settings refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.photo_render_begin(gen_random_uuid(), 1, ''low'', ''1024x1024'', ''m'', 0)');
  perform pg_temp.res('37 trial: photo render refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.smart_import_batch(''vendors'', ''[]''::jsonb, ''{}''::jsonb)');
  perform pg_temp.res('38 trial: smart import refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.my_studio_account_update(''{}''::jsonb)');
  perform pg_temp.res('39 trial: studio account refused', e like '42501%free trial%', e);
  -- seats: admin + 2 (pending invites count), 3rd refused
  e := pg_temp.try('select public.create_invitation(''tl_s1@t.test'', ''sales'')') || pg_temp.try('select public.create_invitation(''tl_s2@t.test'', ''manager'')');
  perform pg_temp.res('40 trial: 2 invites OK', e = '', e);
  e := pg_temp.try('select public.create_invitation(''tl_s3@t.test'', ''sales'')');
  perform pg_temp.res('41 trial: 3rd invite refused', e like '42501%', e);
  perform pg_temp.su();
  -- system work is exempt (no API claims; the suite runner pins helm.maintenance=off, so switch it on here)
  perform set_config('helm.maintenance', 'on', true);
  e := pg_temp.try(format('insert into public.vendors(org_id, name) values (%L, ''TL sys vendor'')', o));
  perform set_config('helm.maintenance', 'off', true);
  perform pg_temp.res('42 system insert past the cap still works', e = '', e);
exception when others then perform pg_temp.su(); insert into _uf values ('1x trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid studio: unchanged -------------------------------------------------------------------------
do $$ declare e text; A uuid := 'a0000000-0000-4000-8000-000000000001'; n0 int; begin
  perform pg_temp.su(); select count(*) into n0 from public.vendors where org_id = A;
  perform pg_temp.login('a_admin@a.test');
  e := '';
  for i in 1..25 loop e := e || pg_temp.try(format('insert into public.vendors(name) values (%L)', 'PAID vendor ' || i)); end loop;
  perform pg_temp.su();
  perform pg_temp.res('50 paid: 25 vendors OK (no cap)', e = '' and (select count(*) from public.vendors where org_id = A) = n0 + 25, e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('insert into public.dish_catalog(category, name) values (''Starters'', ''PAID dish'')');
  perform pg_temp.res('51 paid: new dish OK', e = '', e);
  e := pg_temp.try('insert into public.chair_types(name, price) values (''PAID chair'', 10)');
  perform pg_temp.res('52 paid: new chair type OK', e = '', e);
  e := pg_temp.try(format('update public.organizations set location = ''Paid City'' where id = %L', A));
  perform pg_temp.res('53 paid: studio edit OK', e = '', e);
  e := pg_temp.try('select public.export_org_data()');
  perform pg_temp.res('54 paid: export not trial-locked', e not like '%free trial%', e);
  e := pg_temp.try('select public.admin_set_link_autoexpire(true, 30)');
  perform pg_temp.res('55 paid: auto-expire not trial-locked', e not like '%free trial%', e);
  perform pg_temp.res('56 paid: my_trial_limits says not trial', public.my_trial_limits() ->> 'trial' = 'false');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('5x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- shape ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('60 originals kept, not callable by the app', to_regprocedure('public.export_org_data__pre0173()') is not null
    and not has_function_privilege('authenticated', 'public.export_org_data__pre0173()', 'execute')
    and not has_function_privilege('anon', 'public.export_org_data__pre0173()', 'execute'));
  perform pg_temp.res('61 wrappers keep the original grants', has_function_privilege('authenticated', 'public.export_org_data()', 'execute')
    and not has_function_privilege('anon', 'public.export_org_data()', 'execute'));
  perform pg_temp.res('62 cap trigger on 6 tables', (select count(*) from pg_trigger where tgname = 'zzzz_tl173_cap') = 6);
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-LOCKDOWN-0173: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-LOCKDOWN-0173: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
