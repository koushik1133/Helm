# AUTH-PRODUCTION-HARDENING.md (Agent D)

Recommended Supabase Auth production settings for Helm. **Every item below is a
RECOMMENDATION — a Supabase/Vercel/GitHub dashboard change, NOT applied by this
read-only doc program.** Apply in the production project (`nqltzgiwznphugcfhmbm`),
then re-verify. Evidence legend: **SOURCE** (seen in repo) · **STAGING VERIFIED** ·
**RECOMMENDATION** (dashboard change, not applied) · **BLOCKED**.

## 0. Authorization baseline (context — already enforced)
- **SOURCE / STAGING VERIFIED:** All mutating app logic routes through **SECURITY
  DEFINER** RPCs with internal `has_area` / `can_edit` checks; `anon` has no EXECUTE
  grant on mutating RPCs (migrations 0005/0007/0011; `STAGING-REDTEAM-MATRIX.md`
  A1–A3). Authz matrix staging-verified (99 allow/deny cells, 0 failures).
- Implication: Supabase Auth governs **authentication + session issuance only**;
  resource authorization does not depend on these dashboard settings. Hardening Auth
  reduces account-takeover / enumeration / abuse risk, not RLS bypass risk.

## 1. Password policy — RECOMMENDATION
- **Minimum length:** 12 characters (Supabase default is 6 — raise it).
- **Required character classes:** enable "Lowercase, uppercase, digits, symbols"
  (strongest available tier).
- **Leaked-password protection (HaveIBeenPwned):** **ENABLE.**
  - **BLOCKER FINDING:** the staging Security Advisor reports
    `auth_leaked_password_protection` is **currently DISABLED**. Turn it ON in
    Dashboard → Authentication → Policies (checks new/changed passwords against HIBP's
    k-anonymity API; rejects known-breached passwords). Low risk, no app change.

## 2. Session / refresh token expiry — RECOMMENDATION
- **Access (JWT) expiry:** 3600 s (1 h) — keep short so revoked/role-changed users
  re-derive claims quickly.
- **Refresh token rotation:** ENABLE "Detect & revoke on reuse" (rotation + reuse
  detection). Already on by default on recent projects — confirm.
- **Refresh token / inactivity timeout:** set a bounded "time-box" (e.g. 30 days
  absolute) plus inactivity expiry so abandoned sessions die.
- For privileged roles, prefer shorter effective sessions (see §8 MFA / step-up).

## 3. Email verification & signup policy — RECOMMENDATION
- **Confirm email:** REQUIRE email confirmation before first sign-in.
- **Signup policy:** Helm is multi-tenant/invite-driven — **DISABLE open public
  signups**; provision users via the admin RPC (`admin_create_user`, is_admin-gated).
  If any self-serve flow is kept, scope it and require confirmation.
- **Secure email change:** require confirmation on BOTH old and new address.

## 4. Account-enumeration posture — RECOMMENDATION
- Keep "Prevent user-existence leakage" behavior: generic responses on signup / reset
  / sign-in so an attacker cannot distinguish "no such account" from "wrong password".
- Ensure OTP / reset responses are uniform (the OTP path already returns a generic
  shape — **SOURCE** `send-otp/index.ts`).

## 5. Auth rate limits — RECOMMENDATION
- Set per-IP / per-identity limits in Dashboard → Authentication → Rate Limits for:
  sign-in, OTP/token send, password reset, verify. Keep conservative (e.g. a handful
  of OTP sends per hour per phone). Note DB-side `admin_store_otp` already rate-limits
  OTP issuance (**SOURCE** `send-otp/index.ts` comment) — the dashboard limit is a
  second, edge-level layer.

## 6. Custom SMTP readiness — RECOMMENDATION
- The built-in Supabase SMTP is rate-capped and not for production volume. Provision
  custom SMTP (e.g. Resend/SES — Resend already used by `razorpay-webhook`, **SOURCE**)
  with SPF/DKIM/DMARC on the sending domain before relying on auth emails.

## 7. CAPTCHA / bot control — RECOMMENDATION
- Enable Auth CAPTCHA (hCaptcha/Turnstile) on signup, sign-in, and OTP-send to blunt
  credential-stuffing and OTP-pumping. Pair with §5 rate limits.

## 8. MFA — RECOMMENDATIONS
**Privileged HELM app roles (admin / owner):**
- Enable Supabase MFA (TOTP) and **require** it for admin/owner before they can reach
  privileged RPCs/pages. Treat MFA as a step-up for money/user-management actions
  (`record_payment`, `mark_paid`, `admin_create_user`).

**Platform admin accounts (separate from the app):**
- **Supabase org:** require MFA for every org member; restrict who holds Owner/Admin;
  review members quarterly.
- **Vercel:** require MFA for the team; limit Owner seats; scope deploy tokens.
- **GitHub org (`koushik1133/Helm`):** require org-wide 2FA, protect `main` (reviews +
  status checks), and restrict who can change Actions secrets.

## Summary of BLOCKED / gating items
- **auth_leaked_password_protection = DISABLED** on staging Security Advisor →
  must ENABLE in prod (release gate). All other items are RECOMMENDATION pending the
  dashboard change.
