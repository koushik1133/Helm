-- r60-db-hardening-0301.sql -- r60 (database audit 2026-10-28): I-05 anon loses table privileges on the 60 studio
-- tables (signed-out pages keep working through their link RPCs), I-06 the kept upload-guard copies are not callable
-- by the app (the live guard still works for anon), I-07 layouts_quarantined_count is Helm HQ only, and a layout /
-- saved view written for ANOTHER studio (or another owner) is refused instead of silently rewritten.
-- Re-creates the production grants first (hosted Supabase gives anon every privilege on new tables), re-applies 0301
-- twice (re-run safe). Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _t60(t text primary key); grant all on _t60 to anon, authenticated, service_role;
insert into _t60 select unnest(array[
  'app_config', 'audit_log', 'chair_types', 'change_requests', 'chat_conversations', 'chat_members',
  'chat_messages', 'chat_reactions', 'checklist_templates', 'crew_members', 'design_stages', 'dish_catalog',
  'event_attendees', 'event_checklist', 'event_costs', 'event_day', 'event_discovery', 'event_files',
  'event_guests', 'event_issues', 'event_media', 'event_menu_items', 'event_plan', 'event_proposal',
  'event_ratings', 'event_refunds', 'event_requirements', 'event_resource_needs', 'event_resources',
  'event_stock_requests', 'event_tasks', 'expense_claims', 'inventory_checkouts', 'inventory_items',
  'inventory_reservations', 'layout_rules', 'lead_archive', 'leads', 'menu_templates', 'notification_seen',
  'notifications', 'nurture', 'nurture_automation', 'nurture_templates', 'organizations', 'payment_milestones',
  'plate_types', 'proposal_risks', 'quotation_versions', 'quote_consents', 'quote_otps', 'quote_payments',
  'quote_versions', 'quotes', 'role_access', 'run_sheet_items', 'task_templates', 'vendor_bills', 'vendors',
  'work_tokens']);

-- ---- the production state before 0301 (what the audit found) ----------------------------------------------------
do $$ declare t text; begin
  for t in select x.t from _t60 x where to_regclass('public.' || x.t) is not null loop
    execute format('grant all on table public.%I to anon', t);
  end loop;
  grant execute on function public.storage_object_name_ok__pre0069(text, text) to anon, authenticated;
  grant execute on function public.storage_object_name_ok__pre0256(text, text) to anon, authenticated;
end $$;
-- what signed-in / service callers hold before (must be unchanged after)
create temp table _before as
  select x.t, r.r, p.p, has_table_privilege(r.r, ('public.' || x.t)::regclass, p.p) ok
    from _t60 x, (values ('authenticated'), ('service_role')) r(r), (values ('select'), ('insert'), ('update'), ('delete')) p(p)
   where to_regclass('public.' || x.t) is not null;

set client_min_messages = error;
\ir ../../supabase/migrations/0301_r60_db_hardening.sql
\ir ../../supabase/migrations/0301_r60_db_hardening.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text, p_aal text default 'aal1') returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"anon"}', false); perform set_config('role', 'anon', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: ' || coalesce(p_detail, '') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return coalesce(v, '<null>'); exception when others then return 'ERR ' || sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
grant execute on function pg_temp.uid(text) to anon, authenticated, service_role;

-- ================= I-05 ===========================================================================================
do $$ declare bad text; begin
  perform pg_temp.su();
  select string_agg(x.t, ', ' order by x.t) into bad from _t60 x
   where to_regclass('public.' || x.t) is not null
     and (has_table_privilege('anon', ('public.' || x.t)::regclass, 'select') or has_table_privilege('anon', ('public.' || x.t)::regclass, 'insert')
          or has_table_privilege('anon', ('public.' || x.t)::regclass, 'update') or has_table_privilege('anon', ('public.' || x.t)::regclass, 'delete')
          or has_table_privilege('anon', ('public.' || x.t)::regclass, 'truncate') or has_table_privilege('anon', ('public.' || x.t)::regclass, 'references')
          or has_table_privilege('anon', ('public.' || x.t)::regclass, 'trigger'));
  perform pg_temp.res('01 anon holds no privilege on any of the 60 tables', bad is null, bad);
  perform pg_temp.res('02 all 60 tables exist on this build', (select count(*) from _t60 x where to_regclass('public.' || x.t) is not null) = 60);
  select string_agg(b.t || ':' || b.r || ':' || b.p, ', ') into bad from _before b
   where b.ok is distinct from has_table_privilege(b.r, ('public.' || b.t)::regclass, b.p);
  perform pg_temp.res('03 signed-in + service_role table privileges unchanged on the 60 tables', bad is null, bad);
