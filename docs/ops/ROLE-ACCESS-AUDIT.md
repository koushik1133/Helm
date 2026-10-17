# Role access audit - UI gate vs DB gate (2026-10-16)

Static audit: no sign-in as other users. Sources: `public/store-api.js` (AREAS, `canView`, `canEditArea`,
`requireView`), every page gate, `public/shell-b.js` / `mobile-nav.js` nav, `supabase/canonical-base/base-v1`
+ `supabase/migrations/0001..0143` (RLS policies, the `ra view/ins/upd/del` table->area loop, SECURITY DEFINER
RPCs, including the `__preNNNN` wrapper chains). Fixes ship in `supabase/migrations/0144_role_gate_fixes.sql`
(+ `supabase/APPLY-0144.sql`) and the UI edits below. Test: `test/role-access-audit.test.mjs`.

> Migration number: the task asked for 0143, but `0143_roles_crew_defaults.sql` (Worker -> Crew) took that
> number, so this is **0144**. Run order: APPLY-0143, then APPLY-0144.

## How access works (one paragraph)
Admin passes everything. Every other role reads its row in `role_access` (per studio, per area: view / edit),
edited in Control Center. The DB function `has_area(area, need)` reads the same table, and RLS on each table
uses it (e.g. `leads` -> `leads`, `event_tasks` -> `staff`, `payment_milestones` -> `finance`). So the UI and
the DB agree **only if** each page is gated on the same area its tables use, and every RPC checks the area.

## Default matrix for a new studio (V = view, E = edit, - = none)
From `_a49_default_matrix` (0049), designer (0008 / 0143) and crew (0143). Admin = everything. Client = nothing
(clients use their portal / booklet links, which are token RPCs, not the matrix).

| area | manager | planner | sales | coordinator | supervisor | quality | operations | designer | crew |
|---|---|---|---|---|---|---|---|---|---|
| leads, crm | E | E | E | V | - | - | - | - | - |
| nurture, discovery | E | E | - | - | - | - | - | - | - |
| proposal | E | E | - | - | - | - | - | E | - |
| quotes | E | E | - | V | V | V | V | V | - |
| layouts | V | E | - | V | V | V | V | E | - |
| design | E | E | - | - | - | - | - | E | - |
| staff, inventory, vendors, resources | E | E | - | E | V | V | E | - | - |
| calendar | E | E | - | E | V | V | V | V | V |
| templates | E | E | - | E | - | V | V | V | - |
| runsheet, plan, logistics | E | E | - | E | V | V | V | - | runsheet V |
| ready | E | E | - | E | V | V | - | - | - |
| command | E | E | - | E | E | E | V | - | - |
| issues | E | E | - | E | E | E | E | - | - |
| media | E | E | - | E | E | V | V | E | - |
| finance, settlement, closure | E | E | - | - | - | - | - | - | - |
| controls | E | - | - | - | - | - | - | - | - |
| codes | E | E | - | - | - | - | - | - | - |
| users | - | - | - | - | - | - | - | - | - |
| item_pricing / photo_render | follow quotes view / quotes edit (seeded once by 0086 / 0095) |
| venues, insights, pkg_review, pkg_payments | admin only until granted in Control Center |

## Result per role x area group
"OK" = UI gate and DB gate agree. Before -> after this pass.

| role | pipeline (leads/crm/nurture/discovery/proposal) | event + quotes | ops pages | money (finance/settlement/closure/payments) | admin (controls/users/codes) |
|---|---|---|---|---|---|
| admin | OK | OK | OK | OK | OK |
| manager | OK | **was broken**: confirm, plan lock, sign-off, task assign, layout versions, close event, record payment refused by `can_edit()` -> **fixed** | **was broken** (same `can_edit()`) -> **fixed** | **was broken** (record_payment / close_event inner `can_edit()`) -> **fixed** | OK |
| planner | OK | OK | OK | OK | OK |
| sales | OK | **was mismatched**: quotes list shown but RLS-empty; New button errored -> page now gated on quotes view, New follows quotes edit; sales no longer passes `can_edit()`-only RPCs it has no area for | n/a | OK (no access) | OK |
| coordinator | OK (leads/crm view) | **was broken** for plan/discovery/proposal saves -> **fixed**; **payments leaked** -> **fixed** | **was broken** (assign tasks) -> **fixed** | **payments leaked via quote_payments + activity trail** -> **fixed** | OK |
| supervisor / quality / operations | n/a | **payments leaked** -> **fixed** | coarse "ops" gate let them open pages whose area is off (empty / errors) -> **fixed** (fine gates); operations kept plan-lock / task RPCs only via the hard-coded list -> now matrix | **payments leaked** -> **fixed** | OK |
| designer | proposal OK | quotes view: sees quote price + client contact (owner-chosen default); **payments leaked** -> **fixed** | coarse "ops" gate opened staff/vendors etc. -> **fixed** | **payments leaked** -> **fixed** | OK |
| crew | n/a | no quotes view (OK, no client contact) | calendar + runsheet view, BUT both pages read `quotes` (RLS) -> calendar shows empty, run-sheet says "not found". **Not fixed - owner decision** (see below) | activity trail leaked payments + client email/phone to any signed-in member -> **fixed** | OK |
| client | n/a (no matrix rows) | activity trail leak -> **fixed** | n/a | **fixed** | OK |

