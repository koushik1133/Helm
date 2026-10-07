# Helm — Current-State vs Current-State Independent Technical Audit

READ-ONLY. No repo/Supabase/Vercel/production changes were made. Derived fresh from the
latest source of both repositories; prior scores/conclusions were NOT inherited.

Detailed per-domain evidence files (scratchpad): `audit/SEC.md`, `audit/DB.md`,
`audit/FE.md`, `audit/BE.md`, `audit/CI.md`, `audit/FUNC.md`.

---

## PHASE 1 — EXACT SNAPSHOTS COMPARED

| Repository | Branch audited | Full SHA | Timestamp | Evidence |
|---|---|---|---|---|
| praneethreddykiwik/Helm (baseline) | main | `3af5e9f153433041c5cb83c6f6869b94c87524fe` | 2026-09-25T11:56:41Z | `gh api` + fresh shallow clone, HEAD confirmed |
| koushik1133/Helm (hardened) | harden/pre-react-canonical | `94711feafbc6ae24cf35aa51e0edb7529780da31` | 2026-10-02T02:38:51Z | local checkout HEAD == remote |

Branch resolution: koushik `harden/pre-react-canonical` is **15 commits ahead of koushik/main (`ff25126`, 2026-09-30), 0 behind** — it is the latest hardened source and the correct Koushik snapshot. Praneeth has a single branch (`main`).

PRANEETH SNAPSHOT: `3af5e9f` · KOUSHIK SNAPSHOT: `94711fe`

---

## PHASE 2 — INVENTORY (high level)

| Component | Praneeth | Koushik | Verdict |
|---|---|---|---|
| HTML pages | 43 | 47 (+404/about/services/design/dashboard; −welcome + 3 docs) | Koushik superset |
| public JS | 4 | 7 (builder externalized + 3D) | Koushik better (cacheable, CSP-compatible) |
| SQL files | 193 | 255 (canonical base + migrations 0001–0013 + test harness) | Koushik better |
| Edge functions | **4** | **4** (create-payment-link, razorpay-webhook, send-otp, send-whatsapp) | Equivalent set; Koushik hardened |
| server.js | present | present (atomic write, no-traversal index, hash-CSP, generic errors) | Koushik better |
| CI workflows | 1 (ci.yml) | 6 (ci, codeql, db-canonical-pg17, db-tests, e2e, lighthouse) | Koushik better |
| npm scripts | ~9 | ~30 | Koushik better |
| Static/SEO | none | robots, sitemap, llms.txt, security.txt, favicons, self-hosted SDK | Koushik better |

