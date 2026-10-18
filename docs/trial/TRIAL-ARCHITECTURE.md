# Helm Free Trial: Architecture (for owner review)

Status: DRAFT, design only. No SQL has been written or applied. Baseline: origin/main `5051b41`.
Rules that apply throughout: zero data loss (additive, idempotent migrations only), work local-first, staging before prod.

---

## 1. Goals

| # | Requirement (owner) | What it means in practice |
|---|---|---|
| G1 | Every free-trial signup gets the **same** predefined sample data | One owner-defined dataset, versioned. Every trial studio gets an identical copy of it. |
| G2 | Data covers inventory, staff, vendors, venues, menus/packages, templates, price list, leads, quotes, events | A complete studio that looks lived-in on day one |
| G3 | Users are **not** copied | The person who signs up becomes Admin. Sample staff are crew records only, never login accounts. |
| G4 | Admin can invite up to **2 more users**, in any role | Seat limit of 3 people, enforced on the server |
| G5 | Users can do everything on dummy data | Edit templates, create quotes, run the full lifecycle |
| G6 | Client approval uses **"Skip OTP — trial test mode"** | WhatsApp/SMS are not live. Approval is simulated, on the server, and only for studio members. |
| G7 | No real emails, WhatsApp messages or payments from sample data | Every outbound channel fails closed |
| G8 | "Create studio" directly (paid) gets normal onboarding with import, and **no** sample data | Two separate entry paths |

## 2. What already exists (we build on it, we don't rebuild)

Most of the plumbing is already in place. The main gap is G1: the dataset is hard-coded in SQL instead of being one owner-defined master.

| Piece | Where | Status |
|---|---|---|
| Trial entry RPC `start_self_serve_trial(name, tz, currency, mode)` | `0119_unified_trial.sql:70` | Works. Mode 'demo' seeds data, mode 'own' does not. |
| Trial flags `trial_ends_at`, `trial_mode`, `demo_choice` | `0116:47`, `0097:60`, `0127:38` | Works |
| `is_demo` flag + guard trigger on 12 tables | `0097:68-80` | Works. Only database functions can set it. |
| Built-in seed `_demo_seed` + `_trial_seed_extra` | `0100:33`, `0116:133` | Hard-coded, small, and different data per path |
| Owner seed hook `helm_env_settings.trial_demo_seed` | `0127:49-128` | Adds to the built-in data; doesn't replace it. Only 4 kinds of data. |
| Clear/reset `_demo_clear`, `trial_demo_choice` | `0097:411`, `0127:145` | Works. Deletes only `is_demo` rows in the caller's studio. |
| Outbound blocks (WhatsApp, OTP send, payment link, outbox) for demo events | `0097:135-188` | Works |
| Skip OTP `trial_test_approve` (members only) | `0128:54`, `0146:86-97`, `approve.html:282` | Works |
| Read-only after expiry `_trial_locked` + `tg_studio_read_only` | `0116:73-90`, `0159:110` | Works |
| Direct paid path with payment gate | `0159_direct_studio_plan_gate.sql:70` | Works |
| Seat limit of 3 for trials | none | **Missing** |
| Tasks, run sheet, chat welcome, nurture contacts, booklet seed | none | **Missing** |
| Sample-data version on the studio | none | **Missing** |

## 3. Chosen pattern, and why

**Pattern: a seed function driven by a versioned manifest, run once at signup, writing into the trial's own studio (shared schema + RLS), with every row marked by a column flag.**

| Option considered | Who uses it | Verdict for Helm |
|---|---|---|
| Seed at signup or on a button, with rows flagged as sample | Pipedrive (`[Sample]` data in every new account), Atender (one-click sample content), Salesforce (`hasSampleData` in a version-controlled definition file) | **Chosen.** Fits shared-schema + RLS. Already 80% built. |
| Clone a template tenant (schema or DB copy) | django-tenants, Postgres `CREATE DATABASE … TEMPLATE` | Rejected. It works for schema-per-tenant. With a shared schema, every id and org_id would need rewriting. The Salesforce patent US11151110 describes exactly that remapping problem. |
| Test/live mode inside one account | Stripe (`sk_test_`/`sk_live_` keys, livemode flag) | We take its **safety idea**: sandbox actions physically can't reach live channels. We don't take the mixed-mode design, because Stripe and Shopify both show settings leaking between modes. |
| One shared read-only demo account | HubSpot partner demo accounts | Rejected. Users can't edit anything, and that breaks G5. |

