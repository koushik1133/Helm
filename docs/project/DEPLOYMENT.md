# Helm — Production Deployment Runbook

Plain-English runbook for shipping Helm to staging and production, checking that the deploy fully landed, and rolling back. It describes what exists in the repo today. File paths are relative to the repo root.

Related docs (reuse, do not duplicate): `docs/CANONICAL-DEPLOYMENT.md` (DB migration mechanism), `docs/RUNBOOK.md` (ops / 2 AM checklist), `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/ops/EMAIL-SETUP.md`, `docs/ops/WHATSAPP-SETUP.md`, `supabase/functions/README.md`, `docs/project/SETUP-AND-ENVIRONMENT.md`, `docs/project/INTEGRATIONS.md`.

> Rule zero: no step here may delete, overwrite or cross-tenant-expose data. Migrations are additive and idempotent; rollback of the **site** is a Vercel redeploy, never a database restore unless the DR runbook says so.

---

## 1. Environments at a glance

| | Staging | Production |
|---|---|---|
| Git remote | `origin` → `github.com/koushik1133/Helm` | `prod` → `github.com/praneethreddykiwik/Helm` |
| Hosting | Vercel, auto-deploys on push to `main` | Vercel, auto-deploys on push to `main` of the prod repo |
| Public URL | `https://helm-v01.vercel.app` | `https://www.helm.events` (apex `helm.events`) |
| Supabase project ref | `xizehqgeyjcfpzrdymly` (helm-staging) | `nqltzgiwznphugcfhmbm` |
| Front-end DB wiring | `public/config.staging.js`, selected by hostname in `public/config.js` | `public/config.js` defaults |
| Checkout "skip payment" bypass | ON (testing) | OFF — `config.js` `onboarding.allowPaymentBypass` is false on `helm.events`, and server flag via migration `0162_launch_bypass_off.sql` (prod only) |

Verified: `git remote -v` in the repo shows exactly these two remotes. `public/config.js` routes `helm-v01.vercel.app` / `*.vercel.app` / localhost to the staging Supabase project and keeps the production URL for `helm.events`.

Assumption: both Vercel projects build from the `main` branch of their repo with the settings in `vercel.json` (no build step, `outputDirectory: "public"`, `cleanUrls: true`). The site is static; `server.js` is local-dev only (`scripts/check-deploy-static.mjs` asserts this).

---

## 2. Release procedure (push)

Order is always **local → staging → prod**. Do not push to prod until the owner says "push to main / go live".

### 2.1 Before pushing
1. Working tree clean, on `main`, up to date: `git fetch --all && git status`.
2. Cache-busting: every changed `public/**/*.js|css` must have a bumped `?v=N` everywhere it is referenced.
   - `node scripts/bump-changed-assets.mjs` (dry run) → `--apply` → `--verify` (must exit 0).
3. Run the gate: `npm run ci` (lint-style checks, CSP hash check `gen-csp.mjs --check`, migration canon, deploy-static, env-safety, deferred-integrations, then `npm test`). Must be green.
4. Optional but recommended: `npm run test:e2e:smoke` against staging.

### 2.2 Staging
```bash
git push origin main          # Vercel staging auto-deploys helm-v01.vercel.app
```
Apply any new SQL to **staging** first (section 4), deploy any changed edge functions to staging (section 5), then run the checks in section 3 against `https://helm-v01.vercel.app`.

### 2.3 Production
Only after staging passes and the owner approves:
```bash
git push prod main            # Vercel prod auto-deploys www.helm.events
```
Then apply the same SQL to **prod** in the same order, deploy the same edge functions to prod, and re-run section 3 against `https://www.helm.events`.

Decision needed: whether prod pushes are always fast-forward of the exact staging commit (recommended), or whether the prod repo may diverge. Today the docs assume the same commit.

---

## 3. Verify the deploy really landed

Vercel can report "Ready" while a browser still runs old JS. Check **inner pages**, not only the landing page.

| Check | How | Pass |
|---|---|---|
| Deployment status | Vercel dashboard → Deployments → latest is Ready and is the commit you pushed | SHA matches `git rev-parse HEAD` |
| Asset version pins (landing) | View source of `/` and compare `?v=` values with `public/index.html` | Same numbers |
| Asset version pins (inner pages) | View source of e.g. `/login`, `/dashboard`, `/quotes`, `/builder`, `/closure`, `/approve`, `/portal` and compare `store-api.js?v=`, `shell-proto.js?v=` (and its `SHELL_V`), page scripts | Same numbers as the repo |
| Headers | `curl -sI https://www.helm.events/dashboard` | `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, CSP present; private pages carry `X-Robots-Tag: noindex` and `Cache-Control: no-store` |
| Static containment | `DEPLOY_CHECK_URL=https://www.helm.events npm run check:deploy` | Exit 0 (GET-only, never deploys) |
| Pretty URLs | Open `/<studio-slug>/dashboard`, `/<slug>/quote/<token>` | Rewrites from `vercel.json` resolve |
| Correct database | On staging, DevTools → Network: Supabase calls go to `xizehqgeyjcfpzrdymly`; on prod to `nqltzgiwznphugcfhmbm` | No cross-wiring |
| Smoke flow | Sign in → dashboard → open a quote → builder loads → sign out | No console errors |
| Edge functions | Supabase → Edge Functions → each changed function shows the new deployment time | Matches |

