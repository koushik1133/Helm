-- ============================================================================
-- HELM - 0069 package flow + booklet share checklist (one paste) (2026-10-08)
--   * Clients pick a menu package + guest count from their private booklet; staff with
--     the new Package review area accept (maker-checker) or decline; the event is
--     re-priced by the server; payments are credited; overpay = credit or refund due.
--   * Booklet share checklist: hidden sections are removed server-side; 2D / 3D
--     snapshots in the private bucket booklet-snapshots.
-- REQUIRES 0050, 0045, 0052, 0063, 0065 - the preflight stops if not.
-- Order note: apply after 0068 (0067 lands above 0068 when it exists).
-- WHAT IT TOUCHES: 5 new tables, 6 new nullable columns (menu_templates x3,
-- client_booklets x3 incl. sections with an all-shown default), 1 bucket, new functions,
-- policies and triggers; 4 functions wrapped (renamed once to *__pre0069), the upload
-- name guard extended in place. NO row is deleted. SAFE TO RE-RUN.
-- Plain ASCII on purpose (the SQL editor mangles fancy characters).
-- ============================================================================
-- ============================================================================
-- 0069_package_flow.sql - CANONICAL forward-only. Client package selection from
-- the private booklet, staff review (maker-checker), re-pricing through the
-- server pricing authority, payment credit / overpay handling, notifications and
-- a dormant outbox for client + staff messages.
-- REQUIRES 0050 (rate_hit), 0045 (tg_studio_read_only), 0052 (re-approval),
-- 0063 (notification_mutes), 0065 (client_booklets) - the preflight stops if missing.
--
-- In plain words:
--   * menu_templates (Control Center menu packages) gain 3 OPTIONAL columns:
--     description, min_guests, max_guests (null = no limit). Nothing else changes.
--   * pkg_settings - one row per studio: pkg_require_otp (false), pkg_client_channel
--     ('email'), overpay_mode ('credit'), pkg_lock_days (0). Missing row = defaults.
--   * package_selections - what the client picked (package, guests, note). Status
--     pending -> accepted | declined; a newer pending choice supersedes the older one
--     (placeholder rule, may become configurable later); cancelled is reserved.
--     RLS: staff of the same studio with has_area('pkg_review','view') read; nobody
--     writes directly - only the functions below.
--   * Client (signed out, booklet token): public_booklet_packages, public_booklet_choose,
--     public_booklet_otp_request. Token-gated (invalid / expired / revoked / deleted
--     event = "invalid link"), rate-limited (rate_hit), audited (audit_log).
--   * The draft price is computed by helm_quote_total (D8 pricing authority) from the
--     package per-person price x guests on top of the event's own pricing. Client
--     prices are never read.
--   * Staff: pkg_selection_list, pkg_selection_review (accept / decline). Whoever
--     adjusted a draft cannot approve it (maker-checker); the only exception is a
--     studio with exactly ONE admin, logged as pkg.self_approve_override.
--     On accept: the event pricing becomes the draft (re-approval is flagged by 0052
--     when the client had approved), open unpaid payment links are cancelled, a live
--     approval link is ensured, paid money is credited; if the new total is below what
--     was paid the difference is recorded in pkg_credits as 'credit' or 'refund_due'
--     (overpay_mode). Never an automatic refund.
--   * Areas pkg_review / pkg_payments: no role_access rows are seeded (D2: the matrix
--     is the sole authority; admin passes has_area by design).
--   * Notification types pkg_selected / pkg_accepted / pkg_declined / pkg_payment are
--     added to the catalog (bell visible only to roles with the area view).
--   * pkg_outbox - queued client e-mail / WhatsApp and staff WhatsApp messages for the
--     dormant edge function pkg-client-notify (service-role claim / mark only).
--   * Suspended studios: read-only (zzz_studio_read_only on every new table).
--
-- Additive + idempotent: new tables (RLS on), 3 nullable columns, new functions and
-- triggers. notification_catalog / notification_type_of / notify_default are renamed
-- ONCE to *__pre0069 and wrapped. NO existing row is deleted; existing rows change
-- only through the explicit workflow steps above.
-- ============================================================================

do $$ begin
  if to_regprocedure('public.has_area(text,text)') is null then raise exception '0069: has_area() is not installed'; end if;
  if to_regprocedure('public.current_org_id()') is null then raise exception '0069: current_org_id() is not installed'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception '0069: 0050 (rate_hit) is not installed'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then raise exception '0069: 0045 (tg_studio_read_only) is not installed'; end if;
  if to_regprocedure('public.helm_quote_total(jsonb)') is null then raise exception '0069: helm_quote_total() is not installed'; end if;
  if to_regprocedure('public._a52_has_consent(uuid)') is null then raise exception '0069: 0052 (re-approval) is not installed'; end if;
  if to_regclass('public.client_booklets') is null then raise exception '0069: 0065 (client_booklets) is not installed'; end if;
  if to_regclass('public.notification_mutes') is null then raise exception '0069: 0063 (notification_mutes) is not installed'; end if;
  if to_regprocedure('public.notification_catalog()') is null then raise exception '0069: notification_catalog() is not installed'; end if;
end $$;

-- ---- 1) package details (optional) ----------------------------------------------------
alter table public.menu_templates add column if not exists description text;
alter table public.menu_templates add column if not exists min_guests integer;
alter table public.menu_templates add column if not exists max_guests integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'menu_templates_pkg_guests_chk') then
    alter table public.menu_templates add constraint menu_templates_pkg_guests_chk check (
      (min_guests is null or min_guests between 1 and 100000) and (max_guests is null or max_guests between 1 and 100000)
      and (min_guests is null or max_guests is null or min_guests <= max_guests)
      and (description is null or char_length(description) <= 2000)) not valid;
  end if;
end $$;

-- ---- 2) studio settings ------------------------------------------------------------
create table if not exists public.pkg_settings (
  org_id             uuid primary key references public.organizations(id) on delete cascade,
  pkg_require_otp    boolean not null default false,
  pkg_client_channel text    not null default 'email' check (pkg_client_channel in ('whatsapp', 'email', 'both')),
  overpay_mode       text    not null default 'credit' check (overpay_mode in ('credit', 'manual_refund')),
  pkg_lock_days      integer not null default 0 check (pkg_lock_days between 0 and 365),
  updated_at         timestamptz not null default now(),
  updated_by         uuid
);

-- ---- 3) selections ------------------------------------------------------------------
create table if not exists public.package_selections (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  quote_id         uuid not null references public.quotes(id) on delete cascade,
  booklet_id       uuid references public.client_booklets(id) on delete set null,
  package_id       uuid not null references public.menu_templates(id) on delete restrict,
  guests           integer not null check (guests between 1 and 100000),
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'superseded', 'cancelled')),
  client_note      text check (client_note is null or char_length(client_note) <= 1000),
  decline_reason   text check (decline_reason is null or char_length(decline_reason) <= 500),
  draft_version_id uuid references public.quotation_versions(id) on delete set null,
  created_by_client boolean not null default true,
  reviewed_by      uuid,
  reviewed_at      timestamptz,
  otp_verified     boolean not null default false,
  ip_hash          text,
  ua               text check (ua is null or char_length(ua) <= 300),
  created_at       timestamptz not null default now(),
  -- additive extras (not in the client contract)
  per_person       numeric,
  draft_total      numeric,
  price_override   numeric,
  drafted_by       uuid,
  updated_at       timestamptz not null default now()
);
create index if not exists package_selections_quote_idx on public.package_selections(quote_id, created_at desc);
create unique index if not exists package_selections_one_pending on public.package_selections(quote_id) where status = 'pending';