### The "master sample studio" decision

The owner wants to define the data once, and ideally edit it in the app. There are two ways to do that:

- **A. Manifest only.** The data lives as a JSON file in the repo (`seed/trial/v1/*.json`). It is loaded into `helm_trial_seed_manifest` and seeded from there.
- **B. Master studio + snapshot (recommended).** The owner keeps one real studio, "Helm Sample Master", and edits it with the normal Helm screens. A platform-admin button, **"Publish sample v{N}"**, snapshots that studio into a frozen JSON manifest row, `helm_trial_seed_manifest(version, payload, published_at)`. New trials seed from the latest **published manifest**. They never copy live from the master studio.

Why B: the owner edits in a UI they already know. Trials are protected from half-finished edits, because only published snapshots count. Each version is frozen and auditable. Roll back by marking an older version current.
The JSON is also exported into the repo (`seed/trial/vN.json`) so it is version-controlled, the way Salesforce does it.

## 4. Data model (all additive)

| Change | Table | Notes |
|---|---|---|
| Keep `is_demo` as the sample marker | 12 existing tables | Don't rename it to `is_sample`. That would be a breaking change. "Sample" is only the UI wording. |
| Add `is_demo boolean default false` + partial index + guard trigger | new seeded tables: `tasks`, run-sheet rows, `event_booklets` / booklet pages, layout items, nurture contacts, chat messages, price-list items, templates (WhatsApp/email/contract), staff assignments | Same `_a97_tg_demo_flag_guard` pattern |
| Add `sample_batch_id uuid` | all seeded tables | Ties every row to a single seed run. Used for audit and exact clears. |
| Add `organizations.sample_version int`, `sample_batch_id uuid`, `sample_seeded_at timestamptz` | organizations | Records which version a studio got |
| Add `organizations.seat_limit int` (null = plan default) | organizations | Set to 3 for trials |
| New `helm_trial_seed_manifest(version int pk, payload jsonb, source_org uuid, published_by uuid, published_at, is_current bool, notes)` | platform table | Platform admin only. RLS: no tenant access. |
| New `trial_seed_runs(id, org_id, version, batch_id, counts jsonb, status, started_at, finished_at, error)` | audit | One row per seed attempt. Makes the seed easy to debug. |

The manifest payload is one JSON document. Sections: `venues`, `dish_catalog`, `menu_templates`, `price_list`, `inventory_items`, `crew_members`, `vendors`, `templates`, `leads`, `quotes` (with nested `milestones`, `payments`, `checklist`, `layout`, `booklet`, `run_sheet`, `staff_assignments`, `tasks`), `nurture_contacts` and `chat_welcome`. Each item has a stable **`key`** (e.g. `"venue.lakeview"`), and references use keys, never uuids: `"venue": "venue.lakeview"`.

## 5. The seed function: `seed_trial_from_manifest(p_version int default null)`

