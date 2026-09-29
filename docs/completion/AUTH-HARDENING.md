# Auth hardening plan (signup/signin improvements)

Current: Supabase email/password + admin-created users with one-time temp passwords + optional Google OAuth (code present, not configured). Solid baseline. The five improvements below make it enterprise-grade. Most are Supabase dashboard settings, not app code.

| # | Improvement | Where | Effort | Notes |
|---|---|---|---|---|
| 1 | **Password policy** (min length 12, complexity, breached-password check) | Supabase → Auth → Policies | XS | Current min is 6 (weak). Supabase supports min length + HaveIBeenPwned check. Raise to ≥12. |
| 2 | **Email verification on self-signup** | Supabase → Auth → Email; `create_studio` flow | S | Require confirmed email before first login for self-serve studios. Admin-created users can stay auto-confirmed. |
| 3 | **MFA (TOTP) for admin/manager** | Supabase MFA + app enrollment UI | M | Enroll TOTP; enforce for privileged roles at sign-in. Supabase has native MFA (AAL2). |
| 4 | **Rate-limit auth** (per-identity then per-IP) | Supabase Auth rate limits + edge | S | Throttle sign-in, password-reset, OTP. Supabase has built-in auth rate limits; tune them. Prevents credential-stuffing/brute-force. |
| 5 | **Finish Google OAuth** | Supabase → Auth → Providers + Google Cloud console | S | Code exists (`signInWithGoogle`); needs client ID/secret + redirect URIs configured. |

## Recommended sequence
1. (#1) Raise password policy now — immediate, zero code. *(Note: staging synthetic users currently use a short password; bump them when you raise the policy.)*
2. (#4) Turn on/tune auth rate limits — immediate, zero code.
3. (#2) Email verification for self-signup.
4. (#5) Google OAuth config.
5. (#3) MFA for admin/manager — highest value for privileged accounts, most UI work.

## Related (from the security audit)
- After **SEC-01**, rotate the `admin@helm.com` production password (it was a weak shared value and `helm-v01` is prod-connected).
- Consider disabling public access to `create_studio` self-signup until email verification (#2) is on, if you don't want open studio registration yet.

These are **not launch blockers** individually, but #1 and #4 are cheap wins that should ship with the SEC-01 fix.
