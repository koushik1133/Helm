# Helm: Implementation Plan for the Next Phase

| Field | Value |
|---|---|
| Document | docs/project/IMPLEMENTATION-PLAN.md (Prompt 7) |
| Date | 2026-10-17 |
| Scope | The NEXT phase of an existing product. Helm is already built and live. |
| Stack | Vanilla HTML/JS in `public/`, Vercel (`vercel.json`, `server.js`), Supabase Postgres + RLS (`supabase/migrations/`, latest definition wins), Edge Functions (`supabase/functions/`) |
| Environments | Production `helm.events`; staging `helm-v01.vercel.app` (see `docs/CANONICAL-DEPLOYMENT.md`, `docs/STAGING-SETUP.md`) |
| Related | `docs/product/IMPLEMENTATION-PLAN.md` (launch plan, 2026-10-16), `docs/RUNBOOK.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/DEFERRED-INTEGRATIONS.md`, `docs/ops/EMAIL-SETUP.md`, `docs/ops/WHATSAPP-SETUP.md`, `docs/LOGO-SWAP.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/workflow/KNOWN-GAPS.md` |

---

## 1. How to read this plan

Each phase lists: **Goal**, **Tasks**, **Files / modules**, **Prerequisites**, **DB / API changes**, **Tests**, **Done when**.

