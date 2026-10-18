# Helm free trial, end to end

This is a plain-words brief of the free trial. It covers what a new studio gets, what it can change, and where the limits are. Paid studios are not affected by anything here.

## 1. Signing up
- The person signs up and picks **Start free trial**. `start_self_serve_trial` creates the studio and an 8-day trial (`studio_subscriptions.status = 'trial'`).
- The welcome step (`trial_welcome_setup`) asks for a name, city and phone. Helm then writes the studio details itself. The trial user never has to do studio set-up.
- When the sample template is switched on, the studio gets a copy of the sample studio (migrations 0166-0171). Every copied row is marked as demo data.

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

GST is set to 18% (intra-state). Event dates are relative to the sign-up day, so the calendar always looks current.

## 3. What a trial studio can use
- The dashboard, leads, events and quotes, the layout builder (2D/3D), inventory, vendors, staff, venues, calendar, budget and chat.
- **Pricing & coupons:** fully editable (default pricing, rate cards, capacity limits, object prices).
- **Layout builder prices:** every builder item type starts at the owner's inventory rate (for example LED Wall 5,000, Stage Barrier 1,000, Main Stage 18,000) and the chair rate is 100 (migration 0182). Seats are billed at the chair rate: chairs, chair rows, seating blocks and the seats around round / banquet tables (a round table with 8 seats = 8 x 100). The studio can still change every rate under Pricing.
- **Menus & catalog:** existing menu packages can be changed, including their prices and dish lists. New dishes, packages, chair types or plate types **cannot be added**, and existing ones cannot be removed.
- **Layout rules** and **Layout templates:** editable.
- **Users & invites:** at most **you + 2 people**. Open invitations count toward that number. The server refuses a 3rd person even if the request is sent straight to the API.
- **Roles & access:** editable.
- **Plan & billing:** shown, so the studio can upgrade. The demo-data card (keep or clear the sample data) also sits here.

## 4. What is hidden and blocked
"Blocked" means the screen hides the feature, a direct link shows **"Not available in the free trial"**, and the server refuses the request (migration 0173).

| Feature | Screen | Server |
|---|---|---|
| Studio set-up: General, studio account, studio, branding, billing details, client link name | Control Center section hidden; the onboarding page is covered; the "Fill in studio details" step is removed | Direct `organizations` edits refused; `my_studio_account_update` and `set_studio_link_name` refused |
| Client links auto-expire and the package flow | Section hidden | `admin_set_link_autoexpire` and `admin_set_link_expiry_shelf` refused |
| Import (Excel/CSV import, custom fields, builder layout import) | Section and Import buttons hidden; `HelmImport` does nothing | `smart_import_batch` refused |
| Data & compliance, and all downloads (studio archive, CSV and PDF reports, quote PDF, booklet PDF, run sheet print, builder PNG/JSON, event file download) | Section and buttons hidden; print and download links blocked in the page | `export_tenant_organization_package` and `export_org_data` refused |
| Photo renders | "Render" button and render dialog hidden | `photo_render_begin` and `photo_render_settings_set` refused |
| Notifications | Section hidden | `admin_set_notification_pref` and `admin_reset_notification_prefs` refused |
| Reminders & client messages, privacy PIN | Section hidden | Outgoing messages from a trial are already queued as "skipped" and never sent (0166) |

## 5. Creation cap: 2 per list
- A trial studio can add at most **2 of its own rows** to each of these lists: leads (clients), events/quotes, inventory items, vendors, staff and venues.
- Sample (demo) rows do not count. A sample inventory item stays sample data even when the studio renames or re-prices it (migration 0182), so it never counts. For the other lists, a sample row that the studio renames out of the "Demo ·" prefix becomes the studio's own row and does count.
- The 3rd add is refused with **"Free trial limit reached (2). Upgrade to add more."** `my_trial_limits()` returns the counts so the app can show the limit before the server refuses.

## 6. Messages
Nothing leaves Helm during a trial. E-mail, WhatsApp and SMS rows are queued as "skipped", and sample contacts are dummy addresses and numbers.

## 7. Clearing the demo data
An admin can clear the sample data from the demo-data card. Only rows marked as demo data in that studio are removed. Rows the studio created or adopted are never touched.
Sample dishes, menu packages and inventory items stay demo data even after the studio edits them during the trial (migration 0182), so clearing removes them too. Once the studio pays, the 0097 rule applies again: editing a sample row from then on makes it the studio's own row.

## 8. When the trial ends (day 8)
The studio becomes read-only until a plan is paid. Everything stays as it was, and paying unlocks the studio again. Once the subscription is no longer `trial`, every limit in this brief stops applying automatically.

## For engineers
- **Trial test:** `public._is_trial_org(org)` checks `studio_subscriptions.status = 'trial'`. The sample master studio is exempt.
- **Client:** `public/trial-lock.js` (loaded by `store-api.js`) asks `my_trial_status` and adds `html.helm-trial`. `public/trial-lock.css` hides the entry points. `control-split.js` hides the locked sections and shows the not-available message for direct links.
- **SQL:** `supabase/APPLY-0173.sql` is the paste file. Run it on staging first, then production. It is safe to run twice, and its VERIFY rows should all be `true`.
- **Tests:** `tests/db/trial-lockdown-0173.sql` (DB) and `test/trial-lockdown-ui.test.mjs` (UI).
