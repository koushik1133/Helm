-- trial-data-0168.sql -- 0168: owner venues + payment terms in the sample master, manifest v2, and a
-- cloned trial studio takes INR / Asia/Kolkata / IN + the payment terms + the master's item rate cards
-- even when the visitor's browser said USD / UTC. Other studios are never touched.
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
-- row counts of every cloned table for one studio

do $$ declare M uuid := 'a5a5a5a5-0166-4000-8000-000000000001'; mf public.helm_trial_seed_manifest; begin
  perform pg_temp.su();
  select * into mf from public.helm_trial_seed_manifest where is_current;
  -- 0169 publishes v3 on top; v2 stays as published
  select * into mf from public.helm_trial_seed_manifest where version = 2;
  perform pg_temp.res('01 manifest v2 kept with owner notes (v3 current after 0169)', mf.version = 2 and mf.notes = 'v2: owner venues + payment terms');
  perform pg_temp.res('02 v2 carries studio settings', mf.payload #>> '{studio,currency}' = 'INR' and mf.payload #>> '{studio,timezone}' = 'Asia/Kolkata'
    and (mf.payload #>> '{studio,pricing,advancePct}')::numeric = 30 and (mf.payload #>> '{studio,pricing,balanceDueDays}')::int = 3, (mf.payload -> 'studio')::text);
  perform pg_temp.res('03 master has exactly the 4 owner venues', (select count(*) from public.venues where org_id = M) = 4
    and (select count(*) from public.venues where org_id = M and name in (E'Demo \u00b7 Grand Convention Centre, Hitec City', E'Demo \u00b7 Green Meadows Lawn',
         E'Demo \u00b7 Royal Banquet Hall', E'Demo \u00b7 Square Garden Pavilion, Gachibowli')) = 4);
  perform pg_temp.res('04 venue codes valid (convention centre, both, ft, 6 restrictions)', exists (select 1 from public.venues where org_id = M
    and name like '%Square Garden%' and venue_type = 'lawn' and setting = 'both' and dim_unit = 'ft' and seated_capacity = 2400
    and floating_capacity = 4000 and cardinality(restrictions) = 6 and cost_min = 250000 and cost_max = 450000 and sound_curfew = '22:00')
    and exists (select 1 from public.venues where org_id = M and name like '%Grand Convention%' and venue_type = 'convention_centre' and 'product_launch' = any(event_types)));
  perform pg_temp.res('05 no sample event names an old venue', not exists (select 1 from public.quotes where org_id = M
    and client ->> 'venue' ~ '(Sitara|Banjara|Golconda|Skyline)'));
  perform pg_temp.res('06 master payment terms', exists (select 1 from public.app_config where org_id = M and key = 'pricing'
    and (value ->> 'advancePct')::numeric = 30 and (value ->> 'balanceDueDays')::int = 3 and value ->> 'paymentTermsNote' like '30% advance to confirm%'));
  perform pg_temp.res('07 milestones: 30% advance + balance due event - 3', not exists (
      select 1 from public.payment_milestones pm join public.quotes q on q.id = pm.quote_id
       where pm.org_id = M and not ((pm.label = 'Advance (30%)' and pm.amount = round((q.pricing ->> 'total')::numeric * 0.3))
                                 or (pm.label = 'Balance (70%)' and pm.due_date = q.event_date - 3)))
    and (select count(*) from public.payment_milestones where org_id = M) >= 4);
  perform pg_temp.res('08 milestones add up to the event total', not exists (select 1 from public.quotes q where q.org_id = M
    and exists (select 1 from public.payment_milestones pm where pm.quote_id = q.id)
    and (select sum(amount) from public.payment_milestones pm where pm.quote_id = q.id) <> (q.pricing ->> 'total')::numeric));
  perform pg_temp.res('09 clone wrapper in place (pre kept, not callable by the app)', to_regprocedure('public._sample_clone_into__pre0168(uuid)') is not null
    and not has_function_privilege('authenticated', 'public._sample_clone_into(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._sample_clone_into__pre0168(uuid)', 'execute'));
exception when others then perform pg_temp.su(); insert into _uf values ('0x master', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare a uuid; b uuid; o public.organizations; r jsonb; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  a := pg_temp.trial('td_a@t.test', 'UTC', 'USD');
  select * into o from public.organizations where id = a;
  perform pg_temp.res('20 trial cloned from current (>= v5, later migrations on top of v2)', o.sample_version = (select version from public.helm_trial_seed_manifest where is_current), coalesce(o.sample_version::text, 'null'));
  perform pg_temp.res('21 trial studio INR + Asia/Kolkata + IN (browser said USD / UTC)', o.currency = 'INR' and o.timezone = 'Asia/Kolkata' and o.country = 'IN',
    o.currency || ' ' || o.timezone || ' ' || coalesce(o.country, ''));
  perform pg_temp.res('22 trial payment terms', exists (select 1 from public.app_config where org_id = a and key = 'pricing'
    and (value ->> 'advancePct')::numeric = 30 and (value ->> 'balanceDueDays')::int = 3 and value ->> 'paymentTermsNote' like '30% advance%'));
  perform pg_temp.res('23 trial has the 4 owner venues', (select count(*) from public.venues where org_id = a and is_demo
    and name in (E'Demo \u00b7 Grand Convention Centre, Hitec City', E'Demo \u00b7 Green Meadows Lawn', E'Demo \u00b7 Royal Banquet Hall',
                 E'Demo \u00b7 Square Garden Pavilion, Gachibowli')) = 4);
  perform pg_temp.res('24 trial milestones: balance due event - 3', exists (select 1 from public.payment_milestones pm join public.quotes q on q.id = pm.quote_id
    where pm.org_id = a and pm.label = 'Balance (70%)' and pm.due_date = q.event_date - 3 and q.lifecycle_stage = 'planning'));
  perform pg_temp.res('25 trial has all 11 builder item rate cards', (select count(*) from public.item_rate_cards where org_id = a) = 11);
  perform pg_temp.res('26 master unchanged by the clone', (select count(*) from public.venues where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 4
    and (select currency from public.organizations where id = 'a5a5a5a5-0166-4000-8000-000000000001') = 'INR');
  perform pg_temp.newuser('td_b@t.test'); perform pg_temp.login('td_b@t.test');
  r := public.start_self_serve_trial('T own', 'UTC', 'USD', 'own');
  perform pg_temp.su(); b := (r ->> 'org_id')::uuid;
  -- 0177: a free trial is India only, so 'USD' sent by the browser still lands on INR
  perform pg_temp.res('27 an own-data trial keeps its own settings (no clone)', (select currency from public.organizations where id = b) = case when to_regprocedure('public.tg_org_trial_india()') is null then 'USD' else 'INR' end
    and not exists (select 1 from public.venues where org_id = b), r::text);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x clone', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-DATA-0168: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-DATA-0168: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
