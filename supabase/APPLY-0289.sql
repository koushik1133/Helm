-- APPLY-0289.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0284 (invitation RSVP + privacy + themes). It STOPS (nothing changed) when 0284 or 0260 is missing.
-- R40 OPTIONAL INVITATION PASSCODE. OFF for every site, new or existing - every invitation looks and behaves exactly as
-- today until its studio ticks "Ask guests for a passcode (optional)" in the Invitation Studio and saves.
-- When on: the guest sees only the theme and "You're invited" with a passcode box; the server sends nothing else (no
-- names, date, time, venue, address, schedule, photos, RSVP or phone) until the passcode is right. The passcode is never
-- stored - only a bcrypt hash. A right passcode gives that phone a server-signed proof that lasts while the invitation is
-- live; a new passcode stops every older proof. Wrong tries: 10 per network / 15 minutes, 100 per site / hour, 300 / day.
-- 1 NEW private table (RLS on, no API access), 6 new functions, 4 guest functions renamed once to *__pre0289 and wrapped
-- (same names, arguments and answers), 2 photo read checks get one extra condition. No existing row, column or table
-- changed or deleted. Safe to run twice. ASCII only. If APPLY-0260 or APPLY-0284 is ever pasted again, paste this again.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (invite.html, invite-studio.html, store-api.js v292).
--   3  Check: Invitation Studio -> RSVP & privacy -> tick "Ask guests for a passcode", type one, Save; open the link in a
--      private window: only "You're invited" + the passcode box; type it -> the invitation opens.
begin;
-- STOP guard: 0284 (and 0260) must already be applied - checked again in the first block of the migration below
do $$ begin
  if to_regclass('public.event_site_rsvps') is null or to_regprocedure('public._r34_ip_hash()') is null then
    raise exception 'STOP: apply APPLY-0284.sql (invitation RSVP + privacy) first - nothing was changed'; end if;
