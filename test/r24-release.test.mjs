// r24-release.test.mjs - the release/r24-staging train:
//  * supabase/APPLY-R24.sql is current (generator --check); PRECHECK (R23 applied, else STOP naming
//    APPLY-R23-STAGING.sql) first; one section per R24 migration (0268, 0269) in MANIFEST order, each paste file
//    verbatim in its own begin / commit; ends with ONE combined VERIFY grid
//  * pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE / DELETE FROM
//  * R24 DB suites in run-all.sh after the R23 ones; generator --check in npm run ci
//  * Automations page: the R23 rows call the real R23 settings RPCs (which exist in 0261 / 0262 / 0264 / 0266) and link
//    to the Control Center sections that hold those cards
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const { R24 } = await import(root + 'scripts/gen-apply-r24.mjs');
const REL = read('supabase/APPLY-R24.sql');

t('R24 set = 0268 0269, in MANIFEST order, after every R23 migration', () => {
  assert.deepEqual(R24, ['0268', '0269']);
  const nums = [...read('supabase/migrations/MANIFEST').matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.deepEqual(nums.filter((n) => R24.includes(n)), R24);
  for (const n of ['0257', '0261', '0262', '0263', '0264', '0265', '0266']) assert.ok(nums.indexOf(n) < nums.indexOf('0268'), n + ' before 0268');
});
t('APPLY-R24.sql is current', () => {
  const r = spawnSync(process.execPath, ['scripts/gen-apply-r24.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
t('PRECHECK first: one marker per R23 migration, STOP names APPLY-R23-STAGING.sql, read-only', () => {
  const pre = REL.slice(0, REL.indexOf('-- RELEASE SECTION 01/'));
  assert.ok(pre.includes('STOP r24 PRECHECK') && pre.includes('Paste APPLY-R23-STAGING.sql first'));
  for (const [n, marker] of [['0257', "to_regprocedure('public.tg_r23_org_identity_lock()')"], ['0261', "to_regclass('public.client_link_views')"],
    ['0262', "to_regclass('public.quote_validity')"], ['0263', "to_regclass('public.quote_stage_transitions')"],
    ['0264', "to_regclass('public.payment_schedule_settings')"], ['0265', "to_regclass('public.crew_availability')"],
    ['0266', "to_regclass('public.notification_inbox_state')"]]) {
    assert.ok(pre.includes(marker + ' is null then m := m || \'' + n), n + ' marker');
    const mig = read('supabase/migrations/MANIFEST').match(new RegExp('^forward  (supabase/migrations/' + n + '_\\S+)', 'm'))[1];
    const obj = marker.match(/public\.(\w+)/)[1];
    assert.match(read(mig), new RegExp('create (or replace function|table if not exists) public\\.' + obj + '\\b'), n + ' creates ' + obj);
  }
  const block = pre.slice(pre.indexOf('do $$'));
  assert.ok(!/\b(insert|update|delete|create|alter|drop|grant|revoke)\b/i.test(block.replace(/raise exception[^;]*;/i, '')), 'precheck is read-only');
});
t('one section per migration, in order, verbatim; ONE combined VERIFY last', () => {
  const heads = [...REL.matchAll(/^-- RELEASE SECTION (\d+)\/(\d+): (\S+)\n-- In plain words: \S/gm)].map((m) => m[3]);
  assert.deepEqual(heads, R24.map((n) => `APPLY-${n}.sql`));
  for (const n of R24) assert.ok(REL.includes(read(`supabase/APPLY-${n}.sql`).replace(/\s*$/, '\n')), n + ' verbatim');
  assert.equal((REL.match(/^begin;$/gm) || []).length, R24.length);
  assert.equal((REL.match(/^commit;$/gm) || []).length, R24.length);
  assert.match(REL, /-- COMBINED VERIFY[^\n]*\n-- #+\nselect item, ok from \(\n[\s\S]*\n\) z order by item;\n$/);
  for (const n of R24) assert.ok(REL.includes(`select '${n} ' || item as item, ok from (values`), n + ' VERIFY rows in the grid');
});
t('pasteable: ASCII, no psql meta-command, no temp table, no DROP TABLE / TRUNCATE / DELETE FROM', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(REL), 'ASCII');
  assert.ok(!/^\s*\\/m.test(REL), 'psql meta');
  assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(REL), 'temp table');
  assert.ok(!/^\s*(drop\s+table|truncate|delete\s+from)\b/im.test(REL), 'drop table / truncate / delete');
  assert.ok(!/^\s*set\s+(session\s+)?(role|search_path|statement_timeout)\s*(=|to)\s[^\n]*;\s*$/im.test(REL), 'no session SET statement');
});
t('DB suites in run-all.sh (R24 after R23); generator --check in npm run ci; test in npm test', () => {
  const ra = read('scripts/db-test/run-all.sh');
  const at = (s) => { const m = ra.search(new RegExp('^run "' + s + '" ', 'm')); assert.ok(m >= 0, s); return m; };
  const last23 = Math.max(...['r23-studio-name-0257', 'r23-link-views-0261', 'r23-quote-validity-0262', 'r23-state-machine-0263', 'r23-payment-schedules-0264', 'r23-crew-0265', 'r23-inbox-0266'].map(at));
  assert.ok(at('r24-stock-0268') > last23 && at('r24-automation-0269') > at('r24-stock-0268'));
  const pk = JSON.parse(read('package.json')).scripts;
  assert.match(pk.ci, /node scripts\/gen-apply-r23-staging\.mjs --check && node scripts\/gen-apply-r24\.mjs --check/);
  for (const f of ['r24-plain-words', 'r24-resources', 'r24-stock-flow', 'r24-automation', 'r24-release']) assert.ok(pk.test.includes(`node test/${f}.test.mjs`), f);
});
t('Automations (r25 0274): R23 rows switch through automation_switch into the R23 settings, and open the sections holding their cards', async () => {
  const win = {};
  vm.runInNewContext(read('public/automations.js'), { window: win, document: {}, location: { origin: 'https://helm.events' } });
  const reg = win.HelmAutomations.registry();
  const by = Object.fromEntries(reg.map((x) => [x.key, x]));
  const s274 = read('supabase/migrations/0274_automations_optin.sql');
  for (const [key, store, hash] of [['viewed_alert', 'client_view_settings', '#notifications'], ['quote_expiry_client', 'quote_validity', '#client-links'],
    ['quote_expiry_team', 'quote_validity', '#client-links'], ['overdue_bell', 'payment_schedule_settings', '#payment-schedules'],
    ['inbox_email', 'inbox_settings', '#notifications'], ['crew_shifts', "'crew'", '#crew']]) {
    assert.equal(by[key].hash, hash, key + ' settings link');
    assert.match(read('public/control-split.js'), new RegExp('hash:"' + hash + '"'), hash + ' is a Control Center section');
    assert.ok(s274.includes("'" + key + "'") && s274.includes(store), key + ' is switched where ' + store + ' lives');
  }
  // the R23 cards keep their details but no second on / off (one place)
  assert.ok(!/followup_enabled: fe/.test(read('public/link-views.js')), 'link views card: no on / off');
  assert.ok(!/overdue_bell:/.test(read('public/payment-schedule-settings.js')), 'payment schedules card: no on / off');
  assert.ok(!/email_enabled: on/.test(read('public/inbox-settings.js')), 'inbox card: no on / off');
  assert.ok(!/notifyShifts: nt/.test(read('public/crew-shifts.js')), 'crew card: no on / off');
});
t('Control Center: 19 sections incl. R23 Payment schedules / Crew and R24 Automations', () => {
  const cs = read('public/control-split.js');
  for (const k of ['payments', 'crew', 'automations']) assert.match(cs, new RegExp('\\{key:"' + k + '"'), k);
  assert.match(cs, /if\(id==="pstCard"\) return "payments";\s*if\(id==="autoCard"\|\|id==="rsrCard"\|\|id==="enqCard"\) return "automations";/);
});
let pass = 0;
for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`r24-release: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
