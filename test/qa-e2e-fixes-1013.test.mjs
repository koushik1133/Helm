// QA-E2E fixes 2026-10-13: booklet invoice total (0111) + milestone display + single Reference row,
// lead form negatives rejected (not flipped), Invite Studio venue prefill from Plan, profile
// labels, Business revenue note, leads board boot not blocked on bell/account.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const B = ctx.HelmBooklet;
const J = (x) => JSON.parse(JSON.stringify(x));

t('milestones covered by the ledger show paid (display only, in schedule order)', () => {
  const ms = [{ amount: 40000, status: 'paid' }, { amount: 60000, status: 'due' }];
  assert.deepEqual(J(B.msDisplayStatus(ms, 100000)), ['paid', 'paid']);
  assert.deepEqual(J(B.msDisplayStatus(ms, 82600)), ['paid', 'due']);
  assert.deepEqual(J(B.msDisplayStatus([{ amount: 10, status: 'due' }, { amount: 5, status: 'overdue' }], 5)), ['due', 'overdue']);
  assert.deepEqual(J(B.msDisplayStatus([{ amount: 10, status: 'waived' }], 0)), ['waived']);
  assert.equal(ms[1].status, 'due', 'input never mutated');
});
t('balance line is not "Paid in full" while an approved change is due', () => {
  assert.equal(B.balanceLine(87600, 82600, 5000, null, null), 'Balance ' + B.money(5000) + ' due');
  assert.equal(B.balanceLine(87600, 87600, 0, null, null), 'Paid in full');
});
t('booklet: payments total prefers the server invoice total; Reference rendered once', () => {
  const js = read('public/booklet.js');
  assert.match(js, /num\(p\.total\) != null && num\(p\.total\) > 0 \? num\(p\.total\)/);
  assert.equal((js.match(/fact\(dl, "Reference"/g) || []).length, 1);
});
t('0111 migration: additive, ASCII, change orders in _bk_payments, no grants to clients', () => {
  const m = read('supabase/migrations/0111_booklet_invoice_total.sql'), a = read('supabase/APPLY-0111.sql');
  for (const s of [m, a]) { assert.ok(/^[\x00-\x7F]*$/.test(s), 'ascii'); assert.doesNotMatch(s, /\b(drop|delete|truncate|alter table)\b/i); assert.doesNotMatch(s, /grant execute/i); }
  assert.match(m, /create or replace function public\._bk_payments\(p_quote uuid, p_org uuid, p_base jsonb\)/);
  assert.match(m, /change_requests c\s+where c\.quote_id = q\.id and c\.status = 'approved'/);
  assert.match(m, /x\.id = p_quote and x\.org_id = p_org/);
  assert.match(m, /'receipts', v_rc/);
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /VERIFY/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0111_booklet_invoice_total\.sql/);
});
t('lead form: budget / guests keep the minus so the validator rejects it with a message', () => {
  const h = read('public/leads.html');
  assert.match(h, /id="f_budget" type="number" data-allow-negative/);
  assert.match(h, /id="f_guests" type="number" data-allow-negative/);
  assert.match(h, /V\.money\(\$\("#f_budget"\)\.value,\{field:"Budget"\}\)/);
  assert.match(h, /V\.count\(\$\("#f_guests"\)\.value,\{field:"Guest count"\}\)/);
  assert.doesNotMatch(h, /await renderAccount\(\); try\{await BPStore\.bell\.mount/);
});
t('invite studio: Plan venue prefills only empty fields', () => {
  const h = read('public/invite-studio.html');
  assert.match(h, /async function prefillFromPlan\(\)/);
  assert.match(h, /!n\.value\.trim\(\)\) n\.value=/);
  assert.match(h, /await prefillFromPlan\(\); prefillFromQuote\(\)/);
});
t('profile: full name / mobile never labelled optional', () => {
  const a = read('public/auth-ui.js');
  assert.match(a, /else if \(!a\.core\) lab\.appendChild/);
  assert.match(a, /"Full name", \{ req: setup \|\| hadName, core: true/);
  assert.match(a, /"Mobile number", \{ req: setup \|\| hadPhone, core: true/);
});
t('business / dashboard revenue note distinguishes confirmed-without-value', () => {
  for (const f of ['public/shell-b-money.js', 'public/shell-b-dash.js']) {
    const s = read(f); assert.match(s, /var nConf = /, f); assert.match(s, /nConf \? "Your confirmed events add no booked value/, f);
  }
});
console.log(n + ' passed');
