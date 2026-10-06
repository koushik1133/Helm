# Supabase Auth dashboard settings (owner checklist)

Apply on **both** projects — production `nqltzgiwznphugcfhmbm` and staging `xizehqgeyjcfpzrdymly`
(Supabase Dashboard → select project). Do staging first, test sign-in, then production.
The app code (0028 + login/reset pages) already enforces the same rules; these settings make
Supabase enforce them server-side too. Menu names follow the 2026 dashboard; if a label moved,
search the Auth settings page for the setting name in **bold**.

## 1. Passwords — Authentication → Providers → Email (or Authentication → Policies / Passwords)
1. **Minimum password length**: `12`.
2. **Password requirements**: "Letters and digits" (at minimum; "lowercase, uppercase, digits" is also fine — the app requires a letter + a number).
3. **Prevent use of leaked passwords** (HaveIBeenPwned): ON. (Pro plan feature.)
4. **Secure password change**: ON (password change needs a recent sign-in).
5. **Secure email change**: ON (both old and new address must confirm).
6. Save.

## 2. Two-step verification — Authentication → Multi-Factor (MFA)
1. **TOTP (App Authenticator)**: Enabled (enroll + verify).
2. Max enrolled factors: 10 (default) is fine. Phone MFA: leave off.
3. Optional later: set `auth.mfaRequiredForAdmins: true` in `public/config.js` to force admins to enrol.

## 3. Sessions — Authentication → Sessions (and Project Settings → JWT)
1. **JWT expiry**: `3600` seconds.
2. **Detect and revoke compromised refresh tokens** (refresh-token rotation): ON; **Refresh token reuse interval**: `10` seconds.
3. **Time-box user sessions**: `7 days` (168 h).
4. **Inactivity timeout**: `24 hours`.
   (The app additionally signs staff out after 30 min idle and 12 h total — `auth.session` in config.js.)
5. Single session per user: leave OFF.

## 4. Bot protection — Authentication → Attack Protection (Bot and Abuse Protection)
1. In Cloudflare dashboard → Turnstile → Add site: domains `www.helm.events`, `helm.events`, `helm-v01.vercel.app` (+ staging host, `localhost` for testing). Mode: Managed. Copy the **site key** and **secret key**.
2. Supabase → **Enable CAPTCHA protection**: ON, provider **Cloudflare Turnstile**, paste the **secret key**, Save. (Do this on a project only when step 3 ships the site key, or sign-in will fail.)
3. Put the **site key** (public) in `public/config.js` → `captcha: { provider: "turnstile", siteKey: "<site key>" }` and deploy. Empty siteKey = feature off.
   Order: deploy siteKey first is harmless (Supabase ignores tokens while CAPTCHA is off); then enable in Supabase.

## 5. Rate limits — Authentication → Rate Limits
- Emails sent: `30`/hour (needs custom SMTP; default SMTP is 2/h).
- Token refreshes: `150` per 5 min per IP (default).
- Sign-ups/sign-ins: `30` per 5 min per IP. Token verifications (OTP/MFA): `30` per 5 min per IP.

## 6. URL configuration — Authentication → URL Configuration
- **Site URL**: `https://www.helm.events` (staging: the staging host).
- **Redirect URLs** (add all):
  - `https://www.helm.events/reset-password`, `https://www.helm.events/login.html**`, `https://helm.events/reset-password`
  - `https://helm-v01.vercel.app/reset-password`, `https://helm-v01.vercel.app/login.html**`
  - staging: `https://<staging-host>/reset-password`, `https://<staging-host>/login.html**`
  - local: `http://localhost:4173/reset-password`, `http://localhost:4173/login.html**`

## 7. Email templates — Authentication → Emails / Templates
1. **Reset password** template: keep `{{ .ConfirmationURL }}`; wording "Reset your Helm password — this link works once and expires in 1 hour."
2. **Password changed** notification (Security notifications → "Password changed"): ON. Text: "Your Helm password was just changed. If this wasn't you, reset it now and contact your studio admin."
3. Also enable **Email changed** and **MFA factor enrolled/removed** notifications if offered.
4. Recovery/OTP expiry: `3600` s.

## 8. Recommendation (not applied): PKCE for Google sign-in
The app still uses the implicit OAuth flow (tokens in the URL fragment). Switching to
`flowType: 'pkce'` in `store-api.js` createClient is recommended, but must be tested on
staging with Google + the reset-password link first (both change how the return URL is handled).
Google sign-in no longer requests offline access (no Google refresh token).

## 9. Optional server-side MFA backstop
`public.mfa_ok()` (0028) returns false for an aal1 token of a user with a verified factor.
It is not in any policy yet; add it as RESTRICTIVE policies table-by-table after staging tests.
