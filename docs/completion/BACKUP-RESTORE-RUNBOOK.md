# Helm backup & restore runbook (I-28 — recovery readiness)

**Status of this deliverable**
- **Procedure + verify scaffold = DELIVERED** (this file + `supabase/completion/RESTORE-VERIFY.sql`).
- **Live restore DRILL = BLOCKED.** No disposable/throwaway DB target exists in this
  environment and there are **no credentials** here (`HELM_E2E_*` all MISSING). A real
  drill must NOT run against production (`nqltzgiwznphugcfhmbm`) or staging
  (`xizehqgeyjcfpzrdymly`). This document is written so a human operator can execute
  the drill later against a fresh throwaway target.

**Safety rules (non-negotiable)**
- Restore ONLY into a **throwaway** target: a brand-new Supabase project you will delete
  after the drill, or a local/ephemeral Postgres. **Never** restore over production or
  staging — a restore is destructive to whatever it lands on.
- All checks in `RESTORE-VERIFY.sql` are read-only; running them is safe on any target,
  but you should still only point them at the restored throwaway copy.
- Never print, paste, or commit connection strings, service-role keys, or DB passwords.

---

## (a) How to obtain a backup

### Pro tier (preferred) — dashboard snapshot
1. Supabase dashboard → **Project** → **Database** → **Backups**.
2. Confirm a recent automated daily snapshot exists, or click **Backup now** / take a
   Point-in-Time-Recovery (PITR) marker if PITR is enabled.
3. Record: snapshot timestamp, whether PITR is on, and the retention window. These feed
   the RPO note below.
4. For an off-platform copy (recommended before a risky migration), also run a logical
   dump from an operator machine (never commit the output):
   ```bash
   # Requires the Supabase CLI logged in; DB password supplied via env, never echoed.
   supabase db dump --project-ref <PROD_REF> -f helm-backup-$(date +%F).sql
   # or, direct pg_dump against the pooler/direct connection string:
   #   pg_dump "$HELM_DB_URL" --no-owner --no-privileges -Fc -f helm-backup-$(date +%F).dump
   ```
   `-Fc` (custom format) is preferred for restore flexibility with `pg_restore`.

### Free tier fallback — table export
If snapshots/PITR aren't available, export the critical tables. Minimum set (money +
inventory + tenancy first), then the rest of the schema:
- **Critical:** `quotes`, `quote_payments`, `payment_milestones`, `inventory_items`,
  `quote_consents`, `leads`, `profiles`, `organizations`, `role_access`.
- **Also export:** `audit_log`, `layouts`, `event_sites`, `notifications`,
  `event_costs`, `event_refunds`, `expense_claims`, and any table with live data.

Options:
```bash
# Per-table CSV via psql \copy (run from operator machine; safe, read-only on source):
psql "$HELM_DB_URL" -c "\copy public.quotes         to 'quotes.csv'         csv header"
psql "$HELM_DB_URL" -c "\copy public.quote_payments to 'quote_payments.csv' csv header"
psql "$HELM_DB_URL" -c "\copy public.inventory_items to 'inventory_items.csv' csv header"
# ...repeat for each critical table.
```
Or Supabase Table Editor → each table → **Export → CSV**. Note that CSV export loses
constraints, triggers, RLS policies, and functions — you must re-apply the schema from
`supabase/HELM-STAGING-SCHEMA.sql` + the phase files before importing the rows, and RLS
will read FAIL in verify until policies are re-applied. Snapshot restore is strongly
preferred over CSV for exactly this reason.

---

## (b) EXACT restore procedure into a THROWAWAY target

Choose ONE target. Both end at the same verify step.

### Option 1 — new throwaway Supabase project
1. Create a **new** Supabase project (name it e.g. `helm-drill-YYYYMMDD`). This is the
   disposable target; you will delete it at the end.
2. Get its direct connection string → export as `HELM_DRILL_DB_URL` in your shell
   (never commit it).
3. Restore:
   - **From a logical dump (`.dump`/custom format):**
     ```bash
     pg_restore --no-owner --no-privileges --clean --if-exists \
       -d "$HELM_DRILL_DB_URL" helm-backup-YYYY-MM-DD.dump
     ```
   - **From a plain SQL dump:**
     ```bash
     psql "$HELM_DRILL_DB_URL" -f helm-backup-YYYY-MM-DD.sql
     ```
   - **From CSV fallback:** first apply schema, then import rows:
     ```bash
     psql "$HELM_DRILL_DB_URL" -f supabase/HELM-STAGING-SCHEMA.sql
     # re-apply any phase files the schema file does not itself include, then:
     psql "$HELM_DRILL_DB_URL" -c "\copy public.quotes from 'quotes.csv' csv header"
     # ...repeat per table, parents before children (organizations/profiles → leads → quotes → quote_payments).
     ```
4. Note the wall-clock time restore took (feeds the RTO note).

### Option 2 — local / ephemeral Postgres (fully offline drill)
1. Start a throwaway Postgres:
   ```bash
   docker run --rm -d --name helm-drill -e POSTGRES_PASSWORD=drill \
     -p 55432:5432 postgres:16
   export HELM_DRILL_DB_URL="postgresql://postgres:drill@localhost:55432/postgres"
   ```
   (`--rm` makes it disposable; `docker rm -f helm-drill` destroys it.)
