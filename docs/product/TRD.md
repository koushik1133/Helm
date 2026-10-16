# Helm: Technical Requirements Document (TRD)

| Field | Value |
|---|---|
| **Document** | Technical Requirements Document and architecture description |
| **Version** | 2.0 (rewrite to the arc42 structure) |
| **Date** | 16 October 2026 |
| **Status** | Draft for owner review. **[OWNER TO FILL]** marks business decisions. |
| **Environments** | **Production** Supabase `nqltzgiwznphugcfhmbm` (migrations through 0115; re-verify) · **Staging** Supabase `xizehqgeyjcfpzrdymly` (through 0124; 0125 pending) · **Local** `node server.js` (port 4401 in QA) |
| **Companion documents** | [PRD.md](PRD.md) · [USER-MANUAL.md](USER-MANUAL.md) · `docs/TECHNICAL-HANDOFF.md` · `docs/DISASTER-RECOVERY-RUNBOOK.md` · `docs/INCIDENT-RESPONSE-RUNBOOK.md` · `docs/OBSERVABILITY-ACTIVATION.md` · `supabase/migrations/MANIFEST` |

> **Structure.** Sections 1 to 12 follow the twelve arc42 sections (introduction and goals, constraints, context, solution strategy, building blocks, runtime, deployment, cross-cutting concepts, decisions, quality, risks, glossary). Sections 13 to 16 add what a Google-style design doc and ISO/IEC/IEEE 29148 expect for operations: testing, observability, release and migration process, backup and disaster recovery. Requirement IDs (`TR-...`, `QR-...`) are verifiable.

---

## 1. Introduction and goals

### 1.1 Requirements overview
Helm is a multi-tenant SaaS for event studios. Functional scope is defined in [PRD.md](PRD.md) (modules M1 to M12, requirements `FR-...`). This document defines how the system is built and the technical requirements it must satisfy.

### 1.2 Top quality goals

| Priority | Quality goal | Scenario (summary) |
|---|---|---|
| 1 | **Tenant isolation and security** | A user of studio A can never read or change studio B's rows, even with a crafted API call. |
| 2 | **Data integrity (zero data loss, money correctness)** | A tampered browser total is ignored; a payment beyond the agreed total is refused; no money row is ever deleted. |
| 3 | **Performance on real networks** | An Indian user on 4G sees the dashboard usable within 2.5 s. |
| 4 | **Operability** | A migration can be applied to staging, verified, then to production with a VERIFY script, without downtime. |
| 5 | **Usability on any device** | Crew complete tasks on a 360 px phone; planners build layouts on a laptop. |

### 1.3 Stakeholders

| Role | Expectation from this document |
|---|---|
| Owner / product | Know what is live, what is risky, what needs a decision. |
| Engineers (human or AI agents) | Rules for code, migrations, security, tests. |
| Auditors / security reviewers | Trust boundaries, controls, evidence. |
| Studio IT / enterprise customers | Data location, backup, isolation guarantees. |

---

## 2. Architecture constraints

| ID | Constraint | Type | Rationale |
|---|---|---|---|
| C1 | Front end is static HTML/CSS/vanilla JS, **no framework, no build step**. | Technical | React/Next.js migration attempted and discarded (ADR-002). |
| C2 | Strict CSP: no `'unsafe-inline'` in `script-src`; inline scripts allowed only by SHA-256 hash; no `style=""`, no inline event handlers, no `javascript:` URLs. | Security | XSS defence (ADR-005). |
| C3 | Database migrations are **forward-only, additive and idempotent**; the order is fixed by `supabase/migrations/MANIFEST`. | Organisational | Zero-data-loss rule. |
| C4 | Every SQL pasted into the Supabase editor must be paste-safe: no temp tables or session state. | Operational | Editor runs statements independently. |
| C5 | Production changes only after staging verification and explicit owner approval; work stays local until the owner says push. | Organisational | Change control. |
| C6 | Secrets live only in Supabase secrets / Vercel env; nothing secret in `public/`. | Security | Browser is untrusted. |
| C7 | Photo renders are triggered only by the owner. | Cost | Paid credits per render. |
| C8 | Hosting: Vercel (static) + Supabase (ap-south-1, Mumbai). | Technical | Current contracts. |

