-- APPLY-0284.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER APPLY-0260 (cancelled events close links) and APPLY-0261 (link views: the IP helper). Order-independent of
-- 0262-0277 and of the parallel 0279 / 0281 / 0282 / 0283 work.
-- R34 invitation sites. DEFAULTS STAY AS TODAY for every site, new or existing (phone + WhatsApp buttons, full address);
-- everything new is optional per site: an RSVP form ("RSVP form" or "Both"; replies on the Invitation Studio page + CSV),
-- hiding the address until the guest replies Yes or Maybe (needs the form), "Make new
-- link" (old links say "This invitation has moved"), and 6 new themes. 2 NEW private tables (RLS on, no API access),
-- 1 NEW column (event_sites.private_data, default empty), 2 small triggers, 7 new functions, the template check widened
-- to a superset. No existing row, column or function changed or deleted; every existing invitation looks and behaves
-- exactly as today until its studio changes a setting (one visible change on every site, owner request: the footer
-- reads "Designed by <Studio> . Made with Helm Studios"). Safe to run twice. ASCII only.
-- After this: deploy the site (invite.html, invite-studio.html, invite-extras.js, store-api.js v287, invite-og.png).
begin;
-- 0284_invite_rsvp_privacy.sql - CANONICAL forward-only.
-- REQUIRES phase87 (event_sites, create / publish_event_site), 0022 + 0156 + 0260 (public_event_site and its gates:
--          live window, shelved / cancelled event), 0050 (rate_hit), 0261 (_lv261_req: the caller's IP, Cloudflare
--          cf-connecting-ip first). 0184 (_tr184_purge_tables) is patched only when present.
--
-- In plain words (owner, r34: "invitation site privacy + RSVP + themes"):
--   1  RSVP FORM. Guests can reply on the invitation itself: name, how many are coming (0-20), Yes / No / Maybe and an
--      optional message. Replies go to NEW private table event_site_rsvps (RLS on, no API privilege) through NEW anon
--      public_invite_rsvp(slug, form): only for a PUBLISHED site whose studio switched the form on (data.rsvpForm),
--      only while public_event_site itself answers (so an ended / cancelled / shelved invitation refuses too);
--      rate-limited AFTER validation per network (the caller's IP from cf-connecting-ip via _lv261_req, hashed, never
--      stored in clear: 30 / hour - families share mobile / venue Wi-Fi addresses; no readable network = one shared
--      'noip' bucket, 20 / hour) + per site (400 / day, 3000 replies in total) + everyone (3000 / hour); name 1-80, message 0-500,
--      no < or > (no HTML) and no control characters; a honeypot field. The answer carries a random guest token
--      (only its sha256 is stored) so the same phone can change its reply later (up to 20 times).
--      Studio side: NEW event_site_rsvp_list(site) (Quotes view + own studio): counts + the list, for the dashboard
--      and the CSV download on the Invitation Studio page.
--   2  HOST PHONE PRIVACY. "RSVP on WhatsApp / Call" becomes a per-site switch (data.rsvpContact). The default for every
--      site, new or existing, is today's behaviour (buttons shown; no setting saved = shown); the RSVP form (data.rsvpForm)
--      is OPTIONAL, off unless the studio picks "RSVP form" or "Both". When the buttons are switched OFF
--      the contact number is moved out of the public data into NEW column event_sites.private_data (never returned to
--      guests) by trigger ad_r34_site_private - so it cannot leak even through an old cached page.
--   3  ADDRESS PRIVACY (per site, data.addressMode): 'full' (default = today) or 'after_rsvp' = guests see only the
--      venue name + city; the street address and map link live in private_data (same trigger) and are handed out only
--      to a guest whose reply is Yes or Maybe (never "No"): in the answer to their own RSVP, or later by NEW anon
--      public_invite_reveal(slug, guest token) on that device.
--   4  TURN OFF LINK / MAKE NEW LINK. Turn off = the existing unpublish. NEW event_site_new_link(site) (Quotes edit +
--      own studio, published at least once) gives the site a new random link (same name-based form as publish:
--      <name>-<16 hex>). EVERY retired public link - a new link here, or a re-publish after a name change - is kept in
--      NEW table event_site_slug_history (trigger ae_r34_slug_history; never deleted; RLS on, no API privilege).
--      NEW anon public_invite_info(slug) tells the guest page 'live' (+ the studio's name for the footer), 'moved'
--      (an old link: "This invitation has moved - ask the host for the new link"), 'off' (turned off) or 'none'.
--      NEW event_site_old_links(site) lists a site's retired links for the studio.
--   5  MORE THEMES. event_sites_template_chk is widened once to a superset: + shubh (Indian wedding), mehndi (sangeet /
--      mehendi), solitaire (engagement), jubilee (birthday), gala (corporate gala), linen (minimal modern).
--   6  Free-trial clean-up (0184) also empties the two new tables (patched in place, like 0256); both carry the studio
--      read-only guard (0045 zzz_studio_read_only) - a suspended / ended-trial studio takes no new replies (calm answer).
--   No existing row, column, function or grant is changed or deleted (one CHECK replaced by a strict superset); every
--   existing site looks and behaves exactly as today until its studio changes a setting. Safe to run twice. ASCII only.

do $$ begin
  if to_regclass('public.event_sites') is null then raise exception 'STOP 0284: event_sites (phase87) is missing'; end if;
  if to_regprocedure('public.public_event_site(text)') is null then raise exception 'STOP 0284: public_event_site is missing'; end if;
  if to_regprocedure('public.event_site_live_until(uuid)') is null then raise exception 'STOP 0284: 0022 (event_site_live_until) is not applied'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0284: 0050 (rate_hit) is not applied'; end if;
  if to_regprocedure('public._lv261_req()') is null then raise exception 'STOP 0284: 0261 (_lv261_req) is not applied'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP 0284: has_area / current_org_id missing'; end if;
end $$;

-- ---- 1) columns + the widened template check ---------------------------------------------------------------------------
alter table public.event_sites add column if not exists private_data jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'event_sites_private_data_obj' and conrelid = 'public.event_sites'::regclass) then
    alter table public.event_sites add constraint event_sites_private_data_obj check (jsonb_typeof(private_data) = 'object');
  end if;
  -- the five phase87 templates + six r34 themes (a strict superset: every existing row still passes)
  if exists (select 1 from pg_constraint where conname = 'event_sites_template_chk' and conrelid = 'public.event_sites'::regclass
               and position('linen' in pg_get_constraintdef(oid)) = 0) then
    alter table public.event_sites drop constraint event_sites_template_chk;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_sites_template_chk' and conrelid = 'public.event_sites'::regclass) then
    alter table public.event_sites add constraint event_sites_template_chk
      check (template in ('eternal', 'confetti', 'summit', 'promise', 'soiree', 'shubh', 'mehndi', 'solitaire', 'jubilee', 'gala', 'linen'));
  end if;
