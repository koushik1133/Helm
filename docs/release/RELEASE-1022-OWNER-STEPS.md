# Release 1022: owner steps (plain words)

Branch: `release/r21-b`. It is round 21, part b: these branches merged and tested together.

| Branch | What it adds |
|---|---|
| `fix/r21-reminders` (0241) | **Delivery & arrival reminders.** Per assignment ("120 chairs from Deccan Rentals by 4:30 pm") Helm e-mails the vendor / staff member at the reminder times (default 60 / 30 / 0 min), with a one-tap status link (on the way / arrived / delayed / problem). Every answer is posted by Helm into the event's chat group (@admins, the person who scheduled it, and the coordinators / managers in that group) and the bell. OFF until you switch it on |
| `fix/r21-target-margin` (0242) | One studio-wide **Target margin %** for the Insights Benchmarks card (Control Center > Pricing) |
| `fix/r21-trial-paid` (0244) | **Trial to paid**: HQ "Activate plan" (payment + GST invoice + plan active, trial limits lifted), Contact sales saved in Helm (HQ Requests tab + e-mail to sales@helm.events), "Ask my admin to upgrade", and the manual UPI / bank details on the checkout page |
| `fix/r21-money` (0246) | **Event money ledger**: every event cost with Estimated / Committed / Actual, staff wages counted, estimated / expected / actual margin. Events closed before this keep their recorded numbers (shown as "legacy") |
| `fix/r21-reserved-domain` (0248) | Nobody can sign up or be invited with a **helm.events / helm.com** address except Helm staff you allow (HQ > Staff access). Existing logins are not changed |
| (front end) | Team role pickers in Control Center no longer offer "Client"; a user with no access shows "No access" |

Do everything on **STAGING first** (`xizehqgeyjcfpzrdymly`). Move to **PRODUCTION** (`nqltzgiwznphugcfhmbm`)
only after staging looks right. Nothing here deletes data.

Order: **1 database, 2 edge functions, 3 Auth hook, 4 website (merge the PR), 5 settings, 6 checks.**

