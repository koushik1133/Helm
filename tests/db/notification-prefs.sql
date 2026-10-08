-- notification-prefs.sql — 0036 admin-managed notifications per role / per person.
-- A studio admin can switch a notification type on/off per role (bell) and per person,
-- and switch automatic staff texts/e-mails off studio-wide; a non-admin, another
-- studio's admin and a signed-out caller are refused; REQUIRED client messages (OTP,
-- receipts, links) can't be switched off; bell_feed / my_pending hide what is off;
-- with no prefs the bell behaves as before (money types: finance roles only);
-- every change is audit-logged; reset never deletes a row.
-- Fixture: a_admin/a_staff(sales) in studio A, b_admin/b_staff(sales) in B;
-- this suite adds a_crew_np (crew, studio A, no finance access).
\set ON_ERROR_STOP 0
set client_min_messages = warning;
drop table if exists _np; create temp table _np(name text, result text); grant all on _np to anon, authenticated;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
end $$;
create or replace function pg_temp.anon() returns void language plpgsql as $$
begin perform pg_temp.su(); perform auth.login_anon(); end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql security definer as $$ select id from auth.users where email = p_email $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin perform pg_temp.su(); insert into _np values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate; end $$;
-- the test kinds visible in the CALLER's bell (only this suite's rows, marked detail.np)
create or replace function pg_temp.bell() returns text language plpgsql as $$
declare v text; begin
  select string_agg(x ->> 'kind', ',' order by x ->> 'kind') into v
    from jsonb_array_elements(public.bell_feed(100) -> 'items') x where x -> 'detail' ->> 'np' = '1';
  return coalesce(v, '');
end $$;
create or replace function pg_temp.prefs_rows(p_org text) returns int language sql security definer as $$
  select count(*)::int from public.notification_prefs where org_id = p_org::uuid $$;
create or replace function pg_temp.audit_n(p_action text) returns int language sql security definer as $$
  select count(*)::int from public.audit_log where action = p_action $$;
grant execute on function pg_temp.try(text), pg_temp.uid(text), pg_temp.bell(), pg_temp.prefs_rows(text), pg_temp.audit_n(text) to anon, authenticated;

