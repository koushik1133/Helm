# Helm: Implementation Plan (Today to Production Launch and Beyond)

| Field | Value |
|---|---|
| Document | IMPLEMENTATION-PLAN.md |
| Version | 1.0 |
| Date | 2026-10-16 |
| Status | Draft for owner review |
| Product | Helm, a multi-tenant event-management SaaS for event studios (vanilla HTML/JS on Vercel, Supabase Postgres + RLS + Edge Functions) |
| Production DB | `nqltzgiwznphugcfhmbm` |
| Staging DB | `helm-staging` (`xizehqgeyjcfpzrdymly`) |
| Companion docs | `docs/product/PRD.md`, `docs/product/TRD.md`, `docs/product/USER-MANUAL.md`, `docs/RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md` |

---

## 1. Purpose and Guiding Rules

This plan moves Helm from its current state (feature-complete on staging, production frontend and database behind staging) to a public production launch, and then through the post-launch roadmap. Every workstream lists tasks, owner, dependencies, effort, acceptance criteria and risk.

**Non-negotiable rules that apply to every task below:**

1. **Zero data loss.** Migrations are additive and idempotent only. No `DROP TABLE`, `DELETE`, or `TRUNCATE` of real data. Archive, never delete. Paid ledger and consent rows are never removed (FK `RESTRICT` exists).
2. **Staging first.** Every SQL file runs on staging, its VERIFY returns all `ok = true`, and the affected screen is tested in the app, before the same file runs on production.
3. **Owner runs SQL.** The developer prepares SQL and VERIFY files; the owner pastes them into the Supabase SQL editor. Copy with `LANG=en_US.UTF-8 pbcopy < file` (plain `pbcopy` garbles non-ASCII characters).
4. **Local only until told.** No `git push`, PR, or production deploy until the owner says "push to main".
5. **Backup before any production change**, and a backup is only valid once a test restore has succeeded.
6. **Integrations fail closed.** `public/config.js` `liveChannels.pay` and `liveChannels.whatsapp` stay `false` until their workstream's go-live gate passes; the CI guard `check-deferred-integrations` is updated in the same commit that flips a flag.

### 1.1 Roles

| Role | Who | Responsibilities |
|---|---|---|
| **Owner** | Business owner / platform admin | Dashboard settings (Supabase, Vercel, Google Cloud, Razorpay, Meta, DNS), running SQL, legal sign-off, content (logo, photos, clips), go/no-go decisions |
| **Dev** | Developer (Claude-assisted) | Code, SQL + VERIFY files, tests, docs, release notes, rollback scripts |
| **Legal** | External counsel [OWNER TO FILL] | Review of Terms, Privacy, DPA, refund and cookie policies |

### 1.2 Effort scale

| Size | Meaning |
|---|---|
| XS | under 1 hour |
| S | half a day |
| M | 1 to 2 days |
| L | 3 to 5 days |
| XL | more than 1 week |

---

## 2. Current State Snapshot (2026-10-16)

| Area | State |
|---|---|
| Frontend | Many features built and tested locally / on staging (trial flow, dashboard due-today, vendor bills + P&L, landing redesign, shell-b app shell). Production (`www.helm.events`) runs an older `origin/main` build. |
| Database | Migrations 0116, 0118 to 0124 applied on **staging only**. 0125 prepared, not run anywhere. 0117 (per-studio Razorpay/WhatsApp accounts) prepared, **do not run yet**. 0108 to 0115 believed on prod; must be re-verified. |
| Prod SQL bundle | Ready in `supabase/PROD-BUNDLE-2026-10/` (precheck, backup, APPLY + VERIFY 0116 to 0125, optional 0108 to 0115, `DO-NOT-RUN-YET/APPLY-0117.sql`). |
| Prod test data | Test studios, junk rows and 11 accounts on published default passwords exist. Cleanup kit in `supabase/prod-cleanup/` (inventory, backup, archive, test users, onboard clients). Owner has said: do not touch prod data until told. |
| Auth | Email/password + Google sign-in working. MFA TOTP on, leaked-password protection on, min length 12. Turnstile CAPTCHA and Google PKCE parked. |
| Integrations | WhatsApp (Meta Cloud API) and Razorpay (Payment Links + HMAC webhook) built, dormant. |
| Email | Resend-based sender exists in edge functions; `helm.events` has no MX records, so `@helm.events` mailboxes cannot receive mail. |
| Monitoring | Sentry hook present and no-op until a DSN is set (`docs/OBSERVABILITY-ACTIVATION.md`). |
| Branding | New logo pending; swap checklist ready in `docs/LOGO-SWAP.md`. |
| Region | TRD records the production project in **ap-south-1 (Mumbai)**. [OWNER TO FILL: confirm in Supabase Dashboard -> Project Settings -> General. If prod is already ap-south-1, workstream W4 reduces to verifying staging and edge-function regions.] |

