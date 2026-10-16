# Helm: Product Requirements Document (PRD)

| Field | Value |
|---|---|
| **Product** | Helm, the event operating system for event studios, planners and decorators |
| **Document** | Product Requirements Document |
| **Version** | 2.0 (rewrite to an industry-standard structure) |
| **Date** | 16 October 2026 |
| **Status** | Draft for owner review. Sections marked **[OWNER TO FILL]** need a business decision. |
| **Owner** | [OWNER TO FILL] (product owner / founder) |
| **Approvers** | [OWNER TO FILL] |
| **Companion documents** | [TRD.md](TRD.md) (technical, arc42) · [USER-MANUAL.md](USER-MANUAL.md) / [user-manual.html](user-manual.html) · `docs/DATA-PROTECTION-REVIEW.md` · `docs/INDIA-AUDIT-2026-10.md` · `docs/UAE-AUDIT-2026-10.md` |

> **How to read this document.** Sections 1 to 4 explain *why* (problem, vision, users). Sections 5 to 8 define *what* (scope, requirements with IDs and acceptance criteria, priorities). Sections 9 to 14 cover *how we will know it works* and *what could go wrong*. The structure combines the Atlassian/Confluence PRD template (goals, background, requirements table, user interaction, questions, not doing), Lenny Rachitsky's one-pager (problem, why now, success metrics, non-goals), Amazon's working-backwards PR/FAQ (customer-first press release and FAQ), and the requirement attributes from ISO/IEC/IEEE 29148 (unique ID, priority, verifiable acceptance criterion). Technical design is deliberately left to the TRD.

---

## Table of contents

1. Summary and working-backwards press release
2. Problem statement and evidence
3. Vision, product principles and why now
4. Users: personas and jobs to be done
5. Scope: modules and release status
6. Functional requirements and acceptance criteria (by module)
7. Key user journeys
8. Prioritisation (MoSCoW)
9. Non-functional requirements (product-level)
10. Success metrics and KPIs
11. Assumptions, dependencies and constraints
12. Risks
13. Release plan and roadmap
14. Open questions
15. Out of scope (non-goals)
16. Legal, compliance and market coverage
17. Glossary
18. Document history
19. References

---

## 1. Summary and working-backwards press release

### 1.1 One-paragraph summary

Helm is a multi-tenant, browser-based SaaS that runs an event studio from the first enquiry to the final profit-and-loss statement. Its spine is a single record: **the quote is the event**. Leads, discovery notes, a to-scale 2D/3D floor plan that prices itself, the client proposal and online approval, payment milestones, crew tasks, inventory reservations, vendor bills, the event-day command centre, settlement and closure all hang off that one record. Each studio's data is isolated by row-level security in Postgres, money is computed by the server, and nothing important is ever hard-deleted.

### 1.2 Press release (Amazon PR/FAQ style, written as if launched)

> **Helm launches the event operating system that takes studios from enquiry to profit in one place**
>
> *Hyderabad, [OWNER TO FILL: launch date].* Event studios in India, the UAE, the UK and the US can now run every wedding, corporate event and celebration from a single workspace. Helm replaces the WhatsApp groups, Excel quotes, paper sketches and after-the-event profit guesses that most studios rely on today.
>
> A planner converts an Instagram enquiry into a quote in minutes, drags a stage, round tables and floral arches onto a to-scale plan of the actual venue, and watches the price update with every item. The client opens a proposal on their phone, walks through the venue in 3D, and approves with a one-time code. From that moment the studio's crew see their own tasks, stock is reserved so it cannot be double-booked, and vendor bills land against the event. After the event, the owner sees the real margin, not an estimate.
>
> *"[OWNER TO FILL: founder quote]"*
>
> Studios can start an 8-day free trial with sample data at [OWNER TO FILL: domain], no card required.

### 1.3 External FAQ (customer questions)

| Question | Answer |
|---|---|
| Do my clients need an account? | No. Clients use secure links (proposal, approval with one-time code, booklet, invitation site). |
| Can my crew use it on a phone? | Yes. Crew see only their own tasks on a mobile page and can accept, decline and upload photo evidence. |
| Which currencies and taxes? | Any currency. Country tax templates for India GST, UAE VAT and others; tax is computed after discounts. |
| Is my data private from other studios? | Yes. Every table is protected by row-level security per studio; cross-tenant access is tested on every release. |
| Can I export my data? | Yes. Admins can export the organisation's data; deletion requests are supported. |
| Does Helm file my GST/VAT return? | No. Helm produces the figures; filing stays with your accountant. |

### 1.4 Internal FAQ (stakeholder questions)

| Question | Answer |
|---|---|
| Why vanilla HTML/JS instead of React? | A React/Next.js migration was attempted and discarded (2026-10-01). Vanilla pages with a strict CSP, no build step and no framework runtime are faster to load and easier to audit. See TRD ADR-002. |
| Why is the database the authority for money? | Browser values can be tampered with. Prices, taxes, overpayment checks and P&L are recomputed in Postgres (924 client-vs-server differential cases, 0 mismatches). |
| What is the biggest risk? | Production rollout discipline (pending migrations 0116 to 0125, default-password accounts, test data on production). See section 12. |

