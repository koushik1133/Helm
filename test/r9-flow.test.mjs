// r9: quote-creation title placeholder (guessed vs issued code) stays "automatic" so
// TYPE_LOC_GUESTS_DDMMMYY naming applies; server sentences (22023/42501) surface in toasts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const N = require('../public/event-name.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('stale guessed code title (-01 while code is -02) is still auto', () => {
  assert.equal(N.isAuto('10092026-01', '10092026-02'), true);
  assert.equal(N.isAuto('10092026-02', '10092026-02'), true);
  assert.equal(N.isAuto('My big wedding', '10092026-02'), false);
  assert.equal(N.isAuto('2026-10-09', 'x'), false);
});
t('naming edge cases', () => {
  assert.equal(N.format({ eventType: 'Wedding', guests: 0, eventDate: '' }), 'WED');
  assert.equal(N.format({ eventType: '', city: 'Hyderabad', guests: 300 }), 'HYD_300');
  assert.equal(N.format({}), '');
  assert.equal(N.unique('WED_HYD', ['WED_HYD']), 'WED_HYD-2');
  assert.equal(N.unique('WED_HYD', ['WED_HYD', 'WED_HYD-2']), 'WED_HYD-3');
});

// friendlyError, evaluated from the shipped source with a minimal global
const S = read('public/store-api.js');
const a = S.indexOf('  function errCode(e)'), b = S.indexOf('/* ------------------------------------------------------------- toasts */');
assert.ok(a > 0 && b > a);
const fe = new Function('global', 'navigator', S.slice(a, b) + '\nreturn friendlyError;')({}, { onLine: true });
t('closure re-open: server sentence shown, not a generic retry line', () => {
  assert.equal(fe({ code: '22023', message: 'This event is not closed.' }, { action: 're-open the event' }), 'Couldn’t re-open the event. This event is not closed.');
  assert.match(fe({ code: '42501', message: 'Only an admin can re-open a closed event.' }, { action: 're-open the event' }), /Only an admin/);
  assert.match(fe({ code: '42501', message: 'not authorized' }, { action: 'x' }), /permission/);
  assert.match(fe({ code: '22023', message: 'invalid input syntax for column foo' }, {}), /Something went wrong/);
});
t('pages bumped', () => {
  for (const p of ['quotes.html', 'dashboard.html', 'closure.html', 'flow.html']) {
    const h = read('public/' + p);
    assert.match(h, /store-api\.js\?v=159/, p);
  }
});
console.log(`r9-flow: ${n} passed`);

// ---- r9 P0: flow autosave (debounce / serialize / badge) with fake timers + DOM stub ----
const A = require('../public/flow-autosave.js');
function fakeTimers() { let id = 0; const m = new Map();
  return { setTimeout: (f) => { m.set(++id, f); return id; }, clearTimeout: (i) => m.delete(i),
    fire() { const fs = [...m.values()]; m.clear(); fs.forEach((f) => f()); }, size: () => m.size }; }
