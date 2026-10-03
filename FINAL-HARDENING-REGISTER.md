# FINAL-HARDENING-REGISTER.md — Phase 1 Reality Lock

**Program:** Pre-React hardening of Helm. **Phase 1 = READ-ONLY** (this document changed no source/schema).
**Date:** 2026-10-01

## Reality lock (verified this phase)

| Fact | Value | Evidence |
|---|---|---|
| origin/main SHA | `ff2512661427ee91f5a8e8f11b900fd76a9b6fe9` | `git rev-parse origin/main` |
| Local HEAD | `651cbe60b0462a0a6752c6d67219ef9059bd83c8` (branch `harden/payment-otp-rls-2026-10`) | `git rev-parse HEAD` |
| HEAD vs origin/main | **+1 ahead, 0 behind** (the committed B2 advisory-lock) | `git rev-list --left-right --count` |
| Local `main` | also at `651cbe6`, ahead of origin by 1, **unpushed** | `git branch -vv` |
| Uncommitted paths | **24** (8 modified, 16 untracked) | `git status` |
| npm ci | OK | ran |
| npm audit | **0 vulnerabilities** | ran |
| npm test (working tree) | **EXIT 0, 20 files green** | ran |
| **npm run ci (working tree)** | **EXIT 1 — FAIL** (OTP-safety flags `supabase/tests/50-otp-race-lockout.sql:142,158`) | ran |
| Local Postgres | **14.23** (prod = PG17); Docker installed but **not running** | `postgres --version` |
| Staging/test-DB creds | **all UNSET** in env | `printenv` |
| Auto-apply SQL mechanism | **NONE** — no `config.toml`, no `migrations/`, CI runs no psql/db push, `setup-all.sql` references none of security-fix/wave15b/harden | verified |
| Canonical install path | **ambiguous**: `setup-all.sql` (137-line one-file bootstrap) ∥ `full-schema/` (56 files) ∥ `phaseNN` ∥ unwired `wave*/security-fix/` | verified |

## Existing local hardening (DO NOT duplicate — reconcile)

- `supabase/harden-2026-10/`: H01 overpayment INSERT+UPDATE+FOR UPDATE lock · H02 OTP row lock · H03b milestone RESTRICTIVE RLS · H04 ledger-only total · H05 financial FK · H06 qp org-read guard · H07 22 indexes. (uncommitted)
- `supabase/prod-fix/`: B2 overpayment advisory lock (**committed @651cbe6**) · B5 record_settlement_payment · C2b OTP lockout · PROD-FINAL-DB-ADDS · W15-002/002b settlement-closure matrix · create-helm-user-token-columns-fix (login-500 fix, NOT the SEC-01 anon-revoke) · invite-media-content-type-restrict. (mostly uncommitted)
- `supabase/wave15b/` (in ff25126): W15B-01 pricing recompute + W15B-06 reject-unshaped-total — **the pricing-authority fix**, headers say "STAGING ONLY". (committed, unwired)
- `supabase/security-fix/SEC-01..07` (in ff25126): the DB security pass. (committed, unwired)
- Tests: `tests/db/tenant-isolation.mjs`, `tests/db/rest-ledger-rls.mjs`, `supabase/tests/*` harness, `tests/e2e/auth/login-regression.spec.mjs`, `test/capability-aware-errors.test.mjs`, `test/invite-media-hardening.test.mjs`. (uncommitted)

> **Key reconciliation:** the *fixes largely exist* already. The gaps are (a) they are not wired into a deterministic canonical deployment, (b) the pricing fix is staging-only, (c) runtime/behavioral proof is missing, (d) the local test harness breaks `npm run ci`.

## Issue register

