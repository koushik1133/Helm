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
