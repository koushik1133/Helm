# AGENTS.md - coding rules for the Helm repo

Rules for any person or AI agent changing this repo. Plain English. Each rule points at the file that enforces or shows it.
No root `AGENTS.md` or `CLAUDE.md` exists at the time of writing, so this file is the reference. If one is added later, the root file wins and this file must be updated to match.

Helm is an event-studio SaaS. The stack is vanilla HTML/JS (`public/`) served as static files on Vercel (`vercel.json`), with Supabase Postgres, RLS and edge functions behind it (`supabase/`). `server.js` is the **local dev server only**.
Prod is `helm.events` and staging is `helm-v01.vercel.app`.

---

## 0. The top rule: zero data loss

No change may delete, overwrite, corrupt or cross-tenant-expose customer data. If a request could do that, stop and raise it before you write any code. Every other rule below comes after this one.

---

## 1. Inspect before you change

| Do | Why |
|---|---|
| Read the page's `.html`, its `.js` and its `.css`, and grep `public/` for the function name before editing | Many pages share helpers through `shell-proto.js`, `shell-b*.js` and `ui-kit.js`. A local edit can break other pages |
| For DB work, read the **latest** definition of the function or table: the highest-numbered file in `supabase/migrations/` that touches it | Later migrations redefine functions. The latest definition is the one that runs |
| Look in `test/` for a test named after the feature (for example `grep -l builder test/`) | Most features have a source-characterization test that pins their behaviour |
| Read the docs that already exist: `docs/RUNBOOK.md`, `docs/TECHNICAL-HANDOFF.md`, `docs/CANONICAL-DEPLOYMENT.md`, `docs/FILL-ONLY-MIGRATIONS.md`, `docs/DB-TEST-SUITE.md` | They record decisions you might otherwise undo |

## 2. Vanilla JS patterns

- **No framework.** A React/Next.js migration was tried and thrown away. Do not propose it again.
- Pages are plain `public/<page>.html` files, each with its own `<page>.js` and `<page>.css`. Polish layers are separate files, for example `budget-polish.css`.
- Scripts are IIFEs or plain scripts that hang shared objects on `window`. Examples: `window.BPStore` in `public/store-api.js` and the helpers in `ui-kit.js`.
- Guard any use of a global, for example `window.BPStore && BPStore.studioTax`. Pages load in different orders (see `booklet-share.js` and `client.js`).
- Build the DOM with `textContent` and `createElement`, or escape values before you use any HTML sink (§8).

## 3. Naming

| Thing | Convention | Example |
|---|---|---|
| Pages | kebab-case `.html` with a matching `.js`/`.css` | `checkout.html`, `checkout.js`, `checkout-v2.css` |
| Shell family | `shell-b-<area>.js/.css` | `shell-b-search.js` |
| Migrations | `NNNN_snake_case.sql`, 4-digit and strictly increasing | `0162_launch_bypass_off.sql` |
| Paste files | `supabase/APPLY-NNNN.sql` or `APPLY-NNNN-MMMM.sql`, plus `supabase/VERIFY-NNNN.sql` | `APPLY-0160-0161.sql`, `VERIFY-0160.sql` |
| Tests | `test/<feature>.test.mjs` | `test/crew-schedule-ui.test.mjs` |
| Edge functions | kebab-case folder in `supabase/functions/` | `invite-mailer/` |
| SQL functions/RPCs | snake_case, with `my_` for "current user" calls | `my_profile_status`, `current_org_id` |

## 4. Folder structure

| Path | What it holds |
|---|---|
| `public/` | Every shipped asset: HTML pages, JS, CSS, `_headers`, `config.js`, `brand/` |
| `supabase/migrations/` | The canonical forward-only migrations, plus `MANIFEST` (base vs forward) |
| `supabase/APPLY-*.sql`, `VERIFY-*.sql` | Files to paste into the Supabase SQL editor, with read-only checks |
| `supabase/functions/` | Deno edge functions; shared code lives in `_shared/` |
| `supabase/phase*.sql`, `wave*/`, `prod-fix/`, `harden-2026-10/` | Historical files. Do not edit them; add a new migration instead |
| `scripts/` | CI guards and generators (`gen-csp.mjs`, `bump-changed-assets.mjs`, `check-*.mjs`, `db-migrate.sh`, `db-test/`) |
| `test/` | Node unit and source tests run by `npm test` |
| `tests/` | Playwright E2E, DB isolation and staging tests |
| `docs/` | Runbooks, the manual (`docs/manual/USER-MANUAL.html`) and project docs (`docs/project/`) |
| `server.js` | Local dev server only. It never runs in production |

## 5. Reuse components

