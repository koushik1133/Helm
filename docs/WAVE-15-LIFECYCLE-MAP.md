# Wave 15 — Helm Continuous Lifecycle Map & Verification

**Scope:** koushik1133/Helm · origin · localhost → STAGING (`xizehqgeyjcfpzrdymly`) · synthetic data only.
**Production (praneethreddykiwik/Helm, www.helm.events, prod Supabase `nqltz…`) — UNTOUCHED.**

## Architecture (verified from source)
- Static HTML pages talk to Supabase through `public/store-api.js` (`BPStore`), which calls SECURITY DEFINER RPCs / PostgREST. `public/config.js` routes localhost → staging via explicit allowlists (prod hosts fail-closed).
- **The quote row IS the event.** There is no separate event table; every downstream table foreign-keys to `quotes.id` (`event_plan.quote_id`, `event_tasks.quote_id`, `quote_payments.quote_id`, …). The canonical lifecycle id threaded end-to-end is therefore **`quoteId`**.
- Two edit-authority mechanisms coexist: legacy `can_edit()` (hardcoded `admin/planner/sales/operations`) used by most RPCs, and `has_area(area,need)` (data-driven matrix, phase29/31) used by feature-table RLS + newer RPCs. **They diverge — see W15-002.**

## Lifecycle stages (page · control · table · RPC · roles · dep)
| # | Stage | Page | Key control | Table(s) | RPC | Edit role(s) | Needs |
|---|-------|------|-------------|----------|-----|--------------|-------|
| 1 | Lead create/edit | leads.html | #newBtn/#lm_save; kanban drag | leads, lead_archive | REST + convert_lead_to_quote | admin/planner/sales | — |
| 2 | Discovery | discovery.html | #d_save, #r_add | event_discovery, event_requirements | set_discovery | can_edit | quoteId |
| 3 | Quote create | (lead convert / dashboard) | convert/create | quotes, quote_versions | create_quote / convert_lead_to_quote | admin/planner/sales | lead |
| 4 | Pricing / Version | quotes.html, flow.html | #cm_savePricing, #q_save | quotes, quotation_versions | confirm_quote, save_quotation_version | manager/planner (RPC: can_edit) | quoteId |
| 5 | Builder / Layout | builder.html | #saveBtn | quote_versions | add_quote_version | planner (layouts) | quoteId |
| 6 | Proposal | proposal.html | #pubBtn / #shareLink | event_proposal | set_proposal, publish_proposal | can_edit | quoteId |
| 7 | Approval (client) | approve.html | #sendOtp,#c_otp,#confirmBtn | quote_otps, quote_consents | request_otp, verify_and_consent | anon (token) | approval_token |
| 8 | Payment | approve.html / staff | #payBtn / record_payment | quote_payments, payment_milestones | create_payment, record_payment, mark_paid | can_edit (client reads only) | quoteId/token |
| 9 | Planning (venue/menu) | plan.html | #v_save,#p_save,#lockBtn | event_plan, event_menu | set_event_plan, set_plan_lock | plan edit: manager/planner/coordinator | quoteId |
| 10 | Resources/Staffing | resources.html, staff.html | #n_add,#bookModal | event_resource_needs, event_resources, staff | resources.*, bookings.* | resources edit: +operations | quoteId |
| 11 | Tasks | ops.html | #assignBtn | event_tasks, work_tokens | assign_tasks, reassign_task | can_edit (assign) | quoteId |
| 12 | Run sheet | runsheet.html | #r_add | run_sheet_items | runsheet.* | runsheet edit: manager/planner/coordinator | quoteId |
| 13 | Operations/Inventory/Vendors | ops.html, inventory.html, vendors.html | verify, reserve, book | event_tasks, inventory_*, vendors | verify_task, inventory.*, vendors.* | area-specific | quoteId |
| 14 | Worker/Crew | work.html | Accept/Start/Done | event_tasks | worker_get_tasks, worker_respond | anon (token) | work_token |
| 15 | Event day / Issues | ready.html, command, issues.html | #markBtn,#i_add | event_day, event_issues | set_plan_signoff | command/issues edit | quoteId |
| 16 | Settlement | settlement.html | #pay_btn,#e_add | quote_payments, expense_claims, event_refunds | record_payment, mark_paid | **planner/admin** (NOT manager — W15-002) | quoteId |
| 17 | Closure | closure.html | #c_save,#closeBtn | event_closure, event_ratings | set_closure, close_event | **planner/admin** (NOT manager — W15-002) | quoteId |

