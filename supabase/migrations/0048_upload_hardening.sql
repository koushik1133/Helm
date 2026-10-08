-- 0048_upload_hardening.sql — CANONICAL forward-only.
-- Upload + storage hardening (all six app buckets) and NV-04 (run-2).
--
-- 1) NV-04 — guests could LIST invite-media across studios.
--    The 0019 anon SELECT policy matched any photo on ANY published, live site, with
--    no slug context, so Storage list/search/sign (which run under the caller's RLS)
--    let anyone with the anon key enumerate every live invitation's photos across all
--    studios. Now a guest (anon) can read an invite-media object ONLY when:
--      * the request carries header  x-helm-site-slug: <slug>  (the invitation page
--        sends it on its own signing client), AND
--      * that slug is a PUBLISHED, in-window site whose org_id / quote_id are the
--        object's first two path folders and whose data->photos lists the object, AND
--      * the Storage operation is not a list/search (storage-api sets
--        storage.operation; a list/search is refused even with a valid slug).
--    No slug → nothing. Wrong slug / another studio's slug → nothing. Unpublished or
--    out-of-window → nothing. Signed-in staff keep their own-org read (0013) unchanged.
--
-- 2) RESTRICTIVE storage.objects policies (AND-ed with every permissive policy,
--    present or future) for INSERT and UPDATE, from anon and authenticated:
--      * the object name must match the bucket's server-shaped key pattern (random
--        uuid/hex file name, no client file name, no extra folders, no '..');
--      * the extension must be on the bucket's allowlist;
--      * the first folder must be the caller's own studio (task-proof: anon link
--        upload; its key is bound to a one-time server grant by 0038 instead);
--      * any other bucket (helm-manual, unknown) takes no client writes at all.
--
-- 3) storage.buckets: every app bucket re-pinned private with its MIME allowlist +
--    size cap (idempotent UPDATE of existing rows; insert only if missing).
--
-- Additive + idempotent: new functions, new policies (drop-if-exists + create), the
-- 0019 policy replaced in place, bucket config re-pinned. No object, table or row of
-- app data is changed or deleted. Antivirus scanning is NOT done here (needs an
-- external scanner — owner item, see docs).

-- ---- helpers ------------------------------------------------------------------------
-- the slug the guest's invitation page presented (header), or null
create or replace function public.request_site_slug()
returns text language plpgsql stable set search_path = '' as $$
declare h text := current_setting('request.headers', true); v text;
begin
  if h is null or h = '' then return null; end if;
  begin v := (h::jsonb) ->> 'x-helm-site-slug'; exception when others then return null; end;
  v := nullif(btrim(v), '');
  if v is null or length(v) > 200 or v !~ '^[A-Za-z0-9][A-Za-z0-9_-]*$' then return null; end if;
  return v;
end $$;
revoke all on function public.request_site_slug() from public;
grant execute on function public.request_site_slug() to anon, authenticated, service_role;

-- true when storage-api says this is a listing / search (never allowed for guests)
create or replace function public.storage_op_is_listing()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('storage.operation', true), '') ~* '(list|search)';
$$;
revoke all on function public.storage_op_is_listing() from public;
grant execute on function public.storage_op_is_listing() to anon, authenticated, service_role;

