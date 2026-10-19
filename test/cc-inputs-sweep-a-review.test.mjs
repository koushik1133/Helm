// Review of Control Center input sweep A (Oct 2026): the rest of the General boxes (studio name,
// currency, timezone), a logo host with an empty label, the suggested-access button never
// downgrading an existing edit grant, the PIN "paste would overflow" message and the link-expiry
// save message.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
require('../public/form-validate.js');
const C = require('../public/cc-inputs.js');
const ctl = r('public/control.html');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const okv = (res, v) => { assert.equal(res.ok, true, JSON.stringify(res)); if (v !== undefined) assert.equal(res.value, v); };
const no = (res, re) => { assert.equal(res.ok, false, JSON.stringify(res)); if (re) assert.match(res.error, re); };

await t('studio name: required (the column is NOT NULL), trimmed + inner spaces collapsed, 80 max, needs a letter/digit', () => {
  no(C.studioName(''), /Enter your studio/); no(C.studioName('   '), /Enter your studio/); no(C.studioName('​'), /Enter your studio/);
  okv(C.studioName('  Aurora   Events '), 'Aurora Events'); okv(C.studioName('A&B Events 2'), 'A&B Events 2');
  okv(C.studioName('Événements Élégance'), 'Événements Élégance');
  okv(C.studioName('x'.repeat(80))); no(C.studioName('x'.repeat(81)), /80 characters .*81/);
  no(C.studioName('---'), /letter or number/); no(C.studioName('😀😀'), /letter or number/); no(C.studioName('<b>x</b>'), /< or >/);
});

await t('currency: 3-letter code, lower case / spaces fixed; symbols and words refused; empty is allowed', () => {
  okv(C.currency(''), ''); okv(C.currency(' inr '), 'INR'); okv(C.currency('aed'), 'AED');
  no(C.currency('₹'), /not the symbol/); no(C.currency('US$'), /not the symbol/); no(C.currency('rupees'), /3-letter/);
  no(C.currency('IN'), /3-letter/); no(C.currency('INR1'), /3-letter/);
});

await t('timezone: IANA names only, case + spaces fixed; abbreviations, offsets, cities and typos refused', () => {
  okv(C.timezone(''), ''); okv(C.timezone('Asia/Kolkata'), 'Asia/Kolkata'); okv(C.timezone('asia/kolkata'), 'Asia/Kolkata');
  okv(C.timezone('Asia / Dubai'), 'Asia/Dubai'); okv(C.timezone('America/New York'), 'America/New_York'); okv(C.timezone('utc'), 'UTC');
  okv(C.timezone('Asia/Calcutta'));
  for (const bad of ['IST', 'GST', '+05:30', '5.5', 'GMT+5:30']) no(C.timezone(bad), /timezone name|isn't a timezone/);
  no(C.timezone('Hyderabad'), /isn't a timezone/); no(C.timezone('Asia/Kolkatta'), /isn't a timezone/); no(C.timezone('x'.repeat(41)), /too long/);
});

await t('logo URL: a host with an empty label (x..com) or a trailing dot is refused', () => {
  no(C.logo('https://x..com/a.png'), /website name/); no(C.logo('https://cdn.x.com./a.png'), /website name/);
  okv(C.logo('https://cdn.x.com/a.png'));
});

await t('control.html: name / currency / timezone are checked under the box and saved normalised; empty currency follows the country', () => {
  assert.match(ctl, /<input id="o_name" maxlength="120"/); assert.match(ctl, /<input id="o_currency" maxlength="8"/); assert.match(ctl, /<input id="o_tz" maxlength="60"/);
  assert.match(ctl, /HelmCCInputs\.first\(\[G\.email,G\.phone,G\.logo,G\.accent,G\.currency,G\.tz,G\.tax\]\)/);
  assert.doesNotMatch(ctl, /name:ccv\(G&&G\.name,"o_name"\)/, 'r23 (0257): the studio name is fixed at creation - never sent by the General save');
  assert.match(ctl, /currency:ccv\(G&&G\.currency,"o_currency"\)\.toUpperCase\(\)\|\|\(ctp&&ctp\.known\?ctp\.currency:"INR"\)/);
  assert.match(ctl, /timezone:ccv\(G&&G\.tz,"o_tz"\)\|\|"Asia\/Kolkata"/);
  const ci = r('public/cc-inputs.js');
  assert.match(ci, /name: b\("o_name", "cc_name", \{ required: function \(\) \{ return true; \} \}\), currency: b\("o_currency", "cc_currency"\), tz: b\("o_tz", "cc_tz"\)/);
  assert.match(ctl, /lxMsg\("err",lxCheck\(\)\.error\|\|/);
});

await t('Roles & access: "Apply suggested access" only adds - an area the role can already edit keeps edit', async () => {
  const src = ctl.slice(ctl.indexOf('  var ROLE_SUGGEST = {'), ctl.indexOf('  /* ---------------- NOTIFICATIONS (0036)'));
  const calls = [], attrs = {};
  const ctx = {
    AREAS: ['design', 'layouts', 'proposal', 'quotes', 'calendar', 'templates', 'media', 'runsheet'].map((k) => ({ key: k, label: k.toUpperCase() })),
    MTX: { designer: { quotes: { view: true, edit: true }, design: { view: true, edit: true }, calendar: { view: false, edit: false }, proposal: { view: true, edit: false } } },
    cellDefault: () => ({ view: false, edit: false }), loadMatrix: async () => true, renderMatrix() {}, errMsg: () => 'ERR', mtxErr: null,
    $: () => ({ setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } }),
    BPUI: { confirm: async () => true, toast() {} },
    BPStore: { auth: { admin: { roleLabel: (x) => x, setAccess: async (...a) => { calls.push(a); } } } },
  };
  vm.createContext(ctx); vm.runInContext(src.replace('let cellQueue', 'var cellQueue').replace(/\bconst MTX\b/, 'var MTX') + '\n;this.applySuggested=applySuggested;', ctx);
  const btn = { disabled: false };
  await ctx.applySuggested('designer', btn);
  const by = Object.fromEntries(calls.map(([, a, v, e]) => [a, [v, e]]));
  assert.equal(by.design, undefined, 'already view + edit: skipped');
  assert.equal(by.quotes, undefined, 'view + edit kept: before, the (view) suggestion sent setAccess(quotes, true, false) and took edit away');
  assert.ok(!calls.some(([, , , e], i) => calls[i][1] === 'quotes' && e === false));
  assert.deepEqual(by.proposal, [true, true], 'view-only area gets the suggested edit');
  assert.deepEqual(by.calendar, [true, false]); assert.deepEqual(by.layouts, [true, true]);
  assert.equal(attrs['aria-busy'], undefined, 'busy flag cleared when the queue empties');
});

await t('privacy PIN: a paste that would overflow the 4 digits says so (not "this paste has 2 digits")', () => {
  const pp = r('public/privacy-pin-settings.js');
  assert.match(pp, /would make " \+ res\.length \+ " — the PIN is exactly 4\. Clear the box and paste again\./);
});

console.log(`cc-inputs-sweep-a-review: ${n} test(s) passed.`);
