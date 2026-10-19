# Release 1021: owner steps (plain words)

Branch: `release/r20-pr4`. It is round 20, part 4: four fix branches merged and tested together.

| Branch | What it fixes |
|---|---|
| `fix/r20-checkout-sales` | The plans page ("Choose a plan") looks finished: plan cards always show, and while online payment is off the button says **Contact sales** and opens a filled-in email to sales@helm.events. Trial admins are no longer bounced off the page |
| `fix/r20-safari-profile` | Safari: the profile menu at the bottom of the sidebar opens again. The profile panel fills empty fields with what you already gave at sign-up (nothing is saved until you press Save) |
| `fix/r20-planner` | Planner live-QA fixes: New quote / New lead menus follow the real access rules, money in lead notes stays hidden, "Reply" opens that lead, clearer greeting, tour, Templates notice, chat ticks |
| `fix/r20-business` | The **Business page is for the admin only** by default. A new switch "Business overview (studio money)" in Control Center lets a studio turn it on for other roles |

Note: `fix/r20-planner` is also its own PR (PR 3). If PR 3 is merged first, this PR still merges cleanly
(it already contains PR 3).

Do everything on **STAGING first** (`xizehqgeyjcfpzrdymly`). Move to **PRODUCTION** (`nqltzgiwznphugcfhmbm`)
only after staging looks right. Nothing here deletes data.

Order: **1 database, then 2 website (merge the PR), then 3 checks.**
No edge function changed in this release, so there is nothing to redeploy there.
The user manual did not change in this release, so there is nothing to upload.

Release 1020 (`APPLY-RELEASE-1020.sql`, the free-trial quote cap) should already be on the database. If it is not
yet, paste it too. The two pastes do not depend on each other, so their order does not matter.

---

## 1. Database: one paste

1. Open Supabase, pick the project (staging first), then go to **SQL Editor > New query**.
2. Open `supabase/APPLY-RELEASE-1021.sql` from the repo (the same file is also at
   `~/Desktop/Agency/Helm/APPLY-RELEASE-1021.sql`). Copy **the whole file**, paste it, and press **Run**.
   It takes a few seconds.
3. The **last result grid** is the combined VERIFY: 7 rows, from `0239 01` to `0239 07`. Every row must say
   `ok = true`.
4. If it stops with an error that starts with `STOP:`, an older migration is missing on that database (or the
   default access list was changed by hand). Nothing was changed. Copy the error and send it to Claude. Then
   paste the **whole file again**. It can run twice safely, and a second paste changes nothing.

What it runs (one file, unchanged, in its own transaction):

| # | File | In plain words |
|---|---|---|
| 1 | `APPLY-0239.sql` | A new access switch, **Business overview (studio money)**. Every studio gets it **on for the admin and off for every other role**. New studios get the same. The two money summaries only the Business page uses now also need this switch |

What the paste changes, in plain words:
- It only **adds** rows: one "business" access row per role per studio. No existing access row is changed or
  deleted, and nobody gains access to anything.
- Planners and managers **keep** "Budget & finance". Payments, settlement, closure, event profit and the dashboard
  money cards work for them exactly as before. Only the Business page itself is now admin only.
- Insights was already admin only by default. The paste only checks that this is still true.
- Two database functions are kept under a new name (`..._pre0239`) behind new ones with the same names. No table,
  column or security rule is changed.

## 2. Website

Merge the PR `release/r20-pr4` into `main`. Vercel deploys the site. Do this right after step 1 on production.
Until the site is deployed, a non-admin who still has the old Business page open sees its money cards fail to load
(the database already refuses them). That is expected and stops once the site is live.

## 3. Checks after the push (production)

1. **Business page:** as the admin, open Business. Everything shows. As a planner or manager, the sidebar has no
   Business item, and opening `/business` directly shows "The Business page is for studio admins". In Control
   Center > Roles & access, switch on "Business overview (studio money)" for planners. A planner then sees the page.
   Switch it off again if you do not want that.
2. **Planner money still works:** as a planner, record a payment on an event's settlement and open its closure.
   Both work as before. The dashboard money strip shows, but links to the events list instead of Business.
3. **Plans page:** as a trial admin, press "Choose a plan". The plan cards show (Starter, Studio, Enterprise
   "Price on request"). The button says **Contact sales**. It opens a filled-in form, and "Send to sales" opens your
   email app addressed to sales@helm.events.
4. **Safari:** in Safari, click your avatar or name at the bottom of the sidebar. The menu opens (Profile, Account
   settings, User manual, Sign out).
5. **Profile pre-fill:** as a new trial admin, open Profile. The name, mobile and city you typed at sign-up are
   filled in and marked as suggestions. Nothing is saved until you press **Save profile**.
6. **Planner menus:** as a planner without "Create new quotes", the top bar has no New quote. Its "New" menu
   lists only what the planner can make. "New lead" on Leads works.
