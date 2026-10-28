-- trial-gates-0203.sql -- 0203: free-trial server gates. Trial studio: no greeting to a client (send refused,
-- automatic run does nothing, automation cannot be switched on, auto-greet shown off), menu package dishes
-- fixed (price editable), activity log not readable, checklist / task templates not writable, checkout status
-- says "trial" (not "subscribed"); export / import / photo render / starter seed still refused (0173 / 0181).
-- Paid studio: unchanged. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
-- r37 / 0287: the server's "today" is the STUDIO's day (India for these fixtures) and HQ's is India time, so the
-- fixtures' current_date must be that same day (otherwise this suite fails between 18:30 and 24:00 UTC)
set timezone = 'Asia/Kolkata';
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
create or replace function pg_temp.val(p_sql text) returns text language plpgsql as $$
declare v text; begin execute p_sql into v; return v; exception when others then return 'ERR ' || sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.val(text) to anon, authenticated, service_role;
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

-- earlier suites in run-all re-apply older migrations over the 0173 / 0203 wrappers: re-run both
-- (also proves a re-run is safe)
\ir ../../supabase/migrations/0173_trial_lockdown.sql
\ir ../../supabase/migrations/0203_trial_gates.sql

-- ---- trial studio: greetings ------------------------------------------------------------------------
do $$ declare o uuid; e text; v text; nid uuid; n0 int; n1 int; begin
  o := pg_temp.trial('tg202_trial@t.test'); perform pg_temp.put('o', o::text);
  perform pg_temp.res('01 trial studio is trial (subscription status)', public._is_trial_org(o)
    and (select status from public.studio_subscriptions where org_id = o) = 'trial');
  e := pg_temp.sys(format('insert into public.nurture(org_id, name, email, occasion_type, occasion_date, auto_on) values (%L, ''TG202 Contact'', ''tg202@example.com'', ''birthday'', current_date, true)', o))
    || pg_temp.sys(format('insert into public.nurture_automation(org_id, id, enabled, within_days) values (%L, 1, true, 30) on conflict (org_id, id) do update set enabled = true, within_days = 30', o));
  perform pg_temp.res('02 setup: Helm can still write a trial contact + switch automation on', e = '', e);
  select id into nid from public.nurture where org_id = o and name = 'TG202 Contact';
  select count(*) into n0 from public.comms_outbox where org_id = o;
  perform pg_temp.login('tg202_trial@t.test');
  e := pg_temp.try(format('select public.queue_nurture_greeting(%L)', nid));
  perform pg_temp.res('10 trial: Send greeting refused with the plan message', e like '42501%Greetings are sent once you choose a plan%', e);
  v := pg_temp.val('select public.run_nurture_auto(30)::text');
  perform pg_temp.res('11 trial: Run today''s greetings / automatic run does nothing (0)', v = '0', v);
  v := pg_temp.val('select public.run_nurture_auto()::text');
  perform pg_temp.res('12 trial: automatic run with no days does nothing (0)', v = '0', v);
  v := pg_temp.val(format('select bool_or(auto_on)::text from public.nurture_due(400) where id = %L', nid));
  perform pg_temp.res('13 trial: upcoming occasions still listed, auto-greet shown off', v = 'false', v);
  e := pg_temp.try('update public.nurture_automation set enabled = false where id = 1');
  perform pg_temp.res('14 trial: switching automatic greetings OFF works', e = '', e);
  e := pg_temp.try('update public.nurture_automation set enabled = true where id = 1');
  perform pg_temp.res('15 trial: switching automatic greetings ON refused', e like '42501%Automatic greetings start once you choose a plan%', e);
  e := pg_temp.try('update public.nurture_automation set within_days = 10 where id = 1');
  perform pg_temp.res('16 trial: days ahead change (automation off) still saves', e = '', e);
  perform pg_temp.su();
  select count(*) into n1 from public.comms_outbox where org_id = o;
  perform pg_temp.res('17 trial: nothing queued, contact not marked greeted',
    n1 = n0 and (select last_greeted from public.nurture where id = nid) is null, n0 || ' -> ' || n1);
