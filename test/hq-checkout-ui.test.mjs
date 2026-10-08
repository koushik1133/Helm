// HQ checkout settings UI (0056): plan checkout details + studio checkout switches.
// Pure arg builders are extracted from public/hq.js and run in a vm; static checks pin
// the markup (clear labels, no inline handlers/styles) and textContent-only rendering.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const JS = read('public/hq.js'), HTML = read('public/hq.html'), SQL = read('supabase/migrations/0056_onboarding_checkout.sql');
function fn(name) {
  const i = JS.indexOf('  function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = JS.indexOf('\n  }\n', i);
  const ctx = {}; vm.createContext(ctx); vm.runInContext(JS.slice(i, j + 4) + '\nthis.f = ' + name + ';', ctx);
  return ctx.f;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
let n = 0; const t = (name, f) => { f(); n++; console.log('ok - ' + name); };

t('checkout switches → hq_set_checkout_settings args', () => {
  const f = fn('checkoutSettingsArgs');
  assert.deepEqual(plain(f(true, false, ' 2026-11 ')), { p_allow_trial_bypass: false, p_online_payments_live: true, p_terms_version: '2026-11' });
  assert.deepEqual(plain(f(0, 1, '')), { p_allow_trial_bypass: true, p_online_payments_live: false, p_terms_version: null });
  assert.throws(() => f(false, false, 'v 1<script>'));
});
t('plan checkout details → hq_set_plan_checkout args (trimmed, validated)', () => {
  const f = fn('planCheckoutArgs');
  const a = plain(f('studio', 'INR', '  Growing  teams ', ' Unlimited members \n\n  Priority   support \r\n', 'plan_ABC123456', ''));
  assert.deepEqual(a, { p_code: 'studio', p_currency: 'INR', p_description: 'Growing teams', p_features: ['Unlimited members', 'Priority support'],
    p_sort_order: null, p_razorpay_plan_id_monthly: 'plan_ABC123456', p_razorpay_plan_id_yearly: null });
  assert.throws(() => f('studio', 'INR', '', '', 'pay_123', ''), /plan_/);
  assert.throws(() => f('studio', 'INR', '', '', '', 'plan_x'), /plan_/);
  assert.throws(() => f('studio', 'INR', '', '<img src=x>', '', ''));
  assert.throws(() => f('studio', 'INR', '', Array(22).fill('x').join('\n'), '', ''), /20/);
  assert.throws(() => f('', 'INR', '', '', '', ''));
  assert.equal(f('studio', 'zz', '', '', '', '').p_currency, 'INR');
});
t('markup: clear labels, testing bypass obvious, no inline handlers / style=', () => {
  assert.match(HTML, /Testing bypass: show “Skip payment \(testing only\)”/);
  assert.match(HTML, /Turn OFF before launch/);
  assert.match(HTML, /Online payment is live/);
  for (const id of ['coLive', 'coBypass', 'coTermsV', 'btnCheckout', 'tPlanCo', 'pcDesc', 'pcFeat', 'pcRzpM', 'pcRzpY', 'btnPlanCo'])
    assert.match(HTML, new RegExp('id="' + id + '"'), id);
  assert.doesNotMatch(HTML, /\sstyle="/); assert.doesNotMatch(HTML, /\son[a-z]+="/i);
  assert.match(HTML, /hq\.js\?v=8/);
});
t('rendering: textContent / createElement only; writes go through the gated RPCs', () => {
  assert.doesNotMatch(JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(JS, /call\("hq_set_checkout_settings", a\)/);
  assert.match(JS, /call\("hq_set_plan_checkout", a\)/);
  assert.match(JS, /call\("hq_plan_checkout"\)/);
});
t('SQL: HQ read is operator-gated, writes go through _hq_wgate (aal2 + audit)', () => {
  assert.match(SQL, /function public\.hq_plan_checkout\(\)[\s\S]*?_hq_gate\('hq_plan_checkout'\)/);
  assert.match(SQL, /function public\.hq_set_checkout_settings[\s\S]*?_hq_wgate\(/);
  assert.match(SQL, /function public\.hq_set_plan_checkout[\s\S]*?_hq_wgate\(/);
});
console.log(`hq-checkout-ui: ${n} passed`);
