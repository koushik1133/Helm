# OPERATIONS

**Purpose:** execution — planning, tasks, run sheet, inventory/vendors, event-day operations.
**Login:** email/password (`operations.a@…`; Password: [REDACTED TEST CREDENTIAL]). **Landing:** dashboard.html.
**Caps:** view, edit. Server: in `can_edit()`.

**Primary work on the SAME event:** set the venue/plan (`set_event_plan`), assign tasks (`assign_tasks`) with worker tokens, manage run sheet + inventory. **Creates/updates:** event_plan, event_tasks, inventory checkouts. **Cannot:** create quotes at will (create gated), delete.

**Handoff:** ← Planner (paid/confirmed event) → **Worker** (assigned task via token) → Manager (settlement).

**Verified:** lifecycle stages 08–09 green ×3 browsers (plan set; task assigned; worker accepts via token).
**Screenshots:** `screenshots/07-operations/01…04` (dashboard, ops, runsheet, inventory). **Status:** PASS.