- Before you write a new modal, toast, table, phone input or search control, look in `ui-kit.js/.css`, `shell-b-*.js`, `toast` (covered by `test/toast.test.mjs`) and the phone input (`test/phone-input.test.mjs`).
- Format money through `BPStore.studioMoney` and `BPStore.studioTax`. Do not hard-code currency or locale, because Helm has India, UAE and US studios.
- Pages loaded through the shell helpers in `shell-proto.js` (`css()` / `js()`) share one version constant, `SHELL_V` (§10).

## 6. No new dependencies

- The only runtime dependency is `@supabase/supabase-js` (pinned exactly, see `package.json`). The dev dependencies are Playwright and axe.
- Do not add npm packages, CDN scripts or build tools. If one looks truly necessary, **Decision needed:** ask the owner first.
- Pin versions exactly, with no `^` or `~`. GitHub Actions must be pinned to full commit SHAs (`scripts/check-actions-pinned.mjs`).

## 7. Error handling

- Wrap every Supabase call: `const { data, error } = await supa.rpc(...)`. Handle `error` and never assume `data` is there (see the pattern in `store-api.js`).
- Messages to users go through the toast or inline UI. Write them in plain words and do not show raw SQL or stack traces (`test/capability-aware-errors.test.mjs`).
- A save that fails must say so and keep what the user typed (`test/rel-save-failure.test.mjs`).
- Security checks must **fail closed**. Example: the MFA check in `store-api.js` treats any error as "MFA required".
- Integrations that are switched off (Razorpay, SMS, WhatsApp) must stay dormant and fail closed (`scripts/check-deferred-integrations.mjs`).

## 8. Security and secrets

- **Never commit secrets.** In docs, name only the env var or secret, never its value. Gitleaks runs in CI over the full history (`.github/workflows/ci.yml`, `secret-scan-history.yml`).
- Only the anon key may appear in the front end. `scripts/check-jwt-roles.mjs` fails on any `service_role` JWT in a tracked file.
- No hard-coded OTP or PIN (`scripts/check-otp-safety.mjs`). Localhost must never point silently at prod (`scripts/check-env-safety.mjs`).
- HTML sinks: no unescaped `innerHTML`, `insertAdjacentHTML` or `document.write` (`scripts/check-html-sinks.mjs`, with exceptions listed in `scripts/html-sinks-allowlist.json`).
- Tenancy is enforced by RLS through `current_org_id()` and `has_area()`. Every new table needs `org_id`, RLS switched on and org-scoped policies. Every `SECURITY DEFINER` function must check the org itself. `check-migration-canon.mjs` guards the phase73 isolation.
- Never use `/api` routes in production. Deploys are static only (`scripts/check-deploy-static.mjs`).
- Email is sent from `notifications@helm.events`, with Reply-To set to the studio's email.

## 9. DB and API access: BPStore and RPC

- Pages read and write data **only through `BPStore`** (`public/store-api.js`). Do not create a second Supabase client inside a page.
- Put privileged or multi-row logic in **Postgres RPCs** (`supa.rpc(...)`) that check role and org on the server. Do not chain client-side table writes.
- Money is decided by the server. Pricing goes through the server pricing RPC (D8, phase99), so the client total is only a display value (`test/money-trust-boundary.test.mjs`, `test/d8-pricing-authority-gap.test.mjs`).
- Base functions are immutable. To change one, rename and wrap it; do not edit it in place (`scripts/check-base-immutable.mjs`).

## 10. CSP and asset versioning

**CSP** (`vercel.json`, `public/_headers`). `script-src` has no `'unsafe-inline'`.
- Do not add inline event handlers (`onclick=`) or `javascript:` URLs.
- Do not add new inline styles; use classes (`scripts/extract-inline-styles.mjs --check`).
- After you edit **any** inline `<script>`, run `npm run gen:csp`. It recomputes the hashes in `vercel.json` and `_headers`, and CI runs `gen-csp.mjs --check`.
- Keep `vercel.json` under 200 KB. The generator enforces this.
- If you change the capture host config, run `node scripts/gen-capture-host.mjs`.

**Cache-busting.** Assets are cached as immutable, so a changed file needs a new `?v=`.
```
node scripts/bump-changed-assets.mjs           # dry run
node scripts/bump-changed-assets.mjs --apply   # rewrite ?v= refs
node scripts/bump-changed-assets.mjs --verify  # fail if a changed asset kept its old version
```
- The script bumps static refs, loader constants and the shared **`SHELL_V` pin in `shell-proto.js`**. That pin covers `shell-b*`, `ui-kit`, `tables-mobile` and `tour.js`.
- It is idempotent, so running it twice does not double-bump.
- Run it before every commit that touches `public/**/*.js|css`.

## 11. Migrations

