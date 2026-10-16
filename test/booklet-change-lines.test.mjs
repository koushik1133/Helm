// 0114: client booklet Quotation lists approved change orders + "Total incl. approved changes"
// that matches the Payments total; older DBs (no payments.changes) render as before.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const api = ctx.HelmBooklet;

t('older DB without payments.changes -> no rows', () => {
  const r = api.quoteChanges({ payments: { total: 370000 } }, 370000);
  assert.equal(r.rows.length, 0); assert.equal(r.total, null);
  assert.equal(api.quoteChanges({}, 1000).rows.length, 0);
});
t('approved change listed; total = server invoice total (Payments)', () => {
  const r = api.quoteChanges({ payments: { total: 372000, changes: [{ title: 'Extra lights', amount: 2000, date: '2026-10-10' }] } }, 370000);
  assert.equal(r.rows.length, 1); assert.equal(r.rows[0].title, 'Extra lights'); assert.equal(r.rows[0].amount, 2000);
  assert.equal(r.total, 372000);
});
t('no server total -> quote + changes; junk dropped', () => {
  const r = api.quoteChanges({ payments: { changes: [{ title: 'A', amount: '1500.5' }, null, { title: 'B', amount: 'x' }, { title: 'Z', amount: 0 }] } }, 10000);
  assert.equal(r.rows.length, 1); assert.equal(r.total, 11500.5);
});
t('migration 0114: ASCII, approved + org scoped, no cost exposed, internal only, MANIFEST', () => {
  for (const f of ['supabase/migrations/0114_booklet_change_lines.sql', 'supabase/APPLY-0114.sql']) {
    const s = read(f); assert.ok(/^[\x00-\x7f]*$/.test(s), f + ' ascii');
    assert.match(s, /c\.org_id = q\.org_id and c\.status = 'approved'/);
    assert.match(s, /invoice-total-0111/); assert.match(s, /'receipts', v_rc, 'changes', v_ch/);
    assert.ok(!/'cost/.test(s)); assert.ok(!/grant execute/i.test(s));
  }
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0114_booklet_change_lines\.sql/);
});
t('booklet.js renders change rows via DOM (no innerHTML)', () => {
  const s = read('public/booklet.js'); assert.match(s, /Total incl\. approved changes/); assert.ok(!/\.innerHTML\s*=/.test(s));
});
console.log(`booklet-change-lines: ${n} passed`);
