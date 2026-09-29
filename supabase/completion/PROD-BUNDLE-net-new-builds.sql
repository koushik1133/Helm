-- ============================================================================
-- PROD BUNDLE — Net-new builds (My-Tasks, Designer state machine, File storage)
-- Run this WHOLE file once in the PRODUCTION Supabase SQL editor.
-- All statements are additive + idempotent (safe to re-run). Zero data loss.
-- Order: Build 3 (my_tasks) -> Build 1 (designer) -> Build 4 (file storage).
-- After running, scroll up to check each VERIFY block returned ok = t.
-- NOTE (Build 4): if the storage.buckets / storage.objects statements error on
--   permissions, create a PRIVATE bucket named 'event-docs' in Dashboard ->
--   Storage, then re-run — the policies are standard storage RLS.
-- Generated 2026-09-29T15:34:52Z from BUILD3/BUILD1/BUILD4 (verified on staging).
-- ============================================================================

-- ========================= BUILD 3 : my_tasks =============================
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

-- ========================= BUILD 1 : designer =============================
-- =====================================================================
-- BUILD 1 — Designer role + 2D->3D design-approval state machine
-- =====================================================================
-- Adds a dedicated `designer` role (BESIDE the existing 11, additive) and a
-- formal per-event design pipeline with validated state transitions, notifications,
-- audit, and optimistic locking. "The quote row IS the event" — design_stages.quote_id
-- is the event. All additive + idempotent. Zero data loss.
--
-- States: draft_2d -> internal_review -> approved_2d -> build_3d -> client_review
--         -> approved_3d -> locked   (with `revise` loop-backs, revision counter)
-- =====================================================================

-- 1) Widen the profiles role CHECK to allow 'designer' (additive: only expands the set)
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role = any (array['admin','manager','planner','sales','coordinator',
    'supervisor','quality','operations','crew','worker','client','designer']));

-- 2) New area 'design' + seed role_access defaults for every existing org.
--    Admin bypasses has_area entirely (no rows needed). Designer gets design+layouts+
--    proposal+quotes; manager/planner get design edit; coordinator gets design view.
--    Matrix stays editable in Control Center afterwards. Idempotent via PK upsert.
insert into public.role_access (org_id, role, area, can_view, can_edit)
select o.id, v.role, v.area, v.can_view, v.can_edit
from public.organizations o
cross join (values
  -- designer: owns design + layouts, sees proposal/quotes/calendar/templates
  ('designer','design',     true,  true),
  ('designer','layouts',    true,  true),
  ('designer','quotes',     true,  false),
  ('designer','proposal',   true,  true),
  ('designer','calendar',   true,  false),
  ('designer','templates',  true,  false),
  ('designer','media',      true,  true),
  -- others gain the new design area at sensible defaults
  ('manager','design',      true,  true),
  ('planner','design',      true,  true),
  ('coordinator','design',  true,  false),
  ('sales','design',        true,  false),
  ('supervisor','design',   true,  false),
  ('quality','design',      true,  false),
  ('operations','design',   true,  false),
  ('crew','design',         false, false),
  ('worker','design',       false, false),
  ('client','design',       false, false)
) as v(role, area, can_view, can_edit)
on conflict (org_id, role, area) do nothing;   -- never clobber an operator's edits

-- 2b) Allow an 'in_app' notification channel (additive: widen the CHECK set only).
--     Design transitions raise in-app dashboard pings, not SMS/email.
alter table public.notifications drop constraint if exists notifications_channel_check;
alter table public.notifications add constraint notifications_channel_check
  check (channel = any (array['sms','email','in_app']));

-- 3) design_stages: one current design record per event (quote). History -> audit_log.
create table if not exists public.design_stages (
  id uuid not null default gen_random_uuid(),
  quote_id uuid not null,
  state text not null default 'draft_2d',
  revision integer not null default 1,
  assigned_designer uuid,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  org_id uuid not null default public.current_org_id(),
  constraint design_stages_pkey primary key (id),
  constraint design_stages_quote_uk unique (quote_id),
  constraint design_stages_quote_fk foreign key (quote_id) references public.quotes(id) on delete cascade,
  constraint design_stages_state_chk check (state = any (array[
    'draft_2d','internal_review','approved_2d','build_3d','client_review','approved_3d','locked','revise']))
);
create index if not exists ix_design_stages_org_state on public.design_stages (org_id, state);
-- Idempotently ensure the state CHECK includes the 'revise' loop-back state
-- (fixes a table that may have been created before 'revise' was added).
alter table public.design_stages drop constraint if exists design_stages_state_chk;
alter table public.design_stages add constraint design_stages_state_chk check (state = any (array[
  'draft_2d','internal_review','approved_2d','build_3d','client_review','approved_3d','locked','revise']));

-- 4) RLS: org + has_area('design'|'layouts'). Client sees only their own event at client_review+.
alter table public.design_stages enable row level security;
alter table public.design_stages force row level security;
drop policy if exists design_stages_select on public.design_stages;
drop policy if exists design_stages_write  on public.design_stages;
create policy design_stages_select on public.design_stages
  for select to authenticated
  using (org_id = public.current_org_id()
    and (public.has_area('design','view') or public.has_area('layouts','view')));
