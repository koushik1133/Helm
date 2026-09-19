# Blueprint Stage — Roadmap v2 (Multi-tenant + requested features)

> Planning only. Build **one phase at a time**, each ends with: idempotent SQL delivered → user runs it → live test → git push → bump `?v=`.
> Continues phase numbering from phase39 (plate types).

## Scope locked with the client (2026-09-19)
Build **only** these, in phases. (Explicitly **removed**: deposit/advance tracking with auto payment reminders — parked.)

1. Task **sourcing** (in-house / outsource + vendor picker + send checklist)
2. **Lifecycle reorder** in the stepper (date/time decided first; menu locked before quote)
3. **Multi-tenant** — the app must serve many studios worldwide, fully isolated (foundational)
4. **Audit log**
5. **Report exports** (CSV / PDF)
6. **Calendar conflict / overbooking predictions**
7. **Post-event insights** (which vendors/tasks slip most, loss trends)
8. **Auto staff suggestions** (skill match + availability)
9. **Live event-day mobile view** for crew
10. **Multi-currency + GST invoice templates**
11. **Client portal**
12. **Notification center** (in-app bell)
13. **Deep visual polish** (applied last, once structure is stable)

---

## BLOCK E — Quick wins (self-contained, low risk) — do first for momentum

### Phase 40 — Task sourcing (in-house / outsource + vendor picker)
- **SQL:** `event_tasks` gets `assignee_kind` ('in_house'|'outsourced') + `vendor_id` (fk vendors). RPC `assign_task_vendor(task, vendor)` that stamps the assignee and queues a checklist to the notification outbox.
- **UI (ops.html):** assignment control = dropdown **In-house / Outsource** → if outsource, a **vendor picker modal** (all active vendors) → assign → **send checklist** (same outbox flow as crew). Vendor-assigned tasks show on the vendor's event view.
- **Test:** assign a task to a vendor → appears on vendor view, checklist queued.

### Phase 41 — Lifecycle reorder (date/time first, menu before quote)
- **Change:** the `STAGES` array + gating in `event.html` — capture event **date/time at lead/discovery** (required early), and **require the menu locked before quote pricing** is allowed (pricing depends on veg/non-veg plates).
- Mostly front-end gating; minimal SQL (a stage-order/gate flag if needed).
- **Test:** can't price the quote until the menu is locked; date/time is prompted up front.

---

## BLOCK F — Multi-tenant foundation (pivotal, highest-risk — do before feature blocks)

**Model:** shared database, shared schema, **row-level tenant isolation** (standard SaaS pattern at this scale; schema/DB-per-tenant is overkill). Every tenant-scoped row carries `org_id`; RLS forces `org_id = current_org_id()` on every table. Deny-by-default, force RLS, `org_id` never client-writable (set server-side in SECURITY DEFINER RPCs).

