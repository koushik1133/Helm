-- APPLY-0332.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- It stops with "STOP 0332: ..." if 0330 (R122) or an earlier migration it builds on is missing.
-- [numbering: 0331 is left free for another round running at the same time; this file is 0332]
-- R123a (owner: "it should tell all devices with admin login the hq page last seen"):
--   * Helm HQ gets a "Where you're logged in" page (Team & safety -> Where you're logged in): every HQ sign-in of YOUR
--     account with its device ("Chrome (Mac OS X)", "Safari (iPhone)", "Claude Desktop" ...), rough location (city /
--     country when Cloudflare tells the database, else "Unknown"), a masked IP (203.0.113.x), when it signed in and when
--     it was last active, "This device", 10 a page.
--   * "Sign out" on a row ends that one sign-in; "Log out of all other devices" ends every other sign-in of your account
--     (this one stays). The ended sign-in really stops: HQ refuses it ("Session expired - sign in again") and it can't be
--     renewed. No fresh two-step code is asked for signing yourself out; it is written to the HQ log.
--   * The HQ team list shows a device name and location for each person's sign-ins.
--   No outside location service is used; only the Cloudflare headers the database already receives.
--   hq_staff_sessions gains 4 empty columns + 1 timestamp; two internal functions wrapped (old bodies kept once as
--   *__pre0332 with no app privilege); three new HQ functions. No table, column, row or policy is deleted, and no
--   existing row is changed. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true. Rows starting "info" only
--      report counts (they are always true) - read the number in the text.
--   2  No edge function needs a redeploy. Deploy the site (hq.html / hq.js / hq-staff.js / page-tours.js) with this release.
--   3  Open HQ -> Team & safety -> Where you're logged in. If Location says "Unknown" on every row, Cloudflare is not
--      passing location headers to the database for this project - the rest still works.
begin;
-- 0332_r123a_hq_devices.sql - CANONICAL forward-only. R123a (owner: "it should tell all devices with admin login the
-- hq page last seen") - Helm HQ "Where you're logged in": every HQ sign-in with its device, rough location, masked IP,
-- signed-in time and last active time; sign out one other device or every other device.
-- REQUIRES 0330 (R122), 0277 (HQ staff gates, hq_staff_sessions, hq_session_revocations, _hq27_client_ip,
--          _hq27_session_id), 0280 (_hq27_sessions_of with 'sid').
-- [numbering: 0331 is kept free for a round running at the same time; this is 0332]
--
-- In plain words:
--   1  HQ already records each HQ sign-in (one hq_staff_sessions row per Supabase sign-in, keyed by the session id in
--      the login token) and its "last seen" time (at most one update a minute, from the HQ gate every HQ call goes
--      through). Four new EMPTY columns are added to that table: ip_masked (e.g. 203.0.113.x - never the full
--      address), city / region / country (only what Cloudflare already tells the database in the request headers
--      cf-ipcity / cf-region / cf-ipcountry - no outside look-up service is ever called) and meta_at (when they were
--      last filled). The HQ gate fills them, at most once a minute per sign-in. Old rows are left as they are.
--   2  hq_my_sessions(limit, offset): MY OWN HQ sign-ins only (newest "last active" first, 10 a page): device
--      ("Chrome (Mac OS X)", "Safari (iPhone)", "Claude Desktop" ...), location ("Hyderabad, India" / "India" /
--      "Unknown"), masked IP, signed in, last active, "this device", and whether it still works (active / expired /
--      signed out). Any HQ role with two-step. Other people's sign-ins are never in the answer.
--   3  hq_sign_out_my_other_sessions(): "Log out of all other devices" - every other sign-in of MY account is ended
--      (marked in hq_session_revocations; Supabase refresh tokens marked revoked - nothing deleted). This device
--      stays signed in. No fresh two-step code is asked (you can only sign YOURSELF out); written to the HQ log.
--   4  hq_sign_out_my_session(sid): the same for one other sign-in of mine ("Sign out" on a row).
--   5  The HQ team list (Owner / Admin / Security) shows each sign-in's device name and location too.
--   A signed-out sign-in really stops working: the HQ gate (0277) already refuses a session id that is in
--   hq_session_revocations (HQ_SESSION_ENDED -> the "Session expired - sign in again" screen) and the sign-in can't be
--   renewed (refresh token revoked).
-- ZERO DATA LOSS: no table, column, row or policy is dropped or deleted; 4 nullable columns + 1 timestamp added; no
-- existing row is changed by this file. Two functions re-issued as wrappers (_hq27_require, _hq27_sessions_of - old
-- bodies kept once as *__pre0332 with NO app privilege, still doing every check they did). Additive + idempotent: safe
-- to run twice. ASCII only. Goes after 0330.
-- ROLLBACK (manual, only if ever needed - SQL editor), per wrapped function F(args):
--   drop function public.F(args); alter function public.F__pre0332(args) rename to F;
--   revoke execute on the three new hq_* functions from authenticated. The new columns can stay (unused).

-- ---- 0) preflight -------------------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public._r330_paid_refresh()') is null or to_regprocedure('public.hq_studio_detail__pre0330(uuid)') is null then
    raise exception 'STOP 0332: 0330 (R122) is not applied - run APPLY-0330.sql first'; end if;
  if to_regprocedure('public._hq27_require(text,boolean)') is null or to_regclass('public.hq_staff_sessions') is null
     or to_regclass('public.hq_session_revocations') is null or to_regprocedure('public._hq27_client_ip()') is null
     or to_regprocedure('public._hq27_session_id()') is null or to_regprocedure('public._hq27_me()') is null then
    raise exception 'STOP 0332: 0277 (HQ staff gates + sessions) is not applied'; end if;
  if to_regprocedure('public._hq27_sessions_of(uuid)') is null or to_regprocedure('public.hq_my_session()') is null then
    raise exception 'STOP 0332: 0280 (HQ sessions with ids) is not applied'; end if;
  if to_regclass('public.audit_log') is null or to_regclass('public.hq_staff_events') is null then
    raise exception 'STOP 0332: audit_log / hq_staff_events missing'; end if;
end $$;

-- ---- 1) new empty columns on hq_staff_sessions (nullable, bounded) ---------------------------------------------------------
alter table public.hq_staff_sessions add column if not exists ip_masked text;
alter table public.hq_staff_sessions add column if not exists city text;
alter table public.hq_staff_sessions add column if not exists region text;
alter table public.hq_staff_sessions add column if not exists country text;
alter table public.hq_staff_sessions add column if not exists meta_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.hq_staff_sessions'::regclass and conname = 'hq_staff_sessions_r123a_chk') then
    alter table public.hq_staff_sessions add constraint hq_staff_sessions_r123a_chk
      check ((ip_masked is null or char_length(ip_masked) <= 60) and (city is null or char_length(city) <= 60)
             and (region is null or char_length(region) <= 60) and (country is null or country ~ '^[A-Z0-9]{2}$'));
  end if;
