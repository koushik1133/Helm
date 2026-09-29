# Phase 3 — Personal "Upcoming & my tasks" dashboard

Delivers the dashboard feed you described: on load, each user sees active events with an
open/done task rollup and an unread-notification count; clicking an event expands its
tasks (completed ones collapsed under "Done").

## What shipped (staging-applied, needs prod apply)
- **DB:** `supabase/completion/PHASE3-my-pending.sql` — `my_pending()` RPC (SECURITY DEFINER,
  org + `has_area('quotes','view')` gated, revoked from anon). Returns `{upcoming:[…], unread, as_of}`.
  Applied + verified on **staging**; **run it on production** to enable there.
- **Client:** `public/store-api.js` — `BPStore.pending()`.
- **UI:** `public/dashboard.html` — "Upcoming & my tasks" section: event cards with
  `N open` / `all done` badges + unread badge; click a card → loads `ops.listTasks` (RLS-scoped),
  shows Open(n) and a collapsed Done(n) group. Hidden for roles without quotes access.

## Verified on staging (runtime, real UI)
- admin/planner: 25 upcoming events + unread badge; expand shows tasks (or "No tasks yet").
- crew/client: section hidden (my_pending returns empty — correctly gated).

## Deferred (follow-up)
- **Handoff auto-notifications:** inserting a targeted `notifications` row on each stage-completing
  RPC (convert/publish/record_payment/assign_tasks/verify/close) so the *next* role is pinged.
  This touches several RPCs and is a separate, careful change.
- Realtime auto-refresh of the widget.
- Must also deploy to the customer production frontend (see CUSTOMER-FRONTEND-PARITY.md).