---

## 2. Problem statement and evidence

**Problem.** Small and mid-sized event studios (3 to 40 people) run high-value, one-off projects with tight deadlines using informal tools. Information is retyped at every stage, prices drift, stock is double-booked, approvals are disputed, and true profit is only known (if at all) weeks after the event.

| ID | Problem today | Consequence | Helm response |
|---|---|---|---|
| P1 | Enquiries arrive on WhatsApp, Instagram and phone and live in someone's head. | Lost leads, slow replies. | Lead pipeline with stages, follow-ups, source tracking, nurture reminders. |
| P2 | Quotes typed fresh in Excel; prices drift. | Under-quoting, inconsistent margins. | Price list, menu packages, templates; builder prices each placed item; server recomputes totals. |
| P3 | Clients cannot picture the venue. | Long back-and-forth, lost deals. | To-scale 2D plan, 3D view, measure mode, photo render, shareable proposal. |
| P4 | Approval is "OK on WhatsApp". | Scope and price disputes. | Approval link with one-time code, consent record, locked confirmed version, re-approval on change. |
| P5 | Stock double-booked across same-day events. | Shortages on event day. | Atomic reservations, checkout/return, shortage warnings, calendar conflicts. |
| P6 | Vendor bills on WhatsApp; profit done on paper. | Nobody knows true margin. | Vendor bills and payouts per event, event P&L, business P&L, payables. |
| P7 | Crew instructed by phone call. | Missed tasks, no accountability. | Task board, accept/decline, dependencies, alarms, photo evidence, supervisor verification. |
| P8 | Event-day chaos. | Late setups, unlogged issues. | Event-day command: arrivals, setup checks, reception counts, live stock, issues. |
| P9 | Money owed is unclear. | Cash-flow surprises. | Payment milestones, overpayment guard, settlement, refunds, staff expense claims. |

**Evidence.** Requirements were gathered from client discovery calls (for example the September 2026 Praneeth call: live builder pricing, six menu packages, dropdowns, staff sync), owner walkthroughs, and the India and UAE market audits (`docs/INDIA-AUDIT-2026-10.md`, `docs/UAE-AUDIT-2026-10.md`). Quantitative market sizing: **[OWNER TO FILL]**.

---

## 3. Vision, product principles and why now

**Vision.** *Run every event like clockwork.* One workspace takes a studio from first enquiry to final P&L.

**Product principles** (used to break ties in design decisions):

1. **One record, start to end.** The quote is the event; no duplicate data entry.
2. **The floor plan sells the event.** The builder is at the centre of the sales flow and prices itself.
3. **Money is server-authoritative.** Totals, taxes, overpayment checks and P&L come from the database.
4. **Every studio's data is its own.** Row-level isolation and a configurable role matrix.
5. **Zero data loss.** Records are voided or archived with a reason and an audit trail, never silently deleted.
6. **Works where studios work.** Any browser, laptop or phone; any currency; local tax; metric or imperial.

**Why now.** Studios already live on smartphones and share links with clients; India's UPI and payment-link adoption and the UAE's VAT regime make digital quoting and collection expected; generic CRMs and project tools do not understand floor plans, stock or event-day operations. **[OWNER TO FILL: competitive landscape and differentiation table.]**

---

## 4. Users: personas and jobs to be done

### 4.1 Personas

| ID | Persona | Role(s) in Helm | Context | Primary needs |
|---|---|---|---|---|
| PE-1 | **Studio owner** | `admin` | Founder of a décor/wedding/corporate studio; approves quotes; watches cash. | Pipeline, booked revenue, cash received, today's dues, per-event and business profit, control over who sees money. |
| PE-2 | **Planner / event manager** | `planner`, `manager` | Runs 2 to 10 live events at once, mostly on a laptop. | Fast quoting, accurate builder, client-ready proposal, task board, run sheet. |
| PE-3 | **Sales executive** | `sales` | Handles enquiries from social, referrals, walk-ins, often on a phone. | A pipeline that never loses a lead, reminders, quick conversion. |
| PE-4 | **Operations lead** | `operations`, `coordinator`, `supervisor`, `quality` | On-ground team leads. | Stock, vendor bookings, logistics, event-day command, issues; finance hidden unless granted. |
| PE-5 | **Crew / worker** | `crew`, `worker` (or token link, no account) | Decorators, helpers, drivers on a phone, sometimes poor connectivity. | Only their tasks; accept/decline; mark done with photo. |
| PE-6 | **Client** | `client` (link-based, no login) | Couple, family or corporate host. | Beautiful proposal, approve with a code, see payments due, share invitation site. |
| PE-7 | **Platform operator (Helm HQ)** | platform admin (MFA) | The Helm team. | Subscriptions, trials, invoices, support, without access to studios' private data. |

### 4.2 Jobs to be done

