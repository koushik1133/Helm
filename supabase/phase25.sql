-- =========================================================================
-- Phase 25 — Event photos / media collection & client gallery (spec step 86)
-- Collect photo/video links per event, flag which ones go in the client gallery.
-- (URL-based — no file storage needed; links to Drive/Dropbox/YouTube etc.)
-- Idempotent. Read = ops roles; write = editors (matches phase21 scoping).
-- =========================================================================
create table if not exists public.event_media (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes(id) on delete cascade,
  kind       text not null default 'photo' check (kind in ('photo','video')),
  url        text not null,
  caption    text,
  in_gallery boolean not null default true,   -- shown in the client-facing gallery
  seq        int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index if not exists event_media_quote_idx on public.event_media(quote_id, seq, created_at);

alter table public.event_media enable row level security;
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='event_media'
  loop execute format('drop policy if exists %I on public.event_media', p.policyname); end loop;
end $$;
create policy "media view" on public.event_media for select to authenticated using ( public.can_view_ops() );
create policy "media ins"  on public.event_media for insert to authenticated with check ( public.can_edit() );
create policy "media upd"  on public.event_media for update to authenticated using ( public.can_edit() ) with check ( public.can_edit() );
create policy "media del"  on public.event_media for delete to authenticated using ( public.can_edit() );

notify pgrst, 'reload schema';
