#!/usr/bin/env bash
# =============================================================================
# SEC-05/06/07 behaviour + concurrency tests — STAGING ONLY.
#
#   STAGING_DB_URL='postgresql://postgres:<pw>@db.xizehqgeyjcfpzrdymly.supabase.co:5432/postgres' \
#     bash supabase/security-fix/staging-tests/run-staging-tests.sh
#
# Use the DIRECT connection (port 5432), not the transaction pooler.
# Refuses to run against the production project (nqltzgiwznphugcfhmbm).
# Creates fixtures in two dedicated test studios (ids ee5ec07e-…) and deletes
# every row it created at the end (also on failure). Concurrency tests use
# genuinely separate sessions. Needs: psql, bash.
# =============================================================================
set -u
URL="${STAGING_DB_URL:-}"
[ -n "$URL" ] || { echo "set STAGING_DB_URL"; exit 2; }
case "$URL" in *nqltzgiwznphugcfhmbm*) echo "REFUSING: this is the PRODUCTION project"; exit 3;; esac
case "$URL" in *xizehqgeyjcfpzrdymly*) ;; *) [ "${ALLOW_NON_STAGING:-}" = 1 ] || { echo "REFUSING: URL is not the staging project (xizeh…)"; exit 3; };; esac

PSQL=(psql "$URL" -X -q -At -v ON_ERROR_STOP=1)
PASS=0; FAIL=0
ok()   { echo "PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL  $1  ${2:-}"; FAIL=$((FAIL+1)); }
q()    { "${PSQL[@]}" -c "$1" 2>&1; }
expect(){ # name, sql, expected-output
  local out; out=$(q "$2" | tail -1); [ "$out" = "$3" ] && ok "$1" || bad "$1" "(got: $out; want: $3)"; }
expect_err(){ # name, sql, error-substring
  local out; out=$(q "$2"); echo "$out" | grep -q "$3" && ok "$1" || bad "$1" "(got: $(echo "$out" | tail -1))"; }

OA=ee5ec07e-0000-4000-8000-00000000000a; OB=ee5ec07e-0000-4000-8000-00000000000b
UA=ee5ec07e-0000-4000-8000-0000000000a1; UB=ee5ec07e-0000-4000-8000-0000000000b1
UP=ee5ec07e-0000-4000-8000-0000000000a2; UO=ee5ec07e-0000-4000-8000-0000000000a3
Q1=ee5ec07e-0000-4000-8000-00000000c001; Q2=ee5ec07e-0000-4000-8000-00000000c002; Q3=ee5ec07e-0000-4000-8000-00000000c003
IT=ee5ec07e-0000-4000-8000-00000000d001; R1=ee5ec07e-0000-4000-8000-00000000e001; R2=ee5ec07e-0000-4000-8000-00000000e002
AS_A="select set_config('request.jwt.claim.sub','$UA',true), set_config('request.jwt.claims','{\"sub\":\"$UA\",\"role\":\"authenticated\"}',true); set local role authenticated;"
AS_B="select set_config('request.jwt.claim.sub','$UB',true), set_config('request.jwt.claims','{\"sub\":\"$UB\",\"role\":\"authenticated\"}',true); set local role authenticated;"
AS_P="select set_config('request.jwt.claim.sub','$UP',true), set_config('request.jwt.claims','{\"sub\":\"$UP\",\"role\":\"authenticated\"}',true); set local role authenticated;"
AS_O="select set_config('request.jwt.claim.sub','$UO',true), set_config('request.jwt.claims','{\"sub\":\"$UO\",\"role\":\"authenticated\"}',true); set local role authenticated;"
AS_ANON="select set_config('request.jwt.claims','{\"role\":\"anon\"}',true); set local role anon;"
PRICE='{"gstPct":18,"chairs":1,"chairPrice":1}'

