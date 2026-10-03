#!/usr/bin/env bash
# Genuine two-session overlap test for the overpayment advisory lock (0003).
# Session A opens a txn, inserts a paid row (acquires the per-quote advisory xact
# lock), holds it for 2s, commits. Session B starts ~0.6s later and tries the same
# — it MUST block on the lock until A commits, then be REJECTED (would overpay).
# Proves: real overlap (B waits), exactly one financial effect, final paid<=total.
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"; export LC_ALL=C LANG=C
Q='a0000000-0000-4000-8000-00000000da01'
psql -q -c "delete from public.quote_payments where quote_id='$Q';" >/dev/null

echo "== scenario 1: different idempotency keys, both ₹150k on a ₹236k quote =="
# Session A (background): hold the lock 2s
( psql -q -v ON_ERROR_STOP=1 <<SQL
begin;
insert into public.quote_payments(quote_id,provider,amount,currency,status,simulated,idempotency_key)
  values ('$Q','t',150000,'INR','paid',true,'keyA');
select pg_sleep(2);
commit;
SQL
  echo "A: committed (₹150k paid)" ) &
APID=$!
sleep 0.6   # ensure A holds the lock before B starts
# Session B (foreground): should block ~1.4s then be rejected
B_START=$(date +%s.%N)
B_OUT=$(psql -q -v ON_ERROR_STOP=1 <<SQL 2>&1
begin;
insert into public.quote_payments(quote_id,provider,amount,currency,status,simulated,idempotency_key)
  values ('$Q','t',150000,'INR','paid',true,'keyB');
commit;
SQL
)
B_END=$(date +%s.%N)
wait $APID
B_WAIT=$(echo "$B_END - $B_START" | bc)
if echo "$B_OUT" | grep -qi "exceeds the outstanding balance"; then
  echo "B: REJECTED (overpay guard) after blocking ${B_WAIT}s  -> overlap proven"
else
  echo "B: UNEXPECTED: $B_OUT"
fi
psql -q -t -c "select 'final: '||count(*)||' paid row(s), total paid='||coalesce(sum(amount),0)||' (<=236000 required)' from public.quote_payments where quote_id='$Q' and status='paid';"

echo
echo "== scenario 2: SAME idempotency key twice (expect exactly one effect) =="
psql -q -c "delete from public.quote_payments where quote_id='$Q';" >/dev/null
psql -q -v ON_ERROR_STOP=0 <<SQL >/dev/null 2>&1
insert into public.quote_payments(quote_id,provider,amount,currency,status,simulated,idempotency_key) values ('$Q','t',100000,'INR','paid',true,'dup');
insert into public.quote_payments(quote_id,provider,amount,currency,status,simulated,idempotency_key) values ('$Q','t',100000,'INR','paid',true,'dup');
SQL
psql -q -t -c "select 'same-key result: '||count(*)||' row(s) (expect 1 — unique idempotency_key), total='||coalesce(sum(amount),0) from public.quote_payments where quote_id='$Q' and status='paid';"