`/api/health` exists only in local `server.js` (`GET /api/health → {ok:true}`); it is **not** served in production. Production health = the page checks above + Supabase status.

Assumption: no external uptime monitor is configured yet (`docs/RUNBOOK.md`, "Known operational gaps"). Decision needed: add one on `https://www.helm.events/login`.

---

## 4. Database migrations

Mechanism (see `docs/CANONICAL-DEPLOYMENT.md`): `supabase/migrations/MANIFEST` lists files in order; the latest definition of any function wins. Forward migrations are idempotent and additive. Base snapshot `supabase/canonical-base/base-v1-2026-09-25.sql` is immutable and only used for fresh installs.

How SQL actually reaches staging/prod today: one-paste files in `supabase/` run in the Supabase SQL Editor.

| File pattern | Purpose |
|---|---|
| `supabase/APPLY-<nnnn>.sql` / `APPLY-<a>-<b>.sql` | Wraps one or more migrations: preflight, own transaction, then a `VERIFY` block |
| `supabase/VERIFY-<nnnn>.sql` | Read-only re-check any time |
| `supabase/APPLY-PENDING.sql` | Historical bundle (0049–0051); the editor shows only the last result grid |
| `scripts/db-migrate.sh --plan / --apply / --verify` | CLI runner with ledger `public.helm_schema_migrations` (sha256 drift detection) |

Procedure, per release:
1. List new forward files since the last release (tail of `MANIFEST`; latest are `0159`–`0162`).
2. **Staging first** (`xizehqgeyjcfpzrdymly`): paste each `APPLY-*.sql` in MANIFEST order. Every `VERIFY` row must read `ok = true`. If a part fails it rolls back by itself; fix and re-run (safe to re-run).
3. Re-test the related feature on staging.
4. **Then production** (`nqltzgiwznphugcfhmbm`), same files, same order, same VERIFY check.
5. Prod-only files: `0162_launch_bypass_off.sql` (`APPLY-0162.sql`) — staging keeps the bypass on.
6. Record what was applied where (owner tracker; memory notes keep a staging-vs-prod list).

Editor rules: no temp tables or session state in pastes; copy files with `LANG=en_US.UTF-8 pbcopy < file` so non-ASCII text survives. Never run `full-schema/complete-setup.sql` (deprecated, reverts tenant isolation) or anything in `supabase/test-harness/` on staging/prod.

Order with code: if a migration and a front-end change depend on each other, the APPLY header says so (e.g. "Deploy closure.html + store-api.js together"). Default: apply SQL first (additive, old UI keeps working), then push the site.

---

## 5. Edge functions

Location: `supabase/functions/<name>/index.ts`, shared code in `_shared/` (`cors.ts`, `limits.ts`, `money.ts`). Deploy per project:
```bash
supabase functions deploy <name> --project-ref <ref>             # JWT-verified
supabase functions deploy <name> --no-verify-jwt --project-ref <ref>   # webhooks / cron-called
```

| Function | Deploy flag (per repo docs) | Live today? |
|---|---|---|
| `invite-signup` | default | Built; deploy on prod pending (checklist) |
| `invite-mailer` | `--no-verify-jwt` (cron + secret) | Yes (email) |
| `welcome-mailer`, `security-alert-mailer`, `billing-reminder` | `--no-verify-jwt` (cron + `HELM_*_SECRET`) | Per flag |
| `comms-dispatch` | `--no-verify-jwt` | Per studio switches |
| `integrations-test` | default | Yes |
| `pkg-client-notify`, `booklet-snapshot`, `verify-upload` | per `supabase/functions/README.md` | Per flag |
| `send-otp`, `send-phone-code` | default | SMS off |
| `send-whatsapp`, `wa-proposal` | default | WhatsApp off in app (`liveChannels.whatsapp=false`) |
| `wa-webhook` | `--no-verify-jwt` | Off until secrets set |
| `create-payment-link`, `create-subscription-checkout` | default | Razorpay off |
| `razorpay-webhook`, `razorpay-subscription-webhook` | `--no-verify-jwt` | Off |
| `render-photo` | default | Owner-only; never triggered by Claude |

