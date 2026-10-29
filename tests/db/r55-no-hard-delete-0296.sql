-- r55-no-hard-delete-0296.sql -- 0296: events (quotes), their version history / invitation website and the master lists
-- the screens only switch off (vendors, staff, stock, packages, dishes, chair / plate types, coupons) can't be
-- hard-deleted any more - not through the API (even by an admin, even from the Deleted shelf), not by hand without a
-- purge mark. The shelf (soft delete) / deactivate still work; the trial purge (0184 mark) and "clear sample data"
-- still delete; a studio delete is skipped + logged; TRUNCATE refused; the screens' own hard deletes unchanged.
-- run-all pins helm.allow_purge=on for the older suites; this suite turns it off first.
-- Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _r55(name text, result text); grant all on _r55 to anon, authenticated, service_role;
create temp table _r55kv(k text primary key, v text); grant all on _r55kv to anon, authenticated, service_role;

-- re-apply twice (proves a re-run is safe)
set client_min_messages = error;
\ir ../../supabase/migrations/0296_r55_no_accidental_deletes.sql
\ir ../../supabase/migrations/0296_r55_no_accidental_deletes.sql
set client_min_messages = warning;

-- the real rule from here on: no purge mark in this session
do $$ begin
  perform set_config('helm.allow_purge', '', false); perform set_config('helm.allow_org_purge', '', false);
  perform set_config('helm.trial_purge_org', '', false);
end $$;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claims', '', false); end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _r55 values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
-- run one statement; '' = ok, else "SQLSTATE hint message"; row count in _r55kv('n')
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare n bigint; h text; begin
  execute p_sql; get diagnostics n = row_count;
  insert into _r55kv values ('n', n::text) on conflict (k) do update set v = excluded.v;
  return '';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return sqlstate || ' ' || coalesce(h, '') || ' ' || sqlerrm;
end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.n() returns bigint language sql as $$ select v::bigint from _r55kv where k = 'n' $$;
grant execute on function pg_temp.n() to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _r55kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.id(p_k text) returns uuid language sql as $$ select v::uuid from _r55kv where k = p_k $$;
grant execute on function pg_temp.id(text) to anon, authenticated, service_role;

-- ---- fixtures (Studio A / B from 10-fixtures) ------------------------------------------------------------------
do $$
declare orgA uuid := 'a0000000-0000-4000-8000-000000000001'; orgB uuid := 'b0000000-0000-4000-8000-000000000001';
        q uuid; v uuid;
begin
  perform pg_temp.su();
  insert into public.quotes(org_id, code, title) values (orgA, 'R55-SHELF', 'r55 shelved') returning id into q;
  update public.quotes set deleted_at = now() where id = q;
  perform pg_temp.put('shelved', q::text);
  insert into public.quotes(org_id, code, title) values (orgA, 'R55-LIVE', 'r55 live') returning id into q;
  perform pg_temp.put('live', q::text);
  insert into public.quotes(org_id, code, title) values (orgB, 'R55-B', 'r55 B') returning id into q;
  perform pg_temp.put('qb', q::text);
  insert into public.quotes(org_id, code, title, is_demo) values (orgA, 'R55-DEMO', 'r55 sample', true) returning id into q;
  perform pg_temp.put('demo', q::text);
  insert into public.vendors(org_id, name) values (orgA, 'R55 vendor') returning id into v; perform pg_temp.put('vendor', v::text);
  insert into public.vendors(org_id, name, is_demo) values (orgA, 'R55 sample vendor', true) returning id into v; perform pg_temp.put('dvendor', v::text);
  insert into public.crew_members(org_id, name, phone) values (orgA, 'R55 crew', '+919800000055') returning id into v; perform pg_temp.put('crew', v::text);
  -- event_sites' own trigger needs the studio in context (claims only, still superuser)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', (select id from auth.users where email = 'a_admin@a.test'), 'role', 'authenticated')::text, false);
  insert into public.event_sites(org_id, quote_id, slug) values (orgA, pg_temp.id('live'), 'r55-site-' || substr(md5(random()::text), 1, 8))
    returning id into v; perform pg_temp.put('site', v::text);
  insert into public.layouts(org_id, name, data) values (orgA, 'R55 layout', '{}'::jsonb) returning id into v; perform pg_temp.put('layout', v::text);
  perform pg_temp.su();
  insert into public.event_tasks(org_id, quote_id, category, title) values (orgA, pg_temp.id('live'), 'setup', 'R55 task')
    returning id into v; perform pg_temp.put('task', v::text);
  insert into public.leads(org_id, name) values (orgA, 'R55 lead') returning id into v; perform pg_temp.put('lead', v::text);
  insert into public.event_guests(org_id, quote_id, label) values (orgA, pg_temp.id('live'), 'R55 guest') returning id into v; perform pg_temp.put('guest', v::text);
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values ('e5500000-0000-4000-8000-000000000055', 'R55 empty studio', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()),
           ('e5500000-0000-4000-8000-000000000056', 'R55 empty studio 2', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now());
