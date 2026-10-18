// Quote NAME follows TYPE_CITY_GUESTS_DATE (auto) until the user types their own; quotes.code stays the Ref.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../public/event-name.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('type codes for every event type (incl. UAE)', () => {
  const want = { Gala: 'GAL', Iftar: 'IFT', Exhibition: 'EXH', Henna: 'HEN', 'National Day': 'NAT', Eid: 'EID', Conference: 'CONF',
    Corporate: 'CORP', Concert: 'CON', Birthday: 'BDAY', Engagement: 'ENG', Sangeet: 'SAN', Mehendi: 'MEH', Haldi: 'HAL',
    Reception: 'REC', Political: 'POL', 'Political rally': 'POL', 'Product launch': 'LAUNCH', Festival: 'FEST', Wedding: 'WED' };
  for (const [k, v] of Object.entries(want)) assert.equal(N.typeCode(k), v, k);
});
t('format per type', () => {
  assert.equal(N.format({ eventType: 'Political', city: 'Hyderabad', guests: 5000, eventDate: '2026-10-06' }), 'POL_HYD_5000_06OCT26');
  assert.equal(N.format({ eventType: 'Wedding', city: 'Hyderabad', guests: 300, eventDate: '2026-12-28' }), 'WED_HYD_300_28DEC26');
  assert.equal(N.format({ eventType: 'National Day', city: 'Dubai', guests: 800, eventDate: '2026-12-02' }), 'NAT_DXB_800_02DEC26');
  assert.equal(N.format({ eventType: 'Product launch', city: 'Mumbai' }), 'LAUNCH_MUM');
});
t('live update on event type change: an automatic name follows the new type', () => {
  const q = { code: '10062026-09', title: '10062026-09', eventType: 'Wedding', client: { city: 'Hyderabad', guests: 5000, eventDate: '2026-10-06' } };
  assert.equal(N.displayName(q), 'WED_HYD_5000_06OCT26');
  q.eventType = 'Political'; assert.equal(N.displayName(q), 'POL_HYD_5000_06OCT26');
  q.title = 'WED_HYD_5000_06OCT26'; assert.equal(N.isAuto(q.title, q.code), true); assert.equal(N.displayName(q), 'POL_HYD_5000_06OCT26');
  assert.equal(N.isAuto('LAUNCH_HYD_06OCT26', 'x'), true); assert.equal(N.isAuto('CONF', 'x'), true);
});
t('manual name sticks', () => {
  const q = { code: '10062026-09', title: 'Reddy campaign launch', eventType: 'Political', client: { city: 'Hyderabad' } };
  assert.equal(N.isAuto(q.title, q.code), false); assert.equal(N.displayName(q), 'Reddy campaign launch');
  assert.equal(N.isAuto('SHARMA_WEDDING', 'x'), false); assert.equal(N.isAuto('VIP', 'x'), false);
  // date-number codes and bare numbers are automatic
  assert.equal(N.isAuto('10062026-09', 'x'), true); assert.equal(N.isAuto('5000', 'x'), true);
});
t('reset to auto + validation', () => {
  const f = read('public/flow.html');
  assert.match(f, /id="qNameReset"[^>]*>Reset to auto name</);
  assert.match(f, /e\.key==="Enter"[\s\S]{0,80}finish\(true\)[\s\S]{0,80}e\.key==="Escape"[\s\S]{0,80}finish\(false\)/);
  assert.match(f, /\["c_type","c_date","c_city","c_guests"\]\.forEach[\s\S]{0,120}renderName/);
  assert.equal(N.validateName('  '), "The name can't be empty.");
  assert.ok(N.validateName('x'.repeat(81))); assert.equal(N.validateName('x'.repeat(80)), '');
  assert.equal(N.HINT, 'Auto name: TYPE_CITY_GUESTS_DATE — type your own to customise');
  const b = read('public/builder.html'); assert.match(b, /id="projNameReset"[^>]*>Reset to auto name</);
  assert.match(read('public/builder.js'), /pn\.value=quoteDisplayName\(q\)/);
});
t('list / header display: name first, code as Ref chip', () => {
  assert.equal(N.displayName({ code: '10062026-09', title: '' }), '10062026-09');
  const ql = read('public/quotes.html'); assert.match(ql, /<span class="refchip"[^>]*>\$\{esc\(x\.code\)\}<\/span>/); assert.match(ql, /esc\(qName\(x\)\)/);
  const d = read('public/dashboard.html'); assert.match(d, /<b>\$\{esc\(qName\(s\)\)\}<\/b><\/a> <span class="refchip"/);
  assert.match(read('public/event.html'), /HelmEventName\.displayName\(ev\)/);
  const f = read('public/flow.html'); assert.match(f, /\$\("#code"\)\.textContent="Ref "\+/); assert.match(f, /<h2 id="qName"/);
  for (const p of ['flow', 'quotes', 'dashboard', 'event', 'builder']) assert.match(read('public/' + p + '.html'), /event-name\.js\?v=9/, p);
});
console.log('quote-naming: ' + n + ' passed');
