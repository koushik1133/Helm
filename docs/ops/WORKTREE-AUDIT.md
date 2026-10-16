# Worktree audit (read-only) — 2026-10-16

Generated read-only from `git worktree list` run in `wt-side` (after `git fetch origin`). Nothing was deleted or modified.

- Worktrees registered: 148 (main checkout `2d view-restored` + its `.claude/worktrees/agent-*` + `wt-*` folders).
- `Helm/` on disk: ~10 GB (du). Sum of per-worktree du is higher because nested agent worktrees sit inside `2d view-restored`.
- Merged = HEAD commit is an ancestor of origin/main. Pushed = HEAD contained in some origin branch.

## Summary

| Group | Count | Approx. size |
|---|---|---|
| SAFE TO REMOVE | 132 | ~8.9 GB |
| REVIEW | 14 | ~0.9 GB |
| KEEP | 2 | (main checkout + wt-side) |

**Estimated space freed if all SAFE worktrees are removed: ~8.9 GB** (most of it is per-worktree `node_modules`). Removing REVIEW ones after triage frees ~0.9 GB more.

Caution: other Claude sessions/workflows may be running in some `wt-*` folders right now. Only remove when no session is active.

## KEEP

| Path | Branch | Last commit | Dirty files | Merged | Pushed | Size |
|---|---|---|---|---|---|---|
| `2d view-restored` | detached | 2026-10-10 | 4 | merged | pushed | 1327 MB |
| `wt-side` | feat/ui-sidebar-2 | 2026-10-11 | 327 | merged | pushed | 282 MB |

- `wt-side` = current working worktree (local, uncommitted work in progress — do not touch).
- `2d view-restored` = main checkout; it owns the `.git` directory for every worktree. Never delete it (that would orphan all others). It has 4 uncommitted entries — review separately.

## REVIEW (uncommitted or unpushed work)

| Path | Branch | Last commit | Dirty files | Merged | Pushed | Size |
|---|---|---|---|---|---|---|
| `2d view-restored/.claude/worktrees/agent-a1324268c0e5ad26f` | worktree-agent-a1324268c0e5ad26f | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-a1fb818f590a8cc2e` | worktree-agent-a1fb818f590a8cc2e | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-a3073ef895ca6ef86` | worktree-agent-a3073ef895ca6ef86 | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-a7644f897fc9a437b` | worktree-agent-a7644f897fc9a437b | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-a8e31921b3838f51b` | worktree-agent-a8e31921b3838f51b | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-a9824f86c828d1564` | worktree-agent-a9824f86c828d1564 | 2026-10-08 | 10 | merged | pushed | 65 MB |
| `2d view-restored/.claude/worktrees/agent-a9f70182320bdfaea` | worktree-agent-a9f70182320bdfaea | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-acc77fdc0b0e73882` | worktree-agent-acc77fdc0b0e73882 | 2026-10-08 | 0 | no | no | 66 MB |
| `2d view-restored/.claude/worktrees/agent-ae9f2ab42782cc323` | worktree-agent-ae9f2ab42782cc323 | 2026-10-08 | 0 | no | no | 66 MB |
| `wt-ci` | fix/ci-checks | 2026-10-07 | 1 | merged | pushed | 73 MB |
| `wt-fix1` | fix/live-round1 | 2026-10-10 | 1 | merged | pushed | 68 MB |
| `wt-main` | detached | 2026-10-10 | 1 | merged | pushed | 100 MB |
| `wt-pending-sql` | detached | 2026-10-08 | 1 | merged | pushed | 66 MB |
| `wt-signup` | feat/signup-confirm-emails | 2026-10-08 | 6 | merged | pushed | 64 MB |

What is in them:

- Unpushed local commits (branch never pushed; content may have been re-landed via another PR — verify with `git log origin/main --grep` before discarding):
  - `agent-a1324268c0e5ad26f` — cf514305 Admin/chat/login/tour UX batch
  - `agent-a1fb818f590a8cc2e` — a5d8f3db Builder hardening B1-B12, L4
  - `agent-a3073ef895ca6ef86` — 5f369547 Inventory/calendar/date/logout hardening
  - `agent-a7644f897fc9a437b` — db993e68 Resources audit fixes
  - `agent-a8e31921b3838f51b` — 5b5beb7f Quotes/event/proposal/plan audit fixes
  - `agent-a9f70182320bdfaea` — 358870c8 Pending SQL sections 2-10
  - `agent-acc77fdc0b0e73882` — 46edd754 + 4f951bbe store-api range reads / chat read-state
  - `agent-ae9f2ab42782cc323` — 1492cef7 Builder pricing sync / package revert
  - Safe preservation (no data loss): `git -C "<path>" push origin HEAD:refs/heads/archive/<name>` before removing.