-- ---- 4) client credits / refunds due ------------------------------------------------
create table if not exists public.pkg_credits (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  selection_id uuid references public.package_selections(id) on delete set null,
  kind         text not null check (kind in ('credit', 'refund_due')),
  amount       numeric not null check (amount > 0 and amount < 1e12),
  status       text not null default 'open' check (status in ('open', 'applied', 'refunded', 'void')),
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists pkg_credits_quote_idx on public.pkg_credits(quote_id);

-- ---- 5) OTP codes for the booklet ---------------------------------------------------
create table if not exists public.pkg_otps (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  booklet_id  uuid not null references public.client_booklets(id) on delete cascade,
  code_hash   text not null,
  channel     text not null check (channel in ('whatsapp', 'email')),
  attempts    integer not null default 0,
  expires_at  timestamptz not null default (now() + interval '10 minutes'),
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pkg_otps_booklet_idx on public.pkg_otps(booklet_id, created_at desc);

-- ---- 6) outbox (dormant edge function pkg-client-notify) ------------------------------
create table if not exists public.pkg_outbox (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  quote_id     uuid references public.quotes(id) on delete cascade,
  selection_id uuid references public.package_selections(id) on delete set null,
  audience     text not null check (audience in ('client', 'staff')),
  channel      text not null check (channel in ('whatsapp', 'email')),
  kind         text not null check (kind ~ '^[a-z_]{1,40}$'),
  recipient    text,
  user_id      uuid,
  payload      jsonb not null default '{}'::jsonb,
  dedupe_key   text not null,
  status       text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  attempts     integer not null default 0,
  claimed_at   timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists pkg_outbox_dedupe_key on public.pkg_outbox(dedupe_key);
create index if not exists pkg_outbox_pending_idx on public.pkg_outbox(created_at) where sent_at is null;

-- ---- 7) RLS, grants, guards ------------------------------------------------------------
alter table public.pkg_settings enable row level security;
alter table public.package_selections enable row level security;
alter table public.pkg_credits enable row level security;
alter table public.pkg_otps enable row level security;
alter table public.pkg_outbox enable row level security;
do $$ declare t text; begin
  foreach t in array array['pkg_settings', 'package_selections', 'pkg_credits', 'pkg_otps', 'pkg_outbox'] loop
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    execute format('drop trigger if exists zzz_studio_read_only on public.%I', t);
    execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select on table public.package_selections to authenticated;
    grant select on table public.pkg_settings to authenticated;
    grant select on table public.pkg_credits to authenticated;
  end if;
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    foreach t in array array['package_selections', 'pkg_credits', 'pkg_otps', 'pkg_outbox'] loop
      execute format('drop trigger if exists zz_quote_org_match on public.%I', t);
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end loop;
  end if;
end $$;
drop policy if exists pkg_selections_read on public.package_selections;
create policy pkg_selections_read on public.package_selections for select to authenticated
  using (org_id = (select public.current_org_id()) and public.has_area('pkg_review', 'view'));
drop policy if exists pkg_settings_read on public.pkg_settings;
create policy pkg_settings_read on public.pkg_settings for select to authenticated
  using (org_id = (select public.current_org_id()) and (public.has_area('controls', 'view') or public.has_area('pkg_review', 'view')));
drop policy if exists pkg_credits_read on public.pkg_credits;
create policy pkg_credits_read on public.pkg_credits for select to authenticated
  using (org_id = (select public.current_org_id()) and (public.has_area('pkg_payments', 'view') or public.has_area('finance', 'view')));

-- ---- 8) notification catalog: 4 new types (rename once + wrap) -------------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['notification_catalog', ''],
    ['notification_type_of', 'text, text'],
    ['notify_default', 'uuid, text, text, text']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0069', f[2])) is null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0069');
    end if;
    execute format('revoke all on function public.%I(%s) from public', f[1] || '__pre0069', f[2]);
  end loop;
end $$;

create or replace function public.notification_catalog()
returns jsonb language sql immutable set search_path = '' as $$
  -- package-flow-0069: the database's own catalog + the 4 package types (once)
  select case when exists (select 1 from jsonb_array_elements(c) e where e ->> 'type' = 'pkg_selected') then c
    else c || $cat$[
    {"type":"pkg_selected","group":"Sales","label":"Client picked a package",
     "description":"A client chose a menu package and guest count from their booklet. Shown to roles with Package review access.",
     "audience":"staff","channels":["in_app","whatsapp"],"required":[],"gated":["whatsapp"],"money":false},
    {"type":"pkg_accepted","group":"Sales","label":"Package accepted",
     "description":"A reviewer accepted a client's package choice; the updated quote was sent to the client.",
     "audience":"staff","channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"pkg_declined","group":"Sales","label":"Package declined",
     "description":"A reviewer declined a client's package choice (with a reason).",
     "audience":"staff","channels":["in_app"],"required":[],"gated":[],"money":false},
    {"type":"pkg_payment","group":"Finance","label":"Package payment received",
     "description":"A payment was received on an event priced from a client package. Shown to roles with Package payments access.",
     "audience":"staff","channels":["in_app","whatsapp"],"required":[],"gated":["whatsapp"],"money":true}
  ]$cat$::jsonb end
  from (select public.notification_catalog__pre0069() as c) x;
$$;

create or replace function public.notification_type_of(p_kind text, p_channel text default null)
returns text language sql immutable set search_path = '' as $$
  select case when lower(btrim(coalesce(p_kind, ''))) in ('pkg_selected', 'pkg_accepted', 'pkg_declined', 'pkg_payment')
              then lower(btrim(p_kind))
              else public.notification_type_of__pre0069(p_kind, p_channel) end;
$$;

create or replace function public.notify_default(p_org uuid, p_role text, p_type text, p_channel text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- package-flow-0069: package types reach admin + roles with the area VIEW in the matrix
  select case
    when p_type in ('pkg_selected', 'pkg_accepted', 'pkg_declined', 'pkg_payment') then
      coalesce(p_role = 'admin', false) or coalesce(p_role = '*', false)
      or exists (select 1 from public.role_access ra where ra.org_id = p_org and ra.role = p_role and ra.can_view
                   and ra.area = case when p_type = 'pkg_payment' then 'pkg_payments' else 'pkg_review' end)
    else public.notify_default__pre0069(p_org, p_role, p_type, p_channel) end;
$$;

-- ---- 9) helpers (internal) -------------------------------------------------------------
create or replace function public._pkg_settings(p_org uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pkg_require_otp', coalesce(s.pkg_require_otp, false),
    'pkg_client_channel', coalesce(s.pkg_client_channel, 'email'),
    'overpay_mode', coalesce(s.overpay_mode, 'credit'),
    'pkg_lock_days', coalesce(s.pkg_lock_days, 0))
  from (select 1) one left join public.pkg_settings s on s.org_id = p_org;
$$;

