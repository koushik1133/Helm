# Vercel Deployment Verification Report — Helm (pre-React hardening)

**Question:** Will the current hardened Helm deploy to Vercel cleanly?
**Answer: VERCEL READY = YES** (static-only deploy; no server runtime, no DB, no migrations in the build path)

- Repo: `/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored`
- Branch: `harden/pre-react-canonical`
- Date: 2026-10-01
- Method: read-only file audit + safe local commands (`npm ci`, `npm run ci`). **No commits, no deploys, no DB touched.**
- Vercel CLI: **not installed** (`which vercel` → not found). A local `vercel build` could not be run; a manual static-build-equivalence check was performed instead (see below).

---

## Deployment separation (as designed)

| Layer | What deploys | How |
|---|---|---|
| **VERCEL** | Frontend/static only — the contents of `public/` | `outputDirectory: "public"`, `framework: null`, `buildCommand: null`, `installCommand: null` → Vercel serves `public/` verbatim, runs no build |
| **SUPABASE** | Schema / RLS / RPC / Storage / Edge Functions | Applied out-of-band from `supabase/` (SQL migrations + `functions/`). Never run by Vercel. |
| **LOCAL-ONLY** | PG17 test cluster + Supabase SQL shim + DB harness | `scripts/db-test/`, `supabase/test-harness/`, `server.js`. Used only in local dev/CI, never shipped. |

---

## Per-area verification

| Area | Status | Evidence |
|---|---|---|
| **Build** | PASS | `vercel.json`: `framework:null`, `buildCommand:null`, `installCommand:null`, `outputDirectory:"public"`. `package.json` has **no** `build`/`vercel-build`/`postinstall`/`preinstall`/`prepare` hook → nothing runs at Vercel build time. |
| **Routes / rewrites / redirects** | PASS | `cleanUrls:true`, `trailingSlash:false`; rewrite `/i/:slug* → /invite.html`; redirect `/signup → /login#signup`. All target files exist in `public/`. |
| **CSP** | PASS | Per-route CSP in `vercel.json`; `npm run ci` runs `gen-csp --check` → "CSP script hashes current (45 inline scripts, 11 policies)". Hash parity holds. |
| **Headers parity** | PASS | `test/headers-parity.test.mjs` → 300 assertion groups passed (HSTS/COOP/CORP/CSP/noindex consistent across `vercel.json`, `server.js`, `public/_headers`). Note: `public/_headers` is Netlify/CF-only; Vercel ignores it (documented in file). |
| **Static assets** | PASS | `public/` holds all HTML, `builder.js`, `builder-3d.js`, `builder.css`, `config.js`, `store-api.js`, `telemetry.js`, icons, `robots.txt`, `sitemap.xml`, `llms.txt`, `404.html`, `.well-known/security.txt`, `vendor/supabase-js-2.117.2.min.js`. Long-cache headers for js/css/img/vendor; short-cache for `config.js`. |
| **Env vars** | PASS (none required) | Client config is committed in `public/config.js` using the **public-by-design anon keys** (prod + staging), RLS-protected. No build-time env vars needed. Secrets (service-role, DB pwd, OAuth client secret, provider keys) are correctly absent from the repo/client. |
| **server.js role** | PASS (not deployed) | Zero-dependency local dev server (`node http`) serving `public/` + a `/api/layouts` JSON store to `data/layouts.json`. Lives at repo root, **outside `public/`**, so Vercel never bundles or runs it. It is the localhost REST fallback only. |
| **Test shim NOT bundled** | PASS | `supabase/test-harness/` (`00-supabase-shim.sql`, `10-fixtures.sql`) is under `supabase/`, outside `public/` → excluded from Vercel output. |
| **DB NOT in build** | PASS | No local PostgreSQL required by runtime: no `pg`, `:5432`, `postgres://`, or `require()` in `public/*.js`/`*.html` (only match is hostname-detection strings in `config.js` and the vendored supabase-js). `npm run test:db` / `db-migrate` are separate scripts, **not** in the Vercel build (there is no Vercel build step at all). Supabase migrations never auto-run from Vercel. |
| **No serverless functions** | PASS | No `api/` directory at repo root or in `public/` → Vercel provisions zero Serverless/Edge Functions. `check:deferred` confirms "no provider webhook/handler in public/". |
| **`npm ci`** | PASS | Clean install, 14 packages, 0 vulnerabilities, exit 0. |
| **`npm run ci`** | PASS | Exit 0. Includes ci-check, check-deploy-static ("All deploy-static checks passed"), migration-canon, otp-safety, deferred-integrations, env-safety, jwt-roles, gen-csp --check, and full `npm test` suite — all green. |

### Manual static-build-equivalence check (Vercel CLI unavailable)
Because `framework/buildCommand/installCommand` are all null and `outputDirectory` is `public/`, a Vercel deploy is a pure upload of `public/` with the `headers`/`rewrites`/`redirects` from `vercel.json` applied at the edge. There is no compile/bundle step to fail. `scripts/check-deploy-static.mjs` validates the `vercel.json` static-deploy contract and passed. This is the build-equivalent verification.

---

## Remaining requirements / notes (none block a clean deploy)

1. **Post-deploy header verification (recommended):** run `node scripts/check-deploy-static.mjs --url=<preview-url>` (or set `DEPLOY_CHECK_URL`) after deploy — the HTTP-level checks were skipped locally ("Static config checks only").
2. **Supabase must be provisioned independently** — schema/RLS/RPC/Storage/Edge for the target project. Per project memory, prod (`nqltzgiwznphugcfhmbm`) is hardened/applied; this is outside Vercel's scope.
3. **Staging host wiring:** if deploying a staging frontend, add its exact hostname to `window.SUPABASE_STAGING.hosts` in `config.js`; unknown hosts fail closed (never touch prod) by design.
4. **Live channels stay dormant:** `config.js` `liveChannels` sms/pay/whatsapp all `false` — flip only after the matching Edge Function is deployed with secrets.
5. **Cleanup nit (non-blocking):** a leftover `react-poc/.next/cache/` exists at repo root (React POC was discarded). It is outside `public/`, so it does **not** deploy; consider removing it for hygiene.

**Verdict: deploys to Vercel cleanly as a static site.**
