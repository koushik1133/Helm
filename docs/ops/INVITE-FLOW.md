# Team invitations: end-to-end trace, root causes and fixes (0205, 2026-10-18)

Branch `fix/invite-accept-flow` (from `feat/trial-bundle`). Migration 0205, edge functions
`invite-signup` + `invite-mailer`, `public/login.html`, `public/auth-confirm.html`, `public/store-api.js`.

## 1. What went wrong in production (plain words)

Trial studio ABCD invited `shagantikoushik+test@gmail.com` as Planner. The invitee opened the e-mail,
saw "Join ABCD - create your account", typed a password and got **"This e-mail already has a Helm
account - sign in instead"** - although they never had a password.

1. **The invite e-mail made the login up front.** Prod has no e-mail provider set for the edge
   functions, so `invite-mailer` used Supabase Auth's own mailer: `inviteUserByEmail()` sends the
   "Invite user" e-mail **and creates the login right away - with no password**. Its "Accept
   invitation" button is a one-time Supabase link (works once, 24 h) that signs the person in.
2. **That one-time sign-in was easy to lose**: the link opened in a browser where the studio admin
   was still signed in (Helm never swaps a signed-in account for one in a link), the link was opened
   twice / by a mail scanner, it expired, or the page was opened again later.
3. **The join form then tried to create the login a second time** (`invite-signup` →
   `createUser`) → Supabase: "already registered" → Helm said "sign in instead". There was no
   password to sign in with, and no way to get one: a dead end.
4. **Different e-mails for different invitees.** A brand-new address got the "Invite user" e-mail
   ("Join ABCD ... Accept invitation"); an address that already had a login got Supabase's generic
   "Magic link" e-mail ("Your Helm sign-in link"). Same feature, two unrelated-looking e-mails.
5. **Self sign-up mixed in.** If the join form's server call failed it silently fell back to the
   normal sign-up, which sends **"Confirm your email for Helm"** - the 11:22 e-mail the second
   tester got before the 11:26 invite. A person who signed up on their own first and never
   confirmed could then neither sign in ("not confirmed") nor create the account ("exists").
6. **"Your password was changed" e-mail with a dead button.** The Supabase *Password changed*
   security notification had the *Reset password* body pasted into it. Notifications have no
   one-time link, so the "Choose a new password" button had an empty link and showed as plain text.
7. **The Supabase project URL was visible** in every auth e-mail
   (`https://nqltzgiwznphugcfhmbm.supabase.co/auth/v1/verify?...`).

## 2. What the fix does

| # | Fix |
|---|---|
| 1 | With an e-mail provider (Resend, **or the SMTP secrets client-mailer already uses**), `invite-mailer` sends ONE branded invitation to everyone and Supabase creates **no** login up front. The join page creates it (`invite-signup`, already confirmed, only for the invited e-mail). |
| 2 | Without a provider, the "Invite user" and "Magic link" Supabase templates now carry the same text ("Join <Studio> on Helm - <Inviter> invited you as <Role>" + **Accept invitation**); for an existing login `invite-mailer` writes that login's `studio` / `role` (human label) / `invited_by` first (0205 `invite_auth_user_id`). |
| 3 | The join page knows, for the invitation's OWN e-mail only (0205 `invite_account_state`, service role): **new** → create password; **needs_link** (login made by the invite, no password) → "Email me a new link to set my password" (never "sign in"); **unconfirmed** (self sign-up never confirmed) → same new link (it confirms and joins); **existing** → "Sign in to accept" with the invite kept (accepted right after sign-in). |
| 4 | Every path shows the invite context: "Join <Studio> on Helm", "<Inviter> invited you as <Role>", the invited e-mail read-only, then the one right action (Set your password / Email me a new link / Sign in to accept). |
| 5 | A used / expired / cancelled link says "This invitation link has expired or was already used - ask <Studio> to resend it" + **Email me a new link**: expired → the studio's bell gets one note per 24 h (0205 `invite_request_new_link`; the invitation itself is never renewed - seat limit / admin's choice); used (already joined) → the normal reset link to choose a password; cancelled → "ask <Studio>". |
| 6 | An invitee **never** goes through self sign-up: no `signUp()` and no "Confirm your email" on the invite path. If the server can't create the account it says so. |
| 7 | All auth e-mail links are on `https://www.helm.events/auth/confirm?token_hash=...&type=...&next=...` (`public/auth-confirm.html`): verified in the browser, then invite → Join page signed in → Set your password; reset → choose a new password; sign-up confirm → signed in (only in the browser that started the sign-up); `next` must be a same-origin path (open redirects refused). |
| 8 | E-mail buttons are Outlook-safe (VML for Outlook desktop + a table cell with a real `<a href>` for everything else) and every e-mail keeps the plain "Copy and paste this link" line. Security notifications have their own templates. |
| 9 | Google on the invite page: the button is shown, the invite token rides the OAuth round trip, and the Google account joins when its e-mail is the invited one (the DB checks that). |
| 10 | A login that already belongs to another studio gets a plain explanation (one login = one studio). |

## 3. Every invite path (traced)

