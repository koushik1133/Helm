// Page batch 2 guards (found in live testing): duplicate requirement / scope item / template,
// GSTIN format on studio settings, blank pricing rejected. Static source checks in the repo's vm-test style.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('discovery: a repeated requirement asks before adding (normalised match)', () => {
  const h = read('public/discovery.html');
  assert.match(h, /normSvc\(x\.service\)===normSvc\(service\)/);
  assert.match(h, /Already listed/);
});
t('proposal: a repeated scope item is refused with a message', () => {
  const h = read('public/proposal.html');
  assert.match(h, /is already in the scope list/);
});
t('templates: repeated lines are kept once and a twin template name asks first', () => {
  const h = read('public/templates.html');
  assert.match(h, /seenK/);
  assert.match(h, /Name already used/);
  assert.match(h, /repeated line/);
});
t('control: studio GSTIN is format-checked and pricing needs both rates', () => {
  const h = read('public/control.html');
  assert.match(h, /Enter a valid 15-character GSTIN/);
  assert.match(h, /Enter a price for both chair and plate/);
  // the GSTIN regex matches the one used at checkout
  const re = /\^\[0-9\]\{2\}\[A-Z\]\{5\}\[0-9\]\{4\}\[A-Z\]\[1-9A-Z\]Z\[0-9A-Z\]\$/;
  assert.match(h, re);
  assert.match(read('public/store-api.js'), re);
});
t('GSTIN pattern accepts a real-shaped value and rejects junk', () => {
  const re = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  assert.ok(re.test('36ABCDE1234F1Z5'));
  for (const bad of ['BADGST', '36ABCDE1234F1Z', '', '36abcde1234f1z5']) assert.ok(!re.test(bad), bad);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok  - ' + name); } catch (e) { failed++; console.log('not ok - ' + name + ': ' + (e && e.message)); }
}
console.log(`page-batch-2-guards: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
