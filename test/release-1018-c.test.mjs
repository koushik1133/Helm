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
// release 1018-c = these (frozen); migrations written after it (0212 trial client e-mail, ...) have their own paste file
const RELEASE = ['0206', '0207', '0208', '0236', '0237'];
const after = nums.filter((n) => +n > 205);
const fresh = after.filter((n) => RELEASE.includes(n));
t('MANIFEST: each migration number once; the new ones are 0206, 0207, 0208, 0236, 0237 in numeric order', () => {
  assert.equal(new Set(nums).size, nums.length, 'duplicate migration number');
  assert.deepEqual(fresh, RELEASE);
  assert.deepEqual([...after].sort(), after, 'every migration after 0205 in numeric order');
  for (const n of after.filter((x) => !RELEASE.includes(x))) assert.ok(read(`supabase/APPLY-${n}.sql`).length > 0, n + ': own paste file');
  assert.equal(nums.indexOf('0205'), nums.indexOf('0206') - 1, '0206 right after 0205');
  assert.deepEqual(nums.filter((n) => +n > 205), [...nums.filter((n) => +n > 205)].sort(), 'later migrations in numeric order too');
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
t('0208: widens quotes_deleted_reason_chk to a superset only (no row written / deleted), APPLY verbatim, DB suite registered', () => {
  const m = read('supabase/migrations/0208_quote_deleted_reason_auto_draft.sql'), a = read('supabase/APPLY-0208.sql');
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(m), 'ASCII');
  assert.ok(!/^\s*(update|delete|truncate|insert)\b/im.test(m), 'no row written');
  assert.match(m, /if v_def is not null and v_def like '%''auto_empty_draft''%' then\s*return;/, 'skips when already widened');
  assert.match(m, /unnest\(v_vals \|\| array\['manual', 'link_expired', 'auto_empty_draft'\]\)/, 'superset of the live values');
  assert.match(m, /\) not valid', v_list\);/); assert.match(m, /^alter table public\.quotes validate constraint quotes_deleted_reason_chk;$/m);
  assert.ok(a.includes(m.trim()), 'APPLY carries the migration'); assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /run "empty-draft-0208" "EMPTY-DRAFT-0208: ALL PASS \\\(13\/13\\\)" psql -q -f tests\/db\/empty-draft-0208\.sql/);
});
let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`release-1018-c: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
