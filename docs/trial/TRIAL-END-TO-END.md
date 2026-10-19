# Helm free trial, end to end

This is a plain-words brief of the free trial. It covers what a new studio gets, what it can change, and where the limits are. Paid studios are not affected by anything here.

## 1. Signing up
- The person signs up and picks **Start free trial**. `start_self_serve_trial` creates the studio and an 8-day trial (`studio_subscriptions.status = 'trial'`).
- The welcome step (`trial_welcome_setup`) asks for a name, city and phone. Helm then writes the studio details itself. The trial user never has to do studio set-up.
- When the sample template is switched on, the studio gets a copy of the sample studio (migrations 0166-0171). Every copied row is marked as demo data.

## 1a. Trial terms and "I agree" (migration 0207)
- The welcome's first step is **"Your 8-day free trial"**: what is included (the sample counts below), what the studio can do, what is locked and what happens after the trial, with links to Terms (`/terms#trial`) and Privacy (`/privacy`). The owner must tick **"I have read and agree to the free-trial terms, the Terms of Service and the Privacy Policy"**; Continue stays disabled until then.
- `accept_trial_terms(version)` records it in `trial_terms_acceptances` (studio, person, version, time, short user agent). `my_trial_terms_status()` tells the app whether to ask, so another device asks again until it is agreed. Other studio pages send an owner who has not agreed back to the dashboard (`trial-lock.js`).
- A trial that finished the welcome before 0207 gets the same terms once as a window. Invited teammates get a short read-only notice instead ("Got it", no agreement). Paid studios and ended trials are never asked.
- Every number and rule shown comes from `public/trial-facts.js` (also used by the sign-up box). The version there must match `_trial_terms_version()`; a new wording needs a new version.
- Current version: **`trial-2026-10-20`** (migration 0238: quotes and events are capped at 2 new again; 0211 / 0212 had `trial-2026-10-19` with quotes not capped). A trial owner who agreed to an older version is asked once more (the one-time window); the earlier agreements stay on record.