end $$;

-- ---- 2) keep the current bodies once (__pre0332, no app privilege) -----------------------------------------------------------
do $$
declare
  f record; v_pub regprocedure; v_pre regprocedure;
begin
  for f in select * from (values ('_hq27_require', 'text,boolean'), ('_hq27_sessions_of', 'uuid')) x(n, a)
  loop
    v_pub := to_regprocedure('public.' || f.n || '(' || f.a || ')');
    v_pre := to_regprocedure('public.' || f.n || '__pre0332(' || f.a || ')');
    if v_pub is not null and v_pre is null
       and position('r123a-0332' in coalesce((select p.prosrc from pg_proc p where p.oid = v_pub), '')) = 0 then
      execute format('alter function public.%I(%s) rename to %I', f.n, f.a, f.n || '__pre0332');
    end if;
    v_pre := to_regprocedure('public.' || f.n || '__pre0332(' || f.a || ')');
    if v_pre is not null then
      execute 'revoke all on function ' || v_pre::text || ' from public';
      if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function ' || v_pre::text || ' from anon'; end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function ' || v_pre::text || ' from authenticated'; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke all on function ' || v_pre::text || ' from service_role'; end if;
    end if;
  end loop;
end $$;

-- ---- 3) small helpers (pure; no API privilege) ---------------------------------------------------------------------------------
-- "Chrome (Mac OS X)", "Safari (iPhone)", "Claude Desktop (Mac OS X)", "Unknown device" - from a browser's user-agent text
create or replace function public._r123_device_label(p_ua text)
returns text language sql immutable set search_path = '' as $$
  -- r123a-0332
  with u as (select coalesce(p_ua, '') as ua),
  b as (select ua, case
      when ua ~ 'Claude/[0-9]' or ua ~* 'claude[ -]?desktop' then 'Claude Desktop'
      when ua ~ 'Electron/' then 'Desktop app'
      when ua ~ 'Edg(e|A|iOS)?/' then 'Edge'
      when ua ~ '(OPR|Opera)[/ ]' then 'Opera'
      when ua ~ 'SamsungBrowser/' then 'Samsung Internet'
      when ua ~ '(Firefox|FxiOS)/' then 'Firefox'
      when ua ~ '(Chrome|CriOS|Chromium)/' then 'Chrome'
      when ua ~ 'Safari/' and ua ~ 'Version/' then 'Safari'
      when ua ~ 'AppleWebKit/' and ua ~ '(iPhone|iPad)' then 'Safari'
      else null end as br,
    case
      when ua ~ 'iPhone' then 'iPhone'
      when ua ~ 'iPad' then 'iPad'
      when ua ~ 'Android' then 'Android'
      when ua ~ 'CrOS' then 'ChromeOS'
      when ua ~ 'Windows' then 'Windows'
      when ua ~ '(Macintosh|Mac OS X)' then 'Mac OS X'
      when ua ~ 'Linux' then 'Linux'
      else null end as os from u)
  select case when btrim(ua) = '' then 'Unknown device'
              when br is null and os is null then 'Unknown device'
              when br is null then 'Browser (' || os || ')'
              when os is null then br
              else br || ' (' || os || ')' end
    from b