end $$;

-- ---- 2) new private tables (RLS on, no API privilege) ------------------------------------------------------------------
create table if not exists public.event_site_rsvps (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  site_id     uuid not null references public.event_sites(id) on delete cascade,
  guest_name  text not null check (char_length(guest_name) between 1 and 80),
  party_size  integer not null check (party_size between 0 and 20),
  attending   text not null check (attending in ('yes', 'no', 'maybe')),
  message     text check (message is null or char_length(message) <= 500),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  ip_hash     text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  edits       integer not null default 0 check (edits between 0 and 20),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists event_site_rsvps_site_idx on public.event_site_rsvps(site_id, created_at desc);
create index if not exists event_site_rsvps_org_idx on public.event_site_rsvps(org_id);

create table if not exists public.event_site_slug_history (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  site_id     uuid not null references public.event_sites(id) on delete cascade,
  slug        text not null unique check (char_length(slug) between 1 and 200),
  reason      text not null default 'renamed' check (reason in ('new_link', 'renamed')),
  retired_by  uuid,
  retired_at  timestamptz not null default now()
);
create index if not exists event_site_slug_history_site_idx on public.event_site_slug_history(site_id, retired_at desc);
create index if not exists event_site_slug_history_org_idx on public.event_site_slug_history(org_id);

alter table public.event_site_rsvps enable row level security;
alter table public.event_site_slug_history enable row level security;
do $$ declare t text; begin
  foreach t in array array['public.event_site_rsvps', 'public.event_site_slug_history'] loop
    execute format('revoke all on table %s from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table %s from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table %s from authenticated', t); end if;
  end loop;
end $$;

-- the studio read-only guard (0045: suspended / ended trial / unpaid studio) on both new tables, like every studio table
do $$ declare t text; begin
  if to_regprocedure('public.tg_studio_read_only()') is null then return; end if;
  foreach t in array array['event_site_rsvps', 'event_site_slug_history'] loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
end $$;

-- ---- 3) private fields never reach the public data ---------------------------------------------------------------------
-- addressMode 'after_rsvp' -> address + mapUrl live in private_data; rsvpContact false -> hostPhone lives there.
-- Switching back moves them back (nothing is lost); a site with neither setting is left exactly as it is.
create or replace function public.tg_r34_site_private()
returns trigger language plpgsql set search_path = '' as $$
-- r34-invite-0284
declare d jsonb := new.data; pd jsonb := coalesce(new.private_data, '{}'::jsonb); k text; v_hide boolean;
begin
  if d is null or jsonb_typeof(d) <> 'object' then return new; end if;
  if jsonb_typeof(pd) <> 'object' then pd := '{}'::jsonb; end if;
  foreach k in array array['address', 'mapUrl', 'hostPhone'] loop
    v_hide := case when k = 'hostPhone' then (d -> 'rsvpContact') = 'false'::jsonb
                   else (d ->> 'addressMode') = 'after_rsvp' end;
    if v_hide then
      if d ? k then pd := pd || jsonb_build_object(k, d -> k); d := d - k; end if;
    else
      if not (d ? k) and pd ? k then d := d || jsonb_build_object(k, pd -> k); end if;
      pd := pd - k;
    end if;
  end loop;
  new.data := d; new.private_data := pd;
  return new;