const tick = () => new Promise((r) => setTimeout(r, 0));
const at = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
await at('debounce: many inputs → one save after the delay', async () => {
  const T = fakeTimers(); let calls = 0; const states = [];
  const as = A.create({ ...T, save: { client: async () => { calls++; } }, badge: (s, st) => states.push(st) });
  as.schedule('client'); as.schedule('client'); as.schedule('client');
  assert.equal(T.size(), 1); assert.equal(calls, 0); assert.equal(as.pending(), true);
  T.fire(); await as.flush();
  assert.equal(calls, 1); assert.deepEqual(states, ['saving', 'saved']); assert.equal(as.pending(), false);
});
await at('serialize: no overlapping writes', async () => {
  let live = 0, max = 0; const slow = async () => { live++; max = Math.max(max, live); await tick(); await tick(); live--; };
  const as = A.create({ ...fakeTimers(), save: { client: slow, venue: slow, proposal: slow } });
  as.now('client'); as.now('venue'); as.now('proposal'); as.now('client');
  await as.flush(); assert.equal(max, 1);
});
await at('failure → "Not saved — retry", retry → saved; invalid → inline reason, no throw', async () => {
  let fail = true; const states = [];
  const as = A.create({ ...fakeTimers(), save: { client: async () => { if (fail) throw new Error('net'); }, menu: async () => ({ invalid: 'Enter a valid phone' }) },
    badge: (s, st, m) => states.push(s + ':' + st + (typeof m === 'string' ? ':' + m : '')) });
  assert.equal(await as.now('client'), false); assert.equal(as.hasFailed(), true);
  fail = false; assert.equal(await as.now('client'), true); assert.equal(as.hasFailed(), false);
  assert.equal(await as.now('menu'), false);
  assert.deepEqual(states, ['client:saving', 'client:error', 'client:saving', 'client:saved', 'menu:saving', 'menu:invalid:Enter a valid phone']);
});
t('badge paint: hidden by default, text + clickable only on error', () => {
  const attrs = {}; const cls = new Set();
  const el = { dataset: {}, textContent: '', classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] };
  A.paint(el, 'saving'); assert.equal(el.textContent, 'Saving…'); assert.ok(cls.has('on')); assert.ok(!cls.has('bad'));
  A.paint(el, 'error'); assert.equal(el.textContent, 'Not saved — retry'); assert.equal(attrs.role, 'button'); assert.ok(cls.has('bad'));
  A.paint(el, 'saved'); assert.equal(el.textContent, 'Saved ✓'); assert.equal(attrs.role, undefined);
});
t('flow.html wiring: badges start empty, autosave sections, beforeunload uses unsaved(), quotation stays explicit', () => {
  const h = read('public/flow.html');
  assert.doesNotMatch(h, /id="sv-\w+"[^>]*>Saved ✓</);
  assert.match(h, /flow-autosave\.js\?v=1/);
  assert.match(h, /client:\(\)=>saveClient\(true\), discovery:saveDiscovery, venue:saveVenue, menu:saveMenuNotes, proposal:saveProposal/);
  assert.match(h, /beforeunload",\(e\)=>\{ if\(unsaved\(\) && !leaving\)/);
  assert.match(h, /if\(AS\) await AS\.flush\(\)/);
  assert.doesNotMatch(h, /save:\{[^}]*quote/);
});
console.log(`r9-flow: ${n} passed (total)`);
t('suspended / trial-ended studio: create shows read-only reason', () => {
  assert.match(fe({ code: '25006', hint: 'studio_suspended', message: "Read-only: this studio's Helm subscription is suspended — contact Helm" }, { action: 'create the quote' }), /^Couldn’t create the quote\. This studio is read-only/);
});
t('nurture: existing invalid phone rows are flagged', () => assert.match(read('public/nurture.html'), /BPStore\.staff\.phoneInvalid\(n\)\?'<span class="due badphone"/));
console.log(`r9-flow: ${n} passed (total)`);
{
  const a2 = S.indexOf('  function inRange(date, r)'), b2 = S.indexOf('d >= r.from && d <= r.to; }', a2) + 27;
  const inRange = new Function(S.slice(a2, b2) + '\nreturn inRange;')();
  const off = -new Date('2026-09-30T20:00:00Z').getTimezoneOffset();   // minutes east of UTC
  t('insights range: UTC timestamps use the local calendar day (IST month boundary)', () => {
    const oct = { from: '2026-10-01', to: '2026-10-31' }, sep = { from: '2026-09-01', to: '2026-09-30' };
    assert.equal(inRange('2026-10-01', oct), true);              // plain dates untouched
    assert.equal(inRange('2026-09-30', oct), false);
    if (off >= 240) { assert.equal(inRange('2026-09-30T20:00:00+00:00', oct), true); assert.equal(inRange('2026-09-30T20:00:00Z', sep), false); }
    else assert.equal(inRange('2026-09-30T12:00:00Z', sep), true);
    assert.equal(inRange('', oct), false); assert.equal(inRange('x', null), true);
  });
  t('reports: "today" is the local day', () => assert.doesNotMatch(read('public/reports.html'), /new Date\(\)\.toISOString\(\)\.slice\(0,10\)/));
}
console.log(`r9-flow: ${n} passed (total)`);
