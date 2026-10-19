# Helm API reference

This page describes the API surface Helm has today. It was checked against the code on `origin/main` (worktree `wt-docs`, 2026-10-17). Helm has **no custom REST backend in production**. The browser talks to three things:

1. **Supabase PostgREST**: table reads and writes, all guarded by Row-Level Security (RLS).
2. **Postgres RPC functions** (`supa.rpc(name, args)`). About 255 distinct functions are called from `public/*.js`.
3. **Supabase Edge Functions** (`/functions/v1/<name>`). There are 21, in `supabase/functions/`.

Provider webhooks (Razorpay, Meta) call edge functions directly. `server.js` is a local dev server only (see section 9).

Conventions: "Assumption:" marks something not fully proven from code. "Decision needed:" marks an owner choice. Secret **values** never appear on this page, only their **names**.

Related docs (reuse, do not duplicate): `supabase/functions/README.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/COMMS-AUTOMATION-SETUP.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/PHOTO-RENDER-SETUP.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/DATA-PROTECTION-REVIEW.md`, `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

---

## 1. Auth model

| Caller | Credential | What it can reach |
|---|---|---|
| **Anonymous visitor** (client approval link, booklet, portal, invitation site, crew work link) | Supabase **anon key** (public by design, in `public/config.js`) plus a **bearer token in the URL** (a UUID or hex string such as `p_token`) | Only the functions granted `to anon` (section 3.1). Each one checks the token itself: that it is live, unexpired and unrevoked. No table access. |
| **Signed-in studio member** (admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, client) | Supabase Auth **JWT** (email/password, Google OAuth, optional TOTP MFA) | Tables through RLS, plus functions granted `to authenticated`. Tenant scope is `current_org_id()`. Permission scope is `has_area(area, level)` from the configurable role matrix (`admin_get_role_access` / `admin_set_role_access`, legacy `supabase/phase29-role-access.sql`). |
| **Platform operator / HQ** | JWT plus an operator flag (`is_platform_operator`, `is_platform_admin`, `operator_mfa_required`) | HQ pages (`hq.html`, `hq.js`) and cross-studio billing functions. |
| **Edge function (server)** | `SUPABASE_SERVICE_ROLE_KEY` (injected by Supabase, never sent to the browser) | `service_role`-only functions (section 3.13), such as outbox claim/mark, payment settle and rate limiting. |
| **Cron / DB webhook** | Shared secret in the `x-helm-cron-secret` header (compared in constant time) | Mailer and dispatcher edge functions. |
| **Provider webhook** | HMAC signature header (section 6) | `razorpay-webhook`, `razorpay-subscription-webhook`, `wa-webhook`. |

How tenancy works:
- Every studio-owned row carries `org_id`. RLS policies compare it with `current_org_id()`.
- `SECURITY DEFINER` functions re-check org and role inside the function body. Migrations 0073 and later, plus `supabase/phase73-definer-org-isolation-final.sql`, cover this. See `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

Default privileges (0156 and earlier hardening): new functions in `public` are **not** executable by `anon` or `PUBLIC`. Each anon function has to be granted explicitly.

Account-level controls (Supabase dashboard; see `docs/AUTH-DASHBOARD-SETTINGS.md`):
- Email confirmation.
- Auth rate limits. The doc notes 30 emails per hour needs custom SMTP.
- Optional Cloudflare Turnstile (`config.captcha.siteKey`, empty means off).
- MFA lockout: 5 wrong codes lock code entry for 15 minutes (0050, `mfa_record_failure` / `mfa_lock_status`).

---

## 2. Request / response and error conventions

### 2.1 Client wrappers (`public/store-api.js`)
- **RPC:** `rpc(name, args)` wraps `supa.rpc`. Argument names use the `p_` prefix (for example `{ p_token, p_quote_id }`). Most functions return `jsonb` or a table row, and the wrapper throws the PostgREST error object (`code`, `message`, `hint`, `details`).
- **Edge functions:** `callFn(name, body)` at `store-api.js:2741`.
  - Always `POST` with a JSON body.
  - Sends `Authorization: Bearer <session access token>`, falling back to the anon key on public pages, plus an `apikey` header.
  - A non-2xx response throws `Error(j.error || "HTTP <status>")`.
- **Live versus simulated:** `config.liveChannels = { sms, pay, whatsapp }`. All three are `false` today: Razorpay, SMS and WhatsApp are off. While a flag is false, the app calls a simulated RPC instead of the edge function:

  | Action | Simulated RPC (flag off) | Edge function (flag on) |
  |---|---|---|
  | OTP | `request_otp` | `send-otp` |
  | Payment | `create_payment` | `create-payment-link` |
  | WhatsApp | `wa_request_otp` / `wa_proposal_prepare` with `p_simulate: true` | `wa-proposal` |

  On production hosts (`window.HELM_IS_PROD_HOST`) the simulated payment is refused with a plain message.

