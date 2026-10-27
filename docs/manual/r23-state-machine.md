# Event stages and stage history

Every quote / event in Helm now has **one stage**, shown as the same coloured pill everywhere, and Helm keeps a
**history of every stage change**: who made it, when, how and why.

## The stages

| Stage | What it means |
|---|---|
| Lead | An enquiry, nothing priced or sent yet |
| Draft | Being priced. Locked but not sent also counts as Draft |
| Sent | The approval link is with the client (or the price changed and the client must approve again) |
| Viewed by client | The client opened the approval link |
| Expired | The approval link ran out before the client approved |
| Lost | Archived or deleted before the client approved |
| Approved | The client approved. The advance is still pending |
| Advance paid | The advance came in before the event was confirmed |
| Confirmed | Booked: approved and the advance is in, or the studio confirmed it without online approval |
| In progress | Planning, resources and ready |
| Event day | The day of the event |
| Completed | The event is over and money is being settled |
| Closed | Settled and closed |
| Cancelled | The event will not happen |

You don't set these stages yourself. Helm works them out from what already happens: sending the link, the client
opening and approving it, recording a payment, moving the event's stage strip, closing, re-opening or cancelling.

## Stage history (event page and quote flow)

1. Open an event (or its quote flow).
2. The **Stage history** card shows the current stage and the date since then.
3. Under it is every move, newest first. For example: *Moved to Approved by the client · 20/10/2026, 14:05*.
   If a reason was given (cancelling, an admin override, re-opening), it shows under the move.
4. **Show all** opens the older moves.

Anyone who can see the studio's quotes can see the history. Client links never show it.

## Out-of-order moves

Helm has a list of the usual moves (for example Sent → Approved, or Closed → Completed when an event is re-opened).
A move outside that list is marked **Out of the usual order**.

- **Warn (default):** the move goes through as before and is logged.
- **Enforce:** a team member's out-of-order move is refused with a clear message. Client links, payments and
  automatic jobs are never blocked.

## Settings → Event stages (studio admin only)

- **Stage rules:** Warn (recommended) or Enforce.
- **Show the stage history** on the event page and quote flow: on (default) or off.
- The card also shows how many out-of-order moves were logged in the last 30 days.

Other roles see these settings read-only.
