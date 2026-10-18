# Helm security posture

Date: 2026-10-17. Scope: the code on `origin/main` (vanilla HTML/JS on Vercel, Supabase Postgres with RLS, Supabase Edge Functions). Plain-English summary of what exists today, with file references. No secret values appear here, only the names of env vars and secrets.

Related documents (they have the detail): `security/REPORT.md` (OWASP audit, Oct 2026), `docs/OWNER-ACTIONS-SECURITY.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/CSP-UNSAFE-INLINE-AUDIT.md`, `docs/DATA-PROTECTION-REVIEW.md`, `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`.

---

## 1. At a glance

| Area | Where it is enforced | Status |
|---|---|---|
| Sign-in (password, Google, TOTP two-step) | Supabase Auth + `public/auth-ui.js`, `public/store-api.js`, migrations 0028/0050/0053/0158 | Built. MFA verify hook (0158) is dormant until the owner turns it on |
| Who can see/do what | Postgres RLS (`current_org_id()`, `has_area()`), SECURITY DEFINER RPCs | Built, the main control |
| Tenant isolation (studio = organization) | RLS on every tenant table keyed on `org_id` | No cross-tenant read found in audit run-3 |
| Secrets | Supabase Edge Function secrets and Vercel env; never in the browser | Built; CI secret scanning |
| XSS | Strict CSP (no inline script, hashed styles), Trusted Types, HTML-sink allowlist check in CI | Built |
| CSRF | Bearer-token API (no cookie auth), `form-action 'self'`, `frame-ancestors 'none'` | Built (by design) |
| Uploads | Private buckets, MIME allowlist, quotas, `verify-upload` function | Built; no antivirus by default |
| Rate limits | OTP, invitations, privacy PIN, MFA, work links, WhatsApp sends | Built in SQL |
| Payments / SMS / WhatsApp | Code exists, switched OFF (fail-closed flags) | Off by owner choice |
| Default-password accounts | 11 prod accounts | **Open High, accepted for now by the owner** |

---

## 2. Authentication (who you are)

- **Provider:** Supabase Auth. Email + password, and Google sign-in (OAuth, implicit flow; see `public/login.html`, `public/store-api.js`).
- **Password rules:** at least 12 characters with a letter and a digit (0028 follow-up in `security/REPORT.md`). A Postgres password-verification hook adds a per-account lockout (0053).
- **Two-step (TOTP MFA):** enrolment and step-up in the app (0028, 0050). The app gate requires MFA for enrolled users.
  - 0050 counts wrong codes the browser reports (`mfa_record_failure`).
  - 0158 adds the **server-side** "MFA Verification Attempt" hook `hook_mfa_verification_attempt`: 5 wrong codes in 15 minutes lock all codes for 15 minutes. **It does nothing until the owner enables it** in Dashboard > Authentication > Hooks (staging first).
- **Sessions:** 30-minute idle logout and 12-hour absolute logout; sign-out clears per-user browser state; app pages are `no-store` (`security/REPORT.md`, phases 3-4).
- **CAPTCHA:** Cloudflare Turnstile is wired but off: `public/config.js` ships `captcha: { provider: "turnstile", siteKey: "" }`. Needs a site key in config and the secret in Supabase Auth.
- **Login redirects:** `safeNext()` in `public/store-api.js` only allows same-site paths (open-redirect guard).
- **Client OTP (quote approval / booklet):** codes are generated with a crypto RNG, 5 wrong tries lock, 30-second resend cooldown, 3 resends (`supabase/functions/send-otp/index.ts`, 0026). The OTP is sent to the contact stored on the quote, not a typed number.
- **Free-trial "Skip payment":** turned off on the server for production by `supabase/migrations/0162_launch_bypass_off.sql` (prod only; staging keeps it for testing).
- **Email:** auth and app emails go out from `notifications@helm.events` with Reply-To set to the studio's email (owner fact).

Accepted risk: the Supabase session lives in `localStorage` (Supabase default). Mitigated by the strict CSP, no inline script and the session timeouts.

---

## 3. Authorization (what you may do)