- `SECURITY DEFINER`. The studio comes from `auth.uid()` through membership, **never from a parameter**. The caller must be Admin of a studio where `trial_mode = 'demo'`.
- Called by `start_self_serve_trial` when mode is 'demo'. It replaces `_demo_seed` + `_trial_seed_extra` + `_trial_seed_custom`, which are kept as `*__pre01xx` for rollback.
- **Idempotent.** If `organizations.sample_batch_id` is already set, it returns `{skipped:true}`. An advisory lock on org_id stops double clicks from racing.
- **One transaction.** It either seeds everything or nothing.
- **Id remapping.** A PL/pgSQL `jsonb` map, `key → new uuid`, built while inserting. It doesn't use temp tables, per the paste-SQL rules. Every child resolves its foreign keys through the map. Every row gets `org_id = caller org`, `is_demo = true` and `sample_batch_id = batch`.
- **Dates are relative to signup.** The manifest stores `event_offset_days` (e.g. `+21`, `-10`). The function computes `current_date + offset` in the studio's timezone, so the data always looks current. Past events (negative offsets) show the post-event and settlement flow.
- **Pricing.** Quotes are priced by the **server pricing engine** (D8 authority), the way `0100` already does it. Totals are never copied from the manifest. That way they stay consistent with the trial's own price list.
- **Contacts are made safe at insert time.** Every email is rewritten to `<key>@example.com` (RFC 2606). Every phone is rewritten to the `+91 00000 xxxxx` reserved pattern (`_is_demo_phone`). This happens even if the manifest contains a real-looking value.
- **Insert order** (parents first):

| Step | Table(s) |
|---|---|
| 1 | venues, vendors, crew_members (+ skills/roles) |
| 2 | dish_catalog, price-list items, inventory_items |
| 3 | menu_templates (packages) → package items |
| 4 | templates (contract, WhatsApp, email, invitation) |
| 5 | leads, nurture contacts |
| 6 | quotes/events (the quote row IS the event) → priced by engine |
| 7 | payment_milestones → quote_payments (simulated, `method='demo'`) |
| 8 | event_checklist, tasks, run sheet, staff assignments, inventory checkouts |
| 9 | layouts → layout items; booklet |
| 10 | chat welcome message(s) |
| 11 | write counts to `trial_seed_runs`, stamp the org, write an audit_log row |

## 6. Trial limits

| Limit | Value | Enforced where |
|---|---|---|
| Length | `helm_billing_settings.trial_days` (default 8) | existing `_trial_days()` |
| Users | 3 total (Admin + 2). Any role. | **New** trigger on member insert and invite create: count active members plus pending invites against `seat_limit`. The UI shows "2 of 2 invites used". |
| After expiry | Read-only (existing `_trial_locked`). Data is kept. | existing |
| Data retention after expiry | Owner decision. Pipedrive's model: delete shortly after the trial ends if not converted, with a 60-day recovery window. | Recommend **60 days read-only, then archive**. No hard delete without owner sign-off. |
| Conversion to paid | Change only plan/status. **Data never moves.** | existing checkout |
| Sample data on conversion | Owner decision: keep, or "Start fresh" (`trial_demo_choice('fresh')`) | existing `?demo=fresh&then=checkout` |

## 7. Safety

1. **RLS stays the isolation boundary.** Seed and clear functions take the org from auth and include `org_id` in every WHERE clause.
2. **Outbound channels fail closed** for any `is_demo` record **or** any studio in trial: email/SMTP, WhatsApp, SMS, Razorpay links and payments, invitation-site publishing, and calendar invites. Each blocked send writes a "Simulated — not sent (trial)" entry to the timeline instead. The existing 0097 guards cover WhatsApp, OTP, payment link and outbox. **Still to add:** SMTP email, invitation publish, and staff notifications.
   - **Owner decision:** should *real* records a trial user creates (their own lead with a real email) be allowed to send? The safe default is to block every send during a trial. The banner explains it.
3. **Skip OTP** is only available when `_trial_test_mode_ok(org)` is true **and** the caller is a signed-in member (0146). It is never a URL or client flag. A real client holding the link still needs a real OTP, and the bypass can never be used on a paid studio. Each use stamps `verified_via_otp=false` and writes `approval.trial_test_skip` to the audit log.
4. **Sample contacts can't be delivered to**: `@example.com` emails and reserved phone numbers. Even a bug can't reach a person.
5. **Clear deletes only rows marked `is_demo` and the current `sample_batch_id`** in the caller's org. It does a dry-run count first and writes an audit row. Sample masters that real records still use are deactivated, not deleted (existing behaviour). Venues are never deleted.
6. Sample staff never become login users (G3). `crew_members` rows have no auth link.