end $$;
create or replace trigger ad_r34_site_private before insert or update on public.event_sites
  for each row execute function public.tg_r34_site_private();

-- every retired PUBLIC link is kept (a draft placeholder never was public)
create or replace function public.tg_r34_slug_history()
returns trigger language plpgsql security definer set search_path = '' as $$
-- r34-invite-0284
begin
  if old.slug is distinct from new.slug and old.slug is not null and old.published_at is not null
     and old.slug not like 'draft-%' then
    insert into public.event_site_slug_history(org_id, site_id, slug, reason, retired_by)
      values (old.org_id, old.id, old.slug,
              case when coalesce(current_setting('helm.r34_slug_reason', true), '') = 'new_link' then 'new_link' else 'renamed' end,
              auth.uid())
      on conflict (slug) do nothing;
  end if;
  return null;
end $$;
create or replace trigger ae_r34_slug_history after update of slug on public.event_sites
  for each row execute function public.tg_r34_slug_history();

-- ---- 4) helpers --------------------------------------------------------------------------------------------------------
-- the caller's network (cf-connecting-ip first, via 0261), hashed - never stored in clear
create or replace function public._r34_ip_hash()
returns text language plpgsql stable security definer set search_path = '' as $$
-- r34-invite-0284
declare v text := public._lv261_req() ->> 'ip';
begin
  return case when v is null or v = '' then null else encode(pg_catalog.sha256(convert_to('helm-invite:' || v, 'UTF8')), 'hex') end;
end $$;

-- guest text: control characters removed (newlines kept only when p_multi), spaces collapsed, trimmed; '' -> null
create or replace function public._r34_text(p text, p_multi boolean)
returns text language sql immutable set search_path = '' as $$
  -- r34-invite-0284
  select nullif(btrim(case when p_multi
      then regexp_replace(regexp_replace(regexp_replace(replace(coalesce(p, ''), E'\r', ''), E'[\\x01-\\x09\\x0b-\\x1f\\x7f]', ' ', 'g'),
             '[ ]{2,}', ' ', 'g'), E'\\n{3,}', E'\n\n', 'g')
      else regexp_replace(regexp_replace(coalesce(p, ''), E'[\\x01-\\x1f\\x7f]', ' ', 'g'), '\s+', ' ', 'g') end), '');
$$;

