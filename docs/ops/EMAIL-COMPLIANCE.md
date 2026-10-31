# Email compliance (Helm)

What Helm does so its e-mail meets the **Gmail / Yahoo bulk-sender rules**, **CAN-SPAM** (US),
**GDPR / UK GDPR** and the **India DPDP Act 2023**, plus the DNS steps only the owner can do.
Code: `supabase/functions/_shared/email-compliance.mjs`, `supabase/functions/email-unsubscribe`,
`public/unsubscribe.html`, migration `0165_email_unsubscribe.sql` (paste `supabase/APPLY-0165.sql`).

> This is engineering guidance, not legal advice. Have the privacy policy and marketing consent
> wording reviewed by a lawyer before launch.

## 1. Rules we follow

| Rule | Source | What Helm does |
|---|---|---|
| SPF **and** DKIM on the sending domain, DMARC record (at least `p=none`), From aligned with SPF or DKIM | Gmail + Yahoo (all senders > 5,000/day; SPF or DKIM for everyone) | Owner DNS steps in section 4. Mail is sent *from* a helm.events address; the studio name is only the display name ("Sparkle via Helm Events" with EMAIL_BRAND_MODE=studio) and the studio address is Reply-To (business e-mail, else the studio owner's - never the sending address, R107), so alignment holds. |
| One-click unsubscribe for marketing/promotional mail: `List-Unsubscribe` (mailto + https) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), plus a visible link; honour within 2 days | Gmail + Yahoo | Every non-transactional e-mail has both headers and a visible "Unsubscribe" link. The opt-out is recorded instantly and the senders skip that address from then on. |
| Spam-complaint rate under 0.3% (aim for under 0.1%) | Gmail + Yahoo | Only people who have a relationship with the studio get mail; follow-ups are switched off by default per studio; opt-outs are instant. Watch the rate in Postmaster Tools (section 5). |
| Valid From / Reply-To, no header tricks, honest subjects | Gmail, CAN-SPAM | `cleanName` strips CR/LF/quotes from display names; subjects are plain descriptions ("Your Helm free trial ends tomorrow", "Following up - <event>"). No "Re:"/"Fwd:" fakery. |
| Postal address in commercial mail; opt-out honoured within 10 business days; opt-out link works for 30 days | CAN-SPAM | Footer shows "Helm Events, <postal address>" (env `HELM_POSTAL_ADDRESS`). Opt-outs are honoured immediately; links never expire (HMAC token, no expiry). |
| Marketing needs consent (or soft opt-in for existing customers), state purpose, easy withdrawal, privacy link | GDPR / UK GDPR + PECR, DPDP s.6 (consent, withdrawal as easy as giving) | Footer states *why* the recipient got the mail and links Privacy. Withdrawal = one click, no login. Re-subscribe is offered on the same page. |
| Transactional mail is exempt from unsubscribe | CAN-SPAM "transactional or relationship", Gmail | Sign-in codes, invites, approval/booklet links, receipts, payment reminders, billing and security notices carry the footer **without** an unsubscribe link. |

## 2. Classification of every e-mail Helm sends

| E-mail | Sent by | Class | Footer | Unsubscribe + headers |
|---|---|---|---|---|
| Confirm sign-up, magic link, reset password, change e-mail, reauthentication, invite (Supabase Auth) | Supabase Auth templates `docs/ops/email-templates`, `docs/email-templates` | Transactional | yes | no |
| Team invite | `invite-mailer` | Transactional | yes | no |
| Welcome (owner / member) | `welcome-mailer` | Transactional | yes | no |
| Approval link / booklet link to a client | `client-mailer` (via `_shared/mailer.ts`) | Transactional | yes | no |
| E-mail OTP for approval | `send-otp` (via `_shared/mailer.ts`) | Transactional | yes | no |
| Package chosen / client + staff notices | `pkg-client-notify` | Transactional | yes | no |
| Payment received / needs attention | `razorpay-webhook` | Transactional | yes | no |
| Client payment reminder (`pay_reminder`) | `comms-dispatch` | Transactional (money owed for a booked event) | yes | no |
| Subscription renews soon / past due | `billing-reminder` | Transactional | yes | no |
| Security alert to studio admins | `security-alert-mailer` | Transactional | yes (no links, anti-phishing) | no |
| Integrations "send test" | `integrations-test` | Transactional | yes | no |
| Sales follow-up (`follow_up`) | `comms-dispatch` | **Non-transactional** | yes | **yes** (per studio) |
| Nurture greetings (birthday, anniversary, ...) | `queue_nurture_greeting` -> `notifications` (simulated today, no real send yet) | **Non-transactional** | yes, when a sender is built | **yes** (per studio); opted-out rows are stored `suppressed` |
| Free-trial nudges (day 5/7/8; trial_7d/3d/1d/ended) | `comms-dispatch` (0120), `billing-reminder` (0058) | **Non-transactional** | yes | **yes** (scope: Helm itself) |
| WhatsApp messages | `send-whatsapp`, `wa-*` | Not e-mail | - | STOP handled by 0155 |