| ID | When... | I want to... | So I can... | Persona |
|---|---|---|---|---|
| JTBD-1 | an enquiry arrives | capture it in seconds with source and date | reply first and never lose it | PE-3 |
| JTBD-2 | a client asks "how much?" | build a priced plan of their actual venue | send a confident, consistent quote the same day | PE-2 |
| JTBD-3 | the client is undecided | show them the venue in 3D on their phone | win the booking | PE-2, PE-6 |
| JTBD-4 | the client agrees | get a recorded approval and an advance | avoid disputes and secure cash | PE-1, PE-6 |
| JTBD-5 | several events share a date | know what stock and crew are free | avoid shortages and double-booking | PE-4 |
| JTBD-6 | the event day arrives | see setup progress and issues live | deliver on time | PE-4, PE-5 |
| JTBD-7 | the event is over | see what I really earned | price the next event better | PE-1 |
| JTBD-8 | I am given a task | see exactly what, where and when | do it right and prove it | PE-5 |

---

## 5. Scope: modules and release status

Status legend: **Prod** = live on production · **Staging** = shipped to staging, production pending · **Dormant** = built, switched off behind a flag · **Planned** = not built.

| Module | Pages (under `public/`) | Status |
|---|---|---|
| M1 Acquisition and onboarding | `index`, `pricing`, `try`, `demo`, `login`, `onboarding`, `profile-setup`, `invite-studio` | Prod; 8-day unified trial Staging (0116, 0118 to 0123) |
| M2 Workspace shell and dashboard | `dashboard`, `chat`, global search, bell, tour | Prod; "Due today" Staging (0121) |
| M3 Sales: leads, CRM, nurture | `leads`, `crm`, `nurture` | Prod; lead audit Staging (0125) |
| M4 Quote, proposal and approval | `quotes`, `proposal`, `proposal-view`, `approve`, `templates`, `budget` | Prod |
| M5 2D/3D builder | `builder`, `design`, `flow` | Prod; photo render owner-only |
| M6 Event workspace and operations | `event`, `discovery`, `plan`, `ops`, `resources`, `inventory`, `vendors`, `logistics`, `runsheet`, `ready`, `command`, `issues`, `teardown`, `media`, `calendar`, `staff`, `work` | Prod |
| M7 Money | `settlement`, `closure`, `business`, `reports`, `insights` | Prod; vendor bills and P&L Staging (0124) |
| M8 Client-facing | `proposal-view`, `approve`, `client`, `portal`, `booklet`, `invite` (`/i/<slug>`) | Prod |
| M9 Administration and security | `control`, `audit`, `services`, data export, `data-deletion` | Prod |
| M10 Platform (HQ) and billing | `hq`, `checkout`, `sim-pay` (non-prod) | Prod (HQ); paid checkout prices pending |
| M11 Integrations | WhatsApp, Razorpay per-studio payment links | Dormant |
| M12 Legal pages | `terms`, `privacy`, `cookie-policy`, `acceptable-use`, `dpa`, `refund-policy`, `data-deletion` | Prod (owner-supplied final text pending) |

---

## 6. Functional requirements and acceptance criteria

Each requirement has a unique ID (`FR-<module>-<nn>`), a MoSCoW priority (section 8), a user story and at least one verifiable acceptance criterion written in Given/When/Then form where useful. Where an automated test exists it is named so the criterion is traceable.

### 6.1 M1 Acquisition and onboarding

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M1-01 | As a visitor, I want a landing page explaining Helm so I can decide to try it. | Must | Page loads on mobile and desktop without horizontal scroll; primary CTA "Start free trial" and secondary "Try the planner" visible above the fold; footer links all legal pages. |
| FR-M1-02 | As a visitor, I want to try the planner without signing up. | Should | `/try` opens a pre-made banquet in 2D/3D/Measure; no network writes occur (sandbox `localStorage` tier); reload resets. |
| FR-M1-03 | As a visitor, I want a read-only live demo. | Should | `/demo` shows a fictional studio; every write control is disabled or simulated; no request mutates any database. |
| FR-M1-04 | As a studio owner, I want to sign up with email or Google. | Must | Password requires 12+ chars, upper, lower, digit and symbol; email confirmation required before first sign-in; Google OAuth creates the same profile shape; failed-attempt lockout applies (`test/auth-signup-confirm.test.mjs`, `test/password-lockout-ui.test.mjs`). |
| FR-M1-05 | As a new studio, I want an 8-day trial with sample data. | Must | Given a new sign-up, a trial studio is created with records labelled *Demo*; reminders fire on day 5, 7 and 8 in the studio's time zone; after day 8 the studio becomes read-only until a plan is chosen, without deleting data (`test/trial-demo.test.mjs`, `test/trial-reminders-ui.test.mjs`). |
| FR-M1-06 | As a trial owner, I want to "Start my own studio" when ready. | Must | The confirm dialog shows per-type counts of demo records; confirming gives a fresh studio; no other organisation's rows are touched (0123). |
| FR-M1-07 | As an owner, I want an onboarding wizard. | Must | Wizard captures studio profile, country (sets currency and default tax lines), units (m/ft), logo, price list (Excel smart import), packages, venues and team invites; every step can be skipped and resumed (`test/onboarding-wizard.test.mjs`, `test/smart-import.test.mjs`). |
| FR-M1-08 | As an owner, I want a getting-started checklist. | Should | Dashboard shows remaining first steps with progress; items tick automatically when completed. |