cleanup() {
  "${PSQL[@]}" >/dev/null 2>&1 <<SQL
do \$\$ declare r record; begin
  for r in select c.table_name from information_schema.columns c join information_schema.tables t
             on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
            where c.table_schema='public' and c.column_name='org_id' and c.table_name not in ('quotes','organizations','profiles')
  loop execute format('delete from public.%I where org_id in (''$OA'',''$OB'')', r.table_name); end loop;
end \$\$;
delete from public.quotes where org_id in ('$OA','$OB');
delete from public.profiles where id in ('$UA','$UB','$UP','$UO');
delete from public.organizations where id in ('$OA','$OB');
delete from auth.users where id in ('$UA','$UB','$UP','$UO');
SQL
}
trap cleanup EXIT
cleanup   # start clean if a previous run was interrupted

echo "== fixtures (test studios A and B only)"
"${PSQL[@]}" <<SQL || { echo "fixture setup failed"; exit 1; }
insert into auth.users(id, email) values ('$UA','sec-test-a@example.invalid'),('$UB','sec-test-b@example.invalid'),('$UP','sec-test-p@example.invalid'),('$UO','sec-test-o@example.invalid');
insert into public.organizations(id, name) values ('$OA','SEC-TEST Studio A'),('$OB','SEC-TEST Studio B');
insert into public.profiles(id, org_id, role) values ('$UA','$OA','admin'),('$UB','$OB','admin'),('$UP','$OA','planner'),('$UO','$OA','operations')
  on conflict (id) do update set org_id = excluded.org_id, role = excluded.role;
insert into public.quotes(id, org_id, code, title, pricing, event_date) values
  ('$Q1','$OA','SECT-1','SEC test 1','$PRICE', current_date + 90),
  ('$Q2','$OA','SECT-2','SEC test 2','$PRICE', null),
  ('$Q3','$OA','SECT-3','SEC test 3','$PRICE', null);
insert into public.inventory_items(id, name, total_qty, org_id) values ('$IT','SEC-TEST chairs',10,'$OA');
insert into public.inventory_reservations(id, item_id, quote_id, qty, status, org_id) values
  ('$R1','$IT','$Q1',4,'reserved','$OA'), ('$R2','$IT','$Q1',4,'reserved','$OA');
SQL

echo "== SEC-06 return_reservation (qty N=4, stock 10)"
expect_err "A damaged > N refused" "begin; $AS_A select public.return_reservation('$R1', 5); commit;" "between 0 and 4"
expect     "A reservation + stock unchanged" "select status||'/'||(select total_qty from public.inventory_items where id='$IT') from public.inventory_reservations where id='$R1'" "reserved/10"
expect     "B valid return" "begin; $AS_A select (public.return_reservation('$R1', 3)).status; commit;" "returned"
expect     "B stock decremented once (10-3)" "select total_qty from public.inventory_items where id='$IT'" "7"
expect_err "C repeat return refused" "begin; $AS_A select public.return_reservation('$R1', 3); commit;" "already returned"
expect     "C no second decrement" "select total_qty from public.inventory_items where id='$IT'" "7"
expect_err "E Org B cannot return Org A reservation" "begin; $AS_B select public.return_reservation('$R2', 1); commit;" "not found"
expect     "E nothing changed" "select status||'/'||(select total_qty from public.inventory_items where id='$IT') from public.inventory_reservations where id='$R2'" "reserved/7"
tmp=$(mktemp -d)
for i in 1 2; do ("${PSQL[@]}" -c "begin; $AS_A select (public.return_reservation('$R2', 2)).status; select pg_sleep(1); commit;" >"$tmp/r$i" 2>&1) & done; wait
n_ok=$(grep -l "^returned" "$tmp"/r* | wc -l)
[ "$n_ok" = 1 ] && ok "D concurrent returns: exactly one succeeds" || bad "D concurrent returns" "(successes: $n_ok)"
expect     "D stock decremented exactly once (7-2)" "select total_qty from public.inventory_items where id='$IT'" "5"

