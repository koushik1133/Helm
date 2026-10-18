# Helm: 5 ways to run your studio, from first enquiry to closed event

This guide is for studio owners. It shows five team setups that work well in Helm, covering who does each step, where they click, what the client sees, and where the money is tracked.

**Remember this one thing:** in Helm, *the quote is the event*. A lead becomes a quote. When the client says yes, that same quote is confirmed and holds the floor plan, the tasks, the payments and the closure. Nobody types anything twice. Each person just works on their part of the same record.

**Where things live (your web address).** Every studio page sits under your studio's link name, for example `helm.events/<studio>/...`:

| What | Address | Menu name |
|---|---|---|
| Home / dashboard | `/<studio>/dashboard` | Dashboard (Home) |
| Leads | `/<studio>/leads` | Leads |
| Quotes and events list | `/<studio>/quotes` (also `/<studio>/events`) | Quotes |
| One event's hub | `/<studio>/events/<event number>` | opens from Quotes |
| Floor plan (builder) | `/<studio>/events/<event number>/floor-plan` | "Floor plan" button on the event |
| Event tasks | `/<studio>/events/<event number>/tasks` | "Tasks" on the event |
| Calendar | `/<studio>/calendar` | Calendar |
| Team chat | `/<studio>/chat` | Chat |
| Staff, Inventory, Vendors, Templates | `/<studio>/staff`, `/inventory`, `/vendors`, `/templates` | Resources group |
| CRM archive, Nurture | `/<studio>/crm`, `/<studio>/nurture` | Pipeline group |
| Run-sheet, Resource plan, Logistics, Readiness, Teardown | `/<studio>/runsheet`, `/resources`, `/logistics`, `/ready`, `/teardown` | Planning steps on the event |
| Event-day command | `/<studio>/command` | Event day |
| Budget, Settlement, Closure and P&L | `/<studio>/budget`, `/settlement`, `/closure` | Finance steps on the event |
| Business, Insights, Reports, Audit log | `/<studio>/business`, `/insights`, `/reports`, `/audit` | Owner menu |
| Settings (Control Center: users, access, pricing, venues, codes) | `/<studio>/settings` | Settings |
| Studio setup, Integrations | `/<studio>/onboarding`, `/<studio>/integrations` | Owner menu |
| Client's page | `/<studio>/clients/<client ref>` | from the event |
| Client booklet (shareable) | `/<studio>/booklet/<secret link>` | "Share booklet" |
| Digital invitation website | `/i/<event link>` | Invitation site on a confirmed event |

**Roles in Helm:** Admin, Event manager, Planner, Sales, Event coordinator, Supervisor, Quality engineer, Operations, Designer, Crew, and Client. *Worker* is an old name and now counts as Crew.

**Who can do what is set by you.** Go to **Settings → Users & access** to turn each area (Leads, Finance, Settlement and so on) on or off per role. When an area is off, it is blocked on the server and not just hidden. Typing the address won't get around it. Basic rights per role:
- **Admin**: everything, including deleting and managing users.
- **Event manager, Planner, Sales**: view, create and edit. Planners can also delete.
- **Coordinator, Supervisor, Quality, Operations, Designer**: view and edit, but they **cannot create new quotes**.
- **Crew and Client**: view only.
- **Create new quotes** is its own switch in Settings. By default it is on for manager, planner and sales.

---

## Workflow 1: One person does everything (owner as Admin, working solo)

**Best for:** a new or small studio where the owner sells, plans and runs events.

1. **Set up once.** Open **Studio setup** (`/<studio>/onboarding`). Add your logo, venues and prices (Settings → Item pricing). On **Inventory**, press **Load starter items**, then fix quantities and prices.
2. **Enquiry comes in.** Go to **Leads → New lead** (`/<studio>/leads`) and enter the name, phone or email, event type, date and budget.
3. **Qualify it.** Use the Discovery questions on the lead. When it's real, press **Generate a quote**. This creates the event with a number.
4. **Build the quote.** Open the event (`/<studio>/events/<number>`) and pick a package or menu. Open **Floor plan** to drag in stages, tables and seating. The price updates as you go, and each save keeps a version.
5. **Send the proposal.** Publish the proposal from the event and share the link with the client.
6. **Client approves and pays the advance.** The client approves with a one-time code. You record the advance against the **payment milestones**, and the event becomes **Confirmed**.
7. **Plan.** Fill in the event's **Venue and menu**, **Resource plan**, **Run-sheet**, **Logistics** and **Readiness** steps. Check **Calendar** for clashes.
8. **Event day.** Use **Event-day command** (`/<studio>/command`) to tick off the run-sheet and log any issues.
9. **Close.** Use **Settlement** to add extras and collect the balance. Then go to **Closure and P&L**, review costs against revenue, and close the event.

