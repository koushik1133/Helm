# Helm — Production Readiness Audit (Principal Engineer Review Board)

**Date:** 2026-09-29 · **Method:** synthesis of this engagement's verified evidence (source audit, staging runtime, 3-browser e2e, 3-org isolation proof, SEC-01..04 fixes applied to prod) + targeted infra/CI/frontend checks. Honest, problem-focused. No AI/LLM features exist in Helm, so that panel is N/A.

---

## EXECUTIVE SUMMARY

**Is it production-ready?** The **data + security core is** — tenant isolation is airtight (RLS on all 59 tables, 0 unscoped policies, org-scoped SECURITY DEFINER RPCs, cross-tenant denial proven across 3 orgs), server-authoritative pricing (924-case differential), overpayment/idempotency guards, and the one CRITICAL vuln (unauthenticated account-takeover via `create_helm_user`) is **fixed on production**. Auth is hardened (password length 12, complexity, leaked-password check on Pro, email verification, Google OAuth).

**Can it safely serve paying customers today?** **Not yet — HIGH RISK**, for reasons that are mostly *operational and deployment*, not core-code:
1. **The customer production frontend is 43 commits behind** (`praneeth/main` is a strict ancestor of `koushik/main`). It is missing every Wave-16 client hardening (input validators, global number hardener, RBAC button map, a11y) — the prod **database** is fixed, but the prod **frontend** your customers load is old.
2. **No live observability** — `telemetry.js` is wired but has no DSN (off); no uptime monitor; no alerting. You'd be blind to production incidents.
3. **No verified backup/restore drill** — prod is on Pro (snapshots exist) but recovery has never been rehearsed.
4. **CAPTCHA misconfiguration risk** and **email at 2/h** (verification is on but no custom SMTP) can break auth/signup.

**Biggest business risks:** (a) customers on an unpatched frontend; (b) an incident you can't see; (c) an unrecoverable data event.

---

## PRODUCTION READINESS SCORECARD

| Category | Score /10 | Notes |
|---|---|---|
| Security | **8.0** | SEC-01..04 fixed on prod; isolation airtight; auth hardened. Deductions: CAPTCHA misconfig risk, exposed DB password (rotate), no MFA enforcement yet, no SRI on CDN scripts. |
| Backend Architecture | **8.0** | Mature RPC/RLS layer, server-authoritative money, org guards. Deduction: optimistic lock is opt-in per call-site; some last-write-wins. |
| Frontend | **6.5** | 45 vanilla pages, zero runtime deps (tiny), CSP + security headers. Deductions: no build/bundle/code-split, `builder.html` is 4,020 lines (heavy), a11y partial. |
| Database | **8.5** | 59 tables, RLS 100%, CHECK/FK constraints, idempotent migrations, pooled. Strong. |
| Infrastructure | **7.0** | Vercel static + Supabase Pro (prod). CI runs guards + unit tests on push. Deductions: no CodeQL/gitleaks/dep-audit in CI, e2e not in CI, staging is free-tier past quota grace. |
| Reliability | **7.5** | Injected-failure e2e (500/timeout/offline) pass, idempotency, overpayment guard. Deduction: lost-update opt-in; no circuit breakers for 3rd-party (deferred integrations). |
| Scalability | **6.5** | Static FE scales via CDN; Postgres via pooler. No load testing done; builder is client-heavy. Unmeasured at scale. |
| Testing | **7.5** | Unit + 3-browser e2e + 12-stage lifecycle + coverage + a11y + responsive; 924-case pricing differential. Deductions: e2e not in CI (needs creds), no load/perf tests. |
| Observability | **4.0** | telemetry.js wired but NO DSN (off); no uptime/alerting; audit_log exists. Effectively blind in prod. |
| AI Safety | **N/A** | No LLM/AI features in Helm. |

**Weighted overall posture: solid core (~8), let down by observability (4) and deployment parity.**

---

## SECURITY RISK MATRIX (critical/high, current state)

| Risk | Sev | State |
|---|---|---|
| Unauthenticated account-takeover (`create_helm_user`) | CRITICAL | ✅ FIXED on prod (SEC-01) |
| Cross-tenant data access | CRITICAL | ✅ No path found; proven across 3 orgs |
| `layouts` endpoint reachable regardless of matrix | HIGH | ✅ FIXED on prod (SEC-02) |
| Colleague PII via `profiles` | MED | ✅ FIXED on prod (SEC-03) |
| Exposed prod DB password (in chat) | HIGH | ⚠️ OPEN — **rotate now** |
| CAPTCHA enabled without frontend → auth breakage | HIGH (avail.) | ⚠️ verify toggled OFF on prod |
| No MFA for admin/manager | MED | OPEN — code build (Phase 3-adjacent) |
| No SRI on CDN scripts | LOW | OPEN — add integrity hashes |
| No dependency/secret scanning in CI | MED | OPEN — add gitleaks + audit + CodeQL |

