# Helm - Knowledge Transfer (KT)

For a new developer or team taking over Helm. Read this first, then the deeper docs it links to.
Everything here describes what exists in the repo (origin/main, checked 2026-10-17), with file references.
Guesses are marked **Assumption:**. Open owner choices are marked **Decision needed:**. No secret values appear here, only the names of env vars and secrets.

---

## 1. Product in one page

Helm ("Helm Events") is a multi-tenant SaaS for **event studios** (wedding/event planners, caterers, decorators). Each studio is an **organization**; its staff sign in and run the whole event lifecycle in one place:

```
Lead  ->  Quote (the quote IS the event)  ->  Floor-plan builder (2D/3D, live pricing)
      ->  Client approval / booklet / portal  ->  Confirm (advance payment)
      ->  Planning / run sheet / crew / inventory / logistics  ->  Event day
      ->  Settlement  ->  Closure
```

| Item | Value |
|---|---|
| Production | `helm.events` (Supabase project ref `nqltzgiwznphugcfhmbm`) |
| Staging | `helm-v01.vercel.app` (separate staging Supabase project, see `public/config.staging.js`, `docs/STAGING-SETUP.md`) |
| Hosting | Vercel, static files from `public/` (`vercel.json`, `outputDirectory: public`) |
| Backend | Supabase: Postgres + RLS + RPCs + Auth + Storage + Deno edge functions |
| Front end | Vanilla HTML/CSS/JS, no framework, no build step |
| Only runtime dependency | `@supabase/supabase-js` 2.117.3 (exact pin, `package.json`) |
| Email | Sent from `notifications@helm.events`, Reply-To = the studio's email |
| Integrations | Razorpay, SMS (MSG91) and WhatsApp are **switched off** (`public/config.js` `liveChannels` all `false`). WhatsApp is set up separately by the owner |
| Theme | Default theme Emerald (green light). Dark mode is **off** (`test/theme-green-light.test.mjs`) |

A React/Next.js migration was tried and discarded. Do not propose it again.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| Studio / org | One customer business. Table `organizations`; every tenant row carries `org_id` |
| `current_org_id()` | SQL helper returning the signed-in user's org. Used by every RLS policy |
| `has_area(area, 'view'\|'edit')` | SQL helper that reads the per-role matrix `role_access`. Admin always passes. Latest version in `supabase/migrations/0154_final_fixes.sql` (see `docs/project/DATABASE.md`) |
| Area | A permission bucket (leads, quotes, design, inventory, settlement...) in `role_access` |
| Role | admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew, client |
| Lead | An enquiry (`leads.html`, `crm.html`) |
| Quote | The quote row **is** the event. There is no separate events table. Versioned (`phase77-quotation-versions.sql`) |
| Builder | The 2D/3D floor-plan designer with live pricing (`builder.html`, `builder.js`, `builder-3d.js`, `builder-tools.js`) |
| Flow | The unified quote flow page (`flow.html` + `flow-*.js`) |
| Booklet | A shareable, token-linked proposal/brochure for the client (`booklet*.js/css`, table `client_booklets`) |
| Portal / approve | Client-facing pages reached by token links (`portal.html`, `approve.html`, `proposal-view.html`) |
| Work link | Token link for crew without accounts (`work.html`) |
| Run sheet | Event-day timeline (`runsheet.html`) |
| Settlement / closure | Final money reconciliation and closing an event (`settlement.html`, `closure.html`). Closing is refused while money is owed (0049) |
| D8 / pricing authority | The server decides the price (`phase99-server-pricing-authority.sql`, `migrations/0001_pricing_authority.sql`); client totals are display only |
| BPStore | The single client data facade, `window.BPStore` in `public/store-api.js` (~10.5k lines). Name comes from the old codename "Blueprint Stage" |
| Shell / shell-b | Shared app chrome: sidebar, search, theme, tour (`shell-proto.js`, `shell-b*.js/css`) |
| `SHELL_V` | One cache version string in `public/shell-proto.js` for every file the shell loads |
| HQ | Platform-operator console (`hq.html`, private) |
| APPLY / VERIFY files | SQL files to paste into the Supabase SQL editor (`supabase/APPLY-NNNN.sql`, `VERIFY-NNNN.sql`) |
| MANIFEST | The only sanctioned apply order for a fresh DB (`supabase/migrations/MANIFEST`, run by `scripts/db-migrate.sh`) |

---

## 3. How the code is organised

### 3.1 Top-level

