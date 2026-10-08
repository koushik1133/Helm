# Supabase Auth dashboard settings (owner checklist)

Apply on **both** projects — production `nqltzgiwznphugcfhmbm` and staging `xizehqgeyjcfpzrdymly`
(Supabase Dashboard → select project). Do staging first, test sign-in, then production.
The app code (0028/0030 + login/reset pages) already enforces the same rules; these settings make
Supabase enforce them server-side too. Menu names follow the 2026 dashboard; if a label moved,
search the Auth settings page for the setting name in **bold**.

## 1. Passwords — Authentication → Providers → Email (or Authentication → Policies / Passwords)
1. **Minimum password length**: `12`.
2. **Password requirements**: "Lowercase, uppercase letters, digits and symbols" (set 2026-10). The app now requires exactly the same thing everywhere a password is set — sign-up, reset, change-password, temp-password screen (live checklist) and admin-created users (`public._password_ok`, migration `0030_password_rule_symbols.sql`). Symbols = Supabase's set `!@#$%^&*()_+-=[]{};'\:"|<>?,./`~` (a space or accented letter does not count).
3. **Prevent use of leaked passwords** (HaveIBeenPwned): ON. (Pro plan feature.)
4. **Secure password change**: ON (password change needs a recent sign-in).
5. **Secure email change**: ON (both old and new address must confirm).
6. Save.

## 2. Two-step verification — Authentication → Multi-Factor (MFA)
1. **TOTP (App Authenticator)**: Enabled (enroll + verify).
2. Max enrolled factors: 10 (default) is fine. Phone MFA: leave off.
3. Optional later: set `auth.mfaRequiredForAdmins: true` in `public/config.js` to force admins to enrol.

