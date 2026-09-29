# Helm — Elite Production Readiness Audit (Review Board, post-remediation)

**Date:** 2026-09-29 · Assumes imminent paying-customer launch. Brutally honest, problem-focused. Reflects the CURRENT state after this engagement's fixes (SEC-01..04 applied to prod, 3-org isolation proven, indexes, CI hardening, Phase-3 dashboard). No AI/LLM exists in Helm → that panel is N/A and cannot be scored.

---

## EXECUTIVE SUMMARY
- **Production-ready?** Core security/data: yes. Overall: **HIGH RISK** until deployment-parity + observability + recovery close.
- **Safe for paying customers today?** No — not because of code defects (the CRITICAL account-takeover is fixed on prod and tenant isolation is airtight), but because (1) the **customer prod frontend is 43 commits behind**, (2) there is **no live monitoring**, (3) **recovery is unproven**.
- **Biggest business risks:** customers on unpatched frontend; blind to incidents; unrecoverable data event.

---

## FINDINGS (genuinely open — the fixed items are not re-listed)

### F1 — No live error/uptime monitoring
File: GLOBAL (public/telemetry.js wired, no DSN) · Severity: 🔴 Critical (operational) · Category: Observability
- **Problem:** telemetry.js installs handlers but is a no-op without a DSN; no uptime monitor; no alerting. A prod outage or error storm is invisible.
- **Evidence:** `telemetry.js` `ENABLED = !!CFG.dsn`; no DSN anywhere; RUNBOOK notes "not live".
- **Impact:** MTTR unbounded; silent data/auth failures.
- **Fix:** create a Sentry (or GlitchTip) project → set `window.HELM_TELEMETRY={dsn,env,release}` before scripts; add an uptime monitor (UptimeRobot/Betterstack) on `/` and Supabase health; wire alert routing. **Owner action — external service.**
- **Validate:** trigger a test error → appears in Sentry; take the app down → alert fires.

### F2 — Customer production frontend is 43 commits behind
File: GLOBAL (praneeth repo) · Severity: 🔴 Critical · Category: Infra/Deployment
- **Problem:** prod DB is hardened, but `www.helm.events` serves old frontend missing all Wave-16 client hardening (validators, number hardener, RBAC button map, a11y, config).
- **Evidence:** `prod/main` is a strict ancestor of `origin/main` (43 commits). See CUSTOMER-FRONTEND-PARITY.md.
- **Impact:** customers run unpatched client; UX + client-side validation gaps.
- **Fix:** fast-forward/patch the customer repo + Vercel deploy. **Owner action.**
- **Validate:** diff deployed bundle vs origin; smoke the live site.

### F3 — Backup restore never drilled
File: GLOBAL · Severity: 🔴 Critical · Category: Infra/DR
- **Problem:** prod on Supabase Pro (snapshots exist) but recovery has never been rehearsed → RTO/RPO unproven.
- **Fix:** run BACKUP-RESTORE-RUNBOOK.md against a throwaway target; record timings. **Owner (needs a throwaway DB).**
- **Validate:** RESTORE-VERIFY.sql returns all-PASS on the restored copy.

### F4 — No per-identity rate limiting on data RPCs / no circuit breakers
File: GLOBAL · Severity: 🟠 Major · Category: Reliability/Security
- **Problem:** Supabase Auth endpoints are rate-limited (dashboard), but business RPCs (PostgREST) have no per-identity throttle; deferred 3rd-party integrations (when enabled) have no circuit breaker/fallback.
- **Impact:** an authenticated user could hammer expensive RPCs; a flaky provider (once enabled) could cascade.
- **Fix:** add a token-bucket in the definer RPCs for hot/expensive functions (e.g., a `rate_limit(key, n, window)` helper table), and wrap provider calls (send-otp/whatsapp/razorpay edge fns) with timeout + retry + breaker. **Code (me) + tuning.**
- **Validate:** loop an RPC past the limit → 429/raise; simulate provider timeout → breaker opens.

### F5 — No structured logging / distributed tracing (OpenTelemetry)
File: GLOBAL · Severity: 🟠 Major · Category: Observability
- **Problem:** no JSON structured logs or tracing; only Postgres logs + basic client telemetry.
- **Impact:** hard to debug cross-service (edge fn → DB) issues at scale.
- **Fix:** emit structured logs from edge functions; add OTel traces if/when a backend tier grows. For a static+Supabase stack, prioritize Supabase log drains + Sentry breadcrumbs first. **Owner+me.**

