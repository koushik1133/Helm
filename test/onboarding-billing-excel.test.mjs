// Onboarding: required billing details + Excel import (xlsx-lite) + "update by exact name".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const O = require('../public/onboarding-core.js');
const X = require('../public/xlsx-lite.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);

const good = { legal_name: 'Aurora Events Pvt Ltd', line1: '12 Road No 3', city: 'Hyderabad', state: 'Telangana', pin: '500034', phone: '+91 98765 43210', location: 'Hyderabad' };
t('billing: complete details pass; GSTIN optional', () => { const r = O.validateBilling(good); assert.equal(r.ok, true); assert.equal(r.data.gstin, ''); });
t('billing: every required field is enforced with a message', () => {
  const r = O.validateBilling({});
  for (const k of ['legal_name', 'line1', 'city', 'state', 'pin', 'phone', 'location']) assert.ok(r.errors[k], k);
  assert.equal(r.errors.gstin, undefined); assert.equal(r.errors.line2, undefined);
});
t('billing: PIN, phone and GSTIN formats', () => {
  assert.ok(O.validateBilling({ ...good, pin: '012345' }).errors.pin);
  assert.ok(O.validateBilling({ ...good, pin: '5000' }).errors.pin);
  assert.ok(O.validateBilling({ ...good, phone: '12345' }).errors.phone);
  assert.ok(O.validateBilling({ ...good, gstin: '36ABCDE1234F1Z' }).errors.gstin);
  const ok = O.validateBilling({ ...good, gstin: ' 36abcde1234f1z5 ' }); assert.equal(ok.ok, true); assert.equal(ok.data.gstin, '36ABCDE1234F1Z5');
});
t('billing: markup is stripped', () => assert.equal(O.validateBilling({ ...good, legal_name: '<b>Aurora</b>' }).data.legal_name, 'Aurora'));
t('billing patch keeps other brand keys and the studio name', () => {
  const org = { name: 'Aurora', brand: { logo: 'https://x/l.png', accent: '#111', billing: { extra: 1 } } };
  const p = O.billingPatch(org, O.validateBilling({ ...good, gstin: '36ABCDE1234F1Z5' }).data);
  assert.equal(p.name, undefined); assert.equal(p.brand.logo, 'https://x/l.png'); assert.equal(p.brand.accent, '#111');
  assert.equal(p.brand.billing.extra, 1); assert.equal(p.brand.billing.pin, '500034'); assert.equal(p.brand.phone, '+91 98765 43210');
  assert.equal(p.location, 'Hyderabad'); assert.equal(p.gst_number, '36ABCDE1234F1Z5');
  assert.equal(O.billingPatch({ name: '' }, O.validateBilling(good).data).name, 'Aurora Events Pvt Ltd');
});
t('billing: existing studio missing details is detected; round-trip is complete', () => {
  assert.ok(O.billingMissing({ name: 'Old studio', brand: {} }).length >= 6);
  const p = O.billingPatch({ name: 'x' }, O.validateBilling(good).data);
  assert.deepEqual(O.billingMissing(Object.assign({ name: 'x' }, p)), []);
});
t('update by EXACT name only (pricing + inventory), never for near matches', () => {
  const table = [['type', 'name', 'price'], ['chair', 'Gold', '900'], ['chair', 'silver ', '500']];
  const ex = [{ id: 'a', name: 'Gold', _type: 'chair' }, { id: 'b', name: 'Silver', _type: 'chair' }];
  const map = { type: 0, name: 1, price: 2 };
  let p = O.buildPreview('pricing', table, map, ex, { 2: 'update', 3: 'update' });
  assert.equal(p.rows[0].updatable, true); assert.equal(p.rows[0].action, 'update');
  assert.equal(p.rows[1].updatable, false); assert.equal(p.rows[1].action, 'skip');
  assert.equal(p.summary.willMerge, 1);
});
t('applyBatch: update calls api.update, never delete; default stays skip', async () => {
  const table = [['type', 'name', 'price'], ['chair', 'Gold', '900'], ['plate', 'Veg', '300']];
  const ex = [{ id: 'a', name: 'Gold', _type: 'chair' }];
  const calls = [];
  const api = { create: async (k, pl) => { calls.push(['create', pl.name]); return { id: 'n1' }; }, update: async (k, id, pl) => { calls.push(['update', id, pl.price]); }, merge: async () => { throw new Error('no'); }, deactivate: async () => { calls.push(['deactivate']); } };
  const skip = O.buildPreview('pricing', table, { type: 0, name: 1, price: 2 }, ex, {});
  await O.applyBatch({ kind: 'pricing', rows: skip.rows, batchKey: 'b1', ledger: { entries: {} }, api });
  assert.deepEqual(calls, [['create', 'Veg']]); calls.length = 0;
  const upd = O.buildPreview('pricing', table, { type: 0, name: 1, price: 2 }, ex, { 2: 'update' });
  const r = await O.applyBatch({ kind: 'pricing', rows: upd.rows, batchKey: 'b2', ledger: { entries: {} }, api });
  assert.deepEqual(calls, [['create', 'Veg'], ['update', 'a', 900]]); assert.equal(r.counts.merged, 1);
  assert.ok(!calls.some((c) => c[0] === 'deactivate'));
});
t('xlsx: template round-trips through the reader', async () => {
  const rows = [['Name', 'Price'], ['Gold chair', '1,250'], ['A & <b> "q"', '=1+1']];
  const r = await X.readXlsx(X.buildXlsx(rows, 'Pricing'));
  assert.deepEqual(r.rows, rows); assert.deepEqual(r.sheetNames, ['Pricing']);
  assert.equal(X.toCSV(r.rows), 'Name,Price\r\nGold chair,"1,250"\r\n"A & <b> ""q""",=1+1\r\n');
  // formula-looking text is neutralised later by validation, never evaluated
  assert.equal(O.safeText('=1+1').startsWith("'"), true);
});
t('xlsx: shared strings, numbers, booleans, gaps', () => {
  const ss = X.parseShared('<sst><si><t>Item</t></si><si><r><t>Chiavari</t></r><r><t xml:space="preserve"> chair</t></r></si></sst>');
  const rows = X.parseSheet('<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>450.50000000000006</v></c><c r="D2" t="b"><v>1</v></c></row></sheetData>', ss);
  assert.deepEqual(rows, [['Item'], ['Chiavari chair', '', '450.5', 'TRUE']]);
});
t('xlsx: old binary .xls is refused with a clear message', async () => {
  const ole = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0]);
  assert.equal(X.kindOf(ole), 'ole');
  await assert.rejects(X.readXlsx(ole), /Save As/);
  assert.equal(X.kindOf(new TextEncoder().encode('name,price\n')), 'text');
});
t('UI wiring: onboarding loads xlsx-lite, accepts .xlsx/.xls/.csv, requires billing to finish', () => {
  const h = read('public/onboarding.html'), js = read('public/onboarding.js');
  assert.match(h, /<script src="xlsx-lite\.js\?v=2"><\/script>\n<script src="onboarding-core\.js\?v=3"><\/script>\n<script src="onboarding\.js\?v=5"><\/script>/);
  assert.match(js, /accept="\.xlsx,\.xls,\.csv/);
  assert.match(js, /Download Excel template/);
  assert.match(js, /if \(org && !billingOk\(\)\) return `<div class="ob-card"><h2>Almost there/);
  assert.doesNotMatch(js, /\.delete\(|hardDelete/);
});
t('Control Center: billing fields, missing-details prompt, Import from Excel', () => {
  const c = read('public/control.html');
  for (const id of ['o_legal', 'o_line1', 'o_line2', 'o_city', 'o_state', 'o_pin', 'billPrompt']) assert.match(c, new RegExp('id="' + id + '"'));
  assert.match(c, /<script src="onboarding-core\.js\?v=3"><\/script>/);
  assert.match(c, /<h3>Import from Excel<\/h3>/);
  assert.match(c, /href="onboarding\.html#s1">Import price list/);
});
for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log(`onboarding-billing-excel: ${n} passed`);
