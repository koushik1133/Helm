-- budget-plan-0196.sql -- 0196: budget lines made from requirements. Proves: the 4 new columns are nullable,
-- a requirement key is unique per event (a second pull is refused with 23505, the page skips it), hand-typed
-- lines (no key) never collide, priority / key / quoted checks, a vendor of ANOTHER studio is refused on insert
-- and update, studio B can neither see nor write studio A's lines, a free-trial studio (sample event too) can
-- add more than 2 budget lines (0173 cap does not apply), and re-running 0196 changes no row.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _bp(name text, result text); grant all on _bp to anon, authenticated, service_role;
create temp table _bkv(k text primary key, v text); grant all on _bkv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _bp values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _bkv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _bkv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;

-- earlier suites in run-all re-apply older migrations: re-run 0196 (also proves a re-run is safe)
\ir ../../supabase/migrations/0196_budget_from_requirements.sql

do $$ declare A uuid := 'a0000000-0000-4000-8000-000000000001'; B uuid := 'b0000000-0000-4000-8000-000000000001'; va uuid; vb uuid; begin
  perform pg_temp.su();
  insert into public.vendors(name, category, org_id) values ('BP0196 Florists A', 'Florist', A) returning id into va;
  insert into public.vendors(name, category, org_id) values ('BP0196 Sound B', 'Sound & lights', B) returning id into vb;
  perform pg_temp.put('va', va::text); perform pg_temp.put('vb', vb::text);
  perform pg_temp.res('01 four new columns, all nullable', (select count(*) from information_schema.columns where table_schema = 'public'
    and table_name = 'event_costs' and column_name in ('requirement_key', 'priority', 'quoted', 'vendor_id') and is_nullable = 'YES') = 4);
end $$;

-- ---- studio A admin: pull requirements -------------------------------------------------------------
do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; e text; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, kind, estimated, requirement_key, priority, quoted)
         values (%L, 'Decor & flowers', 'internal', 0, 'req:decor & flowers', 'mandatory', 45000)$q$, qa));
  perform pg_temp.res('02 requirement line added', e = '', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, kind, estimated, requirement_key, priority)
         values (%L, 'Decor & flowers', 'internal', 0, 'req:decor & flowers', 'optional')$q$, qa));
  perform pg_temp.res('03 same requirement again refused (23505, no duplicate)', e like '23505%', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, kind, estimated) values (%L, 'Catering', 'internal', 100), (%L, 'Catering', 'internal', 200)$q$, qa, qa));
  perform pg_temp.res('04 hand-typed lines (no key) never collide', e = '', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, requirement_key, priority) values (%L, 'X', 0, 'req:x1', 'urgent')$q$, qa));
  perform pg_temp.res('05 unknown priority refused', e like '23514%', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, quoted) values (%L, 'X', 0, -5)$q$, qa));
  perform pg_temp.res('06 negative quoted refused', e like '23514%', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, requirement_key) values (%L, 'X', 0, 'free text key')$q$, qa));
  perform pg_temp.res('07 key must be req:/std:', e like '23514%', e);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, vendor_id) values (%L, 'Sound', 0, %L)$q$, qa, pg_temp.get('vb')));
  perform pg_temp.res('08 vendor of another studio refused on insert', e like '42501%not in this studio%', e);
  e := pg_temp.try(format($q$update public.event_costs set vendor_id = %L, kind = 'vendor' where quote_id = %L and requirement_key = 'req:decor & flowers'$q$, pg_temp.get('va'), qa));
  perform pg_temp.res('09 own vendor accepted', e = '' and exists (select 1 from public.event_costs where quote_id = qa::uuid and vendor_id = pg_temp.get('va')::uuid), e);
  e := pg_temp.try(format($q$update public.event_costs set vendor_id = %L where quote_id = %L and requirement_key = 'req:decor & flowers'$q$, pg_temp.get('vb'), qa));
  perform pg_temp.res('10 vendor of another studio refused on update', e like '42501%not in this studio%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _bp values ('0x studio A', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- studio B: cannot see or write studio A's lines ---------------------------------------------------
do $$ declare qa text := 'a0000000-0000-4000-8000-00000000da01'; e text; n int; begin
  perform pg_temp.login('b_admin@b.test');
  select count(*) into n from public.event_costs where quote_id = qa::uuid;
  perform pg_temp.res('11 studio B sees none of studio A''s lines', n = 0, n::text);
  e := pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, requirement_key) values (%L, 'Hijack', 0, 'req:hijack')$q$, qa));
  perform pg_temp.res('12 studio B cannot add a line to studio A''s event', e <> '', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _bp values ('1x studio B', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- free trial: budget lines are not capped (sample event too) --------------------------------------
do $$ declare u uuid; o uuid; q uuid := gen_random_uuid(); e text := ''; r jsonb; v_trial boolean; begin
  perform pg_temp.su();
  select id into u from auth.users where email = 'bp196_trial@t.test';
  if u is null then u := auth.seed_user('bp196_trial@t.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, 'bp196_trial@t.test', 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login('bp196_trial@t.test');
  r := public.start_self_serve_trial('BP196 Trial', 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su();
  o := (r ->> 'org_id')::uuid;
  v_trial := public._is_trial_org(o);
  insert into public.quotes(id, code, title, status, client, pricing, current_version, approval_status, org_id, is_demo, created_at, updated_at)
    values (q, 'BP196-1', 'Sample event', 'quote', '{"name":"Sample"}'::jsonb, '{"guests":100,"platePrice":500}'::jsonb, 1, 'none', o, true, now(), now());
  perform pg_temp.login('bp196_trial@t.test');
  for i in 1..5 loop
    e := e || pg_temp.try(format($q$insert into public.event_costs(quote_id, description, estimated, requirement_key, priority) values (%L, %L, 0, %L, 'mandatory')$q$,
                                 q, 'Line ' || i, 'req:line ' || i));
  end loop;
  perform pg_temp.res('13 trial studio: 5 budget lines on a sample event (no 2-row cap)', e = '' and v_trial and
    (select count(*) from public.event_costs where quote_id = q) = 5, coalesce(nullif(e, ''), 'count ' || (select count(*) from public.event_costs where quote_id = q)));
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _bp values ('13 trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- re-run is a no-op on rows ---------------------------------------------------------------------
do $$ declare before text; after text; begin
  perform pg_temp.su();
  select string_agg(id::text || coalesce(requirement_key, '-') || coalesce(priority, '-') || estimated::text || coalesce(quoted::text, '-') || coalesce(vendor_id::text, '-'), ',' order by id) into before from public.event_costs;
  perform pg_temp.put('before', before);
end $$;
\ir ../../supabase/migrations/0196_budget_from_requirements.sql
do $$ declare after text; begin
  perform pg_temp.su();
  select string_agg(id::text || coalesce(requirement_key, '-') || coalesce(priority, '-') || estimated::text || coalesce(quoted::text, '-') || coalesce(vendor_id::text, '-'), ',' order by id) into after from public.event_costs;
  perform pg_temp.res('14 re-running 0196 changes no row', after is not distinct from pg_temp.get('before'), 'rows changed');
end $$;

select name, result from _bp order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'BUDGET-PLAN-0196: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'BUDGET-PLAN-0196: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _bp;
rollback;
