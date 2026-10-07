-- ════════════════════════════════════════════════════════════════════════════
-- HELM — EVERYTHING PENDING (one paste) — Supabase SQL Editor           (v11, 2026-10-07)
--   0038 crew work link: reject reason, voice note, proof photos (private bucket)
--   0039 optional client-link auto-expire (Control Center; OFF by default)
--   0040 link-expiry archive / soft-delete of quotes (Archive + Deleted tabs)
-- REQUIRES 0037 on this database (each part's preflight stops if something is missing).
-- SAFE TO RE-RUN: idempotent; changes no existing rows, drops no table or column.
--   If anything fails, the whole run rolls back.
-- USE: SQL Editor → paste ALL → Run → the last table must show every row "ok"
--   (27 rows: 7 for 0038, 11 for 0039, 9 for 0040).
-- ════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════ PART 0038 ═══════════════════════════════
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

-- ═══════════════════════════════ PART 0039 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0039 optional client-link auto-expire (one paste)                  (2026-10-07)
--   A studio admin can switch on, in Control Center, "client links stop working N
--   days after they were sent" (calendar days, weekends included; N = 1–365, default
--   10). It is OFF for every studio after this paste — nothing changes until an
--   admin switches it on. When on, it covers the approval link (+ portal, OTP,
--   payment and the Razorpay link it opens), the proposal link, crew task links and
--   invitation websites; a link stops at the EARLIER of this and today's event-based
--   limit (never later). Computed when a link is opened — no link is rewritten.
-- REQUIRES 0037 (is_platform_operator) and the 0012/0022 link guards on this
--   database — the preflight stops if not. Does NOT need 0038 (either order works).
--   BOTH production and staging need this.
-- WHAT IT TOUCHES: adds tables org_link_autoexpire (empty) + client_link_issued
--   (filled once with the issue time of links already out there: approval tokens from
--   the audit log, else the quote's creation time; proposals from their last save),
--   one AFTER trigger on quotes + one on event_proposal (they only write to
--   client_link_issued), and wraps 12 functions: each keeps THIS database's own body
--   under the name <fn>__pre0039 (API roles can't call it) behind a thin age check.
--   No column added to an existing table; no existing row changed or deleted.
-- SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ declare f text; begin
  if to_regprocedure('public.is_platform_operator()') is null then raise exception 'STOP: 0037 not installed'; end if;
  if to_regprocedure('public.client_link_deadline(date, uuid, integer)') is null
     or to_regprocedure('public.public_get_proposal__base(uuid)') is null
     or to_regprocedure('public.public_event_site__base(text)') is null then raise exception 'STOP: 0022 (client link windows) not installed'; end if;
  if to_regclass('public.audit_log') is null or to_regclass('public.event_tasks') is null
     or to_regprocedure('public.is_admin()') is null or to_regprocedure('public.current_org_id()') is null then
    raise exception 'STOP: base schema objects missing'; end if;
  foreach f in array array['public_get_quote(uuid)', 'public_get_portal(uuid)', 'create_payment(uuid)', 'request_otp(uuid, text)',
      'verify_and_consent(uuid, text, text, boolean, text, text, text, text)', 'payment_link_begin(uuid, integer)',
      'otp_send_authorize(uuid, text)', 'generate_approval_token(uuid)', 'public_get_proposal(uuid)',
      'publish_proposal(uuid, boolean)', '_work_token_live(uuid)', 'event_site_live_until(uuid)'] loop
    if to_regprocedure('public.' || f) is null then raise exception 'STOP: public.% is missing on this database', f; end if;
  end loop;
  raise notice 'Preflight OK — applying 0039…';
end $$;

-- ---- 1) the setting (one row per studio; no row = OFF) ----------------------
create table if not exists public.org_link_autoexpire (
  org_id     uuid primary key references public.organizations(id),
  enabled    boolean not null default false,
  days       int not null default 10,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint org_link_autoexpire_days_chk check (days between 1 and 365)
);
alter table public.org_link_autoexpire enable row level security;
revoke all on public.org_link_autoexpire from public, anon, authenticated;   -- RPCs only
grant select on public.org_link_autoexpire to service_role;

-- ---- 2) when each token was issued -------------------------------------------
create table if not exists public.client_link_issued (
  kind      text not null,                     -- 'quote' (approval/portal/payment) | 'proposal'
  token     uuid not null,
  quote_id  uuid,                               -- for tracing only (the quote's own org is read live)
  issued_at timestamptz not null default now(),
  source    text not null default 'trigger',   -- trigger | audit_log | quote_created | proposal_saved
  primary key (kind, token),
  constraint client_link_issued_kind_chk check (kind in ('quote', 'proposal'))
);
alter table public.client_link_issued enable row level security;
revoke all on public.client_link_issued from public, anon, authenticated;     -- internal only
grant select on public.client_link_issued to service_role;

create or replace function public.tg_client_link_issued()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'quotes' then
    if new.approval_token is not null and (tg_op = 'INSERT' or new.approval_token is distinct from old.approval_token) then
      insert into public.client_link_issued(kind, token, quote_id)
        values ('quote', new.approval_token, new.id) on conflict do nothing;
    end if;
  elsif tg_table_name = 'event_proposal' then
    if new.share_token is not null and (tg_op = 'INSERT' or new.share_token is distinct from old.share_token) then
      insert into public.client_link_issued(kind, token, quote_id)
        values ('proposal', new.share_token, new.quote_id) on conflict do nothing;
    end if;
  end if;
  return null;
end $$;
revoke all on function public.tg_client_link_issued() from public, anon, authenticated;
drop trigger if exists zz_client_link_issued on public.quotes;
create trigger zz_client_link_issued after insert or update of approval_token on public.quotes
  for each row execute function public.tg_client_link_issued();
drop trigger if exists zz_client_link_issued on public.event_proposal;
create trigger zz_client_link_issued after insert or update of share_token on public.event_proposal
  for each row execute function public.tg_client_link_issued();

-- links already out there (only fills the NEW table; re-runs add nothing twice)
insert into public.client_link_issued(kind, token, quote_id, issued_at, source)
select 'quote', q.approval_token, q.id,
       coalesce(ev.at, q.created_at), case when ev.at is null then 'quote_created' else 'audit_log' end
  from public.quotes q
  left join lateral (
    select max(a.at) as at from public.audit_log a
     where a.quote_id = q.id and a.entity = 'quotes'
       and ((a.action = 'update' and a.changed -> 'approval_token' ->> 1 = q.approval_token::text)
         or (a.action = 'insert' and a.changed ->> 'approval_token' = q.approval_token::text))
  ) ev on true
 where q.approval_token is not null
on conflict do nothing;
insert into public.client_link_issued(kind, token, quote_id, issued_at, source)
select 'proposal', pr.share_token, pr.quote_id, pr.updated_at, 'proposal_saved'
  from public.event_proposal pr
 where pr.share_token is not null
on conflict do nothing;

-- ---- 3) the rule ---------------------------------------------------------------
-- N when the studio switched it on, else NULL (= no age limit)
create or replace function public.link_autoexpire_days(p_org uuid)
returns int language sql stable security definer set search_path = '' as $$
  select s.days from public.org_link_autoexpire s
   where s.org_id = p_org and s.enabled and s.days between 1 and 365;
