// Client onboarding wizard — pure import logic (public/onboarding-core.js).
// Covers CSV parsing, number/format edge cases, formula/HTML neutralising, header mapping,
// duplicate detection (in-file + existing), idempotent/resumable apply, undo, draft round-trip.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const ctx = { module: { exports: {} }, console, TextDecoder, Uint8Array };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(read('public/onboarding-core.js'), ctx);
const O = ctx.module.exports;

const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---- numbers ---- */
t('Indian + western grouping, currency symbols, decimals', () => {
  assert.equal(O.parseNumber('₹ 1,25,000').value, 125000);
  assert.equal(O.parseNumber('Rs. 1,250,000').value, 1250000);
  assert.equal(O.parseNumber('1,250.50').value, 1250.5);
  assert.equal(O.parseNumber('INR 850/-').value, 850);
  assert.equal(O.parseNumber('.5').value, 0.5);
});
t('scientific notation accepted when finite, overflow rejected', () => {
  assert.equal(O.parseNumber('1.5e3').value, 1500);
  assert.equal(O.parseNumber('1E400').ok, false);
});
t('blank / negative / NaN / text / oversized prices rejected', () => {
  assert.equal(O.parseNumber('', { required: true }).ok, false);
  assert.equal(O.parseNumber('', {}).value, null);
  for (const bad of ['-5', '(100)', 'NaN', 'Infinity', 'abc', '12abc', '1,2,3', '--1', '999999999999']) assert.equal(O.parseNumber(bad).ok, false, bad);
});
t('quantities must be whole and bounded', () => {
  assert.equal(O.parseNumber('12.5', { int: true }).ok, false);
  assert.equal(O.parseNumber('12', { int: true, max: O.MAX_QTY }).value, 12);
  assert.equal(O.parseNumber('99999999', { int: true, max: O.MAX_QTY }).ok, false);
});

/* ---- text safety ---- */
t('formula-injection cells are neutralised', () => {
  for (const f of ['=SUM(A1)', '+1+1', '-2+3', '@cmd']) assert.ok(O.safeText(f).startsWith("'"), f);
  assert.equal(O.safeText('Normal item'), 'Normal item');
  assert.equal(O.csvEscapeCell('=1+1'), "'=1+1");
});
t('HTML/script stripped from stored text, control chars and zero-width removed', () => {
  assert.ok(!/[<>]/.test(O.safeText('<script>alert(1)</script>Tent')));
  assert.ok(!/[<>]/.test(O.safeText('<img src=x onerror=alert(1)>Chair')));
  assert.equal(O.cleanText('a​b\u0007 c'), 'ab c');
  assert.equal(O.cleanText('x'.repeat(500)).length, 200);
});
t('normKey ignores case, whitespace, punctuation, accents, width', () => {
  assert.equal(O.normKey('  Café  Table-5 '), O.normKey('cafe table 5'));
  assert.equal(O.normKey('ＡＢＣ'), O.normKey('abc'));
  assert.equal(O.normKey('Salt & Pepper'), O.normKey('salt and pepper'));
  assert.notEqual(O.normKey('Chair 1'), O.normKey('Chair 2'));
});

