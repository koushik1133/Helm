# Switching on WhatsApp in Helm (owner guide)

Plain-English, step by step. The same guide is in the app: **/<studio>/integrations → WhatsApp** (also linked
from the dashboard "Getting started" checklist and the Studio setup wizard step "WhatsApp & email"). The WhatsApp code is **already built** and ships **switched off**
(it fails closed: nothing is sent until every step below is done). You do the Meta and
Supabase parts; no code change is needed except flipping one flag at the end.

Projects:
- **Staging**: `xizehqgeyjcfpzrdymly` - always do it here first.
- **Production**: `nqltzgiwznphugcfhmbm` - only after staging works.

What WhatsApp is used for in Helm (each piece has its own switch):

| Piece | Edge function | What it sends | Switch |
|---|---|---|---|
| Event messages from staff | `send-whatsapp` | template messages to the event's client / crew / booked vendor | `liveChannels.whatsapp` in `public/config.js` |
| Phone verification code | `send-phone-code` | 6-digit code to a member | same flag |
| Reminders + "copy my bell to WhatsApp" | `comms-dispatch` | payment reminders, client follow-ups, a member's bell notifications (task assigned, etc.) | secret `HELM_COMMS_ENABLED=true` + per-studio settings |
| Package choice notices | `pkg-client-notify` | package accepted/declined, booklet code, "client picked a package" | secret `HELM_PKG_NOTIFY_ENABLED=true` |
| Delivery receipts + STOP | `wa-webhook` | nothing - records sent/delivered/read and STOP/START opt-outs | dormant until its 2 secrets are set |

---

## Step 1 - Meta business account (about 1-3 days for verification)
1. Go to **business.facebook.com**, create (or use) your **Meta Business account** for the company.
2. Business Settings > **Business info** > start **Business verification** (GST certificate / incorporation
   document). Unverified accounts can only message a few test numbers and 250 people/day.

## Step 2 - WhatsApp Business Platform app
1. Go to **developers.facebook.com** > My Apps > **Create app** > type **Business** > link it to the business above.
2. In the app, **Add product > WhatsApp**. Meta creates a **WhatsApp Business Account (WABA)**.
3. Note the **WhatsApp Business Account ID** (WhatsApp > API Setup).

## Step 3 - Phone number
1. WhatsApp > API Setup > **Add phone number**. Use a number that is **not** already on the normal
   WhatsApp / WhatsApp Business phone app (or delete WhatsApp from that number first).
2. Verify it by SMS / call. Set the display name (e.g. "Helm Events") - Meta reviews it.
3. Copy the **Phone number ID** (a long number - NOT the phone number itself). This becomes `WHATSAPP_PHONE_ID`.

## Step 4 - Permanent access token
The token on the API Setup page expires in 24 hours - do not use it.
1. business.facebook.com > Business Settings > Users > **System users** > Add (role Admin).
2. **Assign assets**: your app (full control) and your WhatsApp account (full control).
3. **Generate new token** > choose the app > expiry **Never** > tick `whatsapp_business_messaging`
   and `whatsapp_business_management`. Copy it once and keep it in a password manager.
   This becomes `WHATSAPP_TOKEN`.
4. App > Settings > Basic > **App secret** (click Show). This becomes `WHATSAPP_APP_SECRET` (webhook signing).

## Step 5 - Message templates to create
WhatsApp Manager > Account tools > **Message templates** > Create. A business may only *start* a chat with an
**approved template**. Create each one below, **Language: English (US) `en_US`** unless noted, with exactly the
variables shown, in that order (`{{1}}`, `{{2}}` ...). Approval usually takes minutes to a few hours.
Wording can be changed, but the **name, language, and number/order of variables must match**.