Assumption: flag column for mailers/dispatchers is taken from `docs/ops/EMAIL-SETUP.md`, `docs/COMMS-AUTOMATION-SETUP.md` and `supabase/functions/README.md`; only `wa-webhook` states it in its own source. Confirm in each function's header before deploying.

Deploy the same function version to staging first, then prod.

---

## 6. Environment variables and secrets (names only)

Never paste values into docs, commits or chat. Set with `supabase secrets set --project-ref <ref> NAME=…`.

**Injected by Supabase:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

| Group | Names |
|---|---|
| App / CORS | `APP_URL`, `ALLOWED_ORIGINS` (replaces default list), `EXTRA_ALLOWED_ORIGINS` (adds), `ALLOW_LOCALHOST` |
| Email | `RESEND_API_KEY`, `RESEND_FROM`, `MANAGER_EMAIL`, `HELM_INVITE_EMAILS_ENABLED`, `HELM_INVITE_EMAIL_SECRET`, `INVITE_EMAIL_BATCH`, `HELM_WELCOME_EMAILS_ENABLED`, `HELM_WELCOME_EMAIL_SECRET`, `WELCOME_EMAIL_BATCH`, `HELM_SECURITY_ALERTS_ENABLED`, `HELM_SECURITY_ALERT_SECRET`, `HELM_SECURITY_ALERT_HQ_TO`, `SECURITY_ALERT_BATCH` |
| Invite sign-up | `HELM_INVITE_DIRECT_SIGNUP` (kill switch) |
| Comms / notify | `HELM_COMMS_ENABLED`, `HELM_COMMS_SECRET`, `COMMS_BATCH`, `HELM_PKG_NOTIFY_ENABLED`, `HELM_PKG_NOTIFY_SECRET`, `PKG_NOTIFY_BATCH`, `PKG_WHATSAPP_TEMPLATE` |
| Billing | `HELM_BILLING_REMINDERS_ENABLED`, `HELM_BILLING_CRON_SECRET`, `BILLING_REMINDER_BATCH`, `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED` |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `PAYMENT_LINK_TTL_MINUTES` |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATES`, `WHATSAPP_TPL_LANG`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_REQUIRE_OPTIN`, `WHATSAPP_VERIFY_TEMPLATE`, `WHATSAPP_VERIFY_LANG` |
| SMS | `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID` (per `supabase/functions/README.md`) |
| Uploads / AV | `HELM_UPLOAD_SCAN_ENABLED`, `HELM_UPLOAD_SCAN_SECRET`, `HELM_UPLOAD_QUARANTINE`, `UPLOAD_SCAN_BATCH`, `HELM_AV_URL`, `HELM_AV_TOKEN`, `HELM_AV_ALLOWED_HOSTS`, `HELM_AV_TIMEOUT_MS` |
| Booklet | `HELM_BOOKLET_SNAPSHOT_ENABLED` |
| Photo render | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `RENDER_TIMEOUT_MS`, `RENDER_COST_USD_*` |

Front-end (public, in repo): `public/config.js` / `config.staging.js` hold the Supabase URL + anon key (public by design), `liveChannels` (`sms`, `pay`, `whatsapp` all `false`), `captcha.siteKey` (empty = off), `HELM_FEATURES.integrationsPage` (on localhost only). Vercel has no server secrets; it serves static files.

Email facts: sender address `notifications@helm.events`; per-studio display name and Reply-To (studio email) come from `comms_settings.email_from_name / email_reply_to` (migration 0150). Note `docs/ops/EMAIL-SETUP.md` still shows example `hello@helm.events`; the owner's chosen `RESEND_FROM` address is `notifications@helm.events`.

---

## 7. Domain, HTTPS, HSTS, CORS, redirects

- **Domain:** `www.helm.events` on the prod Vercel project; apex `helm.events` should redirect to `www`. HTTPS certificates are managed by Vercel.
- **HSTS:** `vercel.json` sends `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` on every path. `includeSubDomains` means every `*.helm.events` subdomain must serve HTTPS. Decision needed: submit to the HSTS preload list (hard to undo).
- **Other headers (vercel.json):** `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera/mic/geo/payment off), COOP, CORP, CSP (hashes generated by `scripts/gen-csp.mjs`), `Access-Control-Allow-Origin: https://www.helm.events`.
- **Edge-function CORS:** `_shared/cors.ts` has a built-in allow-list; `ALLOWED_ORIGINS` replaces it, `EXTRA_ALLOWED_ORIGINS` adds (e.g. a Vercel preview URL). Staging origin `https://helm-v01.vercel.app` must be allowed on the staging project.
- **Supabase Auth URL configuration** (per project): Site URL = `https://www.helm.events` (staging: `https://helm-v01.vercel.app`); Redirect URLs include `https://www.helm.events/login*`, `/reset-password*` and the staging equivalents; Google OAuth redirect added in Google Cloud too (see `docs/AUTH-DASHBOARD-SETTINGS.md`).
- **Auth hooks** (Supabase → Authentication → Hooks, Postgres type, schema `public`): `hook_password_verification_attempt` (0053) and `hook_mfa_verification_attempt` (0158).

