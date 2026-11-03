-- r123a-hq-devices-0332.sql -- R123a: Helm HQ "Where you're logged in".
-- Proves: (1) structure - 4 nullable columns + meta_at, the two wrapped functions carry the marker and keep their old
-- bodies ONCE as __pre0332 with no app privilege, new entry points signed-in only (never anon), helpers private;
-- (2) device / IP mask / location helpers; (3) the HQ gate records the masked IP + Cloudflare location of MY sign-in and
-- never the full address; (4) at most once a minute (meta + last seen throttled); (5) hq_my_sessions = only my own
-- sign-ins, newest first, current marked, IP masked, paging; another HQ person never sees mine; (6) sign out ONE other
-- sign-in: revoked mark + refresh token revoked, that sign-in refused by HQ (HQ_SESSION_ENDED), the current one keeps
-- working; the current one / a bad id / someone else's id refused; (7) "Log out of all other devices": every other
-- sign-in of mine (HQ or not) ended, this one kept and still working, other people untouched, no fresh code needed,
-- HQ log + staff log rows, no e-mail queued; (8) anon / non-HQ / aal1 refused; (9) the HQ team list carries device
-- name + location; (10) re-run safe.
-- Re-applies 0332 twice. Local disposable PG only. Fake data only. Rolled back.
\set ON_ERROR_STOP 0
set client_min_messages = error;
\ir ../../supabase/migrations/0332_r123a_hq_devices.sql
\ir ../../supabase/migrations/0332_r123a_hq_devices.sql
set client_min_messages = warning;
begin;
create temp table _rs(name text, result text); grant all on _rs to anon, authenticated, service_role;
create temp table _kv(k text primary key, v text); grant all on _kv to anon, authenticated, service_role;
-- Supabase keeps refresh tokens in auth.refresh_tokens (not in the local shim): a minimal copy for this test (rolled back)
create table if not exists auth.refresh_tokens (id bigserial primary key, session_id uuid, revoked boolean default false, updated_at timestamptz);

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; perform set_config('request.jwt.claims', '', false);
  perform set_config('request.headers', '', false); end $$;
