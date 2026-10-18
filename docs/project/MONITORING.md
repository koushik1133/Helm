# Helm — Monitoring, Alerts and Backups

Plain-English view of what Helm watches today, what alerts exist, how backups and recovery work, and the gaps. Everything here was checked against code in this repo (files cited). It complements, and does not replace:
`docs/OBSERVABILITY-ACTIVATION.md` (how to switch things on), `docs/STAGING-OBSERVABILITY.md` (staging verification plan), `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/RUNBOOK.md`.

Environments: production `helm.events` (Supabase project `nqltzgiwznphugcfhmbm`), staging `helm-v01.vercel.app` (Supabase `xizehqgeyjcfpzrdymly`). No secret values appear in this document — only names.

---

## 1. Summary

| Layer | Exists in code? | Switched on today? |
|---|---|---|
| Browser error reporting (Sentry via `public/telemetry.js`) | Yes | **No** — no-op until a DSN is set |
| Uptime check | No external monitor configured | **No** |
| Vercel logs (deploys, edge requests) | Built into Vercel | Yes (passive; nobody alerted) |
| Supabase logs (Postgres, Auth, Edge Functions, API) | Built into Supabase | Yes (passive; nobody alerted) |
| In-app audit log (`audit_log` table, Audit page) | Yes | Yes |
| Security alerts (bell + queued e-mail) | Yes (`0054_security_alerts.sql`) | Bell: yes. E-mail: **dormant** until mailer enabled |
| Helm HQ owner dashboard (`public/hq.html`, `hq.js`) | Yes | Yes (platform admins only) |
| Outbox status columns (comms, invites, welcome, etc.) | Yes | Yes (visible by query only) |
| Database cron jobs (`pg_cron`) | Yes | Yes, but failures are not alerted |
| CI scheduled scans (CodeQL, secret scan) | Yes (`.github/workflows`) | Yes (weekly) |
| Backups / PITR | Supabase platform feature | **Assumption:** daily backups on; PITR must be confirmed in dashboard |

Bottom line: Helm records a lot, but **nothing pages a human today**. If the site goes down or an edge function fails repeatedly, the owner only finds out from users.

---

## 2. What is monitored today

### 2.1 Browser errors — `public/telemetry.js`
- Installs global `error` and `unhandledrejection` handlers and, when a DSN exists, loads the pinned Sentry browser SDK (8.35.0) and reports.
- Strong redaction before sending: JWTs, access/refresh tokens, OTP codes, emails, phone numbers, UUIDs, and the token part of client links (`/<studio>/quote|proposal|portal|work|invite/<ref>`, `/i/<slug>`).
- Loaded by 53 pages in `public/*.html`.
- **Status: not live.** `public/config.js` does not set `window.HELM_TELEMETRY`, so `ENABLED` is false and it does nothing. CSP in `vercel.json` / `server.js` already allows the Sentry hosts.
- Activation steps: `docs/OBSERVABILITY-ACTIVATION.md` §1.

### 2.2 Health endpoint
- `server.js` serves `GET /api/health` → `{ ok: true, service, time }`.
- **Important:** `server.js` is the local/dev server. On Vercel the site is static (`outputDirectory: public`, no `api/` folder), so `/api/health` is **Assumption: not available on helm.events** (likely 404). An uptime check should target `/` or a static file instead, or a tiny health function must be added. **Decision needed:** add a real Vercel/Supabase health endpoint, or monitor the home page plus a Supabase REST ping.

### 2.3 Vercel logs
- Deployment build logs and runtime/edge request logs in the Vercel dashboard (per project, prod and staging).
- Useful for: failed deploys, 404/5xx spikes, header/CSP problems after a deploy.
- Retention is plan-dependent; no log drain is configured in this repo.