---

## 3. Workstreams

Each workstream has an ID (W1 to W17) used in the timeline and checklist.

### W1. Production SQL bundle (PROD-BUNDLE-2026-10)

| Field | Detail |
|---|---|
| Goal | Bring the production database to parity with staging before the new frontend ships. |
| Owner | Owner (runs SQL), Dev (prepares, reviews results) |
| Dependencies | W2 backup taken and test-restored. 0125 must pass on staging first. |
| Effort | M (about 2 hours of pasting + verification, plus staging run for 0125) |
| Risk | Medium. Mitigated: every APPLY is guarded (fails before changing anything if a prerequisite is missing), idempotent, and has a VERIFY. Old frontend keeps working after the bundle runs (see bundle README compatibility table). |

**Tasks**

| # | Task | Owner |
|---|---|---|
| 1.1 | Run `18-APPLY-0125.sql` + `18-VERIFY-0125.sql` on **staging**; pay one milestone's exact remaining balance in the app; confirm a lead edit shows in the Audit log. | Owner |
| 1.2 | On prod: run `00-PRECHECK.sql`; all PREREQ rows true. Share the result. | Owner |
| 1.3 | Run only the `optional-0108-0115...` files whose precheck rows are false, in number order. | Owner |
| 1.4 | Run `02-BACKUP-function-defs.sql`; download the result as CSV and store offline. This is the function-level rollback. | Owner |
| 1.5 | Run steps 10 to 18 in order (0116, 0118, 0119, 0120, 0121, 0122, 0123, 0124, 0125), each followed by its VERIFY. Stop at the first `ok = false`. | Owner |
| 1.6 | Re-run `00-PRECHECK.sql`: every row true except the 0117 row. | Owner |
| 1.7 | Update the staging-vs-prod tracker and `supabase/migrations/MANIFEST` notes. | Dev |

**Acceptance criteria**
- Every VERIFY row on prod returns `ok = true`; final precheck all true except 0117.
- Live (old) frontend still loads dashboard, quotes, payments without errors.
- Function-definition CSV saved offline.

### W2. Backup and restore drill

| Field | Detail |
|---|---|
| Goal | A proven, restorable copy of production before any production change. |
| Owner | Owner |
| Dependencies | Database password; `pg_dump` version 17 or newer. |
| Effort | S |
| Risk | High if skipped. Everything in W1, W3 and W4 depends on it. |

**Tasks**
1. Note the latest dashboard backup timestamp (and PITR restore point if enabled) per `supabase/prod-cleanup/02-BACKUP.md`.
2. Take a `pg_dump -Fc` of `public`, `auth`, `storage`, plus readable schema copies; store offline and encrypted.
3. Restore the dump into a scratch project (or local Postgres) and spot-check row counts of `organizations`, `quotations`, `payments`/ledger, `auth.users`.
4. Record timestamp, file hash and row counts in the release log.

**Acceptance criteria:** restore succeeds; row counts match the inventory query (`supabase/prod-cleanup/01-INVENTORY.sql`).

### W3. Frontend push to production

| Field | Detail |
|---|---|
| Goal | Ship the tested local/staging frontend to `www.helm.events`. |
| Owner | Dev (prepare release), Owner (says "push to main", smoke-tests) |
| Dependencies | W1 complete on prod (new screens call 0116 to 0125 functions). W8 legal pages final. W9 assets in place or hidden. |
| Effort | M |
| Risk | Medium. Cache-busting and CSP hashes are the usual failure points. |

**Tasks**
1. Freeze scope; list changes since last prod release (release notes).
2. Run the full local test suite, `node scripts/gen-csp.mjs`, and CI checks (`check-env-safety`, `check-deferred-integrations`).
3. Bump `?v=` cache keys on changed CSS/JS.
4. Owner says "push to main"; Dev pushes; Vercel auto-deploys.
5. Smoke test on production (Section 5.3) on desktop and phone.
6. Tag the release commit (for rollback).

**Acceptance criteria:** smoke test passes; no console CSP violations; Sentry (W15) shows no new error spike for 24 hours.

### W4. Region confirmation / move to ap-south-1

| Field | Detail |
|---|---|
| Goal | Host data in Mumbai (ap-south-1) for India-first latency and data-residency comfort under the DPDP Act. |
| Owner | Owner (dashboard), Dev (runbook, config change) |
| Dependencies | W2. If a move is needed, it must happen **before** W5 cleanup and W14 user reset is cheaper after it, and before public launch. |
| Effort | XS if already ap-south-1; XL if a move is required. |
| Risk | High if a move is needed: Supabase does not move a project between regions in place; it requires a new project, dump/restore, auth users + storage objects copy, edge-function redeploy, secrets re-set, new URL/anon key in `config.js`, and Google OAuth callback update. |