-- an HQ person signed in with two-step on sign-in p_sid, request headers p_hdr; p_code_age = last code entered that long ago
create or replace function pg_temp.hq(p_email text, p_sid uuid, p_hdr jsonb default '{}'::jsonb, p_code_age interval default null, p_aal text default 'aal2')
returns void language plpgsql as $$
declare u uuid; c jsonb; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  c := jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', p_aal);
  if p_sid is not null then c := c || jsonb_build_object('session_id', p_sid); end if;
  if p_code_age is not null then
    c := c || jsonb_build_object('amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from now() - p_code_age)::bigint)));
  end if;
  perform set_config('request.jwt.claims', c::text, false);
  perform set_config('request.headers', coalesce(p_hdr, '{}'::jsonb)::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _rs values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare h text; begin execute p_sql; return ''; exception when others then
  get stacked diagnostics h = pg_exception_hint; return sqlstate || ' ' || sqlerrm || ' [' || coalesce(h, '') || ']'; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _kv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
grant execute on function pg_temp.put(text, text) to anon, authenticated, service_role;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _kv where k = p_k $$;
grant execute on function pg_temp.get(text) to anon, authenticated, service_role;
create or replace function pg_temp.sid(p_k text) returns uuid language sql as $$ select v::uuid from _kv where k = p_k $$;
grant execute on function pg_temp.sid(text) to anon, authenticated, service_role;
create or replace function pg_temp.staff(p_email text, p_role text) returns void language plpgsql as $$
begin
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = p_email) then perform auth.seed_user(p_email); end if;
  update auth.users set email_confirmed_at = now() where email = p_email;
  insert into public.platform_admins(email, added_by, role) values (p_email, 'r123a test', p_role) on conflict (email) do nothing;
  update public.platform_admins set role = p_role, status = 'active', require_mfa = false,
         user_id = (select id from auth.users where email = p_email) where email = p_email;
end $$;
-- a Supabase sign-in (auth.sessions + one refresh token) for a person; returns its id
create or replace function pg_temp.signin(p_email text, p_ua text, p_ip text) returns uuid language plpgsql as $$
declare s uuid := gen_random_uuid(); u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  insert into auth.sessions(id, user_id, created_at, updated_at, user_agent, ip) values (s, u, now(), now(), p_ua, p_ip::inet);
  insert into auth.refresh_tokens(session_id, revoked) values (s, false);
  return s;
end $$;

-- ---- setup -------------------------------------------------------------------------------------------------------------------
do $$ declare a uuid; b uuid; c uuid; d uuid; v uuid; begin
  perform pg_temp.staff('r123_owner@hqstaff.test', 'owner');
  perform pg_temp.staff('r123_viewer@hqstaff.test', 'viewer');
  perform pg_temp.su();
  update public.helm_hq_settings set hq_idle_minutes = 30, hq_max_hours = 12, hq_reauth_minutes = 15, hq_ip_allowlist_on = false where id;
  a := pg_temp.signin('r123_owner@hqstaff.test', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', '203.0.113.42');
  b := pg_temp.signin('r123_owner@hqstaff.test', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', '198.51.100.7');
  c := pg_temp.signin('r123_owner@hqstaff.test', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Claude/0.14.10 Chrome/128.0 Electron/32.2 Safari/537.36', '192.0.2.10');
  d := pg_temp.signin('r123_owner@hqstaff.test', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/130.0', '203.0.113.99');   -- never opened HQ
  v := pg_temp.signin('r123_viewer@hqstaff.test', 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0', '198.51.100.200');
  perform pg_temp.put('a', a::text); perform pg_temp.put('b', b::text); perform pg_temp.put('c', c::text);
  perform pg_temp.put('d', d::text); perform pg_temp.put('v', v::text);
exception when others then perform pg_temp.su(); insert into _rs values ('00 setup', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 1) structure + privileges -------------------------------------------------------------------------------------------
do $$ declare f text; ok boolean := true; pre text; begin
  perform pg_temp.su();
  perform pg_temp.res('01 hq_staff_sessions gains ip_masked / city / region / country / meta_at (nullable; nothing dropped)',
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'hq_staff_sessions'
      and column_name in ('ip_masked', 'city', 'region', 'country', 'meta_at') and is_nullable = 'YES') = 5
    and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'hq_staff_sessions'
      and column_name in ('session_id', 'user_id', 'email', 'started_at', 'last_seen_at', 'ip_short', 'user_agent')) = 7);
  foreach f in array array['_hq27_require(text,boolean)', '_hq27_sessions_of(uuid)'] loop
    pre := 'public.' || replace(f, '(', '__pre0332(');
    ok := ok and position('r123a-0332' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure('public.' || f))) > 0
      and to_regprocedure(pre) is not null
      and position('r123a-0332' in (select p.prosrc from pg_proc p where p.oid = to_regprocedure(pre))) = 0
      and not has_function_privilege('anon', pre, 'execute') and not has_function_privilege('authenticated', pre, 'execute')
      and not has_function_privilege('service_role', pre, 'execute')
      and not has_function_privilege('authenticated', 'public.' || f, 'execute')
      and (select p.prosecdef and 'search_path=""' = any(p.proconfig) from pg_proc p where p.oid = to_regprocedure('public.' || f));
  end loop;
  perform pg_temp.res('02 the HQ gate + team-list sessions carry the 0332 marker (definer, empty search_path); old bodies kept ONCE as __pre0332 with no app privilege', ok);
  perform pg_temp.res('03 new HQ functions: signed-in yes, anon no, definer + empty search_path; helpers: no API role',
    has_function_privilege('authenticated', 'public.hq_my_sessions(integer,integer)', 'execute')
    and not has_function_privilege('anon', 'public.hq_my_sessions(integer,integer)', 'execute')
    and has_function_privilege('authenticated', 'public.hq_sign_out_my_other_sessions()', 'execute')
    and not has_function_privilege('anon', 'public.hq_sign_out_my_other_sessions()', 'execute')
    and has_function_privilege('authenticated', 'public.hq_sign_out_my_session(text)', 'execute')
    and not has_function_privilege('anon', 'public.hq_sign_out_my_session(text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r123_end_sessions(uuid,uuid,uuid,text)', 'execute')
    and not has_function_privilege('anon', 'public._r123_end_sessions(uuid,uuid,uuid,text)', 'execute')
    and not has_function_privilege('authenticated', 'public._r123_req_geo()', 'execute')
    and not has_function_privilege('authenticated', 'public._r123_device_label(text)', 'execute')
    and not has_function_privilege('anon', 'public._r123_ip_mask(text)', 'execute')
    and (select bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)) from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname in ('hq_my_sessions', 'hq_sign_out_my_other_sessions', 'hq_sign_out_my_session', '_r123_end_sessions')));
exception when others then perform pg_temp.su(); insert into _rs values ('0x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 2) helpers --------------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('04 device names: Chrome (Mac OS X), Safari (iPhone), Claude Desktop (Mac OS X), Edge (Windows), Firefox (Linux), Unknown device',
    public._r123_device_label('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36') = 'Chrome (Mac OS X)'
    and public._r123_device_label('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1') = 'Safari (iPhone)'
    and public._r123_device_label('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Claude/0.14.10 Chrome/128.0 Electron/32.2 Safari/537.36') = 'Claude Desktop (Mac OS X)'
    and public._r123_device_label('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0') = 'Edge (Windows)'
    and public._r123_device_label('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0') = 'Firefox (Linux)'
    and public._r123_device_label('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36') = 'Chrome (Android)'
    and public._r123_device_label('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1') = 'Chrome (iPhone)'
    and public._r123_device_label(null) = 'Unknown device' and public._r123_device_label('curl/8.0') = 'Unknown device',
    public._r123_device_label('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Claude/0.14.10 Chrome/128.0 Electron/32.2 Safari/537.36'));
  perform pg_temp.res('05 IP masked: 203.0.113.42 -> 203.0.113.x, IPv6 -> its /48, garbage -> nothing',
    public._r123_ip_mask('203.0.113.42') = '203.0.113.x' and public._r123_ip_mask('2001:db8:1:2::5') = '2001:db8:1::/48'
    and public._r123_ip_mask('not-an-ip') is null and public._r123_ip_mask('') is null and public._r123_ip_mask(null) is null,
    coalesce(public._r123_ip_mask('2001:db8:1:2::5'), 'null'));
  perform pg_temp.res('06 location: city + region + country name / country only / Unknown; header text cleaned and bounded',
    public._r123_location_label('Hyderabad', 'Telangana', 'IN') = 'Hyderabad, Telangana, India'
    and public._r123_location_label(null, null, 'AE') = 'United Arab Emirates' and public._r123_location_label(null, null, 'BR') = 'BR'
    and public._r123_location_label('Dubai', 'Dubai', 'AE') = 'Dubai, United Arab Emirates'
    and public._r123_location_label(null, null, null) = 'Unknown'
    and public._r123_hdr_text('<script>New%20York</script>') = 'scriptNew Yorkscript'
    and char_length(public._r123_hdr_text(repeat('a', 500))) = 60 and public._r123_hdr_text('  ') is null);
exception when others then perform pg_temp.su(); insert into _rs values ('2x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 3) the HQ gate records MY sign-in: masked IP + Cloudflare location, at most once a minute --------------------------------
do $$ declare e text; h public.hq_staff_sessions; h2 public.hq_staff_sessions; begin
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'),
    '{"cf-connecting-ip":"203.0.113.42","cf-ipcountry":"IN","cf-ipcity":"Hyderabad","cf-region":"Telangana","user-agent":"Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36"}'::jsonb);
  e := pg_temp.try('select public.hq_heartbeat(''overview'')');
  perform pg_temp.su();
  select * into h from public.hq_staff_sessions where session_id = pg_temp.sid('a');
  perform pg_temp.res('07 first HQ call records the sign-in with masked IP 203.0.113.x + Hyderabad, Telangana, IN',
    e = '' and h.session_id is not null and h.ip_masked = '203.0.113.x' and h.city = 'Hyderabad' and h.region = 'Telangana' and h.country = 'IN'
    and h.meta_at is not null, e || ' ' || coalesce(row_to_json(h)::text, 'no row'));
  perform pg_temp.res('08 the full IP address is stored nowhere in hq_staff_sessions',
    not exists (select 1 from public.hq_staff_sessions x where x.user_id = h.user_id and row_to_json(x)::text like '%203.0.113.42%'));
  -- again within the minute with other headers: nothing rewritten (meta + last seen throttled)
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{"cf-connecting-ip":"198.51.100.1","cf-ipcountry":"AE","cf-ipcity":"Dubai"}'::jsonb);
  e := pg_temp.try('select public.hq_heartbeat(''studios'')');
  perform pg_temp.su();
  select * into h2 from public.hq_staff_sessions where session_id = pg_temp.sid('a');
  perform pg_temp.res('09 throttled: a second call within a minute changes neither the details nor the last-seen time',
    e = '' and h2.city = 'Hyderabad' and h2.ip_masked = '203.0.113.x' and h2.meta_at = h.meta_at and h2.last_seen_at = h.last_seen_at, e);
  -- two minutes later: refreshed
  update public.hq_staff_sessions set meta_at = now() - interval '2 minutes', last_seen_at = now() - interval '2 minutes' where session_id = pg_temp.sid('a');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{"cf-connecting-ip":"198.51.100.1","cf-ipcountry":"AE","cf-ipcity":"Dubai"}'::jsonb);
  e := pg_temp.try('select public.hq_heartbeat(''studios'')');
  perform pg_temp.su();
  select * into h2 from public.hq_staff_sessions where session_id = pg_temp.sid('a');
  perform pg_temp.res('10 after a minute the next HQ call refreshes last seen + location (Dubai, AE, 198.51.100.x)',
    e = '' and h2.city = 'Dubai' and h2.country = 'AE' and h2.ip_masked = '198.51.100.x' and h2.last_seen_at > now() - interval '5 seconds', e);
  -- no Cloudflare headers at all: the earlier location is kept, never blanked
  update public.hq_staff_sessions set meta_at = now() - interval '2 minutes' where session_id = pg_temp.sid('a');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{}'::jsonb);
  e := pg_temp.try('select public.hq_heartbeat(''studios'')');
  perform pg_temp.su();
  select * into h2 from public.hq_staff_sessions where session_id = pg_temp.sid('a');
  perform pg_temp.res('11 a request without location headers keeps the last known location', e = '' and h2.city = 'Dubai' and h2.ip_masked = '198.51.100.x', e);
  -- the owner's other sign-ins open HQ once (B: no headers at all, C: only a country), the viewer once
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('b'), '{}'::jsonb); perform public.hq_heartbeat('overview');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('c'), '{"cf-ipcountry":"in"}'::jsonb); perform public.hq_heartbeat('overview');
  perform pg_temp.hq('r123_viewer@hqstaff.test', pg_temp.sid('v'), '{"cf-connecting-ip":"198.51.100.200","cf-ipcountry":"GB"}'::jsonb); perform public.hq_heartbeat('overview');
  perform pg_temp.su();
  update public.hq_staff_sessions set last_seen_at = now() - interval '10 minutes' where session_id = pg_temp.sid('b');
  update public.hq_staff_sessions set last_seen_at = now() - interval '5 minutes' where session_id = pg_temp.sid('c');