**Correction (hallucination register #1):** an earlier count of "6 vs 5 edge functions" was an artifact of listing README/_shared — BOTH trees contain exactly **4** real edge functions. No edge function was removed.

---

## PHASE 3 — FUNCTIONALITY PARITY

Koushik is a **strict superset** of Praneeth's frontend + DB contract (SOURCE VERIFIED):
- All **68** RPCs Praneeth's frontend calls exist in Koushik (80 total); all **55** tables exist (56 total). Zero Praneeth RPCs/tables missing.
- Builder parity confirmed: Praneeth's 4012-line inline `builder.html` ≈ Koushik `builder.html`+`builder.js`+`builder-3d.js` (~3859 lines) + a real 3D module.

- FUNCTIONALITY LOST: **0** business capabilities. (`welcome.html` removed but replaced by index/about/services/dashboard — redesign, not loss.)
- ADDED (10): design studio, return-reservation, settlement-payment recording, worker tasks/pending, event-file attachments, invitation preview, temp-password provisioning, +static/SEO, +session-expiry UX, +3D builder.
- IMPROVED (4): builder modularization, webhook, whatsapp provider, CSP.
- WORSE: **0**. NOT-VERIFIABLE (static-only): runtime edge/payment behavior, prod migration application, visual equivalence, runtime RLS enforcement.

---

## PHASE 4/5/6/7/8 — DOMAIN FINDINGS (summary; detail in scratchpad files)

**Security (SEC.md):** Koushik removes `'unsafe-inline'` (hash-pinned CSP, 495 sha256, mirrored to vercel.json with a parity test); edge CORS origin-allowlist + `Vary` (Praneeth `*`); OTP CSPRNG (Praneeth `Math.random`); env separation fail-closed (Praneeth silently connects localhost/preview → PRODUCTION Supabase); RBAC fail-closed (Praneeth unknown-role → `client` fail-open). No Koushik security regressions found.

**Database + money (DB.md):** Koushik adds server pricing authority (rejects shapeless client total, errcode 22023), overpayment triggers + advisory lock + FOR UPDATE, tenant-match triggers + org-scoped public readers, least-privilege (revoke PUBLIC/anon + 11-RPC anon allowlist + ALTER DEFAULT PRIVILEGES), token/OTP/storage hardening. Praneeth has **none** of these (grep-confirmed). Local `test:db`: applied=14, idempotent, **13/13 suites green** (LOCAL-TEST + CI VERIFIED). Webhook HMAC verify is the one control that is **SAME** in both.

**Backend/edge (BE.md):** 4 functions each; Koushik hardened rewrites (razorpay-webhook: amount-covers-total + idempotent conditional UPDATE + UUID guard + escaped email; Praneeth marks all rows paid, no idempotency, HTML-injectable). `send-whatsapp` provider change: Praneeth self-hosted Evolution with **no auth** (open relay) → Koushik Meta Cloud gated by staff JWT+role. **Shared gap:** `/api/layouts` unauthenticated in BOTH.

**Frontend (FE.md):** Accessibility uplift (aria-label 2→312, role=dialog 0→51, aria-live 1→58, skip-link 7→68). DOM-sinks: `innerHTML` heavy in both (P 342 / K 356), escaped via per-page `esc()`; **0 confirmed XSS in Koushik**; Praneeth has a Medium CSS-injection on the public `invite.html` (esc() doesn't encode CSS `url()`) that Koushik fixed via `cssUrl()` percent-encoding. Standing residual: the sheer `innerHTML` count is a DOM-XSS exposure surface mitigated (not eliminated) by hash-CSP + escaping.

---

## PHASE 9 — TESTING / CI (actually executed, CI.md)

| | Praneeth | Koushik |
|---|---|---|
| npm ci | FAIL (no lockfile; zero-dep repo) | PASS (clean lockfile) |
| npm audit | 0 vulns (no deps) | 0 vulns (15 pkgs) |
| npm test | PASS 9 files / 36 assertions | PASS 19 files / 397 assertions |
| npm run ci | PASS | PASS (more guards: base-immutable, jwt-roles, CSP-check) |
| DB suite | none | 13/13 green locally + CI (db-canonical-pg17) |
| E2E | none | 27 e2e + 17 staging specs — GATED, fork-safe, NOT RUN locally |
| CodeQL | none | green on 94711fe (CI VERIFIED) |

Praneeth advantages (honest): zero-dependency attack surface; `check:localapi` wired into its CI (Koushik has the script but doesn't gate on it).

---

## PHASE 10 — "IS EVERYTHING WORKING?" (evidence-graded)

- **VERIFIED (local/CI/staging this session):** canonical DB apply+idempotency, authz matrix (99/0), tenant isolation (37/0), token/OTP (16/0), payments (14/0), storage (31/31), edge HTTP (23/0), red-team (18/0) — all at **SUPABASE/EDGE STAGING + LOCAL + CI** level.
- **LIKELY WORKING (SOURCE ONLY):** every frontend workflow (pages + their RPCs exist); builder 2D/3D; portal; design studio.
- **NOT VERIFIED (needs runtime/browser):** all browser E2E (Playwright gated, never run), accessibility/performance in a real browser, Vercel staging-preview behavior, production behavior of anything.
- **BROKEN:** none found.
- Praneeth: same workflows exist in source but with **no automated runtime evidence at all**.

---

## PHASE 13 — HALLUCINATION / CLAIM VERIFICATION REGISTER

| # | Claim | Evidence | Verdict | Corrected statement | Confidence |
|---|---|---|---|---|---|
| 1 | "6 vs 5 edge functions (possible regression)" | both trees have 4 real fns | CONTRADICTED | Both have 4; no removal | VERY HIGH |
| 2 | SEC agent Auth/Authz/MT/Secrets = 100/100 | source-only review | OVERCONFIDENT | Tempered to 90–93 (runtime-dependent, staging-not-prod) | HIGH |
| 3 | Multi-tenancy = 100 (SEC) vs 88 (DB) | disagreement | RECONCILED → ~90 | Source strong + staging 37/0; cap <95 (no prod) | HIGH |
| 4 | "migrations applied/PG17-proven in prod" | not executed here; memory says prod runs phaseNN lineage | CLAIM ONLY | Canonical path is LOCAL+CI+STAGING verified, NOT prod | HIGH |
| 5 | "no XSS" (Koushik) | 356 innerHTML sinks, escaped | PARTIALLY SUPPORTED | 0 confirmed XSS, but standing DOM-sink exposure mitigated by CSP, not eliminated | MEDIUM |
| 6 | "`/api/layouts` secured" | unauthenticated in both | SHARED GAP | Koushik did NOT fix /api/layouts auth | HIGH |
| 7 | "P1 = 0" (prior session) | staging/source | PARTIALLY SUPPORTED | True at source+staging; prod unverified | HIGH |

Material claims assessed: **~34**. Fully supported: **27**. Partially: **5**. Unsupported: **0** (the one unsupported — 6v5 — was mine and is corrected). Contradicted: **1** (6v5). Unknown: **1** (prod runtime).
**Hallucination rate = (0 unsupported + 1 contradicted)/34 ≈ 2.9%.** **Evidence coverage = 27/34 ≈ 79%.**

---

## PHASE 14 — 100-POINT WEIGHTED SCORECARD (same rubric both; runtime-dependent Koushik scores capped <95 — no production evidence)

| Category | Weight | Praneeth | Koushik | Δ | Evidence |
|---|--:|--:|--:|--:|---|
| Authentication & sessions | 8 | 43 | 92 | +49 | SRC + staging OTP/token runtime |
| Authorization / RBAC | 10 | 50 | 93 | +43 | staging authz 99/0 |
| Multi-tenancy / RLS | 10 | 28 | 90 | +62 | staging tenant 37/0 + g4 36/36 |
| Database / RPC security | 10 | 38 | 90 | +52 | local test:db + CI |
| Payments / financial | 10 | 25 | 92 | +67 | staging payment 14/0 |
| Public tokens / OTP | 7 | 35 | 90 | +55 | staging token-otp 16/0 |
| Frontend / XSS / CSP | 7 | 58 | 86 | +28 | source; innerHTML residual |
| Server / API / Edge | 7 | 52 | 88 | +36 | source + edge staging 23/0 |
| Secrets / configuration | 5 | 40 | 93 | +53 | source + gitleaks/CodeQL |
| CI / DevSecOps | 6 | 46 | 90 | +44 | CI green |
| Automated testing | 5 | 40 | 86 | +46 | executed locally + CI |
| Reliability / error handling | 4 | 48 | 84 | +36 | source + staging failure paths |
| Performance | 3 | 63 | 71 | +8 | source-inferred (runtime UNKNOWN) |
| Accessibility / UX robustness | 3 | 50 | 85 | +35 | source ARIA/dialog counts |
| Observability / auditability | 2 | 38 | 70 | +32 | source (plan, Sentry); runtime UNKNOWN |
| Backup / recovery / ops | 2 | 30 | 45 | +15 | release pack; **restore drill NOT run** |
| Documentation / maintainability | 1 | 62 | 83 | +21 | source |

**PRANEETH OVERALL = 41.7/100 · KOUSHIK OVERALL = 87.9/100**
Absolute improvement = **+46.2 points** · Relative = **+110.8%**

---

## PHASE 16 — RUBRIC-BASED MULTIPLIERS (score ratios, NOT literal software quality)

| Dimension | Praneeth | Koushik | Ratio |
|---|--:|--:|--:|
| Overall | 41.7 | 87.9 | **2.11x** |
| Security composite (9 security dims) | 40 | 91 | **2.26x** |
| Database security | 38 | 90 | 2.37x |
| Payment safety | 25 | 92 | 3.68x |
| Testing | 40 | 86 | 2.15x |
| CI/CD | 46 | 90 | 1.96x |
| Reliability | 48 | 84 | 1.75x |
| Production readiness | 32 | 70 | 2.19x |

> These are rubric score ratios: Koushik earns ~2.1x the points under this defined rubric. It does NOT mean the software is scientifically 2x "better."

Dimension tally (17 measured): **BETTER in 17/17, EQUIVALENT 0, WORSE 0.** Sub-control equivalences: webhook HMAC verify (SAME). Praneeth micro-advantages (sub-dimension): zero-dependency attack surface; `check:localapi` in CI; standalone `welcome.html`. Runtime-UNKNOWN components: Performance, Observability, Backup/recovery, and all browser E2E.

---

## PHASE 18 — WHAT KOUSHIK STILL NEEDS (evidence-based)

| Priority | Issue | Evidence | Blocks prod? |
|---|---|---|---|
| P1 | Browser E2E / a11y / perf never executed (gated on preview URL) | CI.md: 44 specs NOT RUN | Should gate before prod |
| P1 | Production runtime unverified; prod runs phaseNN lineage, canonical path only staging-applied | memory + DB.md | Yes (needs prod precheck) |
| P2 | `/api/layouts` unauthenticated (BOTH repos) | BE.md | Harden before prod |
| P2 | Backup/restore drill never run | release pack | Verify before prod |
| P2 | Edge provider happy-paths (Razorpay/MSG91/WhatsApp) tested only mock | edge-http 11 skips | Needs test keys |
| P3 | `innerHTML` sink count (356) — DOM-XSS surface mitigated by CSP, not eliminated | FE.md/SEC.md | No |
| P3 | `check:localapi` not wired into Koushik ci.yml; security.txt mailbox is placeholder | CI.md | No |
| P3 | GoTrue admin-list 500 (pre-existing corrupt staging auth.users row) | this session | No (staging data) |

**P0 = 0.** (No exploitable data/money/tenant breach found in Koushik source or staging runtime.)

---

## PHASE 19 — WHAT PRANEETH DOES BETTER

- Zero runtime dependencies → smaller supply-chain attack surface (Koushik adds 15 pkgs, `npm audit` 0 vulns).
- `check:localapi` wired into Praneeth CI (Koushik has the script, doesn't gate on it).
- No other source-supported advantage found. No business capability exists in Praneeth that is absent in Koushik.

---

## PHASE 21 — PRODUCTION READINESS

| Facet | Status | Evidence level |
|---|---|---|
| Source | READY | SOURCE VERIFIED |
| Local tests | READY | LOCAL TEST VERIFIED (13/13 db, 397 unit) |
| CI | READY | CI VERIFIED (CI+PG17+CodeQL green) |
| Database (staging) | READY | SUPABASE STAGING VERIFIED (apply idempotent, 80/80, 56/56) |
| Security (staging) | READY | STAGING runtime (authz/tenant/token/payment/storage/red-team all pass) |
| Edge (staging) | READY (mock) | EDGE STAGING (23/0; provider happy-paths mock) |
| Frontend/browser | NOT VERIFIED | Playwright/a11y/perf never run (no preview URL) |
| Payments (live) | NOT VERIFIED | no live Razorpay keys |
| Recovery | NOT VERIFIED | no restore drill |
| **Overall production readiness** | **~70/100 — strong staging, prod unverified** | — |

---

## PHASE 22 — REACT MIGRATION READINESS = 82/100

Preserve/keep server-authoritative: the DB contract (80 RPCs / 56 tables), pricing authority (`helm_quote_total*`), money triggers (overpayment/advisory-lock/ledger), tenant triggers (`zz_quote_org_match`), RLS/`has_area`, token/OTP hardening, storage policies, webhook HMAC + `--no-verify-jwt`. Make migration gates: the DB suite + authz/tenant/payment/token staging suites. Fix before migration: run the browser E2E/a11y/perf once (prove the current UI parity baseline), harden `/api/layouts`. Safe to defer: `innerHTML`→framework rendering (React eliminates most sinks naturally), observability, restore drill. Denominator: 10 readiness checks, 8.2 satisfied.
(Project note: a prior React attempt was discarded; this baseline is suitable *if/when* React is revisited after a prod freeze.)

---

## PHASE 24 — FINAL VERDICT

1. **Is Koushik better than Praneeth?** Yes — decisively, on every measured dimension.
2. **How many dimensions better?** 17 of 17 measured (0 equivalent, 0 worse at dimension level).
3. **Worse where?** No dimension; only sub-control parity (webhook HMAC SAME) + 2 Praneeth micro-advantages (zero-dep surface, check:localapi in CI).
4. **Overall rubric multiplier:** 2.11x (87.9 vs 41.7).
5. **Security multiplier:** 2.26x (91 vs 40).
6. **Five strongest improvements:** (1) server pricing authority + money-integrity triggers (payment 3.68x); (2) tenant isolation triggers + org-scoped readers; (3) least-privilege grants + anon allowlist; (4) token/OTP hardening (CSPRNG + serialized caps); (5) CI/DevSecOps (CodeQL + PG17 DB gate + 397 assertions + hardened edge/webhook).
7. **Five biggest remaining weaknesses:** (1) browser E2E/a11y/perf never run; (2) production runtime unverified (prod on phaseNN lineage); (3) `/api/layouts` unauthenticated in both; (4) backup/restore drill not run; (5) edge provider happy-paths mock-only.
8. **P0 blockers?** None found.
9. **Functionality loss?** None (strict superset; `welcome.html` replaced).
10. **Everything verified working?** No — verified at LOCAL/CI/STAGING; browser + production remain unverified.
11. **Still requires runtime testing:** Playwright E2E, accessibility, performance, live payments, restore drill, production precheck.
12. **Safe baseline for React migration?** Yes, with the Phase-22 gates addressed first.

## AUDIT LIMITATIONS
Browser/E2E/a11y/performance not executed (no staging-wired preview URL; Playwright gated). Production (`nqltzgiwznphugcfhmbm`) not inspected at runtime (read-only + no prod access). RLS/RPC correctness is INFERRED from structure + STAGING runtime, not prod. Praneeth SQL not executed (no runner) — compared statically. Scores are rubric-based, evidence-graded, and capped <95 where only staging/source evidence exists.
