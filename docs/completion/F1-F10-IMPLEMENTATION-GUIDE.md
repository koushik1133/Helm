# F1–F10 — What each is & how to implement in production

Plain-language guide to the 10 open findings from ELITE-AUDIT.md. Each says **what it is**, **why it matters**, **who does it**, and **the exact steps**.

---

## F1 — Live error monitoring (Sentry) + uptime  🔴
**What it is:** Sentry is a hosted service that catches JavaScript errors in your users' browsers (and messages from your app) and shows them in a dashboard with the stack trace, page, browser, and how many users hit it. "Uptime monitoring" is a separate service that pings your site every minute and alerts you if it's down. Right now Helm has the *code* wired (`public/telemetry.js`) but no Sentry project, so it does nothing.

**Why it matters:** without it, if a customer hits an error or the site goes down, you find out from an angry email, not a dashboard. This is the #1 reason the audit says "blind in prod."

**Who:** You create the accounts (free tiers exist); I wire the code.

### Step-by-step — create & configure Sentry
1. Go to **https://sentry.io** → sign up (free tier is fine to start).
2. **Create a project** → platform **"Browser JavaScript"** → name it `helm-web`.
3. Sentry shows you a **DSN** — a URL like
   `https://abc123@o456.ingest.us.sentry.io/789`. Copy it. (The DSN is *public/safe* to ship in the frontend — it can only *send* events, not read them.)