---

## 3. System scope and context

### 3.1 Business context

```
            Visitors / prospects ──► Landing, /try, /demo
                                         │
 Studio users (owner, planner, sales, ───┤
 ops, crew) on laptop / phone            ▼
                                   ┌───────────┐
 Clients (link + OTP, no login) ──►│   HELM    │◄── Helm HQ operators (MFA)
 Guests (invitation site /i/slug) ►│           │
                                   └─────┬─────┘
       ┌──────────────┬───────────┬──────┴───────┬──────────────┬─────────────┐
   Google OAuth   SMTP email   Razorpay      Meta WhatsApp   Image-gen API   SMS/phone OTP
   (sign-in)      (mailers)    (billing;     Cloud API       (photo render,  provider
                               payment links (dormant)       owner-only)
                               dormant)
```

| Partner | Data exchanged | Direction |
|---|---|---|
| Studio users | All studio records within their role's areas | In/out |
| Clients | Proposal, approval OTP + consent, booklet, payments due | In/out via token RPCs |
| Guests | Invitation content, RSVP | In/out via site slug |
| Google | Identity token | In |
| Razorpay | Subscription and payment-link events (HMAC-signed webhooks) | In/out |
| Meta WhatsApp | Template messages and delivery webhooks | Out/in (dormant) |
| SMTP provider | Welcome, trial, billing, security-alert email | Out |
| Image generation | Layout prompt and image | Out/in (owner only) |

### 3.2 Technical context

| Channel | Protocol | Notes |
|---|---|---|
| Browser to Vercel | HTTPS (HSTS) | Static pages, headers and CSP from `vercel.json`. |
| Browser to Supabase | HTTPS REST (PostgREST), RPC, WebSocket (Realtime) | Anon key + user JWT; all access governed by RLS. |
| Browser to Edge Functions | HTTPS | OTP, uploads, payment links, render. |
| Third parties to Edge Functions | HTTPS webhooks | HMAC verified, timing-safe compare, idempotency keys. |

---

## 4. Solution strategy

| Goal | Strategy |
|---|---|
| Isolation | `org_id` on every tenant table; RLS policies `org_id = current_org() AND has_area(...)`; SECURITY DEFINER functions re-check org with pinned `search_path`; anon role has no table grants. |
| Money integrity | Business rules in PL/pgSQL RPCs; client totals ignored; triggers enforce overpayment guards; void-with-reason instead of delete; read-only P&L views. |
| One record | `quotes.id` is the spine for every event-related table (ADR-001). |
| Speed | No framework runtime; CDN-cached static assets; batched RPCs; parallel loads; three.js only on builder pages. |
| Safety in change | MANIFEST-ordered migrations with paired APPLY/VERIFY scripts; CI guards; staging first. |
| Integrations | Edge functions behind feature flags (`liveChannels`), fail-closed until configured (ADR-007). |

---

## 5. Building block view

### 5.1 Level 1: containers

| Container | Technology | Responsibility | Location |
|---|---|---|---|
| Web client | 66 static HTML pages, vanilla JS, per-page CSS | UI for every persona | `public/` |
| Data gateway | `public/store-api.js` (`BPStore`, `auth`) | Single client API: Supabase tier in the app, `localStorage` tier for `/try` sandbox; role helpers (`canView`, `canEditArea`, `ROLE_LABELS`) | `public/store-api.js` |
| Builder engine | `builder.js` (2D canvas), `builder-tools.js`, `builder-3d.js` (three.js, pinned CDN version) | Floor plan, pricing of placed items, 3D | `public/` |
| Database | Supabase Postgres (CI canon tests on Postgres 17) | Tables, RLS, RPCs, triggers, views | `supabase/migrations/` |
| Auth | Supabase Auth | Email/password, Google OAuth, email confirmation, sessions | Supabase |
| Storage | Supabase Storage (private buckets, signed URLs) | invite media, event docs, evidence, chat attachments, manual | Supabase |
| Realtime | Supabase Realtime | Chat, notifications | Supabase |
| Edge functions (Deno) | 17 functions | Integrations and secret-holding work | `supabase/functions/` |
| Local server | `server.js` (Node, no deps) | Serves `public/` locally, mirrors Vercel headers | repo root |

