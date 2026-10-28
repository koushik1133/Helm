# Payment schedules

Helm splits what the client pays into a few payments (for example 30% now, 50% before the event, 20% on the day), reminds the client before each one is due, and marks each payment as paid when the money comes in.

## What happens on its own
- **When the client approves a quote**, Helm adds your default payment schedule to the event. It only does this when the event has no payments planned yet. A schedule that is already there is never changed.
- The amounts come from the quote total, including GST and any approved change orders. They are rounded to whole rupees, and the last payment takes the small difference so the schedule always adds up to the total.
- **Reminders to the client** (off until you switch on "Payment reminders" in Settings > Automations): 3 days before the due date, on the due date, and 3 days after if it is still unpaid. Each reminder includes your UPI ID, your payment note and the online payment link, if one is open.
- **When a payment is overdue** (once "Overdue payment alert" is switched on in Automations), the team gets one bell notice ("Client payment overdue"). Admins and roles that can see Finance get it.
- **When you record a payment**, every planned payment it fully covers is marked Paid. A part payment shows as "Part paid" with the amount still left.

## Set it up (Settings > Payment schedules)
1. Pick the **Default schedule**. Built in: 30 / 50 / 20 (the default), 50 / 50, and 100% upfront.
2. To make your own, click **+ New schedule**. Add 1 to 10 payments. Each payment has a name, an amount (a % of the total, a fixed amount, or "Balance" = whatever is left) and a due date (days after approval, or days before / after the event). An example on ₹1,00,000 shows as you type. Click **Add schedule**.
3. Enter your **UPI ID** and a short **payment note** (for example bank details). Clients see these on their page and in reminders.
4. **Payment schedule on approval** (on) and **Overdue payment alert** (off) are switched in Settings > Automations.
5. Click **Save payment settings**.
- You change reminder timing and wording in **Reminders & client messages**.
- Archiving a schedule hides it. Events that already use it keep their payments.

## On an event
- The **Payment schedule** card shows on the quote's payment step, the event workspace and Budget. Each payment shows as Paid, Part paid, Due or Overdue, with Total / Paid / Outstanding.
- If an event has no schedule, pick a template, check the preview and click **Add this schedule**.
- **Pause automatic reminders for this event** stops automatic reminders for that one event. "Send reminder now" in Logistics > Payments still works.
- To change or remove a payment, go to **Logistics > Payments**.

## The client's page
The client sees "Payment schedule" with each payment marked paid, part paid, due or overdue, plus a "How to pay" box with your UPI ID, note and online link.

## Who can do what
- Change Settings and schedules: admins, or roles that can edit Settings.
- See an event's schedule: roles with Finance view. Add a schedule: Finance edit. Pause reminders: Finance or Quotes edit.
- Messages to clients are only queued. Nothing is sent until the studio's e-mail / WhatsApp sending is switched on. Free-trial studios never send them.
