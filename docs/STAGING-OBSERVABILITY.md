# STAGING-OBSERVABILITY.md

Plan for verifying observability on the STAGING Supabase project
(`xizehqgeyjcfpzrdymly`) and the staging-wired Vercel branch-preview. Nothing here
runs against production. This is a verification PLAN plus a restore-drill plan — it is
not itself evidence; each item is confirmed only when the described observation is made.

## 0) Scope & non-goals
- Verify we can SEE failures (Edge logs, auth failures, payment failures, failed webhooks)
  and liveness (health endpoint) on staging.
- NON-GOAL: enabling live external channels. `liveChannels.{sms,pay,whatsapp}` stay `false`
  on staging unless a specific test explicitly uses provider TEST mode with test keys.

## 1) Structured Edge Function logs
- [ ] Each Edge Function (send-otp, create-payment-link, send-whatsapp, worker_respond,
      any health fn) emits ONE structured JSON line per invocation: `{ts, fn, level,
      request_id, outcome, latency_ms, err_code?}`. No secrets, no PII, no tokens.
- [ ] Verify in Supabase Dashboard → Edge Functions → Logs that a staging invocation
      produces the structured line with a correlatable `request_id`.
- [ ] Confirm `request_id` is also returned to the caller so a client error can be tied
      to a server log line.

## 2) Failed-webhook visibility
- [ ] Inbound webhooks (e.g. Razorpay payment status in TEST mode) that fail signature
      verification or processing are recorded to a `webhook_events` (or equivalent) table
      with status `failed`, the reason, and the raw-but-redacted payload hash.
- [ ] A failed webhook is queryable (count + last_error) without reading the raw body.
- [ ] Fail-closed: a webhook that cannot be verified is REJECTED (4xx) and logged, never
      silently accepted.

## 3) Auth failures
- [ ] Failed sign-in / invalid-OTP / expired-session events are visible in Supabase Auth
      logs on staging.
- [ ] Repeated failures from one identity are observable (basis for future rate-limit/alert).
- [ ] No credential or OTP value appears in any log line.

## 4) Payment failures (TEST mode only)
- [ ] A declined/failed TEST payment surfaces as a structured log + a `failed` row,
      distinct from success, with provider error code preserved.
- [ ] The UI reflects failure (no false "paid" state) — cross-checked by the payment-sim
      Playwright flow (#22).

## 5) Health endpoint
- [ ] A lightweight health route/function returns `{status:"ok", ref, time}` where `ref`
      is the STAGING project ref — used to confirm WHICH project is live.
- [ ] Health check does NOT require auth and does NOT leak config/secrets.
- [ ] Add to the staging preview report §8 runtime sweep.

## 6) Alerting (plan only)
- [ ] Decide thresholds (error rate, webhook-failure count, auth-failure spikes) and the
      channel. Not wired yet — documented as a follow-up, not claimed as done.

---

## 7) NON-PRODUCTION restore-drill plan
> **Backup/recovery is NOT considered verified until an actual restore test completes.**
> Having backups configured is necessary but NOT sufficient. Until the drill below runs
> green, recovery status is "UNVERIFIED".

Drill (run on an ISOLATED scratch project, never production, never the shared staging DB
mid-test):
1. Provision a throwaway restore-target Supabase project (or a staging snapshot clone).
2. Take/identify a known backup/snapshot of staging with a known-good data fixture in it.
3. Restore that backup into the throwaway target.
4. Assert: table count matches expected schema (e.g. 59 tables), a known fixture row is
   present and intact, and RLS policies are present post-restore.
5. Measure and record RTO (time to restore) and RPO (data-loss window vs. last backup).
6. Tear down the throwaway target.
7. Record result + date in this doc. Only then may "restore verified" be claimed, and only
   for the backup type actually drilled.

### Drill log
| Date | Backup type | Target | Tables OK | Fixture intact | RLS intact | RTO | RPO | Result |
|------|-------------|--------|-----------|----------------|------------|-----|-----|--------|
| —    | —           | —      | —         | —              | —          | —   | —   | UNVERIFIED |

### Zero-data-loss guardrail tie-in
Per the project's top-priority guardrail, the drill itself must be additive/read-only on
the SOURCE: it reads a backup and writes only to the throwaway target. It must never
restore onto, overwrite, or point writes at production or the live staging DB.
