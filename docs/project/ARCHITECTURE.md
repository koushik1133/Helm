# Helm — System Architecture

Status: describes what exists on `origin/main` (checked against the code, 2026-10-17). File paths are relative to the repo root.
Conventions: **Assumption:** means not proven from the code. **Decision needed:** means the owner has to decide. No secret values appear here, only the names of variables and secrets.

---

## 1. What Helm is, in one paragraph

Helm is a multi-tenant SaaS for event studios. A studio is an **organization**. Its staff take an enquiry from **lead** to **quote**. The quote row *is* the event, so there is no separate events table that has to stay in sync. After the quote come the **2D/3D floor-plan builder**, **client approval / booklet / portal**, **planning, run sheet and crew tasks**, and finally **settlement and closure**. Roles: admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, and client (who uses token links, not a staff login).

---

## 2. Stack and why

| Layer | Technology | Where | Reasoning |
|---|---|---|---|
| Frontend | Vanilla HTML + CSS + JS, no framework, no build step | `public/*.html`, `public/*.js`, `public/*.css` (~270 files) | Zero toolchain and instant deploys, and every page loads on its own. A React/Next.js migration was tried and dropped, so the product stays vanilla. |
| Hosting / CDN | Vercel, static output only | `vercel.json` (`outputDirectory: public`, `buildCommand: null`, `cleanUrls`) | Static files at the edge. Security headers and rewrites are declared in one file. |
| Database | Supabase Postgres with Row-Level Security | `supabase/canonical-base/`, `supabase/migrations/0001…0162` | The browser talks to Postgres directly through PostgREST/RPC. RLS is the authorization boundary, so there is no app server to keep secure. |
| Auth | Supabase Auth (email/password, Google OAuth, TOTP MFA) | `public/store-api.js`, `public/login.html`, `public/auth-ui.js` | A managed identity service. Its JWT carries `auth.uid()`, which RLS uses. |
| Server-side logic | Postgres functions (about 260 RPCs called from the client) + Supabase Edge Functions (Deno) | `supabase/migrations/*`, `supabase/functions/*` | Business rules such as pricing, money, closure gates and tenancy run inside the database, inside transactions. Edge functions handle anything that needs a secret or a third-party call. |
| Client SDK | `@supabase/supabase-js` 2.117.2, self-hosted and version-pinned | `public/vendor/supabase-js-2.117.2.min.js`, `public/vendor/README.md` | No third-party script CDN is needed at runtime, so the CSP can stay `'self'`. |
| Local dev server | Node `server.js` (zero dependencies) | `server.js`, `server/jobs`, `server/services` | Serves `public/` locally, plus a small `/api/layouts` file-backed fallback used when Supabase is blanked. |

---

## 3. Frontend architecture

- **Multi-page app.** Each screen is its own HTML file, for example `dashboard.html`, `leads.html`, `quotes.html`, `builder.html`, `booklet.html`, `runsheet.html`, `settlement.html`, `closure.html`, `control.html` (settings / Control Center) and `hq.html` (Helm HQ / platform operator).
- **Shared core, loaded on every page:**
  - `config.js` / `config.staging.js` hold runtime config and the host-based environment router (see §9).
  - `store-api.js` (~10.5k lines) exposes the global data layer `BPStore`. It covers the Supabase client, the auth/session gate, the role capability matrix, pricing helpers (`quoteTotal`, `breakdown`), realtime subscriptions, and pretty URL routing.
  - `shell-proto.js` injects the signed-in app layout (`shell-b.*`) on an allow-list of studio pages. Marketing pages, public/client links, crew `work.html`, HQ, the builder and auth pages keep their own layouts.
  - `ui-kit.js` / `ui-kit.css` provide shared UI (toasts, dialogs). `form-validate.js` holds the shared validators. `trusted-types.js` is the DOM-sink policy. `telemetry.js` handles error capture (§10).
