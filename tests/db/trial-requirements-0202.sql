-- trial-requirements-0202.sql -- 0202: the sample events carry the client's requirements (Must-have /
-- Nice-to-have / Optional). The master's 7 events have them, the manifest published once (current + 1)
-- carries them, a brand-new free trial signed up through the REAL RPC (as the app role) gets them on its
-- own events (new ids, own studio, no master id), "Clear demo data" removes them with the sample events,
-- an existing trial on the previous manifest gets them from APPLY-0178-refresh-trials.sql, paid studios
-- are untouched and a re-run changes nothing. Rolled back. Local disposable PG only.
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
create or replace function pg_temp.signup(p_email text, p_name text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.su(); perform auth.seed_user(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial(p_name, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); perform pg_temp.put(p_email, r::text);
  return r;
end $$;
-- requirements the trial user SEES (RLS, as the app role), as "event title | service | priority | qty"
create or replace function pg_temp.seen(p_email text) returns jsonb language plpgsql as $$
declare j jsonb; begin
  perform pg_temp.login(p_email);
  select jsonb_build_object('n', count(*), 'events', count(distinct r.quote_id),
           'sig', string_agg(q.title || '|' || r.service || '|' || r.priority || '|' || coalesce(r.qty::text, '-'), ';' order by q.title, r.service))
    into j from public.event_requirements r join public.quotes q on q.id = r.quote_id;
  perform pg_temp.su();
  return j;
end $$;
create or replace function pg_temp.master_sig() returns text language sql as $$
  select string_agg(q.title || '|' || r.service || '|' || r.priority || '|' || coalesce(r.qty::text, '-'), ';' order by q.title, r.service)
    from public.event_requirements r join public.quotes q on q.id = r.quote_id
   where r.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' $$;

do $$ begin perform pg_temp.su(); end $$;
update public.helm_sample_template set active = true where id;
-- the paid fixture studios get requirements of their own; they must never change
insert into public.event_requirements (quote_id, service, priority, qty, note)
values ('a0000000-0000-4000-8000-00000000da01', 'Paid A: Photography', 'mandatory', 2, 'own row'),
       ('b0000000-0000-4000-8000-00000000da01', 'Paid B: Catering', 'nice', 80, 'own row');
select pg_temp.put('paid_before', (select string_agg(id || '|' || org_id || '|' || service || '|' || priority || '|' || coalesce(qty::text, '') || '|' || coalesce(note, ''), ';' order by id)
  from public.event_requirements where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')));

-- ---- 0x: installed + master + manifest ------------------------------------------------------------
do $$ declare t text[] := public._sample_clone_tables(); m public.helm_trial_seed_manifest; begin
  select * into m from public.helm_trial_seed_manifest x where x.is_current;
  perform pg_temp.res('01 clone list has event_requirements after quotes (+ every 0169 table kept)',
    array_position(t, 'event_requirements') > array_position(t, 'quotes')
    and t @> array['venues', 'vendors', 'crew_members', 'dish_catalog', 'inventory_items', 'menu_templates', 'item_rate_cards',
                   'checklist_templates', 'task_templates', 'coupons', 'studio_layout_templates', 'leads', 'quotes', 'quote_versions',
                   'event_discovery', 'payment_milestones', 'quote_payments', 'event_checklist', 'event_tasks', 'run_sheet_items',
                   'inventory_reservations', 'event_costs', 'event_closure', 'nurture'] and array_length(t, 1) = 25, t::text);
  perform pg_temp.res('02 master: all 7 sample events have 4-7 requirements; all 3 priorities used',
    (select count(*) from public.quotes q where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null) = 7
    and not exists (select 1 from public.quotes q where q.org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and q.deleted_at is null
                      and (select count(*) from public.event_requirements r where r.quote_id = q.id) not between 4 and 7)
    and (select count(distinct priority) from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 3
    and (select count(*) from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 41);
  perform pg_temp.res('03 service names match the quote step 3 suggestions (Decor with e-acute)',
    exists (select 1 from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001' and service = 'D' || chr(233) || 'cor & flowers')
    and not exists (select 1 from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001'
                      and service not in ('Catering', 'D' || chr(233) || 'cor & flowers', 'Stage & lighting', 'Photography', 'Videography',
                                          'Entertainment / DJ', 'Transport', 'Sound / PA', 'LED wall / screens', 'Security', 'Valet parking')));
  perform pg_temp.res('04 the 0202 manifest is current, published once, = previous + 1, carries the 41 rows',
    m.notes = public._a202_manifest_note()
    and (select count(*) from public.helm_trial_seed_manifest where notes = public._a202_manifest_note()) = 1
    and m.version = (select max(version) from public.helm_trial_seed_manifest where version < m.version) + 1
    and jsonb_array_length(m.payload #> '{tables,event_requirements}') = 41 and (m.counts ->> 'event_requirements')::int = 41
    and jsonb_array_length(m.payload #> '{tables,quotes}') = 7, m.version::text || ' ' || coalesce(m.notes, ''));
  perform pg_temp.res('05 the 0182 builder prices are still in the new manifest',
    m.payload #> '{studio,pricing,assetPrices}' @> public._a182_owner_asset_prices() and m.payload #>> '{studio,pricing,chairPrice}' = '100');
  perform pg_temp.res('06 app roles cannot run the 0202 helpers',
    not has_function_privilege('authenticated', 'public._a202_sample_requirements()', 'execute')
    and not has_function_privilege('anon', 'public._a202_sample_requirements()', 'execute')
    and not has_function_privilege('authenticated', 'public._a202_manifest_note()', 'execute')
    and not has_function_privilege('authenticated', 'public._sample_clone_tables()', 'execute'));
exception when others then perform pg_temp.su(); insert into _uf values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1x: a brand-new free trial gets the requirements ---------------------------------------------
do $$ begin perform pg_temp.signup('tr202_new@t.test', 'Nova Events');
exception when others then perform pg_temp.su(); insert into _uf values ('signup new', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare r jsonb := pg_temp.get('tr202_new@t.test')::jsonb; a uuid; j jsonb; begin
  a := (r ->> 'org_id')::uuid;
  perform pg_temp.res('10 sign-up cloned the current (0202) manifest', r ->> 'result' = 'started' and (r #>> '{seed,cloned}')::boolean
    and (r #>> '{seed,version}')::int = (select version from public.helm_trial_seed_manifest where is_current)
    and (r #>> '{seed,counts,event_requirements}')::int = 41, r::text);
  j := pg_temp.seen('tr202_new@t.test');
  perform pg_temp.res('11 the trial user sees 41 requirements on all 7 sample events, same as the master',
    (j ->> 'n')::int = 41 and (j ->> 'events')::int = 7 and j ->> 'sig' = pg_temp.master_sig(), j::text);
  perform pg_temp.res('12 every requirement is on one of the trial''s own events, own studio, new id, no creator',
    not exists (select 1 from public.event_requirements r where r.org_id = a
                  and (r.created_by is not null or not exists (select 1 from public.quotes q where q.id = r.quote_id and q.org_id = a and q.is_demo)
                       or r.id::text like 'a5a5a5a5-%' or r.quote_id::text like 'a5a5a5a5-%'))
    and (select count(*) from public.event_requirements where org_id = a) = 41);
  perform pg_temp.res('15 the trial''s sample events carry budget + guests on the quote wherever the lead has them (0199 rule)',
    (select count(*) from public.quotes q where q.org_id = a and nullif(btrim(coalesce(q.client ->> 'budget', '')), '') is not null) = 7
    and not exists (select 1 from public.quotes q join public.leads l on l.quote_id = q.id and l.org_id = q.org_id where q.org_id = a
                      and ((l.budget is not null and nullif(btrim(coalesce(q.client ->> 'budget', '')), '') is null)
                        or (l.guest_count is not null and nullif(btrim(coalesce(q.client ->> 'guests', '')), '') is null))),
    (select string_agg(q.title || '=' || coalesce(q.client ->> 'budget', '-') || '/' || coalesce(q.client ->> 'guests', '-'), '; ') from public.quotes q where q.org_id = a));
  perform pg_temp.res('13 master rows unchanged by the clone', (select count(*) from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 41);
exception when others then perform pg_temp.su(); insert into _uf values ('1x new trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- a trial member can add an own requirement to a sample event (quote step 3), Budget reads them (RLS)
do $$ declare a uuid := (pg_temp.get('tr202_new@t.test')::jsonb ->> 'org_id')::uuid; q uuid; n integer; begin
  select id into q from public.quotes where org_id = a and title like '%Wedding%' limit 1;
  perform pg_temp.login('tr202_new@t.test');
  insert into public.event_requirements (quote_id, service, priority) values (q, 'Fireworks', 'optional');
  select count(*) into n from public.event_requirements where quote_id = q;
  perform pg_temp.su();
  perform pg_temp.res('14 trial user adds a requirement + reads its event''s list (8)', n = 8, n::text);
exception when others then perform pg_temp.su(); insert into _uf values ('14 own add', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2x: Clear demo data removes the sample requirements with the sample events -----------------
do $$ declare a uuid := (pg_temp.get('tr202_new@t.test')::jsonb ->> 'org_id')::uuid; begin
  perform public._demo_clear(a);
  perform pg_temp.res('20 clear demo data: the sample events and all their requirements are gone',
    not exists (select 1 from public.quotes q where q.org_id = a and q.is_demo)
    and (select count(*) from public.event_requirements where org_id = a) = 0, (select count(*) from public.event_requirements where org_id = a)::text);
  perform pg_temp.res('21 master + paid studios untouched by the clear',
    (select count(*) from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 41
    and (select string_agg(id || '|' || org_id || '|' || service || '|' || priority || '|' || coalesce(qty::text, '') || '|' || coalesce(note, ''), ';' order by id)
           from public.event_requirements where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')) = pg_temp.get('paid_before'));
exception when others then perform pg_temp.su(); insert into _uf values ('2x clear', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3x: an EXISTING trial cloned from the previous manifest (no requirements) -> REFRESH-0178 -----
do $$ begin perform pg_temp.signup('tr202_old@t.test', 'Old Trial Events');
exception when others then perform pg_temp.su(); insert into _uf values ('signup old', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
do $$ declare a uuid := (pg_temp.get('tr202_old@t.test')::jsonb ->> 'org_id')::uuid; begin
  -- what a trial cloned before 0202 looks like: previous manifest version, no requirement rows
  delete from public.event_requirements where org_id = a;
  update public.organizations set sample_version = sample_version - 1 where id = a;
  perform pg_temp.put('old_org', a::text);
exception when others then perform pg_temp.su(); insert into _uf values ('30 old setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;
\o /dev/null
\i supabase/APPLY-0178-refresh-trials.sql
\o
do $$ declare a uuid := pg_temp.get('old_org')::uuid; j jsonb; begin
  j := pg_temp.seen('tr202_old@t.test');
  perform pg_temp.res('30 refresh: the existing trial is on the current manifest with all 41 requirements',
    (select sample_version from public.organizations where id = a) = (select version from public.helm_trial_seed_manifest where is_current)
    and (j ->> 'n')::int = 41 and (j ->> 'events')::int = 7 and j ->> 'sig' = pg_temp.master_sig(), j::text);
  perform pg_temp.res('31 paid studios'' requirements byte-identical after sign-ups, clear and refresh',
    (select string_agg(id || '|' || org_id || '|' || service || '|' || priority || '|' || coalesce(qty::text, '') || '|' || coalesce(note, ''), ';' order by id)
       from public.event_requirements where org_id in ('a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001')) = pg_temp.get('paid_before'));
exception when others then perform pg_temp.su(); insert into _uf values ('3x refresh', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4x: re-running 0202 changes nothing (marker), an owner edit in the master is kept --------------
do $$ declare v integer := (select version from public.helm_trial_seed_manifest where is_current); begin
  perform pg_temp.put('ver_before', v::text);
  update public.event_requirements set note = 'owner edit' where id = 'a5a5a5a5-0202-4000-8000-000000000101';
end $$;
\o /dev/null
\i supabase/migrations/0202_trial_sample_requirements.sql
\o
do $$ begin
  perform pg_temp.res('40 re-run: no new manifest, no new master row, owner edit kept',
    (select version from public.helm_trial_seed_manifest where is_current)::text = pg_temp.get('ver_before')
    and (select count(*) from public.helm_trial_seed_manifest where notes = public._a202_manifest_note()) = 1
    and (select count(*) from public.event_requirements where org_id = 'a5a5a5a5-0166-4000-8000-000000000001') = 41
    and (select note from public.event_requirements where id = 'a5a5a5a5-0202-4000-8000-000000000101') = 'owner edit');
exception when others then perform pg_temp.su(); insert into _uf values ('4x rerun', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-REQUIREMENTS-0202: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-REQUIREMENTS-0202: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
