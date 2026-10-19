# Release 1020: owner steps (plain words)

Branch: `release/r20`. It is round 20: six fix branches merged and tested together.

| Branch | What it fixes |
|---|---|
| `fix/r20-trial-quotes` | Free trial: quotes capped at 2 new again; plain-words invitation errors on the sign-in page |
| `fix/r20-builder-owner` | Builder: the old header is back with Render visible (also in the free trial), Client images off in the trial, H = go home, a "?" tour button in the top bar, live-QA builder fixes |
| `fix/r20-shell` | Trial lead counter, calendar type filter on the list, user names, quote numbers in the studio's date, demo prefix, a notice when a trial page is not available, profile card placement |
| `fix/r20-chat` | Quote bubbles fit on phones, no 409 error on the first Chat visit, real names in the group header, member list |
| `fix/r20-events` | Live-QA fixes on the event pages (readiness check, Delete hidden for confirmed / paid events, form checks) |
| `fix/r20-flow` | Quote list "..." menu no longer cut off, staff preview, decor kept, event names, trail, stages, no repeated toasts, venue picker |

Do everything on **STAGING first** (`xizehqgeyjcfpzrdymly`). Move to **PRODUCTION** (`nqltzgiwznphugcfhmbm`)
only after staging looks right. Nothing here deletes data.

Order: **1 database, then 2 website (merge the PR), then 3 user manual, then 4 checks.**
No edge function changed in this release, so there is nothing to redeploy there.

Do steps 1 and 2 close together. The free-trial terms version changes to `trial-2026-10-20`, both in the
database and in the website (`public/trial-facts.js`). While only one of them is updated, a trial owner's
"I agree" is refused with a version error. Once both are updated, every trial owner is asked to agree once more,
because the wording changed (2 new quotes again). Their earlier agreement stays on record.

---

## 1. Database: one paste

1. Open Supabase, pick the project (staging first), then go to **SQL Editor > New query**.
2. Open `supabase/APPLY-RELEASE-1020.sql` from the repo (the same file is also at
   `~/Desktop/Agency/Helm/APPLY-RELEASE-1020.sql`). Copy **the whole file**, paste it, and press **Run**.
   It takes a few seconds.
3. The **last result grid** is the combined VERIFY: 6 rows, from `0238 01` to `0238 06`. Every row must say
   `ok = true`.
4. If it stops with an error that starts with `STOP:`, an older migration is missing on that database. Copy the
   error and send it to Claude. Then paste the **whole file again**. It can run twice safely, and a second paste
   changes nothing.

What it runs (one file, unchanged, in its own transaction):

| # | File | In plain words |
|---|---|---|
| 1 | `APPLY-0238.sql` | Free trial: a trial studio may again create at most **2 new quotes / events**. The three cap triggers that 0211 removed from quotes come back (only if missing). Sample events (SMP-1000 and so on) never count. Quotes a trial already made are kept. The app shows "Free trial: 1 of 2 new quotes used". Terms version `trial-2026-10-20` |

What the paste changes, in plain words:
- **No rows** are written, changed or deleted. Existing free trials keep every quote they already have.
  A trial that already has 2 or more of its own quotes simply cannot add another one.
- It adds back three triggers on the quotes table and re-issues two functions (`my_trial_limits`,
  `_trial_terms_version`) with the same names and inputs. Paid studios are not affected.

## 2. Website

Merge the PR `release/r20` into `main`. Vercel deploys the site. Do this right after step 1 on production,
so the trial terms version matches.

## 3. User manual: upload to private storage

The user manual is served from a private Supabase Storage bucket, not from the website.

1. In Supabase (staging first, then production), open **Storage**. Check that a bucket called `helm-manual`
   exists. If it does not, first run `supabase/migrations/0031_manual_private_bucket.sql` in the SQL Editor
   (it only creates the private bucket and its read rule; it is safe to run twice).
2. Open the `helm-manual` bucket. At its **root** (not inside a folder), upload `docs/manual/USER-MANUAL.html`
   as `USER-MANUAL.html`. If one is already there, replace it.
3. Open (or create) the `screenshots` folder in the same bucket and upload every file from
   `docs/manual/screenshots/` (the `*.webp` pictures), replacing files with the same names.
4. Sign in to Helm and open the profile menu > **User manual**. The manual opens at `/manual` with its pictures.

## 4. Checks after the push (production)

1. **Trial quotes:** in a free trial, create quotes. Next to New quote the app shows "Free trial: 1 of 2 new
   quotes used". After the second one, New quote is switched off ("2 of 2") and says why; the database also
   refuses a third ("Free trial limit reached (2). Upgrade to add more."). The sample events do not count.
2. **Trial terms:** a trial owner is asked to agree to the terms once more, and "I agree" works.
3. **Builder:** the header has Render visible, also in a free trial. Client images are hidden in the trial.
   Press **H** on any app page (not while typing) and you land on the dashboard. The "?" button in the top bar
   starts the guided tour.
4. **Trial page notice:** in a trial, open `/audit` directly. You land on the dashboard with a short notice
   saying the audit log isn't available on the free trial.
5. **Chat:** open Chat for the first time after signing in. No error shows. A group shows real names in its header.
6. **Quotes list:** with only one quote in the list, open its "..." menu. The whole menu shows. A confirmed or paid
   event has no Delete button (use Archive).
7. **New quote number:** the next quote number uses the studio's date (not your computer's date).