## 8. Onboarding: trial vs paid

| Step | Free trial (`try.html` → `?trial=1`) | Direct "Create studio" (`?direct=1`) |
|---|---|---|
| Sign up | Email or Google | Email or Google |
| Studio created by | `start_self_serve_trial(..., 'demo')` | `create_studio` (0159) |
| Payment | None during trial | Payment gate (`studio_payment_gate`) |
| Data | Sample manifest vN seeded | Empty |
| First screen | Dashboard with "Sample data" banner and a guided tour ("Approve a quote → Skip OTP → see the event") | Onboarding wizard: studio profile → import inventory/staff/vendors (CSV) → "Load starter items" (existing) → invite team |
| Users | Admin + 2 | Plan limit |
| Outbound | All simulated | Live, once integrations are on |
| End | Convert (keep or clear the sample data) or expire to read-only | n/a |

The "demo vs my own data" choice in `chooseStart()` stays, so a trial user can still pick "own" and get an empty trial.

## 9. Admin tooling (how the owner edits the sample data)

1. Open the **Helm Sample Master** studio. It is a normal studio flagged `is_sample_master=true`, excluded from billing and analytics.
2. Edit inventory, menus, quotes and so on with the normal screens.
3. Control Center → **Trial sample data** → **Preview** shows counts and a diff against the current version. **Publish v{N+1}** snapshots it into `helm_trial_seed_manifest`.
4. Only new trials get vN+1. Existing trials are **never re-seeded**.
5. **Roll back** by choosing an older version and clicking "Make current".
6. Export the JSON into `seed/trial/vN.json` and commit it.

The snapshot step validates the manifest. It checks that every reference resolves, that no real-looking emails or phones are present (warn, then rewrite), that every quote has a venue and a package, and that the size limits are respected.

## 10. Testing plan

| Test | Where |
|---|---|
| Seed is identical across two fresh trials (row counts per table match the manifest) | `tests/db/trial-manifest-seed.sql` (new) |
| Seed run twice gives no duplicates (idempotent) | same |
| Cross-tenant: trial A cannot read trial B or the master | RLS test |
| Dates fall within the expected window relative to `current_date` | same |
| Quote totals match the server pricing engine | same |
| Seat limit: 3rd invite OK, 4th refused (invite and accept paths) | `tests/db/trial-seat-limit.sql` |
| Skip OTP: works for a member during the trial; refused for an anonymous link holder, after expiry, and on a paid studio | extend `tests/db/trial-test-mode` |
| Outbound: email, WhatsApp, SMS, payment and publish on sample data all produce a "simulated" entry and no outbox send | `tests/db/trial-outbound-block.sql` |
| Clear: removes only that batch's sample rows; user-created rows survive, including rows linked to sample masters | extend `tests/db/trial-demo-0097.sql` |
| Expiry → read-only, and data is kept | existing `trial-reminders.sql` |
| Direct paid path seeds nothing | `onboarding-checkout.sql` |
| Browser E2E: sign up → tour → approve with Skip OTP → event → invite 2 users → expire | local, then staging |

## 11. Rollout

1. Owner fills in the data plan checklist (section 12). We build the manifest v1 JSON.
2. Migration A (additive): new columns, flags on new tables, manifest and run tables, seat trigger. Staging first.
3. Migration B: `seed_trial_from_manifest`. Rewire `start_self_serve_trial` to it, keeping the old functions as `__pre`. Staging.
4. Load manifest v1 on staging. Run the DB tests and browser E2E.
5. Control Center "Trial sample data" page (preview / publish / rollback) and the Helm Sample Master studio.
6. Outbound blocks for SMTP, publish and staff notifications.
7. Owner tests on staging. Then the prod SQL in order (tracked in the staging-vs-prod tracker), when the owner says go.
8. Push only when the owner says push.

## 12. DATA PLAN CHECKLIST (owner to fill)

