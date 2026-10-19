-- 0261_client_link_views.sql - CANONICAL forward-only.
-- REQUIRES 0078 (client_link_opens, public_link_opened, comms_outbox, _comms_cfg, _comms_render, _comms_quote_live,
--          comms_outbox_claim chain), 0156 (public_link_opened rate limit), 0036 + 0250 + 0254 (bell_feed chain,
--          notification catalog), 0144 + 0254 (event_activity), 0065 (client_booklets), 0151 (wa_proposal_optins,
--          _wa151_e164), 0155 (_wa_opted_out), 0166 + 0187 (_sample_outbound_blocked), 0092 (_comms_country),
--          0050 (rate_hit), phase29 / phase57 (has_area, current_org_id, user_role), 0045 (tg_studio_read_only),
--          0004 (tg_quote_org_match), 0184 (trial retention lists).
--
-- In plain words (r23, DocSend / PandaDoc / Proposify model: "show when a client opens their link"):
--   1  client_link_views - ONE row per page a client opened on their private links: the client page (portal),
--      the quotation (approve page), the booklet, and the moment they start approving (asked for the code).
--      Each row has the visit number (pages opened from the same device within 30 minutes are one visit),
--      the device type / system / browser (read from the request, never typed by the page) and the IP address.
--      Written ONLY by public_link_viewed(page, token, preview) - signed-out pages call it; it returns nothing
--      and never breaks the client's page. NOT counted: a signed-in member of the studio (previewing their own
--      link), a Helm HQ operator, a page opened with the preview flag (the "Preview" buttons), link-preview bots,
--      a refresh of the same page in the same visit. The 0078 open counter (client_link_opens, used by the
--      automatic follow-ups) keeps being updated exactly as before.
--   2  Bell: the FIRST open -> "Rahul opened the proposal" (kind client_link_viewed) for the quote's owner and
--      everyone with Quotes view; later visits only when the studio switches "re-opens" on (at most one bell row
--      per quote every N hours, default 12).
--   3  "Viewed but not approved": when the client opened the link N days ago (Control Center, default 2) and
--      has not approved, ONE follow-up row (client_view_followups) + a bell row (kind client_view_followup) for
--      the quote's owner (manager, else creator) and the admins. The owner taps "Send a nudge" (link_view_nudge:
--      a polite e-mail / WhatsApp from the studio's own follow-up template, QUEUED in comms_outbox and sent by
--      comms-dispatch - dormant until deployed; never for a free trial / demo event / STOP number; WhatsApp only
--      with the client's opt-in on record) or "Dismiss". At most 3 follow-ups per quote, a new one only after a
--      new visit. Approved / confirmed / cancelled / closed -> resolved. Made by link_views_tick (pg_cron every
--      30 minutes, only if pg_cron is installed) and also by link_views_attention (so it works without pg_cron).
--      "Auto-nudge" = the existing 0078 automatic client follow-ups (comms_settings.fu_enabled, OFF by default) -
--      nothing new sends on its own.
--   4  Reads for the app (same studio, Quotes view): link_views_summary(quotes[]) ("Viewed 3x - last 2h ago" on
--      quote rows), link_views_timeline(quote) (visits: first / last open, device, pages; the IP address ONLY for
--      admins), link_views_attention() (the "viewed, not approved" list for the Attention tab + dashboard).
--   5  Control Center (client_view_settings, one row per studio; Control Center EDIT to change): track opens
--      (on), bell on first open (on), bell on re-opens (off, every 12 h), viewed-not-approved follow-up (on, 2 days).
--   6  event_activity lists "Client opened the booklet (Mobile - Android)" / follow-ups (Quotes viewers); the raw
--      bell rows are left out of it.
-- DRIFT-SAFE: bell_feed, event_activity, comms_outbox_claim, notification_catalog, notification_type_of and
-- notify_default are renamed ONCE to *__pre0261 (the database's own bodies are kept) and wrapped; each wrapper
-- carries the marker 'r23-link-views-0261'. public_link_opened (0078 / 0156) is NOT changed (older pages keep it).
-- ZERO DATA LOSS: 3 new tables, new functions, 6 wrappers. No table, column, row, trigger or policy is dropped or
-- deleted; no existing row is updated (only this feature's own follow-up rows change status). Additive +
-- idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed; no data involved): for each wrapped function f:
--   drop function public.f(...); alter function public.f__pre0261(...) rename to f; re-grant as before
--   (bell_feed / event_activity / notification_catalog / notification_type_of to authenticated; comms_outbox_claim to
--   service_role; notify_default to nobody). The 3 new tables can stay (nothing reads them then).

do $$ begin
  if to_regclass('public.client_link_opens') is null or to_regclass('public.comms_outbox') is null
     or to_regprocedure('public._comms_cfg(uuid)') is null or to_regprocedure('public._comms_render(text,jsonb)') is null
     or to_regprocedure('public._comms_quote_live(uuid)') is null or to_regprocedure('public.comms_outbox_claim(integer)') is null then
    raise exception 'STOP 0261: apply 0078 (comms automation) first'; end if;
  if to_regprocedure('public.bell_feed(integer)') is null or to_regprocedure('public.event_activity(uuid)') is null
     or to_regprocedure('public.notification_catalog()') is null or to_regprocedure('public.notification_type_of(text,text)') is null
     or to_regprocedure('public.notify_default(uuid,text,text,text)') is null then
    raise exception 'STOP 0261: apply 0036 + 0144 + 0250 (bell_feed / event_activity / notification catalog) first'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null or to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then
    raise exception 'STOP 0261: has_area / current_org_id / user_role / rate_hit missing'; end if;
  if to_regclass('public.client_booklets') is null or to_regclass('public.wa_proposal_optins') is null
     or to_regprocedure('public._wa151_e164(text,text)') is null or to_regprocedure('public._wa_opted_out(text,uuid)') is null
     or to_regprocedure('public._sample_outbound_blocked(uuid,text)') is null or to_regprocedure('public._comms_country(uuid)') is null
     or to_regprocedure('public._tr212_claim_blocked(uuid,text,text,text,jsonb)') is null then
    raise exception 'STOP 0261: apply 0065 + 0092 + 0151 + 0155 + 0166 + 0212 first'; end if;
end $$;

-- ---- 1) tables ---------------------------------------------------------------------------------------------------
create table if not exists public.client_link_views (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations(id) on delete cascade,
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  page       text not null check (page in ('portal', 'booklet', 'quotation', 'approve')),
  visit_no   integer not null default 1 check (visit_no between 1 and 100000),
  device     text not null default 'unknown' check (device in ('mobile', 'tablet', 'desktop', 'unknown')),
  os         text check (os is null or char_length(os) <= 40),
  browser    text check (browser is null or char_length(browser) <= 40),
  ip         text check (ip is null or char_length(ip) <= 64),
  fp         text not null check (char_length(fp) = 64),
  created_at timestamptz not null default now()
);
create index if not exists client_link_views_quote_idx on public.client_link_views(org_id, quote_id, created_at);
create index if not exists client_link_views_visit_idx on public.client_link_views(quote_id, fp, created_at);
create index if not exists client_link_views_recent_idx on public.client_link_views(created_at);

