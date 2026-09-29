# MANAGER (Event manager)

**Purpose:** operational authority — settlement and closure of the event.
**Login:** email/password (`manager.a@…`; Password: [REDACTED TEST CREDENTIAL]). **Landing:** dashboard.html.
**Caps:** view, create, edit, manage. Server (W16-02): manager added to `can_create()` **and** `can_edit()`; **not** in `can_delete()` (cannot delete).

**Primary work on the SAME event:** review settlement, verify payment state, complete closure (`close_event`) → terminal `lifecycle_stage='closed'`.

**W15-002 resolution:** manager was previously blocked from settlement/closure (can_edit/has_area divergence); W16-02 grants manager create/settle/close. Verified live: manager settles + closes end-to-end.

**Handoff:** ← Operations/Worker (event executed) → **Admin** (final audit).

**Negative:** cannot delete lifecycle records (deny expected).
**Screenshots:** `screenshots/05-manager/01-dashboard.png`, `02-settlement.png`, `03-closure.png`. **Status:** PASS.
