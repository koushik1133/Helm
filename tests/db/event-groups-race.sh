#!/usr/bin/env bash
# event-groups-race.sh — two people click "Create event group" for the same quote at the
# same moment (0035). Session A creates the group and holds its transaction open; session
# B's create must wait for A, then return A's group — never a second group or a second card.
set -uo pipefail
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"; export LC_ALL=C LANG=C
Q='a0000000-0000-4000-8000-0000000e0077'; O='a0000000-0000-4000-8000-000000000001'
login() { echo "select auth.login_as((select id from auth.users where email='$1'));"; }
cleanup() { psql -q >/dev/null 2>&1 <<SQL
select auth.login_as((select id from auth.users where email='a_admin@a.test')); reset role;
delete from public.chat_conversations where quote_id = '$Q';
delete from public.audit_log where action = 'chat.event_group.create' and quote_id = '$Q';
delete from public.leads where quote_id = '$Q';
delete from public.quotes where id = '$Q';
SQL
}
cleanup
psql -q -v ON_ERROR_STOP=1 -c "insert into public.quotes(id,code,title,status,client,pricing,current_version,org_id,created_at,updated_at)
  values ('$Q','RACE-01','Race test','confirmed','{\"name\":\"Racer\"}','{\"subtotal\":1000,\"discount\":0,\"gstPct\":18,\"total\":1180}',1,'$O',now(),now());" >/dev/null 2>&1
OUTA="$(mktemp)"
( psql -q -t -A -v ON_ERROR_STOP=1 >"$OUTA" 2>&1 <<SQL
begin;
$(login a_staff@a.test)
select 'A=' || public.create_event_group('$Q', null);
select pg_sleep(2);
commit;
SQL
) & APID=$!
sleep 0.6
S=$(date +%s.%N)
B=$(psql -q -t -A -v ON_ERROR_STOP=1 2>&1 <<SQL
$(login a_admin@a.test)
select 'B=' || public.create_event_group('$Q', null);
SQL
)
E=$(date +%s.%N); wait $APID
W=$(echo "$E - $S" | bc)
A_ID=$(grep -o 'A=[0-9a-f-]*' "$OUTA" | cut -d= -f2); B_ID=$(echo "$B" | grep -o 'B=[0-9a-f-]*' | cut -d= -f2); rm -f "$OUTA"
groups=$(psql -q -t -A -c "select count(*) from public.chat_conversations where quote_id='$Q';")
cards=$(psql -q -t -A -c "select count(*) from public.chat_messages m join public.chat_conversations c on c.id=m.conversation_id where c.quote_id='$Q' and m.meta->>'kind'='event';")
echo "EVENT-GROUP-RACE: B waited ${W}s; A=$A_ID B=$B_ID groups=$groups cards=$cards"
cleanup
if [ -n "$A_ID" ] && [ "$A_ID" = "$B_ID" ] && [ "$groups" = "1" ] && [ "$cards" = "1" ]; then
  echo "EVENT-GROUP-RACE: PASS (one group, one card under concurrency)"
else
  echo "EVENT-GROUP-RACE: FAIL"
fi
