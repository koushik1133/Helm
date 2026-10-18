# Helm — External Integrations: Status and Runbook

Scope: every external service Helm talks to, what it does, whether it is on, which secret NAMES it needs (values are never written here), which edge function owns it, how it fails, how to switch it on, and which tests cover it.

Environments: prod `helm.events` (Supabase project `nqltzgiwznphugcfhmbm`), staging `helm-v01.vercel.app` (Supabase `xizehqgeyjcfpzrdymly`). Edge function secrets are set per project with `supabase secrets set NAME=...` (or the Supabase dashboard > Edge Functions > Secrets). Secrets never reach the browser.

Related docs (still authoritative for detail): `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/COMMS-AUTOMATION-SETUP.md`, `docs/PHOTO-RENDER-SETUP.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/DEFERRED-INTEGRATIONS.md`, `supabase/functions/README.md`.

## Summary

| Service | Purpose | Status (owner facts + code) | Edge function(s) |
|---|---|---|---|
| Supabase Auth email (custom SMTP) | Sign-up confirm, password reset, magic links | On; sender `notifications@helm.events` | (Supabase built-in) |
| Resend (transactional email) | Invites, welcome, client notifications, receipts, OTP by email, security alerts | On where `RESEND_API_KEY` is set; sender `notifications@helm.events`, Reply-To = studio email | invite-mailer, welcome-mailer, comms-dispatch, pkg-client-notify, razorpay-webhook, security-alert-mailer, billing-reminder, send-otp, integrations-test |
| Meta WhatsApp Cloud API | Proposal links, OTP, client/crew notifications, inbound webhook | Owner sets up separately; treat as OFF until secrets set | send-whatsapp, wa-proposal, wa-webhook, comms-dispatch, send-otp, send-phone-code, integrations-test |
| Razorpay Payment Links + webhook | Client pays a milestone online; webhook settles the quote | OFF (owner) | create-payment-link, razorpay-webhook |
| Razorpay Subscriptions | Studio plan billing | OFF (flag `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED`) | create-subscription-checkout, razorpay-subscription-webhook |
| MSG91 SMS | OTP for client approval (India DLT) | OFF (owner) | send-otp |
| Google OAuth | "Continue with Google" sign-in | On (Google sign-in working per memory notes) | (Supabase Auth provider) |
| OpenAI images (photo render) | Builder "Render" photo of the floor plan | Dormant until `OPENAI_API_KEY` set; owner-only testing | render-photo |
| Sentry (browser error reporting) | Client error capture | Code-ready, NOT live (no DSN) | none (`public/telemetry.js`) |
| Upload antivirus scan (optional) | Scan uploaded files | Off unless `HELM_UPLOAD_SCAN_ENABLED` + `HELM_AV_*` set | verify-upload |

Assumption: "On" for Resend/SMTP reflects the owner's statement that mail is sent from `notifications@helm.events`; this doc did not inspect live project secrets.

Common design (verified across `supabase/functions/*/index.ts`): each provider is **fail-closed / dormant** — if its secret is unset the function either returns a clear `503`/`"simulated"`/`"dormant"` response or records the item without sending. Most mailers also have an explicit kill switch `HELM_*_ENABLED="false"` and a shared caller secret `HELM_*_SECRET` for cron/DB-triggered calls. CORS and rate limits come from `supabase/functions/_shared/cors.ts` and `_shared/limits.ts` (`ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST`, `APP_URL`).

---

## 1. Supabase Auth email (SMTP)

- **Purpose:** Supabase's own auth mails (confirm sign-up, reset password, invite/magic link). The app calls these via `supabase.auth.*` in `public/store-api.js` / `public/login.html`.
- **Status:** On. Custom SMTP configured in the Supabase dashboard with sender `notifications@helm.events`. Default Supabase SMTP is limited to ~2 mails/hour; `docs/AUTH-DASHBOARD-SETTINGS.md` recommends 30/hour with custom SMTP.
- **Secrets:** none in code; SMTP host/user/password live only in Supabase dashboard > Authentication > SMTP Settings. Assumption: SMTP is Resend's SMTP relay (same domain).
- **Failure handling:** Supabase returns an error to `auth.*`; login page shows it. Rate-limit hits surface as "email rate limit exceeded".
- **Switch on / change:** Dashboard > Auth > SMTP: set sender `notifications@helm.events`, name "Helm"; ensure SPF/DKIM/DMARC for `helm.events`; set Site URL + redirect URLs for `helm.events` and `helm-v01.vercel.app`. Do this on BOTH projects.
- **Tests:** `test/auth-signup-confirm.test.mjs`, `test/auth-session-hardening.test.mjs`, `test/temp-password-reset.test.mjs`.