### 2.2 `friendlyError(err, {action, setupHint})` (`store-api.js:9122`)
Every UI error goes through this function. It never shows SQL or stack traces to end users. It checks these cases in order:

| Condition | Message shown |
|---|---|
| Auth error | "Your session expired — sign in again." |
| Offline / network failure | "Couldn't reach the server…" |
| `hint = money_frozen` (0046) | The DB message itself (a locked approved, paid or closed money record) |
| `hint = payment_pending` (0159) | "Choose a plan and complete payment… or start a free trial" |
| `hint = studio_suspended` or code `25006` | Studio is read-only (subscription suspended or trial ended) |
| `HL409` (blocked; an admin may override) / `HL428` (client must re-approve) (0052) | The DB message, shown as written |
| `22023` / `42501` whose message is a plain sentence | Shown as written (for example "Only an admin can re-open a closed event.") |
| `42501`, HTTP 403, RLS denial | "You don't have permission to …" |
| Missing table or function | Admins see a "migration not applied" notice. Other users see "feature isn't available yet". |
| Not found | "It may have been deleted, or you may no longer have access." |
| `23505` | Already exists |
| `23503` | Linked to other records |
| `23502` | Required field missing |
| `23514`, `22P02`, `22003`, `22007`, `22008` | Some values are invalid |
| `40001`, `40P01`, HTTP 409 | Someone else changed this at the same time |
| `57014`, HTTP 504/408 | The server took too long |
| HTTP 429 | Too many requests |
| HTTP 5xx | The server had a problem |
| `P0001` / plain message with no technical words | Shown as written |
| Anything else | "Something went wrong — please try again." |

Server-side convention: business rules `raise exception … using errcode = 'P0001' | '22023' | '42501' | 'HL409' | 'HL428', hint = '<machine hint>'`, and the message is written for people.

### 2.3 Edge function responses
- Errors are JSON `{ "error": "<short_code_or_sentence>" }` with a meaningful status:

  | Status | Meaning |
  |---|---|
  | 400 | Bad input |
  | 401 | Bad or missing secret, JWT or signature |
  | 403 | Not allowed |
  | 404 | Dormant webhook or snapshot |
  | 405 | Wrong method |
  | 413 | Body over the size cap |
  | 429 | Rate limited, with a `Retry-After` header |
  | 503 | Not configured, for example `render_not_configured` |

- Dormant functions answer **200 no-op** (`{status:"dormant"}`) or 404, so that cron jobs do not alarm.
- **CORS:** browser-called functions allow an exact origin list from `_shared/cors.ts`: `https://helm.events`, `https://www.helm.events`, `https://helm-v01.vercel.app` and `https://helm-alpha-nine.vercel.app`. There are no wildcard previews. Override with `ALLOWED_ORIGINS` or `EXTRA_ALLOWED_ORIGINS`. `ALLOW_LOCALHOST=1` is for dev or staging only. Every response sends `Vary: Origin`.
- **Body caps** (`_shared/limits.ts`): 16 KB for browser-called functions, 64 KB for webhooks. Bodies are read in a stream and abandoned once they pass the cap.

---

## 3. RPC functions by area

**Where definitions live.** The **latest migration wins** (`supabase/migrations/0001…0162`, order in `MANIFEST`). Some older functions are defined only in the root `supabase/*.sql` phase files, for example `create_quote` (`supabase/quotes.sql`) and `admin_set_role_access` (`supabase/phase29-role-access.sql`). `supabase/PENDING-SQL-ALL.sql` bundles these.

**Who may call.** Unless the "Anon" column says otherwise, a function is granted to `authenticated` only. Inside, it checks `current_org_id()` and the caller's `has_area(...)` level, or `can_edit`.

Assumption: argument lists below are summarised. The exact signature is the last `create or replace function` in the migrations.

### 3.1 Public token links (anon-callable)
Grants verified with `grant … to anon` in the migrations.

| Function | Purpose | Inputs → output |
|---|---|---|
| `public_get_quote` | Client approval page: quote, lines and studio branding. Flags a stale approval (0052). | `p_token uuid` → jsonb |
| `public_quote_paid_status` | Paid versus total, from the `quote_payments` ledger (0098) | `p_token` → jsonb |
| `request_otp` | Simulated OTP. Stores a bcrypt hash and returns a dev code only off production. | `p_token, p_phone` → jsonb |
| `verify_and_consent` | Checks the OTP, records consent (terms version, consent text, name, user agent) and approves the quote | 8 args → jsonb |
| `wa_request_otp`, `wa_verify_and_consent` | Approval code over WhatsApp or email, sent to the contact **on the quote** (0151) | token, channel… → jsonb |
| `create_payment` | Simulated payment link. Refused on production hosts by the client. | `p_token` → jsonb |
| `trial_test_mode_for_token`, `trial_test_approve` | Trial-studio test approval with no SMS or email (0128) | token… → bool / jsonb |
| `public_get_booklet`, `public_get_booklet_image`, `public_booklet_packages`, `public_booklet_pay_terms`, `public_booklet_studio` | Client booklet: content, images (stored in the DB, 0083), package choices, payment terms | `p_token` → jsonb |
| `public_booklet_otp_request`, `public_booklet_choose` | Booklet package choice, confirmed by code (0069, re-wrapped in 0156) | token, package, guests, note, otp → jsonb |
| `public_get_portal`, `public_portal_extras` | Client portal | token → jsonb |
| `public_get_proposal` | Proposal view (`/<studio>/proposal/<token>`) | token → jsonb |
| `public_event_site`, `request_site_slug` | Public invitation website `/i/<slug>` (phase87) | slug → jsonb |
| `public_link_studio`, `public_link_opened` | Branding for a link, and "link opened" tracking that drives follow-ups (0078) | kind, token |
| `invitation_preview` | Invitation landing details before sign-in | token → jsonb |
| `worker_respond`, `worker_respond_evidence`, `worker_evidence_upload`, `worker_checkin_equipment`, `worker_assignment_updates` | Crew work link (`/<studio>/work/<token>`): accept or decline, proof photos, equipment check-in | `p_token, p_task_id, …` → jsonb |