create table if not exists public.client_view_settings (
  org_id           uuid primary key references public.organizations(id) on delete cascade,
  track_enabled    boolean not null default true,
  bell_first       boolean not null default true,
  bell_repeat      boolean not null default false,
  repeat_hours     integer not null default 12 check (repeat_hours between 1 and 168),
  followup_enabled boolean not null default true,
  followup_days    integer not null default 2 check (followup_days between 1 and 30),
  updated_by       uuid,
  updated_at       timestamptz not null default now()
);

create table if not exists public.client_view_followups (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  quote_id        uuid not null references public.quotes(id) on delete cascade,
  round           integer not null default 1 check (round between 1 and 3),
  owner_id        uuid,
  status          text not null default 'open' check (status in ('open', 'nudged', 'dismissed', 'resolved')),
  views           integer not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  nudge_channel   text check (nudge_channel is null or nudge_channel in ('email', 'whatsapp')),
  closed_by       uuid,
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  unique (quote_id, round)
);
create unique index if not exists client_view_followups_one_open on public.client_view_followups(quote_id) where status = 'open';
create index if not exists client_view_followups_org_idx on public.client_view_followups(org_id, status, created_at);

-- RLS on; no API-role access at all (definer RPCs only)
do $$ declare t text; begin
  foreach t in array array['client_link_views', 'client_view_settings', 'client_view_followups'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if to_regprocedure('public.tg_studio_read_only()') is not null then
      execute format('drop trigger if exists zzz_studio_read_only on public.%I', t);
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    foreach t in array array['client_link_views', 'client_view_followups'] loop
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end loop;
  end if;
end $$;

-- trial retention (0184): views + follow-ups purge with the quote; the settings row is kept (like comms_settings)
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''client_link_views''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''client_link_opens''', ''))) / length('''client_link_opens''') <> 1 then
        raise notice '0261: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''client_link_opens''', '''client_link_opens'', ''client_link_views'', ''client_view_followups''');
      end if;
    end if;
  end if;
  if to_regprocedure('public._tr184_keep_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_keep_tables()'::regprocedure);
    if position('''client_view_settings''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''comms_settings''', ''))) / length('''comms_settings''') <> 1 then
        raise notice '0261: _tr184_keep_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''comms_settings''', '''comms_settings'', ''client_view_settings''');
      end if;
    end if;
  end if;
end $$;

