-- #########################################################################
-- Blueprint Stage — COMPLETE database setup (ALL-IN-ONE)
-- Run this ONE file top-to-bottom on a fresh Postgres/Supabase project.
-- Idempotent & safe to re-run.  See full-schema/README.md for the phase list.
-- #########################################################################


-- =====================================================================
-- SOURCE: setup-complete.sql
-- =====================================================================

-- =========================================================================
-- Blueprint Stage — COMPLETE database setup (run this ONE file).
-- Idempotent & safe to re-run. Brings a DB that already has `layouts` + `profiles`
-- fully up to date:
--   • role helpers + RBAC             (admin/planner/sales/operations/crew/client)
--   • fine-grained RLS on layouts     (view all · create/edit/delete by role)
--   • admin user-management RPCs      (add user / change role / remove — admin only)
--   • quotes + quote_versions         (quote → versions → confirm, with pricing)
-- Your existing users are NOT touched (the user-seeding block is left commented).
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- =========================================================================
-- 1) LAYOUTS (legacy floor store — kept for compatibility)
-- =========================================================================
create table if not exists public.layouts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default 'Untitled layout',
  data       jsonb not null default '{"items":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists layouts_updated_at_idx on public.layouts (updated_at desc);

-- shared updated_at trigger fn
create or replace function public.set_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists layouts_set_updated_at on public.layouts;
create trigger layouts_set_updated_at before update on public.layouts
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 2) PROFILES + ROLE HELPERS
-- =========================================================================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'client'
             check (role in ('admin','planner','sales','operations','crew','client')),
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER helpers bypass RLS (no recursion) and centralise the capability matrix
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales'), false); $$;
create or replace function public.can_delete() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner'), false); $$;
create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable as $$
  select p_role in ('admin','planner','sales','operations','crew','client'); $$;

-- auto-create a profile whenever an auth user is added
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================================
-- 3) ROW LEVEL SECURITY
-- =========================================================================
-- profiles: a user reads their own row; admins read all; only admins change roles
alter table public.profiles enable row level security;
drop policy if exists "read profiles"         on public.profiles;
drop policy if exists "admin update profiles"  on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using ( id = auth.uid() or public.is_admin() );
create policy "admin update profiles" on public.profiles for update to authenticated
  using ( public.is_admin() ) with check ( public.is_admin() );

-- layouts: wipe EVERY existing policy (incl. legacy permissive ones), then rebuild strict
alter table public.layouts enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='layouts'
  loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
end $$;
create policy "authed read layouts"   on public.layouts for select to authenticated using ( true );
create policy "editors insert layouts" on public.layouts for insert to authenticated with check ( public.can_create() );
create policy "editors update layouts" on public.layouts for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "editors delete layouts" on public.layouts for delete to authenticated using ( public.can_delete() );

-- =========================================================================
-- 4) ADMIN USER MANAGEMENT (RPC, admin-guarded) — powers the in-app Users panel
-- =========================================================================
create or replace function public.admin_create_user(p_email text, p_password text, p_role text)
returns uuid language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid;
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
  insert into public.profiles (id, email, role) values (uid, lower(p_email), p_role)
    on conflict (id) do update set role = excluded.role, email = excluded.email;
  return uid;
end; $$;

create or replace function public.admin_set_role(p_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'invalid role: %', p_role; end if;
  if p_id = auth.uid() and p_role <> 'admin' then raise exception 'you cannot remove your own admin role'; end if;
  update public.profiles set role = p_role where id = p_id;
  if not found then raise exception 'no such user'; end if;
end; $$;

create or replace function public.admin_delete_user(p_id uuid)
returns void language plpgsql security definer set search_path = auth, public as $$
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_id = auth.uid() then raise exception 'you cannot delete your own account'; end if;
  delete from auth.users where id = p_id;   -- cascades to public.profiles
  if not found then raise exception 'no such user'; end if;
end; $$;

revoke all on function public.admin_create_user(text,text,text) from public, anon;
revoke all on function public.admin_set_role(uuid,text)         from public, anon;
revoke all on function public.admin_delete_user(uuid)           from public, anon;
grant execute on function public.admin_create_user(text,text,text) to authenticated;
grant execute on function public.admin_set_role(uuid,text)         to authenticated;
grant execute on function public.admin_delete_user(uuid)           to authenticated;

-- =========================================================================
-- 5) QUOTES + VERSIONS (quote → versions → confirm, with client + pricing)
-- =========================================================================
create table if not exists public.quotes (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,                      -- MMDDYYYY-NN
  title           text not null default 'Untitled event',
  event_type      text,
  status          text not null default 'quote'
                  check (status in ('quote','confirmed','cancelled')),
  client          jsonb not null default '{}'::jsonb,
  pricing         jsonb not null default '{}'::jsonb,
  current_version int  not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  confirmed_by    uuid references auth.users(id)
);
create index if not exists quotes_updated_idx on public.quotes (updated_at desc);
create index if not exists quotes_status_idx  on public.quotes (status);
drop trigger if exists quotes_set_updated on public.quotes;
create trigger quotes_set_updated before update on public.quotes
  for each row execute function public.set_updated_at();

create table if not exists public.quote_versions (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  version_no   int  not null,
  label        text,
  data         jsonb not null default '{"items":[]}'::jsonb,
  object_count int  not null default 0,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  unique (quote_id, version_no)
);
create index if not exists qv_quote_idx on public.quote_versions (quote_id, version_no desc);

alter table public.quotes         enable row level security;
alter table public.quote_versions enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('quotes','quote_versions')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read quotes"   on public.quotes for select to authenticated using ( true );
create policy "insert quotes" on public.quotes for insert to authenticated with check ( public.can_create() );
create policy "update quotes" on public.quotes for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete quotes" on public.quotes for delete to authenticated using ( public.can_delete() );
create policy "read versions"   on public.quote_versions for select to authenticated using ( true );
create policy "insert versions" on public.quote_versions for insert to authenticated with check ( public.can_edit() );
create policy "update versions" on public.quote_versions for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete versions" on public.quote_versions for delete to authenticated using ( public.can_delete() );

create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  insert into public.quotes (code, title, event_type, current_version)
    values (p_code, coalesce(p_title,'Untitled event'), p_event_type, 1) returning * into q;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $$;

create or replace function public.add_quote_version(
  p_quote_id uuid, p_label text, p_data jsonb, p_object_count int
) returns public.quote_versions language plpgsql security definer set search_path = public as $$
declare v public.quote_versions; nextno int;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  select coalesce(max(version_no),0)+1 into nextno from public.quote_versions where quote_id = p_quote_id;
  insert into public.quote_versions (quote_id, version_no, label, data, object_count, created_by)
    values (p_quote_id, nextno, p_label, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid())
    returning * into v;
  update public.quotes set current_version = nextno, updated_at = now() where id = p_quote_id;
  return v;
end; $$;

create or replace function public.confirm_quote(
  p_quote_id uuid, p_client jsonb, p_pricing jsonb
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_edit() then raise exception 'not authorized to confirm' using errcode='42501'; end if;
  update public.quotes
     set status='confirmed', client=coalesce(p_client,client), pricing=coalesce(p_pricing,pricing),
         confirmed_at=now(), confirmed_by=auth.uid(), updated_at=now()
   where id = p_quote_id returning * into q;
  return q;
end; $$;

revoke all on function public.create_quote(text,text,text,jsonb,int)  from public, anon;
revoke all on function public.add_quote_version(uuid,text,jsonb,int)   from public, anon;
revoke all on function public.confirm_quote(uuid,jsonb,jsonb)          from public, anon;
grant execute on function public.create_quote(text,text,text,jsonb,int) to authenticated;
grant execute on function public.add_quote_version(uuid,text,jsonb,int)  to authenticated;
grant execute on function public.confirm_quote(uuid,jsonb,jsonb)        to authenticated;

-- =========================================================================
-- 6) (OPTIONAL) seed / reset the six team users — YOU ALREADY HAVE THESE.
--    Leave commented. Uncomment only to (re)create them or reset passwords to 'helm'.
-- =========================================================================
-- create or replace function public.create_helm_user(p_email text, p_password text, p_role text)
-- returns void language plpgsql security definer set search_path = auth, public, extensions as $$
-- declare uid uuid;
-- begin
--   select id into uid from auth.users where email = p_email;
--   if uid is null then
--     uid := gen_random_uuid();
--     insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
--       raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
--       confirmation_token,recovery_token,email_change,email_change_token_new)
--     values ('00000000-0000-0000-0000-000000000000',uid,'authenticated','authenticated',
--       p_email,extensions.crypt(p_password,extensions.gen_salt('bf')),now(),
--       '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now(),'','','','');
--     insert into auth.identities (id,user_id,identity_data,provider,provider_id,created_at,updated_at,last_sign_in_at)
--     values (gen_random_uuid(),uid,jsonb_build_object('sub',uid::text,'email',p_email),'email',uid::text,now(),now(),now());
--   end if;
--   update auth.users set confirmation_token=coalesce(confirmation_token,''),recovery_token=coalesce(recovery_token,''),
--     email_change=coalesce(email_change,''),email_change_token_new=coalesce(email_change_token_new,'') where id=uid;
--   insert into public.profiles (id,email,role) values (uid,p_email,p_role)
--     on conflict (id) do update set role=excluded.role, email=excluded.email;
-- end; $$;
-- select public.create_helm_user('admin@helm.com','helm','admin');
-- select public.create_helm_user('planner@helm.com','helm','planner');
-- select public.create_helm_user('sales@helm.com','helm','sales');
-- select public.create_helm_user('operations@helm.com','helm','operations');
-- select public.create_helm_user('crew@helm.com','helm','crew');
-- select public.create_helm_user('client@helm.com','helm','client');

-- =========================================================================
-- VERIFY (expect: profiles listed, policies present, quotes/versions = 0)
-- =========================================================================
select 'profiles' as t, count(*)::text as n from public.profiles
union all select 'layouts', count(*)::text from public.layouts
union all select 'quotes', count(*)::text from public.quotes
union all select 'quote_versions', count(*)::text from public.quote_versions
union all select 'layouts_policies', count(*)::text from pg_policies where schemaname='public' and tablename='layouts'
union all select 'quotes_policies', count(*)::text from pg_policies where schemaname='public' and tablename='quotes';

-- =====================================================================
-- SOURCE: otp-payments.sql
-- =====================================================================

-- =========================================================================
-- Client approval: OTP + consent + payment link + notifications.
-- Run ONCE in the Supabase SQL editor (after setup-complete.sql). Idempotent.
--
-- Flow: manager generates a secure approval link (per-quote token) → client opens
-- the public page → reviews T&C → enters phone → gets an OTP → verifies + consents
-- → a payment link is created → on payment, quote is marked paid; client + manager
-- are notified. OTPs are HASHED server-side; anon reaches only its own quote via the
-- unguessable token; consent is stored as an immutable audit row.
--
-- SIMULATION vs LIVE: with app_config.*_live = false (the default), OTP codes are
-- returned to the page for testing and the payment link is a mock. Deploy the Edge
-- Functions and set the flags true to send real SMS/email and real Razorpay links.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- role helpers (redefined so this file stands alone)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- 0) config flags (simulation by default) ---------------------------------
create table if not exists public.app_config (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
insert into public.app_config(key,value) values
  ('channels', '{"sms_live":false,"email_live":false,"pay_live":false}'::jsonb)
  on conflict (key) do nothing;
create or replace function public._flag(p text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select (value->>p)::boolean from public.app_config where key='channels'), false); $$;

-- 1) columns on quotes ----------------------------------------------------
alter table public.quotes add column if not exists approval_token   uuid;
alter table public.quotes add column if not exists approval_status  text not null default 'none';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='quotes_approval_status_chk') then
    alter table public.quotes add constraint quotes_approval_status_chk
      check (approval_status in ('none','sent','approved','paid','cancelled'));
  end if;
end $$;
create unique index if not exists quotes_approval_token_idx on public.quotes(approval_token) where approval_token is not null;

-- 2) tables ---------------------------------------------------------------
create table if not exists public.quote_otps (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists otp_quote_idx on public.quote_otps(quote_id, created_at desc);

create table if not exists public.quote_consents (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text,
  client_name text,
  terms_version text,
  consent_text text,
  agreed boolean not null default false,
  verified_via_otp boolean not null default false,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists consent_quote_idx on public.quote_consents(quote_id, created_at desc);

create table if not exists public.quote_payments (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  provider text not null default 'razorpay',
  amount numeric not null default 0,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','paid','failed','refunded','cancelled')),
  link_url text,
  provider_ref text,
  simulated boolean not null default true,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists pay_quote_idx on public.quote_payments(quote_id, created_at desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references public.quotes(id) on delete cascade,
  channel text not null check (channel in ('sms','email')),
  recipient text,
  kind text,
  status text not null default 'simulated' check (status in ('simulated','sent','failed')),
  detail jsonb,
  created_at timestamptz not null default now()
);

-- 3) RLS: managers (authenticated) read the audit; anon reaches data only via RPCs
alter table public.quote_otps      enable row level security;
alter table public.quote_consents  enable row level security;
alter table public.quote_payments  enable row level security;
alter table public.notifications   enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('quote_otps','quote_consents','quote_payments','notifications')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
-- no OTP read to clients; managers may read consents/payments/notifications for the audit
create policy "mgr read consents"      on public.quote_consents  for select to authenticated using ( true );
create policy "mgr read payments"      on public.quote_payments  for select to authenticated using ( true );
create policy "mgr read notifications" on public.notifications    for select to authenticated using ( true );

-- 4) helper: log a notification (simulated unless the channel is live) ------
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare live boolean;
begin
  live := case p_channel when 'sms' then public._flag('sms_live') when 'email' then public._flag('email_live') else false end;
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind, case when live then 'sent' else 'simulated' end, coalesce(p_detail,'{}'::jsonb));
  -- NOTE: when live, the Edge Function performs the actual send (this only logs intent).