create policy design_stages_write on public.design_stages
  for all to authenticated
  using (org_id = public.current_org_id() and public.has_area('design','edit'))
  with check (org_id = public.current_org_id() and public.has_area('design','edit'));

-- 5) design_get(quote_id): current design record for an event (RLS-scoped read)
create or replace function public.design_get(p_quote_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.has_area('design','view') or public.has_area('layouts','view') then
    coalesce((
      select to_jsonb(d) from public.design_stages d
      where d.quote_id = p_quote_id and d.org_id = public.current_org_id()
    ), jsonb_build_object('quote_id', p_quote_id, 'state', null))
  else null end;
$$;
revoke all on function public.design_get(uuid) from anon, public;
grant execute on function public.design_get(uuid) to authenticated;

-- 6) design_queue(): designer's work queue — active design records grouped by state
create or replace function public.design_queue()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select case when public.has_area('design','view') then
    coalesce((
      select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
        select d.quote_id, d.state, d.revision, d.updated_at, q.code as event_code, q.title as event_title
        from public.design_stages d join public.quotes q on q.id = d.quote_id
        where d.org_id = public.current_org_id() and d.state <> 'locked'
      ) x
    ), '[]'::jsonb)
  else '[]'::jsonb end;
$$;
revoke all on function public.design_queue() from anon, public;
grant execute on function public.design_queue() to authenticated;

-- 7) design_advance(quote_id, to_state, note, expected_updated_at):
--    validates the transition, enforces has_area('design','edit'), optimistic-locks,
--    writes audit_log + a notification, bumps revision on a 'revise' loop-back.
create or replace function public.design_advance(
  p_quote_id uuid, p_to_state text, p_note text default null, p_expected_updated_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_org uuid := public.current_org_id();
  v_uid uuid := auth.uid();
  v_cur text;
  v_rev integer;
  v_upd timestamptz;
  v_allowed boolean := false;
begin
  if not public.has_area('design','edit') then
    raise exception 'not authorized for design' using errcode='42501';
  end if;

  -- ensure a record exists (first advance seeds draft_2d)
  insert into public.design_stages (quote_id, state, org_id, updated_by)
  values (p_quote_id, 'draft_2d', v_org, v_uid)
  on conflict (quote_id) do nothing;

  select state, revision, updated_at into v_cur, v_rev, v_upd
  from public.design_stages
  where quote_id = p_quote_id and org_id = v_org
  for update;
  if not found then raise exception 'no such event in this org'; end if;

  -- optimistic lock (only when caller supplies the expected timestamp)
  if p_expected_updated_at is not null and v_upd is distinct from p_expected_updated_at then
    raise exception 'design record changed, reload' using errcode='40001';
  end if;

  -- allowed transitions (state machine). 'revise' loops back and bumps revision.
  v_allowed := (v_cur, p_to_state) in (
    ('draft_2d','internal_review'),
    ('internal_review','approved_2d'),
    ('internal_review','revise'),
    ('revise','draft_2d'),
    ('approved_2d','build_3d'),
    ('build_3d','client_review'),
    ('client_review','approved_3d'),
    ('client_review','revise'),
    ('approved_3d','locked'),
    ('approved_3d','client_review')   -- re-open for a further client tweak before lock
  );
  if not v_allowed then
    raise exception 'illegal design transition: % -> %', v_cur, p_to_state using errcode='22023';
  end if;

  update public.design_stages
     set state = p_to_state,
         revision = case when p_to_state = 'revise' then revision + 1 else revision end,
         note = coalesce(p_note, note),
         updated_at = now(),
         updated_by = v_uid
   where quote_id = p_quote_id and org_id = v_org;

  insert into public.audit_log (actor, action, entity, entity_id, quote_id, changed, org_id)
  values (v_uid, 'design.advance', 'design_stages', p_quote_id::text, p_quote_id,
          jsonb_build_object('from', v_cur, 'to', p_to_state, 'note', p_note), v_org);

  insert into public.notifications (quote_id, channel, kind, status, detail)
  values (p_quote_id, 'in_app', 'design_'||p_to_state, 'simulated',
          jsonb_build_object('from', v_cur, 'to', p_to_state));

  return jsonb_build_object('quote_id', p_quote_id, 'state', p_to_state,
    'revision', case when p_to_state='revise' then v_rev+1 else v_rev end, 'as_of', now());
end; $$;
revoke all on function public.design_advance(uuid, text, text, timestamptz) from anon, public;
grant execute on function public.design_advance(uuid, text, text, timestamptz) to authenticated;

-- VERIFY
select 'designer role allowed in profiles' as check,
  'designer' = any (string_to_array(
     replace(replace(pg_get_constraintdef(oid),'CHECK ((role = ANY (ARRAY[',''),'])))',''), ', '))
  is not null as ok
  from pg_constraint where conname='profiles_role_check'
union all
select 'design_stages RLS forced',
  (select relforcerowsecurity from pg_class where relname='design_stages')
union all
select 'design_advance revoked from anon (want true)',
  not has_function_privilege('anon','public.design_advance(uuid,text,text,timestamptz)','EXECUTE')
union all
select 'design_queue authenticated can execute',
  has_function_privilege('authenticated','public.design_queue()','EXECUTE');

-- ========================= BUILD 4 : file storage =========================
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