end $$;

-- ---- 1) installed --------------------------------------------------------------------------------------------
do $$ declare n int; begin
  perform pg_temp.su();
  select count(*) into n from pg_trigger g where g.tgname = 'zzzzz_r55_no_hard_delete' and not g.tgisinternal
     and g.tgrelid::regclass::text in ('quotes', 'quote_versions', 'quotation_versions', 'event_sites', 'vendors', 'crew_members',
                                       'inventory_items', 'menu_templates', 'event_tasks');
  perform pg_temp.res('01 row guard on all 9 tables', n = 9, n::text);
  select count(*) into n from pg_trigger g where g.tgname = 'a0_r55_no_truncate' and not g.tgisinternal;
  perform pg_temp.res('02 TRUNCATE guard on the 9 tables + organizations', n = 10, n::text);
  perform pg_temp.res('03 studio delete guard on organizations',
    exists (select 1 from pg_trigger where tgname = 'a0_r55_org_delete_guard' and tgrelid = 'public.organizations'::regclass));
  perform pg_temp.res('04 the row guard fires last (0026 money / read-only / trial-limit refusals keep their messages)',
    not exists (select 1 from pg_trigger g join pg_trigger m on m.tgrelid = g.tgrelid and not m.tgisinternal
                 and (m.tgtype & 8) = 8 and (m.tgtype & 2) = 2 and m.tgname > g.tgname
                 where g.tgname = 'zzzzz_r55_no_hard_delete'));
  perform pg_temp.res('05 nothing removed: the 0042 shelf policy and the 0049 grants are untouched',
    exists (select 1 from pg_policy where polrelid = 'public.quotes'::regclass and polname = 'a42 quotes delete from shelf')
    and has_table_privilege('authenticated', 'public.quotes', 'DELETE'));
end $$;

