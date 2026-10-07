# DB test suite — payment ledger, OTP approval, RLS/RBAC

Database-layer tests for Helm's money and consent paths. They target the trigger,
RPC and RLS boundaries directly — the layer E2E/Playwright can't reach.

> **NOT YET EXECUTED.** No isolated test database credentials were available when
> this suite was authored. **Nothing here has been run**, and this repository
> contains **no real output** from these tests. They are delivered runnable and
> must be executed by someone with access to an isolated non-production DB.
> No results in this document or in any test file are fabricated — the sample
> lines shown are the *format* of output, explicitly labelled as such.

## Safety — never production

- `supabase/tests/run-db-tests.sh` **refuses** any URL containing the production
  project ref `nqltzgiwznphugcfhmbm`, and refuses non-staging URLs unless
  `ALLOW_NON_STAGING=1` (for a throwaway project).
- Every `.sql` file refuses to run unless you pass `-v HELM_TEST_ACK=1`.
- `tests/db/rest-ledger-rls.mjs` refuses a `HELM_TEST_REST_URL` on the prod ref.
- The CI job refuses if any secret points at the prod ref.
- Intended targets: **staging `xizehqgeyjcfpzrdymly`** or a **throwaway Supabase
  project**. Use the **direct** connection (port 5432), not the pooler.

## Preconditions (apply to the test DB first, in order)

```
supabase/HELM-STAGING-SCHEMA.sql
supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql          # trg_no_overpayment (INSERT)
supabase/prod-fix/B2-overpayment-concurrency-lock.sql   # per-quote advisory lock
supabase/prod-fix/B5-record-settlement-payment.sql      # record_settlement_payment()
supabase/prod-fix/C2b-PROD-otp-lockout.sql              # OTP attempts persist
# The fixes these tests GUARD (apply to turn the regression guards green):
supabase/harden-2026-10/H01-overpayment-update-path-and-lock.sql   # CASE 3
supabase/harden-2026-10/H02-otp-verify-row-lock.sql                # CASE 5 race
# CASE 4 group-2 needs a ledger-RLS lockdown that is NOT yet written — see below.
```

The schema snapshot `HELM-STAGING-SCHEMA.sql` (dated before W16-04) does **not**
itself contain the overpayment trigger; it comes from the W16-04/B2 migrations.
Each test file probes for what it needs and prints a clear NOTE when a guard is
missing.

## Files

| File | Brief case | Kind |
|------|-----------|------|
| `supabase/tests/00-fixtures.sql` | — | idempotent fixtures (orgs A/B, 6 users, role_access, quotes, milestone) |
| `supabase/tests/10-overpayment-concurrency.sql` | 1 | cap invariant (single session) |
| `supabase/tests/20-idempotency-key.sql` | 2 | unique index + RPC replay |
| `supabase/tests/30-overpayment-update-path.sql` | 3 | **regression guard** (H01) |
| `supabase/tests/40-ledger-rls.sql` | 4 | RLS negatives; group 2 is a **regression guard** |
| `supabase/tests/50-otp-race-lockout.sql` | 5 | lockout/expiry/single-use; C5.a is a **regression guard** (C2b) |
| `supabase/tests/60-tenant-rbac.sql` | 6 | tenant isolation + role matrix |
| `supabase/tests/99-teardown.sql` | — | removes everything the fixtures created |
| `supabase/tests/run-db-tests.sh` | 1,2,5 (+all) | orchestrator + **real multi-session concurrency** |
| `tests/db/rest-ledger-rls.mjs` | 4 | RLS negatives through the **PostgREST** endpoint; staff checks are a **regression guard** |
| `.github/workflows/db-tests.yml` | — | gated CI job (requires `HELM_TEST_*` secrets) |

## Run everything

```bash
HELM_TEST_DB_URL='postgresql://postgres:<pw>@db.xizehqgeyjcfpzrdymly.supabase.co:5432/postgres' \
  bash supabase/tests/run-db-tests.sh
```

Exit code is 0 only if every test passes. **Expected before the pending fixes:
CASE 3, CASE 4 group-2 and the CASE 5 race FAIL by design** (they assert the
secure end-state that H01 / the ledger lockdown / H02 will deliver).

## Run one case (fixtures + case + teardown)

```bash
psql "$HELM_TEST_DB_URL" -X -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1 \
  -f supabase/tests/00-fixtures.sql \
  -f supabase/tests/<NN>-<case>.sql \
  -f supabase/tests/99-teardown.sql
```

Each file prints `PASS <id>: …` notices; a failed assertion `raise`s and psql
exits non-zero. (Illustrative format only — not a recorded run.)

## Case-by-case: command, expectation, regression status

### Case 1 — concurrent payments, same quote (`10-…` + runner `C1`)
- **Run:** the one-case command with `10-overpayment-concurrency.sql`; the real
  two-session race is `run-db-tests.sh` group **C1**.
- **Expected:** the cap invariant holds — one of two concurrent 600-on-1000
  payments commits, the other is rejected (SQLSTATE 23514); `sum(paid) ≤ total`.
- **Regression?** No, but the C1 race only passes with `prod-fix/B2` applied; the
  file prints a NOTE if the per-quote lock is absent.

### Case 2 — concurrent same idempotency key (`20-…` + runner `C2`)
- **Run:** one-case command with `20-idempotency-key.sql`; concurrency in `C2`.
- **Expected:** exactly one ledger row for the key — the partial unique index
  `quote_payments_idempotency_uk` rejects the duplicate (23505) and
  `record_payment` returns `idempotent_replay: true` on the repeat.
- **Regression?** No.

