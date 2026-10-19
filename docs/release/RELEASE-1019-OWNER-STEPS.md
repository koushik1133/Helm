# Release 1019: owner steps (plain words)

Branch: `release/1019`. It is round 19: ten fix branches merged and tested together.

| Branch | What it fixes |
|---|---|
| `fix/r19-signup-auth` | Sign-up and the confirm link: "You've been invited to join <Studio>" check, confirm link in another browser, City / State / Country step |
| `fix/r19-tour-menu-manual` | Product tour pin step, trimmed profile menu, user manual v4 |
| `fix/r19-quotes-flow` | Trial quotes not capped, "New quote" opens the flow directly, "No package", client e-mail required |
| `fix/r19-trial-email` | E-mail to clients works in the free trial (capped); WhatsApp / SMS / payment links stay off |
| `fix/r19-builder` | 2D vs 3D carpet order, canvas controls strip, two-row header, sample event floor plans |
| `fix/r19-email-branding` | Compass-H logo in every e-mail (new file name) |
| `fix/r19-live-quote-draft-layout-booklet` | L1 "New quote" took over a draft, L2 "Save & back" lost the layout, L11 booklet floor plan |
| `fix/r19-live-shell-chrome-privacy` | L3 Continue button colour, L4 short-window sidebar, L5 hidden amounts in edit fields |
| `fix/r19-live-trial-seed-sql` | L6 "Prices changed" alerts on a new trial, L7 sample phone numbers |
| `fix/r19-live-trial-ui-controls` | L8 trial menu packages, L9 trial end date, L10 reservations, L12 / L13 / L14 trial dialogs |

Do everything on **STAGING first** (`xizehqgeyjcfpzrdymly`). Move to **PRODUCTION** (`nqltzgiwznphugcfhmbm`)
only after staging looks right. Nothing here deletes data.

Order: **1 database, then 2 edge functions, then 3 website (merge the PR), then 4 e-mail templates, then
5 user manual, then 6 optional trial refresh, then 7 checks.**

Do steps 1 and 3 close together. The free-trial terms version changes to `trial-2026-10-19`, both in the
database and in the website (`public/trial-facts.js`). While only one of them is updated, a trial owner's
"I agree" is refused with a version error. Once both are updated, every trial owner is asked to agree once more,
because the wording changed. Their earlier agreement stays on record.

---

## 1. Database: one paste

1. Open Supabase, pick the project (staging first), then go to **SQL Editor > New query**.
2. Open `supabase/APPLY-RELEASE-1019.sql` from the repo. Copy **the whole file**, paste it, and press **Run**.
   It takes under a minute.
3. The **last result grid** is the combined VERIFY: 43 rows, from `0210 01` to `0223 04`. Every row must say
   `ok = true`.
4. If a section stops with an error, copy the error and fix the cause (or send it to Claude). Then paste the
   **whole file again**. Every section can run twice safely, and a second paste changes nothing.

What it runs, in this order (each file unchanged, each in its own transaction):

