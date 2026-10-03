# STAGING DEPLOY HANDOFF — one step to unblock the whole certification

I cannot create the Vercel deployment from here: the `vercel` CLI is not installed,
there is no `VERCEL_TOKEN` in this environment, there is no `.vercel` project link, and
I cannot run a Vercel login/OAuth flow or deploy to your account. Deploying is an
outward-facing action that needs **your** Vercel auth. Everything that makes the deploy
*safe* is already done and committed (host routing fails closed, the runtime pre-auth gate
aborts on prod, the staging badge, the regression tests). You just need to produce the
preview URL.

**Safety invariant already guaranteed by committed code:** any `*.vercel.app` host that is
NOT `helm-v01` / `helm-alpha-nine` resolves to the STAGING project
(`xizehqgeyjcfpzrdymly`) or fails closed (blank) — it can NEVER reach production. So a
preview of this branch is staging-wired automatically, with no Vercel env vars needed.

## Do ONE of these (preview only — never `vercel --prod`)

**Option A — Vercel dashboard (no CLI).** In the Vercel project for `koushik1133/Helm`,
ensure the `harden/pre-react-canonical` branch has a Preview deployment (push triggers one
automatically if the Git integration is connected). Copy the generated preview URL, e.g.
`https://helm-git-harden-pre-react-canonical-<scope>.vercel.app`.

**Option B — Vercel CLI (from the repo root), scoped to a preview:**
```bash
npx vercel link          # once, link to the existing Helm project (interactive)
npx vercel deploy         # PREVIEW build — prints a https://…vercel.app URL. Do NOT pass --prod.
```

Either way the result is a non-production `*.vercel.app` URL. Do **not** repoint or modify
`helm-v01.vercel.app`.

## Then paste the preview URL back to me

Reply with just the URL. I will immediately, read-only and before any login:
1. Open it in a browser and read the resolved `window.SUPABASE_CONFIG.url`.
2. Run the hard runtime gate:
   ```bash
   PREVIEW_URL="https://<your-preview-host>" npx playwright test --config playwright.staging.config.mjs --list
   ```
   which aborts unless it prints `[staging-gate] OK — … STAGING (xizehqgeyjcfpzrdymly)`.
3. Fill TARGET 2 in [ENVIRONMENT-ATTESTATION.md](ENVIRONMENT-ATTESTATION.md).

If and only if it resolves to `xizehqgeyjcfpzrdymly` ⇒ `MUTATING TESTS AUTHORIZED = YES`,
and I auto-continue into the full browser certification (Agent Groups A–U) without asking again.

## Prerequisite for the *mutating* tests (not for attestation)

The staging Supabase project must have the canonical schema applied and the
`HARDEN_TEST_` role accounts seeded, or authed specs have nobody to sign in as:
- `scripts/staging/apply-canonical.sh` (canonical forward migrations → staging)
- `scripts/staging/seed-test-data.mjs` (two synthetic tenants + per-role `HARDEN_TEST_` users)
- `scripts/staging/deploy-edge.sh` (edge functions → staging; `razorpay-webhook` with `--no-verify-jwt`)

These need the ephemeral Supabase Management PAT + staging service-role key you supply via
`.staging.env` (gitignored). Tell me when staging is seeded, or I run them once you confirm
the PAT is loaded. Nothing here touches production.
