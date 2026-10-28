-- r39-staff-google-0288.sql -- r39 Helm staff on @helm.events sign in ONLY with Google (switch helm_hq_settings.staff_google_only):
-- switch OFF -> nothing changes; ON -> password hook refuses helm.events (studio people untouched, 0053 lockout still counts),
-- HQ needs a helm.events Google session (amr 'oauth' + Workspace identity), magic-link / reset links never stored, new
-- helm.events identities only Google Workspace, optional custom-access-token hook, toggle = Owner + aal2 + fresh code +
-- own Google sign-in, audited; break-glass in SQL. Rolled back. Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role, supabase_auth_admin;
-- re-apply 0288 twice inside the test (re-run safe; proves the hook wrapper is not stacked)
set client_min_messages = error;
\ir ../../supabase/migrations/0288_staff_google_only.sql
\ir ../../supabase/migrations/0288_staff_google_only.sql
set client_min_messages = warning;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.headers', '', false); end $$;
-- p_how: 'google' (amr oauth), 'password', 'otp' (magic link); aal2 adds a totp entry p_code_age seconds old
create or replace function pg_temp.as_user(p_email text, p_aal text, p_how text default 'google', p_code_age integer default 10)
returns void language plpgsql as $$
declare u uuid; t double precision := extract(epoch from now()); amr jsonb;
begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  amr := jsonb_build_array(jsonb_build_object('method', case p_how when 'google' then 'oauth' else p_how end, 'timestamp', floor(t - 3600)));
  if p_aal = 'aal2' then amr := jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', floor(t - p_code_age))) || amr; end if;
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal, 'amr', amr))::text, false);
  execute 'set role authenticated';
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.mkuser(p_email text) returns uuid language plpgsql as $$
declare u uuid;
begin
  select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where id = u;
  return u;
