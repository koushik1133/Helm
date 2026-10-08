# Helm auth email templates (Supabase)

Branded, responsive, table-based HTML emails (inline CSS, dark-mode friendly, no external images) for every Supabase Auth email. They use the Supabase Go template variables exactly as Supabase documents them.

| Supabase template | File | Subject line | Variables used |
|---|---|---|---|
| Confirm signup | `confirm-signup.html` | `Confirm your email for Helm` | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| Invite user | `invite.html` | `You're invited to join a studio on Helm` | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .SiteURL }}` |
| Magic link | `magic-link.html` | `Your Helm sign-in link` | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| Change email address | `change-email.html` | `Confirm your new email for Helm` | `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .NewEmail }}` |
| Reset password | `reset-password.html` | `Reset your Helm password` | `{{ .ConfirmationURL }}`, `{{ .Email }}` |
| Reauthentication | `reauthentication.html` | `Your Helm verification code` | `{{ .Token }}`, `{{ .Email }}` |

## Owner steps (do this for staging first, then prod)

1. Open the Supabase dashboard and pick the project: **helm-staging** (`xizehqgeyjcfpzrdymly`) first, then **prod** (`nqltzgiwznphugcfhmbm`).
2. Go to **Authentication → Emails → Templates**.
3. For each row in the table above: choose the template, paste the **Subject line**, switch the body to the source/HTML view, delete what is there, paste the full contents of the matching `.html` file, and click **Save**.
4. Go to **Authentication → URL Configuration** and check **Site URL** is `https://www.helm.events` (staging: the staging URL) and that `https://www.helm.events/login.html` (and the staging equivalent) is in **Redirect URLs**. The confirm link returns to `login.html?code=…`, which signs the person in and shows "Email confirmed".
5. Send yourself a test: create a studio with a new address on **staging**, check the email looks right in Gmail (web + phone) and Outlook, click **Confirm my email**, and check you land signed in with the "Email confirmed" toast.
6. Only then repeat steps 2–4 on prod.

## Recommended: send from no-reply@helm.events (owner item)

By default Supabase sends from "Supabase Auth" via a shared, heavily rate-limited server (a few emails per hour) — mail often lands in spam. Set up custom SMTP:

1. Create an account with a transactional email provider (e.g. **Resend**; Postmark or Amazon SES also work) and verify the domain `helm.events` (add the SPF, DKIM and return-path DNS records they give you; add a DMARC record such as `v=DMARC1; p=quarantine; rua=mailto:dmarc@helm.events`).
2. Supabase → **Project Settings → Authentication → SMTP Settings** → enable custom SMTP: host `smtp.resend.com`, port `465`, user `resend`, password = the Resend API key (keep it only in the dashboard, never in the repo), sender email `no-reply@helm.events`, sender name `Helm Events`.
3. Raise **Authentication → Rate Limits → emails per hour** to fit your sign-up volume.
4. Do this on staging first, test, then prod.

The app side never reveals whether an email has an account: sign-up, "Resend email" and "Resend confirmation link" always show the same generic message.
