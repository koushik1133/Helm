# Helm: Setup and Environment

This page explains how to get Helm running on your own computer, which settings and secrets the live sites rely on and where each one is kept, how database changes reach staging and then production, and which test and check commands to run. Everything here was checked against the code on `origin/main`, and each section names the files it comes from. **No secret values appear on this page, only their names.**

Related docs: `docs/RUNBOOK.md`, `docs/CANONICAL-DEPLOYMENT.md`, `docs/STAGING-SETUP.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/DB-TEST-SUITE.md`, `scripts/staging/README.md`, `scripts/staging/EDGE-SECRETS-INVENTORY.md`, `supabase/functions/README.md`.

---

## 1. The three environments

| Environment | Website | Supabase project ref | How the browser picks it |
|---|---|---|---|
| Production | `helm.events`, `www.helm.events` | `nqltzgiwznphugcfhmbm` | `PROD_HOSTS` allowlist in `public/config.js` |
| Staging | `helm-v01.vercel.app` | `xizehqgeyjcfpzrdymly` | `SUPABASE_STAGING.hosts` in `public/config.staging.js` |
| Local | `http://127.0.0.1:4173` | none by default | `public/config.js` clears the Supabase settings on localhost |

How the browser decides which database to use (`public/config.js`):
- On an exact production host it uses the production project. The old address `helm-alpha-nine.vercel.app` counts as production too, and `vercel.json` redirects it to `www.helm.events`.
- On a non-production host it loads `config.staging.js` and uses the staging project. Production visitors never request that file, and `vercel.json` returns 404 for it on production hosts.
- A host it does not recognise, including a Vercel preview with no staging settings, **stops with an error instead of connecting** (it "fails closed"). It never falls back to production.
- On **localhost** it clears the Supabase URL and key, so the app uses the local Node server (`server.js`) or the browser's own storage, and cannot change production data by accident.
  - Connecting from localhost to production on purpose takes an explicit opt-in: `window.HELM_ALLOW_PROD_FROM_LOCALHOST = true`, or the time-stamped value `helm.allowProdFromLocalhost` in the browser's localStorage. The localStorage opt-in expires after 8 hours.
  - The app also accepts staging settings from `window.HELM_STAGING_SUPABASE` or the localStorage key `helm.staging`. The localStorage version is only used if its URL looks like a real Supabase project address.

The Supabase "anon" (public) keys in `config.js` and `config.staging.js` are public by design. Row-level security (RLS) on the database protects the data. **The service-role key, the database password and provider secrets must never appear in `public/`.**

## 2. Local setup

| Step | Command or detail | Source |
|---|---|---|
| Clone | `git clone https://github.com/koushik1133/Helm.git`. Work in a git worktree if you like; the repo's own scripts expect normal (non-iCloud) disk paths. | memory: GitHub workflow |
| Node version | Node **18 or newer** is required (`engines.node >= 18`). CI uses **Node 20**. There is no `.nvmrc` file. | `package.json`, `.github/workflows/ci.yml` |
| Install | `npm install`, or `npm ci` (uses `package-lock.json`). The only runtime dependency is `@supabase/supabase-js@2.117.3`. Dev dependencies are `@playwright/test` and `@axe-core/playwright`. | `package.json` |
| Run | `npm start` or `npm run dev`. Both run `node server.js`. | `package.json` |
| Port | **4173** by default. `PORT=<n>` changes it; the server refuses to start if the value is not a valid port. | `server.js` |
| Bind address | `127.0.0.1` by default. `HOST=0.0.0.0` opens it to your local network on purpose. | `server.js` |
| Coding-agent preview | `.claude/launch.json` defines `blueprint-stage` (`node server.js`, port 4173, `autoPort`). | `.claude/launch.json` |

What `server.js` does (it needs nothing beyond Node itself):
- Serves the files in `public/`.
- Runs a small layouts API (`/api/health`, `/api/layouts` with create, read, update and delete). It saves layouts to `data/layouts.json` safely: it writes a temporary file and then renames it, so a crash cannot leave a half-written file.
- Sends the same security headers as production. `test/headers-parity.test.mjs` checks this.

Optional settings for `server.js`:

| Name | Purpose |
|---|---|
| `PORT` | Listen port (default 4173) |
| `HOST` | Bind address (default 127.0.0.1) |
| `LAYOUTS_API_TOKEN` | Token that write calls to the layouts API must present when the server is reachable from other machines |
| `TRUST_PROXY=1` | Trust the `X-Forwarded-For` header when rate-limiting |
| `HELM_TRUSTED_TYPES=report` | Adds a report-only Trusted Types security policy (CSP) |

