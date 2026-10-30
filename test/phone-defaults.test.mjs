// Owner bugs: (1) a new quote's client phone must start EMPTY (no studio / staff / old-draft
// number, no number-looking placeholder, no browser autofill hint); (2) per-country national
// lengths — UAE 9 digits after +971, India 10, US 10 — trunk 0 stripped, E.164 out.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const P = require('../public/phone-input.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const api = read('public/store-api.js'), pin = read('public/phone-input.js');

t('new quote: client phone markup has no value / number placeholder', () => {
  const flow = read('public/flow.html');
  assert.match(flow, /<input id="c_phone" type="tel" inputmode="tel" required>/);
  const q = read('public/quotes.html');
  assert.doesNotMatch(q, /\$\("#c_phone"\)\.placeholder="\+971…"/);
});
t('new quote: placeholder is a digit-free mask, never an example number', () => {
  assert.equal(P.mask('IN'), 'XXXXX XXXXX'); assert.equal(P.mask('AE'), 'XX XXX XXXX');
  assert.ok(!/\d/.test(P.mask('US')) && !/\d/.test(P.mask('ZZ')));
  assert.match(pin, /setAttribute\("placeholder", mask\(c\.iso\)\)/);
});
t('new quote: no browser autofill of the user\'s own phone into client fields', () => {
  assert.doesNotMatch(pin, /"tel-national"/);
  assert.match(pin, /if \(!input\.getAttribute\("autocomplete"\)\) input\.setAttribute\("autocomplete", "off"\)/);
});
t('new quote: startBlank refuses a reused draft that already carries a client phone', () => {
  const i = api.indexOf('async startBlank(code)'); const body = api.slice(i, i + 1400);
  assert.match(body, /\["name", "phone", "email", "company"\]/);
  assert.match(body, /if \(!clean\) return this\.create\(code, code, null, \{ items: \[\] \}, 0\)/);
});
t('UAE: 9 digits after +971, mobile starts with 5, E.164 out', () => {
  assert.deepEqual(P.validate('+971 50 123 4567'), { ok: true, e164: '+971501234567' });
  assert.equal(P.validate('501234567', { country: 'AE' }).e164, '+971501234567');
  assert.equal(P.validate('0501234567', { country: 'AE' }).e164, '+971501234567', 'trunk 0');
  assert.equal(P.validate('+971 050 123 4567').e164, '+971501234567', '+971 0…');
  assert.equal(P.validate('971501234567', { country: 'AE' }).e164, '+971501234567', 'repeated code');
  const long = P.validate('+971 50 123 4567 89');
  assert.equal(long.ok, false); assert.match(long.error, /UAE mobile numbers have 9 digits after \+971/);
  assert.equal(P.validate('+971 60 123 4567').ok, false, '9 digits not starting 5');
  assert.equal(P.validate('+971 4 123 4567').e164, '+97141234567', 'Dubai landline 8 digits');
  assert.equal(P.validate('+971 501234567', { mobile: true }).ok, true);
  assert.equal(P.validate('+971 41234567', { mobile: true }).ok, false);
  assert.equal(P.maxNational('AE'), 9);
  assert.equal(P.format('501234567', 'AE'), '50 123 4567');
});
t('India: 10 digits (6–9 for mobiles), trunk 0 dropped', () => {
  assert.equal(P.validate('09876543210', { country: 'IN' }).e164, '+919876543210');
  assert.equal(P.validate('+91 98765 43210').e164, '+919876543210');
  assert.equal(P.validate('+91 98765 4321').ok, false);
  assert.equal(P.validate('+91 58765 43210', { mobile: true }).ok, false);
  assert.equal(P.maxNational('IN'), 10);
});
t('US: 10 digits NANP; others capped by E.164 15', () => {
  assert.equal(P.validate('+1 (201) 555-0123').e164, '+12015550123');
  assert.equal(P.validate('+1 (101) 555-0123').ok, false);
  assert.equal(P.maxNational('US'), 10);
  assert.equal(P.maxNational('DE'), 11);
  assert.equal(P.maxNational('IS'), 15 - 3);
});
t('other validators share the UAE rule (waNumber / smart import / onboarding)', () => {
  assert.match(api, /5\\d\{8\}\|\[234679\]\\d\{7\}/);
  const si = require('../public/smart-import-core.js');
  const pp = si.parsePhone;
  assert.equal(pp('+971 50 123 4567').value, '+971501234567');
  assert.equal(pp('+971 050 123 4567').value, '+971501234567');
  assert.match(pp('+971 50 123 4567 89').error, /9 digits after \+971/);
  assert.match(read('public/onboarding-core.js'), /UAE mobile numbers have 9 digits after \+971/);
});
t('versions bumped: phone-input v=2 everywhere', () => {
  for (const f of ['flow', 'quotes', 'leads', 'control', 'approve', 'staff', 'ops', 'hq', 'profile-setup']) assert.match(read('public/' + f + '.html'), /phone-input\.js\?v=9"/, f);
  assert.match(api, /var PHONE_LIB_V = "9"/); assert.match(read('public/auth-ui.js'), /PHONE_LIB_V = "9"/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`\nphone-defaults: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
