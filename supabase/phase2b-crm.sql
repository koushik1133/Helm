-- =========================================================================
-- PHASE 2b — Immutable CRM archive + realtime for the leads pipeline
-- Idempotent. Safe to re-run. Depends on: phase2-leads.sql.
-- Adds:
--   • public.lead_archive  — append-only snapshot of every lead change
--   • trigger archive_lead() — writes a snapshot on INSERT/UPDATE/DELETE
--   • realtime on public.leads (drag-and-drop syncs live across viewers)
-- The archive is NEVER deleted when a lead is removed — it is your safe CRM.
-- =========================================================================

-- 1) ARCHIVE TABLE (no FK to leads, so it outlives a deleted lead) ---------
create table if not exists public.lead_archive (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid,                         -- deliberately NOT a foreign key
  action       text not null,                -- created | updated | converted | deleted
  name         text,
  phone        text,
  email        text,
  source       text,
  event_type   text,
  event_date   date,
  budget       numeric,
  guest_count  int,
  notes        text,
  status       text,
  quote_id     uuid,
  snapshot     jsonb not null,               -- the full lead row at this moment
  archived_at  timestamptz not null default now(),
  archived_by  uuid default auth.uid()
);
create index if not exists lead_archive_lead_idx on public.lead_archive(lead_id, archived_at desc);
create index if not exists lead_archive_time_idx on public.lead_archive(archived_at desc);

-- 2) TRIGGER: snapshot every change (security definer so it always writes) --
create or replace function public.archive_lead()
returns trigger language plpgsql security definer set search_path = public as $$
declare r public.leads; act text;
begin
  if tg_op = 'DELETE' then r := old; act := 'deleted';
  elsif tg_op = 'INSERT' then r := new; act := 'created';
  else
    r := new;
    act := case when new.quote_id is not null and old.quote_id is null
                then 'converted' else 'updated' end;
  end if;
  insert into public.lead_archive
    (lead_id, action, name, phone, email, source, event_type, event_date,
     budget, guest_count, notes, status, quote_id, snapshot, archived_by)
  values
    (r.id, act, r.name, r.phone, r.email, r.source, r.event_type, r.event_date,
     r.budget, r.guest_count, r.notes, r.status, r.quote_id, to_jsonb(r), auth.uid());
  if tg_op = 'DELETE' then return old; end if;
  return new;
end; $$;

drop trigger if exists leads_archive_ins on public.leads;
create trigger leads_archive_ins after insert on public.leads
  for each row execute function public.archive_lead();
drop trigger if exists leads_archive_upd on public.leads;
create trigger leads_archive_upd after update on public.leads
  for each row execute function public.archive_lead();
drop trigger if exists leads_archive_del on public.leads;
create trigger leads_archive_del after delete on public.leads
  for each row execute function public.archive_lead();

-- 3) RLS: archive is READ-only to app users (only the trigger writes it) ----
alter table public.lead_archive enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies
           where schemaname='public' and tablename='lead_archive'
  loop execute format('drop policy if exists %I on public.lead_archive', p.policyname); end loop;
end $$;
create policy "read archive" on public.lead_archive for select to authenticated using ( true );
grant select on public.lead_archive to authenticated;
-- no insert/update/delete grants: the append-only trigger is the only writer.

-- 4) REALTIME: broadcast leads changes so the board updates live -----------
alter table public.leads replica identity full;   -- deliver full old/new rows
do $$ begin
  begin
    alter publication supabase_realtime add table public.leads;
  exception when others then null;   -- already in the publication → ignore
  end;
end $$;