### 6.2 M2 Workspace shell and dashboard

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M2-01 | As an owner, I want money cards (open pipeline, booked, received, upcoming). | Must | Figures come from server queries; users without `finance` view see no money values (`test/dashboard-money.test.mjs`). |
| FR-M2-02 | As a manager, I want a "Today" strip. | Must | Shows tasks, events and payment milestones due today, read-only, from `dashboard_due_today` (0121). |
| FR-M2-03 | As a user, I want to customise dashboard cards. | Could | Card order/visibility persists per user (`test/dashboard-customize.test.mjs`). |
| FR-M2-04 | As a user, I want global search (Ctrl/Cmd K). | Should | Finds leads, quotes/events, clients, vendors within the user's organisation and permitted areas only. |
| FR-M2-05 | As a user, I want notifications with deep links. | Must | Bell lists unread items; click opens the exact record; per-type mute supported (`test/notif-deeplinks.test.mjs`). |
| FR-M2-06 | As a team member, I want team chat. | Should | Conversations, mentions, attachments (private storage, signed URLs), reactions; members only see conversations they belong to. |
| FR-M2-07 | As an owner sharing my screen, I want a privacy eye. | Should | One toggle masks all money figures on screen. |
| FR-M2-08 | As a user, I want light and dark themes. | Should | Theme follows the system by default and can be overridden; contrast meets WCAG 2.2 AA in both. |
| FR-M2-09 | As an admin, I want a "Recent activity" card. | Should | Card shows the latest entries of the same `audit_log` the Audit page reads (same source, shorter list, links to Audit log). See section 6.9 note. |

### 6.3 M3 Sales: leads, CRM and nurture

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M3-01 | As sales, I want a lead pipeline with stages. | Must | Stages New, Qualified, Discovery, Quoted, Won, Lost; drag or select to move; required fields name and one contact method; phone validated per country. |
| FR-M3-02 | As sales, I want follow-up dates and saved filters. | Should | Overdue follow-ups flagged; saved views persist per user (`test/saved-filters-ui.test.mjs`). |
| FR-M3-03 | As sales, I want to convert a lead to a quote. | Must | Conversion creates one quote linked to the lead; repeat clicks do not create duplicates. |
| FR-M3-04 | As an admin, I want lead edits audited. | Must | Every insert/update to `leads` writes an `audit_log` row (0125). |
| FR-M3-05 | As a manager, I want a Client 360 timeline. | Should | Shows all quotes, payments, messages and events for a client. |
| FR-M3-06 | As sales, I want nurture reminders (anniversaries, birthdays). | Could | Due items flagged; "To lead" re-creates a lead; templates per occasion. |
| FR-M3-07 | Lead same-email overwrite fix (link only on email + phone match; fill blanks only). | Should | **Parked** by owner 2026-10-13. |

### 6.4 M4 Quote, proposal and approval

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M4-01 | As a planner, I want auto-numbered quotes. | Must | Code format `MMDDYYYY-NN` from event date and per-org sequence; unique per organisation; never reused (`test/numbering-integrity.test.mjs`). |
| FR-M4-02 | As a planner, I want packages and a price list. | Must | Six standard menu packages; price list items with specs; editing a package re-prices open drafts only after confirmation (reprice banner). |
| FR-M4-03 | As an owner, I want discounts, coupons and caps. | Must | Order: items, service adjustments, fixed discount, % discount, coupon, cap, tax, integer rounding; server result equals client preview in all 924 differential cases. |
| FR-M4-04 | As an owner, I want country tax. | Must | India: GST lines (CGST/SGST or IGST) at configurable rates; UAE: VAT 5 %; UK: VAT 20 %; US: sales tax per configured rate; tax computed after discount (`test/country-tax.test.mjs`). |
| FR-M4-05 | As a planner, I want quote versions. | Must | Saving creates a version; confirming locks it; later edits create a change request requiring re-approval. |
| FR-M4-06 | As a planner, I want a proposal with mood board, palette and scope. | Must | Proposal renders on phone and desktop; shows only client-safe fields (no cost prices). |
| FR-M4-07 | As a client, I want to approve online. | Must | Given a valid link, when the client enters the one-time code and ticks consent, then the quote becomes Confirmed and a consent record (timestamp, quote version and consent text) is stored; codes are hashed, single-use, expiring; replay is refused. |
| FR-M4-08 | As an owner, I want link windows. | Should | Client links can be time-boxed and auto-expire; expired links show a friendly message. |

