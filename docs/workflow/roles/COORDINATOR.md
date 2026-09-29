# COORDINATOR (Event coordinator)

**Purpose:** supporting planning/resources/scheduling role.
**Login:** email/password (`coordinator.a@…`; Password: [REDACTED TEST CREDENTIAL]). **Landing:** dashboard.html.
**Caps:** view, edit (client caps). Server: **NOT** in `can_edit()` — a known fail-closed over-restriction.

**Primary work:** planning + resources views (plan.html, resources.html), coordination/schedule prep.

**⚠ Product decision (open):** coordinator is excluded from the server `can_edit()` set, so coordinator is effectively view-oriented for lifecycle-gated actions even though the client cap map lists "edit". This is **fail-closed over-restriction, not a security exposure**. Owner must decide whether coordinators should edit lifecycle records (mirror manager's W16-02 treatment) or remain view/coordination-only. Not decided here.

**Handoff:** supporting alongside Operations/Planner.
**Screenshots:** `screenshots/06-coordinator/01…03` (dashboard, plan, resources). **Status:** PASS (as view/coordination); authority = PRODUCT DECISION REQUIRED.