$$;
-- the moment a link sent at p_sent stops working because of its age; NULL = never
create or replace function public.link_autoexpire_at(p_org uuid, p_sent timestamptz)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select p_sent + make_interval(days => public.link_autoexpire_days(p_org));
$$;

create or replace function public.approval_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(q.org_id, coalesce(i.issued_at, q.created_at))
    from public.quotes q
    left join public.client_link_issued i on i.kind = 'quote' and i.token = q.approval_token
   where q.approval_token = p_token;
$$;
create or replace function public.proposal_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(q.org_id, coalesce(i.issued_at, q.created_at))
    from public.event_proposal pr
    join public.quotes q on q.id = pr.quote_id
    left join public.client_link_issued i on i.kind = 'proposal' and i.token = pr.share_token
   where pr.share_token = p_token;
$$;
-- crew: last time the link went out = created, or a task newly assigned to that person
create or replace function public.work_link_age_until(p_token uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select public.link_autoexpire_at(w.org_id,
           greatest(w.created_at,
                    (select max(t.created_at) from public.event_tasks t
                      where t.quote_id = w.quote_id and t.assignee_phone = w.phone)))
    from public.work_tokens w where w.token = p_token;
$$;
create or replace function public.link_age_expired(p_until timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_until is not null and now() >= p_until;
$$;
do $$ begin
  execute 'revoke all on function public.link_autoexpire_days(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.link_autoexpire_at(uuid, timestamptz) from public, anon, authenticated';
  execute 'revoke all on function public.approval_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.proposal_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.work_link_age_until(uuid) from public, anon, authenticated';
  execute 'revoke all on function public.link_age_expired(timestamptz) from public, anon, authenticated';
end $$;

-- ---- 4) wrap the entry points (keep each project's own body) -------------------
do $$ declare f text[]; begin
  foreach f slice 1 in array array[
    ['public_get_quote',        'uuid'],
    ['public_get_portal',       'uuid'],
    ['create_payment',          'uuid'],
    ['request_otp',             'uuid, text'],
    ['verify_and_consent',      'uuid, text, text, boolean, text, text, text, text'],
    ['payment_link_begin',      'uuid, integer'],
    ['otp_send_authorize',      'uuid, text'],
    ['generate_approval_token', 'uuid'],
    ['public_get_proposal',     'uuid'],
    ['publish_proposal',        'uuid, boolean'],
    ['_work_token_live',        'uuid'],
    ['event_site_live_until',   'uuid']
  ] loop
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0039', f[2])) is null
       and to_regprocedure(format('public.%s(%s)', f[1], f[2])) is not null then
      execute format('alter function public.%I(%s) rename to %I', f[1], f[2], f[1] || '__pre0039');
    end if;
    if to_regprocedure(format('public.%s(%s)', f[1] || '__pre0039', f[2])) is not null then
      execute format('revoke all on function public.%I(%s) from public, anon, authenticated', f[1] || '__pre0039', f[2]);
    end if;
  end loop;
end $$;

-- approval token: read the quote / portal ------------------------------------
create or replace function public.public_get_quote(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_quote__pre0039(p_token);
end $$;

create or replace function public.public_get_portal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_portal__pre0039(p_token);
end $$;

-- approval token: approve (OTP + consent) and pay ------------------------------
create or replace function public.request_otp(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
-- 0039 age gate. The code is still generated further down (request_otp__base,
-- secure: extensions.gen_random_bytes, see 0026).
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.request_otp__pre0039(p_token, p_phone);
end $$;

create or replace function public.verify_and_consent(p_token uuid, p_phone text, p_code text, p_agreed boolean,
                                                     p_terms_version text, p_consent_text text,
                                                     p_client_name text, p_user_agent text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.verify_and_consent__pre0039(p_token, p_phone, p_code, p_agreed, p_terms_version,
                                            p_consent_text, p_client_name, p_user_agent);
end $$;

create or replace function public.create_payment(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.create_payment__pre0039(p_token);
end $$;

-- Edge Function (service role) entry points: same answers they give for an expired link
create or replace function public.otp_send_authorize(p_token uuid, p_phone text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.approval_link_age_until(p_token)) then
    raise exception 'invalid link' using errcode = 'HL404';
  end if;
  return public.otp_send_authorize__pre0039(p_token, p_phone);
end $$;

create or replace function public.payment_link_begin(p_token uuid, p_ttl_minutes integer default 4320)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_until timestamptz := public.approval_link_age_until(p_token); v_out jsonb; v_exp timestamptz;
begin
  if public.link_age_expired(v_until) then return jsonb_build_object('action', 'invalid'); end if;
  v_out := public.payment_link_begin__pre0039(p_token, p_ttl_minutes);
  -- the Razorpay link it is about to open never outlives the approval link
  -- (Razorpay needs >= 15 minutes, so never less than 20, as the original does)
  if v_until is not null and v_out ->> 'action' = 'create'
     and to_timestamp((v_out ->> 'expire_by')::double precision) > v_until then
    v_exp := greatest(v_until, now() + interval '20 minutes');
    update public.quote_payments set link_expires_at = v_exp
     where id = (v_out ->> 'payment_id')::uuid and status = 'created';
    v_out := v_out || jsonb_build_object('expire_by', floor(extract(epoch from v_exp))::bigint);
  end if;
  return v_out;
end $$;

-- studio side: sending the approval link again after it aged out gives a NEW link
create or replace function public.generate_approval_token(p_quote_id uuid)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare tok uuid; v_new uuid;
begin
  tok := public.generate_approval_token__pre0039(p_quote_id);    -- every permission check, as before
  if tok is not null and public.link_age_expired(public.approval_link_age_until(tok)) then
    update public.quotes q set approval_token = gen_random_uuid(), updated_at = now()
     where q.id = p_quote_id and q.org_id = public.current_org_id() and q.approval_token = tok
       and q.approval_token_revoked_at is null
       and (q.approval_token_expires_at is null or q.approval_token_expires_at > now())
    returning q.approval_token into v_new;
    tok := coalesce(v_new, tok);
  end if;
  return tok;
end $$;

-- proposal link -----------------------------------------------------------------
create or replace function public.public_get_proposal(p_token uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
begin
  if public.link_age_expired(public.proposal_link_age_until(p_token)) then
    raise exception 'this link has expired' using errcode = 'P0001';
  end if;
  return public.public_get_proposal__pre0039(p_token);
end $$;

create or replace function public.publish_proposal(p_quote_id uuid, p_published boolean)
returns uuid language plpgsql volatile security definer set search_path = '' as $$
declare tok uuid; v_new uuid;
begin
  tok := public.publish_proposal__pre0039(p_quote_id, p_published);   -- every permission check, as before
  if coalesce(p_published, false) and tok is not null
     and public.link_age_expired(public.proposal_link_age_until(tok)) then
    update public.event_proposal pr set share_token = gen_random_uuid(), updated_at = now()
     where pr.quote_id = p_quote_id and pr.org_id = public.current_org_id() and pr.share_token = tok
    returning pr.share_token into v_new;
    tok := coalesce(v_new, tok);
  end if;
  return tok;
end $$;

-- crew task link: every worker_* RPC resolves its token through _work_token_live ------
create or replace function public._work_token_live(p_token uuid)
returns public.work_tokens language plpgsql volatile security definer set search_path = '' as $$
declare w public.work_tokens;
begin
  w := public._work_token_live__pre0039(p_token);                 -- invalid / revoked / expired, as before
  if public.link_age_expired(public.work_link_age_until(w.token)) then
    raise exception 'link expired' using errcode = '42501';
  end if;
  return w;
end $$;

-- invitation website (+ photos via invite_media_on_published_site, + the studio's
-- "live until" line): the earlier of the event window and the age limit
create or replace function public.event_site_live_until(p_site_id uuid)
returns timestamptz language sql stable security definer set search_path = '' as $$
  select least(public.event_site_live_until__pre0039(s.id),
               public.link_autoexpire_at(s.org_id, coalesce(s.published_at, s.created_at)))
    from public.event_sites s where s.id = p_site_id;
$$;

-- grants: exactly what each entry point had before ---------------------------------
do $$ declare f text; begin
  foreach f in array array['public_get_quote(uuid)', 'public_get_portal(uuid)', 'create_payment(uuid)',
      'request_otp(uuid, text)', 'verify_and_consent(uuid, text, text, boolean, text, text, text, text)',
      'public_get_proposal(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public';
    execute 'grant execute on function public.' || f || ' to anon, authenticated, service_role';
  end loop;
  foreach f in array array['generate_approval_token(uuid)', 'publish_proposal(uuid, boolean)',
      'event_site_live_until(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated, service_role';
  end loop;
  foreach f in array array['payment_link_begin(uuid, integer)', 'otp_send_authorize(uuid, text)',
      '_work_token_live(uuid)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
end $$;

-- ---- 5) admin RPCs (Control Center) --------------------------------------------
create or replace function public.admin_get_link_autoexpire()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.org_link_autoexpire; v_tz text;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into s from public.org_link_autoexpire x where x.org_id = v_org;
  select nullif(btrim(o.timezone), '') into v_tz from public.organizations o where o.id = v_org;
  return jsonb_build_object('enabled', coalesce(s.enabled, false), 'days', coalesce(s.days, 10),
    'min_days', 1, 'max_days', 365, 'updated_at', s.updated_at,
    'timezone', coalesce(v_tz, 'Asia/Kolkata'), 'now', now());
end $$;

create or replace function public.admin_set_link_autoexpire(p_enabled boolean, p_days int)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id();
        v_old_on boolean; v_old_days int; v_days int; v_email text; v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_enabled is null then raise exception 'choose on or off' using errcode = '22023'; end if;
  select x.enabled, x.days into v_old_on, v_old_days
    from public.org_link_autoexpire x where x.org_id = v_org for update;
  v_days := coalesce(p_days, v_old_days, 10);
  if v_days < 1 or v_days > 365 then
    raise exception 'choose between 1 and 365 days' using errcode = '22023';
  end if;
  insert into public.org_link_autoexpire(org_id, enabled, days, updated_by, updated_at)
    values (v_org, p_enabled, v_days, v_me, now())
  on conflict (org_id) do update
    set enabled = excluded.enabled, days = excluded.days, updated_by = excluded.updated_by, updated_at = now();
  if v_old_on is distinct from p_enabled or v_old_days is distinct from v_days then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'link_autoexpire.set', 'organizations', v_org::text, v_org,
              jsonb_build_object('enabled', jsonb_build_object('old', coalesce(v_old_on, false), 'new', p_enabled),
                                 'days',    jsonb_build_object('old', coalesce(v_old_days, 10), 'new', v_days)));
  end if;
  return public.admin_get_link_autoexpire();
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_get_link_autoexpire()', 'admin_set_link_autoexpire(boolean, integer)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- ═══════════════════════════════ VERIFY ═══════════════════════════════════════

-- ═══════════════════════════════ PART 0040 ═══════════════════════════════
-- ════════════════════════════════════════════════════════════════════════════
-- HELM — 0040 client link expired → Archive / Deleted quotes (one paste)    (2026-10-07)
--   Adds, under 0039's "auto-expire client links" switch in Control Center, a studio
--   ADMIN choice: when a quote's client link expires and the quote was never confirmed,
--   approved or paid → Keep it (default) | Move to Archive | Move to Deleted quotes.
--   It is KEEP for every studio after this paste — nothing moves until an admin
--   chooses otherwise (and only while 0039 auto-expire is ON).
--   Archive / Deleted are SOFT flags on the quote (archived_at / deleted_at): nothing
--   is ever erased, the Quotes page gets Archive + Deleted tabs with Restore, and the
--   existing delete guard (0026) is untouched. Quotes with a payment, client approval
--   or refund on record never move.
--   It runs when someone opens Quotes or the Dashboard (at most once per 10 minutes
--   per studio); if pg_cron is ALREADY installed a 30-minute job is added too (the
--   extension is never created). Every moved quote gets an audit_log row.
-- REQUIRES 0039 (link auto-expire) on this database — the preflight stops if not.
--   BOTH production and staging need this (after 0039).
-- WHAT IT TOUCHES: adds 8 nullable columns to quotes (all NULL = unchanged), 3 CHECK
--   constraints that only constrain those new columns, 1 partial index, 1 BEFORE
--   trigger on quotes (stops the app's API roles writing the new columns directly),
--   1 new settings table (org_link_expiry_shelf, empty), new functions only.
--   No existing function replaced; no existing row changed or deleted.
-- SAFE TO RE-RUN. If anything fails, the whole paste rolls back.
-- ════════════════════════════════════════════════════════════════════════════
do $$ declare f text; begin
  if to_regclass('public.org_link_autoexpire') is null or to_regclass('public.client_link_issued') is null
     or to_regprocedure('public.link_autoexpire_days(uuid)') is null
     or to_regprocedure('public.admin_set_link_autoexpire(boolean, integer)') is null then
    raise exception 'STOP: 0039 (link auto-expire) not installed — paste APPLY-0039.sql first'; end if;
  foreach f in array array['public.quotes', 'public.audit_log', 'public.event_proposal', 'public.quote_payments',
      'public.payment_milestones', 'public.quote_consents', 'public.event_refunds', 'public.organizations'] loop
    if to_regclass(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  foreach f in array array['public.current_org_id()', 'public.has_area(text, text)', 'public.is_admin()'] loop
    if to_regprocedure(f) is null then raise exception 'STOP: % is missing on this database', f; end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'aa_quote_delete_guard' and tgrelid = 'public.quotes'::regclass) then
    raise exception 'STOP: the 0026 quote delete guard is missing on this database'; end if;
  raise notice 'Preflight OK — applying 0040…';
end $$;

-- ---- 1) soft flags on quotes (NULL = in the normal lists) --------------------
alter table public.quotes add column if not exists archived_at       timestamptz;
alter table public.quotes add column if not exists archived_by       uuid;
alter table public.quotes add column if not exists archived_reason   text;
alter table public.quotes add column if not exists deleted_at        timestamptz;
alter table public.quotes add column if not exists deleted_by        uuid;
alter table public.quotes add column if not exists deleted_reason    text;
alter table public.quotes add column if not exists link_expired_at   timestamptz;  -- set when moved because the link expired
alter table public.quotes add column if not exists shelf_restored_at timestamptz;  -- last Restore from Archive/Deleted

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quotes_archived_reason_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_archived_reason_chk
      check (archived_reason is null or archived_reason in ('manual', 'link_expired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_deleted_reason_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_deleted_reason_chk
      check (deleted_reason is null or deleted_reason in ('manual', 'link_expired'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quotes_shelf_one_chk' and conrelid = 'public.quotes'::regclass) then
    alter table public.quotes add constraint quotes_shelf_one_chk
      check (archived_at is null or deleted_at is null);
  end if;
end $$;
create index if not exists quotes_shelf_idx on public.quotes (org_id)
  where archived_at is not null or deleted_at is not null;

-- the API roles can read these columns (normal quote RLS) but never write them:
-- only the SECURITY DEFINER functions below change them
create or replace function public.quotes_shelf_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.archived_at is not null or new.archived_by is not null or new.archived_reason is not null
         or new.deleted_at is not null or new.deleted_by is not null or new.deleted_reason is not null
         or new.link_expired_at is not null or new.shelf_restored_at is not null then
        raise exception 'a new quote can''t start archived or deleted' using errcode = '42501';
      end if;
    elsif (new.archived_at, new.archived_by, new.archived_reason, new.deleted_at, new.deleted_by,
           new.deleted_reason, new.link_expired_at, new.shelf_restored_at)
          is distinct from
          (old.archived_at, old.archived_by, old.archived_reason, old.deleted_at, old.deleted_by,
           old.deleted_reason, old.link_expired_at, old.shelf_restored_at) then
      raise exception 'archive and deleted change only through Archive / Delete / Restore in the app'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.quotes_shelf_guard() from public, anon, authenticated;
drop trigger if exists quotes_shelf_guard_biu on public.quotes;
create trigger quotes_shelf_guard_biu before insert or update on public.quotes
  for each row execute function public.quotes_shelf_guard();

-- ---- 2) the studio's choice + when it last ran (one row per studio; none = Keep) --
create table if not exists public.org_link_expiry_shelf (
  org_id         uuid primary key references public.organizations(id),
  action         text not null default 'keep',
  updated_by     uuid,
  updated_at     timestamptz not null default now(),
  last_run_at    timestamptz,
  last_run_moved int,
  constraint org_link_expiry_shelf_action_chk check (action in ('keep', 'archive', 'delete'))
);
alter table public.org_link_expiry_shelf enable row level security;
revoke all on public.org_link_expiry_shelf from public, anon, authenticated;   -- RPCs only
grant select on public.org_link_expiry_shelf to service_role;

-- ---- 3) which quotes qualify (read-only) ----------------------------------------
create or replace function public.link_expiry_shelf_candidates(p_org uuid, p_days int)
returns table(quote_id uuid, link_expired_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select q.id, x.sent + make_interval(days => p_days)
    from public.quotes q
    cross join lateral (
      select greatest(
        case when q.approval_token is not null then
          coalesce((select i.issued_at from public.client_link_issued i
                     where i.kind = 'quote' and i.token = q.approval_token), q.created_at) end,
        (select max(coalesce(i.issued_at, q.created_at))
           from public.event_proposal pr
           left join public.client_link_issued i on i.kind = 'proposal' and i.token = pr.share_token
          where pr.quote_id = q.id and pr.share_token is not null)
      ) as sent
    ) x
   where p_org is not null and p_days between 1 and 365
     and q.org_id = p_org
     and q.archived_at is null and q.deleted_at is null
     and q.status = 'quote' and q.confirmed_at is null
     and coalesce(q.lifecycle_stage, 'quote') in ('lead', 'discovery', 'proposal', 'quote')
     and q.approval_status in ('none', 'sent')
     and x.sent is not null
     and x.sent + make_interval(days => p_days) <= now()
     and (q.shelf_restored_at is null or q.shelf_restored_at + make_interval(days => p_days) <= now())
     and not exists (select 1 from public.quote_consents c where c.quote_id = q.id)
     and not exists (select 1 from public.quote_payments p where p.quote_id = q.id
                      and p.status in ('paid', 'refunded', 'created'))
     and not exists (select 1 from public.payment_milestones m where m.quote_id = q.id and m.status = 'paid')
     and not exists (select 1 from public.event_refunds r where r.quote_id = q.id);
$$;
revoke all on function public.link_expiry_shelf_candidates(uuid, int) from public, anon, authenticated;

-- ---- 4) the job: move what qualifies for ONE studio (idempotent) -------------------
create or replace function public.apply_link_expiry_archive(p_org uuid default public.current_org_id())
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_days int; v_action text; v_n int := 0; v_me uuid := auth.uid(); r record;
begin
  if p_org is null then
    return jsonb_build_object('moved', 0, 'action', 'keep', 'enabled', false);
  end if;
  -- a signed-in caller can only ever run it for their own studio
  if v_me is not null and p_org is distinct from public.current_org_id() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_days := public.link_autoexpire_days(p_org);                 -- NULL = auto-expire off
  select s.action into v_action from public.org_link_expiry_shelf s where s.org_id = p_org;
  v_action := coalesce(v_action, 'keep');
  if v_days is null or v_action not in ('archive', 'delete') then
    return jsonb_build_object('moved', 0, 'action', v_action, 'enabled', v_days is not null);
  end if;
  for r in select c.quote_id, c.link_expired_at from public.link_expiry_shelf_candidates(p_org, v_days) c loop
    if v_action = 'archive' then
      update public.quotes q
         set archived_at = now(), archived_by = null, archived_reason = 'link_expired', link_expired_at = r.link_expired_at
       where q.id = r.quote_id and q.org_id = p_org and q.archived_at is null and q.deleted_at is null
         and q.status = 'quote' and q.confirmed_at is null and q.approval_status in ('none', 'sent');
    else
      update public.quotes q
         set deleted_at = now(), deleted_by = null, deleted_reason = 'link_expired', link_expired_at = r.link_expired_at
       where q.id = r.quote_id and q.org_id = p_org and q.archived_at is null and q.deleted_at is null
         and q.status = 'quote' and q.confirmed_at is null and q.approval_status in ('none', 'sent');
    end if;
    if found then
      v_n := v_n + 1;
      insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
        values (null, null, case when v_action = 'archive' then 'quote.moved_to_archive' else 'quote.moved_to_deleted' end,
                'quotes', r.quote_id::text, r.quote_id, p_org,
                jsonb_build_object('auto', true, 'reason', 'link_expired', 'link_expired_at', r.link_expired_at,
                                   'days', v_days, 'run_by', v_me));
    end if;
  end loop;
  return jsonb_build_object('moved', v_n, 'action', v_action, 'enabled', true, 'days', v_days);
end $$;
revoke all on function public.apply_link_expiry_archive(uuid) from public, anon, authenticated;
grant execute on function public.apply_link_expiry_archive(uuid) to service_role;

-- every studio that switched it on (for pg_cron / the service role)
create or replace function public.apply_link_expiry_archive_all()
returns int language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid; v_out jsonb; v_total int := 0;
begin
  for v_org in select s.org_id from public.org_link_expiry_shelf s
                 join public.org_link_autoexpire a on a.org_id = s.org_id
                where s.action in ('archive', 'delete') and a.enabled loop
    v_out := public.apply_link_expiry_archive(v_org);
    update public.org_link_expiry_shelf s set last_run_at = now(), last_run_moved = (v_out ->> 'moved')::int
     where s.org_id = v_org;
    v_total := v_total + coalesce((v_out ->> 'moved')::int, 0);
  end loop;
  return v_total;
end $$;
revoke all on function public.apply_link_expiry_archive_all() from public, anon, authenticated;
grant execute on function public.apply_link_expiry_archive_all() to service_role;

-- the app's lazy trigger: opening Quotes / Dashboard. At most once per 10 minutes per
-- studio (the row update below is the claim, so two tabs can't both run it).
create or replace function public.link_expiry_shelf_tick()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); v_claimed boolean; v_out jsonb;
begin
  if auth.uid() is null or v_org is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- roles that can't see quotes (crew, …) open the Dashboard too: a quiet no-op, not an error
  if not public.has_area('quotes', 'view') then
    return jsonb_build_object('ran', false, 'moved', 0);
  end if;
  update public.org_link_expiry_shelf s set last_run_at = now()
   where s.org_id = v_org and s.action in ('archive', 'delete')
     and (s.last_run_at is null or s.last_run_at <= now() - interval '10 minutes')
  returning true into v_claimed;
  if not coalesce(v_claimed, false) then
    return jsonb_build_object('ran', false, 'moved', 0);
  end if;
  v_out := public.apply_link_expiry_archive(v_org);
  update public.org_link_expiry_shelf s set last_run_moved = (v_out ->> 'moved')::int where s.org_id = v_org;
  return v_out || jsonb_build_object('ran', true);
end $$;
revoke all on function public.link_expiry_shelf_tick() from public, anon;
grant execute on function public.link_expiry_shelf_tick() to authenticated;

-- ---- 5) Quotes page: list the Archive / Deleted shelves; move by hand; Restore ------
-- SECURITY INVOKER: the caller's normal quote RLS (has_area quotes view + own studio)
-- decides what they see — this only picks the flagged rows, plus the two tab counts
-- (Archive = flagged archived + finished events: cancelled, or closed after confirming).
create or replace function public.list_quote_shelf()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'code', q.code, 'title', q.title, 'event_type', q.event_type,
               'status', q.status, 'lifecycle_stage', q.lifecycle_stage, 'approval_status', q.approval_status,
               'current_version', q.current_version, 'event_date', q.event_date,
               'client_name', coalesce(q.client ->> 'name', q.pricing -> 'client' ->> 'name'),
               'total', q.pricing -> 'total', 'created_at', q.created_at, 'updated_at', q.updated_at,
               'shelf', case when q.deleted_at is not null then 'deleted' else 'archived' end,
               'shelved_at', coalesce(q.deleted_at, q.archived_at),
               'reason', case when q.deleted_at is not null then q.deleted_reason else q.archived_reason end,
               'link_expired_at', q.link_expired_at)
             order by coalesce(q.deleted_at, q.archived_at) desc)
        from public.quotes q
       where q.archived_at is not null or q.deleted_at is not null), '[]'::jsonb),
    'archived_count', (select count(*) from public.quotes q
                        where q.deleted_at is null
                          and (q.archived_at is not null or q.status = 'cancelled'
                               or (q.lifecycle_stage = 'closed' and q.status = 'confirmed'))),
    'deleted_count', (select count(*) from public.quotes q where q.deleted_at is not null));
$$;
revoke all on function public.list_quote_shelf() from public, anon;
grant execute on function public.list_quote_shelf() to authenticated;

create or replace function public.move_quote_to_shelf(p_quote_id uuid, p_shelf text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_email text;
        v_pending boolean := false; v_can_delete boolean := false;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_shelf is null or p_shelf not in ('archive', 'delete') then
    raise exception 'choose archive or delete' using errcode = '22023';
  end if;
  if not exists (select 1 from public.quotes q where q.id = p_quote_id and q.org_id = v_org) then
    raise exception 'no such quote' using errcode = '42501';
  end if;
  if p_shelf = 'delete' then
    -- same people who could delete before (admin / planner) ...
    if to_regprocedure('public.can_delete()') is not null then
      execute 'select public.can_delete()' into v_can_delete;
    else v_can_delete := public.is_admin(); end if;
    if not coalesce(v_can_delete, false) then raise exception 'not authorized' using errcode = '42501'; end if;
    -- ... and the 0026 rule still holds: money / consent / refunds -> cancel, don't delete
    if exists (select 1 from public.quote_payments where quote_id = p_quote_id and status in ('paid', 'refunded'))
       or exists (select 1 from public.payment_milestones where quote_id = p_quote_id and status = 'paid')
       or exists (select 1 from public.quote_consents where quote_id = p_quote_id)
       or exists (select 1 from public.event_refunds where quote_id = p_quote_id) then
      raise exception 'This event has payments, a client approval or refunds on record, so it can''t be deleted. Cancel it instead.'
        using errcode = 'P0001';
    end if;
    update public.quotes q set deleted_at = now(), deleted_by = v_me, deleted_reason = 'manual',
                               archived_at = null, archived_by = null, archived_reason = null, link_expired_at = null
     where q.id = p_quote_id and q.org_id = v_org and q.deleted_at is null;
  else
    update public.quotes q set archived_at = now(), archived_by = v_me, archived_reason = 'manual', link_expired_at = null
     where q.id = p_quote_id and q.org_id = v_org and q.archived_at is null and q.deleted_at is null;
  end if;
  if found then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
      values (v_me, v_email, case when p_shelf = 'archive' then 'quote.moved_to_archive' else 'quote.moved_to_deleted' end,
              'quotes', p_quote_id::text, p_quote_id, v_org, jsonb_build_object('auto', false, 'reason', 'manual'));
  end if;
  return jsonb_build_object('id', p_quote_id, 'shelf', case when p_shelf = 'archive' then 'archived' else 'deleted' end);
end $$;
revoke all on function public.move_quote_to_shelf(uuid, text) from public, anon;
grant execute on function public.move_quote_to_shelf(uuid, text) to authenticated;

create or replace function public.restore_quote_from_shelf(p_quote_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_email text; v_from text;
        v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.has_area('quotes', 'edit') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  select case when q.deleted_at is not null then 'deleted' when q.archived_at is not null then 'archived' end
    into v_from from public.quotes q where q.id = p_quote_id and q.org_id = v_org;
  if not found then raise exception 'no such quote' using errcode = '42501'; end if;
  if v_from is null then
    return jsonb_build_object('id', p_quote_id, 'restored', false);       -- already in the normal lists
  end if;
  -- shelf_restored_at keeps it from being moved again by the link rule for N days
  update public.quotes q
     set archived_at = null, archived_by = null, archived_reason = null,
         deleted_at = null, deleted_by = null, deleted_reason = null,
         link_expired_at = null, shelf_restored_at = now()
   where q.id = p_quote_id and q.org_id = v_org;
  select u.email into v_email from auth.users u where u.id = v_me;
  insert into public.audit_log(actor, actor_email, action, entity, entity_id, quote_id, org_id, changed)
    values (v_me, v_email, 'quote.restored', 'quotes', p_quote_id::text, p_quote_id, v_org,
            jsonb_build_object('from', v_from));
  return jsonb_build_object('id', p_quote_id, 'restored', true, 'from', v_from);
end $$;
revoke all on function public.restore_quote_from_shelf(uuid) from public, anon;
grant execute on function public.restore_quote_from_shelf(uuid) to authenticated;

-- ---- 6) Control Center (studio admin) ----------------------------------------------
create or replace function public.admin_get_link_expiry_shelf()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id(); s public.org_link_expiry_shelf; v_days int; v_waiting int;
begin
  if auth.uid() is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into s from public.org_link_expiry_shelf x where x.org_id = v_org;
  select coalesce(a.days, 10) into v_days from public.org_link_autoexpire a where a.org_id = v_org;
  -- how many quotes would move right now with the current number of days
  select count(*) into v_waiting from public.link_expiry_shelf_candidates(v_org, coalesce(v_days, 10));
  return jsonb_build_object('action', coalesce(s.action, 'keep'), 'updated_at', s.updated_at,
    'last_run_at', s.last_run_at, 'last_run_moved', s.last_run_moved, 'waiting', v_waiting);
end $$;

create or replace function public.admin_set_link_expiry_shelf(p_action text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_org uuid := public.current_org_id(); v_old text; v_email text;
        v_pending boolean := false;
begin
  if v_me is null or v_org is null or not public.is_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regprocedure('public.helm_pw_change_pending()') is not null then
    execute 'select public.helm_pw_change_pending()' into v_pending;
    if coalesce(v_pending, false) then raise exception 'set your own password first' using errcode = '42501'; end if;
  end if;
  if p_action is null or p_action not in ('keep', 'archive', 'delete') then
    raise exception 'choose keep, archive or delete' using errcode = '22023';
  end if;
  select x.action into v_old from public.org_link_expiry_shelf x where x.org_id = v_org for update;
  insert into public.org_link_expiry_shelf as x (org_id, action, updated_by, updated_at)
    values (v_org, p_action, v_me, now())
  on conflict (org_id) do update
    set action = excluded.action, updated_by = excluded.updated_by, updated_at = now(),
        -- a new choice runs at the next page open, not 10 minutes later
        last_run_at = case when x.action is distinct from excluded.action then null else x.last_run_at end;
  if coalesce(v_old, 'keep') is distinct from p_action then
    select u.email into v_email from auth.users u where u.id = v_me;
    insert into public.audit_log(actor, actor_email, action, entity, entity_id, org_id, changed)
      values (v_me, v_email, 'link_expiry_shelf.set', 'organizations', v_org::text, v_org,
              jsonb_build_object('action', jsonb_build_object('old', coalesce(v_old, 'keep'), 'new', p_action)));
  end if;
  return public.admin_get_link_expiry_shelf();
end $$;

do $$ declare f text; begin
  foreach f in array array['admin_get_link_expiry_shelf()', 'admin_set_link_expiry_shelf(text)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

-- ---- 7) pg_cron, ONLY if it is already installed (never created here) ---------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      if not exists (select 1 from cron.job where jobname = 'helm_link_expiry_shelf') then
        perform cron.schedule('helm_link_expiry_shelf', '*/30 * * * *',
                              'select public.apply_link_expiry_archive_all()');
      end if;
    exception when others then
      raise notice 'pg_cron present but the job could not be scheduled (%); the app runs it on page open instead', sqlerrm;
    end;
  end if;
end $$;

-- ═══════════════════════════════ VERIFY ═══════════════════════════════════════

-- ═══════════════════════════════ VERIFY (all parts) ═══════════════════════════════
select item, case when ok then 'ok' else 'FAIL' end as status from (values
  ('0038 · task-proof bucket: private, 8 MB cap, images + voice notes only',
     exists (select 1 from storage.buckets where id = 'task-proof' and public = false and file_size_limit = 8388608
               and allowed_mime_types @> array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4']
               and cardinality(allowed_mime_types) = 6)),
  ('0038 · storage: link upload only through a grant; staff-only read; no anon read/update/delete',
     exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'task_proof_link_upload' and cmd = 'INSERT')
     and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'task_proof_staff_read' and cmd = 'SELECT'
                   and roles = array['authenticated']::name[])
     and not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                       and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%task-proof%'
                       and cmd in ('SELECT','UPDATE','DELETE','ALL') and roles && array['anon','public']::name[])),
  ('0038 · task_evidence: RLS on, staff read own studio, no direct writes, no anon',
     (select relrowsecurity from pg_class where oid = 'public.task_evidence'::regclass)
     and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_evidence' and policyname = 'task_evidence_staff_read')
     and has_table_privilege('authenticated', 'public.task_evidence', 'SELECT')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'INSERT')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'UPDATE')
     and not has_table_privilege('authenticated', 'public.task_evidence', 'DELETE')
     and not has_table_privilege('anon', 'public.task_evidence', 'SELECT')),
  ('0038 · task_evidence_grants: internal (RLS on, no API access)',
     (select relrowsecurity from pg_class where oid = 'public.task_evidence_grants'::regclass)
     and not has_table_privilege('anon', 'public.task_evidence_grants', 'SELECT')
     and not has_table_privilege('authenticated', 'public.task_evidence_grants', 'SELECT')),
  ('0038 · crew-link RPCs callable signed out; staff read gate is not',
     has_function_privilege('anon', 'public.worker_evidence_upload(uuid,uuid,text,text)', 'EXECUTE')
     and has_function_privilege('anon', 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])', 'EXECUTE')
     and has_function_privilege('anon', 'public.task_proof_upload_ok(text)', 'EXECUTE')
     and not has_function_privilege('anon', 'public.task_proof_visible(text)', 'EXECUTE')
     and (select prosecdef from pg_proc where oid = 'public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'::regprocedure)
     and pg_get_functiondef('public.worker_evidence_upload(uuid,uuid,text,text)'::regprocedure) like '%_work_token_live%'
     and pg_get_functiondef('public.worker_respond_evidence(uuid,uuid,text,text,text,integer,text[])'::regprocedure) like '%_work_token_live%'),
  ('0038 · tenant guard (quote/studio must agree) on both new tables',
     (select count(*) from pg_trigger where tgname = 'zz_quote_org_match'
        and tgrelid in ('public.task_evidence'::regclass, 'public.task_evidence_grants'::regclass)) = 2),
  ('0038 · existing crew-link RPCs still callable signed out',
     has_function_privilege('anon', 'public.worker_respond(uuid,uuid,text)', 'EXECUTE')
     and has_function_privilege('anon', 'public.worker_get_tasks(uuid)', 'EXECUTE')),

  ('0039 · setting table: RLS on, no direct access for signed-in users or visitors',
     to_regclass('public.org_link_autoexpire') is not null
     and (select relrowsecurity from pg_class where oid = 'public.org_link_autoexpire'::regclass)
     and not has_table_privilege('anon', 'public.org_link_autoexpire', 'select')
     and not has_table_privilege('authenticated', 'public.org_link_autoexpire', 'select')
     and not has_table_privilege('authenticated', 'public.org_link_autoexpire', 'insert')
     and not has_table_privilege('authenticated', 'public.org_link_autoexpire', 'update')),
  ('0039 · only 1 to 365 days can be stored',
     exists (select 1 from pg_constraint where conname = 'org_link_autoexpire_days_chk'
              and conrelid = 'public.org_link_autoexpire'::regclass)),
  ('0039 · issue-time table: RLS on, internal only',
     to_regclass('public.client_link_issued') is not null
     and (select relrowsecurity from pg_class where oid = 'public.client_link_issued'::regclass)
     and not has_table_privilege('anon', 'public.client_link_issued', 'select')
     and not has_table_privilege('authenticated', 'public.client_link_issued', 'select')),
  ('0039 · every approval link already out there has an issue time',
     not exists (select 1 from public.quotes q where q.approval_token is not null
                  and not exists (select 1 from public.client_link_issued i where i.kind = 'quote' and i.token = q.approval_token))),
  ('0039 · every proposal link already out there has an issue time',
     not exists (select 1 from public.event_proposal p where p.share_token is not null
                  and not exists (select 1 from public.client_link_issued i where i.kind = 'proposal' and i.token = p.share_token))),
  ('0039 · new approval / proposal links get their issue time recorded (2 triggers)',
     (select count(*) from pg_trigger where tgname = 'zz_client_link_issued'
       and tgrelid in ('public.quotes'::regclass, 'public.event_proposal'::regclass)) = 2),
  ('0039 · 12 entry points wrapped; each original kept as <fn>__pre0039',
     (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in
       ('public_get_quote__pre0039','public_get_portal__pre0039','create_payment__pre0039','request_otp__pre0039',
        'verify_and_consent__pre0039','payment_link_begin__pre0039','otp_send_authorize__pre0039',
        'generate_approval_token__pre0039','public_get_proposal__pre0039','publish_proposal__pre0039',
        '_work_token_live__pre0039','event_site_live_until__pre0039')) = 12
     and pg_get_functiondef('public.public_get_quote(uuid)'::regprocedure) like '%public_get_quote__pre0039%'
     and pg_get_functiondef('public._work_token_live(uuid)'::regprocedure) like '%_work_token_live__pre0039%'
     and pg_get_functiondef('public.event_site_live_until(uuid)'::regprocedure) like '%event_site_live_until__pre0039%'),
  ('0039 · nobody outside the database can call an original (unguarded) body',
     not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '%\_\_pre0039'
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  ('0039 · client pages keep working for visitors (same grants as before)',
     has_function_privilege('anon', 'public.public_get_quote(uuid)', 'execute')
     and has_function_privilege('anon', 'public.public_get_portal(uuid)', 'execute')
     and has_function_privilege('anon', 'public.create_payment(uuid)', 'execute')
     and has_function_privilege('anon', 'public.request_otp(uuid,text)', 'execute')
     and has_function_privilege('anon', 'public.verify_and_consent(uuid,text,text,boolean,text,text,text,text)', 'execute')
     and has_function_privilege('anon', 'public.public_get_proposal(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.generate_approval_token(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.publish_proposal(uuid,boolean)', 'execute')
     and has_function_privilege('authenticated', 'public.event_site_live_until(uuid)', 'execute')),
  ('0039 · server-only helpers stay server-only',
     not has_function_privilege('anon', 'public.payment_link_begin(uuid,integer)', 'execute')
     and not has_function_privilege('authenticated', 'public.payment_link_begin(uuid,integer)', 'execute')
     and not has_function_privilege('anon', 'public.otp_send_authorize(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'public._work_token_live(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.generate_approval_token(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.link_autoexpire_days(uuid)', 'execute')),
  ('0039 · admin RPCs: signed-in only (admin checked inside), never visitors',
     has_function_privilege('authenticated', 'public.admin_set_link_autoexpire(boolean,integer)', 'execute')
     and not has_function_privilege('anon', 'public.admin_set_link_autoexpire(boolean,integer)', 'execute')
     and not has_function_privilege('anon', 'public.admin_get_link_autoexpire()', 'execute')
     and pg_get_functiondef('public.admin_set_link_autoexpire(boolean,integer)'::regprocedure) like '%is_admin()%'),

  ('0040 · 8 new quote columns, all NULL until something is archived / deleted',
     (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'quotes'
       and column_name in ('archived_at','archived_by','archived_reason','deleted_at','deleted_by','deleted_reason',
                           'link_expired_at','shelf_restored_at')) = 8),
  ('0040 · a quote can be archived OR deleted, never both; reasons limited to manual / link_expired',
     (select count(*) from pg_constraint where conrelid = 'public.quotes'::regclass
       and conname in ('quotes_archived_reason_chk','quotes_deleted_reason_chk','quotes_shelf_one_chk')) = 3),
  ('0040 · the app can''t write the archive / deleted flags directly (guard trigger)',
     exists (select 1 from pg_trigger where tgname = 'quotes_shelf_guard_biu' and tgrelid = 'public.quotes'::regclass)),
  ('0040 · the 0026 delete guard is still on quotes',
     exists (select 1 from pg_trigger where tgname = 'aa_quote_delete_guard' and tgrelid = 'public.quotes'::regclass)),
  ('0040 · setting table: RLS on, no direct access for signed-in users or visitors',
     to_regclass('public.org_link_expiry_shelf') is not null
     and (select relrowsecurity from pg_class where oid = 'public.org_link_expiry_shelf'::regclass)
     and not has_table_privilege('anon', 'public.org_link_expiry_shelf', 'select')
     and not has_table_privilege('authenticated', 'public.org_link_expiry_shelf', 'select')
     and not has_table_privilege('authenticated', 'public.org_link_expiry_shelf', 'insert')
     and not has_table_privilege('authenticated', 'public.org_link_expiry_shelf', 'update')),
  ('0040 · every studio starts on Keep (no setting rows, nothing archived or deleted by this paste)',
     not exists (select 1 from public.org_link_expiry_shelf where action <> 'keep')
     and not exists (select 1 from public.quotes where archived_reason = 'link_expired' or deleted_reason = 'link_expired')),
  ('0040 · the job is server-only (no rate-limit bypass from the app)',
     not has_function_privilege('anon', 'public.apply_link_expiry_archive(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.apply_link_expiry_archive(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'public.apply_link_expiry_archive_all()', 'execute')
     and not has_function_privilege('authenticated', 'public.link_expiry_shelf_candidates(uuid,integer)', 'execute')),
  ('0040 · app RPCs: signed-in only (permissions checked inside), never visitors',
     has_function_privilege('authenticated', 'public.link_expiry_shelf_tick()', 'execute')
     and has_function_privilege('authenticated', 'public.list_quote_shelf()', 'execute')
     and has_function_privilege('authenticated', 'public.restore_quote_from_shelf(uuid)', 'execute')
     and has_function_privilege('authenticated', 'public.move_quote_to_shelf(uuid,text)', 'execute')
     and has_function_privilege('authenticated', 'public.admin_set_link_expiry_shelf(text)', 'execute')
     and not has_function_privilege('anon', 'public.link_expiry_shelf_tick()', 'execute')
     and not has_function_privilege('anon', 'public.list_quote_shelf()', 'execute')
     and not has_function_privilege('anon', 'public.restore_quote_from_shelf(uuid)', 'execute')
     and not has_function_privilege('anon', 'public.move_quote_to_shelf(uuid,text)', 'execute')
     and not has_function_privilege('anon', 'public.admin_set_link_expiry_shelf(text)', 'execute')
     and pg_get_functiondef('public.admin_set_link_expiry_shelf(text)'::regprocedure) like '%is_admin()%'
     and pg_get_functiondef('public.restore_quote_from_shelf(uuid)'::regprocedure) like '%has_area(''quotes'', ''edit'')%'),
  ('0040 · the Quotes list function uses the caller''s own access (not SECURITY DEFINER)',
     not (select prosecdef from pg_proc where oid = 'public.list_quote_shelf()'::regprocedure))
) v(item, ok);
