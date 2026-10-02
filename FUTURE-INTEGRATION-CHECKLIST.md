# Future Integration Enablement Checklist

Razorpay and WhatsApp are **DEFERRED — securely disabled**. This is the gated
runbook to turn them on later. Do **not** flip any flag until every box in a
section is checked. CI guard: `scripts/check-deferred-integrations.mjs` (run by
`npm run ci`) FAILS if a flag is flipped on without the secure path in place.

> Guardrail reminder: additive + reversible changes only; no destructive migrations.
> Keep the feature flags the *last* switch you flip, after secrets + webhook + test-mode pass.

---

## A. Razorpay — test-mode → live

### A1. Supabase secrets (dashboard / `supabase secrets set`, never committed)
- [ ] `RAZORPAY_KEY_ID` (start with `rzp_test_…`)
- [ ] `RAZORPAY_KEY_SECRET`
- [ ] `RAZORPAY_WEBHOOK_SECRET` (matches the dashboard webhook secret)
- [ ] `APP_URL` (for the callback return URL)
- [ ] `RESEND_API_KEY`, `RESEND_FROM`, `MANAGER_EMAIL` (receipt emails)
- [ ] (optional SMS receipt) `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_SMS_TEMPLATE_ID`, `MANAGER_PHONE`

### A2. Deploy Edge Functions (separately from the static app)
- [ ] `supabase functions deploy create-payment-link`
- [ ] `supabase functions deploy razorpay-webhook`
- [ ] **`verify_jwt=false` ONLY for `razorpay-webhook`** (it authenticates by HMAC, not a Supabase JWT). Leave `verify_jwt` ON for every ordinary user API. *(GAP-1: not committed in repo — set at deploy time.)*

### A3. Razorpay dashboard (TEST mode first)
- [ ] Create a webhook → point at the deployed `razorpay-webhook` URL
- [ ] Subscribe to `payment_link.paid` and `payment.captured`
- [ ] Set the webhook secret = `RAZORPAY_WEBHOOK_SECRET`

### A4. Test-mode verification (use Razorpay published TEST cards only)
- [ ] Approve a quote → create a payment link → pay with a test card
- [ ] Webhook marks the quote `paid` exactly once; receipt email sent
- [ ] Replay the same webhook → 200, **no** duplicate receipt (idempotency)
- [ ] Tamper the signature → 401
- [ ] Underpay / re-priced quote → not settled (amount-coverage guard), reconcile row recorded
- [ ] Confirm amount came from the stored quote, never the client request

### A5. Go live
- [ ] Swap to `rzp_live_…` keys + live webhook secret
- [ ] Set DB `app_config` `channels.pay_live = true`
- [ ] Set `public/config.js` `liveChannels.pay = true` **(last step)**
- [ ] Re-run `npm run ci` on a branch that intentionally expects live (guard will flag flipped flags — gate consciously)

### A6. Pre-flight invariants (must stay true)
- [ ] No key/secret literal in `public/` or `supabase/functions/` (secret scan clean)
- [ ] No webhook/handler served from the static `public/` deploy
- [ ] Quote total authority (PR-MONEY-01 / W15-001) resolved or explicitly accepted before taking real money

---

## B. WhatsApp (Meta WhatsApp Cloud API) — enablement

### B1. Supabase secrets
- [ ] `WHATSAPP_TOKEN` (permanent Meta system-user token)
- [ ] `WHATSAPP_PHONE_ID` (numeric business phone-number id)
- [ ] (optional) `WHATSAPP_API_VERSION` (defaults `v21.0`)

### B2. Deploy
- [ ] `supabase functions deploy send-whatsapp`
- [ ] Keep `verify_jwt` behaviour: function itself enforces a signed-in **staff** JWT via `staffUserId()` — do not expose to anon
- [ ] Build the UI caller (none exists today) — must send the staff access token, never the anon key

### B3. Meta setup
- [ ] Approved message templates registered (required to open a conversation)
- [ ] Business phone verified

### B4. Verification
- [ ] `{ ping: true }` returns the phone metadata (credential check, no send)
- [ ] Missing token/phone-id → `500 not configured` (fail closed)
- [ ] Anon / non-staff caller → `401`
- [ ] Token never appears in a response body or logs
- [ ] `notifications` row `status:"sent"` only after a real Meta `ok`

### B5. Go live
- [ ] Set `public/config.js` `liveChannels.whatsapp = true` **(last step)**
- [ ] Re-run `npm run ci` (guard gate)

---

## C. OTP / SMS (MSG91) — required gate for the live approval flow
MSG91 is **required** to enable the live client consent/approval flow (see report).
Until configured, the flow fails closed (`unavailable`) — this is intended.
- [ ] `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID` set
- [ ] `supabase functions deploy send-otp`
- [ ] DB `app_config` `channels.sms_live = true`
- [ ] `public/config.js` `liveChannels.sms = true`
- [ ] Confirm `otp_dev_echo` is **false** in every non-local environment
- [ ] Verify: live OTP sent via SMS, plaintext code never returned by the API
- [ ] `scripts/check-otp-safety.mjs` / `npm run check:otp` passes
