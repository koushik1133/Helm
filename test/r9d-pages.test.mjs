// R9d regression tests: audit-format money/pricing edge cases + comms settings blank numbers.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('../public/audit-format.js');

// huge totals must still be grouped, never "₹1e,+21"
assert.equal(A.inr(1e21), '₹1,00,00,00,00,00,00,00,00,00,000');
assert.equal(A.inr(-1234567), '-₹12,34,567');
// string vs number total of the same amount is not a change
assert.equal(A.describe('pricing', { total: '1000' }, { total: 1000 }), 'Pricing details updated (total ₹1,000)');
// an empty-string old total is "unset", not ₹0
assert.equal(A.describe('pricing', { total: '' }, { total: 5 }), 'Total set to ₹5');
assert.equal(A.describe('pricing', { total: 'abc' }, { total: 'x' }), 'Pricing updated');

// comms settings: a blank number field must block save, not save 0
const vals = { cm_pay_before: '', cm_pay_every: '3', cm_pay_max: '3', cm_fu_delay: '3', cm_fu_max: '2', cm_pay_tpl: '', cm_fu_tpl: '', cm_wa_num: '' };
const els = {};
const get = (id) => els[id] || (els[id] = { id, value: vals[id] ?? '', checked: false, textContent: '', dataset: {}, disabled: false,
  addEventListener() {}, firstChild: null, removeChild() {}, appendChild() {}, setAttribute() {}, querySelectorAll: () => [] });
let errText = '';
els.cm_err = Object.assign(get('cm_err'), { appendChild(p) { errText = p.textContent; } });
let setCalled = false, saveFn = null;
els.cm_save = Object.assign(get('cm_save'), { addEventListener(ev, fn) { saveFn = fn; } });
globalThis.document = { getElementById: get, querySelectorAll: () => [], createElement: () => ({ setAttribute() {}, appendChild() {}, dataset: {} }) };
globalThis.window = globalThis;
globalThis.BPStore = { comms: { sample: {}, render: (t) => t,
  get: async () => ({ pay_before_days: 3, pay_every_days: 3, pay_max_overdue: 3, fu_delay_days: 3, fu_max: 2, roles: [], types: [] }),
  set: async () => { setCalled = true; return {}; } } };
els.commsCard = get('commsCard');
new Function(readFileSync(new URL('../public/comms-settings.js', import.meta.url), 'utf8'))();
await globalThis.HelmCommsSettings.init();
els.cm_pay_before.value = '   ';
await saveFn();
assert.equal(setCalled, false, 'blank number must not be saved');
assert.match(errText, /Days before the due date must be a whole number/);
els.cm_pay_before.value = '0';
await saveFn();
assert.equal(setCalled, true, '0 is still a valid explicit value');
console.log('r9d-pages: ok');
// studio WhatsApp number: letters / too short rejected client-side (server strips non-digits)
for (const junk of ['abc12345678xyz', '12345', '+91 98765 43210 ext 5', '1234567890123456']) {
  setCalled = false; els.cm_wa_num.value = junk; await saveFn();
  assert.equal(setCalled, false, 'junk WhatsApp accepted: ' + junk); assert.match(errText, /WhatsApp number with country code/);
}
setCalled = false; els.cm_wa_num.value = '+91 98765-43210'; await saveFn(); assert.equal(setCalled, true);
console.log('r9d-pages wa: ok');
// design.html: edit rights follow the access matrix (canEditArea('design')), not a hard-coded role list
const dh = readFileSync(new URL('../public/design.html', import.meta.url), 'utf8');
assert.match(dh, /canEditArea\("design"\)/);
// insights.html: closed events without a code never print "null"; partial summaries don't crash
const ih = readFileSync(new URL('../public/insights.html', import.meta.url), 'utf8');
assert.doesNotMatch(ih, /label:e\.code\+/); assert.doesNotMatch(ih, /esc\(e\.code\+/);
assert.match(ih, /d=Object\.assign\(\{vendors:\[\],taskSlips:\[\]\},d\)/);
// control.html pricing: blank tax rate refused; failed save doesn't mutate the loaded config
const ch = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
assert.match(ch, /a blank rate would drop tax from new quotes/);
assert.match(ch, /setPricing\(nextCfg\); pricingCfg=nextCfg;/);
console.log('r9d-pages static: ok');
