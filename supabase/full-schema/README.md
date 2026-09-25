# Blueprint Stage — Database Schema (historical snapshot folder)

> ⚠️ **Canonical source of truth = the numbered `phaseNN-name.sql` files in the
> parent `supabase/` folder**, applied in order (see `docs/TECHNICAL-HANDOFF.md`).
> The files in **this** `full-schema/` folder — including `complete-setup.sql` —
> are **historical bootstrap snapshots** that were frozen at ~phase 55–58 and were
> **not** kept up to date. Treat them as reference/mirror artifacts, **not** as a
> complete production schema.

## Do NOT deploy production from `complete-setup.sql`

`complete-setup.sql` is **incomplete**. It is missing every phase from ~59 onward,
which includes **security-critical** and data-integrity changes, for example:

- **phase73** — org-isolation of the `SECURITY DEFINER` functions
  (`admin_set_role`, `admin_create_user`, `admin_delete_user`, `confirm_quote`).
  Without phase73 those functions are **not org-scoped** and permit cross-tenant
  role changes / user deletion / quote confirmation.
- **phase76** (`record_payment`), **phase77** (`save_quotation_version` /
  quotation versioning), **phase85** (`export_org_data` /
  `export_tenant_organization_package`), phase87/88 (event sites, invite media).

Deploying (or idempotently **re-running**) `complete-setup.sql` on top of a
hardened database would **revert** the phase73 org-scoping to the pre-hardening
bodies. Do not use it as the deploy path.

## Canonical deployment path (fresh database)

Run the numbered `phaseNN-name.sql` files from the parent `supabase/` folder **in
order, through the latest phase present**, ending with the org-isolation and
later phases. Applying **phase73** (and 76/77/85+) is **mandatory** for tenant
isolation and money/data integrity.

> **A verified single-file "run one file and you're done" install does NOT exist
> in this repository.** Before any production deploy, verify on an **approved
> staging database** that the deployed function bodies are the org-scoped
> (phase73) ones and that grants/`search_path`/RLS match expectations — see
> `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

## Historical ordered pieces (reference only — snapshot, not current)

The table below reflects the frozen snapshot and is kept for reference. It is
**not** the full schema and must not be treated as the deploy path:

| # | File | What it adds |
|---|------|--------------|
| 01 | `01-core-auth-quotes.sql` | Auth, 6 roles + RBAC, profiles, quotes, quote_versions, admin RPCs |
| 02 | `02-approval-payments.sql` | Client approval: OTP, consent, payment links, notifications outbox |
| 03 | `03-operations-tasks.sql`  | Crew members, task templates, event_tasks, work tokens |
| 04 | `04-control-center.sql`    | Pricing config, vendors, coupons, manager notify |
| 05 | `05-workspace.sql`         | `quotes.lifecycle_stage` + `set_lifecycle_stage` (Phase 1) |
| 06 | `06-leads.sql`             | `leads` table + `convert_lead_to_quote` (Phase 2) |
| 07 | `07-otp-dev-pin.sql`       | DEPRECATED (PR-AUTH-01): now installs the random-code request_otp (no fixed PIN) |
| 08 | `08-crm-realtime.sql`     | `lead_archive` (immutable CRM) + triggers + leads realtime (Phase 2b) |
| 09 | `09-discovery.sql`        | `event_discovery` + `event_requirements` + `set_discovery` (Phase 3) |
| 10 | `10-proposal.sql`        | `event_proposal` + `proposal_risks` + share token RPCs (Phase 4) |
| 11 | `11-mvp-polish.sql`      | Converted lead opens at Discovery stage (Phase 5 polish) |
| 12 | `12-staff.sql`          | Staff directory: role/skills/dept/email/rate on crew_members (Phase 6) |
| 13 | `13-inventory.sql`     | Inventory items + per-event reservations + availability view (Phase 7) |
| 14 | `14-resource-needs.sql`| Per-event resource needs (capability check flags gaps) (Phase 8) |
| 15 | `15-vendors.sql`       | vendors.kind + event_resources (external bookings) (Phase 9) |
| 16 | `16-calendar.sql`     | quotes.event_date + backfill (resource calendar) (Phase 10) |
| 17 | `17-runsheet.sql`     | run_sheet_items — timed event-day schedule (Phase 11) |
| 18 | `18-budget.sql`       | event_costs + change_requests — budget vs actuals (Phase 12) |
| 19 | `19-plan.sql`         | event_plan — venue + menu/package lock (Phase 13) |
| 20 | `20-logistics.sql`   | event_checklist + payment_milestones (Phase 14) |
| 21 | `21-readiness.sql`   | event_plan dry-run/briefing sign-offs (Phase 15) |
| 22 | `22-dayops.sql`      | event_day — arrivals + setup checks (Phase 16) |
| 23 | `23-issues.sql`      | event_issues — live issue tickets + incident log (Phase 17) |
| 24 | `24-teardown.sql`   | event_checklist adds a 'teardown' section (Phase 18) |
| 25 | `25-settlement.sql` | event_resources.settled + expense_claims (Phase 19) |
| 26 | `26-closure.sql`    | event_closure + event_ratings + close_event (Phase 20) |

Then, on a brand-new DB only, seed the team logins:

```
../seed-users.sql
```

## Going forward (per-phase files)

Each new phase ships its own idempotent `phaseNN-name.sql` file in the **parent**
`supabase/` folder (e.g. `phase73-definer-org-isolation-final.sql`) — that is the
authoritative artifact. Do **not** rely on hand-appending bodies into
`complete-setup.sql`; that practice stopped at ~phase 58 and is what left this
snapshot stale and unsafe. If a consolidated installer is ever needed, it must be
**regenerated** from the numbered phase files (idempotently, in order) and then
**verified on staging** before use — never edited by hand as the source of truth.

## The 6 seeded users (password `helm`)

`admin@helm.com` · `planner@helm.com` · `sales@helm.com` ·
`operations@helm.com` · `crew@helm.com` · `client@helm.com`

> Change these passwords before any real use.