## 2. Sample data the trial starts with
| List | Count |
|---|---|
| Leads (clients) | 16 |
| Events / quotes | 7 (some confirmed, with a simulated advance and balance, reservations and run sheets) |
| Inventory items (the owner's rental price list) | 165 |
| Vendors | 16 |
| Staff | 12 |
| Venues | 4: Grand Convention Centre (Hitec City), Green Meadows Lawn, Royal Banquet Hall, Square Garden Pavilion (Gachibowli) |
| Dishes | 145 |
| Menu packages | 6: Standard, Gold and Premium, each in Veg and Non-veg |
| Coupons | 3 |
| Layout templates | 3 |
| Client requirements | 41 (on the 7 sample events, 0202) |

GST is set to 18% (intra-state). Event dates are relative to the sign-up day, so the calendar always looks current.

## 3. What a trial studio can use
- The dashboard, leads, events and quotes, the layout builder (2D/3D), inventory, vendors, staff, venues, calendar, budget and chat.
- **Pricing & coupons:** fully editable (default pricing, rate cards, capacity limits, object prices).
- **Layout builder prices:** every builder item type starts at the owner's inventory rate (for example LED Wall 5,000, Stage Barrier 1,000, Main Stage 18,000) and the chair rate is 100 (migration 0182). Seats are billed at the chair rate: chairs, chair rows, seating blocks and the seats around round / banquet tables (a round table with 8 seats = 8 x 100). The studio can still change every rate under Pricing.
- **Menus & catalog:** only prices change: a package's price per plate and its dish list, and the chair and plate prices. New dishes, packages, chair types or plate types **cannot be added**, and existing ones cannot be renamed, switched off or removed (the server refuses it, migration 0181). A price change keeps a sample row a sample row, so "Clear demo data" still removes it.
- **Layout rules:** editable.
- **Layout templates:** the builder gallery shows the sample layouts, **Start blank** and **From past events** (never the built-in presets, even when no sample layout is left). Saving, renaming, archiving, duplicating or setting a default template is not part of the trial (0181).
- **Users & invites:** at most **you + 2 people**. Open invitations count toward that number. The server refuses a 3rd person even if the request is sent straight to the API.
- **Roles & access:** editable.
- **Plan & billing:** shown, so the studio can upgrade. The demo-data card (keep or clear the sample data) also sits here. Checkout can save the billing details and accept the Terms during the trial (`my_studio_account_update` is open to the trial admin, migration 0185 section 10); the other studio settings stay fixed.

## 3a. The trial checklist (dashboard "Try Helm in a few steps")
Five steps, each ticking itself: **Explore a sample event** (opening any event page), **Open the 2D/3D layout builder** (opening the builder; the link opens a sample floor plan), **Send a quote to a client** (one of the studio's own quotes is sent - the e-mail really goes out; sample quotes do not count), **Invite a teammate** (an invite or a second member; admins only) and **Choose a plan** (admins only). Teammates without admin or quote access see only the steps they can do. When the trial has ended only "Choose a plan" is shown. Hiding the trial list is saved on the person's account and does not hide the paid checklist after upgrading.

## 4. What is hidden and blocked
"Blocked" means the screen hides the feature, a direct link shows **"Not available in the free trial"**, and the server refuses the request (migration 0173).

| Feature | Screen | Server |
|---|---|---|
| Studio set-up: General, studio account, studio, branding, billing details, client link name | Control Center section hidden; the onboarding page is covered; the dashboard checklist shows only the trial steps (see 3a) | Direct `organizations` edits refused; `my_studio_account_update` and `set_studio_link_name` refused |
| Client links auto-expire and the package flow | Section hidden | `admin_set_link_autoexpire` and `admin_set_link_expiry_shelf` refused |
| Import (Excel/CSV import, custom fields, builder layout import) | Section and Import buttons hidden; `HelmImport` does nothing | `smart_import_batch` refused |
| Data & compliance, and all downloads (studio archive, CSV and PDF reports, quote PDF, booklet PDF, run sheet print, builder PNG/JSON, event file download) | Section and buttons hidden; print and download links blocked in the page | `export_tenant_organization_package` and `export_org_data` refused |
| Photo renders | "Render" button and render dialog hidden | `photo_render_begin` and `photo_render_settings_set` refused |
| Notifications | Section hidden | `admin_set_notification_pref` and `admin_reset_notification_prefs` refused |
| Reminders & client messages, privacy PIN | Section hidden; "Send reminder now" hidden | Outgoing messages from a trial are already queued as "skipped" and never sent (0166); `event_reminder_settings_set`, `privacy_pin_set`, `privacy_pin_reset` and `payment_reminder_send_now` refused (0181). Unlocking hidden amounts with the default PIN still works |
| Custom fields | Section hidden | Adding, changing or removing a custom field definition (`custom_field_defs`) refused (0181) |
| Layout templates (your own) | "Save as template" and "My templates" hidden in the builder; Control Center section shows "Not available in the free trial" | `studio_template_save`, `_set_archived`, `_set_default`, `_duplicate` refused (0181) |
| Templates page (checklist templates) | Page covered with "Templates are not part of the free trial"; "Go to templates" (search) and "Checklist template" (quick create) removed | - |

## 5. Creation cap: 2 created in total per list (quotes and events included again)
- **Quotes and events are capped at 2 new again** (migration 0238, owner r20; 0211 had removed the quote cap). "New quote" still opens the quote flow straight away (no name / type dialog); an untouched blank quote is reused (that inserts nothing, so it is never refused), and empty drafts move to the Deleted shelf after a day (0141 / 0208) - they still count, like every own quote. Quotes a trial made while 0211 was live are kept and count. The Quotes page and the dashboard say "Free trial: 1 of 2 new quotes used" next to "New quote"; at 2 of 2 the button is switched off and a refused 3rd quote says so with a "Choose a plan" link.
- A trial studio can create at most **2 of its own rows in total** in each of these lists: leads (clients), events / quotes, inventory items, vendors, staff and venues.
- "In total" (0181): every own row the trial adds is remembered in `trial_create_log`, so deleting it does not free a slot. Rows that still exist also count, including removed (inactive), soft-deleted and shelved ones. Restoring a deleted lead brings the same row back and does not use a new slot.
- Sample (demo) rows do not count. A sample inventory item stays sample data even when the studio renames or re-prices it (migration 0182), so it never counts. For the other lists, a sample row that the studio renames out of the "Demo ·" prefix becomes the studio's own row and does count.
- The 3rd add is refused with **"Free trial limit reached (2). Upgrade to add more."** `my_trial_limits()` returns the counts so the app can show the limit before the server refuses (0238: quotes are in `used` again, no `uncapped` key).

## 6. Messages
**E-mail works during an active trial (owner decision, migration 0212).** The approval (quote) link e-mail and the booklet link e-mail ("Send by email", client-mailer), the booklet and invitation website "Send to client" by e-mail (comms_outbox -> comms-dispatch) and the approval code by e-mail (send-otp) really reach the client. Caps: **30 client e-mails a day per studio and 5 a day to one address** (rolling 24 hours, counted in `trial_email_sends`, which stores only a sha-256 fingerprint of the address). Sample (demo) events are never e-mailed. The owner can switch trial e-mail off at once: `update public.trial_email_settings set enabled = false where id;` (caps: `per_studio_day`, `per_recipient_day`).
**WhatsApp, SMS and online payment links stay off** in the trial: their rows are queued as "skipped" and the direct routes (SMS / WhatsApp approval code, "Send on WhatsApp", proposal WhatsApp, payment links) are refused (0179 / 0187). The app hides the WhatsApp options in the trial; the client page offers the code by e-mail or **Test mode - confirm**. Payment reminders and automatic follow-ups are not sent in the trial either.
After an unpaid trial ends (read-only) nothing is sent at all, e-mail included, until the studio is on a paid plan; the sample master never sends.

## 7. Clearing the demo data
An admin can clear the sample data from the demo-data card. Only rows marked as demo data in that studio are removed. Rows the studio created or adopted are never touched.
Sample dishes, menu packages and inventory items stay demo data even after the studio edits them during the trial (migration 0182), so clearing removes them too. Once the studio pays, the 0097 rule applies again: editing a sample row from then on makes it the studio's own row.

## 8. When the trial ends (day 8)
The studio becomes read-only until a plan is paid. Everything stays as it was, and paying unlocks the studio again. Once the subscription is no longer `trial`, every limit in this brief stops applying automatically.

## For engineers
- **Trial test:** `public._is_trial_org(org)` checks `studio_subscriptions.status = 'trial'`. The sample master studio is exempt.
- **Client:** `public/trial-lock.js` (loaded by `store-api.js`) asks the server for the subscription status and adds `html.helm-trial`. `public/trial-lock.css` hides the entry points. `control-split.js` hides the locked sections and shows the not-available message for direct links.
- **Before first paint (0181):** `trial-lock.js` caches `helm.trial = 1` in the browser. On the next page load `shell-proto.js` (app pages), `trial-early.js` (builder, booklet) or `store-api.js` (any other page) adds `html.helm-trial` at once, so export, render and print buttons never flash usable. When the server says the studio is not on a trial (paid, upgraded, signed out), the class comes off again and the flag is cleared. Sign-out clears it too.
- **SQL:** `supabase/APPLY-0173.sql`, then `supabase/APPLY-0181.sql`, are the paste files. Run them on staging first, then production. They are safe to run twice, and their VERIFY rows should all be `true`.
- **Tests:** `tests/db/trial-lockdown-0173.sql` and `tests/db/trial-guards-0181.sql` (DB), and `test/trial-lockdown-ui.test.mjs` (UI).
