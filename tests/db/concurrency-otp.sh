#!/usr/bin/env bash
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"; export LC_ALL=C LANG=C
Q='a0000000-0000-4000-8000-00000000da01'; O='a0000000-0000-4000-8000-000000000001'; PH='9993334444'
psql -q -c "delete from public.quote_otps where quote_id='$Q';" >/dev/null
# pre-seed 2 so the cap (3) is one away; two concurrent inserts must yield only ONE more (total 3), not 4
psql -q -c "insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id) select '$Q','$PH','h',now()+interval '10 min','$O' from generate_series(1,2);" >/dev/null
( psql -q -v ON_ERROR_STOP=1 <<SQL
begin;
insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id) values('$Q','$PH','h',now()+interval '10 min','$O');
select pg_sleep(2);
commit;
SQL
) & APID=$!
sleep 0.6
S=$(date +%s.%N)
B=$(psql -q -v ON_ERROR_STOP=1 -c "insert into public.quote_otps(quote_id,phone,code_hash,expires_at,org_id) values('$Q','$PH','h',now()+interval '10 min','$O');" 2>&1)
E=$(date +%s.%N); wait $APID
W=$(echo "$E - $S" | bc)
cnt=$(psql -q -t -A -c "select count(*) from public.quote_otps where quote_id='$Q' and phone='$PH';")
if echo "$B" | grep -qi "too many"; then echo "OTP-CONCURRENCY: B rejected after blocking ${W}s; final count=$cnt (expect 3, not 4) -> overlap proven"; else echo "OTP-CONCURRENCY: B result=$B final count=$cnt"; fi
[ "$cnt" = "3" ] && echo "OTP-CONCURRENCY: PASS (cap held under concurrency)" || echo "OTP-CONCURRENCY: FAIL (count=$cnt)"
