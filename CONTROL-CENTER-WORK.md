# Control Center rebuild + Nurture automation — work tracker

Started 2026-09-18. Two features requested by the user, tracked step-by-step.

## Feature 1 — Control Center tabs + configurable access matrix + more roles
Goal: In `control.html`, below the header add two tabs — **Pricing** and **User control**.
Move the admin Users panel (today a modal on `index.html`) into the User-control tab.
Add a fully **customizable per-role access matrix**: pick a role → a table of every
area (Leads, CRM, Nurture, Staff, Inventory, Vendors, Calendar, Templates, Codes,
Controls, …) with a tick/cross (green border + tick = accessible). Saved to DB and
enforced (UI gating + RLS). Add 4 new roles: **coordinator, supervisor, worker, manager**.

- [x] 1a. SQL `phase29-role-access.sql`: 10 roles; `role_access` table + seeded defaults;
      `has_area()`; RLS on every feature table driven by `has_area`; admin RPCs
      `admin_get_role_access` / `admin_set_role_access`; legacy wrappers kept. Idempotent. ✅
- [x] 1b. `store-api.js`: 10-role ROLE_CAPS + `admin.roles()`; AREAS constant (25 areas);
      live `role_access` fetch (cached) drives `canView` (+ `canEditArea`); `admin.getAccess/setAccess`. ✅
- [x] 1c. `control.html`: Pricing | User control tabs; pricing moved into Pricing pane;
      User-control pane = team table (add/role/remove, 10 roles) + role picker + matrix editor
      (icon chips, green border+tick = view, ✎ = edit). Admin-only. ✅
- [x] 1d. `index.html`: Users → `control.html#users`; every nav link gated by its fine area;
      old users modal removed. ✅
- [x] 1e. Cache bumped `?v=41` on all 31 pages. SQL synced to phase29.sql / full-schema/35 /
      complete-setup.sql. UI tested in-browser (10 roles, 25 chips, toggles, restricted nav). ✅
- [ ] 1f. **USER TO RUN** `phase29-role-access.sql` on Supabase, then live per-role test. Pushed.

## Feature 2 — Nurture recurring occasions + automated greetings
Goal: In `nurture.html` add an **on/off automation** tab. List everyone with a recurring
occasion (birthday, anniversary, yearly). Auto-send a warm greeting (“Happy birthday!
Last year at this time you…”) with memories + a few gallery photos attached. Per-occasion
**editable template** with a good default. (Real send stays deferred → queues to the
notification outbox / simulated for now.)

- [ ] 2a. SQL `phase30-nurture-automation.sql`: `nurture_occasions(contact,occasion_type,
      occasion_date,recurrence,auto_on,...)`, `nurture_templates(occasion_type,subject,body,
      editable)` seeded with defaults; `nurture_due(p_within_days)` RPC; `queue_nurture_greeting()`
      RPC → notification outbox with rendered template + gallery image links. Idempotent.
- [ ] 2b. `store-api.js`: `nurture.occasions`, `nurture.templates`, `nurture.due`, `nurture.send`.
- [ ] 2c. `nurture.html`: Automation tab (toggle), due list, template editor.
- [ ] 2d. Test + sync copies + push.

## Design decisions (defaults; admin can change all in the matrix)
- 10 roles. Defaults: admin=all; manager=all except managing users; planner=all ops+pipeline+finance;
  sales=pipeline+quotes edit, finance/ops view; coordinator=ops+day edit, no finance;
  supervisor=day+ops edit, no finance/pipeline; operations=ops edit, day view;
  crew/worker/client=none (token pages only).
- Access model = view/edit per area (green tick = has it). Delete follows edit.
- Admin always has full access (safety floor) regardless of matrix rows.
- Real email/SMS send remains deferred; greetings queue to the existing outbox.
