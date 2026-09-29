-- =====================================================================
-- BUILD 4 — Event file/document storage (private bucket + tenant-isolated RLS)
-- =====================================================================
-- Adds per-event document storage. This is as much a SECURITY change as a feature:
-- files are the classic tenant-isolation hole, so the bucket is PRIVATE and every
-- object is scoped by org_id in its path AND by has_area. Path convention:
--     <org_id>/<quote_id>/<uuid>.<ext>
-- Metadata lives in public.event_files (RLS-scoped) so listings never enumerate the
-- raw bucket. Additive + idempotent. Zero data loss.
--
-- NOTE: creating storage buckets/policies may require the storage admin role. If any
-- statement here errors on permissions when YOU run it in the Supabase SQL editor,
-- create the bucket in Dashboard → Storage (name 'event-docs', PRIVATE) and re-run;
-- the policies below use standard storage.objects RLS.
-- =====================================================================

-- 1) Private bucket (never public). Idempotent.
insert into storage.buckets (id, name, public)
values ('event-docs', 'event-docs', false)
on conflict (id) do update set public = false;   -- ensure it stays private

-- 2) Storage RLS on storage.objects for this bucket only.
--    org is the FIRST path segment; has_area gates view/edit. Anon has no policy → denied.
drop policy if exists event_docs_select on storage.objects;
drop policy if exists event_docs_insert on storage.objects;
drop policy if exists event_docs_update on storage.objects;
drop policy if exists event_docs_delete on storage.objects;

create policy event_docs_select on storage.objects
  for select to authenticated
  using (bucket_id = 'event-docs'
     and (storage.foldername(name))[1] = (select public.current_org_id())::text
     and (public.has_area('quotes','view') or public.has_area('media','view')));

create policy event_docs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'event-docs'
     and (storage.foldername(name))[1] = (select public.current_org_id())::text
     and (public.has_area('quotes','edit') or public.has_area('media','edit')));

create policy event_docs_update on storage.objects
  for update to authenticated
  using (bucket_id = 'event-docs'
     and (storage.foldername(name))[1] = (select public.current_org_id())::text
     and (public.has_area('quotes','edit') or public.has_area('media','edit')))
  with check (bucket_id = 'event-docs'
     and (storage.foldername(name))[1] = (select public.current_org_id())::text
     and (public.has_area('quotes','edit') or public.has_area('media','edit')));

create policy event_docs_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'event-docs'
     and (storage.foldername(name))[1] = (select public.current_org_id())::text
     and (public.has_area('quotes','edit') or public.has_area('media','edit')));

-- 3) Metadata table (listings go through RLS here, not raw bucket enumeration).
create table if not exists public.event_files (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  storage_path text not null,
  filename text not null,
  mime text,
  size_bytes bigint,
  uploaded_by uuid,
  created_at timestamptz not null default now(),
  org_id uuid not null default public.current_org_id(),
  constraint event_files_pkey primary key (id),
  constraint event_files_path_uk unique (storage_path),
  constraint event_files_quote_fk foreign key (quote_id) references public.quotes(id) on delete cascade
);
create index if not exists ix_event_files_quote on public.event_files (quote_id);

alter table public.event_files enable row level security;
alter table public.event_files force row level security;
drop policy if exists event_files_select on public.event_files;
drop policy if exists event_files_write  on public.event_files;
create policy event_files_select on public.event_files
  for select to authenticated
  using (org_id = public.current_org_id()
     and (public.has_area('quotes','view') or public.has_area('media','view')));
create policy event_files_write on public.event_files
  for all to authenticated
  using (org_id = public.current_org_id()
     and (public.has_area('quotes','edit') or public.has_area('media','edit')))
  with check (org_id = public.current_org_id()
     and (public.has_area('quotes','edit') or public.has_area('media','edit'))
     -- the referenced event must belong to the caller's org (no metadata rows
     -- pointing at another tenant's quote, even though org_id already = caller org)
     and exists (select 1 from public.quotes q
                 where q.id = quote_id and q.org_id = public.current_org_id()));

-- 4) list_event_files(quote_id): RLS-scoped metadata list for an event
create or replace function public.list_event_files(p_quote_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.has_area('quotes','view') or public.has_area('media','view') then
    coalesce((
      select jsonb_agg(to_jsonb(f) order by f.created_at desc)
      from public.event_files f
      where f.quote_id = p_quote_id and f.org_id = public.current_org_id()
    ), '[]'::jsonb)
  else '[]'::jsonb end;
$$;
revoke all on function public.list_event_files(uuid) from anon, public;
grant execute on function public.list_event_files(uuid) to authenticated;

-- VERIFY
select 'event-docs bucket is PRIVATE' as check, (public = false) as ok from storage.buckets where id='event-docs'
union all
select 'event_files RLS forced', (select relforcerowsecurity from pg_class where relname='event_files')
union all
select 'list_event_files revoked from anon (want true)',
  not has_function_privilege('anon','public.list_event_files(uuid)','EXECUTE')
union all
select '4 storage policies on event-docs',
  (select count(*) from pg_policies where schemaname='storage' and tablename='objects'
     and policyname like 'event_docs_%') = 4;