end $$;
create or replace function pg_temp.uid(p_email text) returns uuid language sql as $$ select id from auth.users where email = p_email $$;
-- a Google identity as Supabase stores it (identity_data: email, email_verified, custom_claims.hd from Google's id token)
create or replace function pg_temp.google(p_email text, p_gmail text, p_hd text, p_verified boolean default true) returns void language plpgsql as $$
begin
  insert into auth.identities(user_id, identity_data, provider, provider_id, last_sign_in_at)
  values (pg_temp.uid(p_email), jsonb_build_object('sub', md5(p_gmail), 'email', p_gmail, 'email_verified', p_verified)
            || case when p_hd is null then '{}'::jsonb else jsonb_build_object('custom_claims', jsonb_build_object('hd', p_hd)) end,
          'google', md5(p_gmail), now());
end $$;
-- the hooks are called the way Supabase Auth calls them: as supabase_auth_admin (the event is built first, as the test owner)
create or replace function pg_temp.pwhook(p_email text, p_valid boolean) returns jsonb language plpgsql as $$
declare ev jsonb := jsonb_build_object('user_id', pg_temp.uid(p_email), 'valid', p_valid); r jsonb;
begin execute 'set role supabase_auth_admin'; r := public.hook_password_verification_attempt(ev); execute 'reset role'; return r; end $$;
create or replace function pg_temp.cathook(p_email text, p_method text) returns jsonb language plpgsql as $$
declare ev jsonb := jsonb_build_object('user_id', pg_temp.uid(p_email), 'authentication_method', p_method,
  'claims', jsonb_build_object('sub', pg_temp.uid(p_email), 'aal', 'aal1', 'amr', jsonb_build_array(jsonb_build_object('method', p_method, 'timestamp', 1)))); r jsonb;
begin execute 'set role supabase_auth_admin'; r := public.hook_custom_access_token_r39(ev); execute 'reset role'; return r; end $$;
-- the switch, read as the test owner
create or replace function pg_temp.sw() returns boolean language sql security definer as $$ select staff_google_only from public.helm_hq_settings where id $$;
grant execute on function pg_temp.sw() to anon, authenticated, service_role, supabase_auth_admin;

-- ---- setup: Owner admin@ (password login + linked Workspace Google), Sales sales1@, a non-helm.events operator, studio people
do $$ begin
  perform pg_temp.su();
  update public.helm_hq_settings set staff_google_only = false where id;
  insert into public.platform_admins(email, added_by, role, status) values ('admin@helm.events', 'test', 'owner', 'active') on conflict (email) do nothing;
  insert into public.platform_admins(email, added_by, role) values ('sales1@helm.events', 'test', 'sales'), ('hd1@helm.events', 'test', 'admin'),
    ('nohd@helm.events', 'test', 'admin'), ('gm1@helm.events', 'test', 'admin'), ('opx@ops.test', 'test', 'admin')
  on conflict do nothing;
  perform pg_temp.mkuser(e) from unnest(array['admin@helm.events', 'sales1@helm.events', 'hd1@helm.events', 'nohd@helm.events', 'gm1@helm.events', 'opx@ops.test']) e;
  perform pg_temp.google('admin@helm.events', 'admin@helm.events', 'helm.events');
  perform pg_temp.google('sales1@helm.events', 'sales1@helm.events', 'helm.events');
  perform pg_temp.google('hd1@helm.events', 'hd1@helm.events', 'helm.events', false);          -- hd only (verified flag off)
  perform pg_temp.google('nohd@helm.events', 'nohd@helm.events', null, false);                 -- neither hd nor verified
  perform pg_temp.google('gm1@helm.events', 'gm1@helm.events', 'helm.events');
  perform pg_temp.google('gm1@helm.events', 'somebody.personal@gmail.com', null);               -- a personal Gmail linked too
  perform pg_temp.google('opx@ops.test', 'opx@ops.test', null);
exception when others then perform pg_temp.su(); insert into _rs values ('0x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) switch OFF: nothing changes ------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.su();
  perform pg_temp.res('01 the switch exists and is OFF by default',
    (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'helm_hq_settings' and column_name = 'staff_google_only') = 'false'
    and not public._r39_on());
  r := pg_temp.pwhook('admin@helm.events', true);
  perform pg_temp.res('02 OFF: password hook lets admin@helm.events through (0053 body)', r ->> 'decision' = 'continue', r::text);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('03 OFF: Owner on a PASSWORD + two-step sign-in still uses HQ', e = '' and public.is_platform_admin(), e);
  r := public.staff_google_session_check();
  perform pg_temp.res('04 OFF: staff_google_session_check says no Google needed', not (r ->> 'needs_google')::boolean and not (r ->> 'on')::boolean, r::text);
  perform pg_temp.su();
  perform set_config('request.jwt.claims', '{"role":"anon"}', false); execute 'set role anon';
  perform pg_temp.res('05 OFF: sign-in page hint is off for admin@helm.events', not public.staff_google_only_for('admin@helm.events'));
  perform pg_temp.su();
  e := pg_temp.try('update auth.users set recovery_token = ''pkce_t1'' where email = ''admin@helm.events''');
  perform pg_temp.res('06 OFF: a reset / magic link for admin@helm.events can still be stored', e = '', e);
  update auth.users set recovery_token = '' where email = 'admin@helm.events';
  r := pg_temp.cathook('admin@helm.events', 'password');
  perform pg_temp.res('07 OFF: custom access token hook returns the claims unchanged', r ? 'claims' and not r ? 'error', r::text);
  e := pg_temp.try('insert into auth.identities(user_id, identity_data, provider, provider_id) values (pg_temp.uid(''sales1@helm.events''), ''{"email":"sales1@helm.events"}'', ''email'', ''x-sales1'')');
  perform pg_temp.res('08 OFF: a helm.events login may get a password (e-mail) identity', e = '', e);
exception when others then perform pg_temp.su(); insert into _rs values ('1x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) turning it ON: Owner only, two-step, fresh code, own Google sign-in, audited -------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.as_user('sales1@helm.events', 'aal2', 'google');
  e := pg_temp.try('select public.hq_set_staff_google_only(true)');
  perform pg_temp.res('10 Sales (not Owner) cannot turn it on', e like '42501%' and not pg_temp.sw(), e);
  perform pg_temp.as_user('admin@helm.events', 'aal1', 'google');
  e := pg_temp.try('select public.hq_set_staff_google_only(true)');
  perform pg_temp.res('11 Owner without two-step (aal1) cannot', e like '42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'google', 3600);
  e := pg_temp.try('select public.hq_set_staff_google_only(true)');
  perform pg_temp.res('12 Owner with an old two-step code must enter a fresh one (HQ_REAUTH)', e like '42501%HQ_REAUTH%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  e := pg_temp.try('select public.hq_set_staff_google_only(true)');
  perform pg_temp.res('13 Owner on a PASSWORD sign-in cannot turn it on (prove Google first)', e like '22023%Sign in to HQ with Google%' and not pg_temp.sw(), e);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'google');
  r := public.hq_staff_google_only();
  perform pg_temp.res('14 checklist: admin@ Google OK, nohd@ not, gm1@ not (personal Gmail linked), opx@ops.test not on helm.events',
    (r ->> 'my_session_google')::boolean and not (r ->> 'on')::boolean
    and exists (select 1 from jsonb_array_elements(r -> 'staff') x where x ->> 'email' = 'admin@helm.events' and (x ->> 'google_ok')::boolean)
    and exists (select 1 from jsonb_array_elements(r -> 'staff') x where x ->> 'email' = 'nohd@helm.events' and not (x ->> 'google_ok')::boolean)
    and exists (select 1 from jsonb_array_elements(r -> 'staff') x where x ->> 'email' = 'gm1@helm.events' and not (x ->> 'google_ok')::boolean)
    and exists (select 1 from jsonb_array_elements(r -> 'staff') x where x ->> 'email' = 'opx@ops.test' and not (x ->> 'on_domain')::boolean), r::text);
  r := public.hq_set_staff_google_only(true);
  perform pg_temp.su();
  perform pg_temp.res('15 Owner on a fresh helm.events Google sign-in turns it ON; audited (audit_log + staff log)',
    (r ->> 'on')::boolean and public._r39_on()
    and (select staff_google_only_changed_by from public.helm_hq_settings where id) = 'admin@helm.events'
    and exists (select 1 from public.audit_log where action = 'hq.staff.google_only' and changed ->> 'after' = 'true')
    and exists (select 1 from public.hq_staff_events where kind = 'settings' and detail -> 'staff_google_only' ->> 'after' = 'true'), coalesce(r::text, ''));
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) ON: password sign-in refused for helm.events, studio people untouched ------------------------------------------
do $$ declare r jsonb; r2 jsonb; r3 jsonb; begin
  perform pg_temp.su();
  r := pg_temp.pwhook('admin@helm.events', true); r2 := pg_temp.pwhook('sales1@helm.events', false);
  perform pg_temp.res('20 ON: password sign-in for admin@ (right password) and sales1@ (wrong one) refused with the Google message',
    r ->> 'decision' = 'reject' and r ->> 'message' = 'Helm staff sign in with Google. Use ''Continue with Google''.'
    and r2 ->> 'decision' = 'reject' and r2 ->> 'message' = r ->> 'message' and not (r ->> 'should_logout_user')::boolean, r::text || r2::text);
  r := pg_temp.pwhook('a_admin@a.test', true);
  r2 := pg_temp.pwhook('a_admin@a.test', false);
  perform pg_temp.res('21 ON: a studio person''s right password goes through; a wrong one is counted by the 0053 lockout as before',
    r ->> 'decision' = 'continue' and r2 ->> 'decision' = 'continue'
    and (select fails from public.auth_password_attempts where user_id = pg_temp.uid('a_admin@a.test')) = 1, r::text || r2::text);
  r3 := pg_temp.pwhook('opx@ops.test', true);
  perform pg_temp.res('22 ON: a non-helm.events address is never refused by the staff rule', r3 ->> 'decision' = 'continue', r3::text);
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) ON: HQ needs a helm.events Google session ------------------------------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  e := pg_temp.try('select public.hq_overview()');
  perform pg_temp.res('30 ON: Owner on a password + two-step sign-in: HQ refused, is_platform_admin false', e like '42501%' and not public.is_platform_admin(), e);
  r := public.staff_google_session_check();
  perform pg_temp.res('31 ON: staff_google_session_check tells that person to sign in with Google', (r ->> 'needs_google')::boolean and (r ->> 'login_google')::boolean, r::text);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'otp');
  perform pg_temp.res('32 ON: a magic-link (otp) + two-step session is refused', not public.is_platform_admin());
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'recovery');
  perform pg_temp.res('33 ON: a reset-link (recovery) session is refused', not public.is_platform_admin());
  perform pg_temp.as_user('admin@helm.events', 'aal1', 'google');
  perform pg_temp.res('34 ON: Google but no two-step: still refused (two-step stays mandatory)', not public.is_platform_admin());
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'google');
  e := pg_temp.try('select public.hq_overview()');
  r := public.staff_google_session_check();
  perform pg_temp.res('35 ON: Owner on Google + two-step uses HQ', e = '' and public.is_platform_admin() and not (r ->> 'needs_google')::boolean, e || r::text);
  perform pg_temp.as_user('sales1@helm.events', 'aal2', 'google');
  perform pg_temp.res('36 ON: Sales on Google + two-step uses HQ (role rules unchanged)', pg_temp.try('select public.hq_overview()') = ''
    and pg_temp.try('select public.hq_billing()') like '42501%HQ_ROLE%');
  perform pg_temp.as_user('hd1@helm.events', 'aal2', 'google');
  perform pg_temp.res('37 ON: Google said hd = helm.events -> allowed', public.is_platform_admin());
  perform pg_temp.as_user('nohd@helm.events', 'aal2', 'google');
  perform pg_temp.res('38 ON: Google identity without hd and not verified -> refused', not public.is_platform_admin());
  perform pg_temp.as_user('gm1@helm.events', 'aal2', 'google');
  perform pg_temp.res('39 ON: a login that also has a personal Gmail linked -> refused (can''t tell which Google was used)', not public.is_platform_admin());
  perform pg_temp.as_user('opx@ops.test', 'aal2', 'google');
  perform pg_temp.res('40 ON: an HQ operator NOT on helm.events -> refused even on Google', not public.is_platform_admin()
    and pg_temp.try('select public.hq_overview()') like '42501%');
  perform pg_temp.su();
  perform pg_temp.res('41 rule pieces: personal Gmail / unverified / wrong-user identity never pass',
    not public._r39_google_identity_ok('{"email":"x@gmail.com","email_verified":true}', 'x@gmail.com')
    and not public._r39_google_identity_ok('{"email":"x@helm.events","email_verified":false}', 'x@helm.events')
    and not public._r39_google_identity_ok('{"email":"y@helm.events","email_verified":true,"custom_claims":{"hd":"helm.events"}}', 'x@helm.events')
    and not public._r39_google_identity_ok('{"email":"x@gmail.com","email_verified":true,"custom_claims":{"hd":"helm.events"}}', 'x@gmail.com')
    and public._r39_google_identity_ok('{"email":"X@Helm.events","email_verified":false,"custom_claims":{"hd":"helm.events"}}', 'x@helm.events')
    and not public._r39_is_staff_email('x@team.helm.events') and not public._r39_is_staff_email('x@helm.events.evil.test')
    and public._r39_is_staff_email(' Admin@HELM.events. ') and not public._r39_is_staff_email('a@b@helm.events'));
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) ON: magic links / reset links, new identities, the optional token hook ------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.su();
  e := pg_temp.try('update auth.users set recovery_token = ''pkce_t2'', recovery_sent_at = now() where email = ''admin@helm.events''');
  perform pg_temp.res('50 ON: a reset / magic link for admin@helm.events is refused (never stored)',
    e like '42501%Helm staff sign in with Google%' and (select recovery_token from auth.users where email = 'admin@helm.events') = '', e);
  e := pg_temp.try('update auth.users set recovery_token = ''pkce_t3'', recovery_sent_at = now() where email = ''a_admin@a.test''');
  perform pg_temp.res('51 ON: a studio person''s reset / magic link still works', e = '' and (select recovery_token from auth.users where email = 'a_admin@a.test') = 'pkce_t3', e);
  e := pg_temp.try('update auth.users set recovery_token = '''' where email = ''admin@helm.events''');
  perform pg_temp.res('52 ON: clearing a link (Supabase after use) is never blocked', e = '', e);
  e := pg_temp.try('insert into auth.identities(user_id, identity_data, provider, provider_id) values (pg_temp.uid(''hd1@helm.events''), ''{"email":"hd1@helm.events"}'', ''email'', ''x-hd1'')');
  perform pg_temp.res('53 ON: a password (e-mail) identity for a helm.events login is refused', e like '42501%Google%', e);
  e := pg_temp.try('select pg_temp.google(''hd1@helm.events'', ''hd1.personal@gmail.com'', null)');
  perform pg_temp.res('54 ON: linking a personal Gmail to a helm.events login is refused', e like '42501%', e);
  e := pg_temp.try('select pg_temp.mkuser(''newstaff1@helm.events'')');
  perform pg_temp.res('55 ON: a NEW helm.events login made with a password is refused (whole sign-up undone)', e like '42501%'
    and not exists (select 1 from auth.users where email = 'newstaff1@helm.events'), e);
  e := pg_temp.try('select pg_temp.mkuser(''newperson@studio.test'')');
  perform pg_temp.res('56 ON: a studio person signs up with a password as before', e = '' and exists (select 1 from auth.users where email = 'newperson@studio.test'), e);
  e := pg_temp.try('update auth.identities set identity_data = identity_data || ''{"name":"Admin"}'' where user_id = pg_temp.uid(''admin@helm.events'') and provider = ''google''');
  perform pg_temp.res('57 ON: a Google sign-in refreshing an existing identity is never blocked', e = '', e);
  r := pg_temp.cathook('admin@helm.events', 'password');
  perform pg_temp.res('58 ON: optional token hook - no token for a helm.events PASSWORD sign-in (403 + message)',
    (r -> 'error' ->> 'http_code')::int = 403 and r -> 'error' ->> 'message' like 'Helm staff sign in with Google%', r::text);
  r := pg_temp.cathook('admin@helm.events', 'magiclink');
  perform pg_temp.res('59 ON: optional token hook - no token for a helm.events MAGIC LINK', r ? 'error', r::text);
  r := pg_temp.cathook('admin@helm.events', 'oauth');
  perform pg_temp.res('60 ON: optional token hook - Google sign-in gets its claims unchanged', r ? 'claims' and not r ? 'error' and r -> 'claims' ->> 'aal' = 'aal1', r::text);
  r := pg_temp.cathook('a_admin@a.test', 'password');
  perform pg_temp.res('61 ON: optional token hook - studio password sign-in gets its claims unchanged', r ? 'claims' and not r ? 'error', r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) studio people completely unaffected; grants -----------------------------------------------------------------------