end; $$;

-- 5) manager: generate / return the per-quote approval link token ----------
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select approval_token into tok from public.quotes where id = p_quote_id;
  if tok is null then tok := gen_random_uuid();
    update public.quotes set approval_token = tok, approval_status = 'sent', updated_at = now() where id = p_quote_id;
  else
    update public.quotes set approval_status = case when approval_status='none' then 'sent' else approval_status end where id = p_quote_id;
  end if;
  return tok;
end; $$;

-- 6) public: fetch the safe, client-facing view of a quote by token --------
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  return jsonb_build_object(
    'code', q.code, 'title', q.title, 'event_type', q.event_type,
    'status', q.status, 'approval_status', q.approval_status,
    'client_name', coalesce(q.client->>'name',''),
    'pricing', q.pricing);
end; $$;

-- 7) public: request an OTP for this quote+phone ---------------------------
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- TEMPORARY dev PIN: in simulation the code is always 123456 for easy testing.
  -- When sms_live is on, MSG91 generates the real code via the send-otp Edge Function.
  code := '123456';
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  -- SIMULATION: return the code so it can be read to the client. LIVE: never return it (SMS carries it).
  return jsonb_build_object('sent', true, 'live', live, 'dev_code', case when live then null else code end);
end; $$;

-- 7b) service-role: store an externally-generated OTP hash (used by the live
--     send-otp Edge Function, which generates the code and sends it via MSG91).
create or replace function public.admin_store_otp(p_token uuid, p_phone text, p_code text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; recent int;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests'; end if;
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(p_code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  return jsonb_build_object('stored', true);
end; $$;
revoke all on function public.admin_store_otp(uuid,text,text) from public, anon, authenticated;

-- 8) public: verify OTP + record consent (approves the quote) --------------
create or replace function public.verify_and_consent(
  p_token uuid, p_phone text, p_code text, p_agreed boolean,
  p_terms_version text, p_consent_text text, p_client_name text, p_user_agent text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; rec public.quote_otps;
begin
  select * into q from public.quotes where approval_token = p_token;
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
end; $$;

-- 9) public: create a payment link (simulated unless pay is live) ----------
create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; amt numeric; pid uuid; link text; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  if q.approval_status not in ('approved','paid') then raise exception 'approve the terms first'; end if;
  amt := coalesce((q.pricing->>'total')::numeric, 0);
  live := public._flag('pay_live');
  if live then
    -- LIVE: the Edge Function must create the real Razorpay link and update this row.
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
end; $$;

-- 10) mark paid (webhook via Edge Function in live; dev button for managers)
create or replace function public.mark_paid(p_quote_id uuid, p_provider_ref text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  -- allowed for managers (dev button) — the live webhook Edge Function uses the service role
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  update public.quote_payments set status='paid', paid_at=now(), provider_ref=coalesce(p_provider_ref,provider_ref)
    where quote_id=p_quote_id and status='created';
  update public.quotes set approval_status='paid', updated_at=now() where id=p_quote_id returning * into q;
  perform public._notify(p_quote_id,'email', q.client->>'email','payment_receipt', jsonb_build_object('code',q.code));
  perform public._notify(p_quote_id,'sms',   q.client->>'phone','payment_receipt', jsonb_build_object('code',q.code));
  return jsonb_build_object('paid', true);
end; $$;

-- grants: token-scoped public flow reachable by anon; manager ops by authenticated
grant execute on function public.public_get_quote(uuid)                               to anon, authenticated;
grant execute on function public.request_otp(uuid,text)                               to anon, authenticated;
grant execute on function public.verify_and_consent(uuid,text,text,boolean,text,text,text,text) to anon, authenticated;
grant execute on function public.create_payment(uuid)                                 to anon, authenticated;
revoke all on function public.generate_approval_token(uuid) from anon;
revoke all on function public.mark_paid(uuid,text)          from anon;
grant execute on function public.generate_approval_token(uuid) to authenticated;
grant execute on function public.mark_paid(uuid,text)          to authenticated;

-- verify
select 'quote_otps' t, count(*) n from public.quote_otps
union all select 'quote_consents', count(*) from public.quote_consents
union all select 'quote_payments', count(*) from public.quote_payments
union all select 'notifications', count(*) from public.notifications
union all select 'config', count(*) from public.app_config;

-- =====================================================================
-- SOURCE: operations.sql
-- =====================================================================

-- =========================================================================
-- Event operations: crew, predefined task templates, event tasks, worker links.
-- Run ONCE (after setup-complete.sql + otp-payments.sql). Idempotent.
--
-- Flow: a confirmed event (quote) → manager assigns predefined tasks by category
-- to crew (all-to-one or split) → each crew member gets a no-login link
-- (work.html?token=) to Accept/Reject/Start/Complete → the manager dashboard
-- tracks every status live and can reassign a rejected task in one click.
-- Reuses _notify()/notifications (sms) and the can_edit() RBAC guard.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- role helpers (redefined so this file stands alone)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;

-- _notify() lives in otp-payments.sql; provide a fallback if that file wasn't run
create or replace function public._notify(p_quote uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications(quote_id,channel,recipient,kind,status,detail)
    values (p_quote,p_channel,p_to,p_kind,'simulated',coalesce(p_detail,'{}'::jsonb));
exception when undefined_table then null;  -- notifications table not present → skip
end; $$;

-- ------------------------------------------------------------------ tables
create table if not exists public.crew_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  department text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists crew_dept_idx on public.crew_members(department) where active;

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  seq int not null default 0,
  default_duration_min int not null default 60,
  unique (category, title)
);

create table if not exists public.event_tasks (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  category text not null,
  title text not null,
  seq int not null default 0,
  crew_id uuid references public.crew_members(id) on delete set null,
  assignee_name text,
  assignee_phone text,
  status text not null default 'assigned'
    check (status in ('unassigned','assigned','accepted','rejected','in_progress','completed','cancelled')),
  note text,
  planned_end timestamptz,     -- Phase-2 scheduling (unused now)
  buffer_min int,              -- Phase-2
  depends_on uuid,             -- Phase-2
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);
create index if not exists etask_quote_idx on public.event_tasks(quote_id, category, seq);
create index if not exists etask_phone_idx on public.event_tasks(quote_id, assignee_phone);

create table if not exists public.work_tokens (
  token uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  phone text not null,
  name text,
  created_at timestamptz not null default now(),
  unique (quote_id, phone)
);

-- event → manager assignment ("event assigning")
alter table public.quotes add column if not exists manager_id uuid references auth.users(id);

-- ------------------------------------------------------------------ RLS
alter table public.crew_members enable row level security;
alter table public.event_tasks  enable row level security;
alter table public.work_tokens  enable row level security;
alter table public.task_templates enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('crew_members','event_tasks','work_tokens','task_templates')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
-- managers (authenticated) read everything; anon reaches tasks only via token RPCs
create policy "read templates" on public.task_templates for select to authenticated using ( true );
create policy "read crew"      on public.crew_members  for select to authenticated using ( true );
create policy "write crew"     on public.crew_members  for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read tasks"     on public.event_tasks   for select to authenticated using ( true );
create policy "read tokens"    on public.work_tokens   for select to authenticated using ( true );  -- managers copy the worker link
-- event_tasks/work_tokens writes go through SECURITY DEFINER RPCs only (no direct anon/authenticated write policy)

-- ------------------------------------------------------------------ seed templates (6 categories × ~18 tasks)
insert into public.task_templates(category,title,seq) values
 ('Stage','Confirm stage size & position',1),('Stage','Mark stage footprint',2),('Stage','Erect truss frame',3),
 ('Stage','Lay stage decking',4),('Stage','Level & lock platforms',5),('Stage','Skirt & drape the stage',6),
 ('Stage','Rig main backdrop',7),('Stage','Install side wings',8),('Stage','Place podium/lectern',9),
 ('Stage','Set up stairs & ramp',10),('Stage','Lay stage carpet',11),('Stage','Cable management on stage',12),
 ('Stage','Safety rails & edge guards',13),('Stage','Position monitors/wedges',14),('Stage','Décor on stage',15),
 ('Stage','Final stage cleaning',16),('Stage','Load-in remaining props',17),('Stage','Manager walkthrough & sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Decoration','Finalize theme & colours',1),('Decoration','Entrance arch setup',2),('Decoration','Aisle/pathway décor',3),
 ('Decoration','Floral centerpieces',4),('Decoration','Table linens & runners',5),('Decoration','Chair covers & sashes',6),
 ('Decoration','Backdrop florals',7),('Decoration','Balloon/prop installation',8),('Decoration','Drapes & fabric',9),
 ('Decoration','Welcome signage',10),('Decoration','Photo booth setup',11),('Decoration','Candle/lantern placement',12),
 ('Decoration','Stage floral accents',13),('Decoration','Perimeter greenery',14),('Decoration','Ceiling/canopy décor',15),
 ('Decoration','Touch-up & fluff',16),('Decoration','Remove packaging/waste',17),('Decoration','Décor walkthrough & sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Lighting','Survey power & DB points',1),('Lighting','Position generators/distro',2),('Lighting','Rig front truss',3),
 ('Lighting','Hang wash fixtures',4),('Lighting','Hang spot fixtures',5),('Lighting','Place uplighters on perimeter',6),
 ('Lighting','Install moving heads',7),('Lighting','Set up followspot',8),('Lighting','LED wall/screen power',9),
 ('Lighting','DMX patch & addressing',10),('Lighting','Focus & aim fixtures',11),('Lighting','Program scenes/cues',12),
 ('Lighting','Haze/fog machine setup',13),('Lighting','Cable ramps & safety',14),('Lighting','Dimmer/console test',15),
 ('Lighting','Full lighting test run',16),('Lighting','Blackout & failover check',17),('Lighting','Lighting sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Catering','Confirm menu & headcount',1),('Catering','Set up kitchen/prep area',2),('Catering','Position buffet counters',3),
 ('Catering','Live-counter setup',4),('Catering','Chafing dishes & warmers',5),('Catering','Beverage/bar station',6),
 ('Catering','Water & welcome drinks',7),('Catering','Crockery & cutlery',8),('Catering','Glassware setup',9),
 ('Catering','Serving staff briefing',10),('Catering','Cold storage/refrigeration',11),('Catering','Dessert station',12),
 ('Catering','Tasting & quality check',13),('Catering','Waste bins & disposal',14),('Catering','Hand-wash/sanitation',15),
 ('Catering','Replenishment plan',16),('Catering','Post-meal clearing',17),('Catering','Catering sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Labor','Confirm crew headcount',1),('Labor','Load-in from trucks',2),('Labor','Move furniture to zones',3),
 ('Labor','Chair layout as per plan',4),('Labor','Table placement',5),('Labor','Carpet/flooring lay',6),
 ('Labor','Assist stage team',7),('Labor','Assist décor team',8),('Labor','Assist lighting team',9),
 ('Labor','Barricades & queue posts',10),('Labor','Signage placement',11),('Labor','Waste clearing round',12),
 ('Labor','Restroom/porta setup',13),('Labor','Water points setup',14),('Labor','Standby during event',15),
 ('Labor','Teardown & load-out',16),('Labor','Site cleanup',17),('Labor','Labor sign-off',18)
on conflict (category,title) do nothing;
insert into public.task_templates(category,title,seq) values
 ('Transportation','Plan vehicle & route',1),('Transportation','Confirm pickup schedule',2),('Transportation','Load stage material',3),
 ('Transportation','Load décor & florals',4),('Transportation','Load lighting/AV gear',5),('Transportation','Load catering equipment',6),
 ('Transportation','Load furniture & chairs',7),('Transportation','Dispatch to venue',8),('Transportation','Unload at venue',9),
 ('Transportation','Return empties',10),('Transportation','Guest shuttle (if any)',11),('Transportation','Fuel & toll settlement',12),
 ('Transportation','Standby vehicle on site',13),('Transportation','Post-event load-out',14),('Transportation','Return material to store',15),
 ('Transportation','Damage/inventory check',16),('Transportation','Driver briefing',17),('Transportation','Transport sign-off',18)
on conflict (category,title) do nothing;

-- ------------------------------------------------------------------ RPCs
-- assign a set of tasks (by title) in a category to one worker; returns the worker link token
create or replace function public.assign_tasks(
  p_quote_id uuid, p_category text, p_titles text[], p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.quotes; tok uuid; t text; n int := 0; s int;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select * into q from public.quotes where id = p_quote_id;
  if q.id is null then raise exception 'no such event'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'valid worker phone required'; end if;
  -- ensure a work link exists for (event, phone)
  select token into tok from public.work_tokens where quote_id=p_quote_id and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,p_quote_id,p_phone,p_name); end if;
  foreach t in array coalesce(p_titles,'{}') loop
    select seq into s from public.task_templates where category=p_category and title=t;
    insert into public.event_tasks(quote_id,category,title,seq,crew_id,assignee_name,assignee_phone,status,created_by)
      values (p_quote_id,p_category,t,coalesce(s,999),p_crew_id,p_name,p_phone,'assigned',auth.uid());
    n := n + 1;
  end loop;
  perform public._notify(p_quote_id,'sms',p_phone,'task_assigned',
    jsonb_build_object('count',n,'category',p_category,'token',tok));
  return jsonb_build_object('work_token',tok,'tasks_created',n);
end; $$;

-- move a task to a different worker (after a reject or no-response)
create or replace function public.reassign_task(p_task_id uuid, p_crew_id uuid, p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare qt uuid; tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  select quote_id into qt from public.event_tasks where id=p_task_id;
  if qt is null then raise exception 'no such task'; end if;
  select token into tok from public.work_tokens where quote_id=qt and phone=p_phone;
  if tok is null then tok := gen_random_uuid();
    insert into public.work_tokens(token,quote_id,phone,name) values (tok,qt,p_phone,p_name); end if;
  update public.event_tasks set crew_id=p_crew_id, assignee_name=p_name, assignee_phone=p_phone,
    status='assigned', responded_at=null, started_at=null, completed_at=null where id=p_task_id;
  perform public._notify(qt,'sms',p_phone,'task_assigned', jsonb_build_object('reassigned',true,'token',tok));
  return jsonb_build_object('work_token',tok);
end; $$;

-- worker (no login): fetch my tasks for this event via my token
create or replace function public.worker_get_tasks(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.work_tokens; q public.quotes; tasks jsonb;
begin
  select * into w from public.work_tokens where token=p_token;
  if w.token is null then raise exception 'invalid link'; end if;
  select * into q from public.quotes where id=w.quote_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'title',title,'status',status
           ) order by category, seq), '[]'::jsonb) into tasks
    from public.event_tasks where quote_id=w.quote_id and assignee_phone=w.phone;
  return jsonb_build_object('event', jsonb_build_object('code',q.code,'title',q.title),
    'worker', jsonb_build_object('name',w.name,'phone',w.phone), 'tasks', tasks);
