# Helm: Product Requirements Document (as built)

| Field | Value |
|---|---|
| Product | Helm ("Helm Events"), an operating system for event studios |
| Document | PRD describing the product that EXISTS on `origin/main` (17 Oct 2026) |
| Production | https://helm.events (Supabase project `nqltzgiwznphugcfhmbm`, see `public/config.js`) |
| Staging | https://helm-v01.vercel.app (`public/config.staging.js`) |
| Code basis | `public/*.html` (72 pages), `public/*.js`, `supabase/migrations/0001`–`0162` (latest definition wins), `supabase/functions/*` (20 edge functions), `vercel.json`, `server.js`, `test/` (247 files) |
| Related docs | `docs/product/PRD.md` (v2.0 forward-looking PRD, reused here), `docs/product/TRD.md`, `docs/product/APP-FLOW.md`, `docs/workflow/*`, `docs/RUNBOOK.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/CANONICAL-DEPLOYMENT.md`, `docs/AUTH-*.md` |

Conventions: **Assumption:** = not proven from code. **Decision needed:** = owner must decide. No secret values appear in this document; only the names of environment variables.

---

## 1. Problem

Small and mid-sized event studios (décor, wedding, corporate; roughly 3 to 40 people) run high-value, one-off projects on WhatsApp, Excel and paper. The same information is retyped at every stage:

| # | Today | Result |
|---|---|---|
| P1 | Enquiries live in chats and phones | Leads lost, slow replies |
| P2 | Quotes typed fresh in Excel | Prices drift, margins inconsistent |
| P3 | Clients cannot picture the venue | Long back-and-forth, lost deals |
| P4 | Approval is "OK on WhatsApp" | Scope and price disputes |
| P5 | Stock and crew double-booked | Shortages on event day |
| P6 | Vendor bills on paper | True profit unknown |
| P7 | Crew instructed by phone | Missed tasks, no proof of work |
| P8 | Money owed unclear | Cash-flow surprises |

## 2. Value proposition

**One record from enquiry to profit: the quote IS the event.** A lead converts into a quote; that same `quotes` row carries the floor plan, versions, proposal, client approval, payment milestones, plan, tasks, inventory reservations, vendor bills, settlement and closure P&L.

- A to-scale **2D/3D floor-plan builder that prices itself** (`builder.html`, `builder.js`, `builder-3d.js`).
- **Server-authoritative money**: totals, tax, overpayment guard and P&L are computed in Postgres (`enforce_no_overpayment_ms`, `event_pnl`, `business_pnl`; see `docs/product/PRD.md` §6.7).
- **Clients need no account**: token links for proposal, OTP approval, booklet, portal and invitation site.
- **Studio data is private**: every tenant table is filtered by `current_org_id()` and the per-role `has_area()` matrix in RLS.
- **Zero data loss**: records are voided/archived with a reason and audited, not hard-deleted (`audit_log` via `tg_audit`, extended in `0125`, `0135`).

## 3. Target users

| Persona | Helm role key(s) | Needs |
|---|---|---|
| Studio owner | `admin` | Pipeline, cash, profit, control of who sees money |
| Event manager | `manager` | Oversee events, settlement, closure (`0147`, `0152`) |
| Planner | `planner` | Fast quoting, builder, proposal, run sheet |
| Sales | `sales` | Never lose a lead, follow-ups, conversion |
| Ops leads | `coordinator`, `supervisor`, `quality`, `operations` | Stock, vendors, logistics, event-day command, issues |
| Designer | `designer` | Layouts, mood boards, design studio (defaults in `0143`) |
| Crew | `crew` (legacy `worker` merged into crew by `0143`) | Only their own tasks and schedule, on a phone |
| Client | `client` / token link | Proposal, approve, pay schedule, booklet, invitation |
| Helm HQ (platform operator) | HQ admin (MFA available, `0047`, `0158`) | Subscriptions, trials, invoices; no access to studio operational data |

Markets: India first (GST), with UAE VAT, UK VAT, US sales tax templates (`country-profile.js`, `test/country-tax.test.mjs`). **Decision needed:** launch market order and AED/GBP/USD pricing.

---

## 4. Core journeys and user stories

