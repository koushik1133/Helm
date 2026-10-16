# PROD SQL bundle - October 2026 (staging -> production catch-up)

Target: PROD `nqltzgiwznphugcfhmbm`. Everything here was already run on STAGING
(`xizehqgeyjcfpzrdymly`), except 0125 (not yet run anywhere) and 0117 (do not run yet).
All files are additive + idempotent (safe to run twice). No DROP TABLE / DELETE / TRUNCATE of real data.
All files are pure ASCII (0122 builds special characters with `chr()`), but still copy with
`LANG=en_US.UTF-8 pbcopy < file` - plain `pbcopy` once garbled "Demo ·" on staging.

## Order (paste one file at a time into the SQL editor; every VERIFY row must say ok = true)

| Step | File | What it does, in plain words | Needs first |
|---|---|---|---|
| 00 | `00-PRECHECK.sql` | Read-only. One row per change: true = already on this DB, false = must run. Also checks prerequisites (PREREQ rows must all be true). | - |
| (opt) | `optional-0108-0115-run-only-if-precheck-false/APPLY-01xx.sql` | Dashboard money, dashboard prefs, overpay cap incl. changes, booklet totals, confirmed_at stamp, insights ex-tax, booklet change lines, task requeue. **Run ONLY the ones whose precheck rows are false**, in number order. | - |
| 02 | `02-BACKUP-function-defs.sql` | Read-only. Prints current definitions of every function this bundle replaces. **Download the result as CSV and keep it** - this is your rollback. | - |
| 10 | `10-APPLY-0116.sql` + VERIFY | "Start free trial" -> a "Demo N" studio with sample data, trial end date on the studio, studio becomes read-only (not deleted) after the trial until a plan is chosen. Adds `organizations.trial_ends_at`. | create_studio, 0045, 0097+0100 |
| 11 | `11-APPLY-0118.sql` + VERIFY | `start_trial(timezone, currency)` - trial studio uses the visitor's time zone + currency. | 0116 |
| 12 | `12-APPLY-0119.sql` + VERIFY | One unified trial for every self-serve sign-up, length set in `helm_billing_settings.trial_days` (default **8**). `my_start_trial` / checkout now use it instead of 14. New `start_self_serve_trial`. | 0116, 0118, 0054, 0056, 0058 |
| 13 | `13-APPLY-0120.sql` + VERIFY | Trial reminders (3 days left / tomorrow / today) as bell notifications; e-mails stay dormant until comms is switched on. New table `trial_reminders`; hourly cron only if pg_cron exists. | 0058, 0116, 0119 |
| 14 | `14-APPLY-0121.sql` + VERIFY | New read-only `dashboard_due_today()` - milestones due today on the dashboard. | 0108 |
| 15 | `15-APPLY-0122.sql` + VERIFY | Fixes garbled "Demo ·" text in trial functions; repairs only is_demo rows in trial studios; lead history records the lead's own studio. | 0116, 0119 |
| 16 | `16-APPLY-0123.sql` + VERIFY | `my_demo_status()` also returns counts of sample rows (read-only). | 0097 |
| 17 | `17-APPLY-0124.sql` + VERIFY | Vendor bills, vendor payouts (idempotent, never deleted), event P&L, business P&L. New tables only. | 0049, 0101, 0116 |
| 18 | `18-APPLY-0125.sql` + VERIFY | Lead edits appear in the Audit log; fixes "exceeds the outstanding balance" when paying a milestone's exact remaining balance. | 0042, 0110 |
| - | `DO-NOT-RUN-YET/APPLY-0117.sql` | Per-studio Razorpay / WhatsApp accounts. Integrations are dormant. Run only when integrations go live, after staging. | - |

**0125 WARNING:** 0125 has not run on staging. Run it on STAGING first, check VERIFY-0125 all true and
pay one milestone's exact remaining balance successfully. Only then run step 18 on prod.

After the last step, re-run `00-PRECHECK.sql`: every row true except the 0117 row (false is correct).

## Expected results
- Each APPLY ends with its VERIFY select (or run the matching `NN-VERIFY-xxxx.sql`): every `ok` = true.
- If an APPLY stops with `0119: apply 0116 + 0118 ... first` (or similar), a prerequisite is missing -
  stop, re-run the precheck, nothing was half-applied (the guard runs before any change).

## Rollback / backout
- **Functions:** paste the saved `def` text from step 02's CSV for that function and run it. That restores the exact previous body (same signature).
- **New functions** (start_trial, start_self_serve_trial, dashboard_due_today, event_pnl, ...) can stay - nothing calls them unless the new frontend does. Leave them rather than drop.
- **New tables / columns** (trial_reminders, vendor_bills, vendor_payouts, organizations.trial_ends_at, helm_billing_settings.trial_days): leave in place (zero data loss). They are harmless when unused.
- **To undo the 8-day trial length only:** `update public.helm_billing_settings set trial_days = 14;` (settings value, not data).
- **0125 leads audit trigger:** `drop trigger if exists audit_trg on public.leads;` (removes only the trigger; audit rows already written stay).
- **If a trial studio gets locked unexpectedly:** extend it from HQ (hq_set_subscription trial end) - never delete it.

## Will running this BEFORE the new frontend is deployed break the live (old, origin/main) frontend?
Short answer: **no breakage; two behaviour changes the old UI will show slightly wrong text for.**

| Thing the old frontend calls | Change | Effect on old frontend |
|---|---|---|
| `my_start_trial(p_source, p_plan)` (checkout.js "Start 14-day free trial") | Same signature + result shape. Trial length now `trial_days` = **8**, and it also sets `organizations.trial_ends_at`. | Works. Old page still SAYS "14-day"; the real trial is 8 days, and after it the studio turns read-only (error 25006, hint `trial_ended`). Old store-api already maps 25006 to "read-only ... trial has ended". Existing studios/subscriptions are not changed. |
| `my_checkout_options()` | Reads trial_days instead of 14. Same keys. | Works. |
| `my_trial_status()`, `my_demo_status()` | my_trial_status unchanged; my_demo_status adds a `counts` key only. | Works (extra key ignored). |
| `tg_studio_read_only` (trigger on writes) | Adds "ended trial -> read-only" branch, only for studios with `trial_ends_at` set (none today, since the old UI never set it). | No effect on existing studios. |
| `start_trial`, `my_trial_org`, `dashboard_due_today`, vendor bills/P&L | New, not called by old frontend. | None. |
| `archive_lead`, `enforce_no_overpayment_ms`, leads audit | Same signatures; bug fixes. | Old UI benefits (milestone full-balance pay now works). |

**Recommended safe order:**
1. Precheck + backup (00, 02) on prod.
2. Run SQL 0116 -> 0124 on prod (old frontend keeps working).
3. Deploy the new frontend (it needs these functions; deploying it first would show "missing function" fallbacks on the trial/dashboard/vendor-bill screens).
4. Run 0125 on staging, test, then on prod (independent of frontend; can go any time after).
5. Optional: if you want the old checkout's "14-day" text to stay true until the new frontend is live, run step 3 the same day as step 2, or temporarily set `trial_days = 14` and set it back to 8 at deploy.