-- ---- 2) helpers (internal) ----------------------------------------------------------------------------------------
-- the studio's settings with defaults (a studio without a row = the defaults)
create or replace function public._lv261_cfg(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  -- r23-link-views-0261
  select jsonb_build_object(
    'track_enabled', coalesce(s.track_enabled, true),
    'bell_first', coalesce(s.bell_first, true),
    'bell_repeat', coalesce(s.bell_repeat, false),
    'repeat_hours', coalesce(s.repeat_hours, 12),
    'followup_enabled', coalesce(s.followup_enabled, true),
    'followup_days', coalesce(s.followup_days, 2),
    'updated_at', s.updated_at)
  from (select 1) one left join public.client_view_settings s on s.org_id = p_org;
$$;

-- device type / system / browser from a user agent (no fingerprinting beyond this)
create or replace function public._lv261_device(p_ua text)
returns jsonb language sql immutable set search_path = '' as $$
  -- r23-link-views-0261
  select jsonb_build_object(
    'device', case when u = '' then 'unknown'
                   when u ~* '(ipad|tablet|kindle|silk/|playbook)' or (u ~* 'android' and u !~* 'mobile') then 'tablet'
                   when u ~* '(mobi|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone)' then 'mobile'
                   else 'desktop' end,
    'os', case when u ~* '(iphone|ipad|ipod)' then 'iOS' when u ~* 'android' then 'Android'
               when u ~* 'windows' then 'Windows' when u ~* '(macintosh|mac os x)' then 'macOS'
               when u ~* 'cros' then 'ChromeOS' when u ~* 'linux' then 'Linux' end,
    'browser', case when u ~* 'whatsapp' then 'WhatsApp' when u ~* '(fban|fbav)' then 'Facebook' when u ~* 'instagram' then 'Instagram'
                    when u ~* 'edg(e|a|ios)?/' then 'Edge' when u ~* 'samsungbrowser' then 'Samsung Internet'
                    when u ~* '(opr/|opera)' then 'Opera' when u ~* '(firefox|fxios)' then 'Firefox'
                    when u ~* '(chrome|crios)' then 'Chrome' when u ~* 'safari' then 'Safari' end)
  from (select coalesce(left(p_ua, 400), '') as u) x;
$$;

-- link-preview bots / crawlers / headless browsers never count as "the client opened it"
create or replace function public._lv261_is_bot(p_ua text)
returns boolean language sql immutable set search_path = '' as $$
  -- r23-link-views-0261
  select coalesce(p_ua, '') ~* '(bot|crawl|spider|slurp|preview|facebookexternalhit|^whatsapp/|telegram|skypeuripreview|headlesschrome|lighthouse|curl/|wget/|python-|node-fetch|axios/|go-http)';
$$;

-- the caller's user agent + IP from the request headers (PostgREST), never from the page
create or replace function public._lv261_req()
returns jsonb language plpgsql stable set search_path = '' as $$
-- r23-link-views-0261
declare h jsonb; v_ip text; v_ua text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ua := left(coalesce(h ->> 'user-agent', ''), 400);
  v_ip := btrim(split_part(coalesce(nullif(h ->> 'cf-connecting-ip', ''), nullif(h ->> 'x-forwarded-for', ''), nullif(h ->> 'x-real-ip', ''), ''), ',', 1));
  begin
    if v_ip <> '' then v_ip := host(v_ip::inet); else v_ip := null; end if;
  exception when others then v_ip := null;
  end;
  return jsonb_build_object('ua', v_ua, 'ip', v_ip);
end $$;

-- the quote's owner: its manager, else whoever saved its first version - only while they are still in the studio
create or replace function public._lv261_owner(p_quote uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  -- r23-link-views-0261
  select coalesce(
    (select p.id from public.quotes q join public.profiles p on p.id = q.manager_id and p.org_id = q.org_id where q.id = p_quote),
    (select p.id from public.quote_versions v join public.quotes q on q.id = v.quote_id
       join public.profiles p on p.id = v.created_by and p.org_id = q.org_id
      where v.quote_id = p_quote order by v.version_no, v.created_at limit 1));
$$;

create or replace function public._lv261_page_label(p_page text)
returns text language sql immutable set search_path = '' as $$
  -- r23-link-views-0261
  select case p_page when 'portal' then 'the proposal' when 'booklet' then 'the booklet'
                     when 'quotation' then 'the quotation' when 'approve' then 'the approval step' else 'their link' end;
$$;

create or replace function public._lv261_mask(p_channel text, p_to text)
returns text language sql immutable set search_path = '' as $$
  -- r23-link-views-0261: a***@b.com / +91******3210
  select case when p_channel = 'email' and position('@' in coalesce(p_to, '')) > 1
              then left(p_to, 1) || '***' || substr(p_to, position('@' in p_to))
              when p_channel = 'whatsapp' and length(coalesce(p_to, '')) >= 6
              then '+' || left(p_to, 2) || repeat('*', greatest(length(p_to) - 6, 0)) || right(p_to, 4)
              else '***' end;
$$;

-- a quote still waiting for the client (not approved / paid / confirmed / cancelled / closed / archived / deleted)
create or replace function public._lv261_waiting(p_quote uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-link-views-0261
  select public._comms_quote_live(p_quote)
     and coalesce((select q.status not in ('confirmed', 'cancelled')
                          and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled')
                     from public.quotes q where q.id = p_quote), false);
$$;

-- ---- 3) the signed-out pages: "the client opened this page" ---------------------------------------------------------
create or replace function public.public_link_viewed(p_page text, p_token uuid, p_preview boolean default false)
returns void language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: never raises, returns nothing; staff / HQ / preview / bots are not counted
declare
  v_q uuid; v_org uuid; v_kind text; v_cfg jsonb; r jsonb; v_ua text; v_ip text; v_fp text; d jsonb;
  v_visit integer; v_prev integer; v_new boolean := false; v_first boolean := false; v_n integer;
  v_code text; v_name text; v_owner uuid; v_label text;
begin
  if p_token is null or p_page is null or p_page not in ('portal', 'booklet', 'quotation', 'approve') then return; end if;
  if coalesce(p_preview, false) then return; end if;
  v_kind := case when p_page = 'booklet' then 'booklet' else 'quote' end;
  -- no rate-limit row for a random token (0156 rule)
  if v_kind = 'booklet' then
    if not exists (select 1 from public.client_booklets b where b.token = p_token) then return; end if;
  elsif not exists (select 1 from public.quotes q where q.approval_token = p_token) then return; end if;
  begin
    if public.rate_hit('link_view', p_token::text, 3600, 120) > 0 then return; end if;
  exception when others then return;
  end;
  if v_kind = 'booklet' then
    select b.quote_id, b.org_id into v_q, v_org from public.client_booklets b
     where b.token = p_token and b.revoked_at is null and b.expires_at > now();
  else
    select q.id, q.org_id into v_q, v_org from public.quotes q
     where q.approval_token = p_token and q.approval_token_revoked_at is null
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now());
  end if;
  if v_q is null or v_org is null then return; end if;
  -- a studio member previewing their own link, or a Helm HQ operator, is not "the client opened it"
  if auth.uid() is not null then
    if exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id = v_org) then return; end if;
    begin
      if to_regprocedure('public.is_platform_operator()') is not null and public.is_platform_operator() then return; end if;
    exception when others then null;
    end;
  end if;
  r := public._lv261_req(); v_ua := r ->> 'ua'; v_ip := r ->> 'ip';
  if public._lv261_is_bot(v_ua) then return; end if;

  -- the 0078 open counter (automatic follow-up timing) works exactly as before ('approve' is a click, not an open)
  if p_page <> 'approve' then
    begin
      insert into public.client_link_opens(quote_id, kind, org_id) values (v_q, v_kind, v_org)
        on conflict (quote_id, kind) do update set last_opened_at = now(), open_count = public.client_link_opens.open_count + 1;
    exception when others then null;     -- e.g. a suspended (read-only) studio: never break the client's page
    end;
  end if;

  v_cfg := public._lv261_cfg(v_org);
  if not coalesce((v_cfg ->> 'track_enabled')::boolean, true) then return; end if;
  v_fp := encode(sha256(convert_to(coalesce(v_ip, '') || '|' || coalesce(v_ua, ''), 'UTF8')), 'hex');
  d := public._lv261_device(v_ua);
  begin
    perform pg_advisory_xact_lock(hashtextextended('helm:lv261:' || v_q::text, 0));
    select v.visit_no into v_prev from public.client_link_views v
     where v.quote_id = v_q and v.fp = v_fp and v.created_at > now() - interval '30 minutes'
     order by v.created_at desc limit 1;
    if v_prev is not null then
      -- same visit: a refresh of a page already logged in this visit adds nothing
      if exists (select 1 from public.client_link_views v where v.quote_id = v_q and v.visit_no = v_prev and v.page = p_page
                   and v.fp = v_fp and v.created_at > now() - interval '30 minutes') then return; end if;
      v_visit := v_prev;
    else
      select coalesce(max(v.visit_no), 0) + 1 into v_visit from public.client_link_views v where v.quote_id = v_q;
      v_new := true; v_first := v_visit = 1;
    end if;
    insert into public.client_link_views(org_id, quote_id, page, visit_no, device, os, browser, ip, fp, created_at)
      values (v_org, v_q, p_page, v_visit, d ->> 'device', d ->> 'os', d ->> 'browser', v_ip, v_fp, clock_timestamp());
  exception when others then return;
  end;

  -- bell: the first open; later visits only when the studio wants them (throttled per quote)
  if not v_new then return; end if;
  begin
    select q.code, nullif(left(regexp_replace(btrim(coalesce(q.client ->> 'name', '')), '\s+', ' ', 'g'), 60), '')
      into v_code, v_name from public.quotes q where q.id = v_q;
    v_owner := public._lv261_owner(v_q);
    if v_first and coalesce((v_cfg ->> 'bell_first')::boolean, true) then
      v_label := coalesce(v_name, 'Your client') || ' opened ' || public._lv261_page_label(p_page);
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (v_q, 'in_app', 'client_link_viewed', 'simulated',
                jsonb_build_object('label', v_label, 'first', true, 'views', 1, 'page', p_page, 'device', d ->> 'device', 'os', d ->> 'os',
                                   'client', v_name, 'event_code', v_code, 'via', 'link_views', 'source', '0261',
                                   'notify', case when v_owner is not null then jsonb_build_array(v_owner) else '[]'::jsonb end), v_org);
    elsif not v_first and coalesce((v_cfg ->> 'bell_repeat')::boolean, false)
          and not exists (select 1 from public.notifications n where n.quote_id = v_q and n.org_id = v_org and n.kind = 'client_link_viewed'
                            and n.created_at > now() - make_interval(hours => coalesce((v_cfg ->> 'repeat_hours')::int, 12))) then
      select count(distinct v.visit_no) into v_n from public.client_link_views v where v.quote_id = v_q;
      v_label := coalesce(v_name, 'Your client') || ' opened ' || public._lv261_page_label(p_page) || ' again (' || v_n || ' visits)';
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (v_q, 'in_app', 'client_link_viewed', 'simulated',
                jsonb_build_object('label', v_label, 'first', false, 'views', v_n, 'page', p_page, 'device', d ->> 'device', 'os', d ->> 'os',
                                   'client', v_name, 'event_code', v_code, 'via', 'link_views', 'source', '0261',
                                   'notify', case when v_owner is not null then jsonb_build_array(v_owner) else '[]'::jsonb end), v_org);
    end if;
  exception when others then null;
  end;
