# See when your client opens their link

Helm shows you when a client opens the private link you sent them: the client page (proposal), the quotation, the booklet, and the moment they start approving.

## Where you see it

- **Quotes list**: under the event name, a small chip like **"👁 Viewed 3× · last 2h ago"**. It turns orange with **"not approved"** when the client has looked but not approved for a while.
- **Event workspace**: the same chip next to the status at the top.
- **Quote flow, step 9 (Share with client & approval)**: the chip plus one line ("First opened 17/10/2026, 4:05 pm · last looked at: quotation"). Before the first open it says "Not opened yet".
- **Bell 🔔**: "Rahul opened the proposal" the first time the client opens any page.

Click the chip to open the **timeline**: each visit with the date and time, the device (Mobile / Tablet / Desktop, Android / iOS, browser) and the pages opened, for example "Proposal → Quotation → Started approving". Pages opened on one device within 30 minutes count as one visit.

## What is never counted

- You and your team, when you are signed in to Helm.
- The **Preview** buttons (approval link and booklet), even in a private window.
- Link previews made by WhatsApp, e-mail apps and search engines.

## "Viewed but not approved"

If the client opened their link **2 days ago** (you can change this) and still hasn't approved:

1. The quote's owner (the event manager, otherwise the person who made the quote) and the admins get a bell reminder.
2. The quote shows in the **⚠ Attention** tab on Quotes and under **Needs attention** on the dashboard.
3. Open it and tap **Send a nudge by e-mail** (or **Nudge on WhatsApp**). Helm sends your studio's own follow-up message to the client's e-mail / WhatsApp saved on the event. Or tap **Dismiss** if you have already spoken to them.

Notes:
- A nudge is queued and goes out with Helm's scheduled messages. In a free trial or on a demo event it is recorded but not sent.
- WhatsApp needs the client's mobile number, their WhatsApp opt-in, and your studio's WhatsApp number (Settings → Notifications).
- Up to 3 nudges per client per day. A new reminder only comes after the client opens the link again.
- When the client approves, the reminder disappears by itself.

## Who can do what

| | See views and the timeline | Send a nudge / Dismiss | See the client's IP address | Change the settings |
|---|---|---|---|---|
| Admin | ✓ | ✓ | ✓ | ✓ |
| Roles with Quotes **view** | ✓ | – | – | – |
| Roles with Quotes **edit** | ✓ | ✓ | – | – |
| Roles with Settings **edit** | – | – | – | ✓ |

## Settings (Settings → 🔔 Notifications → "Client link views")

- **Track when clients open their links**: on by default.
- **Bell notification the first time**: on by default.
- **Also notify on later visits**: off by default; at most once every 12 hours (1 to 168).
- **"Viewed but not approved" reminder**: off until you switch it on in Settings > Automations; after 2 days (1 to 30).
- **Automatic nudge to the client**: this is the existing **Client follow-ups** switch in "Automatic client messages" just below. It is **off** by default.
