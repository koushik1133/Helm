# Why "Delete user" fails in Supabase, and what to do about it

Status: diagnosis only. Nothing has been deleted, and this file contains no delete SQL.
Source: read from supabase/HELM-STAGING-SCHEMA.sql and supabase/migrations/*.sql. No queries were run.

## 1. Plain-English cause

When you click Authentication -> Users -> Delete, Supabase runs `DELETE FROM auth.users WHERE id = ...`.
Postgres then looks at every table that points at that user.

- Some links say **ON DELETE CASCADE** ("if the user goes, delete my row too"), for example `profiles`, chat membership and per-user settings.
- Some links say **ON DELETE SET NULL** ("if the user goes, blank my pointer"), for example the sender of a chat message.
- About **40 links say nothing**. Nothing means NO ACTION, which works like RESTRICT: "you may not delete this user while I still point at them."

Every test user has created something, such as a quote, lead, cost, task, checklist item, invitation, or a whole studio (`organizations.created_by`). That one row blocks the delete. Postgres raises a foreign-key violation (23503). The dashboard shows it as the generic **"Database error deleting user"**.

This is a safety feature, not a bug. The database refuses to delete a person while business records still say "this person did it". No trigger blocks auth deletes. The only BEFORE DELETE guards are on `quotes` (0026), `venues` (0085), `studio_layout_templates` (0096) and `helm_hq_settings` (0047). Those apply only if a cascade ever reached those tables, and none of the user links cascade into them.

Storage: `storage.objects.owner` has no foreign key in current Supabase, so uploaded files do not block the delete. They also stay behind afterwards.

`audit_log.actor` is a plain uuid with no foreign key. It never blocks a delete, and audit history survives.

## 2. Blocking references (NO ACTION -> these stop the delete)

All of these point to `auth.users(id)` and are defined in HELM-STAGING-SCHEMA.sql:

| Table | Column(s) |
|---|---|
| organizations | created_by |
| quotes (the event) | manager_id, confirmed_by |
| leads | owner |
| invitations | invited_by, accepted_by |
| quote_versions, quotation_versions | created_by |
| payment_milestones, event_refunds, event_costs, expense_claims | created_by |
| event_plan | updated_by, locked_by |
| event_proposal, event_discovery, event_closure | updated_by |
| event_tasks | created_by, verified_by |
| event_checklist, checklist_templates, event_day, event_issues, event_media, event_guests, event_attendees, event_ratings, event_requirements, event_resource_needs, event_resources, event_stock_requests, event_sites, run_sheet_items, proposal_risks, nurture, change_requests, inventory_reservations | created_by |
| inventory_checkouts | issued_by, confirmed_by |

Possibly more on PROD: prod is behind staging (about 0115), so re-check there before any fix.

## 3. Links that already behave well (no action needed)

- CASCADE: profiles.id, notification_seen, chat_members, chat_reactions, auth_temp_passwords, notification_prefs, user_dashboard_prefs. Via profiles, the same applies to member_profiles, phone_verifications, getting_started_state, saved_views and member_wa_optin.
- SET NULL: chat_conversations.created_by, chat_messages.sender_id, member_profiles.profile_id.

## 4. What to do NOW (safe, deletes nothing)

For each test user in Supabase -> Authentication -> Users:
1. **Ban the user.** Open the user, choose "Ban user", and pick a long duration. They can no longer sign in. Every record stays.
2. **Reset or rotate the password** ("Send password recovery", or set a random one). This also closes the "default password" risk.
3. Optionally remove the user from their studio in Helm (Team page, deactivate). The membership is revoked, but the history stays.

This makes the accounts harmless before client demos, with zero data loss.

## 5. Proper fix LATER (owner approval required, not written yet)

One additive, idempotent migration. For each blocking constraint:
`DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT ... ON DELETE SET NULL` (`NOT VALID`, then `VALIDATE`), in a single transaction. No row data changes.

Reasoning per group:
- **"Who did it" stamps** (created_by, updated_by, locked_by, verified_by, issued_by, confirmed_by, invited_by, accepted_by): use **SET NULL**. The business row such as a cost, task or payment must survive the person. `audit_log` already keeps actor + actor_email as text, so "who" is not lost. First check that each column is nullable. Any `NOT NULL` would need `DROP NOT NULL`, which is also additive.
- **quotes.manager_id, leads.owner**: use **SET NULL**. The event or lead stays and shows as "unassigned", and an admin reassigns it. Never CASCADE, because that would delete client events.
- **organizations.created_by**: use **SET NULL**. A studio must never disappear because its creator's login was removed.
- Do **not** turn any of these into CASCADE. CASCADE would silently delete business data, which breaks the zero-data-loss rule.

After that migration, dashboard deletion of a test user works. Their studios and records remain, owned by nobody. Removing whole test studios is a separate, later step.

Before running it: apply on STAGING, delete one throwaway staging user, and confirm the rows remain with a null stamp. Then do the same on PROD.

## 6. Trial demo data vs real studio data (same database)

Current design, as read from the migrations:
- **Every trial studio gets its own copy** of the sample data. It is not one shared table. `start_trial()` (0116) creates a studio named **"Demo N"** and seeds it with `_demo_seed` / `_demo_seed_ae` (0097/0100/0102). Every seeded row has `org_id` = that studio and **`is_demo = true`**, and names start with "Demo -". Staff are seeded too.
- `is_demo` can only be set by the database functions. Trigger `zz_a97_demo_flag_guard` stops the app from flagging or unflagging rows. A demo row the studio edits into its own (renamed) becomes real (`is_demo = false`).
- `organizations.trial_mode` ('demo' | 'own') and `organizations.trial_ends_at` (8 days) mark a trial studio. `studio_subscriptions.status = 'trial'` drives the banner. After the end date the studio becomes read-only (`tg_studio_read_only`). Nothing is deleted.
- `clear_demo_data()` / "Start my own studio" (0123) removes only that studio's `is_demo` rows.
- Demo events can never send WhatsApp messages or take money (0097 guards).

Recommendations for keeping trial and production cleanly separate in one database:
1. **Flag, not name.** Treat `organizations.trial_ends_at IS NOT NULL AND no paid subscription` as "trial". The "Demo N" name is a convenience only. An explicit `organizations.kind` ('trial' | 'customer' | 'internal_test'), added later as an additive column, would make this permanent and queryable.
2. **Reporting filters.** HQ dashboards and revenue already read subscriptions only. Any new studio, event or user count should exclude `is_demo` rows and trial-only studios by default.
3. **RLS already isolates** every studio by `org_id`, so trial users never see real studios. Keep it that way. No cross-org "shared demo" table.
4. **Your own test studios.** Before inviting clients, mark them `internal_test` (or ban their users, section 4) so they do not appear as customers.
5. **Expired-trial cleanup (later, opt-in).** After a grace period (for example 30 days read-only and unpaid), an HQ-only action can archive the studio, then clear its demo rows using the same `is_demo` + `org_id` rule. Never delete automatically without owner sign-off.
6. **Shared demo catalogue.** Each trial gets the same template inventory, vendors and packages from the seed functions. To change what trials see, edit the seed function, not existing rows.
