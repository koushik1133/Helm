# Release 1018: owner steps (plain words)

Branch: `release/trial-and-fixes-1018` (the free-trial bundle and 29 fix branches, merged and tested).
Do everything on **STAGING first** (`xizehqgeyjcfpzrdymly`). Move to **PRODUCTION** (`nqltzgiwznphugcfhmbm`)
only after staging looks right. Nothing here deletes data.

Order: **1 database, then 2 edge functions, then 3 secrets check, then 4 website (merge the PR), then 5 checks.**
The SQL is additive, so the website still works if the database is updated first.

---

## 1. Database: one paste

1. Open Supabase, pick the project (staging first), then go to **SQL Editor > New query**.
2. Open `supabase/APPLY-RELEASE-1018.sql` from the repo. Copy **the whole file**, paste it, and press **Run**.
   It takes under a minute.
3. The **last result grid** is the combined VERIFY. Every row must say `ok = true`, except:
   - `0174 04` and `0190 06` say `false` while the **sample switch** is off. With the switch off, new free
     trials start without the sample data. When you want the sample data for new trials, run this one line
     on its own: `update public.helm_sample_template set active = true where id;`. Run the release file again
     and both rows say `true`.
   - `0184 03` says `false` only after you have switched trial deletion on yourself. It is off by default.
4. If a section stops with an error: copy the error, fix the cause (or send it to Claude), then paste the **whole
   file again**. Every section can run twice safely; a second paste changes nothing.

What the paste changes, in plain words:
- **Free-trial studios only:** India defaults (FIX-0177). Then, as the very LAST step, each trial studio's
  **sample** rows are cleared and copied again from the newest sample. That newest sample has the sample event
  requirements (0202). The trial studio's **own** rows are kept.
- **Sample master studio only:** the owner's builder rates (0182), 41 sample event requirements (Catering, Décor
  & flowers, Stage & lighting, Photography ...), and the empty budget / guests on its sample events filled in
  (0202). One new sample version is published.
- **All studios:** an event's budget / guests that are **empty** are filled from the other copy of the same event.
  The copies are the quote, the CRM lead and Discovery (0199). A value that is already there is never changed.
- Everything else is new functions, triggers, tables and empty (nullable) columns. Paid studios' rows are not
  changed, apart from the 0199 empty-value fill.

Tested before this hand-off on a copy at the production state (migrations up to 0172, and again with 0173),
with the v5 sample, 3 free trials and 3 paid studios:
- Pasted twice, once as one query and once statement by statement: **0 errors**.
- VERIFY: every row `true` except the two sample-switch rows.
- The second paste changed nothing.
- Paid studios: identical, apart from the 0199 empty-value fill.
- Every trial ended on the new sample with its own rows kept.

## 2. Edge functions: redeploy the changed ones

These are the functions that changed in this release (`git diff origin/main -- supabase/functions`):

| Function | Why | Flag |
|---|---|---|
| `comms-dispatch` | sends the invitation-site (0195) and booklet (0200) links; **e-mail now goes through your SMTP (Gmail) mailer**; trial reminder copy (0184) | `--no-verify-jwt` |
| `client-mailer` | free-trial gates (0166 outbox rule, then 0179 trial_send_blocked) | `--no-verify-jwt` |
| `send-otp` | free-trial: no real approval code to clients (0179) | default (JWT) |
| `create-payment-link` | free-trial: no real Razorpay link (0187) | default (JWT) |
| `send-whatsapp` | free-trial: no real WhatsApp (0179) | default (JWT) |
| `wa-proposal` | free-trial: no real proposal WhatsApp (0179) | default (JWT) |

Shared files changed: `_shared/mailer.ts`, `_shared/trial-guard.ts` and `_shared/trial-outbound.ts`. They are
included in the six functions above, so nothing else needs a redeploy. `invite-mailer`, `invite-signup`,
`welcome-mailer` and the rest did **not** change.

Run these from the **helm-deploy** folder, after the PR is merged to `main`. The functions must come from
`main`, not from an old copy.