/* ---- CSV ---- */
t('BOM, CRLF, CR, quoted commas and newlines, escaped quotes', () => {
  const r = O.parseCSV('﻿name,note\r\n"A, B","line1\nline2"\r"He said ""hi""",x\r\n');
  deq(r.rows, [['name', 'note'], ['A, B', 'line1\nline2'], ['He said "hi"', 'x']]);
});
t('semicolon and tab delimiters detected; blank lines skipped', () => {
  deq(O.parseCSV('a;b\n1;2\n\n3;4').rows, [['a', 'b'], ['1', '2'], ['3', '4']]);
  deq(O.parseCSV('a\tb\n1\t2').rows[1], ['1', '2']);
});
t('unterminated quote and replacement chars produce warnings', () => {
  assert.ok(O.parseCSV('a,b\n"x,1').warnings.some((w) => /never closed/.test(w)));
  assert.ok(O.parseCSV('a,b\n�,1').warnings.some((w) => /encoding/.test(w)));
});
t('huge file is capped at MAX_ROWS and flagged', () => {
  const body = ['name'].concat(Array.from({ length: 5000 }, (_, i) => 'Item ' + i)).join('\n');
  const r = O.parseCSV(body);
  assert.equal(r.rows.length, O.MAX_ROWS + 1); assert.equal(r.truncated, true);
  const p = O.buildPreview('menu', r.rows, { name: 0, category: -1, kind: -1 }, []);
  assert.equal(p.rows.length, O.MAX_ROWS);
});
t('decodeBytes: utf-8, utf-16 BOM, windows-1252 fallback', () => {
  assert.equal(O.decodeBytes(new TextEncoder().encode('₹ naïve'), TextDecoder).text, '₹ naïve');
  assert.equal(O.decodeBytes(Uint8Array.from([0xFF, 0xFE, 0x61, 0x00]), TextDecoder).text, 'a');
  const r = O.decodeBytes(Uint8Array.from([0x43, 0x61, 0x66, 0xE9]), TextDecoder);   // "Café" in latin-1
  assert.equal(r.text, 'Café'); assert.ok(r.warnings.length);
});
t('templates parse back and validate cleanly for every kind', () => {
  for (const k of Object.keys(O.KINDS)) {
    const rows = O.parseCSV(O.templateCSV(k)).rows;
    const m = O.mapHeaders(rows[0], k);
    assert.equal(m.confident, true, k);
    const p = O.buildPreview(k, rows, m.mapping, []);
    assert.equal(p.summary.invalid, 0, k); assert.equal(p.summary.new, rows.length - 1, k);
  }
});

/* ---- header mapping ---- */
t('fuzzy header mapping handles synonyms, typos, casing, order', () => {
  const m = O.mapHeaders(['Item Name ', 'QTY', 'Cost', 'Catagory'], 'inventory');
  assert.equal(m.mapping.name, 0); assert.equal(m.mapping.total_qty, 1); assert.equal(m.mapping.unit_cost, 2); assert.equal(m.mapping.category, 3);
});
t('wrong headers: required fields reported missing, no column used twice', () => {
  const m = O.mapHeaders(['foo', 'bar'], 'inventory');
  assert.equal(m.confident, false); deq(m.missing.sort(), ['name', 'total_qty']);
  const s = O.sanitizeMapping({ name: 0, total_qty: 0, category: 99, unit: -5, unit_cost: 'x' }, 'inventory', 2);
  assert.equal(s.name, 0); assert.equal(s.total_qty, -1); assert.equal(s.category, -1); assert.equal(s.unit_cost, -1);
});