**Needs 0240 first.** `APPLY-0240.sql` (Insights per-event costs, PR #215) is already on staging and production.
If it is ever missing, the 1022 paste stops at its first block with `STOP 1022: APPLY-0240.sql ... is not applied`
and changes nothing.

---

## 1. Database: one paste

1. Open Supabase, pick the project (staging first), then **SQL Editor > New query**.
2. Open `supabase/APPLY-RELEASE-1022.sql` from the repo (the same file is also at
   `~/Desktop/Agency/Helm/APPLY-RELEASE-1022.sql`). Copy **the whole file**, paste it, press **Run**.
3. The **last result grid** is the combined VERIFY (rows `0241 ...`, `0242 ...`, `0244 ...`, `0246 ...`,
   `0248 ...`). Every row must say `ok = true`.
4. If it stops with an error starting with `STOP`, something it needs is missing. Sections that finished are kept;
   copy the error and send it to Claude, then paste the **whole file again** (safe to run twice; a second paste
   changes nothing).

What it runs, in this order (each file unchanged, each in its own transaction):

| # | File | In plain words |
|---|---|---|
| 0 | (check) | Stops before any change if 0240 is not applied |
| 1 | `APPLY-0241.sql` | Delivery reminders: 5 new tables, new functions, cron job `helm_delivery_reminders` (every 5 min, if pg_cron is on). OFF for every studio until an admin switches it on |
| 2 | `APPLY-0242.sql` | Target margin: 2 new functions, one settings row per studio when saved |
| 3 | `APPLY-0244.sql` | Trial to paid: plan activation, sales requests, "ask my admin", Helm notice e-mails |
| 4 | `APPLY-0246.sql` | Event money ledger + Insights per-event costs now count crew wages |
| 5 | `APPLY-0248.sql` | Reserved e-mail domains: new tables + guard triggers (active at once for NEW sign-ups / invites) + the Auth hook function (dormant until step 3) + HQ Staff access |

Only **adds**: new tables, functions and rows. Functions that change are kept under a new name (`..._preNNNN`)
behind new ones with the same names. No existing row is changed or deleted.

## 2. Edge functions: redeploy four

From the deploy folder, for each project (staging first, then production):

```
cd ~/Desktop/Agency/Helm/helm-deploy
supabase functions deploy comms-dispatch --no-verify-jwt --project-ref <ref>
supabase functions deploy razorpay-subscription-webhook --no-verify-jwt --project-ref <ref>
supabase functions deploy invite-signup --no-verify-jwt --project-ref <ref>
supabase functions deploy invite-mailer --no-verify-jwt --project-ref <ref>
```

- `comms-dispatch` sends the delivery reminders and the new Helm notices (sales requests, "ask my admin").
- `razorpay-subscription-webhook` passes the subscription id to plan activation (still dormant while online payment is off).
- `invite-signup` and `invite-mailer` refuse reserved helm.events / helm.com addresses.

**Cron checks** (SQL Editor, read-only):

```
select jobname, schedule, active from cron.job where jobname in ('helm_delivery_reminders', 'helm_comms_dispatch');
```

Both rows must be there and `active = true`. If `helm_comms_dispatch` is missing, set it up as in
`docs/COMMS-AUTOMATION-SETUP.md` (step 5). If `helm_delivery_reminders` is missing (pg_cron was off when you
pasted), run: `select cron.schedule('helm_delivery_reminders', '*/5 * * * *', 'select public.delivery_reminders_tick()');`

## 3. Auth hook: switch on "Before User Created"

Supabase Dashboard > **Authentication > Hooks** > **Before User Created** > Add / Enable > Hook type **Postgres** >
Schema **public** > Function **hook_before_user_created** > Save.

Test: sign up with `x@helm.events` - it is refused ("Addresses on helm.events are reserved for the Helm team").
A normal address still signs up as before. Before creating any NEW Helm-team login on helm.events, add that exact
address in HQ > Staff access first. To review existing helm.events logins: `supabase/R21-RESERVED-DOMAIN-REPORT.sql`
(read-only) or HQ > Staff access. `R21-RESERVED-DOMAIN-DISABLE.sql` only if you decide to (reversible, nothing deleted).

## 4. Website

1. Fill in **HELM_PAY_MANUAL** in `public/config.js` (your UPI id / payee name and/or bank account, IFSC, bank).
   Only receiving details, never a password, PIN or API key. Empty fields are not shown.
2. Merge the PR `release/r21-b` into `main`. Vercel deploys the site.

## 5. Settings (production, as the admin)

1. **Delivery reminders:** Control Center > Notifications > Delivery reminders > switch **on** (pick the chat group
   if you want a fixed one; default is each event's own group). Save.
2. **Target margin:** Control Center > Pricing > **Target margin %** (0 to 90) > Save. Insights Benchmarks uses it
   (30% until you set it).

## 6. Checks after the push (production)

1. **Delivery reminder:** on a confirmed event, add an assignment for yourself (your e-mail) due in ~1 hour. The
   reminder e-mail arrives at the 60-minute mark; tap "On the way" - the event chat group shows Helm's post and the
   bell rings.
2. **Money:** open an event's Budget / Closure - costs show Estimated / Committed / Actual; staff wages appear.
   An event closed before this release shows "legacy" numbers unchanged.
3. **Insights:** Benchmarks shows your target margin.
4. **Trial to paid:** in HQ > Studios, "Activate plan" on a test trial studio; HQ > Requests lists a Contact sales
   request; the checkout page shows your UPI / bank details.
5. **Reserved domain:** sign-up with an `@helm.events` address is refused; an invite to one is refused.
6. **Roles:** Control Center > Users & invites: the role pickers have no "Client".