-- paid = the settlement "Received" rule: the ledger when the event has ledger rows, else paid milestones
create or replace function public._pkg_paid(p_quote uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select round(coalesce(case when exists (select 1 from public.quote_payments pm where pm.quote_id = p_quote)
    then (select sum(pm.amount) from public.quote_payments pm where pm.quote_id = p_quote and pm.status = 'paid')
    else (select sum(m.amount) from public.payment_milestones m where m.quote_id = p_quote and m.status = 'paid') end, 0), 2);
$$;

create or replace function public._pkg_total(p jsonb)
returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 0; end if;
  return round(coalesce((p ->> 'total')::numeric, 0), 2);
exception when others then return 0;
end $$;

-- null = open; else the reason the selection is locked
create or replace function public._pkg_lock_reason(p_quote uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare q public.quotes; v_days int; v_closed boolean := false; v_menu boolean := false;
begin
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null or q.deleted_at is not null or q.archived_at is not null then return 'unavailable'; end if;
  if not public._studio_writable(q.org_id) then return 'suspended'; end if;
  if to_regclass('public.event_closure') is not null then
    select exists (select 1 from public.event_closure c where c.quote_id = q.id and c.closed_at is not null) into v_closed;
  end if;
  if v_closed or q.lifecycle_stage in ('settlement', 'closed') then return 'frozen'; end if;   -- D6: closed event money is frozen
  if q.confirmed_at is not null or q.status = 'confirmed'
     or q.lifecycle_stage in ('planning', 'resources', 'ready', 'event_day') then return 'confirmed'; end if;
  select coalesce(ep.menu_locked, false) into v_menu from public.event_plan ep where ep.quote_id = q.id;
  if coalesce(v_menu, false) then return 'menu_locked'; end if;
  v_days := coalesce((public._pkg_settings(q.org_id) ->> 'pkg_lock_days')::int, 0);
  if q.event_date is not null and current_date > q.event_date - v_days then return 'too_close'; end if;
  return null;
end $$;

-- the booklet behind a token (or 'invalid link'); rate-limited per token
create or replace function public._pkg_booklet(p_token uuid, p_bucket text, p_max int)
returns public.client_booklets language plpgsql volatile security definer set search_path = '' as $$
declare b public.client_booklets; v_wait int;
begin
  if p_token is null then raise exception 'invalid link' using errcode = 'P0001'; end if;
  v_wait := public.rate_hit(p_bucket, md5('pkg:' || p_token::text), 600, p_max);
  if v_wait > 0 then raise exception 'too many requests - try again in % seconds', v_wait using errcode = 'P0001', hint = 'rate_limited'; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now()
     or not exists (select 1 from public.quotes q where q.id = b.quote_id and q.org_id = b.org_id and q.deleted_at is null) then
    raise exception 'invalid link' using errcode = 'P0001';
  end if;
  return b;
end $$;

create or replace function public._pkg_req_meta()
returns jsonb language plpgsql stable set search_path = '' as $$
declare h jsonb; v_ip text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then h := null; end;
  v_ip := btrim(split_part(coalesce(h ->> 'x-forwarded-for', h ->> 'x-real-ip', ''), ',', 1));
  return jsonb_build_object('ip_hash', case when v_ip <> '' then md5('helm-pkg:' || left(v_ip, 64)) end,
                            'ua', nullif(left(coalesce(h ->> 'user-agent', ''), 300), ''));
end $$;

-- server-side draft price: the event's pricing + package per-person x guests (D8 authority)
create or replace function public._pkg_price(p_pricing jsonb, p_per_person numeric, p_guests int)
returns jsonb language plpgsql stable set search_path = '' as $$
declare p jsonb; v_gst numeric;
begin
  p := case when jsonb_typeof(p_pricing) = 'object' then p_pricing else '{}'::jsonb end;
  begin v_gst := (p ->> 'gstPct')::numeric; exception when others then v_gst := null; end;
  p := p - 'subtotal' - 'computed' - 'total';
  if jsonb_typeof(p -> 'catering') = 'object' then p := jsonb_set(p, '{catering,mode}', '"inhouse"'::jsonb); end if;
  p := p || jsonb_build_object('guests', p_guests, 'platePrice', round(p_per_person, 2), 'gstPct', coalesce(v_gst, 18));
  return p || jsonb_build_object('total', public.helm_quote_total(p));
end $$;

-- bell row + staff WhatsApp (permitted roles, not muted, number on file); never raises
create or replace function public._pkg_notify(p_quote uuid, p_kind text, p_detail jsonb, p_dedupe text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare q public.quotes; r record; v_area text := case when p_kind = 'pkg_payment' then 'pkg_payments' else 'pkg_review' end;
begin
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null then return; end if;
  begin
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (q.id, 'in_app', p_kind, 'simulated', coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('quote_id', q.id, 'code', q.code), q.org_id);
  exception when others then raise warning 'pkg-0069: bell row skipped (%)', sqlstate;
  end;
  if p_kind not in ('pkg_selected', 'pkg_payment') then return; end if;
  for r in
    select p.id, p.role, coalesce(nullif(btrim(mp.whatsapp), ''), case when mp.whatsapp_same then nullif(btrim(mp.phone), '') end) as wa
      from public.profiles p left join public.member_profiles mp on mp.user_id = p.id
     where p.org_id = q.org_id and coalesce(p.role, 'client') <> 'client'
       and (p.role = 'admin' or exists (select 1 from public.role_access ra where ra.org_id = q.org_id and ra.role = p.role and ra.area = v_area and ra.can_view))
       and not exists (select 1 from public.notification_mutes m where m.user_id = p.id and m.org_id = q.org_id and m.type = p_kind)
       and public.notify_allowed_user(q.org_id, p.id, p_kind, 'in_app')
  loop
    if r.wa is null or regexp_replace(r.wa, '[^0-9]', '', 'g') !~ '^[0-9]{8,15}$' then continue; end if;
    begin
      insert into public.pkg_outbox(org_id, quote_id, selection_id, audience, channel, kind, recipient, user_id, payload, dedupe_key, status)
        values (q.org_id, q.id, nullif(p_detail ->> 'selection_id', '')::uuid, 'staff', 'whatsapp', p_kind,
                regexp_replace(r.wa, '[^0-9]', '', 'g'), r.id,
                coalesce(p_detail, '{}'::jsonb) || jsonb_build_object('code', q.code, 'title', q.title),
                p_dedupe || ':staff:' || r.id::text,
                case when public.notify_allowed(q.org_id, '*', p_kind, 'whatsapp') then 'pending' else 'skipped' end)
        on conflict (dedupe_key) do nothing;
    exception when others then raise warning 'pkg-0069: staff whatsapp skipped (%)', sqlstate;
    end;
  end loop;
end $$;

-- client message(s) per the studio channel toggle; a missing address is logged as skipped
create or replace function public._pkg_client_msg(p_quote uuid, p_sel uuid, p_kind text, p_payload jsonb, p_dedupe text, p_channel text default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare q public.quotes; v_ch text; c text; v_to text; v_first text;
begin
  select * into q from public.quotes x where x.id = p_quote;
  if q.id is null then return null; end if;
  v_ch := coalesce(p_channel, public._pkg_settings(q.org_id) ->> 'pkg_client_channel');
  foreach c in array case when v_ch = 'both' then array['whatsapp', 'email'] else array[v_ch] end loop
    v_to := case when c = 'email' then nullif(lower(btrim(coalesce(q.client ->> 'email', ''))), '')
                 else nullif(regexp_replace(coalesce(q.client ->> 'phone', ''), '[^0-9]', '', 'g'), '') end;
    if c = 'email' and v_to is not null and v_to !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then v_to := null; end if;
    if c = 'whatsapp' and v_to is not null and v_to !~ '^[0-9]{8,15}$' then v_to := null; end if;
    insert into public.pkg_outbox(org_id, quote_id, selection_id, audience, channel, kind, recipient, payload, dedupe_key, status, sent_at)
      values (q.org_id, q.id, p_sel, 'client', c, p_kind, v_to,
              coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('studio', (select o.name from public.organizations o where o.id = q.org_id),
                'client_name', left(coalesce(q.client ->> 'name', ''), 80), 'code', q.code, 'title', q.title),
              p_dedupe || ':' || c, case when v_to is null then 'skipped' else 'pending' end,
              case when v_to is null then now() end)
      on conflict (dedupe_key) do nothing;
    if v_to is not null and v_first is null then v_first := c; end if;
  end loop;
  return v_first;
end $$;

create or replace function public._pkg_staff(p_edit boolean)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_role text;
begin
  if v_me is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = v_me and p.org_id = v_org;
  if v_role is null or v_role = 'client' then raise exception 'not authorized' using errcode = '42501'; end if;
  if not public.has_area('pkg_review', case when p_edit then 'edit' else 'view' end) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return v_org;
end $$;

-- ---- 10) client RPCs (signed out, booklet token) -----------------------------------------
create or replace function public.public_booklet_packages(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.client_booklets; q public.quotes; s public.package_selections; v_pk jsonb; v_cur text;
  v_ready jsonb := null; v_total numeric; v_paid numeric; v_set jsonb; v_sel public.menu_templates; v_mode text; v_totals jsonb;
begin
  b := public._pkg_booklet(p_token, 'pkg.read', 120);
  v_sel := public._bk_selected_pkg(b.quote_id);
  v_mode := case when not public._bk_on(b.sections, 'menu') then 'hidden' when v_sel.id is not null then 'selected' else 'choose' end;
  select * into q from public.quotes x where x.id = b.quote_id;
  select coalesce(o.currency, 'INR') into v_cur from public.organizations o where o.id = q.org_id;
  v_set := public._pkg_settings(q.org_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'description', t.description,
           'per_person', t.price_per_plate, 'currency', coalesce(v_cur, 'INR'), 'min_guests', t.min_guests, 'max_guests', t.max_guests,
           'tier', t.tier, 'diet', t.diet,
           'items', case when jsonb_typeof(t.dishes) = 'array' then t.dishes else '[]'::jsonb end) order by t.seq, t.name), '[]'::jsonb)
    into v_pk from public.menu_templates t where t.org_id = q.org_id
     and ((v_mode = 'choose' and t.active) or (v_mode = 'selected' and t.id = v_sel.id));
  select * into s from public.package_selections x where x.quote_id = q.id and x.status <> 'superseded'
   order by x.created_at desc limit 1;
  if s.id is not null and s.status = 'accepted' and q.approval_token is not null and q.approval_token_revoked_at is null
     and (q.approval_token_expires_at is null or q.approval_token_expires_at > now()) then
    v_ready := jsonb_build_object('approve_url', '/approve?token=' || q.approval_token::text);
  end if;
  v_total := public._pkg_total(q.pricing); v_paid := public._pkg_paid(q.id);
  v_totals := case when not public._bk_on(b.sections, 'quotation') then null
    when not public._bk_on(b.sections, 'payments') then jsonb_build_object('total', v_total, 'paid', null, 'balance', null, 'currency', coalesce(v_cur, 'INR'))
    else jsonb_build_object('total', v_total, 'paid', v_paid, 'balance', round(v_total - v_paid, 2), 'currency', coalesce(v_cur, 'INR')) end;
  if v_mode = 'hidden' then s := null; v_ready := null; end if;
  if not public._bk_on(b.sections, 'quotation') then v_ready := null; end if;
  if public.rate_hit('pkg.log', md5('pkg:' || p_token::text), 3600, 1) = 0 then
    insert into public.audit_log(action, entity, entity_id, quote_id, org_id)
      values ('pkg.view', 'package_selections', b.id::text, q.id, q.org_id);
  end if;
  return jsonb_build_object('packages', v_pk,
    'current_selection', case when s.id is null then null else jsonb_build_object('status', s.status, 'package_id', s.package_id,
       'guests', s.guests, 'decline_reason', s.decline_reason, 'updated_at', greatest(s.updated_at, coalesce(s.reviewed_at, s.created_at))) end,
    'quote_ready', v_ready,
    'locked', v_mode <> 'choose' or public._pkg_lock_reason(q.id) is not null,
    'require_otp', coalesce((v_set ->> 'pkg_require_otp')::boolean, false),
    'mode', v_mode,
    'totals', v_totals);
end $$;

create or replace function public.public_booklet_otp_request(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.client_booklets; q public.quotes; v_code text; r bigint; v_ch text; v_pref text; v_out jsonb; v_id uuid;
begin
  b := public._pkg_booklet(p_token, 'pkg.otp', 5);
  select * into q from public.quotes x where x.id = b.quote_id;
  if public._pkg_lock_reason(q.id) is not null then raise exception 'package selection is closed for this event' using errcode = 'P0001', hint = 'locked'; end if;
  if (select count(*) from public.pkg_otps o where o.booklet_id = b.id and o.created_at > now() - interval '24 hours') >= 10 then
    raise exception 'too many codes requested today - try again tomorrow' using errcode = 'P0001', hint = 'rate_limited'; end if;
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    exit when r < 4294000000;
  end loop;
  v_code := lpad((r % 1000000)::text, 6, '0');
  v_pref := public._pkg_settings(q.org_id) ->> 'pkg_client_channel';
  v_ch := case when v_pref in ('whatsapp', 'both') and regexp_replace(coalesce(q.client ->> 'phone', ''), '[^0-9]', '', 'g') ~ '^[0-9]{8,15}$' then 'whatsapp'
               when coalesce(q.client ->> 'email', '') ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then 'email'
               when regexp_replace(coalesce(q.client ->> 'phone', ''), '[^0-9]', '', 'g') ~ '^[0-9]{8,15}$' then 'whatsapp' end;
  update public.pkg_otps set expires_at = now() where booklet_id = b.id and verified_at is null and expires_at > now();
  insert into public.pkg_otps(org_id, quote_id, booklet_id, code_hash, channel)
    values (q.org_id, q.id, b.id, extensions.crypt(v_code, extensions.gen_salt('bf', 8)), coalesce(v_ch, 'email')) returning id into v_id;
  if v_ch is not null then
    perform public._pkg_client_msg(q.id, null, 'pkg_otp', jsonb_build_object('otp', v_code), 'otp:' || v_id::text, v_ch);
  end if;
  insert into public.audit_log(action, entity, entity_id, quote_id, changed, org_id)
    values ('pkg.otp_request', 'pkg_otps', v_id::text, q.id, jsonb_build_object('channel', v_ch), q.org_id);
  v_out := jsonb_build_object('sent', v_ch is not null, 'channel', v_ch);
  if to_regprocedure('public._a42_dev_echo_allowed()') is not null and public._a42_dev_echo_allowed() then
    v_out := v_out || jsonb_build_object('dev_code', v_code);
  end if;
  return v_out;
end $$;

create or replace function public.public_booklet_choose(p_token uuid, p_package uuid, p_guests integer, p_note text, p_otp text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare b public.client_booklets; q public.quotes; t public.menu_templates; v_lock text; v_otp public.pkg_otps;
  v_need_otp boolean; v_ok_otp boolean := false; v_pricing jsonb; v_ver uuid; v_sel uuid; v_meta jsonb; n int;
begin
  b := public._pkg_booklet(p_token, 'pkg.choose', 10);
  perform pg_advisory_xact_lock(hashtextextended('helm:pkg:quote:' || b.quote_id::text, 0));
  select * into q from public.quotes x where x.id = b.quote_id for update;
  if not public._studio_writable(q.org_id) then
    raise exception 'Read-only: this studio''s Helm subscription is suspended' using errcode = '25006', hint = 'studio_suspended'; end if;
  v_lock := public._pkg_lock_reason(q.id);
  if v_lock is null and not public._bk_on(b.sections, 'menu') then v_lock := 'hidden'; end if;
  if v_lock is null and public._bk_selected_pkg(q.id) is not null and (public._bk_selected_pkg(q.id)).id is not null then v_lock := 'selected'; end if;
  if v_lock is not null then raise exception 'package selection is closed for this event (%)', v_lock using errcode = 'P0001', hint = 'locked'; end if;
  select * into t from public.menu_templates x where x.id = p_package and x.org_id = q.org_id and x.active;
  if t.id is null then raise exception 'this package is not available' using errcode = 'P0001', hint = 'package'; end if;
  if p_guests is null or p_guests < greatest(1, coalesce(t.min_guests, 1)) or p_guests > least(100000, coalesce(t.max_guests, 100000)) then
    raise exception 'guests must be between % and %', greatest(1, coalesce(t.min_guests, 1)), least(100000, coalesce(t.max_guests, 100000))
      using errcode = 'P0001', hint = 'guests'; end if;
  v_need_otp := coalesce((public._pkg_settings(q.org_id) ->> 'pkg_require_otp')::boolean, false);
  if p_otp is not null and btrim(p_otp) <> '' then
    select * into v_otp from public.pkg_otps o where o.booklet_id = b.id and o.verified_at is null and o.expires_at > now()
     order by o.created_at desc limit 1 for update;
    if v_otp.id is not null and v_otp.attempts < 5 then
      v_ok_otp := extensions.crypt(btrim(p_otp), v_otp.code_hash) = v_otp.code_hash;
      update public.pkg_otps set attempts = attempts + 1, verified_at = case when v_ok_otp then now() end where id = v_otp.id;
    end if;
  end if;
  if v_need_otp and not v_ok_otp then
    if v_otp.id is not null then
      -- keep the failed attempt counted, then refuse
      return jsonb_build_object('ok', false, 'status', 'otp_invalid');
    end if;
    raise exception 'enter the code we sent you' using errcode = 'P0001', hint = 'otp_required';
  end if;
  v_pricing := public._pkg_price(q.pricing, t.price_per_plate, p_guests);
  insert into public.quotation_versions(org_id, quote_id, label, pricing, total)
    values (q.org_id, q.id, left('Package draft: ' || t.name || ' x ' || p_guests, 100) || ' #' || left(md5(gen_random_uuid()::text), 6), v_pricing, (v_pricing ->> 'total')::numeric)
    returning id into v_ver;
  update public.package_selections set status = 'superseded', updated_at = clock_timestamp() where quote_id = q.id and status = 'pending';
  get diagnostics n = row_count;
  v_meta := public._pkg_req_meta();
  insert into public.package_selections(org_id, quote_id, booklet_id, package_id, guests, status, client_note, draft_version_id,
      created_by_client, otp_verified, ip_hash, ua, per_person, draft_total, created_at, updated_at)
    values (q.org_id, q.id, b.id, t.id, p_guests, 'pending', nullif(btrim(left(coalesce(p_note, ''), 1000)), ''), v_ver,
      true, v_ok_otp, v_meta ->> 'ip_hash', v_meta ->> 'ua', t.price_per_plate, (v_pricing ->> 'total')::numeric, clock_timestamp(), clock_timestamp())
    returning id into v_sel;
  insert into public.audit_log(action, entity, entity_id, quote_id, changed, org_id)
    values ('pkg.choose', 'package_selections', v_sel::text, q.id,
            jsonb_build_object('package_id', t.id, 'guests', p_guests, 'draft_total', v_pricing ->> 'total', 'superseded', n, 'otp', v_ok_otp), q.org_id);
  perform public._pkg_notify(q.id, 'pkg_selected', jsonb_build_object('selection_id', v_sel, 'package_id', t.id, 'package', t.name,
            'guests', p_guests, 'path', 'event.html?id=' || q.id::text || '#quote'), 'sel:' || v_sel::text || ':selected');
  return jsonb_build_object('ok', true, 'status', 'pending');
end $$;

-- ---- 11) staff RPCs -------------------------------------------------------------------------
create or replace function public.pkg_selection_list(p_quote uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public._pkg_staff(false); v_edit boolean := public.has_area('pkg_review', 'edit');
begin
  return coalesce((select jsonb_agg(j order by (j ->> 'created_at') desc) from (
    select jsonb_build_object('id', s.id, 'quote_id', s.quote_id, 'event_code', q.code, 'event_title', q.title,
      'package_id', s.package_id, 'package', t.name, 'per_person', s.per_person, 'guests', s.guests, 'status', s.status,
      'client_note', s.client_note, 'decline_reason', s.decline_reason, 'draft_version_id', s.draft_version_id,
      'draft_total', s.draft_total, 'price_override', s.price_override, 'current_total', public._pkg_total(q.pricing),
      'paid', public._pkg_paid(q.id), 'otp_verified', s.otp_verified, 'drafted_by', s.drafted_by,
      'reviewed_by', s.reviewed_by, 'reviewed_at', s.reviewed_at, 'created_at', s.created_at,
      'locked', public._pkg_lock_reason(q.id) is not null,
      'can_review', v_edit and s.status = 'pending' and s.drafted_by is distinct from auth.uid()) as j
      from public.package_selections s join public.quotes q on q.id = s.quote_id
      left join public.menu_templates t on t.id = s.package_id
     where s.org_id = v_org and (p_quote is null or s.quote_id = p_quote)
     order by s.created_at desc limit 200) x), '[]'::jsonb);
end $$;

create or replace function public.pkg_selection_review(p_id uuid, p_action text, p_price_override numeric default null, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public._pkg_staff(true); v_me uuid := auth.uid(); s public.package_selections; q public.quotes;
  t public.menu_templates; v_ver public.quotation_versions; v_pricing jsonb; v_single boolean; v_is_admin boolean;
  v_override boolean := false; v_new numeric; v_paid numeric; v_ledger numeric; v_claims text; v_n int := 0;
  v_mode text; v_credit jsonb := null; v_url text; v_had_consent boolean; v_reason text; v_ch text;
begin
  if p_action not in ('accept', 'decline') then raise exception 'action must be accept or decline' using errcode = '22023'; end if;
  select * into s from public.package_selections x where x.id = p_id and x.org_id = v_org;
  if s.id is null then raise exception 'selection not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:pkg:quote:' || s.quote_id::text, 0));
  select * into s from public.package_selections x where x.id = p_id for update;
  if s.status <> 'pending' then raise exception 'this selection is already %', s.status using errcode = '22023'; end if;
  select * into q from public.quotes x where x.id = s.quote_id and x.org_id = v_org for update;
  if q.id is null or q.deleted_at is not null then raise exception 'event not found' using errcode = 'P0002'; end if;

  if p_action = 'decline' then
    v_reason := nullif(btrim(left(coalesce(p_reason, ''), 500)), '');
    if v_reason is null or char_length(v_reason) < 3 then raise exception 'a decline reason is required' using errcode = '22023'; end if;
    update public.package_selections set status = 'declined', decline_reason = v_reason, reviewed_by = v_me, reviewed_at = now(), updated_at = now() where id = s.id;
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'pkg.decline', 'package_selections', s.id::text, q.id, jsonb_build_object('reason', v_reason), v_org);
    perform public._pkg_notify(q.id, 'pkg_declined', jsonb_build_object('selection_id', s.id, 'path', 'event.html?id=' || q.id::text || '#quote'), 'sel:' || s.id::text || ':declined');
    perform public._pkg_client_msg(q.id, s.id, 'pkg_declined', jsonb_build_object('reason', v_reason), 'sel:' || s.id::text || ':declined:client');
    return jsonb_build_object('ok', true, 'status', 'declined', 'version_id', null, 'approve_url', null);
  end if;

  if public._pkg_lock_reason(q.id) is not null then
    raise exception 'package selection is closed for this event (%)', public._pkg_lock_reason(q.id) using errcode = 'P0001', hint = 'locked'; end if;
  v_is_admin := coalesce(public.user_role() = 'admin', false);
  v_single := (select count(*) from public.profiles p where p.org_id = v_org and p.role = 'admin') = 1;
  select * into t from public.menu_templates x where x.id = s.package_id;

  if p_price_override is not null then
    if not (p_price_override >= 0 and p_price_override < 1e9) then raise exception 'price override out of range' using errcode = '22003'; end if;
    v_pricing := public._pkg_price(q.pricing, p_price_override, s.guests);
    insert into public.quotation_versions(org_id, quote_id, label, pricing, total, created_by)
      values (v_org, q.id, left('Package draft (adjusted): ' || coalesce(t.name, 'package') || ' x ' || s.guests, 100) || ' #' || left(md5(gen_random_uuid()::text), 6), v_pricing, (v_pricing ->> 'total')::numeric, v_me)
      returning * into v_ver;
    update public.package_selections set draft_version_id = v_ver.id, price_override = round(p_price_override, 2), per_person = round(p_price_override, 2),
      draft_total = v_ver.total, drafted_by = v_me, updated_at = now() where id = s.id;
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'pkg.adjust', 'package_selections', s.id::text, q.id, jsonb_build_object('per_person', p_price_override, 'draft_total', v_ver.total), v_org);
    if not (v_is_admin and v_single) then
      return jsonb_build_object('ok', true, 'status', 'pending', 'version_id', v_ver.id, 'approve_url', null, 'needs_checker', true);
    end if;
    v_override := true;
  else
    if s.drafted_by is not null and s.drafted_by = v_me then
      if not (v_is_admin and v_single) then
        raise exception 'someone else must approve a draft you adjusted' using errcode = '42501', hint = 'maker_checker'; end if;
      v_override := true;
    end if;
    select * into v_ver from public.quotation_versions x where x.id = s.draft_version_id and x.quote_id = q.id;
    if v_ver.id is null then
      v_pricing := public._pkg_price(q.pricing, coalesce(s.per_person, t.price_per_plate), s.guests);
      insert into public.quotation_versions(org_id, quote_id, label, pricing, total, created_by)
        values (v_org, q.id, left('Package: ' || coalesce(t.name, 'package') || ' x ' || s.guests, 100) || ' #' || left(md5(gen_random_uuid()::text), 6), v_pricing, (v_pricing ->> 'total')::numeric, null)
        returning * into v_ver;
    end if;
  end if;
  if v_override then
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'pkg.self_approve_override', 'package_selections', s.id::text, q.id, jsonb_build_object('reason', 'single admin studio'), v_org);
  end if;

  -- the event takes the draft pricing (pricing triggers recompute; 0052 flags re-approval)
  v_had_consent := public._a52_has_consent(q.id);
  v_new := public.helm_quote_total(v_ver.pricing);
  v_paid := public._pkg_paid(q.id);
  select coalesce(sum(pm.amount), 0) into v_ledger from public.quote_payments pm where pm.quote_id = q.id and pm.status = 'paid';
  if v_new < v_ledger - 0.5 then
    -- the money guard refuses API callers lowering below paid; this server path records the overpay itself
    v_claims := current_setting('request.jwt.claims', true);
    perform set_config('request.jwt.claims', (coalesce(nullif(v_claims, ''), '{}')::jsonb || '{"role":"service_role"}'::jsonb)::text, true);
    update public.quotes set pricing = v_ver.pricing, updated_at = now() where id = q.id;
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  else
    update public.quotes set pricing = v_ver.pricing, updated_at = now() where id = q.id;
  end if;
  update public.event_plan set menu_template = t.name, menu_plate_price = coalesce(s.per_person, t.price_per_plate), updated_at = now(), updated_by = v_me
   where quote_id = q.id and org_id = v_org;

  -- unpaid links for the old amount
  update public.quote_payments set status = 'cancelled' where quote_id = q.id and status = 'created';
  get diagnostics v_n = row_count;

  -- overpay
  if v_new < v_paid - 0.5 then
    v_mode := public._pkg_settings(v_org) ->> 'overpay_mode';
    insert into public.pkg_credits(org_id, quote_id, selection_id, kind, amount, created_by)
      values (v_org, q.id, s.id, case when v_mode = 'manual_refund' then 'refund_due' else 'credit' end, round(v_paid - v_new, 2), v_me);
    v_credit := jsonb_build_object('mode', v_mode, 'amount', round(v_paid - v_new, 2));
    insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
      values (v_me, 'pkg.overpay', 'pkg_credits', s.id::text, q.id, v_credit || jsonb_build_object('paid', v_paid, 'new_total', v_new), v_org);
  end if;

  -- a live approval link (rotated when the client must approve again)
  select * into q from public.quotes x where x.id = q.id;
  if q.approval_token is null or q.approval_token_revoked_at is not null or coalesce(q.consent_stale, false)
     or (q.approval_token_expires_at is not null and q.approval_token_expires_at <= now()) then
    perform public._a42_expire_open_otps(q.id);
    update public.quotes x set approval_token = gen_random_uuid(), approval_token_revoked_at = null,
        approval_token_expires_at = greatest(now() + interval '30 days', coalesce(public.client_link_deadline(x.event_date, x.org_id, 30), now())),
        approval_status = case when coalesce(x.approval_status, 'none') = 'none' then 'sent' else x.approval_status end
     where x.id = q.id;
  end if;
  select * into q from public.quotes x where x.id = q.id;
  v_url := '/approve?token=' || q.approval_token::text;

  update public.package_selections set status = 'accepted', reviewed_by = v_me, reviewed_at = now(), draft_version_id = v_ver.id,
    draft_total = v_new, updated_at = now() where id = s.id;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (v_me, 'pkg.accept', 'package_selections', s.id::text, q.id,
            jsonb_build_object('version_id', v_ver.id, 'total', v_new, 'paid', v_paid, 'cancelled_links', v_n,
                               'reapproval', coalesce(q.consent_stale, false), 'had_consent', v_had_consent), v_org);
  perform public._pkg_notify(q.id, 'pkg_accepted', jsonb_build_object('selection_id', s.id, 'version_id', v_ver.id, 'total', v_new,
            'path', 'event.html?id=' || q.id::text || '#quote'), 'sel:' || s.id::text || ':accepted');
  v_ch := public._pkg_client_msg(q.id, s.id, 'pkg_accepted', jsonb_build_object('approve_url', v_url, 'total', v_new,
            'paid', v_paid, 'balance', round(v_new - v_paid, 2), 'currency', (select o.currency from public.organizations o where o.id = v_org),
            'reapproval', coalesce(q.consent_stale, false)), 'sel:' || s.id::text || ':accepted:client');
  return jsonb_build_object('ok', true, 'status', 'accepted', 'version_id', v_ver.id, 'approve_url', v_url,
    'reapproval_required', coalesce(q.consent_stale, false), 'cancelled_links', v_n, 'credit', v_credit, 'total', v_new, 'paid', v_paid);
