-- =========================================================================
-- Quotes & versions — run ONCE in the Supabase SQL editor. Safe & idempotent.
-- A QUOTE is one event code (MMDDYYYY-NN). It carries client info + pricing and
-- a status (quote → confirmed). Every save from the builder is a new VERSION;
-- all versions are kept. Confirming a quote freezes a priced snapshot.
-- RBAC reuses can_create()/can_edit()/can_delete() from setup-all.sql.
-- =========================================================================

create extension if not exists pgcrypto with schema extensions;

-- role helpers (redefined so this file stands alone; identical to setup-all.sql)
create or replace function public.user_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid(); $$;
create or replace function public.can_edit() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales','operations'), false); $$;
create or replace function public.can_create() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner','sales'), false); $$;
create or replace function public.can_delete() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(public.user_role() in ('admin','planner'), false); $$;

-- 1) quotes ---------------------------------------------------------------
create table if not exists public.quotes (
  id              uuid primary key default gen_random_uuid(),
  code            text unique not null,                      -- MMDDYYYY-NN
  title           text not null default 'Untitled event',
  event_type      text,                                      -- concert / wedding / conference / …
  status          text not null default 'quote'
                  check (status in ('quote','confirmed','cancelled')),
  client          jsonb not null default '{}'::jsonb,        -- {name,email,phone,company,eventDate,venue,address,notes}
  pricing         jsonb not null default '{}'::jsonb,        -- see store-api for shape (chair/plate/catering/gst/…)
  current_version int  not null default 1,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  confirmed_by    uuid references auth.users(id)
);
create index if not exists quotes_updated_idx on public.quotes (updated_at desc);
create index if not exists quotes_status_idx  on public.quotes (status);

create or replace function public.set_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists quotes_set_updated on public.quotes;
create trigger quotes_set_updated before update on public.quotes
  for each row execute function public.set_updated_at();

-- 2) quote_versions (every save is a new immutable version) ---------------
create table if not exists public.quote_versions (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes(id) on delete cascade,
  version_no   int  not null,
  label        text,                                          -- optional note ("added VIP riser")
  data         jsonb not null default '{"items":[]}'::jsonb,  -- the full canvas layout
  object_count int  not null default 0,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),
  unique (quote_id, version_no)
);
create index if not exists qv_quote_idx on public.quote_versions (quote_id, version_no desc);

-- 3) Row Level Security ---------------------------------------------------
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

-- 4) helper: create a quote + its first version atomically ----------------
create or replace function public.create_quote(
  p_code text, p_title text, p_event_type text, p_data jsonb, p_object_count int
) returns public.quotes language plpgsql security definer set search_path = public as $$
declare q public.quotes;
begin
  if not public.can_create() then raise exception 'not authorized to create' using errcode='42501'; end if;
  insert into public.quotes (code, title, event_type, current_version)
    values (p_code, coalesce(p_title,'Untitled event'), p_event_type, 1)
    returning * into q;
  insert into public.quote_versions (quote_id, version_no, data, object_count, created_by)
    values (q.id, 1, coalesce(p_data,'{"items":[]}'::jsonb), coalesce(p_object_count,0), auth.uid());
  return q;
end; $$;

-- 5) helper: append a new version and bump current_version ----------------
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

-- 6) helper: confirm a quote (store client + pricing snapshot) -------------
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

revoke all on function public.create_quote(text,text,text,jsonb,int)       from public, anon;
revoke all on function public.add_quote_version(uuid,text,jsonb,int)        from public, anon;
revoke all on function public.confirm_quote(uuid,jsonb,jsonb)              from public, anon;
grant execute on function public.create_quote(text,text,text,jsonb,int)     to authenticated;
grant execute on function public.add_quote_version(uuid,text,jsonb,int)      to authenticated;
grant execute on function public.confirm_quote(uuid,jsonb,jsonb)            to authenticated;

-- verify
select 'quotes' t, count(*) from public.quotes union all select 'versions', count(*) from public.quote_versions;
