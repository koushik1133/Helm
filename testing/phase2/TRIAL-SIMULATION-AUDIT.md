# Free trial = full simulation: outbound audit (R114, SQL 0323)

Owner decision (2026-10-31): in a free-trial studio, nothing real may leave Helm to a client. No e-mail, no WhatsApp, no SMS, no approval code, no payment link, no booklet or invitation send. The owner still walks the whole flow and sees what would happen, as previews, under a red "Trial simulation" banner.

**How a trial is detected.** The rule is `public._tb179_no_send(org)` (0179). It is true while the studio is on its free trial (`studio_subscriptions.status = 'trial'` via `_is_trial_org`), after an unpaid trial has ended and gone read-only (`_trial_locked`), and for the Helm sample master studio. Edge functions ask `trial_send_blocked(org, quote, token)` through `_shared/trial-guard.ts` with the service role. If that check fails, they treat the studio as a trial and send nothing. Queued messages (`comms_outbox`, `pkg_outbox`, `assign_notify_outbox`) are turned into `skipped` rows by the 0166 outbox guard `_ts166_tg_outbox_skip`. The app learns the state from `my_trial_messaging()` and `my_trial_org()` (`public/trial-lock.js`, `public/trial-test-note.js`).

**The gap R114 closes.** 0212 had made an exception: an active trial could really e-mail its client, up to 30 a day. That covered the approval link, the booklet link, the invitation website link, the approval code (closed by 0322), and delivery reminders to vendors (0241). All of these went through one switch, `_tr212_email_ok(org)`. 0323 wraps that function so it always returns false; the 0212 body is kept as `_tr212_email_ok__pre0323`. 0323 also refuses any trial e-mail slot at all. The client-mailer edge function now returns a preview instead of sending.

## Table