Decision needed: some booklet functions (`public_booklet_choose`, `public_booklet_otp_request`) were re-wrapped in 0156. The visible re-grant is to `authenticated`. Confirm on staging that anonymous booklet visitors can still choose a package. Assumption: an earlier anon grant carries over, or the booklet page holds a session.

### 3.2 Session, profile, onboarding, trial

| Function | Purpose |
|---|---|
| `current_org_id`, `my_auth_info`, `my_profile`, `my_profile_status`, `complete_my_profile`, `update_my_profile`, `set_my_display_name`, `set_my_avatar` | Who am I, plus my profile |
| `password_change_required`, `clear_password_change_required` | Forced password change for temp-password users |
| `mfa_lock_status`, `mfa_record_failure`, `mfa_record_success`, `operator_mfa_required` | MFA lockout and enforcement |
| `is_platform_admin`, `is_platform_operator` | HQ flags |
| `create_studio`, `my_studio_route`, `set_studio_link_name`, `my_studio_account`, `my_studio_account_update` | Studio (org) creation, URL slug, account details |
| `start_trial`, `start_self_serve_trial`, `my_start_trial`, `my_pending_start_trial`, `my_trial_status`, `my_trial_access`, `my_trial_org`, `set_trial_mode`, `trial_demo_choice` | 8-day free trial (0120) |
| `my_checkout_options`, `my_checkout_preview`, `my_checkout_status`, `my_subscription`, `my_invoice`, `my_pending` | Subscription checkout and billing (studio → Helm) |
| `seed_demo_data`, `reset_demo_data`, `clear_demo_data`, `my_demo_status` | Demo data (guarded by 0097) |
| `my_getting_started`, `my_getting_started_dismiss`, `my_dashboard_prefs`, `save_dashboard_layout`, `save_desk_notes`, `recent_list`, `recent_touch`, `saved_view_set_default` | UI preferences |

### 3.3 Team, roles, invitations (mostly admin)

| Function | Purpose / who |
|---|---|
| `create_invitation(p_email, p_role)` | **Admin only** (0156). Per-studio caps (0155): trial 20 a day / 50 open; paid 200 a day / 500 open. |
| `resend_invitation_email`, `invitation_by_token`, `accept_invitation(token)` | Invite flow. Accepting does not change the role of someone already in that studio (0156). |
| `admin_create_user`, `admin_create_user_temp`, `admin_delete_user`, `admin_set_role`, `admin_set_display_name`, `admin_update_member_profile`, `staff_set_login_role` | Admin user management |
| `admin_get_role_access`, `admin_set_role_access` | Per-role access matrix that drives `has_area` |
| `member_profile_list`, `studio_avatars`, `audit_actor_names`, `staff_departments`, `staff_department_add` | Team directory |
| `admin_get_notification_prefs`, `admin_set_notification_pref`, `admin_reset_notification_prefs`, `my_notification_prefs`, `my_notification_mutes`, `set_notification_mute` | Notification preferences |
| `privacy_pin_status`, `privacy_pin_set`, `privacy_pin_check`, `privacy_pin_reset` | Privacy PIN that hides money tiles |
| `phone_verify_status`, `phone_verify_check` | Member phone verification (the code is sent by `send-phone-code`) |

### 3.4 Leads and nurture

| Function | Purpose |
|---|---|
| `convert_lead_to_quote` | Lead → quote (the quote **is** the event) |
| `restore_archived_lead`, `set_discovery`, `client_timeline`, `resolve_client_ref` | Lead and client housekeeping |
| `nurture_due`, `queue_nurture_greeting`, `run_nurture_auto` | Nurture follow-ups |
| `smart_import_batch` | CSV / smart import (0088) |
| `studio_search` | Global search |

### 3.5 Quotes / events (core lifecycle)

