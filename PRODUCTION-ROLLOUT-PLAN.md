# PRODUCTION ROLLOUT PLAN — canonical forward migrations (0001–0014)

**Target:** production Supabase `nqltzgiwznphugcfhmbm`.
**Scope:** apply the sanctioned, forward-only, additive + idempotent hardening
migrations `supabase/migrations/0001_*.sql … 0014_*.sql` (order fixed by
`supabase/migrations/MANIFEST`) onto the existing prod schema, then deploy edge
functions and the Vercel front-end.

> ⛔ **DO NOT EXECUTE ANY STEP IN THIS FILE WITHOUT EXPLICIT OPERATOR APPROVAL.**
> Claude/agents do **not** run anything against production. This is a written
> runbook the operator executes by hand. **STOP before every apply step** and
> confirm the preceding verify step passed. The forward migrations are
> additive + idempotent (CREATE OR REPLACE / IF NOT EXISTS / guarded `do $$`),
> but they are still hard to fully reverse — a snapshot is mandatory first.

Guardrail (project memory, TOP PRIORITY): never run anything that can delete,
overwrite, corrupt, or cross-tenant-expose data. Every migration here is
additive + idempotent by design; if any step would not be, STOP and escalate.

---

## Step 0 — SNAPSHOT / PITR FIRST  ⟵ mandatory, before anything
- Supabase dashboard → Database → **Backups** → take (or confirm today's)
  snapshot; confirm **PITR** is enabled and note the restore window.
- If snapshots are unavailable on the current plan, export `quotes`,
  `quote_payments`, `inventory_items`, `profiles`, `work_tokens` (at minimum)
  or upgrade first.
- **Rollback for this step:** n/a — this *is* the rollback anchor for all later
  steps. Do not proceed until a restorable snapshot exists.

## Step 1 — RUN `supabase/PRODUCTION-PRECHECK.sql` + RECORD  (READ-ONLY)
- Paste the whole file into the prod SQL editor (ref `nqltzgiwznphugcfhmbm`).
- It is strictly read-only (SELECT / catalog reads only). Capture **every**
  result set (Q01–Q14) into the release record.
- Blocking findings to resolve BEFORE any apply:
  - Q09b > 0 public tables with RLS off that are not expected deny-all.
  - Q10b anon-executable SECURITY DEFINER set not equal to the sanctioned list.
  - Q11 unexpected functions with mutable `search_path`.
  - Q13c `quote_payments.amount <= 0` > 0 (manual look — a money CHECK may skip
    or fail). Q13a/Q13b/Q13f orphan org_id rows > 0 (tenant integrity).
  - Q12 any bucket with `public=true`.
- **Rollback:** none needed (nothing was written).
- **STOP** — review results with the operator before Step 2.

## Step 2 — RECONCILE PROD'S HISTORICAL phaseNN LINEAGE vs CANONICAL 0001–0014
- Prod was built incrementally via ad-hoc `phaseNN` / `wave*` SQL (see project
  memory: wave5, phase97/98, phase99 D8 server-pricing authority already APPLIED
  to prod; Wave 15B + Wave 16 bundle in `supabase/prod-rollout/` prepared).
- The canonical forwards are written to be **idempotent**: objects already
  present in prod from those historical phases are simply re-asserted
  (CREATE OR REPLACE / IF NOT EXISTS / `on conflict do update`), not duplicated.
- Using Q03 (ledger — expected EMPTY on prod, since prod never ran the canonical
  runner) and Q04/Q05/Q06/Q10b/Q11/Q12, map each forward migration to what prod
  already has. Likely-already-present per memory:
  - `0001_pricing_authority` — phase99 D8 server pricing authority applied.
  - `0003_money_integrity` / overpayment guards — Wave 16 (W16-03/04) prepared/applied.
  - `0004_tenant_integrity` — multitenant org_id NOT NULL (phase60) + isolation.
  - storage `0013` — phase88 invite-media; phase87 event sites.
- Record, per forward file, "already present / will no-op" vs "new". This does
  not change behavior — idempotency means re-asserting is safe — but it tells the
  operator what to expect from `applied=N`.
- **Rollback:** none (analysis only). **STOP** — get sign-off on the reconciliation.

## Step 3 — APPLY FORWARD MIGRATIONS via the guarded runner, REPOINTED TO PROD
- The staging runner (`scripts/staging/apply-canonical.sh`) **hard-refuses the
  prod ref** by design (`_common.sh` `require_ref`). To run against prod you must
  use the sanctioned prod path — do **not** edit the staging guard. Options:
  1. A dedicated prod runner that applies ONLY MANIFEST `forward` entries in
     order, each inside its own transaction, recording sha256 in
     `public.helm_schema_migrations`, refusing a FRESH DB (base-v1 is never
     applied to an existing prod), and refusing sha drift; OR
  2. Paste each `0001…0014` file **in MANIFEST order** into the prod SQL editor,
     one at a time, confirming success before the next, then insert the ledger
     row manually.
- Order is exactly MANIFEST lines 16–29 (0001 → 0014). The `base` line is
  **skipped** on an existing prod DB.
- After each file: expect success with no destructive notices. Because every
  file is idempotent, a partial failure can be fixed and the file re-run.
- **Rollback per step:**
  - Functions are CREATE OR REPLACE → revert by re-applying the prior definition
    from git history (e.g. `supabase/wave15b/W15B-03-ROLLBACK.sql` reverts the
    pricing-authority fn).
  - Triggers/constraints added → `drop trigger …` / `alter table … drop
    constraint …` for the specific object.
  - RLS/grants (0005/0006/0013) → re-apply prior grant/policy from git.
  - Catastrophic → restore the Step 0 snapshot / PITR.
- **STOP** between files if any emits an unexpected error.

## Step 4 — SECOND IDEMPOTENT PASS (no-op proof)
- Re-run the apply (runner or re-paste). It MUST report `applied=0` (all forward
  entries already recorded with matching sha256; every CREATE/INSERT no-ops).
- A non-zero `applied` on the second pass, or any sha **drift** error, means a
  migration file changed after being recorded → STOP, do not force, investigate.
- **Rollback:** none (idempotent no-op). **STOP** if applied≠0.

## Step 5 — VERIFY (read-only)
- Re-run `supabase/PRODUCTION-PRECHECK.sql` and confirm the hardened target:
  Q04 all functions present; Q05 every guard present≥1; Q06 both work_tokens
  columns; Q09b = 0 unexpected RLS-off tables; Q10b = sanctioned anon set only;
  Q11 no unexpected mutable search_path; Q12 both buckets private with allowlist;
  Q13* all 0 (or justified). Optionally run the contract-coverage checks from
  `scripts/staging/verify.sh` logic (RPC + table contract) against prod read-only.
- **Rollback:** none (read-only). **STOP** — operator signs off before deploy.

## Step 6 — EDGE FUNCTION DEPLOY
- Deploy edge functions to prod (see `scripts/staging/deploy-edge.sh` for the
  set + secret inventory): `send-otp`, `send-whatsapp`, `create-payment-link`,
  and **`razorpay-webhook` with `--no-verify-jwt`** (it authenticates via HMAC
  `x-razorpay-signature`, not a JWT — without the flag a real webhook 401s before
  reaching the function):
  `supabase functions deploy razorpay-webhook --project-ref nqltzgiwznphugcfhmbm --no-verify-jwt`
  The other three deploy without the flag.
- Set required secrets first (never logged): `RAZORPAY_WEBHOOK_SECRET` (required
  for razorpay-webhook) + optional Resend/MSG91/manager vars per the inventory.
- Deferred integrations (Google OAuth, MSG91 SMS/OTP, Razorpay, WhatsApp) stay
  **fail-closed / dormant** until secrets + feature flag are intentionally flipped.
- **Rollback:** redeploy the previous function version from git; unset the flag/
  secret to return the integration to its dormant fail-closed state.
- **STOP** — smoke the webhook with a test signature before flipping any flag.

## Step 7 — VERCEL PRODUCTION (front-end static)
- Deploy the vanilla HTML/JS front-end to Vercel production (product stays
  vanilla — no React, per memory). This bundle is otherwise DB-only; client-side
  validators / input hardener / RBAC button map ship here.
- **Rollback:** Vercel → promote the previous production deployment (instant
  rollback); the static front-end carries no data migration.

## Step 8 — LIVE SMOKE
- Create a quote; record a valid payment; attempt an overpayment (must be
  BLOCKED); confirm a client approval + an OTP flow still work; confirm invite
  media is private (no public read). Confirm Control Center `role_access` matrix
  is configured for prod (data, not in this bundle).

---

### Reference
- Apply order: `supabase/migrations/MANIFEST` (base skipped on existing prod).
- Migrations: `supabase/migrations/0001_*.sql … 0014_*.sql`.
- Precheck: `supabase/PRODUCTION-PRECHECK.sql` (read-only).
- Staging precedent: applied + verified on `xizehqgeyjcfpzrdymly` first
  (`scripts/staging/{precheck,apply-canonical,verify}.sh`).
- Prior prod bundle (Wave15B+16): `supabase/prod-rollout/` runbook + SQL.

**Every apply step is gated on explicit operator approval. STOP-before-apply.**
