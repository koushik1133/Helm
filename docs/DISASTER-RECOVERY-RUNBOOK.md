# DISASTER-RECOVERY-RUNBOOK.md (Agent F)

Recovery runbook for Helm production. Builds on `docs/STAGING-OBSERVABILITY.md` §7
(restore-drill plan) — does not duplicate it. Legend: **SOURCE** · **STAGING VERIFIED**
· **RECOMMENDATION** · **BLOCKED**.

## 1. RPO / RTO targets (RECOMMENDATION — ratify with business owner)
| Domain | RPO (max data loss) | RTO (max downtime) |
|--------|--------------------|--------------------|
| PostgreSQL (tenant data, money ledger) | ≤ 5 min (PITR) | ≤ 2 h |
| Storage objects (invite-media, event-docs) | ≤ 24 h | ≤ 4 h |
| Edge Function source | 0 (in git) | ≤ 30 min (redeploy) |
| Vercel frontend | 0 (in git) | ≤ 15 min (promote prior) |
| Secrets / config | 0 if vaulted offline | ≤ 1 h (re-set by name) |

The money ledger drives the tight DB RPO: a lost `record_payment`/`mark_paid` is a
financial discrepancy, so PITR (not just daily snapshot) is required for prod.

## 2. Five SEPARATE recovery domains (critical — they are NOT one backup)
A single "Supabase backup" does **not** cover everything. Each domain fails and
recovers independently:
1. **PostgreSQL** — tables, RLS, SECURITY DEFINER RPCs. Covered by Supabase
   PITR/snapshots.
2. **Storage objects** — bytes in the `invite-media` / `event-docs` buckets. **NOT**
   in the Postgres backup; only the object *metadata rows* are. The file bytes need a
   separate copy (**SOURCE:** buckets defined in `supabase/migrations/0013_storage_hardening.sql`).
3. **Edge Function source & deployed versions** — `supabase/functions/*`
   (send-otp, create-payment-link, send-whatsapp, razorpay-webhook). Source is in git;
   the *deployed* version must be re-pushed.
4. **Vercel frontend** — static app + `/api/health`; recovered by promoting a prior
   production deployment.
5. **Secrets** — Edge secrets set by NAME (MSG91, RAZORPAY_KEY_ID/KEY_SECRET,
   RAZORPAY_WEBHOOK_SECRET, RESEND_*, etc. — **SOURCE** `PRODUCTION-RELEASE-PACK.md`
   §7–8). Values are never in git/logs, so they are **not** recoverable from a
   code/DB restore — they must be re-provisioned from an offline vault.

## 3. Recovery procedure per domain
### 3.1 PostgreSQL
1. Identify target recovery point (PITR timestamp or named snapshot).
2. Restore to a **new** project first (never in place) — see drill §5.
3. Validate (table count, a known fixture row, RLS policies present) before cutover.
4. Repoint app (`config.js` / Vercel env) to restored ref.
- **Zero-data-loss guardrail:** restore to a NEW target and validate before any
  repoint; never restore over the live prod DB.

### 3.2 Storage objects
1. Restore bucket bytes from the independent object backup/replication.
2. Re-apply bucket config (private, MIME allowlist, size cap) — re-run
   `0013_storage_hardening.sql` (idempotent, **SOURCE**).
3. Verify object keys still match `<org_id>/...` RLS layout.

### 3.3 Edge Functions
1. `git checkout` the known-good commit.
2. `supabase functions deploy <name>` for each function.
3. Re-set any required secrets by name (§3.5).

### 3.4 Vercel
1. Vercel → Deployments → promote the last known-good production deployment, OR
   redeploy the known-good git SHA.
2. Confirm `/api/health` → `{ok:true}` and correct project ref.

### 3.5 Secrets
1. Retrieve from offline vault (NOT from repo/logs).
2. `supabase secrets set NAME=...` per name; never echo values to logs.
3. Rotate anything suspected exposed (see INCIDENT-RESPONSE-RUNBOOK §secret rotation).

## 4. PITR / snapshot assumptions (RECOMMENDATION — verify in prod dashboard)
- PITR must be ENABLED on the prod project (plan-gated feature) for the ≤5 min RPO.
- Daily automated snapshots + a fresh manual snapshot taken IMMEDIATELY before every
  migration apply (**SOURCE** `PRODUCTION-RELEASE-PACK.md` §9).
- Confirm retention window covers the RTO/RPO decision in §1.

## 5. RESTORE-DRILL procedure (against a DISPOSABLE non-prod project)
Follows `STAGING-OBSERVABILITY.md` §7:
1. Provision a throwaway restore-target project.
2. Identify a known backup/snapshot containing a known-good fixture.
3. Restore into the throwaway target.
4. Assert: expected table count, fixture row intact, RLS policies present post-restore.
5. Record RTO (time to restore) + RPO (loss window vs last backup).
6. Tear down the throwaway target.
7. Log date + result; only then may "restore verified" be claimed, for that backup
   type only.

### 5.1 Drill status — BLOCKED (OPEN RELEASE GATE)
- **The restore drill has NOT YET BEEN EXECUTED.** Status: **BLOCKED** — needs a
  disposable restore target + Supabase plan access to run a restore.
- Per `PRODUCTION-RELEASE-PACK.md` §9, backup is **NOT verified** by this program.
- **This is a release gate and it is currently OPEN.** Recovery status stays
  "UNVERIFIED" until the drill runs green and is logged in
  `STAGING-OBSERVABILITY.md` §7 drill log.
