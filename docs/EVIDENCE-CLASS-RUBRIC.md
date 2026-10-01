# EVIDENCE-CLASS-RUBRIC.md

An auditor rubric for scoring claims about Helm honestly. Every claim ("X works", "Y is
secure", "Z is verified") must be tagged with the HIGHEST evidence class that actually
backs it — no higher. This exists to stop a lower class being silently reported as a
higher one (e.g. "the code does X" dressed up as "X is runtime-verified in production").

## Evidence classes (strict ascending order)
Lower classes prove LESS. A claim's honest score is the single highest class whose
conditions are literally met.

1. **SOURCE** — the source code / config appears to do the thing. No execution.
   Proves intent, not behavior.
2. **LOCAL PG17** — exercised against a local Postgres 17 instance (SQL migrations,
   RLS policies, DB tests actually run locally).
3. **GITHUB CI** — a GitHub Actions run executed the check (unit/integration/db tests,
   header-parity, env-routing static test) and passed, reproducibly, in CI.
4. **VERCEL PROD READ-ONLY** — observed on the production frontend by READ-ONLY
   inspection (headers, routes, static assets, exposure probes). No writes, no auth'd
   mutation. (See PRODUCTION-FRONTEND-READONLY-REPORT.md.)
5. **VERCEL STAGING PREVIEW** — driven on the staging-wired Vercel branch-preview
   (frontend resolves to the STAGING ref). Runtime behavior of the FRONTEND confirmed,
   including write flows, because the DB is isolated staging.
6. **SUPABASE STAGING** — confirmed at the staging DATA layer: the staging Supabase
   project's rows/RLS/logs actually reflect the operation (server-side truth, not just UI).
7. **PRODUCTION** — confirmed in the live production system with production data. The
   strongest and most dangerous class; most claims should NEVER need it, and write-flow
   production verification is generally prohibited for this product.

## Hard rules
1. **Never upgrade one class into another.** "Code does X" (SOURCE) is not "X passes in CI"
   (GITHUB CI); "headers present on prod" (PROD READ-ONLY) is not "login works on prod"
   (which would be PRODUCTION and is not done). State the real class.
2. **"Runtime-verified" requires the workflow to be actually DRIVEN** (class ≥ VERCEL
   STAGING PREVIEW for frontend flows, or ≥ SUPABASE STAGING for data-layer truth). A
   workflow that was only read, type-checked, or statically tested is NOT runtime-verified.
3. **Read-only ≠ write-verified.** A PROD READ-ONLY observation never backs a claim about
   mutation, persistence, or side effects.
4. **UI success ≠ data success.** A green UI (STAGING PREVIEW) does not prove the row was
   written correctly; that needs SUPABASE STAGING.
5. **One claim, one highest-honest class.** If parts differ, split the claim.
6. **No backup/recovery claim above "configured"** until a real restore DRILL runs green
   (see docs/STAGING-OBSERVABILITY.md §7).
7. **Absence of evidence is not evidence.** An untested flow is scored at its real class
   (often SOURCE), never assumed to work.

## Dimension scoring template
For each audited capability, score every dimension at its highest HONEST evidence class
and cite the artifact. Leave blank (not optimistic) when there is no evidence.

| Capability: <name> | Highest honest class | Artifact / where observed | Notes / gaps |
|--------------------|----------------------|---------------------------|--------------|
| Functional (does the flow complete?) | | | |
| Data correctness (rows/fields right?) | | | |
| AuthZ / RLS (right users only) | | | |
| Security headers / CSP | | | |
| Input validation / hardening | | | |
| Error handling / fail-closed | | | |
| Observability (failure is visible) | | | |
| Backup / restore | | | |
| Env isolation (never prod by accident) | | | |

### Worked example (env routing, as of this preparation)
| Capability: env routing | Highest honest class | Artifact | Notes |
|-------------------------|----------------------|----------|-------|
| Host→project selection logic | GITHUB CI (once wired) / currently LOCAL | tests/staging/env-routing.test.mjs (17/17 pass locally) | Static eval of real config.js; preview-can-never-be-prod proven statically |
| Preview resolves to STAGING at runtime | SOURCE | config.js preview branch | NOT yet VERCEL STAGING PREVIEW — no staging-wired preview driven yet |
| Prod headers present | VERCEL PROD READ-ONLY | PRODUCTION-FRONTEND-READONLY-REPORT.md | read-only only |

> Rule reminder: the env-routing logic being correct in a static test (LOCAL/CI) does NOT
> let anyone claim the preview "resolves to staging in the browser" — that is SOURCE until
> a real staging-wired preview is driven and recorded in VERCEL-STAGING-PREVIEW-REPORT.md.
