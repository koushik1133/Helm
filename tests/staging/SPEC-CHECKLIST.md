# Staging-Preview Spec Checklist — 26 required flows

Maps each required flow to an EXISTING Playwright spec under `tests/e2e/` or to a
clearly-skipped TODO **stub** under `tests/staging/specs/`. Run against the
staging-wired preview with `playwright.staging.config.mjs` (which hard-gates the
STAGING ref first). Do NOT run against production. Stubs use `test.fixme(...)` so
they report as PENDING and never silently pass.

| # | Flow | Spec | Status |
|---|------|------|--------|
| 1 | Login | tests/e2e/auth/login-regression.spec.mjs, auth/smoke.spec.mjs | MAPPED |
| 2 | Password change | tests/staging/specs/password-change.spec.mjs | STUB |
| 3 | Session expiry | tests/staging/specs/session-expiry.spec.mjs | STUB |
| 4 | Dashboard | auth/smoke.spec.mjs (post-login dashboard) | MAPPED |
| 5 | CRM | tests/staging/specs/crm.spec.mjs | STUB |
| 6 | Leads (create/edit) | coverage/discovery.spec.mjs (capture) + tests/staging/specs/leads.spec.mjs (create/edit) | MAPPED (capture) + STUB (create/edit) |
| 7 | Quote | coverage/quotes.spec.mjs | MAPPED |
| 8 | Pricing | coverage/budget.spec.mjs + tests/staging/specs/pricing-authority.spec.mjs (D8 authority) | MAPPED (math) + STUB (D8 authority) |
| 9 | Discount | coverage/budget.spec.mjs (discount math) | MAPPED |
| 10 | Coupon | coverage/budget.spec.mjs (coupon/discount) | MAPPED |
| 11 | Builder 2D | coverage/builder.spec.mjs | MAPPED |
| 12 | Builder 3D | tests/staging/specs/builder-3d.spec.mjs | STUB |
| 13 | Approval | approval/approval.spec.mjs, approval/approval-extended.spec.mjs | MAPPED |
| 14 | Proposal | lifecycle/lifecycle.spec.mjs (stage) + tests/staging/specs/proposal.spec.mjs | MAPPED (partial) + STUB |
| 15 | Portal (client) | roles/roles.spec.mjs (data denial) + tests/staging/specs/portal.spec.mjs (UI) | MAPPED (data) + STUB (UI) |
| 16 | Event planning | coverage/plan.spec.mjs | MAPPED |
| 17 | Design Studio | tests/staging/specs/design-studio.spec.mjs | STUB |
| 18 | Inventory | coverage/inventory.spec.mjs | MAPPED |
| 19 | Reservation | coverage/resources.spec.mjs + tests/staging/specs/reservation.spec.mjs | MAPPED (partial) + STUB |
| 20 | Return reservation | tests/staging/specs/return-reservation.spec.mjs | STUB |
| 21 | Worker | roles/roles.spec.mjs (role) + tests/staging/specs/worker.spec.mjs (/work) | MAPPED (role) + STUB (/work) |
| 22 | Tasks | coverage/control.spec.mjs + tests/staging/specs/tasks.spec.mjs (CRUD) | MAPPED (partial) + STUB |
| 23 | QC (quality) | roles/roles.spec.mjs (role) + tests/staging/specs/qc.spec.mjs | MAPPED (role) + STUB |
| 24 | Invitations | tests/staging/specs/invitations.spec.mjs (/i/<slug>, invite-studio) | STUB |
| 25 | Admin / users / roles | roles/roles.spec.mjs (admin), coverage/control.spec.mjs | MAPPED |
| 26 | Safe payment testing | tests/staging/specs/payment-sim.spec.mjs (sim-pay / Razorpay TEST only) | STUB |
| + | Logout | auth/smoke.spec.mjs (teardown) + tests/staging/specs/logout.spec.mjs (explicit) | MAPPED (partial) + STUB |

Also mapped (bonus coverage): coverage/settlement.spec.mjs, coverage/vendors.spec.mjs,
coverage/logistics.spec.mjs, coverage/staff.spec.mjs.

## Cross-cutting (already present, run in the e2e projects)
- Environment isolation: environment/isolation.spec.mjs (asserts STAGING, zero prod hits)
- Privacy: privacy/privacy.spec.mjs · Responsive: responsive/responsive.spec.mjs
- A11y: accessibility/a11y.spec.mjs · Reliability/concurrency: reliability/*.spec.mjs
- Input validation: validation/input-validation.spec.mjs

## Payment-flow safety rule
Flow #26 must use ONLY the simulated pay surface (`/sim-pay`) or Razorpay **test mode**
with test keys/cards. NEVER a live Razorpay link, NEVER a real card. `liveChannels.pay`
stays `false` for staging tests. The stub's safety header enforces this for the author.

## Stub convention
Stubs live under `tests/staging/specs/<name>.spec.mjs` and use `test.fixme(...)` so they
appear in the report as PENDING (not silently absent, not silently green) until authored.
They are collected by the `staging-stubs` project in `playwright.staging.config.mjs`.

## Role note
The staging globalSetup signs in the seeded HARDEN_TEST_ roles only:
admin, manager, sales, coordinator, operations, designer, quality, client.
Flows needing `worker`/`supervisor`/`planner`/`crew` require those fixture users to be
added to scripts/staging/seed-test-data.mjs before the corresponding spec can run.