## 3. Sessions — Authentication → Sessions (and Project Settings → JWT)
Recommendation (owner decision 2026-10: keep clients signed in like Google / consumer apps):
1. **JWT expiry**: `3600` seconds (access token refreshes silently every hour).
2. **Detect and revoke compromised refresh tokens** (refresh-token rotation): **ON**; **Refresh token reuse interval**: `10` seconds.
3. **Time-box user sessions**: `0` (never) — or `30 days` if you want a monthly re-login.
4. **Inactivity timeout**: `14 days` (someone who hasn't opened Helm for two weeks signs in again).
5. Single session per user: leave OFF.
6. MFA → **Limit duration of AAL1 sessions**: ON is fine (only affects sessions that haven't completed two-step on an account that has it).

App-side timers: `public/config.js` → `auth.session` now defaults to `{ idleMinutes: 0, warnSeconds: 60, maxHours: 0 }` —
**0 = off**, so the app no longer signs people out after 30 min idle / 12 h. The feature is still there: set e.g.
`idleMinutes: 30, maxHours: 12` (and redeploy) for a stricter studio. Signing out (or another account signing in)
in one tab still signs out every open tab.

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
Paste these as-is (Source / HTML view). Plain tables + inline styles only, so they render the same in
Gmail, Outlook (desktop + web), Apple Mail and phone clients. Recovery/OTP expiry: `3600` s.
Also enable **Email changed** and **MFA factor enrolled/removed** security notifications if offered.

### 7a. Reset password (Templates → "Reset password")
**Subject:** `Reset your Helm password`

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2ee;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e8e3db;border-radius:12px;">
      <tr><td style="padding:28px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:20px;font-weight:bold;color:#6d28d9;letter-spacing:.5px;">Helm</div>
      </td></tr>
      <tr><td style="padding:8px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;color:#1b1930;">
        <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:#1b1930;">Reset your password</h1>
        <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#4b475f;">
          We got a request to reset the password for your Helm account <strong>{{ .Email }}</strong>.
          Click the button below to choose a new one.
        </p>
      </td></tr>
      <tr><td align="left" style="padding:8px 32px 8px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="#6d28d9" style="border-radius:8px;">
            <a href="{{ .ConfirmationURL }}" target="_blank"
               style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">Reset my password</a>
          </td></tr></table>
      </td></tr>
      <tr><td style="padding:12px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;">
        <p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:#6b6577;">
          This link works <strong>once</strong> and expires in <strong>1 hour</strong>. Your new password needs at least
          12 characters with a lowercase letter, an uppercase letter, a number and a symbol.
        </p>
        <p style="margin:0 0 12px 0;font-size:13px;line-height:1.6;color:#6b6577;">
          Button not working? Copy this link into your browser:<br>
          <a href="{{ .ConfirmationURL }}" style="color:#6d28d9;word-break:break-all;">{{ .ConfirmationURL }}</a>
        </p>
        <p style="margin:0 0 24px 0;font-size:13px;line-height:1.6;color:#6b6577;">
          Didn't ask for this? You can ignore this email — your password stays the same.
        </p>
      </td></tr>
      <tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #eeeae4;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9a95a8;">
        Helm · event planning for studios. This is an automatic security email; replies aren't read.
      </td></tr>
    </table>
  </td></tr>
</table>
```

### 7b. Password changed (Security notifications → "Password changed": ON)
**Subject:** `Your Helm password was changed`

No link variable is needed; the only link is the optional `{{ .SiteURL }}/reset-password`.

```html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f2ee;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e8e3db;border-radius:12px;">
      <tr><td style="padding:28px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;">
        <div style="font-size:20px;font-weight:bold;color:#6d28d9;letter-spacing:.5px;">Helm</div>
      </td></tr>
      <tr><td style="padding:8px 32px 0 32px;font-family:Arial,Helvetica,sans-serif;color:#1b1930;">
        <h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:#1b1930;">Your password was changed</h1>
        <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#4b475f;">
          The password for your Helm account <strong>{{ .Email }}</strong> was just changed.
          For your security, other devices were signed out.
        </p>
        <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#4b475f;"><strong>Was this you?</strong> Then there's nothing to do.</p>
        <p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#4b475f;"><strong>Wasn't you?</strong> Act now:</p>
        <ol style="margin:0 0 16px 20px;padding:0;font-size:15px;line-height:1.6;color:#4b475f;">
          <li>Reset your password straight away using "Forgot password?" on the sign-in page, or
            <a href="{{ .SiteURL }}/reset-password" style="color:#6d28d9;">{{ .SiteURL }}/reset-password</a>.</li>
          <li>Tell your studio admin, so they can check your account and turn on two-step verification.</li>
          <li>If you used the same password anywhere else, change it there too.</li>
        </ol>
      </td></tr>
      <tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #eeeae4;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#9a95a8;">
        Helm · event planning for studios. This is an automatic security email; replies aren't read.
      </td></tr>
    </table>
  </td></tr>
</table>
```

## 8. PKCE auth flow (applied in code, 2026-10)
`store-api.js` creates the client with `flowType: 'pkce'` + `detectSessionInUrl: true`. Every auth link
(Google return, password reset, sign-up confirmation, magic link) now comes back as `?code=…`, which
supabase-js exchanges for a session using the code verifier saved in the **same browser** that started
the flow. Tokens are never put in or read from the URL fragment (a legacy `#access_token` is stripped).

Owner dashboard steps (both projects, staging first):
1. **Email templates: no change needed.** Keep `{{ .ConfirmationURL }}` exactly as in 7a (and in the
   Confirm signup / Magic link / Invite templates). In PKCE mode Supabase builds that URL so it redirects
   to `redirect_to?code=…`. Do NOT switch templates to `{{ .TokenHash }}` links — the app has no
   `verifyOtp` landing page for them.
2. **Redirect URLs (section 6) must include** `/reset-password` and `/login.html**` for every host —
   reset links return to `/reset-password?code=…`, confirm/Google links to `/login.html?…&code=…`.
   A redirect that is not allowed falls back to the Site URL; the app still routes a recovery session
   to `/reset-password`, but add the URLs so this never happens.
3. Test on staging: Google sign-in, Forgot password → link → new password, new sign-up → confirm link,
   invite link → sign-up → confirm → joined the studio.
4. Behaviour change users may notice: a reset / confirm link opened in a **different browser or device**
   cannot sign in. The reset page says "Open the link in the same browser you requested it from";
   for sign-up confirmation the email is still confirmed, so the person just signs in.

### Account enumeration
Sign-in errors are always "Invalid email or password." (including unconfirmed accounts); sign-up and
password reset always answer "If this email can be used, we've sent a link." Keep **Confirm email ON**
(Providers → Email) — with it off, Supabase returns "User already registered" (the app hides it, but
an existing account would then never get a session, so turning it off breaks nothing yet leaks timing).
Google sign-in no longer requests offline access (no Google refresh token).

## 9. Optional server-side MFA backstop
`public.mfa_ok()` (0028) returns false for an aal1 token of a user with a verified factor.
It is not in any policy yet; add it as RESTRICTIVE policies table-by-table after staging tests.

## 10. Per-account password lockout — Authentication → Hooks (migration 0053, Pro plan)
Locks an account after repeated wrong passwords, enforced by Supabase Auth itself (not the browser):
5 wrong passwords within 15 minutes → locked 15 minutes; a second lock within 24 h → 1 hour. While
locked, even the right password is refused with *"Too many attempts. Try again in 15 minutes (or 1 hour)
or reset your password."* A successful sign-in clears the counter; a password reset/change clears a lock.
Lock / unlock events are written to `audit_log` (`auth.password.locked` / `auth.password.unlocked`, user id only).
**Until step 3 below is done, nothing changes for anyone.**

1. Staging first: SQL Editor → paste `supabase/APPLY-0053.sql` → Run. Every VERIFY row must say `ok = true`
   (`locked_now` = 0). Safe to re-run.
2. Authentication → **Hooks** → **Add hook** → **Password Verification Attempt**.
3. Hook type: **Postgres**. Schema: **public**. Function: **hook_password_verification_attempt**. Enable → **Create / Save**.
   (The dashboard grants `supabase_auth_admin` execute; the migration already did, and revoked it from anon/authenticated/service_role.)
4. Test on staging: wrong password 5× on a test account → 5th shows the "Too many attempts…" message; the right
   password is then refused too; "Forgot password" → reset link → new password → sign-in works.
5. Repeat steps 1–3 on production.

To unlock someone by hand (owner, SQL editor): `delete from public.auth_password_attempts where user_id = '<uuid>';`
(or have them reset their password). To turn the feature off: disable the hook in step 3 (nothing else needed).
Note: the hook only runs for accounts that exist, so the lock message itself can reveal that an email is
registered after 5 attempts; Supabase's IP rate limits and CAPTCHA (§4, §5) remain the first line against enumeration.