Edge functions: `billing-reminder`, `booklet-snapshot`, `comms-dispatch`, `create-payment-link`, `create-subscription-checkout`, `pkg-client-notify`, `razorpay-subscription-webhook`, `razorpay-webhook`, `render-photo`, `security-alert-mailer`, `send-otp`, `send-phone-code`, `send-whatsapp`, `verify-upload`, `wa-webhook`, `welcome-mailer`, plus `_shared` helpers.

### 5.2 Level 2: data model (domain groups)

```
organizations 1─* profiles (user → org, role)
organizations 1─* leads ──(convert)──► quotes   ◄── THE EVENT
quotes 1─* quotation_versions / quote_versions
quotes 1─1 event_discovery, event_proposal, event_plan, event_day, event_closure
quotes 1─* event_requirements, proposal_risks, quote_consents, quote_otps
quotes 1─* payment_milestones, quote_payments, change_requests, event_refunds
quotes 1─* event_tasks ─* task_evidence ; work_tokens
quotes 1─* event_resource_needs, event_resources ; inventory_reservations, inventory_checkouts ─► inventory_items
quotes 1─* vendor_bills 1─* vendor_payouts ─► vendors (0124)
quotes 1─* run_sheet_items, event_checklist, event_guests, event_attendees, event_stock_requests,
           event_issues, event_media, event_ratings, expense_claims, event_costs
quotes 1─1 client_booklets ─* client_booklet_images ; event_sites (/i/<slug>)
organizations 1─* venues, menu_templates, dish_catalog, item_rate_cards, tax_rules, coupons,
                 studio_layout_templates, task_templates, checklist_templates, nurture, nurture_templates
organizations 1─* chat_conversations ─* chat_messages ; notifications ; audit_log
organizations 1─1 studio_subscriptions, studio_account, org_payment_accounts (0117)
```

| Group | Tables |
|---|---|
| Tenancy and identity | organizations, profiles, member_profiles, role_access, platform_admins, studio_account, studio_consent_log |
| Sales | leads, lead_archive, nurture, nurture_automation, nurture_templates, saved_views |
| Quote and pricing | quotes, quotation_versions, quote_versions, item_rate_cards, menu_templates, package_selections, dish_catalog, plate_types, chair_types, coupons, tax_rules, layouts, layout_rules, studio_layout_templates |
| Approval and client | quote_otps, quote_consents, client_booklets, client_booklet_images, client_link_issued, client_link_opens, event_sites, invitations, event_attendees |
| Operations | event_plan, event_tasks, task_templates, task_evidence, work_tokens, crew_members, event_resource_needs, event_resources, vendors, venues, run_sheet_items, event_checklist, checklist_templates, event_guests, event_day, event_issues, event_stock_requests |
| Inventory | inventory_items, inventory_reservations, inventory_checkouts, inv_shortage_alerts |
| Money | payment_milestones, quote_payments, change_requests, event_costs, expense_claims, event_refunds, vendor_bills, vendor_payouts, payment_reconciliation, event_closure |
| Collaboration | chat_conversations, chat_members, chat_messages, chat_reactions, chat_prefs, notifications, notification_prefs, notification_mutes, notification_seen |
| Platform | studio_subscriptions, subscription_payments, helm_plans, helm_plan_prices, trial_reminders, billing_reminders, welcome_email_outbox, comms_outbox, org_payment_accounts, org_whatsapp_accounts |
| Security and audit | audit_log, auth_password_attempts, auth_rate_hits, auth_mfa_attempts, security_alert_events, storage_upload_log, upload_scans, photo_render_usage |

