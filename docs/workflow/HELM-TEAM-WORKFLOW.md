# Helm — How your team actually works in the app (end to end)

Plain-language walkthrough of one event from first enquiry to close, **who does what**, **what hands off to whom**, and **how each person is told there's something waiting for them**. This reflects what is actually built today (including the new Designer state machine, My-Tasks buckets, and per-role dashboards).

> **The one idea that makes Helm simple:** *the quote row IS the event.* A lead becomes a quote, the quote gets confirmed, and that same record carries the layout, tasks, payments, and closure. Nobody re-keys anything — everyone works on the same event record, just on their part of it.

---

## The cast (roles) and what they own
| Role | Owns | Typical screens |
|---|---|---|
| **Sales** | Leads → quotes → winning the deal | Leads, Quotes, Builder (draft), Discovery |
| **Event manager (manager)** | The whole event after it's won; approvals; money | Dashboard, Event hub, Settlement, Closure |
| **Planner** | Turning a won event into a plan | Quotes, Plan, Run-sheet, Resources |
| **Designer** *(new)* | The 2D→3D design and getting the client to sign off | Design Studio, Builder |
| **Event coordinator** | Day-to-day delivery, tasks, staffing | Run-sheet, Staff, Event-day command |
| **Supervisor / Quality / Operations** | Execution + verification on the ground | Command, Issues, Inventory, tasks |
| **Crew / Worker** | Doing the assigned tasks | Dashboard "My tasks", event tasks |
| **Client** | Approving the proposal/design, paying, seeing their event | Portal, Proposal, Invitation site |

Which tabs each role even *sees* is controlled by the **access matrix in Control Center** (per-org). If a feature is turned off for a role there, it's gone for them — not just hidden, but blocked at the database (see the security note at the end).

---

## The journey, stage by stage — with handoffs and notifications

### 1. Lead comes in → **Sales**
- Sales creates a **Lead** (name, event type, date, budget) in Leads.
- Sales qualifies it (Discovery) and, when it's real, presses **Generate a quote** — this creates the event record (a quote code like `09292026-01`).
- **Handoff:** none yet — Sales still owns it.

### 2. Build the quote + draft layout → **Sales / Planner (+ Designer)**
- In the **Builder**, they lay out the floor in 2D (drag stages, seating, tables), and live pricing updates. Save = a new version.
- **Inventory tip — "Load starter items":** on the Inventory page there's a **"Load starter items"** button. A brand-new org has an empty inventory, so Helm can seed a realistic starter catalogue in one click (Chiavari chairs, round tables, linens, uplights, speakers, mics, staging decks, chafing dishes, plates, extension cords, etc.). It's **idempotent** — press it once to populate, and pressing again only adds what's missing ("All starter items already present"). It saves you typing your whole rental catalogue by hand on day one. You then edit quantities/prices to match what you really own.

### 3. Design sign-off → **Designer → Client** *(new state machine)*
This is the new formal flow, visible in **Design Studio** (`design.html`) and as a chip on the Builder:
```
draft_2d → internal_review → approved_2d → build_3d → client_review → approved_3d → locked
                     └──── revise ◄────┘ (loops back, bumps the revision number)
```
- The **Designer** advances each stage with a button; a **note** can be attached ("moved the bar, widened the aisle").
- At **client_review** the **client** signs off (via the existing OTP/portal approval), moving it to **approved_3d**, then the manager **locks** it.
- **Every transition:** writes to the audit log **and raises an in-app notification**, and the design shows up in the Designer's **queue** grouped by state. A rejection sends it back to `revise` and increments the revision, so you always know which round you're on.

### 4. Confirm & pay → **Event manager + Client**
- Manager sends the proposal; the **client approves + pays a deposit** (OTP-verified). The event flips to **confirmed**. Overpayment is guarded; payments reconcile against milestones.
- **Handoff:** confirmed event now belongs to the **Planner / Coordinator** for delivery.

### 5. Plan & assign work → **Planner / Coordinator**
- Planner builds the **run-sheet**, resource plan, and **tasks** (`event_tasks`) — each task can be assigned to a **crew member**, given a due time, and chained with dependencies (task B `depends_on` task A).
- **Handoff + notification:** assigning a task is how work reaches **Crew/Operations/Quality**.

### 6. The "what's waiting for me" experience → **everyone, on the Dashboard**
This is the part you described — and it's live:
- **Welcome board (per role, new):** the top of the dashboard shows a **role-specific set of cards** — Sales sees pipeline/won; a manager sees upcoming events, awaiting-confirmation, and *designs at client review*; a coordinator sees *tasks today / overdue / blocked*; a designer sees the design queue; crew sees their task buckets.
- **"Upcoming & my tasks":** a list of your active events. **Click an event and its tasks expand inline** — open tasks are shown, and **completed tasks collapse under a "Done" fold** (exactly the "previous done tasks get closed" behaviour you wanted).
- **"My tasks" (new):** your personal tasks bucketed **TODAY / OVERDUE / BLOCKED / COMPLETED**, so a crew member logs in and immediately sees what's due, what's late, and what's stuck waiting on someone else.
- **Bell / notifications:** unread count in the header; design transitions, approvals, and payments raise notifications, all **org-scoped** (you never see another org's notifications).

### 7. Event day → **Coordinator / Supervisor / Crew**
- **Event-day command** shows the run-sheet live; crew mark tasks started/done; supervisors/quality **verify** completed tasks; issues/incidents are logged.

### 8. Settlement & close → **Event manager**
- Final settlement (extras, balances), then **Closure & P&L** — costs vs revenue, margins. The event moves to **closed** and drops out of everyone's active lists.

---

## The handoff chain at a glance
```
Sales (lead → quote → win)
   → Designer (2D → client sign-off → 3D → lock)         ⟳ revise loop
   → Event manager (confirm + deposit)
   → Planner (run-sheet + tasks)
   → Coordinator (assign + schedule)  ──assign──►  Crew / Operations / Quality (do + verify)
   → Event manager (settlement → closure → P&L)
```
Each arrow is a real state change that (a) moves the event forward, (b) surfaces on the next person's **dashboard board + My-tasks**, and (c) can raise a **notification**. No email chains, no spreadsheets — the event record carries itself down the line.

---

## Security note (why "disabled means disabled")
When a feature/area is turned **off** for a role in Control Center, it is enforced at the **database (RLS)**, not just hidden in the UI. We proved this at runtime: disabling an area makes the underlying API return **zero rows** for that role — so it can't be reached by typing the URL, hitting the endpoint directly, or opening another tab. Cross-organisation isolation is also runtime-proven with three separate orgs: **no org can see another org's events, tasks, notifications, files, or anything else.** Full evidence: `docs/completion/MASTER-PLATFORM-AUDIT.md`.
