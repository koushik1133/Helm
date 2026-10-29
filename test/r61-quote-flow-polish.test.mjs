// r61-quote-flow-polish.test.mjs - quote flow polish (owner screenshots, steps 4 / 9 / 10):
//  * step 9 "Valid until": India dd/mm/yyyy date box (parseDMY), Undo after Extend / Save date through the server
//    (BPStore.quoteValidity.undo -> quote_validity_undo), the link heads-up, History word for 'undo'
//  * step 10: the advance row is one aligned grid; the schedule card previews the split (percent, when, amount or "-")
//    and shows a soft note instead of the raw red "Price the quote first" error
//  * step 4: the saved-venue select sits in a .fld like every other field
//  * SQL 0302 registered (MANIFEST, run-all, release lists), APPLY = migration + VERIFY, ASCII, additive only
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const QV = require('../public/quote-validity.js'), PS = require('../public/payment-schedule.js');
const QVJS = rd('public/quote-validity.js'), PSJS = rd('public/payment-schedule.js'), FLOW = rd('public/flow.html'), STORE = rd('public/store-api.js');
const VP = rd('public/venue-picker.js'), TOURS = rd('public/page-tours.js'), FPC = rd('public/flow-polish.css');
const SQL = rd('supabase/migrations/0302_r61_quote_validity_undo.sql'), APPLY = rd('supabase/APPLY-0302.sql');

