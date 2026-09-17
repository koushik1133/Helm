# Remind me later — Blueprint Stage backlog

Running list of things deferred on purpose. Add to this whenever something is
parked. (Kept out of the phase flow; pick up when ready.)

---

## ✅ 1. P&L overstates profit when actuals are only partly entered — FIXED 2026-09-17
- **Where:** `public/store-api.js` → `closure.pl()` (`const cost = s.actCost || s.estCost`).
- **Problem:** the moment ANY cost line has an `actual` value, `actCost` becomes
  truthy and the whole P&L uses it — so every line still left as *estimate only*
  silently drops out of "cost". Profit looks bigger than it is.
- **Fix idea:** cost = per-line `actual ?? estimated`, summed — i.e. use the actual
  where entered and fall back to the estimate line-by-line, not all-or-nothing.
  Apply the same line-by-line logic to `budget.summary` `actCost` so budget & P&L agree.
  **Done:** added `finalCost` = per-line `actual ?? estimated` + approved change cost
  + un-imported vendor spend; P&L and settlement "Final margin" now use `finalCost`.

## ✅ 2. Vendor spend can vanish from margin / P&L — FIXED 2026-09-17
- **Where:** `store-api.js` `budget.summary` / `settlement.summary` / `closure.pl` —
  costs are read from `event_costs` only. Vendor bookings (`event_resources`) count
  **only if** someone clicked "Import vendor bookings" on the Budget page.
- **Problem:** forget that one click and the vendors' cost is missing from cost →
  profit/margin overstated.
- **Fix idea:** fold vendor booking costs into the cost total automatically (or
  auto-import on load), and de-dupe against any already-imported lines.
  **Done:** `budget.summary` now folds in any non-cancelled vendor booking whose
  cost isn't already an `event_costs` line (deduped by `booking_id`), into estCost
  and finalCost — so vendor spend counts even if "Import vendor bookings" was never clicked.

## 3. (also deferred earlier) Time-aware calendar — Phase 10b
- Reverted at commit `ff7646b`. Re-add event start/end times + overlap-based
  (not whole-day) conflict detection, and make `resources.check` schedule-aware.

---

_Fixed on 2026-09-17 instead of deferring: Readiness empty-passes, Inventory over-commit guard._
