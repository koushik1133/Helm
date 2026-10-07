# Going live: SMS (MSG91) · Payments (Razorpay) · Email (Resend)

Until you do this, the app runs in **simulation mode** and is fully usable for testing:
the OTP is shown on the client approval page, the payment link is a mock, and every
SMS/email is recorded (not sent). Nothing here charges money or messages anyone.

## 1. Run the SQL
Run `supabase/otp-payments.sql` in the SQL editor (after `setup-complete.sql`).

## 2. Deploy the Edge Functions
Install the Supabase CLI, then from the project root (`2d view/`):

```bash
supabase link --project-ref nqltzgiwznphugcfhmbm
supabase functions deploy send-otp
supabase functions deploy create-payment-link
supabase functions deploy razorpay-webhook
supabase functions deploy send-whatsapp
```
Apply migration `0027_uploads_payments.sql` first — the functions call its RPCs
(`payment_link_begin/attach/fail`, `razorpay_settle`, `otp_send_authorize`,
`whatsapp_authorize`) and fail closed without them.

## 3. Set the secrets
```bash
supabase secrets set \
  MSG91_AUTHKEY="<MSG91_AUTHKEY>" MSG91_SENDER=HELMEV MSG91_OTP_TEMPLATE_ID="<MSG91_TEMPLATE_ID>" \
  RAZORPAY_KEY_ID="<RAZORPAY_KEY_ID>" RAZORPAY_KEY_SECRET="<RAZORPAY_KEY_SECRET>" \
  RAZORPAY_WEBHOOK_SECRET="<RAZORPAY_WEBHOOK_SECRET>" \
  RESEND_API_KEY="<RESEND_API_KEY>" RESEND_FROM="Helm <events@helm.events>" \
  WHATSAPP_TEMPLATES="event_update,payment_reminder" \
  APP_URL=https://www.helm.events
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

### Allowed browser origins (CORS)
`send-otp`, `create-payment-link` and `send-whatsapp` are called from the browser, so
they answer CORS — but only for an EXACT list of Helm's own front-ends (see `_shared/cors.ts`):

| Origin | Why |
|---|---|
| `https://helm.events`, `https://www.helm.events` | production |
| `https://helm-v01.vercel.app`, `https://helm-alpha-nine.vercel.app` | Vercel project hosts |

Any other origin gets **no** `Access-Control-Allow-Origin` header (the browser blocks
the response); every response carries `Vary: Origin`. There is **no** pattern for
Vercel previews any more (audit Phase 8): anyone can create a Vercel project whose
`*.vercel.app` name matches a pattern such as `helm-v01-*-vk-hub.vercel.app`.

- `ALLOWED_ORIGINS="https://a.example,https://b.example"` replaces the exact list.
- `EXTRA_ALLOWED_ORIGINS="https://helm-v01-abc123-vk-hub.vercel.app"` adds exact origins
  (e.g. the one preview you are testing).
- `ALLOW_LOCALHOST=1` additionally allows `http(s)://localhost|127.0.0.1:<port>` — for
  a dev/staging project only, never production.

`razorpay-webhook` is called server-to-server by Razorpay and sends no CORS headers.

### Settings added in audit Phase 8 (all optional except where noted)
| Variable | Function | Meaning |
|---|---|---|
| `SUPABASE_ANON_KEY` | send-whatsapp | auto-injected; used to run the authorization AS THE CALLER (RLS) |
| `WHATSAPP_TEMPLATES` | send-whatsapp | comma list of approved template names (default `event_update,payment_reminder,event_reminder,crew_assignment`) |
| `WHATSAPP_ALLOW_TEXT=1` | send-whatsapp | allow free-form text inside the 24h window (off by default) |
| `PAYMENT_LINK_TTL_MINUTES` | create-payment-link | link lifetime, 20..43200, default 4320 (3 days); capped at the approval link expiry |
| `APP_URL` | create-payment-link | **required for the return page**; Razorpay returns the payer to `APP_URL/approve.html?payment=done` (no token) |
| `RESEND_FROM` | razorpay-webhook | only the ADDRESS is used; the display name is the paying studio's `organizations.name` |
| `MANAGER_EMAIL` | razorpay-webhook | optional platform-ops copy with NO tenant data; studio receipts go to `organizations.business_email` |
| `EXTRA_ALLOWED_ORIGINS` | all browser-called | exact extra CORS origins |

`MANAGER_PHONE` is no longer used.

