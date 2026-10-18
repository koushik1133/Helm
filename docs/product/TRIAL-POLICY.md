# Helm free trial: what happens, day by day

This page describes, in plain English, how a Helm free trial works and what happens when it ends.
It matches the database rules in migrations 0116, 0119, 0120, 0126 and 0183.

## Starting a trial

- Anyone can start a free 8-day trial. No card is needed.
- Every trial is its own separate studio ("Demo 1", "Demo 2", ... or the name the person chooses).
  Nothing is shared between trial studios, and trial studios never touch real (paying) studios.
- In "explore with sample data" mode the studio starts with sample inventory, vendors, staff,
  menus and events, all clearly marked "Demo ·". In "my own studio" mode it starts empty.

## During the trial (days 1 to 8)

- Everything in Helm is open: quotes, events, payments, staff, inventory, vendors.
- **The owner can add real staff.** On the Staff page, invite your team the same way a paid studio
  does. The Staff page shows: "Trial: when the trial ends on <date>, your staff keep read-only access
  until you upgrade."
- Reminders are shown to the owner on day 5 (3 days left), day 7 (ends tomorrow) and day 8
  (ends today), plus a strip at the top of every page with the days left.

## When the trial ends without payment

The trial ends after 8 days, or later if Helm approved an extension. From that moment the studio is
**read-only for everyone in it** (0183). Whether a studio is "in trial" is decided by its subscription
(status trial, or a trial that lapsed without any payment), so a studio that has paid is never affected.

- **The owner** signs in and lands in the studio as usual. Everything can be viewed, but nothing can
  be created, changed or deleted. A banner at the top of every page says:
  "Your trial has ended. Your data is preserved and available in read-only mode. Upgrade now to
  continue creating and editing records." with an **Upgrade** button.
- **Invited staff keep read-only access.** They sign in, land in the studio and see the same banner
  (without the button: only a studio admin can upgrade). Nobody can add, edit or delete anything until
  the studio is upgraded. Their accounts and roles are kept exactly as they were.
- Edit buttons (New, Save, Delete and similar) are hidden or disabled in the app, and the database
  refuses any change that is still attempted, with the same message.
- Still allowed while read-only: billing details and the Terms (to upgrade), the notification bell,
  marking chat as read, and each person's own profile and personal settings.
- **No data is ever deleted automatically.** Events, quotes, clients, payments, staff records and
  everything else stay exactly as they were, for as long as the studio exists.

## When the owner pays

- Paying at any time, even weeks later, unlocks everything **instantly**:
  the studio becomes editable again for the owner and every staff member automatically.
  Nobody needs to be re-invited.
- If the studio was using sample data, the owner can remove all "Demo ·" records with
  "Start my own studio" and continue with an empty studio. Anything they renamed or created
  themselves is kept.
- Helm HQ can also extend a trial; the studio is editable again until the new end date.

## In short

| | During trial | Trial ended, not paid | After paying |
|---|---|---|---|
| Owner | Full access | Read-only, "Your trial has ended" banner + Upgrade | Full access |
| Invited staff | Full access (per their role) | Read-only (same banner) | Full access again automatically |
| Data | Kept | Kept, never auto-deleted | Kept |
