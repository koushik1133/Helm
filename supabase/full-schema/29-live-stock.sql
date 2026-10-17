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
-- Phase 23 — Live inventory support (spec step 60)
-- On the day: raise a stock request, mark it issued or replaced. A running log.
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_stock_requests (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  item_id    uuid references public.inventory_items(id) on delete set null,  -- optional catalog link
  label      text not null,                 -- what's needed
  qty        numeric not null default 1,
  status     text not null default 'requested'
             check (status in ('requested','issued','replaced','cancelled')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_stock_req_quote_idx on public.event_stock_requests(quote_id, created_at desc);

alter table public.event_stock_requests enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_stock_requests'
  loop execute format('drop policy if exists %I on public.event_stock_requests', p.policyname); end loop;
end $$;
create policy "stockreq view" on public.event_stock_requests for select to authenticated using ( public.can_view_ops() );
create policy "stockreq ins"  on public.event_stock_requests for insert to authenticated with check ( public.can_edit() );
create policy "stockreq upd"  on public.event_stock_requests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "stockreq del"  on public.event_stock_requests for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