end $$;

create or replace function public.pkg_settings_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_role text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.org_id = v_org;
  if v_role is null or v_role = 'client' or not (public.has_area('controls', 'view') or public.has_area('pkg_review', 'view')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  return public._pkg_settings(v_org);
end $$;

create or replace function public.pkg_settings_set(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_role text; c jsonb; k text;
begin
  if auth.uid() is null or v_org is null then raise exception 'not authorized' using errcode = '42501'; end if;
  select pr.role into v_role from public.profiles pr where pr.id = auth.uid() and pr.org_id = v_org;
  if v_role is null or v_role = 'client' or not (v_role = 'admin' or public.has_area('controls', 'edit')) then
    raise exception 'not authorized' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'settings must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('pkg_require_otp', 'pkg_client_channel', 'overpay_mode', 'pkg_lock_days') then
      raise exception 'unknown setting %', k using errcode = '22023'; end if;
  end loop;
  if p ? 'pkg_require_otp' and jsonb_typeof(p -> 'pkg_require_otp') <> 'boolean' then raise exception 'pkg_require_otp must be true/false' using errcode = '22023'; end if;
  if p ? 'pkg_client_channel' and coalesce(p ->> 'pkg_client_channel', '') not in ('whatsapp', 'email', 'both') then raise exception 'pkg_client_channel must be whatsapp, email or both' using errcode = '22023'; end if;
  if p ? 'overpay_mode' and coalesce(p ->> 'overpay_mode', '') not in ('credit', 'manual_refund') then raise exception 'overpay_mode must be credit or manual_refund' using errcode = '22023'; end if;
  if p ? 'pkg_lock_days' and (jsonb_typeof(p -> 'pkg_lock_days') <> 'number' or (p ->> 'pkg_lock_days') !~ '^[0-9]{1,3}$' or (p ->> 'pkg_lock_days')::int > 365) then
    raise exception 'pkg_lock_days must be a whole number 0..365' using errcode = '22023'; end if;
  c := public._pkg_settings(v_org) || p;
  insert into public.pkg_settings(org_id, pkg_require_otp, pkg_client_channel, overpay_mode, pkg_lock_days, updated_at, updated_by)
    values (v_org, (c ->> 'pkg_require_otp')::boolean, c ->> 'pkg_client_channel', c ->> 'overpay_mode', (c ->> 'pkg_lock_days')::int, now(), auth.uid())
    on conflict (org_id) do update set pkg_require_otp = excluded.pkg_require_otp, pkg_client_channel = excluded.pkg_client_channel,
      overpay_mode = excluded.overpay_mode, pkg_lock_days = excluded.pkg_lock_days, updated_at = now(), updated_by = auth.uid();
  insert into public.audit_log(actor, action, entity, entity_id, changed, org_id)
    values (auth.uid(), 'pkg.settings', 'pkg_settings', v_org::text, p, v_org);
  return public._pkg_settings(v_org);
end $$;

-- ---- 12) payment received -> pkg_payment (never blocks a payment) ---------------------------
create or replace function public._pkg_tg_payment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid')
       and exists (select 1 from public.package_selections s where s.quote_id = new.quote_id and s.status = 'accepted') then
      perform public._pkg_notify(new.quote_id, 'pkg_payment',
        jsonb_build_object('payment_id', new.id, 'amount', new.amount, 'source', tg_table_name,
                           'path', 'settlement.html?quote=' || new.quote_id::text || '#payments'),
        'pay:' || tg_table_name || ':' || new.id::text);
    end if;
  exception when others then raise warning 'pkg-0069: payment notice skipped (%)', sqlstate;
  end;
  return null;
end $$;
drop trigger if exists zz_pkg_payment on public.quote_payments;
create trigger zz_pkg_payment after insert or update of status on public.quote_payments
  for each row execute function public._pkg_tg_payment();
drop trigger if exists zz_pkg_payment on public.payment_milestones;
create trigger zz_pkg_payment after insert or update of status on public.payment_milestones
  for each row execute function public._pkg_tg_payment();

-- ---- 13) outbox RPCs (service role only - the dormant pkg-client-notify) -------------------
create or replace function public.pkg_outbox_claim(p_limit integer default 25)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_out jsonb := '[]'::jsonb;
begin
  update public.pkg_outbox set status = 'failed', sent_at = now(), payload = payload - 'otp' where sent_at is null and attempts >= 5;
  update public.pkg_outbox set status = 'skipped', sent_at = now(), payload = payload - 'otp'
   where sent_at is null and kind = 'pkg_otp' and created_at < now() - interval '10 minutes';
  for r in select o.* from public.pkg_outbox o
     where o.sent_at is null and o.status = 'pending' and (o.claimed_at is null or o.claimed_at < now() - interval '10 minutes')
     order by o.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update skip locked
  loop
    update public.pkg_outbox set claimed_at = now(), attempts = attempts + 1 where id = r.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', r.id, 'audience', r.audience, 'channel', r.channel,
      'kind', r.kind, 'to', r.recipient, 'payload', r.payload));
  end loop;
  return v_out;