end $$;
-- 0289_invite_passcode.sql - CANONICAL forward-only.
-- REQUIRES 0284 (public_invite_rsvp / public_invite_reveal / public_invite_info, event_site_rsvps), 0260 (the
--          public_event_site wrapper + the invite-media guest read check), 0050 (rate_hit, auth_rate_hits),
--          0261 (_lv261_req via 0284's _r34_ip_hash: the caller's network, Cloudflare cf-connecting-ip first),
--          pgcrypto in the extensions schema (crypt / gen_salt / hmac). 0184 (_tr184_purge_tables) is patched only when present.
--
-- In plain words (owner, r40: "an OPTIONAL passcode for an invitation site; OFF by default"):
--   1  A studio can switch on "Ask guests for a passcode" per invitation (Quotes edit, own studio) through NEW
--      event_site_set_passcode(site, on, passcode). The passcode (4-20 characters, spaces at the ends dropped, capital
--      letters do not matter) is NEVER stored: only a bcrypt hash (extensions.crypt, gen_salt('bf', 8)) in NEW private
--      table event_site_passcodes (RLS on, no API privilege; one row per site; never deleted - "off" keeps the row).
--      NEW event_site_passcode_state(site) (Quotes view) tells the studio page whether it is on (never the passcode).
--   2  A guest types the passcode on the invitation's cover; NEW anon public_invite_unlock(slug, passcode) checks it and,
--      when right, answers a short server-signed proof: 'p1.<expiry>.<hmac-sha256>' over the site id + expiry, keyed
--      by a random per-site secret kept in the same private row. It expires when the invitation's live window ends
--      (event_site_live_until; 30 days when the event has no date yet; never more than 400 days). Changing the
--      passcode makes a new secret, so every older proof stops working at once. "Make new link" keeps the setting
--      (the row belongs to the site, not to the link).
--   3  Wrong tries are limited BEFORE the hash is even checked: per network 10 wrong tries / 15 minutes (the caller's
--      network via _r34_ip_hash = cf-connecting-ip, hashed; no readable network = one shared 'noip' bucket, also 10),
--      per site 100 wrong tries / hour and 300 / day, and everyone together 20000 tries / hour. Answers are generic:
--      "That passcode didn't work" / "Too many tries - please wait a few minutes" - never what was wrong or how close.
--   4  While a site's passcode is on, the proof travels in the request header x-helm-invite-pass and EVERY public door
--      checks it on the server:
--        public_event_site      -> 'This invitation needs a passcode' (no name, date, venue, schedule, photos, phone)
--        public_invite_info     -> {state:'live', locked:true, template} only (no studio name) - the theme for the cover
--        public_invite_rsvp     -> {ok:false, reason:'passcode'} (nothing stored)
--        public_invite_reveal   -> {ok:false, reason:'passcode'} (no address)
--        invite photos (storage) -> invite_media_guest_read_ok / invite_media_on_published_site refuse
--      Each of the four RPCs is renamed ONCE to *__pre0289 (body untouched, no API grant) and wrapped under its old name
--      with the same arguments and answers (the 0276 pattern); the two storage checks get one extra condition in place.
--      A later re-run of 0260 / 0284 puts their plain bodies back: run 0289 again afterwards (it re-wraps the newest body).
--   5  A site with the passcode off (every site today, and every new site) answers exactly as before.
--   6  Free-trial clean-up (0184) also empties the new table (patched in place, like 0284); the table carries the studio
--      read-only guard (0045 zzz_studio_read_only).
--   No existing row, column or table is changed or deleted. Safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.event_site_rsvps') is null
     or coalesce(to_regprocedure('public.public_invite_info__pre0289(text)'), to_regprocedure('public.public_invite_info(text)')) is null
     or coalesce(to_regprocedure('public.public_invite_rsvp__pre0289(text,jsonb)'), to_regprocedure('public.public_invite_rsvp(text,jsonb)')) is null
     or coalesce(to_regprocedure('public.public_invite_reveal__pre0289(text,text)'), to_regprocedure('public.public_invite_reveal(text,text)')) is null
     or to_regprocedure('public._r34_ip_hash()') is null then
    raise exception 'STOP 0289: apply 0284 (invitation RSVP + privacy) first'; end if;
  if coalesce(to_regprocedure('public.public_event_site__pre0289(text)'), to_regprocedure('public.public_event_site(text)')) is null
     or to_regprocedure('public.public_event_site__pre0260(text)') is null
     or to_regprocedure('public.invite_media_guest_read_ok(text)') is null then
    raise exception 'STOP 0289: apply 0260 (cancelled events close links) first'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null or to_regclass('public.auth_rate_hits') is null then
    raise exception 'STOP 0289: 0050 (rate_hit) is not applied'; end if;
  if to_regprocedure('extensions.crypt(text,text)') is null or to_regprocedure('extensions.hmac(text,text,text)') is null then
    raise exception 'STOP 0289: pgcrypto (extensions.crypt / extensions.hmac) is missing'; end if;
  if to_regprocedure('public.event_site_live_until(uuid)') is null or to_regprocedure('public.has_area(text,text)') is null
     or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0289: event_site_live_until / has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) the private passcode table (RLS on, no API privilege) ----------------------------------------------------------
