-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
begin;
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- a156guard txn: the refusal above runs INSIDE a transaction, so under psql -f without ON_ERROR_STOP
-- every later statement fails too ("current transaction is aborted") and nothing is applied.
-- ==========================================================================================
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

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
