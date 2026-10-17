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
-- PHASE 12 — Budget vs. actuals + change orders  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes), phase9-vendors.sql
--   (event_resources, for importing vendor costs).
-- event_costs   = cost lines (estimated vs actual, internal / vendor / other)
-- change_requests = priced scope changes (revenue + cost impact) the client
--   approves; approved ones roll into the budget. Margin = quote revenue − cost.
-- =========================================================================

-- 1) COST LINES ----------------------------------------------------------
create table if not exists public.event_costs (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  category    text,
  description text not null,
  kind        text not null default 'internal' check (kind in ('internal','vendor','other')),
  estimated   numeric not null default 0,
  actual      numeric,
  booking_id  uuid references public.event_resources(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists event_costs_quote_idx on public.event_costs(quote_id, created_at);

-- 2) CHANGE REQUESTS (priced scope changes) ------------------------------
create table if not exists public.change_requests (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  title       text not null,
  detail      text,
  price_delta numeric not null default 0,   -- extra charged to the client
  cost_delta  numeric not null default 0,   -- extra cost to deliver it
  status      text not null default 'requested' check (status in ('requested','approved','rejected')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  decided_at  timestamptz
);
create index if not exists change_req_quote_idx on public.change_requests(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_costs     enable row level security;
alter table public.change_requests enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_costs','change_requests')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read costs"   on public.event_costs for select to authenticated using ( true );
create policy "write costs"  on public.event_costs for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read changes"   on public.change_requests for select to authenticated using ( true );
create policy "insert changes" on public.change_requests for insert to authenticated with check ( public.can_edit() );
create policy "update changes" on public.change_requests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete changes" on public.change_requests for delete to authenticated using ( public.can_delete() );

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