| # | File | In plain words |
|---|---|---|
| 1 | `APPLY-0210.sql` | Sign-up: the open-invitation check (service role only; it returns the studio name and role, never the token) and the trial welcome's City + State + Country India step |
| 2 | `APPLY-0211.sql` | Free trial: unlimited quotes / events (the 2-new cap stays for leads, inventory, vendors, staff, venues); terms version `trial-2026-10-19`; new "No package - decide later" (the event's dishes are kept) |
| 3 | `APPLY-0212.sql` | Free trial: e-mail to clients really goes out, up to 30 a day per studio and 5 a day per address. Demo events are never e-mailed. WhatsApp, SMS and payment links stay off |
| 4 | `APPLY-0213.sql` | The sample events SMP-1000 / 1002 / 1004 / 1005 / 1006 get real floor plans (sample master only). One new sample version is published, so NEW trials get them |
| 5 | `APPLY-0220.sql` | "New quote" reuses a draft only when nothing was put into it. The booklet link shows floor plan + 3D once a layout is saved, and its sections can be switched on the live link |
| 6 | `APPLY-0222.sql` | Re-pricing alerts skip sample data, confirmed events and approved / paid quotes. The sample master's open quotes are priced at its own chair rate (100). One new sample version |
| 7 | `APPLY-0223.sql` | The trial end date and days left are counted in the studio's time zone on every screen |

What the paste changes, in plain words:
- **Sample master studio only (0213, 0222):** five empty sample floors get a floor plan. Its five open sample
  quotes are re-priced at its own chair rate. Its confirmed sample events' sample milestones and advance follow
  the new totals. Two new sample versions are published, for NEW trials.
- **One new settings row (0212):** `trial_email_settings` (trial e-mail on, 30 a day per studio, 5 a day per
  address). 0212 also saves the old function bodies it replaces in `tr212_saved_defs`.
- **Existing free trials and paid studios:** no rows changed.
- Everything else is new functions, tables, triggers and one empty (nullable) column. 0211 removes only the three
  free-trial cap **triggers** on quotes. Nothing else is dropped.

**Trial e-mail off switch.** To turn free-trial client e-mail off at once, run this one line:
`update public.trial_email_settings set enabled = false where id;`
Use `set enabled = true` to turn it back on.

Tested before this hand-off on a copy at the production state (origin/main: migrations up to 0208 + 0236 +
0237), with the two test studios and two free trials (sample data on):
- Pasted twice: **0 errors**, and all 43 VERIFY rows were `true` both times.
- The second paste changed nothing: the schema and every table row were identical.
- The first paste changed rows of the **sample master studio only** (quotes, layout versions, milestones,
  sample payments, sample manifest), plus the new 0212 settings / bookkeeping rows and the audit log.

## 2. Edge functions: redeploy the changed ones

These functions changed in this release, either their own code or a shared file they bundle
(`git diff origin/main -- supabase/functions`):

| Function | Why | Flag |
|---|---|---|
| `invite-signup` | sign-up open-invitation check + "Join" re-sends the invitation e-mail (0210); new e-mail logo | `--no-verify-jwt` |
| `client-mailer` | free-trial e-mail to clients through the 0212 gate (caps, demo events); new e-mail logo | `--no-verify-jwt` |
| `comms-dispatch` | sends a trial's queued booklet / invitation-site link e-mails (0212); everything else from a trial stays skipped | `--no-verify-jwt` |
| `send-otp` | free-trial approval code by e-mail through the 0212 gate (never SMS / WhatsApp); new e-mail logo | default (JWT) |
| `invite-mailer` | new e-mail logo (`_shared/email-layout.mjs`) | `--no-verify-jwt` |
| `welcome-mailer` | new e-mail logo | `--no-verify-jwt` |
| `pkg-client-notify` | new e-mail logo | `--no-verify-jwt` |
| `billing-reminder` | new e-mail logo | `--no-verify-jwt` |
| `wa-proposal` | new e-mail logo; the shared trial guard gained the 0212 e-mail gate (WhatsApp is unchanged) | default (JWT) |
| `create-payment-link` | bundles the shared trial guard (new e-mail gate added; payment links unchanged) | default (JWT) |
| `send-whatsapp` | bundles the shared trial guard (new e-mail gate added; WhatsApp unchanged) | default (JWT) |

Shared files changed: `_shared/email-layout.mjs` (logo), `_shared/trial-guard.ts` and `_shared/trial-outbound.ts`
(0212 gate). `comms-dispatch/trial-row.mjs` is new. Every function that bundles one of them is in the table, so
nothing else needs a redeploy. The JWT flags are the same ones each function had in release 1018.

Run these from the **helm-deploy** folder, after the PR is merged to `main`. The functions must come from
`main`, not from an old copy.

```bash
cd ~/Desktop/Agency/Helm/helm-deploy
git checkout main && git pull

# STAGING
supabase functions deploy invite-signup       --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy client-mailer       --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy comms-dispatch      --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy send-otp            --project-ref xizehqgeyjcfpzrdymly
supabase functions deploy invite-mailer       --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy welcome-mailer      --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy pkg-client-notify   --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy billing-reminder    --project-ref xizehqgeyjcfpzrdymly --no-verify-jwt
supabase functions deploy wa-proposal         --project-ref xizehqgeyjcfpzrdymly
supabase functions deploy create-payment-link --project-ref xizehqgeyjcfpzrdymly
supabase functions deploy send-whatsapp       --project-ref xizehqgeyjcfpzrdymly

# PRODUCTION (only after staging is checked)
supabase functions deploy invite-signup       --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy client-mailer       --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy comms-dispatch      --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy send-otp            --project-ref nqltzgiwznphugcfhmbm
supabase functions deploy invite-mailer       --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy welcome-mailer      --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy pkg-client-notify   --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy billing-reminder    --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt
supabase functions deploy wa-proposal         --project-ref nqltzgiwznphugcfhmbm
supabase functions deploy create-payment-link --project-ref nqltzgiwznphugcfhmbm
supabase functions deploy send-whatsapp       --project-ref nqltzgiwznphugcfhmbm
```

No new secrets are needed. The trial e-mails use the SMTP (Gmail) secrets already set for the project.

**Heads-up:** after step 1 and these redeploys, a studio on an **active free trial** really e-mails its
clients: approval (quote) links, booklet and invitation-site links, and the approval code. The caps are 30 a day
per studio and 5 a day per address. Sample (demo) events are never e-mailed. Gmail allows about 500 e-mails a
day for a normal account, so keep an eye on the volume. Use the off switch in step 1 if needed.

## 3. Website

Merge the PR `release/1019` into `main`. Vercel deploys the site. Do this right after step 1 on production,
so the trial terms version matches.

## 4. E-mail templates: re-paste after the site deploy

The e-mails now load the logo from a new address, `https://www.helm.events/email/helm-logo-v3.png`. The old file
stays, so mail already sent keeps its picture. **First open that address in a browser and check the compass-H
logo shows.** Then, in Supabase > Authentication > Emails (staging first, then production), re-paste the **body**
of all eight auth templates from `docs/ops/email-templates/`. The subjects are unchanged.

| Template in Supabase | File |
|---|---|
| Confirm signup | `docs/ops/email-templates/confirm-signup.html` |
| Invite user | `docs/ops/email-templates/invite-user.html` |
| Magic link | `docs/ops/email-templates/magic-link.html` |
| Change email address | `docs/ops/email-templates/change-email.html` |
| Reset password | `docs/ops/email-templates/reset-password.html` |
| Reauthentication | `docs/ops/email-templates/reauthentication.html` |
| Security notifications > Password changed | `docs/ops/email-templates/password-changed.html` |
| Security notifications > Email address changed | `docs/ops/email-templates/email-changed.html` |

The details are in `docs/ops/EMAIL-TEMPLATES.md`, section 7.

## 5. User manual: re-upload

The manual was rebuilt (v4, 23 chapters). In Supabase > Storage > `helm-manual`, upload
`docs/manual/USER-MANUAL.html` over the old one. New pictures are still "Screenshot to add" boxes. To fill them:
run `node scripts/manual-capture.mjs --list` for the shot list. Then run the script, sign in by hand in the window
it opens (on a demo studio), and upload the new files in `docs/manual/screenshots/` to `screenshots/`. `/manual`
shows each picture in place of its box by itself. See `docs/OWNER-ACTIONS-SECURITY.md`.

## 6. Existing free trials (optional, your decision)

New trials get the new floor plans and prices from the new sample versions. Existing trials keep their copy
until you choose one of these:
- `supabase/APPLY-0213-refresh-trial-layouts.sql`: the gentle one. It only fills **empty** sample floors of
  active trials with the 0213 floor plans. It never touches a floor the studio drew on, its own events or paid
  studios. Run it after step 1. It is safe to run twice, and its last query should return no rows.
- `supabase/APPLY-0178-refresh-trials.sql`: a full re-copy of the newest sample. It **replaces** each trial's
  sample data (the trial's own rows are kept). Run this only if you also want the 0222 prices in existing trials;
  it also clears their old "Prices changed" banner.

Existing trials get no new "Prices changed" alerts from now on, whichever you choose.

## 7. Checks after the push (production)

1. **Sign-up:** sign up a new free trial with a test e-mail. The welcome asks for City, State (dropdown) and
   Country (India, fixed). The dashboard has no "Prices changed" alerts, and the trial end date is the same on
   Plan & billing, the trial strip and the Staff page.
2. **Invitation check:** on the sign-up page, enter an e-mail that has an open invitation. You see "You've been
   invited to join <Studio> as <role>". "Join" e-mails the invitation again.
3. **Trial quotes:** in the trial, create a third quote: it works. "New quote" opens the flow directly. In step 5,
   "No package - decide later" clears the package.
4. **Trial e-mail:** send a quote approval link from the trial to your own address. It arrives. A demo (sample)
   event says it is not sent. WhatsApp options are hidden.
5. **Builder:** open the gala sample layout. The carpet is under the stage in 2D, as in 3D. The zoom / pan strip
   sits under the plan.
6. **E-mail logo:** a new invitation or welcome e-mail shows the compass-H logo.
7. **Manual:** the profile menu shows Profile, Account settings, User manual and Sign out. User manual opens
   `/manual` with the new contents list.