-- NV-04: guest read of ONE invitation's photos, bound to the slug the guest holds
create or replace function public.invite_media_guest_read_ok(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_slug text := public.request_site_slug();
begin
  if v_slug is null or p_name is null or public.storage_op_is_listing() then return false; end if;
  return exists (
    select 1
      from public.event_sites s
     where s.slug = v_slug
       and s.status = 'published'
       and s.org_id::text   = split_part(p_name, '/', 1)
       and s.quote_id::text = split_part(p_name, '/', 2)
       and now() < coalesce(public.event_site_live_until(s.id), 'infinity'::timestamptz)
       and exists (
         select 1
           from jsonb_array_elements_text(
                  case when jsonb_typeof(s.data->'photos') = 'array' then s.data->'photos' else '[]'::jsonb end
                ) u(url)
          where right(u.url, length(p_name) + 14) = '/invite-media/' || p_name));
end $$;
revoke all on function public.invite_media_guest_read_ok(text) from public;
grant execute on function public.invite_media_guest_read_ok(text) to anon, authenticated;

-- server-shaped object key + extension allowlist + own-studio first folder, per bucket
create or replace function public.storage_object_name_ok(p_bucket text, p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  u   constant text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  rnd constant text := '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})';
  v_org uuid;
begin
  if p_bucket is null or p_name is null or length(p_name) > 400 then return false; end if;
  if p_bucket = 'task-proof' then              -- anon crew link; key bound to a 0038 grant
    return p_name ~ ('^' || u || '/' || u || '/' || u || '/' || u || '\.(jpg|png|webp|webm|ogg|m4a)$');
  end if;
  v_org := public.current_org_id();
  if v_org is null or auth.uid() is null or split_part(p_name, '/', 1) is distinct from v_org::text then
    return false;
  end if;
  return case p_bucket
    when 'invite-media'   then p_name ~ ('^' || u || '/' || u || '/' || rnd || '\.(png|jpg|webp|gif)$')
    when 'event-docs'     then p_name ~ ('^' || u || '/' || u || '/' || rnd || '\.(pdf|png|jpg|webp)$')
    when 'chat-media'     then p_name ~ ('^' || u || '/' || u || '/[A-Za-z0-9-]{1,64}\.(png|jpg|webp|gif|webm|ogg|m4a|mp3)$')
    when 'member-avatars' then p_name ~ ('^' || u || '/' || u || '/' || u || '\.(png|jpg|webp)$')
    else false                                 -- helm-manual / unknown: no client writes
  end;
end $$;
revoke all on function public.storage_object_name_ok(text, text) from public;
grant execute on function public.storage_object_name_ok(text, text) to anon, authenticated;

-- ---- 1) NV-04: replace the guest read policy (same name, slug-bound now) -------------
drop policy if exists "invite_media_public_read" on storage.objects;     -- legacy phase88; never again
drop policy if exists "invite_media_published_read" on storage.objects;
create policy "invite_media_published_read" on storage.objects for select to anon, authenticated
  using ( bucket_id = 'invite-media' and public.invite_media_guest_read_ok(name) );

-- ---- 2) restrictive write rules -------------------------------------------------------
drop policy if exists upload_guard_insert on storage.objects;
create policy upload_guard_insert on storage.objects as restrictive for insert to anon, authenticated
  with check ( public.storage_object_name_ok(bucket_id, name) );
drop policy if exists upload_guard_update on storage.objects;
create policy upload_guard_update on storage.objects as restrictive for update to anon, authenticated
  using ( true )
  with check ( public.storage_object_name_ok(bucket_id, name) );

-- ---- 3) bucket config: private + MIME allowlist + size cap ----------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('invite-media',   'invite-media',   false,  8388608, array['image/png','image/jpeg','image/webp','image/gif']),
  ('event-docs',     'event-docs',     false, 10485760, array['application/pdf','image/png','image/jpeg','image/webp']),
  ('chat-media',     'chat-media',     false, 16777216, array['image/png','image/jpeg','image/webp','image/gif',
                                                              'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a']),
  ('task-proof',     'task-proof',     false,  8388608, array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4']),
  ('member-avatars', 'member-avatars', false,  2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;
update storage.buckets b set public = false,
       file_size_limit    = case when c.id = 'helm-manual' then b.file_size_limit else c.lim end,
       allowed_mime_types = case when c.id = 'helm-manual' then b.allowed_mime_types else c.mimes end
  from (values
    ('invite-media',    8388608::bigint, array['image/png','image/jpeg','image/webp','image/gif']),
    ('event-docs',     10485760::bigint, array['application/pdf','image/png','image/jpeg','image/webp']),
    ('chat-media',     16777216::bigint, array['image/png','image/jpeg','image/webp','image/gif',
                                               'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/aac','audio/wav','audio/x-m4a']),
    ('task-proof',      8388608::bigint, array['image/jpeg','image/png','image/webp','audio/webm','audio/ogg','audio/mp4']),
    ('member-avatars',  2097152::bigint, array['image/png','image/jpeg','image/webp']),
    ('helm-manual',    20971520::bigint, null::text[])
  ) c(id, lim, mimes)
 where b.id = c.id
   and (b.public is distinct from false
        or (c.id <> 'helm-manual' and (b.file_size_limit is distinct from c.lim or b.allowed_mime_types is distinct from c.mimes)));
-- helm-manual: only re-pinned private above (its limits stay as 0031 set them)

-- ---- VERIFY ---------------------------------------------------------------------------
-- select policyname, permissive, cmd, roles from pg_policies where schemaname='storage' and tablename='objects'
--  and policyname in ('invite_media_published_read','upload_guard_insert','upload_guard_update');
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
