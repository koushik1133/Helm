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