4. **Enable it in Helm.** In `public/config.js`, near the top (before other scripts run), add:
   ```html
   <!-- already loaded per-page; set the config once in config.js -->
   window.HELM_TELEMETRY = {
     dsn: 'https://abc123@o456.ingest.us.sentry.io/789',  // your DSN
     env: 'production',
     release: '2026-09-29'   // bump on each deploy
   };
   ```
   Then add the Sentry Loader snippet (from your project's **Settings → Client Keys → Loader Script**) to the page `<head>`, OR let me add an auto-loader to `telemetry.js` (it already uses `window.Sentry` if present).
5. **Allow Sentry in the CSP.** In `vercel.json`, add Sentry's hosts:
   - `script-src`: add `https://browser.sentry-cdn.com https://js.sentry-cdn.com`
   - `connect-src`: add `https://*.ingest.sentry.io https://*.ingest.us.sentry.io`
   (I'll prepare this patch — without it the browser blocks Sentry.)
6. **Deploy** (to the customer frontend). Then **verify**: open the site, run `throw new Error('sentry-test')` in the console → it appears in Sentry within seconds.

**PII safety:** `telemetry.js` already redacts JWTs/tokens/OTP/email/phone before sending, and we set Sentry's `beforeSend` to scrub too. No secrets leave the browser.

### Uptime monitoring (5 min)
1. Sign up at **https://uptimerobot.com** (free) or Betterstack.
2. **Add monitor** → HTTP(s) → URL `https://www.helm.events` → interval 1–5 min.
3. Add an alert contact (email/SMS/Slack). Optionally add a second monitor on a Supabase health URL.

**Done = F1 at ~9–10.** (I wire the code + CSP; you create Sentry + UptimeRobot + paste the DSN + deploy.)

---

## F2 — Deploy the hardened frontend to customer production  🔴
**What it is:** your production site `www.helm.events` is served from the **praneeth** repo, which is **43 commits behind** the hardened `koushik` repo. So the DB is fixed but customers load old frontend code.
**Why:** customers miss all the input-validation/RBAC/a11y hardening.
**Who:** You (deploy); I prepare the exact patch.
**Steps:** confirm which repo/branch Vercel serves for `www.helm.events` → I produce a clean fast-forward or cherry-pick patch (`CUSTOMER-FRONTEND-PARITY.md`) → you review + merge + let Vercel deploy → smoke-test login/quote/approve on the live site.

---

## F3 — Backup restore drill  🔴
**What it is:** proving you can actually *recover* from a backup, not just that backups exist. Prod is on Supabase Pro (daily snapshots + PITR available), but restore has never been tested.
**Why:** an untested backup is a hope, not a plan.
**Who:** You (needs a throwaway target); I scripted it (`BACKUP-RESTORE-RUNBOOK.md` + `RESTORE-VERIFY.sql`).
**Steps:** take/confirm a snapshot → restore it into a **new throwaway** Supabase project (never over prod/staging) → run `RESTORE-VERIFY.sql` (expect all PASS) → record how long it took (that's your RTO) → destroy the throwaway.

---

## F4 — Per-identity RPC rate-limiting + circuit breakers  🟠
**What it is:** (a) Rate-limiting = stop one logged-in user from hammering expensive database functions thousands of times/sec. (b) Circuit breaker = when a third-party (WhatsApp/Razorpay, once enabled) starts failing/timing out, stop calling it for a bit instead of piling up.
**Why:** prevents abuse, runaway DB cost, and cascading failures.
**Who:** Me (build) + you tune limits.
**Steps (I do):** add a small `rate_limit(key, max, window)` helper table + check inside hot SECURITY DEFINER RPCs; wrap the edge functions (`send-otp`, `send-whatsapp`, `create-payment-link`) with timeout + retry + breaker. Test: loop an RPC past the limit → it's rejected; simulate a provider timeout → breaker opens.

---

## F5 — Structured logging + tracing  🟠
**What it is:** logs in machine-readable JSON (not free text) and "traces" that follow one request across systems (browser → edge function → DB). For a static + Supabase app, the practical version is: enable **Supabase Log Drains** to ship logs somewhere searchable, and add Sentry breadcrumbs (comes with F1). Full OpenTelemetry tracing only matters once you add a real backend tier.
**Who:** You (Supabase log drain config) + me (structured logs from edge functions).
**Steps:** Supabase → Settings → Log Drains → point to a store (Datadog/Logtail/S3). I make the edge functions emit JSON logs with request id + org id (no PII).

---

## F6 — MFA (2-factor) for admin & manager  🟠
**What it is:** require a second factor (authenticator-app code / TOTP) for privileged logins, so a stolen password isn't enough.
**Why:** admin/manager accounts control everything; password-only is weak for them.
**Who:** You enable TOTP in the dashboard; I build the enrollment screen + enforcement.
**Steps:** Supabase → Authentication → **Multi-Factor** → enable **TOTP**. I add: an enrollment UI (show QR, verify a code, save the factor) and a sign-in gate that requires MFA (AAL2) for `admin`/`manager` before they can act. Test: an admin without MFA is prompted to enroll and blocked from privileged actions until they do.

---

## F7 — Optimistic locking everywhere (lost-update protection)  🟠
**What it is:** if two people edit the same record at once, the second save should be told "this changed, reload" instead of silently overwriting the first. Helm has this on some save paths (`updateMeta` with `expectedUpdatedAt`) but not all.
**Why:** prevents silent data loss when two staff edit the same event/quote.
**Who:** Me (build) + a product decision on which flows need it.
**Steps (I do):** thread `expectedUpdatedAt` through the remaining mutating call-sites (or add a version check in the RPCs). Test: two tabs edit the same quote → the second save returns CONFLICT and prompts reload.

---

## F8 — Load/performance baseline  🟠
**What it is:** actually measuring how the app behaves under many concurrent users and how fast pages load — you've never done this. The tools are now in the repo.
**Who:** You run them (ideally against staging on a paid tier).
**Steps:** `npm run loadtest` (set `LOADTEST_URL` to staging) → records p50/p95/p99 latency + req/s. Run Lighthouse (`lighthouserc.json`) for page-load scores. Capture the numbers as your baseline; fix anything egregious.

---

## F9 — Frontend bundling/minify + broader accessibility  🟡
**What it is:** the app ships raw multi-file JS/HTML (works fine, tiny deps) but isn't minified/code-split, and accessibility (axe) is only checked on 3 pages. `builder.html` is 4,020 lines (heavy first paint).
**Who:** Me (optional, lower priority).
**Steps:** add an optional `esbuild` minify step for the largest files; broaden the axe/keyboard a11y checks to the top ~10 screens. Not a launch blocker.

---

## F10 — Turn on e2e tests in CI  🟡
**What it is:** the automated browser tests exist and pass, but the CI job that runs them is **gated off** until you add the staging credentials as GitHub secrets (so external contributors don't fail).
**Who:** You (add secrets).
**Steps:** GitHub repo → Settings → Secrets and variables → Actions → add `HELM_E2E_STAGING_URL`, `HELM_E2E_STAGING_ANON`, `HELM_E2E_SERVICE_ROLE`, `HELM_E2E_PASSWORD` (staging values only). The `e2e.yml` workflow then runs them on every PR automatically.

---

## Quick ownership summary
| Finding | You do | I do |
|---|---|---|
| F1 Sentry+uptime | create Sentry + UptimeRobot, paste DSN, deploy | code wiring + CSP patch |
| F2 frontend parity | approve + deploy | prepare the patch |
| F3 backup drill | provide throwaway DB, run it | scripts ready |
| F4 rate-limit/breakers | tune limits | build |
| F5 logging/tracing | Supabase log drain | edge-fn JSON logs |
| F6 MFA | enable TOTP in dashboard | build enrollment + enforcement |
| F7 optimistic lock | decide scope | build |
| F8 load baseline | run `npm run loadtest` | tool shipped |
| F9 bundle/a11y | — | build (optional) |
| F10 e2e in CI | add GitHub secrets | workflow shipped |

**Fastest path to real safety:** F1 (Sentry+uptime) → F2 (deploy hardened frontend) → F3 (backup drill) → rotate the exposed DB password → confirm CAPTCHA off. Those five remove the actual launch blockers.
