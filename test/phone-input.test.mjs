// phone-input.js (HelmPhone) + form-validate.js (HelmValidate) — pure rules, no DOM.
// Formatting per country, +code / 00code detection, E.164 output, 7–15 digit range,
// India mobile rule, name / e-mail / text rules, HTML stripping. Fake test numbers only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const P = require('../public/phone-input.js');
const V = require('../public/form-validate.js');
globalThis.HelmPhone = P;
const tests = []; const t = (n, f) => tests.push([n, f]);

t('country list: ~245 entries, unique ISO codes, India + the Gulf / SAARC set present, flags render', () => {
  assert.ok(P.COUNTRIES.length >= 240 && P.COUNTRIES.length <= 260, String(P.COUNTRIES.length));
  const isos = P.COUNTRIES.map((c) => c.iso); assert.equal(new Set(isos).size, isos.length);
  for (const i of ['IN', 'US', 'CA', 'GB', 'AE', 'SG', 'AU', 'SA', 'QA', 'KW', 'OM', 'BH', 'MY', 'NP', 'LK', 'BD', 'FR']) assert.ok(P.country(i), i);
  assert.equal(P.flag('IN'), '🇮🇳'); assert.equal(P.flag('fr'), '🇫🇷'); assert.equal(P.flag('x'), '');
  assert.equal(P.country('JM').code, '1'); assert.equal(P.country('JE').code, '44');
});
t('parse: leading +code / 00code picks the country; national numbers use the default', () => {
  const cases = [['+919876543210', 'IN', '9876543210'], ['+44 7700 900123', 'GB', '7700900123'], ['0044 7700 900123', 'GB', '7700900123'],
    ['+1 (201) 555-0123', 'US', '2015550123'], ['+971 50 123 4567', 'AE', '501234567'], ['+65 8123 4567', 'SG', '81234567'],
    ['+61 412 345 678', 'AU', '412345678'], ['+966 51 234 5678', 'SA', '512345678'], ['+974 3312 3456', 'QA', '33123456'],
    ['+965 5001 2345', 'KW', '50012345'], ['+968 9212 3456', 'OM', '92123456'], ['+973 3600 1234', 'BH', '36001234'],
    ['+60 12-345 6789', 'MY', '123456789'], ['+977 984-1234567', 'NP', '9841234567'], ['+94 71 234 5678', 'LK', '712345678'],
    ['+880 1812-345678', 'BD', '1812345678'], ['+33 6 12 34 56 78', 'FR', '612345678'], ['+1 876 555 1234', 'JM', '8765551234'],
    ['+7 701 234 5678', 'KZ', '7012345678'], ['+7 912 345 6789', 'RU', '9123456789'],
    ['98765 43210', 'IN', '9876543210'], ['09876543210', 'IN', '9876543210'], ['919876543210', 'IN', '9876543210']];
  for (const [raw, iso, nat] of cases) { const p = P.parse(raw, 'IN'); assert.equal(p.iso, iso, raw); assert.equal(p.national, nat, raw); }
  assert.equal(P.parse('+1 506 234 5678', 'CA').iso, 'CA', 'shared +1 keeps the current country');
  assert.equal(P.parse('', 'AE').iso, 'AE');
});
t('format: per-country as-you-type patterns + generic grouping', () => {
  const f = [['9876543210', 'IN', '98765 43210'], ['98765', 'IN', '98765'], ['987654', 'IN', '98765 4'], ['2015550123', 'US', '(201) 555-0123'],
    ['201', 'US', '(201'], ['2015', 'US', '(201) 5'], ['7700900123', 'GB', '7700 900123'], ['501234567', 'AE', '50 123 4567'], ['81234567', 'SG', '8123 4567'],
    ['412345678', 'AU', '412 345 678'], ['512345678', 'SA', '51 234 5678'], ['33123456', 'QA', '3312 3456'], ['123456789', 'MY', '12-345 6789'],
    ['1234567890', 'MY', '12-3456 7890'], ['9841234567', 'NP', '984-1234567'], ['712345678', 'LK', '71 234 5678'], ['1812345678', 'BD', '1812-345678'],
    ['612345678', 'FR', '6 12 34 56 78'], ['123456789', 'BR', '123 456 789'], ['1234567890', 'BR', '123 456 7890'], ['1234', 'BR', '1234']];
  for (const [d, iso, out] of f) assert.equal(P.format(d, iso), out, iso + ' ' + d);
  assert.equal(P.display('+919876543210'), '+91 98765 43210');
  assert.equal(P.display('+447700900123'), '+44 7700 900123');
});
t('validate: E.164 out, per-country lengths, 7–15 digits, India mobile rule, polite messages', () => {
  for (const ok of ['+919876543210', '+447700900123', '+12015550123', '+971501234567', '+6581234567', '+5511912345678', '+35312345678'])
    assert.equal(P.validate(ok).ok, true, ok);
  assert.equal(P.validate('98765 43210', { country: 'IN' }).e164, '+919876543210');
  assert.equal(P.validate('+91 98765 43210', { mobile: true }).e164, '+919876543210');
  assert.match(P.validate('+91 58765 43210', { mobile: true }).error, /starting with 6, 7, 8 or 9/);
  assert.equal(P.validate('+91 58765 43210').ok, true, 'landline-style numbers are fine when the field is not a mobile field');
  assert.match(P.validate('+91 98765').error, /too short.*10-digit.*India/);
  assert.match(P.validate('+44 7700 9001234').error, /too long/);
  assert.match(P.validate('+55 12').error, /too short/);
  assert.match(P.validate('+55 1234567890123456').error, /too long/);
  assert.match(P.validate('+999 123456789').error, /country code/);
  assert.equal(P.validate('', {}).ok, true); assert.equal(P.validate('', { required: true }).ok, false);
  for (const v of ['+919876543210', '+447700900123', '+5511912345678']) assert.match(P.validate(v).e164, /^\+[1-9]\d{6,14}$/);
});
t('HelmValidate.rules: names, e-mails, text, phone; HTML stripped, whitespace trimmed, e-mail lower-cased', () => {
  const R = V.rules;
  for (const ok of ['Ananya Rao', "D'Souza", 'Mary-Jane O’Neil', 'José Núñez', 'अनन्या']) assert.equal(R.name(ok).ok, true, ok);
  assert.equal(R.name('  Ananya   Rao  ').value, 'Ananya Rao');
  for (const bad of ['R2D2', 'Ana@', 'x'.repeat(51), '--', "Ana -Rao"]) assert.equal(R.name(bad).ok, false, bad);
  assert.match(R.name('', { required: true, label: 'full name' }).error, /^Please enter your full name\.$/);
  assert.match(R.name('A1').error, /letters, spaces, hyphens/);
  assert.equal(R.name('<b>Ana</b>').value, 'Ana', 'HTML stripped');
  assert.equal(R.email('  Ana.Rao@Example.COM ').value, 'ana.rao@example.com');
  for (const bad of ['ana', 'ana@', 'ana@x', 'a..b@x.com', 'ana@ex ample.com']) assert.equal(R.email(bad).ok, false, bad);
  assert.match(R.email('nope').error, /name@example\.com/);
  assert.equal(R.text('<script>x</script> Lead ', { label: 'Job title' }).value, 'x Lead');
  assert.match(R.text('x'.repeat(81), { label: 'Job title', max: 80 }).error, /80 characters/);
  assert.equal(R.phone('+44 7700 900123').value, '+447700900123');
  assert.match(R.phone('', { required: true, label: 'mobile number' }).error, /Please enter your mobile number/);
  assert.match(R.phone('+91 12345 67890', { mobile: true }).error, /6, 7, 8 or 9/);
});
t('sources: no innerHTML / inline styles in the component or validator; CSS in theme.css', () => {
  for (const f of ['public/phone-input.js', 'public/form-validate.js']) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.doesNotMatch(s, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|\.style\.|setAttribute\("style"/, f);
  }
  const css = readFileSync(new URL('../public/theme.css', import.meta.url), 'utf8');
  for (const sel of ['.hp-pop', '.hp-opt', '.fv-msg', '.fv-ic', 'input.fv-ok']) assert.ok(css.includes(sel), sel);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) { try { await f(); pass++; console.log('ok - ' + n); } catch (e) { fail++; console.log('not ok - ' + n + ': ' + (e && e.message)); } }
console.log(`\nphone-input: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
