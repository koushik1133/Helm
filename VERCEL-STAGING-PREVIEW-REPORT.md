# VERCEL-STAGING-PREVIEW-REPORT.md

> **SCAFFOLD — to be filled once a STAGING-wired Vercel branch-preview URL exists.**
> This report covers the Vercel branch-preview deploy (e.g. the preview alias for
> `harden/pre-react-canonical`) whose frontend resolves to the **STAGING** Supabase
> project (`xizehqgeyjcfpzrdymly`), NOT production. Write/runtime flows are permitted
> here because the DB is isolated staging. Do NOT fill this from the production alias
> (`helm-v01.vercel.app`) — that belongs in `PRODUCTION-FRONTEND-READONLY-REPORT.md`.

Date: <YYYY-MM-DD>
Candidate SHA: <sha>
Preview URL inspected: https://<preview-alias>.vercel.app
Branch: harden/pre-react-canonical

---

## 0) HARD GATE — config must resolve to STAGING (BLOCKER)
- [ ] `GET /config.js` served 200 on the preview host.
- [ ] In a browser on the preview host, `window.SUPABASE_CONFIG.url` contains
      `xizehqgeyjcfpzrdymly` (STAGING ref).  → **required**
- [ ] `window.SUPABASE_CONFIG.url` does **NOT** contain `nqltzgiwznphugcfhmbm`
      (PROD ref).  → **required**
- [ ] `window.SUPABASE_CONFIG.__staging === true`.
- [ ] Zero network requests observed to `nqltzgiwznphugcfhmbm` during a dashboard load.
- [ ] Automated proof: `tests/staging/env-routing.test.mjs` passes for the preview
      hostname (static), AND Playwright `globalSetup` staging-ref assertion passed.
> If any box above is unchecked, STOP — the preview is misrouted and nothing else in
> this report is trustworthy.

## 1) HTTP security headers (GET /dashboard on preview host)
- [ ] Content-Security-Policy (hash-based script-src; object-src 'none'; frame-ancestors
      'none'; base-uri 'self'; form-action 'self'; connect-src self + *.supabase.co +
      sentry; upgrade-insecure-requests) — record verbatim.
- [ ] Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
- [ ] X-Frame-Options: DENY
- [ ] X-Content-Type-Options: nosniff
- [ ] Referrer-Policy: strict-origin-when-cross-origin
- [ ] Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
- [ ] Cross-Origin-Opener-Policy: same-origin
- [ ] Cross-Origin-Resource-Policy: same-origin
- [ ] X-Robots-Tag: noindex, nofollow, noarchive (app page)
> Note: a *.vercel.app preview host is NOT covered by the HSTS `preload` list; the header
> is still sent. Confirm Vercel does not inject preview-only headers that relax CSP.

## 2) Per-page CSP overrides (portal / proposal / proposal-view / media / invite /
##    invite-studio / i/*)
- [ ] portal, proposal, proposal-view, media → relaxed img-src https: present, script-src
      still hash-based.
- [ ] invite, invite-studio, /i/* → frame-ancestors 'self' / X-Frame-Options SAMEORIGIN.
- [ ] No page downgrades script-src to 'unsafe-inline'.

## 3) Routes (status codes on preview host)
- [ ] 200: / /dashboard /login /builder /crm /leads /quotes /approve /proposal
      /proposal-view /portal /design /inventory /work /command /control /settlement
      /invite /sim-pay  (record full list)
- [ ] /config.js /store-api.js 200

## 4) 404 handling
- [ ] Unknown route → custom /404 with noindex.

## 5) robots / sitemap / security.txt
- [ ] /robots.txt — disallows app/token routes; marketing crawlable.
- [ ] /sitemap.xml — present, lists only intended public URLs.
- [ ] /.well-known/security.txt — present; Contact mailbox is REAL (not placeholder).

## 6) Static assets
- [ ] @supabase/supabase-js served self-hosted (no third-party CDN at JS level).
- [ ] No unexpected third-party origins in Network tab beyond supabase + sentry + fonts + cdnjs.

## 7) Source maps / test-file exposure
- [ ] /config.js.map, /store-api.js.map → 403/404.
- [ ] No `sourceMappingURL` footer in served JS.
- [ ] /supabase/test-harness/* , /supabase/migrations/* , /tests/* → 404 (not bundled).
- [ ] /.env /.git/config /package.json /server.js /vercel.json → 404.

## 8) Runtime sweep (ALLOWED here — staging DB)
- [ ] Per-route console-error sweep: zero uncaught errors / zero CSP violations.
- [ ] Network-failure sweep: no fail-open to prod; no unexpected 5xx.
- [ ] Login + one write flow drives STAGING only (cross-check §0 network guard).

## STATUS: <PENDING / PASS / FAIL>
Staging-ref hard gate (§0): <result>. Remaining items: <summary>.