| Function | Purpose |
|---|---|
| `create_quote`, `start_blank_quote`, `discard_empty_drafts` | Create a quote. Empty drafts are cleaned up (0141). |
| `add_quote_version`, `save_quotation_version`, `rebrand_quote_code` | Versions and quote code |
| `confirm_quote(p_quote_id, p_client jsonb, p_pricing jsonb)` | Confirms pricing. The **server is the pricing authority** (D8, phase99; role gate 0144). |
| `get_pricing_config`, `set_pricing_config`, `get_item_rate_cards`, `set_item_rate_card`, `apply_menu_template`, `add_event_dish`, `remove_event_dish`, `set_event_dish_qty` | Pricing, menus, dishes |
| `generate_approval_token`, `reissue_approval_link`, `admin_get_link_autoexpire`, `admin_set_link_autoexpire`, `admin_get_link_expiry_shelf`, `admin_set_link_expiry_shelf`, `link_expiry_shelf_tick` | Approval links and their expiry (0039) |
| `move_quote_to_shelf`, `restore_quote_from_shelf`, `list_quote_shelf` | Shelf (archive) |
| `set_lifecycle_stage` | Stage move. Can raise `HL409` / `HL428` (0052). |
| `set_proposal`, `publish_proposal` | Proposal |
| `create_event_group`, `refresh_event_group`, `event_group_index`, `resolve_event_ref`, `event_activity`, `list_event_files` | Grouping and event lookups |
| `studio_template_save`, `studio_template_duplicate`, `studio_template_set_default`, `studio_template_set_archived` | Studio templates |
| `venue_save`, `venue_set_active`, `venue_load_samples` | Venues for the floor-plan builder |

### 3.6 Client approval, booklet, packages, event sites (staff side)

| Function | Purpose |
|---|---|
| `booklet_share`, `booklet_current`, `booklet_revoke`, `booklet_put_image`, `booklet_set_image_variants`, `booklet_set_snapshot`, `booklet_image_info`, `booklet_staff_image` | Build and share the client booklet (0069, 0083) |
| `pkg_settings_get`, `pkg_settings_set`, `pkg_selection_list`, `pkg_selection_review` | Menu packages and review of the client's choice |
| `create_event_site`, `publish_event_site`, `event_site_live_until` | Digital invitation sites (phase87) |
| `wa_proposal_prepare`, `wa_proposal_state` | "Send on WhatsApp" status (simulated / sent / delivered / read / failed) (0151) |
| `photo_render_settings_get`, `photo_render_settings_set`, `photo_render_list`, `photo_render_job`, `photo_render_image`, `photo_render_use_in_booklet` | AI photo renders (0095). Owner-triggered only. |

### 3.7 Planning, run sheet, crew, tasks

| Function | Purpose |
|---|---|
| `set_event_plan`, `set_plan_lock`, `set_plan_signoff` | Plan and sign-off |
| `design_get`, `design_queue`, `design_advance` | Designer queue |
| `assign_tasks`, `assign_tasks_vendor`, `reassign_task`, `set_task_schedule`, `set_task_special`, `verify_task`, `task_verify_summary`, `run_task_reminders`, `run_task_triggers` | Tasks and quality verification |
| `my_tasks`, `crew_event_brief`, `crew_task_respond`, `crew_schedule` | Crew self-service (signed-in). These are **not** anon (0153). |
| `runsheet_group_status`, `runsheet_post_to_group` | Run sheet posted to group chat |
| `event_reminder_settings_get`, `event_reminder_settings_set`, `event_reminder_upcoming` | Event-approaching reminders (0129) |

### 3.8 Inventory and equipment

| Function | Purpose |
|---|---|
| `reserve_inventory`, `return_reservation`, `adjust_inventory_total` | Atomic reservations (0071) |
| `checkout_availability`, `checkout_equipment`, `checkout_equipment_smart`, `cancel_checkout`, `checkin_equipment` | Equipment checkout and check-in (0072) |

### 3.9 Money: payments, settlement, closure

| Function | Purpose |
|---|---|
| `record_payment`, `mark_paid`, `settle_milestone`, `record_settlement_payment` | Record client payments on the `quote_payments` ledger. Approved or paid records are frozen (`money_frozen`). |
| `payment_reminder_send_now` | Queues a client payment reminder (outbox → `comms-dispatch`) |
| `record_vendor_payout`, `vendor_payables_summary` | Vendor bills and payouts (0124) |
| `close_event_blockers`, `close_event(uuid, boolean, text)`, `reopen_event(uuid, text)`, `set_closure` | Closure gate. Override and reopen are admin-only and need a reason. |
| `save_org_payment_account` | The studio's own Razorpay account (0117). Credentials are read server-side by `org_razorpay_creds`. |

### 3.10 Dashboards and insights

| Function | Purpose |
|---|---|
| `dashboard_money`, `dashboard_money_for`, `dashboard_due_today` | KPI tiles. `dashboard_money_for` is not anon. |
| `insights_range(date, date)`, `insights_events`, `insights_events_ex_tax`, `business_pnl(date, date)`, `event_pnl` | Per-currency totals (0094), P&L (0124) |
| `bell_feed`, `bell_mark_seen`, `mgr_notify` | In-app notification bell |

