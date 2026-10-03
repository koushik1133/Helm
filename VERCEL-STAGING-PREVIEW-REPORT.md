# VERCEL-STAGING-PREVIEW-REPORT.md

> **SCAFFOLD — to be filled once a STAGING-wired Vercel branch-preview URL exists.**
> This report covers the Vercel branch-preview deploy (e.g. the preview alias for
> `harden/pre-react-canonical`) whose frontend resolves to the **STAGING** Supabase
> project (`xizehqgeyjcfpzrdymly`), NOT production. Write/runtime flows are permitted
> here because the DB is isolated staging. Do NOT fill this from the production alias
> (`helm-v01.vercel.app`) — that belongs in `PRODUCTION-FRONTEND-READONLY-REPORT.md`.

Date: 2026-10-01
Candidate SHA: 62e8095 (branch `harden/pre-react-canonical`, local HEAD)
Preview URL inspected: **BLOCKED — could not be resolved (see §A)**
Branch: harden/pre-react-canonical
Verification mode: READ-ONLY (no writes, no deploys, no browser write-flows, no Playwright)

---

## A) PREVIEW URL DISCOVERY — **BLOCKED**

The staging-wired Vercel branch-preview URL for `harden/pre-react-canonical`
**could not be resolved** from this workspace. Details:

- No committed Vercel project identifier: `vercel.json` present but contains **no**
  `name` / `alias` / `project` field; there is **no `.vercel/` directory** committed.
- No Vercel CLI available on this machine (`vercel` not on PATH), so the deployment
  URL / scope slug cannot be queried.
- A handful of plausible host candidates were probed read-only (`curl -sI`); **all
  returned HTTP 404 with `x-vercel-error: DEPLOYMENT_NOT_FOUND`**, i.e. no deployment
  is mapped to those hostnames (the scope suffix Vercel appends is unknown):
  - `helm-v01-git-harden-pre-react-canonical-koushik1133.vercel.app` → 404 DEPLOYMENT_NOT_FOUND
  - `helm-git-harden-pre-react-canonical-koushik1133.vercel.app` → 404 DEPLOYMENT_NOT_FOUND
  - `helm-v01-git-harden-pre-react-canonical.vercel.app` → 404 DEPLOYMENT_NOT_FOUND
  - `helm-git-harden-pre-react-canonical.vercel.app` → 404 DEPLOYMENT_NOT_FOUND
- For contrast, the known PRODUCTION alias `helm-v01.vercel.app/` returns **200**
  (confirmed prod-wired; correctly NOT treated as the preview).

**To unblock:** paste the actual Vercel preview URL for this branch (from the Vercel
dashboard → Deployments, or a PR "Preview" link), or connect the `vercel` CLI so the
deployment URL + scope can be resolved. Then re-run this verification.

### Expected routing once the URL is known (from committed `public/config.js`)
The served `config.js` is a **single static file identical for every host**; the
Supabase project is chosen **client-side by hostname** in the file's IIFE. Verified
statically against the committed logic:
- `PROD_HOSTS` = `{ www.helm.events, helm.events, helm-v01.vercel.app, helm-alpha-nine.vercel.app }` → production ref `nqltzgiwznphugcfhmbm` (step 1, early return).
- **Any other `*.vercel.app` host** (step 2b) → `resolveStaging()` → STAGING ref
  `xizehqgeyjcfpzrdymly`, setting `window.SUPABASE_CONFIG.__staging = true`; if staging
  were blank it **fails closed** (blank creds), never production.
- `window.SUPABASE_STAGING.url` is committed and non-blank (`https://xizehqgeyjcfpzrdymly.supabase.co`),
  so a real branch-preview host **will** resolve to STAGING deterministically.

So the branch preview, once located, is **expected to resolve to STAGING
(`xizehqgeyjcfpzrdymly`)** — but this MUST be confirmed live against §0 before any
write flow is run.

---

## 0) HARD GATE — config must resolve to STAGING (BLOCKER)
- [ ] `GET /config.js` served 200 on the preview host.  → **PENDING (no preview URL)**
- [ ] In a browser on the preview host, `window.SUPABASE_CONFIG.url` contains
      `xizehqgeyjcfpzrdymly` (STAGING ref).  → **required — PENDING**
      (Static expectation: YES, per step-2b logic above — must be confirmed live.)
