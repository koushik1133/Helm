// release-1018-c.test.mjs - the release/1018-c paste file and migration numbering:
//  * MANIFEST: every migration number once, the new ones (after 0205 = production with 1018-b) in numeric order
//  * supabase/APPLY-RELEASE-1018-C.sql is current (generator --check), one section per new migration in order,
//    each paste file verbatim, ends with ONE combined VERIFY grid; pasteable (ASCII, no psql meta / temp table)
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

const man = read('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
const fresh = nums.filter((n) => +n > 205);
t('MANIFEST: each migration number once; the new ones are 0206, 0207, 0236, 0237 in numeric order', () => {
  assert.equal(new Set(nums).size, nums.length, 'duplicate migration number');
  assert.deepEqual(fresh, ['0206', '0207', '0236', '0237']);
  assert.deepEqual([...fresh].sort(), fresh);
  assert.equal(nums.indexOf('0205'), nums.indexOf('0206') - 1, '0206 right after 0205');
});
t('APPLY-RELEASE-1018-C.sql is current', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-apply-release-1018-c.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
t('one section per new migration, in order, each paste file verbatim; ONE combined VERIFY last', () => {
  const rel = read('supabase/APPLY-RELEASE-1018-C.sql');
  const heads = [...rel.matchAll(/^-- RELEASE SECTION (\d+)\/(\d+): (\S+)\n-- In plain words: \S/gm)].map((m) => m[3]);
  assert.deepEqual(heads, fresh.map((n) => `APPLY-${n}.sql`));
  for (const n of fresh) assert.ok(rel.includes(read(`supabase/APPLY-${n}.sql`).replace(/\s*$/, '\n')), n + ' verbatim');
  assert.equal((rel.match(/^begin;$/gm) || []).length, fresh.length);
  assert.equal((rel.match(/^commit;$/gm) || []).length, fresh.length);
  assert.match(rel, /-- COMBINED VERIFY[^\n]*\n-- #+\nselect item, ok from \(\n[\s\S]*\n\) z order by item;\n$/);
  for (const n of fresh) assert.ok(rel.includes(`select '${n} ' || item as item, ok from (values`), n + ' VERIFY rows in the grid');
});
t('pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE', () => {
  const rel = read('supabase/APPLY-RELEASE-1018-C.sql');
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(rel), 'ASCII');
  assert.ok(!/^\s*\\/m.test(rel), 'psql meta');
  assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(rel), 'temp table');
  assert.ok(!/^\s*(drop\s+table|truncate)\b/im.test(rel), 'drop table / truncate');
});
let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`release-1018-c: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