The authoritative column-level schema is the migration set; a dedicated backend schema document is **[OWNER TO FILL: link when produced]**.

---

## 6. Runtime view (key sequences)

### 6.1 Sign-up and trial

```
User        Browser(login.html)      Supabase Auth        Postgres (RPC)              Edge/mailer
 │ fill form ─►│ validate password      │                     │                          │
 │             │──signUp(email,pw)─────►│ create user, send   │                          │
 │             │                        │ confirmation email  │                          │
 │ click link ─────────────────────────►│ confirm, session    │                          │
 │             │──my_start_trial()──────────────────────────►│ create org + profile     │
 │             │                        │                     │ seed Demo rows (is_demo)  │
 │             │                        │                     │ welcome_email_outbox ───►│ welcome-mailer
 │             │◄── dashboard (demo) ───────────────────────── │                          │
 │  (hourly) trial_reminders_tick(): day 5/7/8 in studio tz → bell + outbox ───────────► │
 │  "Start my own studio": my_demo_status() counts → confirm → fresh org (others untouched)
```
Requirements: TR-RT-01 the trial seed is idempotent; TR-RT-02 read-only trigger `tg_studio_read_only` blocks writes after expiry without deleting data.

### 6.2 Quote to approval

```
Planner ─► quotes.html: create from lead (single quote per conversion)
        ─► builder.html: place items; client preview total
        ─► quote save (D8 pricing trigger/RPC): server recomputes (items→adjustments→fixed→%→coupon→cap→tax→round),
           ignores client total, writes quote_versions
        ─► proposal.html: "Send approval link" → client_link_issued (+ window/expiry)
Client  ─► approve.html?token: request OTP → send-otp (hash stored in quote_otps, TTL, single use)
        ─► submit OTP + consent → approval RPC (token from generate_approval_token): verify hash, not expired, not used;
           insert quote_consents; lock version; status Confirmed; audit_log
        ─► later scope change → change_requests → re-approval required
```

### 6.3 Payment and settlement

```
Manager ─► settlement.html: add milestone / record payment
        ─► trigger enforce_no_overpayment_ms: sum(other paid milestones) + this ≤ confirmed total + approved changes
           (each payment counted once, 0125) → else raise
[Dormant] create-payment-link → Razorpay link → client pays → razorpay-webhook (HMAC, idempotent) → quote_payments
Vendor bill ─► vendor_bills insert ─► record_vendor_payout(bill, amount, idem_key): refuses overpay, idempotent
Reports     ─► event_pnl / vendor_payables_summary / business_pnl (read-only views, ex-tax)
Closure     ─► close_event RPC → event_closure, archive, nurture reminder
               (server-side open-balance gate: open item, see section 11)
```

### 6.4 Crew task

```
Manager ─► ops.html: create task (deps, due, assignee) → notification
Crew    ─► work.html (signed-in) or token link (work_tokens, scoped to that crew member)
        ─► accept/decline → status change (RLS: only own tasks)
        ─► complete: upload photo → verify-upload (size/type, quarantine/scan) → task_evidence
Supervisor ─► verify → task closed; audit_log
```

---

## 7. Deployment view

```
 GitHub repo (main) ──push (owner only)──► Vercel
   ├─ static site: public/** , headers + CSP + rewrites (vercel.json)
   ├─ Preview / staging: helm-v01.vercel.app  → config.staging.js → Supabase staging
   └─ Production domain [OWNER TO FILL]       → config.js         → Supabase production
 Supabase (ap-south-1 Mumbai)
   ├─ production  nqltzgiwznphugcfhmbm
   └─ staging     xizehqgeyjcfpzrdymly
 Edge functions: `supabase functions deploy <name>`; secrets: `supabase secrets set`
 CI: GitHub Actions — ci.yml, codeql.yml, db-canonical-pg17.yml, db-tests.yml, e2e.yml, lighthouse.yml
```