$$;

-- 203.0.113.42 -> 203.0.113.x ; 2001:db8:1:2::5 -> 2001:db8:1::/48 ; anything else -> null (never the full address)
create or replace function public._r123_ip_mask(p_ip text)
returns text language plpgsql immutable set search_path = '' as $$
declare v inet;
begin
  -- r123a-0332
  if p_ip is null or btrim(p_ip) = '' then return null; end if;
  begin v := btrim(p_ip)::inet; exception when others then return null; end;
  if family(v) = 4 then
    return split_part(host(v), '.', 1) || '.' || split_part(host(v), '.', 2) || '.' || split_part(host(v), '.', 3) || '.x';
  end if;
  return host(network(set_masklen(v, 48))) || '/48';
end $$;

-- a header value fit to show: letters / digits / space . , ' ( ) - only, at most 60 characters, else null
create or replace function public._r123_hdr_text(p_v text)
returns text language sql immutable set search_path = '' as $$
  -- r123a-0332
  select nullif(left(btrim(regexp_replace(replace(replace(coalesce(p_v, ''), '%20', ' '), '+', ' '),
                                          '[^[:alpha:][:digit:] .,''()-]', '', 'g')), 60), '')
$$;

-- where the request came from, as far as Cloudflare tells the database (request headers); never an outside look-up.
-- Only Cloudflare headers are read (Cloudflare sets them itself; other x-... location headers could be typed by anyone).
create or replace function public._r123_req_geo()
returns jsonb language plpgsql stable set search_path = '' as $$
declare h jsonb; c text;
begin
  -- r123a-0332
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  if h is null or jsonb_typeof(h) <> 'object' then return jsonb_build_object('city', null, 'region', null, 'country', null); end if;
  c := upper(btrim(coalesce(h ->> 'cf-ipcountry', '')));
  if c !~ '^[A-Z0-9]{2}$' or c in ('XX', 'T1') then c := null; end if;   -- XX = unknown, T1 = Tor
  return jsonb_build_object('city', public._r123_hdr_text(h ->> 'cf-ipcity'),
                            'region', public._r123_hdr_text(coalesce(h ->> 'cf-region', h ->> 'cf-region-code')),
                            'country', c);
end $$;