- **Feature modules:** `builder.js`, `builder-3d.js`, `builder-tools.js` (floor plan); `booklet*.js` (client booklet); `onboarding*.js`, `trial*.js` (signup/trial); `crew-schedule.js`, `vendor-bills-ui.js`, `smart-import*.js`, `wa-proposal.js`, and others.
- **Pretty URLs:** `vercel.json` rewrites `/<studio>/dashboard`, `/<studio>/quote/<token>`, `/<studio>/portal/<token>`, `/<studio>/work/<token>`, `/i/<slug>` (invitation site), and so on to the matching HTML file. `store-api.js` (`prettyRoutes`) keeps the address bar consistent.
- **Theme:** the default theme is Emerald (green, light). Dark mode is off (`theme.css`, `shell-b-theme-*.css`).
- **Feature switches** live in one place, `config.js`: `HELM_FEATURES.integrationsPage` is on only on localhost, and `SUPABASE_CONFIG.liveChannels.{sms,pay,whatsapp}` are all `false`.

---

## 4. Backend architecture

There is no custom app server in production. The "backend" has three parts:

1. **Postgres schema + RLS.** Every tenant table carries `org_id`. Policies combine `org_id = current_org_id()` with `has_area(area, need)`.
2. **RPC functions (`SECURITY DEFINER`)** for anything multi-step or sensitive. Examples: pricing authority (`0001_pricing_authority.sql`, `phase99-server-pricing-authority.sql`), `close_event` with its balance gate, inventory reservation (`0071_reserve_inventory_atomic.sql`), numbering, token-link reads such as `invitation_by_token`, `worker_get_tasks` and `resolve_event_ref`, and the crew task flows (`worker_respond*`).
3. **Edge Functions (Deno)** in `supabase/functions/`, sharing code in `_shared/cors.ts`, `_shared/limits.ts` and `_shared/money.ts`:

| Function | Purpose | State |
|---|---|---|
| `invite-mailer`, `welcome-mailer`, `security-alert-mailer`, `billing-reminder`, `pkg-client-notify`, `comms-dispatch` | Outbound email and notifications (Resend) | Each one is gated by its own `HELM_*_ENABLED` flag and shared secret |
| `invite-signup` | Invite → direct staff signup | `HELM_INVITE_DIRECT_SIGNUP` |
| `send-otp`, `send-phone-code` | SMS OTP via MSG91 | Off (`liveChannels.sms=false`) |
| `send-whatsapp`, `wa-proposal`, `wa-webhook` | Meta WhatsApp Cloud API | Off. The owner sets up WhatsApp separately |
| `create-payment-link`, `razorpay-webhook`, `create-subscription-checkout`, `razorpay-subscription-webhook` | Razorpay payments and subscriptions | Off (`liveChannels.pay=false`, `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED`) |
| `verify-upload` | Upload scanning / quarantine | `HELM_UPLOAD_SCAN_ENABLED`, `HELM_UPLOAD_QUARANTINE` |
| `booklet-snapshot` | Frozen booklet snapshot | `HELM_BOOKLET_SNAPSHOT_ENABLED` |
| `render-photo` | AI photo render of a layout (OpenAI images) | Only the owner triggers it |
| `integrations-test` | Connection tests for integrations | — |

Details are in `supabase/functions/README.md` and `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`.

---

## 5. Data flow

```
Browser page ──► BPStore (store-api.js)
                 ├─ supa.from(table).select/insert/update   ──► PostgREST ──► RLS (org_id + has_area)
                 ├─ supa.rpc('fn', args)                    ──► SECURITY DEFINER fn (own authz checks)
                 ├─ supa.channel(...) realtime              ──► chat, versions, bell notifications
                 ├─ supa.storage                            ──► buckets (media, chat attachments, manual)
                 └─ supa.functions.invoke('edge-fn')        ──► Edge Function ──► Resend / MSG91 / Meta / Razorpay / OpenAI
Public client (no login) ──► token URL /<studio>/quote|portal|proposal|work/<token>
                 ──► anon-callable token RPCs (validate token, expiry window, and scope)
```