### J1 First-time studio owner
Landing (`index`) → `pricing` / `try` / `demo` → `login` (sign up: email+password or Google) → email confirmation → `checkout` (choose plan or trial) → `onboarding` wizard (profile, country → currency/tax, units, logo, price-list Excel import, packages, venues, team invites) → `dashboard` with getting-started checklist (`getting-started.js`) and tour (`tour.js`).

- As an owner I can start a trial with demo data and later "Start my own studio" without touching other studios' rows (`trial-demo.js`, `0126`–`0128`).
- As an owner I can invite my team by email (`invite-mailer` edge function, `0131`).

### J2 Enquiry to confirmed event
`leads` (create, stage, follow-up) → convert (`convert_lead_to_quote`) → `discovery` → `quotes` / `flow` (unified quote flow) → `builder` (layout + live price) → `proposal` (publish) → client opens `proposal-view` → `approve` (OTP + consent) → quote Confirmed → advance milestone recorded in `settlement`.

- As sales I convert a lead once; repeated clicks do not duplicate.
- As a planner every save creates a version; confirmation locks it; later edits become a change order needing re-approval.
- As a client I approve with a single-use, hashed, expiring code; the consent (time, version, text) is stored.

### J3 Plan and run
`event` workspace (lifecycle bar) → `plan` (`set_event_plan`) → `resources` → `inventory` reservations → `vendors` / `logistics` → `ops` task board (`assign_tasks`, dependencies, evidence) → crew `work` page/token → `runsheet` → `ready` gate → `command` (event day) + `issues` → `teardown` returns.

- As crew I see only my assignments and schedule (`crew-schedule.js`, `0161`), never money or client contacts.

### J4 Close the books
`settlement` (client invoice, milestones, vendor bills/payouts `vendor-bills-ui.js`, staff claims, refunds) → `closure` (`close_event`: blocked while balance owed or equipment checked out; admin may override with reason, stored in `event_close_overrides`, `0148`) → `business` / `reports` / `insights`.

### J5 Client
Proposal link → approve → `client`/`portal` (dues count confirmed events only, `0160`) → `booklet` → invitation site `/i/<slug>` (`invite.html`, built in `invite-studio.html`).

### J6 Platform (HQ)
`hq` console: studios, plans, trials, invoices (`hq.js`, `hq-invoice.js`, `0045`), checkout settings incl. the trial-bypass switch (`0162`).

---

## 5. Features and functional requirements

Status: **Live** = in code and on production; **Off** = built, switched off by flag; **Partial** = exists with known gaps.