-- "Hyderabad, Telangana, India" / "India" / "Unknown"
create or replace function public._r123_location_label(p_city text, p_region text, p_country text)
returns text language sql immutable set search_path = '' as $$
  -- r123a-0332
  with n as (select case upper(coalesce(p_country, ''))
      when 'IN' then 'India' when 'AE' then 'United Arab Emirates' when 'US' then 'United States' when 'GB' then 'United Kingdom'
      when 'SG' then 'Singapore' when 'AU' then 'Australia' when 'CA' then 'Canada' when 'DE' then 'Germany' when 'FR' then 'France'
      when 'NL' then 'Netherlands' when 'IE' then 'Ireland' when 'SA' then 'Saudi Arabia' when 'QA' then 'Qatar' when 'OM' then 'Oman'
      when 'KW' then 'Kuwait' when 'BH' then 'Bahrain' when 'NP' then 'Nepal' when 'LK' then 'Sri Lanka' when 'BD' then 'Bangladesh'
      when 'MY' then 'Malaysia' when 'JP' then 'Japan' when 'NZ' then 'New Zealand' when 'ZA' then 'South Africa'
      when '' then null else upper(p_country) end as cn)
  select coalesce(nullif(concat_ws(', ', nullif(btrim(coalesce(p_city, '')), ''),
                                         case when nullif(btrim(coalesce(p_region, '')), '') is distinct from nullif(btrim(coalesce(p_city, '')), '')
                                              then nullif(btrim(coalesce(p_region, '')), '') end,
                                         cn), ''), 'Unknown')
    from n
$$;

