#!/usr/bin/env bash
# run-all.sh — rebuild a disposable PG17 cluster, apply the canonical migrations,
# load the two-tenant fixture, and run every DB behavioral suite. Exit non-zero on
# any failure. Local-only; never touches staging/production.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
export LC_ALL=C LANG=C
# Use the Homebrew PG17 bin for local dev if present; in CI, psql is already on PATH.
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@17/bin}"; [ -d "$PGBIN" ] && export PATH="$PGBIN:$PATH"
# Connection: honour an externally-provided PG* (e.g. a CI postgres:17 service);
# otherwise fall back to the local disposable cluster on 127.0.0.1:55439.
if [ -z "${PGHOST:-}" ]; then
  export HELM_PG_PORT="${HELM_PG_PORT:-55439}"
  export HELM_PG_SCRATCH="${HELM_PG_SCRATCH:-/tmp/helm-pgcluster}"
  export PGHOST=127.0.0.1 PGPORT="$HELM_PG_PORT" PGUSER="$(whoami)"
  if ! pg_isready -q 2>/dev/null; then
    bash scripts/db-test/cluster.sh init >/dev/null 2>&1 || true
    bash scripts/db-test/cluster.sh start >/dev/null 2>&1 || true
  fi
fi
export PGDATABASE=helm_runall
dropdb --if-exists helm_runall >/dev/null 2>&1; createdb helm_runall
psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1

fail=0
echo "== clean install =="; bash scripts/db-migrate.sh --apply 2>&1 | grep -oE "applied=[0-9]+ skipped=[0-9]+" || fail=1
echo "== idempotent 2nd run =="; R2="$(bash scripts/db-migrate.sh --apply 2>&1 | grep -oE 'applied=[0-9]+')"; echo "$R2"; [ "$R2" = "applied=0" ] || { echo "NOT idempotent"; fail=1; }
psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1

reseed() { psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1; }
run() { local name="$1" marker="$2"; shift 2; reseed; local out; out="$("$@" 2>&1)"; if echo "$out" | grep -qE "$marker"; then echo "  ✓ $name"; else echo "  ✗ $name"; echo "$out" | tail -3; fail=1; fi; }
echo "== behavioral suites =="
run "contract-coverage"  "CONTRACT-COVERAGE: 100%"         node tests/db/contract-coverage.mjs
run "pricing-parity"     "13 parity case\(s\) passed, 0 failed" node tests/db/pricing-parity.mjs
run "auth-matrix"        "AUTH-MATRIX: ALL PASS"           psql -q -f tests/db/auth-matrix.sql
run "rpc-authz-matrix"   "RPC-AUTHZ-MATRIX: ALL PASS"      psql -q -f tests/db/rpc-authz-matrix.sql
run "tenant-attack"      "TENANT-ATTACK: ALL PASS"         psql -q -f tests/db/tenant-attack.sql
run "g4-coverage"        "G4-COVERAGE: ALL expected"       psql -q -f tests/db/g4-coverage.sql
run "grants-matrix"      "GRANTS-MATRIX: ALL PASS"         psql -q -f tests/db/grants-matrix.sql
run "token-otp"          "TOKEN-OTP: ALL PASS"             psql -q -f tests/db/token-otp.sql
run "worker-token"       "WORKER-TOKEN: ALL PASS"          psql -q -f tests/db/worker-token.sql
run "advisor-hardening"  "ADVISOR-HARDENING: ALL PASS"     psql -q -f tests/db/advisor-hardening.sql
run "storage-policy"     "STORAGE-POLICY: ALL PASS"        psql -q -f tests/db/storage-policy.sql
run "payment-matrix"     "PAYMENT-MATRIX: ALL PASS"        psql -q -f tests/db/payment-matrix.sql
run "checkout-overissue" "CHECKOUT-OVERISSUE: ALL PASS"    psql -q -f tests/db/checkout-overissue.sql
run "concurrency-overpay" "REJECTED .*overlap proven"      bash tests/db/concurrency-overpay.sh
run "concurrency-otp"    "OTP-CONCURRENCY: PASS"           bash tests/db/concurrency-otp.sh

echo "----------------------------------------"
if [ "$fail" = 0 ]; then echo "DB SUITES: ALL GREEN"; else echo "DB SUITES: FAILURES ABOVE"; exit 1; fi
