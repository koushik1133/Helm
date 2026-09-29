# CUSTOMER FRONTEND PARITY (§15)

# PRODUCTION PARITY — UNCONFIRMED

## The core risk

Wave-16 client-side hardening (submit-time validators, the global number hardener in
`public/store-api.js`, the RBAC button map, a11y/WCAG pass, and `config.js` env wiring)
was committed and pushed to **`koushik1133/Helm`** (remote `origin`). But
**`www.helm.events` is served (Vercel static) from `praneethreddykiwik/Helm`** (remote
`prod`). If the production deployment tracks the `prod` repo, **none of the Wave-16
frontend hardening is live for customers.**

## What was verified locally (read-only, no fetch/push)

Both remotes are configured and `prod/main` was **already present locally** (previously
fetched), so a read-only git comparison was possible without touching production:

```
origin  https://github.com/koushik1133/Helm.git
prod    https://github.com/praneethreddykiwik/Helm.git
```

Findings:

- **All six Wave-16 commits are absent from `prod/main`.** `git branch -r --contains`
  for each (`d87c096`, `c0c6b21`, `43d0590`, `72b6b7e`, `e6f7ea8`, `e72241e`) returns
  **only** `origin/main` / `origin/HEAD` — never `prod/main`.
- **`prod/main` is a strict ancestor of `origin/main`/HEAD.** Merge-base ==
  `prod/main` tip == `3af5e9f` ("Calendar: guard against malformed event dates").
  `HEAD` is **43 commits ahead of `prod/main`, and `prod/main` is 0 commits ahead** of
  the merge-base. There is **no divergence** — the local `origin` line is a clean
  superset of the local `prod` line.

## Why parity is still UNCONFIRMED (not "confirmed behind")

The git comparison shows the *repos* differ and that origin cleanly supersedes prod.
What could **not** be confirmed from this planning context (production access forbidden):

1. Which repo/branch Vercel's **production** deployment actually tracks.
2. Which **commit** is currently live on `www.helm.events`.
3. Whether the local `prod/main` tracking ref matches the true remote `prod/main` right
   now (it was not re-fetched — fetching prod is forbidden here).

So: the hardening is **provably not in the local `prod/main` snapshot**, but live-site
parity is **UNCONFIRMED** pending an operator confirming (1)–(3).

---

## MINIMAL PATCH PLAN (NO EXECUTION, NO PUSH)

Because `prod/main` is a strict ancestor of `origin/main` with **zero prod-only
commits**, bringing the customer frontend to parity is a **clean fast-forward** — no
merge conflicts, no cherry-pick surgery required in the common case.

### Option A (recommended): fast-forward `prod/main` to `origin/main`

An authorized operator, on their machine with push rights to `praneethreddykiwik/Helm`:

1. Fetch both remotes fresh and re-confirm `prod/main` is still an ancestor of
   `origin/main` (i.e. `git merge-base --is-ancestor prod/main origin/main` succeeds and
   `git rev-list --count origin/main..prod/main` == 0). If prod has since gained its own
   commits, STOP and fall back to Option B.
2. Fast-forward and push: merge `origin/main` into `prod/main` (fast-forward only), push
   to `prod`. This carries **all 43 commits**, including every Wave-16 frontend file.
3. Trigger/allow the Vercel production deploy from the updated `prod` repo.

This is the least-risk path and also delivers Wave 15B and earlier hardening that prod
is missing.

### Option B (surgical): cherry-pick only the frontend hardening

If the operator wants **only** the Wave-16 client hardening (not the 43-commit superset),
cherry-pick these six commits onto `prod/main` in order:

| Order | SHA | Subject |
|---|---|---|
| 1 | `d87c096` | wave16(hardening): app-wide input validation, numeric hardening, RBAC/nav/quote fixes |
| 2 | `72b6b7e` | wave16(hardening): submit-time validation across all money/count/dimension forms + perf + a11y |
| 3 | `43d0590` | wave16(a11y+perf): structural WCAG pass across 27 pages + performance fixes |
| 4 | `c0c6b21` | wave16(product+gate): manager authority, overpayment guard, lost-update lock, lifecycle GREEN |
| 5 | `e6f7ea8` | wave16(fixes+guide): unified overpayment guard, proposal URL validation, guide corrections |
| 6 | `e72241e` | config+tests: wire staging env block + harden e2e lead bootstrap |

**Warning on Option B:** these commits were authored on top of Wave-15B and earlier work
that is also absent from `prod/main`. Cherry-picking onto the older `prod/main` base is
likely to hit conflicts or carry references to functions/DB shape prod does not yet have
(e.g. store-api validators that assume Wave-15B pricing contract). Option A avoids this.

### Exact frontend files carrying Wave-16 hardening

Union of `public/` files changed across the six commits (enumerated via
`git show --stat`):

- **`public/store-api.js`** — global number hardener + validators + overpayment guard +
  proposal URL validation (the central hardening surface; changed in 5 of 6 commits).
- **`public/config.js`** — staging/prod env block wiring (`e72241e`).
- **`public/theme.css`** — a11y/contrast tokens (`c0c6b21`).
- Page files (validators, RBAC button map, a11y attributes, perf):
  `budget.html`, `builder.html`, `calendar.html`, `closure.html`, `command.html`,
  `control.html`, `crm.html`, `dashboard.html`, `discovery.html`, `event.html`,
  `flow.html`, `insights.html`, `inventory.html`, `issues.html`, `leads.html`,
  `logistics.html`, `media.html`, `nurture.html`, `ops.html`, `plan.html`,
  `proposal.html`, `quotes.html`, `ready.html`, `resources.html`, `runsheet.html`,
  `settlement.html`, `staff.html`, `teardown.html`, `vendors.html`.

(Full aggregate diff merge-base→HEAD touches 48 files / +2286 / −1478, which includes
non-Wave-16 changes too; the list above is scoped to the six Wave-16 commits.)

### Dependencies & migration prerequisites

- **DB prerequisite:** the Wave-16 client overpayment/manager-authority behavior is the
  *front* half of server-side guards delivered by the `PROD-01-APPLY.sql` bundle. The
  client code fails safe without the DB changes (server is authoritative), but for
  correct end-to-end behavior the **DB bundle should be applied to prod** (see
  `PRODUCTION-HANDOFF.md` §3) alongside or before the frontend cutover.
- **Config prerequisite:** confirm the deployed `config.js` points at the prod Supabase
  project and keeps `liveChannels` all `false` (deferred integrations stay off).
- **`vercel.json`** must be present on the deployed repo (headers/CSP, `outputDirectory:
  public`, cleanUrls, `/i/:slug*` rewrite). Confirm it exists on `prod` after the cutover.

### Deployment order

1. Operator confirms live-tracking repo/branch + current live commit (resolves the
   UNCONFIRMED items).
2. Apply DB bundle to prod (per handoff §3) — or confirm already applied.
3. Fast-forward `prod/main` to `origin/main` (Option A) or cherry-pick (Option B).
4. Vercel preview deploy → verify → promote to `www.helm.events`.
5. Non-mutating smoke tests (handoff §6), then monitoring (handoff §7).

**No push, cherry-pick, fetch, or deploy was performed in preparing this plan.**