Rules that apply to every phase (from the project's standing rules):

- **Zero data loss.** Migrations are additive and idempotent only (`create or replace`, `add column if not exists`, new tables). No `drop`, no destructive `update`, no cross-tenant reads. Every new table gets `org_id` + RLS using `current_org_id()` and `has_area(...)`. See `docs/FILL-ONLY-MIGRATIONS.md` and `scripts/check-migration-canon.mjs`.
- **Staging first.** SQL runs on staging, gets tested, then runs on production in number order. Next free migration number: `0163` (latest on main is `0162_launch_bypass_off.sql`).
- **Local until told.** Work is built and tested locally; nothing is pushed to `main` until the owner says so.
- **Secrets.** Only secret *names* appear in docs or code. Values live in Supabase / Vercel dashboards.
- **CI gates.** `npm test`, `npm run check:csp`, `check:migration`, `check:deferred`, `check:env`, `check:deploy`, plus Playwright tags (`test:e2e:smoke`, `:roles`, `:lifecycle`) where UI changes.
- **Cache bump.** Changed JS/CSS needs its `?v=` bumped (`scripts/bump-changed-assets.mjs`) and CSP hashes regenerated (`scripts/gen-csp.mjs`).

Owner facts used throughout: email sender is `notifications@helm.events` with Reply-To set to the studio's email; WhatsApp is set up by the owner separately; Razorpay, SMS and WhatsApp are currently switched off; dark mode is off and the default theme is Emerald (green light).

---

## 2. Phase overview

| # | Phase | Size | Depends on | Risk |
|---|---|---|---|---|
| P1 | Manager questionnaire answers round | S | Owner/manager input | Low (docs/config only at first) |
| P2 | Logo rebrand (compass "H") | S | Final SVG from owner | Low |
| P3 | Email go-live | S | DNS for helm.events, Resend account | Low-Medium |
| P4 | Turnstile bot protection | S | Cloudflare account | Medium (can lock out sign-in if misconfigured) |
| P5 | Lead dedupe / overwrite fix | M | P1 answers (merge rule) | Medium (touches customer records) |
| P6 | Dashboard improvements | M | P1 answers | Low |
| P7 | Crew schedule polish | S-M | 0161 applied on both DBs | Low |
| P8 | Vendor bills polish | M | 0124 applied | Medium (money) |
| P9 | Time-aware calendar | L | P7 | Medium |
| P10 | WhatsApp go-live | M | Meta Business verification by owner | Medium |
| P11 | Razorpay go-live | L | Razorpay KYC, legal pages, P3 | High (money) |

Suggested order: P1 -> P2 -> P3 -> P4 -> P5 -> P7 -> P6 -> P8 -> P9 -> P10 -> P11. Integrations that need outside approval (P10, P11) can have their paperwork started on day one and run in parallel.

---

## P1. Manager questionnaire answers round

**Goal.** Turn the open business questions into written decisions before code is touched, so later phases do not guess.

**Tasks.**
1. Collect the open questions from `docs/business-questions` (Assumption: questions live there or in `docs/workflow/KNOWN-GAPS.md` / `docs/helm-team-workflows.md`; this worktree did not show a `docs/business-questions` folder, so confirm its location).
2. Send to the manager/owner as one short form. Group by phase below (lead merge rule, dashboard tiles, vendor bill approval, calendar time rules, WhatsApp templates, payment milestones).
3. Record answers in a single "Decisions" table in that doc with date and who decided.
4. Feed each answer into the matching phase's tasks.

**Files.** Docs only: `docs/business-questions/*` (or wherever confirmed), `docs/workflow/KNOWN-GAPS.md`.

**Prerequisites.** None.

**DB / API changes.** None.

**Tests.** None (documentation).

**Done when.** Every "Decision needed" item in this plan has a written answer or an explicit "use default".

Questions that must be in the round:

| Topic | Question |
|---|---|
| Leads | Decision needed: when a new quote/lead arrives with an email or phone already on file, should Helm (a) link to the existing contact and never overwrite, (b) ask the user, or (c) create a new record and flag a possible duplicate? |
| Dashboard | Decision needed: which KPI tiles matter per role, and which default period (7d / 1m / 6m / 1y)? |
| Vendor bills | Decision needed: does a vendor bill need approval before a payout can be recorded? Who approves? |
| Calendar | Decision needed: is a "conflict" the same venue at overlapping times, the same crew member at overlapping times, or both? Default event length when no end time is set? |
| WhatsApp | Decision needed: which messages go by WhatsApp (proposal, reminders, payment links) and the exact template wording for Meta approval. |
| Payments | Decision needed: Razorpay on the studio's own account or a platform account; who bears fees; refund policy text. |

---

## P2. Logo rebrand (compass "H")

**Goal.** Replace the current two-pill mark with the new compass-style "H" everywhere, in one controlled swap.

**What exists.** `docs/LOGO-SWAP.md` (updated 2026-10-16) documents a single source of truth: `public/brand/mark.svg` (`<symbol id="helm-mark">`, viewBox `0 0 48 48`) used by the app rail (`public/shell-b.js`), login and `hq.html`. Other copies: CSS pills `.mark i` on marketing/legal pages, loader paths in `public/shell-proto.js` (`HB_MARK`) and `public/marketing-loader.js` (`MARK`), `public/shell-b-loader-mark.svg`, favicon `public/brand/favicon.svg` plus `favicon.ico`, `favicon-48.png`, `apple-touch-icon.png`, `og.png`. A test `test/logo-bare-mark.test.mjs` guards the mark.

**Tasks.**
1. Get from owner: mark-only SVG (square, transparent) and mark + "Helm" wordmark SVG; light and dark variants if different.
2. Replace the `<symbol>` body in `public/brand/mark.svg` (main shape `currentColor`, accent part inheriting stroke).
3. Replace `public/brand/favicon.svg`; re-render PNG/ICO fallbacks using the `qlmanage` + `magick` steps in `docs/LOGO-SWAP.md`.
4. Marketing pages: the compass H is not two pills, so switch `.mark` spans to `<svg class="helm-mark"><use href="/brand/mark.svg#helm-mark"/></svg>` (58 pages) or a shared CSS rule.
5. Update loader outline paths (`HB_MARK`, `MARK`, `shell-b-loader-mark.svg`).
6. Regenerate `og.png` (1200x630).
7. Bump `SHELL_V` in `shell-proto.js`, `?v=` on `marketing-loader.js`, run `scripts/gen-csp.mjs`.
8. Check the mark against all 5 themes (light only; dark mode is off) with Emerald as default.

**Prerequisites.** Final artwork. Decision needed: wordmark font and whether the accent colour follows the theme.

**DB / API changes.** None.

**Tests.** Update `test/logo-bare-mark.test.mjs` to the new symbol; `npm run check:csp`; visual check of rail, login, marketing header/footer, loader, favicon, WhatsApp/LinkedIn link preview (re-scrape og:image).

**Done when.** No page shows the old pills (grep for `.mark i` rules returns only removed/unused code), favicons and og image updated, tests green.

---

## P3. Email go-live

**Goal.** All transactional email sends from `notifications@helm.events` with Reply-To = the studio's own email, reliably delivered.

**What exists.** Edge functions `invite-mailer`, `welcome-mailer`, `security-alert-mailer`, `billing-reminder`, `comms-dispatch`, `pkg-client-notify` use Resend (`RESEND_API_KEY`, `RESEND_FROM`). Each has an on/off switch: `HELM_INVITE_EMAILS_ENABLED`, `HELM_WELCOME_EMAILS_ENABLED`, `HELM_SECURITY_ALERTS_ENABLED`, `HELM_BILLING_REMINDERS_ENABLED`, `HELM_COMMS_ENABLED`, `HELM_PKG_NOTIFY_ENABLED`, with shared secrets `HELM_*_SECRET` for cron/webhook calls. Owner guide: `docs/ops/EMAIL-SETUP.md`; templates in `docs/ops/email-templates/` and `docs/email-templates/`. Supabase Auth emails (confirm, reset) are configured separately (`docs/AUTH-DASHBOARD-SETTINGS.md`).

**Tasks.**
1. Verify `helm.events` in Resend: SPF, DKIM, and a DMARC record (start at `p=none`, move to `quarantine` after 2 clean weeks).
2. Set `RESEND_FROM` to the `notifications@helm.events` sender on staging, then production.
3. Confirm every mailer sets `reply_to` to the studio email (read from the org record). Assumption: some mailers may still default Reply-To to a Helm address; check each function in `supabase/functions/*/index.ts` and fix any that do not.
4. Point Supabase Auth custom SMTP at the same domain so confirm/reset mails match.
5. Flip the `HELM_*_ENABLED` flags one at a time on staging; send each mail type to a test inbox (Gmail + Outlook) and check spam placement.
6. Repeat on production.
7. Add a short "email health" row to `docs/OBSERVABILITY-ACTIVATION.md` (bounce/complaint watch in Resend).

**Prerequisites.** DNS access for helm.events; MX for the domain if replies to `notifications@` must be received (Decision needed: should `notifications@` be no-reply or a monitored inbox?).

**DB / API changes.** None expected. If Reply-To needs a studio-level override, add a nullable `orgs.reply_to_email` column in an additive migration (`0163_...`).

**Tests.** Existing `test/invite-mailer.test.mjs`, `test/comms-automation.test.mjs`, `test/edge-functions-hardening.test.mjs`; add an assertion that each mailer builds `reply_to` from the studio record; manual inbox test matrix.

**Done when.** All six mail types arrive in inbox (not spam) from `notifications@helm.events`, reply goes to the studio, DMARC reports clean.

---

## P4. Turnstile bot protection

**Goal.** Protect sign-in, sign-up and password reset against bots with Cloudflare Turnstile.

**What exists.** The client side is already wired: `public/config.js` has `captcha: { provider: "turnstile", siteKey: "" }` (empty = off); `public/store-api.js` reads it (around lines 285 and 340); `public/auth-ui.js`, `public/login.html` and `public/trusted-types.js` handle the widget. The secret key belongs in Supabase Auth's CAPTCHA setting (`docs/AUTH-DASHBOARD-SETTINGS.md`), never in `config.js`.

**Tasks.**
1. Create a Turnstile site in Cloudflare for `helm.events` and `helm-v01.vercel.app` (separate keys per environment preferred).
2. Put the site key in `public/config.staging.js` (staging) and test.
3. Enable CAPTCHA protection in the Supabase staging Auth settings with the Turnstile secret.
4. Confirm CSP in `vercel.json` / `public/_headers` allows `challenges.cloudflare.com` for script and frame; rerun `gen-csp`.
5. Test email+password sign-in, sign-up, reset, invite sign-up (`invite-signup` function), Google sign-in (should not be blocked), and the trial flow (`try.html`).
6. Repeat on production in one window, with rollback = blank the site key and switch off CAPTCHA in Supabase.

**Prerequisites.** Cloudflare account. P3 is helpful (reset emails must work to test reset).

**DB / API changes.** None. Supabase Auth setting only.

**Tests.** `test/auth-gate.test.mjs`, `test/auth-session-hardening.test.mjs`, `test/html5-config-hardening.test.mjs`; Playwright `test:e2e:security`. Add a test that `config.js` never contains a Turnstile secret pattern (extend `scripts/check-env-safety.mjs`).

**Done when.** All auth paths work with the widget on both environments, and a request without a token is refused by Supabase.

---

## P5. Lead dedupe / overwrite fix

**Goal.** A new quote or lead that shares an email or phone with an existing lead must never silently overwrite the older person's details.

**What exists.** Leads live in `leads` (with `lead_id` history rows; see the history columns in `public/store-api.js` around line 3410). Quotes (the quote IS the event) carry their own client name/phone/email. Nurture contacts convert into leads via `nurture.convertToLead` (`public/store-api.js` ~line 3592), which always creates a new lead. Phone/email values are protected by the crypto layer (`supabase/migrations/0026_business_logic_crypto.sql`). The client timeline joins on these fields (`0062_client_timeline.sql`). Assumption: the overwrite happens where a quote is created from or linked to a lead by matching email; the exact code path was parked by the owner as "fix option A" and needs to be re-located before coding.

**Tasks.**
1. Find every path that writes lead/client contact fields from a quote (quote save, approval, portal edits, lead import in `smart-import.js`).
2. Implement the decided rule (P1). Recommended default (option A): **match = link, never overwrite**. If the incoming name differs, keep the existing lead, attach the quote, and log the new values in lead history for a person to accept.
3. Add a "Possible duplicate" badge in `leads.html` / CRM with a manual **Merge** action that moves quotes onto one lead and archives the other (archive, never delete).
4. Normalise matching: email lower-case and trimmed; phone in E.164 using `public/phone-input.js`.

**Prerequisites.** P1 decision on the merge rule.

**DB / API changes.** Additive migration `0164_lead_dedupe.sql`: a normalised match key (generated or helper function), a read-only `find_lead_matches(p_email, p_phone)` RPC (SECURITY DEFINER, scoped by `current_org_id()`, gated by `has_area('leads','view')`), and a `merge_leads(p_keep, p_archive)` RPC that only re-points `quote_id` links and sets `archived_at`. No row deletion, no unique constraint on existing data (existing duplicates would fail it).

**Tests.** New `test/lead-dedupe.test.mjs` (same email different name keeps original; different studios with same email never match); DB test in `scripts/db-test/` for cross-tenant isolation (`npm run test:isolation`); Playwright `@lifecycle`.

**Done when.** Re-running the original bug scenario leaves the first lead unchanged, duplicates are flagged, merge works, and no other studio's lead is ever matched.

---

## P6. Dashboard improvements

**Goal.** Make the dashboard answer "what needs me today" per role, with a working period filter.

**What exists.** `public/dashboard.html`, `public/shell-b-dash.js` (KPI period filter block "DP:start", tested by `test/dashboard-period.test.mjs`), `public/dash-prompts.js`, `public/dashboard-polish.css`; tests `dashboard-money`, `dashboard-redesign`, `dashboard-customize`, `dashboard-seemore-1017`. Business totals come from `business_pnl` / `vendor_payables_summary` (0124).

**Tasks.**
1. Confirm the 7d / 1m / 6m / 1y filter is live on prod and applies to every KPI tile (Assumption: built in `shell-b-dash.js`; verify each tile respects it).
2. Role-based default layouts (admin/manager: money + pipeline; sales: leads/quotes; planner/coordinator: upcoming events and tasks; crew: own schedule only) using the existing customise feature.
3. "Today" strip: events today/tomorrow, overdue tasks, unpaid milestones due, vendor bills due (from P8).
4. Empty states and fast loading (reuse `test/boot-perf.test.mjs` budget).
5. Money tiles respect `has_area('finance', ...)`; never show money to roles without it.

**Prerequisites.** P1 tile decisions. P8 for payables tile.

**DB / API changes.** Possibly one read-only RPC `dashboard_today()` (additive, org-scoped). No table changes.

**Tests.** Extend existing dashboard tests; role test in `test/role-access-audit.test.mjs` that crew/designer see no money tiles; Playwright `@roles`.

**Done when.** Each role sees its own default view, period filter works on all tiles, money hidden from non-finance roles.

---

## P7. Crew schedule polish

**Goal.** Make the new crew schedule (Week / Month / Team week) comfortable on phones and clear about shifts.

**What exists.** `supabase/migrations/0161_crew_schedule.sql` adds read-only RPC `crew_schedule(p_from, p_to, p_staff)`, returning schedule fields only (no money, no client contact), crew limited to own rows, 62-day cap. UI in `public/crew-schedule.js` + `public/crew-schedule.css`, test `test/crew-schedule-ui.test.mjs`.

**Tasks.**
1. Confirm 0161 is applied on staging and production (`supabase/migrations/MANIFEST`, `docs/RUNBOOK.md` apply steps).
2. Mobile layout pass (320-414px): day list instead of grid on narrow screens; tap targets 44px.
3. Show shift times from `planned_start`/`planned_end`; mark "time not set" clearly.
4. Clash hint when one crew member has two tasks overlapping in time (client-side, from returned rows).
5. "Add to my phone calendar" (.ics download per shift) - Decision needed: allowed for crew?
6. Empty state for crew with no linked `crew_members.profile_id`, telling them to ask their admin.

**Prerequisites.** 0161 on both DBs.

**DB / API changes.** None (reuse `crew_schedule`).

**Tests.** Extend `test/crew-schedule-ui.test.mjs`; Playwright `@responsive` and `@roles` (crew cannot see another crew member via `p_staff`).

**Done when.** Usable on a phone, overlap hint works, crew isolation verified.

---

## P8. Vendor bills polish

**Goal.** Make vendor bills and payouts easy and trustworthy, so per-event and studio profit are right.

**What exists.** `supabase/migrations/0124_vendor_bills.sql`: tables `vendor_bills` (void with reason, never delete) and `vendor_payouts` (only via idempotent `record_vendor_payout`, cannot overpay), and read-only `event_pnl`, `vendor_payables_summary`, `business_pnl`. Access: same studio + `finance` area. UI: `public/vendor-bills-ui.js`, `public/vendor-bills.css`, used from `settlement.html`, `quotes.html`, `business.html`/`business.js`. Audit coverage added in `0135_audit_more_tables.sql`.

**Tasks.**
1. Bill entry: attach photo/PDF via existing upload path (`verify-upload` scan), due-date picker, vendor prefill from the event's bookings.
2. Payables list on Business page: filters (due, overdue, paid, void), sort by due date, totals per vendor.
3. Partial payments shown clearly (paid / open balance), payout history per bill.
4. Optional approval step if P1 says so (status `draft -> approved -> paid`).
5. Settlement page: show bills vs booking cost so the "one source per booking" rule is visible to the user.
6. Export payables to Excel (`public/xlsx-lite.js`).

**Prerequisites.** 0124 on both DBs; P1 approval decision.

**DB / API changes.** If approval is wanted: additive `0165_vendor_bill_approval.sql` adding `approved_by`, `approved_at` (nullable) and updating `record_vendor_payout` to require approval only when a studio setting is on. Existing bills stay valid (null = approved under old behaviour).

**Tests.** Money tests (`test/money-trust-boundary.test.mjs`, `test/per-currency-totals.test.mjs`); new DB tests: payout idempotency, no overpay, void blocked when paid, cross-tenant refusal; UI test for list filters.

**Done when.** A full event can go bill -> partial payout -> full payout -> correct net profit on `event_pnl` and the Business page.

---

## P9. Time-aware calendar

**Goal.** The calendar understands start and end times, not just dates, and flags real overlaps.

**What exists.** Quotes have `event_date` and `event_time` (text) (seen in `0004`, `0009`, `0012`); tasks have `planned_start`/`planned_end` timestamps (used by 0161). `public/calendar.html` shows events by date. A previous attempt (Phase 10b) was built and reverted (commit ff7646b), so this is a redo.

**Tasks.**
1. Add optional end time to events (UI on quote/event page; default length from P1).
2. Calendar day/week views with time blocks; month view unchanged.
3. Conflict rule from P1: same venue overlapping times and/or same crew overlapping times. Show as a warning, never block saving.
4. Time zone: store as studio local time with the studio's country profile (`public/country-profile.js`); show it.
5. Keep events without time working ("all day").

**Prerequisites.** P1 conflict rule; P7 done (shares overlap logic).

**DB / API changes.** Additive `0166_event_time_window.sql`: nullable `quotes.event_start_at timestamptz`, `quotes.event_end_at timestamptz`, a backfill-free read path (if null, fall back to `event_date` + `event_time`), and a read-only `calendar_conflicts(p_from, p_to)` RPC scoped by org. No change to existing `event_time` values.

**Tests.** `test/date-guard.test.mjs` extension; new overlap unit tests (touching edges are not conflicts; all-day vs timed); DB isolation test; Playwright calendar smoke.

**Done when.** Timed events show in day/week view, overlaps flagged per the rule, old date-only events unchanged.

---

## P10. WhatsApp go-live

**Goal.** Send approved WhatsApp templates (proposal links, reminders) from the studio's number, opt-in respected.

**What exists.** Built and dormant: edge functions `send-whatsapp`, `wa-webhook`, `wa-proposal`, `send-phone-code`; UI `public/wa-proposal.js`, `public/integrations*.js`, `public/comms-settings.js`. Client flag `liveChannels.whatsapp: false` in `public/config.js`. Secrets by name: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATES`, `WHATSAPP_TPL_LANG`, `WHATSAPP_REQUIRE_OPTIN`, `WHATSAPP_ALLOW_TEXT`, `WHATSAPP_VERIFY_TEMPLATE`, `WHATSAPP_VERIFY_LANG`, `PKG_WHATSAPP_TEMPLATE`. Guides: `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/ops/WHATSAPP-SETUP.md`, `docs/DEFERRED-INTEGRATIONS.md`. CI check `check:deferred` keeps it off until intended.

**Tasks.**
1. Owner completes Meta Business verification and number setup (owner does this separately).
2. Submit templates for approval with wording from P1.
3. Set secrets on staging; deploy functions; register webhook URL for `wa-webhook` with the verify token.
4. Flip `liveChannels.whatsapp` in `config.staging.js` only; test send, delivery status, opt-out, template fallback.
5. Update `scripts/check-deferred-integrations.mjs` expectations for the live state (deliberately).
6. Production: same, then flip `config.js`.

**Prerequisites.** Meta approval; P1 templates.

**DB / API changes.** None expected (comms tables exist). Assumption: opt-in storage exists from the earlier build; verify before go-live.

**Tests.** `test/wa-proposal.test.mjs`, `test/deferred-integrations.test.mjs` (update), `test/edge-functions-hardening.test.mjs`; webhook signature check with `WHATSAPP_APP_SECRET`.

**Done when.** A real proposal template is delivered on staging and production, webhooks update status, opt-out stops sends.

---

## P11. Razorpay go-live

**Goal.** Studios can collect client payments by Razorpay Payment Link, and Helm can bill studios by subscription.

**What exists.** Built and dormant: `create-payment-link`, `razorpay-webhook`, `create-subscription-checkout`, `razorpay-subscription-webhook`, `billing-reminder`; UI `public/checkout.html`, `public/sim-pay.html` (test-only), `public/hq-invoice.js`. Flags: `liveChannels.pay: false` in `config.js`, server `HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED`, HQ `online_payments_live`. Secrets by name: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET`, `RAZORPAY_EVENT_MAX_AGE_SEC`, `RAZORPAY_REQUIRE_STUDIO_ACCOUNT`, `PAYMENT_LINK_TTL_MINUTES`. Server pricing authority (D8) is enforced in the DB. Launch bypass turned off in `0162_launch_bypass_off.sql`.

**Tasks.**
1. Owner: Razorpay KYC; decide studio-own vs platform account (P1).
2. Staging with Razorpay **test** keys: create link, pay with Razorpay's published test card, webhook marks milestone paid in the ledger, duplicate webhook ignored (idempotent), expired link handled.
3. Confirm settlement "Received" reads the ledger and `close_event` balance gate behaviour (open P1 items from the October E2E audit; verify they are fixed before money goes live).
4. Subscription checkout for studios on staging.
5. Legal pages final: `refund-policy.html`, `terms.html`, `pricing.html`.
6. Production with live keys behind `liveChannels.pay`, one studio pilot first.

**Prerequisites.** P3 (receipts by email), KYC, legal review.

**DB / API changes.** Assumption: none, ledger and webhooks exist. Any fix from step 3 is an additive migration.

**Tests.** `test/money-trust-boundary.test.mjs`, `test/d8-pricing-authority-gap.test.mjs`, `test/pricing-differential*.test.mjs`, `test/sim-pay-prod-ui.test.mjs`, `test/onboarding-checkout.test.mjs`, `test/hq-checkout-ui.test.mjs`, `test/deferred-integrations.test.mjs` (update); webhook replay/old-event tests.

**Done when.** Pilot studio collects a real payment end to end, the ledger and settlement agree, and the webhook is replay-safe.

---

## 3. Cross-phase checklist per release

| Step | Command / place |
|---|---|
| Unit + guard tests | `npm test` |
| CSP | `npm run check:csp` (regenerate with `node scripts/gen-csp.mjs`) |
| Migration canon | `npm run check:migration` |
| Env / secrets safety | `npm run check:env` |
| Deferred integrations state | `npm run check:deferred` |
| DB tests + tenant isolation | `npm run test:db`, `npm run test:isolation` |
| E2E | `npm run test:e2e:smoke`, `:roles`, `:lifecycle` |
| SQL apply | staging first, then prod in number order (`docs/RUNBOOK.md`) |
| Rollback plan | flags off first; SQL is additive so no rollback SQL needed (`docs/DISASTER-RECOVERY-RUNBOOK.md`) |

---

## 4. Recommended first task

**Run the manager questionnaire round (P1) and, in the same week, the logo rebrand (P2).**

Why: P1 costs no code and unblocks the decisions needed for lead dedupe, dashboard, vendor bills, calendar, WhatsApp and Razorpay. P2 is a small, safe, visible win with a ready checklist (`docs/LOGO-SWAP.md`) and only needs the final compass "H" SVG from the owner. Meanwhile the owner can start Meta and Razorpay verification, which take the longest.

First concrete step: send the six-question table in P1 to the manager, and ask the owner for the compass "H" SVG files (mark-only and mark + wordmark).