create table if not exists public.event_site_passcodes (
  site_id     uuid primary key references public.event_sites(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  enabled     boolean not null default false,
  pass_hash   text not null check (pass_hash ~ '^\$2[abxy]?\$[0-9]{2}\$[./A-Za-z0-9]{53}$'),
  secret      text not null check (secret ~ '^[0-9a-f]{64}$'),
  version     integer not null default 1 check (version >= 1),
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists event_site_passcodes_org_idx on public.event_site_passcodes(org_id);
comment on table public.event_site_passcodes is
  'r40-passcode-0289: optional invitation passcode - bcrypt hash only (never the passcode), the per-site proof secret.';
alter table public.event_site_passcodes enable row level security;
do $$ begin
  revoke all on table public.event_site_passcodes from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on table public.event_site_passcodes from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on table public.event_site_passcodes from authenticated; end if;
end $$;
do $$ begin
  if to_regprocedure('public.tg_studio_read_only()') is not null
     and not exists (select 1 from pg_trigger where tgrelid = 'public.event_site_passcodes'::regclass and tgname = 'zzz_studio_read_only') then
    execute 'create trigger zzz_studio_read_only before insert or update or delete on public.event_site_passcodes for each row execute function public.tg_studio_read_only(''org_id'')';
  end if;
end $$;

-- ---- 2) helpers (no API grants) -----------------------------------------------------------------------------------------
-- the passcode as compared: spaces at the ends dropped, lower case (guests on phones type "Rose" or "rose")
create or replace function public._r40_norm(p text)
returns text language sql immutable set search_path = '' as $$
  -- r40-passcode-0289
  select lower(btrim(coalesce(p, '')));
$$;

-- true when a site may be shown: no passcode switched on, or the request carries a valid proof for THIS site
create or replace function public._r40_pass_ok(p_site uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
-- r40-passcode-0289
declare k public.event_site_passcodes; h jsonb; v text; v_exp bigint;
begin
  if p_site is null then return true; end if;
  select * into k from public.event_site_passcodes x where x.site_id = p_site;
  if not found or not k.enabled then return true; end if;
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v := btrim(coalesce(h ->> 'x-helm-invite-pass', ''));
  if v !~ '^p1\.[0-9]{9,11}\.[0-9a-f]{64}$' then return false; end if;
  v_exp := split_part(v, '.', 2)::bigint;
  if v_exp <= extract(epoch from now())::bigint then return false; end if;
  return split_part(v, '.', 3) = encode(extensions.hmac(p_site::text || '.' || v_exp::text, k.secret, 'sha256'), 'hex');
end $$;

-- the same check by link (an unknown / unpublished link is left to the wrapped function: it answers as before)
create or replace function public._r40_slug_ok(p_slug text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r40-passcode-0289
  select coalesce((select public._r40_pass_ok(s.id) from public.event_sites s where s.slug = p_slug and s.status = 'published'), true);
$$;

-- a rate bucket that is already full (peek, no hit): wrong tries are counted only when they are wrong
create or replace function public._r40_full(p_bucket text, p_key text, p_window_s integer, p_max integer)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r40-passcode-0289
  select exists (select 1 from public.auth_rate_hits h
                  where h.bucket = p_bucket and h.key = p_key
                    and h.window_start > now() - make_interval(secs => p_window_s) and h.n >= p_max);
$$;

-- ---- 3) the guest: type the passcode, get a proof -------------------------------------------------------------------------
-- -> {ok:true, token, expires_at} | {ok:true, open:true} (no passcode on this site) | {ok:false, reason, message}
create or replace function public.public_invite_unlock(p_slug text, p_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r40-passcode-0289
declare s public.event_sites; k public.event_site_passcodes; v_ip text := public._r34_ip_hash(); v_code text := public._r40_norm(p_code);
  v_ipb text; v_ipk text; v_exp bigint; v_until timestamptz;
  c_wrong constant jsonb := jsonb_build_object('ok', false, 'reason', 'wrong', 'message', 'That passcode didn''t work. Please check it and try again.');
  c_rate constant jsonb := jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many tries. Please wait a few minutes and try again.');
begin
  if p_slug is null or char_length(p_slug) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'This invitation was not found.'); end if;
  -- the same gates as opening the invitation (published, live window, not shelved / cancelled) - the inner body, so an
  -- ended invitation says so instead of asking for a passcode
  begin
    perform 1 from public.public_event_site__pre0289(p_slug);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'This invitation is not available.');
  end;
  select * into s from public.event_sites x where x.slug = p_slug and x.status = 'published';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'This invitation was not found.'); end if;
  select * into k from public.event_site_passcodes x where x.site_id = s.id;
  if not found or not k.enabled then return jsonb_build_object('ok', true, 'open', true); end if;

  -- limits first (a full bucket refuses even the right passcode, so guessing cannot continue)
  v_ipb := case when v_ip is null then 'inv_pass.noip' else 'inv_pass.ip' end; v_ipk := coalesce(v_ip, 'noip');
  if public._r40_full(v_ipb, v_ipk, 900, 10) or public._r40_full('inv_pass.site', s.id::text, 3600, 100)
     or public._r40_full('inv_pass.siteday', s.id::text, 86400, 300) then return c_rate; end if;
  if public.rate_hit('inv_pass.all', 'all', 3600, 20000) > 0 then return c_rate; end if;

  if char_length(v_code) between 4 and 20 and extensions.crypt(v_code, k.pass_hash) = k.pass_hash then
    v_until := public.event_site_live_until(s.id);
    v_exp := extract(epoch from least(coalesce(v_until, now() + interval '30 days'), now() + interval '400 days'))::bigint;
    if v_exp <= extract(epoch from now())::bigint then v_exp := extract(epoch from now() + interval '1 hour')::bigint; end if;
    return jsonb_build_object('ok', true,
      'token', 'p1.' || v_exp::text || '.' || encode(extensions.hmac(s.id::text || '.' || v_exp::text, k.secret, 'sha256'), 'hex'),
      'expires_at', to_timestamp(v_exp));
  end if;
  -- a wrong try counts against the network and the site
  perform public.rate_hit(v_ipb, v_ipk, 900, 10);
  perform public.rate_hit('inv_pass.site', s.id::text, 3600, 100);
  perform public.rate_hit('inv_pass.siteday', s.id::text, 86400, 300);
  return c_wrong;
