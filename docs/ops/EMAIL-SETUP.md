# Email in Helm (owner guide)

Plain English. In the app the same guide is on **/<studio>/integrations → Email invites**.

## What is e-mailed today
| E-mail | Sent by | Turned on by |
|---|---|---|
| Staff invitation ("<Admin> invited you to join <Studio> on Helm as <Role>" + Join button) | edge function `invite-mailer` (migration 0131) | deploy + it is ON by default |
| Welcome, security alerts, billing reminders | `welcome-mailer`, `security-alert-mailer`, `billing-reminder` | see `supabase/functions/README.md` |
| Payment reminders / follow-ups to clients | `comms-dispatch` (0078) | studio switches in Control Center → Notifications |

The studio never copies the invite link any more: Helm e-mails it within ~2 minutes. **Copy link** stays as
a backup and **Resend email** re-sends (max once per 10 minutes per invite).

## Who it comes from
- **Now (no Resend account):** leave `RESEND_API_KEY` unset. `invite-mailer` sends through **Supabase Auth's own
  mailer** (new address → "Invite user" e-mail, existing account → "Magic link"). Both land on
  `<APP_URL>/login?invite=<token>`. Supabase's built-in mailer is limited to a few e-mails per hour, so for real
  use set **custom SMTP**: Supabase → Authentication → SMTP Settings → e.g. Google Workspace (`smtp.gmail.com`,
  port 465, the account + an **app password**). Then e-mails come from that account.
- **Later (branded):** Resend with your own domain → `Helm <hello@helm.events>`. Set the key and it switches
  automatically; nothing else changes.

Sending "from the studio admin's own Gmail" is not possible without that person's mailbox password, so Helm sends
from one Helm address and names the studio + admin inside the e-mail.

## Steps (staging `xizehqgeyjcfpzrdymly` first, then production `nqltzgiwznphugcfhmbm`)
1. SQL editor: paste `supabase/APPLY-0131.sql`. Every check row must be `true` (re-check any time with
   `supabase/VERIFY-0131.sql`). Optional, for the status card: `supabase/APPLY-0134.sql`.
2. Supabase → Authentication → URL Configuration → Redirect URLs: add `https://www.helm.events/login*`
   (staging: your staging site + `/login*`).
3. Deploy:
   ```bash
   supabase functions deploy invite-mailer --no-verify-jwt --project-ref <ref>
   ```
4. Secrets:
   ```bash
   supabase secrets set --project-ref <ref> \
     HELM_INVITE_EMAIL_SECRET="$(openssl rand -hex 32)" \
     APP_URL="https://www.helm.events"
   # later, branded e-mail (shared with the other mailers):
   #   RESEND_API_KEY="re_..."  RESEND_FROM="Helm <hello@helm.events>"
   ```
5. Safety-net schedule (the Staff page also flushes right after an invite), every 2 minutes:
   ```sql
   select cron.schedule('invite-mailer', '*/2 * * * *', $$
     select net.http_post('https://<ref>.supabase.co/functions/v1/invite-mailer',
       '{}'::jsonb, '{}'::jsonb, jsonb_build_object('x-helm-cron-secret', '<the secret>'), 15000) $$);
   ```
6. Test: invite your own second address from Control Center → User control. Then
   `select status, count(*) from public.invite_email_outbox group by 1;` → one `sent` row.

## Resend (when you want branded e-mail)
1. resend.com → sign up → **Domains → Add domain** `helm.events`.
2. Add the DNS records it shows (SPF `TXT`, DKIM `CNAME`/`TXT`, optional DMARC) at your DNS provider; wait for
   **Verified**.
3. **API Keys → Create** (Sending access). Copy once → `RESEND_API_KEY`.
4. `RESEND_FROM="Helm <hello@helm.events>"`.

## If something is wrong
- Status card says **Waiting for Helm** → rows were marked `skipped`: function not deployed, or SMTP/Resend not set.
- Nothing in the outbox → 0131 not applied (or the invite was created before 0131: press Resend email).
- Emergency stop: `supabase secrets set HELM_INVITE_EMAILS_ENABLED=false --project-ref <ref>`. No data is touched.
- Logs never contain addresses or tokens.
