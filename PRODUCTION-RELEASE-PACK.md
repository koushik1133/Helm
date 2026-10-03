# PRODUCTION-RELEASE-PACK.md

> **STATUS: PREPARED — DO NOT APPLY.** Production requires separate, explicit user
> approval. Nothing in this pack has been run against production
> (`nqltzgiwznphugcfhmbm`). All evidence below is LOCAL PG17 + GitHub CI + Supabase
> STAGING (`xizehqgeyjcfpzrdymly`) + Edge STAGING. No VERCEL staging-preview /
> Playwright evidence yet (blocked on a staging-wired preview URL).

## 1. Final candidate Git SHA
`7a68a16` on `koushik1133/Helm` branch `harden/pre-react-canonical`
(local == remote; GitHub CI + DB-PG17 + CodeQL green on the checkpoints).

## 2. Canonical migrations to apply (forward-only, in order)
From `supabase/migrations/MANIFEST` — apply ONLY these forward entries; NEVER base-v1,
HELM-STAGING-SCHEMA.sql, setup-all, phaseNN, wave, security-fix, prod-fix, or
harden-2026-10 bundles against the existing production DB.

| # | file | purpose | sha256 (recorded in staging ledger) |
|---|------|---------|------|
| 0001 | pricing_authority.sql | fail-closed server pricing recompute | 3985106e5538 |
| 0002 | create_helm_user_lockdown.sql | SEC-01 revoke create_helm_user from anon/auth | 2c912bd2d42c |
| 0003 | money_integrity.sql | ledger-only paid + no-overpayment (advisory lock) | f59b2236776d |
| 0004 | tenant_integrity.sql | zz_quote_org_match (SECURITY DEFINER) tenant guard | d14422ef888c |
| 0005 | least_privilege.sql | revoke PUBLIC/anon on functions; allowlist re-grant | 573f58be82b1 |
| 0006 | rls_access_gates.sql | SEC-02/03/04 RLS (layouts/profiles/coupons) | 2b347572591c |
| 0007 | rpc_authz_guards.sql | mark_paid admin/mgr; record_payment finance; F10 | b681616fe314 |
| 0008 | feature_designer.sql | Design Studio + designer role (+role CHECK widen) | e8abe2703a8a |
| 0009 | feature_tasks_files.sql | my_tasks/my_pending/event_files + storage policy | df3e103a2e74 |
| 0010 | feature_settlement_teardown.sql | settlement/return/invitation_preview | bf167acc4a72 |
| 0011 | authz_complete.sql | has_area on setters + create/convert guards | adb7ff9c3820 |
| 0012 | token_otp_hardening.sql | approval+worker token expiry/revoke + OTP caps | 4ddd5269cea8 |
| 0013 | storage_hardening.sql | invite-media/event-docs private + MIME/size | 977a0a7f7604 |

Apply via the same guarded runner, repointed at production ONLY after approval:
`scripts/staging/apply-canonical.sh` (ref hard-check must be changed to the prod ref
deliberately, with a fresh precheck first). Second run must report `applied=0`.

## 3. Production READ-ONLY precheck (run FIRST, no writes)
- Confirm PG 17, table/function counts, and whether `public.helm_schema_migrations`
  exists (prod likely has NONE of 0001–0013 via this canonical path yet — verify).
- Diff prod's current objects vs the hardened set (triggers zz_enforce_pricing_total,
  trg_no_overpayment[_ms], zz_quote_org_match, zz_approval_token_expiry,
  zz_otp_rate_limit, zz_work_token_renew; function _work_token_live;
  work_tokens.revoked_at/expires_at; buckets invite-media/event-docs private).
- NOTE: production may already carry some equivalents from historical phase/wave/
  prod-fix applies (see memory `prod-db-hardening-status`). The forward migrations are
  idempotent (CREATE OR REPLACE / IF NOT EXISTS / additive), so re-applying is safe,
  but the precheck MUST confirm no column/constraint conflict before apply.

## 4. Expected DB changes / row & object impact
- DDL only (functions, triggers, policies, 2 columns on work_tokens, bucket config).
- No destructive statements; no row deletes; `helm_total_paid` becomes ledger-derived.
- role_access: production orgs already have their matrices — migrations do NOT seed
  role_access (only the staging test factory did). Zero row impact to tenant data.
- Estimated changed objects: ~13 migrations × (functions/triggers/policies); 2 new
  columns; 2 bucket rows upserted. No table drops, no data backfill except
  `work_tokens.expires_at` backfill (0012) for existing NULLs (additive).

## 5. Edge Functions to deploy (production, after approval)
send-otp, send-whatsapp, create-payment-link, razorpay-webhook.
- **razorpay-webhook MUST deploy with `--no-verify-jwt`** (HMAC-authenticated; a JWT
  gate 401s real Razorpay calls). The other three keep JWT verification.
- Use `scripts/staging/deploy-edge.sh` logic (now encodes the webhook flag), repointed
  to prod after approval.

## 6. Vercel candidate
Static frontend at `7a68a16`. Production alias (`helm-v01.vercel.app`) is already
prod-wired (config.js → prod ref). The committed `config.js` preview-routing change is
prod-safe (prod hosts matched first, byte-identical). No production Vercel deploy
without approval.

## 7. Required environment variables (prod)
- Frontend: none at build (anon key is public in config.js).
- Edge (prod secrets, set by NAME via `supabase secrets set`, values never logged):
  MSG91_AUTHKEY/SENDER/OTP_TEMPLATE_ID (send-otp); WHATSAPP_TOKEN/PHONE_ID
  (send-whatsapp); RAZORPAY_KEY_ID/KEY_SECRET (create-payment-link);
  RAZORPAY_WEBHOOK_SECRET (razorpay-webhook); optional RESEND_*/MANAGER_* /MSG91 for
  webhook notifications. SUPABASE_URL/SERVICE_ROLE_KEY are platform-injected.

## 8. Secrets checklist
- [ ] Razorpay LIVE keys + webhook secret (prod) provisioned and set by name.
- [ ] MSG91 + WhatsApp prod credentials set (or left unset = simulated, if intended).
- [ ] No secret present in source, config.js, logs, or this repo.

## 9. Backup assumptions / rollback
- **Backup NOT verified** by this program (no prod restore drill run — see
  `docs/STAGING-OBSERVABILITY.md`). Take a fresh Supabase PITR/snapshot immediately
  before apply and confirm it completed.
- Rollback: migrations are additive; to revert, drop the added triggers/functions/
  columns via a reverse script (to be written per-object) OR restore the pre-apply
  snapshot. Edge: redeploy the previous function versions. Vercel: promote the prior
  production deployment.

## 10. Post-deploy smoke suite (prod, read-mostly)
- `verify.sh` (repointed, read-only): 80/80 RPC, 56/56 tables, hardened objects present.
- A single real login + dashboard load; one quote read; one OTP request in a controlled
  test; one webhook test-signature to a throwaway quote (no settlement).

## 11. Production verification suite
- The staging runtime suites (authz/tenant/token/payment/storage/edge/redteam) can be
  repointed read-mostly at prod with a dedicated prod test org — ONLY with approval and
  a cleanup guarantee. Prefer running destructive/write probes on staging only.

## Evidence ceiling (honest)
Production readiness stays capped until a prod precheck + (optional) canary verify runs.
This pack is the gate artifact; it does not itself raise production-readiness scores.
