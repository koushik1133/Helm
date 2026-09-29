# SUPPORT ROLES — Supervisor, Quality, Crew

These three roles authenticate and load the dashboard on staging (verified). They are supporting roles in the current build, not owners of a lifecycle stage.

## Supervisor (`supervisor.a@…`)
- **Caps:** view, edit (client). Server: not in `can_edit()` (like coordinator).
- **Purpose:** operational oversight. **Screenshot:** `screenshots/09-supervisor/01-dashboard.png`. Status: PASS (view/oversight).

## Quality (Quality engineer, `quality.a@…`)
- **Caps:** view, edit (client). Server: not in `can_edit()`.
- **Purpose:** quality checks. **Screenshot:** `screenshots/10-quality/01-dashboard.png`. Status: PASS (view).

## Crew (`crew.a@…`)
- **Caps:** view only.
- **Purpose:** view assigned work (like worker but broader view). **Screenshot:** `screenshots/11-crew/01-dashboard.png`. Status: PASS (view).

**Note:** Supervisor/Quality edit authority sits behind the same `can_edit()` gate discussed in COORDINATOR.md — a **product decision** on whether these roles should mutate lifecycle records. Not decided here.