```bash
cd ~/Desktop/Agency/Helm/helm-deploy
git checkout main && git pull

# STAGING
REF=xizehqgeyjcfpzrdymly
supabase functions deploy comms-dispatch      --project-ref $REF --no-verify-jwt
supabase functions deploy client-mailer       --project-ref $REF --no-verify-jwt
supabase functions deploy send-otp            --project-ref $REF
supabase functions deploy create-payment-link --project-ref $REF
supabase functions deploy send-whatsapp       --project-ref $REF
supabase functions deploy wa-proposal         --project-ref $REF

# PRODUCTION (only after staging is checked)
REF=nqltzgiwznphugcfhmbm
supabase functions deploy comms-dispatch      --project-ref $REF --no-verify-jwt
supabase functions deploy client-mailer       --project-ref $REF --no-verify-jwt
supabase functions deploy send-otp            --project-ref $REF
supabase functions deploy create-payment-link --project-ref $REF
supabase functions deploy send-whatsapp       --project-ref $REF
supabase functions deploy wa-proposal         --project-ref $REF
```

## 3. Secrets

Supabase secrets belong to the **project**, not to one function. Your SMTP secrets from client-mailer are already
there, so `comms-dispatch` picks them up after the redeploy. Check they exist:
`supabase secrets list --project-ref <ref>`.

| Secret | Needed for | Value |
|---|---|---|
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | all e-mail, now also `comms-dispatch` | `smtp.gmail.com`, `465`, the Gmail address, its **App Password**, and the same address (or an allowed alias) |
| `EMAIL_BRAND_MODE` | display name (optional) | unset or `helm`: "Helm Events". `studio`: the studio's sender name from the Integrations page, else "<Studio> via Helm" |
| `HELM_COMMS_SECRET` | the cron that calls `comms-dispatch` (already set) | unchanged |
| `APP_URL` | links in the e-mails | `https://www.helm.events` |
| `HELM_POSTAL_ADDRESS` | footer of every e-mail (compliance) | your business postal address |
| `UNSUB_MAILTO` | List-Unsubscribe mail address (optional) | e.g. `unsubscribe@helm.events` |
| `RESEND_API_KEY`, `RESEND_FROM` | only if there is **no** SMTP | leave unset while you use Gmail |

E-mail order for `comms-dispatch`: **SMTP first**. Resend is used only when SMTP is not set and `RESEND_API_KEY` is.
If neither is set, the e-mail rows are marked "skipped" and nothing is sent. Every e-mail keeps its footer.
Follow-ups and trial nudges also keep their Unsubscribe link and the one-click List-Unsubscribe headers (0165).

**Heads-up:** after the `comms-dispatch` redeploy, its e-mails really go out through Gmail. That covers
payment reminders and follow-ups to clients (only where a studio switched them on under Control Center >
Notifications), "Send to client" for invitation sites and booklets, and Helm's free-trial reminder e-mails
to studio owners. Free-trial studios still send nothing to clients. Gmail allows about 500 e-mails a day
for a normal account (about 2,000 for Google Workspace); each `comms-dispatch` run sends at most 25
of each kind of message (`COMMS_BATCH`). The Integrations page "Send test" button still uses Resend only; it shows "Simulated" while
`RESEND_API_KEY` is unset.

## 4. Website

Merge the PR `release/trial-and-fixes-1018` into `main`. Vercel deploys the site. Do this after step 1 on
production.

## 5. Checks after the push (production)

1. Sign up a new free trial with a test e-mail. It should open with the sample data (when the switch is on).
   Open a sample event, then **Budget & margin**: the requirement lines (Must-have / Nice-to-have / Optional)
   are there.
2. On a paid test studio, open an event that has a published invitation website. Choose **Send to client** and
   pick e-mail to your own address. Within a few minutes the mail arrives from your Gmail sender.
   Do the same for the **booklet**.
3. In the SQL editor: `select purpose, status, count(*) from public.comms_outbox where created_at > now() - interval '1 hour' group by 1, 2;`
   Your test rows should say `sent`. A free-trial studio's rows say `skipped`.
4. Edge function logs (Supabase > Edge Functions > comms-dispatch > Logs) show only counts, never an address.