end $$;

-- ---- 4) "viewed but not approved" follow-ups (internal) -------------------------------------------------------------
create or replace function public._lv261_sweep(p_org uuid)
returns integer language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: resolve finished ones, then create due ones (idempotent: one open per quote, max 3 rounds)
declare v_cfg jsonb := public._lv261_cfg(p_org); v_days integer; r record; v_last record; v_id uuid; v_owner uuid;
        v_n integer := 0; v_name text; v_code text; v_wait integer; v_notify jsonb;
begin
  if p_org is null then return 0; end if;
  update public.client_view_followups f set status = 'resolved', closed_at = now()
   where f.org_id = p_org and f.status = 'open' and not public._lv261_waiting(f.quote_id);
  if not coalesce((v_cfg ->> 'followup_enabled')::boolean, true) or not coalesce((v_cfg ->> 'track_enabled')::boolean, true) then return 0; end if;
  v_days := greatest(1, least(coalesce((v_cfg ->> 'followup_days')::int, 2), 30));
  for r in
    select v.quote_id, min(v.created_at) as first_at, max(v.created_at) as last_at, count(distinct v.visit_no)::int as visits
      from public.client_link_views v join public.quotes q on q.id = v.quote_id and q.org_id = p_org
     where v.org_id = p_org and q.status not in ('confirmed', 'cancelled')
       and coalesce(q.approval_status, 'none') not in ('approved', 'paid', 'cancelled')
     group by v.quote_id
    having min(v.created_at) <= now() - make_interval(days => v_days)
  loop
    if not public._lv261_waiting(r.quote_id) then continue; end if;
    if exists (select 1 from public.client_view_followups f where f.quote_id = r.quote_id and f.status = 'open') then continue; end if;
    v_last := null;
    select f.round, f.created_at, f.closed_at into v_last from public.client_view_followups f
     where f.quote_id = r.quote_id order by f.round desc limit 1;
    if v_last.round is not null then
      if v_last.round >= 3 then continue; end if;
      if v_last.closed_at is null or v_last.closed_at > now() - make_interval(days => v_days) then continue; end if;
      if r.last_at <= v_last.created_at then continue; end if;      -- no new visit since the last follow-up
    end if;
    v_owner := public._lv261_owner(r.quote_id);
    v_id := null;
    insert into public.client_view_followups(org_id, quote_id, round, owner_id, views, first_viewed_at, last_viewed_at)
      values (p_org, r.quote_id, coalesce(v_last.round, 0) + 1, v_owner, r.visits, r.first_at, r.last_at)
      on conflict do nothing returning id into v_id;
    if v_id is null then continue; end if;
    v_n := v_n + 1;
    begin
      select q.code, nullif(left(regexp_replace(btrim(coalesce(q.client ->> 'name', '')), '\s+', ' ', 'g'), 60), '')
        into v_code, v_name from public.quotes q where q.id = r.quote_id;
      v_wait := greatest(1, floor(extract(epoch from (now() - r.first_at)) / 86400)::int);
      select coalesce(jsonb_agg(distinct to_jsonb(x.id)), '[]'::jsonb) into v_notify
        from (select v_owner as id where v_owner is not null
              union select p.id from public.profiles p where p.org_id = p_org and p.role = 'admin') x;
      insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
        values (r.quote_id, 'in_app', 'client_view_followup', 'simulated',
                jsonb_build_object('label', coalesce(v_name, 'Your client') || ' viewed the proposal ' || r.visits
                                     || case when r.visits = 1 then ' time' else ' times' end || ' but has not approved (' || v_wait
                                     || case when v_wait = 1 then ' day' else ' days' end || ') - send a nudge',
                                   'followup_id', v_id, 'round', coalesce(v_last.round, 0) + 1, 'views', r.visits, 'days', v_wait,
                                   'client', v_name, 'event_code', v_code, 'owner_id', v_owner,
                                   'via', 'link_views', 'source', '0261', 'notify', v_notify), p_org);
    exception when others then raise warning 'r23-link-views-0261: follow-up bell skipped (%)', sqlstate;
    end;
  end loop;
  return v_n;
end $$;

-- pg_cron / service role: every studio with recent views or open follow-ups
create or replace function public.link_views_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261
declare o record; v_n integer := 0;
begin
  for o in select x.org_id from (
             select distinct v.org_id from public.client_link_views v where v.created_at > now() - interval '60 days'
             union select distinct f.org_id from public.client_view_followups f where f.status = 'open') x
  loop
    begin v_n := v_n + public._lv261_sweep(o.org_id);
    exception when others then raise warning 'r23-link-views-0261: studio sweep skipped (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('followups', v_n);
end $$;

-- ---- 5) reads for the app (same studio, Quotes view) ---------------------------------------------------------------
create or replace function public.link_views_summary(p_quotes uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-link-views-0261: { "<quote id>": { views, opens, first_at, last_at, last_page, last_device, approved, followup } }
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_quotes is null or cardinality(p_quotes) = 0 then return '{}'::jsonb; end if;
  if cardinality(p_quotes) > 200 then raise exception 'ask for at most 200 quotes at a time' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_object_agg(x.quote_id::text, jsonb_build_object(
             'views', x.visits, 'opens', x.opens, 'first_at', x.first_at, 'last_at', x.last_at,
             'last_page', x.last_page, 'last_device', x.last_device,
             'approved', coalesce(q.approval_status, 'none') in ('approved', 'paid') or q.status = 'confirmed',
             'followup', (select jsonb_build_object('id', f.id, 'status', f.status, 'round', f.round, 'at', f.created_at,
                                                    'closed_at', f.closed_at, 'channel', f.nudge_channel)
                            from public.client_view_followups f where f.quote_id = x.quote_id and f.org_id = v_org
                           order by f.round desc limit 1)))
      from (select v.quote_id, count(distinct v.visit_no)::int as visits, count(*)::int as opens,
                   min(v.created_at) as first_at, max(v.created_at) as last_at,
                   (array_agg(v.page order by v.created_at desc))[1] as last_page,
                   (array_agg(v.device order by v.created_at desc))[1] as last_device
              from public.client_link_views v
             where v.org_id = v_org and v.quote_id = any (p_quotes)
             group by v.quote_id) x
      join public.quotes q on q.id = x.quote_id and q.org_id = v_org), '{}'::jsonb);