### Case 3 — UPDATE-path overpayment (`30-…`) — **REGRESSION GUARD (H01)**
- **Run:** one-case command with `30-overpayment-update-path.sql`.
- **Expected after fix:** every UPDATE that raises an amount, flips a row to
  `paid`, or re-points `quote_id` past the cap is rejected (23514).
- **Today (pre-H01):** `trg_no_overpayment` is `BEFORE INSERT` only, so those
  UPDATEs succeed → the file's assertions **FAIL on purpose**, exposing the live
  bypass. Applying `harden-2026-10/H01-overpayment-update-path-and-lock.sql`
  (trigger becomes `BEFORE INSERT OR UPDATE`) turns them green.

### Case 4 — ledger writes outside the RPC boundary (`40-…`, `tests/db/rest-ledger-rls.mjs`)
- **Run (SQL):** one-case command with `40-ledger-rls.sql` (needs a Supabase-style
  DB with `anon`/`authenticated` roles).
- **Run (REST):**
  ```bash
  HELM_TEST_REST_URL=... HELM_TEST_ANON_KEY=... HELM_TEST_STAFF_JWT=... \
  HELM_TEST_QUOTE_ID=... node tests/db/rest-ledger-rls.mjs
  ```
- **Group 1 (genuine controls, expected PASS today):** anon and ordinary users
  cannot insert/update/delete `quote_payments` or `payment_milestones`; a `sales`
  user cannot write `payment_milestones` (no finance edit).
- **Group 2 (REGRESSION GUARD, expected FAIL today):** the ledger tables are
  governed by the generic `ra ins/upd/del` RLS — `quote_payments` under area
  `quotes`, `payment_milestones` under area `finance`. So a `quotes`-editor
  (sales/planner/manager) can today POST/PATCH/DELETE `quote_payments` directly,
  and a finance-editor can mark `payment_milestones` paid directly, **bypassing
  `record_payment` / `record_settlement_payment`** (idempotency, server receipt
  numbers, booking side-effects, audit). The tests assert the secure end-state
  (direct staff writes denied), so they **FAIL until a lockdown lands**.
- **Pending fix (not yet written):** restrict `public.quote_payments` and
  `public.payment_milestones` to **SELECT-only** for `anon`/`authenticated` and
  route all writes through the SECURITY DEFINER RPCs — i.e. drop the
  `ra ins/upd/del` policies (and/or `REVOKE INSERT,UPDATE,DELETE`) on those two
  tables. Must stay additive/idempotent and preserve reads used by the UI.

### Case 5 — OTP race / lockout / expiry (`50-…` + runner `C5`)
- **Run:** one-case command with `50-otp-race-lockout.sql`; the concurrent-verify
  race is `run-db-tests.sh` group **C5**.
- **Expected:** wrong attempts persist and the 5-try lockout trips; expired codes
  are inactive; a consumed code is single-use; of two concurrent correct
  verifications only one is approved (one consent row).
- **Regression?** Two pieces:
  - **C5.a (attempts persist)** guards `prod-fix/C2b-PROD-otp-lockout.sql`. The
    pre-C2b body `raise`s on a wrong code, rolling back the `attempts++`, so the
    counter never climbs — C5.a **FAILS** on that body, **PASSES** post-C2b.
  - **C5 race** guards `harden-2026-10/H02-otp-verify-row-lock.sql` (`SELECT …
    FOR UPDATE` on the active OTP row). Without H02 two concurrent verifies can
    both approve (two consent rows) → the race **FAILS until H02** is applied.

### Case 6 — tenant isolation + RBAC (`60-…`)
- **Run:** one-case command with `60-tenant-rbac.sql`.
- **Expected (today's behaviour, all PASS):**
  - Role mapping used by the suite: anonymous → `anon`; ordinary user → `client`;
    finance editor → `manager`; quote editor → `sales`; admin → `admin`.
  - `client` and cross-org admins cannot call `record_payment` /
    `record_settlement_payment` (RPCs gate on `can_edit()` and
    `assert_quote_org()`; both raise 42501).
  - **`manager` (finance editor) is DENIED by the money RPCs** even though the
    matrix grants finance edit — `can_edit()` =
    `role in (admin,planner,sales,operations)` excludes `manager`. This is the
    known W15-002 divergence; the test asserts it as real current behaviour, not
    a bug to fix here.
  - `sales` and `admin` are allowed; an Org B admin sees **zero** Org A ledger
    rows through RLS.
- **Regression?** No.

## Known behaviours encoded (verified against the real schema)

- Overpayment invariant: `sum(paid quote_payments) + sum(paid payment_milestones)
  ≤ (quotes.pricing->>'total') + 0.5`. Quotes with no `total` key are skipped by
  the guard — fixtures therefore set `pricing = '{"total":N}'`.
- `quote_payments` unique partial indexes: `(quote_id, idempotency_key)` and
  `(quote_id, receipt_no)` where the key/receipt is not null.
- `quote_otps` has RLS enabled with **zero policies** (deny-all) — the OTP path is
  reachable only through the SECURITY DEFINER RPCs `request_otp` /
  `verify_and_consent`. The suite does not test direct `quote_otps` REST access
  because it is categorically denied by design.
- RLS areas: `quote_payments → 'quotes'`, `payment_milestones → 'finance'`.

## Not executed — why

No isolated non-production test database (or its credentials) was available in
this environment, and the task explicitly scoped this change to **authoring**
runnable tests + CI wiring only. None of these tests were run; no output was
captured or invented. Provide `HELM_TEST_DB_URL` (and the REST vars) for a
staging/throwaway project and run `supabase/tests/run-db-tests.sh` to execute
them.