## Role-handoff ledger (correct role per stage — not admin everywhere)
| Stage | Role | Rationale |
|-------|------|-----------|
| Lead/Quote | sales | leads+crm+can_create |
| Discovery | planner | sales lost discovery edit in phase31 |
| Pricing/Version | planner | quotes edit + can_edit |
| Builder/Layout | planner | layouts edit = planner only |
| Proposal | planner | can_edit |
| Approval | client (anon token) | token-scoped public flow |
| Payment | planner | record_payment = can_edit (manager blocked) |
| Planning | coordinator | plan edit includes coordinator |
| Tasks | operations | assign_tasks = can_edit |
| Worker | anon token | work.html |
| Settlement/Closure | planner | can_edit; **manager denied (W15-002)** |

## Defects
### W15-001 — D8 "server pricing authority" is inert for the shipping payload (MEDIUM, verified)
- **Evidence:** `phase99` `helm_quote_total`/`enforce_pricing_total`/`save_quotation_version` recompute the total **only when the pricing jsonb has a top-level `subtotal`** (else they return/keep the client `total`). The real UI (`quotes.html gatherPricing`, `flow.html saveQuotation`) emits `total` at top level but `subtotal` only nested under `computed`. So the guard is false and the client total is trusted verbatim.
- **Impact:** a `can_edit()` staff user (incl. sales/operations) can persist an arbitrary quote/version total that bypasses the server formula. No anon path (pricing writes require login+can_edit).
- **Why not a drop-in fix:** `helm_quote_total` is a simplified model (`subtotal − discount`, `×(1+gstPct)`). It omits `discountPct`, `coupon`, `serviceChargePct`, `catering`, IGST/place-of-supply that the client engine (`_canon`) applies. Naively recomputing from `computed.subtotal` would **mis-price legitimate quotes**. Faithful server authority requires porting the full pricing engine server-side — **money-critical PRODUCT/ARCHITECTURE DECISION**, not shipped here (zero-data-loss guardrail).
- **Regression pin:** `test/d8-pricing-authority-gap.test.mjs` (7 assertions) pins the current behavior so it cannot change silently. When the decision lands, replace the characterization assertions with enforced-behavior assertions verified against an approved staging DB.

### W15-002 — `can_edit()` / `has_area()` divergence blocks manager & coordinator (MEDIUM, verified)
- **Evidence:** `can_edit()` = `admin/planner/sales/operations` (control-center.sql:13, operations.sql). The phase29/31 matrix grants `manager`/`coordinator` edit on settlement/closure/plan/etc. Many RPCs (`close_event`, `set_closure`, `mark_paid`, `confirm_quote`, `set_plan_*`, `assign_tasks`) gate on `can_edit()`.
- **Impact:** `manager` — the top operational role — is rejected (42501) by close/settlement/payment RPCs despite the matrix. Over-restrictive (fail-closed, not an exposure), but breaks legitimate handoffs. Settlement/closure must be performed by planner/admin.
- **Fix (proposed, not shipped):** reconcile `can_edit()` to consult `has_area()` for the relevant area, or add manager/coordinator to the areas' edit sets — requires an RBAC owner decision + full RLS regression on staging.

## Product decisions (unchanged — briefs only, per Wave 15)
- **OVERPAYMENT PRODUCT DECISION REQUIRED:** `record_payment` validates only `amount > 0`; no check vs total/milestone/balance. Overpayment is silently accepted; `outstanding` is milestone-status-based so it never goes negative and cannot represent a credit. Refunds are a separate manual table with no auto-linkage.
- **LOST-UPDATE RISK — PRODUCT DECISION REQUIRED:** concurrent quote-metadata edits are last-write-wins (no optimistic-concurrency token).

## Standing risks (not code defects)
- Worker links are permanent, non-expiring anon UUIDs in URL query strings (no revocation/rotation). Token still scopes to exactly one event+phone; no cross-org leak, but indefinite access if a link leaks.
- `approval_token` has no default TTL (never expires unless a value is written); revocation is manual.

## Live-run status
The continuous lifecycle spec (`tests/e2e/lifecycle/lifecycle.spec.mjs`, 12 stages × 3 engines) is **authored from this verified map and ready to run** but was **NOT executed this session** — blocked on `HELM_E2E_PASSWORD` + `HELM_E2E_SERVICE_ROLE` (never committed; not in session env). Export the four `HELM_E2E_*` vars and run `npm run test:e2e:lifecycle` to execute. The lifecycle is **not** claimed verified until that suite is green end-to-end.