### 6.5 M5 2D/3D builder

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M5-01 | As a planner, I want a to-scale plan of the venue. | Must | Plan uses venue length and width in m or ft; usable-area margins respected. |
| FR-M5-02 | As a planner, I want a catalogue of stages, seating, tables, décor, arches, lighting, buffets, lounges, dance floors. | Must | Items searchable; each has real dimensions and a price; placing an item updates the live total. |
| FR-M5-03 | As a planner, I want snap, alignment and measure mode. | Must | Measure shows distance to walls and neighbours in the studio's unit. |
| FR-M5-04 | As a client or planner, I want a 3D view. | Must | Orbit view renders the same layout; mid-range laptop target 60 fps; phones degrade gracefully. |
| FR-M5-05 | As a planner, I want a layout wizard and studio templates. | Should | Wizard generates a non-overlapping layout for guest count and venue (`test/layout-generator-overlap.test.mjs`). |
| FR-M5-06 | As an owner, I want a photo-realistic render. | Could | **Owner-only**; each render consumes paid credits and is logged in `photo_render_usage`. Engineers never trigger renders. |

### 6.6 M6 Event workspace and operations

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M6-01 | As a manager, I want a lifecycle bar. | Must | Stages Lead, Discovery, Proposal, Quote, Confirmed, Planning, Resources, Ready, Event Day, Settlement, Closed; derived from records with admin override. |
| FR-M6-02 | As a planner, I want discovery and requirements capture. | Must | Notes, requirements, risks stored per event. |
| FR-M6-03 | As a manager, I want ops tasks with dependencies, alarms and evidence. | Must | Task cannot be completed before its dependencies; crew accept/decline; photo evidence uploaded to private storage; supervisor verifies. |
| FR-M6-04 | As operations, I want a resource plan (in-house first). | Must | Gaps become vendor booking suggestions. |
| FR-M6-05 | As operations, I want atomic inventory reservations. | Must | Two concurrent reservations cannot exceed stock; checkout/return tracked; shortage warning shown. |
| FR-M6-06 | As operations, I want vendor bookings and logistics. | Must | Vendors, bookings, guests, checklists, permits, comms per event. |
| FR-M6-07 | As a manager, I want a run sheet and readiness gate. | Must | Event cannot be marked Ready while blocking checklist items are open (admin override audited). |
| FR-M6-08 | As a supervisor, I want event-day command. | Must | Arrivals, setup checks, reception counts, live stock requests, issues and incidents in one screen usable on a phone. |
| FR-M6-09 | As crew, I want a phone task page. | Must | `work` page or token link shows only that person's tasks; no other event data exposed. |
| FR-M6-10 | As operations, I want teardown and returns. | Should | Returned quantities reconcile reservations; missing items flagged. |
| FR-M6-11 | Time-aware calendar (event times, overlap conflicts). | Could | **Deferred** (built then reverted, commit ff7646b). |

### 6.7 M7 Money

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M7-01 | As an owner, I want payment milestones and a ledger. | Must | Payments beyond confirmed total plus approved changes are refused (`enforce_no_overpayment_ms`, each payment counted once since 0125). |
| FR-M7-02 | As a manager, I want settlement. | Must | Client invoice, vendor settlement, staff claims, refunds/recoveries per event. |
| FR-M7-03 | As an owner, I want vendor bills and payouts. | Must | Payout cannot exceed bill; idempotent on retry; bills voided with reason, never deleted (0124). |
| FR-M7-04 | As an owner, I want event and business P&L. | Must | Read-only views `event_pnl`, `vendor_payables_summary`, `business_pnl`; figures ex-tax. |
| FR-M7-05 | As an owner, I want closure. | Must | Closing requires settlement reviewed; closure P&L stored; event archived; anniversary nurture created. Server-side balance gate: see Open Question OQ-4. |
| FR-M7-06 | As an owner, I want reports and insights. | Should | Revenue, margin, source and conversion reports, ex-tax, filterable by date. |

### 6.8 M8 Client-facing

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M8-01 | As a client, I want a booklet link. | Should | Shows plan images, scope, change lines, payments due; accessed by token only. |
| FR-M8-02 | As a client, I want an invitation website. | Could | `/i/<slug>`, 5 templates, RSVP; published only for confirmed events; slug unguessable enough to prevent enumeration. |
| FR-M8-03 | As a client, I want to pay online. | Should | **Dormant**: Razorpay payment link into the studio's own account (0117, `liveChannels.pay=false`). |

### 6.9 M9 Administration and security

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M9-01 | As an admin, I want a role/area access matrix. | Must | 12 role keys (admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, worker, client) x 33 areas, view/edit per cell; admin always allowed; database enforces it via `has_area` in RLS. |
| FR-M9-02 | As an admin, I want user control. | Must | Invite, change role, deactivate (no hard delete); reset password flow. |
| FR-M9-03 | As an admin, I want an audit log. | Must | Key tables write `audit_log` rows (who, when, table, action, before/after); read-only page for admins. |
| FR-M9-04 | As an admin, I want a data export. | Must | Organisation-scoped export downloadable by admins only. |
| FR-M9-05 | As a data subject, I want to request deletion. | Must | `data-deletion` page records the request; fulfilment follows retention rules (financial records retained as legally required). |
| FR-M9-06 | As HQ, I want MFA. | Must | HQ console requires TOTP MFA; attempts rate-limited. |