| Template name | Category | Body (variables in order) | Used by |
|---|---|---|---|
| `helm_task_assigned` | Utility | `New assignment from your studio: {{1}}` - ONE variable, the whole assignment text + link | `comms-dispatch` task / run-sheet assignment notices (0132). Secret `WHATSAPP_TPL_TASK_ASSIGNED=helm_task_assigned`. **Language `en`**. |
| `helm_event_reminder` | Utility | `Event reminder from your studio: {{1}}` - ONE variable | `comms-dispatch` WhatsApp copy of the "event in N days" reminder (0129). Secret `WHATSAPP_TPL_EVENT_REMINDER=helm_event_reminder`. **Language `en`**. |
| `event_reminder` | Utility | `Reminder: {{1}} is on {{2}}. Details: {{3}}` (event, date, link) | `send-whatsapp` (default allowlist) |
| `event_update` | Utility | `Hi {{1}}, there is an update to {{2}}. Please check your link: {{3}}` | `send-whatsapp` (default allowlist) |
| `payment_reminder` | Utility | `Hi {{1}}, a payment of {{2}} for {{3}} is due on {{4}}. Pay here: {{5}}` | `send-whatsapp` (default allowlist) |
| `crew_assignment` | Utility | `Hi {{1}}, you are booked for {{2}} on {{3}}. Your link: {{4}}` | `send-whatsapp` (default allowlist) |
| `helm_notice` (any name you like) | Utility | `{{1}}` - ONE variable carrying the whole text | `comms-dispatch` (set as `COMMS_WHATSAPP_TEMPLATE`) and `pkg-client-notify` (set as `PKG_WHATSAPP_TEMPLATE`). **Language `en`** (these functions send code `en`). |
| `phone_verification` | **Authentication** | Meta's fixed OTP text with one code variable + "Copy code" button | `send-phone-code` (override with `WHATSAPP_VERIFY_TEMPLATE`) |

Note: Meta often rejects templates whose body is *only* a variable. If `helm_notice` is rejected, use
`Update from your studio: {{1}}`.

Note: `helm_task_assigned` / `helm_event_reminder` are sent by `comms-dispatch`, which does NOT use the
`send-whatsapp` allowlist. If either secret is unset it falls back to `COMMS_WHATSAPP_TEMPLATE`.
Example variable for Meta review: `Stage setup at 4 PM for Rao Wedding. Open your link: https://www.helm.events/work`.

Note on the `send-whatsapp` allowlist: `send-whatsapp` only sends template names on its allowlist. The default list is
`event_update, payment_reminder, event_reminder, crew_assignment`. Unless the code default has been updated,
include the new name in the secret: `WHATSAPP_TEMPLATES="event_update,payment_reminder,event_reminder,crew_assignment,helm_task_assigned"`.

## Step 6 - Supabase secrets + deploy (staging first)
Run in a terminal inside the repo, with the Supabase CLI logged in. Generate random secrets with `openssl rand -hex 32`.

```bash
# ---- STAGING ----
supabase link --project-ref xizehqgeyjcfpzrdymly

supabase secrets set --project-ref xizehqgeyjcfpzrdymly \
  WHATSAPP_TOKEN="<permanent token from step 4>" \
  WHATSAPP_PHONE_ID="<phone number ID from step 3>" \
  WHATSAPP_API_VERSION="v21.0" \
  WHATSAPP_TEMPLATES="event_update,payment_reminder,event_reminder,crew_assignment,helm_task_assigned" \
  WHATSAPP_APP_SECRET="<app secret from step 4>" \
  WHATSAPP_WEBHOOK_VERIFY_TOKEN="<any long random string you invent>" \
  COMMS_WHATSAPP_TEMPLATE="helm_notice" \
  WHATSAPP_TPL_TASK_ASSIGNED="helm_task_assigned" \
  WHATSAPP_TPL_EVENT_REMINDER="helm_event_reminder" \
  PKG_WHATSAPP_TEMPLATE="helm_notice" \
  APP_URL="https://<your staging site>"

supabase functions deploy send-whatsapp   --project-ref xizehqgeyjcfpzrdymly
supabase functions deploy send-phone-code --project-ref xizehqgeyjcfpzrdymly
supabase functions deploy wa-webhook      --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy comms-dispatch  --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy pkg-client-notify --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy integrations-test --project-ref xizehqgeyjcfpzrdymly
```

For production repeat the same commands with `nqltzgiwznphugcfhmbm` and `APP_URL="https://www.helm.events"`.
(Check `supabase/functions/README.md` for the exact `--no-verify-jwt` list if it differs.)

Database side (should already be applied - confirm in the SQL editor):
`0055` (phone verify), `0069` (package outbox), `0078` (comms automation), `0117` (integration accounts,
opt-outs, webhook events). `select to_regclass('public.whatsapp_opt_outs'), to_regclass('public.comms_outbox');`
must return two non-null names.

## Step 7 - Webhook (delivery receipts + STOP replies)
1. Meta app > WhatsApp > **Configuration** > Webhook > Edit.
2. **Callback URL**: `https://xizehqgeyjcfpzrdymly.supabase.co/functions/v1/wa-webhook`
   (production: `https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/wa-webhook`).
3. **Verify token**: the exact `WHATSAPP_WEBHOOK_VERIFY_TOKEN` you set. Click Verify and save.
4. Webhook fields > **Subscribe** to `messages`, `message_template_status_update`, `phone_number_quality_update`.

If verify fails with 404, the two webhook secrets are not set (the function stays dormant without them).