**Tasks**
1. Confirm prod and staging regions in the dashboard. [OWNER TO FILL]
2. If prod is not in ap-south-1: create new project in ap-south-1 on the same plan; restore the W2 dump; copy storage buckets; redeploy edge functions and secrets; run all VERIFY files; update `public/config.js`, CSP `connect-src`, Google OAuth redirect URI, Razorpay webhook URL, Supabase Auth URL configuration; schedule a maintenance window; keep the old project read-only for 30 days.
3. Measure p95 page-load from India and UAE before and after.

**Acceptance criteria:** Project Settings shows ap-south-1; all VERIFY files true on the target project; login (email + Google), quote, payment and invitation flows pass.

### W5. Production test-data cleanup

| Field | Detail |
|---|---|
| Goal | Remove test studios and junk rows from the customer-visible surface without deleting data. |
| Owner | Owner (decides test vs real, runs SQL), Dev (scripts) |
| Dependencies | Owner's explicit go-ahead (currently "do not touch prod data"). W2 backup. |
| Effort | M |
| Risk | High (data). Mitigated: the kit archives rather than deletes. |

**Tasks**
1. Run `01-INVENTORY.sql`; owner marks each studio Test / Real / Unsure.
2. Complete `02-BACKUP.md` checklist.
3. Run `03-ARCHIVE-TEST-STUDIOS.sql` only for studios marked Test.
4. Handle junk rows (e.g. quotation versions with absurd totals, keyboard-mash crew/task rows) by archiving/flagging, never hard delete.
5. Follow `04-TEST-USERS.md` and `05-ONBOARD-CLIENTS.md`.

**Acceptance criteria:** no test studio visible in HQ active lists or reports; inventory re-run shows only Real studios active; ledger totals for Real studios unchanged.

### W6. Default-password user reset and staff on @helm.events

| Field | Detail |
|---|---|
| Goal | Close the open risk of 11 production accounts on passwords published in the repositories. |
| Owner | Owner |
| Dependencies | W7 (MX for helm.events) so new staff mailboxes receive invites and recovery mail. |
| Effort | S |
| Risk | **Critical while open.** Anyone can sign in as `admin@helm.com` on prod. Recommendation: rotate these passwords immediately even before the full reset; it does not lose data. |

**Tasks**
1. Immediately: rotate `admin@helm.com` and the other 10 accounts (or run `supabase/audit/P3-FIX-rotate-default-passwords.sql`); use "sign out other devices"; confirm whose Windows sessions were seen.
2. Create `admin@helm.events` and `security@helm.events` as platform admins (HQ).
3. Recreate staff via Control Center temp-password flow (forced change on first login).
4. Disable or archive old `@helm.com` demo accounts (no deletion of linked records).
5. Run `P3-CHECK-default-passwords.sql`; it must return **0 rows** (Dev reads the row count from the screenshot).

**Acceptance criteria:** P3-CHECK returns 0 rows; all platform admins have MFA enrolled.

### W7. Email sender and domain mail

| Field | Detail |
|---|---|
| Goal | Reliable transactional mail (invites, password reset, trial reminders, receipts) from a verified `helm.events` sender, and working inboxes. |
| Owner | Owner (DNS, provider accounts), Dev (templates, config) |
| Dependencies | Domain DNS access. |
| Effort | M |
| Risk | Medium. Without SPF/DKIM/DMARC mail lands in spam; Gmail and Yahoo require authentication and DMARC for bulk senders since 2024. |

**Tasks**
1. Choose mailbox provider (Google Workspace or Zoho) and add MX records. [OWNER TO FILL]
2. Verify `helm.events` in Resend; add its DKIM and SPF records; publish DMARC starting at `p=none` with reports, then move to `quarantine`.
3. Set `RESEND_FROM` (e.g. `Helm <no-reply@helm.events>`) in edge-function secrets on prod and staging.
4. Configure Supabase Auth custom SMTP with the same sender so auth emails do not use the shared default sender (rate-limited).
5. Apply templates from `docs/email-templates/`; test invite, reset, confirm, trial reminder.
6. Create `security@helm.events`; enable GitHub private vulnerability reporting.

**Acceptance criteria:** mail-tester score 9/10 or better; all auth emails delivered to Gmail and Outlook inboxes; DMARC aggregate report received.

### W8. Legal finalisation (India, UAE, UK, EU, US)

