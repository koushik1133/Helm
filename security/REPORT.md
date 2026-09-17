# Security Report
Target: Blueprint Stage (2d view-restored) — vanilla-JS + Supabase event platform
Date: 2026-09-17   Scope: static review of the local repo (authorized — user owns it). No active traffic sent.

## Executive summary
Overall posture is good: SQL access goes through Supabase RLS + SECURITY DEFINER RPCs, user input is consistently HTML-escaped, no secrets are committed, and the OTP/payment flows are hashed, expiring, rate-limited and signature-verified. The one real issue was **broken access control** — every signed-in user could read every table, including finances — now fixed by role-scoped RLS (phase21) plus per-page UI gates. Fix to apply today: **run `supabase/phase21-hardening.sql`** so the database enforces it.

## Findings

### SEC-001 Broken access control — all authenticated users could read all data (incl. finances)
Severity: High (authenticated cross-role data access)
Location: every `phaseN` table used `create policy ... for select ... using (true)` (e.g. supabase/phase19-settlement.sql, quotes.sql:74).
Impact: a `crew` or `client` account (or `operations`) could read budgets, P&L, settlements, payments, leads, client contacts, worker tokens and notifications via the REST API, regardless of the UI.
Fix: `supabase/phase21-hardening.sql` — new `can_view_finance()` / `can_view_ops()` helpers; read policies re-scoped (finance + client pipeline → admin/planner/sales; ops/resources → +operations; crew/client → none). Plus app-side `auth.canView()` / `auth.requireView()` gates on every page, role-scoped dashboard nav, and finance/pipeline cards + Total hidden in the workspace. Token/worker/approval flows unaffected (SECURITY DEFINER RPCs bypass RLS).
Verification: after running the SQL, sign in per role and confirm REST reads of finance tables return `[]` for operations/crew/client; app shows a "No access" panel. (UI gates already verified live: operations is blocked from budget.html and loses the money cards.)
Status: Fixed (pending the SQL being run on the live project).

### SEC-002 Webhook HMAC compared in non-constant time
Severity: Low
Location: supabase/functions/razorpay-webhook/index.ts:34
Impact: theoretical timing side-channel on the signature check.
Fix: added `timingSafeEqual()` and use it for the HMAC comparison. Still fails closed on missing secret/signature.
Status: Fixed.

### SEC-003 OTP rate limit is per approval-token, not per phone/IP
Severity: Low
Location: supabase/otp-payments.sql (admin_store_otp) — 5 OTPs / 10 min per quote.
Impact: a holder of a valid (non-guessable) approval token could trigger up to 5 SMS / 10 min to an arbitrary number. Bounded and token-gated.
Status: Accepted risk — revisit at go-live (add per-phone + per-IP buckets when live SMS is enabled).

### SEC-004 Edge Function CORS is `Access-Control-Allow-Origin: *`
Severity: Info
Location: supabase/functions/_shared/cors.ts
Impact: any origin can call the public approval endpoints. No cookies/credentials are used (token-in-header + rate limits), so no credential leakage.
Status: Deferred — tighten to the app's origin at go-live.

### SEC-005 No CSP / HSTS / security headers
Severity: Info
Location: server.js (local dev server; production is static-hosted).
Impact: defense-in-depth headers absent. A strict CSP needs nonces because pages use inline scripts.
Status: Deferred to go-live (set at the static host / reverse proxy; plan a nonce pass for inline scripts).

## Passed / no findings
- **SECURITY DEFINER functions**: all pin `set search_path = public` (99 checked). `public_get_quote` / `public_get_proposal` are token-scoped and return only the intended fields.
- **Injection**: all DB access is parameterized (supabase-js / RPC args); no string-built SQL. No `eval`. Node API clamps/strings inputs.
- **XSS**: every page defines `esc()` and escapes user text at the output sink (verified; the only raw interpolations are static STAGE/card labels and the off-limits 3D builder).
- **Secrets**: none committed. `config.js` holds only the `anon` key (verified `role:"anon"`, RLS-protected). Edge Functions read `SUPABASE_SERVICE_ROLE_KEY` from `Deno.env`. No `.env`/keys tracked.
- **Path traversal**: server.js normalizes and confirms the resolved path stays under `public/`.
- **Auth/OTP**: Supabase Auth (bcrypt) for staff; OTP codes bcrypt-hashed, 10-min expiry, 5-attempt cap; webhook signature verified & fails closed; `quote_otps` has no read policy (deny-all to clients).

## Residual / accepted
- `quotes.pricing` is readable by `operations` at the DB level (ops needs quote basics); the UI hides the Total/pricing from operations. Column-level masking deferred.

## Not tested
- No active/DAST traffic (static review only). The 3D builder internals (builder.html) were out of scope by request. Live Supabase RLS enforcement to be confirmed once phase21 SQL is run.