---

## TECHNICAL DEBT MATRIX (highest first)

1. **Frontend parity** — prod frontend 43 commits behind; must fast-forward/patch (see CUSTOMER-FRONTEND-PARITY.md).
2. **Observability not live** — wire DSN + uptime + alerting.
3. **Backup/restore never drilled** — rehearse (BACKUP-RESTORE-RUNBOOK.md).
4. **Personal task/notification dashboard missing** — the "my pending work" UX (Phase 3 build).
5. **builder.html 4,020 lines** — monolithic; refactor for maintainability/perf later.
6. **Optimistic lock opt-in** — extend to all `updateMeta` call-sites (product decision).
7. **Coordinator/supervisor/quality edit authority** — product decision (fail-closed today).
8. **Custom SMTP** for prod email (verification is on; 2/h default will throttle).

---

## SCALABILITY ASSESSMENT (estimated; not load-tested)

- **100 users:** no issues.
- **1,000:** no issues; pooler handles connections.
- **10,000:** fine on Supabase Pro; review indexes on hot tables (quotes, quote_payments, event_tasks); watch the 2/h email limit → custom SMTP required.
- **100,000:** needs index/query review, likely read replicas or caching for dashboards/insights; builder is per-client heavy (OK) but asset delivery via CDN essential (have it).
- **1,000,000:** significant DB scaling (larger compute, replicas, connection strategy), a caching layer, and rate-limit tuning. Static frontend itself scales on Vercel's CDN. **Recommend a load test before promising this tier.**

---

## MISSING SYSTEMS REPORT (ranked)

1. **Live error monitoring** (DSN) + **uptime monitoring** + **alerting** — highest priority; you're blind without it.
2. **Verified disaster recovery** (restore drill) — prod is on Pro (snapshots) but untested.
3. **CAPTCHA frontend** (widget + token) to safely enable bot protection.
4. **Custom SMTP** for transactional email at scale.
5. **MFA enforcement** for privileged roles (code).
6. **CI security scanning** — gitleaks, `npm audit`/dep-audit, CodeQL.
7. **e2e in CI** (with a staging creds secret) so regressions can't merge.
8. **Load/perf testing** + a Lighthouse baseline (never measured).
9. **Personal task/notification dashboard** (Phase 3).

---

## TOP 10 PRODUCTION BLOCKERS (must fix before serving paying customers)

1. Deploy the hardened frontend to the **customer production** (praneeth) — close the 43-commit gap.
2. Turn on **live observability** (error DSN + uptime + alerting).
3. Run a **backup restore drill** and record it.
4. Confirm **CAPTCHA is OFF** on prod (or fully wired) so logins aren't broken.
5. **Rotate** the exposed prod (and staging) DB passwords.
6. Configure **custom SMTP** (email verification is on; built-in 2/h will fail real signups).
7. Add **CI security scanning** (secrets + deps + CodeQL).
8. Add **SRI** to CDN `<script>`s.
9. Decide **coordinator/supervisor/quality** authority + **optimistic-lock scope** (product decisions).
10. Establish a **Lighthouse/load baseline** before scale claims.

---

## TOP FIXES BY ROI (low effort, high impact)

1. Rotate DB passwords (mins) — closes an exposed credential.
2. Confirm CAPTCHA off / SMTP set (mins) — prevents auth outage.
3. Error DSN + uptime monitor (hours) — from blind to observable.
4. Frontend parity deploy (hours) — customers get all hardening.
5. CI gitleaks + npm audit (hours) — stops secret/CVE regressions.
6. Restore drill (hours) — proves recoverability.

---

## 30-DAY REMEDIATION PLAN

- **Week 1 (stop-the-bleeding):** rotate passwords; confirm CAPTCHA off; custom SMTP; error DSN + uptime + alerting live; frontend parity plan finalized.
- **Week 2 (parity + safety net):** deploy hardened frontend to customer prod; backup restore drill; CI security scanning + SRI.
- **Week 3 (feature + auth):** build personal task/notification dashboard; MFA enforcement for admin/manager; CAPTCHA frontend wired + enabled.
- **Week 4 (scale + polish):** Lighthouse + load baseline; index review on hot tables; resolve the two product decisions; e2e in CI.

---

## FINAL VERDICT

**HIGH RISK** (not "not ready" — the core is genuinely strong; not "ready" — customer-facing parity and operations gaps remain).

The security and data-integrity foundation is now excellent and production-grade, and the one critical vulnerability is fixed on production. What blocks a safe paying-customer launch is **operational**: the customer frontend is running old code, you have no live monitoring, and recovery is unproven. Close the Week-1 and Week-2 items and Helm moves to **READY WITH MINOR CHANGES**.
