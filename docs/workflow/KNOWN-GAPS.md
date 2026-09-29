# Known Gaps & Honest Status — Helm workflow simulation

Truthful record of what was NOT fully exercised or is not implemented. "Tested" here means real staging runtime this session.

## Verified this session (runtime, staging)
- Single-record Lead→Closure lifecycle (12 stages) — 3 browsers green.
- RBAC allow/deny (admin allow, client deny), cross-tenant denial.
- Approval OTP: wrong→fail, correct→approve once, replay→denied.
- Pricing server-authority (924 differential cases, 0 mismatches; tamper ignored).
- Payment record + idempotency + overpayment rejection.
- Per-role real-UI screenshots (11 roles), each with zero production contact.

## Partial / shallow (real but limited depth)
- **Coverage specs** (budget, builder, control, discovery, inventory, logistics, plan, quotes, resources, settlement, staff, vendors): load + clean-console + one validation each — not full feature walkthroughs.
- **Accessibility:** axe (wcag2a/2aa/21a/21aa, critical+serious) on login/dashboard/approval only, + keyboard-to-submit. Not full WCAG.
- **Responsive:** horizontal-overflow + one control reachable, on login (8 widths) + dashboard only.
- **Form-by-form manual entry:** the automated flow drives forms via RPC/UI in the lifecycle; exhaustive field-by-field manual entry per form is documented from source, not each typed by hand.

## Not implemented (do not fake)
- **PDF/CSV export** of proposals/reports — roadmap, NOT built.
- **Live payment (Razorpay)** — DEFERRED, securely disabled (CI-enforced). Simulation only.
- **Live SMS OTP (MSG91)** — code-ready, disabled; approval OTP verified via staging fixture path, not real SMS delivery.
- **WhatsApp / email live channels** — DEFERRED, disabled.
- **Google OAuth** — code present, dashboard config not verified here.

## Test-stability / harness
- `WF-FLAKE-01` — `@coverage budget` flaked once on firefox under full-suite load; passed in isolation. LOW, test-stability, not a product defect.
- `WF-ENV-01` — `@guide` headed screenshot spec fails on macOS `CVDisplayLink`; replaced by headless `@workflow` capture.

## Product decisions still open (not decided here)
- **Coordinator authority:** excluded from `can_edit()` (fail-closed over-restriction, not an exposure). Owner decision needed on whether coordinators should edit lifecycle records.
- **Optimistic-lock scope:** the update-conflict guard is opt-in per call-site (wired on client save); extending to all `updateMeta` callers is a product/eng decision.

## Not done by design (safety)
- Production (`nqltz…`) not touched. `helm-v01.vercel.app` (prod-connected) deliberately NOT driven. Praneeth repo / www.helm.events untouched.