end $$;

create or replace function public.link_views_timeline(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-link-views-0261: the visits of one quote; the IP address ONLY for admins
declare v_org uuid := public.current_org_id(); v_admin boolean := coalesce(public.user_role(), '') = 'admin';
        q record; v_cfg jsonb; v_visits jsonb; v_nudges jsonb; v_fu jsonb; v_email boolean; v_wa boolean; v_dial text; v_e164 text;
        v_s jsonb;
begin
  if auth.uid() is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.client, x.status, x.approval_status, x.tax_snapshot into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  v_cfg := public._lv261_cfg(v_org);
  select coalesce(jsonb_agg(z.j order by z.visit_no desc), '[]'::jsonb) into v_visits from (
    select v.visit_no, jsonb_build_object(
             'visit', v.visit_no, 'started_at', min(v.created_at), 'ended_at', max(v.created_at),
             'device', (array_agg(v.device order by v.created_at))[1], 'os', (array_agg(v.os order by v.created_at))[1],
             'browser', (array_agg(v.browser order by v.created_at))[1],
             'pages', jsonb_agg(jsonb_build_object('page', v.page, 'at', v.created_at) order by v.created_at),
             'ip', case when v_admin then (array_agg(v.ip order by v.created_at))[1] end) as j
      from public.client_link_views v where v.quote_id = p_quote and v.org_id = v_org
     group by v.visit_no order by v.visit_no desc limit 50) z;
  select jsonb_build_object('views', count(distinct v.visit_no), 'opens', count(*), 'first_at', min(v.created_at), 'last_at', max(v.created_at))
    into v_s from public.client_link_views v where v.quote_id = p_quote and v.org_id = v_org;
  select coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'channel', c.channel, 'to', public._lv261_mask(c.channel, c.recipient),
                                               'status', case when c.status = 'pending' then 'queued' else c.status end,
                                               'manual', coalesce((c.payload ->> 'manual')::boolean, false)) order by c.created_at desc), '[]'::jsonb)
    into v_nudges from (select * from public.comms_outbox c where c.org_id = v_org and c.quote_id = p_quote and c.purpose = 'follow_up'
                         order by c.created_at desc limit 10) c;
  select jsonb_build_object('id', f.id, 'status', f.status, 'round', f.round, 'at', f.created_at, 'closed_at', f.closed_at,
                            'channel', f.nudge_channel, 'mine', f.owner_id = auth.uid())
    into v_fu from public.client_view_followups f where f.quote_id = p_quote and f.org_id = v_org order by f.round desc limit 1;
  v_email := public._comms_client_to(q.client, 'email') is not null;
  v_dial := case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(v_org)))
              when 'AE' then '971' when 'US' then '1' else '91' end;
  v_e164 := public._wa151_e164(q.client ->> 'phone', v_dial);
  v_wa := v_e164 is not null
          and coalesce(public._comms_cfg(v_org) ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$'
          and not public._wa_opted_out(substr(v_e164, 2), v_org)
          and coalesce((select o.opted_in from public.wa_proposal_optins o where o.quote_id = p_quote and o.phone_e164 = v_e164
                         order by o.recorded_at desc, o.id desc limit 1), false);
  return coalesce(v_s, '{}'::jsonb) || jsonb_build_object(
    'visits', v_visits, 'nudges', v_nudges, 'followup', v_fu, 'is_admin', v_admin,
    'approved', coalesce(q.approval_status, 'none') in ('approved', 'paid') or q.status = 'confirmed',
    'waiting', public._lv261_waiting(p_quote),
    'can_nudge', public.has_area('quotes', 'edit') and public._lv261_waiting(p_quote),
    'channels', jsonb_build_object('email', v_email, 'whatsapp', v_wa),
    'settings', v_cfg);
end $$;

-- the "viewed, not approved" list (Attention tab + dashboard); also makes due follow-ups (works without pg_cron)
create or replace function public.link_views_attention()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid();
begin
  if v_uid is null or v_org is null or not public.has_area('quotes', 'view') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  begin
    if public.rate_hit('lv_sweep', v_org::text, 300, 1) = 0 then perform public._lv261_sweep(v_org); end if;
  exception when others then null;     -- a read-only studio / call: just list what is there
  end;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'followup_id', f.id, 'quote_id', f.quote_id, 'code', q.code, 'title', q.title,
             'client', nullif(btrim(coalesce(q.client ->> 'name', '')), ''), 'round', f.round, 'at', f.created_at,
             'views', (select count(distinct v.visit_no) from public.client_link_views v where v.quote_id = f.quote_id),
             'first_at', f.first_viewed_at,
             'last_at', (select max(v.created_at) from public.client_link_views v where v.quote_id = f.quote_id),
             'mine', f.owner_id = v_uid, 'owner', public._sa54_name(f.owner_id))
             order by f.created_at)
      from public.client_view_followups f join public.quotes q on q.id = f.quote_id and q.org_id = v_org
     where f.org_id = v_org and f.status = 'open' and public._lv261_waiting(f.quote_id)), '[]'::jsonb);
end $$;

-- ---- 6) actions: send a nudge / dismiss ------------------------------------------------------------------------------
create or replace function public.link_view_nudge(p_quote uuid, p_channel text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: one polite follow-up to the client's address ON THE QUOTE, queued (comms-dispatch sends it)
declare
  v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); q record; v_cfg jsonb; v_to text; v_e164 text; v_dial text;
  v_studio text; v_text text; v_key text; v_id uuid; v_status text; v_reason text; v_n integer; v_fu uuid; v_blocked boolean;
