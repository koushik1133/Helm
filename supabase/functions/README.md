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
```

## 3. Set the secrets
```bash
supabase secrets set \
  MSG91_AUTHKEY="<MSG91_AUTHKEY>" MSG91_SENDER=HELMEV MSG91_OTP_TEMPLATE_ID="<MSG91_TEMPLATE_ID>" \
  RAZORPAY_KEY_ID="<RAZORPAY_KEY_ID>" RAZORPAY_KEY_SECRET="<RAZORPAY_KEY_SECRET>" \
  RAZORPAY_WEBHOOK_SECRET="<RAZORPAY_WEBHOOK_SECRET>" \
  RESEND_API_KEY="<RESEND_API_KEY>" RESEND_FROM="Helm <events@helm.events>" \
  MANAGER_EMAIL="<MANAGER_EMAIL>" MANAGER_PHONE="<MANAGER_PHONE_E164>" \
  APP_URL=https://www.helm.events
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

### Allowed browser origins (CORS)
`send-otp`, `create-payment-link` and `send-whatsapp` are called from the browser, so
they answer CORS — but only for Helm's own front-ends (see `_shared/cors.ts`):

| Origin | Why |
|---|---|
| `https://helm.events`, `https://www.helm.events` | production |
| `https://helm-v01.vercel.app`, `https://helm-alpha-nine.vercel.app` | Vercel project hosts |
| `https://helm-v01-<hash>-vk-hub.vercel.app` | Vercel preview deployments (regex) |

Any other origin gets **no** `Access-Control-Allow-Origin` header (the browser blocks
the response); every response carries `Vary: Origin`.

- `ALLOWED_ORIGINS="https://a.example,https://b.example"` replaces the exact-origin list
  (the preview regex still applies).
- `ALLOW_LOCALHOST=1` additionally allows `http(s)://localhost|127.0.0.1:<port>` — for
  a dev/staging project only, never production.

`razorpay-webhook` is called server-to-server by Razorpay and sends no CORS headers.

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
