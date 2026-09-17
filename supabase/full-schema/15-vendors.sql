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
