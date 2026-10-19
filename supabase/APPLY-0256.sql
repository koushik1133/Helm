-- APPLY-0256.sql - paste into the Supabase SQL editor (STAGING first; production when the owner says go).
-- Run AFTER everything up to APPLY-0253 (0241 delivery reminders + 0246 event money ledger must be in). Order-
-- independent of 0254 / 0255.
-- Vendor requests + vendor invoices (owner, r23): assign a vendor to an event (what / when / where / details /
-- agreed amount) -> the vendor accepts or declines (with a comment) from a one-tap link /vendor-request?t=...
-- (no sign-in) -> reassign / cancel keep the history; once accepted they send their tax invoice from the same link
-- (GST number / CGST + SGST or IGST / GSTIN / PDF or photo); Finance approves (-> one vendor bill = the Actual cost
-- in Budget, Closure, Insights and Business), queries or rejects; payments are the normal vendor-bill payouts.
-- Accepting adds a "Deliveries & arrivals" assignment (r21 reminders). E-mail / WhatsApp rows are only QUEUED.
-- 6 NEW tables (RLS on, RPCs only), 1 private storage bucket 'vendor-invoices' + 2 storage policies, the 0048 upload
-- name guard learns the new bucket (old body kept as storage_object_name_ok__pre0256), new functions, one pg_cron
-- job (only when pg_cron is installed), the 0184 purge list patched in place. No existing table / column / policy
-- changed, nothing deleted. Safe to run twice. ASCII only.
--
-- OWNER STEPS (staging first, then production):
--   1  Paste this whole file and Run. Every VERIFY row at the end must say ok = true.
--   2  Deploy the site (vendor-request.html / .js / .css, vendor-requests-ui.js / .css, vendors.html, event.html,
--      event-polish.css, store-api.js, vercel.json + _headers for the /vendor-request route).
--   3  Edge function (optional until e-mail goes live): redeploy comms-dispatch (--no-verify-jwt) so it also sends
--      the queued vendor request e-mails (vendor-request.mjs). Until then the planner shares the link (Copy link /
--      Open in WhatsApp on the request). WhatsApp rows stay queued (no WhatsApp lane yet).
--   4  pg_cron missing? schedule by hand: select cron.schedule('helm_vendor_requests', '*/15 * * * *',
--      'select public.vendor_requests_tick()');
--   5  Check: Vendors -> Requests & invoices -> New request (event, vendor, Chairs x120, date + time, agreed amount)
--      -> Share link -> open it in a private window -> Accept -> the event's Budget shows the booking Committed;
--      send an invoice from the link (PDF) -> Vendors -> Invoices to review -> Approve -> Budget / Closure show it
--      as Actual; Record payment -> Part paid / Paid.
begin;
-- 0256_vendor_requests_invoices.sql - CANONICAL forward-only.
-- REQUIRES phase9 (vendors + event_resources), phase29 / phase57 (role_access + has_area + current_org_id + user_role),
--          0004 (tg_quote_org_match), 0016 + 0035 (event chat groups + mentions), 0045 (tg_studio_read_only),
--          0050 (rate_hit), 0124 (vendor_bills + vendor_payouts + record_vendor_payout), 0183 (_trial_locked),
--          0179 (_tb179_no_send), 0241 (delivery_commitments + the _dl241 helpers), 0246 (vendor_bills.gst_amount /
--          gst_claimable + the _r21_cost_lines cost ledger).
--
-- In plain words (owner, r23): "assign a vendor to an event the way we assign staff - they get a request, accept or
-- reject it with a comment, we can reassign; after the event they send their invoice from the same link, we approve
-- it and it goes into the budget and the margin".
--   1  vendor_requests - one request to ONE vendor for one event (optionally one existing vendor booking): WHAT
--      (e.g. "Chairs"), quantity, WHEN (when_at), WHERE, details, the AGREED amount and a reply-by time. A request
--      without a booking creates one (event_resources, status 'enquiry', cost = agreed amount) so the 0246 cost
--      ledger counts it as Estimated at once. Status: sent -> accepted / rejected, or cancelled / reassigned (never
--      deleted). Reassign = the old request is closed as 'reassigned' (kept, linked to the new one), the booking
--      moves to the new vendor and a fresh request goes out. vendor_request_log keeps every step (who, when, note).
--   2  Accept (from the vendor's link, or recorded by a planner who got the answer by phone): the booking becomes
--      'confirmed' at the agreed amount (Committed in the ledger) and - when the request has a time - a 0241
--      "Deliveries & arrivals" assignment is added, so the r21 reminder engine reminds the vendor about the
--      delivery and posts their updates in the event chat. Reject needs a comment.
--   3  The vendor's link /vendor-request?t=<64 hex>: two random UUIDs (244 random bits); only the sha-256 is stored,
--      it opens ONE request, expires (90 days after the request time, at least 7 days, at most 180 days),
--      rate-limited, no sign-in. It shows only what the vendor needs (no client, no other vendor, no studio money).
--   4  After accepting, the vendor submits an INVOICE from the same link: invoice number (GST style: up to 16
--      characters, letters / digits / - /), date, taxable value, CGST + SGST or IGST, GSTIN (needed when any GST is
--      charged), notes and ONE file (PDF / JPEG / PNG / WebP, 10 MB) uploaded to the private bucket
--      'vendor-invoices' at <studio>/<event>/<request>/<random>.<ext> through a one-time 15-minute upload grant.
--      Invoice numbers are unique per vendor per financial year (April-March) among live invoices.
--   5  The studio (Finance edit) reviews: Approve / Query (vendor may resubmit; the old one is kept as
--      'superseded') / Reject (with a reason). Approving writes ONE vendor_bills row (amount, GST, claimable flag,
--      booking) - the 0246 ledger then shows it as the Actual cost of that booking, so Budget, Closure, Insights
--      and Business margins update; payments use the existing record_vendor_payout (paid / partial / due), which
--      feeds Closure's "vendor amount unsettled". Approving more than the agreed amount needs an explicit tick.
--      Optional TDS section / amount is kept on the invoice for the payout (information only).
--   6  Notices: every vendor answer, missed reply and new invoice is posted by Helm in the event's team chat group
--      (@ the studio admins, coordinators and whoever sent the request) and dropped into the bell. Request
--      e-mails (the request + reminders 24 h / 48 h later while unanswered) and WhatsApp rows are QUEUED only in
--      vendor_request_sends; the dormant comms-dispatch claims e-mail rows (vendor_request_claim, service role).
--      Free-trial studios, the sample master and sample events never queue a send (copy the link instead).
--      No reply by the reply-by time -> one "No reply from X" notice (vendor_requests_tick, pg_cron if present).
--   Access: assign / reassign / cancel = Vendors EDIT; see = Vendors VIEW or Finance VIEW (amounts only with
--   Finance view or Vendors edit); review invoices = Finance EDIT; admin always. Own studio only everywhere.
-- Changes: 6 new tables (RLS on; no API-role table privilege - RPCs only), 1 private storage bucket + 2 storage
-- policies, new functions only, 1 pg_cron job (only when pg_cron exists); rows inserted into event_resources,
-- delivery_commitments, vendor_bills, chat_messages and notifications through the RPCs; a request's own booking is
-- updated (vendor / status / cost) on accept / reassign / cancel and the old values are written to the request
-- log. The 0048 upload name guard storage_object_name_ok learns the new bucket (its body kept ONCE as
-- storage_object_name_ok__pre0256 and wrapped, the 0069 way). No existing table, column or policy is changed or
-- dropped; nothing is deleted.
-- Additive + idempotent: safe to run twice. ASCII only.
-- ROLLBACK (manual, only if ever needed): select cron.unschedule('helm_vendor_requests'); revoke execute on the
-- vendor_* RPCs from anon / authenticated. The tables can stay (unused).

do $$ begin
  if to_regclass('public.vendors') is null or to_regclass('public.event_resources') is null then
    raise exception 'STOP 0256: phase9 (vendors + event_resources) is not applied'; end if;
  if to_regprocedure('public.has_area(text,text)') is null or to_regprocedure('public.current_org_id()') is null
     or to_regprocedure('public.user_role()') is null then
    raise exception 'STOP 0256: phase29 / phase57 (has_area, current_org_id, user_role) is not applied'; end if;
  if to_regprocedure('public.tg_quote_org_match()') is null then raise exception 'STOP 0256: 0004 (tg_quote_org_match) is not applied'; end if;
  if to_regprocedure('public.tg_studio_read_only()') is null then raise exception 'STOP 0256: 0045 (tg_studio_read_only) is not applied'; end if;
  if to_regprocedure('public.rate_hit(text,text,integer,integer)') is null then raise exception 'STOP 0256: 0050 (rate_hit) is not applied'; end if;
  if to_regclass('public.vendor_bills') is null or to_regclass('public.vendor_payouts') is null
     or to_regprocedure('public.record_vendor_payout(uuid,numeric,date,text,text,text)') is null then
    raise exception 'STOP 0256: 0124 (vendor bills + payouts) is not applied'; end if;
  if to_regprocedure('public._trial_locked(uuid)') is null then raise exception 'STOP 0256: 0183 (_trial_locked) is not applied'; end if;
  if to_regprocedure('public._tb179_no_send(uuid)') is null then raise exception 'STOP 0256: 0179 (_tb179_no_send) is not applied'; end if;
  if to_regclass('public.delivery_commitments') is null or to_regprocedure('public._dl241_send_block(uuid,text,boolean)') is null
     or to_regprocedure('public._dl241_when(timestamptz,uuid)') is null or to_regprocedure('public._dl241_log(uuid,uuid,text,text,timestamptz,text,uuid,text)') is null then
    raise exception 'STOP 0256: 0241 (delivery reminders) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'vendor_bills' and column_name = 'gst_claimable')
     or to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null then
    raise exception 'STOP 0256: 0246 (event money ledger) is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'chat_messages' and column_name = 'meta') then
    raise exception 'STOP 0256: 0016 + 0035 (chat event groups + mentions) are not applied'; end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'STOP 0256: the storage schema (buckets / objects) is missing'; end if;
end $$;

-- ---- 1) tables --------------------------------------------------------------------------------------------------
create table if not exists public.vendor_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  quote_id        uuid not null references public.quotes(id) on delete cascade,
  vendor_id       uuid references public.vendors(id) on delete set null,
  vendor_name     text not null check (char_length(btrim(vendor_name)) between 1 and 120),
  contact_email   text check (contact_email is null or contact_email ~ '^[^\s@<>"'',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$'),
  contact_phone   text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  booking_id      uuid references public.event_resources(id) on delete set null,
  booking_created boolean not null default false,
  what            text not null check (char_length(btrim(what)) between 1 and 200),
  qty             numeric check (qty is null or (qty > 0 and qty <= 1000000)),
  when_at         timestamptz not null,
  where_text      text check (where_text is null or char_length(where_text) <= 300),
  details         text check (details is null or char_length(details) <= 1000),
  agreed_amount   numeric not null check (agreed_amount >= 0 and agreed_amount < 1000000000000),
  currency        text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  respond_by      timestamptz not null,
  status          text not null default 'sent' check (status in ('sent', 'accepted', 'rejected', 'cancelled', 'reassigned')),
  response_note   text check (response_note is null or char_length(response_note) <= 500),
  responded_at    timestamptz,
  responded_via   text check (responded_via is null or responded_via in ('link', 'studio')),
  replaces_id     uuid references public.vendor_requests(id) on delete set null,
  replaced_by     uuid references public.vendor_requests(id) on delete set null,
  delivery_id     uuid references public.delivery_commitments(id) on delete set null,
  reminders_on    boolean not null default true,
  no_response_at  timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists vendor_requests_quote_idx on public.vendor_requests(quote_id, created_at);
