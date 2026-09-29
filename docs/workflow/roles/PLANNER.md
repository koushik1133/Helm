# PLANNER

**Purpose:** the core builder — discovery, pricing, layout, proposal, and (in this build) recording the advance payment.
**Login:** email/password (`planner.a@…`; Password: [REDACTED TEST CREDENTIAL]). **Landing:** dashboard.html.
**Caps:** view, create, edit, delete. Server: in `can_create()` and `can_edit()`.

**Primary work on the SAME quote:**
1. Discovery (`set_discovery`) — event details/requirements.
2. Pricing / version (`save_quotation_version`) — server recomputes the total from raw inputs; client-supplied totals are ignored (tampered `total:1` → recomputed).
3. Builder/layout — save a layout version.
4. Proposal — publish; a scoped share token is minted for the client.
5. Payment — record the advance (`record_payment`, idempotent).

**Creates/updates:** discovery, quotation_versions, quote_versions (layout), proposal, quote_payments. **Cannot:** close (manager/admin authority).

**Handoff:** ← Sales (quote) → **Client** (proposal + approval) → **Operations** (planning).

**Verified:** lifecycle stages 02–07 green ×3 browsers; pricing 924-case differential 0 mismatches.
**Screenshots:** `screenshots/03-planner/01…05` (dashboard, quotes, discovery, proposal, builder). **Status:** PASS.