end; $$;

-- worker (no login): accept / reject / start / complete one of my tasks
create or replace function public.worker_respond(p_token uuid, p_task_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end; $$;

-- grants: manager RPCs → authenticated only; worker RPCs → anon + authenticated (token-scoped)
revoke all on function public.assign_tasks(uuid,text,text[],uuid,text,text) from anon;
revoke all on function public.reassign_task(uuid,uuid,text,text)          from anon;
grant execute on function public.assign_tasks(uuid,text,text[],uuid,text,text) to authenticated;
grant execute on function public.reassign_task(uuid,uuid,text,text)            to authenticated;
grant execute on function public.worker_get_tasks(uuid)          to anon, authenticated;
grant execute on function public.worker_respond(uuid,uuid,text)  to anon, authenticated;

-- verify
select 'crew_members' t, count(*) n from public.crew_members
union all select 'task_templates', count(*) from public.task_templates
union all select 'event_tasks', count(*) from public.event_tasks
union all select 'work_tokens', count(*) from public.work_tokens
union all select 'template_categories', count(distinct category) from public.task_templates;

-- =====================================================================
-- SOURCE: control-center.sql
-- =====================================================================

-- =========================================================================
-- Control Center: global pricing config, vendors, coupons. Run ONCE (idempotent).
-- Central rates (chair/plate/GST) live here so the confirm modal doesn't re-enter
-- them each time; discounts/coupons are per-event. All synced via Supabase.
-- =========================================================================
create extension if not exists pgcrypto with schema extensions;

create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() = 'admin', false); $$;

-- 0) global pricing defaults (in app_config; created by otp-payments.sql, ensure row) ------
create table if not exists public.app_config (
  key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
insert into public.app_config(key,value) values
  ('pricing', '{"chairPrice":200,"platePrice":500,"gstPct":18,"cateringGstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb)
  on conflict (key) do nothing;

create or replace function public.get_pricing_config() returns jsonb
  language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.app_config where key='pricing'),
    '{"chairPrice":200,"platePrice":500,"gstPct":18,"cateringGstPct":18,"serviceChargePct":0,"currency":"INR"}'::jsonb); $$;
create or replace function public.set_pricing_config(p jsonb) returns jsonb
  language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.app_config(key,value,updated_at) values ('pricing', p, now())
    on conflict (key) do update set value=excluded.value, updated_at=now();
  return p;
end; $$;
grant execute on function public.get_pricing_config() to authenticated;
grant execute on function public.set_pricing_config(jsonb) to authenticated;

-- 1) vendors -------------------------------------------------------------------
create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,            -- catering / decor / lighting / transport / general
  phone text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name)
);
alter table public.vendors enable row level security;

-- 2) coupons -------------------------------------------------------------------
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  kind text not null default 'percent' check (kind in ('percent','flat')),
  value numeric not null default 0,     -- percent (0-100) or flat ₹
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.coupons enable row level security;

-- 3) RLS: authenticated read; managers write ----------------------------------
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('vendors','coupons')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read vendors"  on public.vendors for select to authenticated using ( true );
create policy "write vendors" on public.vendors for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read coupons"  on public.coupons for select to authenticated using ( true );
create policy "write coupons" on public.coupons for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- seed a couple of common catering vendors (safe to re-run)
insert into public.vendors(name,category) values
  ('In-house','catering'),('Spice Route Caterers','catering'),('Grand Feast','catering')
  on conflict (name) do nothing;

-- 4) manager-triggered notification (e.g. "text the approval link to the client")
create or replace function public.mgr_notify(p_quote_id uuid, p_channel text, p_to text, p_kind text, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  perform public._notify(p_quote_id, p_channel, p_to, p_kind, p_detail);
  return jsonb_build_object('logged', true);
end; $$;
grant execute on function public.mgr_notify(uuid,text,text,text,jsonb) to authenticated;

-- verify
select 'pricing' t, (get_pricing_config())::text n
union all select 'vendors', count(*)::text from public.vendors
union all select 'coupons', count(*)::text from public.coupons;

-- =====================================================================
-- SOURCE: phase1-workspace.sql
-- =====================================================================

-- =========================================================================
-- Phase 1 — Event Workspace: a lifecycle stage on each event. Idempotent.
-- The "event" is the existing quotes row; we only add a stage + a setter.
-- Stages: lead → discovery → proposal → quote → confirmed → planning →
--         resources → ready → event_day → settlement → closed
-- =========================================================================
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid())
    in ('admin','planner','sales','operations'), false); $$;

alter table public.quotes add column if not exists lifecycle_stage text;

-- backfill from current status, then set a sensible default
update public.quotes set lifecycle_stage = case
    when status='confirmed' then 'confirmed'
    when status='cancelled' then 'closed'
    else 'quote' end
  where lifecycle_stage is null;
alter table public.quotes alter column lifecycle_stage set default 'quote';

do $$ begin
  if not exists (select 1 from pg_constraint where conname='quotes_lifecycle_chk') then
    alter table public.quotes add constraint quotes_lifecycle_chk check (lifecycle_stage in
      ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed'));
  end if;
end $$;

create or replace function public.set_lifecycle_stage(p_quote_id uuid, p_stage text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  if p_stage not in ('lead','discovery','proposal','quote','confirmed','planning','resources','ready','event_day','settlement','closed')
    then raise exception 'invalid stage: %', p_stage; end if;
  update public.quotes set lifecycle_stage = p_stage, updated_at = now() where id = p_quote_id;
  if not found then raise exception 'no such event'; end if;
  return jsonb_build_object('stage', p_stage);
end; $$;
revoke all on function public.set_lifecycle_stage(uuid,text) from anon;
grant execute on function public.set_lifecycle_stage(uuid,text) to authenticated;

-- verify
select lifecycle_stage, count(*) from public.quotes group by lifecycle_stage order by 1;

-- =====================================================================
-- SOURCE: phase2-leads.sql
-- =====================================================================

-- =========================================================================
-- PHASE 2 — Leads & pipeline (CRM front)
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:  public.leads  +  convert_lead_to_quote()  RPC.
-- =========================================================================

-- 1) LEADS TABLE ----------------------------------------------------------
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text,
  email        text,
  source       text,                    -- referral | website | walk-in | social | ad | other
  event_type   text,
  event_date   date,
  budget       numeric,
  guest_count  int,
  notes        text,
  status       text not null default 'new'
               check (status in ('new','qualified','discovery','quoted','won','lost')),
  quote_id     uuid references public.quotes(id) on delete set null,
  owner        uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists leads_status_idx  on public.leads (status);
create index if not exists leads_updated_idx on public.leads (updated_at desc);

drop trigger if exists leads_set_updated on public.leads;
create trigger leads_set_updated before update on public.leads
  for each row execute function public.set_updated_at();

-- 2) RLS ------------------------------------------------------------------
alter table public.leads enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='leads'
  loop execute format('drop policy if exists %I on public.leads', p.policyname); end loop;
end $$;
create policy "read leads"   on public.leads for select to authenticated using ( true );
create policy "insert leads" on public.leads for insert to authenticated with check ( public.can_create() );
create policy "update leads" on public.leads for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete leads" on public.leads for delete to authenticated using ( public.can_delete() );

-- 3) CONVERT LEAD -> QUOTE ------------------------------------------------
-- Reuses the existing quote engine (create_quote logic) without touching it.
-- Auto-generates the MMDDYYYY-NN code, links lead<->quote, marks lead 'quoted'.
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads;
  q public.quotes;
  v_stamp text := to_char(now(), 'MMDDYYYY');
  v_next  int;
  v_code  text;
  v_title text;
begin
  if not public.can_create() then
    raise exception 'not authorized to create' using errcode='42501';
  end if;

  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then
    -- already converted: just return the linked quote
    select * into q from public.quotes where id = l.quote_id;
    return q;
  end if;

  -- next running number for today's stamp
  select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
    into v_next from public.quotes where code like v_stamp || '-%';
  v_code  := v_stamp || '-' || lpad(v_next::text, 2, '0');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;

  insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage)
    values (v_code, v_title, l.event_type, 1,
            jsonb_strip_nulls(jsonb_build_object(
              'name',  l.name,
              'phone', l.phone,
              'email', l.email)),
            'discovery')     -- a converted lead opens at Discovery
    returning * into q;

  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());

  update public.leads
     set status = 'quoted', quote_id = q.id, updated_at = now()
   where id = p_lead_id;

  return q;
end; $$;

revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

-- =====================================================================
-- SOURCE: phase2b-crm.sql
-- =====================================================================

-- =========================================================================
-- PHASE 2b — Immutable CRM archive + realtime for the leads pipeline
-- Idempotent. Safe to re-run. Depends on: phase2-leads.sql.
-- Adds:
--   • public.lead_archive  — append-only snapshot of every lead change
--   • trigger archive_lead() — writes a snapshot on INSERT/UPDATE/DELETE
--   • realtime on public.leads (drag-and-drop syncs live across viewers)
-- The archive is NEVER deleted when a lead is removed — it is your safe CRM.
-- =========================================================================

-- 1) ARCHIVE TABLE (no FK to leads, so it outlives a deleted lead) ---------
create table if not exists public.lead_archive (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid,                         -- deliberately NOT a foreign key
  action       text not null,                -- created | updated | converted | deleted
  name         text,
  phone        text,
  email        text,
  source       text,
  event_type   text,
  event_date   date,
  budget       numeric,
  guest_count  int,
  notes        text,
  status       text,
  quote_id     uuid,
  snapshot     jsonb not null,               -- the full lead row at this moment
  archived_at  timestamptz not null default now(),
  archived_by  uuid default auth.uid()
);
create index if not exists lead_archive_lead_idx on public.lead_archive(lead_id, archived_at desc);
create index if not exists lead_archive_time_idx on public.lead_archive(archived_at desc);

-- 2) TRIGGER: snapshot every change (security definer so it always writes) --
create or replace function public.archive_lead()
returns trigger language plpgsql security definer set search_path = public as $$
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
end; $$;

drop trigger if exists leads_archive_ins on public.leads;
create trigger leads_archive_ins after insert on public.leads
  for each row execute function public.archive_lead();
drop trigger if exists leads_archive_upd on public.leads;
create trigger leads_archive_upd after update on public.leads
  for each row execute function public.archive_lead();
drop trigger if exists leads_archive_del on public.leads;
create trigger leads_archive_del after delete on public.leads
  for each row execute function public.archive_lead();

-- 3) RLS: archive is READ-only to app users (only the trigger writes it) ----
alter table public.lead_archive enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='lead_archive'
  loop execute format('drop policy if exists %I on public.lead_archive', p.policyname); end loop;
end $$;
create policy "read archive" on public.lead_archive for select to authenticated using ( true );
grant select on public.lead_archive to authenticated;
-- no insert/update/delete grants: the append-only trigger is the only writer.

-- 4) REALTIME: broadcast leads changes so the board updates live -----------
alter table public.leads replica identity full;   -- deliver full old/new rows
do $$ begin
  begin
    alter publication supabase_realtime add table public.leads;
  exception when others then null;   -- already in the publication → ignore
  end;
end $$;

-- =====================================================================
-- SOURCE: phase3-discovery.sql
-- =====================================================================

-- =========================================================================
-- PHASE 3 — Discovery & requirements
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:
--   • public.event_discovery     — one discovery record per event (meeting + budget)
--   • public.event_requirements  — structured service needs (must/optional/nice)
--   • set_discovery()            — upsert the discovery record (can_edit)
-- Feeds the quote: the workspace shows the budget range + must-haves next to
-- the Quote card. Does NOT touch the quote / 3D engine.
-- =========================================================================

-- 1) DISCOVERY (one row per event) ---------------------------------------
create table if not exists public.event_discovery (
  quote_id    uuid primary key references public.quotes(id) on delete cascade,
  meet_date   date,
  mode        text,            -- in_person | call | video
  location    text,            -- address or meeting link
  attendees   text,
  notes       text,
  budget_min  numeric,
  budget_max  numeric,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- 2) REQUIREMENTS (many per event) ---------------------------------------
create table if not exists public.event_requirements (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  service     text not null,
  priority    text not null default 'mandatory'
              check (priority in ('mandatory','optional','nice')),
  qty         int,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists event_req_quote_idx on public.event_requirements(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_discovery    enable row level security;
alter table public.event_requirements enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_discovery','event_requirements')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read discovery"   on public.event_discovery    for select to authenticated using ( true );
create policy "write discovery"  on public.event_discovery    for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read reqs"    on public.event_requirements for select to authenticated using ( true );
create policy "insert reqs"  on public.event_requirements for insert to authenticated with check ( public.can_edit() );
create policy "update reqs"  on public.event_requirements for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete reqs"  on public.event_requirements for delete to authenticated using ( public.can_delete() );

-- 4) UPSERT the discovery record -----------------------------------------
create or replace function public.set_discovery(
  p_quote_id uuid, p_meet_date date, p_mode text, p_location text,
  p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric
) returns public.event_discovery language plpgsql security definer set search_path = public as $$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
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
end; $$;
revoke all on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) to authenticated;

