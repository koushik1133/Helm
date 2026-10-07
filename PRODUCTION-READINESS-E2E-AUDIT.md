# Helm — End-to-End Production-Readiness Audit

**Date:** 2026-10-03 · **Branch:** `harden/pre-react-canonical` @ `ab41da5`
**Method:** 6 parallel per-domain source audits of all ~41 app tabs, each finding
cross-checked against the canonical SQL; full offline test batteries; no production
mutation (no live staging URL was available, and the production URL is out of scope
for write tests).

## Evidence grades
- **PROVEN** — verified by a green automated test or by reading the authoritative SQL/source.
- **CONFIRMED (source)** — reproduced by reading the exact code path; not yet exercised at runtime.
- **DEFERRED** — real, but the fix touches money/access semantics or the canonical DB and must be staging-verified, not guessed against production.
- **DECISION** — needs a product call before changing behavior.

---

## 1. What is PROVEN solid

Offline battery (local PostgreSQL 17, the suite CI runs) — **ALL GREEN**:
canonical migrations apply + idempotent; `auth-matrix`, `rpc-authz-matrix` (RLS),
`tenant-attack` (isolation), `grants-matrix`/`g4-coverage` (RBAC), `pricing-parity`
+ `contract-coverage`, `payment-matrix` + `concurrency-overpay`, `token-otp` +
`worker-token` + `concurrency-otp`, `storage-policy`, `advisor-hardening`. Plus
`npm test` + `npm run ci` green.

Verified against SQL:
- **D8 pricing authority (PROVEN).** `helm_quote_total` recomputes the total from raw
  inputs, **rejects** a client-supplied `total` with no computable shape, and a BEFORE
  trigger overwrites `quotes.pricing.total` with the server value on every write. A
  client cannot persist an arbitrary total. (`0001_pricing_authority.sql`)
- **Settlement overpayment cap (PROVEN).** `record_settlement_payment` is
  `security definer`, checks `can_edit()` + org, rejects ≤0, is idempotent; the
  overpay cap is enforced by `trg_no_overpayment` across quote_payments + milestones.

Fixed and pushed this session (3 commits, all green on GitHub Actions):
- `ec0ef7d` mobile guided-tour spotlight alignment (+ regression test).
- `06fe3dd` digit-only phone inputs + automatic required-field `*` (+ test).
- `ab41da5` mandatory client name+phone on **Confirm / record-payment**; close-with-balance
  warning; leads double-toast; nurture toggle revert; builder catering-mode price panel;
  idempotent template apply; vendor history date.

---

## 2. Defect register (by severity)

### P1 — must fix before a production go-live of the full lifecycle

| # | Area | Finding | Grade | Status |
|---|---|---|---|---|
| P1-1 | Settlement | `settlement.summary()` derives **Received/Balance from `payment_milestones` only** (store-api.js:2491), but the settlement page's "Record payment" writes to `quote_payments` — so a recorded settlement receipt never moves Received/Balance. | CONFIRMED | DEFERRED — change summary to sum the `quote_payments` ledger (there is already `milestones.payments(id)`); verify on staging. |
| P1-2 | Closure | `close_event` (canonical base:1927) gates on `can_edit()`+org only — **no server check** of client balance, vendor settlement, or equipment-out. The equipment gate is client-only (bypassable). | CONFIRMED (SQL) | PARTIAL — client balance/vendor **warning added** this session; the hard server gate needs a forward migration. |
| P1-3 | Inventory | `availability()` counts reservations only and **ignores outstanding check-outs** (store-api.js:1447-1467); `co_add` has no over-issue guard. → the same physical stock can be double-allocated. | CONFIRMED | DEFERRED — fold open-loan qty into committed + guard checkout; staging-verify (risk of double-counting reserved-and-checked-out). |

### P2 — serious; fix before or shortly after launch