| Path | What it is |
|---|---|
| `public/` | Everything shipped: ~270 files - HTML pages, page JS/CSS, `_headers`, `config.js`, `config.staging.js`, `brand/`, `vendor/` |
| `supabase/migrations/` | Canonical forward-only migrations `0001`..`0162` + `MANIFEST` |
| `supabase/canonical-base/` | Prod-extracted base schema (fresh installs only) |
| `supabase/APPLY-*.sql`, `VERIFY-*.sql` | Paste files and read-only checks |
| `supabase/phase*.sql`, `wave*/`, `prod-fix/`, `harden-2026-10/`, etc. | **Historical**. Do not edit; add a new migration |
| `supabase/functions/` | Deno edge functions (list in 3.4); shared code in `_shared/` (`cors.ts`, `limits.ts`, `money.ts`) |
| `server.js` | **Local dev server only** (static files + demo `/api/layouts`, default port 4173). Never runs in prod |
| `vercel.json` | Rewrites (pretty URLs like `/<studio>/quotes`, `/i/<slug>`), security headers, CSP hashes |
| `scripts/` | CI guards and generators (`gen-csp.mjs`, `bump-changed-assets.mjs`, `check-*.mjs`, `db-migrate.sh`, `db-test/`) |
| `test/` | ~200 Node source/unit tests run by `npm test` |
| `tests/` | Playwright E2E (`tests/e2e`), DB isolation (`tests/db`), edge (`tests/edge`), staging (`tests/staging`) |
| `docs/` | Runbooks, manual, product/project docs |
| `.github/workflows/` | `ci.yml`, `codeql.yml`, `db-canonical-pg17.yml`, `db-tests.yml`, `e2e.yml`, `lighthouse.yml`, `secret-scan-history.yml` |

### 3.2 Key front-end files

| File | Role |
|---|---|
| `public/config.js` | Runtime config: Supabase URL + **anon** key, host routing (prod / staging / localhost), `liveChannels`, `HELM_FEATURES`, auth/MFA/session/captcha settings |
| `public/config.staging.js` | Staging project's public values and host list |
| `public/store-api.js` | `BPStore`: auth/session gate (incl. MFA), all reads/writes, RPC calls, money/tax formatting (`studioMoney`, `studioTax`), client capability matrix (hides UI only) |
| `public/shell-proto.js` | Boots the app shell; loads `shell-b*`, `ui-kit`, `tables-mobile`, `tour.js` with `?v=SHELL_V` |
| `public/shell-b*.js/css` | Sidebar, search (`shell-b-search`), theme, money, privacy, dashboard chrome |
| `public/ui-kit.js/css` | Shared modal, toast, tables, controls. Reuse before writing new ones |
| `public/login.html`, `auth-ui.js`, `reset-password.*` | Sign-in (email/password + Google OAuth PKCE), reset |
| `public/onboarding*.js`, `trial*.js`, `smart-import*.js` | New studio setup, trial, import |
| `public/dashboard.html`, `leads.html`, `crm.html`, `quotes.html`, `flow.html`, `builder.html`, `event.html` | Core sales and design pages |
| `public/plan.html`, `runsheet.html`, `staff.html`, `crew-schedule.js`, `inventory.html`, `checkout.html`, `logistics.html`, `vendors.html`, `vendor-bills-ui.js` | Operations |
| `public/settlement.html`, `closure.html`, `budget.html`, `reports.html`, `insights.html` | Money and closing |
| `public/approve.html`, `portal.html`, `proposal-view.html`, `booklet.html`, `work.html`, `invite.html` | Token/public pages (client, crew, invitation sites) |
| `public/control.html` | Control Center (admin): role matrix, studio settings, templates, comms |
| `public/chat.html` | Team chat |
| `public/hq.html` | Platform operator console (private) |
| `public/welcome`/marketing pages, legal pages (`privacy`, `terms`, `dpa`, `refund-policy`...) | Public site |

Each page is `page.html` + `page.js` + `page.css`, often with a `page-polish.css` layer. Scripts are IIFEs that hang objects on `window`; always guard globals (`window.BPStore && ...`).

### 3.3 Database

- 162 canonical migrations; see `docs/project/DATABASE.md` for the table catalogue.
- **The latest definition wins**: a function or policy may be redefined many times. Always read the highest-numbered migration that touches it (`grep -l name supabase/migrations/*.sql | tail -1`).
- Base functions are immutable (`scripts/check-base-immutable.mjs`); change them by renaming and wrapping.

### 3.4 Edge functions (`supabase/functions/`)

