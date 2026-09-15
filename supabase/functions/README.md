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
  MSG91_AUTHKEY=xxxx MSG91_SENDER=HELMEV MSG91_OTP_TEMPLATE_ID=xxxx \
  RAZORPAY_KEY_ID=rzp_live_xxx RAZORPAY_KEY_SECRET=xxx RAZORPAY_WEBHOOK_SECRET=xxx \
  RESEND_API_KEY=re_xxx RESEND_FROM="Blueprint Stage <events@yourdomain.com>" \
  MANAGER_EMAIL=you@yourdomain.com MANAGER_PHONE=+91xxxxxxxxxx \
  APP_URL=https://your-app-domain
```
(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.)

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
