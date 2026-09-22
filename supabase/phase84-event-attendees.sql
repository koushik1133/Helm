-- ============================================================================
-- Phase 84 — Per-person event attendees (named guests + ticket status)
-- ---------------------------------------------------------------------------
-- Helm already has event_guests (phase22) = GROUP-level expected/arrived counts.
-- This adds the missing INDIVIDUAL attendee record (name, email, ticket_status)
-- requested for ticketing. It is purely additive and does NOT touch or replace
-- event_guests — both coexist (groups vs named people).
--
-- SAFE BY DESIGN: additive + idempotent; RLS enabled; org-scoped on every row.
-- A BEFORE-write trigger FORCES org_id = current_org_id() (ignoring any client
-- value) and asserts the parent quote belongs to the caller's org — so an
-- attendee can never be attached to another tenant's event.
--
-- Idempotent. Run AFTER phase56 (org_id/current_org_id), phase57 (has_area),
-- phase72 (assert_quote_org). quotes = the "event" table.
-- ============================================================================

create table if not exists public.event_attendees (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null default public.current_org_id() references public.organizations(id) on delete cascade,
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  name          text,
  email         text,
  ticket_status text not null default 'invited',   -- invited | confirmed | checked_in | cancelled
  seq           int  not null default 0,
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users(id) default auth.uid()
);
create index if not exists event_attendees_org_quote_idx on public.event_attendees(org_id, quote_id, seq);

-- ---- tenant + parent-quote guard on every write ----------------------------
create or replace function public.event_attendees_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.org_id := public.current_org_id();       -- force the correct tenant, ignore client input
  perform public.assert_quote_org(new.quote_id); -- parent quote must be in the caller's org
  return new;
end; $$;
drop trigger if exists event_attendees_guard_trg on public.event_attendees;
create trigger event_attendees_guard_trg
  before insert or update on public.event_attendees
  for each row execute function public.event_attendees_guard();

-- ---- RLS: 4-policy CRUD, gated on quotes access + org ----------------------
alter table public.event_attendees enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_attendees'
  loop execute format('drop policy if exists %I on public.event_attendees', p.policyname); end loop;
end $$;
create policy "ea view" on public.event_attendees for select to authenticated
  using ( public.has_area('quotes','view') and org_id = (select public.current_org_id()) );
create policy "ea ins"  on public.event_attendees for insert to authenticated
  with check ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) );
create policy "ea upd"  on public.event_attendees for update to authenticated
  using ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) )
  with check ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) );
create policy "ea del"  on public.event_attendees for delete to authenticated
  using ( public.has_area('quotes','edit') and org_id = (select public.current_org_id()) );

notify pgrst, 'reload schema';
select 'event_attendees' t, 'ready' s;
