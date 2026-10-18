// PP1028: pre-push fixes (approval wording, no silent default decor, discount ₹/% exclusive,
// version labels, budget range, negative paste, toasts above modals, booklet advance, crew_schedule SQL)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/quote-state.js'), ctx); vm.runInContext(read('public/booklet.js'), ctx);
const flow = read('public/flow.html'), quotes = read('public/quotes.html'), builder = read('public/builder.js');

t('#1 approval wording follows the real approval state', () => {
  const s = ctx.HelmApprovalState;
  assert.equal(s('none', false, false), 'Not sent yet.');
  assert.equal(s('', false, false), 'Not sent yet.');
  assert.equal(s('sent', true, false), 'Awaiting client approval.');
  assert.equal(s('none', true, false), 'Awaiting client approval.');
  assert.equal(s('approved', true, false), 'Client approved — advance pending.');
  assert.equal(s('approved', true, true), 'Booking confirmed.');
  assert.equal(s('paid', true, false), 'Booking confirmed.');
  assert.ok(!/ev\.status==='confirmed'\) \$\("#apprState"\)/.test(flow), 'internal confirm no longer = client approved');
  assert.match(flow, /apprStateText\(/);
});
t('#2 builder never auto-adds priced default decor to a priced / locked quote', () => {
  const a = ctx.HelmBuilderAutoDefault;
  assert.equal(a({ status: 'confirmed' }, false, false), false);
  assert.equal(a({ status: 'quote', approvalStatus: 'sent' }, false, false), false);
  assert.equal(a({ status: 'quote' }, true, false), false);
  assert.equal(a({ status: 'quote', approvalStatus: 'none' }, false, false), true, 'brand-new unpriced quote keeps the default');
  assert.equal(a({ status: 'confirmed' }, true, true), true, 'explicit ?gen=1 still generates');
  assert.match(builder, /_ppAllowAuto && !ver\.data\.items\.length/);
});
t('#3/#5 discount ₹ and % are exclusive; % kept as % (never both)', () => {
  const p = ctx.HelmDiscount.pick;
  assert.deepEqual({ ...p('6400', '') }, { discount: 6400, discountPct: 0 });
  assert.deepEqual({ ...p('6400', '10') }, { discount: 0, discountPct: 10 });
  assert.deepEqual({ ...p(0, 150) }, { discount: 0, discountPct: 100 });
  assert.deepEqual({ ...p('', '') }, { discount: 0, discountPct: 0 });
  assert.match(flow, /id="q_discountPct"/);
  assert.match(flow, /HelmDiscount\.wireExclusive\(\$\("#q_discount"\), \$\("#q_discountPct"\)\)/);
  assert.match(quotes, /HelmDiscount\.wireExclusive\(\$\("#p_discount"\), \$\("#p_discountPct"\)\)/);
  assert.match(quotes, /\.\.\.HelmDiscount\.pick\(\$\("#p_discount"\)\.value, \$\("#p_discountPct"\)\.value\)/);
  // wireExclusive: editing one clears the other
  const mk = (v) => { const h = {}; return { value: v, addEventListener: (e, f) => { h[e] = f; }, fire: (e) => h[e]() }; };
  const a = mk('500'), b = mk('5'); ctx.HelmDiscount.wireExclusive(a, b);
  b.value = '10'; b.fire('input'); assert.equal(a.value, '0');
  a.value = '700'; a.fire('input'); assert.equal(b.value, '0');
});
t('#4 saved version is not labelled current when live pricing differs', () => {
  assert.equal(ctx.HelmVersionLabel.differs(223728, 67968), true);
  assert.equal(ctx.HelmVersionLabel.differs(67968, 67968.2), false);
  assert.equal(ctx.HelmVersionLabel.differs(null, 67968), false);
  assert.match(flow, /Current \(unsaved changes\)/);
  assert.match(flow, /'saved '\+esc\(sd\(v\)\)/);
  assert.match(read('public/booklet.js'), /differs \? "Saved" : "Latest"/);
});
t('#6 negative discount rejected with a message; hardener clears a pasted negative', () => {
  const e = ctx.HelmDiscount.rawError;
  assert.match(e('-500', ''), /negative/); assert.match(e('', '-5'), /negative/); assert.match(e('', '120'), /100/);
  assert.equal(e('500', ''), '');
  assert.match(read('public/store-api.js'), /PP1028 #6[\s\S]{0,200}el\.value = ""/);
});
t('#7 budget range only validated when both filled', () => {
  const b = ctx.HelmBudgetRange.bad;
  assert.equal(b('', ''), false); assert.equal(b('5000', ''), false); assert.equal(b('', '100'), false);
  assert.equal(b('5000', '100'), true); assert.equal(b('100', '5000'), false);
});
t('#8 toasts move to the top while a modal is open', () => {
  assert.match(read('public/store-api.js'), /html:has\(\[role=dialog\]\[aria-modal=true\]:not\(\[hidden\]\)\) \.bpui-toasts/);
});
t('#9 booklet payment schedule includes the advance', () => {
  const w = ctx.HelmBooklet.withAdvance;
  const r = w([{ label: 'Balance', amount: 70000 }], 100000, { advance_pct: 30 });
  assert.equal(r.length, 2); assert.match(r[0].label, /Advance \(30%\)/); assert.equal(r[0].amount, 30000);
  assert.equal(w([{ label: 'Advance', amount: 1 }], 100000, { advance_pct: 30 }).length, 1);
  assert.equal(w([], 100000, null).length, 1, '1029 #2: no stored terms -> flow default 10%');
  assert.equal(w([], 100000, { advance_pct: 0 }).length, 0, 'an explicit 0% shows no advance row');
});
t('#10 0163 crew_schedule hardening: ASCII, org-pinned role, deleted excluded, MANIFEST', () => {
  for (const f of ['supabase/migrations/0163_crew_schedule_hardening.sql', 'supabase/APPLY-0163.sql']) {
    const s = read(f); assert.ok(/^[\x00-\x7f]*$/.test(s), f + ' ascii');
    assert.match(s, /pr\.id = auth\.uid\(\) and pr\.org_id = v_org/);
    assert.match(s, /q\.org_id = v_org and q\.deleted_at is null/);
    assert.match(s, /create or replace function public\.crew_schedule/);
    assert.ok(!/\b(drop|delete|truncate|alter table)\b/i.test(s.replace(/--.*$/gm, '')), 'additive only');
  }
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0163_crew_schedule_hardening\.sql/);
});
console.log(`prepush-1028: ${n} passed`);