| Field | Detail |
|---|---|
| Goal | Publish final, jurisdiction-aware Terms of Service, Privacy Policy, Cookie Policy, Refund/Cancellation Policy, Data Processing Addendum, Acceptable Use Policy, and Sub-processor list. |
| Owner | Dev (drafts), Legal + Owner (sign-off) |
| Dependencies | Final company details: legal entity name, registered address, grievance officer, governing law. [OWNER TO FILL] |
| Effort | L |
| Risk | High for launch: Razorpay activation requires live Terms, Privacy, Refund and Contact pages; DPDP requires notice and grievance details. |

**Tasks**
1. Reconcile `public/terms.html`, `public/privacy.html` and other legal pages against the General-Legal templates and `docs/DATA-PROTECTION-REVIEW.md`, `docs/INDIA-AUDIT-2026-10.md`, `docs/UAE-AUDIT-2026-10.md`.
2. Cover: India DPDP Act 2023 + DPDP Rules 2025 (notice, consent, grievance officer, breach notice, children), IT Act and Intermediary Rules (grievance officer), Consumer Protection (E-Commerce) Rules 2020 (refund policy); UAE PDPL (Federal Decree-Law 45/2021); UK GDPR + PECR cookies; EU GDPR Art. 28 DPA; US CCPA/CPRA notice.
3. Publish sub-processor list (Supabase, Vercel, Resend, Razorpay, Meta, Sentry, Google).
4. Add "last updated" dates and version history; link from footer, sign-up and checkout.
5. Cookie banner: reject non-essential by default where required (UK/EU).
6. Legal counsel review and sign-off. [OWNER TO FILL]

**Acceptance criteria:** counsel sign-off recorded; all pages reachable from footer and sign-up; Razorpay website-compliance checklist satisfied.

### W9. Landing page assets

| Field | Detail |
|---|---|
| Goal | Replace placeholders on the marketing site with real hero clips, event photos and layout screenshots. |
| Owner | Owner (supplies media and rights), Dev (encode, place, optimise) |
| Dependencies | Logo (W10) for consistent visuals. Photo/video usage rights or model releases. |
| Effort | M |
| Risk | Low technically; medium for performance (large video) and rights. |

**Tasks**
1. Owner delivers: 2 to 4 hero clips (6 to 12 seconds, no audio), 8 to 12 event photos, current app screenshots (desktop + phone, light + dark).
2. Dev encodes video to H.264 MP4 + WebM, under about 2 MB each, with poster image; images to AVIF/WebP with `srcset`, explicit width/height.
3. Respect `prefers-reduced-motion`; lazy-load below the fold.
4. Decide whether `mk-demos` / demo videos ship. [OWNER TO FILL]

**Acceptance criteria:** Lighthouse mobile performance 85 or higher on `/`; LCP under 2.5 s on a 4G profile; CLS under 0.1; usage rights recorded.

### W10. Logo swap

| Field | Detail |
|---|---|
| Goal | Apply the new brand mark across marketing, app shell, loaders, favicons and social images. |
| Owner | Owner (delivers SVGs), Dev (implements per `docs/LOGO-SWAP.md`) |
| Dependencies | Final logo files: square mark SVG, mark + wordmark SVG, light/dark variants. |
| Effort | S |
| Risk | Low. CSP hash regeneration needed for `login.html`; social caches need re-scrape. |

**Tasks:** follow `docs/LOGO-SWAP.md` sections 1 and 2; regenerate CSP; bump `?v=`; re-scrape `og.png` with Facebook Sharing Debugger, LinkedIn Post Inspector and X.

**Acceptance criteria:** no old mark visible on any of the 58 public pages, app rail, loader, login; favicon correct in Chrome, Safari and iOS home screen.

### W11. Self-serve trial launch

| Field | Detail |
|---|---|
| Goal | "Start free trial" creates a studio with sample data, 8-day trial, reminders, read-only after expiry until a plan is chosen. |
| Owner | Dev, Owner (pricing and trial length decision) |
| Dependencies | W1 (0116, 0118 to 0123), W3, W7 (reminder emails), W8 (Terms at sign-up). |
| Effort | M |
| Risk | Medium: abuse (mass sign-ups) until Turnstile (W16) is on. |

**Tasks**
1. Confirm `helm_billing_settings.trial_days` (default 8). [OWNER TO FILL]
2. End-to-end test on staging: sign-up -> Demo studio with sample data -> reminders at 3 days / tomorrow / today -> read-only after expiry -> HQ extend trial.
3. Make sure all marketing copy says the same trial length (remove any "14-day" text).
4. Enable trial reminder emails once W7 is done.
5. Enable Turnstile (W16) before public announcement.

**Acceptance criteria:** full trial lifecycle passes on staging and prod; expired studio data intact and readable; HQ can extend.

