import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/booklet.js', import.meta.url), 'utf8');
const ctx = { console, URLSearchParams }; ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(src, ctx);
const B = ctx.HelmBooklet;

test('advance re-sized after total grows shows paid + remaining (display only)', () => {
  const html = readFileSync(new URL('../public/booklet.html', import.meta.url), 'utf8');
  assert.match(html, /<th scope="col" class="amt">Paid<\/th><th scope="col" class="amt">Remaining<\/th>/);
  const ms = B.withAdvance([], 877212, { advance_pct: 10 });
  const a = JSON.parse(JSON.stringify(B.msAllocate(ms, 16048)));
  assert.equal(ms[0].amount, 87721.2);
  assert.deepEqual(a, [{ status: 'part_paid', paid: 16048, remaining: 71673.2 }]);
});

test('allocation is oldest-first and respects stored paid / waived', () => {
  const J = (x) => JSON.parse(JSON.stringify(x));
  const ms = [{ amount: 100, status: 'paid' }, { amount: 200, status: 'due' }, { amount: 300, status: 'due' }, { amount: 50, status: 'waived' }];
  assert.deepEqual(J(B.msAllocate(ms, 350)), [
    { status: 'paid', paid: 100, remaining: 0 }, { status: 'paid', paid: 200, remaining: 0 },
    { status: 'part_paid', paid: 50, remaining: 250 }, { status: 'waived', paid: 0, remaining: null }]);
  assert.deepEqual(J(B.msAllocate([{ amount: 10, status: 'due' }], 0)), [{ status: 'due', paid: 0, remaining: 10 }]);
});

test('logistics + flow show paid against milestones', () => {
  const l = readFileSync(new URL('../public/logistics.html', import.meta.url), 'utf8');
  assert.match(l, /Part paid/); assert.match(l, /function payCells/);
  const f = readFileSync(new URL('../public/flow.html', import.meta.url), 'utf8');
  assert.match(f, /id="pay_adv_note"/); assert.match(f, /PAID_SUM=paid\.reduce/);
});