-- =====================================================================
-- SOURCE: phase4-proposal.sql
-- =====================================================================

-- =========================================================================
-- PHASE 4 — Proposal & mood-board (light) + feasibility/risk checklist
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:
--   • public.event_proposal   — one shareable proposal per event (token-scoped)
--   • public.proposal_risks   — internal feasibility/risk checklist
--   • set_proposal()          — upsert proposal content (can_edit)
--   • publish_proposal()      — publish/unpublish + issue the share token
--   • public_get_proposal()   — anon read of a PUBLISHED proposal by token
-- Mirrors the approval token pattern; does not touch the quote/approval engine.
-- =========================================================================

-- 1) PROPOSAL (one row per event) ----------------------------------------
create table if not exists public.event_proposal (
  quote_id     uuid primary key references public.quotes(id) on delete cascade,
  concept      text,
  theme        text,
  palette      jsonb not null default '[]'::jsonb,   -- ["#rrggbb", ...]
  images       jsonb not null default '[]'::jsonb,   -- ["https://...", ...]
  scope        jsonb not null default '[]'::jsonb,   -- ["Stage décor", "Catering", ...]
  share_token  uuid,
  published    boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)
);
create unique index if not exists event_proposal_token_idx
  on public.event_proposal(share_token) where share_token is not null;

-- 2) FEASIBILITY / RISK checklist (internal) -----------------------------
create table if not exists public.proposal_risks (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  title       text not null,
  severity    text not null default 'medium' check (severity in ('low','medium','high')),
  mitigation  text,
  status      text not null default 'open'   check (status in ('open','mitigated','accepted')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists proposal_risks_quote_idx on public.proposal_risks(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_proposal enable row level security;
alter table public.proposal_risks enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_proposal','proposal_risks')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read proposal"  on public.event_proposal for select to authenticated using ( true );
create policy "write proposal" on public.event_proposal for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read risks"    on public.proposal_risks for select to authenticated using ( true );
create policy "insert risks"  on public.proposal_risks for insert to authenticated with check ( public.can_edit() );
create policy "update risks"  on public.proposal_risks for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete risks"  on public.proposal_risks for delete to authenticated using ( public.can_delete() );

-- 4) UPSERT proposal content ---------------------------------------------
create or replace function public.set_proposal(
  p_quote_id uuid, p_concept text, p_theme text,
  p_palette jsonb, p_images jsonb, p_scope jsonb
) returns public.event_proposal language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  insert into public.event_proposal (quote_id, concept, theme, palette, images, scope, updated_at, updated_by)
  values (p_quote_id, p_concept, p_theme,
          coalesce(p_palette,'[]'::jsonb), coalesce(p_images,'[]'::jsonb), coalesce(p_scope,'[]'::jsonb),
          now(), auth.uid())
  on conflict (quote_id) do update set
    concept=excluded.concept, theme=excluded.theme, palette=excluded.palette,
    images=excluded.images, scope=excluded.scope, updated_at=now(), updated_by=auth.uid()
  returning * into pr;
  return pr;
end; $$;

-- 5) PUBLISH / UNPUBLISH + issue share token ------------------------------
create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare tok uuid;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  -- ensure a proposal row exists
  insert into public.event_proposal (quote_id, updated_by) values (p_quote_id, auth.uid())
    on conflict (quote_id) do nothing;
  select share_token into tok from public.event_proposal where quote_id = p_quote_id;
  if tok is null and p_published then tok := gen_random_uuid(); end if;
  update public.event_proposal
     set published = p_published, share_token = coalesce(tok, share_token), updated_at = now()
   where quote_id = p_quote_id;
  return tok;
end; $$;

-- 6) PUBLIC: fetch a PUBLISHED proposal by token (anon) -------------------
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pr public.event_proposal; q public.quotes;
begin
  select * into pr from public.event_proposal where share_token = p_token and published = true;
  if pr.quote_id is null then raise exception 'invalid or unpublished link'; end if;
  select * into q from public.quotes where id = pr.quote_id;
  return jsonb_build_object(
    'concept', pr.concept, 'theme', pr.theme, 'palette', pr.palette,
    'images', pr.images, 'scope', pr.scope,
    'event_code', q.code, 'event_title', q.title, 'event_type', q.event_type,
    'client_name', coalesce(q.client->>'name',''));
end; $$;

revoke all on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) from public, anon;
revoke all on function public.publish_proposal(uuid,boolean)                 from public, anon;
grant execute on function public.set_proposal(uuid,text,text,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.publish_proposal(uuid,boolean)                 to authenticated;
grant execute on function public.public_get_proposal(uuid)                      to anon, authenticated;

-- =====================================================================
-- SOURCE: phase5-mvp-polish.sql
-- =====================================================================

-- =========================================================================
-- PHASE 5 — MVP checkpoint polish (no new tables)
-- Idempotent. Depends on: phase1-workspace.sql, phase2-leads.sql.
-- Change: a converted lead now opens its event at the 'discovery' stage,
-- so the planner flows Discovery → Proposal → Quote → Confirm naturally.
-- =========================================================================
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text := to_char(now(), 'MMDDYYYY'); v_next int; v_code text; v_title text;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
    into v_next from public.quotes where code like v_stamp || '-%';
  v_code  := v_stamp || '-' || lpad(v_next::text, 2, '0');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage)
    values (v_code, v_title, l.event_type, 1,
            jsonb_strip_nulls(jsonb_build_object('name', l.name, 'phone', l.phone, 'email', l.email)),
            'discovery')
    returning * into q;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now() where id = p_lead_id;
  return q;
end; $$;
revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

-- =====================================================================
-- SOURCE: phase6-staff.sql
-- =====================================================================

-- =========================================================================
-- PHASE 6 — In-house staff directory  (Block B: Resource Management)
-- Idempotent. Safe to re-run. Depends on: operations.sql (crew_members).
-- Extends crew_members with role / skills / department details so you can
-- plan in-house people first, before reaching for vendors or freelancers.
-- No new table — we enrich the existing crew_members the tasks module uses.
-- =========================================================================

alter table public.crew_members add column if not exists role      text;
alter table public.crew_members add column if not exists skills    jsonb not null default '[]'::jsonb;
alter table public.crew_members add column if not exists email     text;
alter table public.crew_members add column if not exists emp_type  text;   -- full_time | part_time | on_call
alter table public.crew_members add column if not exists day_rate  numeric;
alter table public.crew_members add column if not exists notes     text;

create index if not exists crew_role_idx on public.crew_members(role) where active;

-- guard emp_type values (allow null) without failing if the constraint exists
do $$ begin
  alter table public.crew_members
    add constraint crew_emp_type_chk
    check (emp_type is null or emp_type in ('full_time','part_time','on_call'));
exception when duplicate_object then null; end $$;

-- crew_members already has RLS: read = any signed-in user, write = can_edit,
-- delete = can_edit (the "write crew" ALL policy). Nothing else to add.

-- =====================================================================
-- SOURCE: phase7-inventory.sql
-- =====================================================================

-- =========================================================================
-- PHASE 7 — In-house inventory  (Block B: Resource Management)
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:
--   • public.inventory_items         — what you own (name, category, qty, unit)
--   • public.inventory_reservations  — per-event holds: reserve → allocate → return
-- "Available" = total owned minus everything still reserved or allocated.
-- =========================================================================

-- 1) STOCK ITEMS ----------------------------------------------------------
create table if not exists public.inventory_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text,
  total_qty  numeric not null default 0,
  unit       text,            -- pcs | sets | m | kg | ...
  notes      text,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists inventory_items_cat_idx on public.inventory_items(category) where active;

-- 2) PER-EVENT RESERVATIONS ----------------------------------------------
create table if not exists public.inventory_reservations (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references public.inventory_items(id) on delete cascade,
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  qty        numeric not null check (qty > 0),
  status     text not null default 'reserved'
             check (status in ('reserved','allocated','returned','cancelled')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index if not exists inv_res_item_idx  on public.inventory_reservations(item_id)  where status in ('reserved','allocated');
create index if not exists inv_res_quote_idx on public.inventory_reservations(quote_id);

drop trigger if exists inv_res_set_updated on public.inventory_reservations;
create trigger inv_res_set_updated before update on public.inventory_reservations
  for each row execute function public.set_updated_at();

-- 3) RLS ------------------------------------------------------------------
alter table public.inventory_items        enable row level security;
alter table public.inventory_reservations enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('inventory_items','inventory_reservations')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read items"   on public.inventory_items for select to authenticated using ( true );
create policy "write items"  on public.inventory_items for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read res"     on public.inventory_reservations for select to authenticated using ( true );
create policy "insert res"   on public.inventory_reservations for insert to authenticated with check ( public.can_edit() );
create policy "update res"   on public.inventory_reservations for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete res"   on public.inventory_reservations for delete to authenticated using ( public.can_delete() );

-- 4) AVAILABILITY view (handy for reports; the app also computes this) -----
-- committed = qty still reserved or allocated; available = total - committed.
create or replace view public.inventory_availability
with (security_invoker = true) as
select
  i.id, i.name, i.category, i.unit, i.total_qty,
  coalesce(sum(r.qty) filter (where r.status in ('reserved','allocated')), 0) as committed,
  i.total_qty - coalesce(sum(r.qty) filter (where r.status in ('reserved','allocated')), 0) as available
from public.inventory_items i
left join public.inventory_reservations r on r.item_id = i.id
where i.active
group by i.id;

grant select on public.inventory_availability to authenticated;

-- =====================================================================
-- SOURCE: phase8-resource-needs.sql
-- =====================================================================

-- =========================================================================
-- PHASE 8 — Resource requirement mapping + capability check
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql, phase6-staff.sql,
--   phase7-inventory.sql (the check reads staff skills + inventory availability).
-- Adds one table: the resource needs for an event. The app auto-checks each
-- need against in-house staff / stock and flags the gaps (for vendors later).
-- =========================================================================

create table if not exists public.event_resource_needs (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null default 'other'
             check (kind in ('staff','inventory','other')),
  label      text not null,
  skill      text,                                              -- for staff needs
  item_id    uuid references public.inventory_items(id) on delete set null, -- for inventory needs
  qty        numeric not null default 1 check (qty > 0),
  note       text,
  status     text not null default 'open' check (status in ('open','outsourced')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists ern_quote_idx on public.event_resource_needs(quote_id, created_at);

alter table public.event_resource_needs enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_resource_needs'
  loop execute format('drop policy if exists %I on public.event_resource_needs', p.policyname); end loop;
end $$;
create policy "read needs"   on public.event_resource_needs for select to authenticated using ( true );
create policy "insert needs" on public.event_resource_needs for insert to authenticated with check ( public.can_edit() );
create policy "update needs" on public.event_resource_needs for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete needs" on public.event_resource_needs for delete to authenticated using ( public.can_delete() );

-- =====================================================================
-- SOURCE: phase9-vendors.sql
-- =====================================================================

-- =========================================================================
-- PHASE 9 — Vendors / freelancers / rentals / procurement
-- Idempotent. Safe to re-run. Depends on: control-center.sql (vendors),
--   phase8-resource-needs.sql (event_resource_needs).
-- Extends vendors with a "kind" + contact/services, and adds event_resources:
-- the external bookings that cover the gaps flagged in the resource plan.
-- =========================================================================

-- 1) EXTEND vendors -------------------------------------------------------
alter table public.vendors add column if not exists kind     text not null default 'vendor';
alter table public.vendors add column if not exists email    text;
alter table public.vendors add column if not exists services jsonb not null default '[]'::jsonb;
alter table public.vendors add column if not exists notes    text;
create index if not exists vendors_kind_idx on public.vendors(kind) where active;

do $$ begin
  alter table public.vendors
    add constraint vendors_kind_chk
    check (kind in ('vendor','freelancer','rental','supplier'));
exception when duplicate_object then null; end $$;

-- 2) EVENT RESOURCES (external bookings per event) ------------------------
create table if not exists public.event_resources (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  vendor_id  uuid references public.vendors(id) on delete set null,
  need_id    uuid references public.event_resource_needs(id) on delete set null,
  kind       text,                       -- vendor | freelancer | rental | supplier
  label      text not null,
  qty        numeric,
  cost       numeric,
  advance    numeric,
  contract   boolean not null default false,
  status     text not null default 'enquiry'
             check (status in ('enquiry','booked','confirmed','delivered','cancelled')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
create index if not exists event_res_quote_idx  on public.event_resources(quote_id, created_at);
create index if not exists event_res_vendor_idx on public.event_resources(vendor_id);

drop trigger if exists event_res_set_updated on public.event_resources;
create trigger event_res_set_updated before update on public.event_resources
  for each row execute function public.set_updated_at();

-- 3) RLS ------------------------------------------------------------------
alter table public.event_resources enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_resources'
  loop execute format('drop policy if exists %I on public.event_resources', p.policyname); end loop;
end $$;
create policy "read eres"   on public.event_resources for select to authenticated using ( true );
create policy "insert eres" on public.event_resources for insert to authenticated with check ( public.can_edit() );
create policy "update eres" on public.event_resources for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete eres" on public.event_resources for delete to authenticated using ( public.can_delete() );
-- vendors already has RLS (read = any signed-in, write/delete = can_edit).

-- =====================================================================
-- SOURCE: phase10-calendar.sql
-- =====================================================================

-- =========================================================================
-- PHASE 10 — Resource calendar (Block B checkpoint)
-- Idempotent. Depends on: setup-complete.sql, phase2-leads.sql.
-- The calendar + conflict detection live in the app; the only DB change is
-- giving every event a date so commitments can be placed on a timeline.
-- =========================================================================

-- 1) event date on the quote (the "event")
alter table public.quotes add column if not exists event_date date;
create index if not exists quotes_event_date_idx on public.quotes(event_date);