begin
  if v_uid is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'choose E-mail or WhatsApp' using errcode = '22023'; end if;
  select x.id, x.client, x.title, x.is_demo, x.tax_snapshot into q from public.quotes x where x.id = p_quote and x.org_id = v_org;
  if q.id is null then raise exception 'not authorized for this event' using errcode = '42501'; end if;
  if not public._lv261_waiting(q.id) then
    raise exception 'This client has already approved (or the event is closed / cancelled) - no nudge needed.' using errcode = 'P0001', hint = 'not_waiting'; end if;
  v_cfg := public._comms_cfg(v_org);
  if p_channel = 'email' then
    v_to := public._comms_client_to(q.client, 'email');
    if v_to is null then raise exception 'Add the client''s e-mail to the event first.' using errcode = 'P0001', hint = 'no_email'; end if;
  else
    v_dial := case upper(coalesce(nullif(q.tax_snapshot ->> 'country', ''), public._comms_country(v_org)))
                when 'AE' then '971' when 'US' then '1' else '91' end;
    v_e164 := public._wa151_e164(q.client ->> 'phone', v_dial);
    if v_e164 is null then raise exception 'Add the client''s mobile number to the event first.' using errcode = 'P0001', hint = 'no_phone'; end if;
    v_to := substr(v_e164, 2);
    if public._wa_opted_out(v_to, v_org) then
      raise exception 'This number replied STOP to WhatsApp messages - send the nudge by e-mail.' using errcode = 'HL451'; end if;
    if not coalesce((select o.opted_in from public.wa_proposal_optins o where o.quote_id = q.id and o.phone_e164 = v_e164
                      order by o.recorded_at desc, o.id desc limit 1), false) then
      raise exception 'The client has not agreed to WhatsApp messages yet - send the nudge by e-mail.' using errcode = 'P0001', hint = 'opt_in'; end if;
    if coalesce(v_cfg ->> 'studio_whatsapp', '') !~ '^[0-9]{8,15}$' then
      raise exception 'WhatsApp sending is not set up for your studio yet - use e-mail.' using errcode = 'P0001', hint = 'wa_not_setup'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('helm:lv261-nudge:' || q.id::text, 0));
  select count(*) into v_n from public.comms_outbox c
   where c.quote_id = q.id and c.purpose = 'follow_up' and c.payload ->> 'r23' = 'nudge' and c.created_at > now() - interval '1 day';
  if v_n >= 3 then raise exception 'This client was nudged 3 times today - try again tomorrow.' using errcode = 'HL429'; end if;
  select count(*) into v_n from public.comms_outbox c
   where c.org_id = v_org and c.purpose = 'follow_up' and c.payload ->> 'r23' = 'nudge' and c.created_at > now() - interval '1 hour';
  if v_n >= 60 then raise exception 'Sending limit reached for your studio - try again in an hour.' using errcode = 'HL429'; end if;

  select left(regexp_replace(btrim(coalesce(o.name, '')), '\s+', ' ', 'g'), 60) into v_studio from public.organizations o where o.id = v_org;
  v_studio := coalesce(nullif(v_studio, ''), 'your event planner');
  v_text := public._comms_render(v_cfg ->> 'fu_template', jsonb_build_object(
    'client', coalesce(nullif(left(btrim(coalesce(q.client ->> 'name', '')), 60), ''), 'there'), 'studio', v_studio,
    'event', coalesce(nullif(btrim(q.title), ''), 'your event')));
  v_blocked := public._sample_outbound_blocked(v_org, v_to);
  v_reason := case when v_blocked then 'free_trial' when coalesce(q.is_demo, false) then 'demo' end;
  select f.id into v_fu from public.client_view_followups f where f.quote_id = q.id and f.org_id = v_org and f.status = 'open';
  -- double tap: the same channel within 10 minutes is not queued again
  v_key := 'fu:nudge:' || q.id || ':' || p_channel || ':' || floor(extract(epoch from now()) / 600)::bigint;
  insert into public.comms_outbox(org_id, quote_id, purpose, channel, recipient, payload, dedupe_key, created_by, status)
    values (v_org, q.id, 'follow_up', p_channel, v_to,
            jsonb_build_object('subject', 'Following up - ' || coalesce(nullif(btrim(q.title), ''), 'your event'),
                               'text', v_text, 'stage', 'nudge', 'manual', true, 'studio', v_studio, 'r23', 'nudge', 'followup_id', v_fu),
            v_key, v_uid, case when v_reason = 'demo' then 'skipped' else 'pending' end)
    on conflict (dedupe_key) do nothing
    returning id, status into v_id, v_status;
  if v_id is null then
    return jsonb_build_object('status', 'already_queued', 'channel', p_channel, 'masked', public._lv261_mask(p_channel, v_to));
  end if;
  if v_status = 'skipped' then
    v_reason := coalesce(v_reason, 'not_sent');
    update public.comms_outbox set sent_at = now() where id = v_id and sent_at is null;   -- finished (never handed out)
  end if;
  update public.client_view_followups set status = 'nudged', nudge_channel = p_channel, closed_by = v_uid, closed_at = now()
   where id = v_fu and status = 'open';
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, 'link_views.nudge', 'client_view_followups', coalesce(v_fu::text, q.id::text), q.id,
            jsonb_build_object('channel', p_channel, 'to', public._lv261_mask(p_channel, v_to),
                               'status', case when v_status = 'skipped' then 'skipped' else 'queued' end, 'reason', v_reason), v_org);
  return jsonb_build_object('status', case when v_status = 'skipped' then 'skipped' else 'queued' end, 'reason', v_reason,
                            'channel', p_channel, 'masked', public._lv261_mask(p_channel, v_to), 'id', v_id);
end $$;

create or replace function public.link_view_followup_dismiss(p_followup uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: "Dismiss" - the row is kept (status dismissed, who / when)
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); f record;
begin
  if v_uid is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  select x.id, x.quote_id, x.status into f from public.client_view_followups x where x.id = p_followup and x.org_id = v_org for update;
  if f.id is null then raise exception 'not authorized for this follow-up' using errcode = '42501'; end if;
  if f.status <> 'open' then return jsonb_build_object('id', f.id, 'status', f.status); end if;
  update public.client_view_followups set status = 'dismissed', closed_by = v_uid, closed_at = now() where id = f.id;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_uid, 'link_views.dismiss', 'client_view_followups', f.id::text, f.quote_id, '{}'::jsonb, v_org);
  return jsonb_build_object('id', f.id, 'status', 'dismissed');
end $$;

