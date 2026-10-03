# Deferred Integrations Guard Report — Razorpay + WhatsApp (+ OTP/SMS)

**Scope:** read-only verification that Razorpay (payments) and WhatsApp are safely
deferred / fail-closed, with the OTP/SMS launch-gate question answered.
**Date:** 2026-10-02 · **Mode:** READ-ONLY (source + tests only; no product code changed, no secrets/staging/prod touched).

## How to read the evidence levels
- **SOURCE VERIFIED** — proven by reading the actual source/config in this repo.
- **LOCAL VERIFIED** — proven by a local, no-network check or test that passes here.
- **GAP** — requirement not met (or not provable) → called out explicitly.

## Commands run
- `node scripts/check-deferred-integrations.mjs` → **PASS** (exit 0): flags OFF, no committed secrets, no static webhook, Edge Functions env-only + webhook HMAC-verified.
- `npm test` → **PASS** (exit 0, full suite). `test/deferred-integrations.test.mjs` extended from 1 → **14** assertions.

## Razorpay (payments)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| R1 | UI disabled if unconfigured | SOURCE VERIFIED | `public/config.js` `liveChannels.pay = false`; `public/store-api.js:798` routes to the simulated `create_payment` RPC unless `LIVE.pay`; `sim-pay.html:61` treats live only when `pay === true`. |
| R2 | Payment-link endpoint fail-closed on missing keys | SOURCE VERIFIED | `create-payment-link` reads `RAZORPAY_KEY_ID`/`KEY_SECRET` from `Deno.env`; missing → Razorpay auth fails → `r.ok` false → returns 502 "could not create the payment link". No link minted, quote not marked paid. Function only reachable when `LIVE.pay=true` (gated off). |
| R3 | No fake success state | SOURCE VERIFIED | Link only returned on a real `r.ok` Razorpay response; quote → `paid` happens **only** in the HMAC-verified webhook, never optimistically in the UI/edge. |
| R4 | Amount server-authoritative (never client total) | SOURCE VERIFIED | Edge request body carries only `{ token }`. Amount = `Math.round(Number(q.pricing.total)*100)` read from the DB row via service role, not from the request. (Pinned by new test.) See NOTE below on the separate, pre-tracked quote-total trust gap. |
| R5 | No placeholder/live key accepted as valid | SOURCE VERIFIED / LOCAL VERIFIED | No key literals in code (env-only); `check-deferred-integrations.mjs` secret-pattern scan passes for `public/` and `supabase/functions/`. |
| R6 | Webhook HMAC verify + replay + idempotency retained | SOURCE VERIFIED / LOCAL VERIFIED | `razorpay-webhook`: `x-razorpay-signature` + `timingSafeEqual(hmacHex(secret,raw))` with `RAZORPAY_WEBHOOK_SECRET`, else 401. Idempotent via single conditional `UPDATE … .neq('approval_status','paid')`; replays find already-paid and 200 without re-notifying. Amount-coverage: won't settle if `paidPaise < expectedPaise`. Pinned by new tests. |
| R7 | `verify_jwt=false` only for the signed webhook, not ordinary user APIs | SOURCE VERIFIED (design) / GAP (not asserted in repo) | By design: `razorpay-webhook` authenticates via HMAC (no Supabase JWT from Razorpay) → needs `verify_jwt=false`. `send-whatsapp` requires a signed-in staff JWT (`staffUserId`); `create-payment-link`/`send-otp` are token-scoped public flows. **No `supabase/config.toml` exists in the repo**, so the per-function `verify_jwt` setting is a dashboard/deploy-time control, not committed/provable here → tracked in the enablement checklist. |
| R8 | No endless retry loop | SOURCE VERIFIED | Malformed/unknown ids and amount mismatch return **200** (not 5xx), so Razorpay stops retrying; only true exceptions throw 500. Pinned by new test. |

**NOTE (pre-existing, separately tracked — not a Razorpay defect):** the Razorpay amount is authoritative *at the integration boundary* (read from the stored quote), but the stored quote total itself is persisted client-supplied verbatim (PR-MONEY-01 / memory W15-001), guarded by `test/money-trust-boundary.test.mjs`. Out of scope for this deferred-integrations guard.

