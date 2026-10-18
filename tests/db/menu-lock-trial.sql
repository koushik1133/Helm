-- menu-lock-trial.sql -- Event Workspace "Lock menu": the event menu lock flow end to end (no migration).
-- Free-trial studio: own event + sample event -> venue/package saved, package applied (dishes), dishes
-- added / changed / removed, menu locked + unlocked. Only the studio CATALOG is fixed in the trial
-- (new dish refused), never the event's own menu. Paid studio: same flow; a role without plan edit and
-- another studio are refused. Rolled back. Local disposable PG only.
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

-- ---- 1) free-trial studio: own event -------------------------------------------------------------
do $$ declare o uuid; e text; q uuid; t uuid; d uuid; m uuid; begin
  o := pg_temp.trial('ml_trial@t.test'); perform pg_temp.put('T', o::text);
  perform pg_temp.res('01 studio is a free trial', public._is_trial_org(o));
  perform pg_temp.login('ml_trial@t.test');
  e := pg_temp.try($q$select public.create_quote('ML-0001','WED_HYD_50000_04NOV26','wedding','{}'::jsonb,0,(current_date + 17))$q$);
  select id into q from public.quotes where org_id = o and title = 'WED_HYD_50000_04NOV26' order by created_at desc limit 1;
  perform pg_temp.put('TQ', q::text);
  perform pg_temp.res('02 trial: own event created', e = '' and q is not null, e);
  e := pg_temp.try(format($q$select public.set_event_plan(%L::uuid, 'DEMO 2', null, null, null, 'Standard - Vegetarian', null)$q$, q));
  perform pg_temp.res('03 trial: venue + package saved', e = '' and exists (select 1 from public.event_plan where quote_id = q and venue_name = 'DEMO 2' and not menu_locked), e);
  select id into t from public.menu_templates where org_id = o and jsonb_array_length(dishes) > 0 order by seq limit 1;
  e := pg_temp.try(format($q$select public.apply_menu_template(%L::uuid, %L::uuid)$q$, q, t));
  perform pg_temp.res('04 trial: studio package applied to the event (dishes copied)', e = '' and t is not null
    and (select count(*) from public.event_menu_items where quote_id = q) > 0, coalesce(e, '') || ' t=' || coalesce(t::text, 'none'));
  select id into d from public.dish_catalog where org_id = o order by name limit 1;
  e := pg_temp.try(format($q$select public.add_event_dish(%L::uuid, %L::uuid)$q$, q, d));
  select id into m from public.event_menu_items where quote_id = q order by seq desc limit 1;
  e := e || pg_temp.try(format($q$select public.set_event_dish_qty(%L::uuid, 50000)$q$, m));
  e := e || pg_temp.try(format($q$select public.remove_event_dish(%L::uuid)$q$, m));
  perform pg_temp.res('05 trial: event dishes add / qty / remove allowed', e = '', e);
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, true)$q$, q));
  perform pg_temp.res('06 trial: Lock menu works', e = '' and (select menu_locked and locked_at is not null from public.event_plan where quote_id = q), e);
  e := pg_temp.try(format($q$select public.apply_menu_template(%L::uuid, %L::uuid)$q$, q, t));
  perform pg_temp.res('07 trial: locked menu refuses a package swap', e like '%menu is locked%', e);
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, false)$q$, q));
  perform pg_temp.res('08 trial: unlock works', e = '' and not (select menu_locked from public.event_plan where quote_id = q), e);
  e := pg_temp.try($q$insert into public.dish_catalog(category, name, kind) values ('Starters (veg)', 'ML brand new dish', 'veg')$q$);
  perform pg_temp.res('09 trial: the CATALOG stays fixed (new dish refused)', e like '42501%not add new menu or catalog items%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('0x trial own', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) free-trial studio: a sample (is_demo) event ---------------------------------------------
do $$ declare o uuid := pg_temp.get('T')::uuid; e text; q uuid; begin
  perform pg_temp.su();
  select id into q from public.quotes where org_id = o and is_demo and status <> 'confirmed' and deleted_at is null order by code limit 1;
  perform pg_temp.login('ml_trial@t.test');
  e := pg_temp.try(format($q$select public.set_event_plan(%L::uuid, 'Sample hall', null, null, null, 'Standard - Vegetarian', null)$q$, q));
  e := e || pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, true)$q$, q));
  perform pg_temp.su();
  perform pg_temp.res('10 trial: sample event menu can be locked', q is not null and e = '' and (select menu_locked from public.event_plan where quote_id = q), coalesce(e, '') || ' q=' || coalesce(q::text, 'none'));
exception when others then perform pg_temp.su(); insert into _uf values ('1x trial sample', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) paid studio (fixture Studio A) ----------------------------------------------------------
do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; q uuid := 'a0000000-0000-4000-8000-00000000da01'; t uuid; e text; begin
  perform pg_temp.su();
  perform pg_temp.res('20 paid studio is not a trial', not public._is_trial_org(A));
  insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, dishes, seq)
    values (A, 'standard', 'veg', 'ML Standard - Vegetarian', 450, '[{"n":"Paneer tikka","c":"Starters (veg)","k":"veg"}]'::jsonb, 99)
    returning id into t;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format($q$select public.set_event_plan(%L::uuid, 'Grand Hall', null, null, null, null, null)$q$, q));
  e := e || pg_temp.try(format($q$select public.apply_menu_template(%L::uuid, %L::uuid)$q$, q, t));
  perform pg_temp.res('21 paid: venue saved + package applied', e = '' and (select package = 'ML Standard - Vegetarian' from public.event_plan where quote_id = q), e);
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, true)$q$, q));
  perform pg_temp.res('22 paid: Lock menu works', e = '' and (select menu_locked from public.event_plan where quote_id = q), e);
  e := pg_temp.try($q$insert into public.dish_catalog(category, name, kind) values ('Starters (veg)', 'ML paid new dish', 'veg')$q$);
  perform pg_temp.res('23 paid: catalog add unchanged (allowed)', e = '', e);
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, false)$q$, q));
  perform pg_temp.res('24 paid: unlock works', e = '' and not (select menu_locked from public.event_plan where quote_id = q), e);
  -- a role without plan edit (fixture sales, made view-only on plan here) cannot lock
  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'plan', true, false, A, now())
    on conflict (role, area, org_id) do update set can_view = true, can_edit = false;
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, true)$q$, q));
  perform pg_temp.su();
  perform pg_temp.res('25 paid: role without plan edit refused', e like '42501%', e);
  -- another studio cannot lock the trial studio's event
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format($q$select public.set_plan_lock(%L::uuid, true)$q$, pg_temp.get('TQ')));
  perform pg_temp.su();
  perform pg_temp.res('26 other studio cannot lock this event', e like '42501%' and not coalesce((select menu_locked from public.event_plan where quote_id = pg_temp.get('TQ')::uuid), false), e);
exception when others then perform pg_temp.su(); insert into _uf values ('2x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'MENU-LOCK-TRIAL: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'MENU-LOCK-TRIAL: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