- Uncommitted changes:
  - `agent-a9824f86c828d1564` — 10 staged files (onboarding.html, onboarding-core.js, control.html, nav-trail.js, _headers, package.json ...)
  - `wt-signup` — 6 modified docs/email-templates/*.html
  - `wt-ci` — untracked `.lighthouseci/` (report output, likely disposable)
  - `wt-fix1` — modified `deno.lock` (likely disposable)
  - `wt-main` — `node_modules` symlink shown as deleted (likely disposable)
  - `wt-pending-sql` — `.claude/launch.json` deleted (likely disposable)
  - Inspect with `git -C "<path>" status` / `git -C "<path>" diff`; commit to a branch and push if worth keeping.

## SAFE TO REMOVE (clean + merged or pushed)

| Path | Branch | Last commit | Dirty files | Merged | Pushed | Size |
|---|---|---|---|---|---|---|
| `2d view-restored/.claude/worktrees/agent-a090d7afb1f351c89` | feat/profile-menu-search | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `2d view-restored/.claude/worktrees/agent-a0b7c9c8cf7bf974b` | worktree-agent-a0b7c9c8cf7bf974b | 2026-10-06 | 0 | merged | pushed | 61 MB |
| `2d view-restored/.claude/worktrees/agent-a1a08003cb27f9646` | worktree-agent-a1a08003cb27f9646 | 2026-10-06 | 0 | merged | pushed | 60 MB |
| `2d view-restored/.claude/worktrees/agent-a1a7110cc05254850` | worktree-agent-a1a7110cc05254850 | 2026-10-06 | 0 | merged | pushed | 60 MB |
| `2d view-restored/.claude/worktrees/agent-a3f93b0cf446843b3` | worktree-agent-a3f93b0cf446843b3 | 2026-10-06 | 0 | merged | pushed | 60 MB |
| `2d view-restored/.claude/worktrees/agent-a6b2c3872331814e0` | worktree-agent-a6b2c3872331814e0 | 2026-10-06 | 0 | merged | pushed | 60 MB |
| `2d view-restored/.claude/worktrees/agent-ab5c508660e376892` | worktree-agent-ab5c508660e376892 | 2026-10-06 | 0 | merged | pushed | 61 MB |
| `2d view-restored/.claude/worktrees/agent-ac2e585fb22c78222` | builder-ux-compact-pan | 2026-10-06 | 0 | merged | pushed | 61 MB |
| `2d view-restored/.claude/worktrees/agent-acf2f29dfa2677f6d` | feat/studio-search | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `hq-billing-extras` | feat/hq-billing-extras | 2026-10-07 | 0 | merged | pushed | 63 MB |
| `wt-0049` | fix/db-gates-0049 | 2026-10-07 | 0 | merged | pushed | 64 MB |
| `wt-0052` | fix/vercel-json-size | 2026-10-08 | 0 | merged | pushed | 94 MB |
| `wt-0053` | feat/password-lockout-0053 | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-0054` | feat/security-alerts-0054 | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-0070` | detached | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-auth` | fix/auth-pkce-enum | 2026-10-07 | 0 | merged | pushed | 63 MB |
| `wt-big` | feat/round-onboarding-import-tax-layout | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-big2` | feat/round-render-templates-demo-india | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-breadcrumbs-recents` | feat/breadcrumbs-recents | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-cap2` | fix/capture-exposure | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-cat` | feat/catalog-prices-dish-editor | 2026-10-10 | 0 | merged | pushed | 98 MB |
| `wt-checklist` | feat/getting-started | 2026-10-08 | 0 | merged | pushed | 95 MB |
| `wt-checkout` | feat/onboarding-checkout | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-client-360` | feat/client-360 | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-client-booklet` | feat/client-booklet | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-cur` | feat/per-currency-totals | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-d6` | feat/d6-money-freeze | 2026-10-07 | 0 | merged | pushed | 63 MB |
| `wt-demo` | feat/trial-demo-mode | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-deploy` | detached | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-e2e` | fix/e2e-usability | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-ent` | fix/design-hide-walk-exit | 2026-10-11 | 0 | merged | pushed | 70 MB |
| `wt-envsplit` | fix/env-config-split | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-final` | fix/flow-snapshots | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-fix-chat` | fix-chat | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-fix-inv` | fix-inv | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-fix-ui` | fix-ui | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-fix2` | fix/live-round2 | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-fix3` | fix/attr-money | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-fix4` | fix/auth-ui-version | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-fix5` | fix/demo-seed-live | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-fix6` | fix/india-clickthrough | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-flow-return` | detached | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-hdr` | feat/builder-header-classic | 2026-10-11 | 0 | merged | pushed | 70 MB |
| `wt-headers` | fix/headers-edge-caps | 2026-10-07 | 0 | merged | pushed | 94 MB |
| `wt-hqmfa` | fix/hq-mfa-optional | 2026-10-07 | 0 | merged | pushed | 63 MB |
| `wt-imp` | feat/smart-import | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-india` | fix/india-polish | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-india2` | fix/india-polish-2 | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-inv` | fix/nurture-phone-checkout | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-issuereview` | detached | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-lay` | feat/layout-wizard | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-loadwarn` | feat/load-size-warning | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-menu` | fix/menu-packages | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-mobile-bottom-bar` | feat/mobile-bottom-bar | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-name2` | fix/name-live-update | 2026-10-10 | 0 | merged | pushed | 100 MB |
| `wt-naming` | feat/quote-naming | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-nfix` | fix/nurture-blank-templates | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-notif-deeplinks` | feat/notif-deeplinks | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-notif-tabs` | feat/notif-tabs | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-onb` | feat/onboarding-wizard | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-onboard` | feat/onboarding-0057-0059 | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-phone` | fix/phone-defaults | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-pkg-flow` | feat/pkg-flow | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-pkg-ui` | feat/pkg-ui | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-pm` | merge-pm | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-polish-fixes` | feat/polish-fixes | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-polish3` | fix/tour-race | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-pretty-urls` | feat/pretty-urls | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-profile` | feat/profile-phone-ui | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-r10` | detached | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-r2` | feat/round2 | 2026-10-08 | 0 | merged | pushed | 67 MB |
| `wt-r2-builder` | feat/r2-builder | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-r2-capture` | feat/r2-capture | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-r2-insights` | feat/r2-insights | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-r2-onboard` | feat/r2-onboard | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-r3` | fix/round3-live | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r3-a` | feat/r3-a | 2026-10-08 | 0 | merged | pushed | 67 MB |
| `wt-r3-b` | feat/r3-b | 2026-10-08 | 0 | merged | pushed | 67 MB |
| `wt-r3-c` | feat/r3-c | 2026-10-08 | 0 | merged | pushed | 67 MB |
| `wt-r4` | feat/round4 | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r4a` | feat/r4-a | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r4b` | feat/r4-b | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r4c` | feat/r4-c | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r4d` | feat/r4-d | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r4e` | feat/r4-e | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r5` | fix/booklet-share-event | 2026-10-09 | 0 | merged | pushed | 97 MB |
| `wt-r6` | feat/label-modes | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r7` | fix/r7-polish | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r8` | detached | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r8a` | fix/r8-checklist | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r8b` | fix/r8-sync | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r8c` | fix/r8-capture | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r9` | feat/round9 | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r9a` | fix/r9-sizing | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r9b` | fix/r9-capture | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r9c` | fix/r9-flow | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-r9d` | fix/r9-pages | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-render` | feat/photoreal-render | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-render2` | feat/render-dialog-polish | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-render3` | feat/render-fidelity | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-render4` | feat/render-master-prompt | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-render5` | fix/render-event-context | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-round` | fix/date-guard | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-safehtml` | feat/safe-html | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-saved-filters` | feat/saved-filters | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-scan` | feat/upload-verify | 2026-10-07 | 0 | merged | pushed | 64 MB |
| `wt-sess` | fix/session-hardening | 2026-10-07 | 0 | merged | pushed | 64 MB |
| `wt-sqlreview` | detached | 2026-10-08 | 0 | merged | pushed | 66 MB |
| `wt-staff` | fix/staff-roles-design | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-tax` | feat/country-tax | 2026-10-10 | 0 | merged | pushed | 98 MB |
| `wt-terms` | fix/approve-country | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-tmpl` | feat/studio-templates-venue-area | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-toasts` | feat/toast-notifications | 2026-10-08 | 0 | merged | pushed | 64 MB |
| `wt-toolbar2` | feat/builder-toolbar-2 | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-tour` | fix/tour-first-signup | 2026-10-09 | 0 | merged | pushed | 67 MB |
| `wt-tpl` | feat/country-templates | 2026-10-10 | 0 | merged | pushed | 68 MB |
| `wt-trial` | feat/trial-reminders | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-uae` | fix/uae-polish | 2026-10-10 | 0 | merged | pushed | 69 MB |
| `wt-uae2` | fix/uae-live | 2026-10-11 | 0 | no | pushed | 70 MB |
| `wt-ui` | fix/clean-banners-headers | 2026-10-07 | 0 | merged | pushed | 94 MB |
| `wt-uploads` | fix/uploads-hardening | 2026-10-07 | 0 | merged | pushed | 64 MB |
| `wt-ux` | feat/ux-pack | 2026-10-08 | 0 | merged | pushed | 65 MB |
| `wt-v` | fix/v-hall | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-v1` | feat/venues | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-v2` | feat/item-specs | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-v3` | feat/event-assets | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-v4` | feat/walkthrough | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-v6` | fix/v-spread | 2026-10-09 | 0 | merged | pushed | 68 MB |
| `wt-venue4` | feat/venue4-walkthrough | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `wt-welcome` | feat/welcome-email | 2026-10-08 | 0 | merged | pushed | 95 MB |
| `wt-wt` | fix/wizard-venue-walk-overlap | 2026-10-10 | 0 | merged | pushed | 70 MB |
| `/Users/koushikgoudshaganti/security-audit-skill/Helm/run-2/postfix/wt` | security/audit-run2-fixes | 2026-10-07 | 0 | merged | pushed | 93 MB |

## Commands for the owner (run later, manually, when no Claude session is active)

Run from `/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored`. `git worktree remove` (without --force) refuses to delete a worktree that has uncommitted changes, so it is safe by construction. Branches are NOT deleted by these commands.

```sh
cd "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a090d7afb1f351c89"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a0b7c9c8cf7bf974b"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a1a08003cb27f9646"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a1a7110cc05254850"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a3f93b0cf446843b3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-a6b2c3872331814e0"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-ab5c508660e376892"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-ac2e585fb22c78222"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/2d view-restored/.claude/worktrees/agent-acf2f29dfa2677f6d"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/hq-billing-extras"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0049"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0052"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0053"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0054"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0070"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-auth"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-big"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-big2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-breadcrumbs-recents"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-cap2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-cat"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-checklist"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-checkout"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-client-360"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-client-booklet"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-cur"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-d6"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-demo"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-deploy"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-e2e"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-ent"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-envsplit"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-final"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix-chat"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix-inv"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix-ui"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix4"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix5"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-fix6"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-flow-return"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-hdr"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-headers"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-hqmfa"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-imp"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-india"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-india2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-inv"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-issuereview"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-lay"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-loadwarn"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-menu"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-mobile-bottom-bar"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-name2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-naming"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-nfix"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-notif-deeplinks"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-notif-tabs"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-onb"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-onboard"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-phone"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-pkg-flow"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-pkg-ui"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-pm"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-polish-fixes"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-polish3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-pretty-urls"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-profile"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r10"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r2-builder"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r2-capture"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r2-insights"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r2-onboard"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r3-a"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r3-b"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r3-c"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4a"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4b"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4c"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4d"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r4e"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r5"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r6"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r7"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r8"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r8a"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r8b"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r8c"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r9"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r9a"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r9b"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r9c"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-r9d"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-render"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-render2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-render3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-render4"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-render5"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-round"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-safehtml"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-saved-filters"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-scan"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-sess"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-sqlreview"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-staff"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-tax"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-terms"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-tmpl"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-toasts"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-toolbar2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-tour"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-tpl"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-trial"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-uae"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-uae2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-ui"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-uploads"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-ux"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v1"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v2"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v3"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v4"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-v6"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-venue4"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-welcome"
git worktree remove "/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-wt"
git worktree remove "/Users/koushikgoudshaganti/security-audit-skill/Helm/run-2/postfix/wt"
git worktree prune
git worktree list | wc -l   # expect 16
```

Do NOT use `--force`, `rm -rf`, or delete `2d view-restored`. Do NOT remove REVIEW worktrees until their work is pushed or confirmed redundant.

## iCloud Desktop sync risk

`Helm/` lives under `~/Desktop`, which is iCloud-synced on this Mac. iCloud previously offloaded/emptied local files (see the earlier wipe-and-restore incident). Risks:

- iCloud can evict ("optimize storage") files inside `.git` or worktrees, corrupting repos or making `git worktree remove` fail mid-way.
- ~10 GB of worktrees (mostly `node_modules`) wastes iCloud quota and sync bandwidth.
- Deletions sync: removing a worktree on this Mac also removes it from iCloud and other devices.

Recommendations: before cleanup, confirm everything important is pushed to GitHub (koushik1133/Helm); keep iCloud Desktop sync paused while working; longer term, move the repo out of `~/Desktop` (e.g. `~/Code/Helm`) and recreate worktrees with `git worktree add` there.