### 3.11 Team chat

`chat_directory`, `chat_start_dm`, `chat_create_group`, `chat_add_members`, `chat_ensure_broadcast`, `chat_send`, `chat_react`, `chat_mark_read`, `chat_set_pref`, `chat_my_mentions` (0016 onwards). The `client` role is excluded from staff chat (0156).

### 3.12 Integrations, comms settings, data export

| Function | Purpose |
|---|---|
| `integrations_overview`, `my_integration_accounts`, `set_org_integration_status`, `save_org_whatsapp_account` | Integrations page (Control Center view/edit) |
| `comms_settings_get`, `comms_settings_set`, `studio_email_settings_get`, `studio_email_settings_set`, `my_wa_forward_get`, `my_wa_forward_set` | Messaging settings: Reply-To studio email, WhatsApp forwarding |
| `export_org_data`, `export_tenant_organization_package` | Studio data export (admin). Supports data-portability requests. |
| `upload_scan_status` | Upload virus/type-scan state |

### 3.13 Service-role only (called by edge functions, never by the browser)

| Area | Functions |
|---|---|
| Payments | `payment_link_begin`, `payment_link_attach`, `payment_link_fail`, `razorpay_settle`, `razorpay_settle_for_org`, `razorpay_record_event`, `org_razorpay_creds`, `hq_settle_provider_payment`, `checkout_attach_subscription`, `my_checkout_prepare` (as caller) |
| OTP / phone | `admin_store_otp`, `otp_send_authorize`, `wa_otp_begin`, `phone_verify_request` |
| WhatsApp | `whatsapp_authorize`, `notify_allowed`, `wa_recipient_opted_out` (STOP list, 0155), `wa_proposal_mark` |
| Outboxes (claim → send → mark) | `comms_outbox_claim/mark/email_identity`, `pkg_outbox_claim/mark`, `invite_email_outbox_claim/mark`, `invite_email_kick_org`, `welcome_email_outbox_claim/mark`, `security_alert_outbox_claim/mark`, `trial_reminder_email_claim/mark`, `assign_notify_claim/mark` |
| Uploads / renders | `upload_scan_claim/mark`, `booklet_snapshot_path`, `photo_render_begin` |
| Limits | `rate_hit(bucket, key, window_s, max)` (0050), `_a154_hit` (0154) |
| Integrations test | `integrations_test_target` |

---

## 4. Edge functions (`supabase/functions/*/index.ts`)

Every function is `POST` unless stated otherwise. "JWT" means the caller's own Supabase access token, used to run the check **as the caller** under RLS. "Cron secret" means the `x-helm-cron-secret` header.

| Function | Method | Auth | Purpose | Default state |
|---|---|---|---|---|
| `send-otp` | POST | Anon key + quote token | Sends the client approval code by SMS (MSG91) or by WhatsApp/email (0151), only to the contact **on the quote** | Off (`liveChannels.sms/whatsapp=false`) |
| `create-payment-link` | POST | Anon key + approval token | Creates a Razorpay Payment Link for an **approved** quote, using the studio's own account (0117) with the Helm account as fallback | Off (`liveChannels.pay=false`) |
| `razorpay-webhook` | POST | `X-Razorpay-Signature` HMAC | Settles client → studio payments and emails receipts | Fails closed with no secret |
| `create-subscription-checkout` | POST | JWT | Studio → Helm subscription via Razorpay Checkout. Has a `verify` action. | Dormant unless `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED=true` |
| `razorpay-subscription-webhook` | POST | HMAC (separate secret) | Settles Helm's own subscription charges | Dormant (same flag) |
| `send-whatsapp` | POST | JWT | Template WhatsApp messages (Meta Cloud API). Per-studio quota through `whatsapp_authorize`. | Off |
| `wa-proposal` | POST | JWT | "Send on WhatsApp" for proposals and payments | Simulated until WhatsApp secrets exist |
| `wa-webhook` | GET (verify) / POST (events) | `hub.verify_token` / `X-Hub-Signature-256` | Delivery status and inbound replies (STOP opt-out) | 404 until both secrets are set |
| `send-phone-code` | POST | JWT | Member phone-verification code on WhatsApp (0055) | Off |
| `comms-dispatch` | POST | Cron secret | Payment reminders, follow-ups, trial reminders and WhatsApp copies of bell notifications, from `comms_outbox` | Auto-on per channel when its secrets exist. Kill switch `HELM_COMMS_ENABLED=false`. |
| `pkg-client-notify` | POST | Cron secret | Package accepted or declined, booklet code, staff alerts (`pkg_outbox`) | Dormant unless `HELM_PKG_NOTIFY_ENABLED=true` |
| `invite-mailer` | POST | Cron secret **or** admin JWT (that studio only) | Staff invitation emails. Uses Resend if configured, otherwise Supabase Auth email. | On. Kill switch `HELM_INVITE_EMAILS_ENABLED=false`. |
| `invite-signup` | POST | Invitation token + email must equal `invitations.email` | Creates the invitee's account with no inbox step | Gated by `HELM_INVITE_DIRECT_SIGNUP` |
| `welcome-mailer` | POST | Cron secret | Welcome emails (`welcome_email_outbox`, 0057) | Dormant unless `HELM_WELCOME_EMAILS_ENABLED=true` |
| `security-alert-mailer` | POST | Cron secret | Security alerts to studio admins and HQ (0054) | Dormant unless `HELM_SECURITY_ALERTS_ENABLED=true` |
| `billing-reminder` | POST | Cron secret | Subscription due-soon and past-due emails | Dormant unless `HELM_BILLING_REMINDERS_ENABLED=true` |
| `verify-upload` | POST | Cron secret (DB webhook on `storage.objects` INSERT) | Claims pending uploads and checks magic bytes against extension, type and bucket allowlist. Optional AV scan and quarantine. | Dormant unless `HELM_UPLOAD_SCAN_ENABLED=true` |
| `render-photo` | POST | Staff JWT | AI event photo from builder snapshots (OpenAI Images edits). Usage and cost are tracked (0095). | 503 `render_not_configured` without the key. Owner-only. |
| `booklet-snapshot` | GET `?t=<token>&k=2d\|3d` | Booklet token | Legacy snapshot streaming. Not needed since 0083. | 404 unless `HELM_BOOKLET_SNAPSHOT_ENABLED=true` |
| `integrations-test` | POST `{action:"status"\|"test", channel}` | JWT (Control Center view / edit) | Shows which channels can send (booleans only), sends a test email to the caller and a test WhatsApp to the studio's own number | Always available |

