# Helm STAGING — Expected Role × Mutating-RPC Authorization Matrix

Authoritative, human-readable companion to the machine-readable
`tests/staging/expected-matrix.mjs` (which `authz-matrix.mjs` imports — the test
does **not** parse this Markdown). Keep the two in sync.

Every expectation is derived from the **canonical hardened schema + migrations**,
not from the client `ROLE_CAPS` (which is advisory only):

| primitive      | definition (staging schema / migrations)                                              |
|----------------|----------------------------------------------------------------------------------------|
| `can_edit()`   | `user_role ∈ {admin, planner, sales, operations}`                                      |
| `can_create()` | `user_role ∈ {admin, planner, sales}`                                                   |
| `is_admin()`   | `user_role = admin`                                                                     |
| `has_area(a,'edit')` | `admin` bypass = true; else `role_access(role=a).can_edit` for the caller's org   |

Default `role_access` edit-grants (phase29 + migration 0008), for the tested roles:

| area       | roles with `can_edit` (default)              |
|------------|----------------------------------------------|
| quotes     | manager, planner, sales                      |
| leads      | manager, planner, sales                      |
| discovery  | manager, planner, sales                      |
| plan       | manager, planner, coordinator                |
| proposal   | manager, planner, sales, **designer** (0008) |
| finance    | manager, planner                             |

> `planner` is deliberately **not** a tested column; it is listed above only
> because it appears in the grant sets.

## Role reconciliation (IMPORTANT)

`viewer` is **not** a DB-valid role. The canonical `profiles_role_check`
(base-v1 widened by migration 0008) permits exactly:
`admin, manager, planner, sales, coordinator, supervisor, quality, operations,
crew, worker, client, designer`.

- The least-privilege / no-capability column uses the real **area-less** role
  **`client`** (external portal role: no staff `has_area`, no `can_edit`,
  no `can_create`). It is labelled **client (no-area)** below.
- `scripts/staging/seed-test-data.mjs` `ROLES` was updated to the DB-valid set:
  dropped `viewer`, kept `designer`, added `client`
  (`admin, manager, sales, coordinator, operations, designer, quality, client`).

> **Seeder note 1 (viewer in lib):** `tests/staging/lib/client.mjs` `SEED.roleToDbRole`
> still contains a `viewer → client` mapping. It was left unchanged (it does not
> break imports and `seedEmail()` does not use it). The seeder must seed the DB
> role **`client`** for the no-area column — which the updated `ROLES` list now does.
>
> **Seeder note 2 (email format):** `lib/client.mjs` `seedEmail(role, org)` emits
> `harden_test_<role>_<org>@helm-staging.test`, while `seed-test-data.mjs` currently
> emits `harden_test_<org>_<role>@helm-staging.test`. These must match or every
> `signInRole()` fails and the suites correctly report **BLOCKED** (never a false
> PASS). Fixing the seeder's email format is out of this change's scope (ROLES-only
> edit) and is flagged for a follow-up.

## Columns under test

`anon`, `client (no-area)`, `sales`, `manager`, `coordinator`, `operations`,
`designer`, `quality`, `admin`.

- `anon` is unauthenticated and additionally **lacks EXECUTE** on every non-public
  RPC (migration 0005), so it is DENY on all rows below.
- No cell is `NA` — every role × RPC pairing is decidable here.

## Matrix (ALLOW / DENY)

| RPC (mutating)            | guard (server)                                   | anon | client | sales | manager | coordinator | operations | designer | quality | admin |
|---------------------------|--------------------------------------------------|------|--------|-------|---------|-------------|------------|----------|---------|-------|
| create_quote              | has_area(quotes,edit) ∧ can_create               | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| convert_lead_to_quote     | has_area(quotes∣leads,edit) ∧ can_create         | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| save_quotation_version    | can_edit ∧ has_area(quotes,edit)                 | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| set_discovery             | can_edit ∧ has_area(quotes∣discovery,edit)       | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| set_event_plan            | can_edit ∧ has_area(quotes∣plan,edit)            | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| set_proposal              | can_edit ∧ has_area(quotes∣proposal,edit)        | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| generate_approval_token   | can_edit ∧ has_area(quotes,edit)                 | DENY | DENY   | ALLOW | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| record_payment            | can_edit ∧ has_area(finance,edit)                | DENY | DENY   | DENY  | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| mark_paid                 | user_role ∈ {admin, manager}                     | DENY | DENY   | DENY  | ALLOW   | DENY        | DENY       | DENY     | DENY    | ALLOW |
| admin_create_user         | is_admin                                         | DENY | DENY   | DENY  | DENY    | DENY        | DENY       | DENY     | DENY    | ALLOW |
| verify_task               | user_role ∈ {admin, manager, planner, quality}   | DENY | DENY   | DENY  | ALLOW   | DENY        | DENY       | DENY     | ALLOW   | ALLOW |

### Notable divergences the matrix captures

- **manager** fails `can_edit()` (not in `{admin,planner,sales,operations}`), so
  despite holding most `has_area` edit grants it is **DENY** on every
  `can_edit`-gated quote-editing RPC. It is **ALLOW** only where the guard keys on
  `user_role` directly (`mark_paid`, `verify_task`). This is the known
  `can_edit` / `has_area` divergence (W15/W16).
- **record_payment** needs *both* `can_edit` and `finance.edit`. `sales` has
  `can_edit` but not `finance.edit`; `manager` has `finance.edit` but not
  `can_edit` — so **admin only**.
- **designer** holds `proposal.edit` (0008) but fails `can_edit`, so `set_proposal`
  is **DENY** for designer.
- **coordinator** holds `plan.edit` but fails `can_edit`, so `set_event_plan` is
  **DENY** for coordinator.

## Verdict classification

A call is **ALLOW** when it succeeds *or* fails with a non-authz error (the guard
was passed and the function body was reached), and **DENY** on HTTP 401/403,
Postgres `42501`, or a PostgREST `PGRST202/301/302` (role lacks EXECUTE) — exactly
as `classify()` in `lib/client.mjs` defines it. For `*quote*`-bound RPCs the suite
binds a **real quote in the caller's own org**, so `assert_quote_org` passes for
authorized roles and the only possible denial is the authorization guard itself.