do $$ declare e text; o1 uuid; begin
  perform pg_temp.su();
  perform auth.login_as(pg_temp.uid('a_admin@a.test'));
  perform set_config('request.jwt.claims', (auth.jwt() || '{"aal":"aal1","amr":[{"method":"password","timestamp":1}]}'::jsonb)::text, false);
  execute 'set role authenticated';
  o1 := public.current_org_id();
  perform pg_temp.res('70 ON: a studio admin on a password sign-in works as before (own studio, not HQ)', o1 is not null and not public.is_platform_admin()
    and pg_temp.try('select count(*) from public.profiles') = '' and pg_temp.try('select public.staff_google_session_check()') like '42501%');
  perform pg_temp.su();
  perform pg_temp.res('71 grants: anon can only ask the sign-in hint; the HQ ones are signed-in only; the rule pieces nobody',
    has_function_privilege('anon', 'public.staff_google_only_for(text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_set_staff_google_only(boolean)', 'execute')
    and not has_function_privilege('anon', 'public.hq_staff_google_only()', 'execute')
    and not has_function_privilege('anon', 'public.staff_google_session_check()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_set_staff_google_only(boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public._r39_login_ok(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.hook_password_verification_attempt(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.hook_password_verification_attempt__pre0288(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.hook_custom_access_token_r39(jsonb)', 'execute')
    and has_function_privilege('supabase_auth_admin', 'public.hook_password_verification_attempt(jsonb)', 'execute')
    and has_function_privilege('supabase_auth_admin', 'public.hook_custom_access_token_r39(jsonb)', 'execute'));
  perform pg_temp.res('72 the hook is wrapped once (0053 body kept as *__pre0288, called by the wrapper)',
    position('r39-staff-google-0288' in (select prosrc from pg_proc where oid = 'public.hook_password_verification_attempt(jsonb)'::regprocedure)) > 0
    and position('r39-staff-google-0288' in (select prosrc from pg_proc where oid = 'public.hook_password_verification_attempt__pre0288(jsonb)'::regprocedure)) = 0
    and position('auth_password_attempts' in (select prosrc from pg_proc where oid = 'public.hook_password_verification_attempt__pre0288(jsonb)'::regprocedure)) > 0);
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) a later re-run of 0053 is re-wrapped by 0288 ----------------------------------------------------------------------
set client_min_messages = error;
\ir ../../supabase/migrations/0053_password_lockout.sql
\ir ../../supabase/migrations/0288_staff_google_only.sql
set client_min_messages = warning;
do $$ declare r jsonb; begin
  perform pg_temp.su();
  r := pg_temp.pwhook('admin@helm.events', true);
  perform pg_temp.res('73 0053 re-run then 0288 re-run: wrapper back on top, still refuses staff, switch kept ON',
    r ->> 'decision' = 'reject' and public._r39_on()
    and position('r39-staff-google-0288' in (select prosrc from pg_proc where oid = 'public.hook_password_verification_attempt(jsonb)'::regprocedure)) > 0, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) turning it OFF again from HQ; break-glass from the SQL editor -----------------------------------------------------