**Local mode in practice.** On localhost, sign-in and anything else that needs Supabase does nothing unless you choose to connect:
- To work against **staging** from localhost, the routing in `config.js` together with `config.staging.js` (or a `helm.staging` override) points the app at the staging project.
- Some features are switched on only on localhost: `HELM_FEATURES.integrationsPage`, and the "skip payment" testing bypass (`onboarding.allowPaymentBypass`). The bypass is off on `helm.events` only.

Assumption: day-to-day feature testing happens against the staging project, not the browser-storage-only fallback, because most pages need Supabase sign-in.

## 3. Vercel (hosting)

Source: `vercel.json`.
- The site is static. There is no build step (`framework: null`, `buildCommand: null`), and Vercel serves the `public/` folder as it is.
- `cleanUrls` (addresses without `.html`) and the URL rewrites live in `vercel.json`, for example `/<studio>/quote/<token>` → `/approve` and `/i/<slug>` → `/invite`.
- **No Vercel environment variables are read at runtime.** The front end has no build step and contains no `process.env`. The environment is chosen in the browser from the hostname (section 1).
- The production project serves `helm.events`. The staging site is `helm-v01.vercel.app`.

Decision needed: confirm whether the Vercel production project should have **any** environment variables. Today none are needed. If old ones are still there, remove them so nobody gets the wrong idea about where settings live.

## 4. Supabase Edge Function secrets (names only)