| ID | Area | Current problem | Root cause | Existing fix? | Files | Tests | Runtime state | Priority |
|---|---|---|---|---|---|---|---|---|
| H-P1 | Pricing authority | `helm_quote_total` returns client `total` when no top-level `subtotal`; real UI sends that shape → client sets arbitrary total | phase99 guard keyed on wrong payload field | **Yes, unwired/staging-only** (wave15b W15B-01/06) | `supabase/phase99-*.sql`, `supabase/wave15b/*` | `test/d8-pricing-authority-gap` (pins bug OPEN); need real-shape regression test | OPEN (source), UNKNOWN (prod) | **P0/P1** |
| H-P2 | create_helm_user | DEFINER + PUBLIC/anon default EXECUTE, no canonical revoke → anon admin takeover | fix only in standalone SEC-01, not canonical | **Yes, unwired** (SEC-01) | `setup-all.sql:85`, `full-schema/01-*`, `security-fix/SEC-01-*` | need anon/staff/admin/cross-org tests | OPEN on clean deploy; staging "exploitable 2026-09-29" | **P1 (CRITICAL class)** |
| H-P3 | Overpayment TOCTOU | SELECT-sum→check→insert with no lock → concurrent inserts overpay | money triggers lack row/advisory lock in canonical | **Yes** B2 committed + H01 uncommitted, but **unwired into canonical** | `prod-fix/B2-*`, `harden-2026-10/H01-*` | need genuine 2-session concurrency test | B2 committed(local) not on prod; prod UNKNOWN | **P1** |
| H-P4 | Cross-tenant F2 | proposal/portal lack `org_id=q.org_id`; can plant/leak across orgs | tenant match only in SEC-05 F2 (unwired); wave10 body wins | **Yes, unwired** (SEC-05 F2) | `security-fix/SEC-05-*`, `wave10/*`, `phase53/58` | need 2-tenant suite | OPEN on clean deploy | **P1** |
| H-P5 | quote↔org integrity (G4) | only `tg_org_from_quote` fills null; never rejects forged org on foreign quote_id | hard reject trigger only in SEC-07 G4 (unwired) | **Yes, unwired** (SEC-07 G4) | `security-fix/SEC-07-*` | 2-tenant row-planting test | OPEN on clean deploy | **P1** |
| H-P6 | Canonical deployment | SEC/wave fixes not in any deterministic path; re-running wave10/PROD-01 clobbers SEC-05 (ordering foot-gun) | no migrations ledger/order | **No** (must design) | (new `supabase/migrations/`) | clean-install + idempotency test | n/a | **P1 (process)** |
| H-P7 | Grants / least-privilege | PUBLIC default EXECUTE; helm_total_paid/_flag anon-readable | comprehensive revoke only in SEC-05 F5 / SEC-07 G5 (unwired) | **Yes, unwired** | `security-fix/SEC-05/07` | grant assertion test | OPEN on clean deploy | **P2** |
| H-P8 | layouts has_area | org-scoped but no `has_area` gate (committed) | area gate only in SEC-02 (unwired) | **Yes, unwired** | `phase89`, `security-fix/SEC-02` | role-matrix test | within-org MED | **P2** |
| H-P9 | invite-media storage | public bucket + client `file.type` trust (both trees) | MIME/size = dashboard action (F6 FAIL on staging) | partial | `security-fix/SEC-05 F6`, `prod-fix/invite-media-*` | upload tests | PARTIAL | **P2** |
| H-P10 | Pricing/tenant tests | characterize bugs instead of preventing them; tenant-isolation = NOT-TESTED placeholder | tests written to pass against current (buggy) behavior | partial (`tests/db/tenant-isolation.mjs` local, unwired) | `test/*`, `tests/db/*` | replace with FAIL-before/PASS-after | n/a | **P2** |
| H-P11 | CI determinism | `npm run ci` RED: OTP-safety flags local test fixture as hardcoded PIN | scanner lacks test-fixture allowlist | **No** | `scripts/check-otp-safety.mjs`, `supabase/tests/50-*` | re-run ci green | n/a | **P2** |
| H-P12 | helm_total_paid double-count | sums ledger + milestone for same cash | two representations of one payment | **Yes, unwired** (H04 ledger-only) | `harden-2026-10/H04-*` | reconciliation test | fails-safe | **P3** |
| H-P13 | style-src unsafe-inline | remains in CSP | inline styles not hashed/extracted | No | `vercel.json`, `server.js`, `_headers` | csp test | n/a | **P3** |
| H-P14 | doc drift / placeholders | `_headers` comment claims unsafe-inline (false); security.txt placeholder mailbox; react-poc/ reappeared | housekeeping | No | `public/_headers`, `.well-known/security.txt`, `react-poc/` | n/a | n/a | **P3** |

## New issues found in Phase 1 (not on the prior list)
- **N1 (P2):** `npm run ci` is RED on the working tree — the uncommitted `supabase/tests/50-otp-race-lockout.sql` trips `check-otp-safety` (PR-AUTH-01). CI cannot be a reliable gate until fixed.
- **N2 (P3):** `react-poc/` is present again as untracked despite being "discarded"; needs cleanup decision (maintainability).
- **N3 (process):** local PG is 14.23 not 17; no staging creds in env — constrains runtime-maturity evidence (see exit gate).

## Rollback strategy (program-level)
- All Phase 2 source work on a dedicated branch off the current tip; no force-push, no history rewrite.
- Every new canonical migration ships PRECHECK + APPLY (idempotent) + VERIFY + ROLLBACK/compensation.
- No production APPLY without the PRODUCTION-RELEASE-PACK and explicit user authorization.
- Existing uncommitted work is preserved (reconciled, not overwritten).

## Phase 1 EXIT GATE status
- [x] current SHA known · [x] known problems verified in current source (H-P1,P2,P4,P5 verified firsthand; P3 reconciled) · [x] dependency/ordering graph documented · [x] exact files/functions identified · [x] rollback strategy defined · [x] baseline tests recorded (npm test green, **npm run ci RED**).
- **Blockers for later phases (need user decision):** (1) staging creds for Phase 3 staging + Phase 5 prod precheck; (2) PG17 vs PG14 vs Docker for DB behavioral tests; (3) confirm canonical-migration direction + target branch.