### F6 — MFA not enforced for privileged roles
File: login.html / store-api.js · Severity: 🟠 Major · Category: Security
- **Problem:** Supabase MFA available but no enrollment UI and no AAL2 enforcement for admin/manager.
- **Fix:** build TOTP enrollment + require AAL2 at sign-in for admin/manager. **Code (me) + dashboard enable (you).**
- **Validate:** admin without MFA is blocked from privileged actions until enrolled.

### F7 — Optimistic lock is opt-in per call-site
File: public/store-api.js (updateMeta) · Severity: 🟠 Major · Category: Backend/Reliability
- **Problem:** lost-update protection only where `expectedUpdatedAt` is passed; other writers are last-write-wins.
- **Fix:** thread `expectedUpdatedAt` through remaining mutating call-sites (or enforce at RPC via a version check). **Code (me) + product decision on scope.**
- **Validate:** two-tab concurrent edit → second save gets CONFLICT.

### F8 — No load/perf baseline
File: GLOBAL · Severity: 🟠 Major · Category: Scalability/Testing
- **Problem:** never load-tested; builder.html is 4,020 lines (client-heavy).
- **Fix:** `npm run loadtest` against staging; Lighthouse budgets (both now in repo). **Owner runs on paid infra.**

### F9 — Frontend not bundled/minified; a11y partial
File: public/* · Severity: 🟡 Minor · Category: Frontend
- **Problem:** raw multi-file vanilla JS (fine functionally, tiny deps) but no minify/code-split; a11y covered on 3 pages.
- **Fix:** optional esbuild minify step; broaden axe coverage. **Code (me), lower priority.**

### F10 — e2e not in CI until secrets added
File: .github/workflows/e2e.yml · Severity: 🟡 Minor · Category: Testing
- **Problem:** e2e job skips until GitHub staging-creds secret exists.
- **Fix:** add repo secrets. **Owner.**

---

## MANDATORY MISSING-SYSTEMS EVALUATION

| System | Status | Notes |
|---|---|---|
| Distributed rate limiting & DDoS | 🟠 PARTIAL | Vercel CDN/DDoS + Supabase Auth rate limits present; **no per-identity throttle on business RPCs** (F4). |
| Multi-tenant data isolation (RLS + tenant context) | ✅ PRESENT | RLS on all 59 tables, 0 unscoped policies, org-scoped definer RPCs, 3-org runtime proof. |
| AI/LLM cost-amplification guardrails | ⚫ N/A | No AI in Helm. |
| Circuit breakers & fallbacks for 3rd-party | 🔴 MISSING | Deferred integrations disabled; **no breaker when enabled** (F4). |
| Structured logging + tracing (OTel) | 🔴 MISSING | F5. |
| Automated DB migration rollback | 🟠 PARTIAL | Every migration ships a ROLLBACK section; forward-only + idempotent; no automated framework. |
| Health checks + graceful shutdown (SIGTERM) | ⚫ MOSTLY N/A | Prod is static (Vercel) + Supabase — no long-lived server to shut down; `server.js /api/health` is dev-only. Edge fns are stateless. |

---

## PRODUCTION READINESS SCORECARD (current)

| Category | Score /10 | Notes |
|---|---|---|
| Security | 8.5 | SEC-01..04 fixed on prod; isolation airtight; SRI+secret-scan added. Gaps: MFA (F6), rotate pw, CAPTCHA frontend. |
| Backend Architecture | 8.0 | Mature RPC/RLS, server-authoritative money. Gap: optimistic-lock scope (F7). |
| Frontend | 6.5 | Tiny deps, CSP. Gaps: no bundle/split, heavy builder, partial a11y (F9). |
| Database | 9.0 | RLS 100%, CHECK/FK, idempotent migrations, hot indexes added. |
| Infrastructure | 8.5 | Vercel + Supabase Pro; CodeQL+gitleaks+audit+gated e2e in CI. Gaps: staging free-tier, CI secret (F10). |
| Reliability | 7.5 | Injected-failure e2e, idempotency, overpayment guard. Gaps: rate limit/breakers (F4), lock scope. |
| Scalability | 7.5 | CDN + pooler + indexes + load tool. Gap: no measured baseline (F8). |
| Testing | 8.5 | Unit + 3-browser e2e + lifecycle + coverage + a11y + responsive + 924-case differential + load tool. Gap: CI secret. |
| Observability | 4.0 | telemetry wired, **no DSN/uptime/alerting** (F1). |
| AI Safety | N/A | No AI. |

---

## SECURITY RISK MATRIX (critical/high)
All previously-critical items are FIXED on prod: account-takeover (SEC-01), cross-tenant (proven none), layouts endpoint (SEC-02), profiles PII (SEC-03). Remaining: exposed DB password (rotate — HIGH), CAPTCHA misconfig risk (verify OFF — HIGH), MFA absent (MED), rate-limit on RPCs (MED).

## TECHNICAL DEBT & COST MATRIX
| Item | Debt | Monthly cost if ignored |
|---|---|---|
| Observability off (F1) | Blind ops | Unbounded incident cost / churn |
| Frontend parity (F2) | Customers unpatched | Support load, trust |
| No backup drill (F3) | Unproven recovery | Catastrophic on data loss |
| No RPC rate limit (F4) | Abuse/cost spikes | DB compute overage |
| builder.html monolith (F9) | Slow first-paint on that page | Minor |

## SCALABILITY ASSESSMENT (estimate; not load-tested)
- 100 / 1,000: no issues.
- 10,000: fine on Pro with the new indexes; watch email 2/h (custom SMTP).
- 100,000: index/query review, likely read replicas + caching for dashboards; CDN essential (present).
- 1,000,000: larger compute + replicas + caching + rate-limit tuning. **Run a load test before promising this tier.**

## MISSING SYSTEMS (ranked)
1. Live monitoring/alerting (F1). 2. Verified DR (F3). 3. RPC rate limiting + breakers (F4). 4. Structured logs/tracing (F5). 5. MFA enforcement (F6). 6. Custom SMTP. 7. Load baseline (F8).

## TOP 20 FIXES BY ROI (low effort → high impact)
1. Rotate DB passwords. 2. Confirm CAPTCHA off / custom SMTP. 3. Sentry DSN + uptime. 4. Add GitHub CI secrets (enable e2e). 5. Run INDEX-REVIEW.sql on prod. 6. Run PHASE3-my-pending.sql on prod. 7. Frontend parity deploy. 8. Backup restore drill. 9. Run `npm run loadtest` vs staging for a baseline. 10. Enable MFA in dashboard. 11. Build MFA enrollment (me). 12. RPC rate-limit helper (me). 13. Provider circuit breakers (me). 14. Thread optimistic lock through remaining call-sites (me). 15. CAPTCHA frontend wiring (me). 16. Structured logs from edge fns. 17. esbuild minify (me). 18. Broaden a11y (me). 19. Tune Lighthouse budgets. 20. Supabase log drain to a store.

## TOP 10 PRODUCTION BLOCKERS
1. Frontend parity deploy (F2). 2. Live monitoring (F1). 3. Backup drill (F3). 4. Confirm CAPTCHA off (breakage). 5. Rotate exposed password. 6. Custom SMTP (email verification is on). 7. RPC rate limiting (F4). 8. Run INDEX + PHASE3 SQL on prod. 9. MFA for privileged roles (F6). 10. Load baseline (F8).

## 30-DAY PLAN (by team)
- **Week 1 — Infra/Sec:** rotate pw; confirm CAPTCHA off; custom SMTP; Sentry DSN + uptime + alerting; add CI secrets.
- **Week 2 — Infra/Backend:** frontend parity deploy; backup restore drill; run INDEX + PHASE3 SQL on prod; CodeQL triage.
- **Week 3 — Backend/Sec:** RPC rate-limit + circuit breakers; MFA enrollment + enforcement; CAPTCHA frontend; optimistic-lock scope decision.
- **Week 4 — Frontend/QA:** load baseline + Lighthouse budgets; esbuild minify; broaden a11y/e2e; structured logging from edge fns.

## AUTOMATED VALIDATION
`bash scripts/gatekeeper-check.sh` runs all zero-dep guards + unit suite + secret scan + dep audit and blocks on any failure. Extend with e2e + SEC-verify once CI secrets are set.

## FINAL VERDICT
**HIGH RISK.** The security and data-integrity core is now genuinely strong and the one critical vulnerability is fixed on production; what blocks a safe paying-customer launch is operational — customers run an unpatched frontend, there is no live monitoring, and recovery is unproven. Close the Week-1/Week-2 items and Helm reaches **READY WITH MINOR CHANGES**.