Lifecycle: **lead** (`leads.html`, `crm.html`, `nurture.html`) → **quote = event** (`quotes.html`, `event.html`, `proposal.html`) → **floor plan** (`builder.html`, layouts table) → **client approval** (`approve.html`, `booklet.html`, `portal.html`) → **planning** (`plan.html`, `runsheet.html`, `ops.html`, `staff.html`, `work.html` for crew) → **settlement / closure** (`settlement.html`, `closure.html`; `close_event` gate). Workflow details: `docs/helm-team-workflows.md`.

**Money rule:** the browser computes prices only for display. The server re-prices and is the authority (D8, `0001_pricing_authority.sql`, `phase99-server-pricing-authority.sql`; tests `test/money-trust-boundary.test.mjs` and `test/pricing-differential*.test.mjs`).

---

## 6. Folder structure

| Path | Contents |
|---|---|
| `public/` | The entire deployed site: HTML pages, JS modules, CSS, `vendor/`, `brand/`, `home-assets/`, `docs/`, `robots.txt`, `sitemap.xml`, `_headers` |
| `supabase/canonical-base/` | Schema snapshot extracted from prod (fresh installs only) |
| `supabase/migrations/` | Forward-only, idempotent migrations `0001…0162` plus `MANIFEST` (the only sanctioned apply order) |
| `supabase/APPLY-*.sql`, `VERIFY-*.sql`, `APPLY-PENDING.sql`, `PRODUCTION-PRECHECK.sql` | Paste-ready bundles for the Supabase SQL editor, with matching verify queries |
| `supabase/phase*.sql`, `wave*/`, `security-fix/`, `prod-fix/` | Historical SQL. Where it conflicts with `migrations/`, the latest definition wins. Older helpers such as `has_area` were first defined in `phase29.sql` and are now part of the canonical base |
| `supabase/functions/` | Edge functions + `_shared/` |
| `server.js`, `server/` | Local dev server, invite cleanup job, notification service |
| `scripts/` | CI guards, CSP generator, asset bumper, `db-migrate.sh`, loadtest, db-test |
| `test/` (~250 files), `tests/` | Node source-characterization tests, Playwright E2E, DB isolation tests |
| `.github/workflows/` | `ci.yml`, `codeql.yml`, `db-canonical-pg17.yml`, `db-tests.yml`, `e2e.yml`, `lighthouse.yml`, `secret-scan-history.yml` |
| `docs/`, `*.md` (root) | Runbooks, audits, setup guides |

---

## 7. Database interaction

- `BPStore` loads the pinned supabase-js from `vendor/` and creates **one** client with `SUPABASE_CONFIG.url` + `anonKey`. The anon key is public by design, and RLS protects the data.
- **Reads** use table selects under RLS, or `get_*` / `list_*` / `dashboard_*` / `insights_*` RPCs. A small stale-while-revalidate cache (`SWR_KEEP_RPCS` in `store-api.js`) applies only to read-only RPC names.
- **Writes** that touch money, numbering, inventory or state transitions go through RPCs, not raw table updates. `0025_write_path_lockdown.sql` and `0005_least_privilege.sql` revoke direct writes where an RPC must be used.
- **Tenancy:** `current_org_id()` is `select org_id from profiles where id = auth.uid()` (SECURITY DEFINER, `search_path=public`). `0004_tenant_integrity.sql` and `0136_tenant_guard_catchup.sql` enforce `org_id` on writes.
- **Fallback:** if Supabase is unavailable or deliberately blanked (localhost without opt-in), `BPStore` falls back to the local Node `/api/layouts` and then to `localStorage`. This is only for dev and offline use.
- Migrations are applied with `scripts/db-migrate.sh --plan|--apply|--verify` against the ledger table `public.helm_schema_migrations`, or by pasting APPLY bundles into the Supabase SQL editor (no temp tables or session state; see `docs/FILL-ONLY-MIGRATIONS.md`). Rule: additive and idempotent only. No migration may destroy or cross-expose data.

