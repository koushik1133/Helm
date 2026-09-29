-- =====================================================================
-- INDEX-REVIEW.sql  —  PROPOSED additive index migration
-- Database / Scalability: fill missing indexes on hot RLS-scoped tables.
--
-- STATUS: PROPOSED — do NOT auto-apply. Coordinator applies.
-- ROLLOUT: apply on STAGING (xizehqgeyjcfpzrdymly) first, verify, then prod.
-- SAFETY:  100% additive + idempotent (CREATE INDEX IF NOT EXISTS).
--          Nothing is dropped or altered. No data is touched.
-- LOCKING: plain CREATE INDEX briefly locks the table for WRITES.
--          For PRODUCTION prefer the CONCURRENTLY variants at the bottom
--          (no long write lock; must run OUTSIDE a transaction block).
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRECHECK — list existing indexes on the affected tables before applying
-- ---------------------------------------------------------------------
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('notifications', 'leads', 'quotes')
ORDER BY tablename, indexname;

-- ---------------------------------------------------------------------
-- STANDARD VARIANT (staging / low-traffic windows)
--   Brief write lock per table. Safe to run inside one transaction.
-- ---------------------------------------------------------------------

-- notifications feed: per-org, newest first (highest seq_scan table).
CREATE INDEX IF NOT EXISTS ix_notifications_org_created
  ON public.notifications (org_id, created_at DESC);

-- notifications per-event lookup: quote_id column exists but had no index.
CREATE INDEX IF NOT EXISTS ix_notifications_quote
  ON public.notifications (quote_id);

-- leads board/filter by status within an org (existing status idx is org-blind).
CREATE INDEX IF NOT EXISTS ix_leads_org_status
  ON public.leads (org_id, status);

-- leads default list: org-scoped, ordered by updated_at DESC.
CREATE INDEX IF NOT EXISTS ix_leads_org_updated
  ON public.leads (org_id, updated_at DESC);

-- quotes pipeline grouped by lifecycle_stage within org (no lifecycle index today).
CREATE INDEX IF NOT EXISTS ix_quotes_org_lifecycle
  ON public.quotes (org_id, lifecycle_stage);

-- quotes calendar / upcoming events: org-scoped, filter/sort on event_date
-- (existing event_date idx is org-blind).
CREATE INDEX IF NOT EXISTS ix_quotes_org_event_date
  ON public.quotes (org_id, event_date);

-- ---------------------------------------------------------------------
-- VERIFY — confirm all six new indexes now exist
-- ---------------------------------------------------------------------
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'ix_notifications_org_created',
    'ix_notifications_quote',
    'ix_leads_org_status',
    'ix_leads_org_updated',
    'ix_quotes_org_lifecycle',
    'ix_quotes_org_event_date'
  )
ORDER BY indexname;
-- Expect 6 rows.

-- =====================================================================
-- PRODUCTION VARIANT — CONCURRENTLY (no long write lock)
-- Run these INSTEAD of the standard block on prod.
-- Each must run on its own, OUTSIDE any transaction block (no BEGIN/COMMIT).
-- IF NOT EXISTS keeps them idempotent. If one fails midway it can leave an
-- INVALID index; drop it (DROP INDEX CONCURRENTLY IF EXISTS <name>) and retry.
-- =====================================================================
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_notifications_org_created
--   ON public.notifications (org_id, created_at DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_notifications_quote
--   ON public.notifications (quote_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_leads_org_status
--   ON public.leads (org_id, status);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_leads_org_updated
--   ON public.leads (org_id, updated_at DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_quotes_org_lifecycle
--   ON public.quotes (org_id, lifecycle_stage);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_quotes_org_event_date
--   ON public.quotes (org_id, event_date);
