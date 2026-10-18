-- trial-seed-0237.sql -- 0237: the free-trial sample data is complete (B11): a layout version 1 for every sample
-- event, the two sample floor plans seat the guest count, the sample events carry their menu package in the event
-- plan, the sample studio has layout rules / chair types / plate types, my_demo_status counts the sample layout
-- templates; a NEW trial gets all of it from the new manifest, an EXISTING trial gets the missing rows insert-only.
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
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the builder's seat count (public/builder.js genSeats): rows x cols, else seats, else per-type sofa / chair seats
create or replace function pg_temp.seats(p jsonb) returns integer language sql as $$
  select coalesce(sum(case when (i -> 'properties' ->> 'rows') is not null and (i -> 'properties' ->> 'cols') is not null
                             then (i -> 'properties' ->> 'rows')::int * (i -> 'properties' ->> 'cols')::int
                           when (i -> 'properties' ->> 'seats') is not null then (i -> 'properties' ->> 'seats')::int
                           else case i ->> 'type' when 'chiavari' then 1 when 'barstool' then 1 when 'sofa' then 3 when 'loveseat' then 2
                                  when 'armchair' then 1 when 'ottoman' then 1 when 'bench' then 2 when 'lounge' then 4 else 0 end end), 0)::int
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) i;
$$;

-- earlier suites re-apply older migrations (0127 my_demo_status, 0169 / 0202 clone list): re-run 0237
\ir ../../supabase/migrations/0237_trial_seed_completeness.sql

