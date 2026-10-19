# Studio links (helm.events/&lt;studio&gt;): guessing, look-alikes and renames

R23, PR #232, SQL 0257. Written for the owner in plain words.

## The short answer

**Can typing helm.events/abcd-events, or another studio's link, sign someone in or show that a studio exists?**
No.

- **Signed out:** every `helm.events/<anything>/<page>` shows the same Helm sign-in page. This is true whether `<anything>` is a real studio, a made-up word or a typo. The server never looks the name up for these pages: it is a fixed rewrite to the same static page (`vercel.json`). So the status code, the size and the timing are identical. No studio name, logo or colour is shown before sign-in.
- **Signed in:** opening another studio's link, or a made-up one, sends you to **your own** dashboard (`my_studio_route`, 0067). The server answers only "is this my studio?". It never says whether the other name exists. No data of the other studio is requested; the database blocks it anyway (RLS by `org_id`).
- **Client links** (quote, portal, proposal, booklet, invitation, crew work link) open only when the studio part **and** the secret token belong together (`public_link_studio` / `public_booklet_studio`). If you put a real token under the wrong studio name, the page shows "link not found". It never reveals the right name. If you put a token under that studio's **old** name, the link opens and the address bar switches to the current name. That only happens for someone who already holds the token.
  - The token is the real secret: a random 128-bit value that can't be guessed. The studio part is a public label that stops one studio from dressing its link up as another studio's (anti-phishing). Old links of the form `/approve.html?token=...` still work on purpose (links already sent). The studio part adds no secrecy there, and none is needed.

## What changed in R23 (0257)

1. **Name and link are fixed after sign-up.** The studio name typed at sign-up, and the link made from it, can't be changed from the app: not by a trial owner, a paid admin, a coordinator, or any other path (Control Center, onboarding, the trial welcome, the old "link name" box). The database refuses it (`aa_r23_org_identity_lock`). The sign-up screen says so: *"This name and your link helm.events/... can't be changed later."*
2. **Only Helm HQ can change them**, when the studio asks. In HQ → Studios → open a studio → **Studio name & link**:
   - The operator must be signed in with two-step, and a reason is required.
   - The form shows old → new and checks availability live.
   - The change is written to the audit log.
   - The studio's admins get a bell notice and an e-mail. The e-mail is sent once comms-dispatch is deployed.
   - Old links keep working.
   - Fallback without the HQ screen (SQL editor): `update public.organizations set name = '...', public_slug = '...' where id = '<studio id>';`
3. **Look-alikes are never handed out.** A new link is refused, and sign-up picks another, when it *looks like* a link already used by another studio, now or in the past.
   - "Looks like" means dashes ignored and these treated as the same: 0/o, 1/l/i, 3/e, 4/a, 5/s, 7/t, 8/b, 9/g, "rn"/m, "vv"/w.
   - Example: if `bloom-decor` exists, `bl00m-decor` or `bloomdecor` are not given out.
4. **Helm words are protected.** These can't be studio links:
   - `helm` and `helm-...` (`helm-support`, `helmevents`, `my-helm`).
   - Look-alikes such as `he1m`.
   - Words like admin, support, login, billing, security, official, staff, team, payments, verify, whatsapp and google, plus every app page name (as before).
5. **Old links are retired forever.** When HQ changes a studio's link, the old one stays reserved for that studio. No other studio can ever take it, and every link already sent keeps working. Industry practice is weaker here: GitHub and Slack release an old name for anyone to claim after a rename.

## What other products do (research, Oct 2026)

- **Slack:** the workspace URL can be changed by an owner. The old URL redirects only until someone else claims it.
- **GitHub:** after an organisation rename, the old name can be claimed by anyone, and its redirects can then be taken over. Very popular repositories are the exception and are retired permanently.
- **Shopify:** the `*.myshopify.com` address can't be changed after the store is created. Stores add a custom domain instead. Helm now follows the same "fixed at creation" rule, with a support-only change.
- **OWASP (enumeration):** failed or unknown lookups must answer in the same way, with the same message, status, redirect and timing. Helm's studio pages do (see the short answer above).
- **Unicode UTS #39 "confusables":** two names are confusable when they share a *skeleton*. Helm uses a small ASCII version of that idea. Links are lowercase a-z, 0-9 and dashes only, so no foreign or invisible characters can get in.

## Impersonation reports (support runbook)

When someone reports a studio that pretends to be them or a well-known business (for example `sharma-weddings` used by a stranger):

1. **Check:** look in HQ → Studios for the studio, its created date, owner e-mail and people. Do not share another studio's details with the person reporting.
2. **Act:**
   - If it is clearly impersonation, use HQ → **Suspend (read-only)** with a reason. Members can still see and export their data, nothing is deleted, and it can be undone.
   - If the rightful owner is a Helm studio, use **Studio name & link** to give the impostor a neutral link (for example `studio-1234`). Write the report in the reason. The audit log keeps everything.
   - Do the rename **before** suspending: a suspended studio is read-only, and that includes its name and link.
   - The old link stays reserved and is never re-used. If the reporter should get that link, make the change in the SQL editor after a manual check. Note it in the audit reason first.
3. **Record:** use the reason field of the HQ action. Reply to the person reporting.
4. **Trademark disputes** (two real businesses, same name): Helm does not decide who owns a trademark. Ask for proof (GST certificate, trademark registration). If it is clear, change one studio's link with its admin's agreement. If not, tell both parties to settle it between themselves.

## Tests

- `tests/db/r23-studio-name-0257.sql` (41 checks) covers:
  - admin, coordinator, staff and free-trial owner all refused;
  - the trial welcome can't rename;
  - sign-up still sets the name and link;
  - SQL editor and service role allowed;
  - HQ needs two-step and a reason, refuses look-alikes and Helm words, keeps the old link, and writes the audit, bell and e-mail;
  - old app and client links still resolve.
- `tests/db/studio-links.sql` and `tests/db/pretty-urls.sql` cover the anti-phishing checks (a token under the wrong studio returns nothing) and the identical answers for unknown studios.
- `test/r23-studio-name.test.mjs` covers every app screen that used to write the name or link.