---

## 8. Authentication and authorization

### AuthN
- Supabase Auth with email + password and Google OAuth (PKCE, `detectSessionInUrl`, `login.html`). Password rules and server-side lockout come from `0030`, `0050` and `0053_password_lockout.sql`. Temporary-password change: `password_change_required` RPC.
- **MFA (TOTP):** the session gate in `store-api.js` checks `mfa.getAuthenticatorAssuranceLevel()`. If `nextLevel=aal2` and the session is still aal1, the user goes through the code step. Wrong codes lock code entry on the server (5 wrong attempts → 15 minutes, `0050`, `mfa_record_failure` / `mfa_lock_status`), with a verify hook in `0158_mfa_verify_hook.sql`. The admin requirement is switched by `config.js auth.mfaRequiredForAdmins` (currently `false`) together with `helm_hq_settings.hq_require_mfa` (`0043`, `0047`).
- The session idle and max-age limits are configurable in `config.js auth.session`. They are currently 0 (off), so Supabase refresh tokens keep users signed in.
- Bot protection: there is a Cloudflare Turnstile hook (`captcha.siteKey`), currently empty (off). See `docs/AUTH-DASHBOARD-SETTINGS.md` and `docs/AUTH-PRODUCTION-HARDENING.md`.
- **Decision needed:** when to turn on MFA-required for admins, the idle timeout, and Turnstile for launch.

### AuthZ
- `role_access(role, area, can_view, can_edit)` is an admin-editable matrix, changed in the Control Center (`admin_get_role_access` / `admin_set_role_access`).
- `has_area(area, need)` is the single helper that RLS policies and RPC guards call (about 70 migrations reference it). RPCs raise `42501 not authorized` when it fails.
- The client-side capability matrix in `store-api.js` hides UI only. An unknown role fails **closed**. The server stays the real gate.
- Platform operator / HQ: `0029_platform_admin.sql` and `0037_platform_operator_check.sql`. `hq.html` is private (`test/hq-private.test.mjs`).
- Clients and crew without accounts use **token links** with time windows and auto-expiry (`0012`, `0022`, `0039`, `0040`).

---

## 9. Environment configuration

| Host | Supabase project | Notes |
|---|---|---|
| `helm.events`, `www.helm.events` (prod) | prod `nqltzgiwznphugcfhmbm` | Explicit allow-list in `config.js`. Payment bypass forced off |
| `helm-v01.vercel.app` (staging) | staging `xizehqgeyjcfpzrdymly` | Listed in `config.staging.js` `hosts`. Tab title gets the suffix "— STAGING" |
| Other `*.vercel.app` previews | staging, or fail-closed | Can never reach prod |
| localhost / LAN | staging, or blanked → local fallback | Prod only with an explicit opt-in that expires after 8 hours |

