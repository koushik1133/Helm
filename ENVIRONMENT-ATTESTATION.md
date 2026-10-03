# ENVIRONMENT ATTESTATION — Helm staging certification

**Purpose.** This is the hard gate that decides whether *mutating* browser tests may
run. `MUTATING TESTS AUTHORIZED` is **YES only when** `SUPABASE PROJECT REF ==
xizehqgeyjcfpzrdymly` **and** `CLASSIFICATION == STAGING`, verified **at runtime**
(the resolved `window.SUPABASE_CONFIG.url` and the actual Auth/REST/Storage/Edge
requests the browser makes), not from source. Anything else ⇒ STOP (read-only only).

- Repository: `koushik1133/Helm`
- Branch: `harden/pre-react-canonical`
- Production Supabase ref (must NEVER be the target of a mutating test): `nqltzgiwznphugcfhmbm`
- Staging Supabase ref (the ONLY ref that authorizes mutation): `xizehqgeyjcfpzrdymly`

The automated enforcement of this gate lives in two places and both are now wired into
CI / the test suite:
- Unit (no browser): [`test/config-router.test.mjs`](test/config-router.test.mjs) +
  [`tests/staging/env-routing.test.mjs`](tests/staging/env-routing.test.mjs) — prove the
  host→project routing fails closed (prod host→prod, any other `*.vercel.app`→staging-or-blank,
  unknown→blank, localhost→staging-or-blank; **a preview host can never reach prod** under any
  opt-in). Run by `npm test`.
- Runtime (real browser, pre-auth): [`tests/staging/global-setup.staging.mjs`](tests/staging/global-setup.staging.mjs)
  — opens `PREVIEW_URL`, reads the resolved Supabase ref, **aborts the entire Playwright run**
  unless it is the staging ref and never the prod ref, and watches early network traffic for any
  prod hit. No test can execute against a mis-wired preview.

---

## TARGET 1 — production reference host (runtime-verified; DO NOT mutate)

| Field | Value |
|---|---|
| TARGET URL | `https://helm-v01.vercel.app/` |
| VERCEL DEPLOYMENT | production alias (unchanged, must stay production-wired) |
| GIT SHA | n/a (live production alias) |
| SUPABASE URL | `https://nqltzgiwznphugcfhmbm.supabase.co` |
| SUPABASE PROJECT REF | `nqltzgiwznphugcfhmbm` |
| AUTH ENDPOINT | `https://nqltzgiwznphugcfhmbm.supabase.co/auth/v1/*` |
| REST ENDPOINT | `https://nqltzgiwznphugcfhmbm.supabase.co/rest/v1/*` |
| STORAGE ENDPOINT | `https://nqltzgiwznphugcfhmbm.supabase.co/storage/v1/*` |
| EDGE ENDPOINT | `https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/*` |
| CLASSIFICATION | **PRODUCTION** |
| MUTATING TESTS AUTHORIZED | **NO** |

**Evidence (BROWSER-VERIFIED, runtime, read-only).** Loading `helm-v01.vercel.app/login`
and reading the frontend's own resolved config returned:
`{ host: "helm-v01.vercel.app", resolvedRef: "nqltzgiwznphugcfhmbm",
resolvedSupabaseUrl: "https://nqltzgiwznphugcfhmbm.supabase.co", classification: "PRODUCTION" }`.
This host is in `PROD_HOSTS` and is matched first in `config.js`, so it returns early and binds
to the production project. It must remain production-wired and is **out of scope** for any
login, write, upload, OTP, payment, delete, seed, load, or DAST action.

---

## TARGET 2 — staging preview host (fill at deploy time)

> Fill this block from a **real browser** against the new `helm-staging-*.vercel.app`
> preview, BEFORE authenticating. Do not copy from source. If any endpoint below shows
> `nqltzgiwznphugcfhmbm`, set CLASSIFICATION=PRODUCTION, MUTATING TESTS AUTHORIZED=NO, and STOP.

| Field | Value |
|---|---|
| TARGET URL | `<PENDING DEPLOY — https://helm-staging-*.vercel.app/>` |
| VERCEL DEPLOYMENT | `<preview deployment id / alias>` |
| GIT SHA | `<HEAD of harden/pre-react-canonical at deploy>` |
| SUPABASE URL | `<expect https://xizehqgeyjcfpzrdymly.supabase.co>` |
| SUPABASE PROJECT REF | `<expect xizehqgeyjcfpzrdymly>` |
| AUTH ENDPOINT | `<expect …xizehqgeyjcfpzrdymly….supabase.co/auth/v1/*>` |
| REST ENDPOINT | `<expect …/rest/v1/*>` |
| STORAGE ENDPOINT | `<expect …/storage/v1/*>` |
| EDGE ENDPOINT | `<expect …/functions/v1/*>` |
| CLASSIFICATION | `<STAGING only if ref == xizehqgeyjcfpzrdymly>` |
| MUTATING TESTS AUTHORIZED | `<YES only if CLASSIFICATION==STAGING AND ref==xizehqgeyjcfpzrdymly>` |

**How to capture (read-only, no credentials, no tokens):**
```
PREVIEW_URL="https://<the-new-preview-host>"
# resolved frontend config (what the app will actually talk to):
#   open PREVIEW_URL in a browser and read:
#   JSON.stringify({host:location.hostname, url:window.SUPABASE_CONFIG.url,
#                   staging:!!window.SUPABASE_CONFIG.__staging})
# then run the hard runtime gate (aborts if it is not staging):
PREVIEW_URL="$PREVIEW_URL" npx playwright test --config playwright.staging.config.mjs --list
```
The `--list` run triggers `global-setup.staging.mjs`, which performs the runtime
ref assertion and prints `[staging-gate] OK — … resolves to STAGING (xizehqgeyjcfpzrdymly)`
or aborts. Only a printed OK flips this block to STAGING / YES.

---

## DECISION

- Mutating browser certification (Agent Groups A–U) is **BLOCKED** until TARGET 2 is
  filled with `CLASSIFICATION == STAGING` and `MUTATING TESTS AUTHORIZED == YES`.
- Production (`helm-v01` / `nqltzgiwznphugcfhmbm`) is untouched and stays read-only.