`invite-mailer`, `invite-signup`, `welcome-mailer`, `security-alert-mailer`, `billing-reminder`, `comms-dispatch`, `pkg-client-notify`, `booklet-snapshot`, `verify-upload`, `render-photo`, `send-otp`, `send-phone-code`, `send-whatsapp`, `wa-proposal`, `wa-webhook`, `create-payment-link`, `razorpay-webhook`, `create-subscription-checkout`, `razorpay-subscription-webhook`, `integrations-test`.
Payment/SMS/WhatsApp functions are dormant and fail closed until deployed with secrets and the matching `liveChannels` flag is flipped. Secret names are listed in `docs/project/SETUP-AND-ENVIRONMENT.md` and `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md` (for example `APP_URL`, `ALLOWED_ORIGINS`, `EXTRA_ALLOWED_ORIGINS`, `ALLOW_LOCALHOST`).

---

## 4. How data flows

```
Browser page (public/*.html + *.js)
   |  only through BPStore (store-api.js)
   v
supabase-js (anon key + user JWT)
   |-- PostgREST table reads/writes  -> RLS: org_id = current_org_id() AND has_area(...)
   |-- supa.rpc(...)                 -> SECURITY DEFINER RPCs that check role + org themselves
   |-- Storage (e.g. invite-media)   -> org-isolated storage policies
   '-- functions.invoke(...)         -> Edge functions (CORS allowlist, rate limits)
Token pages (approve/portal/booklet/work/invite) -> token RPCs with time windows and expiry
```

Rules that follow from this:
- No second Supabase client inside a page; no `/api` routes in production (`scripts/check-deploy-static.mjs`).
- Multi-row or privileged logic goes into an RPC, not chained client writes.
- Money is decided on the server (D8). Tests: `test/money-trust-boundary.test.mjs`, `test/d8-pricing-authority-gap.test.mjs`.

---

## 5. Roles and permissions

| Layer | How it works | Where |
|---|---|---|
| Tenancy | Every tenant table has `org_id not null` + RLS; policies compare to `current_org_id()` | `phase56`-`phase60`, `phase70`-`phase73`, `0004_tenant_integrity.sql` |
| Area matrix | `role_access(org_id, role, area, can_view, can_edit)`, edited in Control Center (`admin_get_role_access` / `admin_set_role_access`). The matrix is the single authority (owner decision D2, `0044_revert_matrix_seed.sql`) | `phase29-role-access.sql`, later migrations |
| Gate helper | `has_area(area, need)`; admin always true. RPCs raise `42501 not authorized` | latest in `0154_final_fixes.sql` |
| Client UI | Capability matrix in `store-api.js` only hides UI; unknown role fails closed | `store-api.js` |
| Token users | Clients/crew without accounts use expiring token links | `0012`, `0022`, `0039`, `0040` |
| Platform admin | HQ operator checks | `0029_platform_admin.sql`, `0037_platform_operator_check.sql` |
| Auth | Email/password + Google OAuth; TOTP MFA with server-side lockout (`0050`, `0158_mfa_verify_hook.sql`); Turnstile hook present but empty (off) | `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md` |

Known gap to remember: `can_edit` and `has_area` have diverged before (manager blocked from settlement/closure). Test any role change with `test/role-access-audit.test.mjs` and the Playwright `@roles` suite.

**Decision needed:** when to require MFA for admins (`config.js auth.mfaRequiredForAdmins`, currently `false`), session idle timeout (currently off) and Turnstile for launch.

---

## 6. Run it locally

```bash
npm ci            # installs supabase-js + Playwright/axe (dev)
npm start         # node server.js -> http://127.0.0.1:4173  (PORT env to change)
```

- On localhost, `config.js` **clears the Supabase settings**, so the app falls back to `server.js` / browser storage and cannot touch prod by accident (`scripts/check-env-safety.mjs`).
- To work against **staging** from localhost, use the staging routing in `config.js` + `config.staging.js` (or a `helm.staging` localStorage override). See `docs/project/SETUP-AND-ENVIRONMENT.md`.
- Connecting localhost to prod needs an explicit opt-in (`window.HELM_ALLOW_PROD_FROM_LOCALHOST` or the 8-hour `helm.allowProdFromLocalhost` value). Do not use it for writes.
- Localhost-only features: `HELM_FEATURES.integrationsPage` and the onboarding payment bypass.
- Tests: `npm test` (no DB), `npm run ci` (all guards + tests), `npm run test:e2e` (Playwright), `npm run test:db` / `test:isolation` (isolated DB; scripts refuse the prod ref).

---

## 7. Making a change safely (checklist)