## WhatsApp

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| W1 | UI disabled if provider unavailable | SOURCE VERIFIED | `liveChannels.whatsapp = false`; **no UI caller exists** — `send-whatsapp` is referenced only in a `store-api.js` comment, never invoked. Strongest possible dormancy. |
| W2 | Missing token → safe failure (no simulated "delivered" in production) | SOURCE VERIFIED | `if (!TOKEN || !PHONE_ID) return json(..."not configured", 500)` before any send. A `notifications` row with `status:"sent"` is written **only after** a real `r.ok` from Meta. Pinned by new test. |
| W3 | No token in browser | SOURCE VERIFIED / LOCAL VERIFIED | Token is `Deno.env.get("WHATSAPP_TOKEN")`, used only in the `Authorization` header; never returned in a `json()` body or logged. Secret-pattern scan of `public/` passes. Pinned by new test. |
| W4 | Logs redact phone/token/content | SOURCE VERIFIED (partial) | `console.error` logs only HTTP status + first 500 chars of Meta's *response*; token/number/message body are not logged. Note: a Meta error response could contain the recipient number echoed back — low risk, redaction is best-effort. |
| W5 | Staff-only (no open relay) | SOURCE VERIFIED | `staffUserId()` rejects anon/non-staff (`401 "sign in as a staff user"`); anon key alone yields no user. Pinned by new test. |
| W6 | No endless retry | SOURCE VERIFIED | Single `fetch`; failures return 400/502 to the caller, no retry loop. |

## OTP / SMS (MSG91)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| O1 | Simulated OTP never accepted as real production consent | SOURCE VERIFIED | In prod (`sms_live=false`, `otp_dev_echo=false`) `request_otp` returns `delivery:'unavailable'` and **does not echo the code**; the client can never learn it, so `verify_and_consent` cannot be completed. Dev-echo is an explicit non-prod opt-in that only works when `sms_live` is off. |
| O2 | `verify_and_consent` requires a real OTP + explicit agreement | SOURCE VERIFIED | Verifies bcrypt `crypt(p_code, code_hash)`, enforces ≤5 attempts, requires `p_agreed = true`, then writes `quote_consents` + flips quote to `approved`. No simulated/bypass path. |
| O3 | Live `send-otp` never returns the plaintext code | SOURCE VERIFIED | `send-otp` stores only the hash via `admin_store_otp`; response is `{sent, live}` only. Notification status is `"sent"` with MSG91 else `"simulated"`. Pinned by new test. |

### OTP VERDICT
**MSG91 (external SMS) IS a launch-critical gate for the live client-approval/consent
flow — but it is safely fail-closed, not a bypass.** Without MSG91 configured and
`sms_live=true`, the public OTP flow reports `unavailable` (prod) rather than leaking
or auto-accepting a code; `otp_dev_echo` is an explicit local-dev-only switch that
cannot operate while SMS is live. There is **no** path where a simulated OTP becomes a
real production consent. So: *required to ENABLE the live approval flow; its absence
blocks the flow safely and does not weaken consent integrity.*

## GAP findings
- **GAP-1 (R7, documentation/deploy):** the per-function `verify_jwt` posture is not
  committed to the repo (no `supabase/config.toml`). It must be set at deploy time:
  `verify_jwt=false` **only** for `razorpay-webhook`; keep it **on** for ordinary user
  APIs. Captured in `FUTURE-INTEGRATION-CHECKLIST.md`. No code fix available here.
- No security GAP found in function behaviour: all Razorpay/WhatsApp/OTP requirements
  are SOURCE or LOCAL verified.

## Product change needed?
**No product code change required.** The dormant posture is correct and fail-closed.
The only open item is a *deploy-time* configuration (`verify_jwt` per function) plus the
separate, already-tracked PR-MONEY-01 quote-total trust boundary — neither is changed here.

## Test additions (tests-only, no product code touched)
`test/deferred-integrations.test.mjs` extended from a single guard-delegation assertion
to **14** source-characterization assertions pinning the fail-closed properties above
(amount authority, no-double-charge, HMAC+idempotency+no-retry-loop, WhatsApp fail-closed
+ staff-only + token-not-echoed, OTP code-never-returned). All pass locally; full
`npm test` suite passes (exit 0).
