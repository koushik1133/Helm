# Deferred integrations — Razorpay & WhatsApp

**Status: DEFERRED — SECURELY DISABLED (out of current release scope).**

Neither Razorpay (payments) nor WhatsApp is implemented in this release. They are
intentionally dormant. `scripts/check-deferred-integrations.mjs` (run in CI) fails
the build if either is switched on without the secure server-side implementation
described below.

## Current safe-disabled state (verified by CI)
- `public/config.js` → `liveChannels.pay = false`, `liveChannels.whatsapp = false`.
- `supabase/otp-payments.sql` seeds `app_config.channels.pay_live = false`; `_flag()` defaults **false** for any unknown flag (fail-closed).
- No provider secret is committed in client code (guard scans `public/**`).
- No live webhook handler exists (the app is a static deploy with no `api/` dir).
- Simulated flows are clearly non-live: `create_payment` returns a `sim-pay.html` link when `pay_live=false`; `_notify` only *logs intent* when a channel is not live.

**Do not** enable these flags, add fake endpoints, or commit provider keys to make
the app "look complete."

## Razorpay — required before activation (future work, not now)
1. Server-side order creation (never from the browser).
2. Server computes the **authoritative amount + currency** (depends on MONEY-01/02 being resolved first).
3. Webhook endpoint with **HMAC signature verification** (`x-razorpay-signature`) using a **server-only** secret.
4. **Replay prevention** (reject stale timestamps) and **event idempotency** (store `event_id`, dedupe).
5. Persist raw events; drive a **payment state machine** (created → authorized → captured → refunded/failed).
6. Handle duplicate callbacks, out-of-order events, cancelled/failed payments.
7. Refund state handling.
8. Sandbox/test-mode verification **before** any live key is configured.
9. Only then flip `pay_live=true` (and update `check-deferred-integrations.mjs` to recognise the verified implementation).

## WhatsApp — required before activation (future work, not now)
1. Server-side provider call; **secret stays server-side only**.
2. Approved message-template handling.
3. Recipient validation + opt-in/consent where applicable.
4. Rate limits + retry rules.
5. Message audit trail with **PII-safe logs** (no full phone numbers / message bodies).
6. Test/sandbox recipient verification before production.
7. Only then flip `whatsapp=true`.

Until every item above is done and verified, both remain **DEFERRED — SECURELY DISABLED**.