end $$;

-- ---- 4) rename the four guest RPCs ONCE to *__pre0289 and wrap them -------------------------------------------------------
-- A wrapper is recognised by its marker. If a later re-run of 0260 / 0284 put a plain body back under the public name,
-- that newer body becomes the inner function (the older *__pre0289 copy is replaced by it) and the wrapper goes on top.
do $$
declare r record; v_pub regprocedure; v_pre regprocedure;
begin
  for r in select * from (values
      ('public_event_site', 'text'),
      ('public_invite_info', 'text'),
      ('public_invite_rsvp', 'text,jsonb'),
      ('public_invite_reveal', 'text,text')) x(fn, args) loop
    v_pub := to_regprocedure('public.' || r.fn || '(' || r.args || ')');
    v_pre := to_regprocedure('public.' || r.fn || '__pre0289(' || r.args || ')');
    if v_pub is not null and position('r40-passcode-0289' in coalesce((select prosrc from pg_proc where oid = v_pub), '')) = 0 then
      if v_pre is not null then execute 'drop function ' || v_pre::text; end if;
      execute format('alter function public.%I(%s) rename to %I', r.fn, r.args, r.fn || '__pre0289');
    end if;
    if to_regprocedure('public.' || r.fn || '__pre0289(' || r.args || ')') is null then
      raise exception 'STOP 0289: %__pre0289 missing (apply 0260 + 0284 first)', r.fn; end if;
  end loop;
end $$;

-- opening the invitation: the inner gates first (not found / ended / cancelled answer as before), then the passcode
create or replace function public.public_event_site(p_slug text)
returns table(event_type text, template text, title text, data jsonb) language plpgsql stable security definer set search_path = '' as $$
-- r40-passcode-0289: while the site's passcode is on, nothing is returned without a valid proof (x-helm-invite-pass)
declare r record;
begin
  for r in select * from public.public_event_site__pre0289(p_slug) loop
    if not public._r40_slug_ok(p_slug) then
      raise exception 'This invitation needs a passcode' using errcode = 'P0001', hint = 'passcode';
    end if;
    event_type := r.event_type; template := r.template; title := r.title; data := r.data;
    return next;
  end loop;
end $$;

-- what the guest page should say about a link; a locked live link says only that (+ its theme for the cover)
create or replace function public.public_invite_info(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r40-passcode-0289
declare r jsonb := public.public_invite_info__pre0289(p_slug); v_tpl text;
begin
  if (r ->> 'state') = 'live' and not public._r40_slug_ok(p_slug) then
    select s.template into v_tpl from public.event_sites s where s.slug = p_slug and s.status = 'published';
    return jsonb_strip_nulls(jsonb_build_object('state', 'live', 'locked', true, 'template', v_tpl));
  end if;
  return r;
end $$;

create or replace function public.public_invite_rsvp(p_slug text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r40-passcode-0289: the passcode proof first (nothing stored without it), then the 0284 body (*__pre0289)
begin
  if not public._r40_slug_ok(p_slug) then
    return jsonb_build_object('ok', false, 'reason', 'passcode', 'message', 'Please enter the passcode first.'); end if;
  return public.public_invite_rsvp__pre0289(p_slug, p);
end $$;

create or replace function public.public_invite_reveal(p_slug text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r40-passcode-0289: the passcode proof first (no address without it), then the 0284 body (*__pre0289)
begin
  if not public._r40_slug_ok(p_slug) then return jsonb_build_object('ok', false, 'reason', 'passcode'); end if;
  return public.public_invite_reveal__pre0289(p_slug, p_token);
end $$;

-- ---- 5) invitation photos (storage checks used by policies: one extra condition, replaced in place) ------------------------
do $$ declare v_def text; f text; v_anchor constant text := 'and not public._a260_quote_cancelled(s.quote_id)'; n integer;
begin
  foreach f in array array['public.invite_media_guest_read_ok(text)', 'public.invite_media_on_published_site(text)'] loop
    if to_regprocedure(f) is null then continue; end if;
    v_def := pg_get_functiondef(f::regprocedure);
    if position('r40-passcode-0289' in v_def) > 0 then continue; end if;
    n := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
    if n <> 1 then
      if f = 'public.invite_media_guest_read_ok(text)' then
        raise exception 'STOP 0289: % has an unexpected body (re-apply 0260 first)', f; end if;
      raise notice '0289: % has an unexpected body - left unchanged (no storage policy uses it)', f;
      continue;
    end if;
    execute replace(v_def, v_anchor, v_anchor || E'\n       and public._r40_pass_ok(s.id) /* r40-passcode-0289 */');
  end loop;
end $$;

-- ---- 6) studio side ------------------------------------------------------------------------------------------------------------
-- is the passcode on for one of my studio's sites? (Quotes view) - never the passcode itself
create or replace function public.event_site_passcode_state(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r40-passcode-0289
declare v_org uuid := public.current_org_id(); k public.event_site_passcodes;
begin
  if v_org is null then raise exception 'no organization in context' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'view') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.event_sites s where s.id = p_site and s.org_id = v_org) then
    raise exception 'invitation site not found' using errcode = 'P0002'; end if;
  select * into k from public.event_site_passcodes x where x.site_id = p_site and x.org_id = v_org;
  if not found then return jsonb_build_object('on', false, 'set', false); end if;
  return jsonb_build_object('on', k.enabled, 'set', true, 'changed_at', k.changed_at);
