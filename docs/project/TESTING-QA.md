# Helm — Testing & QA

How Helm is tested today, what each test layer covers, how the critical journeys are protected, and what to add next. Everything here was checked against the repo (`package.json`, `.github/workflows/`, `test/`, `tests/`, `scripts/db-test/`, `supabase/tests/`, `playwright.config.*`, `lighthouserc.json`). Related docs: `docs/DB-TEST-SUITE.md`, `docs/STAGING-A11Y-PERF-PLAN.md`, `docs/STAGING-REDTEAM-MATRIX.md`, `tests/staging/SPEC-CHECKLIST.md`, `tests/edge/EDGE-TEST-RESULTS.md`, `test/authz-tenant-isolation.NOT-TESTED.md`.

## 1. Test strategy at a glance

Helm has no build step and no framework. The front end is vanilla HTML/JS and most business rules live in Postgres (RLS, triggers, RPCs). Testing is split into layers, cheapest first:

| Layer | What it proves | Where | How to run | Needs secrets? |
|---|---|---|---|---|
| Static guards | No unsafe HTML sinks, pinned Actions, CSP hashes current, migration canon, OTP/env/JWT safety, deploy files static | `scripts/check-*.mjs`, `scripts/gen-*.mjs --check` | `npm run ci` (runs these, then `npm test`) | No |
| Unit / source tests (Node) | Front-end logic, page wiring, pricing, money display, RBAC UI gating, headers, routing | `test/*.test.mjs` (+ `tests/staging/env-routing.test.mjs`) | `npm test` | No |
| DB behavioral suites | Migrations apply clean and idempotently; RLS, RPCs, triggers, money and tenant rules | `scripts/db-test/run-all.sh`, `tests/db/*.sql` | `npm run test:db` (local disposable PG17) | No |
| DB staging suites | Overpayment concurrency, idempotency keys, ledger RLS, OTP race/lockout, tenant RBAC | `supabase/tests/*.sql`, `run-db-tests.sh`, `tests/db/tenant-isolation.mjs` | `bash supabase/tests/run-db-tests.sh`, `npm run test:isolation` | Yes (staging DB) |
| Edge function tests (Deno) | Each Supabase function's auth, CORS, limits, mocked providers | `tests/edge/*.test.ts` | Deno test with `tests/edge/import_map.json` | No (mocks) |
| End-to-end (Playwright) | Real browser flows against localhost pointing at STAGING | `tests/e2e/**` (27 spec files) | `npm run test:e2e` (+ tag variants) | Yes (staging) |
| Staging red-team / matrix | Authz matrix, tenant IDOR, payment red-team, token/OTP, storage, a11y/perf | `tests/staging/*.mjs` | `node tests/staging/run-security.mjs` etc. | Yes (staging) |
| Lighthouse | Performance/a11y budgets on public pages | `lighthouserc.json`, `tools/lhci` | via `lighthouse.yml` | No |
| Manual QA | Role-by-role click-through on staging | staging `helm-v01.vercel.app` | checklists in `docs/` and `tests/staging/SPEC-CHECKLIST.md` | Test accounts |

Rule written into the Playwright config: **no retries** (`retries: 0`), so a flaky pass can't hide a real failure. Mutation tests must never target prod. `run-db-tests.sh` refuses the production project ref.

## 2. Unit / Node tests (`npm test`)

