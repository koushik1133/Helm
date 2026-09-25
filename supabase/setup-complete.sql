-- =========================================================================
-- DEPRECATED — DO NOT RUN (PR-DEPLOY-01). This aggregate defines PRE-HARDENING,
-- NON-org-scoped admin_*/confirm_quote/create_quote bodies. Running it after the
-- numbered phase migrations would REVERT tenant isolation (phase73). The
-- canonical deploy path is the numbered supabase/phaseNN-name.sql files applied
-- in order. Kept for history only. See supabase/full-schema/README.md.
-- =========================================================================
-- Blueprint Stage — COMPLETE database setup (historical aggregate; do not run).
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
