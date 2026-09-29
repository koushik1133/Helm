# Helm — Operating Model: who does what, in what order, and who gets notified

This is the intended end-to-end run of one event, written so a new team member understands it. "**Notifies**" = who should see a pending item on their dashboard once the previous role finishes. Current-state honesty flags (✅ works / 🟡 partial / ❌ gap) are noted per step and summarized in §B.

## A. The end-to-end flow

| # | Who (role) | Page | What they do | Creates/updates | On finish, notifies → | State |
|---|---|---|---|---|---|---|
| 1 | **Sales / Sales manager** | leads.html, crm.html | Capture enquiry, qualify on pipeline | `leads` | — | ✅ |
| 2 | **Sales** | leads → convert | Convert lead → event/quote (`convert_lead_to_quote`) | `quotes` (the event) | **Planner** | ✅ |
| 3 | **Planner** | discovery.html | Capture requirements | `event_discovery` | Planner (self) | ✅ |
| 4 | **Planner** | flow/quotes.html | Price the quote (server-authoritative) | `quotation_versions` | Planner | ✅ |
| 5 | **Planner** | builder.html | Design floor in **2D & 3D**, save layout | `quote_versions` (layout) | Planner | ✅ |
| 6 | **Planner** | proposal.html | Publish proposal, mint client share token | proposal + token | **Client** | ✅ |
| 7 | **Client** | approve.html | Review proposal + pricing, approve via **OTP** | `quote_consents` | **Planner** (payment) | ✅ |
| 8 | **Planner** (payment role) | flow/settlement | Record advance payment | `quote_payments` | **Operations / Coordinator** | ✅ |
| 9 | **Coordinator / Operations** | plan.html, resources.html | Venue/menu/run-sheet, map resources → flag gaps | `event_plan`, resource needs | Operations | ✅ |
| 10 | **Operations** | ops.html | Assign tasks by section, set schedule + dependencies | `event_tasks` + worker tokens | **Crew / Worker** (per task) | ✅ |
| 11 | **Crew / Worker** | work.html (token link) | See ONLY their assigned task, update/complete | task status | **Quality / Operations** | ✅ |
| 12 | **Quality engineer** | command.html | On event day, pass/reject each task | task verify | Operations | ✅ |
| 13 | **Manager** | settlement.html, closure.html | Settle payments, close with P&L | `event_closure`, terminal `closed` | **Admin** | ✅ (W16-02) |
| 14 | **Admin** | control.html, reports.html | Final audit of the whole event | — | — | ✅ |

Access is per-role (Control Center → User control): a salesperson sees only Leads & CRM; crew see only their own tasks; etc.

## B. The "pending on my dashboard" experience you described

You want: each role logs in and **immediately sees "Upcoming events" and "My pending tasks"**; clicking an event **expands its open tasks**; **completed tasks are collapsed/closed**; and handoffs raise a notification for the next role.

**Current state (honest):**
- ✅ **Per-event tasks** exist (`event_tasks` scoped to the quote; assign / schedule / dependencies / verify / special-reminders).
- ✅ **Notifications** exist (a `notifications` table + a bell with an unread count; `phase74` scopes them by org).
- ✅ **Dashboard "Your quotes"** list (all events you can see) with Refresh.
- 🟡 **Worker view** is token-link based (worker opens their task via a link), not a logged-in "my tasks" board.
- ❌ **GAP — the aggregated, role-personalized dashboard you want is not built:** there is no single "Upcoming events + My pending tasks (across all events)" widget with click-to-expand and done-collapsed. Tasks are only visible *inside* an event, and there is no cross-event "assigned to me" query.

**Proposed build (Phase: Personal Dashboard):**
1. Server: `my_pending(p_role)` RPC → returns, for the caller, (a) upcoming events they're on, (b) open tasks assigned to them across events, (c) unread notifications — all org- and role-scoped through existing `has_area`/RLS.
2. Dashboard widget: two panels — **Upcoming events** (date-sorted) and **My pending tasks** (grouped by event; click an event → its open tasks expand; completed tasks shown collapsed under "Done").
3. Handoff notifications: on each stage-completing RPC (convert, publish_proposal, record_payment, assign_tasks, verify_task, close_event) insert a `notifications` row targeted at the next role → appears on their bell + "My pending tasks".
4. Real-time: Supabase realtime on `notifications`/`event_tasks` so it updates live.

This is a real feature addition (not just a test). It should be built, then verified per-role in the browser with screenshots.

## C. What "Load starter items" is (your question)
On **inventory.html**, "Load starter items" (`loadStarterItems()`, button `#seedBtn`) seeds a **predefined catalog** (`STARTER_ITEMS` — chairs, tables, AV, catering gear, décor, lighting, etc.) into the org's inventory so a new studio isn't starting from an empty table. It is **idempotent**: it only adds items not already present and shows "All starter items already present" once seeded (which is what your screenshot shows). It's a convenience seeder, not a test artifact — but note the items named "(testing)" in your prod screenshot are **manually-added test rows**, not starter items (see the ops note).
