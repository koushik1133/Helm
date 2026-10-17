-- ==== SUPERSEDED - DO NOT RUN on a current database (audit run 3, 0156 a156guard) ====
-- This bundle is NOT in supabase/migrations/MANIFEST. Re-running it on a database that already has
-- the canonical migrations would put back older, weaker function bodies or policies (for example
-- the NULL-OTP consent bypass). It refuses to run once 0039+ is applied.
-- Use scripts/db-migrate.sh or the APPLY-0xxx files in MANIFEST order instead.
do $a156guard$ begin
  if to_regprocedure('public.verify_and_consent__pre0039(uuid, text, text, boolean, text, text, text, text)') is not null
     or to_regprocedure('public.verify_and_consent__pre0042(uuid, text, text, boolean, text, text, text, text)') is not null then
    raise exception 'superseded - do not re-run this legacy bundle on a database that has newer canonical migrations (see supabase/migrations/MANIFEST)';
  end if;
end $a156guard$;
-- ==========================================================================================
-- =========================================================================
-- PHASE 17 — Live coordination & issues  [Block D]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_issues = live issue tickets + safety/incident log for the day.
-- (In-event billable scope changes reuse change_requests from Phase 12;
--  the client walkthrough reuses the approval/plan pages.)
-- =========================================================================

create table if not exists public.event_issues (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  kind        text not null default 'issue'   check (kind in ('issue','incident')),
  title       text not null,
  detail      text,
  severity    text not null default 'medium'  check (severity in ('low','medium','high')),
  owner       text,
  status      text not null default 'open'    check (status in ('open','in_progress','resolved')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  created_by  uuid references auth.users(id)
);
create index if not exists event_issues_quote_idx on public.event_issues(quote_id, status, created_at desc);

alter table public.event_issues enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_issues'
  loop execute format('drop policy if exists %I on public.event_issues', p.policyname); end loop;
end $$;
create policy "read issues"  on public.event_issues for select to authenticated using ( true );
create policy "write issues" on public.event_issues for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