| Node | Environment mapping | Notes |
|---|---|---|
| Vercel CDN | Global edge | `framework: null`, static only. |
| Supabase production | Mumbai | PITR required **[OWNER TO FILL: confirm plan/add-on enabled]**. |
| Supabase staging | Mumbai | Built from read-only production schema extraction. |
| Local | Developer machine | `node server.js`; QA port 4401. |

Environment separation is enforced: production CSP excludes the staging origin; config router picks `config.js` or `config.staging.js` by host; CI `check-env-safety`.

---

## 8. Cross-cutting concepts

### 8.1 Multi-tenancy
- Every tenant table has `org_id uuid NOT NULL` referencing `organizations`; `profiles` maps `auth.uid()` to `org_id` and `role`; `current_org()` reads it.
- RLS on every tenant table; unique constraints are org-scoped (e.g. quote codes, inventory names, 0073).
- Anonymous access only via token-scoped RPCs (approval, booklet, invitation, work token).
- TR-MT-01: cross-tenant read and write attempts return zero rows or an error (proved by `tests/db/tenant-isolation.mjs` and E2E stage 12).

### 8.2 RBAC matrix
| Item | Implementation |
|---|---|
| Roles (11) | admin, manager, planner, sales, coordinator, supervisor, quality, operations, crew, worker, client |
| Areas (26) | leads, crm, nurture, discovery, proposal, quotes, staff, inventory, vendors, calendar, templates, resources, runsheet, plan, logistics, ready, finance, settlement, closure, command, issues, media, controls, codes, users, layouts |
| Storage | `role_access(org_id, role, area, can_view, can_edit)`; seeds never overwrite admin edits |
| Enforcement | `has_area(area, 'view'|'edit')` inside RLS; admin always allowed; lifecycle gates `can_create/can_edit/can_delete` |
| UI | `auth.canView` / `auth.canEditArea` hide navigation; convenience only |
| Known divergence | `can_edit` vs `has_area` (W15-002) can block managers from settlement/closure in some configurations; tracked in section 11 |

### 8.3 Row-level security and definer functions
SECURITY DEFINER functions pin `search_path = public, pg_temp`, re-check `org_id`, and grant `EXECUTE` only to `authenticated` (or `anon` for token RPCs). Verification guide: `docs/OPERATOR-VERIFY-DEFINER-FUNCTIONS.md`.

### 8.4 Content Security Policy and front-end security
- CSP hashes generated by `scripts/gen-csp.mjs` into `vercel.json` and `public/_headers`; CI `--check`.
- No `innerHTML` with data (CI `scripts/check-html-sinks.mjs` allowlist); DOM built with `textContent`.
- Global form hardener and shared validators (numbers, phones, dates).
- Headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame-ancestors restrictions (parity tested by `test/headers-parity.test.mjs`).

### 8.5 Authentication and session
Password policy 12+ chars with mixed classes (0030); lockout (0053); rate limits (0050); email confirmation; Google OAuth; HQ TOTP MFA (0043/0047); OTPs hashed, single-use, expiring, replay-denied (0022, 0039, 0040); dev OTP echo only outside production (CI `check-otp-safety`).

### 8.6 Audit and activity
`tg_audit` trigger writes `audit_log` (actor, org, table, action, row id, before/after) for key tables; leads added in 0125. The dashboard **Recent activity** card and the **Audit log** page read the same table: the card is a short, recent slice; the page is the full filterable admin view.

### 8.7 Internationalisation, currency and tax
- Currency per studio (ISO 4217), integer rounding at the end of the pricing pipeline; per-currency totals in reports.
- Country tax templates: India GST (CGST+SGST or IGST), UAE VAT 5 %, UK VAT 20 %, US sales tax (configured rate), others configurable via `tax_rules`. Tax computed after discounts.
- Units metric/imperial; studio time zone for reminders and due dates; phone input with country codes.
- UI language English; RTL readiness for Arabic **[OWNER TO FILL: priority]**.

