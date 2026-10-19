# Automatic client messages, low-stock warnings and WhatsApp forwarding (0078)

Everything below is **dormant** until you do the owner steps. Nothing is ever sent from a browser.

## What it does

| Feature | Trigger | Channel | Stops when |
|---|---|---|---|
| Payment reminders | N days before due, on the due date, then every N days overdue (max M) | E-mail and/or WhatsApp to the client | the milestone is paid / waived, or the event is cancelled / closed |
| "Send reminder now" | Planner clicks it on the event's Logistics > Payments tab | same channels | at most once per milestone + channel per 10 minutes |
| Client follow-ups | client opened the booklet or quote link X days ago and hasn't approved | E-mail and/or WhatsApp | the client approves, picks a package, or the event is cancelled |
| Low-stock warning | events on the same date need more of an item than you own | Bell (Inventory roles + admins) | one bell row per item + date; again only if the gap grows |
| WhatsApp forwarding | any bell notification the member can see, of a type their role has ticked; plus studio announcements (chat broadcast) | WhatsApp to the member, with a deep link | member opts out, admin switches it off; 30 per member per hour |

Every automatic message is a row in `comms_outbox` with a UNIQUE `dedupe_key`, so a message can never be sent twice. Each row is re-checked when it is picked up (paid, approved or opted out -> skipped). A delivered client reminder / follow-up is logged on the event (activity trail and bell).

## Owner setup steps

1. **Database** - paste `supabase/APPLY-0078.sql` in the Supabase SQL editor on staging, check the last grid (10 rows, all `true`), then prod.
2. **Scheduler** - if `pg_cron` is enabled the migration already scheduled `helm_comms_tick` every 15 minutes (it only queues; it sends nothing). Check with `select jobname, schedule from cron.job;`. If pg_cron is not enabled: Database > Extensions > enable `pg_cron`, then run `select cron.schedule('helm_comms_tick', '*/15 * * * *', 'select public.comms_tick()');`.
3. **Edge function** - `supabase functions deploy comms-dispatch --no-verify-jwt`.
4. **Secrets** (`supabase secrets set ...`):
   - `HELM_COMMS_SECRET` = a long random string (e.g. `openssl rand -hex 32`)
   - e-mail: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (the shared SMTP mailer, e.g. Gmail; already set for client-mailer). SMTP is used first; `RESEND_API_KEY`, `RESEND_FROM` only when SMTP is not set (release 1018)
   - `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` (already set for `send-whatsapp`)
   - `COMMS_WHATSAPP_TEMPLATE` = an approved Meta template with ONE body variable `{{1}}` (e.g. name `helm_message`, body `{{1}}`). Without it WhatsApp rows are skipped unless `WHATSAPP_ALLOW_TEXT=1` (free text only works inside the 24-hour customer window - not suitable for reminders).
   - `APP_URL` = `https://www.helm.events` (deep links in forwarded messages)
   - `HELM_COMMS_ENABLED` = `true` **last**, when you are ready to go live.
5. **Run the sender every 5 minutes** - SQL editor (needs `pg_net` + `pg_cron`; store the secret in Vault first):
   ```sql
   select vault.create_secret('<HELM_COMMS_SECRET value>', 'helm_comms_secret');
   select cron.schedule('helm_comms_dispatch', '*/5 * * * *', $$
     select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/comms-dispatch',
       headers := jsonb_build_object('Content-Type', 'application/json',
         'x-helm-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'helm_comms_secret')),
       body := '{}'::jsonb);
   $$);
   ```
6. **Switch features on** - Control Center > Notifications > "Automatic client messages & WhatsApp": tick payment reminders / follow-ups, choose channels, adjust timing and the message (live preview), save. For WhatsApp: add the studio WhatsApp number, tick "Forward notifications to WhatsApp" and tick which notification types each role may get.
7. **Members opt in** - each member opens their profile (avatar menu > Profile), checks their WhatsApp number and ticks "Also send my Helm notifications to my WhatsApp".

