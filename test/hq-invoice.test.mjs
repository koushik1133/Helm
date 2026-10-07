// hq-invoice.test.mjs — public/hq-invoice.js: formatting helpers, defensive
// normalisation of the (not yet final) invoice JSON, and a DOM render against a
// tiny fake document proving data is written as text only (no innerHTML).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const inv = require('../public/hq-invoice.js');
const { formatMoney, formatDate, formatPeriod, normalize } = inv.helpers;
const SRC = readFileSync(new URL('../public/hq-invoice.js', import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('formatMoney: Indian grouping, 2 decimals, INR symbol', () => {
  assert.equal(formatMoney(1234567.5, 'INR'), '₹12,34,567.50');
  assert.equal(formatMoney(999), '₹999.00');
  assert.equal(formatMoney('179.82'), '₹179.82');
  assert.equal(formatMoney(100, 'usd'), '$100.00');
  assert.equal(formatMoney(100, 'EUR'), '€100.00');
  assert.equal(formatMoney(100, 'X1'), 'X1 100.00');
  assert.equal(formatMoney(null), '—');
  assert.equal(formatMoney('abc'), '—');
});

t('formatDate / formatPeriod', () => {
  assert.equal(formatDate('2026-10-07'), '07 Oct 2026');
  assert.equal(formatDate('2026-01-31T18:30:00Z'), '31 Jan 2026');
  assert.equal(formatDate('nonsense'), '—');
  assert.equal(formatDate('2026-13-01'), '—');
  assert.equal(formatPeriod('2026-10-01', '2026-10-31'), '01 Oct 2026 – 31 Oct 2026');
  assert.equal(formatPeriod(null, undefined), '—');
});

t('normalize: nested shape', () => {
  const m = normalize({
    invoice_no: 'HELM/0001', paid_on: '2026-10-07', period_start: '2026-10-01', period_end: '2026-10-31',
    net: 999, gst_rate: 18, gst_amount: 179.82, amount: 1178.82, method: 'razorpay', reference: 'pay_X',
    plan: { name: 'Studio Pro' }, seller: { legal_name: 'Helm Pvt Ltd', gstin: '36ABCDE1234F1Z5', address: 'Hyd' },
    buyer: { name: 'Studio A' },
  });
  assert.equal(m.invoiceNo, 'HELM/0001');
  assert.equal(m.total, '₹1,178.82');
  assert.equal(m.gstRate, '18%');
  assert.equal(m.plan, 'Studio Pro');
  assert.equal(m.seller.gstin, '36ABCDE1234F1Z5');
  assert.equal(m.buyer.name, 'Studio A');
  assert.equal(m.voided, false);
});

t('normalize: flat shape + derived GST/total + void', () => {
  const m = normalize({ net: 1000, seller_legal_name: 'Helm', studio_name: 'B', plan_name: 'Basic', voided_at: '2026-10-08T00:00:00Z', provider_payment_id: 'pay_Y', seller: { gst_rate: 18 } });
  assert.equal(m.gstAmount, '₹180.00');
  assert.equal(m.total, '₹1,180.00');
  assert.equal(m.reference, 'pay_Y');
  assert.equal(m.buyer.name, 'B');
  assert.equal(m.voided, true);
});

t('normalize: garbage input never throws', () => {
  for (const x of [null, undefined, 5, 'x', [], { net: 'abc', seller: 'str' }]) {
    const m = normalize(x);
    assert.equal(typeof m.invoiceNo, 'string');
  }
});

// --- minimal fake DOM ----------------------------------------------------------
function fakeDoc() {
  const mk = (tag) => ({
    tag, className: '', textContent: '', style: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    get firstChild() { return this.children[0] || null; },
    set innerHTML(_) { throw new Error('innerHTML used'); },
  });
  return { title: '', head: mk('head'), body: mk('body'), documentElement: mk('html'), createElement: mk };
}
const allText = (node) => [node.textContent, ...node.children.flatMap(allText)];
const allNodes = (node) => [node, ...node.children.flatMap(allNodes)];

t('render: hostile values land as text, VOID watermark present when voided', () => {
  const doc = fakeDoc();
  inv.render(doc, { invoice_no: '<img src=x onerror=alert(1)>', buyer: { name: '<script>x</script>' }, net: 10, gst_rate: 18, voided_at: 'x' });
  const texts = allText(doc.body);
  assert.ok(texts.includes('<script>x</script>'));
  assert.ok(allNodes(doc.body).some((e) => e.className === 'void' && e.textContent === 'VOID'));
  assert.ok(!allNodes(doc.body).some((e) => e.tag === 'script' || e.tag === 'img'));
  assert.match(doc.title, /^Tax Invoice /);
});

t('render: no VOID when not voided', () => {
  const doc = fakeDoc();
  inv.render(doc, { net: 10 });
  assert.ok(!allNodes(doc.body).some((e) => e.className === 'void'));
});

t('source: no innerHTML / document.write / eval / external URLs', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write\(|eval\(|new Function/);
  assert.doesNotMatch(code, /https?:\/\//);
});

t('gst_split from RPC: IGST line / CGST+SGST lines', () => {
  const base = { net: 1000, gst_rate: 18, gst_amount: 180, seller: { state: 'Telangana' }, buyer: { legal_name: 'Studio A LLP', name: 'A', gstin: '29AAAAA0000A1Z5', address: 'Blr', state: 'Karnataka' } };
  const i = normalize({ ...base, gst_split: { type: 'IGST', igst: 180 } });
  assert.deepEqual(i.gstLines, [{ label: 'IGST @ 18%', amount: '₹180.00' }]);
  assert.equal(i.buyer.name, 'Studio A LLP');
  assert.equal(i.buyer.state, 'Karnataka');
  assert.equal(i.placeOfSupply, 'Karnataka');
  const c = normalize({ ...base, gst_split: { type: 'CGST_SGST', cgst: 90, sgst: 90 } });
  assert.deepEqual(c.gstLines.map((x) => x.label + ' ' + x.amount), ['CGST @ 9% ₹90.00', 'SGST @ 9% ₹90.00']);
});

t('gst_split missing: derived from seller/buyer states', () => {
  const same = normalize({ net: 1000, gst_rate: 18, seller: { state: 'Telangana' }, buyer: { state: ' telangana ' } });
  assert.deepEqual(same.gstLines.map((x) => x.label), ['CGST @ 9%', 'SGST @ 9%']);
  assert.equal(same.gstLines[0].amount, '₹90.00');
  const other = normalize({ net: 1000, gst_rate: 18, seller: { state: 'Telangana' }, buyer: { state: 'Kerala' } });
  assert.deepEqual(other.gstLines, [{ label: 'IGST @ 18%', amount: '₹180.00' }]);
  const unknown = normalize({ net: 1000, gst_rate: 18 });
  assert.deepEqual(unknown.gstLines, [{ label: 'GST @ 18%', amount: '₹180.00' }]);
  assert.equal(unknown.placeOfSupply, '—');
  const odd = normalize({ net: 1001, gst_rate: 18, gst_amount: 180.19, seller: { state: 'X' }, buyer: { state: 'X' } });
  assert.deepEqual(odd.gstLines.map((x) => x.amount), ['₹90.10', '₹90.09']);  // halves sum to total GST
});

t('render: buyer fields, CGST/SGST rows and place of supply appear', () => {
  const doc = fakeDoc();
  inv.render(doc, { net: 1000, gst_rate: 18, seller: { state: 'Telangana' }, buyer: { legal_name: 'Studio A LLP', gstin: '36AAAAA0000A1Z5', address: 'Hyd', state: 'Telangana' } });
  const texts = allText(doc.body);
  for (const s of ['Studio A LLP', 'GSTIN: 36AAAAA0000A1Z5', 'State: Telangana', 'CGST @ 9%', 'SGST @ 9%', 'Place of supply: Telangana']) assert.ok(texts.includes(s), s);
  assert.ok(!texts.some((x) => /^IGST/.test(x)));
});

t('global: export with 0% tax + LUT note -> "Invoice", no tax lines, note shown', () => {
  const data = { invoice_no: 'E1', currency: 'USD', net_amount: 100, total: 100,
    tax: { regime: 'export_lut', components: [], note: 'Supply meant for export under LUT without payment of IGST', lut_number: 'AD360000000000X' },
    seller: { legal_name: 'Helm Pvt Ltd', gstin: '36ABCDE1234F1Z5', state: 'Telangana', country: 'India' },
    buyer: { legal_name: 'Acme Inc', country: 'United States', state: 'CA', tax_id_type: 'EIN', tax_id: '12-3456789', address: 'SF' },
    place_of_supply: 'Outside India' };
  const m = normalize(data);
  assert.equal(m.title, 'Invoice');
  assert.deepEqual(m.gstLines, []);
  assert.match(m.taxNote, /under LUT/); assert.match(m.taxNote, /AD360000000000X/);
  assert.equal(m.placeOfSupply, 'Outside India');
  const doc = fakeDoc(); inv.render(doc, data);
  const texts = allText(doc.body);
  for (const s of ['INVOICE', 'EIN: 12-3456789', 'Country: United States', 'Country: India', 'Place of supply: Outside India']) assert.ok(texts.includes(s), s);
  assert.ok(allNodes(doc.body).some((e) => e.className === 'note' && /LUT/.test(e.textContent)));
  assert.ok(!texts.some((x) => /^(IGST|CGST|GST) @/.test(x)));
  assert.match(doc.title, /^Invoice /);
});

t('global: reverse charge -> note prominent, VAT label, 0 lines', () => {
  const m = normalize({ currency: 'EUR', net_amount: 200, total: 200, tax: { regime: 'reverse_charge', components: [], note: 'Reverse charge: VAT to be accounted for by the recipient' },
    buyer: { legal_name: 'Beta GmbH', country: 'Germany', tax_id_type: 'vat', tax_id: 'DE123456789' } });
  assert.equal(m.title, 'Invoice');
  assert.equal(m.buyer.taxIdLabel, 'VAT');
  assert.equal(m.total, '€200.00');
  assert.match(m.taxNote, /^Reverse charge/);
});

t('global: USD with INR equivalent', () => {
  const m = normalize({ currency: 'USD', net_amount: 49, total: 49, fx_rate_to_inr: 83.25, tax: { components: [] }, buyer: { country: 'US' } });
  assert.equal(m.total, '$49.00');
  assert.equal(m.inrEquivalent, 'INR equivalent @ 83.25: ₹4,079.25');
  const given = normalize({ currency: 'USD', total: 49, fx_rate_to_inr: 83.25, inr_equivalent: 4080 });
  assert.equal(given.inrEquivalent, 'INR equivalent @ 83.25: ₹4,080.00');
  assert.equal(normalize({ currency: 'INR', total: 49, fx_rate_to_inr: 1 }).inrEquivalent, '');
});

t('global: Indian intra-state from tax.components -> "Tax Invoice", CGST+SGST, lines[]', () => {
  const data = { currency: 'INR', net_amount: 1000, total: 1180,
    tax: { regime: 'gst_intra', components: [{ name: 'CGST', rate: 9, amount: 90 }, { name: 'SGST', rate: 9, amount: 90 }] },
    seller: { state: 'Telangana', country: 'India' }, buyer: { legal_name: 'Studio A LLP', country: 'India', state: 'Telangana', tax_id_type: 'GSTIN', tax_id: '36AAAAA0000A1Z5' },
    place_of_supply: 'Telangana (36)', lines: [{ description: 'Studio Pro — Oct 2026', amount: 1000 }] };
  const m = normalize(data);
  assert.equal(m.title, 'Tax Invoice');
  assert.deepEqual(m.gstLines, [{ label: 'CGST @ 9%', amount: '₹90.00' }, { label: 'SGST @ 9%', amount: '₹90.00' }]);
  assert.equal(m.gstAmount, '₹180.00');
  const doc = fakeDoc(); inv.render(doc, data);
  const texts = allText(doc.body);
  for (const s of ['TAX INVOICE', 'GSTIN: 36AAAAA0000A1Z5', 'Studio Pro — Oct 2026', 'Place of supply: Telangana (36)', 'CGST @ 9%']) assert.ok(texts.includes(s), s);
});

console.log(`hq-invoice: ${n} passed`);