---

## 8. Rollback

| What broke | Rollback | Data effect |
|---|---|---|
| Front-end deploy | Vercel → Deployments → previous good deployment → **Promote / Instant Rollback**. Then `git revert` the bad commit and push so the repo matches. | None |
| Edge function | Re-deploy the previous version from the previous git commit (`git checkout <sha> -- supabase/functions/<name>` in a scratch worktree, deploy). Or use the function's kill switch (`HELM_*_ENABLED=false`, `HELM_INVITE_DIRECT_SIGNUP=false`). | None |
| Migration | Do **not** drop or restore. Author a new forward migration that re-issues the previous function definition. Additive columns/tables are left in place. | None |
| Integration misbehaving | Set `liveChannels.<x>=false` in `config.js` and push, and/or flip the `HELM_*_ENABLED` secret to false. | None |
| Data loss / corruption | Follow `docs/DISASTER-RECOVERY-RUNBOOK.md` (PITR / backups) with owner approval only. | Owner decision |

Always: note time, commit SHA, route, error signature (no PII) per `docs/INCIDENT-RESPONSE-RUNBOOK.md`.

---

## 9. POST-LAUNCH OWNER CHECKLIST

Tick each on **production** unless stated. Claude prepares; the owner performs anything needing dashboards, passwords or real sends.

| # | Item | What to do | Done when |
|---|---|---|---|
| 1 | Invite sign-up on prod | `supabase functions deploy invite-signup --project-ref nqltzgiwznphugcfhmbm`; invite a test address and join | Invitee lands signed in, no "check inbox" step |
| 2 | MFA verification hook | Ensure `APPLY-0158.sql` VERIFY rows true on prod; Authentication → Hooks → add **MFA Verification Attempt** → Postgres → `public.hook_mfa_verification_attempt` (also confirm the 0053 password hook) | Wrong-code lockout works server-side |
| 3 | Email / SMTP test | Set SMTP or `RESEND_API_KEY` + `RESEND_FROM` (`notifications@helm.events`), verify domain DNS (SPF/DKIM/DMARC); Integrations → Email → **Send test e-mail to me**; check `invite_email_outbox` shows `sent` | Real mail arrives with studio Reply-To |
| 4 | WhatsApp | Owner sets up Meta separately (`docs/ops/WHATSAPP-SETUP.md`); keep `liveChannels.whatsapp=false` until secrets + templates approved | Test message delivered on staging first |
| 5 | Default passwords | **Reset** (do not delete) every account still on a published default password; prefer forced reset | No account uses a default password |
| 6 | Repos private | GitHub → both `koushik1133/Helm` and `praneethreddykiwik/Helm` → Settings → visibility **Private** | Both private |
| 7 | Staging password rotate | Rotate staging test-account passwords and any shared staging DB password | Old values no longer work |
| 8 | Business emails | Create role mailboxes on `@helm.events` (MX records first) and move owner accounts onto them | Mail flows to the new boxes |
| 9 | security@ mailbox + DNS | Create `security@helm.events`; set `HELM_SECURITY_ALERT_HQ_TO`; publish `/.well-known/security.txt` contact if desired; add DMARC `rua` | Test alert received |
| 10 | Vercel alias cleanup | Remove stale preview aliases / old domains from both Vercel projects; keep `www.helm.events`, `helm.events`, `helm-v01.vercel.app` | Only intended aliases remain |
| 11 | Supabase invoices | Billing → confirm plan (Pro needed for Auth hooks), billing email, and download invoices for both projects | Invoices on file |
| 12 | Manual screenshots | Owner captures the user-manual screenshots on prod or staging with demo data (`scripts/manual-capture.mjs` exists as a helper) | Manual images updated |
| 13 | Launch flag | Confirm `APPLY-0162.sql` ran on prod only (`allow_trial_bypass = false`) and the "Skip payment" button is gone on `www.helm.events` | Bypass off on prod, on in staging |
| 14 | Integrations still off | Confirm `liveChannels` sms/pay/whatsapp = `false` and Razorpay secrets unset on prod | As intended |

Decision needed: Captcha (Turnstile) on prod — `captcha.siteKey` is empty today. Decision needed: external error reporting DSN (`docs/OBSERVABILITY-ACTIVATION.md`) and uptime monitor.