-- ---- 2) API (signed-in admin) ------------------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('shelved')));
  perform pg_temp.su();
  perform pg_temp.res('06 admin API hard delete of a SHELVED quote refused (42501 r55_no_hard_delete), row kept',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.quotes where id = pg_temp.id('shelved')), r);

  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('live')));
  perform pg_temp.su();
  perform pg_temp.res('07 admin API delete of a live quote removes nothing',
    (r = '' and pg_temp.n() = 0 or r like '42501%') and exists (select 1 from public.quotes where id = pg_temp.id('live')), r);

  -- even if an API session somehow carried every purge mark, a direct delete as authenticated is refused
  perform pg_temp.login('a_admin@a.test');
  perform set_config('helm.allow_purge', 'on', false); perform set_config('helm.allow_org_purge', 'on', false);
  perform set_config('helm.trial_purge_org', 'a0000000-0000-4000-8000-000000000001', false);
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('shelved')));
  perform pg_temp.su();
  perform set_config('helm.allow_purge', '', false); perform set_config('helm.allow_org_purge', '', false);
  perform set_config('helm.trial_purge_org', '', false);
  perform pg_temp.res('08 purge marks never help a direct API delete (role authenticated)',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.quotes where id = pg_temp.id('shelved')), r);

  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.vendors where id = %L', pg_temp.id('vendor')));
  perform pg_temp.su();
  perform pg_temp.res('09 admin API hard delete of a vendor refused, row kept',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.vendors where id = pg_temp.id('vendor')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.crew_members where id = %L', pg_temp.id('crew')));
  perform pg_temp.su();
  perform pg_temp.res('10 admin API hard delete of a staff member refused, row kept',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.crew_members where id = pg_temp.id('crew')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.event_sites where id = %L', pg_temp.id('site')));
  perform pg_temp.su();
  perform pg_temp.res('11 admin API hard delete of an invitation website refused, row kept',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.event_sites where id = pg_temp.id('site')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('delete from public.event_tasks where id = %L', pg_temp.id('task')));
  perform pg_temp.su();
  perform pg_temp.res('11b admin API hard delete of a crew assignment (event_tasks) refused, row kept',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.event_tasks where id = pg_temp.id('task')), r);
end $$;

-- ---- 3) soft delete / deactivate (what the screens do) still work ------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('select public.move_quote_to_shelf(%L, %L)', pg_temp.id('live'), 'delete'));
  perform pg_temp.su();
  perform pg_temp.res('12 Delete (move to the Deleted shelf) still works',
    r = '' and (select deleted_at is not null from public.quotes where id = pg_temp.id('live')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('select public.restore_quote_from_shelf(%L)', pg_temp.id('live')));
  perform pg_temp.su();
  perform pg_temp.res('13 Restore from the shelf still works',
    r = '' and (select deleted_at is null from public.quotes where id = pg_temp.id('live')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('update public.vendors set active = false where id = %L', pg_temp.id('vendor')));
  perform pg_temp.su();
  perform pg_temp.res('14 vendor remove (active = false) still works',
    r = '' and not (select active from public.vendors where id = pg_temp.id('vendor')), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try(format('update public.crew_members set active = false where id = %L', pg_temp.id('crew')));
  perform pg_temp.su();
  perform pg_temp.res('15 staff deactivate still works',
    r = '' and not (select active from public.crew_members where id = pg_temp.id('crew')), r);
end $$;

-- ---- 4) the screens' own hard deletes are unchanged -------------------------------------------------------------
do $$ declare r1 text; r2 text; r3 text; n1 bigint; n2 bigint; n3 bigint; begin
  perform pg_temp.login('a_admin@a.test');
  r1 := pg_temp.try(format('delete from public.leads where id = %L', pg_temp.id('lead'))); n1 := pg_temp.n();
  r2 := pg_temp.try(format('delete from public.layouts where id = %L', pg_temp.id('layout'))); n2 := pg_temp.n();
  r3 := pg_temp.try(format('delete from public.event_guests where id = %L', pg_temp.id('guest'))); n3 := pg_temp.n();
  perform pg_temp.su();
  perform pg_temp.res('16 leads / layouts / guests: the screens'' hard deletes still work',
    r1 = '' and n1 = 1 and r2 = '' and n2 = 1 and r3 = '' and n3 = 1, r1 || '|' || r2 || '|' || r3 || ' ' || n1 || n2 || n3);
end $$;

-- ---- 5) by hand (SQL editor = owner role) -------------------------------------------------------------------------
do $$ declare r text; begin
  perform pg_temp.su();
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('shelved')));
  perform pg_temp.res('17 SQL editor delete without a mark refused',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.quotes where id = pg_temp.id('shelved')), r);
  perform set_config('helm.allow_purge', 'b0000000-0000-4000-8000-000000000001', false);
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('shelved')));
  perform pg_temp.res('18 a mark for ANOTHER studio does not help',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.quotes where id = pg_temp.id('shelved')), r);
  -- the 0184 trial purge mark: this studio only
  perform set_config('helm.allow_purge', '', false);
  perform set_config('helm.trial_purge_org', 'a0000000-0000-4000-8000-000000000001', false);
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('qb')));
  perform pg_temp.res('19 trial purge mark for Studio A never deletes a Studio B event',
    r like '42501 r55_no_hard_delete%' and exists (select 1 from public.quotes where id = pg_temp.id('qb')), r);
  r := pg_temp.try(format('delete from public.quotes where id = %L', pg_temp.id('shelved')));
  perform pg_temp.res('20 trial purge mark for Studio A deletes Studio A''s event (0184 unchanged)',
    r = '' and not exists (select 1 from public.quotes where id = pg_temp.id('shelved')), r);
  perform set_config('helm.trial_purge_org', '', false);
  r := pg_temp.try('truncate public.quotes cascade');
  perform pg_temp.res('21 TRUNCATE quotes refused', r like '42501 r55_no_hard_delete%', r);
  r := pg_temp.try('truncate public.organizations cascade');
  perform pg_temp.res('22 TRUNCATE organizations refused (cascade included)', r like '42501 r55_no_hard_delete%'
    and exists (select 1 from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'), r);
end $$;

-- ---- 6) studios -----------------------------------------------------------------------------------------------------
do $$ declare r text; n0 bigint; begin
  perform pg_temp.su();
  select count(*) into n0 from public.audit_log where action = 'studio.delete_refused';
  r := pg_temp.try($q$delete from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'$q$);
  perform pg_temp.res('23 studio delete without a mark: skipped (0 rows), studio kept',
    r = '' and pg_temp.n() = 0 and exists (select 1 from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'), r);
  perform pg_temp.res('24 the attempt is in audit_log (studio.delete_refused, name + who)',
    (select count(*) from public.audit_log where action = 'studio.delete_refused') = n0 + 1
    and exists (select 1 from public.audit_log where action = 'studio.delete_refused' and entity = 'organizations'
                  and entity_id = 'e5500000-0000-4000-8000-000000000055' and changed ->> 'name' = 'R55 empty studio'));
  perform set_config('helm.allow_purge', 'on', false);
  r := pg_temp.try($q$delete from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'$q$);
  perform set_config('helm.allow_purge', '', false);
  perform pg_temp.res('25 the row mark (helm.allow_purge) is not enough for a studio',
    pg_temp.n() = 0 and exists (select 1 from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'), r);
  -- (a refused studio keeps its audit row, which itself holds the studio - so the allowed case uses a second empty one)
  perform set_config('helm.allow_org_purge', 'e5500000-0000-4000-8000-000000000056', false);
  r := pg_temp.try($q$delete from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'$q$);
  perform pg_temp.res('26 a studio mark for ANOTHER studio does not help', pg_temp.n() = 0
    and exists (select 1 from public.organizations where id = 'e5500000-0000-4000-8000-000000000055'), r);
  r := pg_temp.try($q$delete from public.organizations where id = 'e5500000-0000-4000-8000-000000000056'$q$);
  perform set_config('helm.allow_org_purge', '', false);
  perform pg_temp.res('26b with helm.allow_org_purge = that studio the (empty) studio is deleted',
    r = '' and not exists (select 1 from public.organizations where id = 'e5500000-0000-4000-8000-000000000056'), r);
  perform pg_temp.login('a_admin@a.test');
  r := pg_temp.try($q$delete from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.su();
  perform pg_temp.res('27 admin API studio delete removes nothing',
    exists (select 1 from public.organizations where id = 'a0000000-0000-4000-8000-000000000001'), r);
end $$;

-- ---- 7) "clear sample data" still clears (marks only its own studio) ---------------------------------------------
do $$ declare j jsonb; r text; begin
  perform pg_temp.su();
  r := pg_temp.try($q$select public._demo_clear('a0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('28 _demo_clear removes the sample event + sample vendor, keeps real rows',
    r = '' and not exists (select 1 from public.quotes where id = pg_temp.id('demo'))
    and not exists (select 1 from public.vendors where id = pg_temp.id('dvendor'))
    and exists (select 1 from public.quotes where id = pg_temp.id('live'))
    and exists (select 1 from public.vendors where id = pg_temp.id('vendor')), r);
  perform pg_temp.res('29 the mark is gone again afterwards', coalesce(current_setting('helm.allow_purge', true), '') = '');
  perform pg_temp.res('30 previous body kept once as _demo_clear__pre0296; neither callable by the app',
    to_regprocedure('public._demo_clear__pre0296(uuid)') is not null
    and not has_function_privilege('authenticated', 'public._demo_clear(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._demo_clear__pre0296(uuid)', 'execute')
    and not has_function_privilege('anon', 'public._demo_clear(uuid)', 'execute'));
  perform pg_temp.res('31 the studio-refusal logger is not callable by the app',
    not has_function_privilege('authenticated', 'public._r55_log_org_refusal(uuid,text,text)', 'execute')
    and not has_function_privilege('anon', 'public._r55_log_org_refusal(uuid,text,text)', 'execute'));
end $$;

select name, result from _r55 order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R55-NO-HARD-DELETE-0296: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R55-NO-HARD-DELETE-0296: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _r55;
rollback;
