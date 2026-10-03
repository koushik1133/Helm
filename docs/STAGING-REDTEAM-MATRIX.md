# STAGING-REDTEAM-MATRIX.md

Consolidated **adversarial** attack matrix for the Helm staging deployment
(`xizehqgeyjcfpzrdymly`). This is the INDEPENDENT final red-team: it runs AFTER the
functional suites pass and re-exercises the hardened contract as an attacker would.

- **Target:** staging ref `xizehqgeyjcfpzrdymly` ONLY. Prod ref
  `nqltzgiwznphugcfhmbm` is a hard-refuse everywhere.
- **Evidence class:** passing rows are **SUPABASE STAGING** (server-side truth) or
  **VERCEL STAGING PREVIEW** (frontend, for CSP/CORS/open-redirect/config.js rows),
  per `docs/EVIDENCE-CLASS-RUBRIC.md`. A row only probed at SOURCE is marked so.
- **Gate:** the run passes only with **0 unresolved Critical/High** findings.
- **Fail-closed:** the orchestrator (`tests/staging/redteam.mjs`) asserts the staging
  ref and required env/seed before any call; missing → **exit 3 BLOCKED**, never
  PASS-on-skip.

Columns:

- **Attack** — the adversary's goal.
- **Vector / How** — the concrete request(s) an attacker sends.
- **Expected Result** — the hardened contract's correct behavior (what "secure" is).
- **Severity-if-breached** — impact if the expected result does NOT hold.
- **Which-suite-covers** — the existing FUNCTIONAL suite that owns this contract.
- **Independent-probe** — what `redteam.mjs` does itself to cross-check, independently
  of that suite (empty = matrix-only / covered by a prepared functional suite we do
  not duplicate).

---

## A. Authorization & identity

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| A1 | Anon privileged RPC exec | Anon (anon-key bearer, no user) calls each **mutating** RPC: `create_quote`, `convert_lead_to_quote`, `save_quotation_version`, `set_discovery`, `set_event_plan`, `set_proposal`, `generate_approval_token`, `record_payment`, `mark_paid`, `admin_create_user`, `verify_task` | DENY for every one (no EXECUTE grant to `anon` per 0005 + authz guard in 0007/0011) → PGRST202/404/403/42501 | **Critical** (unauth mutation / money / user creation) | authz-matrix.mjs | `redteam.mjs` fires anon `rpc()` at **every** mutating RPC and asserts `classify()==='DENY'` for all |
| A2 | Role escalation (vertical) | Low-priv seeded roles (`client`, `sales`, `coordinator`, `designer`, `quality`) call RPCs reserved for higher roles — esp. `admin_create_user` (is_admin), `record_payment` (finance.edit), `mark_paid` (admin/manager), `verify_task` (admin/manager/planner/quality) | DENY except the exact allowed column(s) in `expected-matrix.mjs` | **Critical** (privilege escalation) | authz-matrix.mjs | `redteam.mjs` spot-attacks `admin_create_user` as `sales` and `record_payment` as `sales`/`manager`, asserting DENY (the two highest-value escalations) |
| A3 | can_edit / has_area divergence abuse (W15-002) | `designer` (proposal.edit but not can_edit) calls `set_proposal`; `coordinator` (plan.edit, not can_edit) calls `set_event_plan`; `manager` (finance.edit, not can_edit) calls `record_payment` | DENY — both predicates must hold; divergence must fail CLOSED | **High** (unintended write path) | authz-matrix.mjs | matrix-only (functional suite owns the full cell grid) |

## B. Tenant isolation / IDOR

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| B1 | Cross-tenant REST read | Org-A admin issues `GET` on each org_id-bearing table filtered to an **org-B row id** (`quotes`, `event_proposal`, `event_tasks`, `design_stages`, `inventory_items`, `inventory_reservations`, `quote_payments`, `profiles`, `layouts`, `coupons`, `event_files`) | Denied, or success with **ZERO rows** (RLS hides). Any returned row = LEAK | **Critical** (cross-tenant data exposure) | tenant-idor.mjs | `redteam.mjs` runs an IDOR sweep: for each sensitive table it selects a forged org-B id as org-A and asserts deny/empty |
| B2 | Cross-tenant REST write (UPDATE/DELETE) | Org-A admin `PATCH`/`DELETE` an org-B row id | Zero rows affected (RLS), or denied | **Critical** (cross-tenant tamper/destroy) | tenant-idor.mjs | sweep issues cross-tenant `restUpdate` setting a harmless field and asserts zero-row/deny |
| B3 | IDOR via forged quote_id / org_id (plant) | INSERT a quote-linked child binding **victim's quote_id + attacker's org_id** (`event_proposal`, `event_tasks`, `design_stages`, `inventory_reservations`, `quote_payments`) | Rejected by `zz_quote_org_match` trigger (0004) + RLS with_check | **Critical** (tenant boundary forgery) | tenant-idor.mjs | `redteam.mjs` attempts one forged-id plant (`event_tasks` victimQuote+attackerOrg) and asserts rejection |
| B4 | Cross-tenant RPC | Attacker calls `save_quotation_version`/`set_proposal`/`record_payment`/`mark_paid`/`generate_approval_token` with a **victim-org quote id** | DENY via `assert_quote_org` before any body effect | **Critical** (cross-tenant mutation) | tenant-idor.mjs | `redteam.mjs` calls `save_quotation_version` + `record_payment` with a forged/other-org quote id and asserts DENY |
| B5 | Cross-tenant public-token read | Use org-B approval token against `public_get_quote`/`public_get_portal` expecting org-A data | Each token resolves ONLY its own quote; payloads tenant-distinct | **High** (token-scoped cross-tenant leak) | tenant-idor.mjs | matrix-only (functional suite compares token payloads) |