Deploy note: webhooks (`razorpay-webhook`, `razorpay-subscription-webhook`, `wa-webhook`) are deployed with `--no-verify-jwt` because the providers call them. Every other function sits behind Supabase's JWT gateway (the anon key counts as a JWT).

---

## 5. External APIs

| Provider | Used by | Endpoint | Notes |
|---|---|---|---|
| **Resend** (email) | `razorpay-webhook`, `comms-dispatch`, `pkg-client-notify`, `invite-mailer`, `welcome-mailer`, `security-alert-mailer`, `billing-reminder`, `send-otp`, `integrations-test` | `POST https://api.resend.com/emails` | Sender is **notifications@helm.events**, with the studio name as display name and **Reply-To set to the studio's email** (`studio_email_settings_*`, `comms_outbox_email_identity`). Only the address part of `RESEND_FROM` is used. Outbox sends carry an `Idempotency-Key` (`comms-<id>`, `pkg-<id>`). With no `RESEND_API_KEY`, rows are marked `skipped`, not failed. |
| **Supabase Auth email / SMTP** | Sign-up, reset, magic link, invite fallback | Supabase dashboard | Custom SMTP is needed for real volume (`docs/AUTH-DASHBOARD-SETTINGS.md`). Decision needed: confirm the Auth SMTP sender also uses notifications@helm.events. |
| **Meta WhatsApp Cloud API** | `send-whatsapp`, `wa-proposal`, `send-otp`, `send-phone-code`, `comms-dispatch`, `pkg-client-notify`, `integrations-test` | `https://graph.facebook.com/<WHATSAPP_API_VERSION, default v21.0>/<WHATSAPP_PHONE_ID>/messages` | One Helm number ("Model 1"). Templates only, unless `WHATSAPP_ALLOW_TEXT=1` (24-hour window). Opt-in and STOP are honoured. The owner sets this up separately; it is **switched off** now. |
| **Razorpay** | `create-payment-link`, `create-subscription-checkout`, webhooks | `https://api.razorpay.com/v1/...` (Payment Links, Subscriptions) | Basic auth with key id and secret. Card/UPI data never touches Helm (Razorpay-hosted page or modal). **Switched off.** |
| **MSG91** (SMS OTP) | `send-otp` | `POST https://control.msg91.com/api/v5/flow/` | DLT sender and template. Non-India numbers are refused unless `MSG91_INTL=1`. **Switched off.** |
| **OpenAI Images** (photo render) | `render-photo` | Images edits endpoint | Timeout `RENDER_TIMEOUT_MS`, model `OPENAI_IMAGE_MODEL`. Per-studio usage in `photo_render_usage`. Claude never triggers renders. |
| **AV scanner** (optional) | `verify-upload` | `HELM_AV_URL` (host must be in `HELM_AV_ALLOWED_HOSTS`) | Bearer `HELM_AV_TOKEN`. Assumption: no scanner is configured in production. |
| **Cloudflare Turnstile** | Login, sign-up, reset | Supabase-verified | Off (`siteKey` empty) |

---

## 6. Webhooks and signature verification