- **Where money lives:** the event's payment milestones, then Budget, Settlement and Closure. **Business**, **Insights** and **Reports** show totals across all events.
- **Handoffs and notifications:** none. You get the bell alerts when the client approves or picks a package.
- **Who can't see what:** not relevant, since you see everything. When you hire someone later, give them their own login with the right role. **Never share the admin login.**

---

## Workflow 2: Full team relay (Sales, Planner, Event manager, Crew)

**Best for:** a growing studio with a person for each stage.

| Step | Who | Where | What they do |
|---|---|---|---|
| 1 | Sales | Leads → New lead | Records the enquiry and qualifies it with Discovery |
| 2 | Sales | Lead → Generate a quote | Creates the event and a draft price |
| 3 | Planner | Quotes → open event → Floor plan | Designs the layout and chooses packages and menu. Price updates live |
| 4 | Planner or Sales | Event → publish proposal | Sends the proposal link to the client |
| 5 | Client | proposal link | Reviews, picks a package, approves with a one-time code |
| 6 | Event manager | Event → package review and payments | Accepts or declines the client's package choice and records the advance. Event becomes Confirmed |
| 7 | Planner | Run-sheet, Resource plan, Logistics | Turns the confirmed event into a plan |
| 8 | Event manager | Event → Tasks (`/events/<n>/tasks`) | Assigns tasks to crew with due times |
| 9 | Crew | Dashboard → My tasks, or their task link | Sees only their own tasks and marks them started or done |
| 10 | Event manager | Settlement → Closure and P&L | Collects the balance and closes the event |

- **Handoffs:** each step changes the event's status. The event then appears on the next person's **Dashboard**, and alerts ring the **bell** (approvals, package picks, payments). Use **Chat** for quick questions.
- **What the client sees:** only the proposal page, the approval screen, their booklet and, later, the invitation site. The client never sees your leads, other quotes or payments.
- **Where money lives:** the payment milestones on the event, then Settlement, then Closure. Sales usually doesn't need Settlement or Closure, so switch those off for Sales if you like.
- **Who can't see what:** Crew sees no prices, leads, clients' money or Settings. Sales and Planner can't open Settings unless you turn on "Control Center" for them. Only Admin can manage users.

---

## Workflow 3: Event-manager-led with a crew

**Best for:** studios where one or two managers own each event from start to finish and lead a crew.

1. **Manager** creates the lead (**Leads → New lead**) and the quote. Managers can create quotes by default.
2. **Manager** builds the floor plan and packages, publishes the proposal, then records the client's approval and advance.
3. **Manager** plans the event (Run-sheet, Resources, Logistics, Readiness) and assigns tasks. A **Coordinator** or **Supervisor** can help edit tasks and the run-sheet, but **cannot create new quotes**.
4. **Crew** work from **My tasks** on the Dashboard: Today, Overdue, Blocked, Completed. A **Supervisor** or **Quality engineer** checks the work marked done.
5. **Manager** runs Settlement and Closure.

- **Owner's job:** check **Business** and **Insights** weekly. Decide in **Settings** whether managers can see Insights money and the Control Center.
- **Who can't see what:** Coordinator, Supervisor and Operations see planning and event-day pages but, by default, no Leads, CRM or finance. Crew sees only their assigned tasks.

---

## Workflow 4: Client self-serve (proposal link, approval, payment milestones)

**Best for:** studios that want the client to do as much as possible online.

1. **Your team** creates the quote and publishes the proposal (Workflow 1 or 2, up to step 5).
2. **Client opens the link.** They see the proposal with pricing, packages and a picture of the layout. They can choose a **package** and see a live price.
3. **Client approves.** They enter a one-time code. Wrong codes are counted and lock out after several tries, and each code works once. Helm keeps the approval as a consent record.
4. **Your team is told.** The **bell** alerts whoever has "Package selections (review)" turned on. The manager accepts or declines the choice.
5. **Payment milestones.** For example: advance, mid-payment, balance. Each payment is recorded against a milestone, and Helm refuses an overpayment. *Online payment links (Razorpay) are built but switched off until you set them up. Until then, record payments by hand as they arrive.*
6. **Client keeps seeing progress** on their **booklet** link (`/<studio>/booklet/<secret>`) and, once confirmed, on their **invitation website** (`/i/<event link>`) to share with guests.
7. Your team finishes the work and closes the event as usual.

