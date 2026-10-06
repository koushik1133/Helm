# Edge Function Runtime Test Harness — Results

Agent E (Edge Function Runtime Harness). Safe, offline, mock-only. **No real provider
or network calls, no deploy, no DB, no git.**

## How it works
- `deno` is available, so handlers are tested **at runtime** in-process.
- `_shared/cors.ts` is imported directly (pure functions).
- The 4 functions call `Deno.serve(handler)` at module top level. `harness.ts`
  stubs `Deno.serve` to **capture the handler**, then invokes it with crafted `Request`s.
- `import_map.json` redirects `npm:@supabase/supabase-js@2.117.2` to a
  local programmable mock (`mocks/supabase-js.ts`) — the real SDK is **never fetched**.
- `Deno.env`, `fetch` (MSG91 / Meta Graph / Razorpay / Resend) are all stubbed.
  The mock `fetch` **throws** on any URL a test did not explicitly allow.
- Module top-level consts (e.g. WhatsApp `TOKEN`) are re-read per test via a
  cache-busted dynamic import.

## Safety proof
The suite is run **without `--allow-net`**. Deno would raise a permission error on
any real runtime `fetch`. The suite passes green, which guarantees every provider
call went to the mock and **zero real network calls happened**.

## Run
```
cd tests/edge
deno test --allow-env --allow-read --no-check --import-map=import_map.json
```
Result: **47 passed | 0 failed** (audit Phase 8 rewrite; also run by `test/edge-functions-hardening.test.mjs`). (Runtime-verified; no `--allow-net`.)

## Per-function matrix

### _shared/cors.ts — CORS allowlist (RUNTIME-VERIFIED)
| Behavior | Status |
|---|---|
| Allowed prod origin echoed (`helm.events`) | PASS |
| Vercel preview lookalikes NOT trusted (no regex; exact `EXTRA_ALLOWED_ORIGINS` only) | PASS |
| Random/evil origin blocked (no ACAO) | PASS |
| Preview-lookalike on another host blocked | PASS |
| `Vary: Origin` always present | PASS |
| No `Access-Control-Allow-Credentials` | PASS |
| Methods = POST, OPTIONS | PASS |
| localhost blocked unless `ALLOW_LOCALHOST=1` | PASS |
| `ALLOWED_ORIGINS` replaces default list, preview regex kept | PASS |
| `escHtml` escapes `& < > " '`, null/undefined → "" | PASS |

### send-otp (RUNTIME-VERIFIED)
| Behavior | Status |
|---|---|
| Missing token/phone → 400 | PASS |
| Invalid phone (<8 digits) → 400 | PASS |
| Rate-limit / invalid token (`admin_store_otp` error) → 400, **no SMS sent** | PASS |
| MSG91 unavailable → 502 generic error, **provider body not leaked**, logged server-side | PASS |
| Happy LIVE path → MSG91 called, 200 `{sent,live:true}`, 10-digit → `91`-prefixed, OTP is 6 digits | PASS |
| Simulated mode (no `MSG91_AUTHKEY`) → 200 `{live:false}`, no fetch | PASS |
| CSPRNG: `crypto.getRandomValues`, rejection sampling, **no `Math.random()`** (source audit) | PASS |
| OTP shape: 5000-sample run — always 6 digits, high entropy, unbiased leading digit | PASS |

### send-whatsapp (RUNTIME-VERIFIED)
| Behavior | Status |
|---|---|
| Not configured (no `WHATSAPP_TOKEN`) → 500 | PASS |
| No JWT → 401 denied, **Meta never called** | PASS |
| Non-staff JWT (role=client) → 401 denied | PASS |
| Staff JWT → allowed, 200, Meta `/messages` hit, number normalised | PASS |
| Provider failure → 502 generic error, **provider body not leaked**, logged | PASS |
| `ping` → credential check is a GET, no message send | PASS |
| Missing text and template → 400 | PASS |

### create-payment-link (RUNTIME-VERIFIED)
| Behavior | Status |
|---|---|
| Missing token → 400 | PASS |
| Unknown token → 404 | PASS |
| Expired token → 404, **Razorpay not called** | PASS |
| Already `paid` → 409, **no second link / no double charge** | PASS |
| Not approved → 400 | PASS |
| Amount ≤ 0 → 400, Razorpay not called | PASS |
| Duplicate click → **reuse open link of same amount**, no new link | PASS |
| Happy path → creates link, 200, amount correct in paise | PASS |

### razorpay-webhook (RUNTIME-VERIFIED)
| Behavior | Status |
|---|---|
| Missing signature → 401 | PASS |
| Wrong signature → 401 (HMAC-SHA256 verify) | PASS |
| Tampered body + old signature → 401 | PASS |
| Valid signature + full payment → 200 `ok`, quote settled, receipts recorded | PASS |
| Replay (quote already paid) → 200 idempotent, **no duplicate receipts/emails** | PASS |
| Underpayment → 200 mismatch, **quote not transitioned to paid**, no receipts | PASS |
| Unknown event type → 200 ignored | PASS |
| Malformed quote_id (non-UUID) → 200 "no quote" (no 500 retry storm) | PASS |
| HTML/CRLF-injected code/title → escaped in email HTML, CR/LF stripped from subject | PASS |
| Source uses `crypto.subtle` HMAC-SHA256 + `timingSafeEqual` + length guard (audit) | PASS |

## Runtime-verified vs source-only
- **Runtime-verified (handler executed with mocks):** all status-code paths, auth
  gating, idempotency conditional-update, underpayment guard, CORS decisions,
  HMAC accept/reject (real WebCrypto signatures computed in-test), HTML/CRLF
  escaping of outbound email, provider-error masking, and the OTP generator's
  statistical shape.
- **Source-only (deploy-gated, cannot be exercised offline):** that the SMS/WhatsApp/
  payment/email actually reach the live providers; real MSG91/Meta/Razorpay/Resend
  response schemas; real Postgres RLS + `admin_store_otp` rate-limit/bcrypt internals;
  genuine concurrency of the conditional UPDATE (verified as single-statement in source,
  not under real parallel DB load). These require a staging deploy with secrets.
