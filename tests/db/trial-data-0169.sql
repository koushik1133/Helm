-- trial-data-0169.sql -- 0169: the owner's wedding layout as a studio layout template + the sample
-- wedding's floor plan (DJ booth centred on the LED screen), GST 18 % intra-state, complete leads /
-- events / discovery, 3 coupons, run sheets on 3 events, sample T&C; manifest v3; a cloned trial gets
-- all of it, and "clear demo data" turns the coupons off and archives the template (never deletes).
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

do $$ declare M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; mf public.helm_trial_seed_manifest; L jsonb; s jsonb; dj jsonb; ax numeric; ay numeric; begin
  perform pg_temp.su();
  select * into mf from public.helm_trial_seed_manifest where version = 3;
  perform pg_temp.res('01 manifest v3 kept (v4 current after 0170), v2 kept', mf.version = 3 and mf.notes = 'v3: wedding layout template, coupons, T&C, GST, run sheets'
    and exists (select 1 from public.helm_trial_seed_manifest where version = 2 and not is_current));
  select data into L from public.studio_layout_templates where org_id = M and name = E'Demo \u00b7 Wedding \u2014 Grand Lawn (450+ guests)' and not archived;
  perform pg_temp.res('02 wedding layout template in the master (71 objects, wedding)', jsonb_array_length(L -> 'items') = 71
    and exists (select 1 from public.studio_layout_templates where org_id = M and event_type = 'wedding'));
  select e into s from jsonb_array_elements(L -> 'items') e where e ->> 'id' = 'obj_1cdzc';
  select e into dj from jsonb_array_elements(L -> 'items') e where e ->> 'id' = 'obj_1b1xh';
  -- the booth centre sits on the screen's centre normal (no sideways offset), just in front, same rotation
  ax := ((dj->>'x')::numeric + (dj->>'width')::numeric/2) - ((s->>'x')::numeric + (s->>'width')::numeric/2);
  ay := ((dj->>'y')::numeric + (dj->>'height')::numeric/2) - ((s->>'y')::numeric + (s->>'height')::numeric/2);
  perform pg_temp.res('03 DJ booth centred in front of the LED screen, same rotation', (dj->>'rotation') = (s->>'rotation')
    and abs(-ax * cos(radians((s->>'rotation')::float8)) - ay * sin(radians((s->>'rotation')::float8))) < 0.2
    and (ax * sin(radians((s->>'rotation')::float8)) - ay * cos(radians((s->>'rotation')::float8))) between 3.5 and 4.5, ax || ',' || ay);
  perform pg_temp.res('04 duplicate fence + extra carpet removed', not exists (select 1 from jsonb_array_elements(L -> 'items') e where e ->> 'id' in ('obj_1g2i6','obj_i4pk'))
    and (select count(*) from jsonb_array_elements(L -> 'items') e where e ->> 'type' = 'fence' and e ->> 'x' = '160') = 1);
  perform pg_temp.res('05 the sample wedding floor plan is the template', (select data from public.quote_versions where org_id = M
    and quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a1' and version_no = 1) = L
    and (select client ->> 'venue' from public.quotes where id = 'a5a5a5a5-0167-4000-8000-0000000000a1') = E'Demo \u00b7 Green Meadows Lawn');
  perform pg_temp.res('06 GST 18 on every sample event, open ones intra-state', not exists (select 1 from public.quotes where org_id = M and pricing ->> 'gstPct' <> '18')
    and (select count(*) from public.quotes where org_id = M and pricing ->> 'placeOfSupply' = 'intra') = 3);
  perform pg_temp.res('07 studio tax 18 % + T&C + payment terms kept', exists (select 1 from public.app_config where org_id = M and key = 'pricing'
    and (value ->> 'gstPct')::numeric = 18 and value ->> 'placeOfSupply' = 'intra' and value ->> 'termsText' like 'SAMPLE TERMS%'
    and value ->> 'termsText' like '%Force majeure%' and value ->> 'termsText' like '%30% advance%' and (value ->> 'advancePct')::numeric = 30));
  perform pg_temp.res('08 3 coupons', (select count(*) from public.coupons where org_id = M and active and code in ('DEMO-WELCOME10','DEMO-FLAT5000','DEMO-WEEKDAY15')) = 3
    and exists (select 1 from public.coupons where org_id = M and code = 'DEMO-FLAT5000' and kind = 'flat' and value = 5000));
  perform pg_temp.res('09 run sheets on wedding, engagement, corporate', (select count(distinct quote_id) from public.run_sheet_items where org_id = M) = 3);
  perform pg_temp.res('10 leads complete, events have source + discovery', not exists (select 1 from public.leads where org_id = M
      and (source is null or budget is null or guest_count is null or event_date is null or notes is null))
    and (select count(*) from public.quotes where org_id = M and client ? 'source' and client ? 'guests' and client ? 'budget') = 4
    and (select count(*) from public.event_discovery where org_id = M) = 3);
  perform pg_temp.res('11 ASCII-only fixes kept the design (stage, video wall, 2 seat blocks)', (select count(*) from jsonb_array_elements(L -> 'items') e
    where e ->> 'type' in ('stage','videowall','ledscreen','dj','seatblock')) = 6);
  perform pg_temp.res('12 corporate templates: round tables gala (45, podium centred, trusses aligned) + theatre (seat blocks, no tables)',
    exists (select 1 from public.studio_layout_templates t where t.org_id = M and t.name = E'Demo \u00b7 Corporate \u2014 Round tables gala (120 guests)'
      and t.event_type = 'corporate' and jsonb_array_length(t.data -> 'items') = 45
      and (select (e->>'x')::numeric + (e->>'width')::numeric/2 from jsonb_array_elements(t.data->'items') e where e->>'id' = 'obj_6f3rc')
        between (select (e->>'x')::numeric + (e->>'width')::numeric/2 - 0.02 from jsonb_array_elements(t.data->'items') e where e->>'id' = 'obj_6e3rc')
            and (select (e->>'x')::numeric + (e->>'width')::numeric/2 + 0.02 from jsonb_array_elements(t.data->'items') e where e->>'id' = 'obj_6e3rc')
      and (select count(distinct e->>'x') from jsonb_array_elements(t.data->'items') e where e->>'type' = 'lighting') = 1)
    and exists (select 1 from public.studio_layout_templates t where t.org_id = M and t.name = E'Demo \u00b7 Corporate \u2014 Theatre/conference'
      and not exists (select 1 from jsonb_array_elements(t.data->'items') e where e->>'type' in ('table','headtable'))
      and (select count(*) from jsonb_array_elements(t.data->'items') e where e->>'type' = 'seatblock') = 4));
  perform pg_temp.res('13 corporate event floor plan = round tables gala', (select v.data from public.quote_versions v where v.org_id = M
    and v.quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a3' and v.version_no = 1)
    = (select data from public.studio_layout_templates where org_id = M and name = E'Demo \u00b7 Corporate \u2014 Round tables gala (120 guests)'));
  perform pg_temp.res('14 corporate event 120 guests + chairs, total repriced, lead 120', exists (select 1 from public.quotes where org_id = M
    and id = 'a5a5a5a5-0167-4000-8000-0000000000a3' and pricing ->> 'guests' = '120' and pricing ->> 'chairs' = '120'
    and (pricing ->> 'total')::numeric > 0 and (pricing ->> 'total')::numeric < 486750 and client ->> 'guests' = '120')
    and exists (select 1 from public.leads where org_id = M and email = 'demo.technova@example.com' and guest_count = 120));
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid; o public.organizations; r jsonb; M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('td3_a@t.test', 'UTC', 'USD');
  select * into o from public.organizations where id = a;
  perform pg_temp.res('20 trial cloned from v4 (0170 on top of v3)', o.sample_version = 4, coalesce(o.sample_version::text, 'null'));
  perform pg_temp.res('21b trial has all 3 layout templates', (select count(*) from public.studio_layout_templates where org_id = a and not archived) = 3);
  perform pg_temp.res('21 trial has the wedding layout template', exists (select 1 from public.studio_layout_templates where org_id = a and not archived
    and name = E'Demo \u00b7 Wedding \u2014 Grand Lawn (450+ guests)' and jsonb_array_length(data -> 'items') = 71));
  perform pg_temp.res('22 trial wedding floor plan = 71 objects', exists (select 1 from public.quote_versions v join public.quotes q on q.id = v.quote_id
    where v.org_id = a and q.org_id = a and q.title like '%Wedding%' and v.object_count = 71));
  perform pg_temp.res('23 trial coupons', (select count(*) from public.coupons where org_id = a and active and code like 'DEMO-%') = 3);
  perform pg_temp.res('24 trial T&C + GST 18 intra', exists (select 1 from public.app_config where org_id = a and key = 'pricing'
    and value ->> 'termsText' like 'SAMPLE TERMS%' and (value ->> 'gstPct')::numeric = 18 and value ->> 'placeOfSupply' = 'intra'));
  perform pg_temp.res('25 trial run sheets on 3 events + 3 discovery records', (select count(distinct quote_id) from public.run_sheet_items where org_id = a) = 3
    and (select count(*) from public.event_discovery d join public.quotes q on q.id = d.quote_id where d.org_id = a and q.org_id = a) = 3);
  perform pg_temp.res('26 trial quotes intra-state 18 %', (select count(*) from public.quotes where org_id = a and pricing ->> 'gstPct' = '18') = 4
    and (select count(*) from public.quotes where org_id = a and pricing ->> 'placeOfSupply' = 'intra') = 3);
  r := public._demo_clear(a);
  perform pg_temp.res('27 clear: coupons off + template archived, rows kept', (select count(*) from public.coupons where org_id = a and code like 'DEMO-%' and not active) = 3
    and (select count(*) from public.studio_layout_templates where org_id = a and archived) = 3, r::text);
  perform pg_temp.res('28 master untouched by clone + clear', (select count(*) from public.coupons where org_id = M and active) = 3
    and (select count(*) from public.studio_layout_templates where org_id = M and not archived) = 3);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x clone', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DATA-0169: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DATA-0169: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
