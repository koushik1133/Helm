# Quote validity ("Valid until")

Every new quote has a **Valid until** date. It tells your client how long the price holds, reminds them before it
ends, and stops an old price from being approved by mistake.

## What your client sees
- On their quote (approval page) and their event booklet: **"This quote is valid until 03/11/2026."** In the last
  3 days it also says how many days are left.
- After that date: **"This quote has expired - ask <your studio> for an updated one."** The Approve steps are
  replaced by a **Request a new quote** button. Pressing it puts a note in your bell (once a day at most).
- Once they have approved, or the quote is cancelled, nothing about validity is shown any more.

## What your team sees
- **Quote flow, step 9 (Share with client & approval)** and the **event workspace**: "Valid until 03/11/2026 ·
  Expires in 14 days".
  - **Extend +14 days** - one click. It adds the studio's default number of days (from today if the quote has
    already expired).
  - **Change date** - pick any date from today up to one year ahead (only if your studio allows custom dates;
    admins always can).
  - **History** - every change, who made it and when.
- **Quotes list**: a small pill - grey "Expires in 10 days", amber "Expires in 2 days", red "Expired yesterday".
  The **Attention** tab also lists quotes that expire soon or have just expired.
- **Bell**: "Quote A-1234 expires in 3 days" (and 1 day), "Quote A-1234 expired - extend it or send an updated
  quote", and "The client asked for an updated quote". Only people who can see quotes get these.

## When the date is set
- A new quote gets today + the default (14 days).
- When you send the approval link for the first time, an automatic date is counted again from that day, so the
  client always gets the full time. A date someone picked by hand is never moved.
- Quotes made **before** this feature have no date and never expire. An admin can give them one (see below).

## Control Center -> Client links & packages -> Quote validity
Who can change it: studio admins, or anyone whose role can edit Control Center.
- **Give new quotes a valid-until date** (on by default). Off = no dates anywhere, nothing expires or locks.
- **Quotes are valid for (days)**: 1 to 365 (default 14).
- **Remind before it ends (days)**: e.g. "3, 1" (default). 0 means on the last day. Up to 5 values.
- **An expired quote can't be approved by the client** (on by default). The server refuses the approval even if
  someone keeps an old page open.
- **Staff may pick a custom date on a quote** (on by default). Off = only admins pick dates; everyone who can
  edit quotes can still press Extend.
- **Remind the studio in the bell** (on) and **E-mail the client a reminder** (on). Client e-mails are only sent
  once client e-mail is switched on for Helm; until then they wait in the queue. Free-trial and demo studios
  never e-mail clients.
- **Apply to open quotes...** (admins only): gives every open, never-approved quote that has no date (and whose
  event is not in the past) today + the default. It shows how many quotes first and asks before changing
  anything. Quotes that already have a date are never changed.

## Who can do what
| Action | Who |
| --- | --- |
| See the date, pill and bell notes | Anyone who can view quotes |
| Extend +default days | Anyone who can edit quotes |
| Pick a custom date | Anyone who can edit quotes, when the studio allows it; admins always |
| Change the studio settings | Admins / roles that can edit Control Center |
| Apply to open quotes | Admins only |
| Request a new quote | The client, from their link, after the quote expired |
