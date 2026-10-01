-- 0009_feature_tasks_files.sql — CANONICAL feature-completeness.
-- Adds current-app objects missing from base-v1: my_tasks, my_pending (worker/staff
-- queues), event_files + list_event_files (file storage), and the event-docs storage
-- policies. Extracted from completion/BUILD3/PHASE3/BUILD4 (no hardened fn redefined).
-- Installs G4 reject trigger on event_files (quote_id+org_id). Idempotent/forward-only.
-- =====================================================================
-- BUILD 3 — my_tasks(): personal task list bucketed TODAY / OVERDUE / BLOCKED / COMPLETED
-- =====================================================================
-- Returns, for the CALLER, the event_tasks assigned to THEM, pre-bucketed.
--
-- Assignment model (schema-confirmed): event_tasks.crew_id -> crew_members.id.
-- A logged-in user is linked to a crew_member by EMAIL within their org
-- (crew_members.email = profiles.email where profiles.id = auth.uid()).
-- There is no assigned_to=auth.uid() column, so the uid->crew join lives here.
-- A user with no matching crew row simply gets empty buckets (expected, not a bug).
--
-- Buckets (precedence: completed > blocked > overdue > today > upcoming):
--   completed : completed_at is not null
--   blocked   : open AND depends_on points at a task that is not completed
--   overdue   : open, not blocked, planned_end < start-of-today
--   today     : open, not blocked, planned_end within today
--   upcoming  : open, not blocked, planned_end in the future or null
--
-- SECURITY DEFINER but SAFE: results are inherently personal (crew_id = the
-- caller's own crew id) and org-scoped (org_id = current_org_id()). auth.uid()
-- and current_org_id() read the request JWT, so identity is honored under definer.
-- Additive, idempotent (create or replace). Revoked from anon.
-- =====================================================================

create or replace function public.my_tasks()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid, public.current_org_id() as org
  ),
  my_crew as (
    select cm.id
    from public.crew_members cm
    join public.profiles p on lower(cm.email) = lower(p.email)
    cross join me
    where p.id = me.uid
      and cm.org_id = me.org
      and cm.email is not null
    limit 1
  ),
  mine as (
    select t.id, t.quote_id, t.title, t.category, t.status, t.note,
           t.planned_start, t.planned_end, t.completed_at, t.depends_on,
           t.verify_status, q.code as event_code, q.title as event_title,
           (t.completed_at is not null) as is_done,
           (t.depends_on is not null and exists (
              select 1 from public.event_tasks d
              where d.id = t.depends_on and d.completed_at is null
           )) as is_blocked
    from public.event_tasks t
    join public.quotes q on q.id = t.quote_id
    cross join me
    where t.org_id = me.org
      and t.crew_id in (select id from my_crew)
  ),
  tagged as (
    select m.*,
      case
        when m.is_done then 'completed'
        when m.is_blocked then 'blocked'
        when m.planned_end is not null and m.planned_end < date_trunc('day', now()) then 'overdue'
        when m.planned_end is not null and m.planned_end < date_trunc('day', now()) + interval '1 day' then 'today'
        else 'upcoming'
      end as bucket
    from mine m
  )
  select jsonb_build_object(
    'today',     coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='today'), '[]'::jsonb),
    'overdue',   coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end) from tagged t where t.bucket='overdue'), '[]'::jsonb),
    'blocked',   coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='blocked'), '[]'::jsonb),
    'upcoming',  coalesce((select jsonb_agg(to_jsonb(t) order by t.planned_end nulls last) from tagged t where t.bucket='upcoming'), '[]'::jsonb),
    'completed', coalesce((select jsonb_agg(to_jsonb(t) order by t.completed_at desc) from tagged t where t.bucket='completed'), '[]'::jsonb),
    'counts',    jsonb_build_object(
        'today',     (select count(*) from tagged where bucket='today'),
        'overdue',   (select count(*) from tagged where bucket='overdue'),
        'blocked',   (select count(*) from tagged where bucket='blocked'),
        'upcoming',  (select count(*) from tagged where bucket='upcoming'),
        'completed', (select count(*) from tagged where bucket='completed')
    ),
    'as_of', now()
  );
$$;

revoke all on function public.my_tasks() from anon, public;
grant execute on function public.my_tasks() to authenticated;

-- Optional additive index for the crew_id + status hot path (safe, idempotent)
create index if not exists ix_event_tasks_crew_status on public.event_tasks (crew_id, status);

-- VERIFY
select 'my_tasks exists + authenticated can execute' as check,
       has_function_privilege('authenticated', 'public.my_tasks()', 'EXECUTE') as ok
union all
select 'anon CANNOT execute my_tasks (want ok=true)',
       not has_function_privilege('anon', 'public.my_tasks()', 'EXECUTE');
-- =====================================================================
-- PHASE 3 — my_pending(): personal dashboard feed (upcoming events + task rollup + unread)
-- =====================================================================
-- Returns, for the CALLER (org- and area-scoped), the active events they can see with
-- an open/done task rollup, plus an unread-notification count. Powers the dashboard
-- "Upcoming events + My pending tasks" widget (click an event → expand its tasks;
-- completed tasks shown collapsed).
--
-- SECURITY DEFINER but SAFE: explicitly filters org_id = current_org_id() and gates on
-- has_area('quotes','view') (so a role without quotes access gets an empty feed — same
-- rule as the RLS on quotes). auth.uid()/current_org_id() read the request JWT, so the
-- caller identity is honored even under definer.
-- Additive, idempotent (create or replace). Revoked from anon.
-- =====================================================================

create or replace function public.my_pending()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid, public.current_org_id() as org, public.has_area('quotes','view') as can_view
  ),
  ev as (
    select q.id, q.code, q.title, q.event_type, q.event_date, q.event_time, q.lifecycle_stage,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is null)     as open_tasks,
           (select count(*) from public.event_tasks t where t.quote_id = q.id and t.completed_at is not null) as done_tasks
    from public.quotes q, me
    where me.can_view
      and q.org_id = me.org
      and coalesce(q.lifecycle_stage,'') <> 'closed'
    order by q.event_date nulls last, q.updated_at desc
    limit 25
  ),
  unread as (
    select count(*)::int as c
    from public.notifications n, me
    where n.org_id = me.org
      and n.created_at > coalesce((select last_seen_at from public.notification_seen s where s.user_id = me.uid), '-infinity'::timestamptz)
  )
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(ev) order by (ev.event_date is null), ev.event_date) from ev), '[]'::jsonb),
    'unread',   (select c from unread),
    'as_of',    now()
  );
$$;

revoke all on function public.my_pending() from anon, public;
grant execute on function public.my_pending() to authenticated;

-- VERIFY
select 'my_pending exists + authenticated can execute' as check,
       has_function_privilege('authenticated', 'public.my_pending()', 'EXECUTE') as ok;
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

-- G4 coverage for event_files (quote_id + org_id)
drop trigger if exists zz_quote_org_match on public.event_files;
create trigger zz_quote_org_match before insert or update on public.event_files
  for each row execute function public.tg_quote_org_match();