-- ---- 7) Control Center ---------------------------------------------------------------------------------------------
create or replace function public.link_view_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-link-views-0261: + the existing automatic follow-up switch (0078 comms_settings) as "auto-nudge"
declare v_org uuid := public.current_org_id(); c jsonb;
begin
  if auth.uid() is null or v_org is null or not (public.has_area('quotes', 'view') or public.has_area('controls', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  c := public._comms_cfg(v_org);
  return public._lv261_cfg(v_org) || jsonb_build_object(
    'can_edit', public.has_area('controls', 'edit'),
    'auto_nudge', jsonb_build_object('enabled', coalesce((c ->> 'fu_enabled')::boolean, false),
                                     'delay_days', (c ->> 'fu_delay_days')::int, 'max', (c ->> 'fu_max')::int,
                                     'channels', coalesce(c -> 'fu_channels', '[]'::jsonb)));
end $$;

create or replace function public.link_view_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: Control Center EDIT only; unknown keys refused; every value checked
declare v_org uuid := public.current_org_id(); v_uid uuid := auth.uid(); k text;
begin
  if v_uid is null or v_org is null or not public.has_area('controls', 'edit') then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('track_enabled', 'bell_first', 'bell_repeat', 'repeat_hours', 'followup_enabled', 'followup_days') then
      raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  foreach k in array array['track_enabled', 'bell_first', 'bell_repeat', 'followup_enabled'] loop
    if p ? k and jsonb_typeof(p -> k) <> 'boolean' then raise exception '% must be true or false', k using errcode = '22023'; end if;
  end loop;
  if p ? 'repeat_hours' and (jsonb_typeof(p -> 'repeat_hours') <> 'number' or (p ->> 'repeat_hours')::numeric not between 1 and 168
                             or (p ->> 'repeat_hours')::numeric <> round((p ->> 'repeat_hours')::numeric)) then
    raise exception 'Re-open alerts: choose 1 to 168 hours.' using errcode = '22023'; end if;
  if p ? 'followup_days' and (jsonb_typeof(p -> 'followup_days') <> 'number' or (p ->> 'followup_days')::numeric not between 1 and 30
                              or (p ->> 'followup_days')::numeric <> round((p ->> 'followup_days')::numeric)) then
    raise exception 'Viewed-not-approved: choose 1 to 30 days.' using errcode = '22023'; end if;
  insert into public.client_view_settings(org_id, updated_by, updated_at) values (v_org, v_uid, now()) on conflict (org_id) do nothing;
  update public.client_view_settings s set
    track_enabled    = case when p ? 'track_enabled' then (p ->> 'track_enabled')::boolean else s.track_enabled end,
    bell_first       = case when p ? 'bell_first' then (p ->> 'bell_first')::boolean else s.bell_first end,
    bell_repeat      = case when p ? 'bell_repeat' then (p ->> 'bell_repeat')::boolean else s.bell_repeat end,
    repeat_hours     = case when p ? 'repeat_hours' then (p ->> 'repeat_hours')::numeric::int else s.repeat_hours end,
    followup_enabled = case when p ? 'followup_enabled' then (p ->> 'followup_enabled')::boolean else s.followup_enabled end,
    followup_days    = case when p ? 'followup_days' then (p ->> 'followup_days')::numeric::int else s.followup_days end,
    updated_by = v_uid, updated_at = now()
   where s.org_id = v_org;
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (v_uid, 'link_views.settings', 'client_view_settings', v_org::text, p, v_org);
  return public.link_view_settings_get();
end $$;

-- ---- 8) dispatcher claim: nudge rows first (re-checked), then the previous claim -----------------------------------
do $$ begin
  if to_regprocedure('public.comms_outbox_claim__pre0261(integer)') is null then
    alter function public.comms_outbox_claim(integer) rename to comms_outbox_claim__pre0261;
  end if;
end $$;

create or replace function public.comms_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- r23-link-views-0261: "Send a nudge" rows (follow_up + payload r23 = nudge) are handed out here even when the
-- automatic follow-ups are off; re-checked (still waiting, not demo, not a trial, WhatsApp STOP + studio number)
declare r record; v_lim integer := greatest(1, least(coalesce(p_limit, 25), 100)); v_n integer := 0; v_out jsonb := '[]'::jsonb;
        v_ok boolean; v_cfg jsonb;
begin
  update public.comms_outbox set status = 'failed', sent_at = now()
   where purpose = 'follow_up' and payload ->> 'r23' = 'nudge' and sent_at is null and attempts >= 5;
  update public.comms_outbox set status = 'skipped', sent_at = now()
   where purpose = 'follow_up' and payload ->> 'r23' = 'nudge' and sent_at is null and created_at < now() - interval '3 days';
  for r in select c.* from public.comms_outbox c
     where c.purpose = 'follow_up' and c.payload ->> 'r23' = 'nudge' and c.sent_at is null and c.status = 'pending'
       and (c.claimed_at is null or c.claimed_at < now() - interval '10 minutes')
     order by c.created_at limit v_lim for update skip locked
  loop
    v_ok := public._lv261_waiting(r.quote_id)
            and exists (select 1 from public.quotes q where q.id = r.quote_id and q.org_id = r.org_id and not coalesce(q.is_demo, false))
            and not public._tr212_claim_blocked(r.org_id, r.recipient, r.purpose, r.channel, r.payload);   -- 0212: free trial / sample
    if v_ok and r.channel = 'whatsapp' then
      v_cfg := public._comms_cfg(r.org_id);
      v_ok := coalesce(v_cfg ->> 'studio_whatsapp', '') ~ '^[0-9]{8,15}$' and not public._wa_opted_out(r.recipient, r.org_id);
    end if;
    if not coalesce(v_ok, false) then
      update public.comms_outbox set status = 'skipped', sent_at = now() where id = r.id;
      continue;
    end if;
    update public.comms_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'purpose', r.purpose, 'channel', r.channel,
      'to', r.recipient, 'payload', r.payload));
    v_n := v_n + 1;
  end loop;
  if v_n < v_lim then
    v_out := v_out || coalesce(public.comms_outbox_claim__pre0261(v_lim - v_n), '[]'::jsonb);
  end if;
  return v_out;
end $$;

-- ---- 9) notification catalog: 2 new types (rename once + wrap) ------------------------------------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['notification_catalog', ''],
    ['notification_type_of', 'text, text'],
    ['notify_default', 'uuid, text, text, text']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0261', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0261');
    end if;
  end loop;
end $$;

create or replace function public.notification_catalog()
returns jsonb language sql immutable security definer set search_path = '' as $$
  -- r23-link-views-0261: + client opened their link / viewed but not approved (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'client_link_viewed') then c
    else c || $cat$[
    {"type":"client_link_viewed","group":"Sales","label":"Client opened their link",
     "description":"Your client opened their proposal, quotation or booklet for the first time (and, if switched on in Control Center, later visits). Shown to roles with Quotes access.",
     "audience":"staff","channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"client_view_followup","group":"Sales","label":"Viewed but not approved",
     "description":"A client opened their link some days ago and has not approved yet - the quote's owner and the admins get a reminder with a one-tap Send a nudge.",
     "audience":"staff","channels":["in_app"],"required":[],"gated":[],"money":false}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0261() as c) x;
$$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable security definer set search_path = '' as $$
  -- r23-link-views-0261
  select case when lower(btrim(coalesce(p_kind, ''))) in ('client_link_viewed', 'client_view_followup')
              then lower(btrim(p_kind))
              else public.notification_type_of__pre0261(p_kind, p_channel) end;
$$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- r23-link-views-0261: both new types -> admin + roles with Quotes view
  select case
    when p_type in ('client_link_viewed', 'client_view_followup') then
      coalesce(p_role = 'admin', false) or coalesce(p_role = '*', false)
      or exists (select 1 from public.role_access ra where ra.org_id = p_org and ra.role = p_role and ra.can_view and ra.area = 'quotes')
    else public.notify_default__pre0261(p_org, p_role, p_type, p_channel) end;
$$;

-- ---- 10) bell: Quotes viewers only; the follow-up only for the owner + admins -------------------------------------
do $$ begin
  if to_regprocedure('public.bell_feed__pre0261(integer)') is null then
    alter function public.bell_feed(integer) rename to bell_feed__pre0261;
  end if;