- **What the client can't see:** your studio pages, other clients, leads, costs, margins or staff. The client role is view-only, and the server returns nothing to them from the studio.
- **Tip:** WhatsApp and email reminders are built but need setting up first (**Integrations** page). Until then, send the link yourself.

---

## Workflow 5: Large studio (designer, vendors, finance, quality)

**Best for:** studios running several events a week with specialist staff.

| Who | Main pages | Does |
|---|---|---|
| Sales | Leads, Nurture, CRM archive | Captures and follows up enquiries, creates quotes |
| Designer | Floor plan (builder), Photo renders if allowed | Lays out the venue and makes the look. Can edit but **cannot create quotes** |
| Planner | Quotes, Run-sheet, Resource plan, Templates | Plans and uses checklist templates |
| Operations | Inventory, Vendors, Logistics, Teardown | Stock, vendor bookings, transport and pack-down |
| Event manager | Event hub, package review, Settlement | Approves and owns delivery |
| Coordinator / Supervisor / Quality | Run-sheet, Event-day command, Issues | Run the day and check the work |
| Crew | My tasks | Do the tasks |
| Finance person (use the Event manager role, or Admin) | Budget, Settlement, Closure and P&L, Reports | Chases payments and closes the books |

- **Flow:** Sales → Designer and Planner → Manager (approval and advance) → Operations and Planner (resources and vendors) → Coordinator and crew (event day) → Finance (settlement and closure).
- **Where money lives:** the payment milestones on each event, then **Settlement**, then **Closure and P&L**. Across all events, use **Business**, **Insights** and **Reports**. *Vendor bills and payouts are not built yet, so track vendor costs on the event budget.*
- **Who can't see what:** there is no separate "finance" role. Give money areas (Budget and finance, Settlement, Closure) only to the roles that need them. Designer, Operations and Crew normally have finance switched off. The **Audit log** (owner menu) records who changed what.

---

## Role vs page (default setup; you can change it in Settings → Users & access)

Key: **Full** = can view and edit. **Edit** = can view and change, but can't create new quotes. **View** = look only. **—** = hidden and blocked.

| Page / area | Admin | Event manager | Planner | Sales | Coordinator / Supervisor / Operations | Quality / Designer | Crew | Client |
|---|---|---|---|---|---|---|---|---|
| Dashboard and My tasks | Full | Full | Full | Full | Edit | Edit | View (own tasks) | — |
| Leads, CRM, Nurture | Full | Full | Full | Full | — | — | — | — |
| Quotes and event hub | Full | Full | Full | Full | Edit | Edit (as allowed) | — | — |
| Floor plan (builder) | Full | Full | Full | Full | Edit | Edit | — | sees the proposal picture |
| Staff, Inventory, Vendors, Calendar, Templates | Full | Full | Full | Full | Edit | as allowed | — | — |
| Run-sheet, Resources, Logistics, Readiness, Event-day command | Full | Full | Full | Full | Edit | as allowed | own tasks only | — |
| Budget, Settlement, Closure and P&L | Full | Full | Full | Full | — | — | — | — |
| Business, Insights, Reports | Full | as allowed | as allowed | as allowed | — | — | — | — |
| Settings (Control Center), Users & access | Full | if "Control Center" is on | — | — | — | — | — | — |
| Audit log | Full | as allowed | — | — | — | — | — | — |
| Proposal, approval, booklet, invitation site | send | send | send | send | — | — | — | View and approve |

Quality engineer and Designer start with no access to some areas. Turn on just what they need in Settings.

---

## Common mistakes (and how to avoid them)

1. **Sharing one login.** Give every person their own account and role, or the Audit log and "My tasks" mean nothing.
2. **Making everyone Admin.** Admin can delete and see all the money. Use Event manager for trusted leads.
3. **Making a new lead for an existing client.** Search Leads and Quotes first. The same email can overwrite or duplicate the client details.
4. **Starting a second quote instead of a new version.** Edit the same event and save. It keeps versions. A second quote splits the payments.
5. **Confirming before the client approves.** Wait for the client's one-time-code approval and the advance. That approval is your proof of agreement.
6. **Recording payments outside Helm.** If a payment isn't on a milestone, Settlement and Closure will show the wrong balance.
7. **Closing with money still owed.** Check that the Settlement balance is zero before closing. Closed events drop off everyone's lists.
8. **Expecting coordinators or designers to create quotes.** They can't by design. Have Sales, a Planner or a Manager create the quote, or turn on "Create new quotes" for that role.
9. **Forgetting Settings after hiring.** When roles change, check **Settings → Users & access**. Remove people who leave.
10. **Waiting for automatic WhatsApp, email or online payments.** These are built but switched off until you finish setup on the **Integrations** page. Until then, send links and record payments yourself.