### 8.8 Caching and performance
- Static assets cached at the CDN; no framework runtime; three.js lazy on builder pages; procedural 3D textures.
- Batched RPCs (`dashboard_due_today`, money cards), `Promise.all` loads, list paging; no stale API caching for activity data.
- Region latency: Mumbai round trip ≈ 20 to 60 ms in India, 40 to 80 ms from UAE, 200 to 250 ms from US.

### 8.9 Accessibility
WCAG 2.2 AA target: keyboard navigation, visible focus, ARIA on toggles and dialogs, colour contrast in both themes, `prefers-reduced-motion`, touch targets ≥ 24 px (44 px preferred on mobile). E2E `@a11y` suite (axe) and Lighthouse CI.

### 8.10 Error handling and resilience
Capability-aware error messages (no raw SQL errors to users); save-failure recovery (`test/rel-save-failure.test.mjs`); idempotency keys on payouts and webhooks; toasts for user feedback.

### 8.11 Data protection
Personal data minimised; no personal data in URLs or telemetry; export and deletion flows; storage private with signed URLs; upload quarantine and scan. Legal mapping in `docs/DATA-PROTECTION-REVIEW.md`.

---

## 9. Architecture decisions (ADR log)

| ID | Decision | Status | Consequence |
|---|---|---|---|
| ADR-001 | The quote is the event (`quotes.id` spine). | Accepted | No data copy between sales and operations; lifecycle derived. |
| ADR-002 | Vanilla HTML/JS, no framework or build step. | Accepted (React attempt discarded 2026-10-01) | Small payloads, simple CSP; more manual DOM code. |
| ADR-003 | Supabase (Postgres + RLS) as backend; business logic in SQL RPCs. | Accepted | Security and money rules enforced at the data layer. |
| ADR-004 | Forward-only additive migrations with MANIFEST, APPLY and VERIFY. | Accepted | No destructive change; occasional compatibility shims. |
| ADR-005 | Hash-based CSP, no inline handlers or styles. | Accepted | Strong XSS defence; CSP regeneration on inline script changes. |
| ADR-006 | Server-authoritative pricing (D8, phase99). | Accepted | Client preview must match; differential tests. |
| ADR-007 | Integrations dormant and fail-closed behind `liveChannels` flags. | Accepted | Safe deploys before secrets exist. |
| ADR-008 | Void-with-reason, never delete money rows. | Accepted | Auditable ledger. |
| ADR-009 | Single region (Mumbai) for India-first launch. | Accepted, revisit | Higher latency abroad. |
| ADR-010 | Trial as a demo-seeded studio with "Start my own studio". | Accepted | Instant value; seed must be idempotent. |

---

## 10. Quality requirements

| ID | Attribute | Requirement | Measurement |
|---|---|---|---|
| QR-PERF-01 | Load | LCP ≤ 2.5 s at p75 on 4G India for dashboard, quotes, event pages | Lighthouse CI, field telemetry |
| QR-PERF-02 | Responsiveness | INP ≤ 200 ms p75; CLS ≤ 0.1 | Core Web Vitals |
| QR-PERF-03 | Builder | ≥ 60 fps 2D pan/drag with 300 items on a mid-range laptop; 3D ≥ 30 fps | Manual benchmark |
| QR-PERF-04 | API | p95 RPC ≤ 300 ms server time; dashboard ≤ 3 round trips | Supabase logs, `scripts/loadtest.mjs` |
| QR-AV-01 | Availability | 99.5 % monthly **[OWNER TO FILL]**; dependent on Supabase and Vercel SLAs | Uptime monitor |
| QR-SEC-01 | Isolation | 0 cross-tenant reads/writes | Isolation tests every release |
| QR-SEC-02 | Web | No `unsafe-inline` script; no data `innerHTML` | CI |
| QR-SEC-03 | Secrets | 0 secrets in repo/public | CI env safety, CodeQL |
| QR-SEC-04 | OWASP | OWASP Top 10 and ASVS L2 controls reviewed per release | Audit docs |
| QR-INT-01 | Money | 0 pricing mismatches (924 cases) | Differential tests |
| QR-INT-02 | Data loss | RPO ≤ 5 min (PITR), RTO ≤ 2 h | DR drill |
| QR-A11Y-01 | Accessibility | WCAG 2.2 AA; 0 serious axe violations | E2E `@a11y` |
| QR-COMP-01 | Browsers | Latest 2 of Chrome, Safari, Firefox, Edge; iOS/Android | Playwright chromium/firefox/webkit |