do $$ declare e text; r jsonb; begin
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'google');
  r := public.hq_set_staff_google_only(false);
  perform pg_temp.su();
  perform pg_temp.res('80 Owner on Google turns it OFF from HQ (audited); password + two-step works in HQ again',
    not (r ->> 'on')::boolean and not public._r39_on()
    and exists (select 1 from public.hq_staff_events where kind = 'settings' and detail -> 'staff_google_only' ->> 'after' = 'false'), r::text);
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  perform pg_temp.res('81 OFF again: Owner on password + two-step is back in HQ', public.is_platform_admin());
  -- break-glass: switch ON, Owner only has a password sign-in; the SQL editor (superuser) turns it off
  perform pg_temp.su();
  update public.helm_hq_settings set staff_google_only = true where id;
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  e := pg_temp.try('select public.hq_set_staff_google_only(false)');
  perform pg_temp.res('82 no app-side bypass: a password session cannot turn the switch off', e like '42501%' and pg_temp.sw(), e);
  perform pg_temp.su();
  update public.helm_hq_settings set staff_google_only = false, staff_google_only_changed_at = now(),
         staff_google_only_changed_by = 'break-glass (SQL editor)' where id;
  perform pg_temp.as_user('admin@helm.events', 'aal2', 'password');
  perform pg_temp.res('83 break-glass SQL (switch off) lets the Owner back in with password + two-step', public.is_platform_admin());
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R39-STAFF-GOOGLE-0288: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R39-STAFF-GOOGLE-0288: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
