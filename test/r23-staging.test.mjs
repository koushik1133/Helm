// r23-staging.test.mjs - the release/r23-staging paste file:
//  * supabase/APPLY-R23-STAGING.sql is current (generator --check); one section per batch migration in MANIFEST order,
//    each paste file verbatim in its own begin / commit; a REQUIRE block first; ends with ONE combined VERIFY grid
//  * pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE / DELETE FROM
//  * every staging migration's DB suite is in run-all.sh; generator --check is in npm run ci; 0256 + 0260 are NOT in it
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const { R23_STAGING } = await import(root + 'scripts/gen-apply-r23-staging.mjs');
const REL = read('supabase/APPLY-R23-STAGING.sql');

t('staging set = 0257 0261 0262 0263 0264 0265 0266, in MANIFEST order; 0256 + 0260 (already applied) left out', () => {
  assert.deepEqual(R23_STAGING, ['0257', '0261', '0262', '0263', '0264', '0265', '0266']);
  const nums = [...read('supabase/migrations/MANIFEST').matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.deepEqual(nums.filter((n) => R23_STAGING.includes(n)), R23_STAGING);
  assert.ok(!/RELEASE SECTION \d+\/\d+: APPLY-02(56|60)\.sql/.test(REL));
  assert.match(REL, /STOP r23 staging: 0256/); assert.match(REL, /STOP r23 staging: 0260/);
});
t('APPLY-R23-STAGING.sql is current', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-apply-r23-staging.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
t('REQUIRE first; one section per migration, in order, verbatim; ONE combined VERIFY last', () => {
  assert.ok(REL.indexOf('STOP r23 staging: 0254') < REL.indexOf('-- RELEASE SECTION 01/'));
  const heads = [...REL.matchAll(/^-- RELEASE SECTION (\d+)\/(\d+): (\S+)\n-- In plain words: \S/gm)].map((m) => m[3]);
  assert.deepEqual(heads, R23_STAGING.map((n) => `APPLY-${n}.sql`));
  for (const n of R23_STAGING) assert.ok(REL.includes(read(`supabase/APPLY-${n}.sql`).replace(/\s*$/, '\n')), n + ' verbatim');
  assert.equal((REL.match(/^begin;$/gm) || []).length, R23_STAGING.length);
  assert.equal((REL.match(/^commit;$/gm) || []).length, R23_STAGING.length);
  assert.match(REL, /-- COMBINED VERIFY[^\n]*\n-- #+\nselect item, ok from \(\n[\s\S]*\n\) z order by item;\n$/);
  for (const n of R23_STAGING) assert.ok(REL.includes(`select '${n} ' || item as item, ok from (values`), n + ' VERIFY rows in the grid');
});
t('pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE / DELETE FROM', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(REL), 'ASCII');
  assert.ok(!/^\s*\\/m.test(REL), 'psql meta');
  assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(REL), 'temp table');
  assert.ok(!/^\s*(drop\s+table|truncate)\b/im.test(REL), 'drop table / truncate');
  // the only deletes: 0263 _r23_stage_sync replacing THIS transaction's own provisional stage-history rows (xact = txid_current())
  const dels = REL.split('\n').filter((l) => /^\s*delete\s+from\b/i.test(l));
  assert.equal(dels.length, 3, dels.join('\n'));
  for (const l of dels) assert.match(l, /^\s*delete from public\.(domain_events|quote_stage_warnings|quote_stage_transitions) \w+ where .*\bxact = v_x\b/, l);
  assert.match(REL, /v_x bigint := txid_current\(\)/);
});
t('DB suites in run-all.sh; generator --check in npm run ci', () => {
  const ra = read('scripts/db-test/run-all.sh');
  for (const s of ['r23-studio-name-0257', 'r23-link-views-0261', 'r23-quote-validity-0262', 'r23-state-machine-0263', 'r23-payment-schedules-0264', 'r23-crew-0265', 'r23-inbox-0266'])
    assert.match(ra, new RegExp('^run "' + s + '" ', 'm'), s);
  assert.match(JSON.parse(read('package.json')).scripts.ci, /node scripts\/gen-apply-r23-staging\.mjs --check/);
});
let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`r23-staging: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
