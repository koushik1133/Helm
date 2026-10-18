// Owner: inventory check-out "gives an error if the items are not there". Now: availability =
// total - open check-outs (any event) - other events' same-day reservations - repair, never < 0;
// a shortage shows who has the stock + due dates + actions (partial / check in / sub-rent / reduce /
// substitutes); the server (0105 checkout_equipment_smart) enforces it under a row lock.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const C = require('../public/checkout-shortage.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

const item = { id: 'chairs', name: 'Chiavari chairs', category: 'Seating', unit: 'pcs', total_qty: 200 };
const quotes = { X: { title: 'Event X', event_date: '2026-12-26', status: 'confirmed' }, Y: { title: 'Event Y', event_date: '2026-12-28', status: 'confirmed' },
  Z: { title: 'Event Z', event_date: '2026-12-28', status: 'confirmed' }, OLD: { title: 'Cancelled', event_date: '2026-12-28', status: 'cancelled' } };
const checkouts = [{ id: 'c1', item_id: 'chairs', quote_id: 'X', qty_out: 80, qty_in: 0, status: 'out', issued_to: 'Ravi' },
  { id: 'c2', item_id: 'chairs', quote_id: 'X', qty_out: 10, qty_in: 10, status: 'returned' },
  { id: 'c3', item_id: 'chairs', quote_id: 'X', qty_out: 30, status: 'cancelled' }];
const base = { item, quotes, checkouts, reservations: [], quoteId: 'Y', today: '2026-12-20' };

