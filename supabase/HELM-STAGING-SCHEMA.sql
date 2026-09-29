-- ============================================================================
-- HELM-STAGING-SCHEMA.sql
-- Reconstructed from a READ-ONLY extraction of PRODUCTION (2026-09-25).
-- RUN THIS IN THE **STAGING** PROJECT ONLY (helm-staging / xizehqgeyjcfpzrdymly).
-- Do NOT run against production. Contains SCHEMA + SECURITY only — ZERO data,
-- ZERO auth users, ZERO OTPs/tokens/payments/customer rows, ZERO secrets.
--
-- WHAT THIS FILE CREATES (review before running):
--   * Extensions: pgcrypto, uuid-ossp (in schema `extensions`) — provides
--     gen_random_bytes / crypt / gen_salt used by defaults and functions.
--   * 59 public tables (identical columns, defaults, NOT NULL).
--   * All PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK constraints.
--   * All indexes (partial + composite) not already backed by a constraint.
--   * RLS enabled on every table + all policies (byte-for-byte predicates).
--       - event_sites policies are created on role `public` to MATCH the prod
--         baseline. The WAVE-09 re-scope to `authenticated` is applied
--         SEPARATELY, in staging only, AFTER the baseline is verified.
--   * ~91 functions / RPCs (verbatim bodies, security + search_path preserved).
--   * All triggers (public) + the auth.users -> handle_new_user() hook.
--   * The inventory_availability view.
--   * Grants matching production (incl. layouts NOT granted to anon, and
--     admin/privileged RPCs revoked from PUBLIC/anon).
--
-- NOT included (intentionally): any table ROWS, auth.users rows, storage
--   buckets/objects, Supabase-managed schemas (auth/storage/realtime/vault),
--   pg_stat_statements (monitoring only), service-role keys, DB passwords.
--
-- ORDER: check_function_bodies=false lets functions be created before the
--   tables they read; constraints/indexes/policies/triggers come after tables.
-- ============================================================================

set check_function_bodies = false;
set search_path = public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) EXTENSIONS  (pg_stat_statements is monitoring-only and intentionally omitted)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto   with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- ---------------------------------------------------------------------------
-- 1b) EARLY FUNCTION: current_org_id() is referenced by column DEFAULTs below,
--     so it must exist before the tables are created (a table default cannot
--     call a not-yet-existing function; check_function_bodies=false does not
--     help there). Its body reads public.profiles, which does not exist yet —
--     that is fine because check_function_bodies=false skips body validation.
--     The full/identical definition is re-issued (CREATE OR REPLACE) in §5.
-- ---------------------------------------------------------------------------
create or replace function public.current_org_id()
 returns uuid
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select org_id from public.profiles where id = auth.uid();
$function$;

-- ===========================================================================
-- 2) TABLES  (columns + defaults + NOT NULL only; constraints added in §4)
-- ===========================================================================

create table if not exists public.organizations (
  id uuid not null default gen_random_uuid(),
  name text not null,
  slug text,
  business_email text,
  currency text not null default 'INR'::text,
  timezone text not null default 'Asia/Kolkata'::text,
  gst_number text,
  brand jsonb not null default '{}'::jsonb,
  plan text not null default 'free'::text,
  created_by uuid,
  created_at timestamptz not null default now(),
  location text
);

create table if not exists public.profiles (
  id uuid not null,
  email text,
  full_name text,
  role text not null default 'client'::text,
  created_at timestamptz not null default now(),
  org_id uuid,
  must_change_password boolean not null default false
);