## Findings and fixes

### DB side (0144)
1. **`can_edit()` ignored the matrix** - it was `role in (admin, planner, sales, operations)`. Event manager and
   coordinator were refused by ~15 RPCs the matrix allows them (confirm quote, plan lock / sign-off, assign /
   reassign tasks, add layout version, publish proposal, close event, record payment...), while sales and
   operations passed it with no area. Fix: the 9 RPCs that checked **only** `can_edit()` are renamed once to
   `*__pre0144` and wrapped with their real area check (add_quote_version -> quotes|layouts edit;
   assign_tasks / reassign_task -> staff edit; assign_tasks_vendor -> staff|vendors edit; set_plan_signoff ->
   plan|ready edit; set_plan_lock -> plan edit; confirm_quote -> quotes edit (+ studio check);
   publish_proposal -> proposal|quotes edit; mgr_notify -> quotes|finance|settlement edit). Then `can_edit()`
   becomes "admin, or this role can edit at least one area". Every other caller already has its own
   `has_area` check (record_payment finance, close_event / set_closure closure, record_settlement_payment
   settlement, set_discovery / set_event_plan / set_proposal / save_quotation_version, set_lifecycle_stage,
   generate / revoke approval token).
2. **Payment receipts readable by non-finance roles** - `quote_payments` sat in the `quotes` area loop, so every
   event viewer could read every receipt (amount, method, receipt no). Fix: restrictive policies - read needs
   finance | settlement | pkg_payments view, direct writes need finance | settlement edit. The app only writes
   payments through DEFINER RPCs that already check finance / settlement edit, so nothing legitimate breaks;
   `logistics.html`, `plan.html`, `flow.html` already handle an empty list.
3. **`event_activity()` leaked to any signed-in member** (crew and client logins included): payment amounts and
   notification recipients (client email / phone). Fix: needs quotes view; payment + milestone lines only with
   a money area.
4. **`task_verify_summary()`** only checked the studio. Fix: needs staff or quotes view (no UI caller today).

### UI side
5. **Coarse page gates** - 13 ops pages were gated on `requireView("ops")` (any of 13 areas), pipeline pages on
   `"pipeline"`, money pages on `"finance"`, the event workspace on `"workspace"`. A role with one area could
   open every sibling page and get empty lists / "not found". Now each page uses its own area (the one its RLS
   uses): calendar, command, issues, logistics, media, plan, ready, resources, runsheet, staff, templates,
   vendors, teardown -> inventory, crm, discovery, leads, proposal, closure, settlement, event -> quotes.
6. **Event workspace cards** - only money and pipeline cards were hidden; now every tool card hides when the
   role cannot view that tool's area (`CARD_AREA` in `event.html`).
7. **`quotes.html` had no page gate** -> `requireView("quotes")`. The New button used the role list
   `can("create")` (sales, designer, manager...) while the server `create_quote` / `start_blank_quote` need
   `has_area(quotes, edit)` -> button now follows `canEditArea("quotes")`.
8. **`ops.html` (event tasks) had no page gate** -> `requireView("staff")`.

### Checked and OK (no change)
- Nav (`shell-b.js`, `mobile-nav.js`) already uses fine `canView(area)` per item.
- Leads, CRM, nurture, discovery, proposal, staff, inventory, vendors, run-sheet, plan, issues, media, command,
  checklist, closure, refunds, costs, change requests, expense claims, milestones: RLS = the expected area.
- Money RPCs: record_payment / mark_paid / settle_milestone -> finance edit; settlement -> settlement edit;
  close / closure -> closure edit; insights money needs finance view; dashboard / client timeline totals need
  finance view; vendor bills / payouts / payment reconciliation -> finance view.
- Profiles: only self, or colleagues with users view. Invitations: users edit. Integration secrets: admin only.
- Crew: no access to quotes, leads, crm_members, guests -> client contact details are not reachable by crew.

### Known structural limits (not changed - owner decisions)
- **The quote row is the event.** Anyone with quotes view (coordinator, supervisor, operations, quality,
  designer by default) can read the quote's price (`pricing`) and the client's name / phone / email
  (`client`). Hiding them needs column-level splitting of `quotes`; not done here.
- **Crew calendar / run-sheet defaults (0143) give empty pages** because both read `quotes`. Options:
  (a) keep crew on "My tasks" (`work.html`, no matrix needed) and drop those two defaults, or (b) add a crew-safe
  schedule RPC that returns only date / venue / their own tasks. Do not grant crew quotes view (that exposes
  client contact + price).
- `coupons`, `app_config` (pricing config), `role_access` are readable by every member of the studio.
- venues / insights / package areas have no default rows -> admin-only until granted (the venue picker is empty
  for a manager until Control Center grants venues view).

## To apply
1. APPLY-0143 (already in your clipboard flow), then paste `supabase/APPLY-0144.sql` into the SQL editor on
   staging first, then prod. Every verify row must be `ok = true`.
2. Retest as manager: confirm a quote, lock the plan, assign a task, close an event, record a payment.
3. Retest as coordinator / operations: the event's activity trail shows no payment lines; Settlement / Budget
   cards are hidden.
