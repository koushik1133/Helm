# Wave 15B — Master Remediation (status)

**Scope:** koushik1133/Helm · origin · localhost → STAGING (`xizehqgeyjcfpzrdymly`) · synthetic only.
**PRANEETH REPO — UNTOUCHED · WWW.HELM.EVENTS — UNTOUCHED · PRODUCTION DATABASE — UNTOUCHED.**

## Credential status
`HELM_E2E_STAGING_URL / STAGING_ANON / SERVICE_ROLE / PASSWORD` — **all MISSING** this session.
All runtime/staging workstreams are therefore **BLOCKED — LOCAL E2E CREDENTIALS REQUIRED**
(Phases 2 live A/B, 5 apply, 6 money-attack, 7 RBAC runtime, 9–20 lifecycle/a11y/responsive/
reliability/perf/privacy/cross-browser). No test was weakened to bypass the requirement.

## W15-001 — server pricing authority (money integrity)
- **Source proof (CONFIRMED):** `phase99` recomputes only on a top-level `subtotal`; the shipping
  payload (`quotes.html gatherPricing`, `flow.html saveQuotation`) nests `subtotal` under `computed`
  and sends a client `total`, so the client total is stored verbatim. Pinned by
  `test/d8-pricing-authority-gap.test.mjs`.
- **Canonical contract (Phase 3):** extracted the real engine `_canon` (store-api.js:689, locked
  rules D1/D4/D5/D7): preSvc → service charge → subtotal → fixed+% discount + coupon (capped) →
  GST on post-discount → round final only.
- **Differential gate (Phase 4, GREEN):** `test/pricing-differential.test.mjs` extracts the ACTUAL
  shipping `_canon`/`quoteTotal` and proves a server-canonical reference (derived from RAW INPUTS
  only) reproduces it to the rupee across **405 cases, 0 mismatches**, and ignores tampered
  `total`/`computed`. => recomputing server-side from raw inputs will NOT change any legitimate total.
- **Fix (Phase 5, SOURCE PREPARED — NOT APPLIED):** `supabase/wave15b/` — PRECHECK / UPGRADE /
  VERIFY / ROLLBACK. UPGRADE rewrites `helm_quote_total` to recompute from the canonical raw inputs
  the UI already sends (never `computed`/`total`), keeps the legacy top-level-subtotal path, is
  additive/idempotent/forward-only. VERIFY asserts shipping+legacy payloads on staging.
  **Runtime status: SQL GENERATED. Apply on STAGING + run VERIFY = BLOCKED (creds). Not for prod.**
- **Runtime A/B (Phase 2) & money-attack regression (Phase 6):** BLOCKED (creds). Design proven offline.

## W15-002 — can_edit()/has_area() divergence
- **Source proof (CONFIRMED):** `can_edit()` = admin/planner/sales/operations; `has_area` grants
  manager/coordinator edit; RPCs `close_event`/`set_closure`/`mark_paid`/`confirm_quote`/`set_plan_*`
  gate on `can_edit()` → manager/coordinator denied despite the matrix (fail-closed, not an exposure).
- **Classification:** ambiguous authority — the two mechanisms disagree and no authoritative product
  rule resolves whether manager is intended to have settlement/closure edit. **PRODUCT DECISION
  REQUIRED** (do not broaden `can_edit()` from inference). Runtime proof (Phase 7) BLOCKED (creds).

## Product decisions (unchanged — briefs only)
- **OVERPAYMENT PRODUCT DECISION REQUIRED** — `record_payment` checks only `amount>0`; overpayment
  silently accepted; `outstanding` is milestone-status-based (never negative, no credit).
- **LOST-UPDATE RISK — PRODUCT DECISION REQUIRED** — concurrent quote-metadata edits are last-write-wins.

## How to run the blocked workstreams
```
export HELM_E2E_STAGING_URL=…  HELM_E2E_STAGING_ANON=…  HELM_E2E_SERVICE_ROLE=…  HELM_E2E_PASSWORD=…
# apply the pricing fix to STAGING (never prod):
psql "$STAGING_DB_URL" -f supabase/wave15b/W15B-00-PRECHECK.sql
psql "$STAGING_DB_URL" -f supabase/wave15b/W15B-01-PRICING-UPGRADE.sql
psql "$STAGING_DB_URL" -f supabase/wave15b/W15B-02-VERIFY.sql
# then the full lifecycle + regression:
npm test && npm run test:e2e:lifecycle && npm run test:e2e
```