-- the reveal for one site: only the private address bits, only in 'after_rsvp' mode, only to a guest whose reply is
-- Yes or Maybe (a "No" reply never gets the address)
create or replace function public._r34_reveal(p_site public.event_sites, p_attending text)
returns jsonb language sql stable set search_path = '' as $$
  -- r34-invite-0284
  select case when (p_site.data ->> 'addressMode') = 'after_rsvp' and p_attending in ('yes', 'maybe')
    then jsonb_strip_nulls(jsonb_build_object(
           'address', nullif(left(coalesce(p_site.private_data ->> 'address', ''), 300), ''),
           'mapUrl', case when coalesce(p_site.private_data ->> 'mapUrl', '') ~* '^https://[^\s"''<>\\]+$'
                               and char_length(p_site.private_data ->> 'mapUrl') <= 500
                          then p_site.private_data ->> 'mapUrl' end))
    else null end;
$$;

-- ---- 5) the guest RSVP (signed out) --------------------------------------------------------------------------------------
-- p: {name, attending (yes | no | maybe), guests (0-20), message, token (to change an earlier reply), website (honeypot)}
-- -> {ok:true, token, updated, reveal?} | {ok:false, reason, message}
create or replace function public.public_invite_rsvp(p_slug text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r34-invite-0284
declare s public.event_sites; v_ip text := public._r34_ip_hash(); v_name text; v_msg text; v_att text; v_n integer;
  v_tok text; v_hash text; v_row public.event_site_rsvps; v_updated boolean := false;
begin
  if p_slug is null or char_length(p_slug) not between 1 and 200 or p is null or jsonb_typeof(p) <> 'object' then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'This invitation was not found.'); end if;
  -- honeypot: a bot filled the hidden field - answer as if saved, store nothing
  if coalesce(p ->> 'website', '') <> '' then return jsonb_build_object('ok', true, 'token', null); end if;
  -- the same gates as opening the invitation (published, live window, not shelved / cancelled)
  begin
    perform 1 from public.public_event_site(p_slug);
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', left(sqlerrm, 200));
  end;
  select * into s from public.event_sites x where x.slug = p_slug and x.status = 'published';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found', 'message', 'This invitation was not found.'); end if;
  if (s.data -> 'rsvpForm') is distinct from 'true'::jsonb then
    return jsonb_build_object('ok', false, 'reason', 'off', 'message', 'Replies are not taken on this invitation.'); end if;

  -- validate (length limits, no HTML)
  if char_length(coalesce(p ->> 'name', '')) > 200 or char_length(coalesce(p ->> 'message', '')) > 2000 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'message', 'That is too long.'); end if;
  if coalesce(p ->> 'name', '') ~ '[<>]' or coalesce(p ->> 'message', '') ~ '[<>]' then
    return jsonb_build_object('ok', false, 'reason', 'html', 'message', 'Please leave out the < and > characters.'); end if;
  v_name := public._r34_text(p ->> 'name', false);
  v_msg := public._r34_text(p ->> 'message', true);
  if v_name is null or char_length(v_name) > 80 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'name', 'message', 'Please write your name (up to 80 characters).'); end if;
  if v_msg is not null and char_length(v_msg) > 500 then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'message', 'message', 'Please keep the message under 500 characters.'); end if;
  v_att := lower(coalesce(p ->> 'attending', ''));
  if v_att not in ('yes', 'no', 'maybe') then
    return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'attending', 'message', 'Please choose Yes, No or Maybe.'); end if;
  if v_att = 'no' then v_n := 0;
  elsif coalesce(p ->> 'guests', '') ~ '^[0-9]{1,2}$' and (p ->> 'guests')::integer between 1 and 20 then v_n := (p ->> 'guests')::integer;
  else return jsonb_build_object('ok', false, 'reason', 'invalid', 'field', 'guests', 'message', 'Please choose how many are coming (1 to 20).');
  end if;

  -- rate limits AFTER validation (a typo does not use up a family's allowance): per network 30 / hour (many guests share
  -- one mobile / venue Wi-Fi address); a request with no readable network shares ONE low 'noip' bucket (never unlimited);
  -- everyone together 3000 / hour; then per site per day (below)
  if public.rate_hit(case when v_ip is null then 'inv_rsvp.noip' else 'inv_rsvp.ip' end, coalesce(v_ip, 'noip'), 3600,
                     case when v_ip is null then 20 else 30 end) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many replies from this network. Please try again in an hour.'); end if;
  if public.rate_hit('inv_rsvp.all', 'all', 3600, 3000) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Many guests are replying right now. Please try again in a few minutes.'); end if;

  perform pg_advisory_xact_lock(hashtext('helm_r34_rsvp:' || s.id::text));
  if public.rate_hit('inv_rsvp.site', s.id::text, 86400, 400) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'full', 'message', 'This invitation has had many replies today. Please try again tomorrow or contact the host.'); end if;

  -- a suspended / ended-trial studio is read-only (0045 guard on the table): the guest gets a calm answer, not an error
  begin
  -- a guest changing an earlier reply from the same device
  v_tok := lower(coalesce(p ->> 'token', ''));
  if v_tok ~ '^[0-9a-f]{64}$' then
    v_hash := encode(pg_catalog.sha256(convert_to(v_tok, 'UTF8')), 'hex');
    select * into v_row from public.event_site_rsvps r where r.token_hash = v_hash and r.site_id = s.id for update;
    if found then
      if v_row.edits >= 20 then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'This reply has been changed many times. Please contact the host.'); end if;
      update public.event_site_rsvps set guest_name = v_name, party_size = v_n, attending = v_att, message = v_msg,
             ip_hash = coalesce(v_ip, ip_hash), edits = edits + 1, updated_at = now()
       where id = v_row.id;
      v_updated := true;
    end if;
  end if;
  if not v_updated then
    if (select count(*) from public.event_site_rsvps r where r.site_id = s.id) >= 3000 then
      return jsonb_build_object('ok', false, 'reason', 'full', 'message', 'This invitation cannot take more replies. Please contact the host.'); end if;
    v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    v_hash := encode(pg_catalog.sha256(convert_to(v_tok, 'UTF8')), 'hex');
    insert into public.event_site_rsvps(org_id, site_id, guest_name, party_size, attending, message, token_hash, ip_hash)
      values (s.org_id, s.id, v_name, v_n, v_att, v_msg, v_hash, v_ip);
  end if;
  exception when read_only_sql_transaction then
    return jsonb_build_object('ok', false, 'reason', 'closed', 'message', 'Replies are not being taken right now. Please contact the host.');
  end;
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'token', v_tok, 'updated', v_updated, 'reveal', public._r34_reveal(s, v_att)));
end $$;