t('available = total - still-out on open check-outs (returned / cancelled ignored)', () => {
  const i = C.compute(base); assert.equal(i.out_now, 80); assert.equal(i.available, 120); assert.equal(i.in_repair, 0);
});
t('other live events\' same-day reservations (not yet out) are held back; own + cancelled + other dates are not', () => {
  const res = [{ item_id: 'chairs', quote_id: 'Z', qty: 40, status: 'reserved' }, { item_id: 'chairs', quote_id: 'Y', qty: 200, status: 'reserved' },
    { item_id: 'chairs', quote_id: 'OLD', qty: 50, status: 'reserved' }, { item_id: 'chairs', quote_id: 'X', qty: 100, status: 'reserved' }];
  const i = C.compute({ ...base, reservations: res });
  assert.equal(i.reserved_other, 40); assert.equal(i.available, 80); assert.equal(i.reserved_by[0].event, 'Event Z');
});
t('a reservation already checked out is not counted twice', () => {
  const co = checkouts.concat([{ id: 'c4', item_id: 'chairs', quote_id: 'Z', qty_out: 40, status: 'out' }]);
  const i = C.compute({ ...base, checkouts: co, reservations: [{ item_id: 'chairs', quote_id: 'Z', qty: 40, status: 'allocated' }] });
  assert.equal(i.out_now, 120); assert.equal(i.reserved_other, 0); assert.equal(i.available, 80);
});
t('never negative, repair counted', () => {
  const i = C.compute({ ...base, item: { ...item, total_qty: 50 }, inRepair: 5 }); assert.equal(i.available, 0);
  assert.equal(C.compute({ ...base, inRepair: 20 }).available, 100);
});
t('blocking check-out: event, qty, due back = day after the event, overdue flag', () => {
  const i = C.compute(base); assert.equal(i.blocking.length, 1);
  assert.deepEqual([i.blocking[0].event, i.blocking[0].qty, i.blocking[0].due_back, i.blocking[0].overdue], ['Event X', 80, '2026-12-27', false]);
  assert.equal(C.compute({ ...base, today: '2026-12-29' }).overdue.length, 1);
});
t('headline / reasons read like the owner asked', () => {
  const i = C.compute(base), f = (d) => ({ '2026-12-28': '28 Dec', '2026-12-27': '27 Dec' }[d] || d);
  assert.equal(C.headline(i, 200, f), 'Only 120 of 200 Chiavari chairs are available for 28 Dec.');
  assert.deepEqual(C.reasons(i, f), ['80 out with Event X (due back 27 Dec) - issued to Ravi']);
  assert.match(C.headline({ ...i, available: 0 }, 5, f), /^None of the 200 Chiavari chairs are available for 28 Dec\.$/);
  assert.match(C.headline(i, 150, f), /You own 200\.$/);
});
t('actions: partial / check-in (only when overdue) / sub-rent / reduce / substitutes', () => {
  const i = { ...C.compute({ ...base, today: '2026-12-29' }), substitutes: [{ item_id: 't', name: 'Tiffany chairs', available: 150 }] };
  const a = C.actions(i, 200).map((x) => x.key);
  assert.deepEqual(a, ['partial', 'checkin', 'subrent', 'reduce', 'sub']);
  assert.equal(C.actions(i, 200)[0].label, 'Check out the 120 available');
  assert.deepEqual(C.actions({ ...i, available: 0, overdue: [], substitutes: [] }, 10).map((x) => x.key), ['subrent']);
  assert.match(C.subrentNote(i, 200, (d) => d), /^Sub-rent \/ vendor: 80 Chiavari chairs for 2026-12-28 \(have 120 of 200\)$/);
});
t('substitutes: same category, free stock only, most free first', () => {
  const items = [item, { id: 't', name: 'Tiffany', category: 'Seating', total_qty: 150 }, { id: 'b', name: 'Bench', category: 'Seating', total_qty: 0 },
    { id: 'p', name: 'Plates', category: 'Crockery', total_qty: 500 }, { id: 'g', name: 'Ghost', category: 'Seating', total_qty: 400 }];
  const s = C.substitutes(items, 'chairs', (i) => i.id === 'g' ? 400 : i.total_qty);
  assert.deepEqual(s.map((x) => x.name), ['Ghost', 'Tiffany']);
});
t('server: 0105 functions are definer, empty search_path, row-locked, shortage is a structured answer', () => {
  const sql = read('supabase/migrations/0105_checkout_shortage_nurture.sql');
  assert.match(sql, /create or replace function public\.checkout_equipment_smart\(/);
  assert.match(sql, /for update;/); assert.match(sql, /'code', 'shortage'/);
  assert.match(sql, /return greatest\(v_total - v_out - v_res, 0\);/);
  assert.equal((sql.match(/security definer\s+set search_path = ''/g) || []).length, 3);
  assert.doesNotMatch(sql, /\b(delete from|drop table|truncate)\b/i);
});
t('client: inventory uses outSmart + shortage panel, partial re-call, sub-rent via stock request, no raw error', () => {
  const inv = read('public/inventory.html'), api = read('public/store-api.js');
  assert.match(api, /rpc\("checkout_equipment_smart"/); assert.match(api, /rpc\("checkout_availability"/);
  assert.match(inv, /<script src="checkout-shortage\.js\?v=4"><\/script>/);
  assert.match(inv, /outSmart\(itemId, quoteId\|\|null, qty, to, crewId, coPending\.note, false\)/);
  assert.match(inv, /outSmart\(p\.itemId, quoteId\|\|null, p\.qty, p\.to, p\.crewId, p\.note, true\)/);
  assert.match(inv, /BPStore\.stockreq\.add\(quoteId,/);
  assert.match(inv, /id="coShort" class="coshort" role="alert"/);
  assert.match(inv, /e\.code==="23514"/, 'older DB over-issue error still becomes the panel');
});
t('APPLY-0105 is ASCII and ends with verify rows', () => {
  const a = read('supabase/APPLY-0105.sql');
  assert.ok(!/[^\x00-\x7f]/.test(a)); assert.match(a, /select item, ok from \(values/); assert.match(a, /\) v\(item, ok\)\norder by item;\n$/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`\ncheckout-shortage: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