## Step 8 - Turn on the background senders (reminders, bell copies, package notices)
Follow `docs/COMMS-AUTOMATION-SETUP.md` steps 4-5. In short:
```bash
supabase secrets set --project-ref <ref> HELM_COMMS_ENABLED=true HELM_COMMS_SECRET="<random>" \
  HELM_PKG_NOTIFY_ENABLED=true HELM_PKG_NOTIFY_SECRET="<random>"
```
then schedule `comms-dispatch` (and `pkg-client-notify`) every 5 minutes with `pg_cron` + `pg_net`, keeping
the secret in Vault (exact SQL is in that doc). Each studio enters its **studio WhatsApp number** and switches on WhatsApp copies in
**Control Center > Notifications > Automatic client messages & WhatsApp** (`control.html#notify`) and each member opts in with their own WhatsApp number.

## Step 9 - Flip the app flag (this is the only code change)
In `public/config.js`:
```js
liveChannels: { sms: false, pay: false, whatsapp: true }
```
Do this in the staging build first. The CI check `check-deferred-integrations` expects `false`; update that
check in the same change (ask Claude to prepare it - owner pushes).

## Step 9b - Integrations page check (0150, no curl needed)
Apply `supabase/APPLY-0150.sql` (every VERIFY row `true`) and deploy `integrations-test` (above). Then, signed in
as a studio admin, open **Integrations** (`/<studio>/integrations`):
- WhatsApp card: enter the studio number as `+<country code> <number>` (E.164), **Save number**, **Send test WhatsApp**.
  - **Simulated** = secrets not set yet (the result line says which one is missing); nothing leaves Helm.
  - **Live** = `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` + `COMMS_WHATSAPP_TEMPLATE` are set; the test uses the
    `helm_notice` template and goes ONLY to the studio's own saved number.
- The status words are the same for every channel: **Not connected / Simulated / Live**. The page reads only
  booleans from the server; no token, ID or key is ever sent to the browser or stored in a table.
- Kill switch for the test button only: `HELM_INTEGRATIONS_TEST_ENABLED=false` (tests then always say Simulated).

## Step 10 - Test with ONE number
1. Use your own phone as the test number. While the business is unverified, add it under
   API Setup > "To" > **Manage phone number list**.
2. Credential check (sends nothing) - from a signed-in staff browser session copy the access token:
```bash
curl -s -X POST "https://xizehqgeyjcfpzrdymly.supabase.co/functions/v1/send-whatsapp" \
  -H "Authorization: Bearer <STAFF_ACCESS_TOKEN>" -H "apikey: <ANON_KEY>" \
  -H "Content-Type: application/json" -d '{"ping":true}'
# expect {"ok":true}
```
3. Make a test event whose client phone is your number, then send one template:
```bash
curl -s -X POST "https://xizehqgeyjcfpzrdymly.supabase.co/functions/v1/send-whatsapp" \
  -H "Authorization: Bearer <STAFF_ACCESS_TOKEN>" -H "apikey: <ANON_KEY>" -H "Content-Type: application/json" \
  -d '{"quote_id":"<event uuid>","number":"91XXXXXXXXXX","template":"event_update","lang":"en_US","params":["Test","Test event","https://example.com"]}'
# expect {"sent":true,"id":"wamid..."}
```
   The function refuses numbers that do not belong to that event (client, crew link or booked vendor) -
   that is the anti-spam guard, not a bug.
4. Reply **STOP** from your phone, then check `select * from whatsapp_opt_outs;` - one row. Reply **START** to undo.
5. Only then repeat steps 6-9 on production.

## Costs (India, approximate - check Meta's current rate card)
- Meta charges **per message** by category: Utility roughly Rs 0.12-0.15, Authentication about the same,
  Marketing about Rs 0.80+. Utility templates sent inside an open 24-hour chat with that person are free.
- All Helm templates above are **Utility** (or Authentication for the code) - keep them that way; Meta may
  re-classify promotional wording as Marketing.
- Add a payment method in WhatsApp Manager > Payment settings, otherwise sends fail after the free test tier.
- Helm's own guard: max **100 WhatsApp messages per studio per hour** from `send-whatsapp`, and the per-member
  bell copy is rate-limited per hour.

## If something is wrong
- `WhatsApp Cloud API not configured` - `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` missing on that project.
- `template not allowed` - add the name to `WHATSAPP_TEMPLATES`.
- Meta error 132001 - template name/language not approved or misspelt; 131026 - number not on WhatsApp;
  131030 - number not in the test list (unverified business).
