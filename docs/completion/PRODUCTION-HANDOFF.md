# PRODUCTION HANDOFF (§14)

# ⚠️ PREPARED — NOT AUTHORIZED FOR EXECUTION ⚠️

**This document is a plan. Nothing in it has been run against production by the author.**
No production remote was fetched, pushed, or mutated in preparing it. Every step below
is to be executed by an authorized human operator, in order, only after explicit
go-ahead. Production Supabase project: `nqltzgiwznphugcfhmbm`. Live site:
`www.helm.events` (served via Vercel static hosting from the production repo
`praneethreddykiwik/Helm` — see `CUSTOMER-FRONTEND-PARITY.md`, this is the parity risk).

Sources this plan is built from: `docs/RUNBOOK.md` (OBS-01 monitoring) and
`supabase/prod-rollout/README-RUNBOOK.md` (Wave 15B + Wave 16 DB bundle).

> **Session-observed state:** the Wave 15B + Wave 16 production DB bundle
> (`PROD-00`/`PROD-01`/`PROD-02`) was reported earlier in the program as VERIFY
> **all-PASS on production**. **Regardless of that report, running any further DB apply
> against production is FORBIDDEN from this planning context.** If a re-apply is ever
> needed, an authorized operator does it manually per the steps below; the bundle is
> idempotent and safe to re-run, but that is the operator's decision, not this doc's.

---

## 0. Production prerequisites (must all be true before anything runs)

- [ ] Authorized operator with production Supabase dashboard + Vercel project access.
- [ ] Explicit written go-ahead to deploy (this doc does not constitute it).
- [ ] Confirmed which repo/branch Vercel's production deployment tracks (expected:
      `praneethreddykiwik/Helm` @ `main`). **See parity doc — frontend hardening is NOT
      yet on that repo.** Resolve parity BEFORE or AS PART OF this deploy.
- [ ] `public/config.js` on the branch being deployed has `liveChannels.pay = false`,
      `liveChannels.whatsapp = false`, `sms = false` (verified: current source has all
      three false). CI guard `check-deferred-integrations` must pass.
- [ ] Production Supabase URL/anon key in the deployed `config.js` match the prod
      project (hostname-routed config; confirm no staging ref leaks to prod host).
- [ ] `role_access` matrix configured in prod **Control Center** (it is DATA, not in the
      SQL bundle) if prod needs the same role layout.
- [ ] Maintenance window agreed; someone on call for the smoke + monitoring window.

## 1. Backup requirement (HARD GATE — do not skip)

