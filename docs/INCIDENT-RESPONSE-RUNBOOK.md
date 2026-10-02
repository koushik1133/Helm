# INCIDENT-RESPONSE-RUNBOOK.md (Agent G)

Incident response for Helm production. Legend: **SOURCE** · **STAGING VERIFIED** ·
**RECOMMENDATION** · **BLOCKED**. Pairs with DISASTER-RECOVERY-RUNBOOK (recovery
mechanics) and OBSERVABILITY-ACTIVATION.md (signal wiring).

## 1. Severity levels (RECOMMENDATION)
| SEV | Definition | Example | Response |
|-----|-----------|---------|----------|
| **SEV1** | Data loss, money error, or cross-tenant exposure; or full outage | wrong-org data visible; duplicate/lost payment; site down | page owner immediately; all-hands; comms clock starts |
| **SEV2** | Major function broken, no data/money loss | OTP delivery down; quotes can't save | owner within 30 min; fix same day |
| **SEV3** | Degraded / partial, workaround exists | slow dashboard; one integration flaky | next business day |
| **SEV4** | Cosmetic / low impact | UI glitch, typo | backlog |
- Any suspected **cross-tenant data exposure or money discrepancy is SEV1** (ties to
  the zero-data-loss guardrail).

## 2. On-call / owner (RECOMMENDATION — fill in)
- Primary owner / incident commander: ______ (currently `hr@criskasecurity.com` as
  default contact).
- Secondary / escalation: ______. Define a single IC per incident who owns decisions.

## 3. Lifecycle: triage → containment → eradication → recovery
1. **Triage:** confirm it's real, assign SEV, name an IC, open a timeline doc.
2. **Containment:** stop the bleeding — e.g. flip a `liveChannels` flag off, disable a
   compromised Edge function, revoke a leaked key, block an abusive IP. Prefer
   fail-closed (the app's integrations are already dormant/fail-closed by default —
   **SOURCE** memory: WhatsApp/Razorpay).
3. **Eradication:** remove root cause — patch code, rotate secret, fix data via an
   additive/idempotent script (NEVER a destructive one).
4. **Recovery:** restore service via the matching DISASTER-RECOVERY domain; verify
   `/api/health` + a real login + one quote read.
5. **Postmortem:** see §7.

## 4. Secret rotation steps
Trigger: any suspected key exposure (SEV1/2).
1. Generate a new secret at the provider (Razorpay / MSG91 / Resend / Supabase
   service-role).
2. `supabase secrets set NAME=<new>` — set by NAME, value never logged (**SOURCE**
   `PRODUCTION-RELEASE-PACK.md` §7–8).
3. Redeploy the consuming Edge function so it picks up the new value.
4. Invalidate the old secret at the provider; for the webhook secret, update the
   provider dashboard so inbound signatures verify against the new value.
5. For service-role / JWT secret rotation, expect session invalidation — communicate.
6. Record rotation in the incident timeline. Scan repo/logs to confirm no secret leaked
   (`.gitleaks.toml` present — **SOURCE**).

## 5. Rollback
- **Code (Vercel):** promote the prior production deployment / redeploy last-good SHA.
- **DB:** restore pre-apply snapshot, OR run the per-object reverse script; migrations
  are additive/idempotent so forward-fix is usually safer than reverse (**SOURCE**
  `PRODUCTION-RELEASE-PACK.md` §9). NEVER hand-delete production rows to "undo".
- **Edge:** redeploy previous function versions.
- **Vercel env/config:** revert the changed env var and redeploy.

## 6. Customer-comms decision tree (RECOMMENDATION)
- Cross-tenant data exposure OR confirmed payment error (SEV1) → **notify affected
  tenants**; assess regulatory/DPDP breach-notification duty (India DPDP: 72h-class
  obligations) → escalate to legal/owner. Do NOT send on your own — comms are a
  send-on-user-behalf action requiring explicit owner approval.
- Outage > RTO (SEV1/2) → status-page / direct notice to active tenants.
- Internal-only, no customer impact (SEV3/4) → internal log only.

## 7. Postmortem (RECOMMENDATION)
Blameless, within 5 business days of SEV1/2: timeline, root cause, detection gap,
customer impact, action items with owners + dates. File under `docs/`.

## 8. Observability activation checklist — BLOCKED (NOT yet active)
`OBSERVABILITY-ACTIVATION.md` documents the code hooks; `telemetry.js` + `/api/health`
exist (**SOURCE**) but **nothing is ON until an operator wires the dashboards/DSN.**
All items below are **BLOCKED** pending that setup:
- [ ] Frontend JS errors → Sentry (DSN in `config.js`; `telemetry.js` redacts
      JWT/token/OTP/email/phone via `beforeSend` — **SOURCE**).
- [ ] Edge Function errors (structured one-line JSON per invocation).
- [ ] Auth failures (failed sign-in / invalid-OTP / expired session).
- [ ] DB CPU / connection count alerts.
- [ ] Storage usage / quota alerts.
- [ ] Slow-query monitoring.
- [ ] HTTP 5xx rate alert.
- [ ] Uptime monitor on `/api/health` + `/` (1-min interval).
- [ ] OTP-abuse / OTP-pumping spike detection.
- [ ] Payment anomaly alerts (declines, amount-mismatch — webhook already logs
      amount-under-total, **SOURCE** `razorpay-webhook`).
- [ ] Webhook-failure visibility (invalid signature → 401, logged — **SOURCE**;
      failed rows queryable without raw body per STAGING-OBSERVABILITY §2).

## 9. Log hygiene (invariant)
Logs must NEVER contain passwords, OTP values, tokens, service-role keys, or payment
secrets. **SOURCE:** webhook uses constant-time signature compare and logs only status
/ ids, not raw bodies (`razorpay-webhook/index.ts`); `telemetry.js` `beforeSend`
redacts PII/secrets. Any new log line must be reviewed against this rule.
