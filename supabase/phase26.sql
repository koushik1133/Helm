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
