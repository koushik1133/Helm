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
-- Phase 24 — Refund / recovery handling (spec step 80)
-- Deposits, damage deductions, refunds to the client, amounts to recover.
-- Idempotent. Finance data -> read + write = admin/planner/sales (phase21 scoping).
-- =========================================================================
create table if not exists public.event_refunds (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null default 'refund'
             check (kind in ('refund','recovery','deduction')),
  amount     numeric not null default 0,
  reason     text,
  status     text not null default 'pending'
             check (status in ('pending','approved','processed','rejected')),
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_refunds_quote_idx on public.event_refunds(quote_id, created_at);

alter table public.event_refunds enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_refunds'
  loop execute format('drop policy if exists %I on public.event_refunds', p.policyname); end loop;
end $$;
create policy "refunds view" on public.event_refunds for select to authenticated using ( public.can_view_finance() );
create policy "refunds ins"  on public.event_refunds for insert to authenticated with check ( public.can_view_finance() );
create policy "refunds upd"  on public.event_refunds for update to authenticated using ( public.can_view_finance() ) with check ( public.can_view_finance() );
create policy "refunds del"  on public.event_refunds for delete to authenticated using ( public.can_view_finance() );

notify pgrst, 'reload schema';
