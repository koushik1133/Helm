-- r27-hq-staff-0277.sql -- r27 Helm HQ staff roles: permission matrix enforced in every HQ gate, two-step always, invite /
-- role / suspend / restore / remove / sign out everywhere, last-Owner guard, HQ session idle / max age / ended, fresh code
-- for sensitive changes, optional IP allowlist, monitoring list, staff e-mail notices (queued only). Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
-- re-apply 0277 inside the test as a simulated FIRST run (re-run safe; later suites may have re-applied 0263 / 0271 bodies
-- and earlier suites re-created security@ as a plain operator): marker cleared, security@ back to the pre-0277 Admin role
update public.helm_hq_settings set r27_seeded_at = null where id;
update public.platform_admins set role = 'admin' where email = 'security@helm.events';
delete from public.platform_admins where email = 'k9@helm.events';   -- test only (rolled back): the first run adds it
set client_min_messages = error;
\ir ../../supabase/migrations/0277_hq_staff_roles.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
-- sign in as p_email at p_aal; p_extra is merged into the token (session_id, amr ...)
create or replace function pg_temp.as_user(p_email text, p_aal text, p_extra jsonb default '{}'::jsonb) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal) || coalesce(p_extra, '{}'::jsonb))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.st(p_email text) returns text language sql as $$ select status from public.platform_admins where email = p_email $$;
create or replace function pg_temp.mkuser(p_email text) returns void language plpgsql as $$
begin
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
end $$;

-- ---- the three HQ accounts set by the migration (owner, r27) ---------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('00a migration: admin@helm.events Owner (active), security@helm.events Security, sales@helm.events Sales (invited until first use)',
    exists (select 1 from public.platform_admins where email = 'admin@helm.events' and role = 'owner' and status = 'active')
    and exists (select 1 from public.platform_admins where email = 'security@helm.events' and role = 'security' and status in ('active', 'invited'))
    and exists (select 1 from public.platform_admins where email = 'sales@helm.events' and role = 'sales' and status in ('invited', 'active'))
    and exists (select 1 from public.platform_admins where email = 'k9@helm.events' and role = 'owner' and status = 'invited')
    and (select r27_seeded_at from public.helm_hq_settings where id) is not null,
    (select string_agg(email || ':' || role || ':' || status, ', ') from public.platform_admins));
  perform pg_temp.res('00b migration queued the sales@ invitation (log row + e-mail in the outbox)',
    exists (select 1 from public.hq_staff_events e join public.helm_notice_outbox o on o.ref_id = e.id
             where e.target_email = 'sales@helm.events' and e.kind = 'invited' and o.kind = 'hq_staff'));
