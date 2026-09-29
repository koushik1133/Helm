# INTEGRATIONS DEPLOYMENT READINESS (I-29)

**Nothing in this document enables any integration.** It is a status assessment only.
Razorpay and WhatsApp are and MUST REMAIN **DEFERRED — SECURELY DISABLED**.

Sources: `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/DEFERRED-INTEGRATIONS.md`,
`supabase/functions/*` (`send-otp`, `create-payment-link`, `razorpay-webhook`,
`send-whatsapp`, `_shared/cors.ts`), `public/config.js`, `vercel.json`.

## Status legend

`CODED` (code exists) · `CONFIGURED` (wired into app flow) · `SECRETS(SET|MISSING)`
(provider secrets in Supabase env) · `TESTED` · `SANDBOX` (test-mode verified) ·
`PROD-CONFIGURED` (provider dashboard/webhook set for prod) · `ENABLED` (live flag on).

Secrets are reported as SET/MISSING only — **no secret value was read, printed, or
committed.** From this planning context, provider dashboards and Supabase secret stores
are not accessible, so secret state is reported **MISSING/UNKNOWN — assume not set** unless
an operator confirms otherwise.

## Status matrix

| Integration | CODED | CONFIGURED | SECRETS | TESTED | SANDBOX | PROD-CONFIGURED | ENABLED | Notes |
|---|---|---|---|---|---|---|---|---|
| **Google OAuth (sign-in)** | YES (in `public/login.html`) | PARTIAL | N/A (Supabase-managed provider) | NO | NO | NO | NO | Code present per MEMORY ("Google sign-in working" in one cluster vs "pending" note). Supabase + Google Cloud dashboard provider setup is the external gate. **PRODUCT/EXTERNAL SETUP REQUIRED.** |
| **MSG91 / SMS OTP** | YES (`supabase/functions/send-otp`) | YES (`liveChannels.sms=false` → simulated; OTP shown client-side) | MISSING (`MSG91_AUTHKEY`/`MSG91_SENDER`/`MSG91_OTP_TEMPLATE_ID`) | NO | NO | NO | NO | Fail-safe: `request_otp` returns `delivery:'unavailable'` when no provider — approval flow is DOWN, not bypassed. DLT sender + template registration required (India). |
| **Razorpay (payments)** | YES (`create-payment-link`, `razorpay-webhook`) | YES (dormant; `liveChannels.pay=false` → `sim-pay.html`) | MISSING (`RAZORPAY_KEY_ID`/`_SECRET`/`_WEBHOOK_SECRET`, `APP_URL`) | NO | NO | NO | **NO — must stay OFF** | **DEFERRED — SECURELY DISABLED.** Webhook HMAC-verified, idempotent, server-authoritative amount, fail-closed. CI `check-deferred-integrations` fails build if flipped on without verified impl. |
| **WhatsApp (Meta Cloud API)** | YES (`send-whatsapp`) | YES (dormant; `liveChannels.whatsapp=false` → logs intent only) | MISSING (`WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID`/`WHATSAPP_API_VERSION`) | NO | NO | NO | **NO — must stay OFF** | **DEFERRED — SECURELY DISABLED.** Requires approved Meta message template + verified business number. CI guard enforces dormant default. |
| **Vercel static hosting** | YES (`vercel.json`) | YES | N/A | Partial (config present) | N/A | UNCONFIRMED | Live on `www.helm.events` | `outputDirectory: public`, `cleanUrls`, security headers + strict CSP, `/i/:slug*` rewrite, `/signup` redirect, no build step. Deploy-source repo parity is the open risk — see `CUSTOMER-FRONTEND-PARITY.md`. |
| **Config parity (`config.js`)** | YES | YES | N/A | — | — | UNCONFIRMED | — | Source has `liveChannels {sms:false, pay:false, whatsapp:false}` (verified). Hostname-routed Supabase config. Must confirm deployed prod `config.js` points at prod project and keeps all flags false. |

## Deferred integrations — confirmation (Razorpay + WhatsApp)

**CONFIRMED: Razorpay and WhatsApp are DEFERRED — SECURELY DISABLED and must stay so.**

- `public/config.js`: `liveChannels.pay = false`, `liveChannels.whatsapp = false`
  (lines 16–19, verified in source).
- `_flag()` defaults **false** for any unknown flag (fail-closed); DB
  `app_config.channels.pay_live=false`.
- Simulated flows are visibly non-live: `create_payment` returns `sim-pay.html`;
  `_notify` only logs intent when a channel is not live.
- CI `scripts/check-deferred-integrations.mjs` fails the build if either flag is flipped
  on without the verified server-side implementation.
- **Do not enable these flags, add fake endpoints, or commit provider keys.** Activation
  is future work with its own checklist (server-side order creation, HMAC verification,
  replay/idempotency, sandbox verification) per `docs/DEFERRED-INTEGRATIONS.md`.

## External setup / product decisions required (not code)

1. **Google OAuth — EXTERNAL SETUP REQUIRED + PRODUCT DECISION.** MEMORY carries
   conflicting notes ("Google sign-in working" vs "Supabase/Google Cloud dashboard setup
   still to be done"). Decide whether Google sign-in is in scope for this launch; if yes,
   complete the Supabase Auth provider + Google Cloud OAuth client/redirect-URI setup
   (dashboard work, no code change). Verify against prod redirect URIs before enabling.
2. **MSG91 SMS OTP — PRODUCT DECISION + EXTERNAL SETUP.** If OTP-verified client approval
   is required at launch, MSG91 must be provisioned (DLT sender id + OTP template with
   `##OTP##`), secrets set, `send-otp` deployed, and `liveChannels.sms` flipped. Until
   then approval OTP runs in simulation (OTP shown client-side) — acceptable for testing,
   NOT for real customer sign-off. **Decide before customer launch.**
3. **Razorpay / WhatsApp — KEEP DEFERRED.** No decision needed to launch; explicitly keep
   OFF. Any future activation follows the deferred-integrations checklist and updates the
   CI guard in the same commit.
4. **Vercel deploy-source parity — OPERATOR ACTION.** Confirm which repo/branch prod
   tracks and whether Wave-16 frontend is live (see parity doc).