-- ---- setup (superuser) ---------------------------------------------------------------
do $$ declare c uuid; begin perform pg_temp.su();
  delete from public.notification_prefs where org_id in ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001');
  delete from public.audit_log where action like 'notification_pref.%';
  delete from public.notifications where detail ->> 'np' = '1';
  select id into c from auth.users where email = 'a_crew_np@a.test';
  if c is null then c := auth.seed_user('a_crew_np@a.test'); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (c, 'a_crew_np@a.test', 'crew', 'a0000000-0000-4000-8000-000000000001', false, now())
  on conflict (id) do update set role = 'crew', org_id = excluded.org_id, must_change_password = false;
  delete from public.role_access where org_id = 'a0000000-0000-4000-8000-000000000001' and role = 'crew' and area = 'finance';
  insert into public.notifications(quote_id, channel, recipient, kind, status, detail, org_id) values
    ('a0000000-0000-4000-8000-00000000da01', 'sms',    '+910000000001', 'task_assigned',   'simulated', '{"np":"1"}', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-00000000da01', 'email',  'client@a.test', 'payment_receipt', 'simulated', '{"np":"1"}', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-00000000da01', 'in_app', null,            'design_revise',   'simulated', '{"np":"1"}', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-00000000da01', 'sms',    '+910000000002', 'otp',             'simulated', '{"np":"1"}', 'a0000000-0000-4000-8000-000000000001');
end $$;

-- ---- defaults = today's behaviour (money: finance roles only) -------------------------
do $$ declare v text; s text; j jsonb; begin
  perform pg_temp.login('a_admin@a.test'); v := pg_temp.bell();
  perform pg_temp.res('01 defaults: admin sees every type', v = 'design_revise,otp,payment_receipt,task_assigned', v);
  perform pg_temp.login('a_staff@a.test'); v := pg_temp.bell();
  perform pg_temp.res('02 defaults: sales (finance view) sees every type incl. payments', v = 'design_revise,otp,payment_receipt,task_assigned', v);
  perform pg_temp.login('a_crew_np@a.test'); v := pg_temp.bell();
  perform pg_temp.res('03 defaults: crew (no finance access) sees all but the money type', v = 'design_revise,otp,task_assigned', v);
  perform pg_temp.login('a_crew_np@a.test');
  s := pg_temp.try($q$select public.bell_feed(5)$q$);
  j := public.bell_feed(100);
  perform pg_temp.res('04 bell_feed no longer returns the recipient (client phone/e-mail)',
    s = '' and not exists (select 1 from jsonb_array_elements(j -> 'items') x where x ? 'recipient'), s);
  perform pg_temp.res('05 reading never writes prefs (no rows until an admin edits)', pg_temp.prefs_rows('a0000000-0000-4000-8000-000000000001') = 0);
end $$;

-- ---- admin can set; bell + my_pending follow -----------------------------------------
do $$ declare s text; r jsonb; v text; u1 int; u2 int; begin
  perform pg_temp.login('a_admin@a.test');
  begin r := public.admin_set_notification_pref('task_assigned', 'in_app', 'sales', false); s := ''; exception when others then s := sqlstate; end;
  perform pg_temp.res('06 admin turns a type off for a role', s = '' and (r ->> 'effective')::boolean = false, s||' '||coalesce(r::text,''));
  perform pg_temp.su();
  perform pg_temp.res('07 the change is audit-logged (actor, studio, old/new)',
    exists (select 1 from public.audit_log where action = 'notification_pref.set' and actor = pg_temp.uid('a_admin@a.test')
              and org_id = 'a0000000-0000-4000-8000-000000000001' and changed ->> 'type' = 'task_assigned'
              and changed ->> 'role' = 'sales' and changed -> 'enabled' ->> 'new' = 'false'), 'no audit row');
  perform pg_temp.login('a_staff@a.test'); v := pg_temp.bell();
  perform pg_temp.res('08 bell_feed hides the type turned off for that role', v = 'design_revise,otp,payment_receipt', v);
  perform pg_temp.login('a_admin@a.test'); v := pg_temp.bell();
  perform pg_temp.res('09 other roles are unaffected (admin still sees it)', v = 'design_revise,otp,payment_receipt,task_assigned', v);
  perform pg_temp.login('a_staff@a.test');
  u1 := (public.bell_feed(100) ->> 'unread')::int; u2 := (public.my_pending() ->> 'unread')::int;
  perform pg_temp.res('10 my_pending unread count follows the same filter as the bell', u1 = u2, u1||' vs '||u2);
  perform pg_temp.login('a_admin@a.test');
  r := public.admin_set_notification_pref('task_assigned', 'in_app', 'sales', false);
  perform pg_temp.res('11 setting the same value again writes no extra audit row', pg_temp.audit_n('notification_pref.set') = 1, pg_temp.audit_n('notification_pref.set')::text);
  perform pg_temp.login('a_admin@a.test');
  r := public.admin_get_notification_prefs();
  perform pg_temp.res('12 admin_get shows the change (on=false, default=true, set) and the catalog',
    (r -> 'in_app' -> 'task_assigned' -> 'sales' ->> 'on')::boolean = false
    and (r -> 'in_app' -> 'task_assigned' -> 'sales' ->> 'default')::boolean = true
    and (r -> 'in_app' -> 'task_assigned' -> 'sales' ->> 'set')::boolean = true
    and jsonb_array_length(r -> 'catalog') >= 16 and (r ->> 'changed')::int = 1, left(r::text, 200));
end $$;

-- ---- non-admin / other studio / signed-out refused -----------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('task_assigned','in_app','sales',true)$q$);
  perform pg_temp.res('13 non-admin is refused (42501) and nothing changes', s = '42501'
    and (select enabled from public.notification_prefs where role = 'sales' and type = 'task_assigned' and channel = 'in_app'
          and org_id = 'a0000000-0000-4000-8000-000000000001') = false, s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_get_notification_prefs()$q$);
  perform pg_temp.res('14 non-admin cannot read the admin matrix (42501)', s = '42501', s);
  perform pg_temp.login('a_staff@a.test');
  s := pg_temp.try($q$select public.admin_reset_notification_prefs()$q$);
  perform pg_temp.res('15 non-admin cannot reset (42501)', s = '42501', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$insert into public.notification_prefs(org_id, role, type, channel, enabled) values ('a0000000-0000-4000-8000-000000000001','crew','other','in_app',false)$q$);
  perform pg_temp.res('16 even an admin cannot write the table directly (RPC + audit only)', s = '42501', s);
  perform pg_temp.login('b_admin@b.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('other','in_app',null,false,pg_temp.uid('a_staff@a.test'))$q$);
  perform pg_temp.res('17 another studio''s admin cannot set a person override for a studio A user (42501)', s = '42501', s);
  perform pg_temp.login('b_admin@b.test');
  perform pg_temp.res('18 another studio''s admin cannot see studio A rows (RLS)',
    (select count(*) from public.notification_prefs where org_id = 'a0000000-0000-4000-8000-000000000001') = 0
    and (public.admin_get_notification_prefs() -> 'in_app' -> 'task_assigned' -> 'sales' ->> 'on')::boolean = true);
  perform pg_temp.login('b_admin@b.test');
  perform public.admin_set_notification_pref('design_update', 'in_app', 'admin', false);
  perform pg_temp.login('a_admin@a.test');
  perform pg_temp.res('19 studio B''s change never reaches studio A''s bell', pg_temp.bell() = 'design_revise,otp,payment_receipt,task_assigned', pg_temp.bell());
  perform pg_temp.login('a_staff@a.test');
  perform pg_temp.res('20 members read their own studio''s prefs (RLS select)',
    (select count(*) from public.notification_prefs) = 1);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.admin_set_notification_pref('other','in_app','crew',false)$q$);
  perform pg_temp.res('21 signed-out caller is refused the admin RPC', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select public.my_notification_prefs()$q$);
  perform pg_temp.res('22 signed-out caller is refused my_notification_prefs', s = '42501', s);
  perform pg_temp.anon();
  s := pg_temp.try($q$select count(*) from public.notification_prefs$q$);
  perform pg_temp.res('23 signed-out caller cannot read the table', s = '42501', s);
  perform pg_temp.su();
  perform pg_temp.res('24 internal helpers are not callable by API roles',
    not has_function_privilege('authenticated', 'public.notify_allowed(uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.notify_allowed(uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.notify_allowed_user(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public._notify_hidden_types(uuid,uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.notify_allowed(uuid,text,text,text)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.admin_set_notification_pref(text,text,text,boolean,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.admin_set_notification_pref(text,text,text,boolean,uuid)', 'EXECUTE'));