-- end some of a person's sign-ins (marks; never deletes). p_keep = never this one; p_only = just this one (else all).
create or replace function public._r123_end_sessions(p_user uuid, p_keep uuid, p_only uuid, p_reason text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_by text; v_ids uuid[] := '{}'::uuid[]; n integer := 0;
begin
  -- r123a-0332 (same marks as 0277 _hq27_end_sessions, without ending the sign-in in use)
  if p_user is null then return 0; end if;
  select lower(u.email) into v_by from auth.users u where u.id = auth.uid();
  if p_only is null and to_regclass('auth.sessions') is not null then
    begin execute 'select coalesce(array_agg(s.id), ''{}''::uuid[]) from auth.sessions s where s.user_id = $1' into v_ids using p_user;
    exception when others then v_ids := '{}'::uuid[]; end;
  end if;
  v_ids := v_ids || coalesce((select array_agg(x.session_id) from public.hq_staff_sessions x
                               where x.user_id = p_user and (p_only is null or x.session_id = p_only)), '{}'::uuid[]);
  v_ids := array(select distinct i from unnest(v_ids) i where i is not null and (p_keep is null or i <> p_keep));
  insert into public.hq_session_revocations(session_id, user_id, revoked_by, reason)
    select i, p_user, v_by, left(p_reason, 200) from unnest(v_ids) i
    on conflict (session_id) do nothing;
  get diagnostics n = row_count;
  if to_regclass('auth.refresh_tokens') is not null and coalesce(array_length(v_ids, 1), 0) > 0 then
    begin
      execute 'update auth.refresh_tokens set revoked = true, updated_at = now() where session_id = any ($1) and not coalesce(revoked, false)'
        using v_ids;
    exception when others then null;   -- HQ already refuses those sessions (hq_session_revocations)
    end;
  end if;
  return n;
end $$;

-- ---- 4) the HQ gate: the 0277 body (every check) + device details for my sign-in, at most once a minute ---------------------
create or replace function public._hq27_require(p_perm text, p_write boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r123a-0332: _hq27_require__pre0332 (0277: role, two-step, IP allow-list, idle / max age / ended sign-in, fresh code,
  -- records the sign-in + last seen) - then masked IP + Cloudflare location on my own row, at most once a minute
  v_sid uuid; g jsonb;
begin
  perform public._hq27_require__pre0332(p_perm, p_write);
  v_sid := public._hq27_session_id();
  if v_sid is null then return; end if;
  if exists (select 1 from public.hq_staff_sessions x where x.session_id = v_sid and x.user_id = auth.uid()
               and (x.meta_at is null or x.meta_at < now() - interval '60 seconds')) then
    g := public._r123_req_geo();
    update public.hq_staff_sessions x
       set ip_masked = coalesce(public._r123_ip_mask(public._hq27_client_ip()), x.ip_masked),
           -- a request that carries a location replaces all three parts together; one without any keeps the last known
           city = case when g ->> 'country' is null and g ->> 'city' is null then x.city else g ->> 'city' end,
           region = case when g ->> 'country' is null and g ->> 'city' is null then x.region else g ->> 'region' end,
           country = case when g ->> 'country' is null and g ->> 'city' is null then x.country else g ->> 'country' end,
           meta_at = now()
     where x.session_id = v_sid and x.user_id = auth.uid();
  end if;
end $$;

-- ---- 5) HQ team list: each sign-in also carries a device name + location (same rows as 0280) ----------------------------------
create or replace function public._hq27_sessions_of(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  -- r123a-0332: _hq27_sessions_of__pre0332 (0280) + device_label + location per sign-in
  r := public._hq27_sessions_of__pre0332(p_user);
  if r is null or jsonb_typeof(r) <> 'array' then return coalesce(r, '[]'::jsonb); end if;
  return coalesce((select jsonb_agg(z.j || jsonb_build_object(
             'device_label', public._r123_device_label(nullif(z.j ->> 'device', '')),
             'location', public._r123_location_label(h.city, h.region, h.country)) order by z.o)
           from jsonb_array_elements(r) with ordinality z(j, o)
           left join lateral (select x.city, x.region, x.country from public.hq_staff_sessions x
                               where x.user_id = p_user and z.j ? 'sid' and left(x.session_id::text, 8) = z.j ->> 'sid'
                               order by x.last_seen_at desc limit 1) h on true), '[]'::jsonb);
end $$;

-- ---- 6) "Where you're logged in": my own HQ sign-ins -------------------------------------------------------------------------
create or replace function public.hq_my_sessions(p_limit integer default 10, p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r123a-0332: the caller's OWN HQ sign-ins only (any HQ role, two-step); newest last-active first
  v_uid uuid; v_sid uuid; v_lim int := least(greatest(coalesce(p_limit, 10), 1), 50); v_off int := greatest(coalesce(p_offset, 0), 0);
  v_idle int; v_max int; a jsonb := null; v_total int; v_rows jsonb; v_others int;
begin
  perform public._hq27_require('self', false);
  v_uid := auth.uid(); v_sid := public._hq27_session_id();
  select coalesce(s.hq_idle_minutes, 30), coalesce(s.hq_max_hours, 12) into v_idle, v_max from public.helm_hq_settings s where s.id;
  v_idle := coalesce(v_idle, 30); v_max := coalesce(v_max, 12);
  -- my Supabase sign-ins (device text + address recorded at sign-in; gone / past not_after = ended)
  if to_regclass('auth.sessions') is not null then
    begin
      execute $q$select coalesce(jsonb_object_agg(s.id::text, jsonb_build_object('ua', to_jsonb(s) ->> 'user_agent', 'ip', to_jsonb(s) ->> 'ip',
                   'na', to_jsonb(s) ->> 'not_after', 'at', s.created_at)), '{}'::jsonb)
                 from auth.sessions s where s.user_id = $1$q$ into a using v_uid;
    exception when others then a := null;
    end;
  end if;
  with mine as (
    select h.session_id, h.started_at, h.last_seen_at, h.ip_short, h.ip_masked, h.city, h.region, h.country, h.user_agent,
           rv.revoked_at, (h.session_id = v_sid) as is_cur, a -> h.session_id::text as au
      from public.hq_staff_sessions h
      left join public.hq_session_revocations rv on rv.session_id = h.session_id
     where h.user_id = v_uid and (h.last_seen_at > now() - interval '30 days' or h.session_id = v_sid)),
  s as (
    select m.*, case
        when m.is_cur then 'current'
        when m.revoked_at is not null then 'signed_out'
        when a is not null and (m.au is null or (nullif(m.au ->> 'na', '') is not null and (m.au ->> 'na')::timestamptz <= now())) then 'ended'
        when m.last_seen_at < now() - make_interval(mins => v_idle)
          or least(m.started_at, coalesce(nullif(m.au ->> 'at', '')::timestamptz, m.started_at)) < now() - make_interval(hours => v_max) then 'expired'
        else 'active' end as st
      from mine m)
  select count(*)::int, count(*) filter (where st in ('active', 'expired') and not is_cur)::int,
         coalesce((select jsonb_agg(jsonb_build_object(
             'sid', left(p.session_id::text, 8),
             'device', public._r123_device_label(coalesce(nullif(p.au ->> 'ua', ''), p.user_agent)),
             'location', public._r123_location_label(p.city, p.region, p.country),
             'country', p.country,
             'ip', coalesce(p.ip_masked, public._r123_ip_mask(nullif(p.au ->> 'ip', '')), p.ip_short),
             'signed_in', p.started_at, 'last_active', p.last_seen_at,
             'is_current', p.is_cur, 'revoked', p.revoked_at is not null, 'revoked_at', p.revoked_at,
             'status', p.st, 'can_sign_out', p.st in ('active', 'expired') and not p.is_cur)
             order by p.is_cur desc, p.last_seen_at desc, p.session_id)
           from (select * from s order by s.is_cur desc, s.last_seen_at desc, s.session_id limit v_lim offset v_off) p), '[]'::jsonb)
    into v_total, v_others, v_rows
    from s;
  return jsonb_build_object('rows', v_rows, 'total', coalesce(v_total, 0), 'limit', v_lim, 'offset', v_off,
    'other_active', coalesce(v_others, 0), 'current_sid', case when v_sid is null then null else left(v_sid::text, 8) end,
    'idle_minutes', v_idle, 'max_hours', v_max);
end $$;

-- ---- 7) "Log out of all other devices" (this one stays signed in) ---------------------------------------------------------------
create or replace function public.hq_sign_out_my_other_sessions()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r123a-0332: only MY sign-ins; no fresh code (signing yourself out); HQ log + staff log row (no e-mail)
  me public.platform_admins; v_sid uuid; n int;
