-- trial-guards-0181.sql -- 0181: free-trial server guards. Trial studio: layout templates / event reminder days /
-- privacy PIN / "Send reminder now" refused, custom field definitions refused, catalog = prices only (no rename,
-- no on/off, no delete; a price edit keeps is_demo), creation cap = 2 created IN TOTAL. Paid studio: unchanged.
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
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.newuser(p_email); perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- a row written by Helm itself (no API claims, maintenance on): the app guards do not apply
create or replace function pg_temp.sys(p_sql text) returns text language plpgsql as $$
declare e text; begin
  perform pg_temp.su(); perform set_config('helm.maintenance', 'on', true);
  e := pg_temp.try(p_sql);
  perform set_config('helm.maintenance', 'off', true); return e;
end $$;

-- earlier suites in run-all re-apply older migrations (0096 / 0157 / 0129 / 0092 / 0173) over the wrappers:
-- re-run 0181 (also proves a re-run is safe)
\ir ../../supabase/migrations/0181_trial_guards.sql

-- ---- trial studio: wrapped settings RPCs ------------------------------------------------------------
do $$ declare o uuid; e text; ms uuid; begin
  o := pg_temp.trial('tg_trial@t.test'); perform pg_temp.put('o', o::text);
  perform pg_temp.res('01 trial studio is trial (subscription status)', public._is_trial_org(o)
    and (select status from public.studio_subscriptions where org_id = o) = 'trial');
  select id into ms from public.payment_milestones where org_id = o order by created_at limit 1;
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('select public.studio_template_save(null, ''{"name":"T","data":{"items":[]}}''::jsonb)');
  perform pg_temp.res('10 trial: save layout template refused', e like '42501%Not available in the free trial%', e);
  e := pg_temp.try(format('select public.studio_template_set_archived(%L, true)', gen_random_uuid()));
  perform pg_temp.res('11 trial: archive layout template refused', e like '42501%free trial%', e);
  e := pg_temp.try(format('select public.studio_template_set_default(%L, true)', gen_random_uuid()));
  perform pg_temp.res('12 trial: default layout template refused', e like '42501%free trial%', e);
  e := pg_temp.try(format('select public.studio_template_duplicate(%L)', gen_random_uuid()));
  perform pg_temp.res('13 trial: duplicate layout template refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.event_reminder_settings_set(5)');
  perform pg_temp.res('14 trial: event reminder days refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.privacy_pin_set(''0000'', ''1234'')');
  perform pg_temp.res('15 trial: privacy PIN change refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.privacy_pin_reset()');
  perform pg_temp.res('16 trial: privacy PIN reset refused', e like '42501%free trial%', e);
  e := pg_temp.try(format('select public.payment_reminder_send_now(%L)', coalesce(ms, gen_random_uuid())));
  perform pg_temp.res('17 trial: send reminder now refused', e like '42501%free trial%', e);
  perform pg_temp.res('18 trial: privacy PIN status + unlock with the default PIN still work',
    (public.privacy_pin_status() ->> 'is_default')::boolean and (public.privacy_pin_check('0000') ->> 'ok')::boolean);
  e := pg_temp.try('select count(*) from public.studio_layout_templates');
  perform pg_temp.res('19 trial: layout templates still readable', e = '', e);
  perform pg_temp.res('19b trial: event reminder days still readable', (public.event_reminder_settings_get() ->> 'days') is not null);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('1x trial rpc', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- trial studio: custom fields + catalog ----------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; ch uuid; pl uuid; mt uuid; md uuid; dc uuid; begin
  e := pg_temp.sys(format('insert into public.custom_field_defs(org_id, entity, key, label) values (%L, ''vendors'', ''gst_no'', ''GST no'')', o));
  perform pg_temp.res('20 setup: Helm can still write a custom field for a trial studio', e = '', e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('insert into public.custom_field_defs(entity, key, label) values (''inventory'', ''colour'', ''Colour'')');
  perform pg_temp.res('21 trial: new custom field refused', e like '42501%Custom fields are not part of the free trial%', e);
  e := pg_temp.try('update public.custom_field_defs set label = ''GSTIN'' where entity = ''vendors'' and key = ''gst_no''');
  perform pg_temp.res('22 trial: custom field change refused', e like '42501%Custom fields%', e);
  perform pg_temp.su();

  -- catalog rows: chair / plate types made by Helm; one sample package WITHOUT the "Demo" prefix (like the owner's)
  e := pg_temp.sys(format('insert into public.chair_types(org_id, name, price) values (%L, ''Chiavari'', 100)', o))
    || pg_temp.sys(format('insert into public.plate_types(org_id, name, price) values (%L, ''Veg'', 400)', o))
    || pg_temp.sys(format('insert into public.menu_templates(org_id, tier, diet, name, price_per_plate, is_demo) values (%L, ''gold'', ''nonveg'', ''Gold Non-veg'', 950, true)', o));
  perform pg_temp.res('30 setup: catalog rows', e = '', e);
  select id into ch from public.chair_types where org_id = o and name = 'Chiavari';
  select id into pl from public.plate_types where org_id = o and name = 'Veg';
  select id into md from public.menu_templates where org_id = o and name = 'Gold Non-veg';
  select id into mt from public.menu_templates where org_id = o and is_demo and id <> md order by seq limit 1;
  select id into dc from public.dish_catalog where org_id = o order by name limit 1;
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.chair_types set price = 120 where id = %L', ch));
  perform pg_temp.su();
  perform pg_temp.res('31 trial: chair price edit allowed', e = '' and (select price from public.chair_types where id = ch) = 120, e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.chair_types set name = ''Gold chair'' where id = %L', ch));
  perform pg_temp.res('32 trial: chair rename refused', e like '42501%not rename%', e);
  e := pg_temp.try(format('update public.chair_types set active = false where id = %L', ch));
  perform pg_temp.res('33 trial: chair switch-off (remove) refused', e like '42501%', e);
  e := pg_temp.try(format('delete from public.chair_types where id = %L', ch));
  perform pg_temp.su();
  perform pg_temp.res('34 trial: chair delete refused (row still there)', exists (select 1 from public.chair_types where id = ch and active), e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.plate_types set price = 450, name = name, active = active where id = %L', pl));
  perform pg_temp.su();
  perform pg_temp.res('35 trial: plate price edit (whole-row patch) allowed', e = '' and (select price from public.plate_types where id = pl) = 450, e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 999, active = true where id = %L', md));
  perform pg_temp.su();
  perform pg_temp.res('36 trial: package price edit allowed', e = '' and (select price_per_plate from public.menu_templates where id = md) = 999, e);
  -- 0203 (owner: prices only in the trial): the dish list of a package is fixed too once 0203 is installed
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.menu_templates set dishes = %L::jsonb where id = %L', '[{"c":"Main","n":"Biryani","k":"nonveg"}]', md));
  perform pg_temp.su();
  perform pg_temp.res('36b trial: package dish list (0203: fixed in the trial; before 0203: editable)',
    case when exists (select 1 from pg_trigger where tgname = 'zzzz_tl202_menu_dishes') then e like '42501%not the dishes%'
         else e = '' and (select dishes -> 0 ->> 'n' from public.menu_templates where id = md) = 'Biryani' end, e);
  perform pg_temp.res('37 trial: a price edit keeps the sample package a sample row', (select is_demo from public.menu_templates where id = md));
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.menu_templates set name = ''My Gold'' where id = %L', md));
  perform pg_temp.res('38 trial: package rename refused', e like '42501%not rename%', e);
  e := pg_temp.try(format('update public.menu_templates set active = false where id = %L', mt));
  perform pg_temp.res('39 trial: package switch-off refused', e like '42501%', e);
  e := pg_temp.try(format('update public.menu_templates set min_guests = 50 where id = %L', mt));
  perform pg_temp.res('40 trial: package other fields refused', e like '42501%', e);
  e := pg_temp.try(format('delete from public.menu_templates where id = %L', mt));
  perform pg_temp.su();
  perform pg_temp.res('41 trial: package delete refused (row still there)', exists (select 1 from public.menu_templates where id = mt), e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.dish_catalog set name = ''Renamed dish'' where id = %L', dc));
  perform pg_temp.res('42 trial: dish rename refused', e like '42501%not rename%', e);
  e := pg_temp.try(format('update public.dish_catalog set active = false where id = %L', dc));
  perform pg_temp.res('43 trial: dish switch-off (remove) refused', e like '42501%', e);
  e := pg_temp.try(format('delete from public.dish_catalog where id = %L', dc));
  perform pg_temp.su();
  perform pg_temp.res('44 trial: dish delete refused (row still there)', exists (select 1 from public.dish_catalog where id = dc and active), e);
  e := pg_temp.sys(format('update public.dish_catalog set name = name || '' (Helm)'' where id = %L', dc));
  perform pg_temp.res('45 Helm itself can still change a trial catalog row', e = '', e);
exception when others then perform pg_temp.su(); insert into _uf values ('2x trial catalog', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- trial studio: 2 created IN TOTAL ----------------------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; l1 uuid; arc uuid; v1 uuid; begin
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TG lead 1'')') || pg_temp.try('insert into public.leads(name) values (''TG lead 2'')');
  perform pg_temp.res('50 trial: 2 own leads OK', e = '', e);
  perform pg_temp.su(); select id into l1 from public.leads where org_id = o and name = 'TG lead 1';
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('delete from public.leads where id = %L', l1));
  perform pg_temp.su();
  perform pg_temp.res('51 setup: an own lead deleted by the app', e = '' and not exists (select 1 from public.leads where id = l1), e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('insert into public.leads(name) values (''TG lead 3'')');
  perform pg_temp.res('52 trial: deleting does not free a slot (3rd lead refused)', e like '42501%Free trial limit reached (2)%', e);
  perform pg_temp.res('53 my_trial_limits counts in total (deleted lead still counted)', (public.my_trial_limits() -> 'used' ->> 'leads')::int = 2
    and (public.my_trial_limits() ->> 'cap')::int = 2, public.my_trial_limits()::text);
  perform pg_temp.su();
  select a.id into arc from public.lead_archive a where a.lead_id = l1 and a.action = 'deleted' order by a.archived_at desc limit 1;
  if arc is not null then
    perform pg_temp.login('tg_trial@t.test');
    e := pg_temp.try(format('select public.restore_archived_lead(%L)', arc));
    perform pg_temp.su();
    perform pg_temp.res('54 trial: restoring the counted lead is allowed (no new slot)', e = '' and exists (select 1 from public.leads where id = l1), e);
  else
    perform pg_temp.res('54 trial: restoring the counted lead is allowed (no new slot)', false, 'no lead_archive row');
  end if;
  -- soft-deleted (inactive) rows keep counting
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('insert into public.vendors(name) values (''TG vendor 1'')') || pg_temp.try('insert into public.vendors(name) values (''TG vendor 2'')');
  perform pg_temp.res('55 trial: 2 own vendors OK', e = '', e);
  perform pg_temp.su(); select id into v1 from public.vendors where org_id = o and name = 'TG vendor 1';
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try(format('update public.vendors set active = false where id = %L', v1));
  e := e || pg_temp.try('insert into public.vendors(name) values (''TG vendor 3'')');
  perform pg_temp.res('56 trial: a removed (inactive) vendor still counts', e like '42501%Free trial limit reached (2)%', e);
  -- rows made before 0181 (not in the log) count; sample rows do not
  perform pg_temp.su();
  e := pg_temp.sys(format('insert into public.inventory_items(org_id, name) values (%L, ''TG old item'')', o));
  perform pg_temp.res('57 setup: an own item from before 0181 (not in the log)', e = ''
    and not exists (select 1 from public.trial_create_log where org_id = o and entity = 'inventory_items'), e);
  perform pg_temp.login('tg_trial@t.test');
  e := pg_temp.try('insert into public.inventory_items(name) values (''TG item 2'')');
  perform pg_temp.res('58 trial: 1 more item OK (sample items do not count)', e = '', e);
  e := pg_temp.try('insert into public.inventory_items(name) values (''TG item 3'')');
  perform pg_temp.res('59 trial: 3rd own item refused (the older one counts)', e like '42501%Free trial limit reached (2)%', e);
  perform pg_temp.su();
  perform pg_temp.res('60 the log remembers app-made rows only', (select count(*) from public.trial_create_log where org_id = o) = 5
    and (select count(*) from public.trial_create_log where org_id = o and entity = 'leads') = 2);
  e := pg_temp.sys(format('insert into public.vendors(org_id, name) values (%L, ''TG sys vendor'')', o));
  perform pg_temp.res('61 system insert past the cap still works', e = '', e);
exception when others then perform pg_temp.su(); insert into _uf values ('5x trial cap', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid studio: unchanged ----------------------------------------------------------------------------
do $$ declare e text; A uuid := 'a0000000-0000-4000-8000-000000000001'; ch uuid; md uuid; dc uuid; lid uuid; n0 int; begin
  perform pg_temp.su();
  perform pg_temp.res('70 paid fixture studio is not trial', not public._is_trial_org(A));
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('select public.studio_template_save(null, ''{"name":"Paid T","data":{"items":[]}}''::jsonb)');
  perform pg_temp.res('71 paid: save layout template works', e = '', e);
  e := pg_temp.try('select public.event_reminder_settings_set(5)');
  perform pg_temp.res('72 paid: event reminder days work', e = '', e);
  e := pg_temp.try('select public.privacy_pin_set(''0000'', ''4321'')');
  perform pg_temp.res('73 paid: privacy PIN change not trial-locked', e not like '%free trial%', e);
  e := pg_temp.try(format('select public.payment_reminder_send_now(%L)', gen_random_uuid()));
  perform pg_temp.res('74 paid: send reminder now not trial-locked', e not like '%free trial%', e);
  e := pg_temp.try('insert into public.custom_field_defs(entity, key, label) values (''inventory'', ''paid_colour'', ''Colour'')');
  perform pg_temp.res('75 paid: new custom field OK', e = '', e);
  e := pg_temp.try('insert into public.chair_types(name, price) values (''Paid chair'', 10)');
  perform pg_temp.su(); select id into ch from public.chair_types where org_id = A and name = 'Paid chair';
  perform pg_temp.login('a_admin@a.test');
  e := e || pg_temp.try(format('update public.chair_types set name = ''Paid chair 2'', active = false where id = %L', ch))
         || pg_temp.try(format('delete from public.chair_types where id = %L', ch));
  perform pg_temp.res('76 paid: chair rename / switch-off / delete OK', e = '', e);
  perform pg_temp.su(); select id into md from public.menu_templates where org_id = A order by seq limit 1;
  select id into dc from public.dish_catalog where org_id = A order by name limit 1;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('update public.menu_templates set name = name || '' X'', active = not active where id = %L', md))
    || pg_temp.try(format('update public.dish_catalog set name = name || '' X'' where id = %L', dc));
  perform pg_temp.res('77 paid: package / dish rename + switch OK', e = '', e);
  perform pg_temp.su(); select count(*) into n0 from public.leads where org_id = A;
  perform pg_temp.login('a_admin@a.test');
  e := '';
  for i in 1..4 loop e := e || pg_temp.try(format('insert into public.leads(name) values (%L)', 'PAID lead ' || i)); end loop;
  perform pg_temp.su(); select id into lid from public.leads where org_id = A and name = 'PAID lead 1';
  perform pg_temp.login('a_admin@a.test');
  e := e || pg_temp.try(format('delete from public.leads where id = %L', lid)) || pg_temp.try('insert into public.leads(name) values (''PAID lead 5'')');
  perform pg_temp.su();
  perform pg_temp.res('78 paid: no cap (add, delete, add again)', e = '' and (select count(*) from public.leads where org_id = A) = n0 + 4, e);
  perform pg_temp.res('79 paid: nothing written to the trial log', not exists (select 1 from public.trial_create_log where org_id = A));
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('80 paid: my_trial_limits says not trial', public.my_trial_limits() ->> 'trial' = 'false');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('7x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- shape ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('90 8 originals kept as __pre0181, not callable by the app',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0181') = 8
    and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0181'
                     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform pg_temp.res('91 wrappers keep the original grants',
    has_function_privilege('authenticated', 'public.studio_template_save(uuid,jsonb)', 'execute')
    and has_function_privilege('authenticated', 'public.privacy_pin_reset()', 'execute')
    and has_function_privilege('authenticated', 'public.payment_reminder_send_now(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.payment_reminder_send_now(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.studio_template_save(uuid,jsonb)', 'execute'));
  perform pg_temp.res('92 triggers: cap 6, log 6, catalog 4, custom fields 1',
    (select count(*) from pg_trigger where tgname = 'zzzz_tl181_cap') = 6 and (select count(*) from pg_trigger where tgname = 'zzzz_tl181_cap_log') = 6
    and (select count(*) from pg_trigger where tgname = 'zzzz_tl181_catalog') = 4 and (select count(*) from pg_trigger where tgname = 'zzzz_tl181_custom_fields') = 1);
  perform pg_temp.res('93 trial log: RLS on, no app access, read-only guard',
    (select relrowsecurity from pg_class where oid = 'public.trial_create_log'::regclass)
    and exists (select 1 from pg_trigger where tgrelid = 'public.trial_create_log'::regclass and tgname = 'zzz_studio_read_only')
    and not has_table_privilege('authenticated', 'public.trial_create_log', 'select')
    and not has_table_privilege('anon', 'public.trial_create_log', 'select')
    and not has_table_privilege('authenticated', 'public.trial_create_log', 'insert'));
  perform pg_temp.res('94 helpers / trigger functions not callable by the app',
    not has_function_privilege('authenticated', 'public._tl181_used(uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._tl181_tg_cap_check()', 'execute')
    and not has_function_privilege('authenticated', 'public._tl181_tg_catalog_edit()', 'execute')
    and has_function_privilege('authenticated', 'public.my_trial_limits()', 'execute'));
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-GUARDS-0181: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-GUARDS-0181: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