-- 2) backfill from the linked lead, then from client.eventDate if present
update public.quotes q
   set event_date = l.event_date
  from public.leads l
 where l.quote_id = q.id and q.event_date is null and l.event_date is not null;

update public.quotes
   set event_date = (client->>'eventDate')::date
 where event_date is null
   and client ? 'eventDate'
   and (client->>'eventDate') ~ '^\d{4}-\d{2}-\d{2}$';

-- 3) copy the event date when converting a lead (extends the Phase 5 function)
create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text := to_char(now(), 'MMDDYYYY'); v_next int; v_code text; v_title text;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
    into v_next from public.quotes where code like v_stamp || '-%';
  v_code  := v_stamp || '-' || lpad(v_next::text, 2, '0');
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
    values (v_code, v_title, l.event_type, 1,
            jsonb_strip_nulls(jsonb_build_object('name', l.name, 'phone', l.phone, 'email', l.email)),
            'discovery', l.event_date)
    returning * into q;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now() where id = p_lead_id;
  return q;
end; $$;
revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

-- =====================================================================
-- SOURCE: phase11-runsheet.sql
-- =====================================================================

-- =========================================================================
-- PHASE 11 — Run-sheet (timed event-day schedule)  [Block C]
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- A minute-by-minute schedule for the event: each row is a time, how long it
-- takes, what happens, who owns it and where. (Task deadlines/dependencies use
-- the event_tasks.planned_end / buffer_min / depends_on columns already present.)
-- =========================================================================

create table if not exists public.run_sheet_items (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  start_time   time,
  duration_min int,
  title        text not null,
  owner        text,          -- who's responsible (team or person)
  location     text,
  note         text,
  seq          int not null default 0,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id)
);
create index if not exists run_sheet_quote_idx on public.run_sheet_items(quote_id, start_time, seq);

alter table public.run_sheet_items enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='run_sheet_items'
  loop execute format('drop policy if exists %I on public.run_sheet_items', p.policyname); end loop;
end $$;
create policy "read runsheet"   on public.run_sheet_items for select to authenticated using ( true );
create policy "insert runsheet" on public.run_sheet_items for insert to authenticated with check ( public.can_edit() );
create policy "update runsheet" on public.run_sheet_items for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete runsheet" on public.run_sheet_items for delete to authenticated using ( public.can_delete() );

-- =====================================================================
-- SOURCE: phase12-budget.sql
-- =====================================================================

-- =========================================================================
-- PHASE 12 — Budget vs. actuals + change orders  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes), phase9-vendors.sql
--   (event_resources, for importing vendor costs).
-- event_costs   = cost lines (estimated vs actual, internal / vendor / other)
-- change_requests = priced scope changes (revenue + cost impact) the client
--   approves; approved ones roll into the budget. Margin = quote revenue − cost.
-- =========================================================================

