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
  assert.equal(formatMoney(100, 'usd'), 'USD 100.00');
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

console.log(`hq-invoice: ${n} passed`);