### 3.1 Tenancy
- Every studio is an `organizations` row. Tenant tables carry `org_id`.
- `current_org_id()` returns the caller's studio from their `profiles` row. RLS policies compare `org_id = current_org_id()`.
- Fix history: 0021 closed a **Critical** where a member could make themselves admin or move to another studio (privilege escalation). `tg_mass_assign_guard` (0032) keeps server-owned columns (role, org, plan, `created_by`, and since 0155 `trial_ends_at` / `trial_mode` / `demo_choice`) out of reach of browser writes.

### 3.2 Roles and `has_area`
- Roles: admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, client.
- A configurable per-role matrix (`role_access`, built in phase29, edited in Control Center) says which **area** (quotes, leads, staff, inventory, money, controls, ...) each role can view or edit.
- `has_area(area, level)` reads that matrix and is used inside RLS policies and RPCs, so the database itself decides. The UI hides buttons the server would refuse anyway (for example the planner fixes in commit 9332e808), but hiding is cosmetic; the server is the gate.
- The `client` role is cut out of staff chat, announcements, coupons, pricing config, rate cards and other roles' access rows (0156).
- Re-opening a closed event is admin-only and goes through `reopen_event` with a reason and an audit row (0156).

### 3.3 SECURITY DEFINER RPC rules
Functions that run with owner rights bypass RLS, so each one must check for itself. The house rules (see `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md` and the migrations):

| Rule | Why |
|---|---|
| `set search_path` pinned (public, extensions) | Stops search-path hijacking |
| First lines check `auth.uid()`, `current_org_id()` and the right `has_area` / `is_admin()` | Same checks RLS would make |
| Every id passed in is checked to belong to the caller's studio | Prevents IDOR and cross-studio references |
| `revoke execute ... from public, anon`, then grant only to `authenticated` (or `service_role` for edge-only helpers like `wa_recipient_opted_out`) | Anonymous callers only reach functions meant for public links |
| Never return hashes or secrets (for example the privacy PIN hash in 0157) | Data minimisation |
| Private tables have RLS on with **no policies and no grants**; only definer functions touch them (`privacy_pin`, `privacy_pin_attempts`, `auth_mfa_verify_attempts`) | Unreachable from PostgREST |
| Migrations are forward-only, additive and idempotent; no DROP / DELETE / TRUNCATE of data | Zero-data-loss policy (`docs/FILL-ONLY-MIGRATIONS.md`, `scripts/check-migration-canon.mjs`) |

`supabase/audit/GRANT-PARITY.sql` compares grants between staging and production.

### 3.4 Public token links
Client approval, proposal, portal, booklet, invitation and crew "work" links (`vercel.json` rewrites such as `/<studio>/quote/<token>`) use unguessable tokens, check the studio slug in the URL (anti-phishing, 0020), expire 7 days after the event (0022/0023), stop working while the event is on the Archive/Deleted shelf (0156), and are served with `no-referrer` and `no-store`.

---

## 4. Secrets handling

- **Browser:** only the Supabase URL and the anon (public) key, in `public/config.js`. The bundle carries both prod and staging config; production hosts can never select staging (`tests/staging/env-routing.test.mjs`, `test/html5-config-hardening.test.mjs`).
- **Edge Functions** read secrets from Supabase secrets (names only): `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_PHONE_ID`, `OPENAI_API_KEY`, `HELM_AV_TOKEN`, and the per-function shared secrets `HELM_COMMS_SECRET`, `HELM_INVITE_EMAIL_SECRET`, `HELM_WELCOME_EMAIL_SECRET`, `HELM_PKG_NOTIFY_SECRET`, `HELM_SECURITY_ALERT_SECRET`, `HELM_UPLOAD_SCAN_SECRET`, `HELM_BILLING_CRON_SECRET`. Feature flags (`HELM_*_ENABLED`) default off.
- **Webhooks** verify signatures: Razorpay HMAC (`razorpay-webhook`, with `RAZORPAY_EVENT_MAX_AGE_SEC` replay window) and Meta `X-Hub-Signature` (`wa-webhook`).
- **CORS:** exact origin list in `supabase/functions/_shared/cors.ts` (plus optional `EXTRA_ALLOWED_ORIGINS`).
- **CI checks:** `.github/workflows/secret-scan-history.yml` (gitleaks over history), `scripts/check-jwt-roles.mjs` (no service-role JWT in code), `scripts/check-env-safety.mjs`, `scripts/check-otp-safety.mjs`, `scripts/check-actions-pinned.mjs`.
- Local test credentials live only in `~/.helm-e2e.env` (gitignored).