---

## 11. Risks and technical debt

| ID | Item | Severity | Plan |
|---|---|---|---|
| TD-1 | Production behind staging (0116, 0118 to 0125 not applied). | High | Apply in order with VERIFY (section 15). |
| TD-2 | `close_event` lacks server-side open-balance gate. | High | Add gate in RPC with audited admin override. |
| TD-3 | Settlement "Received" reads milestones rather than ledger in places. | Medium | Read from ledger. |
| TD-4 | Inventory availability ignores checkouts. | Medium | Include checkouts in availability. |
| TD-5 | `can_edit` vs `has_area` divergence (W15-002). | Medium | Unify on `has_area`. |
| TD-6 | Default-password accounts on production. | Critical | Owner reset. |
| TD-7 | Nurture email outbox simulated (no pg_cron sender). | Low | Build sender. |
| TD-8 | Single region latency for UAE/US. | Medium | Replica / region evaluation. |
| TD-9 | Large `npm test` list in `package.json` is hard to maintain. | Low | Glob runner. |
| TD-10 | Storage objects not covered by Postgres PITR. | Medium | Scheduled bucket export. |

---

## 12. Glossary
See PRD section 17. Additional terms: **RPC** (Postgres function called over PostgREST), **SECURITY DEFINER** (function running with owner rights), **PITR** (point-in-time recovery), **RPO/RTO** (recovery point/time objective), **ADR** (architecture decision record), **MANIFEST** (canonical migration order file).

---

## 13. Testing strategy

| Level | Suite / command | Scope | Gate |
|---|---|---|---|
| Static guards | `npm run ci` (`ci-check`, `check-html-sinks`, `extract-inline-styles --check`, `check-deploy-static`, `check-migration-canon`, `check-otp-safety`, `check-base-immutable`, `check-deferred-integrations`, `check-env-safety`, `check-jwt-roles`, `gen-csp --check`, `gen-capture-host --check`) | Security and deploy invariants | Every change |
| Unit / contract | `npm test` (about 195 files in `test/`) | UI contracts, pricing parity, tax, routing, trial, builder | Every change |
| Pricing differential | `test/pricing-differential*.test.mjs` | 924 client vs server cases | Every change |
| Database | `npm run test:db`, `npm run test:isolation`, CI `db-canonical-pg17.yml` | RLS, definer functions, migration canon on Postgres 17 | Every migration |
| E2E | `npm run test:e2e` with tags `@smoke @security @roles @approval @a11y @responsive @reliability @privacy @lifecycle` | Real browsers against staging; lead-to-closure lifecycle; cross-tenant denial | Before production |
| Performance | `lighthouse.yml`, `scripts/loadtest.mjs` | Web vitals, RPC load | Before production |
| Security | `codeql.yml`, OWASP phase audits | SAST, manual review | Per release |

Test data convention: prefix `QA-E2E` or `(testing)`. Never use real credentials in tests.

---

## 14. Observability

| Signal | Source | Use |
|---|---|---|
| Client errors and events | `telemetry.js` (no personal data) | Error rates per page, funnel KPIs |
| Database and API logs | Supabase logs | Slow queries, failed RPCs |
| Security events | `security_alert_events` → `security-alert-mailer` | Lockouts, suspicious auth |
| Audit trail | `audit_log` | Who changed what |
| Uptime | External monitor **[OWNER TO FILL: tool]** | Availability SLO |

Activation steps: `docs/OBSERVABILITY-ACTIVATION.md`, `docs/STAGING-OBSERVABILITY.md`.

---

## 15. Migration and release process (staging to production)

