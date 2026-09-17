-- =========================================================================
-- PHASE 13 — Venue coordination + menu/package lock  [Block C]
-- Idempotent. Depends on: setup-complete.sql (quotes, RBAC).
-- One event_plan row per event: venue details/access + the agreed menu/package
-- with a lock (once locked, changes should go through a change order — Phase 12).
-- Approval tracking reuses the existing OTP/consent engine (quote_consents etc.)
-- =========================================================================

create table if not exists public.event_plan (
  quote_id       uuid primary key references public.quotes(id) on delete cascade,
  venue_name     text,
  venue_address  text,
  venue_contact  text,
  access_notes   text,
  package        text,
  menu           text,
  menu_locked    boolean not null default false,
  locked_at      timestamptz,
  locked_by      uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);

alter table public.event_plan enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='event_plan'
  loop execute format('drop policy if exists %I on public.event_plan', p.policyname); end loop;
end $$;
create policy "read plan"  on public.event_plan for select to authenticated using ( true );
create policy "write plan" on public.event_plan for all    to authenticated using ( public.can_edit() ) with check ( public.can_edit() );

-- upsert the venue + menu/package content (does not touch the lock)
create or replace function public.set_event_plan(
  p_quote_id uuid, p_venue_name text, p_venue_address text, p_venue_contact text,
  p_access_notes text, p_package text, p_menu text
) returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized to edit' using errcode='42501'; end if;
  insert into public.event_plan (quote_id, venue_name, venue_address, venue_contact, access_notes, package, menu, updated_at, updated_by)
  values (p_quote_id, p_venue_name, p_venue_address, p_venue_contact, p_access_notes, p_package, p_menu, now(), auth.uid())
  on conflict (quote_id) do update set
    venue_name=excluded.venue_name, venue_address=excluded.venue_address, venue_contact=excluded.venue_contact,
    access_notes=excluded.access_notes, package=excluded.package, menu=excluded.menu,
    updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

-- lock / unlock the menu & package
create or replace function public.set_plan_lock(p_quote_id uuid, p_locked boolean)
returns public.event_plan language plpgsql security definer set search_path = public as $$
declare r public.event_plan;
begin
  if not public.can_edit() then raise exception 'not authorized' using errcode='42501'; end if;
  insert into public.event_plan (quote_id, menu_locked, locked_at, locked_by, updated_at, updated_by)
    values (p_quote_id, p_locked, case when p_locked then now() end, case when p_locked then auth.uid() end, now(), auth.uid())
  on conflict (quote_id) do update set
    menu_locked=p_locked, locked_at = case when p_locked then now() else null end,
    locked_by = case when p_locked then auth.uid() else null end, updated_at=now(), updated_by=auth.uid()
  returning * into r;
  return r;
end; $$;

revoke all on function public.set_event_plan(uuid,text,text,text,text,text,text) from public, anon;
revoke all on function public.set_plan_lock(uuid,boolean)                        from public, anon;
grant execute on function public.set_event_plan(uuid,text,text,text,text,text,text) to authenticated;
grant execute on function public.set_plan_lock(uuid,boolean)                        to authenticated;
