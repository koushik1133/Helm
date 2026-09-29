# Page Inventory — Helm (45 pages)

Legend: **Tested** = exercised in a real staging runtime this session (lifecycle/coverage/roles/workflow-capture). **Loaded** = screenshotted/loaded authenticated. **Static** = content page.

| Page | Primary role(s) | Runtime status this session |
|---|---|---|
| login.html | all | Tested (real UI login on staging ✅) |
| dashboard.html | all | Tested (11 roles captured; roles allow/deny) |
| leads.html | sales | Tested (lifecycle 01 + capture) |
| crm.html | sales | Loaded (capture) |
| discovery.html | planner | Tested (lifecycle 02 + capture) |
| quotes.html | planner/admin | Tested (lifecycle 03 + capture) |
| flow.html | planner | Tested (lifecycle 03/07) |
| builder.html | planner | Loaded (capture) + lifecycle 04 (layout save) |
| proposal.html | planner | Loaded (capture) + lifecycle 05 (publish) |
| approve.html | client | Tested (lifecycle 06: OTP wrong/correct/replay) |
| plan.html | coordinator/operations | Tested (lifecycle 08 + capture) |
| resources.html | coordinator | Loaded (capture) + coverage |
| ops.html | operations | Loaded (capture) + lifecycle 09 (assign_tasks) |
| runsheet.html | operations | Loaded (capture) + coverage |
| inventory.html | operations | Loaded (capture) + coverage |
| vendors.html | operations | Coverage |
| staff.html | admin/ops | Coverage |
| settlement.html | manager | Loaded (capture) + lifecycle 10 |
| closure.html | manager | Loaded (capture) + lifecycle 10 (close_event) |
| control.html | admin | Loaded (capture) + coverage |
| reports.html | admin | Loaded (capture) |
| budget.html | admin/planner | Coverage (firefox flake, passes isolated) |
| logistics.html | operations | Coverage |
| command.html | operations | Loaded (guide) |
| nurture, calendar, media, audit, insights, issues, templates, event, ready, teardown, portal, work, invite, invite-studio, proposal-view, services, sim-pay, about, privacy, terms | various | Loaded or Static — not full functional tests this session (see KNOWN-GAPS) |

**Tested (functional, this session): ~20 pages.** Remainder loaded or static. No page called "tested" merely for existing.