end $$;

-- switch the passcode on (with a new passcode, or the one saved before) / off (Quotes edit, own studio)
create or replace function public.event_site_set_passcode(p_site uuid, p_on boolean, p_code text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r40-passcode-0289
declare v_org uuid := public.current_org_id(); s public.event_sites; k public.event_site_passcodes; v_code text; v_new boolean;
begin
  if v_org is null then raise exception 'no organization in context' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into s from public.event_sites x where x.id = p_site and x.org_id = v_org for update;
  if not found then raise exception 'invitation site not found' using errcode = 'P0002'; end if;
  select * into k from public.event_site_passcodes x where x.site_id = s.id for update;
  v_new := p_code is not null and btrim(p_code) <> '';
  if v_new then
    v_code := public._r40_norm(p_code);
    if char_length(v_code) not between 4 and 20 or v_code ~ '[[:cntrl:]]' then
      raise exception 'The passcode must be 4 to 20 characters.' using errcode = '22023'; end if;
  end if;
  if coalesce(p_on, false) then
    if not v_new and k.site_id is null then
      raise exception 'Type a passcode (4 to 20 characters).' using errcode = '22023'; end if;
    if k.site_id is null then
      insert into public.event_site_passcodes(site_id, org_id, enabled, pass_hash, secret, changed_by, changed_at)
        values (s.id, s.org_id, true, extensions.crypt(v_code, extensions.gen_salt('bf', 8)),
                encode(extensions.gen_random_bytes(32), 'hex'), auth.uid(), now());
    elsif v_new then
      -- a new passcode = a new secret: every device that unlocked with the old one has to type the new one
      update public.event_site_passcodes set enabled = true, pass_hash = extensions.crypt(v_code, extensions.gen_salt('bf', 8)),
             secret = encode(extensions.gen_random_bytes(32), 'hex'), version = version + 1, changed_by = auth.uid(), changed_at = now()
       where site_id = s.id;
    else
      update public.event_site_passcodes set enabled = true, changed_by = auth.uid(), changed_at = now() where site_id = s.id;
    end if;
  elsif k.site_id is not null then
    -- off: the row (hash + secret) is kept, never deleted
    update public.event_site_passcodes set enabled = false, changed_by = auth.uid(), changed_at = now() where site_id = s.id;
  end if;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'event_site.passcode', 'event_sites', s.id::text, s.quote_id,
            jsonb_build_object('on', coalesce(p_on, false), 'new_passcode', v_new), v_org);
  return public.event_site_passcode_state(s.id);
end $$;

-- ---- 7) free-trial clean-up (0184) knows the new table (patched in place once; skipped without 0184) ----------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_site_passcodes''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_sites''', ''))) / length('''event_sites''') <> 1 then
        raise notice '0289: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''event_sites''', '''event_site_passcodes'', ''event_sites''');
      end if;
    end if;
  end if;
end $$;