end $$;

-- ---- required types / bad input -------------------------------------------------------
do $$ declare s text; begin
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('otp','sms',null,false)$q$);
  perform pg_temp.res('25 required: the client OTP text can''t be turned off (22023)', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('payment_receipt','email',null,false)$q$);
  perform pg_temp.res('26 required: the client payment receipt can''t be turned off (22023)', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('payment_reconcile','email',null,false)$q$);
  perform pg_temp.res('27 required: "payment needs attention" e-mail can''t be turned off (22023)', s = '22023', s);
  perform pg_temp.su();
  perform pg_temp.res('28 nothing was stored for the refused required types',
    not exists (select 1 from public.notification_prefs where type in ('otp','payment_receipt','payment_reconcile') and channel <> 'in_app'));
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('design_update','sms',null,false)$q$);
  perform pg_temp.res('29 a channel the type never uses is refused (22023)', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('nope','in_app','crew',false)$q$);
  perform pg_temp.res('30 unknown type refused (22023)', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('other','in_app','client',false)$q$);
  perform pg_temp.res('31 unknown / non-staff role refused (22023)', s = '22023', s);
  perform pg_temp.login('a_admin@a.test');
  s := pg_temp.try($q$select public.admin_set_notification_pref('task_reminder','sms',null,false,pg_temp.uid('a_staff@a.test'))$q$);
  perform pg_temp.res('32 per-person override is for the bell only (22023 on sms)', s = '22023', s);
end $$;

-- ---- per-person override ----------------------------------------------------------------
do $$ declare v text; s text; j jsonb; begin
  perform pg_temp.login('a_admin@a.test');
  begin perform public.admin_set_notification_pref('payment_receipt', 'in_app', null, true, pg_temp.uid('a_crew_np@a.test')); s := ''; exception when others then s := sqlstate; end;
  perform pg_temp.login('a_crew_np@a.test'); v := pg_temp.bell();
  perform pg_temp.res('33 a person override can show a type their role hides', s = '' and v = 'design_revise,otp,payment_receipt,task_assigned', s||' '||v);
  perform pg_temp.login('a_admin@a.test');
  perform public.admin_set_notification_pref('chat_message', 'in_app', null, false, pg_temp.uid('a_crew_np@a.test'));
  perform pg_temp.login('a_crew_np@a.test'); j := public.my_notification_prefs();
  perform pg_temp.res('34 my_notification_prefs reports the hidden chat type to the bell', (j -> 'hidden') ? 'chat_message', j::text);
  perform pg_temp.login('a_staff@a.test'); j := public.my_notification_prefs();
  perform pg_temp.res('35 ... and only for that person', not ((j -> 'hidden') ? 'chat_message') and (j -> 'hidden') ? 'task_assigned', j::text);
end $$;

