// fetchall-and-bell-read.test.mjs — D4 (lists never silently truncate), D9 (shelf filter on fallbacks),
// A4 (chat read-state re-lights on a NEW message), L2 (minus-sign hint). Pure Node, vm + source checks.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const fnSrc = (name) => { const at = api.indexOf('async function ' + name + '('); let i = api.indexOf('{', at), d = 0;
  for (; i < api.length; i++) { if (api[i] === '{') d++; else if (api[i] === '}' && --d === 0) return api.slice(at, i + 1); } throw new Error(name); };

const load = () => { const warns = []; const ctx = { console: { warn: (m) => warns.push(m) } };
  vm.runInNewContext(fnSrc('fetchAll') + '\nglobalThis.fetchAll = fetchAll;', ctx); return { fetchAll: ctx.fetchAll, warns }; };
// a fake query: build() returns an object whose .range(a,b) resolves to the slice of `total` rows
const source = (total) => { const calls = []; return { calls, build: () => ({ range: async (a, b) => { calls.push([a, b]);
  return { data: Array.from({ length: Math.max(0, Math.min(total, b + 1) - a) }, (_, i) => ({ id: a + i })), error: null }; } }) }; };

t('fetchAll walks 1000-row pages past the PostgREST cap and stops on a short page', async () => {
  const { fetchAll } = load(); const s = source(2500);
  const rows = await fetchAll(s.build); assert.equal(rows.length, 2500);
  assert.deepEqual(JSON.parse(JSON.stringify(s.calls)), [[0, 999], [1000, 1999], [2000, 2999]]);
});
t('fetchAll: exact multiple needs one extra empty page; empty list is []', async () => {
  const { fetchAll } = load(); assert.equal((await fetchAll(source(1000).build)).length, 1000);
  assert.equal((await fetchAll(source(0).build)).length, 0);
});
t('fetchAll: hard cap warns instead of looping forever; errors are thrown', async () => {
  const { fetchAll, warns } = load(); const rows = await fetchAll(source(50000).build, 1000, 3000);
  assert.equal(rows.length, 3000); assert.equal(warns.length, 1);
  await assert.rejects(fetchAll(() => ({ range: async () => ({ data: null, error: new Error('boom') }) })), /boom/);
});
t('D4: the unpaginated reads use fetchAll', () => {
  for (const re of [/fetchAll\(\(\) => supa\.from\("leads"\)/, /fetchAll\(\(\) => supa\.from\("crew_members"\)/, /fetchAll\(\(\) => supa\.from\("vendors"\)/,
    /fetchAll\(\(\) => \{ let q = supa\.from\("inventory_items"\)/, /fetchAll\(\(\) => supa\.from\("event_tasks"\)\s*\.select\("crew_id,assignee_name/,
    /fetchAll\(\(\) => supa\.from\("event_tasks"\)\.select\("category,status,verify_status/, /fetchAll\(\(\) => supa\.from\("inventory_checkouts"\)/])
    assert.match(api, re, String(re));
});
t('D9: quotes fallback list and byIds hide archived / deleted rows (guarded by isMissingColumn)', () => {
  assert.match(api, /select\("\*"\)\.is\("archived_at", null\)\.is\("deleted_at", null\)/);
  assert.match(api, /select\(QUOTE_LIST_COLS\)\.in\("id", a\)\.is\("archived_at", null\)\.is\("deleted_at", null\)/);
  assert.match(api, /if \(r\.error && isMissingColumn\(r\.error\)\) r = await supa\.from\("quotes"\)\.select\("\*"\)\.in\("id", a\)/);
});
t('A4: chat read key includes the last message; Mark all read clears chat rows', () => {
  assert.match(api, /n\.__chat \? "c:" \+ \(n\.conversation_id \|\| i\) \+ "@" \+ \(n\.msg_id \|\| n\.created_at \|\| ""\)/);
  assert.match(api, /chatItems\.forEach\(\(c\) => \{ const k = "c:" \+ c\.conversation_id \+ "@"/);
  assert.match(api, /rk: "c:" \+ \(n\.conversation_id \|\| ""\) \+ "@"/);
});
t('L2: stripping a minus shows a hint (BPUI.toast or aria-live fallback)', () => {
  assert.match(api, /if \(!allowNeg && v\.indexOf\("-"\) !== -1\) negHint\(\);/);
  assert.match(api, /if \(!allowNeg && n < 0\) \{ n = 0; negHint\(\); \}/);
  assert.match(api, /aria-live", "polite"/);
});

for (const [name, fn] of tests) { await fn(); n++; console.log('ok - ' + name); }
console.log(`\nfetchall-and-bell-read: ${n} passed`);