-- ---- the sample master ------------------------------------------------------------------------------------
do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; d jsonb; n int; begin
  perform pg_temp.su();
  perform pg_temp.res('01 master: every sample event has a layout version 1',
    not exists (select 1 from public.quotes q where q.org_id = M and q.deleted_at is null
                 and not exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = 1))
    and (select count(*) from public.quotes where org_id = M) = 7);
  select data into d from public.quote_versions where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a1' and version_no = 1;
  perform pg_temp.res('02 master SMP-1001 wedding: 450 seats for 450 guests, limit 520 (was 974 vs 450)',
    pg_temp.seats(d) = 450 and (d #>> '{venue,capacity}')::int = 520 and jsonb_array_length(d -> 'items') = 71,
    pg_temp.seats(d) || ' / ' || (d #>> '{venue,capacity}'));
  select data into d from public.quote_versions where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a3' and version_no = 1;
  perform pg_temp.res('03 master SMP-1003 gala: 120 seats for 120 guests, limit 140 (was 132 vs 120)',
    pg_temp.seats(d) = 120 and (d #>> '{venue,capacity}')::int = 140 and jsonb_array_length(d -> 'items') = 45,
    pg_temp.seats(d) || ' / ' || (d #>> '{venue,capacity}'));
  perform pg_temp.res('04 master: every floor plan seats at most its guests and its limit',
    not exists (select 1 from public.quote_versions v join public.quotes q on q.id = v.quote_id
                 where v.org_id = M and v.object_count > 0
                   and (pg_temp.seats(v.data) > (q.client ->> 'guests')::int or pg_temp.seats(v.data) > (v.data #>> '{venue,capacity}')::int)));
  perform pg_temp.res('05 master: sample events carry their menu package in the event plan (locked from Planning on)',
    (select count(*) from public.event_plan p join public.quotes q on q.id = p.quote_id
      where q.org_id = M and p.menu_template = q.pricing ->> '_packageName' and p.menu_plate_price = (q.pricing ->> 'platePrice')::numeric) = 6
    and not exists (select 1 from public.event_plan p join public.quotes q on q.id = p.quote_id
                     where q.org_id = M and q.lifecycle_stage = 'planning' and not p.menu_locked)
    and not exists (select 1 from public.event_plan p join public.quotes q on q.id = p.quote_id
                     where q.org_id = M and q.lifecycle_stage = 'quote' and p.menu_locked));
  perform pg_temp.res('06 master: 8 layout rules, 3 chair types, 3 plate types',
    (select count(*) from public.layout_rules where org_id = M and active) = 8
    and (select count(*) from public.chair_types where org_id = M and active) = 3
    and (select count(*) from public.plate_types where org_id = M and active) = 3);
  perform pg_temp.res('07 one new current manifest with the new lists in it',
    (select count(*) from public.helm_trial_seed_manifest where notes = 'sample completeness (0237)') = 1
    and (select is_current from public.helm_trial_seed_manifest where notes = 'sample completeness (0237)')
    and (select (counts ->> 'layout_rules')::int = 8 and (counts ->> 'chair_types')::int = 3 and (counts ->> 'plate_types')::int = 3
                and (counts ->> 'event_plan')::int = 6 and (counts ->> 'quote_versions')::int = 7
           from public.helm_trial_seed_manifest where is_current));
  perform pg_temp.res('08 clone list: settings lists before leads, event_plan after quotes',
    array_position(public._sample_clone_tables(), 'chair_types') < array_position(public._sample_clone_tables(), 'leads')
    and array_position(public._sample_clone_tables(), 'event_plan') > array_position(public._sample_clone_tables(), 'quotes')
    and 'event_requirements' = any(public._sample_clone_tables()) and 'layout_rules' = any(public._sample_clone_tables())
    and 'plate_types' = any(public._sample_clone_tables()));
  perform pg_temp.res('09 master: the matching layout templates are fitted too (each plan still equals its template)',
    (select data from public.quote_versions where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a1' and version_no = 1)
      = (select data from public.studio_layout_templates where org_id = M and name like '%Grand Lawn%')
    and (select data from public.quote_versions where quote_id = 'a5a5a5a5-0167-4000-8000-0000000000a3' and version_no = 1)
      = (select data from public.studio_layout_templates where org_id = M and name like '%Round tables gala%')
    and not exists (select 1 from public.studio_layout_templates t where t.org_id = M and not t.archived
                     and (t.data #>> '{venue,capacity}') ~ '^[0-9]+$' and pg_temp.seats(t.data) > (t.data #>> '{venue,capacity}')::int));
  perform pg_temp.res('09b fit leaves any other plan unchanged',
    public._a237_fit_layout('{"items":[{"id":"x","type":"seatblock","properties":{"rows":20,"cols":25}}],"venue":{"capacity":450}}'::jsonb)
      = '{"items":[{"id":"x","type":"seatblock","properties":{"rows":20,"cols":25}}],"venue":{"capacity":450}}'::jsonb);
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- a NEW trial: everything comes with the clone ---------------------------------------------------------------
do $$ declare t uuid; d jsonb; s jsonb; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  t := pg_temp.trial('ts237_new@t.test'); perform pg_temp.put('T', t::text);
  perform pg_temp.res('10 new trial: every sample event has a layout version 1',
    (select count(*) from public.quotes where org_id = t and is_demo) = 7
    and not exists (select 1 from public.quotes q where q.org_id = t and q.is_demo
                     and not exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = 1)));
  select v.data into d from public.quote_versions v join public.quotes q on q.id = v.quote_id
   where q.org_id = t and q.code = 'SMP-1001' and v.version_no = 1;
  perform pg_temp.res('11 new trial: the wedding floor plan seats the guests (450 / limit 520)',
    pg_temp.seats(d) = 450 and (d #>> '{venue,capacity}')::int = 520, coalesce(pg_temp.seats(d)::text, 'none'));
  select v.data into d from public.quote_versions v join public.quotes q on q.id = v.quote_id
   where q.org_id = t and q.code = 'SMP-1003' and v.version_no = 1;
  perform pg_temp.res('12 new trial: the gala floor plan seats the guests (120 / limit 140)',
    pg_temp.seats(d) = 120 and (d #>> '{venue,capacity}')::int = 140, coalesce(pg_temp.seats(d)::text, 'none'));
  perform pg_temp.res('13 new trial: event plans (6, own studio, linked to its own sample events)',
    (select count(*) from public.event_plan p join public.quotes q on q.id = p.quote_id and q.org_id = t
      where p.org_id = t and q.is_demo and p.menu_template is not null) = 6);
  perform pg_temp.res('14 new trial: layout rules 8, chair types 3, plate types 3',
    (select count(*) from public.layout_rules where org_id = t) = 8 and (select count(*) from public.chair_types where org_id = t) = 3
    and (select count(*) from public.plate_types where org_id = t) = 3);
  perform pg_temp.login('ts237_new@t.test');
  s := public.my_demo_status();
  perform pg_temp.res('15 new trial: my_demo_status counts the sample layout templates (layouts = active Demo templates)',
    (s #>> '{counts,layouts}')::int = (select count(*) from public.studio_layout_templates where org_id = t and not archived and name like E'Demo \u00b7 %')
    and (s #>> '{counts,layouts}')::int >= 3, s::text);
  perform pg_temp.res('16 new trial: the app reads the lists (Control Center)',
    (select count(*) from public.chair_types) = 3 and (select count(*) from public.plate_types) = 3
    and (select count(*) from public.layout_rules where active) = 8);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('1x new trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- an EXISTING trial (rows missing as before 0237): insert only, where missing ----------------------------------
do $$ declare t uuid; own_q uuid; n_paid int; begin
  perform pg_temp.su();
  t := pg_temp.trial('ts237_old@t.test'); perform pg_temp.put('O', t::text);
  -- make it look like a trial cloned before 0237 (this suite rolls back)
  delete from public.event_plan where org_id = t;
  delete from public.quote_versions v using public.quotes q where q.id = v.quote_id and q.org_id = t and q.is_demo and v.object_count = 0;
  delete from public.layout_rules where org_id = t;
  delete from public.plate_types where org_id = t;
  delete from public.chair_types where org_id = t;
  insert into public.chair_types(org_id, name, price) values (t, 'Own chair 0237', 77);   -- the studio's own list stays as it is
  insert into public.quotes(id, code, title, org_id, is_demo) values (gen_random_uuid(), 'TS237-OWN', 'Own event 0237', t, false) returning id into own_q;
  perform pg_temp.put('OQ', own_q::text);
  select count(*) into n_paid from public.chair_types where org_id = (select org_id from public.profiles where email = 'a_admin@a.test');
  perform pg_temp.put('NP', n_paid::text);
end $$;
\ir ../../supabase/migrations/0237_trial_seed_completeness.sql
do $$ declare t uuid := pg_temp.get('O')::uuid; begin
  perform pg_temp.res('20 existing trial: an empty version 1 added for each sample event without one',
    not exists (select 1 from public.quotes q where q.org_id = t and q.is_demo
                 and not exists (select 1 from public.quote_versions v where v.quote_id = q.id and v.version_no = 1)));
  perform pg_temp.res('21 existing trial: the studio''s own event is not touched (no version added)',
    not exists (select 1 from public.quote_versions where quote_id = pg_temp.get('OQ')::uuid));
  perform pg_temp.res('22 existing trial: event plans added from the sample events'' own pricing',
    (select count(*) from public.event_plan p join public.quotes q on q.id = p.quote_id
      where p.org_id = t and q.is_demo and p.menu_template = q.pricing ->> '_packageName') = 6);
  perform pg_temp.res('23 existing trial: layout rules + plate types filled (empty lists only)',
    (select count(*) from public.layout_rules where org_id = t) = 8 and (select count(*) from public.plate_types where org_id = t) = 3);
  perform pg_temp.res('24 existing trial: a list the studio already has is left alone (chair types)',
    (select count(*) from public.chair_types where org_id = t) = 1
    and exists (select 1 from public.chair_types where org_id = t and name = 'Own chair 0237' and price = 77));
  perform pg_temp.res('25 paid studio untouched', (select count(*) from public.chair_types
    where org_id = (select org_id from public.profiles where email = 'a_admin@a.test')) = pg_temp.get('NP')::int);
end $$;
\ir ../../supabase/migrations/0237_trial_seed_completeness.sql
do $$ declare t uuid := pg_temp.get('O')::uuid; begin
  perform pg_temp.res('26 a 3rd run adds nothing (idempotent)',
    (select count(*) from public.event_plan where org_id = t) = 6 and (select count(*) from public.layout_rules where org_id = t) = 8
    and (select count(*) from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t) = 7
    and (select count(*) from public.helm_trial_seed_manifest where notes = 'sample completeness (0237)') = 1);
  -- Clear sample data (Helm's own function) still removes the sample events with their plans / versions; lists stay
  perform public._demo_clear(t);
  perform pg_temp.res('27 sample clear: sample event plans + versions go with the events, settings lists stay',
    not exists (select 1 from public.event_plan p join public.quotes q on q.id = p.quote_id where q.org_id = t and q.is_demo)
    and not exists (select 1 from public.quotes where org_id = t and is_demo)
    and (select count(*) from public.layout_rules where org_id = t) = 8
    and exists (select 1 from public.quotes where id = pg_temp.get('OQ')::uuid));
exception when others then perform pg_temp.su(); insert into _uf values ('2x existing trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- a "Demo . " layout template alone (0175 gave one to every trial studio, also to checkout trials and studios that had
-- cleared their samples) shows in counts.layouts but never turns has_demo / demo_rows on
do $$ declare t uuid := pg_temp.get('O')::uuid; s0 jsonb; s1 jsonb; begin
  perform pg_temp.login('ts237_old@t.test');
  s0 := public.my_demo_status();
  perform pg_temp.su();
  insert into public.studio_layout_templates(org_id, name, event_type, description, data)
    values (t, E'Demo · Template only 0237', 'reception', 'x', '{"items":[]}'::jsonb);
  perform pg_temp.login('ts237_old@t.test');
  s1 := public.my_demo_status();
  perform pg_temp.su();
  perform pg_temp.res('28 a sample template alone: counted in counts.layouts, not in demo_rows / has_demo',
    (s1 #>> '{counts,layouts}')::int = (s0 #>> '{counts,layouts}')::int + 1
    and (s1 ->> 'demo_rows')::int = (s0 ->> 'demo_rows')::int and (s1 ->> 'has_demo') = (s0 ->> 'has_demo'),
    s0::text || ' -> ' || s1::text);
exception when others then perform pg_temp.su(); insert into _uf values ('28 template only', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.res('90 helpers internal, my_demo_status signed-in only',
    not has_function_privilege('authenticated', 'public._a237_sample_settings()', 'execute')
    and not has_function_privilege('authenticated', 'public._a237_fit_layout(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public._a237_manifest_note()', 'execute')
    and has_function_privilege('authenticated', 'public.my_demo_status()', 'execute')
    and not has_function_privilege('anon', 'public.my_demo_status()', 'execute'));
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-SEED-0237: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-SEED-0237: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