-- ---- 8) grants ------------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public._r40_norm(text)', 'public._r40_pass_ok(uuid)', 'public._r40_slug_ok(text)',
      'public._r40_full(text, text, integer, integer)', 'public.public_invite_unlock(text, text)',
      'public.public_event_site__pre0289(text)', 'public.public_invite_info__pre0289(text)',
      'public.public_invite_rsvp__pre0289(text, jsonb)', 'public.public_invite_reveal__pre0289(text, text)',
      'public.public_event_site(text)', 'public.public_invite_info(text)', 'public.public_invite_rsvp(text, jsonb)',
      'public.public_invite_reveal(text, text)', 'public.event_site_passcode_state(uuid)',
      'public.event_site_set_passcode(uuid, boolean, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') and f like '%\_\_pre0289%' then
      execute format('revoke all on function %s from service_role', f); end if;
  end loop;
  -- the guest page (anyone with the link; each checks everything itself) - the same doors as before + the unlock
  foreach f in array array['public.public_event_site(text)', 'public.public_invite_info(text)', 'public.public_invite_rsvp(text, jsonb)',
      'public.public_invite_reveal(text, text)', 'public.public_invite_unlock(text, text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
  -- the Invitation Studio (each checks the Quotes area + the caller's own studio inside)
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_site_passcode_state(uuid) to authenticated';
    execute 'grant execute on function public.event_site_set_passcode(uuid, boolean, text) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';

commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 new table event_site_passcodes: RLS on, no anon / signed-in privilege',
     (select c.relrowsecurity from pg_class c where c.oid = 'public.event_site_passcodes'::regclass)
     and not has_table_privilege('anon', 'public.event_site_passcodes', 'select')
     and not has_table_privilege('authenticated', 'public.event_site_passcodes', 'select')
     and not has_table_privilege('authenticated', 'public.event_site_passcodes', 'update')),
  ('02 guests may open / reply / reveal / unlock; inner bodies, helpers and studio RPCs are not for guests',
     has_function_privilege('anon', 'public.public_event_site(text)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_info(text)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_rsvp(text, jsonb)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_reveal(text, text)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_unlock(text, text)', 'execute')
     and not has_function_privilege('anon', 'public.public_event_site__pre0289(text)', 'execute')
     and not has_function_privilege('anon', 'public.public_invite_rsvp__pre0289(text, jsonb)', 'execute')
     and not has_function_privilege('anon', 'public._r40_pass_ok(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.event_site_set_passcode(uuid, boolean, text)', 'execute')
     and has_function_privilege('authenticated', 'public.event_site_set_passcode(uuid, boolean, text)', 'execute')
     and has_function_privilege('authenticated', 'public.event_site_passcode_state(uuid)', 'execute')),
  ('03 the four guest functions are wrapped (passcode checked on the server) over their inner bodies',
     (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
        and p.proname in ('public_event_site', 'public_invite_info', 'public_invite_rsvp', 'public_invite_reveal')
        and position('r40-passcode-0289' in p.prosrc) > 0) = 4
     and to_regprocedure('public.public_event_site__pre0289(text)') is not null
     and to_regprocedure('public.public_invite_info__pre0289(text)') is not null
     and to_regprocedure('public.public_invite_rsvp__pre0289(text, jsonb)') is not null
     and to_regprocedure('public.public_invite_reveal__pre0289(text, text)') is not null),
  ('04 invitation photos: the guest read check also asks for the passcode proof',
     position('r40-passcode-0289' in pg_get_functiondef('public.invite_media_guest_read_ok(text)'::regprocedure)) > 0),
  ('05 OFF everywhere unless a studio switched it on (every passcode row was made by the studio, audited)',
     not exists (select 1 from public.event_site_passcodes p
                  where not exists (select 1 from public.audit_log a where a.action = 'event_site.passcode' and a.entity_id = p.site_id::text))),
  ('06 only hashes are stored (bcrypt), never a passcode',
     not exists (select 1 from public.event_site_passcodes p where p.pass_hash !~ '^[$]2[abxy]?[$][0-9]{2}[$]')),
  ('07 free-trial clean-up knows the new table (or 0184 is not installed)',
     to_regprocedure('public._tr184_purge_tables()') is null or public._tr184_purge_tables() @> array['event_site_passcodes']),
  ('08 the new table carries the studio read-only guard (zzz_studio_read_only)',
     exists (select 1 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid = 'public.event_site_passcodes'::regclass)
     or to_regprocedure('public.tg_studio_read_only()') is null),
  ('09 every existing invitation still opens exactly as before (no site locked by this script)',
     not exists (select 1 from public.event_sites s where s.status = 'published' and not public._r40_pass_ok(s.id)
                  and not exists (select 1 from public.event_site_passcodes p where p.site_id = s.id and p.enabled)))
) v(item, ok) order by item;