- [ ] Supabase dashboard → Database → **Backups** → take (or confirm today's) snapshot.
- [ ] Free-tier fallback if snapshots unavailable: export affected tables `quotes`,
      `quote_payments`, `inventory_items` (or upgrade tier first).
- [ ] Record the snapshot ID / timestamp in the deploy ticket. **No apply proceeds
      without a confirmed restore point** — the DB steps are hard to reverse.

## 2. Frontend deployment order (Vercel static)

1. Ensure the production-tracked repo/branch contains the Wave-16 frontend hardening
   (validators, global number hardener in `public/store-api.js`, RBAC button map, a11y,
   `config.js`). If it does not, execute `CUSTOMER-FRONTEND-PARITY.md` first.
2. Merge/deploy the branch to Vercel production. `vercel.json` is authoritative:
   `outputDirectory: public`, `cleanUrls: true`, security headers + CSP, `/i/:slug*`
   rewrite, `/signup` redirect. No build step (`framework: null`).
3. Vercel produces a preview/immutable deployment first — verify on the preview URL,
   then promote to production domain.
4. Frontend and DB should land close together; deploy frontend that is compatible with
   the DB state. The Wave-16 client code tolerates the pre/post DB state (additive), but
   confirm order with the operator.

## 3. DB migration order (operator-run; FORBIDDEN from here)

Per `supabase/prod-rollout/README-RUNBOOK.md`. All statements are additive & idempotent
(CREATE OR REPLACE / IF NOT EXISTS), applied + verified on staging first.

1. **Backup** (section 1 above) — gate.
2. **`supabase/prod-rollout/PROD-00-PRECHECK.sql`** — read-only; shows blocker counts.
   Negative inventory is fine (PROD-01 auto-clamps). Only a non-zero
   `quote_payments.amount <= 0` count needs a manual look.
3. **`supabase/prod-rollout/PROD-01-APPLY.sql`** — paste + run the whole file. Idempotent,
   safe to re-run after partial failure. Applies W15B-01/04/05/06 + W16-02 (manager
   create/settle/close) + W16-03/04 (overpayment guard on both payment tables), clamps
   negative inventory to 0, adds W16-01 CHECK constraints (skips the payments one only if
   amount<=0 rows exist). SQL editor shows only the last statement's output — expected.
4. **`supabase/prod-rollout/PROD-02-VERIFY.sql`** — single result set; every row must read
   **PASS** (payments-CHECK row may read SKIPPED if amount<=0 rows exist). Does not abort.
5. Cross-reference: Wave 15B remediation detail in `docs/WAVE-15B-REMEDIATION.md`; the
   `role_access` matrix is configured separately in Control Center (not in this bundle).

## 4. Verification order

1. `PROD-02-VERIFY.sql` all rows PASS (or documented SKIPPED).
2. Frontend preview verified before promotion (section 2.3).
3. Post-promotion smoke tests (section 6).
4. Monitoring checks live (section 7) before declaring done.

## 5. Rollback conditions & procedure

**Roll back if:** VERIFY shows any unexpected FAIL; overpayment guard blocks legitimate
payments; managers cannot create/settle/close when they should; client approval flow
breaks; client error-rate spike correlates with the deploy; any cross-tenant data
visibility observed (STOP immediately, treat as incident).

**Procedure:**
- Frontend: Vercel → Deployments → promote the previous known-good deployment (instant).
- DB functions: CREATE OR REPLACE — re-apply the prior definition from git history.
  - Pricing authority: `supabase/wave15b/W15B-03-ROLLBACK.sql`.
  - Manager authority: re-apply pre-W16-02 `can_create`/`can_edit` (remove `'manager'`).
  - Overpayment/constraints: `drop trigger trg_no_overpayment on public.quote_payments;`
    and `alter table … drop constraint inventory_items_total_qty_nonneg;` (+ the 3 W16-01
    checks) as needed.
- Last resort: restore from the section-1 snapshot (data loss window = since snapshot).

## 6. Smoke tests (NON-MUTATING first, then guarded)

Non-mutating (run first, safe):
- [ ] Load `www.helm.events` — landing + login render, no console errors.
- [ ] Auth loads; a known account can reach the dashboard (read-only browse).
- [ ] Open a quote/quotes list — pricing displays; RBAC hides controls for a
      view-only role (button map applied).
- [ ] Client approval page loads for an existing approval token (do not submit).

Guarded mutating (only in the agreed window, with test/known data):
- [ ] Create a quote; record a **valid** payment → succeeds.
- [ ] Attempt an **overpayment** → blocked by guard.
- [ ] Confirm a client approval still completes.
- [ ] Manager role can create/settle/close per W16-02.

## 7. Monitoring checks (per `docs/RUNBOOK.md` — OBS-01)

- [ ] Telemetry is **code-ready, NOT live** until a DSN is injected. If enabling: serve
      `window.HELM_TELEMETRY = { dsn, env:'production', release }` before `telemetry.js`;
      do NOT commit the DSN. It redacts JWTs/tokens/OTP/emails/phones and sends path only.
- [ ] Watch: client JS error/rejection rate; Supabase 4xx/5xx (auth/RLS/function);
      `request_otp` returning `delivery:'unavailable'` (means no SMS provider — approval
      down, not bypassed); payment anomalies (duplicate receipts, rising idempotent-replay);
      sustained login failures.
- [ ] **Confirm `liveChannels` remain `false` for Razorpay/WhatsApp** (must stay deferred).
- [ ] Confirm no unexpected anon activity on `layouts`/RPCs (RLS should deny — phase89).
- Known gaps (setup, not code): no uptime monitor/alert routing yet (add external monitor
  on the deployed URL); no structured server logs (static site) — rely on browser error
  reporter + Supabase logs.
