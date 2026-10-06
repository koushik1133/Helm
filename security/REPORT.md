# Helm Security Report: OWASP Audit, October 2026 (final, Phase 10)

Target: Helm (www.helm.events, helm-v01.vercel.app). Production Supabase `nqltzgiwznphugcfhmbm`, staging `xizehqgeyjcfpzrdymly`.
Method: the full OWASP web-testing checklist (131 items), worked phase by phase. Static review plus behavioural attack tests on a disposable Postgres (two studios, every role). Dynamic tests ran on localhost → staging. Production got read-only checks only: probes either read data or attempted writes that were refused and could change nothing.
Scorecard (before Phases 7–10): https://claude.ai/artifact/K3Hj9mc3ZMAesS1Ch9nRMJ (77/100)

## Release verdict
**READY WITH FIXES.** Two conditions:
1. `supabase/APPLY-PENDING.sql` v6 (0026–0028) is applied to staging and production. Run `supabase/audit/P7-10-PRECHECK.sql` first.
2. The owner actions below are completed. The most urgent are the 11 accounts on published default passwords and making both GitHub repos private.

No critical or high finding is open in the code once v6 is applied.

## What each phase found and fixed

| Phase | Area | Key fixes | Migration | Proof |
|---|---|---|---|---|
| 1 | Recon | robots.txt allowlist (no app routes listed); noindex on app and token routes | — | test/robots-policy |
| 2 | Config / transport | private invite-media bucket (photos only on published invitations); stale www domain fixed | 0019 | storage-policy (P2-01) |
| 2b | Links | studio-branded client links with anti-phishing studio check | 0020 | studio-links, vercel-routing |
| 3 | Authentication | demo admin credentials removed from docs; default-password check and rotation SQL | — | P3-CHECK / P3-FIX |
| 4 | Sessions | sign-out clears per-user browser state | — | chat-bell-noise |
| 5 | Authorization | **CRITICAL**: any member could make themselves admin or move to another studio | 0021 | privilege-escalation |
| 5b | Link lifetime | invite / proposal / crew links end 7 days after the event; undated crew-link fix | 0022, 0023 | link-windows |
| 6 | Injection / XSS | chat reaction HTML, chat media tracking URLs, quote print popup, mailto Bcc, dishes count | 0024 | injection-guards, injection-sinks |
| 6b | Mass assignment | direct writes to payments, consent, quote status, invitations, chat (private-chat join, fake DM), crew links, proposal publish, settle, check-out | 0025 | write-path-lockdown (26) |
| 7 | Business logic + crypto | NaN/Infinity/negative money; deleting events with receipts; OTP 5-try lockout; cryptographic OTP; duplicate payment rows; cross-studio references; TRUNCATE revoked; audit triggers; consent snapshot; refund maker-checker; field limits | 0026 | business-logic (39) |
| 8 | Uploads + payments | invitation photo writes need editor role; upload quotas; milestones paid only via Settle; payment links serialized with expiry; webhook reconciliation and retries; per-studio receipts; WhatsApp and SMS locked to event contacts with rate limits; exact CORS list; sim-pay off on prod | 0027 | uploads-payments (35), edge-functions-hardening (18 + 47 Deno) |
| 3–4 follow-up | Login + sessions | 12-character passwords with letter and digit (bcrypt 12); forgot/reset password; change password; TOTP two-factor with step-up; Turnstile CAPTCHA (flag); 30-minute idle and 12-hour absolute logout; no-store on app pages; temp passwords fail closed | 0028 | auth-hardening (34), auth-session-hardening (30) |
| 9 | HTML5 / client | CSP: CDN only on the builder, path-pinned; token pages no-referrer and no-store; telemetry token redaction; internal files 404; https-only media; CSV formula guard; postMessage origin checks pinned | — | html5-config-hardening (21) |

