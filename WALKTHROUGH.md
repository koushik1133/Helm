# Blueprint Stage — full click-by-click walkthrough

One example event — a **wedding for Priya Sharma** — taken through every feature.
Values in `code` are exactly what to type. Tag test data with **(testing)** so you can spot it later.
Sign in as **admin@helm.com / helm** for the walkthrough (admin sees everything; other roles see only their part).

Order of the real client journey:
**Set up directories → Lead → Discovery → Proposal → Quote → Confirm/Approve → Resource plan → Plan the day → Readiness → Event day → Teardown → Settlement → Closure → Nurture.**

---

## 0. One-time setup (your directories) — do this once, reused for every event

### 0a. Sign in
- Open the app (Dashboard). Click **Sign in**. Email `admin@helm.com`, Password `helm`.

### 0b. Add in-house staff — Dashboard → **👷 Staff** → **＋ Add staff**
- Name `Ravi Kumar (testing)` · Role/title `Lead photographer` · Department `Creative` · Employment `full_time` · Phone `+919810000001` · Email `ravi@studio.test` · Day rate `3500` · Skills `photography, photo` · Notes `Senior shooter`
- Save. Add 1–2 more (e.g. Name `Anita Rao (testing)`, Role `Catering lead`, Department `Catering`, Skills `catering, service`).

### 0c. Add inventory — Dashboard → **📦 Inventory** → **＋ Add item** (Stock items section)
- Name `Chiavari Chairs (testing)` · Category `Seating` · Total `200` · Unit `pcs` · Notes `Gold`
- Add another: Name `Round Tables (testing)` · Category `Furniture` · Total `30` · Unit `pcs`.

### 0d. Add vendors/partners — Dashboard → **🤝 Vendors** → **＋ Add partner**
- Name `Spotlight AV Rentals (testing)` · Type `rental` · Category `Lighting` · Phone `+919820000001` · Email `hello@spotlight.test` · Services `LED walls, trussing`
- Add a freelancer: Name `DJ Rhythm (testing)` · Type `freelancer` · Category `Entertainment` · Services `dj, music`.

### 0e. (Optional) Reusable checklist template — Dashboard → **🧩 Templates**
- **Template name** `Outdoor wedding — logistics` · **Section** `Logistics`
- **Checklist items — one per line**:
  ```
  Confirm vendor load-in times
  Book generator backup
  Share run-sheet with crew
  ```
