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
-- Phase 22 — Guest entry / reception (spec step 56)
-- Day-of welcome-desk check-in: guest groups with expected vs arrived counts.
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_guests (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  label      text not null,                 -- group: "Bride's family", "VIPs", "Walk-ins"…
  expected   int  not null default 0,
  arrived    int  not null default 0,
  note       text,
  seq        int  not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_guests_quote_idx on public.event_guests(quote_id, seq);

alter table public.event_guests enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_guests'
  loop execute format('drop policy if exists %I on public.event_guests', p.policyname); end loop;
end $$;
create policy "guests view"  on public.event_guests for select to authenticated using ( public.can_view_ops() );
create policy "guests ins"   on public.event_guests for insert to authenticated with check ( public.can_edit() );
create policy "guests upd"   on public.event_guests for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "guests del"   on public.event_guests for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';
