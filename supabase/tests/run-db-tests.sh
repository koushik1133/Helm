#!/usr/bin/env bash
# ============================================================================
# run-db-tests.sh — Helm payment / OTP / RLS hardening DB test suite (runner).
# ----------------------------------------------------------------------------
# STATUS: NOT YET EXECUTED. No isolated test DB credentials were available when
#         this suite was authored, so it has NOT been run and this repo contains
#         NO real output from it. Author + reader only. Run it yourself against an
#         ISOLATED NON-PRODUCTION database.
#
# WHAT IT DOES
#   1. Refuses to run against production (project ref nqltzgiwznphugcfhmbm) and,
#      unless ALLOW_NON_STAGING=1, against anything that is not staging
#      (xizehqgeyjcfpzrdymly).
#   2. Loads fixtures (supabase/tests/00-fixtures.sql), runs every deterministic
#      per-case file (10..60) and tallies pass/fail by psql exit code.
#   3. Runs the genuinely-concurrent, multi-session tests that the .sql files
#      cannot express alone:
#        C1  two sessions pay the SAME quote at once  -> exactly one commits.
#        C2  two sessions submit the SAME idempotency key -> one logical payment.
#        C5  two sessions verify the SAME OTP at once  -> exactly one approved.
#   4. Always tears down (supabase/tests/99-teardown.sql) via an EXIT trap.
#
# PRECONDITIONS ON THE TARGET DB (apply in this order BEFORE running):
#   supabase/HELM-STAGING-SCHEMA.sql
#   supabase/wave16/W16-04-OVERPAYMENT-UNIFIED.sql
#   supabase/prod-fix/B2-overpayment-concurrency-lock.sql
#   supabase/prod-fix/B5-record-settlement-payment.sql
#   supabase/prod-fix/C2b-PROD-otp-lockout.sql
#   # the fixes under regression test (apply to turn the regression guards green):
#   supabase/harden-2026-10/H01-overpayment-update-path-and-lock.sql   (CASE 3)
#   supabase/harden-2026-10/H02-otp-verify-row-lock.sql                (CASE 5 race)
#   # CASE 4 group-2 needs the ledger-RPC-boundary RLS lockdown (see docs).
#
# USAGE
#   HELM_TEST_DB_URL='postgresql://postgres:<pw>@db.xizehqgeyjcfpzrdymly.supabase.co:5432/postgres' \
#     bash supabase/tests/run-db-tests.sh
#   Use the DIRECT connection (port 5432), NOT the transaction pooler — advisory
#   and FOR UPDATE locks and multi-statement sessions require a real session.
#
# EXIT CODE: 0 only if every test passed. Non-zero otherwise.
# EXPECTED (pre-fix): CASE 3 and CASE 4-group2 FAIL (they guard pending fixes),
#   and the C5 race FAILS until H02 is applied. That is by design — see docs.
# ============================================================================
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="${HELM_TEST_DB_URL:-}"
[ -n "$URL" ] || { echo "set HELM_TEST_DB_URL (DIRECT 5432 connection to an ISOLATED test DB)"; exit 2; }
case "$URL" in *nqltzgiwznphugcfhmbm*) echo "REFUSING: that is the PRODUCTION project"; exit 3;; esac
case "$URL" in
  *xizehqgeyjcfpzrdymly*) ;;
  *) [ "${ALLOW_NON_STAGING:-}" = 1 ] || { echo "REFUSING: URL is not staging (xizeh…). Set ALLOW_NON_STAGING=1 for a throwaway project."; exit 3; };;
esac

PSQL=(psql "$URL" -X -q -v ON_ERROR_STOP=1 -v HELM_TEST_ACK=1)
RAW=(psql "$URL" -X -q -At -v ON_ERROR_STOP=1)
PASS=0; FAIL=0
ok(){  echo "PASS  $1"; PASS=$((PASS+1)); }
bad(){ echo "FAIL  $1  ${2:-}"; FAIL=$((FAIL+1)); }
scalar(){ "${RAW[@]}" -c "$1" 2>/dev/null | tail -1; }

# fixed ids (mirror 00-fixtures.sql)
OA='db7e57ed-0000-4000-8000-00000000000a'
Q_MAIN='db7e57ed-0000-4000-8000-00000000c001'
Q_IDEM='db7e57ed-0000-4000-8000-00000000c002'
Q_OTP='db7e57ed-0000-4000-8000-00000000c005'
T_OTP='db7e57ed-0000-4000-8000-00000000ef01'
U_PLAN='db7e57ed-0000-4000-8000-0000000000a1'
CLAIMS_PLAN='{"sub":"db7e57ed-0000-4000-8000-0000000000a1","role":"authenticated"}'

teardown(){ "${PSQL[@]}" -f "$HERE/99-teardown.sql" >/dev/null 2>&1 || true; }
trap teardown EXIT

echo "== fixtures"
"${PSQL[@]}" -f "$HERE/00-fixtures.sql" >/dev/null || { echo "fixture setup FAILED (is HELM-STAGING-SCHEMA applied?)"; exit 1; }

