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
-- PHASE 14 — Logistics, permits, guests, comms + payment milestones  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- event_checklist   = one flexible per-event checklist, split by section
--   (logistics / compliance / comms / guests). Guest rows carry a headcount.
-- payment_milestones = the payment schedule (label, due date, amount, status);
--   reminders reuse the existing mgr_notify() notification RPC.
-- =========================================================================

create table if not exists public.event_checklist (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  section    text not null check (section in ('logistics','compliance','comms','guests')),
  title      text not null,
  detail     text,
  owner      text,
  due_date   date,
  qty        int,                     -- headcount for guest rows
  status     text not null default 'open' check (status in ('open','done','na')),
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_checklist_quote_idx on public.event_checklist(quote_id, section, seq);

create table if not exists public.payment_milestones (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  label      text not null,
  due_date   date,
  amount     numeric not null default 0,
  status     text not null default 'due' check (status in ('due','invoiced','paid','waived')),
  paid_at    timestamptz,
  note       text,
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists payment_milestones_quote_idx on public.payment_milestones(quote_id, due_date, seq);

alter table public.event_checklist     enable row level security;
alter table public.payment_milestones  enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_checklist','payment_milestones')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read chk"   on public.event_checklist for select to authenticated using ( true );
create policy "write chk"  on public.event_checklist for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read mile"  on public.payment_milestones for select to authenticated using ( true );
create policy "write mile" on public.payment_milestones for all  to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
