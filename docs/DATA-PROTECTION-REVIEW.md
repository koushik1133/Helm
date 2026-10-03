# DATA-PROTECTION-REVIEW.md (Agent I)

Data-protection posture for Helm. Legend: **SOURCE** · **STAGING VERIFIED** ·
**RECOMMENDATION** · **BLOCKED**.

## 1. Storage: private buckets + tenant RLS + MIME/size (STAGING VERIFIED)
- **SOURCE** `supabase/migrations/0013_storage_hardening.sql`:
  - `invite-media`: `public=false`, size cap **8 MB**, MIME allowlist
    `image/{png,jpeg,webp,gif}`.
  - `event-docs`: `public=false`, size cap **10 MB**, MIME allowlist
    `application/pdf` + `image/{png,jpeg,webp}`.
  - Object RLS: own-org only — `(storage.foldername(name))[1] = current_org_id()` for
    select/insert/update/delete; the old public-read policy is dropped. No public
    object listing.
  - Config enforced in SQL (not dashboard-only) and idempotent.
- **STAGING VERIFIED:** storage suite **31/31** passing on staging
  (`DB-TEST-SUITE.md` / storage suite); tenant RLS = 0 cross-org leaks. Object keys are
  server-issued UUIDs (`<org_id>/<quote_id>/...`), not client-chosen.

## 2. Malware scanning for customer uploads — RECOMMENDATION (gap)
- MIME allowlist + size cap + private buckets reduce but do NOT eliminate malicious-file
  risk (a PDF/image can still carry a payload; MIME is declared, not proven server-side
  beyond the allowlist). **No AV/malware scan exists today.**
- **RECOMMENDATION:** add a scan-on-upload step (e.g. Storage webhook → ClamAV / a
  scanning API) that quarantines or rejects infected objects before they're servable.
  Serve customer files only via short-lived signed URLs (buckets are private), never
  public URLs.

## 3. Retention (RECOMMENDATION — define + ratify)
- **Files (invite-media / event-docs):** define per-bucket retention; purge media for
  cancelled/expired events after N months. Purges must be additive/idempotent and
  org-scoped (zero-data-loss guardrail) — soft-delete then hard-delete on a schedule,
  never ad-hoc bulk deletes.
- **PII (customer contact, quotes):** retain for the contractual/accounting period,
  then minimize/anonymize. India DPDP → keep only as long as the stated purpose
  requires.
- **Audit log:** retain longer than operational data (e.g. ≥ 1 year) and make it
  append-only / tamper-evident; never auto-purge audit before PII.

## 4. Account deletion / org deletion (RECOMMENDATION)
- **Account (user) deletion:** disable auth identity, revoke sessions, reassign or
  tombstone their authored rows (don't orphan money/audit records). Keep ledger/audit
  entries for integrity; redact personal fields.
- **Org (tenant) deletion:** a destructive, multi-table, cross-bucket operation —
  **requires explicit owner approval, a dry-run count, and a pre-delete snapshot.**
  Export first (§5), then delete org-scoped rows + objects in dependency order. Must
  never touch other tenants (verify `org_id` scoping on every statement). This is a
  guardrail-sensitive operation — forward-only script, reviewed before run.

## 5. Data export (RECOMMENDATION)
- Provide a per-tenant export (quotes, events, contacts, uploaded docs) via the
  SECURITY DEFINER RPC boundary so RLS/authz still applies. Deliver via signed URL to
  the authenticated requester; never email raw PII. Supports both DPDP access rights
  and pre-deletion backup.

## 6. Legal hold (RECOMMENDATION)
- Add a per-org/per-record "legal hold" flag that SUSPENDS retention purges and blocks
  org/account deletion while set. Retention and deletion jobs must check it first.

## 7. Logs do not expose sensitive data (SOURCE — confirmed)
- `razorpay-webhook`: constant-time signature compare; invalid signature → 401; logs
  status/ids and amount-mismatch, not raw bodies or secrets (**SOURCE**
  `razorpay-webhook/index.ts`).
- `send-otp`: OTP stored only as a bcrypt hash via `admin_store_otp`; the code value is
  not logged (**SOURCE** `send-otp/index.ts`).
- `telemetry.js` `beforeSend` redacts JWTs, tokens, OTPs, emails, phone numbers before
  any Sentry send (**SOURCE** `OBSERVABILITY-ACTIVATION.md`).
- Edge secrets set by NAME, values never logged (**SOURCE** `PRODUCTION-RELEASE-PACK.md`).
- **Invariant to preserve:** no password / OTP / token / service-role / payment secret
  in any log line (see INCIDENT-RESPONSE-RUNBOOK §9).

## 8. BLOCKED / open items
- **Malware scanning:** not implemented → RECOMMENDATION (open gap).
- **Retention / legal-hold / export / org-deletion flows:** policy + tooling not yet
  built → RECOMMENDATION. None applied by this read-only review.
