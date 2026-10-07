-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0038 crew evidence on the work link (one paste)                  (2026-10-07)
--   Crew rejecting a task can add a reason (≤ 1000 chars) and a voice note
--   (≤ 2 min); crew marking a task done can add up to 10 proof photos. Staff with
--   Staff view see them on Operations → Live status (signed links, 5 minutes).
--   Files go to a NEW private bucket 'task-proof' through one-time 15-minute
--   upload grants (30 per hour per crew link); a signed-out visitor can never
--   list, read, overwrite or delete a file.
-- REQUIRES 0037 (is_platform_operator) and the 0012 crew-link guard on this
--   database — the preflight stops if not. BOTH production and staging need this.
-- WHAT IT TOUCHES: adds tables task_evidence + task_evidence_grants (empty), the
--   'task-proof' bucket, two storage.objects policies, and new functions. Does
--   NOT replace worker_respond or any other existing function.
-- SAFE TO RE-RUN: idempotent; changes no existing rows, drops no table or column.
--   If anything fails, the whole run rolls back.
-- USE: SQL Editor → paste ALL → Run → the last table must show every row "ok".
-- ════════════════════════════════════════════════════════════════════════════
do $$
begin
  if to_regprocedure('public.current_org_id()') is null then raise exception 'STOP: not a Helm database'; end if;
  if to_regprocedure('public.is_platform_operator()') is null then raise exception 'STOP: 0037 not installed — run APPLY-0037 first'; end if;
  if to_regprocedure('public._work_token_live(uuid)') is null
     or to_regprocedure('public.worker_respond(uuid,uuid,text)') is null
    then raise exception 'STOP: crew-link guard (_work_token_live / worker_respond) missing'; end if;
  if to_regprocedure('public.has_area(text,text)') is null
    then raise exception 'STOP: has_area missing'; end if;
  if to_regclass('public.event_tasks') is null or to_regclass('public.work_tokens') is null
     or to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null
    then raise exception 'STOP: event_tasks / work_tokens / storage missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'work_tokens' and column_name = 'revoked_at')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'work_tokens' and column_name = 'expires_at')
    then raise exception 'STOP: work_tokens.expires_at / revoked_at missing (0012)'; end if;
  raise notice 'Preflight OK — applying 0038…';
end $$;

