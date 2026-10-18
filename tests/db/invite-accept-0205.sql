-- invite-accept-0205.sql -- 0205: invite_account_state / my_needs_password / invite_auth_user_id / invite_request_new_link.
-- Proves: only the service role can ask invite_account_state, only for ONE pending + unexpired
-- invitation (bad / unknown / expired / revoked / accepted tokens -> valid false), it reports only
-- valid / account / confirmed for the invitation's OWN e-mail (none / needs_password / existing,
-- case-insensitive), a password or a Google sign-in counts as a real account; my_needs_password()
-- answers only for the caller's own login; nothing is written; the invite token is single-use; and
-- pending invitations still count toward a free trial's admin + 2 seat limit. Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
-- re-apply 0205 inside this rolled-back tx (also proves a second run is harmless)
\ir ../../supabase/migrations/0205_invite_account_state.sql
create temp table _ia(name text, result text); grant all on _ia to anon, authenticated, service_role;
create temp table _iakv(k text primary key, v text); grant all on _iakv to anon, authenticated, service_role;

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
create or replace function pg_temp.svc() returns void language plpgsql as $$
begin perform pg_temp.su(); perform set_config('request.jwt.claims', '{"role":"service_role"}', false); perform set_config('role', 'service_role', false); end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _ia values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare v text; begin
  execute p_sql into v; return 'ok:' || coalesce(v, '');
exception when others then return 'err:' || sqlstate || ':' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _iakv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _iakv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
-- a login like the Supabase "Invite user" e-mail makes: no password, not confirmed, e-mail identity only
create or replace function pg_temp.invited_user(p_email text, p_provider text default 'email') returns uuid language plpgsql as $$
declare u uuid; begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, invited_at,
                          confirmation_token, recovery_token, email_change, email_change_token_new,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (gen_random_uuid(), 'authenticated', 'authenticated', p_email, '', null, now(), '', '', '', '',
          jsonb_build_object('provider', p_provider), '{}'::jsonb, now(), now())
  returning id into u;
  insert into auth.identities (user_id, identity_data, provider, provider_id)
    values (u, jsonb_build_object('sub', u::text, 'email', p_email), p_provider, u::text);
  return u;
end $$;
create or replace function pg_temp.inv(p_org uuid, p_email text, p_status text default 'pending', p_exp interval default interval '7 days', p_role text default 'planner')
returns text language plpgsql as $$
declare t text; begin
  insert into public.invitations(org_id, email, role, status, expires_at)
    values (p_org, p_email, p_role, p_status, now() + p_exp) returning token into t;
  return t;
end $$;
create or replace function pg_temp.state(p_key text) returns jsonb language plpgsql as $$
declare r jsonb; begin
  perform pg_temp.svc(); r := public.invite_account_state(pg_temp.get(p_key)); perform pg_temp.su(); return r;
end $$;
create or replace function pg_temp.fp() returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(i)::text, ',' order by i.id) from public.invitations i),
    (select string_agg(to_jsonb(u)::text, ',' order by u.id) from auth.users u),
    (select string_agg(to_jsonb(d)::text, ',' order by d.id) from auth.identities d)));
$$;

-- ---- setup (superuser) ---------------------------------------------------------------------------
do $$ declare a uuid := 'a0000000-0000-4000-8000-000000000001'; begin
  perform pg_temp.su();
  perform pg_temp.put('tNew',  pg_temp.inv(a, 'New.Invitee@IA.test'));
  perform pg_temp.put('tNoPw', pg_temp.inv(a, 'NoPw@IA.test'));          -- invite row in mixed case
  perform pg_temp.invited_user('nopw@ia.test');                           -- login lower case
  perform pg_temp.put('tHasPw', pg_temp.inv(a, 'haspw@ia.test'));
  perform auth.seed_user('haspw@ia.test');
  perform pg_temp.put('tGoogle', pg_temp.inv(a, 'google@ia.test'));
  perform pg_temp.invited_user('google@ia.test', 'google');
  perform pg_temp.put('tExpired', pg_temp.inv(a, 'late@ia.test', 'pending', interval '-1 minute'));
  perform pg_temp.invited_user('late@ia.test');
  perform pg_temp.put('tRevoked', pg_temp.inv(a, 'gone@ia.test', 'revoked'));
  perform pg_temp.put('tSelf', pg_temp.inv(a, 'selfsignup@ia.test'));       -- signed up on their own first, never confirmed
  perform auth.seed_user('selfsignup@ia.test');
  update auth.users set email_confirmed_at = null where email = 'selfsignup@ia.test';
  perform pg_temp.invited_user('gone@ia.test');