| Module | Requirement (summary) | Status | Evidence |
|---|---|---|---|
| Auth | Email/password sign-up with strong-password rules and email confirmation; Google OAuth; password reset; failed-attempt lockout; optional TOTP two-step (admins not forced: `auth.mfaRequiredForAdmins=false`) | Live | `login.html`, `auth-ui.js`, `reset-password.html`, `0050`, `0158`, `docs/AUTH-PRODUCTION-HARDENING.md` |
| Auth | Cloudflare Turnstile bot protection | Off until enabled in Supabase | `public/config.js` |
| Session | App-side idle/max session limits | Off (0 = off, owner 2026-10-16) | `config.js auth.session` |
| Trial & billing | Self-serve trial (`start_self_serve_trial`), demo data, reminders, read-only after expiry, plan checkout; "Skip payment" bypass OFF on helm.events (client) and server (`0162`) | Live | `checkout.html`, `trial*.js`, `0126`–`0128`, `0159` |
| Billing | Razorpay subscription checkout + webhook | Off (`HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED`, `liveChannels.pay=false`) | `create-subscription-checkout`, `razorpay-subscription-webhook` |
| Dashboard | Money cards (hidden without finance area), Today strip, customise, global search (Cmd/Ctrl K), bell with deep links, privacy "Hide amounts" with server-side PIN (`0157`) | Live | `dashboard.html`, `shell-b-*.js`, `studio-search.js` |
| Sales | Lead pipeline, follow-ups, saved filters, guest-count range (`0149`), lead audit, CRM archive/restore (`0139`), nurture (anniversaries/dates, `0140`) | Live | `leads.html`, `crm.html`, `nurture.html`, `saved-filters.js` |
| Quotes | Auto codes `MMDDYYYY-NN`, packages, price list, discounts/coupons/caps, country tax after discount, versions, change orders, reprice banner, empty-draft cleanup (`0141`) | Live | `quotes.html`, `flow.html`, `item-pricing.js`, `test/numbering-integrity.test.mjs` |
| Builder | To-scale venue (m/ft), catalogue with dimensions and prices, snap, measure, 3D orbit, layout wizard, studio templates, venue picker | Live | `builder*.js`, `layout-wizard.js`, `venue-*.js` |
| Builder | Photo-realistic render (paid credits, `photo_render_usage`) | Owner-only | `render-photo` fn, `photo-render-*.js`. Engineers never trigger renders. |
| Proposal & approval | Proposal with mood board/scope; client-safe fields only; OTP approval with consent record; link windows | Live (OTP delivered by email/screen; SMS off) | `proposal.html`, `proposal-view.html`, `approve.html`, `send-otp` |
| Proposal via WhatsApp | Send proposal on WhatsApp | Off | `wa-proposal` fn, `wa-proposal.js`, `0151` |
| Event workspace | Lifecycle bar (Lead → Closed), discovery, plan, resources, inventory reservations/checkout/returns, vendors, logistics, ops tasks, run sheet, readiness gate, event-day command, issues, teardown, media gallery, resource calendar, crew schedule | Live (Partial: time-aware calendar deferred) | `event.html` … `teardown.html`, `calendar.html` |
| Money | Milestones + ledger, overpayment guard, settlement, vendor bills/payouts, staff claims, refunds, event & business P&L, closure gate with audited override | Live | `settlement.html`, `closure.html`, `business.html`, `0124`, `0146`, `0148` |
| Client-facing | Client 360 timeline, portal, booklet (+ snapshot fn), invitation sites with 5 templates, music, photos | Live | `client.html`, `portal.html`, `booklet*.js`, `invite*.html`, `booklet-snapshot` |
| Team | Team chat (conversations, mentions, attachments in private storage), staff directory, my tasks | Live | `chat.html`, `staff.html`, `work.html` |
| Admin | Control Center: role × area matrix (view/edit), users (invite, role change, deactivate), studio settings, channel identity (from-name / Reply-To, `0150`), data export, audit log, templates | Live | `control.html`, `control-split.js`, `audit.html`, `templates.html` |
| Integrations page | WhatsApp / email per-studio setup page | Hidden on live sites (`HELM_FEATURES.integrationsPage` true only on localhost) | `config.js`, `integrations.html` |
| Notifications | Email via Resend: welcome, invites, assignment notices (`0132`), event reminders (`0129`), billing reminders, security alerts, package notices | Built; each gated by its `HELM_*_ENABLED` flag | `welcome-mailer`, `invite-mailer`, `comms-dispatch`, `billing-reminder`, `security-alert-mailer`, `pkg-client-notify` |
| Uploads | Upload verification / AV scan with quarantine | Built, flag-gated (`HELM_UPLOAD_SCAN_ENABLED`) | `verify-upload` |
| Legal | Terms, Privacy, Cookies, AUP, DPA, Refund, Data deletion, Grievance/DPO, SLA, Sub-processors, Security, Accessibility, AI notice, Copyright | Live (Decision needed: final lawyer-reviewed text) | `public/*.html`, `legal.js` |

---

## 6. Non-functional requirements

