---
id: closing-event
nav: Closing an event
order: 60
areas: closure, settlement, finance
---
# Closing an event: summary, "Before you close" and close-anyway approval

Open **Closure & P&L** on the event page (or the Closure page). This is where an event ends.

## Closure summary
At the top, **📈 Closure summary** shows how the event went:
- **Profit** and margin % - revenue without GST minus all costs, **including staff & crew wages**;
- **Estimate vs actual** - how much of the cost is backed by real bills, attendance or receipts;
- **Top cost categories**, **Staff & vendor costs**, **Collected** (% of the invoice) and what is still outstanding;
- **Vendors & crew** (booked / arrived), **Equipment** (how many items are back) and **Tasks** (done / open, issues).

Roles without money access see the same page without amounts. The eye in the top bar (hide amounts) works here too.

## Before you close
Helm checks these points for you. Each line is **OK**, a **Warning** or **Blocking**, and a failing line has a link to fix it (for example **Open Settlement** or **Open Inventory**).

| Check | If it fails |
| --- | --- |
| Event day is over | Can't close before the event day - nobody can override |
| Booking confirmed and priced | Only an admin can approve closing |
| Client balance is 0 | Only an admin can approve closing |
| All equipment returned | Admin only if items are still checked out; missing / written-off items are a warning |
| No expense claims waiting | An approver can approve |
| No refunds waiting | An approver can approve |
| Vendor bills recorded | An approver can approve |
| Crew attendance confirmed | An approver can approve |
| Vendors paid | Warning only - you can pay them after closing |

## Close the event
- If everything is OK, press **Mark event closed & archived**.
- If something is still open, the button says **Request to close anyway…**:
1. Press **Request to close anyway…**.
2. Write why the event should close anyway (at least 10 letters) - for example "Client paying the last instalment by bank on Monday". Your name is saved with it.
3. Press **Request to close anyway**. The button now says **Close requested - waiting for approval**.
4. Everyone who can approve gets a bell notification, an e-mail and a message in the event's team chat.

## Approving or declining (approvers)
1. Open the event's Closure page. The card **Close requested by … - waiting for approval** shows the reason and what was open.
2. Press **Approve & close** - the event closes and the card says who approved it - or **Decline…** and write why. The person who asked is told by bell, chat and e-mail.
3. The person who asked can **Withdraw my request** while it is waiting.

Requests are never deleted - they stay on the event as a record.

## Who can do what
| Action | Who |
| --- | --- |
| See the summary and the checklist | Roles that can view **Closure & P&L** (money only with **Budget & finance**) |
| Close the event / ask to close anyway | Roles that can edit **Closure & P&L** (one open request per event) |
| Approve or decline a request | Admin, or a coordinator / manager with Closure edit - never your own request (unless you are the admin) |
| Approve admin-only checks | Admin only |
