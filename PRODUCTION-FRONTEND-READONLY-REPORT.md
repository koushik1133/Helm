# PRODUCTION-FRONTEND-READONLY-REPORT.md

> **This is the PRODUCTION frontend read-only report — NOT a staging preview report.**
> `helm-v01.vercel.app` is the PRODUCTION frontend wired to the PRODUCTION Supabase
> project (`nqltzgiwznphugcfhmbm`). Everything below was gathered by READ-ONLY inspection
> of that production surface. No write flows were exercised. For the staging-wired Vercel
> branch-preview verification (where write/runtime flows are allowed), see the separate
> `VERCEL-STAGING-PREVIEW-REPORT.md`.

Date: 2026-10-01
Candidate SHA: 8fe1206b5dfb9ad071122d30f74e57b10f8abffa
URL inspected (read-only): https://helm-v01.vercel.app  (PRODUCTION alias)

## ⚠️ IMPORTANT WIRING CAVEAT
`helm-v01.vercel.app/config.js` defaults `window.SUPABASE_CONFIG.url` to the **PRODUCTION**
Supabase project `nqltzgiwznphugcfhmbm`. This alias is the **production frontend wired to the
production database**. Therefore:
- READ-ONLY checks below (headers, routes, static assets, CSP, exposure probes) were run — safe.
- **NO write-flow E2E / payment / OTP / signup tests were run here** — that would mutate
  production data, which is NOT authorized. Those belong on a staging-wired surface
  (local static server or a preview build pointed at `xizehqgeyjcfpzrdymly` via the
  config.js `helm.staging` override / env), covered once staging DB is live.

## HTTP security headers (GET /dashboard) — ALL PRESENT
- Content-Security-Policy: hash-based `script-src 'self'` + cdnjs + sentry-cdn + ~45 sha256 hashes; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `connect-src 'self' https://*.supabase.co wss://*.supabase.co + sentry`; `upgrade-insecure-requests`. ✓
- Strict-Transport-Security: max-age=63072000; includeSubDomains; preload ✓
- X-Frame-Options: DENY ✓ · X-Content-Type-Options: nosniff ✓
- Referrer-Policy: strict-origin-when-cross-origin ✓
- Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=() ✓
- Cross-Origin-Opener-Policy: same-origin ✓ · Cross-Origin-Resource-Policy: same-origin ✓
- X-Robots-Tag: noindex, nofollow, noarchive ✓ (app page correctly non-indexable)

## Routes (status codes)
- 200: / · /dashboard · /login · /builder · /invite · /settlement · /portal · /design ·
  /work (worker portal) · /approve · /proposal-view · /sim-pay · /command · /control ·
  /config.js · /store-api.js · /robots.txt · /sitemap.xml · /.well-known/security.txt
- (Note: worker route is `/work`, not `/worker`.)

## Exposure / safety probes (expected 404/403)
- /.env 404 · /.git/config 404 · /.git/HEAD 404 · /package.json 404 · /server.js 404 · /vercel.json 404 ✓
- /config.js.map 403 · /store-api.js.map 403 (source maps blocked) ✓
- store-api.js has NO `sourceMappingURL` footer (clean) ✓
- **/supabase/test-harness/00-supabase-shim.sql → 404** (test shim NOT bundled) ✓
- /supabase/migrations/0001_pricing_authority.sql → 404 (migrations not served) ✓

## config.js inspection
- Public values only: prod anon key + staging anon key (both public-by-design, RLS-protected). ✓
- NO service_role / sb_secret present. ✓
- localhost→prod requires explicit opt-in (fail-closed). ✓
- localStorage `helm.staging` override validated against `https://<ref>.supabase.co` regex (injection-resistant). ✓

## security.txt / robots
- security.txt Contact present but Contact mailbox is a **PLACEHOLDER** (`security@helm.events`
  "must be confirmed by the owner"). → P3: confirm a real monitored mailbox before prod.
- robots.txt disallows app/token routes; marketing pages crawlable. ✓

## Minor / informational
- `access-control-allow-origin: *` on static HTML (Vercel default for static assets). No
  cookie-based session here (Supabase auth is header/localStorage), so not a credential-leak
  vector; note only. (LOW)
- `/_headers` (Netlify-style) is served 200 but inert on Vercel (vercel.json is authoritative).
  Harmless leftover; consider removing. (LOW)

## Pending (needs a browser against a staging-wired surface — not the prod alias)
- Runtime console-error / network-failure sweep per route.
- Confirm @supabase/supabase-js is self-hosted (no external CDN) at the JS level.
- No environment fail-open at runtime.

## STATUS (read-only, prod alias): PREVIEW HEADERS/ROUTES/ASSETS VERIFIED
Write-flow runtime verification deferred to a staging-wired surface (not production).