Set these with `supabase secrets set NAME=...` on each project, staging and production separately. Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` into every function automatically. The list below comes from scanning `Deno.env.get` calls in `supabase/functions/**`; the per-function detail is in `scripts/staging/EDGE-SECRETS-INVENTORY.md`.

| Area | Secret / setting names | Functions | Current state (owner facts) |
|---|---|---|---|
| Core / CORS | `APP_URL`, `ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` | `_shared/cors.ts`, all browser-called functions | set per environment |
| Email (Resend) | `RESEND_API_KEY`, `RESEND_FROM`, `MANAGER_EMAIL` | `invite-mailer`, `welcome-mailer`, `security-alert-mailer`, `billing-reminder`, `comms-dispatch`, `pkg-client-notify` | Sender is `notifications@helm.events`; replies go to the studio's own email |
| Email switches + shared secrets | `HELM_INVITE_EMAILS_ENABLED`, `HELM_INVITE_EMAIL_SECRET`, `HELM_INVITE_DIRECT_SIGNUP`, `HELM_WELCOME_EMAILS_ENABLED`, `HELM_WELCOME_EMAIL_SECRET`, `HELM_SECURITY_ALERTS_ENABLED`, `HELM_SECURITY_ALERT_SECRET`, `HELM_SECURITY_ALERT_HQ_TO`, `HELM_COMMS_ENABLED`, `HELM_COMMS_SECRET`, `HELM_PKG_NOTIFY_ENABLED`, `HELM_PKG_NOTIFY_SECRET`, `HELM_BILLING_REMINDERS_ENABLED`, `HELM_BILLING_CRON_SECRET` | as above | |
| Batch sizes | `INVITE_EMAIL_BATCH`, `WELCOME_EMAIL_BATCH`, `SECURITY_ALERT_BATCH`, `COMMS_BATCH`, `PKG_NOTIFY_BATCH`, `BILLING_REMINDER_BATCH`, `UPLOAD_SCAN_BATCH` | dispatchers | optional |
| SMS (MSG91) | `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_TEMPLATE_ID`, `MSG91_SMS_TEMPLATE_ID`, `MSG91_INTL` | `send-otp`, `send-phone-code` | **Off**: `liveChannels.sms = false` |
| WhatsApp (Meta Cloud API) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_TEMPLATES`, `WHATSAPP_TPL_LANG`, `WHATSAPP_API_VERSION`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_REQUIRE_OPTIN`, `WHATSAPP_VERIFY_TEMPLATE`, `WHATSAPP_VERIFY_LANG`, `PKG_WHATSAPP_TEMPLATE` | `send-whatsapp`, `wa-webhook`, `wa-proposal`, `pkg-client-notify` | **Off** in the app (`liveChannels.whatsapp = false`). The owner sets up WhatsApp separately (`docs/ops/WHATSAPP-SETUP.md`) |
| Payments (Razorpay) | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `PAYMENT_LINK_TTL_MINUTES`, `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED` | `create-payment-link`, `razorpay-webhook`, `create-subscription-checkout`, `razorpay-subscription-webhook` | **Off**: `liveChannels.pay = false` |
| Upload scanning | `HELM_UPLOAD_SCAN_ENABLED`, `HELM_UPLOAD_SCAN_SECRET`, `HELM_UPLOAD_QUARANTINE`, `HELM_AV_URL`, `HELM_AV_TOKEN`, `HELM_AV_ALLOWED_HOSTS`, `HELM_AV_TIMEOUT_MS` | `verify-upload` | Assumption: off or not set up unless the owner turned it on |
| Booklet snapshot | `HELM_BOOKLET_SNAPSHOT_ENABLED` | `booklet-snapshot` | |
| Photo render (AI) | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `RENDER_TIMEOUT_MS`, `RENDER_COST_USD_*` | `render-photo` | Inactive until the key is set. **Only the owner starts renders** (`docs/PHOTO-RENDER-SETUP.md`) |

Every channel stays switched off until three things are all true: the function is deployed, its secrets are set, and its flag is on. The browser flags are `liveChannels` in `public/config.js`, and the server flags are the `HELM_*_ENABLED` settings. `scripts/check-deferred-integrations.mjs` enforces this.

**Settings stored in the database** (changed with SQL, not stored as secrets):
- `helm_billing_settings.allow_trial_bypass`: migration 0162 sets this to false, for production only.
- `helm_hq_settings.hq_require_mfa`: migration 0047; this goes together with `auth.mfaRequiredForAdmins` in `config.js`.
- Turnstile bot protection: the public key is `captcha.siteKey` in `config.js`, currently empty, so it is off. The secret key is entered only in the Supabase Auth dashboard (`docs/AUTH-DASHBOARD-SETTINGS.md`).
- Google sign-in: the OAuth client is set up in the Supabase and Google Cloud dashboards. Google sign-in is working.

**Operator-only tokens** (supplied for one command at a time, never committed):

| Name | Used for |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Personal access token (starts with `sbp_`) used by `scripts/staging/*.sh` |
| `HELM_DB_URL` and the standard `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE` | Database connection for `scripts/db-migrate.sh` |
| `HELM_E2E_BASE_URL`, `HELM_E2E_PORT`, `HELM_E2E_PASSWORD`, `HELM_E2E_SERVICE_ROLE`, `HELM_E2E_STAGING_URL`, `HELM_E2E_STAGING_ANON` | Playwright end-to-end tests and staging test suites |
| `DEPLOY_CHECK_URL`, `PREVIEW_URL`, `LOADTEST_*` | Post-deploy checks and load tests |

Secret scanning: `.github/workflows/secret-scan-history.yml` scans git history, and `scripts/check-env-safety.mjs` (`npm run check:env`) checks the code for secrets.

## 5. Database connection and migrations

- **Source of truth:** `supabase/migrations/MANIFEST`. It lists one `base` snapshot, applied only to a brand-new database, followed by about 160 `forward` migrations, numbered up to **0162** (`0162_launch_bypass_off.sql`). If a database object is defined in more than one migration, the latest one wins. Older `supabase/phase*.sql` files and `setup-complete.sql` are **out of date and must not be run**.
- **Rules:** changes only ever add things, and every migration is written so it is safe to run twice. Never edit a migration that has already been applied; write a new one instead (`docs/FILL-ONLY-MIGRATIONS.md`). `scripts/check-migration-canon.mjs` and `scripts/check-base-immutable.mjs` enforce this.
- **Runner:** `scripts/db-migrate.sh --plan | --apply | --verify`.
  - It records each applied migration and its sha256 checksum in `public.helm_schema_migrations`, and skips files that are already recorded.
  - If an applied file's content has changed since then (drift), it stops with an error.
- **Order of work:**
  1. Run `scripts/db-test/run-all.sh` (`npm run test:db`). It builds a throwaway local Postgres 17, applies the migrations, checks that running them a second time changes nothing, loads test data for two separate studios, and runs the SQL test suites in `tests/db/*.sql`.
  2. **Staging:** `scripts/staging/precheck.sh` → `apply-canonical.sh` → `verify.sh`. These use the Supabase Management API, refuse to touch the production project ref, and stop if they find drift.
  3. **Production:** paste the matching `supabase/APPLY-*.sql` bundle into the Supabase SQL editor once staging checks pass, in number order. Run `supabase/PRODUCTION-PRECHECK.sql` first, then the `VERIFY-*.sql` script for that bundle. Do not rely on temporary tables or other session state in editor pastes (`docs/CANONICAL-DEPLOYMENT.md`).
- **Edge functions:** deploy with `supabase functions deploy <name>`, or for staging with `scripts/staging/deploy-edge.sh`. There are 20 functions in `supabase/functions/`.

Decision needed: the `0162` launch switch (no "skip payment" on production) and any migration that is on staging but not yet on production need the owner's go-ahead before they are applied to production. Keep a record of which migrations are applied where in the staging-vs-prod tracker.

## 6. Seed and demo data

| Source | What it creates | Where it is used |
|---|---|---|
| `supabase/migrations/0097_trial_demo.sql`, `0100_demo_seed_fix.sql`, `0102_uae_demo_seed.sql`, `0138_demo_staff_phones.sql` | Demo or trial studio content (India and UAE) | Part of the migration list, so it reaches every environment that runs migrations |
| `supabase/test-harness/00-supabase-shim.sql`, `10-fixtures.sql` | Supabase stand-ins plus test data for two separate studios | Local database tests only |
| `scripts/staging/seed-test-data.mjs`, `cleanup-test-data.mjs` (see `DATA-FACTORY.md`) | Made-up test records on staging | Staging only |
| `supabase/seed-users.sql` | Old user seed with default passwords | **Do not use.** These accounts are part of the open default-password clean-up |

Decision needed: whether demo seed migrations should keep shipping to the **fresh** production project (memory: "Fresh Mumbai prod plan"), or be split out so production starts empty.

## 7. Dev scripts and checks

There is no separate linter (like ESLint) and no TypeScript type checking. Quality is enforced by the custom check scripts and test files below.

| Command | What it does |
|---|---|
| `npm test` | Runs about 200 Node test files, `test/*.test.mjs` plus `tests/staging/env-routing.test.mjs`. They check the code's structure and behaviour without a browser or database. |
| `npm run ci` | Everything CI runs. Static checks for unsafe HTML, inline styles, pinned GitHub Actions, migration rules, base immutability, OTP safety, deferred integrations, env safety, JWT roles, the CSP hash list and the capture host, followed by `npm test`. |
| `npm run check:deploy` / `check:localapi` / `check:migration` / `check:otp` / `check:deferred` / `check:env` / `check:jwt` / `check:csp` / `check:base` | Run one check at a time |
| `npm run gen:csp` | Regenerates the CSP hash list after inline-script changes |
| `npm run test:db` | Local Postgres 17 database suites (needs Homebrew `postgresql@17`, or `PG*` settings pointing at a database) |
| `npm run test:isolation` | Checks that one studio cannot see another studio's data (`tests/db/tenant-isolation.mjs`) |
| `npm run test:e2e` (also `:smoke`, `:security`, `:roles`, `:approval`, `:a11y`, `:responsive`, `:reliability`, `:privacy`, `:lifecycle`, `:chromium`, `:firefox`, `:webkit`) | Playwright browser tests. `playwright.config.mjs` starts the local server on port 4173 for them. `playwright.staging.config.mjs` runs them against staging. |
| `npm run loadtest` | `scripts/loadtest.mjs` |
| Edge function tests | `tests/edge/*.test.ts`, run with Deno (`deno.lock`, `tests/edge/import_map.json`) |
| Lighthouse | `lighthouserc.json` and `.github/workflows/lighthouse.yml` (performance and accessibility scores) |

GitHub workflows in `.github/workflows/`: `ci.yml`, `codeql.yml`, `db-canonical-pg17.yml`, `db-tests.yml`, `e2e.yml`, `lighthouse.yml`, `secret-scan-history.yml`.

## 8. Tools used by coding agents

Running Helm needs **no MCP servers or AI tooling**. These tools are used only during development:
- **Claude Code:** `.claude/launch.json` (local preview server). The project memory files hold owner rules: zero data loss, work locally until told to push, never run photo renders, and keep a record of which SQL has run on staging and production.
- **Supabase CLI:** deploying functions, setting secrets, and linking the project with `supabase link --project-ref …`.
- **Vercel:** hosting through Git integration, with the static `public/` folder.
- **Playwright and axe-core:** browser and accessibility tests.
- **Deno:** edge function tests.
- **Postgres 17 (Homebrew):** the local database test cluster.
- Assumption: any MCP connectors in an agent session (browser control, docs, and so on) are optional helpers; nothing in the repo depends on them.

## 9. Fixed owner settings

| Setting | Value |
|---|---|
| Default theme | Emerald / green, light. Dark mode is **off**. |
| Email | Sender is `notifications@helm.events`; Reply-To is the studio's own email. |
| Payments, SMS and WhatsApp | Switched off in the app. The owner sets up WhatsApp separately. |
| Production | `helm.events`, connected to production Supabase |
| Staging | `helm-v01.vercel.app`, connected to staging Supabase |

## 10. Decisions needing owner approval

1. **Production database changes:** approve each migration that is on staging but not yet on production, including `0162`, before it is applied to production.
2. **Making admins use two-step sign-in (MFA):** turn on `auth.mfaRequiredForAdmins` together with `hq_require_mfa`. When?
3. **Turnstile bot protection:** whether to turn it on (needs the public key in `config.js` and the secret key in the Supabase dashboard).
4. **Demo seed data on a fresh production project:** keep it or split it out (section 6).
5. **Default-password accounts and `seed-users.sql`:** reset or delete those accounts, and retire the file.
6. **Vercel environment variables:** confirm none are needed and remove any leftovers.
7. **Upload virus scanning (`HELM_UPLOAD_SCAN_*`, `HELM_AV_*`):** whether to turn it on for launch.
8. **Turning on payments, SMS and WhatsApp later:** each needs its secrets set, the function deployed and its flag flipped, and each needs separate approval.
