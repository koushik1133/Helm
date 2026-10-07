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