| Step | What to do |
|---|---|
| 1. Inspect | Read the page's html/js/css, grep `public/` for the function, find the test in `test/`, read the latest migration for any DB object |
| 2. Branch | Never commit to `main`. Use a feature or `harden/**` branch (CI runs on both). Use worktrees; never bare `git stash pop` (stash is shared) |
| 3. Code | Vanilla JS; `textContent`/`createElement` or escape before HTML sinks (`check-html-sinks.mjs`); no inline `on*=` handlers, no `javascript:` URLs, no new inline styles |
| 4. CSP | If you touched any inline `<script>`, run `npm run gen:csp` (updates hashes in `vercel.json` + `public/_headers`). Keep `vercel.json` < 200 KB |
| 5. Bump assets | `node scripts/bump-changed-assets.mjs --apply`, then `--verify`. It bumps `?v=` refs, loader constants and `SHELL_V` |
| 6. Tests | Add `test/<feature>.test.mjs` **and append it to the `test` script in `package.json`** (unlisted tests never run). Run `npm run ci` |
| 7. Migrations | Additive + idempotent + paste-safe + ASCII only + precondition guards + plain header. Ship three files: `migrations/NNNN_x.sql`, `APPLY-NNNN.sql`, `VERIFY-NNNN.sql` (all rows `ok = true`). Add to `MANIFEST` |
| 8. Docs | Update `docs/manual/USER-MANUAL.html` for user-visible changes; update the matching runbook for ops changes |
| 9. PR | PR against `main` on `origin` (koushik1133/Helm). Commit message starts with the phase/feature, then a plain-words walkthrough. CI green before merge |
| 10. Staging | Owner pastes APPLY on staging, runs VERIFY, tests on `helm-v01.vercel.app` |
| 11. Prod | Only when the owner says go: APPLY on prod in order, VERIFY, push to the `prod` remote (praneethreddykiwik/Helm) / `helm.events`. Some work stays local until the owner says "push to main" |

Full rules: `docs/project/AGENTS.md`. Deploy specifics: `docs/CANONICAL-DEPLOYMENT.md`, `docs/RUNBOOK.md`, `PRODUCTION-RELEASE-PACK.md`.

---

## 8. Pitfalls learned the hard way

| Pitfall | What goes wrong | How to avoid |
|---|---|---|
| Asset cache pins | Assets are cached immutable; a changed JS/CSS with the same `?v=` never reaches users | Always run `bump-changed-assets.mjs --apply` + `--verify` |
| `SHELL_V` pin in `shell-proto.js` | Shell files (`shell-b*`, `ui-kit`, `tables-mobile`, `tour.js`) are loaded via one shared version (currently `"116"`); editing them without bumping it ships stale shells | The bump script handles it; check the diff touches `SHELL_V` |
| CSP inline scripts | `script-src` has no `'unsafe-inline'`; an edited inline script is silently blocked in prod | `npm run gen:csp`; CI runs `--check`. Never add `onclick=` |
| `vercel.json` size | Per-host CSP duplication once grew it to 700 KB and Vercel rejected it | Generator enforces < 200 KB and < 200 rules |
| RLS "latest definition wins" | Editing an old phase file or an older migration changes nothing that runs, or reverts a fix | Read the highest-numbered definition; write a new migration |
| APPLY aggregate files go stale | `supabase/APPLY-PENDING.sql` / `APPLY-ALL-PENDING.sql` are snapshots (APPLY-PENDING is v15 covering 0049-0051) | Use per-number `APPLY-NNNN.sql`; rebuild aggregates on purpose. Track staging vs prod separately |
| Supabase editor pastes | Temp tables/session state break; the editor shows only the last result grid; non-ASCII gets mangled | Paste-safe SQL, ASCII only, copy with `LANG=en_US.UTF-8 pbcopy`, run VERIFY separately |
| Never delete data | Top rule: no change may delete, overwrite, corrupt or cross-tenant-expose data | Additive migrations; fill-only backfills (`docs/FILL-ONLY-MIGRATIONS.md`); raise risky asks before coding |
| Prod from tooling | Accidental SQL on prod | Agents/tools never run SQL against `nqltzgiwznphugcfhmbm`; DB test scripts refuse it |
| Localhost to prod | Local testing writing prod data | `config.js` clears Supabase on localhost; opt-in is explicit and expiring |
| Integrations | Flipping `liveChannels` before deploy + secrets breaks flows | Keep off; owner-only decision |
| Photo renders | Cost money | Never trigger renders; prepare and ask the owner to test |
| Money/currency | Hard-coded INR breaks UAE/US studios | `BPStore.studioMoney` / `studioTax` |

---

## 9. Where the docs live