## C. Money path

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| C1 | Pricing tamper — client total | `save_quotation_version` with proper shape (`subtotal`,`gstPct`) **plus** a bogus `total` | Server recomputes; client `total` ignored (`helm_quote_total`, 0003) | **High** (revenue manipulation) | payment-redteam.mjs | `redteam.mjs` sends a crafted `total` and asserts the returned total is the recomputed value, not the injected one |
| C2 | Pricing tamper — missing-shape total trust (W15-001) | `save_quotation_version` with ONLY `{ total: <big> }` (no subtotal) | Server must NOT trust client `total` (recompute/reject) | **High** (top-level subtotal bypass) | payment-redteam.mjs | `redteam.mjs` sends no-shape `{total}` and asserts server did not echo the injected total |
| C3 | Pricing tamper — negative components / discount / gst | `save_quotation_version` with negative `discount`/`gstPct`; negative `subtotal` | Rejected (22003 / CHECK) | **Medium** (under-billing) | payment-redteam.mjs | included in the pricing-tamper burst (negative components → expect non-OK) |
| C4 | Coupon / discount abuse | Apply a discount that drives total ≤ 0 or exceeds caps | Clamped/rejected; total never negative | **Medium** (free goods) | payment-redteam.mjs | matrix-only (covered by pricing recompute + CHECK constraints) |
| C5 | Overpayment (single) | `record_payment` for `amount > quote_total` | Rejected (23514); ledger unchanged | **High** (ledger corruption) | payment-redteam.mjs | pricing/overpay burst asserts single overpay rejected and `total_paid ≤ total` |
| C6 | Overpayment **race** | Two concurrent `record_payment` of 60k on a 100k quote (`Promise.all`) | Exactly one commits; `total_paid ≤ total` | **High** (double-spend / over-settle) | payment-redteam.mjs | `redteam.mjs` fires the concurrent overpay race and asserts exactly one ledger effect |
| C7 | Idempotency-key replay | Same `idempotency_key` sent twice concurrently | Exactly one ledger row | **High** (double count) | payment-redteam.mjs | matrix-only (functional suite owns the idem-key case) |

## D. Tokens, OTP, webhooks

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| D1 | Approval-token replay (expired/revoked/rotated) | Call `public_get_portal`/`public_get_quote` with an expired, revoked, or rotated-out approval token | DENY for expired/revoked/old; only current valid accepted | **High** (stale-link access) | token-otp.mjs | `redteam.mjs` probes a syntactically-valid but **nonexistent** token → DENY (replay/forgery cross-check without seed mutation) |
| D2 | Worker-token replay (expired/revoked/renewed) | `worker_get_tasks` with expired / deleted / superseded work token | DENY for expired/revoked/old (G2 intent) | **High** (stale worker access) | token-otp.mjs | `redteam.mjs` calls `worker_get_tasks` with a random token → DENY |
| D3 | OTP replay | Re-verify an already-verified OTP via `verify_and_consent` | Not accepted ("no active code") | **High** (consent forgery) | token-otp.mjs | matrix-only (functional suite plants + replays) |
| D4 | OTP rate-limit **race** | Concurrent burst of `request_otp` / `quote_otps` inserts beyond 3/phone/hr & 10/quote/day | Caps hold atomically under `Promise.all` | **Medium** (SMS bombing / cost) | token-otp.mjs | `redteam.mjs` fires an anon `request_otp` burst at a nonexistent token and asserts no success leaks through (fail-closed under load) |
| D5 | Webhook signature forgery | `razorpay-webhook` with missing / wrong `x-razorpay-signature` | 401; nothing settles | **Critical** (forged settlement) | edge-http.mjs | matrix-only (edge suite owns signed fixtures) |
| D6 | Webhook replay (valid sig) | Same validly-signed body posted twice, and against a **nonexistent** quote | 200 idempotent; **no settlement** (nothing to settle) | **High** (double-settle) | edge-http.mjs | `redteam.mjs` posts a valid-signature webhook for a nonexistent quote id and asserts 200 + "no quote" (nothing settles) — settlement-free by construction |

