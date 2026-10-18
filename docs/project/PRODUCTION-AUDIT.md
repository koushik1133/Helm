# Helm — Final Production Readiness Audit

**Date:** 2026-10-17 · **Audited code:** `origin/main` at `0bf8eb05` (PR #170 "release/oct17-final"), and the two follow-up merges now on main (`59ac63c9` PR #172 "Pre-launch fixes 1027", `da5204f6` PR #171 "landing portal reel").
**Targets:** production `helm.events` (and `www.helm.events`), staging `helm-v01.vercel.app` (Supabase project `xizehqgeyjcfpzrdymly`).
**Method:** I read the code, migrations, CI results (GitHub Actions run history via `gh`) and the existing audit documents. I did **not** run anything against production and changed no app code. Where I only have a document's word for something, I say so.

Related documents this audit builds on:
`PRODUCTION-READINESS-E2E-AUDIT.md` (3 Oct), `FINAL-HARDENING-REGISTER.md` (1 Oct), `docs/ops/SECURITY-AUDIT-2026-10-17.md` (AUD-1017), `docs/ops/GAP-AUDIT-2026-10-16.md` (notifications), `docs/project/TESTING-QA.md`, `docs/RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/CANONICAL-DEPLOYMENT.md`.

---

## 1. Verdict

### READY WITH WARNINGS

Helm can go live on `helm.events` for the core studio flow (lead → quote/event → builder → client approval → payments recorded by hand → planning/crew → settlement → closure). No open Critical or High security finding was found. The serious money and closure bugs from the 3 Oct audit are now fixed in the canonical migrations.

The warnings are:

1. **The canonical database test suite is red on main** (7 suites fail). Until someone triages it, we can't say for sure that the latest migrations still pass every rule they used to pass. This is the biggest warning. It must be triaged before the push (see section 4, fix R1).
2. **Production SQL must be brought up to date** before or with the code push. That includes `0162_launch_bypass_off.sql`, which is production-only.
3. **Owner security actions** are still open: accounts on default passwords, private repos, Supabase auth settings.
4. Some roles (coordinator, supervisor, quality, operations, designer) and the client portal **have not been re-tested by hand** on staging since the last round of fixes.

The two PRs that were pending when this audit was asked for are now **merged to main**: "Pre-launch fixes 1027" (`f5502710`, discount kept and shown on Save quotation, "Booking confirmed" wording, approval waits for advance) and the landing portal reel (`2f34a7af`). Before the push, someone still has to confirm that the CI runs on that head commit (`da5204f6`) finished green. They were still running when this was written.

---

## 2. Evidence used

| Source | What it shows | Date |
|---|---|---|
| GitHub Actions, `main` | CI, CodeQL, E2E (staging-gated) and DB tests (staging-gated) **green** on `0bf8eb05`. Lighthouse green on `0bf8eb05`, red on the earlier `82089c51`. **DB canonical (PG17) red.** `secret-scan-history.yml` red with "workflow file issue". | 2026-10-17/18 |
| `docs/ops/SECURITY-AUDIT-2026-10-17.md` | 14 findings: 1 High, 2 Medium and 3 Low fixed (0146); the rest accepted or deferred; no open Critical/High | 2026-10-17 |
| `PRODUCTION-READINESS-E2E-AUDIT.md` | Earlier P1s: settlement Received, close gate, inventory over-issue | 2026-10-03 |
| `test/staging-1026.test.mjs`, `test/prelaunch-1027.test.mjs` (in PR #172) | Regression tests for the last two staging QA rounds | 2026-10-17 |
| `docs/project/TESTING-QA.md` | Test layers, coverage map, known failing suites | 2026-10-17 |
| `docs/ops/GAP-AUDIT-2026-10-16.md` | Which notification channels are working, dormant or missing | 2026-10-16 |
| Code reads | `public/config.js`, `vercel.json`, `supabase/migrations/0049`, `0156`, `0162`, `public/store-api.js` | this audit |

---

## 3. Findings by severity

Severity scale: **Critical** = data loss, cross-studio exposure or money corruption is possible now. **High** = launch blocker. **Medium** = fix before or right after launch. **Low** = known, accepted or cosmetic.

### Critical
None found.

### High

| ID | Finding | Evidence | Required action |
|---|---|---|---|
| H1 | **DB canonical suite fails on main.** Failing suites: `DB-GATES-0049` (3), `LIFECYCLE-REAPPROVAL-0052` (2), `BUSINESS-LOGIC` (3), `TRIAL-REMINDERS` (1), `HQ-SUBSCRIPTIONS` (1), `RESCORE2-FIXES` (1), `NOTIFICATION-PREFS` (1). There are also cascade errors in `audit-run2.sql` ("current transaction is aborted"). None of the last 30 runs of this workflow passed. | Actions run 39081094099 on `0bf8eb05`; also red on `82089c51` | Triage before the push (fix R1). **Assumption:** most of these are stale expectations, because later migrations deliberately changed behaviour (for example 0156 made reopening admin-only, and 0159/0162 changed the trial/bypass rules). That is not proven. `DB-GATES-0049` covers the close-with-balance gate, and `BUSINESS-LOGIC` covers core money rules, so each failure must be explained before launch. |
| H2 | **Production database must match the code being pushed.** The front end on main expects migrations up to `0162` (for example 0160 client Due counts confirmed events only, 0161 crew schedule). | `supabase/migrations/0160..0162`, `supabase/APPLY-0160-0161.sql`, `supabase/APPLY-0162.sql` | Apply the pending APPLY bundles to prod in order, using `docs/CANONICAL-DEPLOYMENT.md` and the SQL tracker. `0162` is **prod only**: staging keeps the "Skip payment (testing only)" bypass. Check every verify row says ok. |

### Medium

| ID | Finding | Evidence | Required action |
|---|---|---|---|
| M1 | Studio accounts still use the **published default passwords** (owner reminder list) | memory/owner reminders; `docs/OWNER-ACTIONS-SECURITY.md` | Owner resets or deletes them before announcing launch |
| M2 | **Secret-history scan workflow is broken** ("workflow file issue"), so the weekly full-history gitleaks check isn't running. Per-push gitleaks in `ci.yml` still runs. | Actions run 39081933014 | Fix the YAML (fix R3). Not a code leak, but it turns off a safety net. |
| M3 | **Live cross-studio probe never run.** Isolation is proven from source and app-layer checks, plus the staging-gated `db-tests` (green). It is not proven by raw PostgREST/storage/realtime requests with two studio tokens. | SECURITY-AUDIT-2026-10-17 §Method, owner action 3 | Do the manual two-studio probe (section 6, check 8) |
| M4 | Privileged catalog check (every `org_id` table has RLS; no anon EXECUTE on sensitive functions) is not recorded as done on prod | SECURITY-AUDIT-2026-10-17 owner action 2 | Run it on staging and prod (section 6, check 7) |
| M5 | **Roles not re-tested by hand** since the 1017–1027 fixes: coordinator, supervisor, quality, operations, designer, client portal | `docs/project/TESTING-QA.md` §9 | Click-through on staging, or **Decision needed:** accept the risk for launch |
| M6 | RBAC divergence: some pages gate on coarse keys or hard-coded role lists (`reports.html`/`insights.html`), and finance P&L hiding is partly client-side | PRODUCTION-READINESS-E2E-AUDIT P2-1/P2-2 (W15-002) | **Assumption:** partly addressed by later role fixes (`role-access-audit`, `planner-1023`). Not re-verified here. **Decision needed:** confirm RLS on summary/P&L calls is enough. |
| M7 | Invite e-mails depend on `invite-mailer` being deployed with secrets. On staging it was not deployed, so only copy-link works. | SECURITY-AUDIT #8, GAP-AUDIT | Deploy mailers on prod with sender `notifications@helm.events` and Reply-To set to the studio's email, then test (section 6, check 10) |

### Low / accepted

| ID | Finding | Status |
|---|---|---|
| L1 | `config.js` defaults to the prod project if `config.staging.js` fails to load on staging | Accepted. CSP `connect-src` on staging pins staging. A host-to-project assertion is a later improvement. |
| L2 | Trusted Types loaded but not enforced; `style-src-attr 'unsafe-inline'` | Accepted. Output encoding plus the `check-html-sinks` CI guard are the control. |
| L3 | Events CSV "stage" column shows the lead stage, not the event status | Accepted UX item |
| L4 | Confirmed events have no start time; calendar conflicts are date-based only | Deferred (time-aware calendar) |
| L5 | `/site.webmanifest` 404 in console | Accepted |
| L6 | Catering GST % setting is saved but not applied separately | **Decision needed:** wire it up or remove it (E2E audit P2-3) |
| L7 | Some notifications are "missing" or "dormant": run-sheet/checklist change pings, crew "link updated" push, in-app WhatsApp send button | GAP-AUDIT. Not a launch blocker while WhatsApp and SMS are off. |
| L8 | About 39 `test/*.mjs` files are not wired into `npm test`. The `&&` chain stops at the first failure. | TESTING-QA §2, §11 |

### Closed since the 3 Oct audit (verified in code)

| Earlier finding | Now |
|---|---|
| P1-1 Settlement "Received" read milestones only | `public/store-api.js` (~line 6605) now counts settlement payments written to `quote_payments` |
| P1-2 `close_event` had no server balance gate | `0049_db_gates.sql`: close refuses while the client still owes, unless there is an override with a 5–1000 character reason, which is logged to `event_close_overrides` and `audit_log`. `0156` makes reopening admin-only through `reopen_event`. |
| P1-3 Inventory over-issue | Checkout guard is tested in `tests/db/checkout-overissue.sql` and `checkout-shortage-0105.sql` |
| AUD-1017 #1 High: vendor spend double-counted in Net profit | Fixed in 0146 |
| AUD-1017 #2, #4, #6 | Fixed (refunds in P&L, trial approve needs membership, share tokens use `crypto.randomUUID()`) |
| D8 pricing authority (client could set total) | Server recomputes the total and a trigger overwrites it (`0001_pricing_authority.sql`). Covered by `pricing-parity` in the DB suite. |
| "Skip payment" on prod | Browser half: `public/config.js` sets `allowPaymentBypass` false on `helm.events`/`www`. Server half: `0162` (still to run on prod, see H2). |

---

## 4. Required fixes before the push

| # | Fix | Owner | Blocks launch? |
|---|---|---|---|
| R1 | Triage the 7 failing DB-canonical suites. For each one, either update a stale expectation (and write down why) or fix the real bug. Get `db-canonical-pg17.yml` green. | Dev | **Yes**, at least `DB-GATES-0049` and `BUSINESS-LOGIC` |
| R2 | Confirm all CI checks on `da5204f6` (the head with PRs #171/#172) are green: CI, Lighthouse, CodeQL, E2E, DB tests | Dev | **Yes** |
| R3 | Fix `secret-scan-history.yml` so it parses and runs | Dev | No, but do it in the launch week |
| R4 | Apply the pending SQL to prod in order, including `APPLY-0160-0161.sql` and `APPLY-0162.sql` (prod only), after running them on staging first (except 0162) | Owner | **Yes** |
| R5 | Reset or remove default-password accounts; make the repos private; set Supabase auth settings (`docs/AUTH-DASHBOARD-SETTINGS.md`) | Owner | **Yes** for passwords; **Decision needed** for the rest |

---

## 5. Tests performed (and by whom)

| Test | Result | Where |
|---|---|---|
| `ci.yml`: gitleaks, JWT roles, `npm audit --audit-level=high`, pinned actions, HTML sinks, inline styles, base-immutable, deploy-static, migration canon, OTP safety, deferred integrations off, env safety, CSP hashes, `npm test`, local `/api/health` | Green on `0bf8eb05` | GitHub Actions |
| CodeQL | Green | GitHub Actions |
| Lighthouse (`/`, `/login`, `/builder`) | Green on `0bf8eb05` | GitHub Actions |
| E2E Playwright against staging (gated) | Green | GitHub Actions |
| Staging DB suites: overpayment concurrency, idempotency, ledger RLS, OTP race/lockout, tenant RBAC | Green | GitHub Actions (`db-tests.yml`) |
| Canonical PG17 clean install, idempotency, 100 behavioral suites | **Red (7 suites)** | GitHub Actions |
| AUD-1017 white-box security review plus black-box staging run | 14 findings, all fixed or accepted | `docs/ops/SECURITY-AUDIT-2026-10-17.md` |
| Staging QA rounds 1017–1027: admin, manager, planner, sales and crew click-throughs | Passed, with fixes locked in by `audit-1017`, `retest*-1017/1018`, `final-1022`, `staging-1026`, `prelaunch-1027` | `test/` |
| Edge functions (Deno, mocked providers) | Recorded in `tests/edge/EDGE-TEST-RESULTS.md` | local |
| Live production writes | **Not done** (by design) | — |

---

## 6. Manual checks before launch

Do these after R1–R5, in this order. Use test records labelled `LAUNCH-TEST` and example.com addresses.

| # | Check | Pass when |
|---|---|---|
| 1 | Open `helm.events` and `www.helm.events`, then hard-refresh | Landing loads in the Emerald theme, there is no dark-mode toggle, the portal reel scrolls, and the console shows no CSP errors |
| 2 | Response headers on `/` and `/login` | HSTS, a strict CSP with no `'unsafe-inline'` in script-src, `frame-ancestors 'none'`, nosniff (`vercel.json`) |
| 3 | Sign up a new studio on prod, then open `/checkout` | **No** "Skip payment (testing only)" button. Calling `my_start_trial('bypass')` is refused (0162). The free trial path still works. |
| 4 | Create a lead, then a quote with a % discount, then **Save quotation** | Discount is kept and shown. Advance = % of the **discounted** total. |
| 5 | Send for approval, approve as the client (simulated OTP while SMS is off), then record the advance by hand | Approval waits for the advance. After payment the page says "Booking confirmed". The booklet shows the right currency. |
| 6 | Try to close the event with a balance still owed | Close is refused, or allowed only with a reason that is logged. Reopening is admin-only. |
| 7 | On staging and prod (SQL editor, read-only): every public table with `org_id` has `relrowsecurity = true`; `has_function_privilege('anon', …)` is false for non-token RPCs | No rows break the rule |
| 8 | Two-studio probe on staging: sign in as studio A, try to read studio B's quote, storage file and realtime channel by id | All refused or empty |
| 9 | Log in as each untested role (coordinator, supervisor, quality, operations, designer) and as a client on the portal | Navigation matches the access matrix in Control Center, with no blank pages |
| 10 | Invite a team member on prod | E-mail arrives from `notifications@helm.events` with Reply-To set to the studio's email. The copy-link fallback also works. |
| 11 | Confirm the integrations are off on prod | `public/config.js` `liveChannels` has sms/whatsapp/pay false. No Razorpay payment link button is live. WhatsApp is set up separately by the owner and stays off until they switch it on. |
| 12 | Backups | Supabase daily backups/PITR are enabled for the prod project. The restore steps in `DISASTER-RECOVERY-RUNBOOK.md` have been read. |
| 13 | Observability | Error alerts per `OBSERVABILITY-ACTIVATION.md` are on, and someone is named on call per `INCIDENT-RESPONSE-RUNBOOK.md` |
| 14 | Rollback | Know the last good Vercel deployment to promote back to (`RUNBOOK.md`). SQL is additive-only, so a code rollback needs no DB rollback. |

---

## 7. Decisions needed

- **Decision needed:** Do the un-retested roles (M5) block launch, or are they accepted for a soft launch?
- **Decision needed:** Which checks become required for merging to `main`? Suggested: `ci`, `db-canonical`, `lighthouse`, CodeQL.
- **Decision needed:** Catering GST % setting: wire it up or remove it (L6).
- **Decision needed:** Turn on the Trusted Types enforcement and config fail-closed hardening after launch (L1, L2)?

## 8. Assumptions

- Assumption: the DB-canonical failures are mostly stale test expectations (see H1). This has to be confirmed.
- Assumption: prod is at least at the migrations applied before 0160. Check this with the SQL tracker before applying the next bundles.
- Assumption: the green staging-gated E2E and DB-tests runs used current staging secrets and the current staging DB.
