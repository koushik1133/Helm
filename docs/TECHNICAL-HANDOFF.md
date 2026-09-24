# WEBSITE TECHNICAL HANDOFF — Helm (brand "Helm Events")

> **UPDATE 2026-09-24 (post-audit changes):**
> - **Rebrand**: wordmark is now "Helm Events" across all pages (phase86). Old codename "Blueprint Stage" retired from UI.
> - **GDPR export card** added to Control Center (phase86); AA-contrast + XSS-safe hardening applied.
> - **Digital invitation websites** (phase87 + phase88): confirmed events can build a public premium invitation site (5 templates: eternal/promise/confetti/summit/soiree), pick background music (predefined royalty-free or custom MP3), add photos (Supabase Storage `invite-media` bucket), and publish at a NAME-based slug `/i/<name>-<token>`. New pages: `public/invite.html` (public renderer, cover gate, music, gallery, share), `public/invite-studio.html` (builder). New SQL: `phase87-event-sites.sql` (event_sites table + RLS + create/publish/public RPCs), `phase88-invite-media-storage.sql` (storage bucket + org-isolated RLS). New store-api `sites` facade. Gated entry button on `event.html`.
> - **server.js**: `/i/<slug>` route (guarded against asset paths), per-request framing headers (same-origin invite preview; localhost drops UIR), and **`media-src 'self' https:`** added to CSP (external invitation music).
> - **vercel.json** added for the Vercel move (static deploy of `public/`, cleanUrls, `/i/` rewrite, security headers). The app talks to Supabase directly, so it does NOT need `server.js` on Vercel.
> - **Supabase**: project transferred to a Pro org (billing). Same ref/keys — no code change.
> - `store-api.js` now at **v=82** uniformly across all pages.
> - Deployed to Vercel (currently helm-v01.vercel.app; personal domain helm-events.com planned on the client's Vercel).
>
> Everything below is the original read-only audit (still broadly accurate for the core platform).

---

# WEBSITE TECHNICAL HANDOFF — Helm (codename "Blueprint Stage")

> Read-only audit. Nothing in the app was modified to produce this. Grounded in the current repo at `…/Helm/2d view-restored`.
> Verified this pass: **41** HTML pages in `public/`, **127** `.sql` files (latest domain phases 75–77, 83–85), **0** test files, **no** CI, `store-api.js` uniformly at `v=79`, `theme.css` drift (36 pages `v=69`, 1 `v=70`), **no** `service_role` in client code.
> "Not verified" = could not confirm from the code.

---

## 1. Product Overview

**What it is:** Helm is a **multi-tenant SaaS platform for event-management businesses** (event planners/studios). Each organization ("studio") registers, gets a private workspace, and runs its whole operation inside it — analogous to Monday/Jira for the events industry. "Blueprint Stage" is the old codename still present in app-internal UI.

**Problem solved:** Replaces spreadsheets/chat/paperwork with one system spanning the full event lifecycle: enquiry → discovery → proposal → quote → confirm (advance payment) → planning → resources → event day → settlement → closure.

**Target users:** Event studios and their staff (10 configurable roles: admin, manager, planner, sales, coordinator, supervisor, operations, crew, worker, client).

**Main use cases:** Capture/qualify leads; design floor layouts (2D/3D) with live pricing; produce versioned quotations + PDFs; take advance payments and confirm bookings; manage staff/inventory/vendors; run the event day; close with P&L.

**Core user journey:** Visitor → `welcome` (marketing) → Sign up (create studio) or accept invite → app home (`index`) → Leads/CRM → convert to quote → unified `flow` (client→…→payment) → `builder` (layout+pricing) → confirm → planning/ops → settle/close.

**Main screens:** marketing (`welcome`/`privacy`/`terms`), `login`, app home (`index`), `flow` (unified quote flow), `builder` (2D/3D layout + pricing), `control` (Control Center/admin), plus ~30 operational pages.

**Status.** Substantially built and functional on Supabase.
- **Complete:** multi-tenant isolation (audited), invitations, attendees, pricing, advance payments, quotation versioning, marketing/legal pages, clean URLs.
- **Incomplete/placeholder:** payments are simulation-only (Razorpay keys not wired), WhatsApp/SMS/email channels are stubs, Google OAuth is coded but not configured, backdrop/3D-with-backdrop (P4) not built, **zero automated tests**. The Node `/api` layer is a demo/fallback tier (Supabase is the real backend).

---

## 2. Technology Stack (verified actual usage)

| Layer | Tech | Where/how used | Verified |
|---|---|---|---|
| Frontend | **Vanilla JS + HTML (single-file pages)** | 41 pages in `public/`, each self-contained (inline CSS/JS) | ✅ |
| Shared client lib | **`public/store-api.js`** (`BPStore` facade, ~2,150 lines) | Data access, auth, pricing engine, tiered backend | ✅ |
| Backend (primary) | **Supabase** (Postgres + PostgREST + Auth) | RLS-secured tables, RPCs, `supa.rpc/from` in store-api | ✅ |
| Backend (fallback) | **Zero-dependency Node `server.js`** | Static file server + `/api/layouts` demo store + rate limiter | ✅ |
| CSS | Hand-rolled CSS + tokens + `theme.css` | Inline `:root` tokens per page + shared `theme.css` (dark mode) | ✅ |
| DB | **PostgreSQL (Supabase)** | `phaseNN-*.sql` migrations | ✅ |
| Auth | **Supabase Auth (GoTrue)** email/password; Google OAuth coded | `store-api.js` auth facade; `login.html` | ✅ (Google **not** configured) |
| Fonts | Google Fonts (IBM Plex Sans/Mono), non-blocking | `<link media=print onload>` on public pages | ✅ |
| Supabase JS SDK | `@supabase/supabase-js@2` via CDN (jsdelivr) | `loadSupabaseLib()` injects it at runtime | ✅ |
| Payments | Razorpay (Edge Functions) | `create-payment-link`, `razorpay-webhook` — **simulation mode** | ⚠️ not live |
| SMS/WhatsApp | MSG91 / Evolution API (Edge Functions) | `send-otp`, `send-whatsapp` — **flags off** | ⚠️ stubbed |
| Email | None wired | `server/services/notification-service.js` builds payload; `send()` stub | ⚠️ |
| Build tools | **None** (no bundler/transpiler) | Files served as-is; cache-busting via `?v=N` | ✅ |
| Package manager | npm (minimal) | `package.json`: only `start`/`dev`; no deps | ✅ |
| Hosting | **Not verified** (runs on localhost:4173 in dev) | — | — |
| Analytics | **None found** | — | ✅ (absent) |

**Not used despite appearing in prior requests:** No React/Next.js/Tailwind/Vite anywhere. The actual stack is vanilla.

---

## 3. Architecture

```
Browser (vanilla JS pages, public/*.html)
   │  loads store-api.js (BPStore facade)
   ▼
BPStore.init() picks a tier:
   ├── supabase  (primary)  ──► Supabase PostgREST/Auth ──► Postgres + RLS + SECURITY DEFINER RPCs
   ├── server    (fallback) ──► Node server.js /api/layouts (file-backed, demo)
   └── local     (offline)  ──► browser localStorage
Tenant context: implicit — current_org_id() reads profiles.org_id from the JWT; client never sends org_id.
Edge Functions (Deno): send-otp, send-whatsapp, create-payment-link, razorpay-webhook (mostly gated off).
Background (new): server/jobs/cleanup-invites.js (cron, service_role), server/services/notification-service.js (email payload).
```

Primary path is **Browser → Supabase (RLS)**. The Node server mainly serves static files + clean-URL routing; its `/api` is a legacy/demo tier.

---

## 4. Project Structure

```
2d view-restored/
├── server.js                     Static host + clean-URL routing + /api/layouts demo + rate limiter. ACTIVE (dev host).
├── package.json                  start/dev only, no deps, node>=18. ACTIVE.
├── public/                       41 single-file pages + shared assets. ACTIVE (the app).
│   ├── store-api.js  (v=79)      BPStore facade: auth, RBAC, pricing, all domain data, tiered backend. CRITICAL.
│   ├── config.js                 window.SUPABASE_CONFIG (url + anon key). ACTIVE. (working-tree change removed liveChannels.)
│   ├── theme.css                 Dark-mode tokens + focus rings + responsive table wrap. ~37 pages (VERSION DRIFT v69/v70).
│   ├── welcome/privacy/terms.html Public marketing + legal. ACTIVE.
│   ├── login.html                Sign in / create studio / accept invite. ACTIVE.
│   ├── index.html                App home (quote list, nav). ACTIVE.
│   ├── flow.html                 Unified quote flow (9 sections). ACTIVE, primary.
│   ├── builder.html              2D/3D layout + live pricing. ACTIVE, 235 KB (5× next; no theme.css).
│   ├── control.html              Control Center: pricing, layout rules, menus, users, invites, access matrix. ACTIVE.
│   └── (~30 ops pages: leads, crm, quotes, staff, inventory, vendors, calendar, plan, runsheet, command, settlement,
│        closure, portal, proposal, proposal-view, nurture, media, issues, reports, insights, audit, resources,
│        logistics, ready, teardown, ops, work, budget, discovery, approve, sim-pay, templates)
├── server/                       NEW background layer (not the web host).
│   ├── jobs/cleanup-invites.js   Cron: soft-expire stale invites. service_role from ENV. Needs @supabase/supabase-js.
│   └── services/notification-service.js  Builds invite email payload (HTML+text). Transport stub.
├── supabase/                     127 .sql. Numbered phaseNN migrations = source of truth; full-schema/ + *.sql are mirrors.
│   ├── phase56/57/58             Multi-tenant foundation (organizations, org_id, current_org_id, has_area, create_studio).
│   ├── phase70-77                Definer org-isolation sweep + advance payment + quotation versions.
│   ├── phase83/84/85             Invitations, event_attendees, GDPR export (NEW).
│   └── functions/                Edge Functions (Deno): send-otp, send-whatsapp, create-payment-link, razorpay-webhook.
└── docs/                         MVP-PHASE1-GUIDE.html, this handoff.
```

**Redundancy:** `supabase/` has heavy duplication (`full-schema/*`, `complete-setup.sql`, `setup-all.sql`, `phaseN.sql` vs `phaseN-name.sql`). The **numbered `phaseNN-name.sql` files are authoritative**. Not verified which single file a fresh deploy should run end-to-end.

---

## 5. Pages & Routes

Clean URLs: `server.js` serves `/name` from `name.html`, 302-redirects `/name.html → /name`, and `/` → `welcome.html`. `/index.html → /index` (app home).

**Primary pages (detail):**
- **`/` (welcome.html)** — Public marketing. Signed-in users auto-redirect to `/index` (`?preview=1` bypass). Light-mode only. Nav links hide <720px with **no mobile menu**.
- **`/login`** — Sign in / Create studio / **Accept invite** (`?invite=<token>`). Correct `<label for>` (good). Light-locked despite loading `theme.css`.
- **`/index`** — App home: quote list, role-gated nav, notification bell. Redirects to `/login` when Supabase-required and unauthenticated. Heading skip (h2→h4). Delete button `opacity:0` until hover.
- **`/flow`** — 9-section quote flow + activity trail; sticky live-price rail. **Inputs lack `<label for>`.** Venue de-duplicated.
- **`/builder`** — 2D/3D floor design + live price. 235 KB; no `theme.css`; **0 aria**; toggles state only via `.on`.
- **`/control`** — Admin config + Users + **Invite by email link** + access matrix. Add-rows overflow <400px (inline grid beats media query).

**All routes:**

| Route | Purpose | Access |
|---|---|---|
| `/`, `/privacy`, `/terms` | Marketing/legal | Public |
| `/login` | Auth + invite accept | Public |
| `/index` | App home | Auth |
| `/flow` | Quote lifecycle | Role-gated (quotes) |
| `/builder` | Layout + pricing | Role-gated |
| `/control` | Admin config + users | Admin/role-gated |
| `/leads`, `/crm`, `/nurture` | Pipeline/CRM | Role-gated |
| `/quotes`, `/proposal`, `/proposal-view`, `/approve` | Quoting/approval | Role-gated / portal |
| `/staff`, `/inventory`, `/vendors`, `/resources`, `/logistics` | Resources | Role-gated |
| `/calendar`, `/plan`, `/runsheet`, `/budget`, `/discovery` | Planning | Role-gated |
| `/ready`, `/command`, `/work`, `/ops`, `/teardown`, `/issues`, `/media` | Event day/ops | Role-gated |
| `/settlement`, `/closure`, `/reports`, `/insights`, `/audit` | Close/analytics | Role-gated |
| `/portal`, `/sim-pay`, `/templates` | Client portal / sim pay / templates | Mixed |

Loading/empty/error states exist on key pages (e.g. `index.html` has Loading + retry) but are **not uniform** across all ops pages (Not verified per-page).

---

## 6. User Flows

**A. New studio signup:** `welcome` → `login#signup` → `auth.signUp` → `org.createStudio` → `create_studio` (seeds private org from Helm master, excludes `%(testing)%`) → `/index`. Email-confirm path stashes studio name in localStorage, completes after confirm+signin.

**B. Join studio (invite):** Admin `/control#users` → create invite → `…/login?invite=<token>` → invitee signs up/in → `accept_invitation` (email-match + one-org guard) → `/index`. RPC 404 until `phase83` applied (graceful).

**C. Quote → booking:** Lead → `convert_lead_to_quote` → `/flow` (debounced auto-save) → live price (`BPStore.pricing`) → `save_quotation_version` → advance (`record_payment`) → booking `confirmed` + notifications. Failure points: dual pricing engines (Bug #1); `count(*)+1` races (Bug #3).

**D. Layout generation:** `/flow` Generate → `builder?gen=1&…` → `layoutRules.get(type)` → applies seats/guest etc.

---

## 7. Backend & APIs

**(a) Node `server.js` `/api` (fallback/demo tier):**

| Method | Route | Auth | Called by FE? | Concern |
|---|---|---|---|---|
| GET | `/api/health` | none | yes (init) | ok |
| GET | `/api/layouts` | **none** | server tier only | IDOR/enumeration |
| GET | `/api/layouts/:id` | **none** | server tier | IDOR |
| POST | `/api/layouts` | **none** | server tier | no authz |
| PUT | `/api/layouts/:id` | **none** | server tier | no authz |
| DELETE | `/api/layouts/:id` | **none** | server tier | destructive, no authz |

Flags: wildcard CORS `*` (`server.js:46,233,246`); no auth/ownership/org scoping; rate limiter keyed on spoofable `X-Forwarded-For` (`server.js:157-172`, `RL_MAX=120`); 5 MB body cap. Mitigation: only used when Supabase is unavailable; `data/` gitignored. **If deployed as the store, it's a full authz bypass.**

**(b) Supabase RPCs (primary):** current_org_id, has_area, is_admin, can_edit, assert_quote_org, create_studio, admin_create_user/set_role/delete_user, convert_lead_to_quote, set_lifecycle_stage, record_payment, save_quotation_version, event_activity, **create_invitation/invitation_by_token/accept_invitation**, **export_tenant_organization_package** (+ legacy `export_org_data`), plus phase70-77 definer setters. All tenant RPCs re-apply `org_id = current_org_id()` or `assert_quote_org`. Client mutations use `.eq("id",…)`.

Duplicate/dead: `export_org_data` superseded by `export_tenant_organization_package`.

---

## 8. Database

**Postgres (Supabase).** Multi-tenant: shared DB + shared schema + `org_id` on every tenant row + RLS.

**Key tables:** organizations, profiles (id→auth.users, email, role [10-value CHECK], `org_id`), quotes (the "event": code MMDDYYYY-NN, client jsonb, pricing jsonb, status, lifecycle_stage, event_date), quote_versions, quotation_versions, quote_payments/payment_milestones, leads, event_guests (group counts), **event_attendees** (per-person + ticket_status), **invitations**, role_access (per-org matrix), library tables (plate_types/chair_types/dish_catalog/menu_templates/layout_rules/app_config/task_templates/checklist_templates/nurture_*), notifications, audit_log.

**Helpers:** current_org_id() (STABLE/DEFINER), has_area(area,need), is_admin(), can_edit(), _valid_role(), assert_quote_org().

**RLS:** **ENABLE (not FORCE)** — deliberate, so trusted DEFINER RPCs can token-scope. Canonical 4-policy CRUD: `has_area(area,'view'|'edit') AND org_id = (select current_org_id())`. Config tables: read = org only, write = `has_area('controls','edit')`. New tables follow the template; `event_attendees` also has a BEFORE-write trigger forcing `org_id` + asserting the parent quote's org.

**Indexes:** `(org_id, …)` composites on new tables; Not verified for every legacy hot table.

**Migrations:** numbered idempotent `phaseNN-*.sql`, run manually. **Integrity risks:** `count(*)+1` numbering races; server trusts client-supplied `pricing.total` in `save_quotation_version`.

---

## 9. Authentication

- **Signup:** `supa.auth.signUp` (email/pw, confirmation may be required). New studio via `create_studio`; teammate via `admin_create_user` or invite accept.
- **Login/Logout:** `supa.auth.signIn` / `signOut` + reload. JWT in localStorage.
- **Protected routes:** client-side redirect only; true enforcement is **server-side RLS**.
- **Roles/permissions:** 10 roles; `role_access` per-org; `has_area` gates RLS + UI. Admin = safety floor.
- **OAuth:** Google coded, dashboard not configured (Not verified working).
- **Passwords:** delegated to Supabase (bcrypt); no plaintext in client.
- **Invite security:** email-match via `auth.jwt()->>'email'`, one-org guard, PII-tight token lookup (verified).

Vulnerabilities: client-only route protection (acceptable with RLS); **Node `/api` bypasses auth entirely**.

---

## 10. External Integrations

| Service | Purpose | Called from | Env | Functional? | Secrets exposed? |
|---|---|---|---|---|---|
| Supabase | DB/Auth/PostgREST | config.js + store-api | anon key (public) | ✅ | anon key expected/public; **no service_role in client** ✅ |
| Razorpay | Payments | create-payment-link, razorpay-webhook (Deno) | Razorpay keys (Deno.env) | ⚠️ simulation | No |
| MSG91 | OTP/SMS | send-otp (Deno) | MSG91 key | ⚠️ gated off | No |
| WhatsApp (Evolution) | WhatsApp | send-whatsapp (Deno) | EVOLUTION_* | ⚠️ gated off (+ working-tree deletion) | No |
| Email | Invites/receipts | notification-service.js | provider key + APP_BASE_URL | ⚠️ payload only; send() stub | No |
| Google Fonts | Typography | all pages | — | ✅ non-blocking | — |
| jsdelivr CDN | supabase-js | loadSupabaseLib() | — | ✅ (8s timeout) | — |

---

## 11. UI/UX

Consistent purple system (`#6d28d9`/`#4f46e5`, IBM Plex). Concrete problems:
- **Contrast fail (Critical):** `--ink-3:#8b8698` ~3.2–3.5:1 on light bg (needs 4.5) — all muted text/placeholders (dark mode passes).
- **Unlabeled inputs (Critical a11y):** flow/control/builder/index have **0 `<label for>`** (login is correct).
- **Modals aren't dialogs (Major):** no role/aria/focus-trap; Escape in builder only.
- **Control Center mobile overflow (Major):** inline grid beats 640px media query → crush <400px.
- **Missing `<main>` + heading skips (Major):** most pages lack `main`; index h2→h4; control h1→h3.
- **Marketing/login light-locked (Minor):** bright flash for dark-mode users.
- **iOS zoom (Minor):** `.fld input` 13–14px (<16px) → focus zoom.
- **Icon-only buttons (Minor):** `title` only — need `aria-label`.

Good: `:focus-visible` ring + `prefers-reduced-motion`; `confirm()` on destructive; loading/disabled with `finally`; responsive table wrapper.

---

## 12. Responsiveness

- **Mobile/Tablet:** mostly fluid; **broken:** Control Center add-rows <400px; builder heavy on mobile; welcome nav vanishes <720px with no menu.
- **Laptop/Desktop/Large:** fine (max-width wrappers).
- Not verified: exhaustive per-page breakpoint testing.

---

## 13. Performance (ranked)

- **P1** — `server.js` no ETag/Last-Modified with `Cache-Control:no-cache` → full re-read+resend each hit (incl. 235 KB builder).
- **P1** — builder.html 235 KB single file, unminified, skips `theme.css`.
- **P2** — every page loads Google Fonts + injects supabase-js (mitigated: non-blocking + 8s timeout).
- **P2** — no read caching for hot config/library tables.
- **P3** — rate-limiter O(n) sweep on request thread.
- N+1: possible via repeated client RPCs; Not verified systematically. No React re-render issues; no bundles.

---

## 14. Security

- **Major** — Node `/api` unauthenticated + wildcard CORS (`server.js:176-236`).
- **Minor** — CSP `'unsafe-inline'` in `script-src`.
- **Minor** — error text leaked (`server.js:255`; Edge Functions return `(e).message`).
- **Minor** — rate limiter trusts `X-Forwarded-For`.
- **Minor** — CRLF into `Location` on redirect (Node rejects → 500; fragile).
- **Confirmed OK:** no committed secrets; anon key expected/public; `service_role` only in Deno.env/`server/jobs` from env; RLS + DEFINER isolation solid (phase70-85); no exploitable `innerHTML` XSS; path traversal guarded (`server.js:135-138`). The anon key lives in `public/config.js` (expected) — do not print it.

---

## 15. Code Quality

- `esc()` duplicated across ~36 pages in 6 different variants (some escape `'`, some throw on null) → shared `util.js`.
- Design tokens inlined in ~40 pages despite `theme.css` → drift/edit cost.
- `builder.html` monolith (235 KB) → split + adopt `theme.css`.
- Manual `?v=N` cache-busting → fragile (theme.css already drifted).
- Two pricing algorithms in `store-api.js` (Bug #1).
- No types, **no tests, no CI** — dominant risk.
- Good: `withFallback` refuses silent localStorage divert; memoized `init()`.

---

## 16. Confirmed Bugs

**BUG #1 — High.** `store-api.js` `quoteTotal` (~:626-648) vs `breakdown` (~:651-676): two divergent grand-total formulas (pre- vs post-discount GST base; different service-charge base; only one IGST-aware; `breakdown` no negative floor). `flow.html:saveQuotation` uses `quoteTotal`; builder uses `breakdown`. Impact: builder price ≠ saved/invoiced total. Fix: one core engine, both as adapters.

**BUG #2 — Medium.** `store-api.js` `breakdown` (~:675): no `Math.max(0,…)` → negative guests/chairs → negative total (via `#q_guests`). Fix: clamp ≥0 + floor.

**BUG #3 — Medium.** `phase77 save_quotation_version` (~:40) + `phase76 record_payment` (~:30): `count(*)+1` with no lock/unique → duplicate `Q2`/`RCP-…-01` under concurrency. Fix: sequence or unique+retry.

**BUG #4 — Medium.** `flow.html updateAdvance` (~:432) + `record_payment` (`phase76:27`): advance % no upper clamp; `>100%` accepted (only `≤0` rejected). Fix: clamp ≤100% client+server.

**BUG #5 — Medium.** `flow.html saveQuotation` (~:358): broad `catch` falls back to `updateMeta`, shows "Saved" while recording no version on a real failure. Fix: surface errors.

**BUG #6 — Low.** `store-api.js getRole` catch → `"client"`: transient error silently downgrades permissions. Fix: distinguish transient vs deny.

---

## 17. Missing Functionality

- **Definitely missing:** automated tests; CI; live Razorpay; live email/WhatsApp/SMS; P4 (backdrop by stage size + 3D-with-backdrop).
- **Probably missing:** consistent per-page empty/error states; server-side pricing recompute; mobile nav on `welcome`.
- **Unclear / needs confirmation:** whether Node `/api` is meant for production; canonical fresh-deploy SQL file; Google OAuth config status.

---

## 18. Dead / Unused Code

- Redundant SQL mirrors (`full-schema/*`, `complete-setup.sql`, `setup-all.sql`, `phaseN.sql` duplicates) — archive after confirming canonical set (Not verified; don't delete blindly).
- `export_org_data` superseded by `export_tenant_organization_package`.
- Working-tree loose ends: `config.js` `liveChannels` removed; `supabase/functions/send-whatsapp` deleted — left untouched per zero-data-loss guardrail.
- `sim-pay.html`, `templates.html` — Not verified as linked from current nav.
- No notable `console.log`/TODO/FIXME; no client mock data beyond synthetic defaults.

---

## 19. Deployment & Environment

- **Env:** client `window.SUPABASE_CONFIG` (url + anon key, `public/config.js`). Server jobs: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_BASE_URL`, provider keys — `process.env`. Edge Functions: service role + Razorpay/MSG91/EVOLUTION_* (Deno.env).
- **Build:** none. **PM:** npm (no deps for web app; `@supabase/supabase-js` only for `server/jobs`).
- **Hosting/Docker/Vercel:** Not verified (none observed).
- **CORS:** wildcard `*` on `/api`.
- **Migrations:** manual in Supabase SQL editor; no automated runner → drift risk.
- **Prod risks:** Supabase **billing/quota** warning seen (project stops serving if exceeded); Google OAuth unconfigured; payments simulated; theme.css drift; SQL applied by hand.

---

## 20. Feature Status Matrix

| Feature | Implemented | Working | Partial | Broken | Mocked | Notes |
|---|---|---|---|---|---|---|
| Multi-tenant isolation | ✅ | ✅ | | | | Audited phase70-85 |
| Auth (email/pw) | ✅ | ✅ | | | | Supabase |
| Google OAuth | ✅ code | | ✅ | | | Not configured |
| Invitations | ✅ | ✅ | | | | Verified |
| Per-person attendees | ✅ | ✅ | | | | phase84 |
| Leads/CRM → quote | ✅ | ✅ | | | | |
| Unified flow | ✅ | ✅ | | | | Venue de-duped |
| Pricing engine | ✅ | | ✅ | | | Bug #1/#2 |
| Quotation versioning + PDF | ✅ | ✅ | | | | Bug #3 |
| Advance payment → booking | ✅ | ✅ | | | ✅ gateway | Simulated; Bug #4 |
| Layout builder 2D/3D | ✅ | ✅ | | | | a11y gaps |
| Admin layout rules | ✅ | ✅ | | | | |
| RBAC access matrix | ✅ | ✅ | | | | |
| GDPR export | ✅ | | ✅ | | | Needs phase85 run |
| Invite-cleanup cron | ✅ | | ✅ | | | Needs env + deps |
| Email delivery | | | ✅ | | ✅ | Payload only |
| WhatsApp/SMS | ✅ fns | | | | ✅ | Gated off |
| Marketing/legal | ✅ | ✅ | | | | Light-only |
| Node /api layouts | ✅ | ✅ | | | | Unauthed demo |
| Tests / CI | | | | | | **None** |
| P4 backdrop/3D | | | | | | Not started |

---

## 21. Issue Priority Matrix

| Priority | Issue | Location | Impact | Action |
|---|---|---|---|---|
| P0 | No tests/CI | repo-wide | Regressions reach prod | node:test + Playwright + CI |
| P0 | Two divergent pricing totals | store-api.js quoteTotal/breakdown | Wrong money | Unify engine |
| P0 | Contrast AA fail | `--ink-3` (tokens/theme.css) | Accessibility | Darken ~`#66627a` |
| P1 | Node `/api` unauthed + `*` CORS | server.js:176-236 | IDOR if deployed | Auth + origin allowlist / remove |
| P1 | Unlabeled inputs | flow/control/builder/index | SR unusable | `<label for>` |
| P1 | Negative/`>100%` pricing edges | breakdown/updateAdvance/record_payment | Invalid quotes/overpay | Clamp + validate |
| P1 | `count(*)+1` races | phase76/77 | Duplicate receipts/versions | Sequence/unique+retry |
| P2 | Modals not dialogs | index/flow/control/builder | a11y | role/aria/focus-trap |
| P2 | Control Center mobile overflow | control.html | Broken <400px | Class-based grid |
| P2 | No ETag/caching | server.js | Bandwidth/latency | ETag/304 |
| P2 | Silent save fallback | flow.html:358 | Data-loss illusion | Surface errors |
| P3 | Duplication (esc/tokens), builder size, SQL dupes, theme.css drift | repo-wide | Maintainability | util.js, split builder, canonicalize SQL, fix `?v=` |

---

## 22. Final Summary

**Product:** Vanilla-JS + Supabase multi-tenant SaaS for event studios; strict per-org isolation.

**Architecture:** Browser (single-file pages + `BPStore`) → Supabase (Postgres + RLS + DEFINER RPCs) primary; zero-dep Node server for static/clean-URLs + demo `/api`; Edge Functions for payments/messaging (gated); new `server/` cron + email layer.

**Working:** tenant isolation, auth, invitations, attendees, leads→quote flow, versioned quotations + PDF, advance payments (simulated), builder, RBAC, marketing/legal, clean URLs, dark mode.

**Broken/risky:** pricing drift + unclamped edges; unauthenticated Node `/api`; AA contrast; concurrency races; silent save fallback.

**Incomplete:** tests/CI; live payments/email/WhatsApp/SMS; Google OAuth config; P4; consistent empty/error states; canonical deploy script.

**Biggest risks:** (1) zero automated verification; (2) money correctness (dual pricing); (3) Node `/api` if prod-exposed; (4) manual SQL migrations/drift; (5) Supabase quota/billing.

**Biggest UX problems:** contrast, unlabeled inputs, non-dialog modals, Control Center mobile overflow, no mobile nav on marketing.

**Recommended next steps (ordered):** 1) Fix `--ink-3` contrast. 2) Unify pricing + clamp edges. 3) Tests + CI (org-isolation, pricing, routing). 4) `<label for>` across flow/control/builder/index. 5) Lock down Node `/api` (auth + CORS) or drop from prod. 6) Fix concurrency races + silent save. 7) Canonical migration path + resolve working-tree loose ends. 8) Extract `util.js`/tokens, split builder, fix `?v=` drift.