### Server-side limits (migration 0027)
| What | Limit |
|---|---|
| WhatsApp | 100 messages / studio / hour; only to the event's client, crew-link or booked-vendor numbers; caller needs quotes **edit** |
| OTP SMS | 200 / studio / day, plus 5 per quote per 10 min; only to the client phone on file (else an Indian mobile) |
| Payment links | one open live link per quote; a changed total cancels the old link at Razorpay |
| invite-media | 8 MB, png/jpeg/webp/gif, 120 stored objects per event, 60 photos shown per site |
| event-docs | 10 MB, pdf/png/jpeg/webp, 200 objects per event |
| chat-media | 16 MB, images + voice notes |
| any bucket | 100 uploads per user per 10 minutes; key = `<org>/<event or chat>/<random>.<ext>` |

Payments that arrive but cannot settle the quote (already paid, short of the total, on a
superseded link, over the balance) are recorded in `public.payment_reconciliation` for a
refund / manual match (finance viewers can read it; `resolve_payment_reconciliation`
closes an item).

### Anti-virus (recommendation — not built)
Uploads are not virus-scanned. Recommended before wide use of event documents: a
post-upload scan (ClamAV in a small container, or a scanning API) triggered by a storage
webhook that marks `event_files` clean or moves the object to a quarantine prefix, and
signed URLs issued only for clean files. Storage checks the client-declared Content-Type
against each bucket's allowlist; the browser re-checks magic bytes before upload.

## 4. Point Razorpay at the webhook
In the Razorpay dashboard → Webhooks, add:
`https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/razorpay-webhook`
subscribe to **payment_link.paid** (and payment.captured), secret = `RAZORPAY_WEBHOOK_SECRET`.

## 5. Flip the app to live
In `public/config.js` add:
```js
window.SUPABASE_CONFIG.liveChannels = { sms: true, pay: true };
```
and in the DB set the channel flags on so simulation stops returning codes:
```sql
update public.app_config set value='{"sms_live":true,"email_live":true,"pay_live":true}'::jsonb where key='channels';
```

## Compliance notes (India)
- **MSG91 / DLT:** register your sender id and OTP template on DLT; the template must contain `##OTP##`.
- **Razorpay:** complete KYC; use Payment Links so the client pays on Razorpay's PCI-compliant page (no card data ever touches this app).
- **Consent:** every approval stores the phone, the exact terms version + text, an OTP-verified flag, and a timestamp in `quote_consents` — your audit trail.
- Keep the service-role key and all provider secrets **only** in Supabase secrets, never in client code.

## Helm subscription billing functions (LATER — owner only, both DORMANT)
`billing-reminder` and `razorpay-subscription-webhook` bill studios for Helm itself
(migration 0045). Both are **no-ops (200)** until their enable flag is `true`, so
deploying them changes nothing. Do these steps only when subscription billing goes live:

1. Apply migration 0045 (tables `billing_reminders`, `studio_subscriptions`,
   `subscription_payments`, RPC `hq_settle_provider_payment`) on staging, then prod.
2. Deploy (the webhook is called by Razorpay without a Supabase JWT; the reminder is
   called by cron with its own shared secret):
   ```bash
   supabase functions deploy billing-reminder --no-verify-jwt
   supabase functions deploy razorpay-subscription-webhook --no-verify-jwt
   ```
3. Secrets:
   ```bash
   supabase secrets set \
     HELM_BILLING_CRON_SECRET="<long random string>" \
     RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET="<from Razorpay dashboard>"
   # optional: RAZORPAY_EVENT_MAX_AGE_SEC=86400  BILLING_REMINDER_BATCH=50
   # RESEND_API_KEY / RESEND_FROM are shared with razorpay-webhook; without a key,
   # reminders are marked channel='skipped' instead of sent.
   ```
4. Razorpay dashboard → Webhooks → add `…/functions/v1/razorpay-subscription-webhook`
   with event `subscription.charged` and the secret above. Each subscription must
   carry `notes.org_id`; the org is still resolved from
   `studio_subscriptions.provider_subscription_id` and a mismatch is refused.
5. Schedule the reminder (pg_cron / external cron), POST with header
   `x-helm-cron-secret: <HELM_BILLING_CRON_SECRET>`.
6. Flip the flags last: `supabase secrets set HELM_BILLING_REMINDERS_ENABLED=true
   HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED=true`. Unset them to go dormant again.

Tests: `tests/edge/billing-extras.test.ts` (signature valid/invalid/missing/tampered,
dormant mode, cron secret, org mismatch, idempotent marking).