### W12. Payments: per-studio Razorpay (migration 0117)

| Field | Detail |
|---|---|
| Goal | Each studio collects client payments into its own Razorpay account through Payment Links; webhook marks milestones paid. |
| Owner | Owner (Razorpay account, KYC, keys), Dev (0117, edge functions, UI) |
| Dependencies | W8 legal pages live (Razorpay activation), W1, W3. Decision: per-studio keys vs Razorpay Route (marketplace). [OWNER TO FILL] |
| Effort | L |
| Risk | High (money). Mitigations: HMAC-verified, idempotent webhook; keys only in server-side storage; flag stays false until tested. |

**Tasks**
1. Decide model: per-studio API keys stored encrypted (0117 `integration accounts`) or Razorpay Route linked accounts.
2. Run `DO-NOT-RUN-YET/APPLY-0117.sql` on **staging**; VERIFY all true.
3. Studio settings screen: connect Razorpay (key id + secret, stored server-side only; never returned to browser).
4. Test mode end to end on staging with Razorpay test keys: create link, pay with test card, webhook updates ledger, replay is idempotent, refund flow.
5. Register webhook (Verify-JWT off for `razorpay-webhook`), set secrets, deploy functions.
6. Flip `liveChannels.pay = true` and update the CI guard in the same commit.
7. Pilot with one real studio, small real payment, then open to all.

**Acceptance criteria:** test-mode lifecycle passes; replayed webhook does not double-count; no secret in client bundle or repo (CI check); reconciliation report matches Razorpay dashboard for pilot.

### W13. WhatsApp phases

| Field | Detail |
|---|---|
| Goal | Send approval links, payment links, crew task links and reminders on WhatsApp via Meta Cloud API. |
| Owner | Owner (Meta Business verification, phone number, templates), Dev |
| Dependencies | 0117 (W12), W8 (opt-in wording in Privacy), Meta template approval. |
| Effort | XL across phases |
| Risk | Medium: template rejection, opt-in compliance, per-conversation cost. |

**Phases**

| Phase | Scope | Gate |
|---|---|---|
| WA-1 | Platform number: transactional templates (payment link, approval link, reminder). Outside the 24-hour window only approved templates are sent. | Meta business verified; 3 templates approved; staging test |
| WA-2 | Re-enable hidden UI: "WhatsApp is on this number", "send notifications to WhatsApp", phone Verify by WhatsApp code. | WA-1 live 2 weeks with no failures |
| WA-3 | Per-studio numbers (Embedded Signup) using 0117 accounts. | Pricing decision; Meta Tech Provider status |
| WA-4 | Inbound messages / vendor bill capture from WhatsApp. | Product decision |

**Acceptance criteria per phase:** delivery receipts logged; opt-out honoured; `liveChannels.whatsapp` flag flipped with CI guard update.

### W14. Lead-overwrite fix

| Field | Detail |
|---|---|
| Goal | Saving a quote must not overwrite a different lead that shares an email. |
| Owner | Dev |
| Dependencies | W1 (fix builds on current trigger). Owner approval of option A. |
| Effort | M |
| Risk | Medium (data integrity of CRM). Current bug merges different clients sharing an email. |

**Tasks**
1. Additive migration (next free number, e.g. 0126): `sync_quote_to_lead` links only when email **and** phone match, or on manual link; never overwrites typed fields, fills blanks only.
2. UI: "Possible match, link?" prompt on quote save.
3. Read-only report of leads already merged incorrectly, for owner review (no automatic un-merge).
4. Tests per `_plans/qa/e2e-sales.md`.

**Acceptance criteria:** QA scenario "Lead Sales" vs "Client Sales" stays as two leads; existing correct links unchanged.

### W15. Monitoring and observability

| Field | Detail |
|---|---|
| Goal | Know about errors and downtime before customers report them. |
| Owner | Owner (accounts), Dev (wiring) |
| Dependencies | None (can start now). |
| Effort | S |
| Risk | Low. Must scrub PII (phone numbers, emails) before sending events. |

**Tasks**
1. Sentry: set DSN in `config.js` per `docs/OBSERVABILITY-ACTIVATION.md`; confirm scrubbing; alert on new issues.
2. Uptime checks (1-minute) on `/`, `/login.html`, Supabase REST health, edge functions; alert to email + phone.
3. Supabase: enable log drains or review Logs Explorer weekly; database advisors (security + performance) clean.
4. Vercel Analytics / Speed Insights for Core Web Vitals.
5. Public status page. [OWNER TO FILL: provider]
6. Weekly review: audit log, failed logins, edge-function errors.

**Acceptance criteria:** a forced test error appears in Sentry within 1 minute; uptime alert fires on a test outage; Supabase advisors show no ERROR-level items.