create index if not exists vendor_requests_vendor_idx on public.vendor_requests(org_id, vendor_id, created_at);
create index if not exists vendor_requests_open_idx on public.vendor_requests(respond_by) where status = 'sent';
-- one live request per booking (a reassign closes the old one first)
create unique index if not exists vendor_requests_live_booking_uq on public.vendor_requests(booking_id)
  where booking_id is not null and status in ('sent', 'accepted');

create table if not exists public.vendor_request_log (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.vendor_requests(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  at          timestamptz not null default clock_timestamp(),
  event       text not null check (char_length(event) between 1 and 40),
  note        text check (note is null or char_length(note) <= 600),
  actor_kind  text not null check (actor_kind in ('user', 'link', 'system')),
  actor_id    uuid,
  actor_label text check (actor_label is null or char_length(actor_label) <= 160)
);
create index if not exists vendor_request_log_idx on public.vendor_request_log(request_id, at);

create table if not exists public.vendor_request_links (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  request_id   uuid not null references public.vendor_requests(id) on delete cascade,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  issued_via   text not null check (issued_via in ('email', 'whatsapp', 'copy')),
  expires_at   timestamptz not null,
  uses         integer not null default 0,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists vendor_request_links_req_idx on public.vendor_request_links(request_id);

create table if not exists public.vendor_request_sends (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  request_id  uuid not null references public.vendor_requests(id) on delete cascade,
  kind        text not null check (kind in ('request', 'reminder')),
  channel     text not null check (channel in ('email', 'whatsapp')),
  recipient   text not null check (char_length(recipient) between 3 and 200),
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  status      text not null default 'pending' check (status in ('pending', 'sent', 'skipped', 'failed')),
  reason      text check (reason is null or char_length(reason) <= 60),
  attempts    integer not null default 0,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists vendor_request_sends_dedupe on public.vendor_request_sends(dedupe_key);
create index if not exists vendor_request_sends_pending_idx on public.vendor_request_sends(channel, created_at) where sent_at is null;

create table if not exists public.vendor_invoices (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  quote_id       uuid not null references public.quotes(id) on delete cascade,
  request_id     uuid not null references public.vendor_requests(id) on delete cascade,
  vendor_id      uuid references public.vendors(id) on delete set null,
  booking_id     uuid references public.event_resources(id) on delete set null,
  invoice_no     text not null check (invoice_no ~ '^[A-Z0-9/-]{1,16}$'),
  invoice_date   date not null,
  fy             text not null check (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  taxable_amount numeric not null check (taxable_amount > 0 and taxable_amount < 1000000000000),
  cgst           numeric not null default 0 check (cgst >= 0),
  sgst           numeric not null default 0 check (sgst >= 0),
  igst           numeric not null default 0 check (igst >= 0),
  total_amount   numeric not null check (total_amount > 0 and total_amount < 1000000000000),
  vendor_gstin   text check (vendor_gstin is null or vendor_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  notes          text check (notes is null or char_length(notes) <= 500),
  storage_path   text check (storage_path is null or storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$'),
  mime           text check (mime is null or mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  status         text not null default 'submitted' check (status in ('submitted', 'queried', 'approved', 'rejected', 'superseded')),
  replaces_id    uuid references public.vendor_invoices(id) on delete set null,
  review_note    text check (review_note is null or char_length(review_note) <= 500),
  reviewed_at    timestamptz,
  reviewed_by    uuid,
  gst_claimable  boolean,
  tds_section    text check (tds_section is null or tds_section ~ '^19[0-9][A-Z]{0,3}$'),
  tds_amount     numeric check (tds_amount is null or tds_amount >= 0),
  bill_id        uuid references public.vendor_bills(id) on delete set null,
  submitted_at   timestamptz not null default now(),
  constraint vendor_invoices_total_ck check (abs(total_amount - (taxable_amount + cgst + sgst + igst)) < 0.005),
  constraint vendor_invoices_gst_ck check ((igst = 0 or (cgst = 0 and sgst = 0)) and abs(cgst - sgst) <= 1),
  constraint vendor_invoices_tds_ck check (tds_amount is null or tds_amount <= total_amount)
);
create index if not exists vendor_invoices_req_idx on public.vendor_invoices(request_id, submitted_at);
create index if not exists vendor_invoices_quote_idx on public.vendor_invoices(quote_id);
create unique index if not exists vendor_invoices_path_uq on public.vendor_invoices(storage_path) where storage_path is not null;
-- GST: an invoice number is unique per supplier per financial year (among invoices that are still live)
create unique index if not exists vendor_invoices_no_uq on public.vendor_invoices(org_id, vendor_id, invoice_no, fy)
  where vendor_id is not null and status in ('submitted', 'queried', 'approved');

create table if not exists public.vendor_invoice_grants (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  request_id  uuid not null references public.vendor_requests(id) on delete cascade,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  path        text not null,
  mime        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '15 minutes'),
  used_at     timestamptz
);
create unique index if not exists vendor_invoice_grants_path_uq on public.vendor_invoice_grants(path);
create index if not exists vendor_invoice_grants_tok_idx on public.vendor_invoice_grants(token_hash, created_at);

-- RLS on everywhere; no API-role table privilege (the pages go through the RPCs below)
do $$ declare t text; begin
  foreach t in array array['vendor_requests', 'vendor_request_log', 'vendor_request_links', 'vendor_request_sends',
                           'vendor_invoices', 'vendor_invoice_grants'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on table public.%I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on table public.%I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant select on table public.%I to service_role', t); end if;
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
  foreach t in array array['vendor_requests', 'vendor_invoices', 'vendor_invoice_grants'] loop
    if not exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'zz_quote_org_match') then
      execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', t);
    end if;
  end loop;
end $$;

-- guards: a request / invoice never moves to another studio or event; a decided invoice is final
create or replace function public.tg_vr256_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
-- vendor-requests-0256
begin
  if new.org_id is distinct from old.org_id or new.quote_id is distinct from old.quote_id then
    raise exception 'A vendor request cannot move to another event.' using errcode = '42501'; end if;
  if tg_table_name = 'vendor_invoices' then
    if new.request_id is distinct from old.request_id or new.invoice_no is distinct from old.invoice_no
       or new.taxable_amount is distinct from old.taxable_amount or new.cgst is distinct from old.cgst
       or new.sgst is distinct from old.sgst or new.igst is distinct from old.igst or new.total_amount is distinct from old.total_amount
       or new.storage_path is distinct from old.storage_path or new.invoice_date is distinct from old.invoice_date then
      raise exception 'A submitted invoice cannot be changed - ask the vendor to send a corrected one.' using errcode = '42501'; end if;
    if old.status in ('approved', 'rejected', 'superseded') and new.status is distinct from old.status then
      raise exception 'This invoice was already decided.' using errcode = '22023'; end if;
    if old.bill_id is not null and new.bill_id is distinct from old.bill_id then
      raise exception 'The bill of an approved invoice cannot change.' using errcode = '42501'; end if;
  else
    if old.status in ('rejected', 'cancelled', 'reassigned') and new.status is distinct from old.status then
      raise exception 'This vendor request is closed.' using errcode = '22023'; end if;
  end if;
  return new;
end $$;
drop trigger if exists vr256_guard on public.vendor_requests;
create trigger vr256_guard before update on public.vendor_requests for each row execute function public.tg_vr256_guard();
drop trigger if exists vr256_guard on public.vendor_invoices;
create trigger vr256_guard before update on public.vendor_invoices for each row execute function public.tg_vr256_guard();

-- ---- 2) helpers (internal, no app grants) -----------------------------------------------------------------------
create or replace function public._vr256_hash(p text)
returns text language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

-- 'assign' = Vendors edit; 'view' = Vendors or Finance view; 'money' = Finance view or Vendors edit;
-- 'review' = Finance edit; admin always; own studio only
create or replace function public._vr256_can(p_need text)
returns boolean language sql stable security definer set search_path = '' as $$
  -- vendor-requests-0256
  select case
    when auth.uid() is null or public.current_org_id() is null then false
    when public.user_role() = 'admin' then true
    when p_need = 'assign' then coalesce(public.has_area('vendors', 'edit'), false)
    when p_need = 'view' then coalesce(public.has_area('vendors', 'view'), false) or coalesce(public.has_area('finance', 'view'), false)
    when p_need = 'money' then coalesce(public.has_area('finance', 'view'), false) or coalesce(public.has_area('vendors', 'edit'), false)
    when p_need = 'review' then coalesce(public.has_area('finance', 'edit'), false)
    else false end;
$$;

create or replace function public._vr256_clean(p text, p_max integer)
returns text language sql immutable set search_path = '' as $$
  select left(nullif(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]+', ' ', 'g')), ''), p_max);
$$;

create or replace function public._vr256_fy(p date)
returns text language sql immutable set search_path = '' as $$
  -- India financial year April - March: 15/03/2027 -> 2026-27, 01/04/2027 -> 2027-28
  select case when extract(month from p) >= 4
              then extract(year from p)::int::text || '-' || lpad(((extract(year from p)::int + 1) % 100)::text, 2, '0')
              else (extract(year from p)::int - 1)::text || '-' || lpad((extract(year from p)::int % 100)::text, 2, '0') end;
$$;

create or replace function public._vr256_log(p_r uuid, p_org uuid, p_event text, p_note text, p_kind text, p_actor uuid, p_label text)
returns void language sql volatile security definer set search_path = '' as $$
  insert into public.vendor_request_log(request_id, org_id, event, note, actor_kind, actor_id, actor_label)
    values (p_r, p_org, p_event, public._vr256_clean(p_note, 600), p_kind, p_actor, left(p_label, 160));
$$;

create or replace function public._vr256_label(p_uid uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(public._dl241_actor_label(p_uid), 'Studio member');
$$;

-- a fresh link (raw token returned once; only its hash is kept)
create or replace function public._vr256_issue(p_r public.vendor_requests, p_via text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_tok text; v_exp timestamptz;
begin
  v_tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_exp := least(greatest(p_r.when_at + interval '90 days', now() + interval '7 days'), now() + interval '180 days');
  insert into public.vendor_request_links(token_hash, request_id, org_id, issued_via, expires_at)
    values (public._vr256_hash(v_tok), p_r.id, p_r.org_id, p_via, v_exp);
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp, 'expires_text', public._dl241_when(v_exp, p_r.org_id));
end $$;

create or replace function public._vr256_link(p_token text)
returns public.vendor_request_links language plpgsql stable security definer set search_path = '' as $$
declare l public.vendor_request_links;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return null; end if;
  select * into l from public.vendor_request_links x where x.token_hash = public._vr256_hash(p_token) and x.expires_at > now();
  return l;
end $$;

-- money on an approved invoice's bill: paid so far + what is left (paid / partial / due)
create or replace function public._vr256_inv(p_i public.vendor_invoices, p_studio boolean)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p_i.id, 'invoice_no', p_i.invoice_no, 'invoice_date', to_char(p_i.invoice_date, 'DD/MM/YYYY'),
      'invoice_date_iso', p_i.invoice_date, 'fy', p_i.fy,
      'taxable_amount', p_i.taxable_amount, 'cgst', p_i.cgst, 'sgst', p_i.sgst, 'igst', p_i.igst, 'total_amount', p_i.total_amount,
      'vendor_gstin', p_i.vendor_gstin, 'notes', p_i.notes, 'status', p_i.status, 'review_note', p_i.review_note,
      'has_file', p_i.storage_path is not null, 'submitted_text', public._dl241_when(p_i.submitted_at, p_i.org_id),
      'paid', pay.paid, 'balance', case when p_i.bill_id is not null then greatest(p_i.total_amount - pay.paid, 0) end,
      'pay_status', case when p_i.bill_id is null then null when pay.paid <= 0 then 'due'
                         when pay.paid + 0.005 >= p_i.total_amount then 'paid' else 'partial' end)
    || case when p_studio then jsonb_build_object('storage_path', p_i.storage_path, 'mime', p_i.mime, 'bill_id', p_i.bill_id,
         'replaces_id', p_i.replaces_id, 'gst_claimable', p_i.gst_claimable, 'tds_section', p_i.tds_section, 'tds_amount', p_i.tds_amount,
         'reviewed_text', public._dl241_when(p_i.reviewed_at, p_i.org_id), 'reviewed_by', public._vr256_label(p_i.reviewed_by),
         'request_id', p_i.request_id, 'quote_id', p_i.quote_id,
         'possible_duplicate', exists (select 1 from public.vendor_bills b where b.org_id = p_i.org_id and b.vendor_id = p_i.vendor_id
                                         and b.status <> 'void' and upper(btrim(coalesce(b.bill_no, ''))) = p_i.invoice_no
                                         and b.id is distinct from p_i.bill_id))
       else '{}'::jsonb end
  from (select coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = p_i.bill_id), 0) as paid) pay;
$$;

-- one request as the studio sees it (amounts only with 'money')
create or replace function public._vr256_row(p_r public.vendor_requests)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_money boolean := public._vr256_can('money'); v jsonb; v_inv jsonb; v_billed numeric; v_appr numeric;
begin
  select coalesce(jsonb_agg(public._vr256_inv(i, true) order by i.submitted_at), '[]'::jsonb),
         coalesce(sum(i.total_amount) filter (where i.status in ('submitted', 'queried', 'approved')), 0),
         coalesce(sum(i.total_amount) filter (where i.status = 'approved'), 0)
    into v_inv, v_billed, v_appr
    from public.vendor_invoices i where i.request_id = p_r.id and i.org_id = p_r.org_id;
  v := jsonb_build_object('id', p_r.id, 'quote_id', p_r.quote_id, 'vendor_id', p_r.vendor_id, 'vendor_name', p_r.vendor_name,
    'contact_email', p_r.contact_email, 'contact_phone', p_r.contact_phone, 'booking_id', p_r.booking_id,
    'what', p_r.what, 'qty', p_r.qty, 'when_at', p_r.when_at, 'when_text', public._dl241_when(p_r.when_at, p_r.org_id),
    'where_text', p_r.where_text, 'details', p_r.details, 'respond_by', p_r.respond_by,
    'respond_by_text', public._dl241_when(p_r.respond_by, p_r.org_id), 'status', p_r.status, 'response_note', p_r.response_note,
    'responded_text', public._dl241_when(p_r.responded_at, p_r.org_id), 'responded_via', p_r.responded_via,
    'replaces_id', p_r.replaces_id, 'replaced_by', p_r.replaced_by, 'delivery_id', p_r.delivery_id,
    'no_response', p_r.no_response_at is not null, 'overdue_reply', p_r.status = 'sent' and p_r.respond_by < now(),
    'created_text', public._dl241_when(p_r.created_at, p_r.org_id), 'created_by', public._vr256_label(p_r.created_by),
    'event_title', (select q.title from public.quotes q where q.id = p_r.quote_id),
    'event_code', (select q.code from public.quotes q where q.id = p_r.quote_id),
    'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = p_r.quote_id),
    'invoices_open', (select count(*) from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'submitted'),
    'invoices_queried', (select count(*) from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'queried'),
    'invoices_approved', (select count(*) from public.vendor_invoices i where i.request_id = p_r.id and i.status = 'approved'),
    'emails_queued', (select count(*) from public.vendor_request_sends s where s.request_id = p_r.id and s.channel = 'email' and s.status = 'pending'),
    'emails_sent', (select count(*) from public.vendor_request_sends s where s.request_id = p_r.id and s.channel = 'email' and s.status = 'sent'),
    'can_money', v_money, 'can_assign', public._vr256_can('assign'), 'can_review', public._vr256_can('review'));
  if v_money then
    v := v || jsonb_build_object('agreed_amount', p_r.agreed_amount, 'currency', p_r.currency, 'invoices', v_inv,
      'billed', v_billed, 'approved_total', v_appr, 'over_agreed', v_billed > p_r.agreed_amount + 0.005);
  else
    v := v || jsonb_build_object('agreed_amount', null, 'invoices', '[]'::jsonb);
  end if;
  return v;
end $$;

-- what the vendor's link shows: only their request + their own invoices (no client, no other vendor, no studio money)
create or replace function public._vr256_public(p_r public.vendor_requests)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'vendor_name', p_r.vendor_name, 'what', p_r.what, 'qty', p_r.qty,
    'when_text', public._dl241_when(p_r.when_at, p_r.org_id), 'where_text', p_r.where_text, 'details', p_r.details,
    'agreed_amount', p_r.agreed_amount, 'currency', p_r.currency, 'status', p_r.status, 'response_note', p_r.response_note,
    'respond_by_text', public._dl241_when(p_r.respond_by, p_r.org_id),
    'event', (select coalesce(nullif(btrim(q.title), ''), 'the event') from public.quotes q where q.id = p_r.quote_id),
    'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = p_r.quote_id),
    'venue', (select left(nullif(btrim(ep.venue_name), ''), 160) from public.event_plan ep where ep.quote_id = p_r.quote_id limit 1),
    'studio', (select o.name from public.organizations o where o.id = p_r.org_id),
    'can_respond', p_r.status = 'sent' and not coalesce(public._trial_locked(p_r.org_id), false),
    'can_invoice', p_r.status = 'accepted' and not coalesce(public._trial_locked(p_r.org_id), false),
    'invoices', coalesce((select jsonb_agg(public._vr256_inv(i, false) order by i.submitted_at)
                            from public.vendor_invoices i where i.request_id = p_r.id), '[]'::jsonb),
    'max_file_mb', 10);
$$;

-- the one-line notice posted in the event chat + the bell (emoji as chr() so this file stays ASCII; no money)
create or replace function public._vr256_text(p_r public.vendor_requests, p_event text, p_note text, p_extra text)
returns text language plpgsql stable security definer set search_path = '' as $$
declare v_what text; v text; v_code text; v_note text := public._vr256_clean(p_note, 300);
begin
  v_what := p_r.what || case when p_r.qty is not null then ' x' || trim(to_char(p_r.qty, 'FM9999999990.##'), '.') else '' end;
  select q.code into v_code from public.quotes q where q.id = p_r.quote_id;
  v := case p_event
    when 'accepted'    then chr(9989) || ' ' || p_r.vendor_name || ' accepted: ' || v_what || ' (' || public._dl241_when(p_r.when_at, p_r.org_id) || ')'
    when 'rejected'    then chr(10006) || ' ' || p_r.vendor_name || ' declined: ' || v_what || coalesce(' - ' || v_note, '')
    when 'no_response' then chr(9200) || ' No reply from ' || p_r.vendor_name || ' to the request for ' || v_what
                            || ' (reply was due ' || public._dl241_when(p_r.respond_by, p_r.org_id) || ')'
    when 'invoice'     then chr(129534) || ' ' || p_r.vendor_name || ' sent invoice ' || coalesce(p_extra, '') || ' for ' || v_what || ' - waiting for approval'
    when 'reassigned'  then chr(128257) || ' ' || v_what || ' reassigned from ' || p_r.vendor_name || ' to ' || coalesce(p_extra, 'another vendor')
    else chr(128230) || ' ' || p_r.vendor_name || ': ' || v_what || ' - ' || coalesce(p_event, 'updated') end;
  if p_event = 'accepted' and v_note is not null then v := v || ' - ' || v_note; end if;
  if v_code is not null then v := v || ' ' || chr(183) || ' ' || v_code; end if;
  return left(v, 600);
end $$;

-- post into the event's team chat group (Helm system message @admins + coordinators + the sender) and the bell.
-- Never blocks the caller (errors are swallowed). Sample (demo) events stay quiet.
create or replace function public._vr256_announce(p_id uuid, p_event text, p_note text, p_extra text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare r public.vendor_requests; v_txt text; v_conv uuid; v_ment jsonb; v_ops jsonb; v_done boolean := false;
begin
  select * into r from public.vendor_requests x where x.id = p_id;
  if r.id is null then return false; end if;
  if exists (select 1 from public.quotes q where q.id = r.quote_id and coalesce(q.is_demo, false)) then return false; end if;
  v_txt := public._vr256_text(r, p_event, p_note, p_extra);
  begin
    select x.id into v_conv from public.chat_conversations x where x.quote_id = r.quote_id and x.org_id = r.org_id and x.kind = 'group'
     order by x.created_at limit 1;
    if v_conv is not null then
      select coalesce(jsonb_agg(to_jsonb(u.id)), '[]'::jsonb) into v_ment
        from (select p.id from public.profiles p where p.org_id = r.org_id and p.role = 'admin'
              union select r.created_by where r.created_by is not null
              -- coordinators of the same studio, only when they are in the group (the bell row reaches every one)
              union select p.id from public.profiles p
                     join public.chat_members m on m.conversation_id = v_conv and m.user_id = p.id and m.org_id = r.org_id
                    where p.org_id = r.org_id and p.role = 'coordinator') u;
      insert into public.chat_messages(conversation_id, org_id, sender_id, kind, body, meta)
        values (v_conv, r.org_id, null, 'system', v_txt,
                jsonb_build_object('mentions', v_ment, 'vendor_request_id', r.id));
      begin update public.chat_conversations set last_message_at = now() where id = v_conv; exception when others then null; end;
      v_done := true;
    end if;
  exception when others then raise warning 'vendor-requests-0256: chat post skipped (%)', sqlstate;
  end;
  begin
    select coalesce(jsonb_agg(to_jsonb(p.id) order by p.id), '[]'::jsonb) into v_ops
      from public.profiles p where p.org_id = r.org_id and p.role in ('admin', 'coordinator', 'manager');
    insert into public.notifications(quote_id, channel, kind, status, detail, org_id)
      values (r.quote_id, 'in_app', 'event_reminder', 'simulated',
              jsonb_build_object('label', v_txt, 'via', 'comms', 'source', '0256', 'vendor_request_id', r.id, 'event', p_event,
                                 'notify', v_ops, 'link', 'vendors.html?tab=requests&quote=' || r.quote_id::text), r.org_id);
    v_done := true;
  exception when others then raise warning 'vendor-requests-0256: bell row skipped (%)', sqlstate;
  end;
  return v_done;
end $$;

-- why this request may not be e-mailed / WhatsApped (null = it may): sample events, sample master, free trials
-- (no outside messages from a trial - copy the link instead), ended trials
create or replace function public._vr256_block(p_r public.vendor_requests, p_to text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.quotes q where q.id = p_r.quote_id and coalesce(q.is_demo, false)) then return 'sample_event'; end if;
  if coalesce(public._tb179_no_send(p_r.org_id), false) then return 'trial_no_send'; end if;
  return public._dl241_send_block(p_r.org_id, case when p_to ~ '@' then p_to else 'x@x.test' end, false);
end $$;

-- queue the request / a reminder for every channel the vendor has (dormant until comms-dispatch claims it)
create or replace function public._vr256_queue(p_r public.vendor_requests, p_kind text, p_slot text)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_n integer := 0; v_block text; c record;
begin
  if not p_r.reminders_on and p_kind = 'reminder' then return 0; end if;
  for c in select * from (values ('email', p_r.contact_email), ('whatsapp', p_r.contact_phone)) x(channel, rcpt) where x.rcpt is not null loop
    v_id := null;
    insert into public.vendor_request_sends(org_id, request_id, kind, channel, recipient, dedupe_key)
      values (p_r.org_id, p_r.id, p_kind, c.channel, c.rcpt, 'vr:' || p_r.id || ':' || p_slot || ':' || c.channel)
      on conflict (dedupe_key) do nothing returning id into v_id;
    if v_id is null then continue; end if;
    v_block := public._vr256_block(p_r, c.rcpt);
    if v_block is not null then
      update public.vendor_request_sends set status = 'skipped', reason = v_block, sent_at = now() where id = v_id;
    else v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

-- an accepted request: its booking is confirmed at the agreed amount (Committed) + a 0241 delivery assignment
create or replace function public._vr256_on_accept(p_id uuid, p_kind text, p_actor uuid, p_label text)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare r public.vendor_requests; b public.event_resources; v_d uuid;
begin
  select * into r from public.vendor_requests x where x.id = p_id for update;
  if r.booking_id is not null then
    select * into b from public.event_resources x where x.id = r.booking_id and x.org_id = r.org_id for update;
    if b.id is not null and b.status <> 'cancelled' then
      update public.event_resources set status = case when status in ('confirmed', 'delivered') then status else 'confirmed' end,
          cost = r.agreed_amount, vendor_id = coalesce(r.vendor_id, vendor_id), updated_at = now()
        where id = b.id;
      perform public._vr256_log(r.id, r.org_id, 'booking_confirmed',
        'Booking ' || coalesce(b.status, '') || ' -> ' || case when b.status in ('confirmed', 'delivered') then b.status else 'confirmed' end
          || '; cost ' || coalesce(trim(to_char(b.cost, 'FM999999999990.00')), 'empty') || ' -> ' || trim(to_char(r.agreed_amount, 'FM999999999990.00')),
        p_kind, p_actor, p_label);
    end if;
  end if;
  -- the r21 reminder engine takes the delivery from here (reminders before when_at, status link, chat updates)
  if r.delivery_id is null and r.when_at > now() and r.when_at < now() + interval '400 days' then
    insert into public.delivery_commitments(org_id, quote_id, what, qty, party_kind, vendor_id, party_name, contact_email, due_at, note,
        source, booking_id, reminders_on, status_by, created_by)
      values (r.org_id, r.quote_id, left(r.what, 200), r.qty, 'vendor', r.vendor_id, left(r.vendor_name, 120), r.contact_email, r.when_at,
        'From the accepted vendor request', 'resource', r.booking_id, true, left(p_label, 160), r.created_by)
      returning id into v_d;
    perform public._dl241_log(v_d, r.org_id, 'scheduled', 'From the accepted vendor request', null, case when p_kind = 'link' then 'link' else 'user' end, p_actor, p_label);
    update public.vendor_requests set delivery_id = v_d where id = r.id;
  end if;
end $$;

-- a closed request (reassigned / cancelled): its delivery assignment is cancelled too (kept, logged)
create or replace function public._vr256_close_delivery(p_r public.vendor_requests, p_actor uuid, p_label text)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_r.delivery_id is null then return; end if;
  update public.delivery_commitments set status = 'cancelled', status_at = now(), status_by = left(p_label, 160), updated_at = now()
   where id = p_r.delivery_id and org_id = p_r.org_id and status <> 'cancelled';
  if found then perform public._dl241_log(p_r.delivery_id, p_r.org_id, 'cancelled', 'Vendor request closed', null, 'user', p_actor, p_label); end if;
end $$;

-- ---- 3) the studio side (signed in, own studio) -------------------------------------------------------------------
-- create one request (and its booking when none is given); returns the row + a link to copy (shown once)
create or replace function public.vendor_request_save(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); k text; r public.vendor_requests;
  v_quote uuid; v_vendor uuid; v public.vendors; v_book uuid; b public.event_resources; v_created boolean := false;
  v_what text; v_qty numeric; v_when timestamptz; v_where text; v_det text; v_amt numeric; v_rby timestamptz;
  v_email text; v_phone text; v_link jsonb; v_queued integer;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'request must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('quote_id', 'vendor_id', 'booking_id', 'what', 'qty', 'when_at', 'where_text', 'details', 'agreed_amount', 'respond_by', 'send') then
      raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  if public.rate_hit('vendor_request_save', v_me::text, 3600, 120) > 0 then raise exception 'Too many requests - try again later' using errcode = '54000'; end if;
  begin v_quote := (p ->> 'quote_id')::uuid; exception when others then raise exception 'bad event' using errcode = '22023'; end;
  if v_quote is null or not exists (select 1 from public.quotes q where q.id = v_quote and q.org_id = v_org and q.deleted_at is null and q.status <> 'cancelled') then
    raise exception 'event not found' using errcode = 'P0002'; end if;
  begin v_vendor := (p ->> 'vendor_id')::uuid; exception when others then raise exception 'bad vendor' using errcode = '22023'; end;
  select * into v from public.vendors x where x.id = v_vendor and x.org_id = v_org;
  if v.id is null then raise exception 'vendor not found' using errcode = 'P0002'; end if;
  if v.active = false then raise exception 'this vendor is inactive - reactivate them first' using errcode = '22023'; end if;
  v_what := btrim(coalesce(p ->> 'what', ''));
  if char_length(v_what) not between 1 and 200 or v_what ~ '[<>]' then raise exception 'say what is needed (1-200 characters, no < or >)' using errcode = '22023'; end if;
  if p ? 'qty' and jsonb_typeof(p -> 'qty') not in ('null') then
    if jsonb_typeof(p -> 'qty') <> 'number' or (p ->> 'qty')::numeric <= 0 or (p ->> 'qty')::numeric > 1000000 then
      raise exception 'quantity must be a number above 0' using errcode = '22023'; end if;
    v_qty := (p ->> 'qty')::numeric;
  end if;
  begin v_when := (p ->> 'when_at')::timestamptz; exception when others then raise exception 'enter when it is needed (date and time)' using errcode = '22023'; end;
  if v_when is null then raise exception 'enter when it is needed (date and time)' using errcode = '22023'; end if;
  if v_when < now() - interval '1 day' or v_when > now() + interval '400 days' then raise exception 'the time must be within the next 400 days' using errcode = '22023'; end if;
  v_where := public._vr256_clean(p ->> 'where_text', 300);
  v_det := public._vr256_clean(p ->> 'details', 1000);
  if coalesce(v_where, '') ~ '[<>]' or coalesce(v_det, '') ~ '[<>]' then raise exception 'where / details may not contain < or >' using errcode = '22023'; end if;
  if char_length(coalesce(p ->> 'where_text', '')) > 300 or char_length(coalesce(p ->> 'details', '')) > 1000 then
    raise exception 'where: up to 300 characters, details: up to 1000' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'agreed_amount') is distinct from 'number' or (p ->> 'agreed_amount')::numeric < 0 or (p ->> 'agreed_amount')::numeric >= 1000000000000 then
    raise exception 'enter the agreed amount (0 or more)' using errcode = '22023'; end if;
  v_amt := round((p ->> 'agreed_amount')::numeric, 2);
  if nullif(p ->> 'respond_by', '') is not null then
    begin v_rby := (p ->> 'respond_by')::timestamptz; exception when others then raise exception 'bad reply-by time' using errcode = '22023'; end;
    if v_rby < now() + interval '30 minutes' or v_rby > now() + interval '30 days' then raise exception 'the reply-by time must be between 30 minutes and 30 days from now' using errcode = '22023'; end if;
  else
    v_rby := greatest(least(now() + interval '48 hours', v_when - interval '12 hours'), now() + interval '2 hours');
  end if;
  v_email := case when public._dl241_email_ok(v.email) then lower(btrim(v.email)) end;
  v_phone := case when regexp_replace(coalesce(v.phone, ''), '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' then regexp_replace(v.phone, '[\s().-]', '', 'g') end;
  -- the booking: one given (same event, not cancelled, its vendor empty or this one, no live request) or a new one
  if nullif(p ->> 'booking_id', '') is not null then
    begin v_book := (p ->> 'booking_id')::uuid; exception when others then raise exception 'bad booking' using errcode = '22023'; end;
    select * into b from public.event_resources x where x.id = v_book and x.org_id = v_org and x.quote_id = v_quote for update;
    if b.id is null then raise exception 'booking not found on this event' using errcode = 'P0002'; end if;
    if b.status = 'cancelled' then raise exception 'this booking was cancelled' using errcode = '22023'; end if;
    if b.vendor_id is not null and b.vendor_id <> v.id then raise exception 'this booking is with another vendor - use Reassign' using errcode = '22023'; end if;
    if exists (select 1 from public.vendor_requests x where x.booking_id = b.id and x.status in ('sent', 'accepted')) then
      raise exception 'this booking already has an open request' using errcode = '23505'; end if;
    if b.vendor_id is null then update public.event_resources set vendor_id = v.id, updated_at = now() where id = b.id; end if;
  else
    insert into public.event_resources(quote_id, vendor_id, kind, label, qty, cost, status, note, created_by, org_id)
      values (v_quote, v.id, coalesce(v.kind, 'vendor'), left(v_what, 200), v_qty, v_amt, 'enquiry', 'Vendor request (Helm)', v_me, v_org)
      returning id into v_book;
    v_created := true;
  end if;
  insert into public.vendor_requests(org_id, quote_id, vendor_id, vendor_name, contact_email, contact_phone, booking_id, booking_created,
      what, qty, when_at, where_text, details, agreed_amount, respond_by, created_by)
    values (v_org, v_quote, v.id, left(btrim(v.name), 120), v_email, v_phone, v_book, v_created,
      v_what, v_qty, v_when, v_where, v_det, v_amt, v_rby, v_me)
    returning * into r;
  perform public._vr256_log(r.id, v_org, 'sent', case when v_created then 'New booking created for this request' end, 'user', v_me, public._vr256_label(v_me));
  v_queued := case when coalesce((p ->> 'send')::boolean, true) then public._vr256_queue(r, 'request', 'request') else 0 end;
  v_link := public._vr256_issue(r, 'copy');
  return public._vr256_row(r) || jsonb_build_object('link', v_link, 'queued', v_queued);
end $$;

-- the planner got the answer another way (phone / WhatsApp): record it the same way the link would
create or replace function public.vendor_request_set_status(p_id uuid, p_status text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests; v_note text := public._vr256_clean(p_note, 500);
  v_label text;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_status is null or p_status not in ('accepted', 'rejected') then raise exception 'unknown status' using errcode = '22023'; end if;
  if coalesce(v_note, '') ~ '[<>]' then raise exception 'note: no < or >' using errcode = '22023'; end if;
  if p_status = 'rejected' and char_length(coalesce(v_note, '')) < 3 then raise exception 'say why the vendor declined' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = p_id and x.org_id = v_org for update;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status <> 'sent' then raise exception 'this request was already answered or closed' using errcode = '22023'; end if;
  v_label := public._vr256_label(v_me) || ' (for ' || r.vendor_name || ')';
  update public.vendor_requests set status = p_status, response_note = v_note, responded_at = now(), responded_via = 'studio', updated_at = now()
   where id = r.id returning * into r;
  perform public._vr256_log(r.id, v_org, p_status, v_note, 'user', v_me, v_label);
  if p_status = 'accepted' then perform public._vr256_on_accept(r.id, 'user', v_me, v_label); end if;
  perform public._vr256_announce(r.id, p_status, v_note, null);
  select * into r from public.vendor_requests x where x.id = p_id;
  return public._vr256_row(r);
end $$;

-- reassign to another vendor: the old request is kept as 'reassigned' (history), the booking moves, a new request goes out
create or replace function public.vendor_request_reassign(p_id uuid, p_vendor uuid, p_agreed numeric default null, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests; n public.vendor_requests; v public.vendors;
  b public.event_resources; v_note text := public._vr256_clean(p_note, 500); v_amt numeric; v_email text; v_phone text; v_link jsonb; v_q integer;
  v_label text;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if coalesce(v_note, '') ~ '[<>]' then raise exception 'note: no < or >' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = p_id and x.org_id = v_org for update;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status not in ('sent', 'accepted', 'rejected') then raise exception 'this request is already closed' using errcode = '22023'; end if;
  if r.replaced_by is not null then raise exception 'this request was already reassigned' using errcode = '22023'; end if;
  if exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status in ('submitted', 'queried', 'approved')) then
    raise exception 'this vendor has already invoiced - settle or reject the invoice first' using errcode = '22023'; end if;
  select * into v from public.vendors x where x.id = p_vendor and x.org_id = v_org;
  if v.id is null then raise exception 'vendor not found' using errcode = 'P0002'; end if;
  if v.active = false then raise exception 'this vendor is inactive - reactivate them first' using errcode = '22023'; end if;
  if v.id = r.vendor_id then raise exception 'pick a different vendor' using errcode = '22023'; end if;
  if p_agreed is not null and (p_agreed < 0 or p_agreed >= 1000000000000) then raise exception 'enter the agreed amount (0 or more)' using errcode = '22023'; end if;
  v_amt := round(coalesce(p_agreed, r.agreed_amount), 2);
  v_label := public._vr256_label(v_me);
  -- close the old request (kept for history); its delivery assignment is cancelled
  if r.status in ('sent', 'accepted') then
    update public.vendor_requests set status = 'reassigned', updated_at = now() where id = r.id;
  end if;
  perform public._vr256_close_delivery(r, v_me, v_label);
  perform public._vr256_log(r.id, v_org, 'reassigned', coalesce('To ' || v.name || coalesce(' - ' || v_note, ''), v_note), 'user', v_me, v_label);
  -- the booking moves to the new vendor and goes back to enquiry until they accept
  if r.booking_id is not null then
    select * into b from public.event_resources x where x.id = r.booking_id and x.org_id = v_org for update;
    if b.id is not null and b.status <> 'cancelled' then
      update public.event_resources set vendor_id = v.id, status = 'enquiry', cost = v_amt, updated_at = now() where id = b.id;
      perform public._vr256_log(r.id, v_org, 'booking_moved', 'Booking vendor ' || r.vendor_name || ' -> ' || v.name || '; status ' || b.status
        || ' -> enquiry; cost ' || coalesce(trim(to_char(b.cost, 'FM999999999990.00')), 'empty') || ' -> ' || trim(to_char(v_amt, 'FM999999999990.00')),
        'user', v_me, v_label);
    end if;
  end if;
  v_email := case when public._dl241_email_ok(v.email) then lower(btrim(v.email)) end;
  v_phone := case when regexp_replace(coalesce(v.phone, ''), '[\s().-]', '', 'g') ~ '^\+[1-9][0-9]{7,14}$' then regexp_replace(v.phone, '[\s().-]', '', 'g') end;
  insert into public.vendor_requests(org_id, quote_id, vendor_id, vendor_name, contact_email, contact_phone, booking_id, booking_created,
      what, qty, when_at, where_text, details, agreed_amount, respond_by, replaces_id, created_by)
    values (v_org, r.quote_id, v.id, left(btrim(v.name), 120), v_email, v_phone,
      case when b.id is not null and b.status <> 'cancelled' then b.id end, r.booking_created,
      r.what, r.qty, r.when_at, r.where_text, r.details, v_amt,
      greatest(least(now() + interval '48 hours', r.when_at - interval '12 hours'), now() + interval '2 hours'), r.id, v_me)
    returning * into n;
  update public.vendor_requests set replaced_by = n.id, updated_at = now() where id = r.id;
  perform public._vr256_log(n.id, v_org, 'sent', 'Reassigned from ' || r.vendor_name, 'user', v_me, v_label);
  perform public._vr256_announce(r.id, 'reassigned', v_note, v.name);
  v_q := public._vr256_queue(n, 'request', 'request');
  v_link := public._vr256_issue(n, 'copy');
  return public._vr256_row(n) || jsonb_build_object('link', v_link, 'queued', v_q);
end $$;

create or replace function public.vendor_request_cancel(p_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests; v_note text := public._vr256_clean(p_reason, 500);
  v_label text;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if char_length(coalesce(v_note, '')) < 3 or v_note ~ '[<>]' then raise exception 'say why it is cancelled (3-500 characters, no < or >)' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = p_id and x.org_id = v_org for update;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status not in ('sent', 'accepted') then raise exception 'this request is already closed' using errcode = '22023'; end if;
  if exists (select 1 from public.vendor_invoices i where i.request_id = r.id and i.status in ('submitted', 'queried', 'approved')) then
    raise exception 'this vendor has already invoiced - settle or reject the invoice first' using errcode = '22023'; end if;
  v_label := public._vr256_label(v_me);
  update public.vendor_requests set status = 'cancelled', updated_at = now() where id = r.id;
  perform public._vr256_log(r.id, v_org, 'cancelled', v_note, 'user', v_me, v_label);
  perform public._vr256_close_delivery(r, v_me, v_label);
  -- a booking made only for this request is cancelled with it (kept; a booking you made yourself stays as it is)
  if r.booking_created and r.booking_id is not null then
    update public.event_resources set status = 'cancelled', updated_at = now() where id = r.booking_id and org_id = v_org and status <> 'cancelled';
    if found then perform public._vr256_log(r.id, v_org, 'booking_cancelled', 'The booking made for this request was cancelled', 'user', v_me, v_label); end if;
  end if;
  select * into r from public.vendor_requests x where x.id = p_id;
  return public._vr256_row(r);
end $$;

-- a fresh link to copy / share another way (raw token shown once)
create or replace function public.vendor_request_link(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); r public.vendor_requests;
begin
  if v_me is null or v_org is null or not public._vr256_can('assign') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  select * into r from public.vendor_requests x where x.id = p_id and x.org_id = v_org;
  if r.id is null then raise exception 'request not found' using errcode = 'P0002'; end if;
  if r.status not in ('sent', 'accepted') then raise exception 'this request is closed' using errcode = '22023'; end if;
  if public.rate_hit('vendor_request_link', v_me::text, 3600, 60) > 0 then raise exception 'Too many links - try again later' using errcode = '54000'; end if;
  return public._vr256_issue(r, 'copy');
end $$;

-- the list: one event (p_quote), one vendor (p_vendor) or the whole studio (newest first, at most 300)
create or replace function public.vendor_requests_list(p_quote uuid default null, p_vendor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public._vr256_can('view') then raise exception 'not authorized' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(public._vr256_row(x) order by x.created_at desc) from (
      select r.* from public.vendor_requests r
        join public.quotes q on q.id = r.quote_id and q.org_id = v_org and q.deleted_at is null
       where r.org_id = v_org and (p_quote is null or r.quote_id = p_quote) and (p_vendor is null or r.vendor_id = p_vendor)
       order by r.created_at desc limit 300) x), '[]'::jsonb);
end $$;

-- counts for the event workspace card (no money)
create or replace function public.vendor_requests_summary(p_quote uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public._vr256_can('view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote and q.org_id = v_org) then raise exception 'event not found' using errcode = 'P0002'; end if;
  return (select jsonb_build_object(
      'awaiting', count(*) filter (where r.status = 'sent'),
      'late', count(*) filter (where r.status = 'sent' and r.respond_by < now()),
      'accepted', count(*) filter (where r.status = 'accepted'),
      'declined', count(*) filter (where r.status = 'rejected' and r.replaced_by is null),
      'invoices_to_review', (select count(*) from public.vendor_invoices i where i.quote_id = p_quote and i.org_id = v_org and i.status = 'submitted'),
      'invoices_queried', (select count(*) from public.vendor_invoices i where i.quote_id = p_quote and i.org_id = v_org and i.status = 'queried'),
      'invoices_unpaid', (select count(*) from public.vendor_invoices i where i.quote_id = p_quote and i.org_id = v_org and i.status = 'approved'
                             and coalesce((select sum(p.amount) from public.vendor_payouts p where p.bill_id = i.bill_id), 0) + 0.005 < i.total_amount))
    from public.vendor_requests r where r.quote_id = p_quote and r.org_id = v_org);
end $$;

create or replace function public.vendor_request_history(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or v_org is null or not public._vr256_can('view') then raise exception 'not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.vendor_requests r where r.id = p_id and r.org_id = v_org) then raise exception 'request not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'log', coalesce((select jsonb_agg(jsonb_build_object('at_text', public._dl241_when(l.at, v_org), 'event', l.event, 'note', l.note,
              'actor_kind', l.actor_kind, 'actor', l.actor_label) order by l.at desc)
       from public.vendor_request_log l where l.request_id = p_id and l.org_id = v_org), '[]'::jsonb),
    'sends', coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'channel', s.channel, 'status', s.status, 'reason', s.reason,
              'at_text', public._dl241_when(coalesce(s.sent_at, s.created_at), v_org)) order by s.created_at desc)
       from public.vendor_request_sends s where s.request_id = p_id and s.org_id = v_org), '[]'::jsonb));
end $$;

-- review an invoice: approve (-> one vendor bill = Actual cost), query (vendor may resubmit) or reject (reason)
create or replace function public.vendor_invoice_review(p_id uuid, p_action text, p_note text default null, p_opts jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_me uuid := auth.uid(); i public.vendor_invoices; r public.vendor_requests;
  v_note text := public._vr256_clean(p_note, 500); k text; v_claim boolean; v_tdss text; v_tdsa numeric; v_due date; v_over boolean := false;
  v_appr numeric; v_bill uuid; v_label text; o jsonb := coalesce(p_opts, '{}'::jsonb);
begin
  if v_me is null or v_org is null or not public._vr256_can('review') then raise exception 'not authorized' using errcode = '42501'; end if;
  if coalesce(public._trial_locked(v_org), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  if p_action is null or p_action not in ('approve', 'query', 'reject') then raise exception 'unknown action' using errcode = '22023'; end if;
  if jsonb_typeof(o) <> 'object' then raise exception 'options must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(o) loop
    if k not in ('gst_claimable', 'tds_section', 'tds_amount', 'allow_over', 'due_date') then raise exception 'unknown option %', k using errcode = '22023'; end if;
  end loop;
  if coalesce(v_note, '') ~ '[<>]' then raise exception 'note: no < or >' using errcode = '22023'; end if;
  if p_action in ('query', 'reject') and char_length(coalesce(v_note, '')) < 3 then
    raise exception 'tell the vendor what is wrong (3-500 characters)' using errcode = '22023'; end if;
  select * into i from public.vendor_invoices x where x.id = p_id and x.org_id = v_org for update;
  if i.id is null then raise exception 'invoice not found' using errcode = 'P0002'; end if;
  if i.status <> 'submitted' then raise exception 'this invoice was already reviewed' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = i.request_id for update;
  v_label := public._vr256_label(v_me);
  if p_action = 'approve' then
    if o ? 'gst_claimable' and jsonb_typeof(o -> 'gst_claimable') not in ('boolean', 'null') then raise exception 'gst_claimable must be true, false or empty' using errcode = '22023'; end if;
    v_claim := case when jsonb_typeof(o -> 'gst_claimable') = 'boolean' then (o ->> 'gst_claimable')::boolean end;
    v_tdss := nullif(upper(btrim(coalesce(o ->> 'tds_section', ''))), '');
    if v_tdss is not null and v_tdss !~ '^19[0-9][A-Z]{0,3}$' then raise exception 'TDS section looks wrong (e.g. 194C, 194J)' using errcode = '22023'; end if;
    if o ? 'tds_amount' and jsonb_typeof(o -> 'tds_amount') not in ('number', 'null') then raise exception 'TDS amount must be a number' using errcode = '22023'; end if;
    v_tdsa := case when jsonb_typeof(o -> 'tds_amount') = 'number' then round((o ->> 'tds_amount')::numeric, 2) end;
    if v_tdsa is not null and (v_tdsa < 0 or v_tdsa > i.total_amount) then raise exception 'TDS cannot be more than the invoice' using errcode = '22023'; end if;
    if v_tdsa is not null and v_tdsa > 0 and v_tdss is null then raise exception 'pick the TDS section' using errcode = '22023'; end if;
    if nullif(o ->> 'due_date', '') is not null then
      begin v_due := (o ->> 'due_date')::date; exception when others then raise exception 'bad due date' using errcode = '22023'; end;
      if v_due < i.invoice_date or v_due > i.invoice_date + 365 then raise exception 'the due date must be within a year of the invoice date' using errcode = '22023'; end if;
    end if;
    v_over := coalesce((o ->> 'allow_over')::boolean, false);
    select coalesce(sum(x.total_amount), 0) into v_appr from public.vendor_invoices x where x.request_id = i.request_id and x.status = 'approved';
    if v_appr + i.total_amount > r.agreed_amount + 0.005 and not v_over then
      raise exception 'This takes the vendor to % against % agreed - tick "approve above the agreed amount" to go ahead.',
        trim(to_char(v_appr + i.total_amount, 'FM999999999990.00')), trim(to_char(r.agreed_amount, 'FM999999999990.00'))
        using errcode = '23514', hint = 'over_agreed'; end if;
    -- the bill: the 0246 ledger counts it as the Actual cost of the booking (claimable GST leaves the margin)
    insert into public.vendor_bills(org_id, quote_id, booking_id, vendor_id, bill_no, bill_date, description, amount, due_date,
        gst_amount, gst_claimable, created_by)
      values (v_org, i.quote_id,
        case when exists (select 1 from public.event_resources b where b.id = i.booking_id and b.org_id = v_org and b.quote_id = i.quote_id) then i.booking_id end,
        i.vendor_id, i.invoice_no, i.invoice_date,
        left('Vendor invoice via Helm link: ' || r.what || coalesce(' (GSTIN ' || i.vendor_gstin || ')', ''), 500),
        i.total_amount, v_due, round(i.cgst + i.sgst + i.igst, 2), v_claim, v_me)
      returning id into v_bill;
    update public.vendor_invoices set status = 'approved', reviewed_at = now(), reviewed_by = v_me, review_note = v_note, bill_id = v_bill,
        gst_claimable = v_claim, tds_section = v_tdss, tds_amount = v_tdsa
     where id = i.id returning * into i;
    perform public._vr256_log(r.id, v_org, 'invoice_approved', 'Invoice ' || i.invoice_no || ' approved' || case when v_appr + i.total_amount > r.agreed_amount + 0.005 then ' (above the agreed amount)' else '' end
      || coalesce(' - ' || v_note, ''), 'user', v_me, v_label);
  else
    update public.vendor_invoices set status = case when p_action = 'query' then 'queried' else 'rejected' end,
        reviewed_at = now(), reviewed_by = v_me, review_note = v_note
     where id = i.id returning * into i;
    perform public._vr256_log(r.id, v_org, case when p_action = 'query' then 'invoice_queried' else 'invoice_rejected' end,
      'Invoice ' || i.invoice_no || ': ' || v_note, 'user', v_me, v_label);
  end if;
  return public._vr256_inv(i, true);
end $$;

-- ---- 4) the vendor's link page (signed out: the 64-hex token is the only key) --------------------------------------
create or replace function public.vendor_link_get(p_token text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.vendor_request_links; r public.vendor_requests;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('vendor_link_get', left(public._vr256_hash(p_token), 32), 600, 120) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  update public.vendor_request_links set uses = uses + 1, last_used_at = now() where token_hash = l.token_hash;
  return public._vr256_public(r);
end $$;

create or replace function public.vendor_link_respond(p_token text, p_action text, p_comment text default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.vendor_request_links; r public.vendor_requests; v_note text := public._vr256_clean(p_comment, 500); v_label text;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('vendor_link_respond', left(public._vr256_hash(p_token), 32), 600, 12) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  if p_action is null or p_action not in ('accept', 'reject') then raise exception 'unknown answer' using errcode = '22023'; end if;
  if char_length(coalesce(p_comment, '')) > 500 or coalesce(v_note, '') ~ '[<>]' then raise exception 'comment: up to 500 characters, no < or >' using errcode = '22023'; end if;
  if p_action = 'reject' and char_length(coalesce(v_note, '')) < 3 then raise exception 'please say why you cannot take this' using errcode = '22023'; end if;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  if r.status <> 'sent' or coalesce(public._trial_locked(r.org_id), false) then
    return public._vr256_public(r) || jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  v_label := left(r.vendor_name || ' (vendor link)', 160);
  update public.vendor_requests set status = case when p_action = 'accept' then 'accepted' else 'rejected' end,
      response_note = v_note, responded_at = now(), responded_via = 'link', updated_at = now()
   where id = r.id returning * into r;
  update public.vendor_request_links set uses = uses + 1, last_used_at = now() where token_hash = l.token_hash;
  perform public._vr256_log(r.id, r.org_id, r.status, v_note, 'link', null, v_label);
  if r.status = 'accepted' then perform public._vr256_on_accept(r.id, 'link', null, v_label); end if;
  perform public._vr256_announce(r.id, r.status, v_note, null);
  select * into r from public.vendor_requests x where x.id = l.request_id;
  return public._vr256_public(r);
end $$;

-- one-time upload grant for the invoice file (PDF / image, 10 MB, 20 an hour per link)
create or replace function public.vendor_invoice_upload(p_token text, p_mime text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.vendor_request_links; r public.vendor_requests; v_mime text := lower(btrim(coalesce(p_mime, ''))); v_ext text; v_path text; n integer;
begin
  l := public._vr256_link(p_token);
  if l.token_hash is null then raise exception 'link not valid' using errcode = '42501'; end if;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id;
  if r.id is null or r.status <> 'accepted' then raise exception 'an invoice can be sent once the request is accepted' using errcode = '22023'; end if;
  if coalesce(public._trial_locked(r.org_id), false) then raise exception 'This studio is read-only' using errcode = '25006'; end if;
  v_ext := case v_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  if v_ext is null then raise exception 'the invoice must be a PDF, JPEG, PNG or WebP file' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('helm:vendor-invoice:' || l.token_hash, 0));
  select count(*) into n from public.vendor_invoice_grants g where g.token_hash = l.token_hash and g.created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'too many uploads from this link - try again in an hour' using errcode = '54000'; end if;
  v_path := r.org_id::text || '/' || r.quote_id::text || '/' || r.id::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  insert into public.vendor_invoice_grants(token_hash, request_id, org_id, quote_id, path, mime)
    values (l.token_hash, r.id, r.org_id, r.quote_id, v_path, v_mime);
  return jsonb_build_object('bucket', 'vendor-invoices', 'path', v_path, 'mime', v_mime, 'max_bytes', 10485760);
end $$;

-- submit the invoice (after the file is uploaded with its grant); a resubmission after a query supersedes the old one
create or replace function public.vendor_invoice_submit(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare l public.vendor_request_links; r public.vendor_requests; g public.vendor_invoice_grants; i public.vendor_invoices; k text;
  v_no text; v_date date; v_tax numeric; v_c numeric; v_s numeric; v_ig numeric; v_gstin text; v_notes text; v_old public.vendor_invoices;
  v_path text; v_rep uuid;
begin
  if coalesce(p_token, '') !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false); end if;
  if public.rate_hit('vendor_invoice_submit', left(public._vr256_hash(p_token), 32), 3600, 10) > 0 then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  l := public._vr256_link(p_token);
  if l.token_hash is null then return jsonb_build_object('ok', false); end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'invoice must be an object' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('invoice_no', 'invoice_date', 'taxable_amount', 'cgst', 'sgst', 'igst', 'vendor_gstin', 'notes', 'file_path', 'replaces_id') then
      raise exception 'unknown field %', k using errcode = '22023'; end if;
  end loop;
  select * into r from public.vendor_requests x where x.id = l.request_id and x.org_id = l.org_id for update;
  if r.id is null then return jsonb_build_object('ok', false); end if;
  if r.status <> 'accepted' or coalesce(public._trial_locked(r.org_id), false) then
    return public._vr256_public(r) || jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  v_no := upper(regexp_replace(btrim(coalesce(p ->> 'invoice_no', '')), '\s+', '', 'g'));
  if v_no !~ '^[A-Z0-9/-]{1,16}$' then raise exception 'invoice number: up to 16 letters, digits, - or /' using errcode = '22023'; end if;
  begin v_date := (p ->> 'invoice_date')::date; exception when others then raise exception 'enter the invoice date' using errcode = '22023'; end;
  if v_date is null or v_date > current_date + 1 or v_date < current_date - 400 then raise exception 'the invoice date must be within the last 400 days' using errcode = '22023'; end if;
  foreach k in array array['taxable_amount', 'cgst', 'sgst', 'igst'] loop
    if p ? k and jsonb_typeof(p -> k) not in ('number', 'null') then raise exception '% must be a number', k using errcode = '22023'; end if;
  end loop;
  v_tax := round(coalesce((p ->> 'taxable_amount')::numeric, 0), 2);
  v_c := round(coalesce((p ->> 'cgst')::numeric, 0), 2); v_s := round(coalesce((p ->> 'sgst')::numeric, 0), 2); v_ig := round(coalesce((p ->> 'igst')::numeric, 0), 2);
  if v_tax <= 0 or v_tax >= 1000000000000 then raise exception 'enter the taxable value (above 0)' using errcode = '22023'; end if;
  if v_c < 0 or v_s < 0 or v_ig < 0 then raise exception 'GST cannot be negative' using errcode = '22023'; end if;
  if v_ig > 0 and (v_c > 0 or v_s > 0) then raise exception 'charge IGST (other state) OR CGST + SGST (same state), not both' using errcode = '22023'; end if;
  if abs(v_c - v_s) > 1 then raise exception 'CGST and SGST must be the same amount' using errcode = '22023'; end if;
  if v_c + v_s + v_ig > v_tax * 0.40 then raise exception 'the GST looks too high for this taxable value' using errcode = '22023'; end if;
  v_gstin := nullif(upper(regexp_replace(coalesce(p ->> 'vendor_gstin', ''), '\s+', '', 'g')), '');
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then raise exception 'the GSTIN looks wrong (15 characters, e.g. 36ABCDE1234F1Z5)' using errcode = '22023'; end if;
  if v_gstin is null and v_c + v_s + v_ig > 0 then raise exception 'enter your GSTIN - it is needed when GST is charged' using errcode = '22023'; end if;
  v_notes := public._vr256_clean(p ->> 'notes', 500);
  if char_length(coalesce(p ->> 'notes', '')) > 500 or coalesce(v_notes, '') ~ '[<>]' then raise exception 'notes: up to 500 characters, no < or >' using errcode = '22023'; end if;
  -- the file: an unused grant from THIS link for THIS request, uploaded (object exists), window closed at most 15 minutes ago
  v_path := btrim(coalesce(p ->> 'file_path', ''));
  if v_path = '' then raise exception 'attach the invoice (PDF or photo)' using errcode = '22023'; end if;
  select * into g from public.vendor_invoice_grants x where x.path = v_path and x.token_hash = l.token_hash and x.request_id = r.id
     and x.used_at is null and x.expires_at > now() - interval '15 minutes' for update;
  if g.id is null then raise exception 'upload not found or expired - please attach the invoice again' using errcode = '42501'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'vendor-invoices' and o.name = g.path) then
    raise exception 'the invoice file did not arrive - please attach it again' using errcode = '22023'; end if;
  -- a corrected invoice after a query replaces the queried one (kept as superseded)
  if nullif(p ->> 'replaces_id', '') is not null then
    begin v_rep := (p ->> 'replaces_id')::uuid; exception when others then raise exception 'bad invoice' using errcode = '22023'; end;
    select * into v_old from public.vendor_invoices x where x.id = v_rep and x.request_id = r.id for update;
    if v_old.id is null or v_old.status <> 'queried' then raise exception 'only a queried invoice can be replaced' using errcode = '22023'; end if;
    update public.vendor_invoices set status = 'superseded' where id = v_old.id;
  end if;
  if r.vendor_id is not null and exists (select 1 from public.vendor_invoices x where x.org_id = r.org_id and x.vendor_id = r.vendor_id
       and x.invoice_no = v_no and x.fy = public._vr256_fy(v_date) and x.status in ('submitted', 'queried', 'approved')) then
    raise exception 'invoice % was already sent this financial year - use a new invoice number', v_no using errcode = '23505'; end if;
  insert into public.vendor_invoices(org_id, quote_id, request_id, vendor_id, booking_id, invoice_no, invoice_date, fy, taxable_amount,
      cgst, sgst, igst, total_amount, vendor_gstin, notes, storage_path, mime, replaces_id)
    values (r.org_id, r.quote_id, r.id, r.vendor_id, r.booking_id, v_no, v_date, public._vr256_fy(v_date), v_tax,
      v_c, v_s, v_ig, v_tax + v_c + v_s + v_ig, v_gstin, v_notes, g.path, g.mime, v_old.id)
    returning * into i;
  update public.vendor_invoice_grants set used_at = now() where id = g.id;
  update public.vendor_request_links set uses = uses + 1, last_used_at = now() where token_hash = l.token_hash;
  perform public._vr256_log(r.id, r.org_id, 'invoice_submitted', 'Invoice ' || v_no || case when v_old.id is not null then ' (corrected, replaces the queried one)' else '' end,
    'link', null, left(r.vendor_name || ' (vendor link)', 160));
  perform public._vr256_announce(r.id, 'invoice', null, v_no);
  return public._vr256_public(r) || jsonb_build_object('submitted', i.invoice_no);
end $$;

-- ---- 5) storage: private bucket, write-once keys with a live grant, read by the studio once an invoice points at it --
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vendor-invoices', 'vendor-invoices', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760, allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

create or replace function public.vendor_invoice_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_name, '') ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$'
     and exists (select 1 from public.vendor_invoice_grants g
                   join public.vendor_request_links l on l.token_hash = g.token_hash and l.expires_at > now()
                   join public.vendor_requests r on r.id = g.request_id and r.status = 'accepted'
                  where g.path = p_name and g.used_at is null and g.expires_at > now())
     and not exists (select 1 from storage.objects o where o.bucket_id = 'vendor-invoices' and o.name = p_name);
$$;

create or replace function public.vendor_invoice_file_visible(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public._vr256_can('money')
     and exists (select 1 from public.vendor_invoices i where i.storage_path = p_name and i.org_id = public.current_org_id());
$$;

-- the 0048 upload name guard (a RESTRICTIVE insert policy binds to the function itself, so it is NOT renamed):
-- its current body is copied ONCE to *__pre0256, then replaced in place by a wrapper that knows the new bucket's
-- key shape (the grant itself is checked by vendor_invoice_upload_ok) and delegates everything else unchanged.
do $$ begin
  if to_regprocedure('public.storage_object_name_ok(text,text)') is not null
     and to_regprocedure('public.storage_object_name_ok__pre0256(text,text)') is null then
    execute replace(pg_get_functiondef('public.storage_object_name_ok(text,text)'::regprocedure),
                    'public.storage_object_name_ok(', 'public.storage_object_name_ok__pre0256(');
    execute 'revoke all on function public.storage_object_name_ok__pre0256(text, text) from public';
    execute 'grant execute on function public.storage_object_name_ok__pre0256(text, text) to authenticated, anon, service_role';
  end if;
end $$;
do $$ begin
  if to_regprocedure('public.storage_object_name_ok__pre0256(text,text)') is not null then
    execute $f$
create or replace function public.storage_object_name_ok(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $b$
begin
  -- vendor-requests-0256: vendor invoices = <org>/<event>/<request>/<random>.{pdf|jpg|png|webp} (anon link; grant-bound)
  if p_bucket = 'vendor-invoices' then
    return coalesce(p_name, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png|webp)$';
  end if;
  return public.storage_object_name_ok__pre0256(p_bucket, p_name);
end $b$;
$f$;
    execute 'grant execute on function public.storage_object_name_ok(text, text) to authenticated, anon, service_role';
  end if;
end $$;

drop policy if exists vendor_invoices_link_upload on storage.objects;
create policy vendor_invoices_link_upload on storage.objects for insert to anon, authenticated
  with check ( bucket_id = 'vendor-invoices' and public.vendor_invoice_upload_ok(name) );
drop policy if exists vendor_invoices_studio_read on storage.objects;
create policy vendor_invoices_studio_read on storage.objects for select to authenticated
  using ( bucket_id = 'vendor-invoices' and public.vendor_invoice_file_visible(name) );

-- ---- 6) the scheduler + the dispatcher (service role / pg_cron) ---------------------------------------------------
-- unanswered requests: a reminder 24 h and 48 h after sending (while the reply is still due), then ONE
-- "No reply from X" notice after the reply-by time
create or replace function public.vendor_requests_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare r public.vendor_requests; v_n integer := 0; v_nr integer := 0; v_fire timestamptz; i integer;
begin
  for r in select x.* from public.vendor_requests x join public.quotes q on q.id = x.quote_id and q.org_id = x.org_id
            where x.status = 'sent' and q.deleted_at is null and q.status <> 'cancelled' and x.created_at > now() - interval '40 days' loop
    begin
      for i in 1 .. 2 loop
        v_fire := r.created_at + make_interval(hours => 24 * i);
        if now() >= v_fire and now() < v_fire + interval '6 hours' and v_fire < r.respond_by + interval '1 hour' then
          v_n := v_n + public._vr256_queue(r, 'reminder', 'reminder' || i);
        end if;
      end loop;
      if r.no_response_at is null and now() >= r.respond_by then
        update public.vendor_requests set no_response_at = now() where id = r.id and no_response_at is null;
        perform public._vr256_log(r.id, r.org_id, 'no_response', null, 'system', null, 'Helm (no reply)');
        perform public._vr256_announce(r.id, 'no_response', null, null);
        v_nr := v_nr + 1;
      end if;
    exception when others then raise warning 'vendor-requests-0256: tick skipped one request (%)', sqlstate;
    end;
  end loop;
  return jsonb_build_object('queued', v_n, 'no_response', v_nr);
end $$;

-- comms-dispatch takes due rows of ONE channel (it asks for 'email'; WhatsApp rows wait for a future lane);
-- each is re-checked and gets a fresh link (only its hash kept)
create or replace function public.vendor_request_claim(p_limit integer default 25, p_channel text default 'email')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare s record; v_out jsonb := '[]'::jsonb; v_link jsonb; v_ident jsonb; r public.vendor_requests;
begin
  if p_channel not in ('email', 'whatsapp') then raise exception 'bad channel' using errcode = '22023'; end if;
  update public.vendor_request_sends set status = 'failed', sent_at = now() where sent_at is null and channel = p_channel and attempts >= 5;
  update public.vendor_request_sends set status = 'skipped', reason = 'stale', sent_at = now()
   where sent_at is null and channel = p_channel and created_at < now() - interval '12 hours';
  for s in select x.* from public.vendor_request_sends x
            where x.sent_at is null and x.status = 'pending' and x.channel = p_channel
              and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
            order by x.created_at limit greatest(1, least(coalesce(p_limit, 25), 100)) for update of x skip locked loop
    select * into r from public.vendor_requests q where q.id = s.request_id and q.org_id = s.org_id;
    if r.id is null or r.status <> 'sent'
       or not exists (select 1 from public.quotes q where q.id = r.quote_id and q.deleted_at is null and q.status <> 'cancelled')
       or public._vr256_block(r, s.recipient) is not null
       or s.recipient is distinct from (case when s.channel = 'email' then r.contact_email else r.contact_phone end) then
      update public.vendor_request_sends set status = 'skipped', reason = 'recheck', sent_at = now() where id = s.id;
      continue;
    end if;
    v_link := public._vr256_issue(r, s.channel);
    select jsonb_build_object('from_name', cs.email_from_name, 'reply_to', cs.email_reply_to) into v_ident
      from public.comms_settings cs where cs.org_id = r.org_id;
    update public.vendor_request_sends set claimed_at = now(), attempts = attempts + 1 where id = s.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', s.id, 'to', s.recipient, 'channel', s.channel, 'kind', s.kind,
      'vendor_name', r.vendor_name, 'what', r.what, 'qty', r.qty, 'when_text', public._dl241_when(r.when_at, r.org_id),
      'respond_by_text', public._dl241_when(r.respond_by, r.org_id),
      'event', (select coalesce(nullif(btrim(q.title), ''), 'the event') from public.quotes q where q.id = r.quote_id),
      'event_date', (select to_char(q.event_date, 'DD/MM/YYYY') from public.quotes q where q.id = r.quote_id),
      'studio', (select o.name from public.organizations o where o.id = r.org_id),
      'token', v_link ->> 'token', 'identity', coalesce(v_ident, '{}'::jsonb)));
  end loop;
  return v_out;
end $$;

create or replace function public.vendor_request_mark(p_id uuid, p_status text)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_status not in ('sent', 'skipped', 'failed', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  if p_status = 'retry' then
    update public.vendor_request_sends set claimed_at = null where id = p_id and sent_at is null;
    return 'pending';
  end if;
  update public.vendor_request_sends set status = p_status, sent_at = now() where id = p_id and sent_at is null;
  return p_status;
end $$;

-- ---- 7) grants -------------------------------------------------------------------------------------------------
do $$ declare f text; begin
  -- internal helpers + service-role entry points: no app grants
  foreach f in array array['public.tg_vr256_guard()', 'public._vr256_hash(text)', 'public._vr256_can(text)', 'public._vr256_clean(text, integer)',
      'public._vr256_fy(date)', 'public._vr256_log(uuid, uuid, text, text, text, uuid, text)', 'public._vr256_label(uuid)',
      'public._vr256_issue(public.vendor_requests, text)', 'public._vr256_link(text)', 'public._vr256_inv(public.vendor_invoices, boolean)',
      'public._vr256_row(public.vendor_requests)', 'public._vr256_public(public.vendor_requests)',
      'public._vr256_text(public.vendor_requests, text, text, text)', 'public._vr256_announce(uuid, text, text, text)',
      'public._vr256_block(public.vendor_requests, text)', 'public._vr256_queue(public.vendor_requests, text, text)',
      'public._vr256_on_accept(uuid, text, uuid, text)', 'public._vr256_close_delivery(public.vendor_requests, uuid, text)',
      'public.vendor_requests_tick()', 'public.vendor_request_claim(integer, text)', 'public.vendor_request_mark(uuid, text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.vendor_requests_tick() to service_role;
    grant execute on function public.vendor_request_claim(integer, text) to service_role;
    grant execute on function public.vendor_request_mark(uuid, text) to service_role;
  end if;
  -- the app (signed in; each RPC checks the studio + area itself)
  foreach f in array array['public.vendor_request_save(jsonb)', 'public.vendor_request_set_status(uuid, text, text)',
      'public.vendor_request_reassign(uuid, uuid, numeric, text)', 'public.vendor_request_cancel(uuid, text)',
      'public.vendor_request_link(uuid)', 'public.vendor_requests_list(uuid, uuid)', 'public.vendor_requests_summary(uuid)',
      'public.vendor_request_history(uuid)', 'public.vendor_invoice_review(uuid, text, text, jsonb)',
      'public.vendor_invoice_file_visible(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
  -- the signed-out vendor link page (+ the storage upload gate)
  foreach f in array array['public.vendor_link_get(text)', 'public.vendor_link_respond(text, text, text)',
      'public.vendor_invoice_upload(text, text)', 'public.vendor_invoice_submit(text, jsonb)', 'public.vendor_invoice_upload_ok(text)'] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('grant execute on function %s to anon', f); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('grant execute on function %s to authenticated', f); end if;
  end loop;
end $$;

-- ---- 8) trial retention (0184) knows the new tables (patched in place, as 0241 did; skipped without 0184) ----------
do $$ declare v_def text; begin
  if to_regprocedure('public._tr184_purge_tables()') is not null then
    v_def := pg_get_functiondef('public._tr184_purge_tables()'::regprocedure);
    if position('''vendor_requests''' in v_def) = 0 then
      if (length(v_def) - length(replace(v_def, '''quotes''', ''))) / length('''quotes''') <> 1 then
        raise notice '0256: _tr184_purge_tables has an unexpected body - left unchanged';
      else
        execute replace(v_def, '''quotes''', '''vendor_invoice_grants'', ''vendor_request_links'', ''vendor_request_sends'', ''vendor_invoices'', ''vendor_request_log'', ''vendor_requests'', ''quotes''');
      end if;
    end if;
  end if;
end $$;

-- ---- 9) pg_cron, ONLY if it is already installed (never created here) -----------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_vendor_requests') then
        perform cron.schedule('helm_vendor_requests', '*/15 * * * *', 'select public.vendor_requests_tick()');
      end if;
    exception when others then
      raise notice 'pg_cron present but helm_vendor_requests could not be scheduled (%); schedule it by hand', sqlerrm;
    end;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- VERIFY (every row must say ok = true)
select item, ok from (values
  ('01 six new tables, RLS on, no anon / signed-in table privilege (RPCs only)',
     (select bool_and(c.relrowsecurity) and count(*) = 6 from pg_class c where c.oid in (to_regclass('public.vendor_requests'), to_regclass('public.vendor_request_log'),
        to_regclass('public.vendor_request_links'), to_regclass('public.vendor_request_sends'), to_regclass('public.vendor_invoices'), to_regclass('public.vendor_invoice_grants')))
     and not has_table_privilege('authenticated', 'public.vendor_requests', 'select')
     and not has_table_privilege('anon', 'public.vendor_request_links', 'select')
     and not has_table_privilege('authenticated', 'public.vendor_invoices', 'insert')),
  ('02 studio RPCs signed-in only; the 4 link RPCs also anon; tick / claim / mark service role only',
     has_function_privilege('authenticated', 'public.vendor_request_save(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.vendor_request_save(jsonb)', 'execute')
     and not has_function_privilege('anon', 'public.vendor_invoice_review(uuid,text,text,jsonb)', 'execute')
     and has_function_privilege('anon', 'public.vendor_link_get(text)', 'execute')
     and has_function_privilege('anon', 'public.vendor_link_respond(text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.vendor_invoice_upload(text,text)', 'execute')
     and has_function_privilege('anon', 'public.vendor_invoice_submit(text,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'public.vendor_requests_tick()', 'execute')
     and not has_function_privilege('anon', 'public.vendor_request_claim(integer,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.vendor_request_claim(integer,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._vr256_announce(uuid,text,text,text)', 'execute')),
  ('03 private bucket vendor-invoices (10 MB, PDF / JPEG / PNG / WebP) + its 2 storage policies',
     exists (select 1 from storage.buckets where id = 'vendor-invoices' and not public and file_size_limit = 10485760)
     and (select count(*) from pg_policies where schemaname = 'storage' and policyname in ('vendor_invoices_link_upload', 'vendor_invoices_studio_read')) = 2),
  ('04 the upload name guard knows the new bucket and still delegates the old ones',
     to_regprocedure('public.storage_object_name_ok__pre0256(text,text)') is not null
     and position('vendor-invoices' in (select prosrc from pg_proc where oid = to_regprocedure('public.storage_object_name_ok(text,text)'))) > 0
     and position('storage_object_name_ok__pre0256' in (select prosrc from pg_proc where oid = to_regprocedure('public.storage_object_name_ok(text,text)'))) > 0),
  ('05 one live request per booking; invoice number unique per vendor per financial year',
     to_regclass('public.vendor_requests_live_booking_uq') is not null and to_regclass('public.vendor_invoices_no_uq') is not null
     and public._vr256_fy('2027-03-15') = '2026-27' and public._vr256_fy('2027-04-01') = '2027-28'),
  ('06 pg_cron job helm_vendor_requests scheduled (or pg_cron not installed - then schedule it by hand, owner step 4)',
     case when to_regclass('cron.job') is null then true
          else position('<row>' in query_to_xml('select 1 from cron.job where jobname = ''helm_vendor_requests''', false, false, '')::text) > 0 end),
  ('07 trial retention (0184) purges the request tables with the event',
     to_regprocedure('public._tr184_purge_tables()') is null
     or public._tr184_purge_tables() @> array['vendor_invoice_grants', 'vendor_request_links', 'vendor_request_sends', 'vendor_invoices', 'vendor_request_log', 'vendor_requests']),
  ('08 nothing was sent by this file',
     not exists (select 1 from public.vendor_request_sends where status = 'sent'))
) v(item, ok) order by item;