end $$;

create or replace function public.pkg_outbox_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.pkg_outbox set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.pkg_outbox set status = p_status, sent_at = now(), payload = payload - 'otp' where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 14) privileges ----------------------------------------------------------------------------
do $$ declare s text; begin
  foreach s in array array[
    'public._pkg_settings(uuid)', 'public._pkg_paid(uuid)', 'public._pkg_total(jsonb)', 'public._pkg_lock_reason(uuid)',
    'public._pkg_booklet(uuid, text, integer)', 'public._pkg_req_meta()', 'public._pkg_price(jsonb, numeric, integer)',
    'public._pkg_notify(uuid, text, jsonb, text)', 'public._pkg_client_msg(uuid, uuid, text, jsonb, text, text)',
    'public._pkg_staff(boolean)', 'public._pkg_tg_payment()',
    'public.public_booklet_packages(uuid)', 'public.public_booklet_otp_request(uuid)',
    'public.public_booklet_choose(uuid, uuid, integer, text, text)',
    'public.pkg_selection_list(uuid)', 'public.pkg_selection_review(uuid, text, numeric, text)',
    'public.pkg_settings_get()', 'public.pkg_settings_set(jsonb)',
    'public.pkg_outbox_claim(integer)', 'public.pkg_outbox_mark(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function public.public_booklet_packages(uuid) to anon;
    grant execute on function public.public_booklet_otp_request(uuid) to anon;
    grant execute on function public.public_booklet_choose(uuid, uuid, integer, text, text) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.public_booklet_packages(uuid) to authenticated;
    grant execute on function public.public_booklet_otp_request(uuid) to authenticated;
    grant execute on function public.public_booklet_choose(uuid, uuid, integer, text, text) to authenticated;
    grant execute on function public.pkg_selection_list(uuid) to authenticated;
    grant execute on function public.pkg_selection_review(uuid, text, numeric, text) to authenticated;
    grant execute on function public.pkg_settings_get() to authenticated;
    grant execute on function public.pkg_settings_set(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.pkg_outbox_claim(integer) to service_role;
    grant execute on function public.pkg_outbox_mark(uuid, text) to service_role;
  end if;
end $$;

-- ============================================================================
-- 15) SHARE CHECKLIST (owner request): the person sharing the booklet ticks which
--     sections the client sees. Hidden sections are removed SERVER-SIDE.
--   * client_booklets.sections jsonb - keys studio, client, venue, menu, layout2d,
--     layout3d, quotation, payments, terms, note (true = shown). Existing rows get the
--     column default = everything shown (today's behaviour).
--   * booklet_share(quote, days, versions, terms, note, sections) - new overload; the
--     old 5-argument call keeps working (= all sections). Unknown keys / non-boolean
--     values are refused (22023).
--   * public_get_booklet is renamed ONCE to public_get_booklet__pre0069 and wrapped:
--     unticked sections are removed before anything leaves the database.
--     menu.mode = 'selected' (the event already has a package / menu: only that one,
--     read-only) or 'choose' (no package yet: the selection workflow).
--   * Snapshots: private bucket booklet-snapshots (png / jpeg / webp, max 3 MB), key
--     <org_id>/<quote_id>/{2d|3d}.{png|jpg|webp}; upload = same-studio staff with
--     has_area('quotes','edit'). booklet_set_snapshot(quote, kind, path) records the
--     path on the live booklet. SQL cannot sign storage URLs, so the booklet gets
--     snapshots.{2d,3d} = true/false and the browser loads them from the dormant,
--     token-gated edge function booklet-snapshot (service role reads the path via
--     booklet_snapshot_path - only when that section is ticked).
-- ============================================================================
alter table public.client_booklets add column if not exists sections jsonb not null
  default '{"studio":true,"client":true,"venue":true,"menu":true,"layout2d":true,"layout3d":true,"quotation":true,"payments":true,"terms":true,"note":true}'::jsonb;
alter table public.client_booklets add column if not exists snap_2d_path text;
alter table public.client_booklets add column if not exists snap_3d_path text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_booklets_sections_obj') then
    alter table public.client_booklets add constraint client_booklets_sections_obj check (jsonb_typeof(sections) = 'object') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_booklets_snap_paths') then
    alter table public.client_booklets add constraint client_booklets_snap_paths check (
      (snap_2d_path is null or snap_2d_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/2d\.(png|jpg|webp)$') and
      (snap_3d_path is null or snap_3d_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/3d\.(png|jpg|webp)$')) not valid;
  end if;
end $$;

create or replace function public._bk_sections_all()
returns jsonb language sql immutable set search_path = '' as $$
  select '{"studio":true,"client":true,"venue":true,"menu":true,"layout2d":true,"layout3d":true,"quotation":true,"payments":true,"terms":true,"note":true}'::jsonb;
$$;

-- validate + normalise: missing keys = shown; unknown keys / non-booleans refused
create or replace function public._bk_sections_norm(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  if p is null then return public._bk_sections_all(); end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'sections must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if not (public._bk_sections_all() ? k) then raise exception 'unknown section %', k using errcode = '22023'; end if;
    if jsonb_typeof(p -> k) <> 'boolean' then raise exception 'section % must be true or false', k using errcode = '22023'; end if;
  end loop;
  return public._bk_sections_all() || p;
end $$;

create or replace function public._bk_on(p jsonb, k text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce((public._bk_sections_all() || coalesce(p, '{}'::jsonb)) ->> k, 'true') = 'true';
$$;

-- the event already has a package / menu chosen (selected mode)
create or replace function public._bk_selected_pkg(p_quote uuid)
returns public.menu_templates language plpgsql stable security definer set search_path = '' as $$
declare t public.menu_templates; v_name text; v_org uuid;
begin
  select ep.menu_template, ep.org_id into v_name, v_org from public.event_plan ep where ep.quote_id = p_quote;
  if nullif(btrim(coalesce(v_name, '')), '') is not null then
    select * into t from public.menu_templates x where x.org_id = v_org and x.name = v_name order by x.active desc, x.seq limit 1;
  end if;
  if t.id is null then
    select x.* into t from public.package_selections s join public.menu_templates x on x.id = s.package_id
     where s.quote_id = p_quote and s.status = 'accepted' order by s.reviewed_at desc nulls last limit 1;
  end if;
  return t;
end $$;

create or replace function public.booklet_share(p_quote_id uuid, p_days integer, p_version_ids uuid[], p_terms text, p_note text, p_sections jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_sec jsonb := public._bk_sections_norm(p_sections); r jsonb; v_prev public.client_booklets;
begin
  select * into v_prev from public.client_booklets b where b.quote_id = p_quote_id and b.org_id = public.current_org_id()
   order by b.created_at desc limit 1;
  r := public.booklet_share(p_quote_id, p_days, p_version_ids, p_terms, p_note);
  update public.client_booklets b set sections = v_sec, snap_2d_path = v_prev.snap_2d_path, snap_3d_path = v_prev.snap_3d_path
   where b.id = (r ->> 'id')::uuid;
  return r || jsonb_build_object('sections', v_sec);
end $$;

-- the old 5-argument share keeps the previous link's snapshots too
create or replace function public._bk_tg_carry_snaps()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_prev public.client_booklets;
begin
  if new.snap_2d_path is null and new.snap_3d_path is null then
    select * into v_prev from public.client_booklets b where b.quote_id = new.quote_id and b.id <> new.id
     order by b.created_at desc limit 1;
    new.snap_2d_path := v_prev.snap_2d_path; new.snap_3d_path := v_prev.snap_3d_path;
  end if;
  return new;
end $$;
drop trigger if exists zb_carry_snaps on public.client_booklets;
create trigger zb_carry_snaps before insert on public.client_booklets for each row execute function public._bk_tg_carry_snaps();

create or replace function public.booklet_snapshot_upload_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_parts text[] := string_to_array(coalesce(p_name, ''), '/'); v_org uuid := public.current_org_id(); v_role text;
begin
  if auth.uid() is null or v_org is null then return false; end if;
  select p.role into v_role from public.profiles p where p.id = auth.uid() and p.org_id = v_org;
  if v_role is null or v_role = 'client' or not public.has_area('quotes', 'edit') then return false; end if;
  if coalesce(array_length(v_parts, 1), 0) <> 3 or v_parts[1] is distinct from v_org::text then return false; end if;
  if v_parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_parts[3] !~ '^(2d|3d)\.(png|jpg|webp)$' then return false; end if;
  return exists (select 1 from public.quotes q where q.id = v_parts[2]::uuid and q.org_id = v_org and q.deleted_at is null)
     and public._studio_writable(v_org);
end $$;

do $$ begin
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('booklet-snapshots', 'booklet-snapshots', false, 3145728, array['image/png', 'image/jpeg', 'image/webp'])
  on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];
exception when undefined_column then
  insert into storage.buckets (id, name, public) values ('booklet-snapshots', 'booklet-snapshots', false)
  on conflict (id) do update set public = false;
end $$;
-- the 0048 upload name guard (restrictive policies bind to the function itself, so it is
-- NOT renamed): its current body is copied ONCE to *__pre0069, then replaced in place by a
-- wrapper that learns the new bucket and delegates everything else.
do $$ begin
  if to_regprocedure('public.storage_object_name_ok(text,text)') is not null
     and to_regprocedure('public.storage_object_name_ok__pre0069(text,text)') is null then
    execute replace(pg_get_functiondef('public.storage_object_name_ok(text,text)'::regprocedure),
                    'public.storage_object_name_ok(', 'public.storage_object_name_ok__pre0069(');
    execute 'revoke all on function public.storage_object_name_ok__pre0069(text, text) from public';
    execute 'grant execute on function public.storage_object_name_ok__pre0069(text, text) to authenticated, anon, service_role';
  end if;
end $$;
do $$ begin
  if to_regprocedure('public.storage_object_name_ok__pre0069(text,text)') is not null then
    execute $f$
create or replace function public.storage_object_name_ok(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $b$
begin
  -- package-flow-0069: booklet snapshots = <org>/<quote>/{2d|3d}.{png|jpg|webp} in the caller's studio
  if p_bucket = 'booklet-snapshots' then
    return p_name is not null and public.current_org_id() is not null and auth.uid() is not null
       and split_part(p_name, '/', 1) = public.current_org_id()::text
       and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(2d|3d)\.(png|jpg|webp)$';
  end if;
  return public.storage_object_name_ok__pre0069(p_bucket, p_name);
end $b$;
$f$;
    execute 'grant execute on function public.storage_object_name_ok(text, text) to authenticated, anon, service_role';
  end if;
end $$;

drop policy if exists booklet_snapshots_insert on storage.objects;
create policy booklet_snapshots_insert on storage.objects for insert to authenticated
  with check ( bucket_id = 'booklet-snapshots' and public.booklet_snapshot_upload_ok(name) );
drop policy if exists booklet_snapshots_update on storage.objects;
create policy booklet_snapshots_update on storage.objects for update to authenticated
  using ( bucket_id = 'booklet-snapshots' and public.booklet_snapshot_upload_ok(name) )
  with check ( bucket_id = 'booklet-snapshots' and public.booklet_snapshot_upload_ok(name) );
drop policy if exists booklet_snapshots_read on storage.objects;
create policy booklet_snapshots_read on storage.objects for select to authenticated
  using ( bucket_id = 'booklet-snapshots' and (storage.foldername(name))[1] = (select public.current_org_id())::text
          and public.has_area('quotes', 'view') );

create or replace function public.booklet_set_snapshot(p_quote_id uuid, p_kind text, p_path text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; n int;
begin
  v_org := public._booklet_staff_quote(p_quote_id, true);
  if p_kind not in ('2d', '3d') then raise exception 'kind must be 2d or 3d' using errcode = '22023'; end if;
  if p_path is not null and p_path !~ ('^' || v_org::text || '/' || p_quote_id::text || '/' || p_kind || '\.(png|jpg|webp)$') then
    raise exception 'bad snapshot path' using errcode = '22023'; end if;
  if p_kind = '2d' then
    update public.client_booklets b set snap_2d_path = p_path where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  else
    update public.client_booklets b set snap_3d_path = p_path where b.quote_id = p_quote_id and b.org_id = v_org and b.revoked_at is null;
  end if;
  get diagnostics n = row_count;
  insert into public.audit_log(actor, action, entity, entity_id, quote_id, changed, org_id)
    values (auth.uid(), 'booklet.snapshot', 'client_booklets', p_quote_id::text, p_quote_id, jsonb_build_object('kind', p_kind, 'set', p_path is not null), v_org);
  return jsonb_build_object('ok', n > 0, 'kind', p_kind, 'path', p_path);
end $$;

-- service role only (edge function booklet-snapshot): the storage path for a ticked snapshot
create or replace function public.booklet_snapshot_path(p_token uuid, p_kind text)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare b public.client_booklets;
begin
  if p_token is null or p_kind not in ('2d', '3d') then return null; end if;
  if public.rate_hit('booklet.snap', md5('booklet:' || p_token::text), 600, 120) > 0 then return null; end if;
  select * into b from public.client_booklets x where x.token = p_token;
  if b.id is null or b.revoked_at is not null or b.expires_at <= now()
     or not exists (select 1 from public.quotes q where q.id = b.quote_id and q.org_id = b.org_id and q.deleted_at is null) then return null; end if;
  if not public._bk_on(b.sections, case when p_kind = '2d' then 'layout2d' else 'layout3d' end) then return null; end if;
  return case when p_kind = '2d' then b.snap_2d_path else b.snap_3d_path end;
end $$;

do $$ begin
  if to_regprocedure('public.public_get_booklet__pre0069(uuid)') is null then
    alter function public.public_get_booklet(uuid) rename to public_get_booklet__pre0069;
  end if;
  revoke all on function public.public_get_booklet__pre0069(uuid) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.public_get_booklet__pre0069(uuid) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.public_get_booklet__pre0069(uuid) from authenticated'; end if;
end $$;

create or replace function public.public_get_booklet(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- package-flow-0069: the 0065 reader, then unticked sections are removed server-side
declare r jsonb; b public.client_booklets; s jsonb; t public.menu_templates; v_cur text;
begin
  r := public.public_get_booklet__pre0069(p_token);      -- validates token, rate limit, audit
  select * into b from public.client_booklets x where x.token = p_token;
  s := public._bk_sections_norm(coalesce(b.sections, public._bk_sections_all()));
  if not public._bk_on(s, 'studio') then r := r || jsonb_build_object('studio', jsonb_build_object('name', r #> '{studio,name}')); end if;
  if not public._bk_on(s, 'client') then r := jsonb_set(r, '{event}', (r -> 'event') - 'client_name' - 'guests'); end if;
  if not public._bk_on(s, 'venue') then r := jsonb_set(r, '{event}', (r -> 'event') - 'venue_name' - 'venue_address'); end if;
  if not public._bk_on(s, 'menu') then r := r - 'menu';
  else
    t := public._bk_selected_pkg(b.quote_id);
    select o.currency into v_cur from public.organizations o where o.id = b.org_id;
    r := jsonb_set(r, '{menu}', coalesce(r -> 'menu', '{}'::jsonb) || jsonb_build_object(
      'mode', case when t.id is null then 'choose' else 'selected' end,
      'selected_package', case when t.id is null then r #> '{menu,selected_package}' else jsonb_build_object('id', t.id, 'name', t.name,
        'tier', t.tier, 'diet', t.diet, 'description', t.description, 'per_person', t.price_per_plate, 'price_per_plate', t.price_per_plate,
        'currency', coalesce(v_cur, 'INR'), 'dishes', t.dishes, 'items', t.dishes) end));
  end if;
  if not public._bk_on(s, 'layout2d') then r := r - 'layout'; end if;
  if not public._bk_on(s, 'quotation') then r := r - 'quote' - 'versions'; end if;
  if not public._bk_on(s, 'payments') then r := r - 'payments'; end if;
  if not public._bk_on(s, 'terms') then r := r - 'terms'; end if;
  if not public._bk_on(s, 'note') then r := r - 'note'; end if;
  return r || jsonb_build_object('sections', s,
    'snapshots', jsonb_build_object('2d', public._bk_on(s, 'layout2d') and b.snap_2d_path is not null,
                                    '3d', public._bk_on(s, 'layout3d') and b.snap_3d_path is not null));
end $$;

do $$ declare s text; begin
  foreach s in array array['public._bk_sections_all()', 'public._bk_sections_norm(jsonb)', 'public._bk_on(jsonb, text)',
    'public._bk_selected_pkg(uuid)', 'public._bk_tg_carry_snaps()', 'public.booklet_share(uuid, integer, uuid[], text, text, jsonb)',
    'public.booklet_set_snapshot(uuid, text, text)', 'public.booklet_snapshot_path(uuid, text)', 'public.public_get_booklet(uuid)'] loop
    execute format('revoke all on function %s from public', s);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', s); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', s); end if;
  end loop;
  -- storage policies call this as the caller
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.booklet_snapshot_upload_ok(text) to authenticated;
    grant execute on function public.booklet_share(uuid, integer, uuid[], text, text, jsonb) to authenticated;
    grant execute on function public.booklet_set_snapshot(uuid, text, text) to authenticated;
    grant execute on function public.public_get_booklet(uuid) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.booklet_snapshot_upload_ok(text) from anon';
    grant execute on function public.public_get_booklet(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.booklet_snapshot_path(uuid, text) to service_role;
  end if;
end $$;

-- ---- verify (every row should say ok = true) -----------------------------------------------
select item, ok from (values
  ('package_selections exists with RLS', (select relrowsecurity from pg_class where oid = 'public.package_selections'::regclass)),
  ('pkg_settings / pkg_credits / pkg_otps / pkg_outbox exist', to_regclass('public.pkg_settings') is not null and to_regclass('public.pkg_credits') is not null
      and to_regclass('public.pkg_otps') is not null and to_regclass('public.pkg_outbox') is not null),
  ('one pending selection per event', to_regclass('public.package_selections_one_pending') is not null),
  ('members cannot write selections', not has_table_privilege('authenticated', 'public.package_selections', 'insert')),
  ('outbox hidden from members', not has_table_privilege('authenticated', 'public.pkg_outbox', 'select')),
  ('suspended-studio guard on new tables', (select count(*) = 5 from pg_trigger where tgname = 'zzz_studio_read_only' and tgrelid in
      ('public.package_selections'::regclass, 'public.pkg_settings'::regclass, 'public.pkg_credits'::regclass, 'public.pkg_otps'::regclass, 'public.pkg_outbox'::regclass))),
  ('client RPCs for anon', has_function_privilege('anon', 'public.public_booklet_packages(uuid)', 'execute')
      and has_function_privilege('anon', 'public.public_booklet_choose(uuid,uuid,integer,text,text)', 'execute')
      and has_function_privilege('anon', 'public.public_booklet_otp_request(uuid)', 'execute')),
  ('staff RPCs not for anon', not has_function_privilege('anon', 'public.pkg_selection_review(uuid,text,numeric,text)', 'execute')
      and has_function_privilege('authenticated', 'public.pkg_selection_list(uuid)', 'execute')),
  ('outbox RPCs service role only', not has_function_privilege('authenticated', 'public.pkg_outbox_claim(integer)', 'execute')),
  ('catalog has 4 package types', (select count(*) = 4 from jsonb_array_elements(public.notification_catalog()) c
      where c ->> 'type' in ('pkg_selected', 'pkg_accepted', 'pkg_declined', 'pkg_payment'))),
  ('booklet sections column', exists (select 1 from pg_attribute where attrelid = 'public.client_booklets'::regclass and attname = 'sections' and not attisdropped)),
  ('booklet share overload', to_regprocedure('public.booklet_share(uuid,integer,uuid[],text,text,jsonb)') is not null
      and to_regprocedure('public.booklet_share(uuid,integer,uuid[],text,text)') is not null),
  ('public booklet reader wrapped', to_regprocedure('public.public_get_booklet__pre0069(uuid)') is not null
      and has_function_privilege('anon', 'public.public_get_booklet(uuid)', 'execute')
      and not has_function_privilege('anon', 'public.public_get_booklet__pre0069(uuid)', 'execute')),
  ('snapshot bucket is private', (select not public from storage.buckets where id = 'booklet-snapshots')),
  ('snapshot upload policy', exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'booklet_snapshots_insert')),
  ('upload name guard knows the bucket', position('booklet-snapshots' in pg_get_functiondef('public.storage_object_name_ok(text,text)'::regprocedure)) > 0)
) v(item, ok);