### W16. Auth hardening carry-overs

| Field | Detail |
|---|---|
| Goal | Close parked security items before public sign-ups. |
| Owner | Owner (dashboard), Dev |
| Dependencies | W3. |
| Effort | S |
| Risk | Medium (bot sign-ups, token interception). |

**Tasks**
1. Turnstile: put the **site key in `config.js` first**, deploy, then add the secret in Supabase Auth (reverse order locks everyone out).
2. Google sign-in: verify Redirect URL allow-list covers `www.helm.events`, `helm.events`, `helm-v01.vercel.app` (`/login.html` and `/**`); Site URL = `https://www.helm.events`. Consider PKCE flow.
3. Apply `docs/AUTH-DASHBOARD-SETTINGS.md` to both projects; staging sign-ups off.
4. Vercel: remove `helm-alpha-nine` alias; apex domain "No redirect" + HSTS preload.
5. Set `organizations.business_email` for every studio.
6. Make both GitHub repositories private.
7. Pay outstanding Supabase invoices (avoid project pause).

**Acceptance criteria:** Google + email sign-in work on every production origin; CAPTCHA challenge appears on sign-up; securityheaders.com grade A.

### W17. Performance work

| Field | Detail |
|---|---|
| Goal | Fast app from India, UAE and US. |
| Owner | Dev |
| Dependencies | W4 (region), W15 (measurement). |
| Effort | L |
| Risk | Low. |

**Tasks**
1. Baseline Core Web Vitals and RPC latency per page (Speed Insights + `tests/staging/a11y-perf.mjs`).
2. Batch remaining sequential queries into RPCs; add indexes flagged by Supabase performance advisor (additive).
3. Render "Recently viewed" from first paint, then re-enable flag `recentViewed`.
4. Image and video budgets on landing (W9).
5. Consider read replica for UAE/US once paying customers exist.

**Acceptance criteria:** p75 LCP under 2.5 s, INP under 200 ms, CLS under 0.1 on dashboard and landing (mobile, India).

### W18. Post-launch product backlog (Phase 3)

| Item | Notes |
|---|---|
| Vendor bills follow-ups | 0124 tables live; extend with bill photo upload, payables aging. |
| Time-aware calendar | Event times + overlap-based conflicts (reverted earlier, redo). |
| Deferred business rules | Refund self-approval exemption, expense two-person rule, `close_event` balance gate, approval reset on price change, overbooking guard, ledger-only totals. Each needs an owner decision. |
| Settlement inline style fix | `settlement.html` inline styles to CSS (CSP). |
| User manual upkeep | Update `docs/product/USER-MANUAL.md` and screenshots with each release. |
| Paid-milestone undo, clear-package | Open items from edge-case pass. |

---

## 4. Phased Timeline

Dates assume work starts Monday 2026-10-19 and the owner can act on dashboard tasks within 1 to 2 days. Adjust to real availability. [OWNER TO FILL: target launch date]

### Phase 1: Launch-critical (weeks 1 to 3, about 2026-10-19 to 2026-11-06)

| Week | Workstreams | Exit criterion |
|---|---|---|
| 1 | **W6 step 1 (rotate default passwords now)**, W2 backup + restore drill, W4 region confirmation, W15 Sentry + uptime, W7 DNS (MX/SPF/DKIM/DMARC), W1 task 1.1 (0125 on staging) | Backup restored; passwords rotated; monitoring live |
| 2 | W1 prod SQL bundle, W8 legal drafts to counsel, W10 logo swap (when files arrive), W9 assets, W16 auth carry-overs | All prod VERIFY true; legal in review |
| 3 | W3 frontend push, W11 trial launch (staging then prod), W5 cleanup (if owner approves), W6 full reset to @helm.events | Go-live checklist (Section 5) fully ticked |

### Phase 2: Revenue and comms (weeks 4 to 8, about 2026-11-09 to 2026-12-11)

| Workstream | Exit criterion |
|---|---|
| W12 Razorpay per studio (0117, test mode, pilot) | One pilot studio collects a real payment, reconciled |
| W13 WhatsApp WA-1 and WA-2 | Templates approved and sending; UI re-enabled |
| W14 lead-overwrite fix | QA scenario passes on prod |
| W17 performance baseline + first fixes | CWV targets met on dashboard |
| W7 trial and receipt emails on | Deliverability verified |

### Phase 3: Scale and depth (from about 2026-12-14)

| Workstream | Exit criterion |
|---|---|
| W13 WA-3 / WA-4 | Per-studio numbers live |
| W17 read replica / regional strategy | p75 latency targets met in UAE and US |
| W18 backlog | Prioritised quarterly with owner |
| Quarterly | Restore drill, access review, legal-page review, dependency update, security re-audit |

