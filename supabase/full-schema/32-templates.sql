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
-- Phase 26 — Reusable checklist templates / process update (spec step 92)
-- Turn lessons learned into reusable checklists you can apply to future events.
-- Global (not per-event). Idempotent. Read = ops roles; write = editors.
-- =========================================================================
create table if not exists public.checklist_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  section    text not null default 'logistics'
             check (section in ('logistics','compliance','comms','guests')),
  items      jsonb not null default '[]'::jsonb,   -- array of item titles (strings)
  notes      text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists checklist_templates_idx on public.checklist_templates(section, name);

alter table public.checklist_templates enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='checklist_templates'
  loop execute format('drop policy if exists %I on public.checklist_templates', p.policyname); end loop;
end $$;
create policy "tpl view" on public.checklist_templates for select to authenticated using ( public.can_view_ops() );
create policy "tpl ins"  on public.checklist_templates for insert to authenticated with check ( public.can_edit() );
create policy "tpl upd"  on public.checklist_templates for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "tpl del"  on public.checklist_templates for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';

-- a156guard txn: end of the one transaction opened above the refusal guard
commit;
