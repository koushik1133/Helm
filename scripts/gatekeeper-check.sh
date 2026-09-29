#!/usr/bin/env bash
# gatekeeper-check.sh — single CI/CD gate. Blocks deploy if any guard fails.
# Aggregates Helm's existing zero-dependency guards + unit suite. Extend with the
# owner-only checks (e2e, SEC verify) once GitHub secrets are configured.
# Usage:  bash scripts/gatekeeper-check.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
fail=0
run() { # run <label> <cmd...>
  local label="$1"; shift
  printf '\n=== %s ===\n' "$label"
  if "$@"; then printf '  PASS: %s\n' "$label"
  else printf '  FAIL: %s\n' "$label"; fail=1; fi
}

run "Deployment containment (static-only)"      node scripts/check-deploy-static.mjs
run "Migration-canon consistency"               node scripts/check-migration-canon.mjs
run "OTP safety (no hardcoded PIN)"             node scripts/check-otp-safety.mjs
run "Deferred integrations stay disabled"        node scripts/check-deferred-integrations.mjs
run "Environment separation (no prod-from-localhost)" node scripts/check-env-safety.mjs
run "Unit / source regression suite"            npm test --silent

# Secret scan (best-effort; skipped if gitleaks not installed locally — CI runs it always)
if command -v gitleaks >/dev/null 2>&1; then
  run "Secret scan (gitleaks)" gitleaks detect --no-banner --redact -c .gitleaks.toml
else
  printf '\n=== Secret scan (gitleaks) ===\n  SKIP: gitleaks not installed locally (runs in CI)\n'
fi

# Dependency audit
run "Dependency audit (high+)" npm audit --audit-level=high

printf '\n========================================\n'
if [ "$fail" -eq 0 ]; then
  printf 'GATEKEEPER: PASS — safe to proceed.\n'; exit 0
else
  printf 'GATEKEEPER: FAIL — deployment blocked. Fix the FAIL items above.\n'; exit 1
fi
