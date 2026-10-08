-- 0051_upload_quarantine.sql — CANONICAL forward-only. REQUIRES 0048.
-- Server-side upload verification + quarantine (DORMANT until the owner deploys the
-- verify-upload Edge Function and flips the enforce flag).
--
-- Gap closed: the browser magic-byte checks (store-api uploads.*) can be skipped by anyone
-- who calls Storage directly with their own JWT; nothing re-checked the bytes server-side
-- and there was no antivirus hook.
--
-- 1) public.upload_scans — one row per uploaded object in a SCANNED bucket
--    (event-docs, chat-media, invite-media, task-proof): status pending | clean | rejected.
--    An AFTER INSERT trigger on storage.objects records every new object as 'pending'; an
--    AFTER UPDATE that rewrites an object in place (upsert) puts it back to 'pending'.
--    Objects that already exist when this runs are GRANDFATHERED as 'clean'.
-- 2) RESTRICTIVE select policy on storage.objects (anon + authenticated):
--      * 'rejected'  → hidden from everyone, ALWAYS (only the deployed scanner rejects);
--      * 'pending'   → hidden from everyone except the uploader, ONLY WHILE
--                      upload_scan_config.enforce = true (default FALSE, so nothing changes
--                      for the app until the owner deploys the scanner and flips it);
--      * 'clean' / other buckets → unchanged (the permissive policies decide as before).
--    service_role (the scanner, signed-URL minting by Edge Functions) bypasses RLS.
-- 3) Service-role-only RPCs for the scanner: upload_scan_claim (batch, SKIP LOCKED, attempt
--    counter) and upload_scan_mark (clean | rejected | retry; rejected writes an audit row).
--    Members read status through upload_scan_status (own studio only) to show "scanning…".
-- 4) Private bucket 'upload-quarantine' (no client policies: no client can read or write it);
--    the scanner MOVES rejected objects there — nothing is hard-deleted by default.
--
-- Additive + idempotent: new table/functions/trigger/policy (drop-if-exists + create), one
-- config row, one bucket, grandfather rows inserted with ON CONFLICT DO NOTHING. No existing
-- object, app row or policy is changed or deleted.

-- ---- tables ---------------------------------------------------------------------------
create table if not exists public.upload_scans (
  object_id  uuid primary key,
  bucket_id  text not null,
  name       text not null,
  org_id     uuid,
  owner_id   uuid,
  status     text not null default 'pending' check (status in ('pending', 'clean', 'rejected')),
  reason     text check (reason is null or length(reason) <= 200),
  size_bytes bigint,
  attempts   int not null default 0,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  scanned_at timestamptz
);
create index if not exists upload_scans_pending_idx on public.upload_scans (created_at) where status = 'pending';
create index if not exists upload_scans_bucket_name_idx on public.upload_scans (bucket_id, name);
alter table public.upload_scans enable row level security;
revoke all on table public.upload_scans from public, anon, authenticated;

create table if not exists public.upload_scan_config (
  id         boolean primary key default true check (id),
  enforce    boolean not null default false,     -- OWNER FLIPS to true after deploying verify-upload
  updated_at timestamptz not null default now()
);
insert into public.upload_scan_config (id, enforce) values (true, false) on conflict (id) do nothing;
alter table public.upload_scan_config enable row level security;
revoke all on table public.upload_scan_config from public, anon, authenticated;

-- ---- helpers ----------------------------------------------------------------------------
create or replace function public.upload_scan_bucket(p_bucket text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_bucket in ('event-docs', 'chat-media', 'invite-media', 'task-proof'), false);
$$;
revoke all on function public.upload_scan_bucket(text) from public;
grant execute on function public.upload_scan_bucket(text) to anon, authenticated, service_role;

create or replace function public.upload_scan_enforced()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select c.enforce from public.upload_scan_config c where c.id), false);
$$;
revoke all on function public.upload_scan_enforced() from public;
grant execute on function public.upload_scan_enforced() to anon, authenticated, service_role;