**Recent activity vs Audit log (clarification).** They are **the same data, shown differently**. Both read the `audit_log` table produced by the shared `tg_audit` trigger. *Recent activity* is the dashboard card showing only the latest few entries the viewer may see, with a "more" link to the Audit page; *Audit log* is the full, filterable, admin-only page. Before migration 0125, lead edits were not audited, so they appeared in neither; after 0125 they appear in both.

### 6.10 M10 Platform and billing

| ID | User story | Priority | Acceptance criteria |
|---|---|---|---|
| FR-M10-01 | As a studio, I want to buy a plan. | Must | Razorpay subscription checkout; webhook HMAC-verified and idempotent; plan prices **[OWNER TO FILL]**. |
| FR-M10-02 | As HQ, I want to see subscriptions and invoices. | Must | HQ shows studio, plan, status, invoices; never a studio's operational records. |

---

## 7. Key user journeys

| ID | Journey | Steps | Success signal |
|---|---|---|---|
| J1 | First-time owner (day 0) | Landing, Start free trial, confirm email, trial studio with demo data, guided tour, onboarding wizard, explore demo quote, Start my own studio, first real lead. | First real quote created on day 1. |
| J2 | Enquiry to confirmed event | Lead, qualify, convert, discovery, package, builder layout, proposal, send approval link, client OTP + consent, Confirmed, advance milestone. | Confirmed with consent record. |
| J3 | Plan and run | Resource plan, reservations, tasks, crew accept, logistics, run sheet, readiness gate, event-day command, teardown. | Event Ready before day; zero shortages. |
| J4 | Close the books | Client balance, vendor bills and payouts, staff claims, refunds, event P&L, feedback, close and archive. | Event Closed with P&L. |
| J5 | Client | Proposal link, 3D images, approve with code, booklet payments, invitation site. | Approval without a call. |
| J6 | Crew | Task link on phone, accept, travel, complete with photo, supervisor verifies. | Task verified on time. |

Detailed screen-by-screen flows for phone and laptop: **[OWNER TO FILL: link to APP-FLOW document when produced]**.

---

## 8. Prioritisation (MoSCoW)

| Bucket | Meaning | Items |
|---|---|---|
| **Must** | Launch-blocking for a paid release. | M1 sign-up/trial/onboarding; M2 money cards, Today strip, notifications; M3 pipeline, convert, lead audit; M4 all; M5 builder core (01 to 04); M6 lifecycle, tasks, reservations, run sheet, command, crew page; M7 milestones, settlement, vendor bills, P&L, closure; M9 all; M10 checkout; legal text final. |
| **Should** | High value, release can ship without. | Try/demo, saved filters, Client 360, chat, privacy eye, themes, layout wizard, link windows, teardown, reports, booklet, online payment links, lead overwrite fix. |
| **Could** | Nice to have. | Dashboard customise, nurture, invitation sites, photo render, time-aware calendar. |
| **Won't (this release)** | Explicitly excluded. | See section 15. |

---

## 9. Non-functional requirements (product level; engineering detail in TRD section 10)

| ID | Area | Requirement |
|---|---|---|
| NFR-01 | Security | Row-level security on every tenant table; strict CSP without `unsafe-inline` scripts; OTP/token hardening; audit trail; MFA for HQ. |
| NFR-02 | Privacy | Data minimisation; no personal data in URLs; export and deletion; compliant with India DPDP Act 2023, UAE PDPL, UK GDPR / DPA 2018, EU GDPR, and US state laws (e.g. CCPA/CPRA) where applicable. |
| NFR-03 | Performance | App pages interactive under 2.5 s (LCP) on 4G in India; INP under 200 ms; builder 60 fps on a mid-range laptop. |
| NFR-04 | Availability | 99.5 % monthly for app and API **[OWNER TO FILL: confirm SLA]**. |
| NFR-05 | Accessibility | WCAG 2.2 AA: keyboard navigation, visible focus, labelled controls, reduced motion. |
| NFR-06 | Internationalisation | Any currency; country tax templates (IN, AE, GB, US, others); metric/imperial; studio time zone. English UI; Arabic/RTL and Hindi **[OWNER TO FILL: priority]**. |
| NFR-07 | Devices | Latest two versions of Chrome, Safari, Firefox, Edge; iOS Safari and Android Chrome; widths 320 px to 2560 px. |
| NFR-08 | Data integrity | Zero data loss: additive migrations, void-with-reason, PITR backups. |

---

## 10. Success metrics and KPIs