-- ---- 6) the reveal on a device that already replied ----------------------------------------------------------------------
-- -> {ok:true, reveal?, reply:{name, attending, guests, message}} | {ok:false}
create or replace function public.public_invite_reveal(p_slug text, p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r34-invite-0284
declare s public.event_sites; v_ip text := public._r34_ip_hash(); r public.event_site_rsvps; v_tok text := lower(coalesce(p_token, ''));
begin
  if p_slug is null or char_length(p_slug) not between 1 and 200 or v_tok !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit(case when v_ip is null then 'inv_reveal.noip' else 'inv_reveal.ip' end, coalesce(v_ip, 'noip'), 3600,
                     case when v_ip is null then 60 else 120 end) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  begin
    perform 1 from public.public_event_site(p_slug);
  exception when others then return jsonb_build_object('ok', false);
  end;
  select * into s from public.event_sites x where x.slug = p_slug and x.status = 'published';
  if not found then return jsonb_build_object('ok', false); end if;
  select * into r from public.event_site_rsvps x
   where x.site_id = s.id and x.token_hash = encode(pg_catalog.sha256(convert_to(v_tok, 'UTF8')), 'hex');
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_strip_nulls(jsonb_build_object('ok', true, 'reveal', public._r34_reveal(s, r.attending),
    'reply', jsonb_strip_nulls(jsonb_build_object('name', r.guest_name, 'attending', r.attending, 'guests', r.party_size, 'message', r.message))));
end $$;

-- ---- 7) what the guest page should say about a link -------------------------------------------------------------------------
-- -> {state:'live', studio} | {state:'off'} | {state:'moved'} | {state:'none'}   (nothing else is ever returned)
create or replace function public.public_invite_info(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r34-invite-0284
declare s public.event_sites; v_studio text;
begin
  if p_slug is null or char_length(p_slug) not between 1 and 200 then return jsonb_build_object('state', 'none'); end if;
  select * into s from public.event_sites x where x.slug = p_slug;
  if found then
    if s.status = 'published' then
      select nullif(left(btrim(o.name), 80), '') into v_studio from public.organizations o where o.id = s.org_id;
      return jsonb_strip_nulls(jsonb_build_object('state', 'live', 'studio', v_studio));
    end if;
    if s.status = 'unpublished' and s.published_at is not null then return jsonb_build_object('state', 'off'); end if;
    return jsonb_build_object('state', 'none');
  end if;
  if exists (select 1 from public.event_site_slug_history h where h.slug = p_slug) then return jsonb_build_object('state', 'moved'); end if;
  return jsonb_build_object('state', 'none');
end $$;

-- ---- 8) studio side ----------------------------------------------------------------------------------------------------------
-- the guest replies of one of my studio's sites (Quotes view)
create or replace function public.event_site_rsvp_list(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r34-invite-0284
declare v_org uuid := public.current_org_id();
begin
  if v_org is null then raise exception 'no organization in context' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'view') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.event_sites s where s.id = p_site and s.org_id = v_org) then
    raise exception 'invitation site not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.guest_name, 'attending', r.attending,
               'guests', r.party_size, 'message', r.message, 'created_at', r.created_at, 'updated_at', r.updated_at)
             order by r.created_at desc)
        from (select * from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org order by x.created_at desc limit 3000) r), '[]'::jsonb),
    'replies', (select count(*) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org),
    'yes', (select count(*) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org and x.attending = 'yes'),
    'maybe', (select count(*) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org and x.attending = 'maybe'),
    'no', (select count(*) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org and x.attending = 'no'),
    'guests_yes', (select coalesce(sum(x.party_size), 0) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org and x.attending = 'yes'),
    'guests_maybe', (select coalesce(sum(x.party_size), 0) from public.event_site_rsvps x where x.site_id = p_site and x.org_id = v_org and x.attending = 'maybe'));