/* ---- preview: validation + duplicates ---- */
const H = ['name', 'category', 'quantity', 'unit', 'unit_cost'];
const inv = (rows, existing, prior) => { const m = O.mapHeaders(H, 'inventory').mapping; return O.buildPreview('inventory', [H].concat(rows), m, existing || [], prior); };
t('a row with more cells than the header (unquoted comma) is rejected, not guessed', () => {
  const p = inv([['Lamp', '', '7', 'pcs', 'Rs 1', '250/-']]);
  assert.equal(p.rows[0].status, 'invalid');
  assert.match(p.rows[0].errors.join(' '), /more cells/);
});
t('duplicates within the file are flagged, first wins', () => {
  const p = inv([['Chair', 'Seating', '10', 'pcs', '5'], ['  CHAIR!! ', 'Seating', '3', '', ''], ['Table', '', '2', '', '']]);
  deq(p.rows.map((r) => r.status), ['new', 'dup-file', 'new']);
  assert.equal(p.rows[1].dupOfLine, 2); assert.equal(p.summary.dupFile, 1);
});
t('duplicates vs existing default to skip, never silent overwrite', () => {
  const p = inv([['chair', '', '5', '', '']], [{ id: 'e1', name: 'Chair ', total_qty: 10, active: true }]);
  assert.equal(p.rows[0].status, 'dup-existing'); assert.equal(p.rows[0].action, 'skip'); assert.equal(p.summary.willSkip, 1); assert.equal(p.summary.willAdd, 0);
});
t('merge only offered for inventory; rename yields a free unique name', () => {
  const ex = [{ id: 'e1', name: 'Chair', active: true }, { id: 'e2', name: 'Chair (2)', active: true }];
  let p = inv([['Chair', '', '5', '', '']], ex);
  p = O.setAction(p, 2, 'rename'); assert.equal(p.rows[0].action, 'rename');
  p = inv([['Chair', '', '5', '', '']], ex, { 2: 'rename' }); assert.equal(p.rows[0].renamedTo, 'Chair (3)');
  p = inv([['Chair', '', '5', '', '']], ex, { 2: 'merge' }); assert.equal(p.rows[0].action, 'merge');
  const dish = O.buildPreview('menu', [['name'], ['Paneer']], { name: 0, category: -1, kind: -1 }, [{ id: 'd', name: 'paneer' }], { 2: 'merge' });
  assert.equal(dish.rows[0].action, 'skip');            // merge not valid for dishes -> falls back to skip
});
t('inactive existing records are never merged into', () => {
  const p = inv([['Chair', '', '5', '', '']], [{ id: 'e1', name: 'Chair', active: false }], { 2: 'merge' });
  assert.equal(p.rows[0].mergeable, false); assert.equal(p.rows[0].action, 'skip');
});
t('invalid rows: blank name, negative/NaN/text qty, bad cost, punctuation-only name', () => {
  const p = inv([['', '', '5', '', ''], ['A', '', '-3', '', ''], ['B', '', 'NaN', '', ''], ['C', '', '4', '', 'free'], ['!!!', '', '4', '', ''], ['D', '', '', '', '']]);
  deq(p.rows.map((r) => r.status), ['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);
  assert.equal(p.summary.invalid, 6);
});
t('valid rows normalise formats and neutralise formulas in stored data', () => {
  const p = inv([['=HYPERLINK("x")', '<b>Tents</b>', '1,200', '', '₹ 1,25,000']]);
  const r = p.rows[0]; assert.equal(r.status, 'new');
  assert.ok(r.data.name.startsWith("'=")); assert.equal(r.data.category, 'Tents'); assert.equal(r.data.total_qty, 1200); assert.equal(r.data.unit_cost, 125000); assert.equal(r.data.unit, 'pcs');
});
t('pricing duplicates are per type (chair vs plate with same name are distinct)', () => {
  const m = O.mapHeaders(['name', 'price', 'type'], 'pricing').mapping;
  const p = O.buildPreview('pricing', [['name', 'price', 'type'], ['Gold', '100', 'chair'], ['Gold', '900', 'plate'], ['gold', '5', 'Chairs']], m, [{ id: 'x', name: 'Gold', _type: 'plate' }]);
  deq(p.rows.map((r) => r.status), ['new', 'dup-existing', 'dup-file']);
});
t('menu diet + vendor phone/email + staff phone validation', () => {
  const m = { name: 0, category: 1, kind: 2 };
  const p = O.buildPreview('menu', [['n', 'c', 'k'], ['Dal', 'Main', 'Veg'], ['Fish', 'Main', 'non-veg'], ['Odd', 'Main', 'purple']], m, []);
  deq(p.rows.map((r) => r.status), ['new', 'new', 'invalid']); assert.equal(p.rows[1].data.kind, 'nonveg');
  const v = O.buildPreview('vendors', [['name', 'phone', 'email'], ['A', '98765 43210', 'a@x.com'], ['B', '12', ''], ['C', '', 'nope']], O.mapHeaders(['name', 'phone', 'email'], 'vendors').mapping, []);
  deq(v.rows.map((r) => r.status), ['new', 'invalid', 'invalid']); assert.equal(v.rows[0].data.phone, '9876543210');
  const s = O.buildPreview('staff', [['name', 'phone'], ['Ravi', '']], O.mapHeaders(['name', 'phone'], 'staff').mapping, []);
  assert.equal(s.rows[0].status, 'invalid');
});

/* ---- apply: idempotent, partial failure, resumable, undo ---- */
const mkApi = (failNames = new Set(), log = []) => {
  let n = 0;
  return { log, api: {
    create: async (k, p) => { log.push(['create', p.name]); if (failNames.has(p.name)) throw new Error('boom ' + p.name); return { id: 'id' + (++n) }; },
    merge: async (k, id, p) => { log.push(['merge', id, p.total_qty]); return true; },
    deactivate: async (k, id) => { log.push(['deactivate', id]); },
  } };
};
t('partial failure is reported per row; retry sends only the failed rows', async () => {
  const p = inv([['A', '', '1', '', ''], ['B', '', '2', '', ''], ['C', '', '3', '', '']]);
  const fail = new Set(['B']); const { api, log } = mkApi(fail);
  let r = await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k1', api });
  deq({ ...r.counts }, { ok: 2, merged: 0, error: 1 });
  fail.clear(); log.length = 0;
  r = await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k1', ledger: r.ledger, api });
  deq(log, [['create', 'B']]); deq({ ...r.counts }, { ok: 3, merged: 0, error: 0 });
});
t('double submit with same batch key writes nothing twice', async () => {
  const p = inv([['A', '', '1', '', ''], ['B', '', '2', '', '']]); const { api, log } = mkApi();
  const first = await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k2', api });
  await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k2', ledger: first.ledger, api });
  assert.equal(log.filter((x) => x[0] === 'create').length, 2);
});
t('skip rows, invalid rows and in-file dups are never written; merge calls merge not create', async () => {
  const ex = [{ id: 'e1', name: 'Chair', active: true }, { id: 'e2', name: 'Table', active: true }];
  const p = inv([['Chair', '', '5', '', ''], ['Table', '', '7', '', ''], ['Bad', '', '-1', '', ''], ['New', '', '1', '', ''], ['new', '', '1', '', '']], ex, { 2: 'merge' });
  const { api, log } = mkApi(); await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k3', api });
  deq(JSON.stringify(log.slice().sort()), JSON.stringify([['create', 'New'], ['merge', 'e1', 5]].sort()));
});
t('createMany chunks; a failed chunk falls back to per-row results', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ['Item' + i, '', '1', '', '']);
  const p = inv(rows); const calls = [];
  let n = 0;
  const api = { create: async (k, pl) => { if (pl.name === 'Item7') throw new Error('x'); return { id: 'r' + (++n) }; },
    createMany: async (k, pls) => { calls.push(pls.length); if (pls.some((x) => x.name === 'Item7')) throw new Error('chunk'); return pls.map(() => ({ id: 'm' + (++n) })); } };
  const r = await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k4', api });
  deq(calls, [100, 100, 50]); assert.equal(r.counts.ok, 249); assert.equal(r.counts.error, 1);
});
t('undo deactivates only this batch\'s created rows, never merged/other batches', async () => {
  const ex = [{ id: 'e1', name: 'Chair', active: true }];
  const p = inv([['Chair', '', '5', '', ''], ['New', '', '1', '', '']], ex, { 2: 'merge' });
  const { api, log } = mkApi(); const r = await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k5', api });
  r.ledger.entries['other:inventory:2'] = { status: 'ok', id: 'foreign' };
  log.length = 0; const u = await O.undoBatch({ kind: 'inventory', batchKey: 'k5', ledger: r.ledger, api });
  deq(log, [['deactivate', 'id1']]); assert.equal(u.undone, 1); assert.equal(u.skippedMerged, 1);
  await O.undoBatch({ kind: 'inventory', batchKey: 'k5', ledger: r.ledger, api }); assert.equal(log.length, 1);   // second undo is a no-op
});
t('cancel stops further writes', async () => {
  const p = inv([['A', '', '1', '', ''], ['B', '', '1', '', '']]); const { api, log } = mkApi(); let c = false;
  const api2 = { ...api, create: async (...a) => { c = true; return api.create(...a); } };
  await O.applyBatch({ kind: 'inventory', rows: p.rows, batchKey: 'k6', api: api2, isCancelled: () => c });
  assert.equal(log.length, 1);
});

/* ---- draft ---- */
t('draft round-trips and rejects junk / other versions', () => {
  const s = { step: 2, steps: { menu: { mode: 'csv', text: 'a,b', manual: [{ name: 'x' }], mapping: { name: 0 }, actions: { 2: 'rename' }, batchKey: 'bk', stage: 'preview' } } };
  const d = O.parseDraft(O.serializeDraft(s));
  assert.equal(d.step, 2); assert.equal(d.steps.menu.text, 'a,b'); assert.equal(d.steps.menu.batchKey, 'bk');
  assert.equal(O.parseDraft('{bad'), null); assert.equal(O.parseDraft('{"v":99,"steps":{}}'), null); assert.equal(O.parseDraft(null), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok  - ' + name); } catch (e) { failed++; console.log('FAIL- ' + name + '\n  ' + (e && e.message)); }
}
if (failed) { console.log(failed + ' failed'); process.exit(1); }
console.log('onboarding-import: ' + tests.length + ' passed');