| Action | Today in trial (before R114) | After fix | File:line |
|---|---|---|---|
| Approval link e-mail ("Send by email", quote page / booklet dialog) | **Really sent** in an active trial (0212 gate, capped 30/day) | Not sent. The DB gate says `allowed:false`. client-mailer returns `{status:"test_mode", simulated:true, preview}` and logs `simulated`. The button reads "Preview e-mail (trial)" and shows what the client would get | `supabase/functions/client-mailer/index.ts:143`, `:157`; `supabase/migrations/0323_r114_trial_simulation.sql:65`; `public/email-send.js:56` |
| Booklet link e-mail (client-mailer kind `booklet`) | **Really sent** (0212) | Same as above: preview only | `supabase/functions/client-mailer/index.ts:143` |
| Booklet "Send to client" (booklet_send -> comms_outbox) | **Really queued + sent** by e-mail in an active trial (0212 outbox guard kept the row `pending`) | The row is stored `skipped` (free_trial) and the dispatcher never claims it. The UI button reads "Preview (trial - not sent)": it shows the message and opens the booklet page with `#preview`, and does not call the server | `supabase/migrations/0212_trial_client_email.sql:115` (switch), `0323_r114_trial_simulation.sql:65`; `public/invite-site-share.js:171` |
| Invitation website "Send to client" (event_site_send -> comms_outbox -> comms-dispatch) | **Really sent** by e-mail (0212); WhatsApp skipped | Same as the booklet: `skipped` on the server, Preview in the UI | `public/invite-site-share.js:171`; `supabase/functions/comms-dispatch/index.ts:84` |
| Approval code (OTP) by e-mail / WhatsApp / SMS | Refused since R113 / 0322 (test code 000000) | Unchanged. The trial e-mail ledger now refuses every kind, not only `otp` | `supabase/functions/send-otp/index.ts:86`; `0322_r113_trial_approval_test_mode.sql:84`; `0323_r114_trial_simulation.sql:89` |
| Client approval itself | Test approval with code 000000 (0322) | Unchanged, plus the red banner and a "Next step (simulated): payment" card | `public/approve.html:141`, `:459` |
| Payment link (Razorpay, create-payment-link) | Refused (0187: 409 `trial`); the page hid "Proceed to payment" | Unchanged on the server. The client page now offers **Simulate payment**: `trial_simulate_payment` records one TEST row per open milestone in `trial_sim_payments`, writes the audit row `payment.simulated` and returns a `TEST-...` receipt. It never writes `quote_payments` or `payment_milestones` and never calls Razorpay | `supabase/functions/create-payment-link/index.ts:90`; `0323_r114_trial_simulation.sql:208`; `public/approve.html:459` |
| Simulated checkout page `sim-pay.html` | Only on local / staging, never on prod hosts | Unchanged | `public/sim-pay.html:72` |
| Payment reminders (automatic + "Send reminder now") | Outbox row `skipped` (0166 guard) | Unchanged (nothing sent) | `supabase/migrations/0166_trial_sandbox_skeleton.sql:352` |
| Client follow-ups (comms-dispatch `follow_up`) | `skipped` (0166) | Unchanged | `supabase/migrations/0166_trial_sandbox_skeleton.sql:352` |
| Package accept / decline / booklet code to the client (pkg-client-notify, pkg_outbox) | `skipped` (0166) | Unchanged | `supabase/functions/pkg-client-notify/index.ts:116` |
| Proposal WhatsApp (wa-proposal) | Simulated path, `{simulated:true, trial:true}`; the box is hidden in the trial | Unchanged | `supabase/functions/wa-proposal/index.ts:65`; `public/wa-proposal.js:102` |
| Staff "Send on WhatsApp" (send-whatsapp) | Refused (0179, 403) | Unchanged | `supabase/functions/send-whatsapp/index.ts:271` |
| Delivery reminders to vendors (0241, e-mail) | **Really sent** in an active trial (0212 caps) | Not sent: `_dl241_send_block` answers `trial_no_send` (it asks `_tr212_email_ok`) | `supabase/migrations/0241_delivery_reminders.sql:271` |
| Vendor requests / run-sheet reminders (comms-dispatch lanes) | Trials never queue them (claims re-check) | Unchanged | `supabase/migrations/0256_vendor_requests_invoices.sql`, `0269_r24_automation.sql` |
| Assignment notices to staff (assign_notify_outbox) | `skipped` (0166) | Unchanged | `supabase/migrations/0166_trial_sandbox_skeleton.sql:352` |
| Integrations "Send test" WhatsApp | Refused for a trial (403) | Unchanged | `supabase/functions/integrations-test/index.ts:133` |
| Client pages (approve, portal, booklet, invitation site) | No disclaimer (approve had the R113 "Test mode" box only) | Red banner "Trial simulation - Nothing is sent to your client, and no real payment is taken." from `public_trial_simulation(kind, ref)`; paid studios see nothing | `public/trial-sim.js`; `0323_r114_trial_simulation.sql:261` |
| **Owner's own e-mails**: welcome, security alerts, sign-in / password / OTP, Helm billing + trial reminders | Sent | **Still sent (unchanged)**. These go to the owner, not a client | `welcome-mailer/index.ts:75`, `security-alert-mailer/index.ts:92`, `billing-reminder/index.ts:106`, `comms-dispatch` trial-reminder lane |
| Staff invitations (invite-mailer / invite-signup) | Sent (the trial allows 2 invites) | Unchanged: these go to the owner's own team, not a client | `supabase/functions/invite-mailer/index.ts:106`, `invite-signup/index.ts:211` |
| Member phone verification (send-phone-code) | The member's own number (dormant) | Unchanged (not client-facing) | `supabase/functions/send-phone-code/index.ts:73` |
| Studio subscription checkout / Razorpay webhooks | Helm billing the studio | Unchanged (the owner paying Helm is real) | `create-subscription-checkout/index.ts:52`, `razorpay-webhook/index.ts:132` |

## Fail-closed notes

- The server decides, not the UI. If the new site is deployed before the SQL runs, the UI already treats *any* trial as a simulation, including an older `my_trial_messaging` that still says `email:true`. If the SQL runs before client-mailer is redeployed, the old client-mailer gets `allowed:false` from the gate and answers `test_mode`, so nothing is sent. The page then says that the preview will appear after the update.
- client-mailer redeployed while the database is still pre-0323: any gate answer with `trial:true`, even `allowed:true`, is treated as a simulation.
- A broken or unknown plan check still fails closed: 503, nothing sent.
- `trial_sim_payments` is not the money ledger. Insights, closure and P&L never read it.
