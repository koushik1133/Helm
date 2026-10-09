// Event display name: TYPE_LOC_GUESTS_DDMMMYY (public/event-name.js) + store-api wiring.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const N = require('../public/event-name.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('spec example', () => assert.equal(N.format({ eventType: 'Wedding', city: 'Hyderabad', guests: 1000, eventDate: '2026-08-19' }), 'WED_HYD_1000_19AUG26'));
t('type map + fallback', () => {
  for (const [k, v] of [['Reception', 'REC'], ['engagement', 'ENG'], ['Birthday party', 'BDY'], ['Corporate', 'COR'], ['Conference', 'CON'],
    ['Sangeet', 'SAN'], ['Haldi', 'HAL'], ['Mehendi', 'MEH'], ['Anniversary', 'ANN'], ['  ', '']]) assert.equal(N.typeCode(k), v, k);
});
t('city map + fallback', () => {
  for (const [k, v] of [['Bangalore', 'BLR'], ['Bengaluru', 'BLR'], ['Mumbai', 'MUM'], ['New Delhi', 'DEL'], ['Chennai', 'CHE'], ['Kolkata', 'KOL'],
    ['Pune', 'PUN'], ['Goa', 'GOA'], ['Hyderabad, Telangana', 'HYD'], ['Nellore', 'NEL']]) assert.equal(N.cityCode(k), v, k);
});
t('city found in venue/address text only when known', () => {
  assert.equal(N.format({ eventType: 'Wedding', address: 'Plot 4, Jubilee Hills, Hyderabad 500033', guests: 200, eventDate: '2026-12-01' }), 'WED_HYD_200_01DEC26');
  assert.equal(N.format({ eventType: 'Wedding', address: 'Some farmhouse road', guests: 200 }), 'WED_200');
});
t('missing parts are omitted', () => {
  assert.equal(N.format({ eventType: 'Haldi', eventDate: '2027-01-05' }), 'HAL_05JAN27');
  assert.equal(N.format({ city: 'Goa' }), 'GOA');
  assert.equal(N.format({ guests: 0 }), '');
  assert.equal(N.format({}), '');
  assert.equal(N.dateCode('not a date'), '');
});
t('fromQuote reads both row shapes', () => {
  assert.equal(N.fromQuote({ event_type: 'Reception', event_date: '2026-08-19', client: { city: 'Pune', guests: '350' } }), 'REC_PUN_350_19AUG26');
  assert.equal(N.fromQuote({ eventType: 'Birthday', client: { eventDate: '2026-02-03', guests: 50 } }), 'BDY_50_03FEB26');
});
t('collisions get -2, -3', () => {
  assert.equal(N.unique('WED_HYD_1000_19AUG26', []), 'WED_HYD_1000_19AUG26');
  assert.equal(N.unique('WED_HYD_1000_19AUG26', ['WED_HYD_1000_19AUG26']), 'WED_HYD_1000_19AUG26-2');
  assert.equal(N.unique('WED_HYD_1000_19AUG26', ['WED_HYD_1000_19AUG26', 'WED_HYD_1000_19AUG26-2']), 'WED_HYD_1000_19AUG26-3');
});
t('auto vs manually renamed titles', () => {
  assert.equal(N.isAuto('10082026-04', '10082026-04'), true);
  assert.equal(N.isAuto('', 'x'), true);
  assert.equal(N.isAuto('Untitled event', 'x'), true);
  assert.equal(N.isAuto('WED_HYD_1000_19AUG26-2', 'x'), true);
  assert.equal(N.isAuto('HAL', 'x'), true);
  assert.equal(N.isAuto('Sharma wedding', 'x'), false);
  assert.equal(N.isAuto('SHARMA_WEDDING', 'x'), false);
});
t('store-api applies auto title in updateMeta, never touches the code', () => {
  const s = read('public/store-api.js');
  assert.match(s, /updateMeta: async \(id, patch, expectedUpdatedAt\) => qt\(\)\.updateMeta\(id, await autoTitlePatch\(id, patch\), expectedUpdatedAt\)/);
  assert.match(s, /if \(!EN\.isAuto\(title, code\)\) return patch;/);
  assert.doesNotMatch(s.slice(s.indexOf('async function autoTitlePatch'), s.indexOf('async function autoTitlePatch') + 2500), /code:/);
});
t('event-name.js loads before store-api on every page', () => {
  const fs = require('node:fs');
  for (const p of fs.readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'))) {
    const h = read('public/' + p); const i = h.search(/store-api\.js\?v=/); if (i < 0) continue;
    const j = h.search(/event-name\.js\?v=2/); assert.ok(j >= 0 && j < i, p);
  }
});
console.log(`event-name: ${n} passed`);
