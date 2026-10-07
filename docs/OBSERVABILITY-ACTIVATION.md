# Observability Activation Runbook (Step 6)

Helm already ships the *code* for error reporting (`public/telemetry.js`) and a
health endpoint (`/api/health`). Nothing is "on" until an operator activates the
three layers below. None of this changes app behaviour or features — it only adds
visibility. Do these at deploy time.

Status legend: ☐ = to do · the "Verify" line is how you *know* it worked.

---

## 1. Error tracking — Sentry (≈20 min)

`telemetry.js` is already wired: it installs global `error` + `unhandledrejection`
handlers, **auto-loads** the Sentry browser SDK (`browser.sentry-cdn.com/8.35.0`),
and inits it with a `beforeSend` that **redacts** JWTs, tokens, OTPs, emails and
phone numbers. It is a **NO-OP until a DSN is set**. CSP already allows the Sentry
CDN + ingest hosts (`server.js` CSP_BASE and `vercel.json`), so **no CSP change is
needed**.

**Activate:**
1. Create a Sentry project (JavaScript/Browser) → copy its **DSN**.
2. In `public/config.js`, **before** anything else runs, set:
   ```js
   window.HELM_TELEMETRY = {
     dsn: 'https://<public-key>@<org>.ingest.sentry.io/<project>',
     env: 'production',          // or 'staging'
     release: '2026-10-01'       // bump per deploy for regression attribution
   };
   ```
   The DSN is a **public** ingest key (safe in client code, like the anon key) — it
   is NOT a secret. Do **not** put the Sentry *auth token* here.
   - Staging vs prod: set `env` per environment. You can gate it so localhost stays
     off: only set `HELM_TELEMETRY` when `location.hostname` is a real deployed host.
3. In Sentry → **Alerts**, create an **error-spike** alert (e.g. "new issue" +
   "events > N in 1h") routed to email/Slack. Spike alerts matter more than per-error.

**Verify:** in the browser console on the deployed site run `throw new Error('obs-test')`
(or `HelmTelemetry.report('error',{message:'obs-test'})`) → the event appears in
Sentry **within a minute**, with PII redacted. `window.HelmTelemetry.enabled === true`.

---

## 2. Uptime monitoring (≈10 min)

Separate from error tracking — catches *fully down*, not just erroring. Helm exposes
`GET /api/health` → `{ ok: true }` (HTTP 200), a perfect liveness probe.

**Activate** (UptimeRobot / Better Uptime / Checkly — all have free tiers):
1. Monitor **A**: `https://<your-domain>/api/health` — HTTP keyword monitor,
   expect `"ok":true`, **interval 1 min**.
2. Monitor **B**: `https://<your-domain>/` (the app itself) — HTTP 200, 1 min.
3. Alerts → email + SMS/Slack. Optionally a public status page.

**Verify:** stop the server (or take the deployment offline) for ~30s → you get a
**DOWN alert**, then an **UP** alert when it recovers.

---

## 3. Product/debug analytics — PostHog (≈20 min)

For **debugging** (reconstruct what a user did before a bug), not growth metrics.
Session replay + event capture.

**CSP change required** (PostHog is a new host — unlike Sentry it's not yet allowed):
- In `server.js` `CSP_BASE` and `vercel.json`, add PostHog's host to **`script-src`**
  and **`connect-src`** (e.g. `https://*.posthog.com` or your self-hosted origin).
  Re-run `npm run gen:csp` so the hash-based CSP is regenerated, then
  `npm run check:csp` to confirm it validates.

**Activate:**
1. Create a PostHog project (cloud or self-hosted — self-host if you need India data
   residency) → copy the **project API key** (public, client-side) + host.
2. Load the PostHog snippet in a shared `<head>` include, initialised with the key.
3. Capture the **debug-critical** events around your core flows (not everything):
   `login`, `quote_created`, `quote_approved`, `payment_recorded`, `settlement_*`,
   plus page views. Enable **session replay** (mask inputs — PII).

**Verify:** sign in on the deployed site, perform one core action, then in PostHog
open **Session Replay** and watch that session + see the custom events.

---

## Definition of done (all three)
- Sentry: intentional error shows up **< 1 min**, redacted; spike alert configured.
- Uptime: 30s outage triggers a DOWN alert.
- Analytics: a real session replay is viewable with your core events.

## Notes / guardrails
- Every key used here (Sentry DSN, PostHog project key) is **public/client-side** and
  safe to commit, exactly like the Supabase anon key. Never commit the Sentry **auth
  token** or any `service_role`/DB secret (CI `gitleaks` will fail the build if you do).
- `telemetry.js` redaction already strips tokens/OTP/email/phone before send — keep
  that `beforeSend` intact if you ever hand-roll the Sentry init.
- Keep monitoring **off on localhost** so local dev noise doesn't pollute prod issues.