-- 1) COST LINES ----------------------------------------------------------
create table if not exists public.event_costs (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  category    text,
  description text not null,
  kind        text not null default 'internal' check (kind in ('internal','vendor','other')),
  estimated   numeric not null default 0,
  actual      numeric,
  booking_id  uuid references public.event_resources(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists event_costs_quote_idx on public.event_costs(quote_id, created_at);

-- 2) CHANGE REQUESTS (priced scope changes) ------------------------------
create table if not exists public.change_requests (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  title       text not null,
  detail      text,
  price_delta numeric not null default 0,   -- extra charged to the client
  cost_delta  numeric not null default 0,   -- extra cost to deliver it
  status      text not null default 'requested' check (status in ('requested','approved','rejected')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  decided_at  timestamptz
);
create index if not exists change_req_quote_idx on public.change_requests(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_costs     enable row level security;
alter table public.change_requests enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_costs','change_requests')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read costs"   on public.event_costs for select to authenticated using ( true );
create policy "write costs"  on public.event_costs for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read changes"   on public.change_requests for select to authenticated using ( true );
create policy "insert changes" on public.change_requests for insert to authenticated with check ( public.can_edit() );
create policy "update changes" on public.change_requests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete changes" on public.change_requests for delete to authenticated using ( public.can_delete() );

-- =====================================================================
-- SOURCE: phase13-plan.sql
-- =====================================================================

-- =========================================================================
-- PHASE 13 — Venue coordination + menu/package lock  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- One event_plan row per event: venue details/access + the agreed menu/package
-- with a lock (once locked, changes should go through a change order — Phase 12).
-- Approval tracking reuses the existing OTP/consent engine (quote_consents etc.)
-- =========================================================================

create table if not exists public.event_plan (
  quote_id       uuid primary key references public.quotes(id) on delete cascade,
  venue_name     text,
  venue_address  text,
  venue_contact  text,
  access_notes   text,
  package        text,
  menu           text,
  menu_locked    boolean not null default false,
  locked_at      timestamptz,
  locked_by      uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);

alter table public.event_plan enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_plan'
  loop execute format('drop policy if exists %I on public.event_plan', p.policyname); end loop;
end $$;
create policy "read plan"  on public.event_plan for select to authenticated using ( true );
create policy "write plan" on public.event_plan for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- upsert the venue + menu/package content (does not touch the lock)
create or replace function public.set_event_plan(
  p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text,
  p_access_notes text, p_package text, p_menu text
) returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

-- lock / unlock the menu & package
create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_plan (quote_id, menu_locked, locked_at, locked_by, updated_at, updated_by)
    values (p_quote_id, p_locked, case when p_locked then now() end, case when p_locked then auth.uid() end, now(), auth.uid())
  on conflict (quote_id) do update set
    menu_locked=p_locked, locked_at = case when p_locked then now() else null end,
    locked_by = case when p_locked then auth.uid() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

revoke all on function public.set_event_plan(uuid,text,text,text,text,text,text) from public, anon;
revoke all on function public.set_plan_lock(uuid,boolean)                        from public, anon;
grant execute on function public.set_event_plan(uuid,text,text,text,text,text,text) to authenticated;
grant execute on function public.set_plan_lock(uuid,boolean)                        to authenticated;

-- =====================================================================
-- SOURCE: phase14-logistics.sql
-- =====================================================================

-- =========================================================================
-- PHASE 14 — Logistics, permits, guests, comms + payment milestones  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_checklist   = one flexible per-event checklist, split by section
--   (logistics / compliance / comms / guests). Guest rows carry a headcount.
-- payment_milestones = the payment schedule (label, due date, amount, status);
--   reminders reuse the existing mgr_notify() notification RPC.
-- =========================================================================

create table if not exists public.event_checklist (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  section    text not null check (section in ('logistics','compliance','comms','guests')),
  title      text not null,
  detail     text,
  owner      text,
  due_date   date,
  qty        int,                     -- headcount for guest rows
  status     text not null default 'open' check (status in ('open','done','na')),
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_checklist_quote_idx on public.event_checklist(quote_id, section, seq);

create table if not exists public.payment_milestones (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  label      text not null,
  due_date   date,
  amount     numeric not null default 0,
  status     text not null default 'due' check (status in ('due','invoiced','paid','waived')),
  paid_at    timestamptz,
  note       text,
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists payment_milestones_quote_idx on public.payment_milestones(quote_id, due_date, seq);

alter table public.event_checklist     enable row level security;
alter table public.payment_milestones  enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_checklist','payment_milestones')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read chk"   on public.event_checklist for select to authenticated using ( true );
create policy "write chk"  on public.event_checklist for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read mile"  on public.payment_milestones for select to authenticated using ( true );
create policy "write mile" on public.payment_milestones for all  to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- =====================================================================
-- SOURCE: phase15-readiness.sql
-- =====================================================================

-- =========================================================================
-- PHASE 15 — Event Ready checkpoint (readiness gate)  [Block C]
-- Idempotent. Depends on: phase13-plan.sql (event_plan).
-- The readiness checklist is COMPUTED in the app by aggregating what earlier
-- phases already store. The only DB change is two sign-off timestamps
-- (dry run + team briefing) on event_plan, plus an RPC to set them.
-- =========================================================================

alter table public.event_plan add column if not exists dry_run_at  timestamptz;
alter table public.event_plan add column if not exists briefing_at timestamptz;

create or replace function public.set_plan_signoff(p_quote_id uuid, p_field text, p_done boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
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
end; $$;

revoke all on function public.set_plan_signoff(uuid,text,boolean) from public, anon;
grant execute on function public.set_plan_signoff(uuid,text,boolean) to authenticated;

-- =====================================================================
-- SOURCE: phase16-dayops.sql
-- =====================================================================

-- =========================================================================
-- PHASE 16 — Event-day command center  [Block D]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- One table for the live day view: arrivals (staff/vendor check-in) and
-- setup/technical checks. The roster can be auto-pulled from the crew already
-- assigned (event_tasks) and the vendors booked (event_resources).
-- =========================================================================

create table if not exists public.event_day (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null check (kind in ('arrival','check')),
  who        text not null,            -- person/vendor name, or the check title
  role       text,                     -- department / 'vendor' / area
  ref_id     uuid,                     -- crew_id or booking id (dedupe on pull)
  status     text not null default 'expected',  -- arrivals: expected|arrived|left|no_show ; checks: pending|done|issue
  note       text,
  seq        int not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_day_quote_idx on public.event_day(quote_id, kind, seq);

drop trigger if exists event_day_set_updated on public.event_day;
create trigger event_day_set_updated before update on public.event_day
  for each row execute function public.set_updated_at();

alter table public.event_day enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_day'
  loop execute format('drop policy if exists %I on public.event_day', p.policyname); end loop;
end $$;
create policy "read day"   on public.event_day for select to authenticated using ( true );
create policy "write day"  on public.event_day for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- =====================================================================
-- SOURCE: phase17-issues.sql
-- =====================================================================

-- =========================================================================
-- PHASE 17 — Live coordination & issues  [Block D]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_issues = live issue tickets + safety/incident log for the day.
-- (In-event billable scope changes reuse change_requests from Phase 12;
--  the client walkthrough reuses the approval/plan pages.)
-- =========================================================================

create table if not exists public.event_issues (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  kind        text not null default 'issue'   check (kind in ('issue','incident')),
  title       text not null,
  detail      text,
  severity    text not null default 'medium'  check (severity in ('low','medium','high')),
  owner       text,
  status      text not null default 'open'    check (status in ('open','in_progress','resolved')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  created_by  uuid references auth.users(id)
);
create index if not exists event_issues_quote_idx on public.event_issues(quote_id, status, created_at desc);

alter table public.event_issues enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_issues'
  loop execute format('drop policy if exists %I on public.event_issues', p.policyname); end loop;
end $$;
create policy "read issues"  on public.event_issues for select to authenticated using ( true );
create policy "write issues" on public.event_issues for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- =====================================================================
-- SOURCE: phase18-teardown.sql
-- =====================================================================

-- =========================================================================
-- PHASE 18 — Teardown & returns  [Block D]
-- Idempotent. Depends on: phase14-logistics.sql (event_checklist),
--   phase7-inventory.sql (returns), phase9-vendors.sql (vendor exit).
-- Teardown reuses what's already there: inventory reservations go to
-- 'returned' (freeing/adjusting stock) and vendor bookings go to 'delivered'.
-- The only schema change is allowing a 'teardown' section on the checklist.
-- =========================================================================

alter table public.event_checklist drop constraint if exists event_checklist_section_check;
alter table public.event_checklist
  add constraint event_checklist_section_check
  check (section in ('logistics','compliance','comms','guests','teardown'));

-- =====================================================================
-- SOURCE: phase19-settlement.sql
-- =====================================================================

-- =========================================================================
-- PHASE 19 — Settlement & billing  [Block D]
-- Idempotent. Depends on: phase9-vendors.sql (event_resources),
--   phase12-budget.sql, phase14-logistics.sql (payment_milestones).
-- Adds: vendor settlement flags on bookings + a staff expense-claims table.
-- The client invoice/margin is computed in the app from revenue, approved
-- change orders, payments received and costs (nothing new to store there).
-- =========================================================================

alter table public.event_resources add column if not exists settled    boolean not null default false;
alter table public.event_resources add column if not exists settled_at  timestamptz;

create table if not exists public.expense_claims (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  who         text not null,
  description text,
  amount      numeric not null default 0,
  status      text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists expense_claims_quote_idx on public.expense_claims(quote_id, created_at);

alter table public.expense_claims enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='expense_claims'
  loop execute format('drop policy if exists %I on public.expense_claims', p.policyname); end loop;
end $$;
create policy "read exp"  on public.expense_claims for select to authenticated using ( true );
create policy "write exp" on public.expense_claims for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- =====================================================================
-- SOURCE: phase20-closure.sql
-- =====================================================================

-- =========================================================================
-- PHASE 20 — Closure, feedback, P&L & archive  [Block D — final checkpoint]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_closure = feedback / testimonial / consent / lessons + closed stamp.
-- event_ratings = ratings for the vendors & staff on this event.
-- The P&L is computed in the app from revenue, costs, expenses.
-- =========================================================================

create table if not exists public.event_closure (
  quote_id      uuid primary key references public.quotes(id) on delete cascade,
  client_rating int check (client_rating between 1 and 5),
  feedback      text,
  testimonial   text,
  media_consent boolean not null default false,
  lessons       text,
  closed_at     timestamptz,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

create table if not exists public.event_ratings (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null check (kind in ('vendor','staff')),
  name       text not null,
  stars      int  not null check (stars between 1 and 5),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_ratings_quote_idx on public.event_ratings(quote_id, kind);

alter table public.event_closure enable row level security;
alter table public.event_ratings enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_closure','event_ratings')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read closure"  on public.event_closure for select to authenticated using ( true );
create policy "write closure" on public.event_closure for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read ratings"  on public.event_ratings for select to authenticated using ( true );
create policy "write ratings" on public.event_ratings for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- upsert the feedback / testimonial / lessons content
create or replace function public.set_closure(
  p_quote_id uuid, p_rating int, p_feedback text, p_testimonial text, p_media_consent boolean, p_lessons text
) returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_closure (quote_id, client_rating, feedback, testimonial, media_consent, lessons, updated_at, updated_by)
  values (p_quote_id, p_rating, p_feedback, p_testimonial, coalesce(p_media_consent,false), p_lessons, now(), auth.uid())
  on conflict (quote_id) do update set
    client_rating=excluded.client_rating, feedback=excluded.feedback, testimonial=excluded.testimonial,
    media_consent=excluded.media_consent, lessons=excluded.lessons, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

-- mark the event closed & archived (stamps closure + moves lifecycle to 'closed')
create or replace function public.close_event(p_quote_id uuid, p_closed boolean)
returns public.event_closure language plpgsql security definer set search_path = public as $$
declare r public.event_closure;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_closure (quote_id, closed_at, updated_by)
    values (p_quote_id, case when p_closed then now() end, auth.uid())
  on conflict (quote_id) do update set
    closed_at = case when p_closed then now() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  update public.quotes set lifecycle_stage = case when p_closed then 'closed' else 'settlement' end, updated_at=now()
   where id = p_quote_id;
  return r;
end; $$;

revoke all on function public.set_closure(uuid,int,text,text,boolean,text) from public, anon;
revoke all on function public.close_event(uuid,boolean)                    from public, anon;
grant execute on function public.set_closure(uuid,int,text,text,boolean,text) to authenticated;
grant execute on function public.close_event(uuid,boolean)                    to authenticated;

-- =====================================================================
-- SOURCE: otp-dev-pin.sql
-- =====================================================================

-- =========================================================================
-- TEMPORARY dev OTP pin — always 123456 in simulation mode
-- Run this once. Replaces request_otp() so the client-approval OTP is a fixed
-- 123456 while testing (no SMS gateway needed). When you go live with MSG91,
-- flip sms_live on and the real code is generated by the send-otp Edge Function.
-- Idempotent. Depends on: otp-payments.sql.
-- =========================================================================
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare q public.quotes; code text; recent int; live boolean;
begin
  select * into q from public.quotes where approval_token = p_token;
  if q.id is null then raise exception 'invalid link'; end if;
  if p_phone is null or length(regexp_replace(p_phone,'[^0-9]','','g')) < 8 then raise exception 'enter a valid phone number'; end if;
  select count(*) into recent from public.quote_otps where quote_id=q.id and created_at > now()-interval '10 minutes';
  if recent >= 5 then raise exception 'too many OTP requests — try again in a few minutes'; end if;
  -- TEMPORARY dev PIN: in simulation the code is always 123456 for easy testing.
  code := '123456';
  insert into public.quote_otps(quote_id, phone, code_hash, expires_at)
    values (q.id, p_phone, extensions.crypt(code, extensions.gen_salt('bf')), now()+interval '10 minutes');
  perform public._notify(q.id,'sms',p_phone,'otp', jsonb_build_object('purpose','approval'));
  live := public._flag('sms_live');
  return jsonb_build_object('sent', true, 'live', live, 'dev_code', case when live then null else code end);
end; $$;

-- SOURCE: seed-users.sql

-- =========================================================================
-- Blueprint Stage — seed team users (one per role), password "helm"
-- Run order in the Supabase SQL editor:
--   1) schema.sql        (layouts table)
--   2) auth-rbac.sql     (profiles + roles + RLS)
--   3) seed-users.sql    (THIS FILE)
--
-- Creates confirmed email/password users directly in the auth schema and
-- assigns each an RBAC role. Idempotent — safe to re-run.
--
-- Accounts (all password: helm):
--   admin@helm.com       → admin       (full access + user management)
--   planner@helm.com     → planner     (full create/edit/delete)
--   sales@helm.com       → sales       (create/edit)
--   operations@helm.com  → operations  (edit)
--   crew@helm.com        → crew        (view only)
--   client@helm.com      → client      (view only)
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_helm_user(p_email text, p_password text, p_role text)
returns void language plpgsql security definer set search_path = auth, public, extensions as $$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;

  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      p_email, extensions.crypt(p_password, extensions.gen_salt('bf')),
      now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now()
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      created_at, updated_at, last_sign_in_at
    ) values (
      gen_random_uuid(), uid,
      jsonb_build_object('sub', uid::text, 'email', p_email),
      'email', uid::text, now(), now(), now()
    );
  else
    -- reset the password on re-run so it always matches
    update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
                          email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = uid;
  end if;

  insert into public.profiles (id, email, role)
  values (uid, p_email, p_role)
  on conflict (id) do update set role = excluded.role, email = excluded.email;
end; $$;

select public.create_helm_user('admin@helm.com',      'helm', 'admin');
select public.create_helm_user('planner@helm.com',    'helm', 'planner');
select public.create_helm_user('sales@helm.com',      'helm', 'sales');
select public.create_helm_user('operations@helm.com', 'helm', 'operations');
select public.create_helm_user('crew@helm.com',       'helm', 'crew');
select public.create_helm_user('client@helm.com',     'helm', 'client');

-- verify
select p.email, p.role from public.profiles p order by p.role;


-- ========================================================================
-- SOURCE: phase21-hardening.sql
-- ========================================================================
-- =========================================================================
-- Phase 21 — Hardening: role-based READ access + atomic inventory adjust
--
-- WHY: until now every feature table read as `using (true)` for any signed-in
-- user, so a crew or client account could read finances, leads, proposals, etc.
-- This pins READ access to the role, matching the app's VIEW_SCOPE:
--   finance/pipeline  -> admin, planner, sales           (can_view_finance)
--   ops/resources     -> admin, planner, sales, operations (can_view_ops)
--   crew / client     -> no internal tables (they use token flows only)
--
-- Idempotent: re-running drops & recreates the policies each time. Safe to run
-- after all earlier phase SQL. Token/worker/approval flows are unaffected —
-- they go through SECURITY DEFINER RPCs which bypass RLS.
-- =========================================================================

-- 1) role helpers ---------------------------------------------------------
create or replace function public.can_view_finance() returns boolean
  language sql stable set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales'), false);
$$;
create or replace function public.can_view_ops() returns boolean
  language sql stable set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false);
$$;

-- 2) atomic inventory total adjust (avoids a lost update on concurrent teardown returns)
create or replace function public.adjust_inventory_total(p_item_id uuid, p_delta numeric)
  returns public.inventory_items language plpgsql security definer set search_path = public as $$
declare row public.inventory_items;
begin
  if not public.can_edit() then raise exception 'not allowed'; end if;
  update public.inventory_items
     set total_qty = greatest(0, coalesce(total_qty,0) + coalesce(p_delta,0))
   where id = p_item_id
   returning * into row;
  return row;
end; $$;
revoke all on function public.adjust_inventory_total(uuid, numeric) from anon;
grant execute on function public.adjust_inventory_total(uuid, numeric) to authenticated;

-- 3) re-scope RLS read policies by role -----------------------------------
do $$
declare
  -- finance + client pipeline: admin / planner / sales only
  fin  text[] := array['event_costs','change_requests','payment_milestones','expense_claims',
                       'event_closure','event_ratings','quote_payments','quote_consents',
                       'leads','lead_archive','event_discovery','event_requirements',
                       'event_proposal','proposal_risks'];
  -- operational data: + operations. writes stay on can_edit()
  opsd text[] := array['event_resource_needs','event_resources','inventory_items','inventory_reservations',
                       'run_sheet_items','event_plan','event_checklist','event_day','event_issues',
                       'crew_members','vendors','event_tasks','task_templates',
                       'work_tokens','notifications'];
  -- quote core: read = ops; keep create/edit/delete split (operations can edit but not create/delete)
  core text[] := array['quotes','quote_versions','layouts'];
  t text; p record;
begin
  foreach t in array fin loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_finance() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_view_finance() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_view_finance() )', t);
  end loop;

  foreach t in array opsd loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_ops() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_edit() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_edit() )', t);
  end loop;

  foreach t in array core loop
    if to_regclass('public.'||t) is null then continue; end if;
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "p21 view" on public.%I for select to authenticated using ( public.can_view_ops() )', t);
    execute format('create policy "p21 ins"  on public.%I for insert to authenticated with check ( public.can_create() )', t);
    execute format('create policy "p21 upd"  on public.%I for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() )', t);
    execute format('create policy "p21 del"  on public.%I for delete to authenticated using ( public.can_delete() )', t);
  end loop;
end $$;

-- 4) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase22-guest-reception.sql
-- ========================================================================
-- =========================================================================
-- Phase 22 — Guest entry / reception (spec step 56)
-- Day-of welcome-desk check-in: guest groups with expected vs arrived counts.
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_guests (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  label      text not null,                 -- group: "Bride's family", "VIPs", "Walk-ins"…
  expected   int  not null default 0,
  arrived    int  not null default 0,
  note       text,
  seq        int  not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_guests_quote_idx on public.event_guests(quote_id, seq);

alter table public.event_guests enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_guests'
  loop execute format('drop policy if exists %I on public.event_guests', p.policyname); end loop;
end $$;
create policy "guests view"  on public.event_guests for select to authenticated using ( public.can_view_ops() );
create policy "guests ins"   on public.event_guests for insert to authenticated with check ( public.can_edit() );
create policy "guests upd"   on public.event_guests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "guests del"   on public.event_guests for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase23-live-stock.sql
-- ========================================================================
-- =========================================================================
-- Phase 23 — Live inventory support (spec step 60)
-- On the day: raise a stock request, mark it issued or replaced. A running log.
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_stock_requests (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  item_id    uuid references public.inventory_items(id) on delete set null,  -- optional catalog link
  label      text not null,                 -- what's needed
  qty        numeric not null default 1,
  status     text not null default 'requested'
             check (status in ('requested','issued','replaced','cancelled')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_stock_req_quote_idx on public.event_stock_requests(quote_id, created_at desc);

alter table public.event_stock_requests enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_stock_requests'
  loop execute format('drop policy if exists %I on public.event_stock_requests', p.policyname); end loop;
end $$;
create policy "stockreq view" on public.event_stock_requests for select to authenticated using ( public.can_view_ops() );
create policy "stockreq ins"  on public.event_stock_requests for insert to authenticated with check ( public.can_edit() );
create policy "stockreq upd"  on public.event_stock_requests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "stockreq del"  on public.event_stock_requests for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase24-refunds.sql
-- ========================================================================
-- =========================================================================
-- Phase 24 — Refund / recovery handling (spec step 80)
-- Deposits, damage deductions, refunds to the client, amounts to recover.
-- Idempotent. Finance data -> read + write = admin/planner/sales (phase21 scoping).
-- =========================================================================
create table if not exists public.event_refunds (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null default 'refund'
             check (kind in ('refund','recovery','deduction')),
  amount     numeric not null default 0,
  reason     text,
  status     text not null default 'pending'
             check (status in ('pending','approved','processed','rejected')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_refunds_quote_idx on public.event_refunds(quote_id, created_at);

alter table public.event_refunds enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_refunds'
  loop execute format('drop policy if exists %I on public.event_refunds', p.policyname); end loop;
end $$;
create policy "refunds view" on public.event_refunds for select to authenticated using ( public.can_view_finance() );
create policy "refunds ins"  on public.event_refunds for insert to authenticated with check ( public.can_view_finance() );
create policy "refunds upd"  on public.event_refunds for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() );
create policy "refunds del"  on public.event_refunds for delete to authenticated using ( public.can_view_finance() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase25-media.sql
-- ========================================================================
-- =========================================================================
-- Phase 25 — Event photos / media collection & client gallery (spec step 86)
-- Collect photo/video links per event, flag which ones go in the client gallery.
-- (URL-based — no file storage needed; links to Drive/Dropbox/YouTube etc.)
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_media (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null default 'photo' check (kind in ('photo','video')),
  url        text not null,
  caption    text,
  in_gallery boolean not null default true,   -- shown in the client-facing gallery
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_media_quote_idx on public.event_media(quote_id, seq, created_at);

alter table public.event_media enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_media'
  loop execute format('drop policy if exists %I on public.event_media', p.policyname); end loop;
end $$;
create policy "media view" on public.event_media for select to authenticated using ( public.can_view_ops() );
create policy "media ins"  on public.event_media for insert to authenticated with check ( public.can_edit() );
create policy "media upd"  on public.event_media for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "media del"  on public.event_media for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase26-templates.sql
-- ========================================================================
-- =========================================================================
-- Phase 26 — Reusable checklist templates / process update (spec step 92)
-- Turn lessons learned into reusable checklists you can apply to future events.
-- Global (not per-event). Idempotent. Read = ops roles; write = editors.
-- =========================================================================
create table if not exists public.checklist_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  section    text not null default 'logistics'
             check (section in ('logistics','compliance','comms','guests')),
  items      jsonb not null default '[]'::jsonb,   -- array of item titles (strings)
  notes      text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists checklist_templates_idx on public.checklist_templates(section, name);

alter table public.checklist_templates enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='checklist_templates'
  loop execute format('drop policy if exists %I on public.checklist_templates', p.policyname); end loop;
end $$;
create policy "tpl view" on public.checklist_templates for select to authenticated using ( public.can_view_ops() );
create policy "tpl ins"  on public.checklist_templates for insert to authenticated with check ( public.can_edit() );
create policy "tpl upd"  on public.checklist_templates for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "tpl del"  on public.checklist_templates for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase27-nurture.sql
-- ========================================================================
-- =========================================================================
-- Phase 27 — Repeat business / CRM nurture (spec step 94)
-- A nurture list of past & prospective clients with occasion follow-up dates.
-- Idempotent. CRM/sales data -> read + write = admin/planner/sales (phase21).
-- =========================================================================
create table if not exists public.nurture (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  email         text,
  occasion      text,                          -- "Anniversary", "Birthday", "Annual gala"…
  occasion_date date,
  next_followup date,                           -- when to reach out next
  note          text,
  status        text not null default 'active'
                check (status in ('active','won','dormant')),
  quote_id      uuid references public.quotes(id) on delete set null,   -- source event, if any
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id)
);
create index if not exists nurture_followup_idx on public.nurture(next_followup);

alter table public.nurture enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='nurture'
  loop execute format('drop policy if exists %I on public.nurture', p.policyname); end loop;
end $$;
create policy "nurture view" on public.nurture for select to authenticated using ( public.can_view_finance() );
create policy "nurture ins"  on public.nurture for insert to authenticated with check ( public.can_view_finance() );
create policy "nurture upd"  on public.nurture for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() );
create policy "nurture del"  on public.nurture for delete to authenticated using ( public.can_view_finance() );

notify pgrst, 'reload schema';


-- ========================================================================
-- SOURCE: phase28-quote-codes.sql
-- ========================================================================
-- =========================================================================
-- Phase 28 — Fix "duplicate key value violates unique constraint quotes_code_key"
--
-- Cause: create_quote inserted the CLIENT-supplied code (p_code). If that number
-- was already taken (a stale dashboard list, or a lead-conversion grabbed it
-- first), the insert hit the unique index on quotes.code.
--
-- Fix: both create_quote and convert_lead_to_quote now generate the code
-- SERVER-SIDE from max(existing) for today's stamp, inside a retry loop that
-- recomputes on a unique_violation — so concurrent creates never collide.
-- p_code is kept in the signature for compatibility but ignored.
-- Idempotent (create or replace).
-- =========================================================================

create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes; v_stamp text := to_char(now(),'MMDDYYYY'); v_next int; v_code text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version)
        values (v_code, coalesce(p_title,'Untitled event'), p_event_type, 1)
        returning * into q;
      exit;                         -- success
    exception when unique_violation then
      if v_try >= 25 then raise; end if;   -- give up after 25 tries
      -- else loop: recompute the next number and try again
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $$;

create or replace function public.convert_lead_to_quote(p_lead_id uuid)
returns public.quotes language plpgsql security definer set search_path = public as $$
declare
  l public.leads; q public.quotes;
  v_stamp text := to_char(now(),'MMDDYYYY'); v_next int; v_code text; v_title text; v_try int := 0;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  select * into l from public.leads where id = p_lead_id;
  if not found then raise exception 'lead not found'; end if;
  if l.quote_id is not null then select * into q from public.quotes where id = l.quote_id; return q; end if;
  v_title := coalesce(nullif(l.name, ''), 'Untitled event')
             || case when l.event_type is not null then ' — ' || l.event_type else '' end;
  loop
    v_try := v_try + 1;
    select coalesce(max((regexp_match(code, '^' || v_stamp || '-(\d+)'))[1]::int), 0) + 1
      into v_next from public.quotes where code like v_stamp || '-%';
    v_code := v_stamp || '-' || lpad(v_next::text, 2, '0');
    begin
      insert into public.quotes (code, title, event_type, current_version, client, lifecycle_stage, event_date)
        values (v_code, v_title, l.event_type, 1,
                jsonb_strip_nulls(jsonb_build_object('name', l.name, 'phone', l.phone, 'email', l.email)),
                'discovery', l.event_date)
        returning * into q;
      exit;
    exception when unique_violation then
      if v_try >= 25 then raise; end if;
    end;
  end loop;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, '{"items":[]}'::jsonb, 0, auth.uid());
  update public.leads set status = 'quoted', quote_id = q.id, updated_at = now() where id = p_lead_id;
  return q;
end; $$;

revoke all on function public.create_quote(text,text,text,jsonb,int) from public, anon;
grant execute on function public.create_quote(text,text,text,jsonb,int) to authenticated;
revoke all on function public.convert_lead_to_quote(uuid) from public, anon;
grant execute on function public.convert_lead_to_quote(uuid) to authenticated;

notify pgrst, 'reload schema';


-- =========================================================================
-- Phase 29 — configurable per-role access matrix + 4 new roles (see phase29-role-access.sql)
-- =========================================================================
-- =========================================================================
-- Phase 29 — Configurable per-role access matrix + 4 new roles
--
-- WHAT this adds
--   1. Four new roles: coordinator, supervisor, worker, manager (total 10).
--   2. role_access(role, area, can_view, can_edit) — an admin-editable matrix
--      that decides, per role, which feature AREAS are visible/editable.
--   3. has_area(area, need) — the single helper every RLS policy now uses, so
--      access follows the matrix. Admin is always allowed (safety floor).
--   4. Every feature table's RLS is rebuilt off has_area (supersedes phase21).
--   5. admin_get_role_access / admin_set_role_access RPCs for the Control Center.
--
-- SAFE + IDEMPOTENT: re-running drops & recreates policies and re-seeds any
-- missing default rows (it never overwrites choices an admin already changed).
-- Token / worker / approval flows are untouched — they use SECURITY DEFINER RPCs
-- that bypass RLS. Run this AFTER phase21..phase28.
-- =========================================================================

-- 1) Widen the allowed roles (CHECK constraint + validator) ----------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','planner','sales','coordinator','supervisor','operations','crew','worker','client'));

create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable set search_path = public as $$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','operations','crew','worker','client');
$$;

-- 2) The access-matrix table ----------------------------------------------
create table if not exists public.role_access (
  role      text not null,
  area      text not null,
  can_view  boolean not null default false,
  can_edit  boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (role, area)
);
alter table public.role_access enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='role_access'
  loop execute format('drop policy if exists %I on public.role_access', p.policyname); end loop;