Use clearly fake names and businesses. Phones and emails are rewritten automatically, but please give placeholders anyway. Currency and timezone follow the trial's own settings.

| # | Dataset | Suggested qty | Fields needed | Notes |
|---|---|---|---|---|
| 1 | Studio profile defaults | 1 | Display name style, tagline, terms text, GST/tax %, logo placeholder | The trial user's own studio name overrides the name |
| 2 | Inventory | ~40 items | Name, category, qty owned, unit, rental/unit price, replacement cost, notes | Categories: furniture (chairs, tables), linen, décor (backdrops, florals), lighting, sound/AV, tableware/cutlery, tents/structures, kitchen equipment |
| 3 | Staff / crew | 8–12 | Name, role (coordinator, captain, server, chef, decorator, driver, helper), skills, day rate, availability | Not logins |
| 4 | Vendors | 8 | Name, type (florist, photographer, DJ, caterer, lighting, transport, makeup, pandit/officiant), contact person, rate card note | |
| 5 | Venues | 4 | Name, area/city, capacity, indoor/outdoor, hall sizes (for layouts), notes | Mix: banquet hall, lawn, hotel ballroom, rooftop |
| 6 | Dish catalog | ~30 dishes | Name, course, veg/non-veg/Jain, cost per plate | Feeds the packages |
| 7 | Menu packages | 6 | Name, tier, per-plate price, included dishes/courses, minimum guests | e.g. Silver Veg, Gold Veg, Royal Veg, Classic Non-veg, Premium Non-veg, Hi-Tea |
| 8 | Item price list | ~25 | Service/add-on, unit, price | Décor packages, DJ hours, valet, photo booth |
| 9 | Templates | 5–8 | Contract/terms, quote cover note, WhatsApp/email message texts (reminder, thank-you, payment due), invitation template choice, checklist template | Edits by the trial user are allowed |
| 10 | Leads | 6 | Name, event type, date offset, guests, budget, source, stage | Stages: New, Contacted, Site visit, Quote sent, Won, Lost |
| 11 | Quotes / events | 4 | Client, venue, package, guests, date offset, add-ons, stage | (a) Draft quote (+30d). (b) Sent, awaiting approval (+21d): **use this one to try Skip OTP**. (c) Confirmed, upcoming (+10d) with **layout, booklet, payment milestones (1 paid), run sheet, staff, inventory**. (d) Completed, past (−10d) and settled. |
| 12 | Payment milestones | per quote | %, due offset, paid yes/no | Simulated only |
| 13 | Run sheet | 1 event, ~15 rows | Time, activity, owner, notes | For event (c) |
| 14 | Tasks | ~10 | Title, assignee role, due offset, status | Mix of done and open |
| 15 | Layout | 1 | Hall, table count and shape, stage, dance floor | For event (c) |
| 16 | Booklet | 1 | Sections to include | For event (c) |
| 17 | Team chat welcome | 1–3 messages | Text, from "Helm" | Explains the trial |
| 18 | Nurture contacts | ~6 | Name, segment, last-contact offset | Never messaged |
| 19 | Checklist | 1 per event | Items, done or not | |

## 13. Open questions for the owner

1. Option **B** (master studio + publish) or **A** (JSON file only) for editing the sample data?
2. When the trial converts to paid: keep the sample data by default, or ask "keep or start fresh"? (Today it asks.)
3. After expiry: how many days read-only before archive? (Suggested: 60, no hard delete.)
4. Should real records a trial user creates be able to send real email? (Suggested: block every send during a trial.)
5. Do the 2 invited users count pending invites against the limit? (Suggested: yes.)
6. Trial length: keep 8 days, or change `trial_days`?
7. Should one user be allowed more than one trial? (Today `start_self_serve_trial` returns the existing studio.)
8. Should sample-data rows keep the "Demo ·" prefix in names, or use only a badge? (The guard trigger currently uses the prefix, so dropping it needs a code change.)
9. India-only data, or a UAE variant too (there is existing `uae-demo-0102` work)? One manifest per region?
10. Should the guided tour be compulsory, or able to be dismissed?