- `npm test` chains **207 test files** in one `&&` chain: 206 in `test/` plus `tests/staging/env-routing.test.mjs`. `test/` has 245 `.mjs` files in total, so **about 39 files exist but are not wired into `npm test`** (e.g. `admin-ui-fixes`, `admin-ux-batch`, `builder-catalogue-*`, `builder-hardening`, `builder-pricing-guards`, `builder-tools`, `builder-versions`, `booklet-change-lines`).
- Because it is one `&&` chain, **the first failing file stops the run**, and later files never execute.
- Most tests are source-level: they read `public/*.html|js`, SQL and config, and assert on behaviour or structure. Some run small pure functions (pricing, money formatting, routing, headers).
- Groups worth knowing about:
  - **Money and pricing:** `money-trust-boundary`, `d8-pricing-authority-gap`, `pricing-differential(-extended)`, `per-currency-totals`, `country-tax`, `money-display-1024`, `dashboard-money`
  - **Security:** `otp-safety`, `token-lifecycle`, `jwt-roles`, `csp-hashes`, `headers-parity`, `injection-sinks`, `auth-session-hardening`, `edge-functions-hardening`, `upload-guard`, `upload-quarantine`, `hq-mfa`, `robots-policy`
  - **Roles:** `role-access-audit`, `sales-role-1017`, `manager-1019`, `staff-roles`
  - **Release rounds:** `audit-1017`, `retest-1017`, `retest2-1017`, `retest-1018`, `final-1022`, `staging-1026`, plus round-numbered files (`r3`…`r10`, `live-round1/2`)

## 3. Database tests

