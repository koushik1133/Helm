# Net-New Builds — Delivered (staging-verified)

All four net-new features from `NET-NEW-BUILD-SCOPE.md` are built, runtime-verified on **staging** (`xizeh…`, synthetic data), and committed to `koushik1133/Helm`. **Production, praneeth, www.helm.events, and helm-v01 were not touched.** Idempotent prod SQL is bundled for you to run.

## What shipped

| # | Feature | DB | Frontend | Runtime-verified on staging |
|---|---|---|---|---|
| 3 | **My-Tasks buckets** | `my_tasks()` RPC + index (no schema change — uid→crew join) | dashboard "My tasks" section (Today/Overdue/Blocked/Completed) | ✅ bucketing correct (JWT), anon 401, cross-org isolated |
| 1 | **Designer role + 2D→3D state machine** | `designer` role, `design` area, `design_stages` table, `design_advance/get/queue` RPCs | `design.html` studio + `builder.html` design chip | ✅ full happy path, revise loop-back + revision bump, illegal-transition reject (400), anon 401 |
| 2 | **Bespoke per-role dashboards** | none | data-driven workspace board for all 11 roles | ✅ parses; reuses verified RPCs |
| 4 | **Per-event file storage** | private `event-docs` bucket, storage RLS ×4, `event_files` table, `list_event_files()` RPC | Attachments panel on `event.html` (magic-byte upload, signed-URL download) | ✅ cross-org object 400, anon 400, org-B→org-A upload 400, cross-org metadata insert 403 |

## Security notes (Build 4 is the touchy one)
- Bucket is **private**; objects are scoped by org in the path (`<org>/<quote>/<uuid>.<ext>`) **and** by `has_area` in storage RLS.
- Uploads are validated by **magic bytes** (not the filename/type), 10 MB cap, PDF/PNG/JPG/WEBP only; the client filename is discarded (stored as a uuid).
- Downloads use **short-lived signed URLs** — never public URLs.
- A metadata-integrity hole found during testing (an admin could insert an `event_files` row pointing at another org's quote) was **fixed** — the write policy now requires the referenced quote belong to the caller's org. Re-verified 403.

## Two additive constraint widenings (safe, expand-only)
- `profiles_role_check` now allows `designer` (Build 1).
- `notifications_channel_check` now allows `in_app` (Build 1 — design transitions raise in-app pings).

Both only **add** allowed values; no existing row is affected.

## How to ship to production (your steps)
1. **DB:** open the PROD Supabase SQL editor and run the whole of
   `supabase/completion/PROD-BUNDLE-net-new-builds.sql` (Build 3 → 1 → 4, all idempotent). Check each VERIFY block shows `ok = t`.
   - If the Build-4 `storage.*` statements error on permissions, create a **private** bucket named `event-docs` in Dashboard → Storage, then re-run.
2. **Frontend:** these ship with the koushik repo. They reach customers only once the hardened frontend is deployed to prod (that's still blocker **F2** — deploy `koushik1133/Helm` to the customer Vercel/praneeth).
3. **Assign a Designer:** in Control Center, set a user's role to **Designer** (or grant the `design` area to an existing role). The role_access defaults are seeded per org; tune them in the matrix.

## Not changed
- No production DB writes by me. No prod/praneeth/www.helm.events/helm-v01 contact.
- The earlier launch blockers are unchanged: **F1** (Sentry+uptime), **F2** (deploy hardened frontend), **F3** (backup drill), rotate the exposed DB password, confirm CAPTCHA off.