| Goal | KPI (definition) | Target (6 months after paid launch) | Source |
|---|---|---|---|
| Fast activation | % of trial studios creating a real quote within 24 h of sign-up | ≥ 60 % | Telemetry + DB |
| Conversion | Trial to paid within 8 days + 7-day grace | ≥ 15 % | HQ subscriptions |
| System of record | Paid studios closing ≥ 1 event per month in Helm | ≥ 70 % | `event_closure` |
| Speed to quote | Median lead-created to proposal-sent time | < 24 h | Audit log timestamps |
| Online approval | Confirmed events approved via link (not manual) | ≥ 50 % | `quote_consents` |
| Retention | Logo retention at month 3 | ≥ 80 % **[OWNER TO FILL]** | HQ |
| Money integrity | Client-vs-server pricing mismatches | 0 | CI differential tests |
| Trust | Cross-tenant exposure incidents | 0 | Isolation tests, incidents |
| Reliability | Data-loss incidents | 0 | Incident log |
| Satisfaction | NPS from studio owners | ≥ 40 **[OWNER TO FILL]** | Survey |

Guardrail metrics: support tickets per active studio, p95 page load, error rate per page (telemetry).

---

## 11. Assumptions, dependencies and constraints

**Assumptions**

| ID | Assumption | If wrong |
|---|---|---|
| A1 | Studios accept a browser app (no native app) on phones and laptops. | Revisit PWA/native shell. |
| A2 | Clients approve via link without an account. | Add client portal login. |
| A3 | An India-first launch tolerates a single Mumbai database region. | Add replica or region move for UAE/US. |
| A4 | Studios will pay roughly ₹1,999 to ₹4,999 per month. | Re-price; prices remain marked "proposed". |

**Dependencies:** Supabase (Postgres, Auth, Storage, Realtime, Edge Functions), Vercel CDN, Google OAuth, Razorpay (subscriptions; payment links dormant), Meta WhatsApp Cloud API (dormant), image-generation provider for photo render, SMTP provider.

**Constraints:** vanilla HTML/JS (no framework); forward-only additive migrations; production changes only after staging verification and explicit owner approval; no inline scripts without CSP hashes; photo renders owner-only; legal text supplied by the owner.

---

## 12. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Production missing migrations 0116, 0118 to 0125 while code expects them. | High | High | Apply in MANIFEST order with VERIFY after each; feature flags. | Owner |
| R2 | Accounts on published default passwords on production. | Medium | Critical | Reset or recreate on the studio domain before onboarding clients. | Owner |
| R3 | Test data on production visible in reports. | Medium | Medium | Isolate by org; archive/void, never blind delete (TRD section 13). | Owner |
| R4 | Close-event without server-side balance gate. | Medium | High | Add RPC-level gate (open P1 from Oct audit). | Engineering |
| R5 | Inventory availability ignores checkouts in some views. | Medium | Medium | Fix availability calculation (open P1). | Engineering |
| R6 | Latency from UAE/US to Mumbai region. | Medium | Medium | Batched RPCs; evaluate replica. | Engineering |
| R7 | Photo render cost overrun. | Low | Medium | Owner-only flag; per-studio quota before GA. | Owner |
| R8 | Legal text not final at launch. | Medium | High | Block paid launch until supplied. | Owner |
| R9 | Trial abuse (repeat trials). | Medium | Low | Email confirmation, phone verify, HQ monitoring. | HQ |

---

## 13. Release plan and roadmap

| Release | Content | Exit criteria |
|---|---|---|
| **R-Now (production catch-up)** | Apply 0116, 0118 to 0125 to production (0117 only when integrations go live); default-password reset; test-data isolation; legal text. | All VERIFY scripts true; E2E smoke and isolation pass on production; owner sign-off. |
| **R-Next (paid launch)** | Plan prices and checkout live; WhatsApp reminders; Razorpay per-studio payment links; close-event balance gate; inventory availability fix; lead overwrite fix. | Must items in section 8 complete; KPIs instrumented. |
| **R-Later** | Time-aware calendar; expanded 3D catalogue; nurture email delivery (pg_cron + mailer); Arabic/RTL; read replica for Gulf. | Prioritised by KPI impact. |

Proposed plans (prices marked proposed until confirmed): Free trial 8 days, no card · Solo ₹1,999/month or ₹19,990/year · Studio ₹4,999/month or ₹49,990/year · Enterprise on request. AED/GBP/USD pricing **[OWNER TO FILL]**.

---

## 14. Open questions

| ID | Question | Owner | Due |
|---|---|---|---|
| OQ-1 | Final plan prices per currency (INR, AED, GBP, USD)? | Owner | [OWNER TO FILL] |
| OQ-2 | Launch date and markets order (India first, then UAE)? | Owner | [OWNER TO FILL] |
| OQ-3 | Which lawyer-reviewed legal texts will be used per market? | Owner | [OWNER TO FILL] |
| OQ-4 | Should closure be hard-blocked server-side when a client balance is open, or allowed with an audited override? | Owner | [OWNER TO FILL] |
| OQ-5 | Is Arabic/RTL required for the UAE launch? | Owner | [OWNER TO FILL] |
| OQ-6 | Photo render quota per plan? | Owner | [OWNER TO FILL] |
| OQ-7 | Data residency: is Mumbai acceptable for UAE/UK clients contractually? | Owner + counsel | [OWNER TO FILL] |

---

## 15. Out of scope (non-goals for this release)

