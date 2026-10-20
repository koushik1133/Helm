// r24-stock-flow.test.mjs - r24 owner: "stock states confuse me across Inventory, Teardown & returns, Event-day command
// and Closure". ONE story per item on an event, the same words everywhere: Reserved -> Out (given to a person, who +
// when) -> Back / Missing / Damaged.
//  1  stock-flow.js (pure): check-out parts, per-event item states, the "never taken out" wording, request states,
//     per-item history, picker search
//  2  pages use it: Inventory (event view + Out & back tab + History), Teardown (one card, auto-release, Mark back with
//     OK + damaged), Event-day command (Give out = a real check-out; searchable, scrollable picker), Closure
//  3  SQL 0268 + APPLY + MANIFEST + DB suite wired (behaviour proven on Postgres in tests/db/r24-stock-0268.sql)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const SF = require('../public/stock-flow.js');
const CS = require('../public/checkout-shortage.js');
const INV = read('public/inventory.html'), TD = read('public/teardown.html'), CMD = read('public/command.html');
const CLO = read('public/closure.html'), CLJ = read('public/closure-checklist.js'), STORE = read('public/store-api.js');
const PICK = read('public/stock-picker.js'), CSS = read('public/stock-flow.css');
const SQL = read('supabase/migrations/0268_stock_one_flow.sql'), APPLY = read('supabase/APPLY-0268.sql');
const MANIFEST = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh'), PKG = read('package.json');

