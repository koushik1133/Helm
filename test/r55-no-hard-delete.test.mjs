// r55-no-hard-delete.test.mjs - r55 zero-data-loss: events, their history / website and the master lists the screens
// only switch off are never hard-deleted. The repo side:
//  * the app (public/*.js, edge functions) never hard-deletes a guarded table - a new .delete() on one would now fail
//    against the 0296 guard, so it must go through the shelf / deactivate instead
//  * the screens' existing hard deletes (leads, layouts, guests, ...) stay outside the guard
//  * SQL 0296: MANIFEST (numeric order) + run-all (+ the 0184 suite re-run with the mark off) + release lists,
//    APPLY verbatim + VERIFY, ASCII, additive only (no drop table / revoke / delete of rows), STOP guard
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const rd = (p) => readFileSync(join(root, p), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const SQL = rd('supabase/migrations/0296_r55_no_accidental_deletes.sql');
const APPLY = rd('supabase/APPLY-0296.sql');
const GUARDED = ['quotes', 'quote_versions', 'quotation_versions', 'event_sites', 'vendors', 'crew_members',
  'inventory_items', 'menu_templates', 'event_tasks'];
const APP_HARD_DELETES = ['leads', 'layouts', 'event_guests', 'event_attendees', 'payment_milestones', 'event_media', 'nurture'];

function files(dir, out = []) {
  for (const f of readdirSync(join(root, dir))) {
    const p = join(dir, f);
    if (f === 'vendor' || f === 'node_modules') continue;
    if (statSync(join(root, p)).isDirectory()) files(p, out);
    else if (/\.(m?js|ts|html)$/.test(f)) out.push(p);
  }
  return out;
}

t('the app and the edge functions never hard-delete a guarded table', () => {
  const bad = [];
  for (const f of [...files('public'), ...files('supabase/functions')]) {
    const src = rd(f);
    for (const m of src.matchAll(/from\(\s*["'`]([a-z_]+)["'`]\s*\)[^;]{0,160}?\.delete\(/g))
      if (GUARDED.includes(m[1])) bad.push(f + ': ' + m[1]);
  }
  assert.deepEqual(bad, []);
});
t('events are removed by the shelf RPC, vendors / staff are switched off', () => {
  const s = rd('public/store-api.js');
  assert.match(s, /async remove\(quoteId\) \{ await rpc\("move_quote_to_shelf", \{ p_quote_id: quoteId, p_shelf: "delete" \}\)/);
  assert.match(s, /supa\.from\("vendors"\)\.update\(\{ active: false \}\)/);
  assert.match(s, /supa\.from\("crew_members"\)\.update\(\{ active: false \}\)/);
});
t('0296 guards exactly the 9 tables and none of the screens\' own hard deletes', () => {
  const list = SQL.match(/foreach t in array array\[([\s\S]*?)\] loop/);
  assert.ok(list, 'table list');
  assert.deepEqual([...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), GUARDED);
  for (const x of APP_HARD_DELETES) assert.ok(!GUARDED.includes(x), x);
  assert.match(SQL, /create trigger a0_r55_org_delete_guard before delete on public\.organizations/);
  assert.match(SQL, /before truncate on public\.organizations/);
});
t('0296: marks honoured for server code only; the 0184 trial purge mark accepted as is', () => {
  assert.match(SQL, /current_user::text not in \('anon', 'authenticated'\)/);
  assert.match(SQL, /current_setting\('helm\.trial_purge_org', true\)/);
  assert.match(SQL, /alter function public\._demo_clear\(uuid\) rename to _demo_clear__pre0296/);
});
t('0296 is additive: no drop table / truncate / delete of rows / revoke of table grants / policy change', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.ok(!/\bdrop\s+(table|policy|function)\b/i.test(code), 'drop');
  assert.ok(!/^\s*(truncate|delete\s+from)\b/im.test(code), 'truncate / delete');
  assert.ok(!/revoke[^;]*on\s+(table\s+)?public\.[a-z_]+\s+from/i.test(code.replace(/revoke all on function[^;]*;/gi, '')), 'table revoke');
  assert.ok(!/\b(create|alter)\s+policy\b/i.test(code), 'policy');
  assert.match(SQL, /raise exception 'STOP 0296: /);
});
t('APPLY-0296: begin / migration verbatim / commit, VERIFY rows, ASCII, no psql meta, no temp table', () => {
  assert.ok(APPLY.includes('\nbegin;\n' + SQL), 'migration verbatim after begin');
  assert.match(APPLY, /\ncommit;\n\n-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values\n/);
  assert.equal([...APPLY.matchAll(/^ {2}\('\d\d /gm)].length, 12, '12 VERIFY rows');
  for (const s of [SQL, APPLY]) {
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), 'ASCII');
    assert.ok(!/^\s*\\/m.test(s), 'psql meta');
    assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(s), 'temp table');
  }
});
t('MANIFEST (numeric order) + run-all + release lists', () => {
  const man = rd('supabase/migrations/MANIFEST');
  const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.ok(nums.includes('0296'));
  const after = nums.filter((x) => +x > 205);
  assert.deepEqual([...after].sort(), after, 'numeric order');
  const ra = rd('scripts/db-test/run-all.sh');
  assert.match(ra, /^run "r55-no-hard-delete-0296" "R55-NO-HARD-DELETE-0296: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r55-no-hard-delete-0296\.sql$/m);
  assert.match(ra, /helm\.allow_purge=on/);
  assert.match(ra, /^run "trial-retention-0184-r55-guard" /m);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0296'/, f);
});
console.log(`r55-no-hard-delete: ${n} passed`);
