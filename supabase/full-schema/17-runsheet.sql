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