---

## 5. Input validation and business-rule guards

- **Browser:** shared validators and a global number hardener (Wave 16); CSV formula-injection guard on exports.
- **Database (the real gate):** CHECK constraints and triggers reject NaN/Infinity/negative money, field-length overflow, duplicate payment rows, cross-studio references and direct writes to server-owned rows (0024-0027, 0152, 0155, 0156).
- **Mass assignment:** direct writes to payments, consent, quote status, invitations, chat membership, crew links, proposal publish, settle and check-out are blocked; these go through RPCs (0025, "write-path lockdown").
- **Pricing authority:** the server recomputes quote prices (phase99 "D8").
- **Refunds:** maker-checker (0026). Decision needed: admins are currently exempt.

---

## 6. XSS and Content Security Policy

- `vercel.json` sets a per-page CSP: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`; `script-src 'self'` plus pinned paths (Sentry CDN at a fixed version; 3D/CDN libraries only on the builder page) and SHA-256 hashes; **no `unsafe-inline` for scripts**. Styles allow hashed blocks and Google Fonts. Images/media only from self, data/blob and the prod Supabase project.
- **Trusted Types:** `require-trusted-types-for 'script'` with the `helm` default policy in `public/trusted-types.js`.
- **No inline handlers:** inline styles were extracted (`scripts/extract-inline-styles.mjs`); hashes are regenerated by `scripts/gen-csp.mjs` / `scripts/csp-hashes.cjs` on each release.
- **HTML-sink allowlist:** `scripts/check-html-sinks.mjs` fails CI when a new `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` appears that is not in `scripts/html-sinks-allowlist.json`. Each allowlisted sink escapes data first.
- `postMessage` handlers check the origin (invite preview); media URLs must be `https`.
- Other headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy` (`vercel.json`, mirrored in `server.js` for local runs; parity pinned by `test/headers-parity.test.mjs`).

---

## 7. CSRF

The API is Supabase PostgREST/Edge Functions with a **Bearer token in the `Authorization` header**, not a cookie, so a forged cross-site form cannot carry the session. Added defences: `form-action 'self'`, `frame-ancestors 'none'` (no clickjacking), exact CORS list on Edge Functions, and webhooks that require signatures. Audit run-3 noted a login-CSRF / session-fixation lead on invite links (`client/login/invite-fragment-session-fixation`, Low).

---

## 8. File uploads

- Supabase Storage buckets are private (invitation media private since 0019; photos only visible on published invitations). Uploads need an editor role (0027).
- Bucket MIME allowlist + browser magic-byte check; per-studio quotas (0027, 0049 `storage_quota_ok`).
- Booklet pictures: 1.5 MB each, plus a per-studio byte budget (trial 50 MB/day, 150 MB total; paid 1 GB/day, 20 GB total) and 60/hour for "use AI photo" (0155).
- `verify-upload` Edge Function can quarantine and scan files through an external antivirus (`HELM_UPLOAD_SCAN_ENABLED`, `HELM_AV_URL`, `HELM_UPLOAD_QUARANTINE`). Assumption: scanning is not switched on in production (flag default off).
- AI photo renders (`render-photo`) are owner-triggered only.

---

## 9. Rate limits and lockouts

