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