## E. Storage

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| E1 | Anon storage bypass | Anon upload/read/list on private buckets `invite-media` / `event-docs` | Denied (private buckets, 0013) | **High** (unauth file access) | storage.mjs | matrix-only (storage suite owns provider-level checks) |
| E2 | MIME spoof / disguised payload | Upload HTML/SVG with image content-type; wrong-MIME for bucket | Rejected (allowlist + size cap) | **High** (stored XSS vector) | storage.mjs | matrix-only |
| E3 | Path traversal in object key | Object name `../escape.png` / double-extension `x.png.html` | Rejected | **Medium** (path escape) | storage.mjs | matrix-only |
| E4 | Cross-org storage read/write | Org-B user writes/reads under org-A `<org_id>/...` path | Denied (RLS foldername check) | **High** (cross-tenant files) | storage.mjs | matrix-only |

## F. Web surface (frontend / edge headers)

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| F1 | CORS — evil origin | `OPTIONS` preflight to edge fns with `Origin: https://evil.example` | No `Access-Control-Allow-Origin` echoed for evil origin; allowed origin echoed | **High** (cross-site API use) | edge-http.mjs | `redteam.mjs` sends an evil-origin preflight to an edge fn and asserts ACAO is not echoed (independent of env/secrets) |
| F2 | CSP weakness | Fetch `PREVIEW_URL` and inspect `Content-Security-Policy` header | Present; no blanket `unsafe-inline`/`*` on script-src (see CSP-UNSAFE-INLINE-AUDIT.md) | **Medium** (XSS amplification) | env-routing / edge headers | `redteam.mjs` fetches PREVIEW_URL headers and flags a missing CSP or `script-src ... 'unsafe-inline'` as a finding (Low/Medium) |
| F3 | Stored XSS — proposal fields | `set_proposal` concept/theme with `<script>`/`<img onerror>`; rendered on public proposal page | Escaped/sanitized on render; no execution | **High** (stored XSS to clients) | e2e / storage (invite media) | matrix-only (requires rendered-page assertion; flagged for VERCEL STAGING PREVIEW) |
| F4 | Stored XSS — invite media | Upload SVG/HTML as invite media, served on public invite site `/i/<slug>` | Rejected at upload (E2) + served with non-executable content-type | **High** (stored XSS) | storage.mjs | matrix-only |
| F5 | Open redirect | Public links / auth return-to with attacker URL (`?redirect=//evil`, `return_to=`) | Only same-origin / allow-listed targets honored | **Medium** (phishing pivot) | env-routing | matrix-only (flagged for VERCEL STAGING PREVIEW rendered check) |

## G. Secrets & environment confusion

| # | Attack | Vector / How | Expected Result | Severity-if-breached | Which-suite-covers | Independent-probe |
|---|--------|--------------|-----------------|----------------------|--------------------|-------------------|
| G1 | Secret leakage — edge error bodies | Trigger edge-fn error paths and inspect bodies for keys/secrets | No secret substrings in any response body | **Critical** (key disclosure) | edge-http.mjs | matrix-only (edge suite owns `noLeak` across fns) |
| G2 | Secret leakage — config.js | Fetch `PREVIEW_URL/config.js`; scan for a **service_role / elevated** key or any `role":"service_role"` JWT | Only the public anon/publishable key present; never an elevated key | **Critical** (elevated key exposure) | env-routing | `redteam.mjs` fetches config.js and asserts no `service_role` marker and no obvious secret; anon key only |
| G3 | Environment confusion (preview→prod) | Fetch `PREVIEW_URL/config.js` and assert the wiring resolves to STAGING, never prod | Contains staging ref `xizehqgeyjcfpzrdymly`; prod ref absent / fail-closed | **Critical** (red-team hits prod by accident) | env-routing / global-setup | `redteam.mjs` fetches config.js, asserts staging ref present and prod ref not the resolved target (hard BLOCK if prod ref appears) |

---

## Coverage summary

- **Attack families (rows): 31** across 7 sections (A:3, B:5, C:7, D:6, E:4, F:5, G:3).
- **Independent probes implemented in `redteam.mjs`: 12** — A1, A2, B1/B2 (sweep),
  B3, B4, C1, C2, C5/C6, D1, D2, D4, D6, F1, G2, G3. (The remainder are owned by the
  prepared functional suites and are intentionally **not duplicated** here.)
- **Critical rows:** A1, A2, B1, B2, B3, B4, D5, G1, G2, G3.
- **Gate:** `redteam.mjs` exits non-zero if ANY Critical/High independent probe
  finds a breach; exit 3 if it cannot run safely (env/seed/ref).

> Evidence honesty: a green row here is **SUPABASE STAGING** (data-layer probes) or
> **VERCEL STAGING PREVIEW** (F2/G2/G3 header+config fetch). Rows marked "matrix-only"
> are owned by a prepared functional suite; where that suite has not yet been DRIVEN
> they remain **SOURCE** until executed. Never upgrade a class (rubric Hard Rule 1).
