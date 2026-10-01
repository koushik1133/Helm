# Staging-Preview Spec Checklist — 26 required flows

Maps each required flow to an EXISTING Playwright spec under `tests/e2e/` or marks it
**TODO (stub)**. Run against the staging-wired preview with
`playwright.staging.config.mjs` (which hard-gates the STAGING ref first). Do NOT run
against production. Nothing here has been executed yet — this is the coverage map.

| # | Flow | Existing spec | Status |
|---|------|---------------|--------|
| 1 | Login | tests/e2e/auth/login-regression.spec.mjs, auth/smoke.spec.mjs | MAPPED |
| 2 | Password change | — | **TODO stub** (tests/staging/stubs/password-change.spec.mjs) |
| 3 | Dashboard | auth/smoke.spec.mjs (post-login dashboard) | MAPPED |
| 4 | CRM | coverage/ (no crm.spec yet) | **TODO stub** (crm.spec.mjs) |
| 5 | Leads | coverage/discovery.spec.mjs (lead capture) | PARTIAL — confirm leads route |
| 6 | Quotes | coverage/quotes.spec.mjs | MAPPED |
| 7 | Pricing | coverage/budget.spec.mjs + D8 server-pricing authority | PARTIAL — add pricing-authority assertion |
| 8 | Builder 2D | coverage/builder.spec.mjs | MAPPED |
| 9 | Builder 3D | — | **TODO stub** (builder-3d.spec.mjs) |
| 10 | Approval | approval/approval.spec.mjs, approval/approval-extended.spec.mjs | MAPPED |
| 11 | Proposal | lifecycle/lifecycle.spec.mjs (proposal stage) | PARTIAL — add dedicated proposal.spec |
| 12 | Portal (client) | roles/roles.spec.mjs (client role) | PARTIAL — add portal.spec |
| 13 | Design | coverage/ (none) | **TODO stub** (design.spec.mjs) |
| 14 | Inventory | coverage/inventory.spec.mjs | MAPPED |
| 15 | Reservations | coverage/resources.spec.mjs (resource reservation) | PARTIAL — confirm reservations |
| 16 | Returns | — | **TODO stub** (returns.spec.mjs) |
| 17 | Tasks | coverage/control.spec.mjs | PARTIAL — confirm task CRUD |
| 18 | Worker | roles/roles.spec.mjs (worker), /work route | PARTIAL — add worker.spec |
| 19 | QC (quality) | roles/roles.spec.mjs (quality) | PARTIAL — add qc.spec |
| 20 | Invitations | — | **TODO stub** (invitations.spec.mjs — /i/<slug>, invite-studio) |
| 21 | Admin | roles/roles.spec.mjs (admin), control.spec.mjs | MAPPED |
| 22 | Payment-safe test flow | coverage/ (sim-pay) | **TODO stub** (payment-sim.spec.mjs — sim-pay only; Razorpay test mode, never live) |
| 23 | Logout | auth/smoke.spec.mjs (session teardown) | PARTIAL — add explicit logout assertion |
| 24 | Settlement | coverage/settlement.spec.mjs | MAPPED |
| 25 | Vendors | coverage/vendors.spec.mjs | MAPPED |
| 26 | Logistics / Plan / Staff | coverage/logistics.spec.mjs, coverage/plan.spec.mjs, coverage/staff.spec.mjs | MAPPED |

## Cross-cutting (already present)
- Environment isolation: environment/isolation.spec.mjs (asserts STAGING, zero prod hits)
- Privacy: privacy/privacy.spec.mjs · Responsive: responsive/responsive.spec.mjs
- A11y: accessibility/a11y.spec.mjs · Reliability/concurrency: reliability/*.spec.mjs
- Input validation: validation/input-validation.spec.mjs

## Payment-flow safety rule
Flow #22 must use ONLY the simulated pay surface (`/sim-pay`) or Razorpay **test mode**
with test keys/cards. NEVER a live Razorpay link, NEVER a real card. `liveChannels.pay`
stays `false` for staging tests.

## TODO stub convention
Create stubs under `tests/staging/stubs/<name>.spec.mjs` using `test.fixme(...)` so they
appear in the report as pending (not silently absent) until authored.
