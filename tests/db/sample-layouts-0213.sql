-- sample-layouts-0213.sql -- 0213: the five free-trial sample events that opened on an EMPTY floor get a floor plan made
-- for their event type and guest count (on their current, still-empty layout version); a NEW trial gets them from the
-- new manifest; an EXISTING trial gets them only through the owner-run _a213_fill_trial_layouts() (fill-empty / insert
-- only - a drawn floor, the studio's own events, paid studios and ended trials are never touched).
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
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
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
-- the builder's seat count (public/builder.js genSeats) for the pieces these plans use
create or replace function pg_temp.seats(p jsonb) returns integer language sql as $$
  select coalesce(sum(case when (i -> 'properties' ->> 'rows') is not null and (i -> 'properties' ->> 'cols') is not null
                             then (i -> 'properties' ->> 'rows')::int * (i -> 'properties' ->> 'cols')::int
                           when (i -> 'properties' ->> 'seats') is not null then (i -> 'properties' ->> 'seats')::int
                           else 0 end), 0)::int
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) i;
$$;
-- the floor the builder opens for an event: its current version
create or replace function pg_temp.floor(p_quote uuid) returns jsonb language sql as $$
  select v.data from public.quote_versions v join public.quotes q on q.id = v.quote_id
   where q.id = p_quote and v.version_no = greatest(coalesce(q.current_version, 1), 1);
$$;
create or replace function pg_temp.empty_floor(p_org uuid) returns void language plpgsql as $$
begin   -- make a trial look like one cloned before 0213 (this suite rolls back)
  update public.quote_versions v set data = '{"items":[]}'::jsonb, object_count = 0, label = null
    from public.quotes q where q.id = v.quote_id and q.org_id = p_org and q.is_demo
     and q.code in ('SMP-1000', 'SMP-1002', 'SMP-1004', 'SMP-1005', 'SMP-1006');
end $$;