end $$;

-- a new random public link for a site that has been published (Quotes edit); the old one is kept (moved)
create or replace function public.event_site_new_link(p_site uuid)
returns public.event_sites language plpgsql volatile security definer set search_path = '' as $$
-- r34-invite-0284
declare v_org uuid := public.current_org_id(); v_row public.event_sites; v_base text; v_slug text; v_try integer := 0;
begin
  if v_org is null then raise exception 'no organization in context' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'edit') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into v_row from public.event_sites s where s.id = p_site and s.org_id = v_org for update;
  if not found then raise exception 'invitation site not found' using errcode = 'P0002'; end if;
  if v_row.published_at is null then raise exception 'Publish the invitation first - it has no link yet.' using errcode = '22023'; end if;
  -- the same name-based form publish_event_site uses (so a later re-publish keeps this link)
  v_base := lower(coalesce(nullif(btrim(v_row.title), ''), v_row.data ->> 'names', 'invitation'));
  v_base := btrim(regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'), '-');
  v_base := left(v_base, 40);
  if coalesce(v_base, '') = '' then v_base := 'invitation'; end if;
  loop
    v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    exit when not exists (select 1 from public.event_sites x where x.slug = v_slug)
          and not exists (select 1 from public.event_site_slug_history h where h.slug = v_slug);
    v_try := v_try + 1;
    if v_try > 8 then raise exception 'could not make a new link - please try again' using errcode = 'P0001'; end if;
  end loop;
  perform set_config('helm.r34_slug_reason', 'new_link', true);
  update public.event_sites set slug = v_slug, updated_at = now() where id = p_site and org_id = v_org returning * into v_row;
  perform set_config('helm.r34_slug_reason', '', true);
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'event_site.new_link', 'event_sites', v_row.id::text, v_row.quote_id, jsonb_build_object('status', v_row.status), v_org);
  return v_row;
end $$;

-- a site's retired public links (Quotes view)
create or replace function public.event_site_old_links(p_site uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r34-invite-0284
declare v_org uuid := public.current_org_id();
begin
  if v_org is null then raise exception 'no organization in context' using errcode = '42501'; end if;
  if not public.has_area('quotes', 'view') then raise exception 'not permitted' using errcode = '42501'; end if;
  if not exists (select 1 from public.event_sites s where s.id = p_site and s.org_id = v_org) then
    raise exception 'invitation site not found' using errcode = 'P0002'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('slug', h.slug, 'reason', h.reason, 'retired_at', h.retired_at) order by h.retired_at desc)
                     from public.event_site_slug_history h where h.site_id = p_site and h.org_id = v_org), '[]'::jsonb);
end $$;