### Dependency map (critical path)

```
W2 Backup ──► W4 Region ──► W1 Prod SQL ──► W3 Frontend push ──► W11 Trial ──► PUBLIC LAUNCH
                                  ▲                ▲
W7 Email DNS ──► W6 User reset    │        W8 Legal, W10 Logo, W9 Assets, W16 Auth
                                  │
                         0125 on staging
PUBLIC LAUNCH ──► W12 Razorpay (needs W8) ──► W13 WhatsApp (needs 0117)
```

---

## 5. Go-Live Checklist

Tick every item; any unticked item in sections 5.1 to 5.3 is a no-go.

### 5.1 Data and database
- [ ] Fresh `pg_dump` taken and **test-restored** (W2); timestamp recorded.
- [ ] `02-BACKUP-function-defs.sql` CSV saved offline.
- [ ] Prod precheck all true except 0117; every VERIFY `ok = true`.
- [ ] Region confirmed ap-south-1 (or move completed and verified).
- [ ] Supabase security and performance advisors: no ERROR-level items.
- [ ] RLS enabled on every `public` table (advisor check).
- [ ] PITR or daily backups enabled on the paid plan; invoices paid.

### 5.2 Security and access
- [ ] `P3-CHECK-default-passwords.sql` returns 0 rows.
- [ ] Platform admins on `@helm.events` with MFA enrolled.
- [ ] Turnstile on (site key deployed before secret).
- [ ] Google sign-in tested on every production origin.
- [ ] No secrets in repo or client bundle (CI checks green); repos private.
- [ ] `liveChannels.pay` and `liveChannels.whatsapp` are false unless their workstream gate passed.
- [ ] Security headers grade A; CSP has no violations in console.

### 5.3 Product smoke test (desktop and phone, light and dark)
- [ ] Sign up (email and Google) -> onboarding -> trial studio with sample data.
- [ ] Create lead -> quote -> client approval link -> confirm event.
- [ ] Record a milestone payment for the exact remaining balance.
- [ ] Vendor bill + payout -> event P&L correct.
- [ ] Dashboard due-today and money cards load.
- [ ] Audit log shows lead edits; Recent activity loads.
- [ ] Invitation site publishes at `/i/<slug>`.
- [ ] Password reset email arrives in inbox (not spam).
- [ ] Read-only trial expiry behaves as expected; HQ can extend.

### 5.4 Business, legal and content
- [ ] Terms, Privacy, Cookies, Refund, DPA, AUP, Sub-processors published, counsel signed off.
- [ ] Grievance officer and contact details published (India).
- [ ] Logo swapped; og image re-scraped.
- [ ] Landing assets final; Lighthouse mobile 85 or higher.
- [ ] Trial length consistent in all copy.
- [ ] User manual updated for this release.

### 5.5 Operations
- [ ] Sentry DSN set; test error received.
- [ ] Uptime monitors and alert contacts set.
- [ ] Incident and DR runbooks reviewed by owner; on-call contact named. [OWNER TO FILL]
- [ ] Release tag created; rollback commands rehearsed on staging.

---

## 6. Rollback Plan

| Trigger | Action | Owner | Target time |
|---|---|---|---|
| Frontend release breaks a core flow | In Vercel, **Promote** the previous production deployment (instant rollback), or `git revert` the release commit and redeploy. Old frontend works with the new SQL (bundle README compatibility table). | Dev | under 10 min |
| A single SQL function misbehaves | Paste its saved definition from the step-02 CSV and run it (same signature). | Owner | under 15 min |
| 8-day trial length wrong | `update public.helm_billing_settings set trial_days = 14;` (setting only). | Owner | under 5 min |
| 0125 leads audit trigger causes errors | `drop trigger if exists audit_trg on public.leads;` (audit rows already written remain). | Owner | under 5 min |
| Trial studio locked unexpectedly | Extend trial end from HQ; never delete the studio. | Owner | under 5 min |
| Payments misbehave | Set `liveChannels.pay = false`, deploy; disable webhook in Razorpay dashboard; reconcile manually from Razorpay reports. Ledger rows are never deleted. | Dev + Owner | under 15 min |
| WhatsApp misbehaves | Set `liveChannels.whatsapp = false`; queued rows become `skipped`. | Dev | under 10 min |
| Data corruption or loss | Stop writes (maintenance banner / read-only), follow `docs/DISASTER-RECOVERY-RUNBOOK.md`: PITR to the recorded time or restore the W2 dump into a new project, verify, switch `config.js`. | Owner + Dev | per DR runbook RTO |
| Region move fails | Keep the old project as primary (`config.js` unchanged); new project discarded. | Dev | under 30 min |
| Security incident | Follow `docs/INCIDENT-RESPONSE-RUNBOOK.md`; rotate keys; DPDP Board / affected-user notice timelines apply. | Owner | per runbook |