## 2. Resend (transactional email)

- **Purpose:** All app-sent mail: staff invites (`invite-mailer`), welcome (`welcome-mailer`), automated client/crew comms (`comms-dispatch`), package notifications (`pkg-client-notify`), payment receipts (`razorpay-webhook`), security alerts (`security-alert-mailer`), trial/billing reminders (`billing-reminder`), approval OTP by email (`send-otp`, channel `email`), Integrations page test mail (`integrations-test`).
- **Status:** On where configured. From address `notifications@helm.events`; display name = studio name; Reply-To = studio's business email (`organizations.business_email`), per `razorpay-webhook` header comment and owner facts.
- **Secrets:** `RESEND_API_KEY`, `RESEND_FROM`. Per-function switches/secrets: `HELM_INVITE_EMAILS_ENABLED`, `HELM_INVITE_EMAIL_SECRET`, `INVITE_EMAIL_BATCH`, `HELM_INVITE_DIRECT_SIGNUP`; `HELM_WELCOME_EMAILS_ENABLED`, `HELM_WELCOME_EMAIL_SECRET`, `WELCOME_EMAIL_BATCH`; `HELM_COMMS_ENABLED`, `HELM_COMMS_SECRET`, `COMMS_BATCH`; `HELM_PKG_NOTIFY_ENABLED`, `HELM_PKG_NOTIFY_SECRET`, `PKG_NOTIFY_BATCH`; `HELM_SECURITY_ALERTS_ENABLED`, `HELM_SECURITY_ALERT_SECRET`, `HELM_SECURITY_ALERT_HQ_TO`, `SECURITY_ALERT_BATCH`; `HELM_BILLING_REMINDERS_ENABLED`, `HELM_BILLING_CRON_SECRET`, `BILLING_REMINDER_BATCH`; `HELM_INTEGRATIONS_TEST_ENABLED`; optional `MANAGER_EMAIL` (ops copy, no tenant data).
- **Failure handling:** without `RESEND_API_KEY` sends are "simulated" (nothing leaves Helm); queued rows stay pending and are retried in batches; kill switch `="false"` makes the function a no-op `200 {status:"dormant"}` (`comms-dispatch/index.ts:176`).
- **Switch on:** verify `helm.events` domain in Resend (SPF/DKIM) -> `supabase secrets set RESEND_API_KEY=... RESEND_FROM="Helm <notifications@helm.events>"` -> deploy functions -> Control Center > Integrations > "Check status" then "Send test" (mails the caller's own login email only).
- **Tests:** `test/invite-mailer.test.mjs`, `test/comms-automation.test.mjs`, `test/integrations-page.test.mjs`, `test/integrations-setup.test.mjs`, `test/security-alerts-ui.test.mjs`, `test/trial-reminders-ui.test.mjs`, `test/edge-functions-hardening.test.mjs`.

## 3. Meta WhatsApp Cloud API

- **Purpose:** send proposal/approval links (`wa-proposal`), approval OTP via AUTHENTICATION template `proposal_approval_otp` (`send-otp` channel `whatsapp`), phone verification (`send-phone-code`), generic/template sends (`send-whatsapp`), automated comms (`comms-dispatch`, `pkg-client-notify`), inbound status/replies (`wa-webhook`).
- **Status:** Owner sets up the Meta Business account, number and templates separately. Off until secrets exist.
- **Secrets:** `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_TPL_LANG`, `WHATSAPP_TEMPLATES`, `COMMS_WHATSAPP_TEMPLATE`, `PKG_WHATSAPP_TEMPLATE`, `WHATSAPP_VERIFY_TEMPLATE`, `WHATSAPP_VERIFY_LANG`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_REQUIRE_OPTIN`; webhook: `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- **Webhook verification:** `wa-webhook` (deploy with `--no-verify-jwt`) answers Meta's GET challenge only when `hub.verify_token` matches, and verifies POST `X-Hub-Signature-256` = HMAC-SHA256(app secret, raw body) before doing anything; it ignores everything until both webhook secrets are set.
- **Failure handling:** unset token/phone id -> "simulated"; free-text only if `WHATSAPP_ALLOW_TEXT` (otherwise approved templates only, as Meta requires outside the 24h window); opt-in enforced when `WHATSAPP_REQUIRE_OPTIN`; OTP goes only to the phone ON THE QUOTE, 30 s cooldown, 3 resends.
- **Switch on:** follow `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`: get permanent system-user token + phone id, get templates approved, set secrets, deploy, register webhook URL `https://<project>.supabase.co/functions/v1/wa-webhook` with the verify token, then Integrations > "Send test" (goes to the studio's own saved number).
- **Decision needed:** final template names/languages per country (India, UAE) and whether `WHATSAPP_REQUIRE_OPTIN` is on in prod.
- **Tests:** `test/wa-proposal.test.mjs`, `test/integrations-page.test.mjs`, `test/otp-safety.test.mjs`, `test/deferred-integrations.test.mjs`, `scripts/check-deferred-integrations.mjs`.

## 4. Razorpay Payment Links + webhook

- **Purpose:** staff create a payment link for a milestone/balance (`create-payment-link`); Razorpay calls `razorpay-webhook` on `payment_link.paid` / `payment.captured`, which settles the quote and emails client + studio.
- **Status:** OFF (owner). Per-studio Razorpay accounts (migration 0117) are dormant until a studio connects one.
- **Secrets:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `PAYMENT_LINK_TTL_MINUTES`; plus Resend secrets for receipts.
- **Webhook verification:** HMAC signature checked against the webhook secret (per-studio secret when URL has `?org=<studio uuid>`); stale events rejected by max age. Settlement is one DB transaction `public.razorpay_settle` under a per-quote money lock; duplicate payment ids applied once; payments that can't settle (already paid, short, superseded link, over balance) are recorded in `payment_reconciliation` for refund — never dropped. Any DB error -> HTTP 500 so Razorpay retries.
- **Failure handling:** no credentials -> `503 "online payments are not configured"` (`create-payment-link/index.ts:86`); UI falls back to manual payment recording.
- **Switch on:** Razorpay test mode first on staging: set keys + webhook secret, deploy (webhook with `--no-verify-jwt`), add webhook URL in Razorpay dashboard for the two events, pay a test link, confirm ledger + receipt; then live keys on prod.
- **Subscriptions** (studio plans): `create-subscription-checkout`, `razorpay-subscription-webhook`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, flag `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED`. Off.
- **Decision needed:** platform-account vs per-studio-account model (`RAZORPAY_REQUIRE_STUDIO_ACCOUNT`), and go-live date.
- **Tests:** `test/money-trust-boundary.test.mjs`, `test/sim-pay-prod-ui.test.mjs`, `test/onboarding-checkout.test.mjs`, `test/hq-checkout-ui.test.mjs`, `test/deferred-integrations.test.mjs`; DB suite `npm run test:db`.

## 5. MSG91 SMS

- **Purpose:** approval OTP by SMS for Indian numbers (`send-otp`, default channel).
- **Status:** OFF (owner). Code says simulated when the auth key is unset.
- **Secrets:** `MSG91_AUTHKEY`, `MSG91_SENDER` (6-char DLT sender id), `MSG91_OTP_TEMPLATE_ID` (DLT template with `##OTP##`), `MSG91_TEMPLATE_ID`, `MSG91_INTL` (`"1"` only once MSG91 international route is enabled).
- **Failure handling:** OTP stored as bcrypt hash (`admin_store_otp`); CSPRNG code; SMS goes only to the phone on file; per-studio daily cap (`otp_send_authorize`, migration 0027); non-+91 numbers get a plain "not supported yet" message unless `MSG91_INTL=1`; DB errors mapped to generic messages.
- **Switch on:** complete DLT registration (entity, sender, template), set secrets, deploy `send-otp`, test on staging with a real Indian number.
- **Decision needed:** keep SMS at all, or rely on WhatsApp/email OTP (0151) only.
- **Tests:** `test/otp-safety.test.mjs`, `test/otp-dev-echo.test.mjs`, `scripts/check-otp-safety.mjs`, `test/approval-handler.test.mjs`.

## 6. Google OAuth

- **Purpose:** "Continue with Google" on `public/login.html` (`#googleBtn`) -> `supa.auth.signInWithOAuth` in `public/store-api.js:1758`. Hidden on invite-join flows.
- **Status:** On (memory notes: Google sign-in working).
- **Secrets:** Google OAuth client id/secret live in Supabase dashboard > Auth > Providers > Google, not in code. Redirect URI `https://<project>.supabase.co/auth/v1/callback` registered in Google Cloud.
- **Failure handling:** OAuth errors return to login page with the error shown.
- **Switch on (new project, e.g. fresh Mumbai prod):** create OAuth client in Google Cloud, set consent screen to `helm.events`, add callback URI, paste id/secret into Supabase provider, add Site/redirect URLs.
- **Tests:** `test/auth-gate.test.mjs`, `test/auth-session-hardening.test.mjs`. Assumption: no automated live OAuth test exists.

## 7. Photo render (OpenAI images)

- **Purpose:** builder "Render" turns a floor plan into a photo. Browser builds prompt (`public/photo-render-prompt.js`) and 3 reference images; `render-photo` calls OpenAI `images/edits`, answers `202 {job_id}`, finishes in background; builder polls `photo_render_job`.
- **Status:** Dormant until key set -> `503 {"error":"render_not_configured"}`. Owner rule: Claude never triggers renders; the owner tests.
- **Secrets:** `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` (optional override), `RENDER_TIMEOUT_MS`.
- **Switch on:** see `docs/PHOTO-RENDER-SETUP.md` (apply SQL, set secrets, deploy).
- **Tests:** `test/photo-render.test.mjs`, `test/render-fidelity.test.mjs`, `test/render-dialog-polish.test.mjs`, `test/render-master-prompt.test.mjs`, `test/render-event-context.test.mjs`, `test/render-variant-coverage.test.mjs`, `test/v-render-hotfix.test.mjs`.

## 8. Sentry (browser error reporting)

- **Purpose:** client error capture via `public/telemetry.js` (global error/rejection hooks, PII/token scrubbing).
- **Status:** Present in code, NOT live — no-op until `window.HELM_TELEMETRY = { dsn, env, release }` is set. CSP in `server.js` allows only the pinned Sentry bundle directory.
- **Secrets:** a DSN (public-ish, but do not commit). No server-side Sentry.
- **Switch on:** `docs/OBSERVABILITY-ACTIVATION.md`.
- **Decision needed:** whether to activate Sentry (DPDP / subprocessor list `public/subprocessors.html` must match).

## 9. Upload antivirus scan (optional)

- `verify-upload`: `HELM_UPLOAD_SCAN_ENABLED`, `HELM_UPLOAD_SCAN_SECRET`, `HELM_UPLOAD_QUARANTINE`, `HELM_AV_URL`, `HELM_AV_TOKEN`, `HELM_AV_ALLOWED_HOSTS`, `HELM_AV_TIMEOUT_MS`, `UPLOAD_SCAN_BATCH`. Off by default. Tests: `test/upload-guard.test.mjs`, `test/upload-quarantine.test.mjs`.

---

## Operator checklist

1. Check status in app: Control Center > Integrations > "Check status" (booleans only, never key values; `integrations-test`).
2. Always enable on staging first, then prod; set secrets on each Supabase project separately.
3. Webhook functions (`razorpay-webhook`, `razorpay-subscription-webhook`, `wa-webhook`) are deployed with `--no-verify-jwt`; all others require JWT or the `HELM_*_SECRET` caller secret.
4. Run `npm test` and `node scripts/check-deferred-integrations.mjs` after any integration change.
5. To switch something off fast: set its `HELM_*_ENABLED="false"` or unset the provider key; functions fall back to dormant/simulated.