| Rule | Detail |
|---|---|
| Additive only | Add tables, columns, functions and policies. No `drop table`, `drop column`, `truncate`, or destructive `delete`/`update` of user data |
| Idempotent | Use `if not exists`, `create or replace`, `do $$ ... $$` guards, and drop-then-create for policies. Running twice must be safe |
| Precondition guards | Raise a clear error when a dependency is missing. Example from 0162: `'0162: apply 0045 first'` |
| ASCII only | Use plain hyphens and quotes. Paste files are copied with `LANG=en_US.UTF-8 pbcopy` |
| Paste-safe | No temp tables or session state, so it works when pasted into the Supabase editor |
| Fill-only backfills | Switch off only the `updated_at` touch trigger around the fill (`docs/FILL-ONLY-MIGRATIONS.md`) |
| Header comment | Say in plain words what the migration changes, what it does not touch, "safe to run twice", which environments it targets and what it depends on |
| Three files | `migrations/NNNN_x.sql` (canonical), `APPLY-NNNN.sql` (begin/commit paste) and `VERIFY-NNNN.sql` (read-only, every row should be `ok = true`) |
| Order | Run on staging first and verify there. Run on prod only when the owner says so, in order. Keep the staging-vs-prod tracker up to date |
| Never on prod from tooling | Agents do not run SQL against prod (`nqltzgiwznphugcfhmbm`). DB test scripts refuse the prod ref |
| Tenant data | Every new table gets `org_id not null`, RLS, and `has_area`-based policies |

## 12. Testing

| Command | What it runs |
|---|---|
| `npm test` | All `test/*.test.mjs` source and unit tests. No DB, about 200 files |
| `npm run ci` | Every guard in §8 and §10, plus `gen-csp --check`, `gen-capture-host --check`, `check-migration-canon`, then `npm test` |
| `npm run test:e2e[:smoke\|:security\|:roles\|...]` | Playwright suites (`playwright.config.mjs`; staging config in `playwright.staging.config.mjs`) |
| `npm run test:db` | `scripts/db-test/run-all.sh` against an isolated DB |
| `npm run test:isolation` | `tests/db/tenant-isolation.mjs` |

CI workflows (`.github/workflows/`):
- `ci.yml`: gitleaks, the JWT check, `npm audit` at high, all the guards, `npm test`, and the local `/api/health` check.
- `codeql.yml`: CodeQL scan.
- `db-canonical-pg17.yml`: fresh install and second install, pricing parity, auth and tenant matrices, concurrency.
- `db-tests.yml`: gated on secrets and red on purpose for pending fixes; see `docs/DB-TEST-SUITE.md`.
- `e2e.yml`, `lighthouse.yml`: browser tests and Lighthouse.

When you add a feature, add `test/<feature>.test.mjs` and **append it to the `test` script in `package.json`**. A test file that is not listed there never runs.

## 13. Docs

- **Update `docs/manual/USER-MANUAL.html` with every release** that changes something users can see. Screenshots are refreshed with `scripts/manual-capture.mjs` (`test/manual-gate.test.mjs` guards the manual).
- If you change ops behaviour, update the matching runbook: `docs/RUNBOOK.md`, `DISASTER-RECOVERY-RUNBOOK.md`, `INCIDENT-RESPONSE-RUNBOOK.md`, `OBSERVABILITY-ACTIVATION.md` or `INTEGRATIONS-WHATSAPP-RAZORPAY.md`.
- In docs, mark guesses as "Assumption:" and open owner choices as "Decision needed:".

## 14. Git discipline

| Rule | Detail |
|---|---|
| Branch | Never commit straight to `main`. Use a feature branch or a `harden/**` branch (CI runs on both) |
| PR | Open the PR against `main` on `origin` (`koushik1133/Helm`). CI must be green before merge |
| Commit message | Start with the phase or feature, then a plain-words walkthrough of what changed |
| Remotes | `origin` = koushik1133/Helm (development). `prod` = praneethreddykiwik/Helm (production). **Never push to `prod` without explicit owner OK.** Some work stays local until the owner says "push to main" |
| Stash | Worktrees share the stash. Use a WIP commit, or a tagged `git stash push -m`, never a bare pop |
| Before pushing | Run `npm run ci` and `bump-changed-assets.mjs --verify`. Run `gen-csp` if you touched inline scripts |
| Owner-only actions | Agents never trigger photo renders, flip integration flags (Razorpay, SMS and WhatsApp are off; the owner sets up WhatsApp) or change Supabase/Vercel dashboard settings |

## 15. Product defaults you must keep

- Dark mode is **off**. The default theme is Emerald, the green light theme (`test/theme-green-light.test.mjs`).
- The quote row **is** the event. Do not add a separate events table.
- Studio = organization. Roles are admin, manager, planner, sales, coordinator, supervisor, quality, operations, designer, crew and client. Access comes from the per-role matrix (`has_area`), which is edited in the Control Center.

Assumption: the CI step list above matches `package.json` `ci` and `ci.yml` on origin/main as of 2026-10-17. Re-check both files if they change.
Decision needed: whether to copy this file to the repo root as `AGENTS.md` and `CLAUDE.md` so agents load it automatically.