end $$;
-- everyone signed in may read the rows for their OWN role (so the app can gate the UI);
-- admins may read/write everything.
create policy "ra read own"  on public.role_access for select to authenticated
  using ( role = public.user_role() or public.is_admin() );
create policy "ra admin ins" on public.role_access for insert to authenticated with check ( public.is_admin() );
create policy "ra admin upd" on public.role_access for update to authenticated using ( public.is_admin() ) with check ( public.is_admin() );
create policy "ra admin del" on public.role_access for delete to authenticated using ( public.is_admin() );

-- 3) Seed sensible defaults (only inserts rows that don't exist yet) -------
--   v = can_view, e = can_edit. Admin is implicit-all (handled in has_area).
do $$
declare
  -- area, and the roles that get view / edit by default
  seed jsonb := '[
    {"area":"leads","view":["manager","planner","sales","coordinator"],"edit":["manager","planner","sales"]},
    {"area":"crm","view":["manager","planner","sales","coordinator"],"edit":["manager","planner","sales"]},
    {"area":"nurture","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"discovery","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"proposal","view":["manager","planner","sales"],"edit":["manager","planner","sales"]},
    {"area":"quotes","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","sales"]},
    {"area":"staff","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"inventory","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"vendors","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"calendar","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"templates","view":["manager","planner","coordinator","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"resources","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","operations"]},
    {"area":"runsheet","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"plan","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"logistics","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator"]},
    {"area":"ready","view":["manager","planner","coordinator","supervisor"],"edit":["manager","planner","coordinator"]},
    {"area":"finance","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"settlement","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"closure","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"command","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor"]},
    {"area":"issues","view":["manager","planner","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor","operations"]},
    {"area":"media","view":["manager","planner","sales","coordinator","supervisor","operations"],"edit":["manager","planner","coordinator","supervisor"]},
    {"area":"controls","view":["manager"],"edit":["manager"]},
    {"area":"codes","view":["manager","planner","sales"],"edit":["manager","planner"]},
    {"area":"users","view":[],"edit":[]}
  ]'::jsonb;
  allroles text[] := array['manager','planner','sales','coordinator','supervisor','operations','crew','worker','client'];
  rec jsonb; a text; r text; v boolean; e boolean;
begin
  for rec in select value from jsonb_array_elements(seed) loop
    a := rec->>'area';
    foreach r in array allroles loop
      v := jsonb_exists(rec->'view', r);
      e := jsonb_exists(rec->'edit', r);
      insert into public.role_access(role, area, can_view, can_edit)
        values (r, a, v, (e and v))          -- edit implies view
      on conflict (role, area) do nothing;    -- never clobber an admin's later change
    end loop;
    -- admin row too (kept in sync for display; has_area allows admin regardless)
    insert into public.role_access(role, area, can_view, can_edit)
      values ('admin', a, true, true) on conflict (role, area) do nothing;
  end loop;
end $$;

-- 4) has_area(): the one gate every policy uses --------------------------
create or replace function public.has_area(p_area text, p_need text default 'view')
  returns boolean language sql stable security definer set search_path = public as $$
  select case
    when public.user_role() = 'admin' then true                    -- admin: full floor
    else coalesce((
      select case when p_need = 'edit' then ra.can_edit else ra.can_view end
      from public.role_access ra
      where ra.role = public.user_role() and ra.area = p_area
    ), false)                                                       -- unknown/absent = deny
  end;
$$;
revoke all on function public.has_area(text,text) from anon;
grant execute on function public.has_area(text,text) to authenticated;

-- keep the legacy helpers working (older policies/copies may reference them)
create or replace function public.can_view_finance() returns boolean
  language sql stable set search_path = public as $$ select public.has_area('finance','view'); $$;
create or replace function public.can_view_ops() returns boolean
  language sql stable set search_path = public as $$ select public.has_area('quotes','view'); $$;

-- 5) Rebuild RLS on every feature table, driven by has_area(area) ----------
--    (supersedes the coarse phase21 groupings). Missing tables are skipped.
do $$
declare
  -- area -> tables that belong to it
  amap jsonb := '{
    "leads":["leads"],
    "crm":["lead_archive"],
    "nurture":["nurture"],
    "discovery":["event_discovery","event_requirements"],
    "proposal":["event_proposal","proposal_risks"],
    "quotes":["quotes","quote_versions","layouts","quote_consents","quote_payments","notifications"],
    "staff":["crew_members","event_tasks","work_tokens"],
    "inventory":["inventory_items","inventory_reservations"],
    "vendors":["vendors","event_resources","event_resource_needs"],
    "templates":["task_templates","checklist_templates"],
    "runsheet":["run_sheet_items"],
    "plan":["event_plan","event_checklist"],
    "finance":["event_costs","change_requests","payment_milestones","expense_claims"],
    "settlement":["event_refunds"],
    "closure":["event_closure","event_ratings"],
    "command":["event_day","event_guests","event_stock_requests"],
    "issues":["event_issues"],
    "media":["event_media"]
  }'::jsonb;
  area text; tbls jsonb; t text; p record;
begin
  for area in select jsonb_object_keys(amap) loop
    tbls := amap->area;
    for t in select jsonb_array_elements_text(tbls) loop
      if to_regclass('public.'||t) is null then continue; end if;
      for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
        execute format('drop policy if exists %I on public.%I', p.policyname, t);
      end loop;
      execute format('alter table public.%I enable row level security', t);
      execute format($f$create policy "ra view" on public.%I for select to authenticated using ( public.has_area(%L,'view') )$f$, t, area);
      execute format($f$create policy "ra ins"  on public.%I for insert to authenticated with check ( public.has_area(%L,'edit') )$f$, t, area);
      execute format($f$create policy "ra upd"  on public.%I for update to authenticated using ( public.has_area(%L,'edit') ) with check ( public.has_area(%L,'edit') )$f$, t, area, area);
      execute format($f$create policy "ra del"  on public.%I for delete to authenticated using ( public.has_area(%L,'edit') )$f$, t, area);
    end loop;
  end loop;
end $$;

-- 6) admin RPCs for the Control Center matrix editor ----------------------
create or replace function public.admin_get_role_access()
  returns setof public.role_access language sql stable security definer set search_path = public as $$
  select * from public.role_access order by role, area;
$$;

create or replace function public.admin_set_role_access(p_role text, p_area text, p_view boolean, p_edit boolean)
  returns public.role_access language plpgsql security definer set search_path = public as $$
declare row public.role_access;
begin
  if not public.is_admin() then raise exception 'not authorized' using errcode='42501'; end if;
  if not public._valid_role(p_role) then raise exception 'unknown role %', p_role; end if;
  insert into public.role_access(role, area, can_view, can_edit, updated_at)
    values (p_role, p_area, coalesce(p_view,false), coalesce(p_edit,false) and coalesce(p_view,false), now())
  on conflict (role, area) do update
    set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now()
  returning * into row;
  return row;
end; $$;

revoke all on function public.admin_get_role_access()                    from public, anon;
revoke all on function public.admin_set_role_access(text,text,boolean,boolean) from public, anon;
grant execute on function public.admin_get_role_access()                    to authenticated;
grant execute on function public.admin_set_role_access(text,text,boolean,boolean) to authenticated;

-- 7) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';


-- =========================================================================
-- Phase 30 — nurture automation: recurring occasions + auto greetings (see phase30-nurture-automation.sql)
-- =========================================================================
-- =========================================================================
-- Phase 30 — Nurture automation: recurring occasions + auto greetings
--
-- WHAT this adds
--   • Recurring occasions on each nurture contact (birthday / anniversary /
--     festival / custom) with a per-contact auto-greeting switch.
--   • nurture_templates — one editable message per occasion type, with a good
--     default. Placeholders: {{name}} {{occasion}} {{years}} {{last_event}} {{studio}}.
--   • nurture_automation — a single global on/off switch (+ how many days ahead).
--   • nurture_due()  — everyone with an occasion coming up (age/years, next date,
--     whether already greeted this year).
--   • queue_nurture_greeting() — renders the template, attaches up to 3 photos
--     from that client's event gallery, and drops the message in the notification
--     outbox (channel=email, status=simulated — real send stays deferred).
--   • run_nurture_auto() — queues greetings for every due, auto-on contact; this
--     is what a daily scheduled job would call once real email is switched on.
--
-- RUN ORDER: run phase29-role-access.sql FIRST (this uses has_area('nurture')).
-- Idempotent. Real SMS/email sending is intentionally deferred.
-- =========================================================================