| Path | Code | What the invitee gets / sees now |
|---|---|---|
| Control Center → Users & invites → Create link | `control.html` → `create_invitation` → outbox trigger (0131) → `invitations.sendNow()` → `invite-mailer` | Branded invitation (provider) or the Supabase "Invite user" e-mail (no provider). Join page → right action. |
| Re-invite the same e-mail (reused invite) | `create_invitation` returns `reused` → `resend_invitation_email` (≤ 1 per 10 min) → `sendNow` | The SAME invitation again (same token, same text). |
| Resend email (Staff page / Control Center) | `resendEmail(id)` + `sendNow()` | Same as above. Only pending + unexpired invites can be re-sent. |
| Staff → "Invite to log in" | `staff.html` → `invitations.create` → `sendNow` | Same e-mail and page as Control Center. |
| Onboarding / trial "Invite your team (up to 2)" | `onboarding.js`, `trial-demo.js` → `create` → `sendNow` | Same. Pending invitations hold seats: a free trial is admin + 2 (0166 trigger counts members + pending invites). |
| Revoke | `invitations.revoke` → status `revoked` | Link → "This invitation was cancelled - ask <Studio> if you should still join." |
| Expired (7 days) | `expires_at` | "This invitation link has expired or was already used - ask <Studio> to resend it" + Email me a new link → bell note for the studio. The admin re-sends from Staff. |
| Used (already accepted) | `accept_invitation` is single-use (status `accepted`) | Same message; Email me a new link → reset link to choose a password (for someone who joined but never set one). |
| Brand-new e-mail | | Provider: no login exists → "Choose a password to join" (created confirmed, joins, lands in the studio). No provider: invite link signs in → Set your password → studio. Old/used link → needs_link → new link. |
| E-mail that already has a Helm login (no studio, e.g. removed earlier) | | "Sign in to accept" (or Google) → accepted → studio. |
| E-mail already in ANOTHER studio | `accept_invitation`: one org per login | Clear message: ask that studio's admin to remove you, or get invited with another e-mail. (A login the other studio created with "Add user" moves over - 0155.) |
| Signed up on their own first, never confirmed | 0205 `unconfirmed` | Never "sign in" (it can't work): Email me a new link → the link confirms the e-mail and joins. |
| Signed up on their own first and made their own (trial) studio | one org per login | Same "already in another studio" message. |
| Browser signed in as someone else (e.g. the admin testing) | link session never swaps accounts | "This invitation is for a different e-mail - Sign out & accept invite" → then the right action (a used link → Email me a new link). On /auth/confirm: "Sign out and continue". |
| Google | `signInWithGoogle(login.html?invite=...)` | Joins when the Google e-mail is the invited one; otherwise "different e-mail". |

Single-use and server-side validation: the invite token (48 hex) is checked on the server by
`invite-signup` (pending + unexpired, the typed e-mail must equal the invited one) and by
`accept_invitation` (signed in, confirmed e-mail = invited e-mail, pending, unexpired; accepted once).

## 4. Owner actions (in this order)

1. **SQL** - paste `supabase/APPLY-0205.sql` in the Supabase SQL editor, staging first, then prod.
   Every VERIFY row must be `true`. Safe to run twice; adds 4 small functions only.
2. **Deploy the two edge functions** (staging ref `xizehqgeyjcfpzrdymly`, prod ref `nqltzgiwznphugcfhmbm`):
   ```
   supabase functions deploy invite-signup --no-verify-jwt --project-ref <ref>
   supabase functions deploy invite-mailer --no-verify-jwt --project-ref <ref>
   ```
3. **Recommended: give the edge functions an e-mail provider** so every invitee gets the branded
   invitation and Supabase never makes a login up front. Either Resend (`RESEND_API_KEY`,
   `RESEND_FROM="Helm <notifications@helm.events>"`) or the same SMTP account Supabase Auth uses:
   ```
   supabase secrets set --project-ref <ref> SMTP_HOST=... SMTP_PORT=465 SMTP_USER=... SMTP_PASS=... SMTP_FROM="Helm <notifications@helm.events>"
   ```
   (If `client-mailer` "Send by email" already works on prod, these are already set.)
4. **Supabase → Authentication → URL Configuration**: Site URL `https://www.helm.events`; Redirect
   URLs keep `https://www.helm.events/**` + `https://helm.events/**` and add
   `https://www.helm.events/auth/confirm` (staging: its own site URL + `/auth/confirm`).
5. **Supabase → Authentication → Emails**: re-paste these templates from `docs/ops/email-templates/`
   (subject + whole HTML file, each into its OWN template - see `docs/ops/EMAIL-TEMPLATES.md`):
   Confirm signup, Invite user, Magic link, Reset password, Change email address, and under
   Security notifications: Password changed, Email address changed. Reauthentication is unchanged.
7. Optional: redeploy the other mailers so their e-mails get the Outlook-safe button too
   (`_shared/email-layout.mjs`): `client-mailer`, `welcome-mailer`, `pkg-client-notify`,
   `billing-reminder`, `wa-proposal` - each with `supabase functions deploy <name> --no-verify-jwt --project-ref <ref>`.
6. Deploy the web app (the new `/auth/confirm` page must be live **before** the new templates are
   pasted, or their links 404).

## 5. Tests

* `test/invite-accept-0205.test.mjs`, `test/auth-confirm.test.mjs` (+ updated invite-flow,
  invite-mailer, email-redesign, auth-signup-confirm, email-compliance, auth-gate).
* Deno harness, fake invites, no network: `tests/edge/invite-signup.test.ts` (peek context,
  needs_link / unconfirmed / existing, resend to the invited address only, own-domain link,
  rate limit 3/h, expired → bell) and `tests/edge/invite-mailer.test.ts` (brand-new, existing
  account, re-invite: identical e-mail; Supabase fallback metadata).
* DB: `tests/db/invite-accept-0205.sql` (40 checks: privileges, states, read-only, single-use token,
  pending invites hold trial seats, bell note once per 24 h, invitation never renewed).
