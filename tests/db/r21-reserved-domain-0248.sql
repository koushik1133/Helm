-- r21-reserved-domain-0248.sql -- 0248: Helm's own e-mail domains (helm.events, helm.com) are not for customers.
-- The Supabase Auth "Before User Created" hook (called the way GoTrue calls it: as supabase_auth_admin, with the
-- documented event shape), the auth.users / invitations backstop triggers, the allowlist, HQ "Staff access"
-- (operators only, audited) and that existing logins are never changed. Rolled back.
-- Local disposable PG only. Fake data only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _rd(name text, result text); grant all on _rd to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.as_user(p_email text, p_aal text) returns void language plpgsql as $$
declare u uuid; begin perform pg_temp.su(); select id into u from auth.users where email = p_email; perform auth.login_as(u);
  perform set_config('request.jwt.claims', (auth.jwt() || jsonb_build_object('aal', p_aal))::text, false);
  execute 'set role authenticated'; end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rd values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role, supabase_auth_admin;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role, supabase_auth_admin;
-- the hook exactly as GoTrue calls it (role supabase_auth_admin, documented payload)
create or replace function pg_temp.hook(p_email text, p_provider text default 'email') returns jsonb language plpgsql as $$
declare r jsonb; begin
  execute 'set local role supabase_auth_admin';
  r := public.hook_before_user_created(jsonb_build_object(
         'metadata', jsonb_build_object('uuid', gen_random_uuid(), 'time', now(), 'name', 'before-user-created', 'ip_address', '127.0.0.1'),
         'user', jsonb_build_object('id', gen_random_uuid(), 'aud', 'authenticated', 'role', '', 'email', p_email, 'phone', '',
                   'app_metadata', jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider)),
                   'user_metadata', '{}'::jsonb, 'identities', '[]'::jsonb, 'is_anonymous', false)));
  execute 'reset role';
  return r;
end $$;
create or replace function pg_temp.blocked(r jsonb) returns boolean language sql as $$
  select (r -> 'error' ->> 'http_code') = '403' and (r -> 'error' ->> 'message') like 'Addresses on % are reserved for the Helm team.%'
         and (select count(*) from jsonb_object_keys(r)) = 1 $$;

-- ---- 1) the hook: blocks reserved, allows the rest -------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.su();
  r := pg_temp.hook('anil@helm.events');
  perform pg_temp.res('01 hook: anil@helm.events blocked with {"error":{"http_code":403,"message":...}}', pg_temp.blocked(r), r::text);
  perform pg_temp.res('02 hook: message names the domain', r -> 'error' ->> 'message' = 'Addresses on helm.events are reserved for the Helm team. Please use your own e-mail address.', r::text);
  perform pg_temp.res('03 hook: helm.com blocked too', pg_temp.blocked(pg_temp.hook('someone@helm.com')));
  perform pg_temp.res('04 hook: sub-domain blocked (x@team.helm.events, a@mail.helm.com)', pg_temp.blocked(pg_temp.hook('x@team.helm.events')) and pg_temp.blocked(pg_temp.hook('a@mail.helm.com')));
  perform pg_temp.res('05 hook: case + spaces + trailing dot blocked', pg_temp.blocked(pg_temp.hook('  Anil@HELM.Events.  ')) and pg_temp.blocked(pg_temp.hook('ANIL@Helm.Com')));
  perform pg_temp.res('06 hook: plus-tag on an allowlisted address is NOT allowlisted (admin+x@helm.events blocked)', pg_temp.blocked(pg_temp.hook('admin+x@helm.events')));
  perform pg_temp.res('07 hook: quoted local part with @ still judged by the real domain', pg_temp.blocked(pg_temp.hook('"a@gmail.com"@helm.events')));
  perform pg_temp.res('08 hook: Google OAuth sign-up blocked the same way', pg_temp.blocked(pg_temp.hook('anil@helm.events', 'google')));
  perform pg_temp.res('09 hook: normal e-mails pass with {}',
    pg_temp.hook('anil@gmail.com') = '{}'::jsonb and pg_temp.hook('owner@studio.in') = '{}'::jsonb
    and pg_temp.hook('anil@helm.events.example.com') = '{}'::jsonb and pg_temp.hook('anil@nothelm.events') = '{}'::jsonb
    and pg_temp.hook('anil@helm.eventsx') = '{}'::jsonb and pg_temp.hook('helm.events@gmail.com') = '{}'::jsonb);
  perform pg_temp.res('10 hook: allowlisted staff (admin@ / security@) pass', pg_temp.hook('admin@helm.events') = '{}'::jsonb and pg_temp.hook('Security@Helm.Events') = '{}'::jsonb);
  -- phone / anonymous sign-ups (no e-mail) and malformed events never block
  execute 'set local role supabase_auth_admin';
  r := public.hook_before_user_created('{"user":{"email":"","phone":"+919800000000"}}'::jsonb);
  e := public.hook_before_user_created('{}'::jsonb)::text || public.hook_before_user_created('{"user":"x"}'::jsonb)::text || public.hook_before_user_created('null'::jsonb)::text;
  execute 'reset role';
  perform pg_temp.res('11 hook: phone / anonymous / malformed events pass ({})', r = '{}'::jsonb and e = '{}{}{}', r::text || ' ' || e);
