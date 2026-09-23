-- ============================================================================
-- phase88-invite-media-storage.sql  —  Storage bucket for invitation photos
-- ---------------------------------------------------------------------------
-- Creates a PUBLIC bucket 'invite-media' for the digital-invitation photos
-- (they are meant to be viewed by anyone with the invite link), and locks
-- WRITES so a signed-in manager can only upload/change/remove files inside
-- their OWN org's folder. Paths are "<org_id>/<quote_id>/<file>", so the first
-- path segment is the tenant — storage RLS checks it against current_org_id().
--
-- GUARDRAILS: additive + idempotent. No destructive statements. Tenant-isolated
-- writes; public read only (matches the public invitation pages).
-- Run once in the Supabase SQL editor.
-- ============================================================================

-- 1) The bucket (public read).
insert into storage.buckets (id, name, public)
values ('invite-media', 'invite-media', true)
on conflict (id) do update set public = true;

-- 2) Anyone may VIEW invitation photos (they appear on the public invite page).
drop policy if exists "invite_media_public_read" on storage.objects;
create policy "invite_media_public_read" on storage.objects
  for select using ( bucket_id = 'invite-media' );

-- 3) A signed-in manager may WRITE only within their own org's folder.
--    (storage.foldername(name))[1] is the first path segment = the org id.
drop policy if exists "invite_media_org_insert" on storage.objects;
create policy "invite_media_org_insert" on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'invite-media' and (storage.foldername(name))[1] = current_org_id()::text );

drop policy if exists "invite_media_org_update" on storage.objects;
create policy "invite_media_org_update" on storage.objects
  for update to authenticated
  using ( bucket_id = 'invite-media' and (storage.foldername(name))[1] = current_org_id()::text );

drop policy if exists "invite_media_org_delete" on storage.objects;
create policy "invite_media_org_delete" on storage.objects
  for delete to authenticated
  using ( bucket_id = 'invite-media' and (storage.foldername(name))[1] = current_org_id()::text );