echo "== SEC-06 invitation_preview (as anon)"
"${PSQL[@]}" -c "insert into public.invitations(org_id, email, role, token, status, expires_at, invited_by) values
  ('$OA','sec-p@example.invalid','planner', repeat('e',47)||'1','pending', now()+interval '7 days','$UA'),
  ('$OA','sec-e@example.invalid','sales',   repeat('e',47)||'2','pending', now()-interval '1 day', '$UA'),
  ('$OA','sec-c@example.invalid','sales',   repeat('e',47)||'3','accepted',now()+interval '7 days','$UA'),
  ('$OA','sec-r@example.invalid','sales',   repeat('e',47)||'4','revoked', now()+interval '7 days','$UA');" >/dev/null
pv(){ "${PSQL[@]}" -c "begin; $AS_ANON select public.invitation_preview('$1')::text; commit;" | tail -1; }
leak(){ echo "$1" | grep -qiE '"(email|id|invitation_id|org_id|invited_by|inviter|inviter_email|token)"' && echo yes || echo no; }
for c in "malformed|0000|\"valid\": false, \"status\": \"not_found\"" "nonexistent|$(printf '9%.0s' {1..48})|\"not_found\"" \
         "valid pending|$(printf 'e%.0s' {1..47})1|\"valid\": true" "expired|$(printf 'e%.0s' {1..47})2|\"expired\": true" \
         "accepted|$(printf 'e%.0s' {1..47})3|\"status\": \"accepted\"" "revoked|$(printf 'e%.0s' {1..47})4|\"status\": \"revoked\""; do
  name=${c%%|*}; rest=${c#*|}; tok=${rest%%|*}; want=${rest#*|}; out=$(pv "$tok")
  echo "$out" | grep -q "$want" && [ "$(leak "$out")" = no ] && ok "preview $name → $out" || bad "preview $name" "($out)"
done

echo "== SEC-07 G1 approval links"
expect "G1 issue: expiry = event+30d" "begin; $AS_A select public.generate_approval_token('$Q1') is not null; commit; select (approval_token_expires_at::date = current_date + 120)::text from public.quotes where id='$Q1';" "true"
t1=$(q "select approval_token from public.quotes where id='$Q1'" | tail -1)
q "update public.quotes set approval_token_expires_at = now() - interval '1 minute' where id='$Q1'" >/dev/null
expect "G1 expired link re-issued with a NEW token" "begin; $AS_A select public.generate_approval_token('$Q1') <> '$t1'; commit;" "t"
expect "G1 revoked link re-issued, flag cleared" "begin; $AS_A select public.revoke_approval_token('$Q1'); select public.generate_approval_token('$Q1') is not null; commit; select (approval_token_revoked_at is null and approval_token_expires_at > now())::text from public.quotes where id='$Q1';" "true"

echo "== SEC-07 G2 worker links"
q "insert into public.work_tokens(token, quote_id, phone, name, org_id) values ('ee5ec07e-0000-4000-8000-00000000f001','$Q1','9000000001','W','$OA')" >/dev/null
expect "G2 issue: expiry = event+14d" "select (expires_at::date = current_date + 104)::text from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001'" "true"
q "update public.work_tokens set expires_at = now() - interval '1 day' where token='ee5ec07e-0000-4000-8000-00000000f001'" >/dev/null
q "insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id) values ('$Q1','setup','SEC-T1','9000000001','assigned','$OA')" >/dev/null
expect "G2 new assignment renews link" "select (expires_at > now())::text from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001'" "true"
q "update public.work_tokens set revoked_at = now(), expires_at = now() - interval '1 day' where token='ee5ec07e-0000-4000-8000-00000000f001'" >/dev/null
q "insert into public.event_tasks(quote_id, category, title, assignee_phone, status, org_id) values ('$Q1','setup','SEC-T2','9000000001','assigned','$OA')" >/dev/null
expect "G2 revoked link NOT renewed" "select (expires_at < now())::text from public.work_tokens where token='ee5ec07e-0000-4000-8000-00000000f001'" "true"

echo "== SEC-07 G3 OTP limits under concurrency (8 simultaneous sessions)"
q "insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values
   ('$Q2','+91 90000 12345','x',now()+interval '10 min','$OA'), ('$Q2','919000012345','x',now()+interval '10 min','$OA')" >/dev/null
q "insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) select '$Q3', '71000000'||g, 'x', now()+interval '10 min', '$OA' from generate_series(10,18) g" >/dev/null
ins(){ "${PSQL[@]}" -c "begin; insert into public.quote_otps(quote_id, phone, code_hash, expires_at, org_id) values ('$1','$2','x',now()+interval '10 min','$OA'); select pg_sleep(1); commit;" >/dev/null 2>&1 && echo ok || echo refused; }
res=$(for i in 1 2 3 4 5 6 7 8; do ins "$Q2" "+91-9000012345" & done; wait)
acc=$(echo "$res" | grep -c ok)
expect "G3 phone: start 2, +$acc accepted → final 3" "select count(*) from public.quote_otps where regexp_replace(phone,'[^0-9]','','g')='919000012345' and created_at > now()-interval '1 hour'" "3"
[ "$acc" = 1 ] && ok "G3 phone: exactly 1 of 8 concurrent accepted" || bad "G3 phone accepted" "($acc)"
res=$(for i in 1 2 3 4 5 6 7 8; do ins "$Q3" "7200000$i$i" & done; wait)
acc=$(echo "$res" | grep -c ok)
expect "G3 quote: start 9, +$acc accepted → final 10" "select count(*) from public.quote_otps where quote_id='$Q3' and created_at > now()-interval '1 day'" "10"
[ "$acc" = 1 ] && ok "G3 quote: exactly 1 of 8 concurrent accepted" || bad "G3 quote accepted" "($acc)"

echo "== SEC-07 G4 quote/studio match"
expect_err "G4 cross-studio row refused" "insert into public.event_tasks(quote_id, category, title, status, org_id) values ('$Q1','setup','x','assigned','$OB')" "another studio"
expect_err "G4 unknown quote refused" "insert into public.event_tasks(quote_id, category, title, status, org_id) values ('ee5ec07e-0000-4000-8000-0000deadbeef','setup','x','assigned','$OA')" "quote not found\|foreign key"
expect "G4 deleting a quote still works (audit keeps its id)" "delete from public.quotes where id='$Q3'; select (not exists (select 1 from public.quotes where id='$Q3'))::text;" "true"

echo "== SEC-07 G5 effective default privileges (probe created and ROLLED BACK)"
expect "G5 new public function: PUBLIC/anon cannot, authenticated can" "begin; create function public.zz_sec07_probe() returns int language sql as 'select 1'; select (not has_function_privilege('anon','public.zz_sec07_probe()','EXECUTE') and has_function_privilege('authenticated','public.zz_sec07_probe()','EXECUTE') and not exists (select 1 from aclexplode((select proacl from pg_proc where oid='public.zz_sec07_probe()'::regprocedure)) a where a.grantee=0))::text; rollback;" "true"

echo "== SEC-05 authorization spot checks"
expect_err "F10 operations cannot save discovery" "begin; $AS_O select public.set_discovery('$Q1', null, null, null, null, 'x', null, null); commit;" "not authorized"
expect_err "F11 planner cannot mark paid" "begin; $AS_P select public.mark_paid('$Q1', null); commit;" "not authorized"
expect     "F11 admin can mark paid" "begin; $AS_A select (public.mark_paid('$Q1', 'sec-test') ->> 'paid'); commit;" "true"

rm -rf "$tmp"
echo "== result: $PASS passed, $FAIL failed (fixtures are removed on exit)"
[ "$FAIL" = 0 ]