-- ---------------------------------------------------------------- tables -----
create table if not exists public.task_evidence (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  task_id       uuid not null references public.event_tasks(id) on delete cascade,
  kind          text not null,
  body          text,
  storage_path  text,
  mime          text,
  duration_s    integer,
  worker_name   text,
  worker_phone  text,
  created_at    timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_kind_chk' and conrelid = 'public.task_evidence'::regclass) then
    alter table public.task_evidence add constraint task_evidence_kind_chk
      check (kind in ('reject_reason','reject_voice','proof_photo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_shape_chk' and conrelid = 'public.task_evidence'::regclass) then
    alter table public.task_evidence add constraint task_evidence_shape_chk check (
      (kind = 'reject_reason' and body is not null and char_length(body) between 1 and 1000 and storage_path is null)
      or (kind in ('reject_voice','proof_photo') and body is null and storage_path is not null and mime is not null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_path_chk' and conrelid = 'public.task_evidence'::regclass) then
    alter table public.task_evidence add constraint task_evidence_path_chk check (storage_path is null or
      storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|webm|ogg|m4a)$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_duration_chk' and conrelid = 'public.task_evidence'::regclass) then
    alter table public.task_evidence add constraint task_evidence_duration_chk check (duration_s is null or duration_s between 0 and 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_worker_len_chk' and conrelid = 'public.task_evidence'::regclass) then
    alter table public.task_evidence add constraint task_evidence_worker_len_chk
      check (char_length(coalesce(worker_name, '')) <= 300 and char_length(coalesce(worker_phone, '')) <= 40);
  end if;
end $$;
create index if not exists task_evidence_task_idx on public.task_evidence (task_id, created_at);
create index if not exists task_evidence_org_idx on public.task_evidence (org_id);
create unique index if not exists task_evidence_path_uq on public.task_evidence (storage_path) where storage_path is not null;

create table if not exists public.task_evidence_grants (
  id          uuid primary key default gen_random_uuid(),
  work_token  uuid not null references public.work_tokens(token) on delete cascade,
  org_id      uuid not null references public.organizations(id),
  quote_id    uuid not null references public.quotes(id) on delete cascade,
  task_id     uuid not null references public.event_tasks(id) on delete cascade,
  kind        text not null,
  path        text not null,
  mime        text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '15 minutes'),
  used_at     timestamptz
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'task_evidence_grants_kind_chk' and conrelid = 'public.task_evidence_grants'::regclass) then
    alter table public.task_evidence_grants add constraint task_evidence_grants_kind_chk
      check (kind in ('reject_voice','proof_photo'));
  end if;
end $$;
create unique index if not exists task_evidence_grants_path_uq on public.task_evidence_grants (path);
create index if not exists task_evidence_grants_token_idx on public.task_evidence_grants (work_token, created_at);
create index if not exists task_evidence_grants_task_idx on public.task_evidence_grants (task_id);

-- tenant integrity (G4): quote_id + org_id must agree on both tables
-- prod drift: some databases never got 0004's shared helper. Create it (exact 0004
-- body) only when missing; never replaces an existing one.
do $guard$ begin
  if to_regproc('public.tg_quote_org_match') is null then
    execute $sql$
create function public.tg_quote_org_match() returns trigger
  language plpgsql security definer set search_path = public as $fn$
declare v_org uuid;
begin
  if new.quote_id is null then return new; end if;
  select org_id into v_org from public.quotes where id = new.quote_id;
  if v_org is not null and new.org_id is distinct from v_org then
    raise exception 'quote % belongs to another studio (row org % <> quote org %)',
      new.quote_id, new.org_id, v_org using errcode = '42501';
  end if;
  return new;
end $fn$;
$sql$;
    execute 'revoke all on function public.tg_quote_org_match() from public';
  end if;
end $guard$;
do $$ begin
  if to_regprocedure('public.tg_quote_org_match()') is not null then
    execute 'drop trigger if exists zz_quote_org_match on public.task_evidence';
    execute 'create trigger zz_quote_org_match before insert or update on public.task_evidence for each row execute function public.tg_quote_org_match()';
    execute 'drop trigger if exists zz_quote_org_match on public.task_evidence_grants';
    execute 'create trigger zz_quote_org_match before insert or update on public.task_evidence_grants for each row execute function public.tg_quote_org_match()';
  end if;
end $$;

-- RLS: staff of the owning studio with Staff VIEW may read evidence; nobody writes
-- through the API (only the SECURITY DEFINER worker RPCs below). Grants are
-- internal (no policy at all).
alter table public.task_evidence        enable row level security;
alter table public.task_evidence_grants enable row level security;
revoke all on table public.task_evidence        from public;
revoke all on table public.task_evidence_grants from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on table public.task_evidence from anon';
    execute 'revoke all on table public.task_evidence_grants from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on table public.task_evidence from authenticated';
    execute 'revoke all on table public.task_evidence_grants from authenticated';
    execute 'grant select on table public.task_evidence to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on table public.task_evidence, public.task_evidence_grants to service_role';
  end if;
end $$;
drop policy if exists task_evidence_staff_read on public.task_evidence;
create policy task_evidence_staff_read on public.task_evidence for select to authenticated
  using (public.has_area('staff', 'view') and org_id = (select public.current_org_id()));

-- ---------------------------------------------------------------- helpers ----
create or replace function public.task_evidence_ext(p_mime text)
returns text language sql immutable set search_path = '' as $$
  select case lower(coalesce(p_mime, ''))
    when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp'
    when 'audio/webm' then 'webm' when 'audio/ogg' then 'ogg' when 'audio/mp4' then 'm4a'
    else null end;
$$;
revoke all on function public.task_evidence_ext(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.task_evidence_ext(text) from anon'; end if;
end $$;

-- storage INSERT gate (anon + signed-in): an exact key with a live, unused,
-- unexpired grant on a live link, never written before.
create or replace function public.task_proof_upload_ok(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_name, '') ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|webm|ogg|m4a)$'
     and exists (select 1 from public.task_evidence_grants g
                   join public.work_tokens w on w.token = g.work_token
                  where g.path = p_name and g.used_at is null and g.expires_at > now()
                    and w.revoked_at is null and (w.expires_at is null or w.expires_at > now()))
     and not exists (select 1 from storage.objects o where o.bucket_id = 'task-proof' and o.name = p_name);
$$;
revoke all on function public.task_proof_upload_ok(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.task_proof_upload_ok(text) to anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.task_proof_upload_ok(text) to authenticated'; end if;
end $$;

-- storage SELECT gate (signed-in staff only): same studio, Staff VIEW, and an
-- evidence row points at the object.
create or replace function public.task_proof_visible(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_area('staff', 'view')
     and exists (select 1 from public.task_evidence e
                  where e.storage_path = p_name and e.org_id = public.current_org_id());
$$;
revoke all on function public.task_proof_visible(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.task_proof_visible(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.task_proof_visible(text) to authenticated'; end if;
end $$;

-- ---------------------------------------------------------------- RPCs -------
-- 1) one-time upload grant for a voice note (reject) or a proof photo (done)
create or replace function public.worker_evidence_upload(p_token uuid, p_task_id uuid, p_kind text, p_mime text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  w public.work_tokens; t public.event_tasks; v_ext text; v_mime text := lower(btrim(coalesce(p_mime, '')));
  v_path text; v_exp timestamptz; n int;
begin
  w := public._work_token_live(p_token);
  select * into t from public.event_tasks
   where id = p_task_id and quote_id = w.quote_id and assignee_phone = w.phone;
  if t.id is null then raise exception 'task not found' using errcode = '42501'; end if;
  if p_kind = 'reject_voice' then
    if v_mime not in ('audio/webm', 'audio/ogg', 'audio/mp4') then raise exception 'voice notes must be audio (webm, ogg or mp4)' using errcode = '22023'; end if;
    if t.status not in ('assigned', 'accepted', 'in_progress') then raise exception 'this task can''t be rejected now' using errcode = '22023'; end if;
  elsif p_kind = 'proof_photo' then
    if v_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'photos must be JPEG, PNG or WebP' using errcode = '22023'; end if;
    if t.status not in ('accepted', 'in_progress') then raise exception 'start the task first' using errcode = '22023'; end if;
  else
    raise exception 'invalid evidence kind' using errcode = '22023';
  end if;
  v_ext := public.task_evidence_ext(v_mime);
  -- 30 grants per hour per link, serialized per link so parallel calls can't overshoot
  perform pg_advisory_xact_lock(hashtextextended('helm:task-evidence:' || p_token::text, 0));
  select count(*) into n from public.task_evidence_grants g
   where g.work_token = p_token and g.created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'too many uploads from this link — try again in an hour' using errcode = 'P0001'; end if;
  v_path := t.org_id::text || '/' || t.quote_id::text || '/' || t.id::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  v_exp := now() + interval '15 minutes';
  insert into public.task_evidence_grants (work_token, org_id, quote_id, task_id, kind, path, mime, expires_at)
    values (p_token, t.org_id, t.quote_id, t.id, p_kind, v_path, v_mime, v_exp);
  return jsonb_build_object('bucket', 'task-proof', 'path', v_path, 'mime', v_mime, 'expires_at', v_exp);
end $$;

-- 2) reject / complete WITH evidence, atomically
create or replace function public.worker_respond_evidence(
  p_token uuid, p_task_id uuid, p_action text,
  p_reason text default null, p_voice_path text default null, p_voice_seconds integer default null,
  p_photo_paths text[] default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  w public.work_tokens; t public.event_tasks; g public.task_evidence_grants;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_photos text[] := coalesce(p_photo_paths, array[]::text[]);
  v_paths text[] := array[]::text[]; v_kinds text[] := array[]::text[];
  v_res jsonb; v_n int := 0; i int; v_secs int;
begin
  w := public._work_token_live(p_token);
  select * into t from public.event_tasks
   where id = p_task_id and quote_id = w.quote_id and assignee_phone = w.phone
   for update;
  if t.id is null then raise exception 'task not found' using errcode = '42501'; end if;

  if p_action = 'reject' then
    if cardinality(v_photos) > 0 then raise exception 'photos go with a completed task' using errcode = '22023'; end if;
    if v_reason is not null and char_length(v_reason) > 1000 then raise exception 'reason is too long (max 1000 characters)' using errcode = '22023'; end if;
    if t.status not in ('assigned', 'accepted', 'in_progress') then raise exception 'this task can''t be rejected now' using errcode = '22023'; end if;
    if p_voice_path is not null then v_paths := array[p_voice_path]; v_kinds := array['reject_voice']; end if;
  elsif p_action = 'complete' then
    if v_reason is not null or p_voice_path is not null then raise exception 'a reason or voice note goes with a rejection' using errcode = '22023'; end if;
    if cardinality(v_photos) > 10 then raise exception 'at most 10 photos' using errcode = '22023'; end if;
    if (select count(distinct x) from unnest(v_photos) x) <> cardinality(v_photos) then raise exception 'duplicate photo' using errcode = '22023'; end if;
    v_paths := v_photos; v_kinds := array_fill('proof_photo'::text, array[cardinality(v_photos)]);
  else
    raise exception 'invalid action' using errcode = '22023';
  end if;
  v_secs := case when p_voice_path is null then null else least(greatest(coalesce(p_voice_seconds, 0), 0), 120) end;

  -- every key must be an unused grant issued to THIS link for THIS task and kind,
  -- and its upload window must have closed no more than 15 minutes ago
  for i in 1 .. coalesce(cardinality(v_paths), 0) loop
    select * into g from public.task_evidence_grants
     where path = v_paths[i] and work_token = p_token and task_id = t.id and kind = v_kinds[i]
       and used_at is null and expires_at > now() - interval '15 minutes'
     for update;
    if g.id is null then raise exception 'upload not found or expired — please attach it again' using errcode = '42501'; end if;
  end loop;

  -- the status change itself: the DB's own worker_respond (unchanged by 0038)
  v_res := public.worker_respond(p_token, p_task_id, p_action);

  if p_action = 'reject' and v_reason is not null then
    insert into public.task_evidence (org_id, quote_id, task_id, kind, body, worker_name, worker_phone)
      values (t.org_id, t.quote_id, t.id, 'reject_reason', v_reason, left(w.name, 300), left(w.phone, 40));
    v_n := v_n + 1;
  end if;
  for i in 1 .. coalesce(cardinality(v_paths), 0) loop
    select * into g from public.task_evidence_grants where path = v_paths[i];
    insert into public.task_evidence (org_id, quote_id, task_id, kind, storage_path, mime, duration_s, worker_name, worker_phone)
      values (t.org_id, t.quote_id, t.id, v_kinds[i], g.path, g.mime,
              case when v_kinds[i] = 'reject_voice' then v_secs else null end, left(w.name, 300), left(w.phone, 40));
    update public.task_evidence_grants set used_at = now() where id = g.id;
    v_n := v_n + 1;
  end loop;
  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('evidence', v_n);
end $$;

revoke all on function public.worker_evidence_upload(uuid, uuid, text, text) from public;
revoke all on function public.worker_respond_evidence(uuid, uuid, text, text, text, integer, text[]) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.worker_evidence_upload(uuid, uuid, text, text) to anon';
    execute 'grant execute on function public.worker_respond_evidence(uuid, uuid, text, text, text, integer, text[]) to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.worker_evidence_upload(uuid, uuid, text, text) to authenticated';
    execute 'grant execute on function public.worker_respond_evidence(uuid, uuid, text, text, text, integer, text[]) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------- storage ----
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('task-proof', 'task-proof', false, 8388608,
        array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4'];

drop policy if exists task_proof_link_upload on storage.objects;
create policy task_proof_link_upload on storage.objects for insert to anon, authenticated
  with check ( bucket_id = 'task-proof' and public.task_proof_upload_ok(name) );
drop policy if exists task_proof_staff_read on storage.objects;
create policy task_proof_staff_read on storage.objects for select to authenticated
  using ( bucket_id = 'task-proof' and public.task_proof_visible(name) );


-- ═══════════════════════════════ VERIFY ═══════════════════════════════════════
select item, case when ok then 'ok' else 'FAIL' end as status from (values
  ('task-proof bucket: private, 8 MB cap, images + voice notes only',
     exists (select 1 from storage.buckets where id = 'task-proof' and public = false and file_size_limit = 8388608
               and allowed_mime_types @> array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4']
               and cardinality(allowed_mime_types) = 6)),
  ('storage: link upload only through a grant; staff-only read; no anon read/update/delete',
     exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'task_proof_link_upload' and cmd = 'INSERT')
     and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'task_proof_staff_read' and cmd = 'SELECT'
                   and roles = array['authenticated']::name[])
     and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                       and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%task-proof%'
                       and cmd in ('SELECT','UPDATE','DELETE','ALL') and roles && array['anon','public']::name[])),
  ('task_evidence: RLS on, staff read own studio, no direct writes, no anon',
     (select relrowsecurity from pg_class where oid = 'public.task_evidence'::regclass)
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_evidence' and policyname = 'task_evidence_staff_read')
     and has_table_privilege('authenticated', 'public.task_evidence', 'SELECT')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'INSERT')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'UPDATE')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'DELETE')
     and not has_table_privilege('anon', 'public.task_evidence', 'SELECT')),
  ('task_evidence_grants: internal (RLS on, no API access)',
     (select relrowsecurity from pg_class where oid = 'public.task_evidence_grants'::regclass)
     and not has_table_privilege('anon', 'public.task_evidence_grants', 'SELECT')
     and not has_table_privilege('authenticated', 'public.task_evidence_grants', 'SELECT')),
  ('crew-link RPCs callable signed out; staff read gate is not',
     has_function_privilege('anon', 'public.worker_evidence_upload(uuid,uuid,text,text)', 'EXECUTE')
     and has_function_privilege('anon', 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])', 'EXECUTE')
     and has_function_privilege('anon', 'public.task_proof_upload_ok(text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.task_proof_visible(text)', 'EXECUTE')
     and (select prosecdef from pg_proc where oid = 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'::regprocedure)
     and pg_get_functiondef('public.worker_evidence_upload(uuid,uuid,text,text)'::regprocedure) like '%_work_token_live%'
     and pg_get_functiondef('public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'::regprocedure) like '%_work_token_live%'),
  ('tenant guard (quote/studio must agree) on both new tables',
     (select count(*) from pg_trigger where tgname = 'zz_quote_org_match'
        and tgrelid in ('public.task_evidence'::regclass, 'public.task_evidence_grants'::regclass)) = 2),
  ('existing crew-link RPCs still callable signed out',
     has_function_privilege('anon', 'public.worker_respond(uuid,uuid,text)', 'EXECUTE')
     and has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'EXECUTE'))
) v(item, ok);