Totals:
- DB battery: **24 suites, ALL GREEN**. Migrations apply idempotently (`applied=29`, then `0` on re-run).
- `npm run ci`: green.
- Every fix has a regression test that fails on the old code.

## Verified on production (read-only)
- 0019–0025 are applied on both projects, all verify rows ok, and both sites run v98. As the admin user, every forbidden direct write is refused with 403/42501, and reads work.
- No failed requests on Chat, Quotes, Flow, Dashboard, Settlement or Invite Studio.
- Edge Functions are **not deployed on prod** (404). They **are deployed on staging** and must be redeployed with the Phase 8 code.
- `inventory_availability` does not leak on prod (signed-out visitors get 0 rows). It does leak in the canonical schema and on staging, and needs a follow-up fix.

## Owner actions (details: docs/OWNER-ACTIONS-SECURITY.md, docs/AUTH-DASHBOARD-SETTINGS.md)
1. Rotate or delete the 11 production accounts on published default passwords. Change the staging `helm0909` users.
2. Make both GitHub repos private (koushik1133/Helm and praneethreddykiwik/Helm). Both are public today.
3. Supabase Auth on both projects:
   - password rules (min 12, letters and digits) and leaked-password protection
   - TOTP on
   - session time-box and inactivity timeout
   - Turnstile secret (ship the site key in config.js first)
   - redirect allowlist entry for `/reset-password`
4. Staging: turn off sign-ups, unset or rotate Edge Function secrets, and redeploy the 4 functions with the new code.
   - New secrets: APP_URL, WHATSAPP_TEMPLATES, optional EXTRA_ALLOWED_ORIGINS.
   - Fill in `organizations.business_email`.
5. security@helm.events with MX, SPF, DKIM and DMARC. Turn on GitHub private vulnerability reporting.
6. Vercel: remove the `helm-alpha-nine` alias. Set the apex to "No redirect", then submit to hstspreload.

## Accepted / deferred risks
- No antivirus on uploads (recommendation: scanning Edge Function for PDFs).
- No server-side file-content sniffing (bucket MIME allowlist plus client magic-byte check).
- Supabase session in localStorage. Mitigated by strict CSP, no inline script, and the idle and absolute timeouts.
- Google OAuth uses the implicit flow (moving to PKCE is recommended; not changed to avoid breaking sign-in).
- `mfa_ok()` is not enforced in RLS yet (needs a staged rollout). MFA is enforced at the app gate.
- Product decisions pending:
  - closing an event with a balance outstanding
  - resetting approval after a price change
  - an overbooking guard
  - the helm_total_paid ledger double-count (H04)
  - whether the refund maker-checker exempts admins (currently yes)

---

# Earlier report (2026-09-19)

# Security Report — Blueprint Stage
Target: local repo (koushik1133/Helm) · Date: 2026-09-19 · Scope: static review + live RLS testing against the owner's own Supabase

## Executive summary
Overall posture is **strong**. The highest-risk area for a multi-role app — access control on financial/PII tables — is **enforced at the database** via role-scoped RLS (verified live: low-privilege roles read 0 rows where admin reads data). No secrets are committed, the payment webhook verifies its HMAC signature, and path traversal is guarded. The one gap found and fixed this pass was **missing HTTP security headers**; they are now set by `server.js` and a portable `public/_headers`.

## Findings

### SEC-001 Missing HTTP security headers  — FIXED
Severity: Medium (defense in depth)
Location: server.js (static responses)
Impact: no clickjacking protection, no MIME-sniffing protection, no CSP to contain injected script, no HSTS.
Fix: added `SECURITY_HEADERS` (CSP, HSTS, X-Content-Type-Options, X-Frame-Options: DENY, Referrer-Policy, Permissions-Policy, COOP) to every served page in `server.js`, plus `public/_headers` for static hosts. CSP allowlists only the app's real sources (self, cdn.jsdelivr.net for supabase-js, cdnjs for three.js, Google Fonts, *.supabase.co REST+realtime).
Verification: `curl -sI http://localhost:4173/index.html` shows all headers; app loads and runs under CSP with **no violations**; Supabase, fonts and the 3D builder all still work.
Status: Fixed.

