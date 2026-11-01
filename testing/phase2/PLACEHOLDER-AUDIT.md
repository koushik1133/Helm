# R115 placeholder audit (app pages)

Scope: every `placeholder=` / `.placeholder =` in `public/*.html` and `public/*.js` app pages (349 found), plus
empty-state texts (`class="empty"`) and date-format hints. Marketing / legal pages (index, pricing, about, terms,
privacy, demo, manual, ...) were left out. Phone fields marked `data-phone` get their placeholder from
`phone-input.js` (a digit-free mask per country), so their `+91…` HTML placeholder is only a no-JS fallback.

What was checked: misleading text, placeholder used as the only label, date format (house format dd/mm/yyyy),
currency hints (₹ for India, the studio currency otherwise), typos, `undefined` / `null` / `NaN` leaks, text cut off
by the box width, leftover dev text (TODO, lorem, test).

Results in short:
- No `undefined` / `null` / `NaN`, TODO, lorem or "test" text in any placeholder or empty state.
- Dates: the only date hint is `dd/mm/yyyy` (quote-validity.js:252). Every `YYYY-MM-DD` / `mm/dd/yyyy` hit is a code
  comment, never shown to users. Date boxes are native `type="date"` (the browser's own format).
- Empty states read well ("No tasks yet.", "Nothing is out right now."); nothing to change.

## Fixed in this PR (text only / tiny JS)

| Page | Field | Issue | Fix | file:line |
|---|---|---|---|---|
| Closure (ratings) | Name | lowercase one-word "who" | "Vendor or staff name" | public/closure.html:120 |
| Issues | Issue | lowercase "what's happening" (reads as a label) | "e.g. Generator not delivered" | public/issues.html:105 |
| Issues | Owner | lowercase "who's on it" | "Who is handling it" | public/issues.html:107 |
| Logistics checklist | Item | lowercase "what needs doing" | "e.g. Confirm generator backup" | public/logistics.html:169 |
| Inventory check-in | Your name | "who checked it" under a "Your name" label (contradicts it) | "e.g. Ravi" | public/inventory.html:253 |
| Settlement | Payment amount | lowercase "amount" | "Amount" | public/settlement.html:112 |
| Settlement expenses | Who | lowercase "name" | "e.g. Ravi (driver)" | public/settlement.html:135 |
| Plan (menu) | Dish quantity | lowercase "qty" | "Qty" | public/plan.html:276 |
| Discovery requirements | Qty | cryptic "#" | "e.g. 2" | public/discovery.html:111 |
| Discovery requirements | Note | lowercase "detail (optional)" | "Detail (optional)" | public/discovery.html:112 |
| Command (guest groups) | Expected headcount | cryptic abbreviation "Exp." (no visible label) | "Guests" (fits the 80px box) | public/command.html:135 |
| Nurture | Email | "for greetings" read as the value, not a hint | "name@email.com" (same as other email boxes) | public/nurture.html:116 |
| HQ referrals | Partner's Helm studio ID | dev-style ASCII arrow "from HQ -> Studios" | "Copy it from HQ → Studios" | public/hq-referrals.html:136 |
| Flow (payment) | Receipt no. | terse "Blank = automatic" | "Leave blank to auto-number" | public/flow.html:355 |
| Builder (item model) | 3D model link | lowercase dev text "paste a GLB from Sloyd / Meshy / Tripo…" | "Paste a .glb link (Sloyd, Meshy, Tripo…)" | public/builder.js:1806 |
| Resources (vendor booking) | For | lowercase "what this vendor brings" | "e.g. Sound & lighting" | public/resources.html:146 |
| Budget, Flow, Inventory, Media, Resources, Vendors, Control (team profile) | Optional fields (Detail, Coupon code, Note(s), Caption, Qty, Cost, Advance, Day rate) | "optional" lowercase while the rest of the app writes "Optional" | "Optional" | public/budget.html:141, public/flow.html:293, public/inventory.html:130/177/220, public/media.html:93, public/resources.html:149/171/172/178, public/vendors.html:146, public/control.html:905 |
| Control Center (pricing) | Price / chair, Price / plate | hard-coded "(₹)" for every studio (AED studios saw ₹) | placeholder follows the studio currency (`curPh()`), ₹ for India | public/control.html:589, :599, :1397 |
| Leads | Budget label | hard-coded "Budget (₹)" | `<span class="cur-sym">` filled with the studio currency when the form opens | public/leads.html:202, :615 |

## Needs an owner decision (not changed)

| Page | Field | Issue | Suggested fix | file:line |
|---|---|---|---|---|
| Control Center (chairs, plates, dishes, coupons, custom fields) | Inline "add" rows | Placeholder is the only visible label ("Chair type e.g. Chiavari", "Price / chair", "Code e.g. DIWALI10", "Value", "Dish name"); it disappears once you type. `aria-label` exists, so screen readers are fine. | Add small visible labels above the add-row boxes (layout change) | public/control.html:559-611 |
| Operations (crew) | Name / Phone add row | Same: placeholder-only label | Visible labels or keep as is (compact row) | public/ops.html:158-159 |
| Command (guest groups) | Group name / Guests add row | Same: placeholder-only label | Visible labels or keep as is | public/command.html:135 |
| Control Center (team profile) | Day rate label | "Day rate per event day (₹)" hard-coded | Follow studio currency like chairs/plates | public/control.html:905 |
| Budget (change request) | Charge client label | "Charge client ₹ before tax" hard-coded | Follow the event's quote currency | public/budget.html:143 |
| Discovery | Budget label | "Budget (₹)" hard-coded; should follow the event's quote currency (flow.html already does this with `.cur-sym`) | Reuse flow's `syncCurLabels` approach | public/discovery.html:98 |
| Resources (vendor booking) | Cost / Advance / Agreed amount labels | "(₹)" hard-coded | Follow the event's quote currency | public/resources.html:163, :171, :172 |
| Flow (discovery budget) | Budget placeholder | "e.g. 5,00,000 or 2 crore" is India-only wording for a UAE quote | Swap to "e.g. 50,000" for non-India quotes | public/flow.html:181 |
| Discovery | Budget placeholder while amounts are hidden | An EMPTY budget shows "••••" (an earlier choice, so it reads like the other hidden amounts) - but it can suggest a value exists | Keep, or show "Hidden" / "Not set yet" | public/discovery.html:219 |
| Control Center (WhatsApp) | Number | "e.g. 98XXXXXXXX" is India-only | Use the phone-input mask like other phone boxes | public/control.html:873 |
| Builder / Capture / Try (layout wizard) | Bars, trucks, booths, rest, exits | Placeholder "0" / "2" looks like a filled value | Use "e.g. 2" or real default values | public/builder.html:372-376 (same in capture.html, try.html) |
| Budget plan | Cost line boxes | Placeholder "0" / "—" looks like a value | "e.g. 25000" / "Optional" | public/budget-plan.js:242-245 |
