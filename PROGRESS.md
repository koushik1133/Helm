# Blueprint Stage — progress vs the client spec (95 steps)

Mapped against `updated_end_to_end_event_planning_flow_with_resource_management.docx`
(Pre-Event 48 · Event-Day 18 · Post-Event 29). Legend: ✅ done · 🟡 lite (works as a
status/checklist, no deep engine) · ⛔ not built yet.

## Score
- **Breadth (a working feature exists): 89 / 95 = ~94%** (✅ + 🟡)
- **Fully built at depth: 56 / 95 = ~59%** (✅)
- **Depth-weighted (🟡 counts half): ~76%**
- **Resource Management module: ~90%** (procurement is the only lite part)
- **Foundation (auth, 6-role RBAC, 2D/3D builder, quote/approval/pricing, notifications): 100%** — pre-existing, reused, and now RBAC-hardened.
- **Honest one-liner:** almost every step of the lifecycle has a real, working feature; ~⅓ are deliberately "lite" and 6 aren't built. What's left is *depth* + going live with real channels.

## PRE-EVENT (48) — 30 ✅ · 18 🟡 · 0 ⛔
✅ 1 Inquiry/lead capture · ✅ 2 Qualification (pipeline) · 🟡 3 Discovery scheduling (no agenda/reminder) · ✅ 4 Requirement gathering · 🟡 5 Client profile (basic client only, no decision-makers/prefs) · ✅ 6 Requirement structuring (mandatory/optional) · 🟡 7 Feasibility check (risk list only) · ✅ 8 Risk assessment · ✅ 9 Concept/proposal · ✅ 10 Mood-board/palette/share · 🟡 11 Soft vendor pre-check (directory+calendar, no per-event ask) · ✅ 12 Internal cost estimation · ✅ 13 Quote preparation · 🟡 14 Quote internal review (versions, no explicit review step) · 🟡 15 Quote sent (share link; no PDF gen) · 🟡 16 Client quote review · ✅ 17 Quote negotiation (versions) · ✅ 18 Quote approval/lock · ✅ 19 Contract & confirmation (OTP+consent+payment) · ✅ 20 Event workspace · ✅ 21 Team assignment · 🟡 22 Workstream creation (task categories, no board) · 🟡 23 Detailed planning (deadlines/deps in schema, thin UI) · ✅ 24 Resource requirement mapping · ✅ 25 Internal capability check · ✅ 26 In-house staff assignment · ✅ 27 In-house inventory allocation · ✅ 28 External gap identification · ✅ 29 Vendor/freelancer engagement · 🟡 30 Vendor booking (no multi-quote compare) · 🟡 31 Vendor contracting (flag, no document) · ✅ 32 Freelancer confirmation · 🟡 33 Procurement/rental planning (lite) · ✅ 34 Staff task assignment · 🟡 35 Client approval tracking · ✅ 36 Menu/service approval + lock · ✅ 37 Venue coordination + layout · ✅ 38 Budget tracking (margin) · ✅ 39 Change request management · 🟡 40 Procurement/rental/inventory execution (return/damage yes; delivery-tracking lite) · 🟡 41 Permissions & compliance (checklist, no document-approval engine) · ✅ 42 Logistics planning + run-sheet · 🟡 43 Guest/attendee planning (headcount yes; seating/list lite) · 🟡 44 Communication plan (checklist) · ✅ 45 Payment milestone tracking + reminders · ✅ 46 Rehearsal/dry-run (sign-off) · ✅ 47 Pre-event readiness gate · 🟡 48 Final briefing (sign-off; no emergency-plan doc)

## EVENT-DAY (18) — 9 ✅ · 7 🟡 · 2 ⛔
✅ 49 Venue access · ✅ 50 In-house deployment + attendance · ✅ 51 Vendor/freelancer arrival tracking · 🟡 52 Inventory/material movement (allocated; venue-movement lite) · ✅ 53 Setup execution checks · ✅ 54 Technical checks · 🟡 55 Client walkthrough (lite) · ✅ 56 Guest entry/reception (command centre: guest groups, +/− check-in, pull-from-logistics, running total) · 🟡 57 Program execution (run-sheet, no live tick-off) · 🟡 58 Live vendor coordination (via issues) · 🟡 59 Live staff coordination (via issues) · ✅ 60 Live inventory support (command centre: raise stock requests from the catalog or free-text, mark issued/replaced) · ✅ 61 Live issue management · 🟡 62 Client requests during event (via change) · ✅ 63 Scope change during event (billable) · 🟡 64 Event progress tracking (run-sheet, no live delay alerts) · ✅ 65 Safety/emergency incident log · ✅ 66 Event completion

## POST-EVENT (29) — 17 ✅ · 8 🟡 · 4 ⛔
✅ 67 Dismantling · ✅ 68 In-house inventory count/return (+damage→stock) · ✅ 69 Rental return · ✅ 70 Vendor exit · ✅ 71 Venue handover (checklist) · 🟡 72 Vendor completion verification · 🟡 73 Client completion acknowledgement · 🟡 74 Scope reconciliation · ✅ 75 Additional charges finalization · 🟡 76 Vendor invoice collection (settlement, no invoice upload) · ✅ 77 Vendor payment settlement · ✅ 78 Client final invoice · ✅ 79 Client payment collection · ✅ 80 Refund/recovery handling (settlement: refunds/recoveries/deductions with approve→processed and running totals) · 🟡 81 Damage/loss handling (stock adjust; no liability case) · 🟡 82 Internal team closure · ✅ 83 Staff overtime/expense claims · ✅ 84 Client feedback + rating + testimonial · ✅ 85 Vendor/freelancer rating · ✅ 86 Event photos/media collection (media.html: add photo/video links, flag client gallery, gallery-preview mode; workspace card) · ✅ 87 Marketing permission (consent flag) · ✅ 88 Profit/loss review · ✅ 89 Financial closure · 🟡 90 Documentation & archive (stamp; no file store) · ✅ 91 Lessons learned · ✅ 92 Template/process update (templates.html: reusable checklist templates by section; "Apply template" on Logistics inserts the items) · 🟡 93 Client relationship management (CRM archive + follow-up link) · ⛔ 94 Repeat business/nurture (occasion reminders) · ✅ 95 Final event closure

## The 6 not-built (⛔)
1. **56 Guest entry/reception** — welcome-desk/guest check-in on the day.
2. **60 Live inventory support** — request/replace stock live during the event.
3. **80 Refund/recovery handling** — deposits, deductions, refunds engine.
4. **86 Media collection/gallery** — photos/videos + client gallery (the deferred DAM).
5. **92 Template/process update** — turn lessons into reusable checklist templates.
6. **94 Repeat business/nurture** — nurture list + occasion reminders (deferred CRM nurture).

## Cross-cutting still to do
- **Go-live channels** (currently simulated): real payments (Razorpay/Stripe), SMS/OTP (MSG91/Twilio), email (Resend/SendGrid), WhatsApp.
- **Deepen the 🟡 lite areas** that matter most: compliance/permit document engine (41), guest list + seating (43), deeper finance (refunds 80, invoices 76), media gallery (86), CRM nurture (94), workstream board (22).
- **Time-aware calendar** (hour-level conflicts) — parked (Phase 10b).
- **Hardening leftovers**: tighten Edge-Function CORS, add CSP/HSTS at host, per-phone OTP limit.

## Done this session (hardening)
Recovered app from GitHub after an iCloud wipe; corrected P&L money math; fixed
readiness empty-passes + inventory over-commit; ~15 polish fixes; **role-based
access control** (UI + DB RLS, verified per-role); full security review (`security/REPORT.md`).
