# Blueprint Stage — Full Database Schema

This folder is the **single source of truth** for the entire database. Use it when
moving to a new Supabase/Postgres project or rebuilding from scratch.

## Fastest path (fresh database)

Run **one** file, top to bottom, in the Supabase SQL editor:

```
complete-setup.sql
```

It contains everything below, in dependency order, plus a user seed (6 team
logins, password `helm`). It is idempotent — safe to re-run.

## Or run the ordered pieces

If you prefer to run them one at a time (same result as `complete-setup.sql`
minus the user seed), run in this exact order:

| # | File | What it adds |
|---|------|--------------|
| 01 | `01-core-auth-quotes.sql` | Auth, 6 roles + RBAC, profiles, quotes, quote_versions, admin RPCs |
| 02 | `02-approval-payments.sql` | Client approval: OTP, consent, payment links, notifications outbox |
| 03 | `03-operations-tasks.sql`  | Crew members, task templates, event_tasks, work tokens |
| 04 | `04-control-center.sql`    | Pricing config, vendors, coupons, manager notify |
| 05 | `05-workspace.sql`         | `quotes.lifecycle_stage` + `set_lifecycle_stage` (Phase 1) |
| 06 | `06-leads.sql`             | `leads` table + `convert_lead_to_quote` (Phase 2) |
| 07 | `07-otp-dev-pin.sql`       | Temporary OTP pin = 123456 in simulation |
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

Then, on a brand-new DB only, seed the team logins:

```
../seed-users.sql
```

## Going forward (per-phase files)

Each new phase ships its own idempotent file in the **parent** `supabase/`
folder (e.g. `phase2-leads.sql`). After you run a phase file on your live DB:

1. Copy it into this folder as the next number (e.g. `06-leads.sql`).
2. Append its body to `complete-setup.sql` (before the user-seed section).

That keeps this folder a complete, replayable snapshot of the whole schema.

## The 6 seeded users (password `helm`)

`admin@helm.com` · `planner@helm.com` · `sales@helm.com` ·
`operations@helm.com` · `crew@helm.com` · `client@helm.com`

> Change these passwords before any real use.