- Native iOS/Android apps (responsive web only).
- Full accounting or GST/VAT return filing.
- Guest ticketing and seat-by-seat ticket sales.
- Cross-studio vendor marketplace.
- Payroll.
- Real-time co-editing of the same floor plan by two users.
- A React/Next.js rewrite (attempted and discarded).

---

## 16. Legal, compliance and market coverage

| Market | Tax handled in product | Privacy law to satisfy | Notes |
|---|---|---|---|
| India | GST (CGST + SGST intra-state, IGST inter-state); GSTIN on invoices | Digital Personal Data Protection Act 2023 and DPDP Rules 2025 | Grievance officer, breach notice, consent records. Mapping in `docs/DATA-PROTECTION-REVIEW.md`. |
| UAE (Dubai) | VAT 5 %; TRN on tax invoices | Federal Decree-Law 45/2021 (PDPL); DIFC/ADGM rules if a studio is in a free zone | See `docs/UAE-AUDIT-2026-10.md`. |
| United Kingdom | VAT 20 % (standard) | UK GDPR, Data Protection Act 2018, PECR (cookies) | Cookie consent must be opt-in for non-essential cookies. |
| United States | Sales tax by state/locality (studio-configured rate) | CCPA/CPRA (California) and other state privacy laws; CAN-SPAM for email | No federal VAT. |
| EU (if served) | VAT by member state | EU GDPR; ePrivacy | SCCs for transfers to India. |

Legal pages exist and are linked from the footer: Terms, Privacy, Cookie policy, Acceptable use, DPA, Refund policy, Data deletion. **Final, lawyer-reviewed legal text is to be supplied by the owner** and inserted unchanged. This PRD is not legal advice.

---

## 17. Glossary

| Term | Meaning |
|---|---|
| Studio / organisation (org) | One customer business; all its data is isolated by `org_id`. |
| Quote / event | The same record. A quote becomes an event when confirmed. |
| Quote code | Human-readable ID, e.g. `12202026-01` (event date + sequence). |
| Version | Saved snapshot of the quote and layout; confirming locks it. |
| Change request | A scope change after confirmation that needs re-approval. |
| Milestone | A scheduled client payment (advance, balance). |
| Vendor bill / payout | What a vendor charges for an event / what the studio has paid against it. |
| Area | A permission area (leads, quotes, finance, ...) in the role matrix. |
| RLS | Row-level security: Postgres rules restricting rows per user. |
| Demo data | Sample records in a trial studio, labelled *Demo*. |
| OTP | One-time code used by clients to approve. |
| P&L | Profit and loss. |
| JTBD | Job to be done. |
| MoSCoW | Must / Should / Could / Won't prioritisation. |

---

## 18. Document history

| Version | Date | Change |
|---|---|---|
| 1.0 | 15 Oct 2026 | First PRD. |
| 2.0 | 16 Oct 2026 | Rewritten to standard structure: PR/FAQ, JTBD, requirement IDs with acceptance criteria, MoSCoW, KPIs, assumptions, risks, release plan, open questions, market coverage. |

---

## 19. References

1. Atlassian, "Product requirements document template" (Confluence). https://www.atlassian.com/software/confluence/templates/product-requirements
2. Atlassian, "How to write a product requirements document". https://www.atlassian.com/agile/product-management/requirements
3. Lenny Rachitsky, "My favorite product management templates" (1-pager / PRD). https://www.lennysnewsletter.com/p/my-favorite-templates-issue-37
4. Amazon "Working Backwards" PR/FAQ, described in C. Bryar and B. Carr, *Working Backwards* (2021); overview: https://workingbackwards.com/resources/working-backwards-pr-faq/
5. ISO/IEC/IEEE 29148:2018, *Systems and software engineering: Life cycle processes, Requirements engineering*. https://www.iso.org/standard/72089.html
6. IEEE 830-1998, *Recommended Practice for Software Requirements Specifications* (superseded by 29148). https://standards.ieee.org/ieee/830/1222/
7. Clayton Christensen Institute, "Jobs to Be Done" theory. https://www.christenseninstitute.org/theory/jobs-to-be-done/
8. Agile Business Consortium, "MoSCoW prioritisation" (DSDM). https://www.agilebusiness.org/dsdm-project-framework/moscow-prioririsation.html
9. W3C, Web Content Accessibility Guidelines (WCAG) 2.2. https://www.w3.org/TR/WCAG22/
10. Google, Core Web Vitals thresholds. https://web.dev/articles/vitals
11. Government of India, Digital Personal Data Protection Act 2023. https://www.meity.gov.in/data-protection-framework
12. UAE Federal Decree-Law No. 45 of 2021 on Personal Data Protection. https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws
13. UK Information Commissioner's Office, UK GDPR guidance. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/
14. California Privacy Protection Agency, CCPA/CPRA. https://cppa.ca.gov/regulations/
15. UAE Federal Tax Authority, VAT. https://tax.gov.ae/en/taxes/vat.aspx ; India GST Council. https://gstcouncil.gov.in/ ; HMRC VAT rates. https://www.gov.uk/vat-rates