end $$;

do $$ declare e text; begin
  perform pg_temp.anon();
  e := pg_temp.try('select count(*) from public.quotes');
  perform pg_temp.res('04 anon direct read of quotes: plain permission denied for table', e like '42501%permission denied for table quotes%', e);
  e := pg_temp.try('select count(*) from public.quote_otps');
  perform pg_temp.res('05 anon direct read of quote_otps: permission denied', e like '42501%', e);
  e := pg_temp.try($q$insert into public.leads(org_id, name, status) values ('a0000000-0000-4000-8000-000000000001', 'anon lead', 'new')$q$);
  perform pg_temp.res('06 anon insert into leads: permission denied', e like '42501%', e);
  e := pg_temp.try($q$update public.organizations set name = 'x'$q$);
  perform pg_temp.res('07 anon update of organizations: permission denied', e like '42501%', e);
  e := pg_temp.try($q$delete from public.work_tokens$q$);
  perform pg_temp.res('08 anon delete from work_tokens: permission denied', e like '42501%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('0x anon direct', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- the signed-out pages still work (their link RPCs run as the table owner)
do $$ declare v text; begin
  perform pg_temp.anon();
  v := pg_temp.val($q$select public.public_get_portal('a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.res('09 anon client portal by link (public_get_portal) still answers the event', v like '%A-0001%' and v not like 'ERR%', v);
  v := pg_temp.val($q$select public.public_get_quote('a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.res('10 anon quote / approve page by link (public_get_quote) still answers', v not like 'ERR%' and v <> '<null>', v);
  v := pg_temp.val($q$select public.public_quote_paid_status('a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.res('11 anon paid status by link still answers', v not like 'ERR%', v);
  v := pg_temp.val($q$select public.public_payment_schedule('a0000000-0000-4000-8000-0000000000aa')::text$q$);
  perform pg_temp.res('12 anon payment schedule by link still answers', v not like 'ERR%', v);
  v := pg_temp.val($q$select public.public_pricing_plans()::text$q$);
  perform pg_temp.res('13 anon pricing page RPC still answers', v not like 'ERR%', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('0x anon rpc', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- signed-in members still read + write their own studio exactly as before
do $$ declare v text; e text; begin
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.val($q$select count(*)::text from public.quotes$q$);
  perform pg_temp.res('14 studio admin still reads own quotes (RLS unchanged)', v ~ '^[1-9][0-9]*$', v);
  e := pg_temp.try($q$insert into public.leads(org_id, name, status) values ('a0000000-0000-4000-8000-000000000001', 'r60 lead', 'new')$q$);
  perform pg_temp.res('15 studio admin still adds a lead', e = '', e);
  v := pg_temp.val($q$select count(*)::text from public.quotes where org_id = 'b0000000-0000-4000-8000-000000000001'$q$);
  perform pg_temp.res('16 studio admin still sees no other studio quote', v = '0', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('0x signed-in', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ================= I-06 ===========================================================================================
do $$ declare v text; e text; begin
  perform pg_temp.su();
  perform pg_temp.res('17 kept guard copies: no anon / authenticated execute',
    not has_function_privilege('anon', 'public.storage_object_name_ok__pre0069(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.storage_object_name_ok__pre0069(text,text)', 'execute')
    and not has_function_privilege('anon', 'public.storage_object_name_ok__pre0256(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.storage_object_name_ok__pre0256(text,text)', 'execute'));
  perform pg_temp.res('18 the live guard storage_object_name_ok stays callable by anon + signed-in',
    has_function_privilege('anon', 'public.storage_object_name_ok(text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.storage_object_name_ok(text,text)', 'execute'));
  perform pg_temp.res('19 no storage policy calls a kept copy by name',
    not exists (select 1 from pg_policies p where coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'storage_object_name_ok__pre'));
  perform pg_temp.anon();
  v := pg_temp.val($q$select public.storage_object_name_ok('task-proof',
         'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/a0000000-0000-4000-8000-000000000003/a0000000-0000-4000-8000-000000000004.jpg')::text$q$);
  perform pg_temp.res('20 anon crew-proof upload name check still runs through the copies (true)', v = 'true', v);
  v := pg_temp.val($q$select public.storage_object_name_ok('vendor-invoices', 'not-a-key')::text$q$);
  perform pg_temp.res('21 anon vendor-invoice bad name still false', v = 'false', v);
  e := pg_temp.try($q$select public.storage_object_name_ok__pre0256('task-proof', 'x')$q$);
  perform pg_temp.res('22 anon calling a kept copy directly: 42501', e like '42501%', e);
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$select public.storage_object_name_ok__pre0069('event-docs', 'x')$q$);
  perform pg_temp.res('23 signed-in calling a kept copy directly: 42501', e like '42501%', e);
  v := pg_temp.val($q$select public.storage_object_name_ok('event-docs',
         'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/0123456789abcdef0123456789abcdef.pdf')::text$q$);
  perform pg_temp.res('24 signed-in event-docs upload name in own studio still true', v = 'true', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rs values ('0x I-06', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ================= I-07 ===========================================================================================
do $$ declare v text; e text; begin
  perform pg_temp.su();
  insert into public.platform_admins(email, added_by) values ('r60hq@helm.events', 'test') on conflict do nothing;
  update public.platform_admins set role = 'owner', status = 'active' where email = 'r60hq@helm.events';
  if not exists (select 1 from auth.users where email = 'r60hq@helm.events') then perform auth.seed_user('r60hq@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'r60hq@helm.events';
  set local session_replication_role = replica;
  insert into public.layouts(name, data, org_id) values ('r60 quarantined', '{}'::jsonb, null);
  set local session_replication_role = origin;

  perform pg_temp.res('25 layouts_quarantined_count: anon has no execute', not has_function_privilege('anon', 'public.layouts_quarantined_count()', 'execute'));
  perform pg_temp.login('a_admin@a.test', 'aal2');
  e := pg_temp.try('select public.layouts_quarantined_count()');
  perform pg_temp.res('26 studio admin (even at aal2) gets 42501', e like '42501%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try('select public.layouts_quarantined_count()');
  perform pg_temp.res('27 studio sales member gets 42501', e like '42501%', e);
  perform pg_temp.login('r60hq@helm.events', 'aal1');
  e := pg_temp.try('select public.layouts_quarantined_count()');
  perform pg_temp.res('28 HQ staff without two-step gets 42501', e like '42501%', e);
  perform pg_temp.login('r60hq@helm.events', 'aal2');
  v := pg_temp.val('select public.layouts_quarantined_count()::text');
  perform pg_temp.res('29 HQ staff with two-step gets the number', v ~ '^[1-9][0-9]*$', v);
  perform pg_temp.su();
  v := pg_temp.val('select public.layouts_quarantined_count()::text');
  perform pg_temp.res('30 direct database session (SQL editor) still gets the number', v ~ '^[1-9][0-9]*$', v);
  perform pg_temp.res('31 previous body kept as layouts_quarantined_count__pre0301, not callable by the app',
    to_regprocedure('public.layouts_quarantined_count__pre0301()') is not null
    and not has_function_privilege('authenticated', 'public.layouts_quarantined_count__pre0301()', 'execute')
    and not has_function_privilege('anon', 'public.layouts_quarantined_count__pre0301()', 'execute'));
exception when others then perform pg_temp.su(); insert into _rs values ('0x I-07', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ================= layouts: another studio refused, own / none stamped ==============================================
do $$ declare e text; n int; begin
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try($q$insert into public.layouts(name, data) values ('r60 own none', '{}'::jsonb)$q$);
  perform pg_temp.res('32 layout with no studio given: saved (app path)', e = '', e);
  e := pg_temp.try($q$insert into public.layouts(name, data, org_id) values ('r60 own named', '{}'::jsonb, 'a0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('33 layout naming its own studio: saved', e = '', e);
  e := pg_temp.try($q$insert into public.layouts(name, data, org_id) values ('r60 forged', '{}'::jsonb, 'b0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('34 layout naming ANOTHER studio: refused 42501 (was silently moved)', e like '42501%own studio%', e);
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$insert into public.layouts(name, data, org_id) values ('r60 forged 2', '{}'::jsonb, 'b0000000-0000-4000-8000-000000000001')$q$);
  perform pg_temp.res('35 sales member naming another studio: refused 42501', e like '42501%', e);
  perform pg_temp.su();
  select count(*) into n from public.layouts where name in ('r60 own none', 'r60 own named') and org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('36 both own layouts landed in Studio A', n = 2, n::text);
  select count(*) into n from public.layouts where name like 'r60 forged%';
  perform pg_temp.res('37 no forged layout row anywhere', n = 0, n::text);
  e := pg_temp.try($q$insert into public.layouts(name, data, org_id) values ('r60 service', '{}'::jsonb, 'b0000000-0000-4000-8000-000000000001')$q$);
  select count(*) into n from public.layouts where name = 'r60 service' and org_id = 'b0000000-0000-4000-8000-000000000001';
  perform pg_temp.res('38 direct database session keeps the studio it names (no longer quarantined)', e = '' and n = 1, e || n);
  perform pg_temp.res('39 previous layouts trigger body kept as _layouts_stamp_org__pre0301, not callable; trigger still on the live function',
    to_regprocedure('public._layouts_stamp_org__pre0301()') is not null
    and not has_function_privilege('authenticated', 'public._layouts_stamp_org__pre0301()', 'execute')
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.layouts'::regclass and t.tgname = 'layouts_stamp_org'
                   and t.tgfoid = 'public._layouts_stamp_org()'::regprocedure));
exception when others then perform pg_temp.su(); insert into _rs values ('0x layouts', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- the built-in sample seed (layout for the caller's own studio) still works
do $$ declare n0 int; n1 int; e text; begin
  perform pg_temp.su();
  select count(*) into n0 from public.layouts where org_id = 'a0000000-0000-4000-8000-000000000001' and is_demo;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.uid('a_admin@a.test'), 'role', 'authenticated', 'aal', 'aal1')::text, false);
  begin
    perform public._demo_seed_ae('a0000000-0000-4000-8000-000000000001'); e := '';
  exception when others then e := sqlstate || ' ' || sqlerrm; end;
  perform pg_temp.su();
  select count(*) into n1 from public.layouts where org_id = 'a0000000-0000-4000-8000-000000000001' and is_demo;
  perform pg_temp.res('40 sample seed for the caller''s own studio still saves its layout there', e = '' and n1 = n0 + 1, e || ' ' || n0 || '->' || n1);
exception when others then perform pg_temp.su(); insert into _rs values ('0x seed', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

-- ================= saved_views: another studio / owner refused, app path unchanged ==================================
do $$ declare e text; n int; begin
  perform pg_temp.su(); delete from public.studio_subscriptions where org_id = 'a0000000-0000-4000-8000-000000000001';
  perform pg_temp.login('a_staff@a.test');
  e := pg_temp.try($q$insert into public.saved_views(page, name, state) values ('leads', 'r60 mine', '{}'::jsonb)$q$);
  perform pg_temp.res('41 saved view without studio / owner (the app path): saved', e = '', e);
  e := pg_temp.try(format($q$insert into public.saved_views(org_id, user_id, page, name) values ('a0000000-0000-4000-8000-000000000001', %L, 'leads', 'r60 explicit')$q$, pg_temp.uid('a_staff@a.test')));
  perform pg_temp.res('42 saved view naming own studio + self: saved', e = '', e);
  e := pg_temp.try(format($q$insert into public.saved_views(org_id, user_id, page, name) values ('b0000000-0000-4000-8000-000000000001', %L, 'leads', 'r60 forged')$q$, pg_temp.uid('b_staff@b.test')));
  perform pg_temp.res('43 saved view naming another studio: refused 42501 (was silently rewritten)', e like '42501%', e);
  e := pg_temp.try(format($q$insert into public.saved_views(user_id, page, name) values (%L, 'leads', 'r60 forged owner')$q$, pg_temp.uid('a_admin@a.test')));
  perform pg_temp.res('44 saved view naming another owner in the same studio: refused 42501', e like '42501%', e);
  e := pg_temp.try($q$update public.saved_views set name = 'r60 mine renamed' where name = 'r60 mine'$q$);
  perform pg_temp.res('45 renaming own saved view still works', e = '', e);
  perform pg_temp.su();
  select count(*) into n from public.saved_views where name in ('r60 mine renamed', 'r60 explicit')
     and org_id = 'a0000000-0000-4000-8000-000000000001' and user_id = pg_temp.uid('a_staff@a.test');
  perform pg_temp.res('46 own saved views landed in Studio A for the caller', n = 2, n::text);
  select count(*) into n from public.saved_views where name like 'r60 forged%';
  perform pg_temp.res('47 no forged saved view anywhere', n = 0, n::text);
  perform pg_temp.res('48 previous saved-view guard kept as tg_saved_views_guard__pre0301, not callable; trigger on the live function',
    to_regprocedure('public.tg_saved_views_guard__pre0301()') is not null
    and not has_function_privilege('authenticated', 'public.tg_saved_views_guard__pre0301()', 'execute')
    and exists (select 1 from pg_trigger t where t.tgrelid = 'public.saved_views'::regclass and t.tgname = 'saved_views_guard'
                   and t.tgfoid = 'public.tg_saved_views_guard()'::regprocedure));
exception when others then perform pg_temp.su(); insert into _rs values ('0x saved_views', 'FAIL: ' || sqlstate || ' ' || sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R60-DB-HARDENING-0301: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R60-DB-HARDENING-0301: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