### 3a. Local canonical suite (`npm run test:db`)
`scripts/db-test/run-all.sh` builds a disposable PG17 cluster on 127.0.0.1:55439 (or uses CI's `PG*` service). It never touches staging or prod. It:
1. loads `supabase/test-harness/00-supabase-shim.sql`
2. applies every migration with `scripts/db-migrate.sh --apply` (clean install)
3. re-applies and asserts `applied=0` (**idempotency check**, in line with the additive-only migration rule)
4. loads the two-tenant fixture `10-fixtures.sql`, then runs **100 behavioral suites** from `tests/db/` (102 files: `.sql`, `.sh` concurrency scripts and `.mjs` parity checks). It reseeds before each suite and matches an exact `ALL PASS (n/n)` marker.

Ordering matters. The script runs some suites first (e.g. `audit-p2-0156`, `pending-fixes`) because later suites re-apply older migrations over newer function bodies.

### 3b. Staging DB suites (gated)
`supabase/tests/00..99-*.sql` cover overpayment concurrency, idempotency keys, the overpayment update path, ledger RLS, OTP race/lockout and tenant RBAC. `tests/db/tenant-isolation.mjs` covers cross-tenant reads. The runner refuses the prod ref and needs `HELM_TEST_ACK=1`. Note: `docs/DB-TEST-SUITE.md` still says these were "NOT YET EXECUTED". Assumption: they have since run on staging; confirm and update that doc.

## 4. Edge functions
`tests/edge/` has Deno tests for most functions in `supabase/functions/`: OTP, phone code, WhatsApp send, payment link, subscription checkout, Razorpay webhook, booklet snapshot, render-photo, mailers, verify-upload, CORS, limits. They use mocks, so no provider is called. Results are recorded in `tests/edge/EDGE-TEST-RESULTS.md`. Razorpay, SMS and WhatsApp are switched off in production. These tests check the fail-closed paths, not live delivery.

## 5. End-to-end (Playwright)
- Config: `playwright.config.*` uses `testDir ./tests/e2e`, a global setup that makes a storageState per role, 1 worker, not parallel, no retries, traces/screenshots kept on failure, projects for chromium, firefox and webkit, and `node server.js` on port 4173.
- **Target:** localhost served with an env-injected staging config. Never prod.
- Spec folders: `accessibility`, `approval` (2), `auth` (2), `coverage` (12), `environment`, `guide`, `lifecycle`, `privacy`, `reliability` (2), `responsive`, `roles`, `validation`, `workflow`. That is 27 specs in total.
- Tag scripts: `test:e2e:smoke`, `:security`, `:roles`, `:approval`, `:a11y` (uses `@axe-core/playwright`), `:responsive`, `:reliability`, `:privacy`, `:lifecycle`, plus a script per browser.

## 6. Lighthouse
`lighthouse.yml` runs pinned `@lhci/cli` from `tools/lhci` against `/`, `/login` and `/builder` (3 runs each).
- **Blocking budgets:** performance, accessibility, FCP, LCP, TBT and CLS, set about 15% below the scores measured on 2026-09-30.
- **Advisory only:** best-practices, SEO (budgeted on the landing page only) and TTI.
- Signed-in app pages such as `/dashboard` are **not** measured, because they redirect to login.

## 7. CI workflows (`.github/workflows/`)

| Workflow | Trigger | What it does | Gate |
|---|---|---|---|
| `ci.yml` | push, PR | JWT role check, `npm audit --audit-level=high`, pinned Actions, HTML sinks, inline styles, base immutable, capture host, deploy static, migration canon, OTP safety, … then the unit tests | always |
| `db-canonical-pg17.yml` | push, PR, manual | `npm ci` then `npm run test:db` on a postgres:17 service | always |
| `db-tests.yml` | push, PR, manual | staging DB suites + tenant isolation | skips unless staging secrets are present; refuses the prod ref |
| `e2e.yml` | push, PR, manual | Playwright, all browsers | `gate` job runs it only if the secrets `HELM_E2E_STAGING_URL`, `HELM_E2E_STAGING_ANON`, `HELM_E2E_EMAIL` and `HELM_E2E_PASSWORD` exist |
| `lighthouse.yml` | push, PR, manual | LHCI budgets | always |
| `codeql.yml` | push, PR, schedule | CodeQL static analysis | always |
| `secret-scan-history.yml` | weekly, manual | gitleaks over the full history (redacted) + JWT role check | always |

## 8. Critical journeys and how they are covered

| Journey | Unit (`test/`) | DB (`tests/db`, `supabase/tests`) | E2E / staging | Manual |
|---|---|---|---|---|
| Sign-in, signup confirm, OTP, lockout, 2FA | `auth-gate`, `auth-signup-confirm`, `otp-*`, `password-lockout-ui`, `privacy-pin-search-2fa` | `auth-hardening`, `auth-limits`, `50-otp-race-lockout` | `e2e/auth`, `staging/token-otp.mjs` | yes |
| Lead to quote (the quote is the event), naming, dates | `quote-naming`, `event-name`, `date-guard`, `quotes-confirm-ux` | `business-logic` | `e2e/workflow`, `e2e/lifecycle` | yes |
| Pricing authority (server-side D8), discounts, tax, currency | `d8-pricing-authority-gap`, `pricing-differential*`, `country-tax`, `per-currency-totals` | `d6-money-freeze`, `booklet-tax`, `country-tax-0089` | `staging/payment-redteam.mjs` | yes |
| Floor-plan builder 2D/3D, layout generator, reprice | `builder-*`, `layout-*`, `r8`–`r10`, `reprice-banner` | `item-specs`, `item-spec-parity.mjs` | `e2e/coverage` | yes |
| Client approval, booklet, portal | `approval-handler`, `client-booklet-ui`, `booklet-*` | `client-booklet`, `booklet-images` | `e2e/approval` | yes |
| Payments ledger, overpayment, client due | `money-trust-boundary`, `sim-pay-prod-ui` | `10/20/30/40-*`, `concurrency-overpay.sh`, `client-due-0160` | `staging/payment-redteam.mjs` | yes |
| Planning, run sheet, crew, inventory checkout | `crew-schedule-ui`, `ops-task-templates`, `checkout-shortage` | `crew-schedule-0161`, `checkout-overissue`, `checkout-shortage-0105`, `inv-fixes` | `e2e/coverage` | yes |
| Settlement / closure | `final-1022` | `business-logic`, `pending-fixes` | `e2e/lifecycle` | yes |
| RBAC per role, tenant isolation | `role-access-audit`, `jwt-roles`, `staff-roles` | `auth-matrix`, `grants-matrix`, `60-tenant-rbac`, `tenant-isolation.mjs` | `e2e/roles`, `staging/authz-matrix.mjs`, `staging/tenant-idor.mjs` | yes |
| Team chat, notifications | `chat-*`, `bell-panel`, `notif-deeplinks` | `chat-rls`, `chat-admin-fixes` | — | yes |
| Comms (email from notifications@helm.events, Reply-To set to the studio) | `comms-automation`, `invite-mailer`, `invite-flow` | `comms-automation` | `tests/edge/*mailer*` | yes |
| Theme (Emerald default, dark mode off) | `theme-green-light` | — | — | yes |

## 9. Recent staging QA rounds (summary)

Assumption: summarised from the owner's QA rounds and the round-named tests. The detailed notes live outside the repo.

- **Role click-throughs on staging (`helm-v01.vercel.app`):** admin, manager, planner, sales and crew **all passed**. Locked in by `role-access-audit`, `sales-role-1017`, `manager-1019` and `retest*`.
- **Fixes on 17 Oct**, each with a regression test in `npm test`:

| Fix | Test |
|---|---|
| Advance is now worked out on the **discounted** total | `money-display-1024` |
| Booklet shows the event's currency | `money-display-1024`, `per-currency-totals` |
| Dashboard period filter | `dashboard-period` |
| Crew calendar / schedule | `crew-schedule-ui`; DB side in `crew-schedule-0161` |
| Search everything | `search-everything` |
| Staging round wrap-up | `staging-1026` |

- **Not yet manually re-tested:** coordinator, supervisor, quality, operations, designer, client portal. Decision needed: whether these block the release.

## 10. Known failing / unreliable suites

| Suite | Status | Cause | Impact |
|---|---|---|---|
| `db-canonical-pg17.yml` (`npm run test:db`) | **Failing on `main`** | Assumption: one or more of the 100 suites is out of step with the latest migrations (exact pass-count markers or suite order), not a confirmed product bug | Main has no green DB signal. Fix before release. |
| `test/edge-functions-hardening.test.mjs` | **Fails locally** | Local checkout has a symlinked `supabase/functions` / worktree path the test does not resolve. Passes in a clean clone. | Because `npm test` is one `&&` chain, every test after it is skipped locally |
| `e2e.yml`, `db-tests.yml` | Skipped in CI unless secrets are set | Gated by design | No automated E2E signal until the staging secrets are added |
| `docs/DB-TEST-SUITE.md` | Says "NOT YET EXECUTED" | Doc is stale (Assumption) | Update after confirming |

## 11. Recommended next tests

1. **Get `db-canonical` green on main.** Find which suite fails, then fix the marker, the ordering, or the real bug. Make the check required on PRs.
2. **Make `edge-functions-hardening` path-safe.** Use `realpath` or `fs.realpathSync` so symlinked checkouts work.
3. **Run every test file even when one fails.** Replace the `&&` chain with a runner (e.g. `node --test test/` or a small loop) that runs all files and reports every failure. Then wire in, or delete, the ~39 orphaned `test/*.mjs` files.
4. **Turn on E2E in CI.** Add the four `HELM_E2E_*` staging secrets. Decision needed: whether E2E becomes required, or stays nightly only.
5. **E2E for the full lifecycle money path.** Discounted quote → advance on discounted total → payment recorded → settlement balance gate → close. Cover the open audit items too: the server balance gate on `close_event`, settlement reading the ledger, and inventory availability counting checkouts.
6. **Manual and E2E role passes for the untested roles:** coordinator, supervisor, quality, operations, designer, and client portal (booklet, approval and OTP).
7. **Authenticated Lighthouse** for `/dashboard`, `/quotes` and the builder, using a staging storageState.
8. **Visual regression** of the Emerald theme and booklet/PDF output for INR, AED and USD.
9. **Email check:** sender is `notifications@helm.events` and Reply-To is the studio email, using a test inbox on staging.
10. **Restore drill** from `DISASTER-RECOVERY-RUNBOOK.md` on staging, done once a quarter.
11. **Load test** (`npm run loadtest`) against staging before onboarding the first large studio.

Decision needed: which checks are required to merge to `main` (suggested: `ci`, `db-canonical`, `lighthouse`, CodeQL).