exception when others then perform pg_temp.su(); insert into _rs values ('00x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- setup: one person per other role; sales@ set aside so the invite flow can be tested end to end ---------------
do $$ begin
  perform pg_temp.su();
  update public.platform_admins set status = 'removed', removed_at = now() where email = 'sales@helm.events';
  insert into public.platform_admins(email, added_by) values ('admin@helm.events', 'test') on conflict do nothing;
  insert into public.platform_admins(email, added_by, role) values
    ('sales1@helm.events', 'test', 'sales'), ('sec1@helm.events', 'test', 'security'),
    ('sup1@helm.events', 'test', 'support'), ('view1@helm.events', 'test', 'viewer'), ('adm1@helm.events', 'test', 'admin')
  on conflict do nothing;
  perform pg_temp.mkuser(e) from unnest(array['admin@helm.events', 'sales1@helm.events', 'sec1@helm.events', 'sup1@helm.events',
                                              'view1@helm.events', 'adm1@helm.events']) e;
  update public.helm_hq_settings set hq_require_mfa = false where id;   -- the old switch no longer matters
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) roles + the matrix in every gate ----------------------------------------------------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  perform pg_temp.res('01 migration: admin@helm.events is Owner, security@helm.events is Security (not Admin)',
    (select role from public.platform_admins where email = 'admin@helm.events') = 'owner'
    and (select role from public.platform_admins where email = 'security@helm.events') = 'security');
  perform pg_temp.as_user('admin@helm.events', 'aal1');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('02 two-step always: Owner at aal1 refused even with the old switch off', e like '42501%' and not public.is_platform_admin(), e);
  perform pg_temp.as_user('sales1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('03 Sales: Overview allowed', e = '', e);
  e := pg_temp.try('select public.hq_sales_requests(''new'')') || pg_temp.try('select public.hq_studios()');
  perform pg_temp.res('04 Sales: Requests + Studios (read) allowed', e = '', e);
  e := pg_temp.try('select public.hq_billing()');
  perform pg_temp.res('05 Sales: Billing refused (HQ_ROLE)', e like '42501%HQ_ROLE%', e);
  e := pg_temp.try('select public.hq_refresh_billing_status()');
  perform pg_temp.res('06 Sales: billing changes refused', e like '42501%HQ_ROLE%', e);
  e := pg_temp.try('select public.hq_audit()') || '|' || pg_temp.try('select public.hq_users()') || '|' || pg_temp.try('select public.hq_staff_list()');
  perform pg_temp.res('07 Sales: Activity log, People, Staff list refused', e like '42501%|42501%|42501%', e);
  perform pg_temp.as_user('view1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_overview()') || '|' || pg_temp.try('select public.hq_studios()');
  perform pg_temp.res('08 Viewer: Overview only', e like '|42501%HQ_ROLE%', e);
  perform pg_temp.as_user('sec1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_audit()') || pg_temp.try('select public.hq_security_alerts()') || pg_temp.try('select public.hq_staff_list()')
       || pg_temp.try('select public.hq_users()');
  perform pg_temp.res('09 Security: Activity, security notices, staff list, People allowed', e = '', e);
  e := pg_temp.try('select public.hq_billing()') || '|' || pg_temp.try('select public.hq_staff_invite(''x1@helm.events'', ''viewer'')');
  perform pg_temp.res('10 Security: Billing + adding staff refused', e like '42501%|42501%', e);
  perform pg_temp.as_user('sup1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_users()') || pg_temp.try('select public.hq_suggestions(''new'')') || '|' || pg_temp.try('select public.hq_plans()');
  perform pg_temp.res('11 Support: People + Requests allowed, Plans refused', e like '|42501%', e);
  perform pg_temp.as_user('adm1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_billing()') || '|' || pg_temp.try('select public.hq_staff_invite(''x2@helm.events'', ''viewer'')')
       || '|' || pg_temp.try('select public.hq_add_operator(''x3@helm.events'')');
  perform pg_temp.res('12 Admin: Billing allowed; adding staff (new + old function) Owner only', e like '|42501%|42501%', e);
  perform pg_temp.su();
  perform pg_temp.res('13 unknown HQ action / read = Owner only (fails closed)',
    public._hq27_write_perm('hq.something.new') = 'owner.only' and public._hq27_read_perm('hq_new_thing') = 'owner.only'
    and not ('owner.only' = any (public._hq27_role_perms('admin'))) and '*' = any (public._hq27_role_perms('owner')));
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) staff management ---------------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_invite('Sales@Helm.events ', 'sales', 'Sales team');
  perform pg_temp.su();
  perform pg_temp.res('14 Owner invites sales@helm.events: row invited, event logged, e-mail queued (hq_staff)',
    pg_temp.st('sales@helm.events') = 'invited' and (select role from public.platform_admins where email = 'sales@helm.events') = 'sales'
    and exists (select 1 from public.hq_staff_events where target_email = 'sales@helm.events' and kind = 'invited')
    and exists (select 1 from public.helm_notice_outbox o join public.hq_staff_events v on v.id = o.ref_id
                 where o.kind = 'hq_staff' and v.target_email = 'sales@helm.events')
    and exists (select 1 from public.audit_log where action = 'hq.staff.invite' and entity_id = 'sales@helm.events'), coalesce(r::text, ''));
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_invite(''sales@helm.events'', ''admin'')');
  perform pg_temp.res('15 inviting the same person twice refused', e like '22023%already%', e);
  e := pg_temp.try('select public.hq_staff_invite(''a_admin@a.test'', ''viewer'')');
  perform pg_temp.res('16 a studio member''s e-mail refused', e like '22023%studio member%', e);
  e := pg_temp.try('select public.hq_staff_invite(''x@helm.events'', ''god'')');
  perform pg_temp.res('17 unknown role refused', e like '22023%', e);
  -- the person signs in (reserved-domain guard: allowed because they are on the HQ list)
  perform pg_temp.su(); perform pg_temp.mkuser('sales@helm.events');
  perform pg_temp.as_user('sales@helm.events', 'aal1');
  r := public.hq_me();
  perform pg_temp.res('18 invited person before two-step: hq_me says role Sales, needs two-step; HQ refused',
    r ->> 'role' = 'sales' and (r ->> 'needs_2step')::boolean and r ->> 'status' = 'invited'
    and pg_temp.try('select public.hq_overview()') like '42501%', r::text);
  perform pg_temp.as_user('sales@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.su();
  perform pg_temp.res('19 first HQ use at aal2: active, bound to the login, activation logged',
    e = '' and pg_temp.st('sales@helm.events') = 'active'
    and (select user_id from public.platform_admins where email = 'sales@helm.events') = (select id from auth.users where email = 'sales@helm.events')
    and exists (select 1 from public.hq_staff_events where target_email = 'sales@helm.events' and kind = 'activated'), e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_set_role(''admin@helm.events'', ''admin'')') || '|' || pg_temp.try('select public.hq_staff_remove(''admin@helm.events'')');
  perform pg_temp.res('20 Owner can''t change own role or remove self', e like '22023%|22023%', e);
  perform pg_temp.su();
  e := pg_temp.try('update public.platform_admins set role = ''admin'' where email = ''admin@helm.events''')
       || '|' || pg_temp.try('delete from public.platform_admins where email = ''admin@helm.events''');
  perform pg_temp.res('21 last active Owner can''t be demoted / deleted - even from the SQL editor', e like '22023%|22023%'
    and (select role from public.platform_admins where email = 'admin@helm.events') = 'owner', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_set_role('sales@helm.events', 'support');
  perform pg_temp.su();
  perform pg_temp.res('22 role change Sales -> Support logged with old role',
    (select role from public.platform_admins where email = 'sales@helm.events') = 'support'
    and exists (select 1 from public.hq_staff_events where target_email = 'sales@helm.events' and kind = 'role_changed' and detail ->> 'old_role' = 'sales'));
  perform pg_temp.as_user('admin@helm.events', 'aal2'); perform public.hq_staff_set_role('sales@helm.events', 'sales');
  -- Security pauses Sales
  perform pg_temp.as_user('sec1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_suspend(''admin@helm.events'', ''testing pause'')');
  perform pg_temp.res('23 Security can''t pause an Owner', e like '42501%Owner%', e);
  e := pg_temp.try('select public.hq_staff_suspend(''sales@helm.events'', ''x'')');
  perform pg_temp.res('24 pausing needs a reason', e like '22023%reason%', e);
  r := public.hq_staff_suspend('sales@helm.events', 'laptop lost - paused');
  perform pg_temp.as_user('sales@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('25 Security pauses Sales: Sales refused at once, still an operator (no studio), hq_me says suspended',
    e like '42501%' and public.is_platform_operator() and public.hq_me() ->> 'status' = 'suspended', e);
  perform pg_temp.as_user('sec1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_restore(''sales@helm.events'')');
  perform pg_temp.res('26 Security can''t give access back (Owner only)', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform public.hq_staff_restore('sales@helm.events');
  perform pg_temp.su();
  perform pg_temp.res('27 Owner restores: active again', pg_temp.st('sales@helm.events') = 'active');
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_remove('sales@helm.events', 'left the company');
  perform pg_temp.as_user('sales@helm.events', 'aal2');
  e := (not public.is_platform_operator() and not public.is_platform_admin())::text;
  perform pg_temp.su();
  perform pg_temp.res('28 remove: row KEPT as removed; the person is no longer an operator / HQ user',
    pg_temp.st('sales@helm.events') = 'removed' and e = 'true', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_invite('sales@helm.events', 'viewer');
  perform pg_temp.su();
  perform pg_temp.res('29 re-inviting a removed person: invited again with the new role', pg_temp.st('sales@helm.events') = 'invited'
    and (select role from public.platform_admins where email = 'sales@helm.events') = 'viewer');
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_remove_operator('view1@helm.events');
  perform pg_temp.su();
  perform pg_temp.res('30 old hq_remove_operator no longer deletes the row', pg_temp.st('view1@helm.events') = 'removed');
  perform pg_temp.as_user('sales1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_set_role(''sup1@helm.events'', ''admin'')') || '|' || pg_temp.try('select public.hq_staff_remove(''sup1@helm.events'')');
  perform pg_temp.res('31 Sales can''t change roles or remove staff', e like '42501%|42501%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) sessions: idle, max age, signed out everywhere, fresh code -----------------------------------------------
do $$ declare e text; v_sid uuid := gen_random_uuid(); v_s2 uuid := gen_random_uuid(); v_s3 uuid := gen_random_uuid(); v_uid uuid; n int; begin
  perform pg_temp.su();
  select id into v_uid from auth.users where email = 'sup1@helm.events';
  insert into auth.sessions(id, user_id, created_at, user_agent, ip) values (v_sid, v_uid, now(), 'Mozilla/5.0 (Macintosh) Chrome/130', '203.0.113.42'),
    (v_s2, v_uid, now() - interval '13 hours', 'Safari', '198.51.100.7'), (v_s3, v_uid, now(), 'Firefox', '192.0.2.1');
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', v_sid));
  e := pg_temp.try('select public.hq_users()');
  perform pg_temp.su();
  perform pg_temp.res('32 first call in a session records it (started, last seen)', e = '' and exists (select 1 from public.hq_staff_sessions where session_id = v_sid), e);
  update public.hq_staff_sessions set last_seen_at = now() - interval '31 minutes' where session_id = v_sid;
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', v_sid));
  e := pg_temp.try('select public.hq_users()');
  perform pg_temp.res('33 31 minutes without HQ use: refused (HQ_SESSION_IDLE)', e like '42501%HQ_SESSION_IDLE%', e);
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', v_s2));
  e := pg_temp.try('select public.hq_users()');
  perform pg_temp.res('34 sign-in older than 12 hours: refused (HQ_SESSION_EXPIRED)', e like '42501%HQ_SESSION_EXPIRED%', e);
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', gen_random_uuid()));
  e := pg_temp.try('select public.hq_users()');
  perform pg_temp.res('35 a session Supabase no longer has (signed out): refused', e like '42501%HQ_SESSION_ENDED%', e);
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', v_s3));
  e := pg_temp.try('select public.hq_users()');
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  n := (public.hq_staff_signout('sup1@helm.events') ->> 'sessions_ended')::int;
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('session_id', v_s3));
  e := e || '|' || pg_temp.try('select public.hq_users()');
  perform pg_temp.su();
  perform pg_temp.res('36 "Sign out everywhere": every session marked ended (nothing deleted), HQ refused on it',
    n >= 3 and e like '|42501%HQ_SESSION_ENDED%' and (select count(*) from auth.sessions where user_id = v_uid) = 3, e || ' n=' || n);
  -- fresh code for sensitive changes (amr in the token)
  perform pg_temp.as_user('admin@helm.events', 'aal2', jsonb_build_object('amr', jsonb_build_array(
    jsonb_build_object('method', 'password', 'timestamp', extract(epoch from now())::bigint),
    jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 hour')::bigint))));
  e := pg_temp.try('select public.hq_billing()') || '|' || pg_temp.try('select public.hq_refresh_billing_status()')
       || '|' || pg_temp.try('select public.hq_staff_invite(''x5@helm.events'', ''viewer'')');
  perform pg_temp.res('37 code entered 1 h ago: reads fine, sensitive changes ask for a fresh code (HQ_REAUTH)', e like '|42501%HQ_REAUTH%|42501%HQ_REAUTH%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', jsonb_build_object('amr', jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '2 minutes')::bigint))));
  e := pg_temp.try('select public.hq_refresh_billing_status()');
  perform pg_temp.res('38 fresh code (2 min): change allowed', e = '', e);
  perform pg_temp.as_user('sup1@helm.events', 'aal2', jsonb_build_object('amr', jsonb_build_array(
    jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - interval '1 hour')::bigint))));
  e := pg_temp.try('select public.hq_set_suggestion(gen_random_uuid(), ''reviewed'', null)');
  perform pg_temp.res('39 everyday change (request status) does not need a fresh code', e not like '%HQ_REAUTH%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) IP allowlist, monitoring, heartbeat, e-mails, grants ----------------------------------------------------------
do $$ declare e text; r jsonb; x jsonb; n int; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform set_config('request.headers', '{"x-forwarded-for":"203.0.113.9, 10.0.0.1"}', false);
  e := pg_temp.try('select public.hq_set_staff_settings(30, 12, 15, true, array[''198.51.100.0/24''])');
  perform pg_temp.res('40 IP allowlist on without my own IP: refused (no lock-out)', e like '22023%203.0.113.9%', e);
  e := pg_temp.try('select public.hq_set_staff_settings(30, 12, 15, true, array[''203.0.113.0/24''])');
  perform set_config('request.headers', '{"x-forwarded-for":"198.51.100.5"}', false);
  e := e || '|' || pg_temp.try('select public.hq_overview()');
  perform set_config('request.headers', '{"x-forwarded-for":"203.0.113.77"}', false);
  e := e || '|' || pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('41 IP allowlist on: other network refused (HQ_IP), listed network fine', e like '|42501%HQ_IP%|', e);
  e := pg_temp.try('select public.hq_set_staff_settings(30, 12, 15, false, array[]::text[])');
  perform pg_temp.res('42 IP allowlist off again; bad values refused',
    e = '' and pg_temp.try('select public.hq_set_staff_settings(2, 12, 15, false, null)') like '22023%'
    and pg_temp.try('select public.hq_set_staff_settings(30, 12, 15, false, array[''not-an-ip''])') like '22023%', e);
  perform set_config('request.headers', '', false);
  perform pg_temp.as_user('sec1@helm.events', 'aal2');
  perform public.hq_heartbeat('overview'); perform public.hq_heartbeat('overview'); perform public.hq_heartbeat('<script>');
  perform pg_temp.su();
  select count(*) into n from public.hq_staff_activity a join auth.users u on u.id = a.user_id where u.email = 'sec1@helm.events';
  perform pg_temp.res('43 heartbeat: page views throttled (one per page per 5 min), bad page names cleaned', n = 2
    and not exists (select 1 from public.hq_staff_activity where page !~ '^[a-z][a-z0-9_-]*$'), 'n=' || n);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_list();
  select s into x from jsonb_array_elements(r -> 'staff') s where s ->> 'email' = 'sup1@helm.events';
  perform pg_temp.res('44 monitoring: role, status, 2-step, last sign-in, last active, sessions (IP shortened), recent changes',
    x ? 'role' and x ? 'status' and x ? 'has_2step' and x ? 'last_sign_in_at' and x ? 'last_active_at' and x ? 'recent'
    and jsonb_typeof(x -> 'sessions') = 'array' and r -> 'settings' ? 'idle_minutes'
    and r::text not like '%203.0.113.42%' and r::text not like '%quote%' and r::text not like '%client%', left(coalesce(x::text, r::text), 300));
  perform pg_temp.res('45 removed people hidden unless asked',
    not exists (select 1 from jsonb_array_elements(r -> 'staff') s where s ->> 'status' = 'removed')
    and exists (select 1 from jsonb_array_elements(public.hq_staff_list(true) -> 'staff') s where s ->> 'status' = 'removed'));
  perform pg_temp.su();
  perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
  select x2 into x from jsonb_array_elements(public.helm_notice_outbox_claim(100)) x2 where x2 ->> 'kind' = 'hq_staff' and x2 -> 'data' ->> 'event' = 'invited'
    and x2 -> 'data' ->> 'email' = 'sales@helm.events' limit 1;
  perform pg_temp.su();
  perform pg_temp.res('46 staff e-mail: to the person + the Owner, never from the row',
    x is not null and (x -> 'to') ? 'sales@helm.events' and (x -> 'to') ? 'admin@helm.events', coalesce(x::text, 'none'));
  e := pg_temp.try('update public.hq_staff_events set kind = ''removed''') || '|' || pg_temp.try('delete from public.hq_session_revocations')
       || '|' || pg_temp.try('delete from public.hq_staff_sessions');
  perform pg_temp.res('47 staff log, sign-out marks and sessions are append-only / never deleted', e like '42501%|42501%|42501%', e);
  perform pg_temp.res('48 grants: hq_me / staff functions signed-in only; internals and tables closed to the API',
    has_function_privilege('authenticated', 'public.hq_me()', 'execute') and not has_function_privilege('anon', 'public.hq_me()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_staff_invite(text,text,text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_staff_list(boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq27_require(text,boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq_gate(text,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._hq27_end_sessions(uuid,text)', 'execute')
    and not has_table_privilege('authenticated', 'public.hq_staff_sessions', 'select')
    and not has_table_privilege('authenticated', 'public.hq_staff_events', 'select'));
  select count(*) into n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'hq\_%'
     and has_function_privilege('authenticated', p.oid, 'execute') and p.proname not in ('hq_me')
     and p.prosrc !~ '(_hq_gate|_hq_wgate|_hq27_require|_r29_hq|_hq_studio_detail_core|hq_staff_invite|hq_staff_remove|hq_activate_plan__pre0328)\(';   -- r120 (0328): the wrapper calls the kept, gated 0287 body
  perform pg_temp.res('49 every HQ function a signed-in user can call goes through the permission gate', n = 0, 'ungated=' || n);
  perform pg_temp.as_user('sales1@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_stage_machine()') || '|' || pg_temp.try('select public.hq_studio_link_check(gen_random_uuid(), ''abc'')');
  perform pg_temp.res('50 hq_stage_machine / hq_studio_link_check: role checked too', e like '42501%|42501%', e);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) the second Owner k9@helm.events: pre-authorised, invited; the guard ignores it until it is active ------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.su();
  e := pg_temp.try('update public.platform_admins set role = ''admin'' where email = ''admin@helm.events''');
  perform pg_temp.res('52 an INVITED Owner (k9@) does not count: admin@ is still protected as the last active Owner', e like '22023%'
    and (select role from public.platform_admins where email = 'admin@helm.events') = 'owner', e);
  perform pg_temp.res('53 k9@helm.events may sign up on helm.events (reserved-domain rules allow pre-authorised HQ e-mails)',
    not public.email_is_reserved('k9@helm.events') and not public.email_is_reserved('sales@helm.events') and public.email_is_reserved('someone@helm.events')
    and public.signup_email_preauthorised(' K9@helm.events ') and not public.signup_email_preauthorised('someone@helm.events')
    and not public.signup_email_preauthorised('a@gmail.com') and has_function_privilege('anon', 'public.signup_email_preauthorised(text)', 'execute'));
  perform pg_temp.mkuser('k9@helm.events');   -- the auth.users guard (0248) lets it through
  perform pg_temp.as_user('k9@helm.events', 'aal1');
  r := public.hq_me();
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('54 k9@ before two-step: hq_me says Owner / invited / needs two-step; HQ refused', r ->> 'role' = 'owner' and r ->> 'status' = 'invited'
    and (r ->> 'needs_2step')::boolean and e like '42501%', r::text || ' ' || e);
  perform pg_temp.as_user('k9@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_overview()') || pg_temp.try('select public.hq_staff_list()');
  perform pg_temp.su();
  perform pg_temp.res('55 k9@ first HQ use with two-step: ACTIVE Owner, bound to its login; now two active Owners',
    e = '' and pg_temp.st('k9@helm.events') = 'active'
    and (select user_id from public.platform_admins where email = 'k9@helm.events') = (select id from auth.users where email = 'k9@helm.events')
    and (select count(*) from public.platform_admins where role = 'owner' and status = 'active') = 2, e);
  e := pg_temp.try('update public.platform_admins set role = ''admin'' where email = ''admin@helm.events''');
  perform pg_temp.res('56 with two active Owners one may step down (guard allows); the other is then protected', e = ''
    and pg_temp.try('update public.platform_admins set role = ''admin'' where email = ''k9@helm.events''') like '22023%', e);
  update public.platform_admins set role = 'owner' where email = 'admin@helm.events';
exception when others then perform pg_temp.su(); insert into _rs values ('5k9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) re-running 0277 changes nobody (no duplicates, nobody flipped back) -------------------------------------------
do $$ begin
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform public.hq_staff_set_role('security@helm.events', 'support');
  perform pg_temp.su();
end $$;
set client_min_messages = error;
\ir ../../supabase/migrations/0277_hq_staff_roles.sql
set client_min_messages = warning;
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('51 re-run: security@ keeps the role the Owner chose (support), k9@ stays an active Owner, nobody re-added, no duplicate invites',
    (select role from public.platform_admins where email = 'security@helm.events') = 'support'
    and (select role from public.platform_admins where email = 'admin@helm.events') = 'owner'
    and (select count(*) from public.platform_admins where email in ('admin@helm.events', 'k9@helm.events', 'sales@helm.events', 'security@helm.events')) = 4
    and pg_temp.st('k9@helm.events') = 'active' and (select role from public.platform_admins where email = 'k9@helm.events') = 'owner'
    and (select count(*) from public.hq_staff_events where target_email = 'sales@helm.events' and kind = 'invited' and detail ? 'by_migration') <= 1,
    (select string_agg(email || ':' || role || ':' || status, ', ') from public.platform_admins));
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R27-HQ-STAFF-0277: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R27-HQ-STAFF-0277: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
