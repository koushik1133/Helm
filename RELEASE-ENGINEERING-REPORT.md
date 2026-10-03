# Release Engineering / Supply-Chain Report — Helm (Agent J)

Date: 2026-10-02 · Repo: koushik1133/Helm · Working copy: `2d view-restored` · Scope: READ-ONLY (no pushes, no repo/settings changes)

Evidence legend: **[V]** verified by command this run · **[F]** read from a committed file · **[R]** recommendation only (not applied).

---

## 1. Build & dependency verification

| Check | Result | Evidence |
|---|---|---|
| `npm ci` clean | **PASS** — "added 14 packages, and audited 15 packages"; "found 0 vulnerabilities"; exit 0 | [V] |
| `npm audit` | **0 vulnerabilities** — critical 0 / high 0 / moderate 0 / low 0 / info 0 | [V] `npm audit --json` |
| Lockfile committed | **YES** — `package-lock.json` tracked (git ls-files) and present; `deno.lock` also tracked | [V] |
| Dependency count | 14 packages total (10 prod / 5 dev per audit metadata; tree has 14 resolved nodes) | [V] |
| Engines | `node >=18` (CI runs Node 20) | [F] |

### Dependency inventory [V]
Direct dependencies (3):
- `@supabase/supabase-js@2.117.2` (prod) — only runtime dependency.
- `@axe-core/playwright@4.13.0` (dev) — a11y testing.
- `@playwright/test@1.63.0` (dev) — E2E runner.

Transitive (resolved): `@supabase/{auth-js,functions-js,postgrest-js,realtime-js,storage-js}@2.117.2`, `@supabase/phoenix@0.4.5`, `iceberg-js@0.8.1`, `tslib@2.8.1`, `axe-core@4.13.0`, `playwright@1.63.0`, `playwright-core@1.63.0`. One UNMET OPTIONAL dependency: `@opentelemetry/api` (optional, benign — not required).

**Unnecessary deps:** none identified. The tree is lean; the single prod dep is the Supabase SDK the app relies on. No duplicate/competing libraries observed.

---

## 2. GitHub Actions pin status

**All actions use floating major-version tags — 0 are pinned to a commit SHA.** This is the one notable supply-chain gap: a floating tag can be force-moved by a compromised upstream.

| Action | Version used | Pinned to SHA? | Workflow(s) | Flag |
|---|---|---|---|---|
| actions/checkout | `@v4` | No (floating) | all 6 workflows | **FLOATING** |
| actions/setup-node | `@v4` | No (floating) | ci, codeql-adjacent, db-canonical, db-tests, e2e, lighthouse (5 files) | **FLOATING** |
| gitleaks/gitleaks-action | `@v2` | No (floating) | ci.yml | **FLOATING** (3rd-party — highest risk) |
| github/codeql-action/init | `@v3` | No (floating) | codeql.yml | **FLOATING** |
| github/codeql-action/analyze | `@v3` | No (floating) | codeql.yml | **FLOATING** |
| actions/upload-artifact | `@v4` | No (floating) | e2e.yml | **FLOATING** |

**Floating (unpinned) action references: 6 of 6 distinct actions (100%).** [V]

**[R] Recommendation:** pin each to a full 40-char commit SHA with a trailing version comment, e.g. `uses: actions/checkout@<sha> # v4.x`. Prioritize the third-party `gitleaks/gitleaks-action@v2` (non-GitHub-owned). Consider Dependabot for `github-actions` to keep pins current.

---

## 3. CI gate inventory [F — read from `.github/workflows/*.yml`]

| Required gate | Present? | Where |
|---|---|---|
| base-immutable check | **YES** — `scripts/check-base-immutable.mjs` (via `npm run ci` / `ci-check`); script present | ci.yml + package.json `ci` |
| canonical-migration-drift | **YES** — `check-migration-canon.mjs` step + dedicated `db-canonical-pg17.yml` (PG17 fresh+idempotent install) | ci.yml, db-canonical-pg17.yml |
| CSP generation / no unsafe-inline | **YES** — `gen-csp.mjs --check` step | ci.yml |
| JWT-role check | **YES** — `check-jwt-roles.mjs` step ("no service_role / non-anon JWT") | ci.yml |
| OTP-safety check | **YES** — `check-otp-safety.mjs` step | ci.yml |
| gitleaks (secret scan) | **YES** — `gitleaks/gitleaks-action@v2`, fetch-depth 0; `.gitleaks.toml` present | ci.yml |
| CodeQL | **YES** — init+analyze (javascript-typescript), push/PR + weekly cron | codeql.yml |