| What | Limit | Where |
|---|---|---|
| Client OTP (approval, booklet) | 5 wrong tries lock; 30 s cooldown; 3 resends | 0026, `send-otp` |
| MFA codes | 5 wrong in 15 min, lock 15 min | 0050 (browser-reported), 0158 (server hook, needs enabling) |
| Password sign-in | per-account lockout hook | 0053 |
| Privacy PIN ("Hide amounts") | 5 wrong, lock 30 s, doubling to max 15 min, per person, server-side bcrypt hash | 0157 |
| Invitations | admin only; trial 20/day and 50 open; paid 200/day and 500 open | 0155, 0156 |
| Admin-created accounts | paid studios only, max 100/day, audited; trial studios must invite | 0155 |
| WhatsApp sends | max 200 different numbers a day per studio; STOP opt-outs honoured on every path | 0155 |
| Crew work links | per-IP limiter | 0154 |
| Supabase Auth | Supabase built-in limits (dashboard) | `docs/AUTH-DASHBOARD-SETTINGS.md` |

Decision needed: the privacy PIN default stays `0000` until a studio admin sets one (0157). Owner may want to force a PIN on first use.

---

## 10. Sensitive data

- **What is held:** client names, phones, emails, event addresses, quote amounts and payments, staff contact details, consent records (OTP approvals with a snapshot of what was shown).
- **Controls:** RLS per studio and per area; finance views gated by `has_area('money')`; "Hide amounts" PIN for screens in public; telemetry redacts tokens; audit log stores user ids, not emails or IPs, for lock events (0158).
- **India DPDP:** see `docs/DATA-PROTECTION-REVIEW.md` and `docs/INDIA-AUDIT-2026-10.md`.
- Decision needed: retention/erasure periods for closed events and archived leads.

---

## 11. Dependencies and supply chain

- No build step and no npm runtime dependencies in the browser bundle; third-party browser scripts are loaded from pinned CDN paths (Sentry fixed version; builder 3D libs).
- `sbom.json` at the repo root; `deno.lock` for Edge Functions; CodeQL (`.github/workflows/codeql.yml`).
- Known gaps from run-3 (Low): Sentry loader without SRI; some GitHub Actions pinned by tag rather than SHA (`scripts/check-actions-pinned.mjs` is the guard); Lighthouse CI fetched via unpinned `npx`.

---

## 12. Logging and monitoring

- `audit_log` table with triggers on sensitive changes (0026), role changes, reopen, refunds, account moves (0155).
- `security-alert-mailer` Edge Function emails security events to HQ (`HELM_SECURITY_ALERTS_ENABLED`, `HELM_SECURITY_ALERT_HQ_TO`).
- Sentry browser telemetry with token redaction; activation steps in `docs/OBSERVABILITY-ACTIVATION.md`.
- Incident steps: `docs/INCIDENT-RESPONSE-RUNBOOK.md`; recovery: `docs/DISASTER-RECOVERY-RUNBOOK.md`.
- `public/.well-known/security.txt` advertises `security@helm.events`.

---

## 13. Audit history

| Audit | Date | Result |
|---|---|---|
| Blueprint stage review | 2026-09-19 | Strong. Missing security headers found and fixed |
| OWASP checklist (131 items, phases 1-10) | Oct 2026 | Critical privilege escalation fixed (0021); 0019-0028 fixes; verdict "Ready with fixes" (`security/REPORT.md`) |
| Cloudflare-style deep audit, runs 1-2 | Oct 2026 | Medium/Low findings fixed (commit 5d8e8ca, 0042/0043) |
| **Security audit run-3** (source + local only, no prod probes) | Oct 2026 | **0 Critical, 1 High, 7 Medium**, 29 Low, 9 Info, 5 need validation. No cross-tenant read through RLS |