---

# HANDOFF FOR ANOTHER AI

**Project:** Helm (UI still says "Blueprint Stage"). Multi-tenant SaaS for event studios. Working dir `…/Helm/2d view-restored`. Git remote `koushik1133/Helm` (branch `main`). Commits: `phaseNN:` prefix + plain-words walkthrough, ending `Co-Authored-By: Claude Opus 4.8`.

**Stack (actual):** Vanilla JS single-file HTML pages (`public/*.html`, 41), shared `public/store-api.js` (`BPStore` facade, ~2,150 lines) at cache `?v=79`, `public/theme.css` (dark mode; drifted v69/v70), zero-dependency `public/server.js` (static host + clean-URL routing + `/api/layouts` demo). Backend = **Supabase** (Postgres + PostgREST + Auth). Edge Functions (Deno) for Razorpay/MSG91/WhatsApp (gated off). New `server/jobs/cleanup-invites.js` (cron, service_role from env) + `server/services/notification-service.js` (email payload). **No React/Next/Tailwind/Vite. No build step. No tests. No CI.**

**Tenancy model:** ONE org per user via `profiles.org_id`. `current_org_id()` (STABLE, SECURITY DEFINER) reads it from the JWT. Client **never** sends `org_id`; RLS supplies it. RLS is **ENABLE (not FORCE)**. Canonical policy: `has_area(area,'view'|'edit') AND org_id = (select current_org_id())`. SECURITY DEFINER RPCs must re-apply `org_id = current_org_id()` or `assert_quote_org(quote_id)`. 10 roles in `role_access` (per-org). Helm master org id `00000000-0000-4000-8000-000000000001` seeds new studios via `create_studio` (copies library tables, excludes `%(testing)%`).

