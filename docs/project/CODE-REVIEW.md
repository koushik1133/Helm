# Helm — Code Review Report (review only, no code changed)

Snapshot: `origin/main` @ `0bf8eb05` (merge of PR #170, release/oct17-final), reviewed 2026-10-17.
Scope: `public/`, `supabase/migrations` + `supabase/functions`, `server.js`, `vercel.json`, `scripts/`, `test/`, `package.json`.
This is a findings list with suggested fixes. Nothing here has been changed. Where a fix touches data, it must follow the
zero-data-loss rule: additive, idempotent migrations only, no deletes or overwrites of live rows.

## 1. Summary

Helm works and is heavily guarded by tests and CI checks (CSP hashes, migration canon, env safety, JWT roles, pinned
actions). The main debt is **size and duplication on the front end**, plus a few **"two ways to do the same thing"**
areas left over from incremental fixes. None of these is a known live bug; they raise the cost and risk of every future change.

| Priority | Count | Theme |
|---|---|---|
| P1 (fix next) | 4 | store-api.js monolith, two stock systems, two vendor-pay paths, asset version-pin gaps |
| P2 (plan) | 6 | tracked node_modules symlink, CSS "polish" layering, 44 MB hero videos in deploy, inline scripts in HTML, monolithic test script, client-side fallbacks for missing RPCs |
| P3 (hygiene) | 5 | root-level doc sprawl, duplicate settlement math, NEXT_PAGES allowlists, legacy `BP*` naming, migration MANIFEST drift risk |

## 2. Size hotspots (verified with `wc -l`)

| File | Lines | Note |
|---|---|---|
| `public/store-api.js` | 10,574 | Single data layer for every page: auth, quotes, inventory, vendor bills, audit, settlement, shell loader. 532 `function` declarations. |
| `public/builder.js` | 4,950 | 2D floor-plan builder. |
| `public/builder-3d.js` | 2,028 | 3D view. |
| `public/control.html` | 1,996 | Control Center, with large inline script. |
| `public/auth-ui.js` | 1,721 | |
| `public/flow.html` | 1,560 | Inline script. |
| `public/shell-b-dash.js` | 1,528 | |
| `public/photo-render-prompt.js` | 1,207 | |
| `public/quotes.html` | 1,113 | Inline script. |

Totals: 74 HTML pages, 100 JS files, 85 CSS files in `public/`; 159 SQL migrations (latest `0162_launch_bypass_off.sql`); 20 edge functions.

## 3. Findings (prioritised)

### P1-1 `store-api.js` is a 10.5k-line monolith
- Evidence: `public/store-api.js` holds every domain (inventory at ~L4000-4180, settlement at ~L6620, vendor bills at ~L6750-6890, audit labels at ~L7920, audit event resolution ~L8084) and also bootstraps the shell (`L1-3` injects `/shell-proto.js`).
- Risk: every page downloads and parses all of it; any edit forces a cache bust for every page; merge conflicts; hard to review.
- Suggested fix: split into domain modules without changing the public `BPStore.*` surface (e.g. `store-core.js`, `store-inventory.js`, `store-money.js`, `store-audit.js`), loaded by a tiny core that keeps the same global. Do it one domain at a time, each behind the existing tests. Vanilla JS only (React migration was discarded; do not re-propose).

### P1-2 Two stock systems (reservations vs checkouts)
- Evidence: `inventory_reservations` + `reserve_inventory` / `return_reservation` RPCs (store-api.js ~L4011-4030, migration 0070) and separately `inventory_checkouts` + `checkout_equipment`, `checkout_equipment_smart`, `checkout_availability`, `checkin_equipment`, `cancel_checkout`, `worker_checkin_equipment` (store-api.js ~L4155-4175, `checkout-shortage.js`). `event_stock_requests` is a third adjacent table.
- Risk: "available" can mean different things on different screens. A prior audit already found availability ignoring checkouts (memory: E2E audit Oct 2026, "inventory availability ignores checkouts"). `inventory.html:645` re-implements availability math client-side for older DBs.
- Suggested fix: define one server-side availability function (reserved + checked-out − returned, per date window) and make every screen read it. Keep both tables (no data removal); treat reservation as "planned" and checkout as "physical" states of one lifecycle. Remove the client-side math fallback once all DBs have the RPC.
- Decision needed: is a reservation automatically converted to a checkout at dispatch, or are they independent?

### P1-3 Two vendor-payment paths
- Evidence: (a) booking-level vendor data in the settlement summary — `vendorCost`, `vendorAdvance`, `vendorOutstanding`, per-booking `settled` flag (store-api.js ~L6625-6640); (b) `vendor_bills` + `vendor_payouts` with `record_vendor_payout` and `vendor_payables_summary` (migration 0124; store-api.js ~L6750-6890). `applyBills` overlays (b) on top of (a) and shifts `finalMargin` by a delta; `settlement.html:209` documents the bug this patched (fully-paid bills still showing as owed).
- Risk: two sources of truth for "owed to vendors"; margin depends on an overlay that silently returns 0 if the bills read fails (`catch (_) { return 0; }`), so the page can show a wrong margin with no warning.
- Suggested fix: make bills/payouts the single ledger. Migrate (additively) each booking's advance into a payout row with a marker, then compute owed/margin server-side in one RPC. Until then, show a visible "vendor bills could not be loaded" notice instead of a silent zero delta.
- Decision needed: should "Settle" on a booking create a payout row, or be retired?

### P1-4 Asset version-pin tooling gap (`/shell-proto.js` pin and others)
- Evidence: `store-api.js` L3 hard-codes `"/shell-proto.js?v=17"`. `scripts/bump-changed-assets.mjs` bumps `?v=` in HTML and the shared `SHELL_V` constant inside `shell-proto.js` (currently `"116"`, L28), but has no rule for the shell-proto pin embedded in `store-api.js`. Also `store-api.js` itself is pinned inconsistently across pages: `?v=234` on 53 pages, `?v=4` on 53 occurrences, `?v=1` on 4, `?v=7` on 3.
- Risk: an edit to `shell-proto.js` ships with the old `v=17` URL, so browsers and the CDN keep the stale file; pages on old store-api pins can run stale data-layer code next to new shell code.
- Suggested fix: add the `store-api.js -> shell-proto.js` pin to the bump script's constants list, and a CI check (`npm run ci`) that fails if any file references a local asset with a version different from the canonical one. Longer term, use content hashes generated at build time.

### P2-1 Tracked `node_modules` symlink
- Evidence: `git ls-files -s` shows `node_modules` as mode `120000` (symlink) pointing to `../wt-invite/node_modules`.
- Risk: fresh clones and CI get a dangling link; local worktrees silently share dependencies with another worktree; Vercel has `installCommand: null`, so builds could depend on it by accident.
- Suggested fix: `git rm --cached node_modules`, add `node_modules/` to `.gitignore`, run `npm ci` per worktree. (Removes only the tracked link, no data.)

### P2-2 CSS layering by "-polish" files
- Evidence: 85 CSS files; one `*-polish.css` per page (`quotes-polish.css`, `settlement-polish.css`, ...), plus `*-v2.css`, `shell-b-theme-luxe.css`, `shell-b-theme-studio.css`, `theme.css` (604 lines), `home.css` (1,227).
- Risk: specificity battles and dead rules; dark-mode rules may still exist although dark mode is off (default theme Emerald).
- Suggested fix: fold each page's polish file into its base stylesheet; run a coverage pass to drop unused selectors and unused theme variants. Keep `scripts/extract-inline-styles.mjs --check`.

### P2-3 Large media inside the static deploy
- Evidence: `public/home-assets` is 44 MB (`hero-hq.mp4` 17 MB, `hero-hq.webm` 15 MB, `hero.mp4` 6.4 MB, `hero.webm` 4.5 MB); `public/mk` 3.1 MB.
- Risk: slow deploys, repo bloat, heavy first load on mobile if the HQ variant is chosen.
- Suggested fix: serve the hero from object storage/CDN, keep one compressed variant per codec, `preload="none"` + poster image. Assumption: the landing page already picks the smaller variant on mobile; verify.

### P2-4 Business logic in inline `<script>` blocks
- Evidence: `control.html`, `flow.html`, `quotes.html`, `settlement.html`, `inventory.html` carry large inline scripts; CSP relies on generated hashes (`scripts/gen-csp.mjs`, `docs/CSP-UNSAFE-INLINE-AUDIT.md`).
- Risk: every inline edit changes a CSP hash; logic cannot be cached or unit-tested on its own.
- Suggested fix: move page scripts to `public/<page>.js` files incrementally; this also shrinks the CSP hash list.

### P2-5 Single 247-file test command
- Evidence: `package.json` `"test"` is one `&&` chain of ~240 `node test/*.test.mjs` calls; many are round/date-named (`r10-hotfix`, `retest2-1017`, `audit-1017`).
- Risk: first failure hides the rest; slow; hard to see which area broke; easy to forget to add a new test to the chain.
- Suggested fix: a small runner (`scripts/run-tests.mjs`) that globs `test/*.test.mjs`, runs all, prints a summary. Group or rename round-numbered tests by feature over time.

### P2-6 Client-side fallbacks for missing RPCs
- Evidence: patterns like `rpcMissing(e)` returning null (store-api.js L6882), "older DB without checkout_availability: same math client-side" (`inventory.html:645`), non-atomic reserve fallback (store-api.js ~L4029), `vbMissingErr` "needs database update 0124".
- Risk: prod and staging can behave differently depending on which migrations ran; client fallbacks bypass server authority (row locks).
- Suggested fix: once prod and staging both have all migrations (see `supabase/migrations/MANIFEST`), remove fallbacks and fail closed with a clear "database update required" message.

### P3-1 Root-level document sprawl
- ~24 `*.md` reports at repo root (`PROGRESS.md`, `REMINDERS.md`, `STAGING-PRECHECK.md`, several `*-REPORT.md`) plus `docs/` and `_plans/`. Suggest moving point-in-time reports to `docs/archive/` and keeping root to `README.md` + runbook links.

### P3-2 Duplicate settlement/margin math
- Margin is computed in the settlement summary, re-adjusted by `applyBills`, and recomputed for the event workspace and P&L. Suggest one server RPC returning the full settlement figures (pairs with P1-3 and the open "settlement Received reads milestones not ledger" item).

### P3-3 Hand-maintained page allowlists
- `NEXT_PAGES` (store-api.js L471), the shell allowlist in `shell-proto.js`, and `vercel.json` rewrites each list pages separately. Suggest one shared list checked by `test/vercel-routing.test.mjs`.

### P3-4 Legacy naming
- Globals `BPStore`, `BPUI` (from "Blueprint") alongside "Helm" names. Low risk; document the mapping or alias `HelmStore = BPStore` if renaming.

### P3-5 Migration manifest drift
- 159 SQL files vs 263-line `MANIFEST`; correctness depends on `scripts/check-migration-canon.mjs`. Keep that check in CI and add a reminder that new SQL also needs `APPLY-PENDING` regeneration and staging-then-prod application.

## 4. Performance notes
- Every signed-in page loads `store-api.js` (~10.5k lines) plus the shell (`shell-b*.js/css`, async=false chain in `shell-proto.js` L42). Splitting P1-1 gives the biggest win.
- `test/boot-perf.test.mjs` and `lighthouserc.json` exist; add a byte budget for `store-api.js` and the shell bundle.
- Hero video (P2-3) dominates landing page weight.
- Supabase client is self-hosted and pinned (`public/vendor/supabase-js-2.117.2.min.js`): good, no change.

## 5. Things that are in good shape
- Server-side pricing authority and money tests (`test/money-trust-boundary`, `pricing-differential*`).
- CI guards: pinned actions, CSP hashes, env safety, JWT roles, OTP safety, deferred integrations (Razorpay/SMS/WhatsApp off).
- Vendor bills are never hard-deleted (void with reason, store-api.js L6751), which matches the zero-data-loss rule.

## 6. Suggested order
1. P1-4 version-pin check (small, prevents stale deploys).
2. P2-1 remove tracked symlink.
3. P1-3 vendor single ledger (needs decision).
4. P1-2 one availability function (needs decision).
5. P1-1 split store-api.js domain by domain.
6. P2 items as capacity allows.