- `config.staging.js` loads only on non-prod hosts, and `vercel.json` 404s it on prod hosts.
- Unknown hosts **fail closed**: Supabase URL blanked, `__localFallback=true`. Guarded by `scripts/check-env-safety.mjs`, `test/config-router.test.mjs` and `tests/staging/env-routing.test.mjs`.
- Edge-function secrets and variables (names only), set in the Supabase dashboard:
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST`
  - Email: `RESEND_API_KEY`, `RESEND_FROM`
  - SMS: `MSG91_*`
  - WhatsApp: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_*` template settings
  - Payments: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`
  - Photo render: `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`
  - Upload scanning: `HELM_AV_URL`, `HELM_AV_TOKEN`
  - Per-function `HELM_*_ENABLED` / `HELM_*_SECRET` pairs and `*_BATCH` sizes
- Owner fact: the email sender is `notifications@helm.events`, with Reply-To set to the studio's email. **Assumption:** this is configured via `RESEND_FROM` per environment. The code default falls back to a Resend test sender when it is unset.
- The GitHub Actions E2E secrets (`HELM_E2E_*`) must point only at staging.

---

## 10. Error handling and observability

- **UI:** `UI.toast(...)` gives plain-language errors. Capability-aware messages explain "you don't have access" instead of showing raw SQL errors (`test/capability-aware-errors.test.mjs`). An expired session shows a toast asking the user to copy unsaved work and sign in again (`store-api.js`).
- **Auth resilience:** a transient network blip does not sign the user out (handled in `onAuthStateChange`).
- **Saves:** relational save failures surface to the user (`test/rel-save-failure.test.mjs`). Builder autosave lives in `flow-autosave.js`.
- **Server:** RPCs raise errors with SQLSTATE (`42501` for authz, `P0001` for business rules such as the closure balance gate). The `audit_log` (`phase47`, `0135`) records changes.
- **Telemetry:** `telemetry.js` captures `error` / `unhandledrejection` events, strips tokens and PII, and forwards to Sentry. It is a **no-op until a DSN is set** (`window.HELM_TELEMETRY`). The CSP already allows the Sentry CDN. See `docs/OBSERVABILITY-ACTIVATION.md`.
- **Decision needed:** whether to activate Sentry (or another tool) for prod.
- Runbooks: `docs/RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`.

---

## 11. Security boundaries

| Boundary | Mechanism | Evidence |
|---|---|---|
| Browser → DB | RLS on every tenant table (`org_id` + `has_area`) | `0006_rls_access_gates.sql`, `0011_authz_complete.sql`, `phase57-multitenant-rls.sql` |
| RPCs | `SECURITY DEFINER` with pinned `search_path`, explicit authz + org checks inside, `revoke … from anon` unless token-based | `0007_rpc_authz_guards.sql`, `phase71–73-definer-*`, `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md` |
| Secrets | Only the anon key is in the client. The service role exists only in edge functions. CI fails on any non-anon JWT | `scripts/check-jwt-roles.mjs`, gitleaks in `ci.yml` |
| Edge functions | CORS allow-list (`_shared/cors.ts`), request limits (`_shared/limits.ts`), shared-secret headers for cron/internal calls, webhook signature checks (Razorpay/Meta) | `test/edge-functions-hardening.test.mjs` |
| Web headers | Strict CSP (`script-src 'self'` + sha256 hashes, no `'unsafe-inline'` scripts; `connect-src` limited to the Supabase project), HSTS, X-Frame-Options, COOP/CORP, Referrer-Policy, Permissions-Policy, X-Robots-Tag on private pages | `vercel.json`, `scripts/gen-csp.mjs`, `docs/CSP-UNSAFE-INLINE-AUDIT.md` |
| DOM | No unescaped `innerHTML` sinks; Trusted Types policy | `scripts/check-html-sinks.mjs`, `public/trusted-types.js` |
| Uploads | Type/size guard, quarantine + AV scan hook, private buckets | `0013`, `0048`, `0051`, `verify-upload` |
| Integrations | Fail-closed / dormant until deployed and flagged on | `scripts/check-deferred-integrations.mjs` |

Known open items are tracked in `FINAL-HARDENING-REGISTER.md` and `docs/OWNER-ACTIONS-SECURITY.md`. **Decision needed:** default-password accounts, private repos, and Supabase auth settings (owner actions).

---

## 12. Testing

- `npm test` runs about 230 zero-dependency Node tests (source characterization, no DB).
- `npm run ci` runs every guard script (`ci-check`, actions pinned to SHAs, HTML sinks, no new inline styles, deploy-static, migration canon, OTP safety, base immutable, deferred integrations, env safety, JWT roles, CSP hashes current, capture-host) and then `npm test`.
- E2E: Playwright (`playwright.config.mjs`, `playwright.staging.config.mjs`) with tags such as `@smoke`, `@security`, `@roles` and `@a11y`. It runs against **staging only** and is gated on `HELM_E2E_*` secrets (`e2e.yml`).
- DB: `npm run test:db` (`scripts/db-test`) and `npm run test:isolation` (tenant isolation). `db-canonical-pg17.yml` rebuilds the schema from `MANIFEST` on Postgres 17. See `docs/DB-TEST-SUITE.md`.
- Also: CodeQL (weekly + PRs), full-history secret scan (weekly), Lighthouse (`lighthouserc.json`), `npm audit --audit-level=high`, and `scripts/loadtest.mjs`.

## 13. Deployment

1. **Frontend:** Vercel deploys `public/` as-is. `main` deploys to prod `helm.events`. Staging is `helm-v01.vercel.app`. See `docs/CANONICAL-DEPLOYMENT.md`. Working rule: test locally first, then staging, and push to `main` only on the owner's word.
2. **Cache busting:** JS/CSS are referenced as `file.js?v=N`. Every changed asset must be bumped with `node scripts/bump-changed-assets.mjs --apply`, then checked with `--verify`. The script also covers loader constants and `SHELL_V` in `shell-proto.js`. Skipping this means users keep running stale cached code.
3. **CSP:** after any inline-script change, run `npm run gen:csp`. CI fails if the hashes are stale.
4. **Database:** add a new numbered file to `supabase/migrations/` and to `MANIFEST`. Generate the paste-ready `supabase/APPLY-NNNN.sql` + `VERIFY-NNNN.sql`, refresh `APPLY-PENDING.sql`, and apply to **staging first**, then prod. Always additive and idempotent.
5. **Edge functions:** deploy with the Supabase CLI per function, set secrets in the dashboard, then flip the function's `HELM_*_ENABLED` flag and, for channels, the `liveChannels` flag in `config.js`. See `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`.
6. Recovery and rollback: `docs/DISASTER-RECOVERY-RUNBOOK.md`.

---

## 14. MVP today vs future scalability

| Area | MVP (now) | Future / scale path |
|---|---|---|
| Frontend | Static vanilla multi-page app; very large shared `store-api.js` | Split `store-api.js` into lazily loaded modules; keep vanilla (no framework migration planned) |
| Backend | Supabase single region (prod `nqltzgiwznphugcfhmbm`); logic in RPCs | **Decision needed:** a fresh clean prod project in Mumbai (owner chose "Option A", timing open); read replicas / connection pooling as load grows |
| Tenancy | Shared schema, `org_id` + RLS | Same model scales; add per-tenant usage limits and plan gates (`0159_direct_studio_plan_gate.sql` is the start) |
| Integrations | Email on (Resend); SMS, WhatsApp, Razorpay switched off | Turn on per channel after deploying + setting secrets (owner sets up WhatsApp); add a job queue / retries for `comms-dispatch` |
| Observability | Telemetry code present, no DSN; Supabase logs | Activate Sentry, uptime checks, DB alerting (`docs/OBSERVABILITY-ACTIVATION.md`) |
| Background jobs | Edge functions triggered by cron/secret calls and batch sizes | **Assumption:** scheduling is done with Supabase cron/pg_net or external cron; verify in the dashboard. Move to a durable queue at higher volume |
| Testing | Source-level guards + gated staging E2E | Make E2E mandatory once staging test creds exist; add DB tests per migration |
| Security | RLS + definer guards, strict CSP, MFA optional | MFA required for admins, Turnstile, session limits, private repos, SOC-style audit log export |
| Deferred features | Time-aware calendar, lead overwrite fix, dashboard period filter, dark mode | Owner-parked; see `REMINDERS.md` / `BACKLOG-meeting.md` |
