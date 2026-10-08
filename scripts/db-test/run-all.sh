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
# first: later suites re-apply older migrations (e.g. rescore2 → 0032) over the entry points
run "audit-run2"         "AUDIT-RUN2: ALL PASS"            bash -c "cd tests/db && psql -q -f audit-run2.sql"
run "d6-money-freeze"    "D6-MONEY-FREEZE: ALL PASS \(49/49\)" bash -c "cd tests/db && psql -q -f d6-money-freeze.sql"
run "matrix-seed-revert" "MATRIX-SEED-REVERT: ALL PASS \(13/13\)" psql -q -f tests/db/matrix-seed-revert.sql
run "mfa-enforce"        "MFA-ENFORCE: ALL PASS"           bash -c "cd tests/db && psql -q -f mfa-enforce.sql"
run "contract-coverage"  "CONTRACT-COVERAGE: 100%"         node tests/db/contract-coverage.mjs
run "pricing-parity"     "13 parity case\(s\) passed, 0 failed" node tests/db/pricing-parity.mjs
run "auth-matrix"        "AUTH-MATRIX: ALL PASS"           psql -q -f tests/db/auth-matrix.sql
run "rpc-authz-matrix"   "RPC-AUTHZ-MATRIX: ALL PASS"      psql -q -f tests/db/rpc-authz-matrix.sql
run "tenant-attack"      "TENANT-ATTACK: ALL PASS"         psql -q -f tests/db/tenant-attack.sql
run "g4-coverage"        "G4-COVERAGE: ALL expected"       psql -q -f tests/db/g4-coverage.sql
run "grants-matrix"      "GRANTS-MATRIX: ALL PASS"         psql -q -f tests/db/grants-matrix.sql
run "token-otp"          "TOKEN-OTP: ALL PASS"             psql -q -f tests/db/token-otp.sql
run "worker-token"       "WORKER-TOKEN: ALL PASS"          psql -q -f tests/db/worker-token.sql
# before rescore2: that suite re-applies 0032, whose anon allowlist predates 0038's link RPCs
run "worker-evidence"    "WORKER-EVIDENCE: ALL PASS \(38/38\)" psql -q -f tests/db/worker-evidence.sql
run "advisor-hardening"  "ADVISOR-HARDENING: ALL PASS"     psql -q -f tests/db/advisor-hardening.sql
run "storage-policy"     "STORAGE-POLICY: ALL PASS"        psql -q -f tests/db/storage-policy.sql
run "upload-hardening"   "UPLOAD-HARDENING: ALL PASS \(20/20\)" psql -q -f tests/db/upload-hardening.sql
run "db-gates-0049"     "DB-GATES-0049: ALL PASS \(51/51\)" psql -q -f tests/db/db-gates-0049.sql
run "lifecycle-reapproval-0052" "LIFECYCLE-REAPPROVAL-0052: ALL PASS \(49/49\)" psql -q -f tests/db/lifecycle-reapproval-0052.sql
run "password-lockout"   "PASSWORD-LOCKOUT: ALL PASS \(34/34\)" psql -q -f tests/db/password-lockout.sql
# before notification-prefs: that suite re-applies 0036 (which resets the 0054 catalog wrapper)
run "security-alerts"    "SECURITY-ALERTS: ALL PASS \(47/47\)" psql -q -f tests/db/security-alerts.sql
run "upload-quarantine"  "UPLOAD-QUARANTINE: ALL PASS \(21/21\)" psql -q -f tests/db/upload-quarantine.sql
run "chat-rls"           "CHAT-RLS: ALL PASS"              psql -q -f tests/db/chat-rls.sql
run "studio-links"       "STUDIO-LINKS: ALL PASS"          psql -q -f tests/db/studio-links.sql
run "privilege-escalation" "PRIVILEGE-ESCALATION: ALL PASS"  psql -q -f tests/db/privilege-escalation.sql
run "link-windows"       "LINK-WINDOWS: ALL PASS"          psql -q -f tests/db/link-windows.sql
run "link-autoexpire"    "LINK-AUTOEXPIRE: ALL PASS \(45/45\)" psql -q -f tests/db/link-autoexpire.sql
run "link-expiry-archive" "LINK-EXPIRY-ARCHIVE: ALL PASS \(66/66\)" psql -q -f tests/db/link-expiry-archive.sql
run "injection-guards"   "INJECTION-GUARDS: ALL PASS"      psql -q -f tests/db/injection-guards.sql
run "write-path-lockdown" "WRITE-PATH-LOCKDOWN: ALL PASS"  psql -q -f tests/db/write-path-lockdown.sql
run "business-logic"     "BUSINESS-LOGIC: ALL PASS"        psql -q -f tests/db/business-logic.sql
run "uploads-payments"   "UPLOADS-PAYMENTS: ALL PASS"     psql -q -f tests/db/uploads-payments.sql
run "platform-admin"     "PLATFORM-ADMIN: ALL PASS \(33/33\)" psql -q -f tests/db/platform-admin.sql
run "hq-subscriptions"   "HQ-SUBSCRIPTIONS: ALL PASS \(80/80\)" psql -q -f tests/db/hq-subscriptions.sql
run "hq-mfa-optional"   "HQ-MFA-OPTIONAL: ALL PASS \(17/17\)" psql -q -f tests/db/hq-mfa-optional.sql
run "auth-hardening"     "AUTH-HARDENING: ALL PASS \(41/41\)" psql -q -f tests/db/auth-hardening.sql
run "auth-limits"        "AUTH-LIMITS: ALL PASS \(21/21\)" psql -q -f tests/db/auth-limits.sql
run "payment-matrix"     "PAYMENT-MATRIX: ALL PASS"        psql -q -f tests/db/payment-matrix.sql
run "checkout-overissue" "CHECKOUT-OVERISSUE: ALL PASS"    psql -q -f tests/db/checkout-overissue.sql
run "rescore2-fixes"     "RESCORE2-FIXES: ALL PASS \(33/33\)" psql -q -f tests/db/rescore2-fixes.sql
run "rescore3-fixes"     "RESCORE3-FIXES: ALL PASS \(26/26\)" psql -q -f tests/db/rescore3-fixes.sql
run "display-names"      "DISPLAY-NAMES: ALL PASS \(38/38\)" psql -q -f tests/db/display-names.sql
run "event-groups"       "EVENT-GROUPS: ALL PASS \(36/36\)" psql -q -f tests/db/event-groups.sql
run "event-groups-race"  "EVENT-GROUP-RACE: PASS"          bash tests/db/event-groups-race.sh
run "notification-prefs" "NOTIFICATION-PREFS: ALL PASS \(47/47\)" psql -q -f tests/db/notification-prefs.sql
run "member-profile"     "MEMBER-PROFILE: ALL PASS \(81/81\)" psql -q -f tests/db/member-profile.sql
run "phone-verify"       "PHONE-VERIFY: ALL PASS \(40/40\)" psql -q -f tests/db/phone-verify.sql
run "onboarding-checkout" "ONBOARDING-CHECKOUT: ALL PASS \(47/47\)" psql -q -f tests/db/onboarding-checkout.sql
run "welcome-email"      "WELCOME-EMAIL: ALL PASS \(31/31\)" psql -q -f tests/db/welcome-email.sql
run "concurrency-overpay" "REJECTED .*overlap proven"      bash tests/db/concurrency-overpay.sh
run "concurrency-otp"    "OTP-CONCURRENCY: PASS"           bash tests/db/concurrency-otp.sh

echo "----------------------------------------"
if [ "$fail" = 0 ]; then echo "DB SUITES: ALL GREEN"; else echo "DB SUITES: FAILURES ABOVE"; exit 1; fi
