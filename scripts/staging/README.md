# Helm — Staging deployment scripts

Three guarded scripts that prepare the **staging** Supabase project
(`xizehqgeyjcfpzrdymly`) using the Supabase **Management API**. They apply the
canonical forward-only hardening migrations and verify the result. They never
touch production (`nqltzgiwznphugcfhmbm` is hard-refused).

> These scripts are a **preparation package**. Review them, then the operator
> runs them deliberately. Nothing here runs automatically.

## Secrets

- The operator supplies a Supabase **personal access token** (an `sbp_...` PAT,
  **not** a JWT / service_role key) via the `SUPABASE_ACCESS_TOKEN` environment
  variable, **ephemerally**, for each command:

  ```sh
  SUPABASE_ACCESS_TOKEN=sbp_xxx scripts/staging/precheck.sh
  ```

- The token is read from the environment at runtime only. The scripts **never**
  print, log, or write it to any file. Do not place it in a committed file and
  do not pass it as a visible shell argument.

## Run order

1. **`precheck.sh`** — read-only. Inspects staging (table/routine counts, ledger
   state, freshness). Appends a dated "Live precheck" section to
   `STAGING-PRECHECK.md`. Run this first and review it.

2. **`apply-canonical.sh`** — the guarded apply. Applies **only** the `forward`
   entries in `supabase/migrations/MANIFEST`, in order, idempotently, recording
   each in `public.helm_schema_migrations` with its sha256. It **aborts if the
   DB is fresh** (base-v1 is never applied to an existing staging DB via this
   path) and **refuses on checksum drift**. Prints `applied=N skipped=M`.

3. **`verify.sh`** — read-only. Confirms the app's DB contract (RPCs via
   `rpc("name")` + tables via `.from("name")` in `public/*.{js,html}`) is fully
   present in staging (target 80/80 RPCs, 56/56 tables or better), checks the
   ledger matches the MANIFEST forward entries by checksum, and spot-checks the
   hardened objects. Prints `VERIFY: PASS/FAIL`.

4. **Idempotency re-run** — run `apply-canonical.sh` again; it must report
   `applied=0`.

## Safety guarantees

- Production ref `nqltzgiwznphugcfhmbm` is hard-refused in every script.
- Only `xizehqgeyjcfpzrdymly` (staging) is accepted.
- Only the `forward` migrations listed in `MANIFEST` are applied — never the
  `base` snapshot on an existing DB, and never any historical
  phase/wave/security-fix/full-schema/setup-all bundle under `supabase/`.
- `apply-canonical.sh` is the only script that writes; `precheck.sh` and
  `verify.sh` are strictly read-only.

## Files

- `_common.sh` — shared helpers (Management API call, token/ref checks, colors).
  Sourced by the three scripts; not run directly.
- `precheck.sh`, `apply-canonical.sh`, `verify.sh` — the three steps above.