### Phase 42 — Organizations & tenant schema
- **`organizations`** (id, name, slug, currency, timezone, gst_number, brand json {logo, accent}, plan, created_at).
- **`org_id uuid`** added to every tenant-scoped table (profiles, leads, quotes, quote_versions, layouts, crew_members, event_tasks, task_templates, inventory_items, inventory_checkouts, chair_types, plate_types, vendors, bookings, event_costs, change_requests, payment_milestones, expense_claims, event_closure, ratings, notifications, nurture_*, role_access, …).
- **Backfill:** seed a default org "Helm Studio", stamp all existing rows to it, then `not null` + FK.
- **`current_org_id()`** SECURITY DEFINER helper (reads caller's `profiles.org_id` by `auth.uid()`) — no dashboard dependency; JWT-claim upgrade optional later for perf.
- ⚠️ Big but idempotent migration. **Run first in this block.**

### Phase 43 — Tenant-isolating RLS everywhere
- Rewrite **every** RLS policy to add `org_id = current_org_id()`; force RLS; deny-by-default. SECURITY DEFINER RPCs set `org_id` server-side (never trust client input).
- **role_access becomes per-org** (org_id column); each new org seeds its own default matrix.
- **Anon token flows** (approve / proposal / client links) scoped by the row's org via the token, not the session.
- **Storage:** namespace gallery/media paths under `org_id/…`.
- **Critical test:** create org B + user B → verify B cannot read or write ANY of org A's rows (leads, quotes, finance, inventory, tasks, layouts). Cross-tenant leakage = the #1 risk.

### Phase 44 — Org onboarding, switcher & per-org config
- **Create-studio / sign-up flow:** create org atomically, first user = org admin, seed role matrix + defaults; onboarding wizard (studio name, currency, timezone, GST, logo/accent).
- **Org settings** card in Control Center (currency, timezone, GST, branding).
- Multi-org membership + switcher: kept **light** (one active org per user for v1; note for later).
- **Test:** onboard a fresh studio end-to-end into an empty, isolated workspace.

---

## BLOCK G — Money & documents (per-tenant)

### Phase 45 — Multi-currency + GST invoice templates
- Per-org currency + per-quote currency; store amount + currency code; format everywhere. GST config per org (rate, GSTIN); invoice with tax breakdown (CGST/SGST/IGST), per-org invoice number series, print/PDF-ready.
- **Pages:** settlement / quotes invoice view; control.html tax config.
- **Test:** invoice renders with correct currency + GST breakdown.

### Phase 46 — Report exports (CSV / PDF)
- Export buttons: leads, events, P&L, inventory, settlements → **CSV**; invoice / closure / P&L → printable **PDF**. All org-scoped.
- **Test:** export a CSV + a PDF, values correct.

---

## BLOCK H — Visibility & intelligence

### Phase 47 — Audit log
- **`audit_log`** (org_id, actor, action, entity, entity_id, before/after json, at). Log key writes (pricing, role changes, deletes, check-in/out) at RPC/trigger level. Admin viewer with filters + export.
- **Test:** change a price / role → entry shows who/what/when.

### Phase 48 — Notification center (in-app bell)
- Extend `notifications` with in-app read/unread; **bell in the header** with unread count + dropdown + mark-read + deep links. Per-user, per-org.
- **Test:** task-assigned / approval / alarm appears in the bell; mark-read works.

### Phase 49 — Calendar conflict / overbooking predictions
- Detect resource overbooking (same crew/inventory/vendor double-booked; capacity exceeded) and warn **before** confirming. Surface on the calendar + readiness gate.
- **Test:** two events sharing a resource on the same date → warning.

### Phase 50 — Auto staff suggestions (skill + availability)
- When assigning a task/need, suggest in-house staff ranked by **skill match + availability** (exclude those booked that date). "Suggested crew" list.
- **Test:** suggestions exclude booked/unskilled and rank correctly.

### Phase 51 — Post-event insights
- Analytics dashboard: which **vendors/tasks slip most** (late / rejected), **loss trends** (inventory write-offs over time), margin trends. Per-org.
- **Test:** after test events, insights reflect the data (e.g. the mic write-off shows in loss trends).

---

## BLOCK I — Client & crew surfaces

### Phase 52 — Live event-day mobile view for crew
- Mobile-first crew page (enhanced `work.html`): big buttons, today's assigned tasks, check-in/out, mark done, offline-tolerant, minimal. Scoped to the crew member.
- **Test:** on a mobile viewport, crew sees only their tasks, can complete + check equipment.

### Phase 53 — Client portal
- Client login/token → portal with their event(s): proposal, approvals, payment status, gallery, timeline. Read-only, scoped to that client; no internal/finance data.
- **Test:** client sees only their event, nothing internal.

---

## BLOCK J — Deep visual polish (last, once structure is stable)

### Phase 54 — Deep visual polish
- Cohesive design system: refined tokens (palette/type/spacing), consistent components (cards/chips/buttons/tables), empty + loading states, responsive nav, optional dark mode, micro-interactions — across all pages. Per-org branding (logo/accent) reflected.
- **Test:** visual pass on key pages, mobile + desktop, no regressions.

---

## Guardrails (every phase)
- Idempotent SQL per phase → delivered to the user to run (their Supabase; MCP is a different account).
- Never handle secrets/keys; don't touch the 3D builder internals; don't delete test data (tag "testing").
- Push each tested phase to GitHub with a plain-words commit; bump `?v=` across pages on any store-api/config change.
- SQL lands in all copies (`phaseNN-*.sql`, `phaseNN.sql`, `full-schema/NN-*.sql`, `complete-setup.sql`).

## Recommended build order
**40 → 41** (quick wins) → **42 → 43 → 44** (multi-tenant foundation) → **45, 46** (money/docs) → **47, 48, 49, 50, 51** (visibility/intelligence) → **52, 53** (surfaces) → **54** (polish last).

## Parked for later (remind the client)
Deposit/advance tracking + auto payment reminders · WhatsApp channel · deep finance engine · full compliance/permit engine · media DAM · billing/plan tiers for tenants · multi-org membership switcher.