-- ---- outbound: automatic staff texts can be switched off; client messages never ---------
do $$ declare r jsonb; st text; begin
  perform pg_temp.login('a_admin@a.test');
  r := public.admin_set_notification_pref('task_reminder', 'sms', 'crew', false);
  perform pg_temp.su();
  perform pg_temp.res('36 outbound switches are stored studio-wide (role *)',
    exists (select 1 from public.notification_prefs where org_id = 'a0000000-0000-4000-8000-000000000001'
              and type = 'task_reminder' and channel = 'sms' and role = '*' and enabled = false), r::text);
  perform public._notify('a0000000-0000-4000-8000-00000000da01', 'sms', '+910000000003', 'task_reminder', '{"np":"1","t":"r"}');
  select status into st from public.notifications where detail ->> 't' = 'r';
  perform pg_temp.res('37 a switched-off staff text is logged as suppressed (not sent)', st = 'suppressed', st);
  perform public._notify('a0000000-0000-4000-8000-00000000da01', 'sms', '+910000000004', 'task_due', '{"np":"1","t":"d"}');
  select status into st from public.notifications where detail ->> 't' = 'd';
  perform pg_temp.res('38 other staff texts still go out as before', st in ('simulated','sent'), st);
  perform public._notify('a0000000-0000-4000-8000-00000000da01', 'sms', '+910000000005', 'otp', '{"np":"1","t":"o"}');
  select status into st from public.notifications where detail ->> 't' = 'o';
  perform pg_temp.res('39 client OTP is never suppressed', st in ('simulated','sent'), st);
  perform public._notify('b0000000-0000-4000-8000-00000000da01', 'sms', '+910000000006', 'task_reminder', '{"np":"1","t":"b"}');
  select status into st from public.notifications where detail ->> 't' = 'b';
  perform pg_temp.res('40 studio A''s switch never suppresses studio B''s texts', st in ('simulated','sent'), st);
end $$;

-- ---- reset to defaults (rows kept, audit) ---------------------------------------------
do $$ declare n int; before int; v text; begin
  perform pg_temp.su(); before := pg_temp.prefs_rows('a0000000-0000-4000-8000-000000000001');
  perform pg_temp.login('a_admin@a.test'); n := public.admin_reset_notification_prefs();
  perform pg_temp.su();
  perform pg_temp.res('41 reset clears every studio A setting and deletes no row',
    n = before and pg_temp.prefs_rows('a0000000-0000-4000-8000-000000000001') = before
    and not exists (select 1 from public.notification_prefs where org_id = 'a0000000-0000-4000-8000-000000000001' and enabled is not null),
    n||'/'||before);
  perform pg_temp.res('42 reset is audit-logged with the previous values',
    exists (select 1 from public.audit_log where action = 'notification_pref.reset' and org_id = 'a0000000-0000-4000-8000-000000000001'
              and (changed ->> 'count')::int = n and jsonb_array_length(changed -> 'previous') = n));
  perform pg_temp.res('43 reset leaves studio B alone',
    exists (select 1 from public.notification_prefs where org_id = 'b0000000-0000-4000-8000-000000000001' and enabled = false));
  perform pg_temp.login('a_staff@a.test'); v := pg_temp.bell();
  perform pg_temp.res('44 after reset the role sees the type again', v like '%task_assigned%', v);
  perform pg_temp.login('a_crew_np@a.test'); v := pg_temp.bell();
  perform pg_temp.res('45 after reset the money default applies again', v not like '%payment_receipt%', v);
end $$;

-- ---- mapping + idempotent re-apply ------------------------------------------------------
do $$ begin perform pg_temp.su();
  perform pg_temp.res('46 raw kinds map to catalog types',
    public.notification_type_of('task_accept') = 'task_update' and public.notification_type_of('design_revise') = 'design_update'
    and public.notification_type_of('nurture_birthday') = 'nurture_greeting' and public.notification_type_of('event_update', 'whatsapp') = 'whatsapp_message'
    and public.notification_type_of('payment_reminder', 'whatsapp') = 'payment_reminder' and public.notification_type_of('mystery') = 'other'
    and public.notification_type_of(null) = 'other');
end $$;
do $$ begin perform pg_temp.su(); end $$;
create temp table _np_before as select count(*) as n from public.notification_prefs;
\i supabase/migrations/0036_notification_prefs.sql
set client_min_messages = warning;
do $$ begin perform pg_temp.su();
  perform pg_temp.res('47 re-applying 0036 keeps every row and installs the gate once',
    (select count(*) from public.notification_prefs) = (select n from _np_before)
    and (select count(*) from pg_trigger where tgname = 'zz_notification_prefs_gate' and tgrelid = 'public.notifications'::regclass) = 1);
end $$;

-- cleanup (superuser)
do $$ begin perform pg_temp.su();
  delete from public.notification_prefs where org_id in ('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001');
  delete from public.audit_log where action like 'notification_pref.%';
  delete from public.notifications where detail ->> 'np' = '1';
end $$;
select name, result from _np order by name;
select case when count(*) filter (where result like 'FAIL%') = 0 and count(*) = 47 then 'NOTIFICATION-PREFS: ALL PASS (47/47)'
            else 'NOTIFICATION-PREFS: '||count(*) filter (where result like 'FAIL%')||' FAILED, '||count(*)||'/47 ran' end from _np;