-- first path folder as a studio id (null when it isn't a uuid)
create or replace function public.upload_scan_org(p_name text)
returns uuid language sql immutable set search_path = '' as $$
  select case when split_part(coalesce(p_name, ''), '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then split_part(p_name, '/', 1)::uuid end;
$$;
revoke all on function public.upload_scan_org(text) from public;
grant execute on function public.upload_scan_org(text) to anon, authenticated, service_role;

-- storage.objects carries owner (uuid, legacy) and/or owner_id (text) depending on version
create or replace function public.upload_scan_owner(p_row jsonb)
returns uuid language plpgsql immutable set search_path = '' as $$
declare v text := coalesce(nullif(p_row ->> 'owner_id', ''), nullif(p_row ->> 'owner', ''));
begin
  if v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return v::uuid; end if;
  return null;
end $$;
revoke all on function public.upload_scan_owner(jsonb) from public, anon, authenticated;

-- RLS gate (restrictive): may the CURRENT caller see this object?
create or replace function public.upload_scan_read_ok(p_id uuid, p_bucket text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare s record;
begin
  if not public.upload_scan_bucket(p_bucket) then return true; end if;
  select us.status, us.owner_id into s from public.upload_scans us where us.object_id = p_id;
  if not found then
    -- no row: only possible if the trigger was bypassed; fail closed when enforcing
    return not public.upload_scan_enforced();
  end if;
  if s.status = 'clean' then return true; end if;
  if s.status = 'rejected' then return false; end if;                 -- always hidden
  -- pending
  if not public.upload_scan_enforced() then return true; end if;     -- dormant: unchanged behaviour
  return s.owner_id is not null and s.owner_id = auth.uid();          -- uploader only
end $$;
revoke all on function public.upload_scan_read_ok(uuid, text) from public;
grant execute on function public.upload_scan_read_ok(uuid, text) to anon, authenticated;

-- ---- trigger: every new / rewritten object in a scanned bucket → pending -----------------
create or replace function public._tg_upload_scan_record()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not public.upload_scan_bucket(new.bucket_id) then return null; end if;
  if tg_op = 'INSERT' then
    insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status)
    values (new.id, new.bucket_id, new.name, public.upload_scan_org(new.name),
            public.upload_scan_owner(to_jsonb(new)), 'pending')
    on conflict (object_id) do update
      set bucket_id = excluded.bucket_id, name = excluded.name, org_id = excluded.org_id,
          status = 'pending', reason = null, scanned_at = null, attempts = 0, claimed_at = null;
  elsif (to_jsonb(new) - 'last_accessed_at') is distinct from (to_jsonb(old) - 'last_accessed_at') then
    -- content / path rewritten in place (upsert, move within a scanned bucket) → re-scan
    insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status)
    values (new.id, new.bucket_id, new.name, public.upload_scan_org(new.name),
            public.upload_scan_owner(to_jsonb(new)), 'pending')
    on conflict (object_id) do update
      set bucket_id = excluded.bucket_id, name = excluded.name, org_id = excluded.org_id,
          status = case when public.upload_scans.status = 'rejected' then 'rejected' else 'pending' end,
          scanned_at = case when public.upload_scans.status = 'rejected' then public.upload_scans.scanned_at end,
          attempts = 0, claimed_at = null;
  end if;
  return null;
end $$;
revoke all on function public._tg_upload_scan_record() from public, anon, authenticated;
drop trigger if exists zz_upload_scan_record on storage.objects;
create trigger zz_upload_scan_record after insert or update on storage.objects
  for each row execute function public._tg_upload_scan_record();

-- ---- grandfather: objects that exist now are treated as clean ----------------------------
insert into public.upload_scans (object_id, bucket_id, name, org_id, owner_id, status, reason, scanned_at)
select o.id, o.bucket_id, o.name, public.upload_scan_org(o.name), public.upload_scan_owner(to_jsonb(o)),
       'clean', 'grandfathered', now()
  from storage.objects o
 where public.upload_scan_bucket(o.bucket_id)
on conflict (object_id) do nothing;

-- ---- restrictive read policy -------------------------------------------------------------
drop policy if exists upload_scan_read_gate on storage.objects;
create policy upload_scan_read_gate on storage.objects as restrictive for select to anon, authenticated
  using ( public.upload_scan_read_ok(id, bucket_id) );

-- ---- member read of scan status (own studio / own uploads only) ---------------------------
create or replace function public.upload_scan_status(p_bucket text, p_names text[])
returns table (name text, status text) language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := public.current_org_id();
begin
  if auth.uid() is null or not public.upload_scan_bucket(p_bucket) or p_names is null
     or coalesce(array_length(p_names, 1), 0) > 200 then return; end if;
  return query
    select us.name, us.status from public.upload_scans us
     where us.bucket_id = p_bucket and us.name = any(p_names)
       and ((v_org is not null and us.org_id = v_org) or us.owner_id = auth.uid());
end $$;
revoke all on function public.upload_scan_status(text, text[]) from public;
grant execute on function public.upload_scan_status(text, text[]) to authenticated;

-- ---- scanner RPCs (service_role ONLY) -----------------------------------------------------
create or replace function public.upload_scan_claim(p_limit int default 20)
returns table (object_id uuid, bucket_id text, name text, mimetype text, size_bytes bigint, attempts int)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
  with c as (
    select us.object_id from public.upload_scans us
     where us.status = 'pending' and us.attempts < 10
       and (us.claimed_at is null or us.claimed_at < now() - interval '5 minutes')
     order by us.created_at
     limit greatest(1, least(coalesce(p_limit, 20), 100))
     for update skip locked
  ), u as (
    update public.upload_scans us set claimed_at = now(), attempts = us.attempts + 1
      from c where us.object_id = c.object_id
    returning us.object_id, us.bucket_id, us.name, us.attempts
  )
  select u.object_id, u.bucket_id, u.name,
         (o.metadata ->> 'mimetype')::text, nullif(o.metadata ->> 'size', '')::bigint, u.attempts
    from u left join storage.objects o on o.id = u.object_id;
end $$;
revoke all on function public.upload_scan_claim(int) from public, anon, authenticated;

create or replace function public.upload_scan_mark(p_object uuid, p_status text, p_reason text, p_size bigint default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare r record;
begin
  if p_status not in ('clean', 'rejected', 'retry') then raise exception 'bad status' using errcode = '22023'; end if;
  select * into r from public.upload_scans where object_id = p_object for update;
  if not found then return 'missing'; end if;
  if r.status <> 'pending' then return r.status; end if;            -- idempotent: never flips a decided row
  if p_status = 'retry' then
    update public.upload_scans set claimed_at = null, reason = left(p_reason, 200) where object_id = p_object;
    return 'pending';
  end if;
  update public.upload_scans
     set status = p_status, reason = left(p_reason, 200), size_bytes = coalesce(p_size, size_bytes),
         scanned_at = now(), claimed_at = null
   where object_id = p_object;
  if p_status = 'rejected' then
    insert into public.audit_log (actor, actor_email, action, entity, entity_id, changed, org_id, at)
    values (null, null, 'upload.rejected', 'storage.objects', p_object::text,
            jsonb_build_object('bucket', r.bucket_id, 'name', r.name, 'reason', left(p_reason, 200), 'owner', r.owner_id),
            r.org_id, now());
  end if;
  return p_status;
end $$;
revoke all on function public.upload_scan_mark(uuid, text, text, bigint) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.upload_scan_claim(int) to service_role;
    grant execute on function public.upload_scan_mark(uuid, text, text, bigint) to service_role;
    grant select on table public.upload_scans to service_role;
  end if;
end $$;

-- ---- quarantine bucket (private; no client policy → no client access) ---------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('upload-quarantine', 'upload-quarantine', false, 20971520, null)
on conflict (id) do nothing;
update storage.buckets set public = false where id = 'upload-quarantine' and public is distinct from false;

-- ---- VERIFY -------------------------------------------------------------------------------
-- select policyname, permissive, cmd from pg_policies where schemaname='storage' and tablename='objects' and policyname='upload_scan_read_gate';
-- select status, count(*) from public.upload_scans group by 1;
-- select enforce from public.upload_scan_config;      -- false until the owner flips it