| Webhook | Verification | Replay / safety |
|---|---|---|
| `razorpay-webhook` | `HMAC-SHA256(RAZORPAY_WEBHOOK_SECRET, rawBody)` compared in constant time with `X-Razorpay-Signature`. A malformed `?org=` gives 401 (per-studio accounts, 0117). | Settles through `razorpay_settle` / `razorpay_settle_for_org`, which are idempotent on the provider payment id. Events are logged by `razorpay_record_event`. Assumption: duplicate deliveries are no-ops at the DB level. |
| `razorpay-subscription-webhook` | Same scheme with `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`. Unset secret gives 401. | Events older than `RAZORPAY_EVENT_MAX_AGE_SEC` are rejected |
| `create-subscription-checkout` `verify` | `HMAC(key_secret, payment_id + "|" + subscription_id)`, constant time; the subscription must belong to the caller's studio | Only for an early "payment received" message. The webhook stays the source of truth. |
| `wa-webhook` | GET: `hub.verify_token` matched in constant time, and the challenge must be `[A-Za-z0-9_-]{1,200}`. POST: `"sha256=" + HMAC(WHATSAPP_APP_SECRET, rawBody)` compared with `X-Hub-Signature-256`. | 404 until both secrets exist |
| Cron / DB webhooks | `x-helm-cron-secret` compared in constant time (`secretMatches`). Unset secret means every call gets 401. | The body is ignored. Work is **claimed from the DB**, so a caller cannot choose a bucket or path. |

---

## 7. Rate limiting

- **Edge functions** (`_shared/limits.ts` `checkLimits`):
  - First an in-memory fixed window per isolate. Keys are hashed, so no raw IP, phone or token is held.
  - Then the durable `rate_hit(bucket, key, window_s, max)` limit, shared across isolates.
  - `HELM_DURABLE_RATE_LIMIT=on|off` (default on).
  - `HELM_RATE_LIMIT_FAIL_CLOSED` (r21): by default a DB error is a 429 (fail **closed**). The one exception is a database without `rate_hit` (migration 0050 missing): that fails open with a loud log line. `false` = fail open (the in-memory limit still applies). `true` = strict (closed even when `rate_hit` is missing).
  - Responses are 429 with `Retry-After`.
- **Database limits:**
  - OTP attempts and expiry (`admin_store_otp`, `request_otp`).
  - Per-studio WhatsApp quota (`whatsapp_authorize`).
  - Invitation caps (0155).
  - MFA lockout (0050).
  - Public-link hit limiter `_a154_hit` (0154).
- **Phone codes:** `PHONE_CODE_GLOBAL_PER_DAY` (default 2000), `PHONE_CODE_ORG_PER_DAY` (default 50), `PHONE_CODE_HOME_CC` (default `91,971`).
- **Supabase Auth:** dashboard rate limits (see `docs/AUTH-DASHBOARD-SETTINGS.md`).
- **`server.js` `/api/*`:** per-client limit returning 429 (dev only).

---

## 8. Pagination and filtering

- **List pages** use `sbPage(query, {limit, offset})` (`store-api.js` around line 2164).
  - Page size is `config.pageSize`, default 25, clamped between 5 and 200. A caller limit is capped at 500.
  - The query fetches `limit + 1` rows, so `hasMore` needs no COUNT. `total` is returned only when `{count:"exact"}` was asked for.
- **Full lists** use `sbAll(build)`. It walks `.range()` in 1000-row chunks up to 20,000 rows. Beyond that the result is flagged `truncated = true` and a warning is logged; rows are never cut silently. The query must be ordered with a unique tie-breaker such as `id`.
- **Search:** `likeTerm` / `orIlike` escape `\ % _`, drop `*`, cap the term at 100 characters, and double-quote values inside `or=(…)`.
- **Ranges:** money and insight functions take `(date, date)`, for example `insights_range` and `business_pnl`.
- **Tenant filter:** applied by RLS and `current_org_id()`, never by the client.

---

## 9. `server.js` (local only)

`server.js` is a zero-dependency Node dev server. It serves `public/` with the same security headers as `vercel.json` (`test/headers-parity.test.mjs`), plus a legacy layouts API that writes to `data/layouts.json`:

- `GET /api/health`
- `GET` / `POST /api/layouts`
- `GET` / `PUT` / `DELETE /api/layouts/:id`

It binds to `127.0.0.1` by default. Non-loopback use needs `LAYOUTS_API_TOKEN`. It sends no CORS headers. It is **not deployed**: production is static Vercel (`vercel.json`, `outputDirectory: public`). Clean-URL rewrites map `/<studio>/quote|proposal|portal|work|invite/<token>` and `/i/<slug>` to their pages.

Env: `PORT` (default 4173), `HOST`, `LAYOUTS_API_TOKEN`.

---

## 10. Required environment variable / secret NAMES

Supabase injects these automatically: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