2. Ensure required extensions exist before restore (Supabase schema uses them):
   ```bash
   psql "$HELM_DRILL_DB_URL" -c 'create extension if not exists pgcrypto; create extension if not exists "uuid-ossp";'
   ```
   (`pgcrypto` is needed for `gen_random_bytes` used by `request_otp`.)
3. Restore with the same `pg_restore` / `psql` command as Option 1.
   Note: a local Postgres lacks the `auth`/`supabase_auth_admin` roles; use
   `--no-owner --no-privileges` and expect auth-schema objects to be skipped — the
   `public`-schema business tables, constraints, triggers, functions, and RLS policies
   are what this drill verifies.

---

## (c) Verification step

1. Run the verify scaffold against the **restored throwaway target only**:
   ```bash
   psql "$HELM_DRILL_DB_URL" -f supabase/completion/RESTORE-VERIFY.sql
   ```
   (Or paste the file into the throwaway project's SQL editor.)
2. Read the single result set:
   - Every **presence** and **invariant** row must read **PASS**
     (the `quote_payments amount>0 CHECK` row may read **SKIPPED** if that constraint
     was intentionally omitted upstream — that matches prod's own PROD-02 behavior).
   - **INFO** rows carry live row counts. Compare each to the **baseline** you recorded
     when you took the backup (step (a)). Counts must match the source (allowing for any
     rows written between snapshot time and dump time).
3. What the scaffold proves survived restore:
   - Key tables present (money, inventory, tenancy, RBAC, audit, layouts, sites).
   - Row-count parity vs. baseline (no silent truncation).
   - **Pricing authority** invariant (W15-001): `helm_quote_total` rejects a
     caller-supplied total.
   - **Overpayment** guards on both `quote_payments` and `payment_milestones`.
   - Inventory / payment **CHECK** constraints.
   - FK delete rule is **RESTRICT** (no cascade wipe of payments/consents).
   - **RLS** is enabled with policies present, and `has_area` (the RLS driver) restored.
   - Core RPCs restored (`request_otp`, `record_payment`, `can_create`, `can_edit`).
4. Optional deeper parity check: for the critical tables, compare a checksum of ordered
   rows on source vs. restored (read-only on both):
   ```sql
   -- run on each side, compare the two values
   select md5(string_agg(t::text, ',' order by t.id)) from public.quote_payments t;
   ```

---

## (d) Rollback conditions

A DRILL restore targets a throwaway DB, so "rollback" = **abandon and destroy the
throwaway target** — never promote it. Declare the restore FAILED (do not proceed to
any production cutover that depended on it) if ANY of these hold:

- Any **presence** or **invariant** row in `RESTORE-VERIFY.sql` reads **FAIL**.
- INFO row counts diverge from baseline beyond the known snapshot→dump write gap
  (missing rows = data loss in the backup path — fix the backup method, do not trust it).
- RLS rows read `FAIL (RLS OFF after restore)` — the restore path dropped tenant
  isolation; a CSV/logical path needs the policy DDL re-applied before it can be trusted.
- Pricing-bypass row reads `FAIL (bypass OPEN)` — the pricing-authority function did not
  survive; restored data would be exploitable.
- `pg_restore`/`psql` exited non-zero, or the log shows errors beyond the expected
  auth-role/ownership skips.

Cleanup after a drill (pass or fail):
```bash
docker rm -f helm-drill            # local option
# or delete the helm-drill-YYYYMMDD Supabase project from the dashboard
```
Then delete local dump/CSV artifacts (they contain live customer data): shred/remove
`helm-backup-*.dump`, `helm-backup-*.sql`, `*.csv`. Never commit them.

---

## (e) RPO / RTO note

- **RPO (Recovery Point Objective) — how much data you can afford to lose.**
  - Pro tier with **daily snapshots only:** RPO ≈ up to 24h (worst case: failure just
    before the next daily snapshot).
  - Pro tier with **PITR enabled:** RPO ≈ minutes (target ≤ 5 min), bounded by WAL
    shipping. **Recommended** for the money tables (`quotes`, `quote_payments`,
    `payment_milestones`).
  - Free tier / CSV fallback: RPO = "time since your last manual export" — effectively
    unbounded and operator-dependent. Treat as a stopgap, not a strategy.
  - **Target to adopt:** enable PITR on production so RPO ≤ 5 minutes for financial data.

- **RTO (Recovery Time Objective) — how long recovery takes.**
  - New throwaway Supabase project + logical restore: budget ~30–60 min for a
    small/medium DB (project provision + restore + verify), dominated by data volume.
  - Local Postgres drill: ~10–20 min (no cloud provisioning).
  - **Target to adopt:** RTO ≤ 1h for a full restore-and-verify; re-measure and record
    the actual `pg_restore` wall-clock each time the drill is run, since RTO grows with
    data size.
  - Record the measured RPO/RTO from each drill back into this section so the numbers
    stay honest.

---

## Drill status log (fill in when the live drill is run)

| Date | Target (throwaway) | Backup source + timestamp | Restore time (RTO) | Verify result | Operator |
|------|--------------------|---------------------------|--------------------|----------------|----------|
| _(pending — BLOCKED: no disposable target + no creds in this env)_ | | | | | |
