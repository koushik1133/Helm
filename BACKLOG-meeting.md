# Stakeholder-meeting backlog (Praneeth + Koushik) — captured 2026-09-18

Everything requested, grouped into buildable clusters. Legend: ⬜ to build · 🟡 partly done · ✅ done.

## Cluster A — Roles & access polish ✅ DONE (phase31, commit pending)
- ✅ **A1 Added "quality" (Quality engineer) role.** 11 roles total.
- ✅ **A2 Relabelled** in the UI: Event manager / Event coordinator / Quality engineer / Supervisor
  (ROLE_LABELS in store-api; used on role tabs, users dropdown, dashboard chip). Keys stay stable.
- ✅ **A3 Default SALES access tightened to Leads + CRM only** (phase31 explicit upsert; admin can widen).
- ✅ **A4 Planner-only layout editing.** New `layouts` area; default edit = planner (+admin), others
  view-only. Enforced by DB RLS on the layouts table (builder internals untouched).
- ✅ **A5 Separate Pricing / User-management tabs** — done (phase29 / control.html).
- ✅ **A6 Per-role feature enable/disable control panel** — done (access matrix); A3/A4 refined defaults.
- ⬜ **USER TO RUN** `phase31-roles-layout.sql` (after phase29), then live per-role test.

## Cluster B — Inventory accountability ✅ DONE (phase33, commit pending)
- ✅ **B1 Priority class A/B/C + unit cost** on inventory items. Badge in the stock table,
  priority filter, priority+cost fields in the item editor.
- ✅ **B2 Chair types in Control Center.** `chair_types` catalog (name + price), CRUD in the
  Pricing tab, seeded Plastic/Cushioned/Chiavari.
- ✅ **B3 Check-out / check-in accountability.** `inventory_checkouts` + checkout_equipment /
  checkin_equipment RPCs (stamp who issued / who signed off). Inventory page "Check-out /
  Check-in" tab: issue form, Out-on-loan list, and a Loss report computing missing units +
  ₹ value lost (unit_cost × missing); optional write-off reduces stock. No photos.
- ⬜ **USER TO RUN** `phase33-inventory-accountability.sql` (after phase29), then live test.

## Cluster C — Task engine (categorization, verification, dependencies, alarms)
- ✅ **C1 QE verification (no photos)** — phase35. event_tasks gains verify_status/verified_by/at/note;
  completing a task auto-queues it (pending); verify_task() pass→passed, reject→rejected + back to
  in_progress (returns to event manager); task_verify_summary() for gating. ops.html shows QC chips +
  Pass/Reject for quality/manager/planner/admin. Tested in-browser.
- ⬜ **C2 Sectioned templates for ~500 tasks** (wedding): stage setup, carpets, backdrops, flower
  decoration, mandapam, lighting, catering, labour, transport. Refine categorization.
- ✅ **C3 Task dependencies + time triggers** — phase37. planned_start + triggered_at; set_task_schedule(); run_task_triggers() notifies scheduled tasks whose time+prerequisite are met (live cron deferred). ops.html shows gate chips (⛔ blocked / ⏱ scheduled / ▶ ready), per-task ⏱ schedule editor, and a "Fire due tasks" button. Tested.
- ⬜ **C4 Special-task recurring alarm.** Every 5 minutes remind until the task is marked complete.
- ⬜ **USER TO RUN** `phase35-task-verification.sql` (after phase29+operations), then live test.

## Cluster D — Layout measurements + quote codes ✅ DONE (commits pending)
- ✅ **D1 2D measurement "📏 Measure" (Work) toggle** in builder.html toolbar: overlays edge-to-edge
  clearances between neighbouring objects (both directions) + the selected object's distance to each
  wall, labelled in the active unit (ft/m, follows the units toggle), auto-switches to 2D, labels
  stay screen-constant across zoom, pointer-events:none so editing is unaffected. 3D builder untouched.
- ✅ **D2 Quote codes from the EVENT date** (phase34): create_quote(p_event_date), convert stamps from
  lead.event_date, rebrand_quote_code() re-issues from the event date (idempotent); quotes.html saves
  the event_date column + re-brands the draft code.
- ⬜ **USER TO RUN** `phase34-event-date-codes.sql` (after phase29+28), then live test. (D1 needs no SQL.)

## Praneeth's own action (not mine)
- Schedule the stakeholder meeting with Anil, Yum, an event manager; consolidate flow.

## Notes / risks
- D1 touches builder.html (which also holds the protected 3D builder) — I'll add a 2D-only overlay
  and keep 3D internals untouched.
- C3 is the largest item (dependency graph + scheduler); best built last, on its own.
- Real SMS/email/push for alarms (C4) stays deferred → alarms surface in-app + queue to the outbox.
