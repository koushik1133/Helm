-- r21-political-0251.sql -- 0251: the free-trial Reception sample layout is replaced by the owner's Political rally layout
-- (master + existing trial studios + one new manifest), paid studios / changed rows / cleared studios untouched. Rolled back. Local disposable PG only.
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

do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; a uuid; b uuid; c uuid; d uuid; p uuid;
  REC constant text := E'Demo \u00b7 Reception \u2014 Lawn reception with sofa lounge (450 guests)';
  POL constant text := E'Demo \u00b7 Political rally \u2014 5,000 seats';
  WED constant text := E'Demo \u00b7 Wedding \u2014 Grand Lawn (450+ guests)';
  v_rec jsonb; t record;
begin
  perform pg_temp.su();
  select data into v_rec from public.studio_layout_templates where org_id = M and name = REC;
  perform pg_temp.res('01 master: Political rally once, live, event type political; Reception kept but archived',
    (select count(*) from public.studio_layout_templates where org_id = M and name = POL) = 1
    and exists (select 1 from public.studio_layout_templates where org_id = M and name = POL and not archived and event_type = 'political')
    and exists (select 1 from public.studio_layout_templates where org_id = M and name = REC and archived)
    and (select count(*) from public.studio_layout_templates where org_id = M and not archived) = 3,
    (select string_agg(name || ':' || archived, ', ') from public.studio_layout_templates where org_id = M));
  select * into t from public.studio_layout_templates where org_id = M and name = POL;
  perform pg_temp.res('02 the layout: 73 objects, no stray chair, 20 seat blocks = 5000 seats, 350 x 550 ft, capacity 5000',
    jsonb_array_length(t.data -> 'items') = 73
    and not exists (select 1 from jsonb_array_elements(t.data -> 'items') i where i ->> 'type' = 'chiavari')
    and (select count(*) from jsonb_array_elements(t.data -> 'items') i where i ->> 'type' = 'seatblock') = 20
    and (select sum((i #>> '{properties,rows}')::int * (i #>> '{properties,cols}')::int) from jsonb_array_elements(t.data -> 'items') i
          where i ->> 'type' = 'seatblock') = 5000
    and t.data #> '{scale,worldFt}' = '{"w":350,"h":550}'::jsonb and (t.data #>> '{venue,capacity}')::int = 5000
    and t.description like 'Sample template. Political rally%' and t.thumbnail is null and not t.is_default);
  perform pg_temp.res('03 manifest published once (current is the 0251 one or a later one) and it carries the new set',
    (select count(*) from public.helm_trial_seed_manifest where notes = 'political rally layout (0251)') = 1
    and exists (select 1 from public.helm_trial_seed_manifest m where m.notes = 'political rally layout (0251)'
      and (m.is_current or exists (select 1 from public.helm_trial_seed_manifest x where x.is_current and x.version > m.version))
      and exists (select 1 from jsonb_array_elements(m.payload #> '{tables,studio_layout_templates}') r where r ->> 'name' = POL and not (r ->> 'archived')::boolean)));

  -- a NEW trial gets the new set
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('pol251_a@t.test');
  perform pg_temp.res('04 new trial: 3 live sample layouts incl. Political rally, Reception not live',
    (select count(*) from public.studio_layout_templates where org_id = a and not archived) = 3
    and exists (select 1 from public.studio_layout_templates where org_id = a and name = POL and not archived)
    and not exists (select 1 from public.studio_layout_templates where org_id = a and name = REC and not archived),
    (select string_agg(name || ':' || archived, ', ') from public.studio_layout_templates where org_id = a));

  -- existing studios made before 0251 (no sample copy; rows put in by hand):
  --   b trial, shipped Reception + Wedding live      -> Reception archived, Political added
  --   c trial, Reception CHANGED by the studio        -> Reception stays live, Political added (samples still shown)
  --   d trial, cleared samples (all Demo archived)   -> nothing added, nothing changed
  --   p PAID, shipped Reception live                  -> untouched
  update public.helm_sample_template set active = false where id;
  b := pg_temp.trial('pol251_b@t.test'); c := pg_temp.trial('pol251_c@t.test');
  d := pg_temp.trial('pol251_d@t.test'); p := pg_temp.trial('pol251_p@t.test');
  update public.studio_subscriptions set status = 'active' where org_id = p;
  insert into public.studio_layout_templates(org_id, name, event_type, description, data, archived) values
    (b, REC, 'reception', 'old', v_rec, false), (b, WED, 'wedding', 'old', '{"items":[]}'::jsonb, false),
    (c, REC, 'reception', 'mine', jsonb_set(v_rec, '{items}', (v_rec -> 'items') || '[{"x":1,"y":1,"id":"mine","type":"stage","width":10,"height":10}]'::jsonb), false),
    (d, REC, 'reception', 'old', v_rec, true), (d, WED, 'wedding', 'old', '{"items":[]}'::jsonb, true),
    (p, REC, 'reception', 'old', v_rec, false), (p, WED, 'wedding', 'old', '{"items":[]}'::jsonb, false);
  perform pg_temp.put('b', b::text); perform pg_temp.put('c', c::text); perform pg_temp.put('d', d::text); perform pg_temp.put('p', p::text);
  perform pg_temp.put('nrows', (select count(*) from public.studio_layout_templates)::text);
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception 1', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
\i supabase/migrations/0251_political_rally_layout.sql
\i supabase/migrations/0251_political_rally_layout.sql
do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; b uuid; c uuid; d uuid; p uuid;
  REC constant text := E'Demo \u00b7 Reception \u2014 Lawn reception with sofa lounge (450 guests)';
  POL constant text := E'Demo \u00b7 Political rally \u2014 5,000 seats';
begin
  perform pg_temp.su();
  b := pg_temp.get('b')::uuid; c := pg_temp.get('c')::uuid; d := pg_temp.get('d')::uuid; p := pg_temp.get('p')::uuid;
  perform pg_temp.res('05 existing trial: shipped Reception archived (row kept), Political rally added once after 2 runs',
    exists (select 1 from public.studio_layout_templates where org_id = b and name = REC and archived)
    and (select count(*) from public.studio_layout_templates where org_id = b and name = POL and not archived) = 1);
  perform pg_temp.res('06 existing trial with a CHANGED Reception: it stays live (never overwritten), Political added once',
    exists (select 1 from public.studio_layout_templates where org_id = c and name = REC and not archived
            and exists (select 1 from jsonb_array_elements(data -> 'items') i where i ->> 'id' = 'mine'))
    and (select count(*) from public.studio_layout_templates where org_id = c and name = POL) = 1);
  perform pg_temp.res('07 trial that cleared its samples: nothing added',
    not exists (select 1 from public.studio_layout_templates where org_id = d and name = POL)
    and (select count(*) from public.studio_layout_templates where org_id = d and not archived) = 0);
  perform pg_temp.res('08 paid studio untouched (Reception live, no Political rally)',
    exists (select 1 from public.studio_layout_templates where org_id = p and name = REC and not archived)
    and not exists (select 1 from public.studio_layout_templates where org_id = p and name = POL));
  perform pg_temp.res('09 re-run: no extra manifest, master still one Political rally, nothing deleted (rows only added)',
    (select count(*) from public.helm_trial_seed_manifest where notes = 'political rally layout (0251)') = 1
    and (select count(*) from public.studio_layout_templates where org_id = M and name = POL) = 1
    and (select count(*) from public.studio_layout_templates) = pg_temp.get('nrows')::int + 2);
exception when others then perform pg_temp.su(); insert into _uf values ('zz exception 2', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-POLITICAL-0251: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-POLITICAL-0251: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