end $$;
create or replace function public.bell_feed(p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-link-views-0261: client_link_viewed -> Quotes viewers; client_view_followup -> the owner + admins (or every
-- Quotes viewer when the quote has no owner)
declare v jsonb; v_drop integer; v_quotes boolean; v_admin boolean; v_me text := coalesce(auth.uid()::text, '');
begin
  v := public.bell_feed__pre0261(p_limit);
  if v is null or jsonb_typeof(v -> 'items') <> 'array' then return v; end if;
  v_admin := coalesce(public.user_role(), '') = 'admin';
  if v_admin then return v; end if;
  v_quotes := public.has_area('quotes', 'view');
  return (with e as (
      select i, ord, coalesce(i ->> 'kind', '') as k,
             case when jsonb_typeof(i -> 'detail' -> 'notify') = 'array' then i -> 'detail' -> 'notify' else '[]'::jsonb end as nt
        from jsonb_array_elements(v -> 'items') with ordinality x(i, ord)),
    m as (select e.*, (e.k in ('client_link_viewed', 'client_view_followup')
                       and (not v_quotes or (e.k = 'client_view_followup' and jsonb_array_length(e.nt) > 0 and not (e.nt ? v_me)))) as hide
            from e)
    select v || jsonb_build_object(
      'items', coalesce((select jsonb_agg(m.i order by m.ord) from m where not m.hide), '[]'::jsonb),
      'unread', greatest(coalesce((v ->> 'unread')::integer, 0)
                         - (select count(*) from m where m.hide and coalesce((m.i ->> 'unread')::boolean, false))::integer, 0)));
end $$;

-- ---- 11) activity trail ----------------------------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.event_activity__pre0261(uuid)') is null then
    alter function public.event_activity(uuid) rename to event_activity__pre0261;
  end if;
end $$;
create or replace function public.event_activity(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
-- r23-link-views-0261: + "Client opened the booklet (Mobile - Android)" per visit, follow-ups (Quotes viewers);
-- the raw client_link_viewed / client_view_followup bell rows are left out
declare v jsonb; v_org uuid := public.current_org_id(); v_add jsonb := '[]'::jsonb;
begin
  v := public.event_activity__pre0261(p_quote);
  if jsonb_typeof(v) <> 'array' then return v; end if;
  v := coalesce((select jsonb_agg(e.i order by e.ord) from jsonb_array_elements(v) with ordinality e(i, ord)
                  where not (coalesce(e.i ->> 'kind', '') = 'notify'
                             and (coalesce(e.i ->> 'text', '') like 'client\_link\_viewed%' or coalesce(e.i ->> 'text', '') like 'client\_view\_followup%'))), '[]'::jsonb);
  if v_org is not null and public.has_area('quotes', 'view') then
    select coalesce(jsonb_agg(x.a), '[]'::jsonb) into v_add from (
      select jsonb_build_object('at', min(c.created_at), 'kind', 'link_view',
               'text', 'Client opened ' || public._lv261_page_label((array_agg(c.page order by c.created_at))[1])
                       || case when count(*) > 1 then ' (+' || (count(*) - 1) || ' more page' || case when count(*) > 2 then 's' else '' end || ')' else '' end
                       || ' - ' || initcap((array_agg(c.device order by c.created_at))[1])
                       || coalesce(' - ' || (array_agg(c.os order by c.created_at))[1], '')
                       || case when min(c.visit_no) = 1 then ' (first open)' else ' (visit ' || min(c.visit_no) || ')' end) as a
        from (select * from public.client_link_views w where w.quote_id = p_quote and w.org_id = v_org
               order by w.created_at desc limit 300) c
       group by c.visit_no
      union all
      select jsonb_build_object('at', f.created_at, 'kind', 'link_followup',
               'text', 'Viewed but not approved - follow-up for ' || coalesce(public._sa54_name(f.owner_id), 'the team')
                       || case f.status when 'nudged' then ' (nudge sent by ' || coalesce(public._sa54_name(f.closed_by), 'someone')
                                                          || coalesce(' by ' || f.nudge_channel, '') || ')'
                                        when 'dismissed' then ' (dismissed by ' || coalesce(public._sa54_name(f.closed_by), 'someone') || ')'
                                        when 'resolved' then ' (client approved / event moved on)' else '' end)
        from public.client_view_followups f where f.quote_id = p_quote and f.org_id = v_org) x;
  end if;
  if jsonb_array_length(v_add) = 0 then return v; end if;
  return (select jsonb_agg(a order by a ->> 'at' desc) from jsonb_array_elements(v || v_add) a);
end $$;

-- ---- 12) grants ---------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal: never callable by the API roles
  foreach f in array array['_lv261_cfg(uuid)', '_lv261_device(text)', '_lv261_is_bot(text)', '_lv261_req()', '_lv261_owner(uuid)',
                           '_lv261_page_label(text)', '_lv261_mask(text, text)', '_lv261_waiting(uuid)', '_lv261_sweep(uuid)',
                           'link_views_tick()', 'comms_outbox_claim(integer)', 'comms_outbox_claim__pre0261(integer)',
                           'notification_catalog__pre0261()', 'notification_type_of__pre0261(text, text)',
                           'notify_default(uuid, text, text, text)', 'notify_default__pre0261(uuid, text, text, text)',
                           'bell_feed__pre0261(integer)', 'event_activity__pre0261(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.' || f || ' from authenticated'; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach f in array array['link_views_tick()', 'comms_outbox_claim(integer)', 'comms_outbox_claim__pre0261(integer)',
                             '_lv261_sweep(uuid)'] loop
      execute 'grant execute on function public.' || f || ' to service_role';
    end loop;
  end if;
  -- signed-in studio members (each checks studio + area itself)
  foreach f in array array['link_views_summary(uuid[])', 'link_views_timeline(uuid)', 'link_views_attention()',
                           'link_view_nudge(uuid, text)', 'link_view_followup_dismiss(uuid)',
                           'link_view_settings_get()', 'link_view_settings_set(jsonb)',
                           'bell_feed(integer)', 'event_activity(uuid)', 'notification_catalog()', 'notification_type_of(text, text)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.' || f || ' from anon'; end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.' || f || ' to authenticated'; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant execute on function public.' || f || ' to service_role'; end if;
  end loop;
  -- the signed-out client pages
  execute 'revoke all on function public.public_link_viewed(text, uuid, boolean) from public';
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'grant execute on function public.public_link_viewed(text, uuid, boolean) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'grant execute on function public.public_link_viewed(text, uuid, boolean) to authenticated'; end if;
end $$;

-- ---- 13) pg_cron, ONLY if it is already installed (never created here) -----------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_link_views_tick') then
        perform cron.schedule('helm_link_views_tick', '*/30 * * * *', 'select public.link_views_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_link_views_tick could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