**Key tables:** organizations, profiles, quotes (the "event"; code MMDDYYYY-NN, client jsonb, pricing jsonb, lifecycle_stage), quote_versions, quotation_versions, quote_payments, payment_milestones, leads, event_guests (group counts), **event_attendees** (per-person, phase84), **invitations** (phase83), role_access, library tables (plate_types/chair_types/dish_catalog/menu_templates/layout_rules/app_config), notifications, audit_log.

**Key RPCs:** current_org_id, has_area, is_admin, can_edit, assert_quote_org, create_studio, admin_create_user/set_role/delete_user, convert_lead_to_quote, set_lifecycle_stage, record_payment, save_quotation_version, event_activity, create_invitation/invitation_by_token/accept_invitation, export_tenant_organization_package (+ legacy export_org_data). Migrations are idempotent `supabase/phaseNN-*.sql`, run **manually** in the SQL editor; the frontend degrades gracefully until a migration is applied. Numbered `phaseNN-name.sql` files are authoritative; `full-schema/`, `complete-setup.sql` are mirrors.

**Client patterns:** `BPStore.init()` picks tier supabase→server→local. Facades: quotes, leads, discovery, proposal, plan, milestones, pricing (breakdown/quoteTotal/fromItems), quotationVersions, layoutRules, menuTemplates, org (createStudio/exportData/exportPackage), invitations, attendees, auth/admin, bell, etc. All `.update()/.delete()` carry `.eq("id",…)`. Cache-busting: bump `store-api.js?v=N` across **all** pages when store-api changes.

