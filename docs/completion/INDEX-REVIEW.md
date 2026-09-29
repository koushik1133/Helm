# Index Review — Database / Scalability (STAGING analysis)

**Scope:** READ-ONLY analysis on Helm **staging** (`xizehqgeyjcfpzrdymly`). Production was NOT touched.
**Date:** 2026-09-29
**Goal:** Find missing indexes on hot, RLS-scoped tables and propose an **additive** migration. Migration is NOT applied here — the coordinator applies it.

## Method

1. Dumped every existing index: `pg_indexes` (schema `public`).
2. Checked the hot RLS-scoped tables for a btree index on `org_id` (every RLS policy filters `org_id = current_org_id()`) and on common join/filter/order columns.
3. Pulled sequential-scan evidence: `pg_stat_user_tables` ordered by `seq_scan`.

## Overall finding

The schema is **already well indexed**. Almost every table has a dedicated `<table>_org_idx` on `org_id` and a `_quote_idx` on the child `quote_id`. So the classic gaps (no org_id index → full-table scan under RLS) mostly do **not** exist here.

The remaining gaps are narrower: a few hot tables have **single-column** indexes on a filter column (`status`, `event_date`, `updated_at`) that are **not org-scoped**, and `notifications` — the single highest seq-scan table — is missing an ordering index and a `quote_id` index despite carrying that column.

## Seq-scan evidence (top of `pg_stat_user_tables`)

| table | seq_scan | idx_scan | n_live_tup | note |
|---|---:|---:|---:|---|
| notifications | 775 | 56 | 306 | **Highest seq_scan.** Only `org_idx` + pkey. No ordering index, no `quote_id` index (column exists). |
| leads | 604 | 753 | 271 | `status`/`updated_at` indexes are NOT org-scoped. |
| quotes | 509 | 6514 | 300 | `status`/`event_date` indexes NOT org-scoped; no `lifecycle_stage` index at all. |
| profiles | 64 | 115696 | 18 | Healthy (index-driven). |
| role_access | 37 | 19341 | 88 | Healthy. |
| quote_otps | 27 | 1676 | 750 | Already has `otp_quote_idx` + `org_idx`. Fine. |

(Staging row counts are small, so the planner will still pick seq scans for tiny tables regardless of indexes — these indexes matter at production data volumes. The proposals are chosen for the query shapes the app actually issues, not the current staging cardinality.)

## Confirmed gaps → proposed additive indexes

All proposed indexes are **additive** and `IF NOT EXISTS`. None drop or alter anything.

1. **`ix_notifications_org_created`** — `notifications(org_id, created_at DESC)`
   Notifications feed is listed per org, newest first. Highest-seq-scan table; today only `org_id` alone is indexed so ordering falls back to a sort over a scan.

2. **`ix_notifications_quote`** — `notifications(quote_id)`
   `notifications.quote_id` exists but has **no index** (unlike every other child table, which all have a `_quote_idx`). Per-event notification lookups scan the table.

3. **`ix_leads_org_status`** — `leads(org_id, status)`
   Existing `leads_status_idx` is on `status` alone — not org-scoped, so under RLS it can't serve the common "leads in this org with status = X" board/filter query on the leading `org_id` predicate.

4. **`ix_leads_org_updated`** — `leads(org_id, updated_at DESC)`
   Existing `leads_updated_idx` is `updated_at` alone. The default leads list is org-scoped and ordered by `updated_at DESC`; a composite serves both filter and order.

5. **`ix_quotes_org_lifecycle`** — `quotes(org_id, lifecycle_stage)`
   `quotes` has **no index on `lifecycle_stage`** at all. The pipeline/board groups events by lifecycle stage within an org.

6. **`ix_quotes_org_event_date`** — `quotes(org_id, event_date)`
   Existing `quotes_event_date_idx` is `event_date` alone (not org-scoped). Calendar / upcoming-events views filter by org and range/sort on `event_date`.

### Deliberately NOT proposed
- New `org_id`-only indexes: already present on every hot table.
- `quote_payments`, `event_tasks`, `quotation_versions`, `event_discovery`, `event_plan`, `layouts`, `crew_members`, `inventory_items`, `vendors`: all already carry `org_idx` (+ `quote_idx` where child), covering the RLS predicate and the common lookups. No change recommended.

## Rollout guidance

- **Apply on staging first, then prod** after verifying the planner uses them and no regressions appear.
- `CREATE INDEX` briefly **locks the table for writes**. On production, prefer the `CREATE INDEX CONCURRENTLY` variants (provided in the `.sql`), which do not take a long write lock. Note: `CONCURRENTLY` cannot run inside a transaction block, so run those statements one-by-one, outside any `BEGIN/COMMIT`.
- All statements are `IF NOT EXISTS`, so re-running is safe/idempotent.

Companion migration: `supabase/completion/INDEX-REVIEW.sql`.