await t('parseDMY: dd/mm/yyyy (and - . separators) -> ISO; impossible dates / US order refused', () => {
  assert.equal(QV.parseDMY('23/12/2026'), '2026-12-23');
  assert.equal(QV.parseDMY(' 1-2-2027 '), '2027-02-01');
  assert.equal(QV.parseDMY('05.11.2026'), '2026-11-05');
  assert.equal(QV.parseDMY('12/23/2026'), '');   // month 23 does not exist
  assert.equal(QV.parseDMY('31/02/2026'), '');
  assert.equal(QV.parseDMY('2026-12-23'), '');
  assert.equal(QV.parseDMY(''), '');
  assert.equal(QV.fmtDMY(QV.parseDMY('09/01/2027')), '09/01/2027');
});
await t('undoOffer / linkWarn read the 0302 answer safely', () => {
  assert.equal(QV.undoOffer(null), null);
  assert.equal(QV.undoOffer({ undo: null }), null);
  assert.equal(QV.undoOffer({ undo: { log_id: 'nope' } }), null);
  assert.deepEqual(QV.undoOffer({ undo: { log_id: 'a0000000-0000-4000-8000-000000000001', back_to: '2026-12-24', back_to_label: '24/12/2026' } }),
    { logId: 'a0000000-0000-4000-8000-000000000001', label: '24/12/2026' });
  assert.equal(QV.linkWarn({ state: 'valid', valid_until: '2027-01-07', link_until: '2026-11-28', link_until_label: '28/11/2026' }), '28/11/2026');
  assert.equal(QV.linkWarn({ state: 'valid', valid_until: '2026-11-20', link_until: '2026-11-28' }), '');
  assert.equal(QV.linkWarn({ state: 'expired', valid_until: '2027-01-07', link_until: '2026-11-28' }), '');
  assert.equal(QV.linkWarn({ state: 'valid', valid_until: '2027-01-07', link_until: null }), '');
  assert.equal(QV.UNDO_MS, 10000);
});
await t('staff widget: text dd/mm/yyyy box + calendar button, Undo button + toast action, History word', () => {
  assert.match(QVJS, /placeholder: "dd\/mm\/yyyy"/);
  assert.match(QVJS, /cls: "qv-dmy"/);
  assert.match(QVJS, /showPicker/);
  assert.doesNotMatch(QVJS, /h\("input", \{ type: "date", min: d\.today/);   // the visible box is no longer a native date input
  assert.match(QVJS, /store\(\)\.undo\(id, u\.logId\)/);
  assert.match(QVJS, /action: \{ label: "Undo"/);
  assert.match(QVJS, /cls: "btn sm qv-undo"/);
  assert.match(QVJS, /undo: "Undone"/);
  assert.match(STORE, /undo: \(quoteId, logId\) => \{ qvSoon = null; return rpc\("quote_validity_undo", \{ p_quote: quoteId, p_log: logId \}\)/);
  assert.doesNotMatch(QVJS, /innerHTML/);
});
await t('payment schedule: due words, percent text, soft note, Add disabled until priced', () => {
  assert.equal(PS.dueWhen({ anchor: 'approval', offset_days: 0 }), 'On approval');
  assert.equal(PS.dueWhen({ anchor: 'approval', offset_days: 7 }), '7 days after approval');
  assert.equal(PS.dueWhen({ anchor: 'event', offset_days: -15 }), '15 days before the event');
  assert.equal(PS.dueWhen({ anchor: 'event', offset_days: 0 }), 'On the event day');
  assert.equal(PS.dueWhen({ anchor: 'event', offset_days: 1 }), '1 day after the event');
  assert.equal(PS.pctText(30), '30%');
  assert.equal(PS.pctText(12.345), '12.3%');
  assert.match(PSJS, /"psch-soft"/);
  assert.match(PSJS, /Price the quote first \(step 8\)/);
  assert.match(PSJS, /go\.disabled = true; return;/);
  assert.doesNotMatch(PSJS, /prev\.appendChild\(el\("p", "psch-err"/);   // the raw red error line is gone
});
await t('step 10: the advance controls are one aligned grid (receipt no. inside), ids kept', () => {
  const i = FLOW.indexOf('<div class="pay-adv" id="payAdv">'), j = FLOW.indexOf('id="pay_terms"');
  assert.ok(i > 0 && j > i);
  const g = FLOW.slice(i, j);
  for (const id of ['pay_pct', 'pay_amount', 'pay_method', 'pay_receiptWrap', 'pay_receipt', 'pay_record']) assert.ok(g.includes('id="' + id + '"'), id);
  assert.equal((FLOW.match(/id="pay_receiptWrap"/g) || []).length, 1);
  assert.match(FPC, /#sec-pay \.pay-adv\{display:grid/);
});
await t('step 4: the saved-venue select sits in a .fld (same size / radius / padding as the other fields)', () => {
  assert.match(VP, /h\("div", \{ cls: "fld vp-fld" \}, \[h\("label", \{ "for": "vp_pick"/);
});
await t('page tour: share & approval step mentions Undo; payment step mentions the split', () => {
  assert.match(TOURS, /sel: "#sec-approve".*Undo/);
  assert.match(TOURS, /sel: "#sec-pay".*30% \/ 50% \/ 20%/);
});
await t('SQL 0302: additive, STOP guard, undo through _qv262_guard, logged, registered; APPLY = migration + VERIFY, ASCII', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.match(code, /STOP 0302:/);
  assert.match(code, /perform public\._qv262_guard\(p_quote\)/);
  assert.match(code, /'undo', 'Undone - back to '/);
  assert.match(code, /alter function public\._qv262_write\(uuid, date, text, text, text\) rename to _qv262_write__pre0302/);
  assert.match(code, /alter function public\.quote_validity_get\(uuid\) rename to quote_validity_get__pre0302/);
  assert.doesNotMatch(code, /\b(drop table|drop column|truncate|delete from)\b/i);
  assert.ok(APPLY.includes(SQL), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY/);
  for (const s of [SQL, APPLY]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  assert.match(rd('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0302_r61_quote_validity_undo\.sql$/m);
  assert.match(rd('scripts/db-test/run-all.sh'), /R61-QV-UNDO-0302: ALL PASS \\\(30\/30\\\)/);
  assert.match(rd('test/release-1019.test.mjs'), /'0302'/);
  assert.match(rd('test/release-1020.test.mjs'), /'0302'/);
});
console.log(`r61-quote-flow-polish: ${n} passed`);