## Runtime verification on STAGING (2026-09-28)
Credentials restored; synthetic users reset to a valid password. Live results:
- **W15-001 — FIXED + VERIFIED.** Applied W15B-01 in the Supabase SQL editor; W15B-02 VERIFY passed. Re-ran the A/B as `planner`: real-UI tampered `total=1` now recomputes to **₹236,000** (was ₹1). Money-attack regression: tamper total→11800, discount cap→0, coupon 100%→0, negative discount/GST **rejected(400)**.
- **W15-002 — RUNTIME-CONFIRMED.** `manager` DENIED(42501) on `close_event`/`mark_paid`; `planner`/`sales` ALLOWED(200). Over-restriction (fail-closed) → product decision on intended manager authority.
- **Tenant isolation — VERIFIED.** Org-B `admin.b`: 0 rows reading an Org-A quote; 403/42501 on `save_quotation_version`+`mark_paid`.
- **OTP/approval — VERIFIED.** wrong→approved:false; correct→approved:true; replay→approved:false (single-use); 1 consent row; 5-wrong→`error:locked`.
- **Payment idempotency — VERIFIED.** same key→1 receipt; negatives rejected.
- **IDOR** 0 rows; **SQL injection** in `create_quote` stored as harmless literal (parameterized).
- **W15B-04 applied** (revoke_work_token/delete_quote live). **W15B-05-FOLLOWUP.sql** prepared (worker-RPC expiry/revoke enforcement, portal/proposal expiry, OTP CSPRNG, FK RESTRICT for quote_payments/quote_consents) — apply in the SQL editor, then re-test worker-token revocation.

Still open: apply W15B-05; product decisions (overpayment, lost-update, manager authority); full 3-browser regression; Strix grey-box. Production untouched throughout.

## W15B-05 applied + verified on STAGING (2026-09-28)
- Worker tokens: `worker_get_tasks` returns 401/42501 after `revoke_work_token` and when `expires_at` is past.
- Cascade-delete: `delete_quote` w/ paid row → 409; service_role direct DELETE of a quote with a payment → 409/23503 (FK RESTRICT). Ledger + consent protected.
- Portal/proposal expiry + OTP CSPRNG functions re-created cleanly.

## W15B-06 applied + verified on STAGING (2026-09-28) — residual pricing bypass CLOSED
Applied via psql (session pooler, ap-south-1). The residual W15-001 bypass (a client `total` with no
computable shape, previously stored verbatim) is now rejected at **every** layer:
- SQL: `helm_quote_total('{"total":999999}')` → **ERROR 22023** ("total without a computable shape").
- PostgREST RPC surface: same payload → **HTTP 400 / 22023**.
- Real save path: `save_quotation_version(quote, {total:999999})` as planner → **400/22023**; stored total held at 59000.
- Table trigger (defense-in-depth): owner-level `UPDATE quotes SET pricing='{"total":999999}'` → **22023**, rolled back.
- No regression: raw payload `{gstPct,guests,platePrice}` still computes 236000; legacy `{subtotal,gstPct}` still 118000.

## Adversarial security RE-TEST on STAGING (2026-09-28, post-W15B-06) — all PASS
- Tenant isolation: org-B `admin.b` sees **0** rows of an org-A quote; cross-tenant `save_quotation_version` → **403**.
- IDOR: `client.a` enumerates **0** quotes. anon reads **0** rows on quotes/profiles/quote_payments/leads/event_closure/work_tokens (RLS deny).
- Injection: `create_quote` with SQL payload stored as harmless literal; `quotes` table intact.
- Worker RPCs enforce `revoked_at`+`expires_at`; `delete_quote` has paid-row guard; FK `quote_payments`/`quote_consents` → quotes = **RESTRICT (r)**; `request_otp` uses `gen_random_bytes` (CSPRNG).

## RBAC evidence — leads INSERT (finding resolved as CONFIG, not a code defect)
- `leads` RLS: INSERT `with check (has_area('leads','edit') and org_id=current_org_id())` — correct deny-by-default + org scope.
- Root cause of "only admin can create leads": `role_access` in staging is seeded for area **`quotes` only** — there are
  **no `leads` rows**, so `has_area('leads',*)` is false for every non-admin (admin hardcoded true). The RLS is correct;
  the matrix is simply unseeded. Resolution = populate the matrix via Control Center (`admin_set_role_access`) — configuration.
- App defines 26 canonical areas (store-api.js AREAS); a client-side `VIEW_SCOPE` fallback governs sidebar visibility only
  (a cosmetic UI/DB divergence at most — the DB still denies). **Seeding the run-org matrix is pending user approval**
  (auto-mode classifier blocked the bulk config write).

## Product decisions — authoritative evidence (unchanged; decisions still required)
- **Overpayment**: `record_payment` checks only `amount>0`; no cap vs outstanding/total, no overpayment/credit guard anywhere → overpayment silently accepted, milestone marked paid.
- **W15-002 manager authority**: settlement/closure RPCs gate on `can_edit()` = admin/planner/sales/operations (hardcoded); the matrix `has_area` would grant manager — divergence is fail-closed. Matrix seed deliberately leaves manager **view-only** on settlement/closure to avoid contradicting the RPC.
- **Lost-update**: quote-metadata edits are last-write-wins (no optimistic-concurrency/version check).

## 3-browser regression on STAGING (2026-09-28)
- **chromium: 32 passed, 1 failed, 11 did-not-run.** The single failure is lifecycle **stage 01 (sales creates lead)** — the
  `leads:edit` matrix gap above; stages 02–12 are serial-dependent on it, so they did not run. All non-lifecycle specs
  (auth/smoke, roles, isolation/privacy, a11y, responsive @8 widths, reliability REL-01/04/10, approval) pass.
- firefox/webkit: (see run) — same single lifecycle-01 dependency expected.
- Once the matrix is seeded, the full continuous lifecycle (Lead→Closure) is expected green.
