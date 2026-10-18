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
# 0164: fixture/setup statements run as a superuser with no API claims, which the DB treats as a
# direct (system) change and keeps quiet. Suites expect normal sends, so pin the override off;
# system-quiet-0164.sql clears it to test the real detection.
export PGOPTIONS="${PGOPTIONS:-} -c helm.maintenance=off"
dropdb --if-exists helm_runall >/dev/null 2>&1; createdb helm_runall
psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/00-supabase-shim.sql >/dev/null 2>&1

fail=0
echo "== clean install =="; bash scripts/db-migrate.sh --apply 2>&1 | grep -oE "applied=[0-9]+ skipped=[0-9]+" || fail=1
echo "== idempotent 2nd run =="; R2="$(bash scripts/db-migrate.sh --apply 2>&1 | grep -oE 'applied=[0-9]+')"; echo "$R2"; [ "$R2" = "applied=0" ] || { echo "NOT idempotent"; fail=1; }
psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1

reseed() { psql -q -v ON_ERROR_STOP=1 -f supabase/test-harness/10-fixtures.sql >/dev/null 2>&1; }
run() { local name="$1" marker="$2"; shift 2; reseed; local out; out="$("$@" 2>&1)"; if echo "$out" | grep -qE "$marker"; then echo "  ✓ $name"; else echo "  ✗ $name"; echo "$out" | tail -3; fail=1; fi; }
echo "== behavioral suites =="
# 0156 first: later suites re-apply older migrations over the 0156 wrappers
run "audit-p2-0156"      "AUDIT-P2-0156: ALL PASS \(76/76\)" psql -q -f tests/db/audit-p2-0156.sql
# before anything that re-applies older migrations (0011/0012/0015/0025/0026) over the 0071/0072 bodies
run "pending-fixes"      "PENDING-FIXES: ALL PASS \(30/30\)" psql -q -f tests/db/pending-fixes.sql
run "inv-fixes"          "INV-FIXES: ALL PASS \(24/24\)" psql -q -f tests/db/inv-fixes.sql
run "checkout-shortage-0105" "CHECKOUT-SHORTAGE-0105: ALL PASS \(24/24\)" psql -q -f tests/db/checkout-shortage-0105.sql
run "chat-admin-fixes"   "CHAT-ADMIN-FIXES: ALL PASS \(21/21\)" psql -q -f tests/db/chat-admin-fixes.sql
run "ui-fixes"           "UI-FIXES: ALL PASS \(27/27\)" psql -q -f tests/db/ui-fixes.sql
run "wa-proposal-0151"   "WA-PROPOSAL-0151: ALL PASS \(24/24\)" psql -q -f tests/db/wa-proposal-0151.sql
run "audit-medium-0155"  "AUDIT-MEDIUM-0155: ALL PASS \(37/37\)" psql -q -f tests/db/audit-medium-0155.sql
run "mfa-verify-hook-0158" "MFA-VERIFY-HOOK-0158: ALL PASS \(15/15\)" psql -q -f tests/db/mfa-verify-hook-0158.sql
run "privacy-pin-0157"   "PRIVACY-PIN-0157: ALL PASS \(30/30\)" psql -q -f tests/db/privacy-pin-0157.sql
run "direct-studio-0159" "DIRECT-STUDIO-0159: ALL PASS \(30/30\)" psql -q -f tests/db/direct-studio-0159.sql
run "crew-schedule-0161" "CREW-SCHEDULE-0161: ALL PASS \(14/14\)" psql -q -f tests/db/crew-schedule-0161.sql
run "insights"           "INSIGHTS: ALL PASS \(19/19\)" psql -q -f tests/db/insights.sql
run "r3-sync-reprice"    "R3-SYNC-REPRICE: ALL PASS \(22/22\)" psql -q -f tests/db/r3-sync-reprice.sql
run "comms-automation"   "COMMS-AUTOMATION: ALL PASS \(54/54\)" psql -q -f tests/db/comms-automation.sql
run "country-templates-0092" "COUNTRY-TEMPLATES-0092: ALL PASS \(12/12\)" psql -q -f tests/db/country-templates-0092.sql
run "country-terms-0093"  "COUNTRY-TERMS-0093: ALL PASS \(6/6\)" psql -q -f tests/db/country-terms-0093.sql
run "per-currency-0094" "PER-CURRENCY-0094: ALL PASS \(12/12\)" psql -q -f tests/db/per-currency-0094.sql
run "client-due-0160"  "CLIENT-DUE-0160: ALL PASS \(9/9\)" psql -q -f tests/db/client-due-0160.sql
run "quote-status-0189" "QUOTE-STATUS-0189: ALL PASS \(19/19\)" psql -q -f tests/db/quote-status-0189.sql
run "photo-render-0095" "PHOTO-RENDER-0095: ALL PASS \(21/21\)" psql -q -f tests/db/photo-render-0095.sql
# early: later suites re-apply 0027 / 0052 / 0093 over the 0097 demo gate wrappers
run "trial-demo-0097"   "TRIAL-DEMO-0097: ALL PASS \(51/51\)" psql -q -f tests/db/trial-demo-0097.sql
run "demo-seed-0100"   "DEMO-SEED-0100: ALL PASS \(18/18\)" psql -q -f tests/db/demo-seed-0100.sql
run "uae-demo-0102"    "UAE-DEMO-0102: ALL PASS \(17/17\)" psql -q -f tests/db/uae-demo-0102.sql
run "e2e-usability-0101" "E2E-USABILITY-0101: ALL PASS \(23/23\)" psql -q -f tests/db/e2e-usability-0101.sql
run "r4-sql-fixes"       "R4-SQL-FIXES: ALL PASS \(26/26\)" psql -q -f tests/db/r4-sql-fixes.sql
# first: later suites re-apply older migrations (e.g. rescore2 → 0032) over the entry points
run "audit-run2"         "AUDIT-RUN2: ALL PASS"            bash -c "cd tests/db && psql -q -f audit-run2.sql"
run "d6-money-freeze"    "D6-MONEY-FREEZE: ALL PASS \(49/49\)" bash -c "cd tests/db && psql -q -f d6-money-freeze.sql"
run "matrix-seed-revert" "MATRIX-SEED-REVERT: ALL PASS \(13/13\)" psql -q -f tests/db/matrix-seed-revert.sql
run "mfa-enforce"        "MFA-ENFORCE: ALL PASS"           bash -c "cd tests/db && psql -q -f mfa-enforce.sql"
run "contract-coverage"  "CONTRACT-COVERAGE: 100%"         node tests/db/contract-coverage.mjs
run "pricing-parity"     "14 parity case\(s\) passed, 0 failed" node tests/db/pricing-parity.mjs
run "auth-matrix"        "AUTH-MATRIX: ALL PASS"           psql -q -f tests/db/auth-matrix.sql
run "rpc-authz-matrix"   "RPC-AUTHZ-MATRIX: ALL PASS"      psql -q -f tests/db/rpc-authz-matrix.sql
run "tenant-attack"      "TENANT-ATTACK: ALL PASS"         psql -q -f tests/db/tenant-attack.sql
run "g4-coverage"        "G4-COVERAGE: ALL expected"       psql -q -f tests/db/g4-coverage.sql
run "grants-matrix"      "GRANTS-MATRIX: ALL PASS"         psql -q -f tests/db/grants-matrix.sql
run "token-otp"          "TOKEN-OTP: ALL PASS"             psql -q -f tests/db/token-otp.sql
run "worker-token"       "WORKER-TOKEN: ALL PASS"          psql -q -f tests/db/worker-token.sql
# before rescore2: that suite re-applies 0032, whose anon allowlist predates 0038's link RPCs
run "worker-evidence"    "WORKER-EVIDENCE: ALL PASS \(38/38\)" psql -q -f tests/db/worker-evidence.sql
# before rescore2 too: its 0032 re-apply resets the anon allowlist (public_get_booklet is a 0065 link RPC)
run "client-booklet"     "CLIENT-BOOKLET: ALL PASS \(44/44\)" psql -q -f tests/db/client-booklet.sql
run "booklet-tax"        "BOOKLET-TAX: ALL PASS \(14/14\)" psql -q -f tests/db/booklet-tax.sql
run "country-tax-0089"   "COUNTRY-TAX-0089: ALL PASS \(16/16\)" psql -q -f tests/db/country-tax-0089.sql
run "quote-currency-0091" "QUOTE-CURRENCY-0091: ALL PASS \(6/6\)" psql -q -f tests/db/quote-currency-0091.sql
run "portal-currency-0090" "PORTAL-CURRENCY-0090: ALL PASS \(7/7\)" psql -q -f tests/db/portal-currency-0090.sql
run "booklet-images"     "BOOKLET-IMAGES: ALL PASS \(25/25\)" psql -q -f tests/db/booklet-images.sql
run "r7-polish"          "R7-POLISH: ALL PASS \(18/18\)" psql -q -f tests/db/r7-polish.sql
run "venues"            "VENUES: ALL PASS \(27/27\)" psql -q -f tests/db/venues.sql
run "venue4-0104"       "VENUE4-0104: ALL PASS \(11/11\)" psql -q -f tests/db/venue4-0104.sql
run "studio-templates"  "STUDIO-TEMPLATES: ALL PASS \(26/26\)" psql -q -f tests/db/studio-templates-0096.sql
run "staff-roles-0106"  "STAFF-ROLES-0106: ALL PASS \(20/20\)" psql -q -f tests/db/staff-roles-0106.sql
run "item-specs"         "ITEM-SPECS: ALL PASS \(30/30\)" psql -q -f tests/db/item-specs.sql
run "smart-import"       "SMART-IMPORT: ALL PASS \(30/30\)" psql -q -f tests/db/smart-import.sql
run "item-spec-parity"   "item-spec-parity: 9 parity case\(s\) passed, 0 failed" node tests/db/item-spec-parity.mjs
# right after client-booklet: later suites re-apply 0036/0048/0054/0058 over the 0069 wrappers
run "pkg-flow"           "PKG-FLOW: ALL PASS \(104/104\)" psql -q -f tests/db/pkg-flow.sql
run "pretty-urls"        "PRETTY-URLS: ALL PASS \(35/35\)" psql -q -f tests/db/pretty-urls.sql
run "advisor-hardening"  "ADVISOR-HARDENING: ALL PASS"     psql -q -f tests/db/advisor-hardening.sql
run "storage-policy"     "STORAGE-POLICY: ALL PASS"        psql -q -f tests/db/storage-policy.sql
run "upload-hardening"   "UPLOAD-HARDENING: ALL PASS \(20/20\)" psql -q -f tests/db/upload-hardening.sql
run "db-gates-0049"     "DB-GATES-0049: ALL PASS \(52/52\)" psql -q -f tests/db/db-gates-0049.sql
run "lifecycle-reapproval-0052" "LIFECYCLE-REAPPROVAL-0052: ALL PASS \(49/49\)" psql -q -f tests/db/lifecycle-reapproval-0052.sql
run "event-stages-0198" "EVENT-STAGES-0198: ALL PASS \(63/63\)" psql -q -f tests/db/event-stages-0198.sql
run "password-lockout"   "PASSWORD-LOCKOUT: ALL PASS \(34/34\)" psql -q -f tests/db/password-lockout.sql
run "notification-mutes" "NOTIFICATION-MUTES: ALL PASS \(17/17\)" psql -q -f tests/db/notification-mutes.sql
run "notification-task-ref" "NOTIFICATION-TASK-REF: ALL PASS \(12/12\)" psql -q -f tests/db/notification-task-ref.sql
# before security-alerts / notification-prefs: they re-apply 0054 / 0036 over the 0058 catalog wrappers
run "trial-reminders"    "TRIAL-REMINDERS: ALL PASS \(36/36\)" psql -q -f tests/db/trial-reminders.sql
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
run "event-group-people-0194" "EVENT-GROUP-PEOPLE-0194: ALL PASS \(23/23\)" psql -q -f tests/db/event-group-people-0194.sql
run "notification-prefs" "NOTIFICATION-PREFS: ALL PASS \(47/47\)" psql -q -f tests/db/notification-prefs.sql
run "member-profile"     "MEMBER-PROFILE: ALL PASS \(81/81\)" psql -q -f tests/db/member-profile.sql
run "phone-verify"       "PHONE-VERIFY: ALL PASS \(40/40\)" psql -q -f tests/db/phone-verify.sql
run "getting-started"    "GETTING-STARTED: ALL PASS \(40/40\)" psql -q -f tests/db/getting-started.sql
run "studio-avatars"    "STUDIO-AVATARS: ALL PASS \(20/20\)" psql -q -f tests/db/studio-avatars.sql
run "onboarding-checkout" "ONBOARDING-CHECKOUT: ALL PASS \(47/47\)" psql -q -f tests/db/onboarding-checkout.sql
run "welcome-email"      "WELCOME-EMAIL: ALL PASS \(31/31\)" psql -q -f tests/db/welcome-email.sql
run "studio-search"      "STUDIO-SEARCH: ALL PASS \(52/52\)" psql -q -f tests/db/studio-search.sql
run "client-360"         "CLIENT-360: ALL PASS \(48/48\)"  psql -q -f tests/db/client-360.sql
run "saved-views"        "SAVED-VIEWS: ALL PASS \(28/28\)" psql -q -f tests/db/saved-views.sql
run "system-quiet-0164"  "SYSTEM-QUIET-0164: ALL PASS \(18/18\)" psql -q -f tests/db/system-quiet-0164.sql
run "trial-sandbox-0166" "TRIAL-SANDBOX-0166: ALL PASS \(51/51\)" psql -q -f tests/db/trial-sandbox-0166.sql
run "trial-manifest-0167" "TRIAL-MANIFEST-0167: ALL PASS \(50/50\)" psql -q -f tests/db/trial-manifest-0167.sql
run "trial-india-0177"   "TRIAL-INDIA-0177: ALL PASS \(17/17\)" psql -q -f tests/db/trial-india-0177.sql
run "trial-data-0168" "TRIAL-DATA-0168: ALL PASS \(17/17\)" psql -q -f tests/db/trial-data-0168.sql
run "trial-data-0169" "TRIAL-DATA-0169: ALL PASS \(24/24\)" psql -q -f tests/db/trial-data-0169.sql
run "trial-data-0170" "TRIAL-DATA-0170: ALL PASS \(16/16\)" psql -q -f tests/db/trial-data-0170.sql
run "trial-data-0171" "TRIAL-DATA-0171: ALL PASS \(16/16\)" psql -q -f tests/db/trial-data-0171.sql
run "trial-lockdown-0173" "TRIAL-LOCKDOWN-0173: ALL PASS \(34/34\)" psql -q -f tests/db/trial-lockdown-0173.sql
run "trial-seed-0174" "TRIAL-SEED-0174: ALL PASS \(12/12\)" psql -q -f tests/db/trial-seed-0174.sql
run "trial-layout-0175" "TRIAL-LAYOUT-0175: ALL PASS \(6/6\)" psql -q -f tests/db/trial-layout-0175.sql
run "trial-client-flow-0176" "TRIAL-CLIENT-FLOW-0176: ALL PASS \(16/16\)" psql -q -f tests/db/trial-client-flow-0176.sql
run "trial-no-send-0179" "TRIAL-NO-SEND-0179: ALL PASS \(41/41\)" psql -q -f tests/db/trial-no-send-0179.sql
run "trial-signup-0180" "TRIAL-SIGNUP-0180: ALL PASS \(33/33\)" psql -q -f tests/db/trial-signup-0180.sql
run "trial-guards-0181" "TRIAL-GUARDS-0181: ALL PASS \(60/60\)" psql -q -f tests/db/trial-guards-0181.sql
run "trial-prices-0182" "TRIAL-PRICES-0182: ALL PASS \(21/21\)" psql -q -f tests/db/trial-prices-0182.sql
run "trial-expiry-0183" "TRIAL-EXPIRY-0183: ALL PASS \(61/61\)" psql -q -f tests/db/trial-expiry-0183.sql
run "trial-retention-0184" "TRIAL-RETENTION-0184: ALL PASS \(50/50\)" psql -q -f tests/db/trial-retention-0184.sql
run "trial-upgrade-0185" "TRIAL-UPGRADE-0185: ALL PASS \(45/45\)" psql -q -f tests/db/trial-upgrade-0185.sql
run "trial-extension-0186" "TRIAL-EXTENSION-0186: ALL PASS \(55/55\)" psql -q -f tests/db/trial-extension-0186.sql
run "trial-outbound-0187" "TRIAL-OUTBOUND-0187: ALL PASS \(17/17\)" psql -q -f tests/db/trial-outbound-0187.sql
run "trial-clone-0190" "TRIAL-CLONE-0190: ALL PASS \(24/24\)" psql -q -f tests/db/trial-clone-0190.sql
run "release-integration-0201" "RELEASE-INTEGRATION-0201: ALL PASS \(11/11\)" psql -q -f tests/db/release-integration-0201.sql
run "trial-requirements-0202" "TRIAL-REQUIREMENTS-0202: ALL PASS \(17/17\)" psql -q -f tests/db/trial-requirements-0202.sql
run "menu-pkg-0192"    "MENU-PKG-0192: ALL PASS \(41/41\)" psql -q -f tests/db/menu-pkg-0192.sql
run "menu-lock-trial" "MENU-LOCK-TRIAL: ALL PASS \(17/17\)" psql -q -f tests/db/menu-lock-trial.sql
run "invite-share-0195" "INVITE-SHARE-0195: ALL PASS \(40/40\)" psql -q -f tests/db/invite-share-0195.sql
run "booklet-send-0200" "BOOKLET-SEND-0200: ALL PASS \(40/40\)" psql -q -f tests/db/booklet-send-0200.sql
run "budget-plan-0196" "BUDGET-PLAN-0196: ALL PASS \(14/14\)" psql -q -f tests/db/budget-plan-0196.sql
run "budget-single-source-0199" "BUDGET-SINGLE-SOURCE-0199: ALL PASS \(32/32\)" psql -q -f tests/db/budget-single-source-0199.sql
run "capacity-shortage-0197" "CAPACITY-SHORTAGE-0197: ALL PASS \(39/39\)" psql -q -f tests/db/capacity-shortage-0197.sql
run "trial-gates-0203" "TRIAL-GATES-0203: ALL PASS \(46/46\)" psql -q -f tests/db/trial-gates-0203.sql
run "anon-grant-tidy-0204" "ANON-GRANT-TIDY-0204: ALL PASS \(28/28\)" psql -q -f tests/db/anon-grant-tidy-0204.sql
run "invite-accept-0205" "INVITE-ACCEPT-0205: ALL PASS \(40/40\)" psql -q -f tests/db/invite-accept-0205.sql
run "flow-progress-0206" "FLOW-PROGRESS-0206: ALL PASS \(46/46\)" psql -q -f tests/db/flow-progress-0206.sql
run "trial-terms-0207" "TRIAL-TERMS-0207: ALL PASS \(39/39\)" psql -q -f tests/db/trial-terms-0207.sql
run "empty-draft-0208" "EMPTY-DRAFT-0208: ALL PASS \(13/13\)" psql -q -f tests/db/empty-draft-0208.sql
run "start-blank-0220" "START-BLANK-0220: ALL PASS \(48/48\)" psql -q -f tests/db/start-blank-0220.sql
run "trial-unify-0236" "TRIAL-UNIFY-0236: ALL PASS \(38/38\)" psql -q -f tests/db/trial-unify-0236.sql
run "trial-seed-0237" "TRIAL-SEED-0237: ALL PASS \(27/27\)" psql -q -f tests/db/trial-seed-0237.sql
run "concurrency-overpay" "REJECTED .*overlap proven"      bash tests/db/concurrency-overpay.sh
run "concurrency-otp"    "OTP-CONCURRENCY: PASS"           bash tests/db/concurrency-otp.sh

echo "----------------------------------------"
if [ "$fail" = 0 ]; then echo "DB SUITES: ALL GREEN"; else echo "DB SUITES: FAILURES ABOVE"; exit 1; fi
