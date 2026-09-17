-- =========================================================================
-- PHASE 3 — Discovery & requirements
-- Idempotent. Safe to re-run. Depends on: setup-complete.sql (quotes, RBAC).
-- Adds:
--   • public.event_discovery     — one discovery record per event (meeting + budget)
--   • public.event_requirements  — structured service needs (must/optional/nice)
--   • set_discovery()            — upsert the discovery record (can_edit)
-- Feeds the quote: the workspace shows the budget range + must-haves next to
-- the Quote card. Does NOT touch the quote / 3D engine.
-- =========================================================================

-- 1) DISCOVERY (one row per event) ---------------------------------------
create table if not exists public.event_discovery (
  quote_id    uuid primary key references public.quotes(id) on delete cascade,
  meet_date   date,
  mode        text,            -- in_person | call | video
  location    text,            -- address or meeting link
  attendees   text,
  notes       text,
  budget_min  numeric,
  budget_max  numeric,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- 2) REQUIREMENTS (many per event) ---------------------------------------
create table if not exists public.event_requirements (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  service     text not null,
  priority    text not null default 'mandatory'
              check (priority in ('mandatory','optional','nice')),
  qty         int,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);
create index if not exists event_req_quote_idx on public.event_requirements(quote_id, created_at);

-- 3) RLS ------------------------------------------------------------------
alter table public.event_discovery    enable row level security;
alter table public.event_requirements enable row level security;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname='public' and tablename in ('event_discovery','event_requirements')
  loop execute format('drop policy if exists %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "read discovery"   on public.event_discovery    for select to authenticated using ( true );
create policy "write discovery"  on public.event_discovery    for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "read reqs"    on public.event_requirements for select to authenticated using ( true );
create policy "insert reqs"  on public.event_requirements for insert to authenticated with check ( public.can_edit() );
create policy "update reqs"  on public.event_requirements for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "delete reqs"  on public.event_requirements for delete to authenticated using ( public.can_delete() );

-- 4) UPSERT the discovery record -----------------------------------------
create or replace function public.set_discovery(
  p_quote_id uuid, p_meet_date date, p_mode text, p_location text,
  p_attendees text, p_notes text, p_budget_min numeric, p_budget_max numeric
) returns public.event_discovery language plpgsql security definer set search_path = public as $$
declare d public.event_discovery;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  insert into public.event_discovery
    (quote_id, meet_date, mode, location, attendees, notes, budget_min, budget_max, updated_at, updated_by)
  values
    (p_quote_id, p_meet_date, p_mode, p_location, p_attendees, p_notes, p_budget_min, p_budget_max, now(), auth.uid())
  on conflict (quote_id) do update set
    meet_date=excluded.meet_date, mode=excluded.mode, location=excluded.location,
    attendees=excluded.attendees, notes=excluded.notes,
    budget_min=excluded.budget_min, budget_max=excluded.budget_max,
    updated_at=now(), updated_by=auth.uid()
  returning * into d;
  return d;
end; $$;
revoke all on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) from public, anon;
grant execute on function public.set_discovery(uuid,date,text,text,text,text,numeric,numeric) to authenticated;
