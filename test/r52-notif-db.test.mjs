// r52-notif-db.test.mjs - r52 "notifications are not clearing", the database / repo side:
//  * SQL 0293: my_pending (dashboard "N unread") = the person's inbox unread (_r23_counts), only worked out when
//    something can be unread, old count + degraded on failure; _r23_visible applies the 0261 client link view rule;
//    notification_catalog read once per layer (audit I-01), two 0078 bodies locked (audit I-06)
//  * MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard, rename-once
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = rd('supabase/migrations/0293_r52_notifications_clear.sql'), APPLY = rd('supabase/APPLY-0293.sql');
const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

await t('SQL 0293: my_pending counts the person\'s inbox (bell badge), fast path, degrades; _r23_visible has the 0261 rule', () => {
  assert.match(code, /create or replace function public\.my_pending\(\)/);
  assert.match(code, /public\._r23_counts\(v_org, v_uid\) ->> 'unread'/);
  assert.match(code, /from public\.notification_inbox_state st/);
  assert.match(code, /n\.created_at > v_seen/);
  assert.match(code, /v_degraded := true/);
  assert.match(code, /is_platform_operator\(\)/);
  assert.match(code, /create or replace function public\._r23_visible\(p_org uuid, p_uid uuid\)/);
  assert.match(code, /with me as materialized \(/);
  assert.match(code, /'client_link_viewed', 'client_view_followup'/);
  assert.match(code, /\(n\.detail -> 'notify'\) \? p_uid::text/);
  assert.match(code, /alter function public\._r23_visible\(uuid, uuid\) rename to _r23_visible__pre0293/);
  assert.match(code, /alter function public\.my_pending\(\) rename to my_pending__pre0293/);
  assert.match(code, /revoke all on function public\.my_pending__pre0293\(\) from authenticated/);
  assert.match(code, /revoke all on function public\._r23_visible__pre0293\(uuid, uuid\) from authenticated/);
  assert.match(code, /STOP 0293:/);
});

await t('SQL 0293: catalog read once per layer (audit I-01) - plpgsql top body, offset 0 layers, I-06 revokes', () => {
  assert.match(code, /returns jsonb language plpgsql immutable security definer set search_path = '' as \$b\$/);
  assert.match(code, /declare c jsonb := public\.notification_catalog__pre0285\(\);/);
  assert.match(code, /alter function public\.notification_catalog\(\) rename to notification_catalog__pre0293/);
  assert.match(code, /\\1 offset 0 \/\* r52-notif-0293: worked out once \*\/\) x/);
  assert.match(code, /'public\.notification_catalog__pre0078\(\)', 'public\.notification_type_of__pre0078\(text, text\)'/);
  assert.match(APPLY, /'14 notification_catalog is the 0293 plpgsql body/);
});

await t('SQL 0293: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0293_r52_notifications_clear\.sql$/m);
  assert.ok(man.indexOf('0292_r47_my_pending_speed.sql') < man.indexOf('0293_r52_notifications_clear.sql'), '0293 after 0292');
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r52-notif-clear-0293" "R52-NOTIF-CLEAR-0293: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r52-notif-clear-0293\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0292'(, '0[23]\d\d')*, '0293'(, '0[23]\d\d')*\]/, f);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 16, 'VERIFY rows');
  for (const s of [SQL, APPLY, rd('tests/db/r52-notif-clear-0293.sql')]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index|trigger)\b/i, 'no drops');
  assert.doesNotMatch(code, /\b(delete\s+from|update\s+public\.|insert\s+into|truncate)\b/i, 'no data touched');
  assert.doesNotMatch(APPLY, /create\s+temp|pg_temp/i, 'no temp tables / session state in the paste file');
  assert.match(rd('package.json'), /node test\/r52-notif-db\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0293.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

console.log(`r52-notif-db: ${n} test(s) passed.`);