exception when others then execute 'reset role'; insert into _rd values ('1x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) allowlist + look-alike domains ---------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  insert into public.staff_email_allowlist(email, note, added_by) values ('newhire@helm.events', 'test', 'test');
  perform pg_temp.res('12 allowlist: an allowlisted address passes the hook', pg_temp.hook('newhire@helm.events') = '{}'::jsonb and pg_temp.hook(' NewHire@helm.events ') = '{}'::jsonb);
  update public.staff_email_allowlist set removed_at = now() where email = 'newhire@helm.events';
  perform pg_temp.res('13 allowlist: a removed row no longer counts', pg_temp.blocked(pg_temp.hook('newhire@helm.events')));
  insert into public.platform_admins(email, added_by) values ('ops-op@helm.events', 'test');
  perform pg_temp.res('14 an HQ operator address always counts as allowlisted', pg_temp.hook('ops-op@helm.events') = '{}'::jsonb);
  insert into public.reserved_email_domains(domain, builtin, added_by) values ('helm-events.com', false, 'test');
  perform pg_temp.res('15 look-alike domain added in the table is blocked (and its sub-domains)',
    pg_temp.blocked(pg_temp.hook('support@helm-events.com')) and pg_temp.blocked(pg_temp.hook('x@a.helm-events.com')));
  update public.reserved_email_domains set removed_at = now() where domain = 'helm-events.com';
  perform pg_temp.res('16 a removed look-alike domain passes again', pg_temp.hook('support@helm-events.com') = '{}'::jsonb);
exception when others then execute 'reset role'; insert into _rd values ('2x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) backstop: auth.users + invitations triggers (routes the hook does not see) --------------------------
do $$ declare e text; u uuid; v_before text; v_n int; begin
  perform pg_temp.su();
  -- admin API createUser / admin_create_user_temp both end in an INSERT into auth.users
  e := pg_temp.try('select auth.seed_user(''anil2@helm.events'')');
  perform pg_temp.res('17 trigger: new login on a reserved domain refused (admin API path)', e like '42501 Addresses on helm.events are reserved%', e);
  e := pg_temp.try('select auth.seed_user(''Mixed@Team.HELM.com'')');
  perform pg_temp.res('18 trigger: sub-domain + case refused', e like '42501 Addresses on helm.com are reserved%', e);
  e := pg_temp.try('select auth.seed_user(''r248-normal@gmail.test'')');
  perform pg_temp.res('19 trigger: a normal new login is created', e = '' and exists (select 1 from auth.users where email = 'r248-normal@gmail.test'), e);
  insert into public.staff_email_allowlist(email, added_by) values ('hire2@helm.events', 'test');
  e := pg_temp.try('select auth.seed_user(''hire2@helm.events'')');
  perform pg_temp.res('20 trigger: an allowlisted staff login can be created', e = '', e);
  -- e-mail change to a reserved address (direct and pending email_change)
  select id into u from auth.users where email = 'r248-normal@gmail.test';
  e := pg_temp.try(format('update auth.users set email = %L where id = %L', 'anil@helm.events', u));
  perform pg_temp.res('21 trigger: changing a login e-mail to a reserved address refused', e like '42501%', e);
  e := pg_temp.try(format('update auth.users set email_change = %L where id = %L', 'anil@HELM.events', u));
  perform pg_temp.res('22 trigger: a pending e-mail change (email_change) to a reserved address refused', e like '42501%', e);
  e := pg_temp.try(format('update auth.users set email = %L where id = %L', 'r248-other@gmail.test', u));
  perform pg_temp.res('23 trigger: a normal e-mail change still works', e = '' and exists (select 1 from auth.users where id = u and email = 'r248-other@gmail.test'), e);
  -- an EXISTING reserved-domain login (made before 0248) keeps working: sign-ins, bans, password changes
  alter table auth.users disable trigger a248_reserved_email_guard;
  insert into auth.users(id, aud, role, email, email_confirmed_at, created_at, updated_at) values
    ('f0000000-0000-4000-8000-000000248a01', 'authenticated', 'authenticated', 'anil@helm.events', now(), now() - interval '2 days', now());
  alter table auth.users enable trigger a248_reserved_email_guard;
  select md5(row(x.*)::text) into v_before from auth.users x where x.id = 'f0000000-0000-4000-8000-000000248a01';
  e := pg_temp.try('update auth.users set last_sign_in_at = now(), updated_at = now() where id = ''f0000000-0000-4000-8000-000000248a01''')
    || pg_temp.try('update auth.users set email = email, email_change = '''' where id = ''f0000000-0000-4000-8000-000000248a01''')
    || pg_temp.try('update auth.users set email = ''ANIL@helm.events'' where id = ''f0000000-0000-4000-8000-000000248a01''')
    || pg_temp.try('update auth.users set encrypted_password = ''x'' where id = ''f0000000-0000-4000-8000-000000248a01''');
  perform pg_temp.res('24 trigger: an existing reserved login is not blocked from sign-in / same-e-mail updates', e = '', e);
  -- invitations: a studio can't invite a reserved address (existing rows untouched)
  select count(*) into v_n from public.invitations;
  e := pg_temp.try('insert into public.invitations(org_id, email, role) values (''a0000000-0000-4000-8000-000000000001'', ''anil@helm.events'', ''sales'')');
  perform pg_temp.res('25 trigger: new invitation to a reserved address refused', e like '22023 Addresses on helm.events are reserved%', e);
  e := pg_temp.try('insert into public.invitations(org_id, email, role) values (''a0000000-0000-4000-8000-000000000001'', ''r248-inv@gmail.test'', ''sales'')');
  perform pg_temp.res('26 trigger: a normal invitation is created', e = '' and (select count(*) from public.invitations) = v_n + 1, e);
  e := pg_temp.try('update public.invitations set email = ''x@team.helm.events'' where email = ''r248-inv@gmail.test''');
  perform pg_temp.res('27 trigger: changing an invitation e-mail to a reserved address refused', e like '22023%', e);
exception when others then execute 'reset role'; insert into _rd values ('3x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- the real RPCs a studio admin uses end in the same refusal (Control Center temp password, invite)
do $$ declare e text; begin
  perform pg_temp.as_user('a_admin@a.test', 'aal1');
  e := pg_temp.try('select public.admin_create_user_temp(''anil3@helm.events'', ''sales'')');
  perform pg_temp.res('28 RPC: admin_create_user_temp refused for a reserved address', e like '42501 Addresses on helm.events%', e);
  e := pg_temp.try('select public.create_invitation(''anil3@helm.events'', ''sales'')');
  perform pg_temp.res('29 RPC: create_invitation refused for a reserved address', e like '%Addresses on helm.events are reserved%', e);
  e := pg_temp.try('select public.create_invitation(''r248-inv2@gmail.test'', ''sales'')');
  perform pg_temp.res('30 RPC: create_invitation still works for a normal address', e = '', e);
  perform pg_temp.res('31 clients cannot read the lists or call the checks',
    pg_temp.try('select * from public.staff_email_allowlist') like '42501%' and pg_temp.try('select * from public.reserved_email_domains') like '42501%'
    and pg_temp.try('select public.email_is_reserved(''a@helm.events'')') like '42501%'
    and pg_temp.try('select public.hook_before_user_created(''{}''::jsonb)') like '42501%');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _rd values ('4x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) HQ "Staff access" -----------------------------------------------------------------------------------
do $$ declare r jsonb; e text; begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'admin@helm.events') then perform auth.seed_user('admin@helm.events'); end if;
  update auth.users set email_confirmed_at = now() where email = 'admin@helm.events';
  delete from auth.mfa_factors where user_id in (select id from auth.users where email = 'admin@helm.events');
  -- a studio admin is not an operator
  perform pg_temp.as_user('a_admin@a.test', 'aal2');
  e := pg_temp.try('select public.hq_staff_access()') || '|' || pg_temp.try('select public.hq_staff_allow_add(''x9@helm.events'', null)');
  perform pg_temp.res('32 HQ: a studio admin is refused (read + write)', e like '42501%|42501%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  r := public.hq_staff_access();
  perform pg_temp.res('33 HQ: operator sees domains + allowlist + existing reserved logins',
    jsonb_array_length(r -> 'domains') >= 2 and r -> 'allowlist' @> '[{"email":"admin@helm.events"}]'::jsonb
    and r -> 'accounts' @> '[{"email":"anil@helm.events","allowlisted":false,"is_platform_admin":false}]'::jsonb
    and r -> 'accounts' @> '[{"email":"admin@helm.events","allowlisted":true,"is_platform_admin":true}]'::jsonb, r::text);
  perform public.hq_staff_allow_add(' Future.Hire@HELM.events ', 'support team');
  perform pg_temp.su();
  perform pg_temp.res('34 HQ: add normalises the address and the hook now lets it through',
    exists (select 1 from public.staff_email_allowlist where email = 'future.hire@helm.events' and removed_at is null)
    and pg_temp.hook('future.hire@helm.events') = '{}'::jsonb);
  perform pg_temp.res('35 HQ: add is audit-logged', exists (select 1 from public.audit_log where action = 'hq.staff_allowlist.add' and entity_id = 'future.hire@helm.events'));
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  e := pg_temp.try('select public.hq_staff_allow_add(''someone@gmail.com'', null)');
  perform pg_temp.res('36 HQ: a non-reserved address is not added', e like '22023%', e);
  perform public.hq_staff_allow_remove('future.hire@helm.events');
  e := pg_temp.try('select public.hq_staff_allow_remove(''admin@helm.events'')');
  perform pg_temp.su();
  perform pg_temp.res('37 HQ: remove keeps the row (removed_at) and blocks again; an operator address cannot be removed',
    exists (select 1 from public.staff_email_allowlist where email = 'future.hire@helm.events' and removed_at is not null)
    and pg_temp.blocked(pg_temp.hook('future.hire@helm.events')) and e like '22023%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform public.hq_reserved_domain_add('@Helm-Events.IN.', 'look-alike');
  e := pg_temp.try('select public.hq_reserved_domain_remove(''helm.events'')') || '|' || pg_temp.try('select public.hq_reserved_domain_add(''not a domain'', null)');
  perform pg_temp.su();
  perform pg_temp.res('38 HQ: look-alike domain added (normalised) and blocked; built-in domain cannot be removed; bad input refused',
    pg_temp.blocked(pg_temp.hook('x@helm-events.in')) and e like '22023%|22023%', e);
  perform pg_temp.as_user('admin@helm.events', 'aal2');
  perform public.hq_reserved_domain_remove('helm-events.in');
  perform pg_temp.su();
  perform pg_temp.res('39 HQ: removing a look-alike keeps the row and lets the domain through',
    exists (select 1 from public.reserved_email_domains where domain = 'helm-events.in' and removed_at is not null) and pg_temp.hook('x@helm-events.in') = '{}'::jsonb
    and exists (select 1 from public.audit_log where action = 'hq.reserved_domain.remove' and entity_id = 'helm-events.in'));
  perform pg_temp.su();
  perform pg_temp.res('40 nothing deleted: built-in domains + seeded allowlist intact',
    (select count(*) from public.reserved_email_domains where builtin and removed_at is null) = 2
    and (select count(*) from public.staff_email_allowlist where email in ('admin@helm.events', 'security@helm.events') and removed_at is null) = 2);
exception when others then perform pg_temp.su(); insert into _rd values ('5x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) the owner's optional disable script (banned_until; reversible) -----------------------------------
do $$ declare e text; begin
  perform pg_temp.su();
  alter table auth.users add column if not exists banned_until timestamptz;   -- the shim lacks it; real Supabase has it
  e := pg_temp.try($q$update auth.users set banned_until = '2999-12-31 00:00:00+00' where lower(email) = 'anil@helm.events' and banned_until is null$q$);
  perform pg_temp.res('41 a ban update on an existing reserved login is not blocked by the guard', e = '' and
    (select banned_until is not null from auth.users where lower(email) = 'anil@helm.events'), e);
  e := pg_temp.try($q$update auth.users set banned_until = null where lower(email) = 'anil@helm.events'$q$);
  perform pg_temp.res('42 ...and is reversible', e = '' and (select banned_until is null from auth.users where lower(email) = 'anil@helm.events'), e);
exception when others then perform pg_temp.su(); insert into _rd values ('6x setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rd order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R21-RESERVED-DOMAIN-0248: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R21-RESERVED-DOMAIN-0248: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rd;
rollback;