All 7 required gates are present and wired. Scripts confirmed on disk: `check-base-immutable.mjs`, `check-migration-canon.mjs`, `gen-csp.mjs`, `check-jwt-roles.mjs`, `check-otp-safety.mjs`, `ci-check.mjs`. Additional gates also present: dependency audit (`npm audit --audit-level=high`), deploy-static containment, deferred-integrations-disabled, env-separation, full `npm test` suite, local-API health. Gated/optional workflows: `e2e.yml` (Playwright/staging, self-skips without secrets), `db-tests.yml` (staging-only, refuses prod, self-skips), `lighthouse.yml` (budgets blocking).

---

## 4. SBOM

**Status: GENERATED [V].** CycloneDX JSON written to `sbom.json` (spec 1.6, 14 components) via:

```
npx --yes @cyclonedx/cyclonedx-npm --output-format JSON --output-file sbom.json
```

(Regenerate after dependency changes. Tooling is not committed as a dep — invoked via npx, consistent with repo's zero-extra-dependency posture.)

---

## 5. Branch-protection status (current) [V]

Branch-protection API **is accessible** with the current `gh` token (account koushik1133). Current state:

- `main` → **NOT protected** (`HTTP 404 "Branch not protected"`).
- `harden/pre-react-canonical` → **NOT protected** (`HTTP 404 "Branch not protected"`). (Branch exists on remote.)

So protection is readable, not permission-gated — and neither target branch currently has any protection rule.

---

## 6. Recommended branch-protection settings [R — RECOMMENDATIONS ONLY, NOT APPLIED]

Apply to **`main`** and **`harden/pre-react-canonical`**:

- **Require status checks to pass before merging** + **require branches up to date**. Required checks (use exact job/check names as they report):
  - `CI` → `check` (ci.yml)
  - `DB canonical (PostgreSQL 17)` → `db-canonical` (db-canonical-pg17.yml)
  - `CodeQL` → `Analyze (javascript-typescript)` (codeql.yml)
- **Require a pull request before merging**, with **at least 1 approving review**; **dismiss stale approvals** on new commits; require review of most recent push.
- **Do not allow force pushes** (`allow_force_pushes: false`).
- **Do not allow deletions** (`allow_deletions: false`).
- **Require conversation resolution** before merge.
- **Include administrators** (`enforce_admins: true`) so the rules bind everyone.
- (Optional) require linear history; require signed commits.

Do **not** mark `e2e`, `db-tests` (staging-gated, secret-dependent, intentionally red until pending fixes land per db-tests.yml header), or `lighthouse` as *required* checks on protected branches — they self-skip or depend on secrets forks lack.

Example (owner runs manually — NOT executed here):
```
gh api -X PUT repos/koushik1133/Helm/branches/main/protection \
  -f 'required_status_checks[strict]=true' \
  -f 'required_status_checks[checks][][context]=check' \
  -f 'required_status_checks[checks][][context]=db-canonical' \
  -f 'required_status_checks[checks][][context]=Analyze (javascript-typescript)' \
  -F 'enforce_admins=true' \
  -F 'required_pull_request_reviews[required_approving_review_count]=1' \
  -F 'required_pull_request_reviews[dismiss_stale_reviews]=true' \
  -F 'restrictions=' \
  -F 'allow_force_pushes=false' -F 'allow_deletions=false' \
  -F 'required_conversation_resolution=true'
```

---

## Summary
npm ci is clean and `npm audit` reports zero vulnerabilities across all severities. Lockfile is committed. The dependency surface is minimal (14 packages, one prod dep). SBOM generated to `sbom.json`. All 7 required CI gates plus gitleaks and CodeQL are present and wired. The sole material supply-chain weakness is that 100% of GitHub Actions (6/6) float on tags rather than SHA pins. Branch protection is readable but **absent** on both `main` and `harden/pre-react-canonical`; recommended settings above should be applied by the owner.