| # | Area | Finding | Grade | Status |
|---|---|---|---|---|
| P2-1 | RBAC | `leads.html`/`crm.html` gate views on the **coarse** "pipeline" key (passes if ANY child viewable); create/convert/delete use **global role caps** while edit uses the **per-area matrix** — the known W15-002 divergence; server RPCs also have competing `can_create()` vs `has_area()` definitions. | CONFIRMED | DECISION + server align. |
| P2-2 | RBAC | `reports.html`/`insights.html` hardcode `["admin","manager","planner"]`, bypassing the configurable matrix; finance P&L suppression is **client-side only** (underlying `summary/pl` calls depend on RLS). | CONFIRMED | DECISION + confirm RLS. |
| P2-3 | Control Center | **Catering GST %** is saved but the engine applies one `gstPct` to everything and forces catering GST to 0 — a dead, misleading setting. | CONFIRMED | DECISION (wire it or remove it). |
| P2-4 | Settlement/Closure | Two different profit definitions: settlement **Final margin excludes** staff expense claims; closure **Profit includes** them. P&L also ignores refunds/recoveries. | CONFIRMED | DECISION (pick one; include expenses + refunds). |
| P2-5 | Lifecycle | `event.html` stepper lets a stage **jump anywhere** with no precondition (unpriced → "Closed"); stage vs status can desync. | CONFIRMED | DECISION (gate forward transitions). |
| P2-6 | Workspace | `flow.html` proposal save sends empty palette/images → can **wipe** palette/images set in `proposal.html` if the RPC overwrites. Optimistic-lock is partial (venue/quotation/builder write-backs are last-write-wins; one silently swallows errors). | CONFIRMED | DEFERRED — fix + staging-verify. |
| P2-7 | Requirements | `flow.html` writes requirements as `{title}`, `discovery.html` as `{service}` — same table, different columns → entries invisible on the other screen (or a 400). | CONFIRMED | DEFERRED — normalize the column. |
| P2-8 | Calendar | Venue clash needs date+time+name+address **all exactly equal** (no time-overlap); non-venue checks skip undated events → real double-bookings missed. | CONFIRMED | DEFERRED (matches the known time-aware-calendar deferral). |
| P2-9 | Inventory | Partial re-check-in uses **total issued, not remaining**, for write-off math; over-commit dialog promises a calendar flag that never fires for undated events. | CONFIRMED | DEFERRED. |
| P2-10 | Tasks | Checklist template apply **was** non-idempotent (duplicated items). | CONFIRMED | **FIXED** this session (dedup by section+title). |

### P3 — polish / low-risk (representative; full list in the per-domain notes)
Account-enumeration on the sign-up path (neutral message needed); store password min 8 vs policy 12; `passwordChangeRequired()` fails open; builder live-panel vs capacity seat-count mismatch for chiavari/barstool; no autosave in the quote builder (manual save only); client-side quote-code collision race; advance payment not bounded by total; settlement no client overpay bound; simulated OTP shown on-screen gated only by `liveChannels.sms`. Several small ones **fixed** this session (leads toast, nurture toggle, vendor date, builder catering mode).

---

## 3. Independent external blockers (unchanged, not code defects)
Live browser E2E / a11y / perf / load (needs a **staging** preview URL that resolves
to `xizehqgeyjcfpzrdymly`); observability activation + alert test; DR restore drill;
live provider keys (Razorpay/WhatsApp stay deferred/fail-closed); enable Supabase
leaked-password protection; GitHub branch protection + Action SHA-pinning.

---

## 4. Verdict

**READY FOR PRODUCTION REVIEW: YES** — the security/data-integrity core (RLS, tenant
isolation, server pricing authority, payment cap, OTP/token, storage) is proven, CI is
green, and the open items are enumerated with evidence.

**READY FOR CONTROLLED PRODUCTION DEPLOYMENT: NO.**

Remaining blockers before a controlled go-live of the full event lifecycle:
1. **P1-1** settlement Received/Balance must count the payments ledger (money shown wrong today).
2. **P1-2** server-side close gate (balance/equipment) — client warning is not enough on its own.
3. **P1-3** inventory availability must account for outstanding check-outs (double-allocation).
4. **P2-1/P2-2** decide and align the RBAC authority (matrix vs role-caps vs server RPC) and confirm finance RLS.
5. Live **staging** E2E of the authed journeys (login → create → price → confirm → close) — not yet run; needs the staging URL.
6. Observability active + alert-tested; DR restore drill; branch protection — operational gates.

Items **P2-3/P2-4/P2-5** need a one-line product decision from you (catering GST,
profit definition, stage gating) before I change those behaviors.