| Need | Doc |
|---|---|
| Coding rules | `docs/project/AGENTS.md` |
| Architecture | `docs/project/ARCHITECTURE.md`, `docs/TECHNICAL-HANDOFF.md` |
| Database | `docs/project/DATABASE.md`, `docs/DB-TEST-SUITE.md`, `docs/FILL-ONLY-MIGRATIONS.md` |
| Setup / env vars | `docs/project/SETUP-AND-ENVIRONMENT.md`, `docs/STAGING-SETUP.md` |
| Testing | `docs/project/TESTING-QA.md` |
| Product | `docs/project/PRD.md`, `docs/project/DESIGN.md`, `docs/helm-team-workflows.md` (Assumption: path as given by the owner), `docs/business-questions` (Assumption: same) |
| Integrations | `docs/project/INTEGRATIONS.md`, `docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md`, `docs/COMMS-AUTOMATION-SETUP.md`, `supabase/functions/README.md` |
| Deploy and ops | `docs/CANONICAL-DEPLOYMENT.md`, `docs/RUNBOOK.md`, `docs/DISASTER-RECOVERY-RUNBOOK.md`, `docs/INCIDENT-RESPONSE-RUNBOOK.md`, `docs/OBSERVABILITY-ACTIVATION.md` |
| Auth | `docs/AUTH-DASHBOARD-SETTINGS.md`, `docs/AUTH-PRODUCTION-HARDENING.md`, `docs/OWNER-ACTIONS-SECURITY.md` |
| User manual | `docs/manual/USER-MANUAL.html` |
| Plan | `docs/project/IMPLEMENTATION-PLAN.md`, root `REMINDERS.md`, `PROGRESS.md`, `BACKLOG-meeting.md` |

---

## 10. Who owns what

| Area | Owner |
|---|---|
| Product decisions, release go/no-go, prod SQL and prod push | Owner (repo `koushik1133`) |
| Production repo/remote | `prod` = praneethreddykiwik/Helm (client side). Assumption: the client (Praneeth) owns the production Vercel/domain account |
| Supabase + Vercel dashboard settings, secrets, auth settings | Owner only |
| WhatsApp (Meta) setup, Razorpay KYC, email DNS | Owner |
| Code, tests, migrations (drafted), docs | Development team / agents, via PR |
| Photo-render testing | Owner only |

**Decision needed:** name a named on-call / incident owner and a backup for `docs/INCIDENT-RESPONSE-RUNBOOK.md`.

---

## 11. Open work (at handover)

From `docs/project/IMPLEMENTATION-PLAN.md` (suggested order P1 -> P2 -> P3 -> P4 -> P5 -> P7 -> P6 -> P8 -> P9 -> P10 -> P11):

| # | Item | Notes |
|---|---|---|
| P1 | Manager questionnaire answers | Unblocks P5/P6 |
| P2 | Logo rebrand (compass "H") | Needs final SVG |
| P3 | Email go-live | DNS for helm.events, provider account |
| P4 | Turnstile bot protection | Can lock out sign-in if misconfigured |
| P5 | Lead dedupe / same-email overwrite fix | Touches customer records - zero-data-loss care |
| P6 | Dashboard improvements (incl. parked period filter) | |
| P7 | Crew schedule polish | Needs `0161` on both DBs |
| P8 | Vendor bills / payouts / net profit | Money |
| P9 | Time-aware calendar (event times, overlap conflicts) | Previously built then reverted |
| P10 | WhatsApp go-live | Owner sets up Meta |
| P11 | Razorpay go-live | KYC, legal pages; high risk |

Also outstanding (owner reminders):
- Keep the staging-vs-prod SQL tracker current; newest migrations (up to `0162_launch_bypass_off.sql`) must be confirmed applied on each DB. **Decision needed:** confirm which APPLY files are applied on prod.
- Security follow-ups after prod push: accounts on default passwords, repos private, staging password, Supabase auth settings (`docs/OWNER-ACTIONS-SECURITY.md`).
- `db-tests.yml` is intentionally red for pending fixes (`docs/DB-TEST-SUITE.md`).
- Parked: dark-mode accent contrast (dark mode is off), fresh prod Supabase project in Mumbai (option A, planned after release).
- **Decision needed:** copy `docs/project/AGENTS.md` to repo root as `AGENTS.md`/`CLAUDE.md`.

---

## 12. First week for a newcomer

1. Read this file, `AGENTS.md`, `ARCHITECTURE.md`, `DATABASE.md`.
2. `npm ci && npm run ci` - everything should pass locally.
3. `npm start`, then connect to **staging** and walk one event from lead to closure (use `docs/manual/USER-MANUAL.html`).
4. Pick a small item (P2 or P7), make it on a branch following section 7, open a PR.