- **Save template**. (You'll apply this later from Logistics.)

---

## 1. New enquiry → capture the Lead — Dashboard → **🎯 Leads**
- Click **＋ New lead**. Fill:
  - **Contact name*** `Priya Sharma (testing)`
  - **Phone** `+919876543210` · **Email** `priya@example.com`
  - **Source** choose `Referral` · **Event type** `Wedding`
  - **Event date** `2026-12-15` · **Budget (₹)** `800000` · **Guest count** `300`
  - **Notes** `Blush & gold theme, outdoor mandap`
- Save. The card appears in the **NEW** column.

## 2. Qualify → Convert to an event
- Drag the card from **NEW** to **QUALIFIED** (or **DISCOVERY**).
- On the card, click **Convert →**. This creates the event and opens the **Event Workspace**. (A snapshot is also written to **CRM archive**.)

> From here you're in the **Event Workspace** (`event.html`) — the hub. Each card below is on that page. Set the **📅 Event date** at the top if it's blank: `2026-12-15`.

## 3. Discovery — Workspace → **Discovery & requirements** → **Open discovery**
- **Meeting date** `2026-10-01` · **Mode** `In person` · **Location / meeting link** `Client home, Jubilee Hills` · **Who attended** `Bride, groom, parents`
- **Budget — min (₹)** `700000` · **Budget — max (₹)** `900000` · **Notes** `Blush & gold; 300 guests; outdoor mandap`
- **Save discovery**.
- Add requirements (each = fill row → **＋ Add**):
  - **Service** `Full décor & mandap` · **Priority** `Must-have` · **Qty** `1`
  - **Service** `Catering (veg)` · **Priority** `Must-have` · **Qty** `300`
  - **Service** `Photo booth` · **Priority** `Nice-to-have` · **Qty** `1`

## 4. Proposal & mood-board — Workspace → **Proposal & mood-board** → **Open proposal**
- **Concept / summary** `Timeless blush & gold garden wedding`
- **Theme** `Garden Elegance`
- **Colour palette** → **＋ Add colour** → set swatches (e.g. `#f7d7d0`, `#e8c07d`, `#ffffff`)
- **Reference images** → **＋ Add image** → paste a URL `https://picsum.photos/seed/mandap/600/400`
- **Scope — what's included** → **＋ Add item**: `Décor & mandap`, `Catering 300`, `Photo & video`
- **Save proposal** → **Publish** (creates a client link — **Copy** it to share; no login needed for the client).
- Feasibility risks: **Title** `Outdoor rain risk` · **Severity** `high` · **Mitigation** `Tent backup on standby`.

## 5. Quote & pricing — Workspace → **Quote & pricing** → **Open quotes**
- In Quotes, add/adjust the version pricing (line items, margin) and set the **total** (e.g. `800000`).
- **Confirm** the quote to lock the commercial scope. (Back on the Workspace the Quote card shows `CONFIRMED`.)

## 6. Floor layout (optional) — Workspace → **Floor layout** → **Open builder**
- Design the 2D/3D plan (drag tables/stage). Save. *(Don't worry about 3D internals — just save a layout.)*

## 7. Client approval — Workspace → **Client approval**
- Either send the approval link (client enters OTP + consents + pays) — for a test, the dev OTP is `123456` — **or** as staff record it via **Manage in Quotes / Mark paid**. The card should read **Status: approved** (or **paid**).

---

## 8. Resource plan (in-house first) — Workspace → **Resource plan** → **Open resource plan**
- Add needs (each → **＋ Add**):
  - **Type** `Staff / skill` · **What's needed** `Lead photographer` · **Skill / role** `photography` · **Qty** `1`
  - **Type** `Inventory item` · **Item** `Round Tables (testing)` · **Qty** `40`
  - **Type** `Other` · **What's needed** `Fireworks display` · **Qty** `1`
- The app auto-checks in-house and flags **gaps** (photography is covered by Ravi; 40 tables vs 30 owned = a gap; fireworks = a gap → outsource).
- **Reserve stock**: Workspace → **Inventory & resources** → **Reserve stock** → **Item** `Chiavari Chairs (testing)` · **Quantity** `150` · **Note** `Ceremony + reception` → **Reserve**. (If you over-reserve past what's free, it warns you.)
- **Book a partner** for each gap: on Resource plan click **＋ Book a partner**:
  - **Partner** `Spotlight AV Rentals (testing)` · **Covers need** `Round tables` · **Cost (₹)** `45000` · **Advance (₹)** `15000` · **Status** `Confirmed` · tick contract.
  - Add another for `DJ Rhythm (testing)` (Cost `60000`, Advance `20000`, Confirmed). Booking a gap marks that need **outsourced**.

## 9. Check the calendar — Dashboard → **📅 Calendar**
- See every event's staff/stock/partners by date and any **conflicts** (over-booked stock or a vendor booked twice on one date). Fix by re-assigning if flagged.

## 10. Plan the day

### 10a. Run-sheet — Workspace → **Run-sheet** → **Open run-sheet** (each → **＋ Add**)
- **Start time** `16:00` · **Mins** `60` · **Activity** `Vendor load-in & setup` · **Owner** `Ops` · **Location** `Main lawn`
- **Start time** `19:00` · **Mins** `90` · **Activity** `Ceremony (pheras)` · **Owner** `Priest` · **Location** `Mandap`
- **Start time** `21:00` · **Mins** `120` · **Activity** `Dinner & DJ` · **Owner** `DJ Rhythm` · **Location** `Reception`

### 10b. Venue & menu — Workspace → **Venue & menu** → **Open details**
- **Venue name** `Falaknuma Garden Lawns` · **Venue contact** `Mr. Rao / +914066298585` · **Address** `Engine Bowli, Hyderabad` · **Access / load-in notes** `Service gate B; load-in from 3pm` → **Save venue**.
- **Package** `Platinum Wedding — 300 pax` · **Menu / service details** `Welcome drinks, 8 starters, 12 mains, live counters, dessert bar` → then **🔒 Lock** it.

### 10c. Budget & margin — Workspace → **Budget & margin** → **Open budget**
- Click **↧ Import vendor bookings** (pulls the partner costs in as cost lines).
- Add internal cost lines (**＋ Add**): **Description** `In-house staff wages` · **Type** `Internal` · **Estimated ₹** `80000` · **Actual ₹** `82000`. Add `Transport & fuel` (`30000` / `28000`).
- Change order: **＋ New change** → **Title** `Add photo booth` · **Detail** `Client added on discovery` · **Charge client ₹** `40000` · **Extra cost ₹** `15000` → save → **Approve**. Revenue and cost both update; the tiles show **margin %**.

### 10d. Logistics & payments — Workspace → **Logistics & payments** → **Open logistics** (tabs across the top)
- **👥 Guests** tab: **Group** `Bride's family` · **Headcount** `120` → **＋ Add**. Add `Groom's family` `100`, `Friends & VIPs` `80`.
- **🚚 Logistics** tab: **Item** `Confirm generator backup` · **Owner** `Ops` · **Due** `2026-12-13` → **＋ Add**. *(Tip: use **Apply a template** → pick `Outdoor wedding — logistics` → **Apply** to drop in the whole checklist at once.)*
- **📋 Permits** tab: **Item** `Fire NOC for fireworks` · **Owner** `Admin` → **＋ Add**.
- **📣 Comms** tab: **Item** `Share run-sheet with crew` · **Owner** `PM` → **＋ Add**.
- **💳 Payments** tab: **Milestone** `50% advance` · **Due date** `2026-10-05` · **Amount ₹** `400000` → **＋ Add**. Add `Balance` / `2026-12-10` / `440000`. Mark the advance **paid** when received.

### 10e. Readiness gate — Workspace → **Readiness gate** → **Open readiness**
- Review the checklist. Use the **Mark done** buttons for **Dry run** and **Team briefed**.
- When every critical check is green, click **Mark Event Ready →**.

---

## 11. Event day — Workspace → **Event-day command** → **Open command**
- **👥 Arrivals & attendance**: click **↧ Pull team & vendors** to build the roster from your crew + confirmed vendors → tap **Arrived** / **Left** / **No-show** as people show up.
- **🔧 Setup & technical checks**: add checks (**＋**) like `Stage & mandap setup`, `Sound check` → tap **Done** or **Issue**.
- **👥 Guest reception**: click **↧ Pull from guest list** (imports the groups from Logistics), then **＋ In** / **–** to count guests in. Or add a group inline (**Group name** `Walk-ins` · **Exp.** `20`).
- **📦 Live stock requests**: pick an item from the dropdown *or* type one (**or type an item…** `Extra extension cords`), **Qty** `3` → **＋** → tap **Issued** / **Replaced**.
- **🎫 Issues** (top link, or Workspace → Issues & incidents): **Issues** tab → **Issue** `Late floral delivery` · **Severity** `Medium` · **Owner** `Ops` → **＋ Log** → **Resolve** when fixed. Use the **Incidents** tab for safety incidents.
- Billable change during the event? Go to **Budget → ＋ New change** (as in 10c) and **Approve**.

---

## 12. Teardown & returns — Workspace → **Teardown & returns** → **Open teardown**
- **📦 In-house inventory returns**: for each reserved item click **Return** (enter any **damaged/lost** qty — it comes off your stock).
- **🤝 Vendor & rental exit**: click **Mark returned/exited** for each partner.
- **✅ Teardown & venue handover**: **＋ Add** items like `Venue walkthrough with manager`, tick them off.

## 13. Settlement & billing — Workspace → **Settlement & billing** → **Open settlement**
- **💳 Client invoice**: check the balance; use **Record a payment received** → enter the amount → the balance drops.
- **🤝 Vendor settlement**: click **Settle** on each partner as you pay them.
- **🧾 Staff expense claims**: **Who** `Ravi Kumar` · **For** `Fuel + toll` · **Amount ₹** `5000` → **＋ Add** → **Approve** → **Mark paid**.
- **↩ Refunds & recovery**: **Type** `Recover from client` · **Reason** `Broken chairs` · **Amount ₹** `2000` → **＋ Add** → **Approve** → **Mark done**. (Use `Refund to client` for money back, `Deduction from deposit` for deposit deductions.)

## 14. Closure, P&L, feedback — Workspace → **Closure & P&L** → **Open closure**
- **📊 Profit & loss**: read revenue − cost − expenses = **profit** with margin %.
- **⭐ Client feedback & testimonial**: set **Client rating** (click the stars, e.g. 5) · **Feedback** `Flawless, guests loved the décor` · **Testimonial (quotable)** `Blueprint Stage made our wedding stress-free!` · tick the marketing-consent box · **Lessons learned (internal)** `Order flowers a day early` → **Save**.
- **🤝 Rate vendors & staff**: **Type** `Vendor` · **Name** `Spotlight AV Rentals (testing)` · **Stars** `5` → **＋ Rate**. Repeat for staff.
- **🗄 Close & archive**: click **Mark event closed & archived** (moves the event to **Closed**). Optionally **＋ Add CRM follow-up lead**.

## 15. Media & gallery — Workspace → **Media & gallery** → **Open media**
- **Type** `Photo` · **Link (URL)** `https://picsum.photos/seed/wed1/800/600` · **Caption** `Mandap wide` → **＋ Add**.
- Add a `Video` with a YouTube link. Tick **gallery** on the ones the client should see, then flip **Client gallery preview** to see exactly their set.

## 16. Repeat business — Dashboard → **🌱 Nurture**
- **Name** `Priya Sharma (testing)` · **Phone** `+919876543210` · **Occasion** `1st Anniversary` · **Occasion date** `2027-12-15` · **Next follow-up** `2027-11-15` → **＋ Add**.
- When the date arrives it shows a red **Due** flag. Click **Followed up** to push it a year out, or **→ Lead** to drop them back into the pipeline for a new event.

---

### Who sees what (role reminder)
- **admin / planner** — everything · **sales** — leads/CRM/discovery/proposal/quote/**finances** · **operations** — resources/day-of/logistics, **no finances** · **crew** — only their tasks (`work.html`) · **client** — only the proposal/approval link.