exception when others then perform pg_temp.su(); insert into _rs values ('3x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 4) hq_my_sessions: only mine, newest first, current marked, masked, paged ------------------------------------------------
do $$ declare r jsonb; r2 jsonb; rv jsonb; x jsonb; begin
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  r := public.hq_my_sessions(10, 0);
  perform pg_temp.su();
  perform pg_temp.res('12 my sign-ins: 3 (the ones that opened HQ), this one first and marked current, then newest last-active first',
    (r ->> 'total')::int = 3 and jsonb_array_length(r -> 'rows') = 3
    and r #>> '{rows,0,sid}' = left(pg_temp.get('a'), 8) and (r #>> '{rows,0,is_current}')::boolean and r #>> '{rows,0,status}' = 'current'
    and r #>> '{rows,1,sid}' = left(pg_temp.get('c'), 8) and r #>> '{rows,2,sid}' = left(pg_temp.get('b'), 8)
    and r ->> 'current_sid' = left(pg_temp.get('a'), 8) and (r ->> 'other_active')::int = 2, r::text);
  x := r -> 'rows' -> 0;
  perform pg_temp.res('13 a row: device name, location, masked IP, signed in, last active; never the full IP or session id',
    x ->> 'device' = 'Chrome (Mac OS X)' and x ->> 'location' = 'Dubai, United Arab Emirates' and x ->> 'ip' = '198.51.100.x'
    and x ? 'signed_in' and x ? 'last_active' and not (x ->> 'revoked')::boolean and not (x ->> 'can_sign_out')::boolean
    and r -> 'rows' -> 1 ->> 'device' = 'Claude Desktop (Mac OS X)' and r -> 'rows' -> 1 ->> 'location' = 'India'
    and r -> 'rows' -> 2 ->> 'device' = 'Safari (iPhone)' and r -> 'rows' -> 2 ->> 'location' = 'Unknown'
    and r -> 'rows' -> 2 ->> 'ip' = '198.51.100.x' and (r -> 'rows' -> 2 ->> 'can_sign_out')::boolean
    and r::text not like '%198.51.100.7%' and r::text not like '%203.0.113.42%' and r::text not like '%' || pg_temp.get('b') || '%', r::text);
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  r := public.hq_my_sessions(2, 0); r2 := public.hq_my_sessions(2, 2);
  perform pg_temp.su();
  perform pg_temp.res('14 paging: 2 + 1 rows of 3, limits clamped (0 -> 1, 500 -> 50)',
    jsonb_array_length(r -> 'rows') = 2 and jsonb_array_length(r2 -> 'rows') = 1 and (r2 ->> 'total')::int = 3
    and r2 #>> '{rows,0,sid}' = left(pg_temp.get('b'), 8), r2::text);
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  r := public.hq_my_sessions(0, -5); r2 := public.hq_my_sessions(500, 0);
  perform pg_temp.su();
  perform pg_temp.res('14b paging limits clamped', (r ->> 'limit')::int = 1 and (r ->> 'offset')::int = 0 and (r2 ->> 'limit')::int = 50);
  perform pg_temp.hq('r123_viewer@hqstaff.test', pg_temp.sid('v'));
  rv := public.hq_my_sessions(10, 0);
  perform pg_temp.su();
  perform pg_temp.res('15 another HQ person (Viewer) sees only their own sign-in - none of the Owner''s',
    (rv ->> 'total')::int = 1 and rv #>> '{rows,0,sid}' = left(pg_temp.get('v'), 8) and rv #>> '{rows,0,device}' = 'Firefox (Linux)'
    and rv #>> '{rows,0,location}' = 'United Kingdom'
    and rv::text not like '%' || left(pg_temp.get('a'), 8) || '%' and rv::text not like '%' || left(pg_temp.get('b'), 8) || '%', rv::text);
exception when others then perform pg_temp.su(); insert into _rs values ('4x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 5) who may call: anon / non-HQ / aal1 / no session id ---------------------------------------------------------------------
do $$ declare e text; e2 text; e3 text; u uuid; begin
  perform pg_temp.su(); perform auth.login_anon();
  e := pg_temp.try('select public.hq_my_sessions(10, 0)') || '|' || pg_temp.try('select public.hq_sign_out_my_other_sessions()')
       || '|' || pg_temp.try('select public.hq_sign_out_my_session(''abcdef01'')');
  perform pg_temp.su();
  perform pg_temp.res('16 anon is refused (no privilege)', e like '42501%|42501%|42501%', e);
  perform pg_temp.su();
  if not exists (select 1 from auth.users where email = 'r123_plain@studio.test') then perform auth.seed_user('r123_plain@studio.test'); end if;
  perform pg_temp.hq('r123_plain@studio.test', gen_random_uuid());
  e := pg_temp.try('select public.hq_my_sessions(10, 0)') || '|' || pg_temp.try('select public.hq_sign_out_my_other_sessions()');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{}'::jsonb, null, 'aal1');
  e2 := pg_temp.try('select public.hq_my_sessions(10, 0)');
  perform pg_temp.hq('r123_owner@hqstaff.test', null);
  e3 := pg_temp.try('select public.hq_sign_out_my_other_sessions()');
  perform pg_temp.su();
  perform pg_temp.res('17 a signed-in person who is not HQ staff, and an HQ person without two-step, are refused',
    e like '42501%not authorized%|42501%not authorized%' and e2 like '42501%not authorized%', e || ' / ' || e2);
  perform pg_temp.res('18 a token with no session id cannot "log out of all other devices" (nothing ended)',
    e3 like '22023%[no_session]' and not exists (select 1 from public.hq_session_revocations r where r.session_id in (pg_temp.sid('b'), pg_temp.sid('c'))), e3);
exception when others then perform pg_temp.su(); insert into _rs values ('5x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 6) sign out ONE other sign-in ------------------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; m jsonb; begin
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  e := pg_temp.try('select public.hq_sign_out_my_session(' || quote_literal(left(pg_temp.get('a'), 8)) || ')')
       || '|' || pg_temp.try('select public.hq_sign_out_my_session(''zz'')')
       || '|' || pg_temp.try('select public.hq_sign_out_my_session(' || quote_literal(left(pg_temp.get('v'), 8)) || ')');
  perform pg_temp.su();
  perform pg_temp.res('19 refused: the sign-in in use, a bad id, another person''s sign-in (nothing ended)',
    e like '22023%[current]|22023%[bad_sid]|22023%[not_found]' and not exists (select 1 from public.hq_session_revocations), e);
  perform pg_temp.hq('r123_viewer@hqstaff.test', pg_temp.sid('v'));
  e := pg_temp.try('select public.hq_sign_out_my_session(' || quote_literal(left(pg_temp.get('b'), 8)) || ')');
  perform pg_temp.su();
  perform pg_temp.res('20 another HQ person cannot sign out my sign-in', e like '22023%[not_found]' and not exists (select 1 from public.hq_session_revocations), e);
  -- the owner signs out the iPhone (B) - with an OLD two-step code: no fresh code needed for signing yourself out
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{}'::jsonb, interval '3 hours');
  r := public.hq_sign_out_my_session(upper(left(pg_temp.get('b'), 8)));
  perform pg_temp.su();
  perform pg_temp.res('21 one other sign-in signed out (no fresh code asked): revoked mark + its refresh token revoked; the others untouched',
    (r ->> 'sessions_ended')::int = 1 and exists (select 1 from public.hq_session_revocations where session_id = pg_temp.sid('b'))
    and (select bool_and(revoked) from auth.refresh_tokens where session_id = pg_temp.sid('b'))
    and not (select bool_or(revoked) from auth.refresh_tokens where session_id in (pg_temp.sid('a'), pg_temp.sid('c'), pg_temp.sid('v')))
    and (select count(*) from public.hq_session_revocations) = 1, coalesce(r::text, ''));
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('b'));
  e := pg_temp.try('select public.hq_heartbeat(''overview'')');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  m := public.hq_my_sessions(10, 0);
  perform pg_temp.su();
  perform pg_temp.res('22 the signed-out sign-in is refused by HQ (HQ_SESSION_ENDED -> "Session expired" screen); this one still works',
    e like '42501%HQ_SESSION_ENDED%' and (m ->> 'total')::int = 3, e);
  perform pg_temp.res('23 the list shows it as signed out (revoked, no Sign out button)',
    exists (select 1 from jsonb_array_elements(m -> 'rows') z where z ->> 'sid' = left(pg_temp.get('b'), 8)
             and z ->> 'status' = 'signed_out' and (z ->> 'revoked')::boolean and not (z ->> 'can_sign_out')::boolean)
    and (m ->> 'other_active')::int = 1, m::text);
  perform pg_temp.res('24 logged: one HQ log row hq.self.signout_one + one staff log row (no e-mail queued)',
    (select count(*) from public.audit_log a where a.action = 'hq.self.signout_one' and a.entity_id = left(pg_temp.get('b'), 8)) = 1
    and (select count(*) from public.hq_staff_events e where e.target_email = 'r123_owner@hqstaff.test' and e.kind = 'signed_out' and (e.detail ->> 'self')::boolean) = 1
    and not exists (select 1 from public.helm_notice_outbox o join public.hq_staff_events e on e.id = o.ref_id
                     where e.target_email = 'r123_owner@hqstaff.test' and e.kind = 'signed_out'));
exception when others then perform pg_temp.su(); insert into _rs values ('6x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 7) "Log out of all other devices" -----------------------------------------------------------------------------------------------
do $$ declare e text; r jsonb; m jsonb; begin
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'), '{}'::jsonb, interval '3 hours');
  r := public.hq_sign_out_my_other_sessions();
  perform pg_temp.su();
  perform pg_temp.res('25 every other sign-in of mine ended (Claude Desktop C + the Edge sign-in D that never opened HQ); B already was; this one kept',
    (r ->> 'sessions_ended')::int = 2 and r ->> 'kept' = left(pg_temp.get('a'), 8)
    and exists (select 1 from public.hq_session_revocations where session_id = pg_temp.sid('c'))
    and exists (select 1 from public.hq_session_revocations where session_id = pg_temp.sid('d'))
    and not exists (select 1 from public.hq_session_revocations where session_id = pg_temp.sid('a'))
    and (select bool_and(revoked) from auth.refresh_tokens where session_id in (pg_temp.sid('b'), pg_temp.sid('c'), pg_temp.sid('d')))
    and not (select bool_or(revoked) from auth.refresh_tokens where session_id = pg_temp.sid('a')), coalesce(r::text, ''));
  perform pg_temp.res('26 other HQ people are untouched (the Viewer''s sign-in + refresh token)',
    not exists (select 1 from public.hq_session_revocations where session_id = pg_temp.sid('v'))
    and not (select bool_or(revoked) from auth.refresh_tokens where session_id = pg_temp.sid('v')));
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('c'));
  e := pg_temp.try('select public.hq_my_sessions(10, 0)');
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  m := public.hq_my_sessions(10, 0);
  perform pg_temp.hq('r123_viewer@hqstaff.test', pg_temp.sid('v'));
  e := e || '|' || pg_temp.try('select public.hq_heartbeat(''overview'')');
  perform pg_temp.su();
  perform pg_temp.res('27 a signed-out device is refused by HQ; this device and the Viewer keep working',
    e like '42501%HQ_SESSION_ENDED%|' and (m ->> 'other_active')::int = 0 and m #>> '{rows,0,status}' = 'current'
    and (select count(*) from jsonb_array_elements(m -> 'rows') z where z ->> 'status' = 'signed_out') = 2, e || ' ' || m::text);
  perform pg_temp.res('28 logged: HQ log row hq.self.signout_others (count, kept id) + staff log row; no e-mail queued',
    (select count(*) from public.audit_log a where a.action = 'hq.self.signout_others' and (a.changed ->> 'sessions_ended')::int = 2) = 1
    and (select count(*) from public.hq_staff_events e where e.target_email = 'r123_owner@hqstaff.test' and e.kind = 'signed_out') = 2
    and not exists (select 1 from public.helm_notice_outbox o join public.hq_staff_events e on e.id = o.ref_id
                     where e.target_email = 'r123_owner@hqstaff.test'));
  -- running it again ends nothing more
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  r := public.hq_sign_out_my_other_sessions();
  perform pg_temp.su();
  perform pg_temp.res('29 a second "log out of all other devices" ends nothing more', (r ->> 'sessions_ended')::int = 0, r::text);
exception when others then perform pg_temp.su(); insert into _rs values ('7x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 8) HQ team list: device name + location per sign-in ---------------------------------------------------------------------------
do $$ declare r jsonb; me jsonb; vw jsonb; begin
  perform pg_temp.hq('r123_owner@hqstaff.test', pg_temp.sid('a'));
  r := public.hq_staff_list(false);
  perform pg_temp.su();
  select z into me from jsonb_array_elements(r -> 'staff') z where z ->> 'email' = 'r123_owner@hqstaff.test';
  select z into vw from jsonb_array_elements(r -> 'staff') z where z ->> 'email' = 'r123_viewer@hqstaff.test';
  perform pg_temp.res('30 HQ team list: my remaining sign-in carries device_label + location; the Viewer''s too; signed-out ones are not listed',
    jsonb_array_length(me -> 'sessions') = 1 and me #>> '{sessions,0,device_label}' = 'Chrome (Mac OS X)'
    and me #>> '{sessions,0,location}' = 'Dubai, United Arab Emirates' and (me #>> '{sessions,0,current}')::boolean
    and vw #>> '{sessions,0,device_label}' = 'Firefox (Linux)' and vw #>> '{sessions,0,location}' = 'United Kingdom', coalesce(me::text, 'no me'));
exception when others then perform pg_temp.su(); insert into _rs values ('8x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

-- ---- 9) re-run safety ---------------------------------------------------------------------------------------------------------
do $$ begin
  perform pg_temp.su();
  perform pg_temp.res('31 re-run safe: one __pre0332 per wrapped function, none wrapped twice',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0332') = 2
    and (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '%\_\_pre0332\_\_pre0332') = 0
    and position('_hq27_require__pre0332' in (select prosrc from pg_proc where oid = 'public._hq27_require(text,boolean)'::regprocedure)) > 0
    and position('r27-hq-staff-0277' in (select prosrc from pg_proc where oid = 'public._hq27_require__pre0332(text,boolean)'::regprocedure)) > 0);
exception when others then perform pg_temp.su(); insert into _rs values ('9x', 'FAIL: '||sqlstate||' '||sqlerrm); end $$;

select name, result from _rs order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'R123A-HQ-DEVICES-0332: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'R123A-HQ-DEVICES-0332: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _rs;
rollback;
