# Production rollout runbook — Wave 15B + Wave 16

**Target:** production Supabase `nqltzgiwznphugcfhmbm`. Everything here is **additive & idempotent** (CREATE OR REPLACE / IF NOT EXISTS) and was applied + verified on staging (`xizehqgeyjcfpzrdymly`) first.

**Claude does NOT run any of this against production.** You run it in the prod Supabase SQL editor. These steps are hard to reverse — take a backup first.

## Order of operations
1. **Backup.** Supabase dashboard → Database → **Backups** → take (or confirm today's) snapshot. On the free tier, if snapshots aren't available, at minimum export the affected tables (`quotes`, `quote_payments`, `inventory_items`) or upgrade first (see the quota note in chat).
2. **PROD-00-PRECHECK.sql** — run it. It's read-only and now shows ONLY the blocker counts (one result set). Negative inventory is fine — PROD-01 auto-clamps it to 0. Only a non-zero **quote_payments.amount <= 0** count needs a manual look (PROD-01 will skip just that one constraint with a NOTICE rather than fail).
3. **PROD-01-APPLY.sql** — paste + run the WHOLE file. It is **idempotent and safe to re-run** (CREATE OR REPLACE / IF NOT EXISTS / guarded), so re-running after a partial failure simply finishes the job. It: applies W15B-01/04/05/06 + W16-02 (**manager create/settle/close**) + W16-03/04 (overpayment guard across both payment tables), then **auto-clamps negative inventory to 0** and adds the W16-01 CHECK constraints (skipping the payments one only if amount<=0 rows exist). Note: Supabase's SQL editor shows only the last statement's output — that's expected; run VERIFY to confirm.
4. **PROD-02-VERIFY.sql** — run it. It's now a **single result set**; every row must read **PASS** (the payments-CHECK row may read SKIPPED if you have amount<=0 rows to clean). It no longer aborts.
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
