# Automations: run-sheet reminders, one Automations page, leads tracked automatically (R24)

## 1. Run-sheet reminders

**What it does.** The person who owns a run-sheet line is reminded before the line starts.

**How to set it up on a line**
1. Open the event's **Run-sheet**.
2. In **Owner**, pick a person:
   - **Team**: someone with a Helm login.
   - **Staff**: someone from your Staff list.
   - **Vendors**: a vendor.
   - **Someone else (type a name)**: type any name. This works as before.
3. Once an owner is picked, **🔔 Remind the owner** is ticked. Keep the studio default time, or choose 5 / 10 / 15 / 30 minutes, 1 or 2 hours before, or "At the start time". Untick it if this line needs no reminder.
4. Tick **Also post the reminder in the event group** if the whole team should see it in the event's chat.
5. Save. The line now shows a small bell with when the reminder goes and who gets it, for example *🔔 15 min before + at the start → Ravi (bell, e-mail)*.

**Who gets what**
| Owner | How they are reminded |
|---|---|
| Team member (has a login) | Bell in Helm, plus e-mail |
| Staff member | WhatsApp with their task link, plus e-mail if they have one (and the bell if they have a login) |
| Vendor | WhatsApp, plus e-mail if they have one |
| Typed name | Only when the name matches one staff member or team member exactly. Otherwise only the event group post, if ticked |

**Things to know**
- A line needs a **start time**, and the event needs a **date**. Otherwise the bell says "Add a start time".
- Each reminder is sent once only and is never late. If Helm misses the time by more than 20 minutes, it skips that reminder.
- Cancelled, closed and sample events are never reminded.
- **Free trial:** reminders go to the bell and the event group only. No e-mail or WhatsApp is sent.
- E-mail and WhatsApp wait in a queue until sending is switched on for your studio.

**Who can do what:** anyone with **Run-sheet edit** can set owners and reminders. The default times are set in Control Center (see below).

## 2. Control Center → Automations

One page lists everything Helm does by itself. Each row shows what it does, where it acts, and whether it is **On** or **Off**, with a **Settings** button for the details:

- Event reminders (always on; the number of days is under Reminders & client messages)
- Delivery & arrival reminders
- Run-sheet reminders
- Payment reminders and client follow-ups (if you switch one on before choosing how to send it, Helm uses e-mail)
- Overdue payment alert, Viewed but not approved, Quote expiry and E-mail digests. These show "Not set up yet" until that update is installed.
- Low stock warnings
- Enquiry form → Leads
- Quotes → Leads (always on)

The same page also has two settings cards:
- **Run-sheet reminders**: on / off, the default reminder times (up to 4; the default is 15 minutes before plus at the start), and e-mail / WhatsApp on or off.
- **Enquiry form**: see below.

**Who can do what:** anyone with Control Center view can see this page. Only people with **Control Center edit** (admins) can change it. Every change is saved in the Audit log.

## 3. Leads tracked automatically

- **From quotes:** every quote with a client name already becomes a lead (source "Quote"). The lead moves along with the quote. Nothing new to do.
- **From your public enquiry form (new):**
  1. Go to Control Center → Automations → **Enquiry form**.
  2. Tick **Open my public enquiry form** and press **Save**.
  3. Copy your link, which looks like `helm.events/<your-studio>/enquiry`. Put it on your website, Instagram bio or WhatsApp.
  4. The client fills in their name, phone or e-mail, type of event, date, guests and a message, and ticks that you may contact them.
  5. A new lead appears in **Leads** under New, with source "Enquiry form". You also get a bell notice saying "New enquiry from …".
  6. If you leave **Send an instant thank-you e-mail** ticked, the client gets your thank-you note. You can write it yourself using {name} {studio} {event}. It is sent once e-mail is switched on for your studio. Free trials do not send it.
- On the Leads page, admins also see a **🔗 Enquiry form** button that opens these settings.

**Safety:** the form shows only your studio name. It never shows other data. Limits are 5 enquiries an hour from one network, 30 an hour per studio and 3 a day from the same phone or e-mail. Bots are caught by a hidden field. The form is **off** until you switch it on.

**Not included:** the Helm website's own contact form and "Contact sales" are for Helm itself, so they do not create studio leads.
