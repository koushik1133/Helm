# Staging synthetic test-data factory

Seeds and tears down deterministic, two-tenant synthetic data on the **Helm
staging** Supabase project for RBAC / tenant-isolation / payment hardening
tests. Staging only. Never run against production.

- `seed-test-data.mjs` — create/update orgs, role users, profiles, quotes.
- `cleanup-test-data.mjs` — delete everything prefixed `HARDEN_TEST_`.

Both are Node ESM, use global `fetch` only (no dependencies), and talk to the
staging GoTrue Admin API + PostgREST with the service_role key.

## The `HARDEN_TEST_` safety invariant

Every object the factory creates is prefixed `HARDEN_TEST_`
(org name/slug, user email local-part + display name, quote code).

`cleanup-test-data.mjs` **hard-asserts that prefix on every single delete
target** and aborts the entire run (deleting nothing further) the moment it
encounters a target that is not prefixed. It can therefore never delete
real/organic staging data. Discovery is prefix-filtered server-side
(`?name=like.HARDEN_TEST_*`, `?code=like.HARDEN_TEST_*`,
`?email=like.harden_test_*`) and then re-asserted locally before each delete.

Additional guards in both scripts:

- **Ref lock:** refuse unless `SUPABASE_STAGING_URL` contains the staging ref
  `xizehqgeyjcfpzrdymly`; hard-refuse if it contains the prod ref
  `nqltzgiwznphugcfhmbm`.
- **Secrets from env only** — never hardcoded, never printed.
- **Idempotent seed** — re-running upserts (orgs on `slug`, profiles on `id`,
  quotes on `org_id,code`, GoTrue users looked up by email) instead of
  duplicating.

## What gets seeded

- Two orgs: `HARDEN_TEST_ORG_A`, `HARDEN_TEST_ORG_B`.
- One user per role per org (16 users total). Emails like
  `harden_test_a_admin@helm-staging.test`.
- Matching `public.profiles` rows (`role`, `org_id`, `must_change_password=false`).
- Two quotes per org (`HARDEN_TEST_A-Q0001`, `…-Q0002`, etc.) for
  tenant/payment tests.
- A JSON manifest of created ids at `scripts/staging/.seed-manifest.json`
  (gitignored). Cleanup reads it in addition to live prefix discovery.

### Roles

Seeded roles (editable via the `ROLES` constant in `seed-test-data.mjs`):
`admin, manager, sales, coordinator, operations, designer, viewer, quality`.

> **Important:** the live `profiles_role_check` CHECK constraint currently
> allows only: `admin, manager, planner, sales, coordinator, supervisor,
> quality, operations, crew, worker, client`. **`designer` and `viewer` are
> not in that constraint** and PostgREST will reject those two profile inserts
> until the constraint is updated (or until you edit `ROLES` to use permitted
> role names). The org/user rows for those roles still succeed; only the
> profile insert for them fails.

## Required env vars

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `SUPABASE_STAGING_URL` | no | `https://xizehqgeyjcfpzrdymly.supabase.co` | Must contain the staging ref. |
| `SUPABASE_STAGING_SERVICE_ROLE_KEY` | **yes** | — | service_role key. Never logged. |
| `SEED_TEST_PASSWORD` | **yes** (seed only) | — | Strong deterministic password. Script refuses if unset; no fallback. |

Keep these in `.staging.env` (gitignored). Load them into the environment
yourself before running — the scripts read from `process.env` and never read
`.staging.env` directly.

## Usage (run later — do not commit secrets)

```sh
# load staging env into this shell (file is gitignored)
set -a; . ./.staging.env; set +a

# seed (idempotent)
node scripts/staging/seed-test-data.mjs

# tear down (prefix-asserted, safe)
node scripts/staging/cleanup-test-data.mjs
```