| Area | What exists | Evidence |
|---|---|---|
| Security | RLS on tenant tables via `current_org_id()` + `has_area()`; SECURITY DEFINER RPCs with `search_path=''`; strict CSP, HSTS, COOP/CORP; Trusted Types; edge-function CORS allowlist (`ALLOWED_ORIGINS`); hashed OTPs and PINs | `vercel.json`, `server.js`, `trusted-types.js`, `_shared/cors.ts`, `0025`, `0136` |
| Privacy | No personal data in URLs; export and deletion pages; DPDP/UAE PDPL review | `data-deletion.html`, `docs/DATA-PROTECTION-REVIEW.md` |
| Data integrity | Forward-only, additive, idempotent migrations (`supabase/migrations/MANIFEST`); void-with-reason; audit trail | `docs/FILL-ONLY-MIGRATIONS.md` |
| Recovery | PITR backups and DR steps | `docs/DISASTER-RECOVERY-RUNBOOK.md` |
| Observability | Client telemetry, incident runbook | `telemetry.js`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md` |
| Performance | Static pages on Vercel CDN, no framework runtime, no build step. **Assumption:** targets LCP < 2.5 s on 4G, builder ~60 fps (from v2.0 PRD; not measured here) | `docs/STAGING-A11Y-PERF-PLAN.md` |
| Responsiveness | Mobile nav and mobile tables; 320 px+ | `mobile-nav.js`, `tables-mobile.js` |
| Accessibility | Target WCAG 2.2 AA; statement page | `accessibility.html` |
| Theme | Light only; dark mode off; default theme Emerald (owner fact) | `theme.css`, `shell-b-theme-*.css` |
| i18n | Any currency, country tax, m/ft, studio time zone; English UI only. **Decision needed:** Arabic/RTL, Hindi | `country-profile.js` |
| Availability | **Decision needed:** confirm SLA figure published on `sla.html` | `sla.html` |
| Testing | 247 unit/integration test files plus DB test suite | `test/`, `docs/DB-TEST-SUITE.md` |

---

## 7. Pages and screens (all 72 in `public/`)

Studio app pages are also reachable at `/<studio-slug>/<page>` via `vercel.json` rewrites; client links use `/<studio>/quote|proposal|portal|work|invite/<token>` and `/i/<slug>`.

### 7.1 Public / marketing
| Page | Purpose |
|---|---|
| `index.html` | Landing page ("Turn event chaos into seamless success") |
| `about.html`, `services.html`, `pricing.html` | Company, services, plans |
| `try.html` | Sandbox planner, no sign-up, no server writes |
| `demo.html` | Read-only fictional demo studio |
| `404.html` | Not found |

### 7.2 Auth, onboarding, billing
| Page | Purpose |
|---|---|
| `login.html` | Sign in / sign up / Google / two-step |
| `reset-password.html` | Set a new password |
| `profile-setup.html` | Complete profile after invite or OAuth |
| `checkout.html` | Choose plan / start trial |
| `sim-pay.html` | Simulated checkout (non-production testing) |
| `onboarding.html` | Studio setup wizard |

### 7.3 Studio workspace
| Page | Purpose | Main roles |
|---|---|---|
| `dashboard.html` | Home: money cards, Today, checklist, search, bell | all staff |
| `leads.html` | Leads and pipeline | sales, admin |
| `crm.html` | CRM archive / restore | sales, admin |
| `nurture.html` | Anniversary/birthday nurture | sales |
| `discovery.html` | Requirements capture | planner |
| `quotes.html` | Quotes and confirmations list | planner, manager, admin |
| `flow.html` | Unified quote flow (client → layout → price → payment) | planner |
| `builder.html` | 2D/3D floor-plan builder with live pricing | planner, designer |
| `design.html` | Design studio (mood boards, palettes) | designer |
| `proposal.html` | Build and publish proposal | planner |
| `budget.html` | Budget per event | admin, planner |
| `templates.html` | Checklist templates | admin |
| `event.html` | Event workspace and lifecycle bar | manager, planner |
| `plan.html` | Event details / plan | coordinator, operations |
| `resources.html` | Resource plan | coordinator |
| `inventory.html` | Stock, reservations, checkout/returns | operations |
| `vendors.html` | Vendors and partners | operations |
| `logistics.html` | Logistics and payments | operations |
| `ops.html` | Task board | operations, supervisor |
| `runsheet.html` | Run sheet | operations |
| `ready.html` | Readiness gate | manager |
| `command.html` | Event-day command | supervisor, operations |
| `issues.html` | Live issues | supervisor, quality |
| `teardown.html` | Teardown and returns | operations |
| `media.html` | Media gallery | planner, designer |
| `calendar.html` | Resource / crew calendar | all staff (crew: own only) |
| `staff.html` | Staff directory | admin, operations |
| `work.html` | My tasks (phone) | crew |
| `chat.html` | Team chat | all staff |
| `settlement.html` | Payments, invoice, vendor bills | manager, admin |
| `closure.html` | Closure and P&L | manager, admin |
| `business.html` | Business P&L | admin |
| `reports.html` | Reports and exports | admin |
| `insights.html` | Insights | admin, manager |
| `audit.html` | Audit log | admin |
| `control.html` | Control Center (roles, users, settings) | admin |
| `integrations.html` | Channel setup (hidden on live sites) | admin |
| `invite-studio.html` | Invitation-site builder | planner |
| `manual.html` | In-app user manual | all |
| `capture.html` | Internal image capture for proposals/booklets | system |
| `hq.html` | Helm HQ platform console | HQ only |

### 7.4 Client-facing (token, no account)
| Page | Purpose |
|---|---|
| `proposal-view.html` | View proposal |
| `approve.html` | Approve with OTP + consent |
| `client.html` | Client 360 (staff view of a client) |
| `portal.html` | Client portal for an event |
| `booklet.html` | Event booklet (plan, scope, dues) |
| `invite.html` | Public invitation site `/i/<slug>` |

### 7.5 Legal and trust
`terms`, `privacy`, `cookie-policy`, `acceptable-use`, `dpa`, `refund-policy`, `data-deletion`, `grievance`, `sla`, `subprocessors`, `security`, `accessibility`, `ai-notice`, `copyright`.

---

## 8. Roles and permissions

- **Tenant boundary:** every row has `org_id`; RLS compares it to `current_org_id()`. Cross-tenant reads return 0 rows (verified in `docs/workflow/ROLE-HANDOFF-MATRIX.md`).
- **Area matrix:** per studio, each role has view/edit per area (leads, quotes, finance, inventory, …); `has_area(area, mode)` is used inside RLS and RPCs. Admin always passes. Edited in Control Center; "Apply suggested access" fills defaults (`0143`).
- **Valid roles:** admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, client (`worker` still valid in DB but merged into crew, `0143`).

| Role | Typical default access (editable) |
|---|---|
| admin | Everything, incl. finance, users, settings, audit, privacy PIN |
| manager | Events, quotes (create, `0147`), settlement, closure (`0152`) |
| planner | Leads/quotes/builder/proposal/plan |
| sales | Leads, CRM, nurture, quotes view |
| coordinator / operations / supervisor / quality | Plan, resources, inventory, vendors, ops, command, issues; finance hidden unless granted |
| designer | Builder, design, media |
| crew | Own tasks and schedule only (`0153`, `0161`) |
| client | No studio tables; token-scoped RPCs only |

**Decision needed:** confirm the shipped default matrix per role is the intended launch default.

---

## 9. Data requirements

Core entities (see `docs/product/BACKEND-SCHEMA.md` for full schema):

| Entity | Notes |
|---|---|
| `organizations`, `profiles`, invitations, `role_access` | Studio, users, role matrix |
| `leads` | Audited; restore from CRM |
| `quotes` (= event), versions, change orders, `quote_consents` | One record per event |
| `layouts` | Builder plans (table name in `config.js`) |
| Payment milestones / ledger | Overpayment guarded |
| `event_tasks`, `crew_members` | Assignments; crew linked by `profile_id` or email |
| Inventory, reservations, checkouts | Atomic reservations |
| Vendors, vendor bills, payouts | Void with reason |
| `event_closure`, `event_close_overrides` | Closure and overrides |
| `event_sites` + `invite-media` bucket | Invitation sites |
| `audit_log` | Who/when/table/action/before/after |
| `helm_billing_settings`, `helm_hq_settings`, subscriptions | Platform (HQ) |
| `photo_render_usage` | Render credits |

Rules: org-scoped, additive migrations only, no hard deletes of business records, money stored with currency (`0142`), financial records retained as legally required.

---

## 10. Integrations

| Integration | Purpose | State | Secret / env **names** |
|---|---|---|---|
| Supabase (DB, Auth, Storage, Realtime, Edge Functions) | Backend | Live | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only) |
| Vercel | Static hosting, headers, rewrites | Live | `vercel.json` |
| Google OAuth | Sign-in | Live | Supabase Auth provider settings |
| Resend email | Sender `notifications@helm.events`; Reply-To = studio email | Built; flag-gated per mailer | `RESEND_API_KEY`, `RESEND_FROM`, `HELM_COMMS_ENABLED`, `HELM_WELCOME_EMAILS_ENABLED`, `HELM_INVITE_EMAILS_ENABLED`, … |
| Meta WhatsApp Cloud API | Messages, proposal send, webhook | **Off**; owner sets up separately | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_TEMPLATES` |
| Razorpay | Subscriptions + per-studio payment links | **Off** | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET` |
| MSG91 SMS | OTP by SMS | **Off** (`liveChannels.sms=false`) | per `send-otp` |
| OpenAI images | Photo render | Owner-only | `OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` |
| AV scanning | Upload scan | Flag-gated | `HELM_AV_URL`, `HELM_AV_TOKEN` |

When a channel is off the app simulates it (no external calls) so the product still works (`config.js`). Setup: `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/COMMS-AUTOMATION-SETUP.md`.

---

## 11. Loading, empty and error states

What exists (from `public/*.html`): ~105 `.empty` blocks, `.emptystate`/`.emptylist` variants, ~45 `.err` inline error areas, a `.loading` state, and shared helpers in `ui-kit.js` / `form-validate.js` / `load-fit.js`.

| State | Expected behaviour |
|---|---|
| Loading | Page shell renders immediately; lists show a loading line/skeleton until the first query returns |
| Empty | Plain-English message plus the next action (e.g. "No leads yet — Add lead"); demo-labelled records in trial studios |
| Validation error | Inline `.err` next to the field; country-aware phone validation (`phone-input.js`) |
| Permission denied | Nav hides areas the role cannot view; server returns 0 rows / refusal; page shows "no access" rather than blank |
| Server refusal | Friendly message plus hint from the RPC (e.g. close gate: collect balance or return equipment, or admin override) |
| Expired / invalid link | Client pages show a friendly expired message |
| Offline / network | **Assumption:** generic retry message; no offline mode |

**Decision needed:** a single standard loading/empty/error pattern across all pages (currently per-page).

---

## 12. MVP scope (launch on helm.events)

In: sign-up/trial/checkout (bypass off), onboarding, dashboard, leads/CRM, quotes/flow/builder (2D/3D), proposal + OTP approval, event workspace through event day, settlement, closure with gate, reports, client portal/booklet, invitation sites, team chat, Control Center + audit + export, email notifications from `notifications@helm.events`, legal pages, light Emerald theme.

Switched off at launch: Razorpay (subscriptions and payment links), SMS, WhatsApp, Integrations page on live sites, dark mode, mandatory admin MFA, app-side session timeout, Turnstile (until configured).

## 13. Out of scope

Native mobile apps; accounting/GST-VAT filing; ticketing; vendor marketplace; payroll; real-time co-editing of one floor plan; time-aware calendar with overlap conflicts (deferred); React/Next.js rewrite (attempted and discarded); quote→lead same-email overwrite fix (parked 2026-10-13).

## 14. Success criteria

| Goal | Measure | Target |
|---|---|---|
| Activation | Trial studios creating a real quote within 24 h | Decision needed (v2.0 PRD proposes ≥ 60 %) |
| Conversion | Trial → paid | Decision needed (proposed ≥ 15 %) |
| System of record | Paid studios closing ≥ 1 event/month in Helm | Proposed ≥ 70 % |
| Online approval | Confirmed events approved via link | Proposed ≥ 50 % |
| Money integrity | Client vs server price mismatches | 0 |
| Trust | Cross-tenant exposure incidents | 0 |
| Reliability | Data-loss incidents | 0 |

## 15. Open decisions

| # | Decision needed |
|---|---|
| D1 | Final plan prices per currency and when to switch Razorpay on |
| D2 | When to enable WhatsApp / SMS (`liveChannels`) after owner setup |
| D3 | Turn on mandatory admin MFA and session limits for launch? |
| D4 | Final lawyer-reviewed legal text per market |
| D5 | Default role matrix sign-off |
| D6 | Arabic/RTL for UAE |
| D7 | Photo render quota per plan |
| D8 | Data residency of the production DB for non-India clients (see `docs/` Mumbai plan) |
