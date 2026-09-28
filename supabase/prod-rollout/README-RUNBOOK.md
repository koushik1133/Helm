# Production rollout runbook — Wave 15B + Wave 16

**Target:** production Supabase `nqltzgiwznphugcfhmbm`. Everything here is **additive & idempotent** (CREATE OR REPLACE / IF NOT EXISTS) and was applied + verified on staging (`xizehqgeyjcfpzrdymly`) first.

**Claude does NOT run any of this against production.** You run it in the prod Supabase SQL editor. These steps are hard to reverse — take a backup first.

## Order of operations
1. **Backup.** Supabase dashboard → Database → **Backups** → take (or confirm today's) snapshot. On the free tier, if snapshots aren't available, at minimum export the affected tables (`quotes`, `quote_payments`, `inventory_items`) or upgrade first (see the quota note in chat).
2. **PROD-00-PRECHECK.sql** — run it. It's read-only. **Requirement to proceed:** every `*_violations` count must be **0**. If any is > 0, clean those rows first (e.g. an inventory item with negative stock, or a genuinely overpaid quote) — do NOT force the constraint over live bad data. The informational rows tell you what's already applied (safe to re-apply regardless).
3. **PROD-01-APPLY.sql** — paste + run. Bundles, in safe order: W15B-01 (server pricing authority / W15-001), W15B-04 (worker-token expiry + retention), W15B-05 (OTP CSPRNG, worker RPC expiry/revoke, portal/proposal expiry, FK RESTRICT), W15B-06 (pricing bypass harden), W16-02 (**manager create/settle/close** — a privilege change you approved), W16-03 (overpayment guard), W16-01 (input CHECK constraints — last, needs PRECHECK clean).
4. **PROD-02-VERIFY.sql** — run it. Every row must read **PASS**. (The first statement is expected to ERROR with `22023` — that IS the pass for the pricing-bypass harden; run the remaining block for the PASS/FAIL table.)
5. **Smoke** the live app: create a quote, record a valid payment, attempt an overpayment (should be blocked), confirm a client approval still works.

## Rollback
- Functions are CREATE OR REPLACE — to revert a function, re-apply its previous definition from git history.
- `supabase/wave15b/W15B-03-ROLLBACK.sql` reverts the pricing-authority function.
- Drop the additions if needed: `drop trigger trg_no_overpayment on public.quote_payments;` and `alter table … drop constraint inventory_items_total_qty_nonneg;` (etc. for the 3 W16-01 checks).
- To revert manager authority: re-apply the pre-W16-02 `can_create`/`can_edit` (remove `'manager'`).

## Notes
- The `role_access` matrix (per-area view/edit) is **data**, configured per environment in **Control Center** — it is NOT in this bundle. Configure prod's matrix there (the grant table Claude provided) if prod needs the same role layout.
- Client-side code (store-api.js validators, input hardener, RBAC button map, a11y, perf) ships with the normal front-end deploy (Vercel static) — this bundle is DB-only.
- Deferred integrations (Google OAuth, MSG91 SMS/OTP, Razorpay, WhatsApp) are **not** part of this rollout.
