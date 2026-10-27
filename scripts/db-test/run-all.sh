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
export PGOPTIONS="${PGOPTIONS:-} -c helm.maintenance=off -c helm.allow_hq_mfa_lockout=on"   # 0249: fixtures turn hq_require_mfa on with fake operators; r21-security-0249.sql turns the guard back on
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
# 0260 early (later suites commit grant changes it probes); it re-applies itself twice (re-run safe), rolled back
run "r23-cancel-links-0260" "R23-CANCEL-LINKS-0260: ALL PASS \(40/40\)" psql -q -f tests/db/r23-cancel-links-0260.sql
run "pending-fixes"      "PENDING-FIXES: ALL PASS \(30/30\)" psql -q -f tests/db/pending-fixes.sql
run "inv-fixes"          "INV-FIXES: ALL PASS \(24/24\)" psql -q -f tests/db/inv-fixes.sql
run "checkout-shortage-0105" "CHECKOUT-SHORTAGE-0105: ALL PASS \(24/24\)" psql -q -f tests/db/checkout-shortage-0105.sql
run "chat-admin-fixes"   "CHAT-ADMIN-FIXES: ALL PASS \(21/21\)" psql -q -f tests/db/chat-admin-fixes.sql
run "ui-fixes"           "UI-FIXES: ALL PASS \(27/27\)" psql -q -f tests/db/ui-fixes.sql
run "wa-proposal-0151"   "WA-PROPOSAL-0151: ALL PASS \(24/24\)" psql -q -f tests/db/wa-proposal-0151.sql
run "audit-medium-0155"  "AUDIT-MEDIUM-0155: ALL PASS \(37/37\)" psql -q -f tests/db/audit-medium-0155.sql
run "mfa-verify-hook-0158" "MFA-VERIFY-HOOK-0158: ALL PASS \(15/15\)" psql -q -f tests/db/mfa-verify-hook-0158.sql
run "r21-reserved-domain-0248" "R21-RESERVED-DOMAIN-0248: ALL PASS \(42/42\)" psql -q -f tests/db/r21-reserved-domain-0248.sql
run "r21-security-0249" "R21-SECURITY-0249: ALL PASS \(29/29\)" psql -q -f tests/db/r21-security-0249.sql
run "r22-mfa-reset-0253" "R22-MFA-RESET-0253: ALL PASS \(30/30\)" psql -q -f tests/db/r22-mfa-reset-0253.sql
run "privacy-pin-0157"   "PRIVACY-PIN-0157: ALL PASS \(30/30\)" psql -q -f tests/db/privacy-pin-0157.sql
run "direct-studio-0159" "DIRECT-STUDIO-0159: ALL PASS \(30/30\)" psql -q -f tests/db/direct-studio-0159.sql
run "r22-create-studio-0255" "R22-CREATE-STUDIO-0255: ALL PASS \(46/46\)" psql -q -f tests/db/r22-create-studio-0255.sql
# early: later suites re-apply 0032 / 0156 / 0200 over the 0262 verify_and_consent / comms_outbox_claim wrappers
run "r23-quote-validity-0262" "R23-QUOTE-VALIDITY-0262: ALL PASS \(69/69\)" psql -q -f tests/db/r23-quote-validity-0262.sql
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
run "security-alerts"    "SECURITY-ALERTS: ALL PASS \(48/48\)" psql -q -f tests/db/security-alerts.sql
run "r21-security-notices-0250" "R21-SECURITY-NOTICES-0250: ALL PASS \(35/35\)" psql -q -f tests/db/r21-security-notices-0250.sql
run "upload-quarantine"  "UPLOAD-QUARANTINE: ALL PASS \(21/21\)" psql -q -f tests/db/upload-quarantine.sql
run "chat-rls"           "CHAT-RLS: ALL PASS"              psql -q -f tests/db/chat-rls.sql
run "studio-links"       "STUDIO-LINKS: ALL PASS"          psql -q -f tests/db/studio-links.sql
run "r23-studio-name-0257" "R23-STUDIO-NAME-0257: ALL PASS \(41/41\)" psql -q -f tests/db/r23-studio-name-0257.sql
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
run "trial-manifest-0167" "TRIAL-MANIFEST-0167: ALL PASS \(51/51\)" psql -q -f tests/db/trial-manifest-0167.sql
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
run "signup-invite-0210" "SIGNUP-INVITE-0210: ALL PASS \(39/39\)" psql -q -f tests/db/signup-invite-0210.sql
run "trial-quotes-0211" "TRIAL-QUOTES-0211: ALL PASS \(27/27\)" psql -q -f tests/db/trial-quotes-0211.sql
run "trial-email-0212" "TRIAL-EMAIL-0212: ALL PASS \(46/46\)" psql -q -f tests/db/trial-email-0212.sql
run "start-blank-0220" "START-BLANK-0220: ALL PASS \(48/48\)" psql -q -f tests/db/start-blank-0220.sql
run "trial-dates-0223" "TRIAL-DATES-0223: ALL PASS \(23/23\)" psql -q -f tests/db/trial-dates-0223.sql
run "trial-unify-0236" "TRIAL-UNIFY-0236: ALL PASS \(38/38\)" psql -q -f tests/db/trial-unify-0236.sql
run "trial-seed-0237" "TRIAL-SEED-0237: ALL PASS \(27/27\)" psql -q -f tests/db/trial-seed-0237.sql
# 0238 after every suite that re-applies 0211 / 0173 / 0181 (it re-applies 0236 + 0211 itself, then 0238)
run "trial-quotes-cap-0238" "TRIAL-QUOTES-CAP-0238: ALL PASS \(28/28\)" psql -q -f tests/db/trial-quotes-cap-0238.sql
run "sample-layouts-0213" "SAMPLE-LAYOUTS-0213: ALL PASS \(16/16\)" psql -q -f tests/db/sample-layouts-0213.sql
run "trial-seed-0222" "TRIAL-SEED-0222: ALL PASS \(18/18\)" psql -q -f tests/db/trial-seed-0222.sql
# 0251 re-applies itself twice (existing trial / paid studios are made after the clean install; re-run safe)
run "r21-political-0251" "R21-POLITICAL-0251: ALL PASS \(9/9\)" psql -q -f tests/db/r21-political-0251.sql
# 0239 re-applies itself (the fixture studios are made after the clean install; also proves a re-run is safe)
run "r20-business-0239" "R20-BUSINESS-0239: ALL PASS \(34/34\)" psql -q -f tests/db/r20-business-0239.sql
run "insights-costs-0240" "INSIGHTS-COSTS-0240: ALL PASS \(18/18\)" psql -q -f tests/db/insights-costs-0240.sql
run "r21-target-margin-0242" "R21-TARGET-MARGIN-0242: ALL PASS \(23/23\)" psql -q -f tests/db/r21-target-margin-0242.sql
# 0241 re-applies itself (fixture studios are made after the clean install; also proves a re-run is safe)
run "r21-reminders-0241" "R21-REMINDERS-0241: ALL PASS \(69/69\)" psql -q -f tests/db/r21-reminders-0241.sql
# 0246 re-applies itself (fixture events are made after the clean install; proves a re-run is safe)
run "r21-money-0246" "R21-MONEY-0246: ALL PASS \(32/32\)" psql -q -f tests/db/r21-money-0246.sql
# 0252 re-applies 0246 (proves the old skip) then 0252 twice (re-run safe)
run "r22-money-0252" "R22-MONEY-0252: ALL PASS \(17/17\)" psql -q -f tests/db/r22-money-0252.sql
# 0254 re-applies itself (fixture events are made after the clean install; proves a re-run is safe)
run "r22-closure-0254" "R22-CLOSURE-0254: ALL PASS \(68/68\)" psql -q -f tests/db/r22-closure-0254.sql
# 0256 re-applies itself twice (fixture events are made after the clean install; proves a re-run is safe)
run "r23-vendors-0256" "R23-VENDORS-0256: ALL PASS \(77/77\)" psql -q -f tests/db/r23-vendors-0256.sql
run "r23-payment-schedules-0264" "R23-PAYMENT-SCHEDULES-0264: ALL PASS \(71/71\)" psql -q -f tests/db/r23-payment-schedules-0264.sql
# 0265 re-applies itself twice (re-run safe); after every suite that re-applies 0132 / 0246 / 0252 (it replaces the 0252 ledger body)
run "r23-crew-0265" "R23-CREW-0265: ALL PASS \(60/60\)" psql -q -f tests/db/r23-crew-0265.sql
# 0261 re-applies itself (after 0254, whose bell_feed / event_activity it wraps; proves a re-run is safe)
run "r23-link-views-0261" "R23-LINK-VIEWS-0261: ALL PASS \(62/62\)" psql -q -f tests/db/r23-link-views-0261.sql
# 0266 re-applies itself (after r22-closure, which re-applies 0254 over the bell_feed wrapper)
run "r23-inbox-0266" "R23-INBOX-0266: ALL PASS \(67/67\)" psql -q -f tests/db/r23-inbox-0266.sql
# 0263 re-applies itself (fixture quotes are made after the clean install; proves the backfill re-run adds nothing)
run "r23-state-machine-0263" "R23-STATE-MACHINE-0263: ALL PASS \(48/48\)" psql -q -f tests/db/r23-state-machine-0263.sql
# r24 stock: re-applies itself twice (after r22-closure-0254, which re-applies the 0254 body), rolled back
run "r24-stock-0268" "R24-STOCK-0268: ALL PASS \(47/47\)" psql -q -f tests/db/r24-stock-0268.sql
# 0269 re-applies itself twice (fixture events are made after the clean install; proves a re-run is safe)
run "r24-automation-0269" "R24-AUTOMATION-0269: ALL PASS \(66/66\)" psql -q -f tests/db/r24-automation-0269.sql
# 0244 re-applies itself twice (re-run safe) after every suite that re-applies 0045 / 0183 / 0185
run "r21-trial-paid-0244" "R21-TRIAL-PAID-0244: ALL PASS \(56/56\)" psql -q -f tests/db/r21-trial-paid-0244.sql
# 0271 re-applies itself twice (re-run safe) after 0244 / 0266 (the outbox kind check + claim it extends)
run "r24-contact-0271" "R24-CONTACT-0271: ALL PASS \(54/54\)" psql -q -f tests/db/r24-contact-0271.sql
# r25 HQ: read-only numbers, re-applies itself twice (re-run safe), rolled back
run "r25-hq-metrics-0272" "R25-HQ-METRICS-0272: ALL PASS \(23/23\)" psql -q -f tests/db/r25-hq-metrics-0272.sql
# 0273 re-applies itself (after every suite that re-applies 0056's _checkout_currency), rolled back
run "r25-currency-0273" "R25-CURRENCY-0273: ALL PASS \(35/35\)" psql -q -f tests/db/r25-currency-0273.sql
# 0274 re-applies itself (twice + twice more: re-run with the marker, then a simulated first run), rolled back
run "r25-automations-0274" "R25-AUTOMATIONS-0274: ALL PASS \(30/30\)" psql -q -f tests/db/r25-automations-0274.sql
run "r26-captcha-0276" "R26-CAPTCHA-0276: ALL PASS \(30/30\)" psql -q -f tests/db/r26-captcha-0276.sql
# 0277 re-applies itself (later suites may re-apply 0263 / 0271 bodies), rolled back
run "r27-hq-staff-0277" "R27-HQ-STAFF-0277: ALL PASS \(58/58\)" psql -q -f tests/db/r27-hq-staff-0277.sql
# 0279 re-applies itself twice (re-run safe), after every suite that re-applies 0045 / 0244 / 0273 / 0277, rolled back
run "r29-referrals-0279" "R29-REFERRALS-0279: ALL PASS \(91/91\)" psql -q -f tests/db/r29-referrals-0279.sql
# 0281 re-applies itself (earlier suites re-apply the 0026 / 0069 / 0269 / 0271 bodies), rolled back
run "r31-client-ip-0281" "R31-CLIENT-IP-0281: ALL PASS \(16/16\)" psql -q -f tests/db/r31-client-ip-0281.sql
# 0282 re-applies itself twice (earlier suites re-apply the 0049 / 0126 / 0155 / 0166 / 0264 bodies), rolled back
run "r32-security-0282" "R32-SECURITY-0282: ALL PASS \(51/51\)" psql -q -f tests/db/r32-security-0282.sql
# R32b (review round 2): price decrease after confirmation, change request below paid, close requests + close_owed,
# payments after closing, seats (joining / lapsed subscriptions), admin_create_user refusals counted
run "r32b-round2-0282" "R32B-ROUND2-0282: ALL PASS \(35/35\)" psql -q -f tests/db/r32b-round2-0282.sql
# 0283 re-applies itself twice (earlier suites re-apply the 0184 / 0266 / 0282 bodies), rolled back
run "r33-team-safety-0283" "R33-TEAM-SAFETY-0283: ALL PASS \(87/87\)" psql -q -f tests/db/r33-team-safety-0283.sql
# 0285 re-applies itself twice (re-run safe; later than every suite that re-applies 0264 / 0150 / 0117), rolled back
run "r35-paysafe-0285" "R35-PAYSAFE-0285: ALL PASS \(100/100\)" psql -q -f tests/db/r35-paysafe-0285.sql
# 0291 re-applies itself twice (re-run safe), rolled back
run "r44-two-step-0291" "R44-TWO-STEP-0291: ALL PASS \(22/22\)" psql -q -f tests/db/r44-two-step-0291.sql
# 0284 re-applies itself twice + once more at the end (re-run safe; after rescore2, which resets anon EXECUTE), rolled back
run "r34-invite-0284" "R34-INVITE-0284: ALL PASS \(59/59\)" psql -q -f tests/db/r34-invite-0284.sql
# r47 (0292): my_pending re-issued (prod 500 = statement timeout); re-applies itself twice (earlier suites re-apply 0036), rolled back
run "r47-my-pending-0292" "R47-MY-PENDING-0292: ALL PASS \(24/24\)" psql -q -f tests/db/r47-my-pending-0292.sql
# 0287 re-applies itself twice (re-run safe; after every suite that re-applies 0069 / 0120 / 0181 / 0239 / 0268), rolled back
run "r37-studio-tz-0287" "R37-STUDIO-TZ-0287: ALL PASS \(36/36\)" psql -q -f tests/db/r37-studio-tz-0287.sql
run "concurrency-overpay" "REJECTED .*overlap proven"      bash tests/db/concurrency-overpay.sh
run "concurrency-otp"    "OTP-CONCURRENCY: PASS"           bash tests/db/concurrency-otp.sh

echo "----------------------------------------"
if [ "$fail" = 0 ]; then echo "DB SUITES: ALL GREEN"; else echo "DB SUITES: FAILURES ABOVE"; exit 1; fi
