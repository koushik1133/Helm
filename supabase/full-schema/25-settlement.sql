-- =========================================================================
-- PHASE 19 — Settlement & billing  [Block D]
-- Idempotent. Depends on: phase9-vendors.sql (event_resources),
--   phase12-budget.sql, phase14-logistics.sql (payment_milestones).
-- Adds: vendor settlement flags on bookings + a staff expense-claims table.
-- The client invoice/margin is computed in the app from revenue, approved
-- change orders, payments received and costs (nothing new to store there).
-- =========================================================================

alter table public.event_resources add column if not exists settled    boolean not null default false;
alter table public.event_resources add column if not exists settled_at  timestamptz;

create table if not exists public.expense_claims (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  who         text not null,
  description text,
  amount      numeric not null default 0,
  status      text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists expense_claims_quote_idx on public.expense_claims(quote_id, created_at);

alter table public.expense_claims enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='expense_claims'
  loop execute format('drop policy if exists %I on public.expense_claims', p.policyname); end loop;
end $$;
create policy "read exp"  on public.expense_claims for select to authenticated using ( true );
create policy "write exp" on public.expense_claims for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