console.log('r24 stock - one flow (stock-flow.js):');
t('a check-out splits into Out / Back / Missing / Damaged', () => {
  assert.deepEqual(SF.coParts({ status: 'out', qty_out: 20 }), { out: 20, back: 0, missing: 0, damaged: 0, cancelled: false });
  assert.deepEqual(SF.coParts({ status: 'partial', qty_out: 20, qty_in: 19, qty_damaged: 2, written_off: 3 }), { out: 0, back: 17, missing: 1, damaged: 2, cancelled: false });
  assert.deepEqual(SF.coParts({ status: 'returned', qty_out: 5, qty_in: 5 }), { out: 0, back: 5, missing: 0, damaged: 0, cancelled: false });
  assert.equal(SF.coParts({ status: 'cancelled', qty_out: 5 }).cancelled, true);
  assert.equal(SF.coState({ status: 'partial', qty_out: 20, qty_in: 19, qty_damaged: 2 }), 'missing');
  assert.equal(SF.coState({ status: 'returned', qty_out: 5, qty_in: 5, qty_damaged: 1 }), 'damaged');
  assert.equal(SF.coSummary({ status: 'partial', qty_out: 20, qty_in: 19, qty_damaged: 2 }), 'Back 17 · Damaged 2 · Missing 1');
});
t('free-stock maths: a written-off missing unit is not also still out (same rule as SQL _r24_not_back)', () => {
  const c = { status: 'partial', qty_out: 20, qty_in: 19, qty_damaged: 2, written_off: 3 };
  assert.equal(SF.notBack(c), 0); assert.equal(CS.stillOut(c), 0);
  assert.equal(SF.notBack({ status: 'partial', qty_out: 10, qty_in: 7 }), 3);      // old short check-in, never written off
  assert.equal(SF.notBack({ status: 'out', qty_out: 4 }), 4);
  assert.match(STORE, /Math\.max\(Number\(c\.written_off \|\| 0\) - Number\(c\.qty_damaged \|\| 0\), 0\)/);
});
t('per event: Reserved / Out (who + when) / Back / Missing / Damaged / Released', () => {
  const rows = SF.eventItems({
    reservations: [
      { id: 'r1', item_id: 'A', qty: 10, status: 'reserved' },            // never taken out
      { id: 'r2', item_id: 'B', qty: 5, status: 'reserved' },             // given out below
      { id: 'r3', item_id: 'C', qty: 4, status: 'allocated' },            // given out before names were recorded
      { id: 'r4', item_id: 'D', qty: 2, status: 'returned' },             // released
    ],
    checkouts: [
      { id: 'c1', item_id: 'B', status: 'out', qty_out: 5, issued_to: 'Suresh', checked_out_at: '2026-10-19T10:30:00Z' },
      { id: 'c2', item_id: 'E', status: 'partial', qty_out: 6, qty_in: 5, qty_damaged: 1 },
      { id: 'c3', item_id: 'B', status: 'cancelled', qty_out: 9 },
    ] });
  const by = Object.fromEntries(rows.map((r) => [r.item_id, r]));
  assert.equal(by.A.state, 'reserved'); assert.equal(by.A.unused, 10); assert.equal(by.A.label, 'Reserved');
  assert.equal(by.B.state, 'out'); assert.equal(by.B.out, 5); assert.equal(by.B.outs.length, 1); assert.equal(by.B.history.length, 1);
  assert.equal(by.C.state, 'out'); assert.equal(by.C.legacyOut, 4); assert.deepEqual(by.C.legacyIds, ['r3']);
  assert.equal(by.D.state, 'released');
  assert.equal(by.E.state, 'missing'); assert.equal(by.E.back, 4); assert.equal(by.E.damaged, 1); assert.equal(by.E.missing, 1);
  assert.equal(SF.stillOut(rows), 9);
  assert.equal(SF.detail(by.B, { fmt: () => '19/10/2026, 4:00 pm', unit: 'pcs' }), '5 pcs with Suresh since 19/10/2026, 4:00 pm');
  assert.equal(SF.detail(by.C, {}), '4 given out (name not recorded)');
});
t('plain words: "Reserved — never taken out, nothing to return" (replaces "Not issued yet")', () => {
  assert.equal(SF.NEVER_OUT, 'Reserved — never taken out, nothing to return');
  const r = SF.eventItems({ reservations: [{ id: 'r', item_id: 'A', qty: 3, status: 'reserved' }], checkouts: [] })[0];
  assert.equal(SF.detail(r, { eventOver: true }), SF.NEVER_OUT);
  const rel = SF.eventItems({ reservations: [{ id: 'r', item_id: 'A', qty: 3, status: 'returned' }], checkouts: [] })[0];
  assert.match(SF.detail(rel, {}), /never taken out, nothing to return \(released automatically\)/);
  assert.doesNotMatch(TD, /Not issued yet|not issued yet/);
});
t('event-day request states follow the real check-out', () => {
  const co = { c1: { id: 'c1', status: 'out', qty_out: 2 }, c2: { id: 'c2', status: 'returned', qty_out: 2, qty_in: 2 } };
  assert.equal(SF.requestState({ status: 'requested' }).label, 'Requested');
  assert.equal(SF.requestState({ status: 'issued', checkout_id: 'c1' }, co).label, 'Out');
  assert.equal(SF.requestState({ status: 'issued', checkout_id: 'c2' }, co).label, 'Back');
  assert.equal(SF.requestState({ status: 'issued' }, co).label, 'Given out');
  assert.equal(SF.requestState({ status: 'issued', source: 'buy' }, co).label, 'Sourced');
  assert.equal(SF.requestState({ status: 'cancelled' }).label, 'Not needed');
  assert.equal(SF.requestState({ status: 'replaced' }).label, 'Swapped');
});
t('per-item history: which event, given to whom, when out, when back (newest first, cancelled left out)', () => {
  const h = SF.history([
    { id: '1', quote_id: 'q1', status: 'returned', qty_out: 4, qty_in: 4, issued_to: 'Ravi', checked_out_at: '2026-10-01T09:00:00Z', checked_in_at: '2026-10-02T09:00:00Z' },
    { id: '2', quote_id: 'q2', status: 'out', qty_out: 3, issued_to: 'Suresh', checked_out_at: '2026-10-18T09:00:00Z', quotes: { id: 'q2', title: 'Kapoor Sangeet', event_date: '2026-10-18' } },
    { id: '3', quote_id: 'q1', status: 'cancelled', qty_out: 9, checked_out_at: '2026-10-19T09:00:00Z' },
  ], { q1: { id: 'q1', title: 'Rao Wedding', eventDate: '2026-10-01' } });
  assert.equal(h.length, 2);
  assert.equal(h[0].event, 'Kapoor Sangeet'); assert.equal(h[0].to, 'Suresh'); assert.equal(h[0].state, 'out'); assert.equal(h[0].backAt, null);
  assert.equal(h[1].event, 'Rao Wedding'); assert.equal(h[1].eventDate, '2026-10-01'); assert.equal(h[1].backAt, '2026-10-02T09:00:00Z');
});
t('picker search: every word must match, names that start with the word first', () => {
  const items = [{ name: 'Gold chiavari chair', category: 'Seating' }, { name: 'Chair cover', category: 'Linens' }, { name: 'Wireless mic', category: 'Sound & AV' }];
  assert.deepEqual(SF.search(items, 'chair').map((i) => i.name), ['Chair cover', 'Gold chiavari chair']);
  assert.deepEqual(SF.search(items, 'gold chair').map((i) => i.name), ['Gold chiavari chair']);
  assert.deepEqual(SF.search(items, 'sound').map((i) => i.name), ['Wireless mic']);
  assert.equal(SF.search(items, '').length, 3);
});

