-- ============================================================================
-- 0013_storage_hardening.sql — CANONICAL forward-only (SEC-05 F6 + bucket config).
-- Storage security for the invite-media and event-docs buckets, enforced in SQL so
-- it does not depend on dashboard-only settings:
--   * buckets are private (public=false) with a MIME allowlist + size cap set on
--     storage.buckets (manageable via SQL on Supabase). No public object listing.
--   * invite-media: own-org read/write only (object key is <org_id>/<quote_id>/...;
--     foldername[1] must equal current_org_id) — replaces the old public-read.
--   * event-docs already org-scoped by 0009; this pins its bucket config too.
-- Client-side magic-byte/type validation + http(s) render guard are covered by
-- test/invite-media-hardening.test.mjs (object key is a server uuid, not client).
-- Provider note: on real Supabase these storage.buckets/objects changes are applied
-- by the migration role; a staging runtime check should re-verify (see release pack).
-- Idempotent. Forward-only.
-- ============================================================================

-- bucket config: private + MIME allowlist + size cap (8 MB)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('invite-media','invite-media', false, 8388608,
          array['image/png','image/jpeg','image/webp','image/gif'])
  on conflict (id) do update set public=false, file_size_limit=8388608,
          allowed_mime_types=array['image/png','image/jpeg','image/webp','image/gif'];
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('event-docs','event-docs', false, 10485760,
          array['application/pdf','image/png','image/jpeg','image/webp'])
  on conflict (id) do update set public=false, file_size_limit=10485760,
          allowed_mime_types=array['application/pdf','image/png','image/jpeg','image/webp'];

-- invite-media object RLS: own-org only; NO public read (SEC-05 F6)
drop policy if exists "invite_media_public_read" on storage.objects;
drop policy if exists "invite_media_org_read" on storage.objects;
drop policy if exists "invite_media_org_write" on storage.objects;
create policy "invite_media_org_read" on storage.objects for select to authenticated
  using ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text );
create policy "invite_media_org_write" on storage.objects for insert to authenticated
  with check ( bucket_id = 'invite-media'
          and (storage.foldername(name))[1] = (select public.current_org_id())::text );
create policy "invite_media_org_update" on storage.objects for update to authenticated
  using ( bucket_id = 'invite-media' and (storage.foldername(name))[1] = (select public.current_org_id())::text );
create policy "invite_media_org_delete" on storage.objects for delete to authenticated
  using ( bucket_id = 'invite-media' and (storage.foldername(name))[1] = (select public.current_org_id())::text );

-- ---- VERIFY: no public invite-media read; buckets private w/ allowlist ------
-- select not exists(select 1 from pg_policies where schemaname='storage' and policyname='invite_media_public_read') as no_public_read;
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id in ('invite-media','event-docs');
