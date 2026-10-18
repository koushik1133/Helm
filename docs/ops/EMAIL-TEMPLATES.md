# Helm auth e-mails: templates, link expiry and redirect URLs (owner steps)

These are the e-mails Supabase Auth sends for Helm: staff invites (when no Resend key is set,
`supabase/functions/invite-mailer` sends through Supabase Auth), sign-in links, password resets,
sign-up confirmation, e-mail changes and reauthentication codes. The templates in
`docs/ops/email-templates/` (2026-10 redesign) use the current Helm logo (hosted PNG
`https://www.helm.events/email/helm-logo.png`, so it only appears once this branch is deployed),
emerald brand `#0d8a5c`, ink `#101511`, a clean 600px card with an emerald top edge, one big button,
preheader text and the footer "Helm Events · helm.events". They are table-based with inline CSS, so
they render in Gmail, Outlook and Apple Mail, and switch to a dark card in dark mode. No tracking pixels.

Do NOT hand-edit the HTML files: they are generated from `supabase/functions/_shared/email-layout.mjs`
(the same layout the edge-function e-mails use) by `node scripts/gen-email-templates.mjs`.

Do staging (`helm-staging`, `xizehqgeyjcfpzrdymly`) first, test, then prod (`nqltzgiwznphugcfhmbm`).

## 1. Paste the templates

Supabase dashboard → your project → **Authentication → Emails → Templates**. For each row: open the
template, paste the **Subject**, switch the body to the HTML/source view, delete everything, paste the
whole file, then **Save changes**.

| Supabase template | File | Subject |
|---|---|---|
| Invite user | `email-templates/invite-user.html` | `{{ if .Data.studio }}You're invited to join {{ .Data.studio }} on Helm{{ else }}You're invited to join a studio on Helm{{ end }}` |
| Magic link | `email-templates/magic-link.html` | `Your Helm sign-in link` |
| Reset password | `email-templates/reset-password.html` | `Reset your Helm password` |
| Confirm signup | `email-templates/confirm-signup.html` | `Confirm your email for Helm` |
| Change email address | `email-templates/change-email.html` | `Confirm your new email for Helm` |
| Reauthentication | `email-templates/reauthentication.html` | `Your Helm verification code` |

Template variables used: `{{ .ConfirmationURL }}`, `{{ .Email }}`, `{{ .SiteURL }}`, `{{ .NewEmail }}`
(change e-mail only), `{{ .Token }}` (reauthentication only) and, in the invite only, `{{ .Data.studio }}`, `{{ .Data.role }}`,
`{{ .Data.invited_by }}`. Those three `Data` names are exactly the metadata keys `invite-mailer` passes
to `inviteUserByEmail(..., { data: { studio, role, invited_by } })`. Each is wrapped in
`{{ if … }}`, so an empty value never shows a blank.

If the dashboard rejects a subject with `{{ if }}`, use the plain subject
`You're invited to join a studio on Helm` instead.

The magic link is also used for invites to people who **already have** a Helm account. It cannot
show the studio name, because Supabase only passes that person's own profile data to it.

## 2. Link expiry (two separate clocks)

| What | How long | Where it is set |
|---|---|---|
| The Helm invitation (the `invite=` token, `invitations.expires_at`) | **7 days** | database default (unchanged) |
| The Supabase button link inside the e-mail | Currently **3600 s = 1 hour** | **Authentication → Emails → (SMTP / provider settings) → "Email OTP expiration"** (older dashboards: Authentication → Providers → Email) |

**Recommended:** set **Email OTP expiration = `86400`** (24 hours, the maximum Supabase allows) on both
projects. The invite e-mail tells the recipient the button lasts 24 hours.

If the e-mail button has expired (or was already clicked) but the Helm invitation is still valid,
nothing is lost:

- The link returns to `/login?invite=…#error=access_denied&error_code=otp_expired`. The page shows
  **"This email link has expired — ask your studio to resend the invite"**, not a blank page, and keeps the invite.
- The studio admin clicks **Resend email** on the Staff page, which sends a fresh link. Or
- the invitee creates their account, or signs in, **with the same e-mail** on that page, and the
  invitation is accepted automatically.

## 3. What a new invitee sees

1. They click **Accept invitation** in the e-mail and land on `/login?invite=<token>`, already signed in by the link.
2. The invitation is accepted, so they are now a member of the studio.
3. **Set your password**: they enter their full name, a password and the password again. This uses
   `supabase.auth.updateUser({ password, data: { full_name } })` and follows Helm's password rule.
4. If the studio requires a profile, they see the profile set-up screen next, with the name already
   filled in. After that they land in the studio.

People who already have an account get the magic link instead. They skip step 3.

If a new invitee closes the tab before setting a password, they can still get in later. They open
**Forgot password?** on the sign-in page, enter the invited e-mail and set a password from the reset e-mail.

## 4. Redirect URLs (Authentication → URL Configuration)

**Site URL:** prod `https://www.helm.events`; staging the staging URL (local: `http://localhost:4402`).

Add these to **Redirect URLs**. The `/**` wildcard covers `/login.html?invite=…`, `/login`,
`/reset-password` and `/reset-password.html`:

| Environment | Redirect URLs to add |
|---|---|
| Staging / local | `http://localhost:4402/**` (plus your staging host as `https://<staging-host>/**` if you have one) |
| Production | `https://www.helm.events/**` and `https://helm.events/**` |

Where each link goes back to (all must match the list above):

| E-mail | Returns to |
|---|---|
| Invite user / magic link (staff invite) | `<origin>/login?invite=<token>`, from `joinLink()` in `invite-mailer/templates.ts` |
| Reset password | `<origin>/reset-password` (`BPStore.auth.requestPasswordReset`) |
| Confirm signup | `<origin>/login.html?…` (`confirmRedirect()` in `login.html`) |
| Change email | `<origin>/login.html` |

**Staff invite origin:** `invite-mailer` builds the link from the `APP_URL` function secret. Only
`https://` values are accepted, and anything else falls back to `https://www.helm.events`. On
**staging**, set `APP_URL` to the staging https host. Otherwise invite e-mails from staging point at
production. A plain `http://localhost:4402` cannot be used for invite links, so test invites through
the staging https host, or open the link and swap the host by hand.

If a URL is missing from the list, Supabase silently sends the person to the **Site URL** instead.
For a reset link, Helm still notices the recovery session and moves them to `/reset-password`.

## 5. Check the password reset end to end (staging)

1. On `/login`, click **Forgot password?**, enter an e-mail that has an account and click **Send reset link**.
2. Open the e-mail **in the same browser** (the PKCE code needs it) and click **Choose a new password**.
   You land on `/reset-password?code=…`, which is exchanged for a recovery session.
3. Enter the new password twice and save. Every session is signed out and you return to
   `/login?reset=1`, which shows "Your password was updated…".
4. Sign in with the new password.
5. Expired or reused link: `/reset-password` shows "This link has expired" with **Request a new link →**.

## 6. Check the invite end to end (staging)

1. On the Staff page, invite a brand-new e-mail. Check the e-mail shows the studio, the role and who invited them.
2. Click the button. You should see **Set your password**. Save it, and you land in the studio.
3. Sign out, then sign in with that e-mail and the new password.
4. Invite an e-mail that already has an account. The magic-link e-mail should arrive, and there should be no password screen.
5. Expired link: wait past the OTP expiry (or click the same button twice) and check you see the friendly expiry message.

If step 2 fails with a "current password" error, check **Authentication → Providers → Email →
"Require current password when updating"**. Supabase only asks for it when the account already has a
password, and a new invitee has none. Report the error if it still appears.