- [ ] `window.SUPABASE_CONFIG.url` does **NOT** contain `nqltzgiwznphugcfhmbm`
      (PROD ref).  → **required — PENDING**
- [ ] `window.SUPABASE_CONFIG.__staging === true`.  → **PENDING**
- [ ] Zero network requests observed to `nqltzgiwznphugcfhmbm` during a dashboard load.  → **PENDING**
- [ ] Automated proof: `tests/staging/env-routing.test.mjs` passes for the preview
      hostname (static), AND Playwright `globalSetup` staging-ref assertion passed.  → **PENDING (Playwright not run per scope)**
> If any box above is unchecked, STOP — the preview is misrouted and nothing else in
> this report is trustworthy.  **→ GATE NOT PASSED: preview URL unresolved (§A). All
> sections below remain PENDING. Do NOT run any write/runtime flow.**

## 1) HTTP security headers (GET /dashboard on preview host)
- [ ] Content-Security-Policy — PENDING (no preview host)
- [ ] Strict-Transport-Security: max-age=63072000; includeSubDomains; preload — PENDING
- [ ] X-Frame-Options: DENY — PENDING
- [ ] X-Content-Type-Options: nosniff — PENDING
- [ ] Referrer-Policy: strict-origin-when-cross-origin — PENDING
- [ ] Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=() — PENDING
- [ ] Cross-Origin-Opener-Policy: same-origin — PENDING
- [ ] Cross-Origin-Resource-Policy: same-origin — PENDING
- [ ] X-Robots-Tag: noindex, nofollow, noarchive (app page) — PENDING
> Note: the probed non-existent hosts DID return `strict-transport-security:
> max-age=63072000; includeSubDomains; preload` from the Vercel edge 404 — informational
> only; full per-route header verification requires the real preview host.

## 2) Per-page CSP overrides — PENDING (no preview host)
- [ ] portal / proposal / proposal-view / media relaxed img-src — PENDING
- [ ] invite / invite-studio / /i/* frame-ancestors 'self' — PENDING
- [ ] No page downgrades script-src to 'unsafe-inline' — PENDING

## 3) Routes (status codes on preview host) — PENDING (no preview host)
- [ ] 200: / /dashboard /login /builder /crm /leads /quotes /approve /proposal
      /proposal-view /portal /design /inventory /work /command /control /settlement
      /invite /sim-pay — PENDING
- [ ] /config.js /store-api.js 200 — PENDING

## 4) 404 handling — PENDING (no preview host)

## 5) robots / sitemap / security.txt — PENDING (no preview host)

## 6) Static assets — PENDING (no preview host)

## 7) Source maps / test-file exposure — PENDING (no preview host)

## 8) Runtime sweep (ALLOWED here — staging DB) — PENDING (no preview host; not in scope for this run)

---

## Static config-safety check (performed — not host-dependent)
- [x] Committed `public/config.js` carries **public values only**: both keys are
      Supabase **anon** JWTs (`"role":"anon"`). No `service_role`, no `sb_secret`,
      no DB password, no OAuth client secret present.
- [x] Staging block (`window.SUPABASE_STAGING`) url = `https://xizehqgeyjcfpzrdymly.supabase.co`
      (STAGING), anonKey ref = `xizehqgeyjcfpzrdymly`.
- [x] Prod block (`window.SUPABASE_CONFIG`) url = `https://nqltzgiwznphugcfhmbm.supabase.co`
      (PROD) — only used by the explicit `PROD_HOSTS` allowlist.

## STATUS: **BLOCKED (preview URL unresolved)**
Staging-ref hard gate (§0): **NOT PASSED — preview URL could not be resolved (§A)**.
Remaining items: all live header/route/exposure/runtime checks PENDING until the real
staging-wired preview URL is provided. Static config logic indicates any non-prod
`*.vercel.app` host will route to STAGING (`xizehqgeyjcfpzrdymly`) or fail closed —
never production — but this requires live confirmation against §0 before any write flow.
