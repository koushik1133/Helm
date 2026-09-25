# Pricing authority — MONEY-01 / MONEY-02 decision table (Wave 6, Agent 7)

**Status: PRODUCT DECISION REQUIRED.** This document does **not** choose tax/business
rules — it lays out what the code does today, where the two calculators disagree,
and the exact decisions a human must make before Agent 8 can implement a single
server-authoritative pricing engine.

## Evidence base (current code)

- `public/store-api.js` `pricing.quoteTotal(p)` — lines ~659–682.
- `public/store-api.js` `pricing.breakdown(inp, rates)` — lines ~684–709.
- `supabase/phase77-quotation-versions.sql:42` — `save_quotation_version` stores
  `tot := (p_pricing->>'total')::numeric` **verbatim** (no recompute).
- `supabase/otp-payments.sql:290` — payment/approval amount
  `amt := (q.pricing->>'total')::numeric` — the **client-computed total is what the
  client is asked to pay**.

## MONEY-02 (financial authority) — the headline

**The browser computes the total; the server stores and charges it without
recomputing.** `save_quotation_version` and the payment/OTP flow both read
`pricing.total` straight from the client-supplied JSON. A tampered browser total
becomes the stored total and the amount presented for payment.
→ This is a **real integrity gap**, independent of which formula is "right".

## MONEY-01 (the formula) — the two calculators disagree

There are **two** total functions with conflicting comments ("THE ONE authoritative
money calc" vs "THE unified breakdown") that produce **different numbers** for the
same event:

| Aspect | `quoteTotal` | `breakdown` |
|---|---|---|
| Cost model | chairs + catering + `other` (flat) | chairs + **objects** + catering + **layoutBase** |
| Service-charge base | (rental + cateringBucket) × svc% | (chairs+objects+catering+layoutBase) × svc% |
| Fixed discount | yes | yes (capped at subtotal) |
| **Percent discount** (`discountPct`) | **yes** | **no** |
| **Coupon** (percent/fixed) | **yes** | **no** |
| **GST base** | **pre-discount** (rental+svc, + catering) | **post-discount** (subtotal − discount) |
| **Catering-specific GST** (`catering.gstPct`) | **yes** | **no** (single gstPct) |
| **CGST/SGST/IGST split** (`placeOfSupply`) | **yes** | **no** |
| Rounding | `round(grand)` only | `round(serviceCharge)`, `round(gst)` |

Because the stored `pricing.total` comes from whichever path wrote it, the same
quote can persist different totals depending on entry point (confirm modal vs
builder write-back).

---

# PRICING DECISIONS REQUIRED

For each: **Option A / Option B**, current behavior, impact, and the recommended
**technical** consequence. The business/tax choice is yours — do not infer it from
this doc.

### D1 — GST on pre-discount or post-discount base?
- **A. Post-discount** (GST on taxable value after discount). *Recommended technically*
  — matches how `breakdown` already works and the common Indian-GST treatment of
  discounts known at time of supply. Lowers GST when discounts apply.
- **B. Pre-discount** (GST on gross, then subtract discount) — current `quoteTotal`.
- **Current:** inconsistent (quoteTotal=pre, breakdown=post).
- **Impact:** changes GST amount and grand total on every discounted quote.
- **Technical consequence:** pick one; unify both calculators to it.

### D2 — Which cost model is canonical?
- **A. Object-based** (`breakdown`: chairs + priced objects + catering + layoutBase).
  *Recommended* — reflects the builder's actual placed items and `assetPrices`.
- **B. Flat** (`quoteTotal`: chairs + catering + a single `other` amount).
- **Current:** both exist; diverge when objects are placed.
- **Impact:** determines whether placed equipment (stage, LED, mandap, …) is priced.
- **Technical consequence:** collapse to one function; delete/redirect the other.

### D3 — Do coupons and percent-discounts apply everywhere?
- **A. Yes** — support fixed + percent discount + coupon in the single engine.
- **B. No** — fixed discount only.
- **Current:** only `quoteTotal` supports percent/coupon; `breakdown` ignores them,
  so builder-saved totals silently drop coupon value.
- **Impact:** whether a coupon actually reduces the stored/charged total.
- **Technical consequence:** define coupon stacking order (see D4).

### D4 — Discount / coupon **stacking order**
- Define the exact sequence, e.g.: line items → service charge → **fixed discount →
  percent discount → coupon** → discount cap (min of total) → GST → round.
- **Current:** `quoteTotal` adds fixed + subtotal×pct + coupon together then caps;
  `breakdown` applies fixed only.
- **Decision needed:** order and whether percent/coupon compound or are additive.

### D5 — Catering tax: single GST rate or separate catering rate?
- **A. Single** `gstPct` for everything (simpler).
- **B. Separate** `catering.gstPct` (current `quoteTotal` supports it; food can carry
  a different GST rate).
- **Impact:** GST total when catering is in-house.

### D6 — Interstate CGST/SGST/IGST split
- **A. Keep** `placeOfSupply` → CGST+SGST (intra) or IGST (inter) — needed only if you
  invoice across state lines.
- **B. Drop** — single GST line (most event businesses are intra-state B2C).
- **Current:** only `quoteTotal` splits; `breakdown` has no split.
- **Impact:** invoice/tax presentation, not the grand total.

### D7 — Rounding rule & currency precision
- Decide: round **each component** or **only the final total**; rounding mode
  (half-up vs banker's); integer rupees vs 2-decimal paise.
- **Current:** mixed (`breakdown` rounds service charge and GST separately;
  `quoteTotal` rounds only the grand). Can cause ₹1–2 drift between the two.

### D8 — Server-side authority (MONEY-02) — how strict?
*(Technical decision; depends on D1–D7 producing one canonical formula.)*
- **A. Server recomputes and is authoritative.** *Recommended.* The DB recomputes
  the total from stored line items + `get_pricing_config()` (org-scoped) inside
  `save_quotation_version` / at payment time; the client total becomes advisory and a
  mismatch is rejected or overwritten. Requires the canonical formula to exist in SQL.
- **B. Server validates within tolerance** — recompute and reject if the client total
  differs by more than ₹X.
- **C. Keep client-authoritative** (status quo) — *not recommended*; leaves the tamper
  gap open.
- **Impact:** closes MONEY-02. Needs D1–D7 settled first so the SQL matches the UI.

---

## What happens after decisions arrive (Agent 8 plan — not yet implemented)

1. Encode the single canonical formula once (shared JS used by both entry points;
   mirrored in a SQL function).
2. Make the server recompute (D8) inside `save_quotation_version` and the payment
   amount source (`otp-payments.sql` amt), reading `get_pricing_config()`.
3. Client total becomes advisory; mismatches rejected/logged.
4. Add a forward-only migration (`WAVE-06-*` + `phaseNN`), **SOURCE PREPARED** only —
   not applied to production until you approve.
5. Financial red-team (Agent 9): tampered total/subtotal, fake discount/coupon,
   negative/huge quantity, malformed JSON, stale quote, direct RPC.

## Until decisions arrive

**MONEY-01 remains BLOCKED — PRODUCT PRICING DECISION REQUIRED.**
No pricing code is changed in this wave. This does not block the other Wave 6
workstreams.