console.log('pages:');
t('Event-day command: searchable, scrollable stock list (no long <select>), works on a phone', () => {
  assert.doesNotMatch(CMD, /id="stk_item"/); assert.doesNotMatch(CMD, /pick a stock item/);
  assert.match(CMD, /<div id="stk_pick" class="stk-pick"><\/div>/);
  assert.match(CMD, /<script src="stock-picker\.js\?v=\d+"><\/script>/); assert.match(CMD, /<script src="stock-flow\.js\?v=\d+"><\/script>/);
  assert.match(CMD, /HelmStockPicker\.mount\(\$\("#stk_pick"\),\{ items:stkItems, allowFree:true/);
  assert.match(PICK, /setAttribute\("role", "combobox"\)/); assert.match(PICK, /setAttribute\("role", "listbox"\)/);
  assert.match(PICK, /ArrowDown/); assert.match(PICK, /not from stock/);
  assert.doesNotMatch(PICK, /innerHTML|\.style\./);                      // CSP: DOM nodes + textContent only
  assert.match(CSS, /\.stkp-list\{[^}]*max-height:280px;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch/);
  assert.match(CSS, /@media \(max-width:640px\)\{\n  \.stkp-list\{position:static;margin-top:6px;max-height:50vh/);
});
t('Event-day command: Give out = a real check-out (who), Mark back with OK + damaged; plain labels', () => {
  assert.match(CMD, /BPStore\.stockreq\.issue\(rid,to,crewId,null,false\)/);
  assert.match(CMD, /res\.code==="shortage"/); assert.match(CMD, /BPStore\.stockreq\.issue\(rid,to,crewId,null,true\)/);
  assert.match(CMD, /BPStore\.inventory\.checkouts\.back\(c\.id, ok\.value, dm\.value, null\)/);
  assert.match(CMD, />Give out<\/button>/); assert.match(CMD, />Mark back<\/button>/); assert.match(CMD, />Not needed<\/button>/);
  assert.doesNotMatch(CMD, /data-s="issued"/); assert.doesNotMatch(CMD, />Replaced</);
  assert.match(STORE, /rpc\("issue_stock_request", \{ p_request: id, p_issued_to: issuedTo \|\| "", p_issued_to_id: crewId \|\| null, p_note: note \|\| null, p_partial: !!partial \}\)/);
});
t('Teardown: ONE stock card, auto-release on the event day, Mark back (OK + damaged), no second loans card', () => {
  assert.match(TD, /<h2>📦 Stock for this event/);
  assert.doesNotMatch(TD, /In-house inventory returns|Equipment check-out \/ check-in|id="loanRows"/);
  assert.match(TD, /BPStore\.inventory\.releaseUnused\(id, true\)/);
  assert.match(TD, /SF\.eventItems\(\{ reservations:res, checkouts:cos \}\)/);
  assert.match(TD, /BPStore\.inventory\.checkouts\.back\(rid, ok\.value, dm\.value, null\)/);
  assert.match(TD, /Came back OK/); assert.match(TD, /Damaged/);
});
t('Inventory event view: Reserved / Now columns, Give out / Release / Mark back; no 4-state dropdown, no hard delete', () => {
  assert.match(INV, /<h2>Stock for this event<\/h2>/);
  assert.match(INV, /<th scope="col" class="num">Reserved<\/th><th scope="col">Now<\/th>/);
  assert.doesNotMatch(INV, /\["reserved","allocated","returned","cancelled"\]/);
  assert.doesNotMatch(INV, /BPStore\.inventory\.removeRes\(/);
  assert.match(INV, /BPStore\.inventory\.setResStatus\(rid,"cancelled"\)/);
  assert.match(INV, /BPStore\.inventory\.releaseUnused\(quoteId,false\)/);
  assert.doesNotMatch(INV, /allocate when it goes out/);
});
t('Inventory Out & back tab: plain labels, Mark back with OK + damaged, Missing & damaged list', () => {
  assert.match(INV, /🔑 Out &amp; back/); assert.match(INV, /<h2>Give out stock<\/h2>/); assert.match(INV, /id="co_add">Give out</);
  assert.match(INV, /Out now <span id="loanCount"/); assert.match(INV, /Missing &amp; damaged<\/h2>/);
  assert.match(INV, /<label for="ci_dmg">Damaged<\/label>/); assert.match(INV, /<label for="ci_in">Came back OK<\/label>/);
  assert.match(INV, /BPStore\.inventory\.checkouts\.back\(checkInId, okV\.value, dmV\.value, by\|\|null\)/);
  assert.match(INV, /const isOpen=\(c\)=>c\.status==="out";/);
  assert.doesNotMatch(INV, /Out on loan|Loss report|Confirm check-in|Issued to</);
});
t('Inventory: per-item History (event · given to · when out · when back)', () => {
  assert.match(INV, /data-hist="\$\{esc\(i\.id\)\}"/); assert.match(INV, /id="histModal"/);
  assert.match(INV, /<th scope="col">Event<\/th><th scope="col">Given to<\/th><th scope="col" class="num">How many<\/th><th scope="col">Out<\/th><th scope="col">Back<\/th>/);
  assert.match(INV, /SF\.history\(await BPStore\.inventory\.checkouts\.forItem\(itemId\), quotesById\)/);
  assert.match(STORE, /select\("\*, quotes\(id,code,title,event_date\)"\)\.eq\("item_id", itemId\)/);
});
t('Closure: only Out-and-not-Back blocks; table speaks the same words', () => {
  assert.match(CLJ, /\["Item", "Reserved", "Out", "Back", "Missing", "Damaged", "Not back yet", ""\]/);
  assert.match(CLJ, /Reserved but never taken out needs no return/);
  assert.match(CLO, /filter\(r=>r\.legacyOut>0\)/);
  assert.doesNotMatch(CLO, /r\.status==="reserved" \|\| r\.status==="allocated"/);
});

console.log('SQL 0268:');
t('new RPCs, trigger, columns, replaced bodies; additive + idempotent; ASCII', () => {
  for (const f of ['checkin_stock(p_id uuid, p_ok numeric, p_damaged numeric default 0, p_returned_by text default null)',
    'issue_stock_request(p_request uuid, p_issued_to text, p_issued_to_id uuid default null,', 'release_unused_stock(p_quote uuid, p_include_today boolean default false)',
    '_r24_release(p_quote uuid, p_org uuid, p_item uuid default null, p_include_today boolean default false)', '_r24_not_back(']) assert.ok(SQL.includes('create or replace function public.' + f), f);
  assert.match(SQL, /add column if not exists qty_damaged numeric not null default 0/);
  assert.match(SQL, /add column if not exists checkout_id uuid/);
  assert.match(SQL, /create trigger zz_r24_release_on_back after update of status on public\.inventory_checkouts/);
  assert.match(SQL, /r24-stock-0268: stock = Reserved -> Out -> Back \/ Missing \/ Damaged; only Out-and-not-Back blocks/);
  assert.doesNotMatch(SQL, /\bdrop table\b|\bdelete from\b|\btruncate\b|drop column/i);
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
  assert.match(SQL, /has_area\('command', 'edit'\)/);
});
t('APPLY-0268 = header + begin + migration + commit + VERIFY again; MANIFEST + DB suite + npm test wired', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(!/[^\x00-\x7f]/.test(APPLY));
  assert.match(MANIFEST, /forward  supabase\/migrations\/0268_stock_one_flow\.sql/);
  assert.match(RUNALL, /run "r24-stock-0268" "R24-STOCK-0268: ALL PASS \\\(47\/47\\\)" psql -q -f tests\/db\/r24-stock-0268\.sql/);
  assert.match(PKG, /node test\/r24-stock-flow\.test\.mjs/);
});

console.log(`\nr24-stock-flow: ${n} passed, ${fail} failed`);
if (fail) process.exit(1);
