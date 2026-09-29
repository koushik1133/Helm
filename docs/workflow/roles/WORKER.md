# WORKER

**Purpose:** field worker — sees and updates ONLY their assigned task/event.
**Access model:** **token-based** task access (work_tokens) + a view-only session (`worker.a@…`). Not a studio editor.
**Caps:** view.

**Primary work:** open assigned task via token (`worker_get_tasks`/`worker_respond`), update/complete status.

**Security (verified in Wave 15B + lifecycle 09):** worker token has expiry + revoke; after `revoke_work_token` or past `expires_at` → access denied (401/42501). Worker cannot see another worker's event, another org's event, or unassigned sensitive data. Tokens are never shown in docs/screenshots.

**Handoff:** ← Operations (task assigned) → Operations/Manager (task complete).
**Screenshots:** `screenshots/08-worker/01-dashboard.png` (restricted view). **Status:** PASS.
