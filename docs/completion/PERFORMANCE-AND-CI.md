# Performance & CI Additions

This document describes the CI, security-scan, and performance-tooling additions
that raise the Infrastructure / Testing / Scalability posture of Helm. Nothing
here touches production, front-end HTML, `store-api.js`, or SQL.

## What was added

### 1. CodeQL static analysis — `.github/workflows/codeql.yml`
GitHub's CodeQL scanner for `javascript-typescript`. Runs on push and PR to
`main`, plus a weekly scheduled scan (Mondays) so newly published queries re-scan
older code. Standard `init` + `analyze` with the default query suite; results
appear in the repo **Security → Code scanning** tab.

### 2. E2E in CI (gated) — `.github/workflows/e2e.yml`
Runs the existing Playwright suite against **staging**. It is **gated on
repository secrets**: a `gate` job checks that `HELM_E2E_STAGING_URL`,
`HELM_E2E_STAGING_ANON`, `HELM_E2E_EMAIL`, and `HELM_E2E_PASSWORD` are all
present and only then runs the tests. When the secrets are absent (every fork /
external-contributor PR, since secrets are never exposed to forks) the workflow
**skips cleanly and never fails**. Playwright runs with `--trace off`. The
Playwright HTML report is uploaded as an artifact.

### 3. Load test — `scripts/loadtest.mjs` (+ `npm run loadtest`)
Zero-dependency HTTP load generator using Node's built-in `fetch` and a fixed
pool of concurrent workers. **No new npm dependencies** — the project keeps its
zero-runtime-dependency posture.

Hammers `LOADTEST_URL` (default `http://127.0.0.1:4173/`) at `N` concurrency for
`T` seconds and reports **p50 / p95 / p99 latency, throughput (req/s), and error
rate**.

```
npm run loadtest
LOADTEST_URL=http://127.0.0.1:4173/api/health npm run loadtest
node scripts/loadtest.mjs --concurrency 50 --duration 20
```

Env / flags: `LOADTEST_URL`, `LOADTEST_CONCURRENCY` (`--concurrency`),
`LOADTEST_DURATION` (`--duration`), `LOADTEST_METHOD` (`--method`),
`LOADTEST_TIMEOUT` (`--timeout`). **Point it only at localhost or a staging URL
you own — never production or a third-party host.**

### 4. Lighthouse budgets — `lighthouserc.json` (+ optional `.github/workflows/lighthouse.yml`)
`lighthouserc.json` defines advisory performance/accessibility/best-practices/SEO
budgets (all `warn`, never error) for `index.html`, `login.html`, and
`dashboard.html`, served by `node server.js` on port 4173. The optional workflow
runs `npx @lhci/cli` (**no committed dependency**) and is fully **non-blocking**
(`continue-on-error` at both job and step level) — perf budgets inform, they
never fail a build or block a merge.

## OWNER actions

1. **Add GitHub Actions secrets** (repo → Settings → Secrets and variables →
   Actions) so the gated E2E workflow runs — all pointing at **staging only**,
   never production:
   - `HELM_E2E_STAGING_URL`
   - `HELM_E2E_STAGING_ANON`
   - `HELM_E2E_EMAIL`
   - `HELM_E2E_PASSWORD`
   Until these are set, the E2E workflow skips (by design).
2. **Review the Lighthouse budgets** in `lighthouserc.json` and tighten/loosen
   `minScore` and numeric thresholds to match real targets before making them
   blocking (if ever).
3. **Run the load test against staging** (not prod) to capture a real baseline,
   e.g. `LOADTEST_URL=<staging-url> node scripts/loadtest.mjs --concurrency 50
   --duration 30`, and record p50/p95/p99 for future regression comparison.
4. **Enable CodeQL** results review in the Security tab (no config needed; the
   workflow uploads automatically once merged to `main`).

## Honest current state

- **Load test:** the script is verified to run and produce output against a
  local `node server.js`, but **no load test has been run against staging yet** —
  no baseline numbers are recorded here.
- **Lighthouse:** the config and workflow are in place but **no Lighthouse run
  has been captured**; budgets are starting-point defaults, not measured targets.
- **CodeQL & E2E workflows:** committed but not yet exercised on GitHub Actions
  from this change; E2E stays skipped until the owner adds the secrets above.
- No production endpoint, front-end HTML, `store-api.js`, or SQL was touched.