## Fail-closed behaviour

- `HELM_COMMS_ENABLED` not `true` -> the function answers `{"status":"dormant"}` and claims nothing (rows wait).
- Wrong / missing `x-helm-cron-secret` -> 401.
- No SMTP secrets and no `RESEND_API_KEY` -> e-mail rows marked `skipped`. No WhatsApp token / phone id / template -> WhatsApp rows `skipped`.
- No studio WhatsApp number -> nothing is queued for WhatsApp and queued WhatsApp rows are skipped.
- Rows older than 3 days are skipped instead of sent late; 5 failed attempts -> `failed`.

## Checking it

```sql
select purpose, channel, status, count(*) from public.comms_outbox group by 1, 2, 3 order by 1, 2, 3;
select public.comms_tick();   -- run the scheduler once by hand (service role / SQL editor)
```

## Delivery & arrival reminders (0241, round 21)

Per assignment: on the event-day page (Event workspace -> Event-day command -> "Deliveries & arrivals") a planner
schedules "120 chairs from Deccan Rentals by 4:30 pm" and, at the bottom of the same form, picks the reminders for
that one assignment (default from Control Center: 1 hour before, 30 minutes before, at the time; up to 6, editable).
A vendor-sourced stock shortage also offers "Delivery reminder", which opens the same form prefilled.

What happens: at each reminder time Helm e-mails the responsible person (vendor / staff / studio user, as allowed in
Control Center) with a one-tap link `https://www.helm.events/delivery?t=<token>`: On the way / Arrived / Delayed (+ new
time) / Problem (+ note). No sign-in. Every reply is kept on the assignment (history: who, when, note), shown live on
the board (late = red), and posted by Helm into the event's team chat group (or a group picked in Control Center),
@mentioning the admins and the person who scheduled it, plus a bell row. No reply 15 minutes after the due time ->
"No response from X" in the group + bell (once). E-mail only - WhatsApp / SMS are not used.

Owner steps (staging first, then production when you say go):
1. **Database** - paste `supabase/APPLY-0241.sql` in the SQL editor; the last grid must show 7 rows, all `true`.
2. **Scheduler** - if pg_cron is enabled the paste already created `helm_delivery_reminders` (every 5 minutes; it only
   queues). Check: `select jobname, schedule from cron.job where jobname = 'helm_delivery_reminders';`. If pg_cron is
   not enabled: Database > Extensions > `pg_cron`, then
   `select cron.schedule('helm_delivery_reminders', '*/5 * * * *', 'select public.delivery_reminders_tick()');`
3. **Sender** - redeploy the dispatcher: `supabase functions deploy comms-dispatch --no-verify-jwt`
   (same secrets as above: `HELM_COMMS_SECRET`, SMTP_* or RESEND_*, `APP_URL`, `HELM_COMMS_ENABLED`).
   The dispatcher must run on a schedule (step 5 above, `helm_comms_dispatch`). For reminders that land close to the
   chosen minute, run it every 2-5 minutes (`*/2 * * * *` is fine; each run claims at most `COMMS_BATCH` rows).
4. **Switch it on** - Control Center > Notifications > "Delivery & arrival reminders": tick "Send automatic delivery &
   arrival reminders", check the default times, who may be e-mailed and where replies are posted, Save.
5. **Who may schedule** - Control Center > Roles & access > "Deliveries & arrivals (reminders)". Until you save that
   row for a role, the role follows its "Event-day command" switch.

Free trial: reminder e-mails share the trial e-mail limits (30 a day per studio, 5 a day to one address); an ended
trial, the sample studio and sample (demo) events never send. Check: 
`select status, reason, count(*) from public.delivery_reminder_sends group by 1, 2;` and
`select public.delivery_reminders_tick();` (runs the scheduler once by hand).
