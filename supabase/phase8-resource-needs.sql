-- ════ SUPERSEDED (audit run 2, RC-11) ════════════════════════════════════════
-- This legacy file predates the canonical migrations (supabase/migrations + MANIFEST).
-- Re-running it on a database that already has them would put back old, weaker function
-- bodies, so it refuses to run there. Use scripts/db-migrate.sh / the APPLY-00xx files.
do $a42guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded by 0039+ (canonical migrations) — do not re-run this legacy file';
  end if;
end $a42guard$;
-- ═════════════════════════════════════════════════════════════════════════════
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