| Group | Names |
|---|---|
| App | `APP_URL` (prod `https://www.helm.events`), `ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST` |
| Email | `RESEND_API_KEY`, `RESEND_FROM`, `MANAGER_EMAIL`, `HELM_SECURITY_ALERT_HQ_TO` |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATES`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_REQUIRE_OPTIN`, `WHATSAPP_TPL_LANG`, `WHATSAPP_VERIFY_TEMPLATE`, `WHATSAPP_VERIFY_LANG`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `PKG_WHATSAPP_TEMPLATE` |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `PAYMENT_LINK_TTL_MINUTES`, `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED` |
| SMS | `MSG91_AUTHKEY`, `MSG91_SENDER`, `MSG91_OTP_TEMPLATE_ID`, `MSG91_INTL` |
| Cron secrets and flags | `HELM_COMMS_SECRET` / `HELM_COMMS_ENABLED`, `HELM_PKG_NOTIFY_SECRET` / `HELM_PKG_NOTIFY_ENABLED`, `HELM_INVITE_EMAIL_SECRET` / `HELM_INVITE_EMAILS_ENABLED`, `HELM_WELCOME_EMAIL_SECRET` / `HELM_WELCOME_EMAILS_ENABLED`, `HELM_SECURITY_ALERT_SECRET` / `HELM_SECURITY_ALERTS_ENABLED`, `HELM_BILLING_CRON_SECRET` / `HELM_BILLING_REMINDERS_ENABLED`, `HELM_UPLOAD_SCAN_SECRET` / `HELM_UPLOAD_SCAN_ENABLED`, `HELM_INVITE_DIRECT_SIGNUP`, `HELM_BOOKLET_SNAPSHOT_ENABLED` |
| Batch sizes | `COMMS_BATCH`, `PKG_NOTIFY_BATCH`, `INVITE_EMAIL_BATCH`, `WELCOME_EMAIL_BATCH`, `SECURITY_ALERT_BATCH`, `BILLING_REMINDER_BATCH`, `UPLOAD_SCAN_BATCH` |
| Uploads / AV | `HELM_AV_URL`, `HELM_AV_TOKEN`, `HELM_AV_ALLOWED_HOSTS`, `HELM_AV_TIMEOUT_MS`, `HELM_UPLOAD_QUARANTINE` |
| Render | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL`, `RENDER_TIMEOUT_MS`, `RENDER_COST_USD_*` |
| Rate limits | `HELM_DURABLE_RATE_LIMIT`, `HELM_RATE_LIMIT_FAIL_CLOSED`, `PHONE_CODE_GLOBAL_PER_DAY`, `PHONE_CODE_ORG_PER_DAY`, `PHONE_CODE_HOME_CC` |
| Frontend (public, `public/config.js`) | `url`, `anonKey` (public), `liveChannels.{sms,pay,whatsapp}`, `captcha.siteKey`, `onboarding.allowPaymentBypass` (off on helm.events), `pageSize`. Staging uses `config.staging.js`. |

Decision needed: the README example shows `RESEND_FROM` with `events@helm.events`, but the owner fact is **notifications@helm.events**. Set `RESEND_FROM` to the notifications address on both prod and staging.

---

## 11. Privacy and failure handling

**Privacy**
- No secret reaches the browser: provider keys exist only as edge-function secrets. `integrations-test` returns booleans, never keys.
- Messages go only to contacts **on file**: the phone or email on the quote, the caller's own login email, the studio's own number. A caller cannot redirect them.
- WhatsApp needs opt-in (stored with its consent text). STOP replies are honoured both at claim time and immediately before each send (0155).
- `MANAGER_EMAIL` copies contain **no tenant data**. Studio receipts go to `organizations.business_email`.
- Rate-limit keys are hashed, and log lines carry no IP, key or phone.
- Consent records (terms version, consent text, user agent, timestamp) are kept for approvals. See `docs/DATA-PROTECTION-REVIEW.md` and `docs/INDIA-AUDIT-2026-10.md`.
- Card and UPI data are handled only by Razorpay (PCI-DSS).
- Data export is available through `export_org_data` / `export_tenant_organization_package`.

**Failure handling**
- **Fail closed:** a missing secret means 401 or 404, and a missing RPC means the call is refused.
- **Dormant by default:** flags plus `liveChannels`, with a simulated path so the app works without providers.
- **Outbox pattern:** DB rows are claimed, sent, then marked `sent`, `failed` or `skipped`, with idempotency keys. A failed provider call does not lose the record.
- **Payments:** the webhook is the source of truth. Settlement RPCs are idempotent, and money records freeze after approval or payment.
- **Rate limiter:** fails closed by default since r21 (`HELM_RATE_LIMIT_FAIL_CLOSED=false` turns that off).
- **UI:** shows `friendlyError` text only.
- Monitoring and incident steps: `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`.

Decisions needed:
- (a) When to flip `liveChannels.pay`, `.sms` and `.whatsapp`, and the matching server flags.
- (b) Whether to set `HELM_RATE_LIMIT_FAIL_CLOSED=true` on production.
- (c) Whether to enable the welcome, security-alert, billing-reminder and upload-scan crons. Each needs its secret and a scheduler.
- (d) Whether to remove the legacy `booklet-snapshot` function.