**Rollback principles:** new tables, columns and functions are left in place (harmless when unused, zero data loss). Roll back behaviour, never data.

---

## 7. Risk Register (top items)

| ID | Risk | Likelihood | Impact | Mitigation | Workstream |
|---|---|---|---|---|---|
| R1 | Default-password accounts abused on prod | High | Critical | Rotate now, full reset later | W6 |
| R2 | Prod SQL applied without restorable backup | Low | Critical | Restore drill gate | W2 |
| R3 | Frontend deployed before SQL, screens show fallbacks | Medium | Medium | Strict order W1 then W3 | W1, W3 |
| R4 | Emails go to spam / not delivered | High | High | SPF, DKIM, DMARC, custom SMTP | W7 |
| R5 | Razorpay activation rejected for missing policies | Medium | High | Legal pages live first | W8, W12 |
| R6 | Bot sign-ups create junk trial studios | Medium | Medium | Turnstile before announcement | W16 |
| R7 | Lead merges corrupt CRM data | Medium | Medium | W14 fix; report-only cleanup | W14 |
| R8 | Region move downtime or auth breakage | Low (if needed) | High | Maintenance window; keep old project | W4 |
| R9 | Non-ASCII SQL garbled on paste | Medium | Low | `LANG=en_US.UTF-8 pbcopy`; ASCII-only files | W1 |

---

## 8. Open Decisions for the Owner

| # | Decision | Needed by |
|---|---|---|
| 1 | Confirm prod region; approve move if not ap-south-1 | Week 1 |
| 2 | Go-ahead for prod test-data cleanup (W5) | Week 3 |
| 3 | Mailbox provider for `helm.events` | Week 1 |
| 4 | Trial length (8 days default) and plan prices | Week 2 |
| 5 | Razorpay model: per-studio keys vs Route | Phase 2 start |
| 6 | Ship `mk-demos` / demo videos on landing | Week 2 |
| 7 | Legal entity, registered address, grievance officer, counsel | Week 1 |
| 8 | Deferred business rules (Section W18) | Phase 3 |
| 9 | Target public launch date | Week 1 |

---

## 9. References

1. Supabase Docs, "Database Backups" and "Point-in-Time Recovery": https://supabase.com/docs/guides/platform/backups
2. Supabase Docs, "Production Checklist": https://supabase.com/docs/guides/deployment/going-into-prod
3. Supabase Docs, "Migrating within Supabase" (moving between projects/regions): https://supabase.com/docs/guides/platform/migrating-within-supabase
4. Supabase Docs, "Send emails with custom SMTP": https://supabase.com/docs/guides/auth/auth-smtp
5. Supabase Docs, "Database Advisors": https://supabase.com/docs/guides/database/database-advisors
6. Vercel Docs, "Instant Rollback": https://vercel.com/docs/instant-rollback
7. Google SRE Book, "Reliable Product Launches at Scale" (launch checklists): https://sre.google/sre-book/reliable-product-launches/
8. Google Workspace Admin Help, "Email sender guidelines" (SPF/DKIM/DMARC): https://support.google.com/a/answer/81126
9. Resend Docs, "Managing Domains": https://resend.com/docs/dashboard/domains/introduction
10. Razorpay Docs, "Payment Links" and "Webhooks": https://razorpay.com/docs/payments/payment-links/ and https://razorpay.com/docs/webhooks/
11. Razorpay, "Website and App Requirements for Activation": https://razorpay.com/docs/payments/website-app-requirements/
12. Meta for Developers, "WhatsApp Cloud API" and "Message Templates": https://developers.facebook.com/docs/whatsapp/cloud-api
13. Ministry of Electronics and IT, Digital Personal Data Protection Act 2023 and DPDP Rules 2025: https://www.meity.gov.in/data-protection-framework
14. UAE Federal Decree-Law No. 45 of 2021 on Personal Data Protection: https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws
15. UK ICO, "Guide to the UK GDPR" and PECR cookie guidance: https://ico.org.uk/for-organisations/
16. web.dev, "Core Web Vitals" thresholds: https://web.dev/articles/vitals
17. Sentry Docs, "Data Scrubbing": https://docs.sentry.io/security-legal-pii/scrubbing/
18. Cloudflare Turnstile Docs: https://developers.cloudflare.com/turnstile/
19. Internal: `supabase/PROD-BUNDLE-2026-10/README.md`, `supabase/prod-cleanup/`, `docs/LOGO-SWAP.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/OBSERVABILITY-ACTIVATION.md`, `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`.