begin
  perform public._hq27_require('self', true);
  v_sid := public._hq27_session_id();
  if v_sid is null then
    raise exception 'Helm HQ can''t tell which device this is - sign out and sign in again, then try once more.' using errcode = '22023', hint = 'no_session';
  end if;
  select * into me from public._hq27_me();
  n := public._r123_end_sessions(auth.uid(), v_sid, null, 'signed out by themselves (all other devices)');
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'hq.self.signout_others', 'hq_staff_sessions', left(v_sid::text, 8),
           jsonb_build_object('sessions_ended', n, 'kept', left(v_sid::text, 8)), null, now()
      from auth.users u where u.id = auth.uid();
  insert into public.hq_staff_events(actor_user_id, actor_email, target_email, kind, detail)
    values (auth.uid(), me.email, coalesce(me.email, ''), 'signed_out', jsonb_build_object('self', true, 'sessions_ended', n, 'kept', left(v_sid::text, 8)));
  return jsonb_build_object('sessions_ended', n, 'kept', left(v_sid::text, 8));
end $$;

-- ---- 8) "Sign out" one other device of mine -----------------------------------------------------------------------------------------
create or replace function public.hq_sign_out_my_session(p_sid text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  -- r123a-0332: one of MY sign-ins (by its short id from hq_my_sessions); never the one in use; HQ log row
  me public.platform_admins; v_sid uuid; v_key text := lower(btrim(coalesce(p_sid, ''))); v_ids uuid[]; n int;
begin
  perform public._hq27_require('self', true);
  if v_key !~ '^[0-9a-f]{8}$' then raise exception 'Choose a sign-in from the list.' using errcode = '22023', hint = 'bad_sid'; end if;
  v_sid := public._hq27_session_id();
  select array_agg(x.session_id) into v_ids from public.hq_staff_sessions x where x.user_id = auth.uid() and left(x.session_id::text, 8) = v_key;
  if coalesce(array_length(v_ids, 1), 0) <> 1 then
    raise exception 'That sign-in is not one of yours (or is no longer listed).' using errcode = '22023', hint = 'not_found';
  end if;
  if v_ids[1] = v_sid then raise exception 'This is the device you are using - use Sign out at the top.' using errcode = '22023', hint = 'current'; end if;
  select * into me from public._hq27_me();
  n := public._r123_end_sessions(auth.uid(), v_sid, v_ids[1], 'signed out by themselves (one device)');
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, changed, org_id, at)
    select auth.uid(), u.email, 'hq.self.signout_one', 'hq_staff_sessions', v_key, jsonb_build_object('sessions_ended', n), null, now()
      from auth.users u where u.id = auth.uid();
  if n > 0 then
    insert into public.hq_staff_events(actor_user_id, actor_email, target_email, kind, detail)
      values (auth.uid(), me.email, coalesce(me.email, ''), 'signed_out', jsonb_build_object('self', true, 'sessions_ended', n, 'sid', v_key));
  end if;
  return jsonb_build_object('sessions_ended', n, 'sid', v_key);
end $$;