Non-transactional senders **fail closed**: no token (0165 not applied) or opted out = the row is
marked `skipped` and nothing is sent.

## 3. How unsubscribe works

1. Sender asks the DB for a token: `email_unsub_token(org, email)` = `v1.<org>.<email hex>.<HMAC-SHA256>`
   (key in `email_unsub_secret`, never readable over the API). For comms rows: `comms_outbox_unsub(id)`.
2. The e-mail gets a visible link `https://www.helm.events/unsubscribe?t=<token>` and headers
   `List-Unsubscribe: <mailto:unsubscribe@helm.events?subject=unsubscribe>, <https://<project>.supabase.co/functions/v1/email-unsubscribe?t=<token>>`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
3. Gmail/Yahoo "Unsubscribe" button -> POST to `email-unsubscribe` -> `email_unsub_set(token, true, 'one_click')`.
   A GET never changes anything (link scanners), it redirects to the page.
4. `/unsubscribe` page: shows sender + masked address, one button to unsubscribe, confirmation, re-subscribe button.
5. Opt-out is per recipient **per studio** (`email_optouts.org_key`); Helm's own nudges use the zero uuid.
   Triggers keep later follow-ups/greetings to that address `skipped` / `suppressed`; senders re-check right before sending.
6. `unsubscribe@helm.events` (mailto) must be a real mailbox; process requests by hand within 2 days
   (or use the page link). Set `UNSUB_MAILTO` to change it.

## 4. OWNER: DNS for helm.events

Do these at the DNS host of helm.events. One SPF record only per name (merge, don't add a second).
Check with `dig +short TXT helm.events`, `dig +short TXT _dmarc.helm.events`, or MXToolbox.

### Now: Gmail / Google Workspace SMTP (`SMTP_HOST=smtp.gmail.com`)
A personal `@gmail.com` sender can never align with helm.events. Send from a **Google Workspace
mailbox on helm.events** (e.g. `mail@helm.events`) with an App Password; set `SMTP_FROM` to it.

| Type | Name | Value |
|---|---|---|
| MX | `helm.events` | Google Workspace MX (`smtp.google.com`, priority 1) |
| TXT (SPF) | `helm.events` | `v=spf1 include:_spf.google.com ~all` |
| TXT (DKIM) | `google._domainkey.helm.events` | the key from Admin console -> Apps -> Gmail -> Authenticate email -> Generate (2048-bit), then click **Start authentication** |
| TXT (DMARC) | `_dmarc.helm.events` | `v=DMARC1; p=none; rua=mailto:dmarc@helm.events; adkim=r; aspf=r; pct=100` |

### Later: Resend (`RESEND_API_KEY`, `RESEND_FROM="Helm <mail@helm.events>"`)
Add the domain in Resend -> Domains; it shows the exact values (region-specific). Typically:

| Type | Name | Value |
|---|---|---|
| TXT (DKIM) | `resend._domainkey.helm.events` | `p=...` (from Resend) |
| MX | `send.helm.events` | `feedback-smtp.<region>.amazonses.com` priority 10 |
| TXT (SPF) | `send.helm.events` | `v=spf1 include:amazonses.com ~all` |

Keep the root SPF for Google as above (Resend uses the `send.` subdomain for bounces, so DMARC
aligns through DKIM on helm.events). The same `_dmarc` record covers both.

### DMARC rollout
1. Start `p=none` with `rua` reports for 2-4 weeks; confirm all real mail passes SPF/DKIM aligned.
2. Then `v=DMARC1; p=quarantine; pct=25; rua=mailto:dmarc@helm.events; adkim=r; aspf=r`, raise `pct` to 100.
3. Optionally `p=reject` once reports are clean for a month.

### Edge secrets / env (owner, when going live)
`HELM_POSTAL_ADDRESS="Helm Events, <street>, <city> <PIN>, India"` (shown in every footer; until set,
a visible placeholder is used), `UNSUB_MAILTO` (default `unsubscribe@helm.events`), `APP_URL`.
Deploy `supabase functions deploy email-unsubscribe --no-verify-jwt`. Run `supabase/APPLY-0165.sql`
on staging then production (VERIFY rows must all be `true`). The Supabase Auth templates now carry the postal address
(Mindspace IT Park, Madhapur, Hyderabad, Telangana 500081; override at runtime with HELM_POSTAL_ADDRESS) - re-paste all six.

## 5. OWNER: Gmail Postmaster Tools
1. Go to https://postmaster.google.com, sign in with a Google account, add domain `helm.events`.
2. Verify with the TXT record it shows (`google-site-verification=...` on `helm.events`).
3. After some volume, watch **Spam rate** (keep < 0.1%, never reach 0.3%), **Authentication**
   (SPF/DKIM/DMARC 100%), **Compliance status** (one-click unsubscribe, alignment).
4. Yahoo: register at https://senders.yahooinc.com (Complaint Feedback Loop) once volume grows.