-- ---- the sample master ------------------------------------------------------------------------------------
do $$ declare M constant uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; q record; d jsonb; ok boolean := true; det text := ''; begin
  perform pg_temp.su();
  for q in select x.id, x.code, (x.client ->> 'guests')::int as g, x.event_type from public.quotes x
            where x.org_id = M and x.code in ('SMP-1000', 'SMP-1002', 'SMP-1004', 'SMP-1005', 'SMP-1006') order by x.code loop
    d := pg_temp.floor(q.id);
    if d is null or pg_temp.seats(d) <> q.g or jsonb_array_length(d -> 'items') < 20
       or (d #>> '{venue,capacity}')::int < q.g or d -> 'items' <> public._a213_sample_layout(q.code) -> 'items' then
      ok := false; det := det || q.code || ':' || coalesce(pg_temp.seats(d)::text, 'none') || '/' || q.g || ' '; end if;
  end loop;
  perform pg_temp.res('01 master: SMP-1000/1002/1004/1005/1006 open on their plan, seats = guests, within the limit', ok, det);
  perform pg_temp.res('02 master: plans fit their event type (stage / mandap, buffets, entrance, exits, seating kind)',
    (select bool_and(x) from (values
      (public._a213_sample_layout('SMP-1000') @> '{"items":[{"type":"stage"},{"type":"dancefloor"},{"type":"buffet"},{"type":"floralentrance"},{"type":"exit"},{"type":"table"}]}'),
      (public._a213_sample_layout('SMP-1002') @> '{"items":[{"type":"stage"},{"type":"dancefloor"},{"type":"buffet"},{"type":"floralentrance"},{"type":"exit"},{"type":"table"}]}'),
      (public._a213_sample_layout('SMP-1004') @> '{"items":[{"type":"stage"},{"type":"fairylights"},{"type":"led"},{"type":"dj"},{"type":"buffet"},{"type":"table"}]}'),
      (public._a213_sample_layout('SMP-1005') @> '{"items":[{"type":"stage"},{"type":"podium"},{"type":"brandwall"},{"type":"seatblock"},{"type":"desk"},{"type":"press"},{"type":"buffet"},{"type":"exit","label":"Entrance"}]}'),
      (public._a213_sample_layout('SMP-1006') @> '{"items":[{"type":"mandap"},{"type":"rangoli"},{"type":"buffet"},{"type":"gifttable"},{"type":"table"}]}'),
      (not public._a213_sample_layout('SMP-1006') @> '{"items":[{"type":"dj"}]}'),
      (public._a213_sample_layout('SMP-1001') is null and public._a213_sample_layout('XYZ') is null)) v(x)));
  perform pg_temp.res('03 master: every piece of every plan lies inside its hall (unrotated pieces)',
    not exists (select 1 from unnest(array['SMP-1000','SMP-1002','SMP-1004','SMP-1005','SMP-1006']) c,
                  jsonb_array_elements(public._a213_sample_layout(c) -> 'items') i
                 where coalesce((i ->> 'rotation')::numeric, 0) = 0
                   and ((i ->> 'x')::numeric < 0 or (i ->> 'y')::numeric < 0
                     or (i ->> 'x')::numeric + (i ->> 'width')::numeric > (public._a213_sample_layout(c) #>> '{venue,room,w}')::numeric
                     or (i ->> 'y')::numeric + (i ->> 'height')::numeric > (public._a213_sample_layout(c) #>> '{venue,room,h}')::numeric)));
  perform pg_temp.res('04 master: the wedding (SMP-1001) and gala (SMP-1003) plans untouched',
    jsonb_array_length(pg_temp.floor('a5a5a5a5-0167-4000-8000-0000000000a1') -> 'items') = 71
    and jsonb_array_length(pg_temp.floor('a5a5a5a5-0167-4000-8000-0000000000a3') -> 'items') = 45);
  perform pg_temp.res('05 master: no extra version rows (the empty current version was filled), quote rows untouched',
    (select count(*) from public.quote_versions where org_id = M) = 7
    and not exists (select 1 from public.quotes where org_id = M and coalesce(current_version, 1) <> 1));
  perform pg_temp.res('06 the 0213 manifest published once, with the plans in it',
    (select count(*) from public.helm_trial_seed_manifest where notes = 'sample floor plans (0213)') = 1
    and (select count(*) from public.helm_trial_seed_manifest c, jsonb_array_elements(c.payload #> '{tables,quote_versions}') x
          where c.is_current and (x ->> 'object_count')::int > 0) = 7);
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- a 2nd run changes nothing (no new manifest, the plans stay as they are)
do $$ begin perform pg_temp.put('MV', (select max(version)::text from public.helm_trial_seed_manifest)); end $$;
\ir ../../supabase/migrations/0213_sample_event_layouts.sql
do $$ begin
  perform pg_temp.res('07 a 2nd run publishes nothing and adds nothing',
    (select max(version)::text from public.helm_trial_seed_manifest) = pg_temp.get('MV')
    and (select count(*) from public.quote_versions where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 7);
end $$;

-- ---- a NEW trial: the plans come with the clone --------------------------------------------------------------
do $$ declare t uuid; ok boolean := true; e record; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  t := pg_temp.trial('sl213_new@t.test');
  for e in select x.id, x.code, (x.client ->> 'guests')::int as g from public.quotes x
            where x.org_id = t and x.is_demo and x.code in ('SMP-1000', 'SMP-1002', 'SMP-1004', 'SMP-1005', 'SMP-1006') loop
    if pg_temp.seats(pg_temp.floor(e.id)) <> e.g or pg_temp.floor(e.id) -> 'items' <> public._a213_sample_layout(e.code) -> 'items' then ok := false; end if;
  end loop;
  perform pg_temp.res('10 new trial: the five sample events open on their floor plan (own studio copy)',
    ok and (select count(*) from public.quotes where org_id = t and is_demo and code in ('SMP-1000', 'SMP-1002', 'SMP-1004', 'SMP-1005', 'SMP-1006')) = 5
    and not exists (select 1 from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t and v.org_id <> t));
  perform pg_temp.res('11 new trial: nothing left for the refresh to do',
    public._a213_fill_trial_layouts(t) = 0);
exception when others then perform pg_temp.su(); insert into _uf values ('1x new trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- EXISTING trials (cloned before 0213: empty sample floors) -- the owner-run refresh --------------------------
do $$ declare t uuid; t2 uuid; own_q uuid; drawn uuid; n int; paid uuid; paid_n int; begin
  perform pg_temp.su(); update public.helm_sample_template set active = true where id and not active;
  t := pg_temp.trial('sl213_old@t.test'); perform pg_temp.empty_floor(t);
  t2 := pg_temp.trial('sl213_ended@t.test'); perform pg_temp.empty_floor(t2);
  update public.organizations set trial_ends_at = now() - interval '1 day' where id = t2;
  -- one sample event the studio has drawn on, and one of the studio's own events
  select q.id into drawn from public.quotes q where q.org_id = t and q.code = 'SMP-1004';
  update public.quote_versions set data = '{"items":[{"id":"mine","type":"stage","x":1,"y":1,"width":10,"height":8}]}'::jsonb, object_count = 1
   where quote_id = drawn;
  insert into public.quotes(id, code, title, org_id, is_demo) values (gen_random_uuid(), 'SL213-OWN', 'Own event 0213', t, false) returning id into own_q;
  select org_id into paid from public.profiles where email = 'a_admin@a.test';
  select count(*) into paid_n from public.quote_versions where org_id = paid;
  n := public._a213_fill_trial_layouts();
  perform pg_temp.res('20 refresh: the trial''s 4 still-empty sample events get their plan (the drawn one is skipped)',
    n >= 4 and (select count(*) from public.quotes q where q.org_id = t and q.is_demo
                 and pg_temp.floor(q.id) -> 'items' = public._a213_sample_layout(q.code) -> 'items') = 4, n::text);
  perform pg_temp.res('21 refresh: a sample floor the studio drew on is never replaced',
    pg_temp.floor(drawn) = '{"items":[{"id":"mine","type":"stage","x":1,"y":1,"width":10,"height":8}]}'::jsonb);
  perform pg_temp.res('22 refresh: the studio''s own event, an ended trial and paid studios are not touched',
    not exists (select 1 from public.quote_versions where quote_id = own_q)
    and not exists (select 1 from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t2 and v.object_count > 0
                     and q.code in ('SMP-1000', 'SMP-1002', 'SMP-1004', 'SMP-1005', 'SMP-1006'))
    and (select count(*) from public.quote_versions where org_id = paid) = paid_n);
  perform pg_temp.res('23 refresh: fills the empty version in place (no extra rows), a 2nd run does nothing',
    (select count(*) from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t and q.is_demo) = 7
    and public._a213_fill_trial_layouts() = 0);
  -- a sample event with NO version at all (very old trial): the version is added as its current one
  delete from public.quote_versions v using public.quotes q where q.id = v.quote_id and q.org_id = t and q.code = 'SMP-1005';
  n := public._a213_fill_trial_layouts(t);
  perform pg_temp.res('24 refresh: an event with no version gets its plan as its current version',
    n = 1
    and pg_temp.seats(pg_temp.floor((select id from public.quotes where org_id = t and code = 'SMP-1005'))) = 200
    and (select v.org_id from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t and q.code = 'SMP-1005') = t,
    n::text || ' / ' || coalesce(pg_temp.seats(pg_temp.floor((select id from public.quotes where org_id = t and code = 'SMP-1005')))::text, 'none')
    || ' / ' || (select count(*) from public.quote_versions v join public.quotes q on q.id = v.quote_id where q.org_id = t and q.code = 'SMP-1005'));
exception when others then perform pg_temp.su(); insert into _uf values ('2x existing trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ begin
  perform pg_temp.res('90 helpers internal (no app / anonymous access)',
    not has_function_privilege('authenticated', 'public._a213_sample_layout(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._a213_fill_floor(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._a213_fill_trial_layouts(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._a213_fill_trial_layouts(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._a213_manifest_note()', 'execute'));
  perform pg_temp.res('91 ASCII-only plans (labels the builder shows as typed)',
    (select bool_and(public._a213_sample_layout(c)::text !~ '[^\x01-\x7e]') from unnest(array['SMP-1000','SMP-1002','SMP-1004','SMP-1005','SMP-1006']) c));
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'SAMPLE-LAYOUTS-0213: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'SAMPLE-LAYOUTS-0213: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
