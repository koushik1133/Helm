-- ============================================================================
-- invite-media-content-type-restrict.sql — server-side content-type gate for
-- the public 'invite-media' storage bucket (digital-invitation photos).
-- ============================================================================
-- STATUS: NOT APPLIED. Review on STAGING, verify, then PRODUCTION by hand.
--
-- FINDING (content-validation hardening, not a proven stored-XSS): the
-- 'invite-media' bucket (phase88) is PUBLIC-read and accepts any object a
-- signed-in manager uploads into their own org folder. Writes were gated only
-- by tenant-isolation RLS (phase88) — nothing on the SERVER constrained the
-- object's content-type or size. The client upload path (BPStore.sites.
-- uploadPhoto) now magic-byte-sniffs to an image allowlist (png/jpeg/webp/gif),
-- caps size at 8 MB, and stores under a random key — but that is CLIENT-side
-- defence. This file adds the matching SERVER-side gate so a request that
-- bypasses the app (direct Storage API call) still cannot register a
-- non-image / oversized object in the bucket.
--
-- WHAT THIS DOES: sets `allowed_mime_types` + `file_size_limit` on the bucket
-- row. Supabase Storage rejects an upload whose DECLARED content-type is not in
-- the allowlist, or whose size exceeds the cap, at the API boundary (HTTP 400).
-- NOTE: this checks the client-DECLARED content-type, not the magic bytes — the
-- byte-level sniff stays in the app as defence-in-depth. The two together mean
-- a non-image is rejected both by its bytes (app) and, if it lies about its
-- type to the raw API, bounded by the server cap + type gate.
--
-- SAFE: additive + forward-only + idempotent. Touches ONLY the single
-- 'invite-media' bucket row; no object is moved, rewritten or deleted; no other
-- bucket, table, policy or tenant is touched. Legitimate image uploads
-- (png/jpeg/webp/gif ≤ 8 MB) are unaffected. Rollback clears the two columns.
-- Run once in the Supabase SQL editor (service role).
-- ============================================================================

-- ---- PRECHECK (read-only): current gate on the bucket -----------------------
-- Expect (pre-apply): public = true, allowed_mime_types = NULL,
--                     file_size_limit = NULL.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'invite-media';

-- ---- APPLY (additive, forward-only, idempotent) -----------------------------
-- 8 MB == 8 * 1024 * 1024 == 8388608 bytes (mirrors INVITE_IMG_MAX in store-api.js).
update storage.buckets
   set allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif'],
       file_size_limit    = 8388608
 where id = 'invite-media';

-- ---- VERIFY (read-only): the gate is now in place ---------------------------
-- Expect: file_size_limit = 8388608 and allowed_mime_types =
--         {image/png,image/jpeg,image/webp,image/gif}.
select id, public, file_size_limit, allowed_mime_types
from storage.buckets
where id = 'invite-media';

-- ---- ROLLBACK (only if required; restores the pre-apply open state) ---------
-- update storage.buckets
--    set allowed_mime_types = null,
--        file_size_limit    = null
--  where id = 'invite-media';
-- ============================================================================