exception when others then perform pg_temp.su(); insert into _uf values ('1x trial greetings', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- trial studio: menu dishes, activity log, templates, checkout status --------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; v text; mt uuid; d0 jsonb; n int; begin
  select id, dishes into mt, d0 from public.menu_templates where org_id = o and is_demo and jsonb_array_length(coalesce(dishes, '[]'::jsonb)) > 0 order by seq limit 1;
  perform pg_temp.res('20 setup: the trial has a sample package with dishes', mt is not null, coalesce(mt::text, 'none'));
  perform pg_temp.login('tg202_trial@t.test');
  e := pg_temp.try(format('update public.menu_templates set dishes = dishes || ''[{"c":"Soups","n":"New soup","k":"veg"}]''::jsonb where id = %L', mt));
  perform pg_temp.res('21 trial: adding a dish to a package refused', e like '42501%not the dishes in a package%', e);
  e := pg_temp.try(format('update public.menu_templates set dishes = ''[]''::jsonb where id = %L', mt));
  perform pg_temp.res('22 trial: clearing a package''s dishes refused', e like '42501%', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 950 where id = %L', mt));
  perform pg_temp.res('23 trial: price per plate change works', e = '', e);
  e := pg_temp.try(format('update public.menu_templates set price_per_plate = 975, dishes = %L::jsonb where id = %L', d0::text, mt));
  perform pg_temp.su();
  perform pg_temp.res('24 trial: price save that re-sends the SAME dishes works (old Control Center save)',
    e = '' and (select price_per_plate from public.menu_templates where id = mt) = 975 and (select dishes from public.menu_templates where id = mt) = d0, e);

  -- activity log: the studio has rows, the trial admin reads none
  select count(*) into n from public.audit_log where org_id = o;
  if n = 0 then
    insert into public.audit_log(org_id, entity, action, changed) values (o, 'leads', 'insert', '{"name":"x"}'::jsonb);
    select count(*) into n from public.audit_log where org_id = o;
  end if;
  perform pg_temp.login('tg202_trial@t.test');
  v := pg_temp.val('select count(*)::text from public.audit_log');
  perform pg_temp.res('30 trial: activity log not readable (0 rows; studio has ' || n || ')', v = '0' and n > 0, v);
  v := pg_temp.val('select count(*)::text from public.audit_actor_names()');
  perform pg_temp.res('31 trial: audit page name lookup returns nothing', v = '0', v);

  e := pg_temp.try('insert into public.checklist_templates(section, name, items) values (''logistics'', ''TG202'', ''[]''::jsonb)');
  perform pg_temp.res('40 trial: new checklist template refused', e like '42501%Templates are not part of the free trial%', e);
  e := pg_temp.try('insert into public.task_templates(category, title, seq) values (''Setup'', ''TG202 task'', 99)');
  perform pg_temp.res('41 trial: new task template refused', e like '42501%Templates are not part of the free trial%', e);
  e := pg_temp.try('update public.task_templates set title = title where true');
  perform pg_temp.res('42 trial: task template change refused (or none to change)', e like '42501%Templates%'
    or (e = '' and (select count(*) from public.task_templates) = 0), e);
  e := pg_temp.try('select count(*) from public.task_templates') || pg_temp.try('select count(*) from public.checklist_templates');
  perform pg_temp.res('43 trial: templates still readable (sample events keep their checklists)', e = '', e);

  v := pg_temp.val('select public.my_checkout_status()::text');
  perform pg_temp.res('50 trial: checkout status says trial, not subscribed',
    (v::jsonb ->> 'has_subscription') = 'false' and (v::jsonb ->> 'reason') = 'trial' and (v::jsonb ->> 'trial') = 'true'
    and (v::jsonb ->> 'required') = 'false' and (v::jsonb ->> 'status') = 'trial', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('2x trial menu/audit/templates/checkout', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- trial studio: export / import / photo render / starter seed still refused (0173 / 0181) -----------
do $$ declare o uuid := pg_temp.get('o')::uuid; e text; n0 int; n1 int; begin
  perform pg_temp.login('tg202_trial@t.test');
  e := pg_temp.try('select public.export_org_data()');
  perform pg_temp.res('60 trial: data export refused', e like '42501%free trial%'
    or e like '42501%permission denied for function export_org_data%', e);   -- r54 (0295): export_org_data closed to the app
  e := pg_temp.try('select public.export_tenant_organization_package()');
  perform pg_temp.res('61 trial: studio data archive refused', e like '42501%free trial%', e);
  e := pg_temp.try('select public.smart_import_batch(''crew_members'', ''[{"name":"X"}]''::jsonb, ''[]''::jsonb)')
    || ' | ' || pg_temp.try('select public.smart_import_batch(''menu'', ''[{"name":"X"}]''::jsonb, ''[]''::jsonb)')
    || ' | ' || pg_temp.try('select public.smart_import_batch(''inventory'', ''[{"name":"X"}]''::jsonb, ''[]''::jsonb)')
    || ' | ' || pg_temp.try('select public.smart_import_batch(''vendors'', ''[{"name":"X"}]''::jsonb, ''[]''::jsonb)');
  perform pg_temp.res('62 trial: Excel import (staff / dishes / inventory / vendors) refused',
    e like '42501%free trial% | 42501%free trial% | 42501%free trial% | 42501%free trial%', e);
  e := pg_temp.try('select public.photo_render_begin(gen_random_uuid(), 1, ''low'', ''1024x1024'', ''m'', 0)');
  perform pg_temp.res('63 trial: photo render refused', e like '42501%free trial%', e);
  perform pg_temp.su(); select count(*) into n0 from public.inventory_items where org_id = o;
  perform pg_temp.login('tg202_trial@t.test');
  e := pg_temp.try('insert into public.inventory_items(name, category, total_qty, unit, priority, unit_cost)
                    select ''TG202 starter '' || g, ''Furniture'', 10, ''pcs'', ''C'', 0 from generate_series(1, 6) g');
  perform pg_temp.su(); select count(*) into n1 from public.inventory_items where org_id = o;
  perform pg_temp.res('64 trial: "Load starter items" bulk insert refused (2-per-list cap), nothing added',
    e like '42501%Free trial limit reached%' and n1 = n0, e || ' ' || n0 || '->' || n1);
exception when others then perform pg_temp.su(); insert into _uf values ('6x trial export/import', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- ended, unpaid trial: checkout status + activity log ------------------------------------------------
do $$ declare o uuid := pg_temp.get('o')::uuid; v text; begin
  perform pg_temp.su();
  update public.studio_subscriptions set status = 'past_due', trial_ends_at = current_date - 20, current_period_end = null where org_id = o;
  update public.organizations set trial_ends_at = now() - interval '20 days' where id = o;
  perform pg_temp.res('65 setup: trial ended unpaid (read-only)', coalesce(public._trial_locked(o), false));
  perform pg_temp.login('tg202_trial@t.test');
  v := pg_temp.val('select public.my_checkout_status()::text');
  perform pg_temp.res('66 ended trial: checkout status says trial_ended, no subscription, not forced to checkout',
    (v::jsonb ->> 'has_subscription') = 'false' and (v::jsonb ->> 'reason') = 'trial_ended' and (v::jsonb ->> 'required') = 'false', v);
  v := pg_temp.val('select count(*)::text from public.audit_log');
  perform pg_temp.res('67 ended trial: activity log still not readable', v = '0', v);
  v := pg_temp.val('select public.run_nurture_auto(30)::text');
  perform pg_temp.res('68 ended trial: automatic greetings do nothing', v = '0', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('6y ended trial', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- paid studio: unchanged ----------------------------------------------------------------------------
do $$ declare e text; v text; A uuid := 'a0000000-0000-4000-8000-000000000001'; nid uuid; md uuid; n int; hasrow boolean; begin
  perform pg_temp.su();
  hasrow := exists (select 1 from public.studio_subscriptions where org_id = A);
  perform pg_temp.res('70 paid fixture studio is not trial', not public._is_trial_org(A) and not coalesce(public._tb179_no_send(A), false));
  insert into public.nurture(org_id, name, email, occasion_type, occasion_date, auto_on) values (A, 'TG202 Paid', 'tg202p@example.com', 'birthday', current_date, true)
    returning id into nid;
  insert into public.nurture_templates(org_id, occasion_type, subject, body, enabled) values (A, 'birthday', 'Happy birthday {{name}}', 'Hi {{name}}', true)
    on conflict (org_id, occasion_type) do update set enabled = true;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('select public.queue_nurture_greeting(%L)', nid));
  perform pg_temp.su();
  perform pg_temp.res('71 paid: Send greeting works (contact marked greeted)', e = '' and (select last_greeted from public.nurture where id = nid) = current_date, e);
  update public.nurture set last_greeted = null where id = nid;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try('insert into public.nurture_automation(id, enabled, within_days) values (1, true, 30) on conflict (org_id, id) do update set enabled = true, within_days = 30');
  perform pg_temp.res('72 paid: switching automatic greetings ON works', e = '', e);
  v := pg_temp.val('select public.run_nurture_auto(30)::text');
  perform pg_temp.res('73 paid: automatic run queues the due greeting', v ~ '^[0-9]+$' and v::int >= 1, v);
  v := pg_temp.val(format('select bool_or(auto_on)::text from public.nurture_due(400) where id = %L', nid));
  perform pg_temp.res('74 paid: nurture_due shows auto-greet as saved', v = 'true', v);
  perform pg_temp.su(); select id into md from public.menu_templates where org_id = A order by seq limit 1;
  perform pg_temp.login('a_admin@a.test');
  e := pg_temp.try(format('update public.menu_templates set dishes = coalesce(dishes, ''[]''::jsonb) || ''[{"c":"Soups","n":"Paid soup","k":"veg"}]''::jsonb where id = %L', md));
  perform pg_temp.res('75 paid: package dishes change works', e = '', e);
  perform pg_temp.su(); select count(*) into n from public.audit_log where org_id = A;
  if n = 0 then insert into public.audit_log(org_id, entity, action, changed) values (A, 'leads', 'insert', '{}'::jsonb); n := 1; end if;
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.val('select count(*)::text from public.audit_log');
  perform pg_temp.res('76 paid: activity log readable as before', v ~ '^[0-9]+$' and v::int = n, v || ' of ' || n);
  v := pg_temp.val('select count(*)::text from public.audit_actor_names()');
  perform pg_temp.res('77 paid: audit name lookup works', v ~ '^[0-9]+$' and v::int >= 1, v);
  e := pg_temp.try('insert into public.task_templates(category, title, seq) values (''Setup'', ''TG202 paid task'', 99)')
    || pg_temp.try('insert into public.checklist_templates(section, name, items) values (''logistics'', ''TG202 paid'', ''[]''::jsonb)');
  perform pg_temp.res('78 paid: templates writable', e = '', e);
  v := pg_temp.val('select public.my_checkout_status()::text');
  perform pg_temp.res('79 paid: checkout status not trial (no row -> existing / needs checkout; a row -> subscribed)',
    (v::jsonb ->> 'trial') = 'false'
    and case when hasrow
             then (v::jsonb ->> 'has_subscription') = 'true' and (v::jsonb ->> 'reason') in ('subscribed', 'pending_payment')
             else (v::jsonb ->> 'has_subscription') = 'false' and (v::jsonb ->> 'reason') in ('existing_studio', 'needs_checkout') end, v);
  perform pg_temp.su();
  insert into public.studio_subscriptions(org_id, status) values (A, 'active')
    on conflict (org_id) do update set status = 'active';
  perform pg_temp.login('a_admin@a.test');
  v := pg_temp.val('select public.my_checkout_status()::text');
  perform pg_temp.res('80 paid (active subscription): has_subscription + subscribed',
    (v::jsonb ->> 'has_subscription') = 'true' and (v::jsonb ->> 'reason') = 'subscribed' and (v::jsonb ->> 'trial') = 'false', v);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _uf values ('7x paid', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- structure ------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('90 3 originals kept as __pre0202, not callable by the app',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0202') = 3
    and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0202'
                     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))));
  perform pg_temp.res('91 wrappers: signed-in users only (never anon)',
    has_function_privilege('authenticated', 'public.queue_nurture_greeting(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.run_nurture_auto(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.nurture_due(integer)', 'execute')
    and has_function_privilege('authenticated', 'public.my_checkout_status()', 'execute')
    and has_function_privilege('authenticated', 'public.audit_actor_names()', 'execute')
    and not has_function_privilege('anon', 'public.queue_nurture_greeting(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.run_nurture_auto(integer)', 'execute')
    and not has_function_privilege('anon', 'public.nurture_due(integer)', 'execute')
    and not has_function_privilege('anon', 'public.my_checkout_status()', 'execute'));
  perform pg_temp.res('92 triggers: nurture auto 1, menu dishes 1, templates 2; restrictive audit policy',
    (select count(*) from pg_trigger where tgname = 'zzzz_tl202_nurture_auto') = 1
    and (select count(*) from pg_trigger where tgname = 'zzzz_tl202_menu_dishes') = 1
    and (select count(*) from pg_trigger where tgname = 'zzzz_tl202_templates') = 2
    and exists (select 1 from pg_policy where polrelid = 'public.audit_log'::regclass and polname = 'tl202_trial_no_read' and not polpermissive));
  perform pg_temp.res('93 helpers / trigger functions not callable by the app (policy helper excepted)',
    not has_function_privilege('authenticated', 'public._tl202_no_send(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._tl202_tg_menu_dishes()', 'execute')
    and not has_function_privilege('authenticated', 'public._tl202_tg_templates()', 'execute')
    and not has_function_privilege('anon', 'public._tl202_caller_trial()', 'execute')
    and has_function_privilege('authenticated', 'public._tl202_caller_trial()', 'execute'));
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-GATES-0203: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-GATES-0203: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