-- ---- 9) free-trial clean-up (0184) knows the new tables (patched in place once; skipped without 0184) -------------------------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''event_site_rsvps''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''event_sites''', ''))) / length('''event_sites''') <> 1 then
        raise notice '0284: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''event_sites''', '''event_site_rsvps'', ''event_site_slug_history'', ''event_sites''');
      end if;
    end if;
  end if;
end $$;

-- ---- 10) grants ------------------------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  foreach f in array array['public.tg_r34_site_private()', 'public.tg_r34_slug_history()', 'public._r34_ip_hash()',
      'public._r34_text(text, boolean)', 'public._r34_reveal(public.event_sites, text)', 'public.public_invite_rsvp(text, jsonb)',
      'public.public_invite_reveal(text, text)', 'public.public_invite_info(text)', 'public.event_site_rsvp_list(uuid)',
      'public.event_site_new_link(uuid)', 'public.event_site_old_links(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  -- the guest page (anyone with the link; each checks everything itself)
  foreach f in array array['public.public_invite_rsvp(text, jsonb)', 'public.public_invite_reveal(text, text)', 'public.public_invite_info(text)'] loop
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the Invitation Studio (each checks the Quotes area + the caller's own studio inside)
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.event_site_rsvp_list(uuid) to authenticated';
    execute 'grant execute on function public.event_site_new_link(uuid) to authenticated';
    execute 'grant execute on function public.event_site_old_links(uuid) to authenticated';
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 new tables event_site_rsvps + event_site_slug_history: RLS on, no anon / signed-in privilege',
     (select bool_and(c.relrowsecurity) from pg_class c where c.oid in ('public.event_site_rsvps'::regclass, 'public.event_site_slug_history'::regclass))
     and not has_table_privilege('anon', 'public.event_site_rsvps', 'select')
     and not has_table_privilege('authenticated', 'public.event_site_rsvps', 'select')
     and not has_table_privilege('anon', 'public.event_site_slug_history', 'select')
     and not has_table_privilege('authenticated', 'public.event_site_slug_history', 'select')),
  ('02 guests may call public_invite_rsvp / reveal / info; studio RPCs are for signed-in staff only',
     has_function_privilege('anon', 'public.public_invite_rsvp(text, jsonb)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_reveal(text, text)', 'execute')
     and has_function_privilege('anon', 'public.public_invite_info(text)', 'execute')
     and not has_function_privilege('anon', 'public.event_site_rsvp_list(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.event_site_new_link(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.event_site_rsvp_list(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.event_site_new_link(uuid)', 'execute')),
  ('03 event_sites.private_data added; the privacy + link-history triggers are in place',
     exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'event_sites' and column_name = 'private_data')
     and exists (select 1 from pg_trigger where tgrelid = 'public.event_sites'::regclass and tgname = 'ad_r34_site_private')
     and exists (select 1 from pg_trigger where tgrelid = 'public.event_sites'::regclass and tgname = 'ae_r34_slug_history')),
  ('04 template check = the 5 old + 6 new themes; every existing site still passes',
     (select position('linen' in pg_get_constraintdef(oid)) > 0 and position('eternal' in pg_get_constraintdef(oid)) > 0
        from pg_constraint where conname = 'event_sites_template_chk' and conrelid = 'public.event_sites'::regclass)
     and not exists (select 1 from public.event_sites where template not in
        ('eternal', 'confetti', 'summit', 'promise', 'soiree', 'shubh', 'mehndi', 'solitaire', 'jubilee', 'gala', 'linen'))),
  ('05 existing sites untouched: nothing moved to private_data unless a studio switched a setting on',
     not exists (select 1 from public.event_sites s where s.private_data <> '{}'::jsonb
        and (s.data ->> 'addressMode') is distinct from 'after_rsvp' and (s.data -> 'rsvpContact') is distinct from 'false'::jsonb)),
  ('06 free-trial clean-up knows the new tables (or 0184 is not installed)',
     to_regprocedure('public._tr184_purge_tables()') is null
     or public._tr184_purge_tables() @> array['event_site_rsvps', 'event_site_slug_history']),
  ('07 both new tables carry the studio read-only guard (zzz_studio_read_only)',
     (select count(*) from pg_trigger where tgname = 'zzz_studio_read_only'
        and tgrelid in ('public.event_site_rsvps'::regclass, 'public.event_site_slug_history'::regclass)) = 2
     or to_regprocedure('public.tg_studio_read_only()') is null)
) v(item, ok) order by item;
