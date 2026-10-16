// Reports exports (QA Oct 2026): settlements CSV carries ex-tax revenue + GST (0113 ex-tax rule,
// so profit/margin columns elsewhere can be reconciled), print P&L shows Indian DD/MM/YYYY dates,
// CSV keeps the UTF-8 BOM (Excel shows the rupee sign) and the formula-injection guard.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const s = readFileSync(new URL('../public/reports.html', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
t('settlements CSV has revenue_ex_tax + gst (summed per currency)', () => {
  assert.match(s, /revenue_ex_tax:Math\.round\(s\.revenueExTax!=null/); assert.match(s, /gst:Math\.round\(s\.tax\|\|0\)/);
  assert.match(s, /\["revenue","revenue_ex_tax","gst","received"/);
});
t('print P&L uses DD/MM/YYYY', () => { assert.match(s, /esc\(dmy\(e\.date\)\)/); assert.match(s, /generated \$\{esc\(dmy\(today\(\)\)\)\}/); });
t('BOM + injection guard kept', () => { assert.match(s, /new Blob\(\["\\uFEFF"\+text\]/); assert.match(s, /\[=\+\\-@\\t\\r/); });
t('events CSV adds approved_changes + invoice_total (quote total + approved price_delta)', () => {
  assert.match(s, /BPStore\.budget\.listChanges\(e\.id\)/); assert.match(s, /c\.status==="approved"/);
  assert.match(s, /\["total","approved_changes","invoice_total"\]/);
});
const ins = readFileSync(new URL('../public/insights.html', import.meta.url), 'utf8');
t('insights groups event types case-insensitively and shows DD/MM/YYYY', () => {
  assert.match(ins, /const tKey=/); assert.match(ins, /d\.types=mergeTypes\(d\.types,false\)/);
  assert.doesNotMatch(ins, /td\(r\.date\|\|"—"\)/); assert.doesNotMatch(ins, /" · "\+e\.date:/);
  assert.match(ins, /BPStore\.fmtDateIN\(e\.date\)/);
});
console.log(`reports-exports: ${n} passed`);