### 2.4 Supabase logs
- Dashboard → Logs: Postgres, Auth (sign-ins, failed logins, OTP), PostgREST API, Storage, Edge Functions (each function's console output and status code).
- Edge functions in `supabase/functions/`: `comms-dispatch`, `invite-mailer`, `welcome-mailer`, `security-alert-mailer`, `pkg-client-notify`, `billing-reminder`, `booklet-snapshot`, `verify-upload`, `render-photo`, `send-otp`, `send-phone-code`, `send-whatsapp`, `wa-proposal`, `wa-webhook`, `create-payment-link`, `razorpay-webhook`, `create-subscription-checkout`, `razorpay-subscription-webhook`, `invite-signup`, `integrations-test`.
- Razorpay, SMS and WhatsApp paths are switched off (fail-closed) per owner; their logs should stay quiet. WhatsApp is set up separately by the owner (`docs/ops/WHATSAPP-SETUP.md`).

### 2.5 In-app audit log
- Table `public.audit_log`, read by `public/store-api.js` (ordered by `at`) and shown on the Audit page (`public/audit.html`, route `/<studio>/audit`).
- Records who changed what (quotes, leads, milestones, settings, etc.; extended in migrations `0125`, `0135`, `0146`, `0155`, `0156`). Studio-scoped through RLS (`current_org_id` / `has_area`).
- This is a business/accountability record, not a technical alarm.

### 2.6 Security alerts — `supabase/migrations/0054_security_alerts.sql`
- Triggers write `security_alert_events` for: admin overrides, MFA/password lockouts, rejected uploads, studio suspended/reactivated, member role changed or removed, HQ operator added/removed.
- Throttled (`security_alert_throttle`): at most one alert per type per studio per 10 minutes, with a count.
- Delivery:
  - **In-app bell** to studio admins (other roles can opt in via Control Center). Live.
  - **E-mail** via `security_alert_outbox` → edge function `security-alert-mailer`. **Dormant** unless `HELM_SECURITY_ALERTS_ENABLED="true"`. Other env names: `HELM_SECURITY_ALERT_SECRET`, `HELM_SECURITY_ALERT_HQ_TO`, `SECURITY_ALERT_BATCH`. Sender is `notifications@helm.events`, Reply-To the studio email.
  - **Assumption:** no cron in migrations calls this mailer; it must be scheduled (or invoked) once enabled.
- HQ view: `hq_security_alerts(from, to)` RPC — counts per type and studio, names only.

### 2.7 Helm HQ — `public/hq.html` / `public/hq.js` (migrations 0029, 0045)
- Private platform-owner page. Non-operators see "page not found"; every `hq_*` RPC is SECURITY DEFINER and refuses anyone not in `platform_admins`; writes need aal2 (2-step) and are audit-logged.
- Shows studios, their people, subscription billing and security alerts. **No studio business data.**
- Good for a daily glance; it does not alert.

### 2.8 Outboxes (delivery queues)
Tables with status tracking: `comms_outbox` (`pending/sent/skipped/failed`, `attempts`), `invite_email_outbox`, `welcome_email_outbox`, `pkg_outbox`, `assign_notify_outbox`, `security_alert_outbox`. Also `storage_upload_log`, `inv_shortage_alerts`, `wa_proposal_audit`, `studio_consent_log`. Failures are recorded but only visible by SQL query.

### 2.9 Scheduled jobs (`pg_cron`, defined in migrations)

| Job | Schedule (UTC) | Does |
|---|---|---|
| `helm_comms_tick` | every 15 min | `comms_tick()` — queues reminder messages |
| `helm_event_reminders` | hourly at :17 | `event_reminders_tick()` |
| `helm_trial_reminders` | hourly at :07 | `trial_reminders_tick()` |
| `helm_link_expiry_shelf` | every 30 min | expires/shelves client links |
| `helm_billing_refresh` | daily 00:15 | `_billing_refresh()` |
| `helm_discard_empty_drafts` | daily 03:17 | `discard_empty_drafts_all()` |

Failures land in `cron.job_run_details` only; nobody is told.

### 2.10 CI (GitHub Actions, `.github/workflows/`)
`ci.yml`, `e2e.yml`, `db-tests.yml`, `db-canonical-pg17.yml`, `lighthouse.yml` run on push/PR. Scheduled weekly: `codeql.yml` (Mon 04:27) and `secret-scan-history.yml` (Mon 03:17). GitHub e-mails the repo owner on failure by default.

---

## 3. Alert conditions (today vs recommended)

| Condition | Alert today? | Recommended trigger | Channel |
|---|---|---|---|
| Site down (helm.events) | No | 2 failed checks in a row, 1-min interval | Email + phone push |
| Supabase API unreachable | No | REST ping fails 2x | Email + push |
| JS error spike | No (Sentry off) | New issue, or >20 events/hour | Email |
| Security event (lockout, role change, override) | Bell only | Already throttled 10 min; enable mailer | Email to studio admins + HQ inbox |
| Edge function failures | No | Any 5xx burst (>5 in 15 min) per function | Email |
| Outbox stuck/failed | No | `failed` rows > 0, or `pending` older than 1 h | Email (daily digest is enough) |
| Cron job failed | No | Any `failed` in `cron.job_run_details` in last 24 h | Email digest |
| Failed deploy | Vercel default email | Keep | Email |
| CI / CodeQL / secret scan failure | GitHub default email | Keep | Email |
| Backup missing | No | Weekly manual check of dashboard | Owner checklist |

---

## 4. Backups

| Data | Covered by | Notes |
|---|---|---|
| Postgres (tenants, quotes, money ledger) | Supabase daily backups; PITR if enabled | DR runbook target RPO ≤ 5 min requires **PITR** (plan add-on) |
| Storage file bytes (floor plans, uploads, photos) | **Not** in Postgres backup | Only metadata rows are backed up; file bytes need separate copy |
| Edge function code | Git repo (`supabase/functions`) | Redeploy from main |
| Front-end | Git + Vercel deployment history | Instant rollback in Vercel |
| Secrets / env vars | Not backed up by any of the above | Keep in an offline vault (names in `docs/DISASTER-RECOVERY-RUNBOOK.md`) |

- **Decision needed:** confirm PITR is enabled on prod `nqltzgiwznphugcfhmbm` (Dashboard → Database → Backups). Assumption: daily backups are on (paid plan); PITR not confirmed.
- **Decision needed:** set up independent backup of Storage buckets (e.g. scheduled `supabase storage` copy or S3 replication).
- Take a manual snapshot / `pg_dump` before every production SQL migration (DR runbook §4).

---

## 5. Recovery verification

Follow `docs/DISASTER-RECOVERY-RUNBOOK.md` §5 (restore drill). Short version:
1. Restore a backup or PITR point into a **new, throwaway** project — never over live prod (zero-data-loss rule).
2. Check row counts of key tables (studios/orgs, quotes, milestones/ledger, audit_log) against prod at that time.
3. Sign in as a test user on the restored copy (pointed via a local `config.js`), open a quote and its builder plan.
4. Confirm RLS still isolates studios (`test/` DB suite, `docs/DB-TEST-SUITE.md`).
5. Record date, restore time taken and result. Delete the throwaway project.

Recommended cadence: once per quarter, and after any big schema change. **Status:** no completed prod restore drill is recorded in this repo (Assumption).

---

## 6. Gaps

1. No uptime monitoring; `/api/health` likely does not exist on Vercel.
2. Sentry code ready but no DSN — browser errors are invisible.
3. Security-alert e-mail dormant; no schedule for the mailer.
4. Edge function failures and outbox `failed` rows are not alerted.
5. Cron job failures not alerted.
6. PITR not confirmed; Storage files have no independent backup.
7. No restore drill on record.
8. No log drain / long retention for Vercel or Supabase logs.

---

## 7. Recommended simple monitoring (low cost, about 1–2 hours total)

1. **Uptime (10 min):** UptimeRobot / Better Stack free tier.
   - Monitor `https://helm.events/` (HTTP 200, 1 min).
   - Monitor Supabase REST: `https://nqltzgiwznphugcfhmbm.supabase.co/rest/v1/` with the public anon key header (expect 200/401-not-5xx).
   - Same pair for staging at a 5-min interval.
2. **Error alerts (20 min):** create Sentry project, set `window.HELM_TELEMETRY` in `public/config.js` (DSN is public, not a secret; `env` = `production`/`staging`), add an error-spike alert. See `docs/OBSERVABILITY-ACTIVATION.md`.
3. **Security e-mails (15 min):** set `HELM_SECURITY_ALERTS_ENABLED`, `HELM_SECURITY_ALERT_SECRET`, `HELM_SECURITY_ALERT_HQ_TO` on the function, then schedule it (e.g. every 5 min via `pg_cron` + `pg_net`, or an external cron) — **Decision needed** on which.
4. **Daily health digest (30 min):** one `pg_cron` job (or a scheduled GitHub Action) that counts, for the last 24 h: failed cron runs, outbox rows `failed` or `pending` > 1 h, security events, and e-mails the HQ inbox only when something is non-zero. Read-only queries; no data changes.
5. **Edge function failures:** in Supabase, use Log Explorer saved queries for status ≥ 500 per function; review weekly until an alerting integration (log drain to Better Stack/Datadog) is justified.
6. **Backups:** enable PITR on prod, schedule Storage backup, and run the first restore drill.
7. **Weekly owner checklist (5 min):** HQ page security alerts, Vercel failed deploys, Supabase backup timestamp, GitHub scan results.

Decision needed: monthly budget for monitoring (free tiers cover items 1, 2 and 4 at current scale).
