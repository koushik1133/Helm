#!/usr/bin/env node
// sim-pay-prod-ui.test.mjs — /sim-pay is 404 on production hosts, so no prod UI may
// offer the simulated online payment: approve.html shows "Your planner will share
// payment details", flow.html offers manual recording only. Staging/local unchanged.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let passed = 0; const t = (n, fn) => { fn(); passed++; console.log('  ✓ ' + n); };

const store = read('public/store-api.js');
const m = /onlinePayAvailable: (\(\) => [^\n]+),\n    createPayment: ([\s\S]+?: rpc\("create_payment", \{ p_token: token \}\)),/.exec(store);
const evalIn = (win, live) => vm.runInNewContext(`(function(){ const LIVE=${JSON.stringify(live)}; const rpc=()=>"rpc"; const callFn=()=>"fn"; const window=W; return { avail: ${m[1]}, create: ${m[2]} }; })()`, { W: win, Promise, Error });

t('store-api: onlinePayAvailable false only on a prod host with pay not live', () => {
  assert.ok(m, 'onlinePayAvailable/createPayment not found');
  assert.equal(evalIn({ HELM_IS_PROD_HOST: true }, { pay: false }).avail(), false);
  assert.equal(evalIn({ HELM_IS_PROD_HOST: true }, { pay: true }).avail(), true);
  assert.equal(evalIn({}, { pay: false }).avail(), true, 'staging/local unchanged');
});
t('store-api: createPayment refuses (no sim link) on prod host when pay not live', async () => {
  const p = evalIn({ HELM_IS_PROD_HOST: true }, { pay: false }).create('t');
  assert.ok(p instanceof Promise); p.catch(() => {});
  assert.equal(evalIn({}, { pay: false }).create('t'), 'rpc');
  assert.equal(evalIn({ HELM_IS_PROD_HOST: true }, { pay: true }).create('t'), 'fn');
});
t('config.js marks production hosts (HELM_IS_PROD_HOST) in the PROD_HOSTS branch', () => {
  assert.match(read('public/config.js'), /if \(PROD_HOSTS\[h\]\) \{ try \{ window\.HELM_IS_PROD_HOST = true; \} catch \(e\) \{\} return; \}/);
});
t('approve.html: hides Proceed to payment and shows planner note when unavailable', () => {
  const a = read('public/approve.html');
  assert.match(a, /id="payManual" hidden[^>]*>Your planner will share payment details\.</);
  assert.match(a, /if\(!\(BPStore\.approval\.onlinePayAvailable && BPStore\.approval\.onlinePayAvailable\(\)\)\)\{ \$\("#payBtn"\)\.hidden=true;/);
});
t('flow.html: online option removed and no sim-pay link built when unavailable', () => {
  const f = read('public/flow.html');
  assert.match(f, /if\(!BPStore\.approval\.onlinePayAvailable\(\)\)\{ const o=\$\("#pay_method"\)\.querySelector\('option\[value="online"\]'\); if\(o\) o\.remove\(\); \}/);
  const uses = f.split('sim-pay.html').length - 1;
  assert.equal(uses, 1);
  assert.match(f, /if\(method==='online' && BPStore\.approval\.onlinePayAvailable\(\)\)\{ const link=location\.origin\+"\/sim-pay\.html/);
});
t('portal / proposal-view / settlement never link to sim-pay', () => {
  for (const p of ['portal', 'proposal-view', 'settlement']) assert.ok(!/sim-pay/.test(read('public/' + p + '.html')), p);
});
console.log(`\nsim-pay-prod-ui: ${passed} test(s) passed.`);
