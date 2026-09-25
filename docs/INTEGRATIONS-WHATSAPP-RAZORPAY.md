# WhatsApp (Meta Cloud API) + Razorpay Payment Links — setup & go-live

The integration **code is complete** but ships **DORMANT / fail-closed**: the
feature flags in `public/config.js` (`liveChannels.pay`, `liveChannels.whatsapp`)
are `false`, so the app simulates these channels and makes **no external calls**
until you deploy the Edge Functions, set the secrets, and flip the flags. CI
(`check-deferred-integrations`) enforces this dormant state.

Architecture (all provider logic is server-side, never in the browser):
- `supabase/functions/send-whatsapp` → Meta WhatsApp Cloud API
- `supabase/functions/create-payment-link` → Razorpay Payment Links
- `supabase/functions/razorpay-webhook` → verifies signature, marks quote paid, sends receipts
- The frontend only calls these via `callFn(...)`; secrets live only in Edge Function env.

You will need the [Supabase CLI](https://supabase.com/docs/guides/cli) logged in and
linked to the project (`supabase link --project-ref nqltzgiwznphugcfhmbm`), OR use a
separate **staging** project first (recommended — see `docs/STAGING-SETUP.md`).

---

## Part A — WhatsApp (Meta Cloud API)

### A1. Create the Meta assets (Meta side — your action)
1. [developers.facebook.com](https://developers.facebook.com) → create/use a **Meta
   app** (type *Business*), add the **WhatsApp** product.
2. Add & verify your **WhatsApp Business phone number**. Note its **Phone number ID**
   (numeric, in WhatsApp → API Setup).
3. Create a **System User** (Business Settings → Users → System Users) with a
   **permanent access token** that has `whatsapp_business_messaging` +
   `whatsapp_business_management`. Copy the token.
4. Create at least one **message template** (WhatsApp Manager → Templates) — you must
   use an approved template to *start* a conversation (free-form text only works
   inside the 24-hour customer window). e.g. a template `event_update` with one body
   variable.

### A2. Set the secrets (Supabase — never in code)
```bash
supabase secrets set \
  WHATSAPP_TOKEN="<permanent-access-token>" \
  WHATSAPP_PHONE_ID="<phone-number-id>" \
  WHATSAPP_API_VERSION="v21.0"
```

### A3. Deploy the function
```bash
supabase functions deploy send-whatsapp
```

### A4. Test (no app change needed)
```bash
# credential check (no message sent):
curl -s -X POST "https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/send-whatsapp" \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"ping":true}'
# → { ok:true, state:{ verified_name, display_phone_number, quality_rating } }

# send a template to your own number (digits, country code, no +):
curl -s -X POST "https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/send-whatsapp" \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"number":"9198XXXXXXXX","template":"event_update","lang":"en_US","params":["your event is confirmed"]}'
```
Request shapes the function accepts: `{ping:true}`, `{number,text}` (session window
only), `{number,template,lang,params:[...]}` (business-initiated).

---

## Part B — Razorpay (Payment Links)

### B1. Razorpay dashboard (your action)
1. [dashboard.razorpay.com](https://dashboard.razorpay.com) → **Settings → API Keys**
   → generate a key. Copy **Key ID** and **Key Secret**.
2. **Settings → Webhooks → Add webhook**:
   - URL: `https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/razorpay-webhook`
   - Secret: choose a strong random string (you'll set the SAME value as
     `RAZORPAY_WEBHOOK_SECRET`).
   - Active events: **`payment_link.paid`** and **`payment.captured`**.
3. Start in **Test mode** keys until verified, then switch to Live keys.

### B2. Set the secrets (Supabase)
```bash
supabase secrets set \
  RAZORPAY_KEY_ID="<key-id>" \
  RAZORPAY_KEY_SECRET="<key-secret>" \
  RAZORPAY_WEBHOOK_SECRET="<same-secret-as-in-dashboard>" \
  APP_URL="https://www.helm.events"
# optional receipt emails/SMS the webhook can send:
supabase secrets set RESEND_API_KEY="<...>" RESEND_FROM="Helm <events@helm.events>" \
  MANAGER_EMAIL="<ops@helm.events>"
```

### B3. Deploy the functions
```bash
supabase functions deploy create-payment-link
supabase functions deploy razorpay-webhook   # webhooks are unauthenticated by Razorpay; it is protected by HMAC signature verification, not JWT
```
> If your Supabase project enforces JWT on functions, mark **razorpay-webhook** as
> **no-verify-JWT** (Dashboard → Edge Functions → razorpay-webhook → *Verify JWT* OFF),
> because Razorpay cannot send a Supabase JWT. Its security is the HMAC signature.

### B4. Test (Razorpay Test mode)
1. Create/approve a test quote in the app so it has an `approval_token` and a
   `pricing.total`.
2. Trigger `create-payment-link` (in-app once flags are on, or via curl) → you get a
   `short_url`.
3. Pay it with a [Razorpay test card](https://razorpay.com/docs/payments/payments/test-card-details/).
4. Confirm the webhook fired: the quote flips to `approval_status = paid`, a
   `quote_payments` row shows `status = paid`, and a receipt email is sent (once).
5. **Replay test:** in the Razorpay dashboard, re-deliver the same webhook — the
   function returns `already paid (idempotent)` and sends **no** duplicate receipt.

---

## Part C — Turn the channels ON (only after A + B verified)

In `public/config.js`, flip the flags:
```js
liveChannels: { sms:false, pay:true, whatsapp:true }
```
(Commit + deploy the frontend.) Now `BPStore.approval.createPayment(...)` uses the
real Razorpay link and WhatsApp sends go through Meta. **Leaving them `false` keeps
everything simulated** — that is the safe default and what CI enforces until you are
ready.

> ⚠️ Flipping `pay`/`whatsapp` to `true` makes `check-deferred-integrations` fail by
> design (it guards the dormant default). When you intentionally go live, update that
> guard in the same commit so CI reflects the new, deliberate state — don't disable
> the guard wholesale.

---

## Security guarantees (already enforced in code)
- **No secrets in the frontend or the repo** — every key is read from `Deno.env` in
  the Edge Function; CI scans `public/` and `supabase/functions/` for committed keys.
- **Webhook is signature-verified** — `razorpay-webhook` computes HMAC-SHA256 over the
  raw body with `RAZORPAY_WEBHOOK_SECRET` and compares in constant time; an invalid or
  missing signature → `401`, so a forged "payment succeeded" is rejected.
- **Idempotent** — replayed webhooks do not double-mark or double-notify.
- **Amount comes from the server** — the payment link amount is read from the stored
  `pricing.total` server-side (tighten further with the MONEY-02 server-authority work
  in `docs/PRICING-DECISIONS-WAVE6.md`).
- **Fail-closed** — a function with missing secrets returns an error and sends nothing.
