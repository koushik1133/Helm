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

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