-- 1) extend the nurture contacts with recurrence + automation --------------
alter table public.nurture add column if not exists occasion_type text not null default 'custom';
alter table public.nurture add column if not exists recurrence    text not null default 'yearly';
alter table public.nurture add column if not exists auto_on       boolean not null default false;
alter table public.nurture add column if not exists last_greeted  date;

-- 2) editable per-occasion templates --------------------------------------
create table if not exists public.nurture_templates (
  occasion_type text primary key,
  subject       text not null,
  body          text not null,
  enabled       boolean not null default true,
  updated_at    timestamptz not null default now()
);

insert into public.nurture_templates (occasion_type, subject, body) values
 ('birthday',   'Happy Birthday, {{name}}! 🎂',
  E'Hi {{name}},\n\nHappy birthday from all of us at {{studio}}! 🎉 We were just remembering {{last_event}} — it was such a joy working with you. Wishing you a wonderful year ahead. We''ve attached a few favourite memories below.\n\nWarmly,\n{{studio}}'),
 ('anniversary','Happy Anniversary, {{name}}! 💐',
  E'Hi {{name}},\n\nHappy {{years}}-year anniversary! It feels like yesterday we were part of {{last_event}}. Thank you for letting us be part of your story — here are a few memories we still love. If you''re planning a celebration, we''d be honoured to help again.\n\nWith love,\n{{studio}}'),
 ('festival',  'Season''s greetings, {{name}}! ✨',
  E'Hi {{name}},\n\nWarmest wishes from {{studio}} this festive season. We loved being part of {{last_event}} and hope this year brings more moments worth celebrating. A few memories attached to bring a smile.\n\nBest,\n{{studio}}'),
 ('custom',    'Thinking of you, {{name}}',
  E'Hi {{name}},\n\nJust checking in from {{studio}} — we remember {{last_event}} fondly and would love to work with you again. Here are a few memories.\n\nWarmly,\n{{studio}}')
on conflict (occasion_type) do nothing;

-- 3) global automation switch (singleton row) -----------------------------
create table if not exists public.nurture_automation (
  id          int primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  within_days int not null default 0,          -- send on the day (0) or N days ahead
  updated_at  timestamptz not null default now()
);
insert into public.nurture_automation (id) values (1) on conflict (id) do nothing;

-- 4) RLS on the two new tables (nurture area) ------------------------------
do $$ declare t text; p record; begin
  foreach t in array array['nurture_templates','nurture_automation'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;
    execute format($f$create policy "n30 view" on public.%I for select to authenticated using ( public.has_area('nurture','view') )$f$, t);
    execute format($f$create policy "n30 ins"  on public.%I for insert to authenticated with check ( public.has_area('nurture','edit') )$f$, t);
    execute format($f$create policy "n30 upd"  on public.%I for update to authenticated using ( public.has_area('nurture','edit') ) with check ( public.has_area('nurture','edit') )$f$, t);
    execute format($f$create policy "n30 del"  on public.%I for delete to authenticated using ( public.has_area('nurture','edit') )$f$, t);
  end loop;
end $$;

-- 5) helper: the next occurrence of a yearly occasion (never errors) -------
-- adds the occasion's day-of-year offset to Jan 1 of the current year; rolls to
-- next year if it has already passed. Good enough for greetings (no leap crash).
create or replace function public._next_occasion(p_date date) returns date
  language sql immutable set search_path = public as $$
  select case
    when p_date is null then null
    else (
      case when cand < current_date then (cand + interval '1 year')::date else cand end
    )
  end
  from (select (make_date(extract(year from current_date)::int,1,1)
               + (p_date - make_date(extract(year from p_date)::int,1,1)))::date as cand) s;
$$;

-- 6) who has an occasion coming up -----------------------------------------
create or replace function public.nurture_due(p_within_days int default 30)
  returns table(
    id uuid, name text, email text, phone text, occasion text, occasion_type text,
    occasion_date date, next_date date, years int, auto_on boolean,
    greeted_this_year boolean, quote_id uuid, last_event text
  ) language sql stable security definer set search_path = public as $$
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
    and n.occasion_date is not null
    and public._next_occasion(n.occasion_date) <= current_date + (greatest(p_within_days,0) || ' days')::interval
  order by public._next_occasion(n.occasion_date);
$$;
revoke all on function public.nurture_due(int) from anon;
grant execute on function public.nurture_due(int) to authenticated;

-- 7) render + queue one greeting (attaches gallery photos) -----------------
create or replace function public.queue_nurture_greeting(p_id uuid)
  returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n public.nurture; tpl public.nurture_templates; ot text;
  v_years int; v_last text; v_photos text[]; v_subject text; v_body text; v_detail jsonb;
  v_studio text := 'Blueprint Stage';
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into n from public.nurture where id = p_id;
  if not found then raise exception 'contact not found'; end if;

  ot := coalesce(n.occasion_type,'custom');
  select * into tpl from public.nurture_templates where occasion_type = ot;
  if not found then select * into tpl from public.nurture_templates where occasion_type='custom'; end if;

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
  update public.nurture set last_greeted = current_date where id = p_id;
  return v_detail;
end; $$;
revoke all on function public.queue_nurture_greeting(uuid) from anon;
grant execute on function public.queue_nurture_greeting(uuid) to authenticated;

-- 8) queue greetings for every due, auto-on contact (the daily job) --------
create or replace function public.run_nurture_auto(p_within_days int default null)
  returns int language plpgsql security definer set search_path = public as $$
declare a public.nurture_automation; within int; d record; cnt int := 0;
begin
  if not public.has_area('nurture','edit') then raise exception 'not authorized' using errcode='42501'; end if;
  select * into a from public.nurture_automation where id = 1;
  if not coalesce(a.enabled,false) then return 0; end if;
  within := coalesce(p_within_days, a.within_days, 0);
  for d in
    select nd.* from public.nurture_due(within) nd
    join public.nurture_templates t on t.occasion_type = nd.occasion_type
    where nd.auto_on = true and nd.greeted_this_year = false
      and nd.email is not null and t.enabled = true
  loop
    perform public.queue_nurture_greeting(d.id);
    cnt := cnt + 1;
  end loop;
  return cnt;
end; $$;
revoke all on function public.run_nurture_auto(int) from anon;
grant execute on function public.run_nurture_auto(int) to authenticated;

-- 9) let PostgREST see the new definitions immediately
notify pgrst, 'reload schema';

-- =========================================================================
-- GO-LIVE (deferred): to send greetings automatically every morning, once a
-- real email channel (Resend/SendGrid) is wired into a "send-email" Edge
-- Function, schedule this with pg_cron:
--   select cron.schedule('nurture-daily','0 9 * * *', $$ select public.run_nurture_auto(); $$);
-- Until then greetings queue to notifications with status='simulated'.
-- =========================================================================


-- =========================================================================
-- Phase 31 — quality-engineer role + planner-only layouts + tighter sales (see phase31-roles-layout.sql)
-- =========================================================================
-- =========================================================================
-- Phase 31 — Cluster A: quality-engineer role, planner-only layouts, tighter sales
--
-- WHAT
--   • Adds the 'quality' (Quality engineer) role → 11 roles total.
--   • Gives floor layouts their own access area ('layouts') and makes EDITING
--     planner-only (everyone else who sees the workspace can view). Enforced in DB.
--   • Seeds default access for the new role, the layouts area, and tightens the
--     default SALES preset to Leads + CRM only (admins can widen any of it later
--     in Control Center → User control).
--
-- RUN AFTER phase29-role-access.sql. Idempotent (re-running is safe and corrects
-- the seeded rows). Display names (Event manager / Event coordinator / Quality
-- engineer / Supervisor) are labels in the app; the DB keeps stable role keys.
-- =========================================================================

-- 1) widen roles to include 'quality' -------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client'));

create or replace function public._valid_role(p_role text) returns boolean
  language sql immutable set search_path = public as $$
  select p_role in ('admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client');
$$;

-- 2) layouts get their own area (planner-only edit) -----------------------
--    (supersedes phase29, which grouped layouts under 'quotes')
do $$ declare p record; begin
  if to_regclass('public.layouts') is not null then
    for p in select policyname from pg_policies where schemaname='public' and tablename='layouts'
    loop execute format('drop policy if exists %I on public.layouts', p.policyname); end loop;
    alter table public.layouts enable row level security;
    create policy "ra view" on public.layouts for select to authenticated using ( public.has_area('layouts','view') );
    create policy "ra ins"  on public.layouts for insert to authenticated with check ( public.has_area('layouts','edit') );
    create policy "ra upd"  on public.layouts for update to authenticated using ( public.has_area('layouts','edit') ) with check ( public.has_area('layouts','edit') );
    create policy "ra del"  on public.layouts for delete to authenticated using ( public.has_area('layouts','edit') );
  end if;
end $$;

-- 3) seed / correct default access rows -----------------------------------
--    overrides is [{role, area, view, edit}] applied as an upsert (corrects rows).
do $$
declare
  overrides jsonb := '[
    {"role":"planner","area":"layouts","view":true,"edit":true},
    {"role":"manager","area":"layouts","view":true,"edit":false},
    {"role":"sales","area":"layouts","view":false,"edit":false},
    {"role":"coordinator","area":"layouts","view":true,"edit":false},
    {"role":"supervisor","area":"layouts","view":true,"edit":false},
    {"role":"operations","area":"layouts","view":true,"edit":false},
    {"role":"quality","area":"layouts","view":true,"edit":false},
    {"role":"crew","area":"layouts","view":false,"edit":false},
    {"role":"worker","area":"layouts","view":false,"edit":false},
    {"role":"client","area":"layouts","view":false,"edit":false},

    {"role":"quality","area":"quotes","view":true,"edit":false},
    {"role":"quality","area":"staff","view":true,"edit":false},
    {"role":"quality","area":"inventory","view":true,"edit":false},
    {"role":"quality","area":"vendors","view":true,"edit":false},
    {"role":"quality","area":"calendar","view":true,"edit":false},
    {"role":"quality","area":"templates","view":true,"edit":false},
    {"role":"quality","area":"resources","view":true,"edit":false},
    {"role":"quality","area":"runsheet","view":true,"edit":false},
    {"role":"quality","area":"plan","view":true,"edit":false},
    {"role":"quality","area":"logistics","view":true,"edit":false},
    {"role":"quality","area":"ready","view":true,"edit":false},
    {"role":"quality","area":"command","view":true,"edit":true},
    {"role":"quality","area":"issues","view":true,"edit":true},
    {"role":"quality","area":"media","view":true,"edit":false},
    {"role":"quality","area":"leads","view":false,"edit":false},
    {"role":"quality","area":"crm","view":false,"edit":false},
    {"role":"quality","area":"nurture","view":false,"edit":false},
    {"role":"quality","area":"discovery","view":false,"edit":false},
    {"role":"quality","area":"proposal","view":false,"edit":false},
    {"role":"quality","area":"finance","view":false,"edit":false},
    {"role":"quality","area":"settlement","view":false,"edit":false},
    {"role":"quality","area":"closure","view":false,"edit":false},
    {"role":"quality","area":"controls","view":false,"edit":false},
    {"role":"quality","area":"codes","view":false,"edit":false},
    {"role":"quality","area":"users","view":false,"edit":false},

    {"role":"sales","area":"leads","view":true,"edit":true},
    {"role":"sales","area":"crm","view":true,"edit":true},
    {"role":"sales","area":"nurture","view":false,"edit":false},
    {"role":"sales","area":"discovery","view":false,"edit":false},
    {"role":"sales","area":"proposal","view":false,"edit":false},
    {"role":"sales","area":"quotes","view":false,"edit":false},
    {"role":"sales","area":"layouts","view":false,"edit":false},
    {"role":"sales","area":"finance","view":false,"edit":false},
    {"role":"sales","area":"settlement","view":false,"edit":false},
    {"role":"sales","area":"closure","view":false,"edit":false},
    {"role":"sales","area":"staff","view":false,"edit":false},
    {"role":"sales","area":"inventory","view":false,"edit":false},
    {"role":"sales","area":"vendors","view":false,"edit":false},
    {"role":"sales","area":"calendar","view":false,"edit":false},
    {"role":"sales","area":"templates","view":false,"edit":false},
    {"role":"sales","area":"media","view":false,"edit":false},
    {"role":"sales","area":"codes","view":false,"edit":false}
  ]'::jsonb;
  o jsonb;
begin
  for o in select value from jsonb_array_elements(overrides) loop
    insert into public.role_access(role, area, can_view, can_edit, updated_at)
      values (o->>'role', o->>'area', (o->>'view')::boolean, ((o->>'edit')::boolean and (o->>'view')::boolean), now())
    on conflict (role, area) do update
      set can_view = excluded.can_view, can_edit = excluded.can_edit, updated_at = now();
  end loop;

  -- make sure the layouts area exists for admin too (display)
  insert into public.role_access(role, area, can_view, can_edit)
    values ('admin','layouts',true,true) on conflict (role, area) do nothing;
end $$;

-- 4) reload
notify pgrst, 'reload schema';


-- =========================================================================
-- Phase 32 — fix _next_occasion date math (see phase32-nurture-datefix.sql)
-- =========================================================================
-- =========================================================================
-- Phase 32 — Fix _next_occasion() date math (nurture automation)
--
-- The phase30 version added the occasion's day-of-year offset to Jan 1, which
-- drifts by a day across leap years — a "today" occasion could roll a full year
-- forward, so nurture_due()/run_nurture_auto() would miss it. This recomputes the
-- next occurrence from the actual month/day (clamping Feb 29 → Feb 28 in non-leap
-- years so it never errors). nurture_due() and queue_nurture_greeting() call this,
-- so both are corrected. Idempotent. Run AFTER phase30.
-- =========================================================================

create or replace function public._next_occasion(p_date date) returns date
  language plpgsql stable set search_path = public as $$
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
end $$;

notify pgrst, 'reload schema';