# ---- deterministic per-case files (exit code = pass/fail) ------------------
for f in 10-overpayment-concurrency 20-idempotency-key 30-overpayment-update-path \
         40-ledger-rls 50-otp-race-lockout 60-tenant-rbac; do
  echo "== $f.sql"
  if "${PSQL[@]}" -f "$HERE/$f.sql"; then ok "$f.sql"; else bad "$f.sql" "(see output above; CASE 3 & CASE 4-group2 are EXPECTED to fail pre-fix)"; fi
done

# ---- C1: concurrent payments on the SAME quote -----------------------------
echo "== C1 concurrent payments (two sessions, same quote)"
"${RAW[@]}" -c "delete from public.quote_payments where quote_id='$Q_MAIN'" >/dev/null
pay(){ "${RAW[@]}" -c "begin; insert into public.quote_payments(quote_id,amount,status,org_id,receipt_no) values ('$Q_MAIN',600,'paid','$OA','RACE-$1'); select pg_sleep(1); commit;" >/dev/null 2>&1 && echo ok || echo refused; }
r=$(for i in 1 2; do pay "$i" & done; wait)
acc=$(echo "$r" | grep -c ok)
[ "$acc" = 1 ] && ok "C1 exactly one of two concurrent 600-on-1000 payments committed" \
               || bad "C1 concurrent payments" "(committed: $acc; want 1 — needs prod-fix/B2 lock)"
tot=$(scalar "select coalesce(sum(amount),0) from public.quote_payments where quote_id='$Q_MAIN' and status='paid'")
awk "BEGIN{exit !($tot<=1000.5)}" && ok "C1 paid total ($tot) never exceeds quote total (1000)" \
                                  || bad "C1 overpayment" "(paid total $tot > 1000)"
"${RAW[@]}" -c "delete from public.quote_payments where quote_id='$Q_MAIN'" >/dev/null

# ---- C2: concurrent same idempotency key -----------------------------------
echo "== C2 concurrent same-idempotency-key submission"
"${RAW[@]}" -c "delete from public.quote_payments where quote_id='$Q_IDEM'" >/dev/null
rpc(){ "${RAW[@]}" -c "begin; select set_config('request.jwt.claims','$CLAIMS_PLAN',true); select public.record_payment('$Q_IDEM',300,'cash',null,null,null,'RACE-KEY')::text; select pg_sleep(1); commit;" >/dev/null 2>&1 && echo ok || echo err; }
r=$(for i in 1 2; do rpc & done; wait)
n=$(scalar "select count(*) from public.quote_payments where quote_id='$Q_IDEM' and idempotency_key='RACE-KEY'")
[ "$n" = 1 ] && ok "C2 two concurrent same-key submissions -> exactly one ledger row" \
             || bad "C2 idempotency" "(rows: $n; want 1 — unique partial index should collapse the race)"
"${RAW[@]}" -c "delete from public.quote_payments where quote_id='$Q_IDEM'" >/dev/null

# ---- C5: concurrent OTP verify (only one approved) -------------------------
echo "== C5 concurrent OTP verification (two sessions, same code)"
"${RAW[@]}" -c "delete from public.quote_consents where quote_id='$Q_OTP' and phone='race9999';
                delete from public.quote_otps where quote_id='$Q_OTP' and phone='race9999';
                insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id)
                  values ('$Q_OTP','race9999', extensions.crypt('123456', extensions.gen_salt('bf')), now()+interval '10 min','$OA');
                update public.quotes set approval_status='none' where id='$Q_OTP';" >/dev/null
# Two concurrent verifications of the same correct code. The authoritative signal
# is how many consent rows got written: exactly one must survive.
verify(){ "${RAW[@]}" -c "begin; select (public.verify_and_consent('$T_OTP'::uuid,'race9999','123456',true,'v1','terms','T','ua'))->>'approved'; select pg_sleep(1); commit;" >/dev/null 2>&1; }
for i in 1 2; do verify & done; wait
consents=$(scalar "select count(*) from public.quote_consents where quote_id='$Q_OTP' and phone='race9999'")
[ "$consents" = 1 ] && ok "C5 exactly one concurrent verify approved (1 consent row)" \
                    || bad "C5 OTP race" "(consent rows: $consents; want 1 — needs harden-2026-10/H02 FOR UPDATE lock)"
"${RAW[@]}" -c "delete from public.quote_consents where quote_id='$Q_OTP' and phone='race9999';
                delete from public.quote_otps where quote_id='$Q_OTP' and phone='race9999';" >/dev/null

echo "== result: $PASS passed, $FAIL failed (fixtures removed on exit)"
echo "   reminder: CASE 3, CASE 4-group2 and the C5 race are REGRESSION GUARDS and"
echo "   are EXPECTED to fail until H01 / the ledger-RLS lockdown / H02 are applied."
[ "$FAIL" = 0 ]