---

## 14. Implementation status (branch feat/trial-sandbox: 0166 + 0167)

Owner decisions applied: India only; 8-day trial; Admin + 2 people (pending invites count; revoke/remove frees a seat);
every trial gets its OWN independent copy; sample contacts are dummy (`Demo ·` names, `@example.com`, `+91 00000 xxxxx`);
Skip OTP in trial test mode; all outbound client messages blocked during the trial (default on).

| Piece | Where |
|---|---|
| Publish snapshot: `helm_trial_seed_manifest` (frozen versions, one `is_current`) | 0167 |
| `publish_sample_manifest(notes)` / `set_current_sample_manifest(v)` / `sample_manifest_status()` (platform admin or SQL editor) | 0167 |
| Clone from the CURRENT manifest (never the live master): 21 tables incl. leads, quotes (re-priced by D8), layout version, milestones, simulated payments, checklist, tasks, run sheet, reservations, costs, closure, nurture, rate cards, checklist/task templates | 0167 `_sample_clone_into` |
| New approval token per trial; dates shift by `current_date - manifest.anchor_date` | 0167 |
| Seat counter RPC `my_seat_usage()`; UI "N of M seats used" in Control Center > Users & invites | 0167 + control.html |
| 2-step trial welcome (dashboard): 1 name/city (default Hyderabad)/phone -> `trial_welcome_setup`; 2 invite up to 2 (or Skip); then the tour | 0167 + trial-demo.js |
| "Sample data" badge in the trial strip | trial.js |
| Clear sample data also removes sample nurture / checklist / task templates (re-opens closed sample events first) | 0167 `_demo_clear` |

### Sample dataset v1 (one SQL section per dataset in 0167 section 11, easy to swap)
venues 4 (Hyderabad) · vendors 8 · staff 10 · dishes 30 · menu packages 6 · inventory 40 (unit_cost = rental rate, replacement cost in attributes) ·
item rate cards 11 · checklist templates 5 (incl. a run-sheet template) · task templates 8 · leads 8 (every stage) ·
events 4: SMP-1001 confirmed +10d (layout, 1 of 3 milestones paid, run sheet 15, tasks 10, checklist 6, reservations 5),
SMP-1002 sent for approval +21d (try Skip OTP), SMP-1003 draft +30d, SMP-1000 closed -10d (fully paid, costs, closure) · nurture 6.

**Replacing the data with the owner's Excel:** edit the master studio ("Helm Sample Master", id `a5a5a5a5-0166-4000-8000-000000000001`)
with the normal screens or SQL, then run `select public.publish_sample_manifest('v2: owner data');`. Only NEW trials get v2.
Roll back: `select public.set_current_sample_manifest(1);`.

### Switch ON (staging) - one line
```sql
update public.helm_sample_template set active = true where id;
```
OFF again: `... set active = false where id;` (new trials then get the old built-in demo seed).

### Sample dataset v2 (0168, `supabase/APPLY-0168.sql`, run after APPLY-0166-0167)
Owner venues replace the 4 v1 venues in the master (same rows, updated by old name; INR per day, dummy contacts):
Grand Convention Centre, Hitec City (convention centre) · Green Meadows Lawn · Royal Banquet Hall · Square Garden Pavilion, Gachibowli.
Events now use them (SMP-1000/1001 Royal Banquet Hall, SMP-1002 Square Garden, SMP-1003 Grand Convention Centre).
Studio payment terms (app_config `pricing`): advance 30 %, balance due 3 days before the event, payment note.
Sample milestones: 30 % advance + 70 % balance due event date - 3.
The manifest now also stores `studio` (currency, timezone, country, payment terms); `_sample_clone_into` (wrapper over
`*__pre0168`) gives every cloned trial INR + Asia/Kolkata + IN + those terms + the master's 11 item rate cards
(the builder's 2D/3D palette itself is shipped in code, so every studio has all products). Published as manifest v2.
