-- r21-target-margin-0242.sql -- 0242 get / set_studio_target_margin: one studio-wide target margin for the
-- Insights benchmarks. Access (insights or controls view to read, controls edit to write, admins always,
-- never anon / client), 0 to 90 validation, tenant scope, additive storage (pricing blob + other keys kept),
-- safe to re-apply. Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- re-apply the migration twice inside the test: create or replace must be idempotent
\ir ../../supabase/migrations/0242_studio_target_margin.sql
\ir ../../supabase/migrations/0242_studio_target_margin.sql
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;

do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; u uuid; c uuid;
begin
  perform pg_temp.su();
  u := coalesce((select id from auth.users where email = 'tm_viewer@a.test'), auth.seed_user('tm_viewer@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (u, 'tm_viewer@a.test', 'Margin Viewer', 'quality', a, false, now()) on conflict (id) do update set role = 'quality', org_id = a;
  c := coalesce((select id from auth.users where email = 'tm_client@a.test'), auth.seed_user('tm_client@a.test'));
  insert into public.profiles(id, email, full_name, role, org_id, must_change_password, created_at)
    values (c, 'tm_client@a.test', 'Portal Client', 'client', a, false, now()) on conflict (id) do update set role = 'client', org_id = a;
  delete from public.role_access where org_id = a and role in ('quality', 'sales', 'client');   -- test-only rows, rolled back
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('quality', 'insights', true, false, a, now());
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('client', 'insights', true, true, a, now()), ('client', 'controls', true, true, a, now());
  insert into public.app_config(org_id, key, value, updated_at) values (a, 'pricing', '{"chairPrice":111,"platePrice":222,"gstPct":18}', now())
    on conflict (org_id, key) do update set value = excluded.value;
exception when others then perform pg_temp.su(); insert into _uf values ('00 fixture', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

do $$ declare r jsonb; e text; pricing_before jsonb; a uuid := 'a0000000-0000-4000-8000-000000000001'; b uuid := 'b0000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.su();
  pricing_before := (select value from public.app_config where org_id = a and key = 'pricing');
  perform pg_temp.res('01 both functions security definer + empty search_path',
    (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) and count(*) = 2 from pg_proc p
      where p.oid in ('public.get_studio_target_margin()'::regprocedure, 'public.set_studio_target_margin(numeric)'::regprocedure)));
  perform pg_temp.res('02 anon no, authenticated yes (both)',
    not has_function_privilege('anon', 'public.get_studio_target_margin()', 'execute')
    and not has_function_privilege('anon', 'public.set_studio_target_margin(numeric)', 'execute')
    and has_function_privilege('authenticated', 'public.get_studio_target_margin()', 'execute')
    and has_function_privilege('authenticated', 'public.set_studio_target_margin(numeric)', 'execute'));
  perform pg_temp.anon();
  e := pg_temp.try($q$select public.get_studio_target_margin()$q$) || pg_temp.try($q$select public.set_studio_target_margin(20)$q$);
  perform pg_temp.res('03 anon refused (read + write)', e like '42501%42501%', e);

  perform pg_temp.login('a_admin@a.test');
  r := public.get_studio_target_margin();
  perform pg_temp.res('04 admin, nothing saved: null target, default 30, can_edit',
    r -> 'target_margin_pct' = 'null'::jsonb and (r ->> 'default_pct')::int = 30 and (r ->> 'can_edit')::boolean, r::text);
  r := public.set_studio_target_margin(25);
  perform pg_temp.res('05 admin saves 25 for the studio', (r ->> 'target_margin_pct')::numeric = 25 and (r ->> 'can_edit')::boolean, r::text);
  r := public.set_studio_target_margin(27.55);
  perform pg_temp.res('06 kept to 1 decimal (27.55 -> 27.6)', (r ->> 'target_margin_pct')::numeric = 27.6, r::text);
  e := pg_temp.try($q$select public.set_studio_target_margin(-1)$q$);
  perform pg_temp.res('07a below 0 refused (22023)', e like '22023%', e);
  e := pg_temp.try($q$select public.set_studio_target_margin(90.5)$q$);
  perform pg_temp.res('07b above 90 refused (22023)', e like '22023%', e);
  e := pg_temp.try($q$select public.set_studio_target_margin('NaN'::numeric)$q$);
  perform pg_temp.res('07c NaN refused (22023)', e like '22023%', e);
  e := pg_temp.try($q$select public.set_studio_target_margin(null)$q$);
  perform pg_temp.res('07d null refused (22023)', e like '22023%', e);
  r := public.set_studio_target_margin(0); r := public.set_studio_target_margin(90);
  perform pg_temp.res('07e edges 0 and 90 accepted', (r ->> 'target_margin_pct')::numeric = 90, r::text);
  r := public.set_studio_target_margin(27.6);
  perform pg_temp.res('08 refused values left the saved value unchanged', (public.get_studio_target_margin() ->> 'target_margin_pct')::numeric = 27.6);

  perform pg_temp.login('tm_viewer@a.test');
  r := public.get_studio_target_margin();
  perform pg_temp.res('09 insights viewer reads the SAME studio value, cannot edit',
    (r ->> 'target_margin_pct')::numeric = 27.6 and not (r ->> 'can_edit')::boolean, r::text);
  e := pg_temp.try($q$select public.set_studio_target_margin(10)$q$);
  perform pg_temp.res('10 insights viewer cannot save (42501)', e like '42501%', e);

  perform pg_temp.login('a_staff@a.test');   -- sales: no insights, no controls rows (removed above)
  e := pg_temp.try($q$select public.get_studio_target_margin()$q$);
  perform pg_temp.res('11 role without insights / controls cannot read (42501)', e like '42501%', e);

  perform pg_temp.su();
  insert into public.role_access(role, area, can_view, can_edit, org_id, updated_at) values ('sales', 'controls', true, true, a, now());
  perform pg_temp.login('a_staff@a.test');
  r := public.set_studio_target_margin(33);
  perform pg_temp.res('12 Control Center editor (not admin) can save', (r ->> 'target_margin_pct')::numeric = 33 and (r ->> 'can_edit')::boolean, r::text);

  perform pg_temp.login('tm_client@a.test');
  e := pg_temp.try($q$select public.get_studio_target_margin()$q$) || ' | ' || pg_temp.try($q$select public.set_studio_target_margin(5)$q$);
  perform pg_temp.res('13 client portal user refused even with matrix rows', e like '42501%| 42501%', e);

  perform pg_temp.login('b_admin@b.test');
  r := public.get_studio_target_margin();
  perform pg_temp.res('14 studio B does not see studio A value', r -> 'target_margin_pct' = 'null'::jsonb, r::text);
  r := public.set_studio_target_margin(40);
  perform pg_temp.su();
  perform pg_temp.res('15 studio B save changes only studio B',
    (select (value ->> 'targetMarginPct')::numeric from public.app_config where org_id = a and key = 'insights') = 33
    and (select (value ->> 'targetMarginPct')::numeric from public.app_config where org_id = b and key = 'insights') = 40);
  perform pg_temp.res('16 pricing settings blob untouched',
    (select value from public.app_config where org_id = a and key = 'pricing') = pricing_before, pricing_before::text);

  update public.app_config set value = value || '{"keepMe":1}'::jsonb where org_id = a and key = 'insights';
  perform pg_temp.login('a_admin@a.test');
  r := public.set_studio_target_margin(35);
  perform pg_temp.su();
  perform pg_temp.res('17 save merges: other keys in the row are kept',
    (select value from public.app_config where org_id = a and key = 'insights') = '{"keepMe":1,"targetMarginPct":35}'::jsonb,
    (select value::text from public.app_config where org_id = a and key = 'insights'));
  update public.app_config set value = '{"targetMarginPct":150}' where org_id = a and key = 'insights';
  perform pg_temp.login('a_admin@a.test');
  r := public.get_studio_target_margin();
  perform pg_temp.res('18 a hand-edited out-of-range value reads as not set', r -> 'target_margin_pct' = 'null'::jsonb, r::text);
  perform pg_temp.su();
  perform pg_temp.res('19 one row per studio, nothing else written',
    (select count(*) from public.app_config where key = 'insights' and org_id in (a, b)) = 2);
exception when others then perform pg_temp.su(); insert into _uf values ('2x run', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-TARGET-MARGIN-0242: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-TARGET-MARGIN-0242: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
