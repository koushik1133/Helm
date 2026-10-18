// uae-polish.test.mjs - UAE audit (Oct 2026, docs/UAE-AUDIT-2026-10.md): AE profile, P.O. box billing,
// quote client emirate + TRN, bilingual Art. 59 tax-invoice title, layout wizard Gulf types + metres,
// flow event types, halal menu wording, 0102 country-aware demo seed, portal title / payments (live E2E).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

t('AE country profile: AED, VAT 5%, TRN 15 digits, 7 emirates, +971, Asia/Dubai', () => {
  const H = require('../public/country-profile.js'); const p = H.get('AE');
  assert.equal(p.currency, 'AED'); assert.equal(p.defaultRate, 5); assert.equal(p.phoneCode, '+971'); assert.equal(p.regions.length, 7);
  assert.equal(H.timezone('AE'), 'Asia/Dubai');
  assert.ok(H.validateTaxId('AE', '100123456700003').ok); assert.ok(!H.validateTaxId('AE', '10012345670000').ok); assert.ok(H.validateTaxId('AE', '').ok);
  const c = H.computeTax('AE', 10000, {}); assert.equal(c.tax, 500); assert.equal(c.total, 10500); assert.equal(c.lines[0].label, 'VAT');
  const inc = H.computeTax('AE', 10500, { inclusive: true }); assert.equal(inc.tax, 500); assert.equal(inc.total, 10500);
  assert.equal(H.formatDate('AE', '2026-12-02'), 'Wednesday, 2 December 2026');
});
t('UAE billing: P.O. box optional, digits only; India PIN still required', () => {
  const O = require('../public/onboarding-core.js');
  const b = { legal_name: 'X LLC', line1: 'Bay Square', city: 'Dubai', state: 'Dubai', phone: '+971 50 123 4567', location: 'Dubai' };
  assert.ok(O.validateBilling({ ...b, country: 'AE' }).ok);
  assert.equal(O.validateBilling({ ...b, country: 'AE', pin: 'P.O. Box 12345' }).data.pin, '12345');
  assert.ok(!O.validateBilling({ ...b, country: 'AE', pin: 'AB-1' }).ok);
  const ib = { ...b, country: 'IN', phone: '+91 98765 43210', state: 'Telangana', city: 'Hyderabad' };
  assert.equal(O.validateBilling(ib).errors.pin, 'PIN code is required.');
  assert.ok(O.validateBilling({ ...ib, pin: '500081' }).ok);
  assert.match(read('public/control.html'), /cc==="AE"\?"P\.O\. box \(optional\)"/);
});
t('quotes: client emirate + optional 15-digit client TRN, printed on the invoice', () => {
  const q = read('public/quotes.html');
  assert.match(q, /id="c_trn"/); assert.match(q, /HelmCountry\.validateTaxId\("AE",\$\("#c_trn"\)\.value\)/);
  assert.match(q, /Client TRN<\/td>/); assert.match(q, /<td class=muted>Emirate<\/td>/);
  assert.match(q, /"Client emirate"/);
});
t('invoice title: AE bilingual only with supplier TRN; India unchanged', () => {
  const q = read('public/quotes.html'); const s = q.indexOf('function invTitle'); const e = q.indexOf('\n  }\n', s);
  const invTitle = new Function('return ' + q.slice(s, e + 4))();
  assert.match(invTitle({ country: 'AE' }, { taxId: '100123456700003' }), /^Tax Invoice \/ <span lang="ar" dir="rtl">فاتورة ضريبية<\/span>$/);
  assert.match(invTitle({ country: 'AE' }, {}), /not a VAT tax invoice/);
  assert.equal(invTitle({ country: 'IN' }, {}), 'Tax Invoice'); assert.equal(invTitle({ country: 'US' }, {}), 'Invoice');
});
t('layout wizard: Gulf event types, AE hides political rally, metres default, mandap off', () => {
  const W = require('../public/layout-wizard.js');
  const ae = W.typesFor('AE').map((x) => x.key), inn = W.typesFor('IN').map((x) => x.key);
  for (const k of ['iftar', 'eid', 'galadinner', 'exhibition']) assert.ok(ae.includes(k), k);
  assert.ok(!ae.includes('political')); assert.ok(inn.includes('political'));
  assert.equal(W.typeKey('Iftar tent'), 'iftar'); assert.equal(W.typeKey('Ramadan'), 'iftar'); assert.equal(W.typeKey('National Day'), 'eid');
  assert.equal(W.typeKey('Trade show'), 'exhibition');
  assert.equal(W.typeKey('Gala dinner'), 'wedding'); assert.equal(W.typeKey('Expo'), 'conference');   // India unchanged
  assert.equal(W.defaults('wedding', { country: 'AE' }).unit, 'm'); assert.equal(W.defaults('wedding', {}).unit, 'ft');
  assert.equal(W.defaults('wedding', { country: 'AE' }).objects.mandap.on, false); assert.equal(W.defaults('wedding', {}).objects.mandap.on, true);
  assert.equal(W.defaults('iftar', {}).objects.bar, undefined);
  assert.match(read('public/builder.js'), /return c==='IN'\|\|c==='US'\?'ft':'m';/);
});
t('flow: UAE event types / concepts without political rally or puja', () => {
  const f = read('public/flow.html'); const m = /const EVENT_TYPE_LIST_AE = (\[[^\]]+\])/.exec(read('public/event-name.js')); const list = JSON.parse(m[1]);
  for (const k of ['Iftar', 'Eid celebration', 'National Day celebration', 'Gala dinner', 'Exhibition']) assert.ok(list.includes(k), k);
  assert.ok(!list.some((x) => /political|puja|sangeet/i.test(x)));
  assert.match(f, /flowCountry\(\)==="AE"\?EVENT_TYPE_AE:EVENT_TYPE_DEFAULTS/);
  const N = require('../public/event-name.js'); assert.equal(N.label('iftar'), 'Iftar'); assert.equal(N.label('national day'), 'National Day celebration');
});
t('menu: halal / vegetarian wording for UAE, India veg / non-veg unchanged', () => {
  for (const p of ['public/plan.html', 'public/control.html']) { const s = read(p); assert.match(s, /meat \/ fish \(halal\)/, p); assert.match(s, /non-veg/, p); }
});
t('0102: country-aware demo seed (AED, VAT 5%, +971, halal), India seed untouched', () => {
  const s = read('supabase/migrations/0102_uae_demo_seed.sql');
  assert.match(s, /"currency":"AED","taxCountry":"AE"/); assert.ok(!/\+91 /.test(s)); assert.match(s, /if v_cc = 'AE' then return public\._demo_seed_ae/);
  assert.ok(!/create or replace function public\._demo_seed\(/.test(s)); assert.ok(!/delete from|drop table|truncate/i.test(s));
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0102_uae_demo_seed\.sql/);
  const a = read('supabase/APPLY-0102.sql'); assert.ok(/^[\x00-\x7f]*$/.test(a), 'APPLY-0102 ASCII'); assert.match(a, /\) v\(item, ok\)/);
});
t('portal (live E2E): title carries the client name, second line = date only, payments line follows the ledger', () => {
  const p = read('public/portal.html');
  assert.match(p, /friendlyTitle\(Object\.assign\(\{client_name:d\.client_name\},e\)\)/);
  assert.match(p, /\$\("#when"\)\.textContent=fmtWhen\(e\.event_date,e\.event_time\)\|\|"Date to be confirmed"/);
  assert.match(p, /d\.approval_status==="paid" \? "" :/);
  assert.match(p, /"Balance "\+inr\(ps\.balance\)\+due/);
  const N = require('../public/event-name.js');
  assert.equal(N.friendlyTitle({ client_name: 'ZZ India Flow Test', event_type: 'wedding', event_date: '2026-12-28', title: 'WED_HYD_300_28DEC26' }), 'Wedding for ZZ India Flow Test · 28 Dec 2026');
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('ok -', n); } catch (e) { fail++; console.error('FAIL -', n, '\n', e.message); } }
if (fail) { console.error(fail + ' failed'); process.exit(1); } console.log('uae-polish: all ' + tests.length + ' passed');