-- ---- 9) privileges -----------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: never callable by the API roles (as the 0277 gate helpers)
  foreach f in array array['public._hq27_require(text, boolean)', 'public._hq27_sessions_of(uuid)', 'public._r123_device_label(text)',
      'public._r123_ip_mask(text)', 'public._r123_hdr_text(text)', 'public._r123_req_geo()', 'public._r123_location_label(text, text, text)',
      'public._r123_end_sessions(uuid, uuid, uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- HQ entry points: signed-in (the HQ gate inside decides) + service role, never anon
  foreach f in array array['public.hq_my_sessions(integer, integer)', 'public.hq_sign_out_my_other_sessions()', 'public.hq_sign_out_my_session(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true; "info" rows just report a number)
select item, ok from (values
  ('01 hq_staff_sessions has the five new nullable columns (nothing dropped)',
     (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'hq_staff_sessions'
       and column_name in ('ip_masked', 'city', 'region', 'country', 'meta_at') and is_nullable = 'YES') = 5
     and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'hq_staff_sessions'
       and column_name in ('session_id', 'user_id', 'email', 'started_at', 'last_seen_at', 'ip_short', 'user_agent')) = 7),
  ('02 the HQ gate and the team-list sessions are the 0332 versions (definer, empty search_path)',
     (select count(*) from pg_proc p where p.oid in ('public._hq27_require(text,boolean)'::regprocedure, 'public._hq27_sessions_of(uuid)'::regprocedure)
        and p.prosrc like '%r123a-0332%' and p.prosecdef and 'search_path=""' = any(p.proconfig)) = 2),
  ('03 the old bodies are kept once as __pre0332 with no app privilege (the old gate still runs every check)',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0332') = 2
     and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0332'
                      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                           or has_function_privilege('service_role', p.oid, 'execute')))
     and position('_hq27_require__pre0332' in pg_get_functiondef('public._hq27_require(text,boolean)'::regprocedure)) > 0
     and position('HQ_SESSION_ENDED' in pg_get_functiondef('public._hq27_require__pre0332(text,boolean)'::regprocedure)) > 0),
  ('04 the three new HQ functions: signed-in yes, never anon',
     has_function_privilege('authenticated', 'public.hq_my_sessions(integer,integer)', 'execute')
     and has_function_privilege('authenticated', 'public.hq_sign_out_my_other_sessions()', 'execute')
     and has_function_privilege('authenticated', 'public.hq_sign_out_my_session(text)', 'execute')
     and not has_function_privilege('anon', 'public.hq_my_sessions(integer,integer)', 'execute')
     and not has_function_privilege('anon', 'public.hq_sign_out_my_other_sessions()', 'execute')
     and not has_function_privilege('anon', 'public.hq_sign_out_my_session(text)', 'execute')),
  ('05 internal helpers are not callable by the app (gate, end sessions, location, device name)',
     not has_function_privilege('authenticated', 'public._hq27_require(text,boolean)', 'execute')
     and not has_function_privilege('authenticated', 'public._r123_end_sessions(uuid,uuid,uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public._r123_end_sessions(uuid,uuid,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._r123_req_geo()', 'execute')
     and not has_function_privilege('authenticated', 'public._r123_device_label(text)', 'execute')),
  ('06 device names and masked IPs look right',
     public._r123_device_label('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36') = 'Chrome (Mac OS X)'
     and public._r123_device_label('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1') = 'Safari (iPhone)'
     and public._r123_ip_mask('203.0.113.42') = '203.0.113.x' and public._r123_ip_mask('nonsense') is null),
  ('07 signing yourself out never needs a fresh two-step code, and is written to the HQ log',
     pg_get_functiondef('public.hq_sign_out_my_other_sessions()'::regprocedure) like '%_hq27_require(''self'', true)%'
     and not public._hq27_sensitive('self')
     and pg_get_functiondef('public.hq_sign_out_my_other_sessions()'::regprocedure) like '%hq.self.signout_others%'
     and pg_get_functiondef('public.hq_sign_out_my_session(text)'::regprocedure) like '%hq.self.signout_one%'),
  ('08 a signed-out sign-in is refused by the HQ gate (revocation check still in place)',
     pg_get_functiondef('public._hq27_require__pre0332(text,boolean)'::regprocedure) like '%from public.hq_session_revocations r where r.session_id = v_sid%'),
  ('09 info: ' || (select count(*) from public.hq_staff_sessions where last_seen_at > now() - interval '30 days')::text
     || ' HQ sign-in(s) used in the last 30 days - device / location fill in at their next HQ use (old rows are not changed)', true),
  ('10 info: ' || (select count(*) from public.hq_staff_sessions where country is not null)::text
     || ' HQ sign-in(s) already have a location (0 right after the first run is normal)', true)
) v(item, ok);
