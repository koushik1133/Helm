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