Run-3 outcome:
- **High: default seed passwords on 11 production accounts** (stated in docs and git history). Owner has **accepted and kept** these accounts for now. Still the top owner action.
- **Mediums fixed** in forward-only migrations:
  - 0155: trial end-date self-extension; pre-confirmed account squatting; booklet image storage budget; WhatsApp STOP enforcement; WhatsApp relay cap.
  - 0156: the database Low findings (stale invite role overwrite, operator email oracle, client-role reads, shelf kill-switch, reopen bypass, refund/vendor-bill update guards, lead history tamper, Razorpay link-id spoofing).
  - 0157: privacy PIN moved to the server.
  - 0158: server-side MFA lockout hook.
  - Regression tests: `test/audit-medium-0155.test.mjs`, `test/audit-p2-0156.test.mjs`, `test/audit-run3-edge-client.test.mjs`. Combined apply script generated by `scripts/gen-apply-0155-0158.mjs`.
  - Shared staging password (Medium): fix is rotation by the owner.
  - Assumption: the aal1 profile-rewrite and paid-quote re-approval Mediums are covered by the 0155-0158 set or later work; verify against `~/security-audit-skill/Helm/run-3/REMEDIATION_PLAN.md`.
- **Planner role review F1-F6** (commit 9332e808, Oct 2026): code fixes shipped (nav crash, blank issues route, buttons hidden for view-only roles). Decision needed: the remaining items are owner decisions about what the planner role may view and edit in the role matrix. The F1-F6 list was not found in this repo; record the decisions in Control Center and this doc.

Open product decisions carried from the OWASP report (Decision needed): closing an event with a balance outstanding; resetting approval after a price change; overbooking guard; `helm_total_paid` ledger double-count (H04); admin exemption from refund maker-checker.

---

## 14. Remaining risks

| Risk | Severity | Mitigation today |
|---|---|---|
| 11 prod accounts on published default passwords | High | None in code; owner accepted for now |
| Public GitHub repos expose schema, audit and red-team docs | Medium | Nothing is secret in the repo, but it helps attackers |
| Shared staging password in git history | Medium | Rotate |
| MFA server lockout off until hook is enabled | Medium | Browser lockout + Supabase rate limit |
| No CAPTCHA on sign-in/sign-up | Low-Medium | Lockouts and Supabase rate limits |
| `mfa_ok()` not enforced in RLS | Low | MFA enforced at the app gate |
| Google OAuth implicit flow (not PKCE) | Low | Strict redirect allowlist |
| No antivirus on uploads unless scan is enabled | Low | Private buckets, MIME allowlist, quotas |
| Session in localStorage | Low | CSP, Trusted Types, timeouts |
| Staging open sign-up and deployed Edge Functions | Low | Turn sign-up off |
| Extra prod alias `helm-alpha-nine.vercel.app` | Low | Same headers; remove alias |

Razorpay, SMS and WhatsApp are switched off, so their risk is dormant. WhatsApp is being set up by the owner separately. Before switching any on, re-check `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`.

---

## 15. Owner actions (checklist)

Full steps in `docs/OWNER-ACTIONS-SECURITY.md`.

1. [ ] **Reset the default passwords**: run `supabase/audit/P3-CHECK-default-passwords.sql` on prod, then `P3-FIX-rotate-default-passwords.sql` (or delete and recreate on @helm.events), and re-check for 0 rows. Rotate the staging shared password and any CI secret that reuses it.
2. [ ] **Make both GitHub repos private** (`koushik1133/Helm`, `praneethreddykiwik/Helm`), then confirm Vercel still deploys.
3. [ ] **Turnstile**: create a Cloudflare Turnstile site; put the site key in `public/config.js` (code PR) and the secret in Supabase Auth > Bot protection, on both projects.
4. [ ] **Enable the MFA Verification Attempt hook** (`public.hook_mfa_verification_attempt`), staging first, then prod. Check the plan offers it.
5. [ ] Supabase Auth settings on both projects: password rules, leaked-password protection, TOTP on, session limits, `/reset-password` redirect allowlist (`docs/AUTH-DASHBOARD-SETTINGS.md`).
6. [ ] Staging: sign-ups off; Vercel preview protection on.
7. [ ] Mail: MX, SPF, DKIM, DMARC for helm.events; create `security@helm.events`; enable GitHub private vulnerability reporting.
8. [ ] Vercel: remove or redirect `helm-alpha-nine.vercel.app`; HSTS preload for the apex.
9. [ ] Make sure 0155-0158 (and 0162 on prod only) are applied on each database. Decision needed: confirm current state with the SQL staging-vs-prod tracker.