- Background reminders not arriving - `HELM_COMMS_ENABLED` not `true`, cron job missing, studio switch off,
  or member not opted in.
- To switch everything off instantly: set `liveChannels.whatsapp` back to `false` and
  `supabase secrets unset HELM_COMMS_ENABLED HELM_PKG_NOTIFY_ENABLED --project-ref <ref>`. No data is touched.

## Send proposal on WhatsApp + WhatsApp approval code (0151)

Model 1: everything goes out from ONE Helm Events number. Until `WHATSAPP_TOKEN` and
`WHATSAPP_PHONE_ID` are set, everything runs **simulated**: the studio's "Send on WhatsApp"
button records the opt-in and an audit row marked *Simulated*, and the approval page shows
the code on screen (staging only) instead of sending it.

### Owner steps
1. Run `supabase/APPLY-0151.sql` (staging first, then prod). Every VERIFY row must say `t`.
2. Deploy: `supabase functions deploy wa-proposal` and `supabase functions deploy send-otp`.
3. Submit the 5 templates below in Meta WhatsApp Manager and wait for "Approved".
4. Set secrets: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` (and `WHATSAPP_TPL_LANG` if the templates
   are not language `en`); for the e-mail fallback `RESEND_API_KEY` + `RESEND_FROM`.
5. Set `liveChannels.whatsapp: true` in `public/config.js` (the page then calls the edge functions).
6. Point the wa-webhook at Meta (above) so Delivered / Read show on the studio's share panel.

### The 5 templates (submit exactly)
The URL button base is `https://www.helm.events/portal.html?token=` with a **dynamic suffix**
`{{1}}` (Helm fills in the client's approval token). Sample suffix for review:
`00000000-0000-4000-8000-000000000000`.

| # | Name | Category | Language | Body | Buttons |
|---|------|----------|----------|------|---------|
| 1 | `proposal_sent` | UTILITY | English (`en`) | `Hi {{1}}, {{2}} has shared your proposal for your {{3}} on {{4}}. Total: {{5}}. Tap below to review and approve it. Reply STOP to opt out.` | URL button "Review proposal" -> `https://www.helm.events/portal.html?token={{1}}` |
| 2 | `proposal_approval_otp` | AUTHENTICATION | English (`en`) | Meta's fixed body: `{{1}} is your verification code.` with "Add security recommendation" ON and "Add expiry time" = 10 minutes (footer: `This code expires in 10 minutes.`) | Copy code button ("Copy code") |
| 3 | `proposal_approved_pay` | UTILITY | English (`en`) | `Thank you {{1}}, your {{2}} on {{3}} is approved. Amount: {{4}}. Tap below to view your booking and pay securely.` | URL button "Pay now" -> `https://www.helm.events/portal.html?token={{1}}` |
| 4 | `payment_received` | UTILITY | English (`en`) | `Hi {{1}}, {{2}} has received your payment for your {{3}}. Thank you! Tap below to see your receipt and booking.` | URL button "View booking" -> `https://www.helm.events/portal.html?token={{1}}` |
| 5 | `proposal_reminder` | UTILITY | English (`en`) | `Hi {{1}}, a reminder from {{2}}: your proposal for your {{3}} on {{4}} (total {{5}}) is waiting for your approval. Reply STOP to opt out.` | URL button "Review proposal" -> `https://www.helm.events/portal.html?token={{1}}` |

Variables Helm sends: client name, studio name, event type, event date (`DD Mon YYYY`), total
(`INR 2,36,000` style, e.g. `INR 236,000`). Which one goes out is picked from the quote: not
approved -> `proposal_sent` (then `proposal_reminder` on the next press), approved ->
`proposal_approved_pay`, paid -> `payment_received`.

### Rules the code enforces
- The number is ALWAYS the client mobile on the quote, E.164-checked (the studio cannot type
  another one; the client approval page never asks for one for WhatsApp / e-mail codes).
- "Client agreed to receive WhatsApp updates" must be ticked once per number; stored with who
  and when (`wa_proposal_optins`, append-only). A STOP reply blocks further sends.
- Approval code: 6 digits, stored only as a bcrypt hash, 10-minute expiry, 5 attempts,
  30 s cooldown and 3 resends per channel per 30 minutes. After 60 s (or a WhatsApp failure)
  the page offers "Send code by email instead" (to the e-mail on the quote). SMS is unchanged.
- Audit (`wa_proposal_audit`, append-only, studio read-only): quote id + version + SHA-256 of
  the quote snapshot, studio, phone, channel, template, wamid, sent / delivered / read (from
  wa-webhook), code sent / checked + attempts, IP (Cloudflare header) + user agent, approval time.