1. Work in a worktree; test locally; stay local until the owner says push.
2. Run `npm run ci`; regenerate CSP hashes if inline scripts changed.
3. Add migration `NNNN_name.sql` (additive, idempotent), register it in `MANIFEST`, write `APPLY-NNNN.sql` (paste-safe) and `VERIFY-NNNN.sql` (returns `true` rows).
4. Apply to **staging**; run VERIFY; test the feature in the staging app; run E2E.
5. Owner approves; push to `main`; Vercel deploys.
6. On **production**: run `VERIFY-0108-0115.sql` first, then in order 0116, 0118, 0119, 0120, 0121, 0122, 0123, 0124, 0125 (0117 only when integrations go live), each followed by its VERIFY; record results in the SQL tracker.
7. Deploy edge functions and secrets as needed; flip feature flags last.
8. Copy SQL with `LANG=en_US.UTF-8 pbcopy` to avoid character corruption.
9. Rollback: front end by promoting the previous Vercel deployment; database by forward fix (never down-migrate data).

Current state (16 Oct 2026):

| Range | Staging | Production |
|---|---|---|
| 0001 to 0115 | Applied | Applied (re-verify) |
| 0116, 0118 to 0124 | Applied | Pending |
| 0117 | Not run | Not run (integrations) |
| 0125 | Pending | Pending |

Production test-data handling: back up first; inventory candidates read-only; prefer isolation (real clients get new orgs) over deletion; delete only with explicit owner approval, org-scoped, in a transaction, tested on a staging copy; money rows voided, not deleted.

---

## 16. Backup and disaster recovery

| Domain | Backup | RPO / RTO target |
|---|---|---|
| Postgres | Supabase daily backups + PITR | RPO ≤ 5 min, RTO ≤ 2 h |
| Storage objects | Periodic bucket export | RPO ≤ 24 h |
| Edge functions | Git | Redeploy ≤ 30 min |
| Front end | Git + Vercel deployments | Promote previous ≤ 15 min |
| Secrets | Offline vault (names documented) | ≤ 1 h |

Drills: restore into a scratch project quarterly, run VERIFY scripts and the tenant-isolation test. Runbooks: `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`. Breach notification timelines: India DPDP (Board and affected principals without delay, detailed report within 72 h), UK/EU GDPR (regulator within 72 h), UAE PDPL (notify the UAE Data Office), US state laws as applicable.

---

## 17. Document history

| Version | Date | Change |
|---|---|---|
| 1.0 | 15 Oct 2026 | First TRD. |
| 2.0 | 16 Oct 2026 | Rewritten to arc42 with runtime sequences, ADR log, quality requirements, testing, observability, release and DR sections. |

## 18. References

1. arc42 template, sections overview. https://arc42.org/overview ; documentation https://docs.arc42.org/home/
2. G. Starke, P. Hruschka, *arc42 by Example*. https://leanpub.com/arc42byexample
3. Malte Ubl, "Design Docs at Google". https://www.industrialempathy.com/posts/design-docs-at-google/
4. ISO/IEC/IEEE 29148:2018, Requirements engineering. https://www.iso.org/standard/72089.html
5. ISO/IEC/IEEE 42010:2022, Architecture description. https://www.iso.org/standard/74393.html
6. Michael Nygard, "Documenting Architecture Decisions" (ADR). https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions
7. C4 model. https://c4model.com/
8. ISO/IEC 25010:2023, Product quality model. https://www.iso.org/standard/78176.html
9. OWASP Top 10 and ASVS. https://owasp.org/www-project-top-ten/ ; https://owasp.org/www-project-application-security-verification-standard/
10. Supabase, Row Level Security. https://supabase.com/docs/guides/database/postgres/row-level-security
11. Supabase, Backups and PITR. https://supabase.com/docs/guides/platform/backups
12. MDN, Content Security Policy. https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP
13. web.dev, Core Web Vitals. https://web.dev/articles/vitals
14. W3C WCAG 2.2. https://www.w3.org/TR/WCAG22/
15. Google SRE Book, "Service Level Objectives". https://sre.google/sre-book/service-level-objectives/