**Auth/onboarding:** Supabase email/pw (+ Google OAuth coded, not configured). Two paths: create studio (`create_studio`) vs join (`/login?invite=<token>` → `accept_invitation`, which enforces JWT email == invited email, one-org guard, PII-tight token lookup).

**Known issues (open):** (1) `store-api.js` has TWO divergent pricing total formulas (`quoteTotal` vs `breakdown`) that disagree; `breakdown` can go negative; advance % has no ≤100% clamp. (2) `count(*)+1` receipt/version numbering races. (3) `flow.html:saveQuotation` swallows errors and shows "Saved" without recording a version. (4) Node `/api/layouts` is unauthenticated + wildcard CORS (demo tier). (5) a11y: `--ink-3` fails AA contrast in light mode; inputs lack `<label for>` in flow/control/builder/index; modals lack dialog semantics; Control Center add-rows overflow <400px. (6) No tests/CI. (7) Working-tree loose ends: `config.js` lost `liveChannels`; `supabase/functions/send-whatsapp` deleted — left untouched per a strict zero-data-loss guardrail.

**Standing constraints for any future work (user-mandated, top priority):** never write code that can delete/overwrite/corrupt/cross-tenant-expose data; additive + idempotent migrations only (no DROP/TRUNCATE/DROP COLUMN); every mutation scoped by key + `org_id`; `service_role` only server-side from env, never client; never log/print PII; RLS on by default with `org_id = current_org_id()` (NOT `auth.uid()=user_id`, since it's multi-tenant); user runs SQL manually and is the final gate; confirm PITR/backups before schema changes. Payments/WhatsApp/OAuth credentials are the user's to configure — the assistant must not create accounts or handle secrets.
