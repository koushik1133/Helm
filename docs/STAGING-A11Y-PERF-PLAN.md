# Staging Accessibility + Performance Verification Plan

Harness: `tests/staging/a11y-perf.mjs` (Node ESM, Playwright + axe-core).
Target: the Helm **staging** Vercel preview deployment.

> **Status: PREPARE-ONLY.** The harness exists and is syntax-checked, but it has
> **not** been run against any live site. There is no `PREVIEW_URL` yet. Running
> it requires a deployed, staging-wired preview (see "Deferred" below).

## Safety posture

- **Public / unauthenticated routes only.** The harness never performs
  authenticated or write/mutating flows.
- **No DB access, no secrets.** It does not read `.staging.env`, tokens, service
  keys, or any Supabase credential. It talks only to the preview over HTTP(S).
- **Fail-closed targeting.** Target base URL comes **only** from env
  `PREVIEW_URL`. If it is unset, invalid, or resolves to the known **PROD** ref
  (`nqltzgiwznphugcfhmbm`), the harness exits **BLOCKED (3)** without running.
  Staging ref is `xizehqgeyjcfpzrdymly`.
- A skipped or unavailable check is **never** reported as PASS — it is BLOCKED.

## Route matrix

Clean URLs are enabled (`vercel.json: cleanUrls: true`), so `/crm` serves
`crm.html`, `/login` serves `login.html`, etc.

| Route        | Backing file     | Auth required | Harness treatment                |
|--------------|------------------|---------------|----------------------------------|
| `/login`     | `login.html`     | no            | full audit, gated                |
| `/dashboard` | `dashboard.html` | yes           | **deferred** (reported only)     |
| `/crm`       | `crm.html`       | yes           | **deferred** (reported only)     |
| `/quotes`    | `quotes.html`    | yes           | **deferred** (reported only)     |
| `/builder`   | `builder.html`   | no            | full audit, gated                |
| `/design`    | `design.html`    | no            | full audit, gated                |
| `/inventory` | `inventory.html` | yes           | **deferred** (reported only)     |
| `/portal`    | `portal.html`    | no            | full audit, gated                |

Auth-required routes are marked **`auth-required → deferred`**: they are loaded
and reported for visibility but never PASS or FAIL the gate, because their real
(authenticated) content cannot be exercised without seed data + a staging-wired
preview.

## Accessibility checks (axe-core)

Run with axe tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `best-practice`.

axe source resolution, in order:
1. **Preferred** — `@axe-core/playwright` (already a devDependency, v4.13.0).
2. **Fallback** — if the dev dep is absent, inject axe-core from CDN
   (`https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.13.0/axe.min.js`) at
   runtime. The harness does **not** add the package.
3. **Neither available** — route a11y result is **BLOCKED**, never PASS.

Rule categories exercised by those tags (what we expect them to catch):

- **Landmarks** — `region`, `landmark-one-main`, `landmark-unique`.
- **Labels** — `label`, `label-title-only`, `aria-input-field-name`,
  `button-name`, `link-name`, `select-name`.
- **Dialogs** — `aria-dialog-name`, `aria-required-children`,
  `aria-allowed-role` for modal/dialog widgets.
- **Focus order / keyboard** — `tabindex`, `focus-order-semantics`,
  `aria-hidden-focus`, `scrollable-region-focusable`.
- **Contrast** — `color-contrast` (text/background WCAG AA ratios).
- **Live regions** — `aria-live` usage via `aria-*` rules for status messaging.
- **Form error messaging** — `aria-valid-attr`, `aria-required-attr`, and
  input-name rules that back accessible error association.

**Threshold:** a public route PASSES a11y only with **zero** axe violations
across those tags. Any violation → route FAIL. (Impact levels are reported —
`critical`/`serious`/`moderate`/`minor` — to help triage.)

## Performance checks

Captured per route by injecting a `PerformanceObserver` snippet (no external
`web-vitals` dependency) before page scripts, then snapshotting after load:

| Metric | Source                                  | "Good" budget |
|--------|-----------------------------------------|---------------|
| LCP    | `largest-contentful-paint` entries      | ≤ 2500 ms     |
| FCP    | `paint` → `first-contentful-paint`      | ≤ 1800 ms     |
| CLS    | `layout-shift` entries (no recent input)| ≤ 0.10        |

Also captured per route:
- **Console errors** (`console.error` + uncaught `pageerror`).
- **Failed network requests / broken assets** (requests that `requestfailed`
  or respond with HTTP ≥ 400).

In this prepare-only stage, vitals are **captured and reported** against the
budgets above; broken assets and console errors are surfaced per route. A public
route FAILs the gate on any broken asset. (Vitals budgets are reported now and
can be promoted to hard gate thresholds once a stable staging preview baseline
exists — tune to the preview's cold/warm behaviour before enforcing.)

## How to run (later)

Prerequisite: a deployed staging preview URL.

```sh
PREVIEW_URL=https://<your-staging-preview>.vercel.app \
  node tests/staging/a11y-perf.mjs
```

Exit codes:

- `0` — all audited public routes PASS.
- `1` — at least one public route FAILED (a11y violations or broken assets).
- `3` — BLOCKED (no `PREVIEW_URL`, Playwright missing, or axe unavailable).
  Never reported as PASS.

Syntax check only (safe, no network, no env):

```sh
node --check tests/staging/a11y-perf.mjs
```

## Deferred: authenticated-route a11y + perf

Accessibility and performance verification of **authenticated** routes
(`/dashboard`, `/crm`, `/quotes`, `/inventory`) is **deferred** until all of:

1. the staging DB migration is applied,
2. synthetic seed data exists for the staging org/users, and
3. a staging-**wired** preview (pointed at the staging Supabase project,
   `xizehqgeyjcfpzrdymly`) is deployed.

Only then can a seeded, authenticated session exercise those routes' real
content. Until then they remain reported-but-deferred, never PASS/FAIL.

This harness is intentionally separate from the staging **security** suites
(`tests/staging/run-security.mjs` and its authz/IDOR/token/payment modules) —
it does not duplicate them.