create table if not exists public.app_config (
  key text not null,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.audit_log (
  id uuid not null default gen_random_uuid(),
  actor uuid,
  actor_email text,
  action text not null,
  entity text not null,
  entity_id text,
  quote_id uuid,
  changed jsonb,
  at timestamptz not null default now(),
  org_id uuid default current_org_id()
);

create table if not exists public.chair_types (
  id uuid not null default gen_random_uuid(),
  name text not null,
  price numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.coupons (
  id uuid not null default gen_random_uuid(),
  code text not null,
  kind text not null default 'percent'::text,
  value numeric not null default 0,
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.plate_types (
  id uuid not null default gen_random_uuid(),
  name text not null,
  price numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.dish_catalog (
  id uuid not null default gen_random_uuid(),
  category text not null,
  name text not null,
  kind text not null default 'veg'::text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.menu_templates (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  tier text not null,
  diet text not null,
  name text not null,
  price_per_plate numeric not null default 0,
  dishes jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  seq integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.crew_members (
  id uuid not null default gen_random_uuid(),
  name text not null,
  phone text not null,
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  role text,
  skills jsonb not null default '[]'::jsonb,
  email text,
  emp_type text,
  day_rate numeric,
  notes text,
  org_id uuid not null default current_org_id()
);

create table if not exists public.vendors (
  id uuid not null default gen_random_uuid(),
  name text not null,
  category text,
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  kind text not null default 'vendor'::text,
  email text,
  services jsonb not null default '[]'::jsonb,
  notes text,
  org_id uuid not null default current_org_id()
);

create table if not exists public.inventory_items (
  id uuid not null default gen_random_uuid(),
  name text not null,
  category text,
  total_qty numeric not null default 0,
  unit text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  priority text not null default 'C'::text,
  unit_cost numeric not null default 0,
  org_id uuid not null default current_org_id()
);

create table if not exists public.layouts (
  id uuid not null default gen_random_uuid(),
  name text not null default 'Untitled layout'::text,
  data jsonb not null default '{"items": []}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.layout_rules (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  event_type text not null,
  rules jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  seq integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.checklist_templates (
  id uuid not null default gen_random_uuid(),
  name text not null,
  section text not null default 'logistics'::text,
  items jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.task_templates (
  id uuid not null default gen_random_uuid(),
  category text not null,
  title text not null,
  seq integer not null default 0,
  default_duration_min integer not null default 60,
  org_id uuid not null default current_org_id()
);

create table if not exists public.nurture_templates (
  occasion_type text not null,
  subject text not null,
  body text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.nurture_automation (
  id integer not null default 1,
  enabled boolean not null default false,
  within_days integer not null default 0,
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.role_access (
  role text not null,
  area text not null,
  can_view boolean not null default false,
  can_edit boolean not null default false,
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.invitations (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  email text not null,
  role text not null,
  token text not null default encode(gen_random_bytes(24), 'hex'::text),
  status text not null default 'pending'::text,
  invited_by uuid,
  expires_at timestamptz not null default (now() + '7 days'::interval),
  accepted_at timestamptz,
  accepted_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.leads (
  id uuid not null default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  source text,
  event_type text,
  event_date date,
  budget numeric,
  guest_count integer,
  notes text,
  status text not null default 'new'::text,
  quote_id uuid,
  owner uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.lead_archive (
  id uuid not null default gen_random_uuid(),
  lead_id uuid,
  action text not null,
  name text,
  phone text,
  email text,
  source text,
  event_type text,
  event_date date,
  budget numeric,
  guest_count integer,
  notes text,
  status text,
  quote_id uuid,
  snapshot jsonb not null,
  archived_at timestamptz not null default now(),
  archived_by uuid default auth.uid(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.quotes (
  id uuid not null default gen_random_uuid(),
  code text not null,
  title text not null default 'Untitled event'::text,
  event_type text,
  status text not null default 'quote'::text,
  client jsonb not null default '{}'::jsonb,
  pricing jsonb not null default '{}'::jsonb,
  current_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  confirmed_by uuid,
  approval_token uuid,
  approval_status text not null default 'none'::text,
  manager_id uuid,
  lifecycle_stage text default 'quote'::text,
  event_date date,
  event_time text,
  org_id uuid not null default current_org_id(),
  approval_token_expires_at timestamptz,
  approval_token_revoked_at timestamptz
);

create table if not exists public.quote_versions (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  version_no integer not null,
  label text,
  data jsonb not null default '{"items": []}'::jsonb,
  object_count integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.quotation_versions (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  quote_id uuid not null,
  label text not null,
  pricing jsonb not null default '{}'::jsonb,
  total numeric not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid
);

create table if not exists public.change_requests (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  title text not null,
  detail text,
  price_delta numeric not null default 0,
  cost_delta numeric not null default 0,
  status text not null default 'requested'::text,
  created_at timestamptz not null default now(),
  created_by uuid,
  decided_at timestamptz,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_discovery (
  quote_id uuid not null,
  meet_date date,
  mode text,
  location text,
  attendees text,
  notes text,
  budget_min numeric,
  budget_max numeric,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_requirements (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  service text not null,
  priority text not null default 'mandatory'::text,
  qty integer,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_proposal (
  quote_id uuid not null,
  concept text,
  theme text,
  palette jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  scope jsonb not null default '[]'::jsonb,
  share_token uuid,
  published boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.proposal_risks (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  title text not null,
  severity text not null default 'medium'::text,
  mitigation text,
  status text not null default 'open'::text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_plan (
  quote_id uuid not null,
  venue_name text,
  venue_address text,
  venue_contact text,
  access_notes text,
  package text,
  menu text,
  menu_locked boolean not null default false,
  locked_at timestamptz,
  locked_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  dry_run_at timestamptz,
  briefing_at timestamptz,
  org_id uuid not null default current_org_id(),
  menu_template text,
  menu_plate_price numeric
);

create table if not exists public.event_menu_items (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  dish_id uuid,
  dish_name text not null,
  category text,
  kind text,
  qty numeric,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_checklist (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  section text not null,
  title text not null,
  detail text,
  owner text,
  due_date date,
  qty integer,
  status text not null default 'open'::text,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.run_sheet_items (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  start_time time without time zone,
  duration_min integer,
  title text not null,
  owner text,
  location text,
  note text,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_costs (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  category text,
  description text not null,
  kind text not null default 'internal'::text,
  estimated numeric not null default 0,
  actual numeric,
  booking_id uuid,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_resource_needs (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null default 'other'::text,
  label text not null,
  skill text,
  item_id uuid,
  qty numeric not null default 1,
  note text,
  status text not null default 'open'::text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_resources (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  vendor_id uuid,
  need_id uuid,
  kind text,
  label text not null,
  qty numeric,
  cost numeric,
  advance numeric,
  contract boolean not null default false,
  status text not null default 'enquiry'::text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  settled boolean not null default false,
  settled_at timestamptz,
  org_id uuid not null default current_org_id()
);

create table if not exists public.inventory_reservations (
  id uuid not null default gen_random_uuid(),
  item_id uuid not null,
  quote_id uuid not null,
  qty numeric not null,
  status text not null default 'reserved'::text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.inventory_checkouts (
  id uuid not null default gen_random_uuid(),
  item_id uuid not null,
  quote_id uuid,
  qty_out numeric not null,
  issued_to text not null,
  issued_to_id uuid,
  issued_by uuid default auth.uid(),
  checked_out_at timestamptz not null default now(),
  qty_in numeric,
  returned_by text,
  confirmed_by uuid,
  checked_in_at timestamptz,
  status text not null default 'out'::text,
  note text,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_stock_requests (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  item_id uuid,
  label text not null,
  qty numeric not null default 1,
  status text not null default 'requested'::text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_tasks (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  category text not null,
  title text not null,
  seq integer not null default 0,
  crew_id uuid,
  assignee_name text,
  assignee_phone text,
  status text not null default 'assigned'::text,
  note text,
  planned_end timestamptz,
  buffer_min integer,
  depends_on uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  verify_status text not null default 'unverified'::text,
  verified_by uuid,
  verified_at timestamptz,
  verify_note text,
  planned_start timestamptz,
  triggered_at timestamptz,
  is_special boolean not null default false,
  remind_every_min integer not null default 5,
  last_reminded_at timestamptz,
  assignee_kind text not null default 'in_house'::text,
  vendor_id uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_guests (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  label text not null,
  expected integer not null default 0,
  arrived integer not null default 0,
  note text,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_attendees (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  quote_id uuid not null,
  name text,
  email text,
  ticket_status text not null default 'invited'::text,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);

create table if not exists public.event_day (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null,
  who text not null,
  role text,
  ref_id uuid,
  status text not null default 'expected'::text,
  note text,
  seq integer not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_issues (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null default 'issue'::text,
  title text not null,
  detail text,
  severity text not null default 'medium'::text,
  owner text,
  status text not null default 'open'::text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_refunds (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null default 'refund'::text,
  amount numeric not null default 0,
  reason text,
  status text not null default 'pending'::text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_media (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null default 'photo'::text,
  url text not null,
  caption text,
  in_gallery boolean not null default true,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_ratings (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  kind text not null,
  name text not null,
  stars integer not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_closure (
  quote_id uuid not null,
  client_rating integer,
  feedback text,
  testimonial text,
  media_consent boolean not null default false,
  lessons text,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.expense_claims (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  who text not null,
  description text,
  amount numeric not null default 0,
  status text not null default 'pending'::text,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.payment_milestones (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  label text not null,
  due_date date,
  amount numeric not null default 0,
  status text not null default 'due'::text,
  paid_at timestamptz,
  note text,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid,
  org_id uuid not null default current_org_id()
);

create table if not exists public.quote_payments (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  provider text not null default 'razorpay'::text,
  amount numeric not null default 0,
  currency text not null default 'INR'::text,
  status text not null default 'created'::text,
  link_url text,
  provider_ref text,
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  org_id uuid not null default current_org_id(),
  receipt_no text,
  method text,
  note text,
  idempotency_key text
);

create table if not exists public.quote_consents (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  phone text,
  client_name text,
  terms_version text,
  consent_text text,
  agreed boolean not null default false,
  verified_via_otp boolean not null default false,
  user_agent text,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.quote_otps (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.work_tokens (
  token uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  phone text not null,
  name text,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.notifications (
  id uuid not null default gen_random_uuid(),
  quote_id uuid,
  channel text not null,
  recipient text,
  kind text,
  status text not null default 'simulated'::text,
  detail jsonb,
  created_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.notification_seen (
  user_id uuid not null,
  last_seen_at timestamptz not null default now(),
  org_id uuid not null default current_org_id()
);

create table if not exists public.nurture (
  id uuid not null default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  occasion text,
  occasion_date date,
  next_followup date,
  note text,
  status text not null default 'active'::text,
  quote_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  occasion_type text not null default 'custom'::text,
  recurrence text not null default 'yearly'::text,
  auto_on boolean not null default false,
  last_greeted date,
  org_id uuid not null default current_org_id()
);

create table if not exists public.event_sites (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null default current_org_id(),
  quote_id uuid not null,
  event_type text not null default 'general'::text,
  template text not null default 'soiree'::text,
  slug text not null,
  title text,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'draft'::text,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- END PART 1 (tables). Constraints, indexes, functions, RLS, policies,
-- triggers, view, grants, and the auth hook are appended in later sections.

-- ===========================================================================
-- 3) CONSTRAINTS  (PK / UNIQUE / CHECK / FK) — all tables now exist
-- ===========================================================================

-- organizations / profiles (parents first)
alter table public.organizations add constraint organizations_pkey primary key (id);
alter table public.organizations add constraint organizations_slug_key unique (slug);
alter table public.organizations add constraint organizations_created_by_fkey foreign key (created_by) references auth.users(id);

alter table public.profiles add constraint profiles_pkey primary key (id);
alter table public.profiles add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;
alter table public.profiles add constraint profiles_org_id_fkey foreign key (org_id) references organizations(id);
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin'::text, 'manager'::text, 'planner'::text, 'sales'::text, 'coordinator'::text, 'supervisor'::text, 'quality'::text, 'operations'::text, 'crew'::text, 'worker'::text, 'client'::text]));

alter table public.app_config add constraint app_config_pkey primary key (org_id, key);
alter table public.app_config add constraint app_config_org_fk foreign key (org_id) references organizations(id);

alter table public.audit_log add constraint audit_log_pkey primary key (id);
alter table public.audit_log add constraint audit_log_org_fk foreign key (org_id) references organizations(id);

alter table public.chair_types add constraint chair_types_pkey primary key (id);
alter table public.chair_types add constraint chair_types_org_name_key unique (org_id, name);
alter table public.chair_types add constraint chair_types_org_fk foreign key (org_id) references organizations(id);

alter table public.coupons add constraint coupons_pkey primary key (id);
alter table public.coupons add constraint coupons_org_code_key unique (org_id, code);
alter table public.coupons add constraint coupons_org_fk foreign key (org_id) references organizations(id);
alter table public.coupons add constraint coupons_kind_check check (kind = any (array['percent'::text, 'flat'::text]));

alter table public.plate_types add constraint plate_types_pkey primary key (id);
alter table public.plate_types add constraint plate_types_org_name_key unique (org_id, name);
alter table public.plate_types add constraint plate_types_org_fk foreign key (org_id) references organizations(id);

alter table public.dish_catalog add constraint dish_catalog_pkey primary key (id);
alter table public.dish_catalog add constraint dish_catalog_org_name_key unique (org_id, name);
alter table public.dish_catalog add constraint dish_catalog_org_fk foreign key (org_id) references organizations(id);
alter table public.dish_catalog add constraint dish_catalog_kind_check check (kind = any (array['veg'::text, 'nonveg'::text, 'special'::text]));

alter table public.menu_templates add constraint menu_templates_pkey primary key (id);
alter table public.menu_templates add constraint menu_templates_org_id_tier_diet_key unique (org_id, tier, diet);
alter table public.menu_templates add constraint menu_templates_org_id_fkey foreign key (org_id) references organizations(id);
alter table public.menu_templates add constraint menu_templates_diet_check check (diet = any (array['veg'::text, 'nonveg'::text]));
alter table public.menu_templates add constraint menu_templates_tier_check check (tier = any (array['standard'::text, 'gold'::text, 'premium'::text]));

alter table public.crew_members add constraint crew_members_pkey primary key (id);
alter table public.crew_members add constraint crew_members_org_fk foreign key (org_id) references organizations(id);
alter table public.crew_members add constraint crew_emp_type_chk check (emp_type is null or (emp_type = any (array['full_time'::text, 'part_time'::text, 'on_call'::text])));

alter table public.vendors add constraint vendors_pkey primary key (id);
alter table public.vendors add constraint vendors_org_name_key unique (org_id, name);
alter table public.vendors add constraint vendors_org_fk foreign key (org_id) references organizations(id);
alter table public.vendors add constraint vendors_kind_chk check (kind = any (array['vendor'::text, 'freelancer'::text, 'rental'::text, 'supplier'::text]));

alter table public.inventory_items add constraint inventory_items_pkey primary key (id);
alter table public.inventory_items add constraint inventory_items_org_fk foreign key (org_id) references organizations(id);
alter table public.inventory_items add constraint inventory_items_priority_check check (priority = any (array['A'::text, 'B'::text, 'C'::text]));

alter table public.layouts add constraint layouts_pkey primary key (id);
alter table public.layouts add constraint layouts_org_fk foreign key (org_id) references organizations(id);

alter table public.layout_rules add constraint layout_rules_pkey primary key (id);
alter table public.layout_rules add constraint layout_rules_org_id_event_type_key unique (org_id, event_type);
alter table public.layout_rules add constraint layout_rules_org_id_fkey foreign key (org_id) references organizations(id);

alter table public.checklist_templates add constraint checklist_templates_pkey primary key (id);
alter table public.checklist_templates add constraint checklist_templates_org_fk foreign key (org_id) references organizations(id);
alter table public.checklist_templates add constraint checklist_templates_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.checklist_templates add constraint checklist_templates_section_check check (section = any (array['logistics'::text, 'compliance'::text, 'comms'::text, 'guests'::text]));

alter table public.task_templates add constraint task_templates_pkey primary key (id);
alter table public.task_templates add constraint task_templates_org_cat_title_key unique (org_id, category, title);
alter table public.task_templates add constraint task_templates_org_fk foreign key (org_id) references organizations(id);

alter table public.nurture_templates add constraint nurture_templates_org_pkey primary key (org_id, occasion_type);
alter table public.nurture_templates add constraint nurture_templates_org_fk foreign key (org_id) references organizations(id);

alter table public.nurture_automation add constraint nurture_automation_org_pkey primary key (org_id, id);
alter table public.nurture_automation add constraint nurture_automation_org_fk foreign key (org_id) references organizations(id);
alter table public.nurture_automation add constraint nurture_automation_id_check check (id = 1);

alter table public.role_access add constraint role_access_pkey primary key (org_id, role, area);
alter table public.role_access add constraint role_access_org_fk foreign key (org_id) references organizations(id);

alter table public.invitations add constraint invitations_pkey primary key (id);
alter table public.invitations add constraint invitations_token_key unique (token);
alter table public.invitations add constraint invitations_org_id_fkey foreign key (org_id) references organizations(id) on delete cascade;
alter table public.invitations add constraint invitations_invited_by_fkey foreign key (invited_by) references auth.users(id);
alter table public.invitations add constraint invitations_accepted_by_fkey foreign key (accepted_by) references auth.users(id);
alter table public.invitations add constraint invitations_role_chk check (role = any (array['admin'::text, 'manager'::text, 'planner'::text, 'sales'::text, 'coordinator'::text, 'supervisor'::text, 'operations'::text, 'crew'::text, 'worker'::text, 'client'::text]));

-- quotes (referenced by most event_* tables)
alter table public.quotes add constraint quotes_pkey primary key (id);
alter table public.quotes add constraint quotes_org_code_key unique (org_id, code);
alter table public.quotes add constraint quotes_org_fk foreign key (org_id) references organizations(id);
alter table public.quotes add constraint quotes_confirmed_by_fkey foreign key (confirmed_by) references auth.users(id);
alter table public.quotes add constraint quotes_manager_id_fkey foreign key (manager_id) references auth.users(id);
alter table public.quotes add constraint quotes_status_check check (status = any (array['quote'::text, 'confirmed'::text, 'cancelled'::text]));
alter table public.quotes add constraint quotes_approval_status_chk check (approval_status = any (array['none'::text, 'sent'::text, 'approved'::text, 'paid'::text, 'cancelled'::text]));
alter table public.quotes add constraint quotes_lifecycle_chk check (lifecycle_stage = any (array['lead'::text, 'discovery'::text, 'proposal'::text, 'quote'::text, 'confirmed'::text, 'planning'::text, 'resources'::text, 'ready'::text, 'event_day'::text, 'settlement'::text, 'closed'::text]));

alter table public.leads add constraint leads_pkey primary key (id);
alter table public.leads add constraint leads_org_fk foreign key (org_id) references organizations(id);
alter table public.leads add constraint leads_owner_fkey foreign key (owner) references auth.users(id);
alter table public.leads add constraint leads_quote_id_fkey foreign key (quote_id) references quotes(id) on delete set null;
alter table public.leads add constraint leads_status_check check (status = any (array['new'::text, 'qualified'::text, 'discovery'::text, 'quoted'::text, 'won'::text, 'lost'::text]));

alter table public.lead_archive add constraint lead_archive_pkey primary key (id);
alter table public.lead_archive add constraint lead_archive_org_fk foreign key (org_id) references organizations(id);

alter table public.quote_versions add constraint quote_versions_pkey primary key (id);
alter table public.quote_versions add constraint quote_versions_quote_id_version_no_key unique (quote_id, version_no);
alter table public.quote_versions add constraint quote_versions_org_fk foreign key (org_id) references organizations(id);
alter table public.quote_versions add constraint quote_versions_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.quote_versions add constraint quote_versions_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.quotation_versions add constraint quotation_versions_pkey primary key (id);
alter table public.quotation_versions add constraint quotation_versions_org_id_fkey foreign key (org_id) references organizations(id);
alter table public.quotation_versions add constraint quotation_versions_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.quotation_versions add constraint quotation_versions_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.change_requests add constraint change_requests_pkey primary key (id);
alter table public.change_requests add constraint change_requests_org_fk foreign key (org_id) references organizations(id);
alter table public.change_requests add constraint change_requests_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.change_requests add constraint change_requests_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.change_requests add constraint change_requests_status_check check (status = any (array['requested'::text, 'approved'::text, 'rejected'::text]));

alter table public.event_discovery add constraint event_discovery_pkey primary key (quote_id);
alter table public.event_discovery add constraint event_discovery_org_fk foreign key (org_id) references organizations(id);
alter table public.event_discovery add constraint event_discovery_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_discovery add constraint event_discovery_updated_by_fkey foreign key (updated_by) references auth.users(id);

alter table public.event_requirements add constraint event_requirements_pkey primary key (id);
alter table public.event_requirements add constraint event_requirements_org_fk foreign key (org_id) references organizations(id);
alter table public.event_requirements add constraint event_requirements_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_requirements add constraint event_requirements_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_requirements add constraint event_requirements_priority_check check (priority = any (array['mandatory'::text, 'optional'::text, 'nice'::text]));

alter table public.event_proposal add constraint event_proposal_pkey primary key (quote_id);
alter table public.event_proposal add constraint event_proposal_org_fk foreign key (org_id) references organizations(id);
alter table public.event_proposal add constraint event_proposal_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_proposal add constraint event_proposal_updated_by_fkey foreign key (updated_by) references auth.users(id);

alter table public.proposal_risks add constraint proposal_risks_pkey primary key (id);
alter table public.proposal_risks add constraint proposal_risks_org_fk foreign key (org_id) references organizations(id);
alter table public.proposal_risks add constraint proposal_risks_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.proposal_risks add constraint proposal_risks_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.proposal_risks add constraint proposal_risks_severity_check check (severity = any (array['low'::text, 'medium'::text, 'high'::text]));
alter table public.proposal_risks add constraint proposal_risks_status_check check (status = any (array['open'::text, 'mitigated'::text, 'accepted'::text]));

alter table public.event_plan add constraint event_plan_pkey primary key (quote_id);
alter table public.event_plan add constraint event_plan_org_fk foreign key (org_id) references organizations(id);
alter table public.event_plan add constraint event_plan_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_plan add constraint event_plan_locked_by_fkey foreign key (locked_by) references auth.users(id);
alter table public.event_plan add constraint event_plan_updated_by_fkey foreign key (updated_by) references auth.users(id);

alter table public.event_menu_items add constraint event_menu_items_pkey primary key (id);
alter table public.event_menu_items add constraint event_menu_items_org_fk foreign key (org_id) references organizations(id);
alter table public.event_menu_items add constraint event_menu_items_dish_id_fkey foreign key (dish_id) references dish_catalog(id) on delete set null;
alter table public.event_menu_items add constraint event_menu_items_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.event_checklist add constraint event_checklist_pkey primary key (id);
alter table public.event_checklist add constraint event_checklist_org_fk foreign key (org_id) references organizations(id);
alter table public.event_checklist add constraint event_checklist_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_checklist add constraint event_checklist_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_checklist add constraint event_checklist_section_check check (section = any (array['logistics'::text, 'compliance'::text, 'comms'::text, 'guests'::text, 'teardown'::text]));
alter table public.event_checklist add constraint event_checklist_status_check check (status = any (array['open'::text, 'done'::text, 'na'::text]));

alter table public.run_sheet_items add constraint run_sheet_items_pkey primary key (id);
alter table public.run_sheet_items add constraint run_sheet_items_org_fk foreign key (org_id) references organizations(id);
alter table public.run_sheet_items add constraint run_sheet_items_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.run_sheet_items add constraint run_sheet_items_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.event_resource_needs add constraint event_resource_needs_pkey primary key (id);
alter table public.event_resource_needs add constraint event_resource_needs_org_fk foreign key (org_id) references organizations(id);
alter table public.event_resource_needs add constraint event_resource_needs_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_resource_needs add constraint event_resource_needs_item_id_fkey foreign key (item_id) references inventory_items(id) on delete set null;
alter table public.event_resource_needs add constraint event_resource_needs_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_resource_needs add constraint event_resource_needs_kind_check check (kind = any (array['staff'::text, 'inventory'::text, 'other'::text]));
alter table public.event_resource_needs add constraint event_resource_needs_qty_check check (qty > 0::numeric);
alter table public.event_resource_needs add constraint event_resource_needs_status_check check (status = any (array['open'::text, 'outsourced'::text]));

alter table public.event_resources add constraint event_resources_pkey primary key (id);
alter table public.event_resources add constraint event_resources_org_fk foreign key (org_id) references organizations(id);
alter table public.event_resources add constraint event_resources_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_resources add constraint event_resources_need_id_fkey foreign key (need_id) references event_resource_needs(id) on delete set null;
alter table public.event_resources add constraint event_resources_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_resources add constraint event_resources_vendor_id_fkey foreign key (vendor_id) references vendors(id) on delete set null;
alter table public.event_resources add constraint event_resources_status_check check (status = any (array['enquiry'::text, 'booked'::text, 'confirmed'::text, 'delivered'::text, 'cancelled'::text]));

alter table public.event_costs add constraint event_costs_pkey primary key (id);
alter table public.event_costs add constraint event_costs_org_fk foreign key (org_id) references organizations(id);
alter table public.event_costs add constraint event_costs_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_costs add constraint event_costs_booking_id_fkey foreign key (booking_id) references event_resources(id) on delete set null;
alter table public.event_costs add constraint event_costs_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_costs add constraint event_costs_kind_check check (kind = any (array['internal'::text, 'vendor'::text, 'other'::text]));

alter table public.inventory_reservations add constraint inventory_reservations_pkey primary key (id);
alter table public.inventory_reservations add constraint inventory_reservations_org_fk foreign key (org_id) references organizations(id);
alter table public.inventory_reservations add constraint inventory_reservations_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.inventory_reservations add constraint inventory_reservations_item_id_fkey foreign key (item_id) references inventory_items(id) on delete cascade;
alter table public.inventory_reservations add constraint inventory_reservations_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.inventory_reservations add constraint inventory_reservations_qty_check check (qty > 0::numeric);
alter table public.inventory_reservations add constraint inventory_reservations_status_check check (status = any (array['reserved'::text, 'allocated'::text, 'returned'::text, 'cancelled'::text]));

alter table public.inventory_checkouts add constraint inventory_checkouts_pkey primary key (id);
alter table public.inventory_checkouts add constraint inventory_checkouts_org_fk foreign key (org_id) references organizations(id);
alter table public.inventory_checkouts add constraint inventory_checkouts_confirmed_by_fkey foreign key (confirmed_by) references auth.users(id);
alter table public.inventory_checkouts add constraint inventory_checkouts_issued_by_fkey foreign key (issued_by) references auth.users(id);
alter table public.inventory_checkouts add constraint inventory_checkouts_issued_to_id_fkey foreign key (issued_to_id) references crew_members(id) on delete set null;
alter table public.inventory_checkouts add constraint inventory_checkouts_item_id_fkey foreign key (item_id) references inventory_items(id) on delete cascade;
alter table public.inventory_checkouts add constraint inventory_checkouts_quote_id_fkey foreign key (quote_id) references quotes(id) on delete set null;
alter table public.inventory_checkouts add constraint inventory_checkouts_qty_out_check check (qty_out > 0::numeric);
alter table public.inventory_checkouts add constraint inventory_checkouts_status_check check (status = any (array['out'::text, 'returned'::text, 'partial'::text]));

alter table public.event_stock_requests add constraint event_stock_requests_pkey primary key (id);
alter table public.event_stock_requests add constraint event_stock_requests_org_fk foreign key (org_id) references organizations(id);
alter table public.event_stock_requests add constraint event_stock_requests_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_stock_requests add constraint event_stock_requests_item_id_fkey foreign key (item_id) references inventory_items(id) on delete set null;
alter table public.event_stock_requests add constraint event_stock_requests_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_stock_requests add constraint event_stock_requests_status_check check (status = any (array['requested'::text, 'issued'::text, 'replaced'::text, 'cancelled'::text]));

alter table public.event_tasks add constraint event_tasks_pkey primary key (id);
alter table public.event_tasks add constraint event_tasks_org_fk foreign key (org_id) references organizations(id);
alter table public.event_tasks add constraint event_tasks_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_tasks add constraint event_tasks_crew_id_fkey foreign key (crew_id) references crew_members(id) on delete set null;
alter table public.event_tasks add constraint event_tasks_vendor_id_fkey foreign key (vendor_id) references vendors(id) on delete set null;
alter table public.event_tasks add constraint event_tasks_verified_by_fkey foreign key (verified_by) references auth.users(id);
alter table public.event_tasks add constraint event_tasks_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_tasks add constraint event_tasks_assignee_kind_chk check (assignee_kind = any (array['in_house'::text, 'outsourced'::text]));
alter table public.event_tasks add constraint event_tasks_status_check check (status = any (array['unassigned'::text, 'assigned'::text, 'accepted'::text, 'rejected'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text]));
alter table public.event_tasks add constraint event_tasks_verify_status_check check (verify_status = any (array['unverified'::text, 'pending'::text, 'passed'::text, 'rejected'::text]));

alter table public.event_guests add constraint event_guests_pkey primary key (id);
alter table public.event_guests add constraint event_guests_org_fk foreign key (org_id) references organizations(id);
alter table public.event_guests add constraint event_guests_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_guests add constraint event_guests_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.event_attendees add constraint event_attendees_pkey primary key (id);
alter table public.event_attendees add constraint event_attendees_org_id_fkey foreign key (org_id) references organizations(id) on delete cascade;
alter table public.event_attendees add constraint event_attendees_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_attendees add constraint event_attendees_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.event_day add constraint event_day_pkey primary key (id);
alter table public.event_day add constraint event_day_org_fk foreign key (org_id) references organizations(id);
alter table public.event_day add constraint event_day_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_day add constraint event_day_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_day add constraint event_day_kind_check check (kind = any (array['arrival'::text, 'check'::text]));

alter table public.event_issues add constraint event_issues_pkey primary key (id);
alter table public.event_issues add constraint event_issues_org_fk foreign key (org_id) references organizations(id);
alter table public.event_issues add constraint event_issues_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_issues add constraint event_issues_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_issues add constraint event_issues_kind_check check (kind = any (array['issue'::text, 'incident'::text]));
alter table public.event_issues add constraint event_issues_severity_check check (severity = any (array['low'::text, 'medium'::text, 'high'::text]));
alter table public.event_issues add constraint event_issues_status_check check (status = any (array['open'::text, 'in_progress'::text, 'resolved'::text]));

alter table public.event_refunds add constraint event_refunds_pkey primary key (id);
alter table public.event_refunds add constraint event_refunds_org_fk foreign key (org_id) references organizations(id);
alter table public.event_refunds add constraint event_refunds_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_refunds add constraint event_refunds_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_refunds add constraint event_refunds_kind_check check (kind = any (array['refund'::text, 'recovery'::text, 'deduction'::text]));
alter table public.event_refunds add constraint event_refunds_status_check check (status = any (array['pending'::text, 'approved'::text, 'processed'::text, 'rejected'::text]));

alter table public.event_media add constraint event_media_pkey primary key (id);
alter table public.event_media add constraint event_media_org_fk foreign key (org_id) references organizations(id);
alter table public.event_media add constraint event_media_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_media add constraint event_media_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_media add constraint event_media_kind_check check (kind = any (array['photo'::text, 'video'::text]));

alter table public.event_ratings add constraint event_ratings_pkey primary key (id);
alter table public.event_ratings add constraint event_ratings_org_fk foreign key (org_id) references organizations(id);
alter table public.event_ratings add constraint event_ratings_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_ratings add constraint event_ratings_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_ratings add constraint event_ratings_kind_check check (kind = any (array['vendor'::text, 'staff'::text]));
alter table public.event_ratings add constraint event_ratings_stars_check check (stars >= 1 and stars <= 5);

alter table public.event_closure add constraint event_closure_pkey primary key (quote_id);
alter table public.event_closure add constraint event_closure_org_fk foreign key (org_id) references organizations(id);
alter table public.event_closure add constraint event_closure_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_closure add constraint event_closure_updated_by_fkey foreign key (updated_by) references auth.users(id);
alter table public.event_closure add constraint event_closure_client_rating_check check (client_rating >= 1 and client_rating <= 5);

alter table public.expense_claims add constraint expense_claims_pkey primary key (id);
alter table public.expense_claims add constraint expense_claims_org_fk foreign key (org_id) references organizations(id);
alter table public.expense_claims add constraint expense_claims_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.expense_claims add constraint expense_claims_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.expense_claims add constraint expense_claims_status_check check (status = any (array['pending'::text, 'approved'::text, 'paid'::text, 'rejected'::text]));

alter table public.payment_milestones add constraint payment_milestones_pkey primary key (id);
alter table public.payment_milestones add constraint payment_milestones_org_fk foreign key (org_id) references organizations(id);
alter table public.payment_milestones add constraint payment_milestones_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.payment_milestones add constraint payment_milestones_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.payment_milestones add constraint payment_milestones_status_check check (status = any (array['due'::text, 'invoiced'::text, 'paid'::text, 'waived'::text]));

alter table public.quote_payments add constraint quote_payments_pkey primary key (id);
alter table public.quote_payments add constraint quote_payments_org_fk foreign key (org_id) references organizations(id);
alter table public.quote_payments add constraint quote_payments_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.quote_payments add constraint quote_payments_status_check check (status = any (array['created'::text, 'paid'::text, 'failed'::text, 'refunded'::text, 'cancelled'::text]));

alter table public.quote_consents add constraint quote_consents_pkey primary key (id);
alter table public.quote_consents add constraint quote_consents_org_fk foreign key (org_id) references organizations(id);
alter table public.quote_consents add constraint quote_consents_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.quote_otps add constraint quote_otps_pkey primary key (id);
alter table public.quote_otps add constraint quote_otps_org_fk foreign key (org_id) references organizations(id);
alter table public.quote_otps add constraint quote_otps_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.work_tokens add constraint work_tokens_pkey primary key (token);
alter table public.work_tokens add constraint work_tokens_quote_id_phone_key unique (quote_id, phone);
alter table public.work_tokens add constraint work_tokens_org_fk foreign key (org_id) references organizations(id);
alter table public.work_tokens add constraint work_tokens_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;

alter table public.notifications add constraint notifications_pkey primary key (id);
alter table public.notifications add constraint notifications_org_fk foreign key (org_id) references organizations(id);
alter table public.notifications add constraint notifications_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.notifications add constraint notifications_channel_check check (channel = any (array['sms'::text, 'email'::text]));
alter table public.notifications add constraint notifications_status_check check (status = any (array['simulated'::text, 'sent'::text, 'failed'::text]));

alter table public.notification_seen add constraint notification_seen_pkey primary key (user_id);
alter table public.notification_seen add constraint notification_seen_org_fk foreign key (org_id) references organizations(id);
alter table public.notification_seen add constraint notification_seen_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.nurture add constraint nurture_pkey primary key (id);
alter table public.nurture add constraint nurture_org_fk foreign key (org_id) references organizations(id);
alter table public.nurture add constraint nurture_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.nurture add constraint nurture_quote_id_fkey foreign key (quote_id) references quotes(id) on delete set null;
alter table public.nurture add constraint nurture_status_check check (status = any (array['active'::text, 'won'::text, 'dormant'::text]));

alter table public.event_sites add constraint event_sites_pkey primary key (id);
alter table public.event_sites add constraint event_sites_org_id_fkey foreign key (org_id) references organizations(id) on delete cascade;
alter table public.event_sites add constraint event_sites_created_by_fkey foreign key (created_by) references auth.users(id);
alter table public.event_sites add constraint event_sites_quote_id_fkey foreign key (quote_id) references quotes(id) on delete cascade;
alter table public.event_sites add constraint event_sites_status_chk check (status = any (array['draft'::text, 'published'::text, 'unpublished'::text]));
alter table public.event_sites add constraint event_sites_template_chk check (template = any (array['eternal'::text, 'confetti'::text, 'summit'::text, 'promise'::text, 'soiree'::text]));
alter table public.event_sites add constraint event_sites_type_chk check (event_type = any (array['wedding'::text, 'birthday'::text, 'corporate'::text, 'engagement'::text, 'general'::text]));

-- END PART 2 (constraints).

-- ===========================================================================
-- 4) INDEXES  (standalone only; pkey/unique-constraint indexes auto-created in §3)
-- ===========================================================================
create index if not exists app_config_org_idx on public.app_config using btree (org_id);
create index if not exists audit_actor_idx on public.audit_log using btree (actor, at desc) where (actor is not null);
create index if not exists audit_at_idx on public.audit_log using btree (at desc);
create index if not exists audit_entity_idx on public.audit_log using btree (entity, at desc);
create index if not exists audit_log_org_idx on public.audit_log using btree (org_id);
create index if not exists audit_quote_idx on public.audit_log using btree (quote_id, at desc) where (quote_id is not null);
create index if not exists chair_types_org_idx on public.chair_types using btree (org_id);
create index if not exists change_req_quote_idx on public.change_requests using btree (quote_id, created_at);
create index if not exists change_requests_org_idx on public.change_requests using btree (org_id);
create index if not exists checklist_templates_idx on public.checklist_templates using btree (section, name);
create index if not exists checklist_templates_org_idx on public.checklist_templates using btree (org_id);
create index if not exists coupons_org_idx on public.coupons using btree (org_id);
create index if not exists crew_dept_idx on public.crew_members using btree (department) where active;
create index if not exists crew_members_org_idx on public.crew_members using btree (org_id);
create index if not exists crew_role_idx on public.crew_members using btree (role) where active;
create index if not exists dish_cat_idx on public.dish_catalog using btree (category) where active;
create index if not exists dish_catalog_org_idx on public.dish_catalog using btree (org_id);
create index if not exists event_attendees_org_quote_idx on public.event_attendees using btree (org_id, quote_id, seq);
create index if not exists event_checklist_org_idx on public.event_checklist using btree (org_id);
create index if not exists event_checklist_quote_idx on public.event_checklist using btree (quote_id, section, seq);
create index if not exists event_closure_org_idx on public.event_closure using btree (org_id);
create index if not exists event_costs_org_idx on public.event_costs using btree (org_id);
create index if not exists event_costs_quote_idx on public.event_costs using btree (quote_id, created_at);
create index if not exists event_day_org_idx on public.event_day using btree (org_id);
create index if not exists event_day_quote_idx on public.event_day using btree (quote_id, kind, seq);
create index if not exists event_discovery_org_idx on public.event_discovery using btree (org_id);
create index if not exists event_guests_org_idx on public.event_guests using btree (org_id);
create index if not exists event_guests_quote_idx on public.event_guests using btree (quote_id, seq);
create index if not exists event_issues_org_idx on public.event_issues using btree (org_id);
create index if not exists event_issues_quote_idx on public.event_issues using btree (quote_id, status, created_at desc);
create index if not exists event_media_org_idx on public.event_media using btree (org_id);
create index if not exists event_media_quote_idx on public.event_media using btree (quote_id, seq, created_at);
create index if not exists event_menu_items_org_idx on public.event_menu_items using btree (org_id);
create index if not exists event_menu_quote_idx on public.event_menu_items using btree (quote_id, seq);
create index if not exists event_plan_org_idx on public.event_plan using btree (org_id);
create index if not exists event_proposal_org_idx on public.event_proposal using btree (org_id);
create unique index if not exists event_proposal_token_idx on public.event_proposal using btree (share_token) where (share_token is not null);
create index if not exists event_ratings_org_idx on public.event_ratings using btree (org_id);
create index if not exists event_ratings_quote_idx on public.event_ratings using btree (quote_id, kind);
create index if not exists event_refunds_org_idx on public.event_refunds using btree (org_id);
create index if not exists event_refunds_quote_idx on public.event_refunds using btree (quote_id, created_at);
create index if not exists event_req_quote_idx on public.event_requirements using btree (quote_id, created_at);
create index if not exists event_requirements_org_idx on public.event_requirements using btree (org_id);
create index if not exists ern_quote_idx on public.event_resource_needs using btree (quote_id, created_at);
create index if not exists event_resource_needs_org_idx on public.event_resource_needs using btree (org_id);
create index if not exists event_res_quote_idx on public.event_resources using btree (quote_id, created_at);
create index if not exists event_res_vendor_idx on public.event_resources using btree (vendor_id);
create index if not exists event_resources_org_idx on public.event_resources using btree (org_id);
create index if not exists event_sites_org_idx on public.event_sites using btree (org_id);
create unique index if not exists event_sites_quote_uidx on public.event_sites using btree (quote_id);
create unique index if not exists event_sites_slug_uidx on public.event_sites using btree (slug);
create index if not exists event_sites_status_idx on public.event_sites using btree (org_id, status);
create index if not exists event_stock_req_quote_idx on public.event_stock_requests using btree (quote_id, created_at desc);
create index if not exists event_stock_requests_org_idx on public.event_stock_requests using btree (org_id);
create index if not exists etask_phone_idx on public.event_tasks using btree (quote_id, assignee_phone);
create index if not exists etask_quote_idx on public.event_tasks using btree (quote_id, category, seq);
create index if not exists etask_vendor_idx on public.event_tasks using btree (quote_id, vendor_id) where (vendor_id is not null);
create index if not exists event_tasks_org_idx on public.event_tasks using btree (org_id);
create index if not exists expense_claims_org_idx on public.expense_claims using btree (org_id);
create index if not exists expense_claims_quote_idx on public.expense_claims using btree (quote_id, created_at);
create index if not exists inv_chk_item_idx on public.inventory_checkouts using btree (item_id);
create index if not exists inv_chk_open_idx on public.inventory_checkouts using btree (status) where (status = any (array['out'::text, 'partial'::text]));
create index if not exists inv_chk_quote_idx on public.inventory_checkouts using btree (quote_id);
create index if not exists inventory_checkouts_org_idx on public.inventory_checkouts using btree (org_id);
create index if not exists inventory_items_cat_idx on public.inventory_items using btree (category) where active;
create index if not exists inventory_items_org_idx on public.inventory_items using btree (org_id);
create index if not exists inv_res_item_idx on public.inventory_reservations using btree (item_id) where (status = any (array['reserved'::text, 'allocated'::text]));
create index if not exists inv_res_quote_idx on public.inventory_reservations using btree (quote_id);
create index if not exists inventory_reservations_org_idx on public.inventory_reservations using btree (org_id);
create index if not exists invitations_email_idx on public.invitations using btree (lower(email));
create index if not exists invitations_org_status_idx on public.invitations using btree (org_id, status);
create index if not exists layout_rules_org_idx on public.layout_rules using btree (org_id);
create index if not exists layouts_org_idx on public.layouts using btree (org_id);
create index if not exists layouts_updated_at_idx on public.layouts using btree (updated_at desc);
create index if not exists lead_archive_lead_idx on public.lead_archive using btree (lead_id, archived_at desc);
create index if not exists lead_archive_org_idx on public.lead_archive using btree (org_id);
create index if not exists lead_archive_time_idx on public.lead_archive using btree (archived_at desc);
create index if not exists leads_org_idx on public.leads using btree (org_id);
create index if not exists leads_status_idx on public.leads using btree (status);
create index if not exists leads_updated_idx on public.leads using btree (updated_at desc);
create index if not exists menu_templates_org_idx on public.menu_templates using btree (org_id);
create index if not exists notification_seen_org_idx on public.notification_seen using btree (org_id);
create index if not exists notifications_org_idx on public.notifications using btree (org_id);
create index if not exists nurture_followup_idx on public.nurture using btree (next_followup);
create index if not exists nurture_org_idx on public.nurture using btree (org_id);
create index if not exists nurture_automation_org_idx on public.nurture_automation using btree (org_id);
create index if not exists nurture_templates_org_idx on public.nurture_templates using btree (org_id);
create index if not exists payment_milestones_org_idx on public.payment_milestones using btree (org_id);
create index if not exists payment_milestones_quote_idx on public.payment_milestones using btree (quote_id, due_date, seq);
create index if not exists plate_types_org_idx on public.plate_types using btree (org_id);
create index if not exists proposal_risks_org_idx on public.proposal_risks using btree (org_id);
create index if not exists proposal_risks_quote_idx on public.proposal_risks using btree (quote_id, created_at);
create index if not exists quotation_versions_quote_idx on public.quotation_versions using btree (quote_id, created_at desc);
create unique index if not exists quotation_versions_quote_label_uk on public.quotation_versions using btree (quote_id, label);
create index if not exists consent_quote_idx on public.quote_consents using btree (quote_id, created_at desc);
create index if not exists quote_consents_org_idx on public.quote_consents using btree (org_id);
create index if not exists otp_quote_idx on public.quote_otps using btree (quote_id, created_at desc);
create index if not exists quote_otps_org_idx on public.quote_otps using btree (org_id);
create index if not exists pay_quote_idx on public.quote_payments using btree (quote_id, created_at desc);
create unique index if not exists quote_payments_idempotency_uk on public.quote_payments using btree (quote_id, idempotency_key) where (idempotency_key is not null);
create index if not exists quote_payments_org_idx on public.quote_payments using btree (org_id);
create unique index if not exists quote_payments_quote_receipt_uk on public.quote_payments using btree (quote_id, receipt_no) where (receipt_no is not null);
create index if not exists quote_versions_org_idx on public.quote_versions using btree (org_id);
create index if not exists qv_quote_idx on public.quote_versions using btree (quote_id, version_no desc);
create unique index if not exists quotes_approval_token_idx on public.quotes using btree (approval_token) where (approval_token is not null);
create index if not exists quotes_event_date_idx on public.quotes using btree (event_date);
create index if not exists quotes_org_idx on public.quotes using btree (org_id);
create index if not exists quotes_status_idx on public.quotes using btree (status);
create index if not exists quotes_updated_idx on public.quotes using btree (updated_at desc);
create index if not exists role_access_org_idx on public.role_access using btree (org_id);
create index if not exists run_sheet_items_org_idx on public.run_sheet_items using btree (org_id);
create index if not exists run_sheet_quote_idx on public.run_sheet_items using btree (quote_id, start_time, seq);
create index if not exists task_templates_org_idx on public.task_templates using btree (org_id);
create index if not exists vendors_kind_idx on public.vendors using btree (kind) where active;
create index if not exists vendors_org_idx on public.vendors using btree (org_id);
create index if not exists work_tokens_org_idx on public.work_tokens using btree (org_id);

-- END PART 3 (indexes).

-- ===========================================================================
-- 5) FUNCTIONS / RPCs  (verbatim; security + search_path preserved)
--    Created with check_function_bodies=false so table refs resolve later.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public._flag(p text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select (value->>p)::boolean from public.app_config
                   where key='channels' order by updated_at desc limit 1), false); $function$;

CREATE OR REPLACE FUNCTION public._flag(p text, p_org uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select (value->>p)::boolean from public.app_config
                   where key='channels' and org_id = p_org), false);
$function$;

CREATE OR REPLACE FUNCTION public._layouts_stamp_org()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.org_id := public.current_org_id();
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public._next_occasion(p_date date)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  y int := extract(year from current_date)::int;
  m int; d int; cand date;
begin
  if p_date is null then return null; end if;
  m := extract(month from p_date)::int;
  d := extract(day from p_date)::int;
  begin cand := make_date(y, m, d); exception when others then cand := make_date(y, m, 28); end;
  if cand < current_date then
    begin cand := make_date(y + 1, m, d); exception when others then cand := make_date(y + 1, m, 28); end;
  end if;
  return cand;
end $function$;

CREATE OR REPLACE FUNCTION public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare live boolean;
begin
  live := case p_channel when 'sms' then public._flag('sms_live') when 'email' then public._flag('email_live') else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
end; $function$;

CREATE OR REPLACE FUNCTION public._valid_role(p_role text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client');
$function$;

CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.invitations; v_uid uuid := auth.uid(); v_current uuid; v_email text;
begin
  if v_uid is null then raise exception 'must be signed in' using errcode='42501'; end if;
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then raise exception 'invalid invitation' using errcode='42501'; end if;
  if v_row.status = 'accepted' and v_row.accepted_by = v_uid then
    return jsonb_build_object('ok', true, 'org_id', v_row.org_id, 'already', true);
  end if;
  if v_row.status <> 'pending' then raise exception 'invitation is %', v_row.status using errcode='42501'; end if;
  if v_row.expires_at <= now() then
    update public.invitations set status = 'expired' where id = v_row.id and status = 'pending';
    raise exception 'invitation has expired' using errcode='42501';
  end if;

  v_email := lower(nullif(auth.jwt() ->> 'email', ''));
  if v_email is null then select lower(u.email) into v_email from auth.users u where u.id = v_uid; end if;
  if v_email is null or v_email <> lower(v_row.email) then
    raise exception 'this invitation was issued to a different email address' using errcode='42501';
  end if;

  select org_id into v_current from public.profiles where id = v_uid;
  if v_current is not null and v_current <> v_row.org_id then
    raise exception 'you already belong to an organization' using errcode='42501';
  end if;
  update public.profiles set org_id = v_row.org_id, role = v_row.role
    where id = v_uid and (org_id is null or org_id = v_row.org_id);
  if not found then
    insert into public.profiles(id, email, org_id, role)
      select v_uid, u.email, v_row.org_id, v_row.role from auth.users u where u.id = v_uid
      on conflict (id) do update
        set org_id = excluded.org_id, role = excluded.role
        where public.profiles.org_id is null or public.profiles.org_id = excluded.org_id;
  end if;

  update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = v_uid
   where id = v_row.id and status = 'pending';
  return jsonb_build_object('ok', true, 'org_id', v_row.org_id, 'role', v_row.role, 'already', false);
end; $function$;

CREATE OR REPLACE FUNCTION public.add_event_dish(p_quote uuid, p_dish uuid)
 RETURNS event_menu_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.dish_catalog; locked boolean; nextseq int; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change dishes'; end if;
  select * into d from public.dish_catalog where id = p_dish and org_id = public.current_org_id();
  if d.id is null then raise exception 'no such dish'; end if;
  select coalesce(max(seq),0)+1 into nextseq from public.event_menu_items where quote_id = p_quote;
  insert into public.event_menu_items(quote_id,dish_id,dish_name,category,kind,seq)
    values (p_quote, d.id, d.name, d.category, d.kind, nextseq)
  returning * into row;
  return row;
end; $function$;

CREATE OR REPLACE FUNCTION public.add_quote_version(p_quote_id uuid, p_label text, p_data jsonb, p_object_count integer)
 RETURNS quote_versions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v public.quote_versions; nextno int;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  select coalesce(max(version_no),0)+1 into nextno from public.quote_versions where quote_id = p_quote_id;
  insert into public.quote_versions (quote_id, version_no, label, data, object_count, created_by)
    values (p_quote_id, nextno, p_label, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid())
    returning * into v;
  update public.quotes set current_version = nextno, updated_at = now()
    where id = p_quote_id and org_id = public.current_org_id();
  return v;
end; $function$;

CREATE OR REPLACE FUNCTION public.adjust_inventory_total(p_item_id uuid, p_delta numeric)
 RETURNS inventory_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.inventory_items;
begin
  if not public.can_edit() then raise exception 'not allowed'; end if;
  update public.inventory_items
     set total_qty = greatest(0, coalesce(total_qty,0) + coalesce(p_delta,0))
   where id = p_item_id and org_id = public.current_org_id()
   returning * into row;
  if row.id is null then raise exception 'item not found'; end if;
  return row;
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_create_user(p_email text, p_password text, p_role text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public', 'extensions'
AS $function$
declare uid uuid; v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_email is null or position('@' in p_email) = 0 then raise exception 'invalid email'; end if;
  if length(coalesce(p_password,'')) < 4 then raise exception 'password too short'; end if;

  select id into uid from auth.users where email = lower(p_email);
  if uid is not null then raise exception 'a user with that email already exists'; end if;

  uid := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    lower(p_email), extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', lower(p_email)),
    'email', uid::text, now(), now(), now()
  );
  insert into public.profiles (id, email, role, org_id) values (uid, lower(p_email), p_role, v_org)
    on conflict (id) do update set role = excluded.role, email = excluded.email, org_id = excluded.org_id;
  return uid;
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_create_user_temp(p_email text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare v_uid uuid; v_temp text;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  v_temp := translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xy9');
  v_uid  := public.admin_create_user(p_email, v_temp, p_role);
  update public.profiles set must_change_password = true where id = v_uid;
  return jsonb_build_object('user_id', v_uid, 'temp_password', v_temp);
end $function$;

CREATE OR REPLACE FUNCTION public.admin_delete_user(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_id = auth.uid() then raise exception 'you cannot delete your own account'; end if;
  if not exists (select 1 from public.profiles where id = p_id and org_id = public.current_org_id()) then
    raise exception 'no such user'; end if;
  delete from auth.users where id = p_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_get_role_access()
 RETURNS SETOF role_access
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.role_access where org_id = public.current_org_id() order by role, area;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_role(p_id uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_id = auth.uid() and p_role <> 'admin' then
    raise exception 'you cannot remove your own admin role'; end if;
  update public.profiles set role = p_role where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'no such user'; end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
 RETURNS role_access
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.role_access;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'unknown role %', p_role; end if;
  insert into public.role_access(org_id, role, area, can_view, can_edit, updated_at)
    values (public.current_org_id(), p_role, p_area, coalesce(p_view,false), coalesce(p_edit,false) and coalesce(p_view,false), now())
  on conflict (org_id, role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
  returning * into row;
  return row;
end; $function$;

CREATE OR REPLACE FUNCTION public.admin_store_otp(p_token uuid, p_phone text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; recent int;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests'; end if;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(p_code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  return jsonb_build_object('stored', true);
end; $function$;

CREATE OR REPLACE FUNCTION public.apply_menu_template(p_quote uuid, p_template uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t public.menu_templates; locked boolean; d jsonb; i int := 0;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select menu_locked into locked from public.event_plan where quote_id = p_quote;
  if coalesce(locked,false) then raise exception 'menu is locked — unlock it to change the package'; end if;
  select * into t from public.menu_templates where id = p_template and org_id = public.current_org_id();
  if t.id is null then raise exception 'no such package'; end if;

  delete from public.event_menu_items where quote_id = p_quote and org_id = public.current_org_id();
  for d in select * from jsonb_array_elements(t.dishes) loop
    i := i + 1;
    insert into public.event_menu_items(quote_id, dish_id, dish_name, category, kind, seq)
    values (
      p_quote,
      (select dc.id from public.dish_catalog dc where dc.org_id = public.current_org_id() and dc.name = (d->>'n') limit 1),
      d->>'n', d->>'c', coalesce(d->>'k','veg'), i);
  end loop;

  update public.event_plan
     set package = t.name, menu_template = t.name, menu_plate_price = t.price_per_plate
   where quote_id = p_quote;
  if not found then
    insert into public.event_plan(quote_id, package, menu_template, menu_plate_price)
    values (p_quote, t.name, t.name, t.price_per_plate);
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.archive_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.leads; act text;
begin
  if tg_op = 'DELETE' then r := old; act := 'deleted';
  elsif tg_op = 'INSERT' then r := new; act := 'created';
  else
    r := new;
    act := case when new.quote_id is not null and old.quote_id is null
                then 'converted' else 'updated' end;
  end if;
  insert into public.lead_archive
    (lead_id, action, name, phone, email, source, event_type, event_date,
     budget, guest_count, notes, status, quote_id, snapshot, archived_by)
  values
    (r.id, act, r.name, r.phone, r.email, r.source, r.event_type, r.event_date,
     r.budget, r.guest_count, r.notes, r.status, r.quote_id, to_jsonb(r), auth.uid());
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.assert_quote_org(p_quote uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from public.quotes where id = p_quote and org_id = public.current_org_id()) then
    raise exception 'not authorized for this event' using errcode='42501';
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.assign_tasks(p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; tok uuid; t text; n int := 0; s int;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'valid worker phone required'; end if;
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,p_phone,p_name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t and org_id=public.current_org_id();
    insert into public.event_tasks(quote_id,category,title,seq,crew_id,assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),p_crew_id,p_name,p_phone,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',p_phone,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok));
  return jsonb_build_object('work_token',tok,'tasks_created',n);
end; $function$;

CREATE OR REPLACE FUNCTION public.assign_tasks_vendor(p_quote_id uuid, p_category text, p_titles text[], p_vendor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; v public.vendors; tok uuid; t text; n int := 0; s int; ph text;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes  where id = p_quote_id and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event'; end if;
  select * into v from public.vendors where id = p_vendor_id and org_id = public.current_org_id();
  if v.id is null then raise exception 'no such vendor'; end if;
  ph := regexp_replace(coalesce(v.phone,''),'[^0-9+]','','g');
  if length(regexp_replace(ph,'[^0-9]','','g')) < 8 then
    raise exception 'This vendor has no phone number — add one in Vendors so the checklist can be sent.';
  end if;
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=ph;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,ph,v.name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t and org_id = public.current_org_id();
    insert into public.event_tasks(quote_id,category,title,seq,assignee_kind,vendor_id,
                                   assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),'outsourced',p_vendor_id,
              v.name,ph,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',ph,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok,
                       'outsourced',true,'vendor',v.name,'checklist',to_jsonb(coalesce(p_titles,'{}'::text[]))));
  return jsonb_build_object('work_token',tok,'tasks_created',n,'vendor',v.name);
end; $function$;

CREATE OR REPLACE FUNCTION public.bell_feed(p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare uid uuid := auth.uid(); org uuid := public.current_org_id(); seen timestamptz; result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select last_seen_at into seen from public.notification_seen where user_id = uid;
  seen := coalesce(seen, 'epoch'::timestamptz);
  with recent as (
    select n.id, n.kind, n.channel, n.recipient, n.detail, n.created_at, n.quote_id,
           q.code as event_code, q.title as event_title, (n.created_at > seen) as unread
    from public.notifications n
    left join public.quotes q on q.id = n.quote_id
    where n.org_id = org
    order by n.created_at desc
    limit greatest(1, least(p_limit, 100))
  )
  select jsonb_build_object(
    'items',  coalesce((select jsonb_agg(to_jsonb(recent) order by recent.created_at desc) from recent), '[]'::jsonb),
    'unread', (select count(*) from public.notifications where created_at > seen and org_id = org)
  ) into result;
  return result;
end; $function$;

CREATE OR REPLACE FUNCTION public.bell_mark_seen()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode='42501'; end if;
  insert into public.notification_seen(user_id, last_seen_at) values (auth.uid(), now())
  on conflict (user_id) do update set last_seen_at = now();
end; $function$;

CREATE OR REPLACE FUNCTION public.can_create()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.user_role() in ('admin','planner','sales'), false); $function$;

CREATE OR REPLACE FUNCTION public.can_delete()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.user_role() in ('admin','planner'), false); $function$;

CREATE OR REPLACE FUNCTION public.can_edit()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select role from public.profiles where id = auth.uid())
    in ('admin','planner','sales','operations'), false); $function$;

CREATE OR REPLACE FUNCTION public.can_view_finance()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ select public.has_area('finance','view'); $function$;

CREATE OR REPLACE FUNCTION public.can_view_ops()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ select public.has_area('quotes','view'); $function$;

CREATE OR REPLACE FUNCTION public.checkin_equipment(p_id uuid, p_qty_in numeric, p_returned_by text, p_writeoff boolean DEFAULT false)
 RETURNS inventory_checkouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.inventory_checkouts; v_missing numeric;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into row from public.inventory_checkouts where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'checkout not found'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  v_missing := greatest(row.qty_out - coalesce(p_qty_in,0), 0);
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = nullif(btrim(coalesce(p_returned_by,'')),''),
         confirmed_by = auth.uid(),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= row.qty_out then 'returned' else 'partial' end
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if p_writeoff and v_missing > 0 then
    update public.inventory_items set total_qty = greatest(0, coalesce(total_qty,0) - v_missing)
     where id = row.item_id and org_id = public.current_org_id();
  end if;
  return row;
end; $function$;

CREATE OR REPLACE FUNCTION public.checkout_equipment(p_item uuid, p_quote uuid, p_qty numeric, p_issued_to text, p_issued_to_id uuid, p_note text)
 RETURNS inventory_checkouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.inventory_checkouts;
begin
  if not public.has_area('inventory','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item and org_id = public.current_org_id()) then
    raise exception 'item not found' using errcode='42501'; end if;
  if p_quote is not null then perform public.assert_quote_org(p_quote); end if;
  if coalesce(p_qty,0) <= 0 then raise exception 'quantity must be > 0'; end if;
  if coalesce(btrim(p_issued_to),'') = '' then raise exception 'who is it issued to?'; end if;
  insert into public.inventory_checkouts (item_id, quote_id, qty_out, issued_to, issued_to_id, issued_by, note)
    values (p_item, p_quote, p_qty, btrim(p_issued_to), p_issued_to_id, auth.uid(), nullif(btrim(coalesce(p_note,'')),''))
  returning * into row;
  return row;
end; $function$;

-- END PART 4a (functions: helpers .. checkout_equipment).

CREATE OR REPLACE FUNCTION public.clear_password_change_required()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  update public.profiles set must_change_password = false where id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.close_event(p_quote_id uuid, p_closed boolean)
 RETURNS event_closure
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_closure (quote_id, closed_at, updated_by)
    values (p_quote_id, case when p_closed then now() end, auth.uid())
  on conflict (quote_id) do update set
    closed_at = case when p_closed then now() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  update public.quotes set lifecycle_stage = case when p_closed then 'closed' else 'settlement' end, updated_at=now()
   where id = p_quote_id and org_id = public.current_org_id();
  return r;
end; $function$;

CREATE OR REPLACE FUNCTION public.confirm_quote(p_quote_id uuid, p_client jsonb, p_pricing jsonb)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized to confirm' using errcode='42501'; end if;
  update public.quotes
     set status='confirmed', client=coalesce(p_client,client), pricing=coalesce(p_pricing,pricing),
         confirmed_at=now(), confirmed_by=auth.uid(), updated_at=now()
   where id = p_quote_id and org_id = public.current_org_id() returning * into q;
  if not found then raise exception 'no such event' using errcode='42501'; end if;
  return q;
end; $function$;

CREATE OR REPLACE FUNCTION public.convert_lead_to_quote(p_lead_id uuid)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  l public.leads; q public.quotes;
  v_stamp text; v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id and org_id = public.current_org_id();
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id and org_id = public.current_org_id(); return q; end if;
  v_stamp := to_char(coalesce(l.event_date, now()), 'MMDDYYYY');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
        values (v_code, v_title, l.event_type, 1,
                jsonb_strip_nulls(jsonb_build_object(
                  'name', l.name, 'phone', l.phone, 'email', l.email,
                  'guests', l.guest_count, 'budget', l.budget,
                  'eventDate', to_char(l.event_date, 'YYYY-MM-DD'), 'source', l.source)),
                'discovery', l.event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now()
    where id = p_lead_id and org_id = public.current_org_id();
  return q;
end; $function$;

CREATE OR REPLACE FUNCTION public.create_event_site(p_quote_id uuid, p_event_type text DEFAULT 'general'::text, p_template text DEFAULT 'soiree'::text)
 RETURNS event_sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid := current_org_id(); v_row public.event_sites; v_slug text;
begin
  if v_org is null then raise exception 'no organization in context'; end if;
  if not has_area('quotes','edit') then raise exception 'not permitted'; end if;
  perform assert_quote_org(p_quote_id);
  select * into v_row from public.event_sites where quote_id = p_quote_id and org_id = v_org;
  if found then return v_row; end if;
  if coalesce(p_event_type,'') not in ('wedding','birthday','corporate','engagement','general') then p_event_type := 'general'; end if;
  if coalesce(p_template,'') not in ('eternal','confetti','summit','promise','soiree') then p_template := 'soiree'; end if;
  v_slug := 'draft-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  insert into public.event_sites (quote_id, event_type, template, slug, created_by)
  values (p_quote_id, p_event_type, p_template, v_slug, auth.uid()) returning * into v_row;
  return v_row;
end$function$;

CREATE OR REPLACE FUNCTION public.create_helm_user(p_email text, p_password text, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'auth', 'public', 'extensions'
AS $function$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      p_email, extensions.crypt(p_password, extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());
    insert into auth.identities (id, user_id, identity_data, provider, provider_id,
      created_at, updated_at, last_sign_in_at)
    values (gen_random_uuid(), uid, jsonb_build_object('sub', uid::text, 'email', p_email),
      'email', uid::text, now(), now(), now());
  else
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()) where id = uid;
  end if;
  insert into public.profiles (id, email, role) values (uid, p_email, p_role)
  on conflict (id) do update set role = excluded.role, email = excluded.email;
end; $function$;

CREATE OR REPLACE FUNCTION public.create_invitation(p_email text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid := public.current_org_id(); v_row public.invitations;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_org is null then raise exception 'no organization context' using errcode='42501'; end if;
  if coalesce(btrim(p_email),'') = '' then raise exception 'email is required'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  select * into v_row from public.invitations
    where org_id = v_org and lower(email) = lower(btrim(p_email))
      and status = 'pending' and expires_at > now()
    order by created_at desc limit 1;
  if v_row.id is not null then return jsonb_build_object('token', v_row.token, 'reused', true); end if;
  insert into public.invitations(org_id, email, role, invited_by)
    values (v_org, lower(btrim(p_email)), p_role, auth.uid())
    returning * into v_row;
  return jsonb_build_object('token', v_row.token, 'reused', false);
end; $function$;

CREATE OR REPLACE FUNCTION public.create_payment(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; amt numeric; pid uuid; link text; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if q.approval_status not in ('approved','paid') then raise exception 'approve the terms first'; end if;
  amt := coalesce((q.pricing->>'total')::numeric, 0);
  live := public._flag('pay_live');
  if live then
    insert into public.quote_payments(quote_id, provider, amount, status, simulated)
      values (q.id,'razorpay',amt,'created',false) returning id into pid;
    return jsonb_build_object('payment_id', pid, 'pending_provider', true, 'amount', amt);
  else
    link := 'sim-pay.html?ref='||q.code||'&amount='||amt::text;
    insert into public.quote_payments(quote_id, provider, amount, status, link_url, simulated)
      values (q.id,'simulated',amt,'created',link,true) returning id into pid;
    perform public._notify(q.id,'sms', q.client->>'phone','payment_link', jsonb_build_object('url',link,'amount',amt));
    return jsonb_build_object('payment_id', pid, 'link_url', link, 'amount', amt, 'live', false);
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.create_quote(p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count integer, p_event_date date DEFAULT NULL::date)
 RETURNS quotes
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
  v_stamp text := to_char(coalesce(p_event_date, now()), 'MMDDYYYY');
  v_next int; v_code text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, event_date)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1, p_event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $function$;

CREATE OR REPLACE FUNCTION public.create_studio(p_name text, p_email text DEFAULT NULL::text, p_currency text DEFAULT 'INR'::text, p_timezone text DEFAULT 'Asia/Kolkata'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_existing uuid;
  helm constant uuid := '00000000-0000-4000-8000-000000000001';
  t text; cols text; has_name boolean;
  lib text[] := array['role_access','task_templates','checklist_templates','plate_types',
                      'chair_types','dish_catalog','menu_templates','layout_rules','nurture_templates','nurture_automation','app_config'];
  v_slug text;
begin
  if v_uid is null then raise exception 'must be signed in to create a studio' using errcode='42501'; end if;
  select org_id into v_existing from public.profiles where id = v_uid;
  if v_existing is not null then return v_existing; end if;
  if coalesce(btrim(p_name),'') = '' then raise exception 'studio name required'; end if;

  v_org := gen_random_uuid();
  v_slug := left(regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g'), 40) || '-' || left(v_org::text, 8);
  insert into public.organizations(id, name, slug, business_email, currency, timezone, created_by)
    values (v_org, p_name, v_slug, p_email, coalesce(p_currency,'INR'), coalesce(p_timezone,'Asia/Kolkata'), v_uid);

  insert into public.profiles(id, email, org_id, role)
    values (v_uid, coalesce(p_email, (select email from auth.users where id = v_uid)), v_org, 'admin')
  on conflict (id) do update set org_id = v_org, role = 'admin';

  foreach t in array lib loop
    if to_regclass('public.'||t) is null then continue; end if;
    select string_agg(quote_ident(column_name), ',') into cols
      from information_schema.columns
      where table_schema='public' and table_name=t
        and column_name not in ('id','org_id','created_at','updated_at','created_by','updated_by','locked_at','locked_by');
    if cols is null then continue; end if;
    has_name := exists(select 1 from information_schema.columns
                       where table_schema='public' and table_name=t and column_name='name');
    execute format(
      'insert into public.%I (org_id,%s) select %L,%s from public.%I where org_id=%L %s',
      t, cols, v_org, cols, t, helm,
      case when has_name then 'and coalesce(name,'''') not ilike ''%(testing)%''' else '' end);
  end loop;

  return v_org;
end; $function$;

-- current_org_id() is defined earlier (before §2 TABLES) because table column
-- defaults call it; that copy is identical to the production definition, so it
-- is not re-issued here. This keeps the file at exactly 101 unique functions.

CREATE OR REPLACE FUNCTION public.enforce_pricing_total()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.pricing is not null and jsonb_typeof(new.pricing)='object' and (new.pricing ? 'subtotal') then
    new.pricing := jsonb_set(new.pricing, '{total}', to_jsonb(public.helm_quote_total(new.pricing)));
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.event_activity(p_quote uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare items jsonb;
begin
  perform public.assert_quote_org(p_quote);
  select coalesce(jsonb_agg(a order by a->>'at' desc), '[]'::jsonb) into items from (
    select jsonb_build_object('at', created_at, 'kind','version','text','Layout v'||version_no||coalesce(' — '||label,'')) a
      from public.quote_versions where quote_id = p_quote
    union all
    select jsonb_build_object('at', coalesce(paid_at,created_at), 'kind','payment',
             'text', case when status='paid' then 'Payment '||coalesce(receipt_no,'')||' — '||to_char(amount,'FM9999999999')||' ('||coalesce(method,provider)||')'
                          else 'Payment '||status||' — '||to_char(amount,'FM9999999999') end) a
      from public.quote_payments where quote_id = p_quote
    union all
    select jsonb_build_object('at', paid_at, 'kind','milestone','text','Milestone paid: '||label||' ('||to_char(amount,'FM9999999999')||')') a
      from public.payment_milestones where quote_id = p_quote and status='paid'
    union all
    select jsonb_build_object('at', created_at, 'kind','consent','text','Client consent recorded ('||coalesce(client_name,'')||')') a
      from public.quote_consents where quote_id = p_quote
    union all
    select jsonb_build_object('at', created_at, 'kind','notify','text',kind||' → '||coalesce(recipient,'')) a
      from public.notifications where quote_id = p_quote
  ) t;
  return items;
end; $function$;

CREATE OR REPLACE FUNCTION public.event_attendees_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.org_id := public.current_org_id();
  perform public.assert_quote_org(new.quote_id);
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.event_sites_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  new.org_id := current_org_id();
  if new.org_id is null then
    raise exception 'no organization in context';
  end if;
  perform assert_quote_org(new.quote_id);
  new.updated_at := now();
  return new;
end$function$;

CREATE OR REPLACE FUNCTION public.export_org_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid := public.current_org_id();
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if v_org is null then raise exception 'no organization context' using errcode='42501'; end if;

  return jsonb_build_object(
    'exported_at',  now(),
    'org',          (select to_jsonb(o) from public.organizations o where o.id = v_org),
    'members',      (select coalesce(jsonb_agg(to_jsonb(p) - 'id'), '[]'::jsonb)
                       from public.profiles p where p.org_id = v_org),
    'quotes',       (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
                       from public.quotes q where q.org_id = v_org),
    'leads',        (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb)
                       from public.leads l where l.org_id = v_org),
    'invitations',  (select coalesce(jsonb_agg(to_jsonb(i) - 'token'), '[]'::jsonb)
                       from public.invitations i where i.org_id = v_org)
  );
end; $function$;

CREATE OR REPLACE FUNCTION public.export_tenant_organization_package()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid := public.current_org_id();
begin
  if v_org is null then
    raise exception 'no organization context' using errcode = '42501';
  end if;
  if not public.has_area('users', 'view') then
    raise exception 'not authorized to export organization data' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'exported_at',     now(),
    'org_id',          v_org,
    'organizations',   (select to_jsonb(o) from public.organizations o where o.id = v_org),
    'profiles',        (select coalesce(jsonb_agg(to_jsonb(p) - 'id'), '[]'::jsonb)
                          from public.profiles p where p.org_id = v_org),
    'quotes',          (select coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb)
                          from public.quotes q where q.org_id = v_org),
    'event_attendees', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                          from public.event_attendees a where a.org_id = v_org),
    'invitations',     (select coalesce(jsonb_agg(to_jsonb(i) - 'token'), '[]'::jsonb)
                          from public.invitations i where i.org_id = v_org)
  );
end; $function$;

CREATE OR REPLACE FUNCTION public.generate_approval_token(p_quote_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  select approval_token into tok from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if tok is null then tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_status = 'sent', updated_at = now()
      where id = p_quote_id and org_id = public.current_org_id();
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end
      where id = p_quote_id and org_id = public.current_org_id();
  end if;
  return tok;
end; $function$;

CREATE OR REPLACE FUNCTION public.get_pricing_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select value from public.app_config where key='pricing' and org_id = public.current_org_id()),
                  '{"chairPrice":200,"platePrice":500,"gstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb);
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.has_area(p_area text, p_need text DEFAULT 'view'::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when public.user_role() = 'admin' then true
    else coalesce((
      select case when p_need = 'edit' then ra.can_edit else ra.can_view end
      from public.role_access ra
      where ra.role = public.user_role() and ra.area = p_area
        and ra.org_id = public.current_org_id()
    ), false)
  end;
$function$;

CREATE OR REPLACE FUNCTION public.helm_quote_total(p jsonb)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare sub numeric; disc numeric; gp numeric; taxed numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' or not (p ? 'subtotal') then
    return coalesce((p->>'total')::numeric, 0);
  end if;
  sub  := coalesce((p->>'subtotal')::numeric, 0);
  disc := coalesce((p->>'discount')::numeric, 0);
  gp   := coalesce((p->>'gstPct')::numeric, 18);
  if sub < 0 or disc < 0 or gp < 0 then
    raise exception 'pricing components cannot be negative (subtotal=%, discount=%, gstPct=%)',
      sub, disc, gp using errcode='22003';
  end if;
  disc  := least(disc, sub);
  taxed := greatest(0, sub - disc);
  return round(taxed * (1 + gp/100));
end $function$;

CREATE OR REPLACE FUNCTION public.invitation_by_token(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_row public.invitations; v_org text;
begin
  select * into v_row from public.invitations where token = p_token;
  if v_row.id is null then return jsonb_build_object('valid', false, 'reason', 'not_found'); end if;
  select name into v_org from public.organizations where id = v_row.org_id;
  return jsonb_build_object(
    'valid',   (v_row.status = 'pending' and v_row.expires_at > now()),
    'status',  v_row.status, 'role', v_row.role, 'org_name', v_org,
    'expired', (v_row.expires_at <= now()) );
end; $function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(public.user_role() = 'admin', false); $function$;

CREATE OR REPLACE FUNCTION public.layouts_quarantined_count()
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*) from public.layouts where org_id is null; $function$;

CREATE OR REPLACE FUNCTION public.mark_paid(p_quote_id uuid, p_provider_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now()
    where id=p_quote_id and org_id = public.current_org_id() returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $function$;

CREATE OR REPLACE FUNCTION public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  perform public._notify(p_quote_id, p_channel, p_to, p_kind, p_detail);
  return jsonb_build_object('logged', true);
end; $function$;

CREATE OR REPLACE FUNCTION public.nurture_due(p_within_days integer DEFAULT 30)
 RETURNS TABLE(id uuid, name text, email text, phone text, occasion text, occasion_type text, occasion_date date, next_date date, years integer, auto_on boolean, greeted_this_year boolean, quote_id uuid, last_event text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select n.id, n.name, n.email, n.phone, n.occasion, coalesce(n.occasion_type,'custom'),
         n.occasion_date,
         public._next_occasion(n.occasion_date) as next_date,
         (extract(year from public._next_occasion(n.occasion_date))::int
            - extract(year from n.occasion_date)::int) as years,
         n.auto_on,
         coalesce(n.last_greeted > current_date - interval '335 days', false) as greeted_this_year,
         n.quote_id,
         (select q.title from public.quotes q where q.id = n.quote_id) as last_event
  from public.nurture n
  where public.has_area('nurture','view')
    and n.org_id = public.current_org_id()
    and n.occasion_date is not null
    and public._next_occasion(n.occasion_date) <= current_date + (greatest(p_within_days,0) || ' days')::interval
  order by public._next_occasion(n.occasion_date);
$function$;

CREATE OR REPLACE FUNCTION public.password_change_required()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((select must_change_password from public.profiles where id = auth.uid()), false);
$function$;

CREATE OR REPLACE FUNCTION public.public_event_site(p_slug text)
 RETURNS TABLE(event_type text, template text, title text, data jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select s.event_type, s.template, s.title, s.data
    from public.event_sites s
   where s.slug = p_slug
     and s.status = 'published'
   limit 1;
$function$;

CREATE OR REPLACE FUNCTION public.public_get_portal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; prop public.event_proposal; ms jsonb; gal jsonb; outstanding numeric; studio jsonb;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select * into prop from public.event_proposal where quote_id = q.id;
  select jsonb_build_object('name', o.name, 'brand', o.brand) into studio
    from public.organizations o where o.id = q.org_id;
  select coalesce(jsonb_agg(jsonb_build_object('label',label,'due_date',due_date,'amount',amount,'status',status)
                            order by seq, due_date), '[]'::jsonb)
    into ms from public.payment_milestones where quote_id = q.id;
  select coalesce(sum(amount),0) into outstanding
    from public.payment_milestones where quote_id = q.id and status not in ('paid','waived');
  select coalesce(jsonb_agg(jsonb_build_object('url',url,'kind',kind,'caption',caption)
                            order by seq, created_at), '[]'::jsonb)
    into gal from public.event_media where quote_id = q.id and in_gallery = true;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_type',q.event_type,
                                'event_date',q.event_date,'event_time',q.event_time,
                                'status',q.status,'stage',q.lifecycle_stage),
    'studio', studio,
    'client_name', coalesce(q.client->>'name',''),
    'approval_status', q.approval_status,
    'total', coalesce((q.pricing->>'total')::numeric, 0),
    'proposal', case when prop.quote_id is not null and prop.published
                  then jsonb_build_object('concept',prop.concept,'theme',prop.theme,
                                          'palette',prop.palette,'images',prop.images,'scope',prop.scope)
                  else null end,
    'payment', jsonb_build_object('milestones', ms, 'outstanding', outstanding),
    'gallery', gal);
end; $function$;

CREATE OR REPLACE FUNCTION public.public_get_proposal(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing,
    'total', coalesce((q.pricing->>'total')::numeric, 0));
end; $function$;

CREATE OR REPLACE FUNCTION public.public_get_quote(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  return jsonb_build_object(
    'code', q.code, 'title', q.title, 'event_type', q.event_type,
    'status', q.status, 'approval_status', q.approval_status,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing);
end; $function$;

-- END PART 4b (functions: clear_password_change_required .. public_get_quote).

CREATE OR REPLACE FUNCTION public.publish_event_site(p_id uuid, p_publish boolean DEFAULT true)
 RETURNS event_sites
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_org uuid := current_org_id(); v_row public.event_sites; v_base text; v_slug text; v_try int := 0;
begin
  if v_org is null then raise exception 'no organization in context'; end if;
  if not has_area('quotes','edit') then raise exception 'not permitted'; end if;
  select * into v_row from public.event_sites where id = p_id and org_id = v_org;
  if not found then raise exception 'invitation site not found'; end if;
  if not p_publish then
    update public.event_sites set status='unpublished', updated_at=now()
     where id=p_id and org_id=v_org returning * into v_row; return v_row;
  end if;
  v_base := lower(coalesce(nullif(trim(v_row.title),''), v_row.data->>'names', 'invitation'));
  v_base := trim(both '-' from regexp_replace(v_base, '[^a-z0-9]+', '-', 'g'));
  v_base := left(v_base, 40);
  if coalesce(v_base,'') = '' then v_base := 'invitation'; end if;
  if v_row.slug is null or v_row.slug not like v_base || '-%' then
    loop
      v_slug := v_base || '-' || substr(replace(gen_random_uuid()::text,'-',''), 1, 6);
      exit when not exists (select 1 from public.event_sites where slug=v_slug and id<>p_id);
      v_try := v_try + 1; exit when v_try > 6;
    end loop;
  else v_slug := v_row.slug; end if;
  update public.event_sites
     set slug=v_slug, status='published', published_at=coalesce(published_at,now()), updated_at=now()
   where id=p_id and org_id=v_org returning * into v_row;
  return v_row;
end$function$;

CREATE OR REPLACE FUNCTION public.publish_proposal(p_quote_id uuid, p_published boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  select share_token into tok from public.event_proposal where quote_id = p_quote_id;
  if tok is null and p_published then tok := gen_random_uuid(); end if;
  update public.event_proposal
     set published = p_published, share_token = coalesce(tok, share_token), updated_at = now()
   where quote_id = p_quote_id;
  return tok;
end; $function$;

CREATE OR REPLACE FUNCTION public.queue_nurture_greeting(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text := 'Blueprint Stage';
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id and org_id = public.current_org_id();
  if not found then raise exception 'contact not found'; end if;

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot and org_id = public.current_org_id();
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom' and org_id = public.current_org_id(); end if;

  v_years := coalesce(extract(year from public._next_occasion(n.occasion_date))::int
                      - extract(year from n.occasion_date)::int, 0);
  select q.title into v_last from public.quotes q where q.id = n.quote_id;
  v_last := coalesce(v_last, 'your event with us');
  select array_agg(url order by seq, created_at) into v_photos
    from (select url, seq, created_at from public.event_media
          where quote_id = n.quote_id and in_gallery = true order by seq, created_at limit 3) m;

  v_subject := replace(replace(replace(replace(replace(coalesce(tpl.subject,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);
  v_body := replace(replace(replace(replace(replace(coalesce(tpl.body,''),
      '{{name}}', coalesce(n.name,'there')), '{{occasion}}', coalesce(n.occasion,ot)),
      '{{years}}', v_years::text), '{{last_event}}', v_last), '{{studio}}', v_studio);

  v_detail := jsonb_build_object(
    'subject', v_subject, 'body', v_body,
    'photos', to_jsonb(coalesce(v_photos, array[]::text[])),
    'occasion_type', ot, 'contact', n.name, 'auto', n.auto_on);

  perform public._notify(n.quote_id, 'email', n.email, 'nurture_'||ot, v_detail);
  update public.nurture set last_greeted = current_date where id = p_id and org_id = public.current_org_id();
  return v_detail;
end; $function$;

CREATE OR REPLACE FUNCTION public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare qt uuid; tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into qt from public.event_tasks where id=p_task_id and org_id=public.current_org_id();
  if qt is null then raise exception 'no such task'; end if;
  select token into tok from public.work_tokens where quote_id=qt and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,qt,p_phone,p_name); end if;
  update public.event_tasks set crew_id=p_crew_id, assignee_name=p_name, assignee_phone=p_phone,
    status='assigned', responded_at=null, started_at=null, completed_at=null where id=p_task_id;
  perform public._notify(qt,'sms',p_phone,'task_assigned', jsonb_build_object('reassigned',true,'token',tok));
  return jsonb_build_object('work_token',tok);
end; $function$;

CREATE OR REPLACE FUNCTION public.rebrand_quote_code(p_quote_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; v_stamp text; v_next int; v_code text; v_try int := 0;
begin
  if not public.has_area('quotes','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'quote not found'; end if;
  if q.event_date is null then return q.code; end if;
  v_stamp := to_char(q.event_date, 'MMDDYYYY');
  if q.code like v_stamp || '-%' then return q.code; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%' and org_id = public.current_org_id();
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      update public.quotes set code = v_code where id = p_quote_id and org_id = public.current_org_id();
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  return v_code;
end; $function$;

CREATE OR REPLACE FUNCTION public.record_payment(p_quote uuid, p_amount numeric, p_method text DEFAULT 'cash'::text, p_receipt_no text DEFAULT NULL::text, p_milestone uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.quotes; rno text; seqn int; studio_email text; existing public.quote_payments; tries int := 0;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  select * into q from public.quotes where id = p_quote and org_id = public.current_org_id();
  if q.id is null then raise exception 'no such event' using errcode='42501'; end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'amount must be greater than zero'; end if;

  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is not null then
    select * into existing from public.quote_payments
      where quote_id = p_quote and idempotency_key = p_idempotency_key limit 1;
    if existing.id is not null then
      return jsonb_build_object('receipt_no', existing.receipt_no, 'amount', existing.amount,
        'method', existing.method, 'booking','confirmed', 'idempotent_replay', true);
    end if;
  end if;

  loop
    tries := tries + 1;
    select count(*)+1 into seqn from public.quote_payments where quote_id = p_quote and status = 'paid';
    rno := coalesce(nullif(btrim(coalesce(p_receipt_no,'')),''), 'RCP-'||q.code||'-'||lpad(seqn::text,2,'0'));
    begin
      insert into public.quote_payments(quote_id, provider, amount, status, provider_ref, receipt_no, method, simulated, paid_at, note, idempotency_key)
        values (p_quote, coalesce(p_method,'cash'), p_amount, 'paid', rno, rno, coalesce(p_method,'cash'),
                (coalesce(p_method,'cash') <> 'cash'), now(), nullif(btrim(coalesce(p_note,'')),''),
                nullif(btrim(coalesce(p_idempotency_key,'')),''));
      exit;
    exception
      when unique_violation then
        if nullif(btrim(coalesce(p_receipt_no,'')),'') is not null then
          raise exception 'receipt number % already exists for this event', rno using errcode='23505';
        end if;
        if tries >= 5 then raise; end if;
    end;
  end loop;

  if p_milestone is not null then
    update public.payment_milestones set status='paid', paid_at=now() where id = p_milestone and quote_id = p_quote;
  else
    update public.payment_milestones set status='paid', paid_at=now()
      where id = (select id from public.payment_milestones where quote_id = p_quote and status <> 'paid' order by seq, due_date limit 1);
  end if;

  update public.quotes
     set approval_status = 'paid',
         status = case when status <> 'confirmed' then 'confirmed' else status end,
         lifecycle_stage = case when lifecycle_stage in ('lead','discovery','proposal','quote','confirmed')
                                then 'planning' else lifecycle_stage end,
         updated_at = now()
   where id = p_quote and org_id = public.current_org_id();

  select business_email into studio_email from public.organizations where id = q.org_id;
  perform public._notify(p_quote,'email', q.client->>'email', 'payment_receipt',
    jsonb_build_object('code',q.code,'amount',p_amount,'receipt',rno,'method',coalesce(p_method,'cash'),'booking','confirmed'));
  perform public._notify(p_quote,'email', coalesce(studio_email,''), 'advance_paid',
    jsonb_build_object('code',q.code,'amount',p_amount,'client',q.client->>'name','receipt',rno,'method',coalesce(p_method,'cash')));

  return jsonb_build_object('receipt_no', rno, 'amount', p_amount, 'method', coalesce(p_method,'cash'), 'booking','confirmed');
end; $function$;

CREATE OR REPLACE FUNCTION public.remove_event_dish(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q uuid; locked boolean;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id and org_id = public.current_org_id();
  if q is null then return; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  delete from public.event_menu_items where id = p_id and org_id = public.current_org_id();
end; $function$;

CREATE OR REPLACE FUNCTION public.request_otp(p_token uuid, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  code := lpad((floor(random() * 1000000))::int::text, 6, '0');
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  if live then
    return jsonb_build_object('sent', true, 'live', true, 'delivery', 'sms', 'dev_code', null);
  elsif public._flag('otp_dev_echo') then
    return jsonb_build_object('sent', true, 'live', false, 'delivery', 'dev_echo', 'dev_code', code);
  else
    return jsonb_build_object('sent', false, 'live', false, 'delivery', 'unavailable', 'dev_code', null,
      'message', 'OTP delivery is not configured. Enable a live SMS provider (sms_live=true) or, for local development only, set channels.otp_dev_echo=true in app_config.');
  end if;
end; $function$;

CREATE OR REPLACE FUNCTION public.revoke_approval_token(p_quote_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  update public.quotes
     set approval_token = null,
         approval_token_revoked_at = now(),
         approval_status = case when approval_status in ('sent','none') then 'cancelled' else approval_status end,
         updated_at = now()
   where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'no such event' using errcode='42501'; end if;
  return jsonb_build_object('revoked', true);
end; $function$;

CREATE OR REPLACE FUNCTION public.run_nurture_auto(p_within_days integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.nurture_automation; within int; d record; cnt int := 0;
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into a from public.nurture_automation where id = 1 and org_id = public.current_org_id();
  if not coalesce(a.enabled,false) then return 0; end if;
  within := coalesce(p_within_days, a.within_days, 0);
  for d in
    select nd.* from public.nurture_due(within) nd
    join public.nurture_templates t on t.occasion_type = nd.occasion_type and t.org_id = public.current_org_id()
    where nd.auto_on = true and nd.greeted_this_year = false
      and nd.email is not null and t.enabled = true
  loop
    perform public.queue_nurture_greeting(d.id);
    cnt := cnt + 1;
  end loop;
  return cnt;
end; $function$;

CREATE OR REPLACE FUNCTION public.run_task_reminders(p_quote uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t record; cnt int := 0;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where org_id = public.current_org_id()
      and (p_quote is null or quote_id = p_quote)
      and is_special = true
      and status not in ('completed','cancelled')
      and (last_reminded_at is null
           or last_reminded_at <= now() - make_interval(mins => greatest(remind_every_min,1)))
  loop
    perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_reminder',
      jsonb_build_object('task', t.title, 'category', t.category, 'every_min', t.remind_every_min));
    update public.event_tasks set last_reminded_at = now() where id = t.id;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $function$;

CREATE OR REPLACE FUNCTION public.run_task_triggers(p_quote uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t record; dep public.event_tasks; cnt int := 0; ok boolean;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  for t in
    select * from public.event_tasks
    where org_id = public.current_org_id()
      and (p_quote is null or quote_id = p_quote)
      and status in ('assigned','accepted')
      and planned_start is not null and planned_start <= now()
      and triggered_at is null
  loop
    ok := true;
    if t.depends_on is not null then
      select * into dep from public.event_tasks where id = t.depends_on and org_id = public.current_org_id();
      ok := found and dep.status = 'completed' and dep.verify_status = 'passed';
    end if;
    if ok then
      perform public._notify(t.quote_id, 'sms', t.assignee_phone, 'task_due',
        jsonb_build_object('task', t.title, 'category', t.category));
      update public.event_tasks set triggered_at = now() where id = t.id;
      cnt := cnt + 1;
    end if;
  end loop;
  return cnt;
end $function$;

CREATE OR REPLACE FUNCTION public.save_quotation_version(p_quote uuid, p_pricing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare n int; lbl text; tot numeric;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote);
  tot := public.helm_quote_total(p_pricing);
  if p_pricing is not null and (p_pricing ? 'subtotal') then
    p_pricing := jsonb_set(p_pricing, '{total}', to_jsonb(tot));
  end if;
  select count(*)+1 into n from public.quotation_versions where quote_id = p_quote;
  lbl := 'Q'||n;
  insert into public.quotation_versions(quote_id, label, pricing, total, created_by)
    values (p_quote, lbl, coalesce(p_pricing,'{}'::jsonb), tot, auth.uid());
  update public.quotes set pricing = coalesce(p_pricing, pricing), updated_at = now()
    where id = p_quote and org_id = public.current_org_id();
  return jsonb_build_object('label', lbl, 'total', tot);
end $function$;

CREATE OR REPLACE FUNCTION public.set_closure(p_quote_id uuid, p_rating integer, p_feedback text, p_testimonial text, p_media_consent boolean, p_lessons text)
 RETURNS event_closure
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_closure (quote_id, client_rating, feedback, testimonial, media_consent, lessons, updated_at, updated_by)
  values (p_quote_id, p_rating, p_feedback, p_testimonial, coalesce(p_media_consent,false), p_lessons, now(), auth.uid())
  on conflict (quote_id) do update set
    client_rating=excluded.client_rating, feedback=excluded.feedback, testimonial=excluded.testimonial,
    media_consent=excluded.media_consent, lessons=excluded.lessons, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_discovery(p_quote_id uuid, p_meet_date date, p_mode text, p_location text, p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric)
 RETURNS event_discovery
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_discovery
    (quote_id, meet_date, mode, location, attendees, notes, budget_min, budget_max, updated_at, updated_by)
  values
    (p_quote_id, p_meet_date, p_mode, p_location, p_attendees, p_notes, p_budget_min, p_budget_max, now(), auth.uid())
  on conflict (quote_id) do update set
    meet_date=excluded.meet_date, mode=excluded.mode, location=excluded.location,
    attendees=excluded.attendees, notes=excluded.notes,
    budget_min=excluded.budget_min, budget_max=excluded.budget_max,
    updated_at=now(), updated_by=auth.uid()
  returning * into d;
  return d;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_event_dish_qty(p_id uuid, p_qty numeric)
 RETURNS event_menu_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q uuid; locked boolean; row public.event_menu_items;
begin
  if not public.has_area('plan','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into q from public.event_menu_items where id = p_id and org_id = public.current_org_id();
  if q is null then raise exception 'no such menu item'; end if;
  select menu_locked into locked from public.event_plan where quote_id = q;
  if coalesce(locked,false) then raise exception 'menu is locked'; end if;
  if p_qty is not null and p_qty < 0 then raise exception 'quantity cannot be negative'; end if;
  update public.event_menu_items set qty = p_qty where id = p_id and org_id = public.current_org_id() returning * into row;
  return row;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_event_plan(p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text, p_access_notes text, p_package text, p_menu text)
 RETURNS event_plan
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_stage not in ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed')
    then raise exception 'invalid stage: %', p_stage; end if;
  update public.quotes set lifecycle_stage = p_stage, updated_at = now()
    where id = p_quote_id and org_id = public.current_org_id();
  if not found then raise exception 'no such event'; end if;
  return jsonb_build_object('stage', p_stage);
end; $function$;

CREATE OR REPLACE FUNCTION public.set_plan_lock(p_quote_id uuid, p_locked boolean)
 RETURNS event_plan
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_plan (quote_id, menu_locked, locked_at, locked_by, updated_at, updated_by)
    values (p_quote_id, p_locked, case when p_locked then now() end, case when p_locked then auth.uid() end, now(), auth.uid())
  on conflict (quote_id) do update set
    menu_locked=p_locked, locked_at = case when p_locked then now() else null end,
    locked_by = case when p_locked then auth.uid() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
 RETURNS event_plan
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  if p_field not in ('dry_run','briefing') then raise exception 'unknown sign-off field %', p_field; end if;
  insert into public.event_plan (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  update public.event_plan set
    dry_run_at  = case when p_field='dry_run'  then (case when p_done then now() else null end) else dry_run_at  end,
    briefing_at = case when p_field='briefing' then (case when p_done then now() else null end) else briefing_at end,
    updated_at  = now(), updated_by = auth.uid()
  where quote_id = p_quote_id
  returning * into r;
  return r;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_pricing_config(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.has_area('controls','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.app_config(org_id, key, value, updated_at) values (public.current_org_id(), 'pricing', p, now())
    on conflict (org_id, key) do update set value=excluded.value, updated_at=now();
  return p;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_proposal(p_quote_id uuid, p_concept text, p_theme text, p_palette jsonb, p_images jsonb, p_scope jsonb)
 RETURNS event_proposal
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  perform public.assert_quote_org(p_quote_id);
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $function$;

CREATE OR REPLACE FUNCTION public.set_task_schedule(p_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_depends uuid)
 RETURNS event_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  if p_depends = p_id then raise exception 'a task cannot depend on itself'; end if;
  update public.event_tasks
     set planned_start = p_start,
         planned_end   = coalesce(p_end, planned_end),
         depends_on    = p_depends,
         triggered_at  = null
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $function$;

CREATE OR REPLACE FUNCTION public.set_task_special(p_id uuid, p_on boolean, p_every_min integer DEFAULT 5)
 RETURNS event_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.event_tasks;
begin
  if not public.has_area('staff','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  update public.event_tasks
     set is_special = coalesce(p_on,false),
         remind_every_min = greatest(coalesce(p_every_min,5), 1),
         last_reminded_at = case when coalesce(p_on,false) then last_reminded_at else null end
   where id = p_id and org_id = public.current_org_id()
   returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ begin new.updated_at = now(); return new; end; $function$;

CREATE OR REPLACE FUNCTION public.sync_quote_to_lead()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name  text := nullif(btrim(NEW.client->>'name'), '');
  v_email text := nullif(btrim(NEW.client->>'email'), '');
  v_phone text := nullif(btrim(NEW.client->>'phone'), '');
  v_status text;
  v_lead public.leads;
begin
  if v_name is null then return NEW; end if;
  v_status := case
    when NEW.status = 'cancelled'                          then 'lost'
    when NEW.approval_status = 'paid'
      or NEW.status = 'confirmed'
      or NEW.lifecycle_stage in ('planning','event','settlement','closed') then 'won'
    when NEW.lifecycle_stage = 'discovery'                 then 'discovery'
    else 'quoted' end;
  select * into v_lead from public.leads where quote_id = NEW.id and org_id = NEW.org_id limit 1;
  if v_lead.id is null then
    select * into v_lead from public.leads
     where org_id = NEW.org_id and quote_id is null
       and ( (v_email is not null and lower(coalesce(email,'')) = lower(v_email))
          or (v_email is null and lower(coalesce(name,'')) = lower(v_name)) )
     order by updated_at desc limit 1;
  end if;
  if v_lead.id is not null then
    update public.leads set
      name       = v_name,
      email      = coalesce(v_email, email),
      phone      = coalesce(v_phone, phone),
      event_type = coalesce(NEW.event_type, event_type),
      event_date = coalesce(NEW.event_date, event_date),
      status     = case when status in ('won','lost') and v_status in ('quoted','discovery')
                        then status else v_status end,
      quote_id   = NEW.id,
      updated_at = now()
     where id = v_lead.id;
  else
    insert into public.leads (org_id, name, phone, email, source, event_type, event_date, status, quote_id)
      values (NEW.org_id, v_name, v_phone, v_email, 'quote', NEW.event_type, NEW.event_date, v_status, NEW.id);
  end if;
  return NEW;
end; $function$;

CREATE OR REPLACE FUNCTION public.task_verify_summary(p_quote uuid)
 RETURNS TABLE(total integer, completed integer, pending integer, passed integer, rejected integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::int,
         count(*) filter (where status = 'completed')::int,
         count(*) filter (where verify_status = 'pending')::int,
         count(*) filter (where verify_status = 'passed')::int,
         count(*) filter (where verify_status = 'rejected')::int
  from public.event_tasks where quote_id = p_quote and org_id = public.current_org_id();
$function$;

CREATE OR REPLACE FUNCTION public.tg_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_id text;
  v_quote uuid;
  v_changed jsonb;
  o jsonb; n jsonb;
begin
  if v_actor is not null then select email into v_email from auth.users where id = v_actor; end if;
  if tg_op = 'DELETE' then n := to_jsonb(OLD); else n := to_jsonb(NEW); end if;
  if tg_op = 'UPDATE' then o := to_jsonb(OLD); end if;

  v_id := coalesce(n->>'id', n->>'quote_id');
  if tg_table_name = 'quotes' then v_quote := (n->>'id')::uuid;
  elsif n ? 'quote_id' then v_quote := nullif(n->>'quote_id','')::uuid;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(key, jsonb_build_array(o->key, n->key))
      into v_changed
      from jsonb_object_keys(n) as key
      where (o->key) is distinct from (n->key)
        and key not in ('updated_at','confirmed_at');
    if v_changed is null then return null; end if;
  else
    v_changed := n;
  end if;

  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, changed)
    values (v_actor, v_email, lower(tg_op), tg_table_name, v_id, v_quote, v_changed);
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.tg_org_from_quote()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if NEW.org_id is null and NEW.quote_id is not null then
    select org_id into NEW.org_id from public.quotes where id = NEW.quote_id;
  end if;
  if NEW.org_id is null then NEW.org_id := public.current_org_id(); end if;
  return NEW;
end; $function$;

CREATE OR REPLACE FUNCTION public.tg_task_verify()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'completed' and (old.status is distinct from 'completed')
     and new.verify_status = 'unverified' then
    new.verify_status := 'pending';
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.user_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select role from public.profiles where id = auth.uid(); $function$;

CREATE OR REPLACE FUNCTION public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean, p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token
    and (approval_token_expires_at is null or approval_token_expires_at > now());
  if q.id is null then raise exception 'invalid link'; end if;
  select * into rec from public.quote_otps
    where quote_id=q.id and phone=p_phone and verified_at is null and expires_at > now()
    order by created_at desc limit 1;
  if rec.id is null then raise exception 'no active code — request a new OTP'; end if;
  if rec.attempts >= 5 then raise exception 'too many attempts — request a new OTP'; end if;
  if extensions.crypt(p_code, rec.code_hash) <> rec.code_hash then
    update public.quote_otps set attempts = attempts+1 where id = rec.id;
    raise exception 'incorrect code';
  end if;
  if p_agreed is not true then raise exception 'you must accept the terms to confirm'; end if;
  update public.quote_otps set verified_at = now() where id = rec.id;
  insert into public.quote_consents(quote_id, phone, client_name, terms_version, consent_text, agreed, verified_via_otp, user_agent)
    values (q.id, p_phone, p_client_name, p_terms_version, p_consent_text, true, true, p_user_agent);
  update public.quotes set approval_status='approved', updated_at=now() where id=q.id;
  return jsonb_build_object('approved', true);
end; $function$;

CREATE OR REPLACE FUNCTION public.verify_task(p_id uuid, p_pass boolean, p_note text DEFAULT NULL::text)
 RETURNS event_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare row public.event_tasks;
begin
  if not (public.user_role() in ('admin','manager','planner','quality')) then
    raise exception 'only a quality engineer or manager can verify tasks' using errcode='42501';
  end if;
  update public.event_tasks set
    verify_status = case when p_pass then 'passed' else 'rejected' end,
    verified_by   = auth.uid(),
    verified_at   = now(),
    verify_note   = nullif(btrim(coalesce(p_note,'')),''),
    status        = case when p_pass then status else 'in_progress' end,
    completed_at  = case when p_pass then completed_at else null end
  where id = p_id and org_id = public.current_org_id()
  returning * into row;
  if not found then raise exception 'task not found'; end if;
  return row;
end $function$;

CREATE OR REPLACE FUNCTION public.worker_checkin_equipment(p_token uuid, p_id uuid, p_qty_in numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w public.work_tokens; row public.inventory_checkouts; digits text; ok boolean;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into row from public.inventory_checkouts where id = p_id;
  if not found then raise exception 'checkout not found'; end if;
  if row.quote_id is distinct from w.quote_id then raise exception 'not your event' using errcode='42501'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select exists(select 1 from public.crew_members cm where cm.id = row.issued_to_id
                and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits) into ok;
  if not ok then raise exception 'not your equipment' using errcode='42501'; end if;
  if coalesce(p_qty_in,0) < 0 then raise exception 'returned count cannot be negative'; end if;
  update public.inventory_checkouts
     set qty_in = coalesce(p_qty_in,0),
         returned_by = coalesce(nullif(btrim(w.name),''),'crew'),
         checked_in_at = now(),
         status = case when coalesce(p_qty_in,0) >= qty_out then 'returned' else 'partial' end
   where id = p_id
   returning * into row;
  return jsonb_build_object('ok',true,'status',row.status,'qty_in',row.qty_in,'qty_out',row.qty_out);
end; $function$;

CREATE OR REPLACE FUNCTION public.worker_get_equipment(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w public.work_tokens; items jsonb; digits text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  digits := regexp_replace(coalesce(w.phone,''),'[^0-9]','','g');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'item', i.name, 'unit', i.unit,
           'qty_out', c.qty_out, 'qty_in', c.qty_in, 'status', c.status
         ) order by i.name), '[]'::jsonb) into items
    from public.inventory_checkouts c
    join public.inventory_items i on i.id = c.item_id
    join public.crew_members cm on cm.id = c.issued_to_id
   where c.quote_id = w.quote_id
     and c.status in ('out','partial')
     and regexp_replace(coalesce(cm.phone,''),'[^0-9]','','g') = digits;
  return jsonb_build_object('equipment', items);
end; $function$;

CREATE OR REPLACE FUNCTION public.worker_get_tasks(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object(
    'event', jsonb_build_object('code',q.code,'title',q.title,'event_date',q.event_date,'event_time',q.event_time),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone),
    'tasks', tasks);
end; $function$;

CREATE OR REPLACE FUNCTION public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare w public.work_tokens; tsk public.event_tasks; newst text;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into tsk from public.event_tasks where id=p_task_id and quote_id=w.quote_id and assignee_phone=w.phone;
  if tsk.id is null then raise exception 'task not found'; end if;
  newst := case p_action
    when 'accept'   then 'accepted'
    when 'reject'   then 'rejected'
    when 'start'    then 'in_progress'
    when 'complete' then 'completed'
    else null end;
  if newst is null then raise exception 'invalid action'; end if;
  if p_action='start'    and tsk.status not in ('accepted','assigned') then raise exception 'accept the task first'; end if;
  if p_action='complete' and tsk.status not in ('in_progress','accepted') then raise exception 'start the task first'; end if;
  update public.event_tasks set status=newst,
    responded_at = case when p_action in ('accept','reject') then now() else responded_at end,
    started_at   = case when p_action='start'    then now() else started_at end,
    completed_at = case when p_action='complete' then now() else completed_at end
    where id=p_task_id;
  perform public._notify(w.quote_id,'sms',null,'task_'||p_action, jsonb_build_object('task',tsk.title,'worker',w.name));
  return jsonb_build_object('ok',true,'status',newst);
end; $function$;

-- END PART 4c (functions: publish_event_site .. worker_respond — 101/101 complete).

-- ===========================================================================
-- 6) ROW LEVEL SECURITY  (enable on all 59 tables; rls_forced stays off)
-- ===========================================================================
alter table public.app_config              enable row level security;
alter table public.audit_log               enable row level security;
alter table public.chair_types             enable row level security;
alter table public.change_requests         enable row level security;
alter table public.checklist_templates     enable row level security;
alter table public.coupons                 enable row level security;
alter table public.crew_members            enable row level security;
alter table public.dish_catalog            enable row level security;
alter table public.event_attendees         enable row level security;
alter table public.event_checklist         enable row level security;
alter table public.event_closure           enable row level security;
alter table public.event_costs             enable row level security;
alter table public.event_day               enable row level security;
alter table public.event_discovery         enable row level security;
alter table public.event_guests            enable row level security;
alter table public.event_issues            enable row level security;
alter table public.event_media             enable row level security;
alter table public.event_menu_items        enable row level security;
alter table public.event_plan              enable row level security;
alter table public.event_proposal          enable row level security;
alter table public.event_ratings           enable row level security;
alter table public.event_refunds           enable row level security;
alter table public.event_requirements      enable row level security;
alter table public.event_resource_needs    enable row level security;
alter table public.event_resources         enable row level security;
alter table public.event_sites             enable row level security;
alter table public.event_stock_requests    enable row level security;
alter table public.event_tasks             enable row level security;
alter table public.expense_claims          enable row level security;
alter table public.inventory_checkouts     enable row level security;
alter table public.inventory_items         enable row level security;
alter table public.inventory_reservations  enable row level security;
alter table public.invitations             enable row level security;
alter table public.layout_rules            enable row level security;
alter table public.layouts                 enable row level security;
alter table public.lead_archive            enable row level security;
alter table public.leads                   enable row level security;
alter table public.menu_templates          enable row level security;
alter table public.notification_seen       enable row level security;
alter table public.notifications           enable row level security;
alter table public.nurture                 enable row level security;
alter table public.nurture_automation      enable row level security;
alter table public.nurture_templates       enable row level security;
alter table public.organizations           enable row level security;
alter table public.payment_milestones      enable row level security;
alter table public.plate_types             enable row level security;
alter table public.profiles                enable row level security;
alter table public.proposal_risks          enable row level security;
alter table public.quotation_versions      enable row level security;
alter table public.quote_consents          enable row level security;
alter table public.quote_otps              enable row level security;  -- deny-all: RLS on, ZERO policies (intentional)
alter table public.quote_payments          enable row level security;
alter table public.quote_versions          enable row level security;
alter table public.quotes                  enable row level security;
alter table public.role_access             enable row level security;
alter table public.run_sheet_items         enable row level security;
alter table public.task_templates          enable row level security;
alter table public.vendors                 enable row level security;
alter table public.work_tokens             enable row level security;

-- ===========================================================================
-- 7) POLICIES  (byte-for-byte predicates; role = authenticated unless noted)
-- ===========================================================================

-- config-style tables: read=own org, write=controls/edit
create policy "cfg read"  on public.app_config      for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.app_config      for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.chair_types     for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.chair_types     for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.coupons         for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.coupons         for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.dish_catalog    for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.dish_catalog    for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.layout_rules    for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.layout_rules    for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.menu_templates  for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.menu_templates  for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "cfg read"  on public.plate_types     for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "cfg write" on public.plate_types     for all    to authenticated using (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('controls'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- audit_log: read-only for admins/controls-view
create policy "audit read" on public.audit_log for select to authenticated using ((is_admin() OR has_area('controls'::text, 'view'::text)) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- role_access: read own org
create policy "ra read" on public.role_access for select to authenticated using (org_id = ( SELECT current_org_id() AS current_org_id));

-- organizations: self read/write
create policy "org self read"  on public.organizations for select to authenticated using (id = ( SELECT current_org_id() AS current_org_id));
create policy "org self write" on public.organizations for update to authenticated using (id = ( SELECT current_org_id() AS current_org_id)) with check (id = ( SELECT current_org_id() AS current_org_id));

-- profiles: self or same-org read
create policy "profiles read" on public.profiles for select to authenticated using ((id = auth.uid()) OR (org_id = ( SELECT current_org_id() AS current_org_id)));

-- notification_seen: self only
create policy "seen self" on public.notification_seen for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- invitations (users area)
create policy "inv read" on public.invitations for select to authenticated using (has_area('users'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "inv ins"  on public.invitations for insert to authenticated with check (has_area('users'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "inv upd"  on public.invitations for update to authenticated using (has_area('users'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('users'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "inv del"  on public.invitations for delete to authenticated using (has_area('users'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- layouts (org-scoped; not_null org guard)
create policy "layouts read"   on public.layouts for select to authenticated using ((org_id IS NOT NULL) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "layouts insert" on public.layouts for insert to authenticated with check (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "layouts update" on public.layouts for update to authenticated using ((org_id IS NOT NULL) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (org_id = ( SELECT current_org_id() AS current_org_id));
create policy "layouts delete" on public.layouts for delete to authenticated using ((org_id IS NOT NULL) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- quotation_versions (quotes area, read/write split)
create policy "qv read"  on public.quotation_versions for select to authenticated using (has_area('quotes'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "qv write" on public.quotation_versions for all    to authenticated using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- event_attendees (quotes area; policy names ea *)
create policy "ea view" on public.event_attendees for select to authenticated using (has_area('quotes'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "ea ins"  on public.event_attendees for insert to authenticated with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "ea upd"  on public.event_attendees for update to authenticated using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "ea del"  on public.event_attendees for delete to authenticated using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- event_sites: baseline is role `public` (WAVE-09 re-scopes to authenticated separately)
create policy "event_sites_select" on public.event_sites for select to public using (has_area('quotes'::text, 'view'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "event_sites_insert" on public.event_sites for insert to public with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "event_sites_update" on public.event_sites for update to public using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id))) with check (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));
create policy "event_sites_delete" on public.event_sites for delete to public using (has_area('quotes'::text, 'edit'::text) AND (org_id = ( SELECT current_org_id() AS current_org_id)));

-- ---- Standard "ra view/ins/upd/del" sets (area shown per table) --------------
-- Emitted via DO block to keep predicates identical across the 30 tables.
do $ra$
declare
  r record;
  org text := '(org_id = ( SELECT current_org_id() AS current_org_id))';
begin
  for r in
    select * from (values
      ('change_requests','finance'), ('checklist_templates','templates'),
      ('crew_members','staff'),      ('event_checklist','plan'),
      ('event_closure','closure'),   ('event_costs','finance'),
      ('event_day','command'),       ('event_discovery','discovery'),
      ('event_guests','command'),    ('event_issues','issues'),
      ('event_media','media'),       ('event_menu_items','plan'),
      ('event_plan','plan'),         ('event_proposal','proposal'),
      ('event_ratings','closure'),   ('event_refunds','settlement'),
      ('event_requirements','discovery'), ('event_resource_needs','vendors'),
      ('event_resources','vendors'), ('event_stock_requests','command'),
      ('event_tasks','staff'),       ('expense_claims','finance'),
      ('inventory_checkouts','inventory'), ('inventory_items','inventory'),
      ('inventory_reservations','inventory'), ('lead_archive','crm'),
      ('leads','leads'),             ('notifications','quotes'),
      ('nurture','nurture'),         ('nurture_automation','nurture'),
      ('nurture_templates','nurture'), ('payment_milestones','finance'),
      ('proposal_risks','proposal'), ('quote_consents','quotes'),
      ('quote_payments','quotes'),   ('quote_versions','quotes'),
      ('quotes','quotes'),           ('run_sheet_items','runsheet'),
      ('task_templates','templates'),('vendors','vendors'),
      ('work_tokens','staff')
    ) as t(tbl, area)
  loop
    execute format(
      'create policy "ra view" on public.%I for select to authenticated using (has_area(%L, %L) AND %s)',
      r.tbl, r.area, 'view', org);
    execute format(
      'create policy "ra ins" on public.%I for insert to authenticated with check (has_area(%L, %L) AND %s)',
      r.tbl, r.area, 'edit', org);
    execute format(
      'create policy "ra upd" on public.%I for update to authenticated using (has_area(%L, %L) AND %s) with check (has_area(%L, %L) AND %s)',
      r.tbl, r.area, 'edit', org, r.area, 'edit', org);
    execute format(
      'create policy "ra del" on public.%I for delete to authenticated using (has_area(%L, %L) AND %s)',
      r.tbl, r.area, 'edit', org);
  end loop;
end
$ra$;

-- END PART 5 (RLS + policies).

-- ===========================================================================
-- 8) TRIGGERS  (public schema)
-- ===========================================================================
create trigger audit_trg after insert or delete or update on public.app_config for each row execute function tg_audit();
create trigger org_from_quote before insert on public.audit_log for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.chair_types for each row execute function tg_audit();
create trigger audit_trg after insert or delete or update on public.change_requests for each row execute function tg_audit();
create trigger org_from_quote before insert on public.change_requests for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.coupons for each row execute function tg_audit();
create trigger audit_trg after insert or delete or update on public.crew_members for each row execute function tg_audit();
create trigger event_attendees_guard_trg before insert or update on public.event_attendees for each row execute function event_attendees_guard();
create trigger org_from_quote before insert on public.event_checklist for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_closure for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.event_costs for each row execute function tg_audit();
create trigger org_from_quote before insert on public.event_costs for each row execute function tg_org_from_quote();
create trigger event_day_set_updated before update on public.event_day for each row execute function set_updated_at();
create trigger org_from_quote before insert on public.event_day for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_discovery for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_guests for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_issues for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_media for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_menu_items for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_plan for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_proposal for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_ratings for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_refunds for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_requirements for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_resource_needs for each row execute function tg_org_from_quote();
create trigger event_res_set_updated before update on public.event_resources for each row execute function set_updated_at();
create trigger org_from_quote before insert on public.event_resources for each row execute function tg_org_from_quote();
create trigger event_sites_guard_biu before insert or update on public.event_sites for each row execute function event_sites_guard();
create trigger org_from_quote before insert on public.event_stock_requests for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.event_tasks for each row execute function tg_org_from_quote();
create trigger task_verify_trg before update on public.event_tasks for each row execute function tg_task_verify();
create trigger audit_trg after insert or delete or update on public.expense_claims for each row execute function tg_audit();
create trigger org_from_quote before insert on public.expense_claims for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.inventory_checkouts for each row execute function tg_audit();
create trigger org_from_quote before insert on public.inventory_checkouts for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.inventory_items for each row execute function tg_audit();
create trigger inv_res_set_updated before update on public.inventory_reservations for each row execute function set_updated_at();
create trigger org_from_quote before insert on public.inventory_reservations for each row execute function tg_org_from_quote();
create trigger layouts_set_updated_at before update on public.layouts for each row execute function set_updated_at();
create trigger layouts_stamp_org before insert on public.layouts for each row execute function _layouts_stamp_org();
create trigger org_from_quote before insert on public.lead_archive for each row execute function tg_org_from_quote();
create trigger leads_archive_del after delete on public.leads for each row execute function archive_lead();
create trigger leads_archive_ins after insert on public.leads for each row execute function archive_lead();
create trigger leads_archive_upd after update on public.leads for each row execute function archive_lead();
create trigger leads_set_updated before update on public.leads for each row execute function set_updated_at();
create trigger org_from_quote before insert on public.leads for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.notifications for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.nurture for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.payment_milestones for each row execute function tg_audit();
create trigger org_from_quote before insert on public.payment_milestones for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.plate_types for each row execute function tg_audit();
create trigger audit_trg after insert or delete or update on public.profiles for each row execute function tg_audit();
create trigger org_from_quote before insert on public.proposal_risks for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.quote_consents for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.quote_otps for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.quote_payments for each row execute function tg_audit();
create trigger org_from_quote before insert on public.quote_payments for each row execute function tg_org_from_quote();
create trigger org_from_quote before insert on public.quote_versions for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.quotes for each row execute function tg_audit();
create trigger quotes_enforce_pricing_total before insert or update of pricing on public.quotes for each row execute function enforce_pricing_total();
create trigger quotes_set_updated before update on public.quotes for each row execute function set_updated_at();
create trigger quotes_sync_lead_ins after insert on public.quotes for each row execute function sync_quote_to_lead();
create trigger quotes_sync_lead_upd after update on public.quotes for each row when (new.client is distinct from old.client or new.status is distinct from old.status or new.approval_status is distinct from old.approval_status or new.lifecycle_stage is distinct from old.lifecycle_stage or new.event_type is distinct from old.event_type or new.event_date is distinct from old.event_date) execute function sync_quote_to_lead();
create trigger audit_trg after insert or delete or update on public.role_access for each row execute function tg_audit();
create trigger org_from_quote before insert on public.run_sheet_items for each row execute function tg_org_from_quote();
create trigger audit_trg after insert or delete or update on public.vendors for each row execute function tg_audit();
create trigger org_from_quote before insert on public.work_tokens for each row execute function tg_org_from_quote();

-- ===========================================================================
-- 9) VIEW
-- ===========================================================================
create or replace view public.inventory_availability as
 select i.id,
    i.name,
    i.category,
    i.unit,
    i.total_qty,
    coalesce(sum(r.qty) filter (where r.status = any (array['reserved'::text, 'allocated'::text])), 0::numeric) as committed,
    i.total_qty - coalesce(sum(r.qty) filter (where r.status = any (array['reserved'::text, 'allocated'::text])), 0::numeric) as available
   from inventory_items i
     left join inventory_reservations r on r.item_id = i.id
  where i.active
  group by i.id;

-- ===========================================================================
-- 10) AUTH HOOK  (public-only extracts cannot capture this; recreated here)
--     New auth.users row -> seed a public.profiles row.
-- ===========================================================================
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===========================================================================
-- 11) GRANTS  (match Supabase defaults + prod exceptions)
-- ===========================================================================
grant usage on schema public to anon, authenticated, service_role;

-- Tables/views: prod grants ALL to anon/authenticated/service_role on every
-- public table EXCEPT layouts (no anon). RLS is what actually restricts rows.
grant all on all tables in schema public to anon, authenticated, service_role;
revoke all on public.layouts from anon;   -- prod: layouts is NOT anon-granted

-- Functions: prod exposes EXECUTE to public/authenticated broadly; every
-- privileged RPC self-checks is_admin()/can_edit()/has_area() internally, so
-- the grant layer is defense-in-depth. This mirrors the Supabase default.
grant execute on all functions in schema public to anon, authenticated, service_role;

-- OPTIONAL HARDENING (review; prod does NOT expose these to anon). Uncomment to
-- tighten staging beyond the default. Each still fails closed via its own guard.
-- revoke execute on function public.admin_store_otp(uuid, text, text) from anon, authenticated;

-- ===========================================================================
-- END OF FILE.  Remaining to complete a 100% match: paste worker_respond()
-- (see the flagged block in §5) — everything else is captured.
-- After a clean run here, apply WAVE-09 (PREFLIGHT -> UPGRADE -> VERIFY) to
-- re-scope event_sites to `authenticated`, IN STAGING ONLY.
-- ===========================================================================