exception when others then perform pg_temp.su(); insert into _ia values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) shape + privileges -----------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('01 both functions exist, SECURITY DEFINER, empty search_path',
    coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.invite_account_state(text)')), false)
    and coalesce((select prosecdef and 'search_path=""' = any(proconfig) from pg_proc where oid = to_regprocedure('public.my_needs_password()')), false));
  perform pg_temp.res('02 invite_account_state: service role only',
    has_function_privilege('service_role', 'public.invite_account_state(text)', 'execute')
    and not has_function_privilege('anon', 'public.invite_account_state(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_account_state(text)', 'execute'));
  perform pg_temp.res('03 my_needs_password: signed-in only',
    has_function_privilege('authenticated', 'public.my_needs_password()', 'execute')
    and not has_function_privilege('anon', 'public.my_needs_password()', 'execute'));
  perform pg_temp.anon();
  perform pg_temp.res('04 anon call refused', pg_temp.try('select public.invite_account_state(''' || pg_temp.get('tNoPw') || ''')::text') like 'err:42501%');
  perform pg_temp.login('haspw@ia.test');
  perform pg_temp.res('05 signed-in member call refused', pg_temp.try('select public.invite_account_state(''' || pg_temp.get('tNoPw') || ''')::text') like 'err:42501%');
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ia values ('0x shape', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) states ---------------------------------------------------------------------------------------
do $$ declare r jsonb; f0 text; f0b text; f1 text; begin
  perform pg_temp.su(); f0 := pg_temp.fp();
  perform pg_temp.svc();
  perform pg_temp.res('10 malformed token -> invalid', public.invite_account_state('not-a-token') = '{"valid": false}'::jsonb
    and public.invite_account_state(null) = '{"valid": false}'::jsonb);
  perform pg_temp.res('11 unknown token -> invalid', public.invite_account_state(encode(extensions.gen_random_bytes(24), 'hex')) = '{"valid": false}'::jsonb);
  perform pg_temp.su();
  r := pg_temp.state('tNew');
  perform pg_temp.res('12 no login yet -> none', r ->> 'account' = 'none' and (r ->> 'valid')::boolean, r::text);
  r := pg_temp.state('tNoPw');
  perform pg_temp.res('13 invite-made login without password -> needs_password, not confirmed (case-insensitive)',
    r ->> 'account' = 'needs_password' and r ->> 'confirmed' = 'false', r::text);
  perform pg_temp.res('14 only valid / account / confirmed are returned (no address, no id)',
    (select array_agg(k order by k) from jsonb_object_keys(r) k) = array['account', 'confirmed', 'valid'], r::text);
  f0b := pg_temp.fp();
  update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where email = 'nopw@ia.test';   -- the first link was opened
  f1 := pg_temp.fp();
  r := pg_temp.state('tNoPw');
  perform pg_temp.res('15 link opened but no password chosen -> still needs_password, confirmed', r ->> 'account' = 'needs_password' and r ->> 'confirmed' = 'true', r::text);
  r := pg_temp.state('tHasPw');
  perform pg_temp.res('16 account with a password -> existing', r ->> 'account' = 'existing', r::text);
  r := pg_temp.state('tGoogle');
  perform pg_temp.res('17 Google sign-in without password -> existing', r ->> 'account' = 'existing', r::text);
  perform pg_temp.res('18 expired invitation -> invalid', pg_temp.state('tExpired') = '{"valid": false}'::jsonb);
  r := pg_temp.state('tSelf');
  perform pg_temp.res('18b self sign-up never confirmed -> unconfirmed (sign-in cannot work yet)', r ->> 'account' = 'unconfirmed' and r ->> 'confirmed' = 'false', r::text);
  perform pg_temp.res('19 revoked invitation -> invalid', pg_temp.state('tRevoked') = '{"valid": false}'::jsonb);
  perform pg_temp.res('20 read-only: invitations / users / identities unchanged by the lookups', f0b = f0 and pg_temp.fp() = f1);
exception when others then perform pg_temp.su(); insert into _ia values ('1x states', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) my_needs_password: own login only -------------------------------------------------------------
do $$ begin
  perform pg_temp.login('nopw@ia.test');
  perform pg_temp.res('30 invitee without password -> true', public.my_needs_password());
  perform pg_temp.login('haspw@ia.test');
  perform pg_temp.res('31 account with password -> false', not public.my_needs_password());
  perform pg_temp.login('google@ia.test');
  perform pg_temp.res('32 Google account -> false', not public.my_needs_password());
  perform pg_temp.anon();
  perform pg_temp.res('33 anon refused', pg_temp.try('select public.my_needs_password()::text') like 'err:42501%');
  perform pg_temp.su();
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', false); perform set_config('role', 'authenticated', false);
  perform pg_temp.res('34 no sub claim -> false', not public.my_needs_password());
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ia values ('3x mine', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) the invite token is single-use -----------------------------------------------------------------
do $$ declare e text; t text := pg_temp.get('tNoPw'); begin
  perform pg_temp.login('haspw@ia.test');
  e := pg_temp.try('select public.accept_invitation(''' || t || ''')::text');
  perform pg_temp.res('40 another account cannot use the token', e like 'err:42501%', e);
  perform pg_temp.login('nopw@ia.test');
  e := pg_temp.try('select public.accept_invitation(''' || t || ''')::text');
  perform pg_temp.res('41 the invitee accepts once', e like 'ok:%"ok": true%' and e not like '%"already": true%', e);
  perform pg_temp.su();
  perform pg_temp.res('42 invitation now accepted, invitee in the studio',
    exists (select 1 from public.invitations where token = t and status = 'accepted')
    and exists (select 1 from public.profiles p join auth.users u on u.id = p.id where u.email = 'nopw@ia.test' and p.org_id = 'a0000000-0000-4000-8000-000000000001' and p.role = 'planner'));
  perform pg_temp.res('43 an accepted token is no longer valid for the state lookup', pg_temp.state('tNoPw') = '{"valid": false}'::jsonb);
  perform pg_temp.login('nopw@ia.test');
  e := pg_temp.try('select public.accept_invitation(''' || t || ''')::text');
  perform pg_temp.res('44 re-opening it is only an "already" no-op', e like '%"already": true%', e);
  perform pg_temp.su();
exception when others then perform pg_temp.su(); insert into _ia values ('4x single-use', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) pending invitations still count toward the free trial's seat limit (admin + 2) -----------------
do $$ declare o uuid := 'c2010000-0000-4000-8000-000000000001'; u uuid; e text; begin
  perform pg_temp.su();
  insert into public.organizations(id, name, currency, timezone, brand, plan, created_at)
    values (o, 'ABCD', 'INR', 'Asia/Kolkata', '{}'::jsonb, 'pro', now()) on conflict (id) do nothing;
  insert into public.studio_subscriptions(org_id, status) values (o, 'trial') on conflict (org_id) do update set status = 'trial';
  u := auth.seed_user('abcd_admin@ia.test');
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at)
    values (u, 'abcd_admin@ia.test', 'admin', o, false, now()) on conflict (id) do update set org_id = excluded.org_id, role = 'admin';
  e := pg_temp.try('select pg_temp.inv(''' || o || ''', ''seat1@ia.test'')');
  perform pg_temp.res('50 1st pending invite fits', e like 'ok:%', e);
  e := pg_temp.try('select pg_temp.inv(''' || o || ''', ''seat2@ia.test'')');
  perform pg_temp.res('51 2nd pending invite fits (admin + 2)', e like 'ok:%', e);
  e := pg_temp.try('select pg_temp.inv(''' || o || ''', ''seat3@ia.test'')');
  perform pg_temp.res('52 3rd pending invite refused: pending invites hold seats', e like 'err:42501%', e);
  perform pg_temp.res('53 the state lookup never frees a seat', (pg_temp.state('tNew') ->> 'valid')::boolean
    and (select count(*) from public.invitations where org_id = o and status = 'pending') = 2);
exception when others then perform pg_temp.su(); insert into _ia values ('5x seats', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) invite_auth_user_id + invite_request_new_link (service role only) ------------------------------
do $$ declare r jsonb; e text; v_inv0 text; v_uid uuid; begin
  perform pg_temp.su(); select id into v_uid from auth.users where email = 'haspw@ia.test';
  perform pg_temp.res('60 both helpers: service role only',
    has_function_privilege('service_role', 'public.invite_auth_user_id(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_auth_user_id(text)', 'execute')
    and not has_function_privilege('anon', 'public.invite_auth_user_id(text)', 'execute')
    and has_function_privilege('service_role', 'public.invite_request_new_link(text)', 'execute')
    and not has_function_privilege('authenticated', 'public.invite_request_new_link(text)', 'execute')
    and not has_function_privilege('anon', 'public.invite_request_new_link(text)', 'execute'));
  perform pg_temp.svc();
  perform pg_temp.res('61 login id of the invitation''s own e-mail',
    public.invite_auth_user_id(pg_temp.get('tHasPw')) = v_uid);
  perform pg_temp.res('62 no login / expired / malformed -> null',
    public.invite_auth_user_id(pg_temp.get('tNew')) is null and public.invite_auth_user_id(pg_temp.get('tExpired')) is null
    and public.invite_auth_user_id('x') is null);
  perform pg_temp.su();
  select to_jsonb(i)::text into v_inv0 from public.invitations i where token = pg_temp.get('tExpired');
  perform pg_temp.svc();
  r := public.invite_request_new_link(pg_temp.get('tHasPw'));
  perform pg_temp.res('63 a still-valid invitation is not "expired"', r ->> 'result' = 'not_expired', r::text);
  r := public.invite_request_new_link(pg_temp.get('tExpired'));
  perform pg_temp.res('64 expired invitation -> the studio is asked once', r ->> 'result' = 'requested' and r ->> 'studio' = 'Studio A', r::text);
  r := public.invite_request_new_link(pg_temp.get('tExpired'));
  perform pg_temp.res('65 asking again within 24 h adds nothing', r ->> 'result' = 'already_requested', r::text);
  perform pg_temp.res('66 revoked / unknown are not renewable', public.invite_request_new_link(pg_temp.get('tRevoked')) ->> 'result' = 'not_expired'
    and public.invite_request_new_link(repeat('e', 48)) ->> 'result' = 'not_found' and public.invite_request_new_link('x') ->> 'result' = 'not_found');
  perform pg_temp.su();
  perform pg_temp.res('67 exactly one bell row for that studio, naming the invitee',
    (select count(*) from public.notifications n where n.kind = 'invite_link_request' and n.org_id = 'a0000000-0000-4000-8000-000000000001'
       and n.detail ->> 'invitation' = (select id::text from public.invitations where token = pg_temp.get('tExpired'))
       and n.detail ->> 'label' like 'late@ia.test asked for a new invitation link%') = 1
    and not exists (select 1 from public.notifications n where n.kind = 'invite_link_request' and n.org_id <> 'a0000000-0000-4000-8000-000000000001'));
  perform pg_temp.res('68 the expired invitation itself is never renewed or changed',
    (select to_jsonb(i)::text from public.invitations i where token = pg_temp.get('tExpired')) = v_inv0);
exception when others then perform pg_temp.su(); insert into _ia values ('6x helpers', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _ia order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'INVITE-ACCEPT-0205: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'INVITE-ACCEPT-0205: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _ia;
rollback;
