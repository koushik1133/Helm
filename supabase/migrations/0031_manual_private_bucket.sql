-- ============================================================================
-- 0031_manual_private_bucket.sql — CANONICAL forward-only.
--
-- What this changes, in plain words:
--   The Helm user manual used to be a public file (/docs/USER-MANUAL + screenshots):
--   anyone with the URL could read it. It now lives in a PRIVATE storage bucket,
--   "helm-manual", and the /manual page downloads it with the visitor's own
--   signed-in session. This file creates that bucket and ONE read rule:
--     * read (select): signed-in users who belong to a studio (current_org_id()
--       is set) — i.e. real Helm staff, not anonymous sessions or client links.
--     * NO insert / update / delete rule for anyone: only the owner (Dashboard →
--       Storage, which uses the service role) can upload or change manual files.
--
-- Additive + idempotent: creates the bucket if missing (or re-pins it private),
-- (re)creates one policy that only matches bucket_id = 'helm-manual'. No existing
-- bucket, object, table or row is touched. Upload of the files is an owner step
-- (docs/OWNER-ACTIONS-SECURITY.md → "User manual").
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('helm-manual', 'helm-manual', false, 5242880,
          array['text/html', 'image/webp', 'image/png', 'image/jpeg'])
  on conflict (id) do update set public = false, file_size_limit = 5242880,
          allowed_mime_types = array['text/html', 'image/webp', 'image/png', 'image/jpeg'];

drop policy if exists "helm_manual_staff_read" on storage.objects;
create policy "helm_manual_staff_read" on storage.objects for select to authenticated
  using ( bucket_id = 'helm-manual' and (select public.current_org_id()) is not null );

-- Verify after apply (read-only):
--   select id, public from storage.buckets where id = 'helm-manual';            -- public = false
--   select policyname, cmd, roles from pg_policies
--    where schemaname = 'storage' and tablename = 'objects' and policyname like 'helm_manual%';  -- one SELECT policy
-- ============================================================================