## OWASP Top 10 verdicts
- **A01 Broken access control — PASS.** Finance/PII tables (`event_costs`, `payment_milestones`, `expense_claims`, `quote_payments`, `event_closure`, `quote_otps`) are RLS-scoped by role via `has_area()` (phase29). **Live-proven:** admin reads 11 costs / 8 milestones / 3 claims; `operations` and `crew` read **0**. Server-side RPCs (`SECURITY DEFINER`) enforce `can_edit()`/`has_area()` before writes; anon/token flows go through definer RPCs only. Client portal RPC returns a whitelisted field set (no costs/margins/vendors/tasks — leak-tested).
- **A02 Cryptographic failures — PASS.** Passwords handled by Supabase Auth (bcrypt/scrypt). OTP stored as a bcrypt hash (`crypt`+`gen_salt('bf')`), never plaintext. TLS via Supabase/host; HSTS now set.
- **A03 Injection — PASS.** No SQL string concatenation (parameterized RPCs / PostgREST). Front-end renders user text through `esc()`; no `dangerouslySetInnerHTML`/`eval`; unescaped interpolations are numbers/enums/UUIDs only.
- **A04 Insecure design — PASS (adequate).** OTP endpoint rate-limited (5 / 10 min / quote). RBAC matrix is configurable and enforced in DB. (Broader per-endpoint rate limiting relies on Supabase defaults — see accepted risks.)
- **A05 Security misconfiguration — PASS (after fix).** Headers now set. Path traversal guarded (files pinned inside `PUBLIC_DIR`). No debug/stack traces leaked to clients.
- **A06 Vulnerable components — PASS.** Zero-dependency Node server (no `node_modules`); supabase-js and three.js pinned to explicit CDN versions.
- **A07 Identification & auth failures — PASS.** Supabase Auth (session rotation, secure tokens). Dedicated full-page sign-in. OTP flow rate-limited + hashed + expiring.
- **A08 Data integrity — PASS.** Payment webhook verifies Razorpay HMAC with a constant-time compare and fails closed (401). CDN scripts pinned by version.
- **A09 Logging & monitoring — PASS (adequate).** Phase 47 audit log records actor/action/entity/old→new/timestamp on sensitive tables; the notification outbox logs channel events. No secrets logged.
- **A10 SSRF — N/A.** The app fetches no user-supplied URLs server-side.

## Secret & dependency scan
- No `.env`, `.pem`, `credentials.json`, or service-role key committed (`git ls-files` clean).
- `config.js` contains only the Supabase **anon** key (public by design; RLS is the boundary).
- `service_role` key appears only as `Deno.env.get(...)` inside edge functions (correct — injected at runtime, never in code).

## Accepted risks (documented, low)
| Risk | Reason | Recommendation |
| --- | --- | --- |
| CSP uses `'unsafe-inline'` for script/style | Every static page uses inline `<script>`/`<style>`; a nonce refactor spans 37 pages | Move to nonce-based CSP during a future refactor; current CSP still blocks external-origin script injection, clickjacking, base-uri and object-src |
| `/api/layouts` CORS is `*` | Local fallback store only; no cookies/credentials used (Supabase auth is header-based), so no cross-origin credential leak | Restrict to the app origin if this API is ever exposed in production |
| Per-endpoint rate limiting relies on Supabase defaults (except OTP) | No custom gateway | Add per-identity limits on auth/search/expensive RPCs at go-live |

## Not tested (out of scope this pass)
- Live penetration testing against a deployed host (static + owner-DB RLS testing only).
- Multi-tenant cross-org isolation — **deferred** (Block F not built yet); must be security-reviewed when multi-tenant lands.
- Edge function deployment config / secret injection in the live Supabase project (owner-managed).
