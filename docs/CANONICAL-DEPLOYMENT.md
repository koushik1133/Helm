# Helm — Canonical Database Deployment

This is the **single sanctioned way** to stand up or forward-migrate the Helm database.
It replaces the previously ambiguous, hand-run mix of `setup-all.sql`,
`full-schema/complete-setup.sql` and loose `phaseNN-name.sql` files (those are
historical/reference only; `complete-setup.sql` is **deprecated — do not run**, it
reverts tenant isolation).

## Mechanism

- **Manifest:** `supabase/migrations/MANIFEST` lists, in order, the `base` snapshot
  (fresh installs only) and the `forward` hardening migrations (always, idempotent).
- **Runner:** `scripts/db-migrate.sh` (`--plan` | `--apply` | `--verify`). It keeps a
  ledger table `public.helm_schema_migrations` (filename + sha256 + applied_at), so:
  - already-applied files are skipped (idempotent re-runs),
  - a file whose bytes changed after being applied is a **drift error** (author a new
    forward migration instead of editing an applied one),
  - on a non-fresh DB (prod/staging) the `base` is skipped — only forward migrations run.
- **No vulnerable `CREATE OR REPLACE` can silently clobber a newer definition**, because
  only MANIFEST files run, in order, and hardening is always last.

## Canonical base provenance (IMMUTABLE)

`supabase/canonical-base/base-v1-2026-09-25.sql` **derives from a 2026-09-25
production-faithful schema extraction. It is schema-only (zero data, zero auth users,
zero secrets, no environment-specific identities, RLS-gated Supabase-standard grants)
and is IMMUTABLE.** Validated on PostgreSQL 17: a fresh load has 0 rows in
organizations/profiles/quotes/auth.users/quote_payments/quote_otps.

**Never modify base-v1 after checkpoint.** All future schema changes are new
forward migrations (`0006`, `0007`, …). A new baseline, if ever needed, is a new
immutable snapshot (`base-v2-<date>.sql`), never an edit of base-v1.
(`supabase/HELM-STAGING-SCHEMA.sql` is the staging-provisioning twin of the same body.)

## Forward migrations (security + money integrity)

| # | File | Closes |
|---|------|--------|
| 0001 | pricing_authority | client-total pricing bypass (recompute / fail-closed) |
| 0002 | create_helm_user_lockdown | anon/staff admin-takeover via create_helm_user |
| 0003 | money_integrity | overpayment TOCTOU + ledger-only total (advisory lock) |
| 0004 | tenant_integrity | cross-tenant proposal/portal (F2) + quote↔org reject trigger (G4) |
| 0005 | least_privilege | PUBLIC/anon EXECUTE leakage (F4/F5) + default privileges (G5) |
| 0006 | rls_access_gates | layouts has_area (SEC-02), profiles leak (SEC-03), coupons (SEC-04) |
| 0007 | rpc_authz_guards | mark_paid role (F11), verify-column guard (F12), has_area RPC guards (F10) |

## Local verification

`npm run test:db` rebuilds a disposable PG17 cluster, applies the canonical path
(fresh + idempotent), and runs the behavioral suites: pricing-parity, auth-matrix,
tenant-attack, g4-coverage, grants-matrix, concurrency. CI runs the same on a
`postgres:17` service (`.github/workflows/db-canonical-pg17.yml`).

## Staging / production

Never run the test harness (`supabase/test-harness/*`) against staging or production —
Supabase already provides the `auth`/`storage` schema and roles. On an existing DB the
runner applies only forward migrations. Production rollout is gated behind an explicit
release pack + owner approval (not covered here).
