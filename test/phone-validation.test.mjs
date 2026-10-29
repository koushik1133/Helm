#!/usr/bin/env node
/* phone-validation.test.mjs — R69 (A5): locks the shared phone normalizer/validator
 * in public/store-api.js and guards against the two parallel copies ever diverging.
 *
 * store-api.js carries two call sites for the SAME India-mobile rule:
 *   - the member-portal form validators  mpMobile / mpAnyPhone   (canonical, {val|err})
 *   - the staff/member-directory helpers  memberMobile / memberAnyPhone  (string|null)
 * Before R69 both re-implemented the rule inline. R69 makes memberMobile/memberAnyPhone
 * DELEGATE to mpMobile/mpAnyPhone so there is a single source of truth. This test:
 *   1. pins the exact output for a golden input table (India, international/UAE, leading
 *      0, +, spaces/dashes, blank, invalid) so the rule can't silently change, and
 *   2. cross-checks member* === (mp* mapped to string|null) across a large fuzz space,
 *      so if anyone edits one copy and not the other, this FAILS.
 * Pure Node, no deps. The four functions are extracted from source and evaluated in a
 * sandbox (store-api.js is a browser IIFE and isn't require-able). Fake test numbers only.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'store-api.js'), 'utf8');

// Extract a top-level `function NAME(...) { ... }` by brace matching.
function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = re.exec(SRC);
  assert.ok(m, 'could not find function ' + name + ' in store-api.js');
  let i = SRC.indexOf('{', m.index);
  assert.ok(i > -1, 'no body for ' + name);
  let depth = 0;
  for (let j = i; j < SRC.length; j++) {
    const ch = SRC[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return SRC.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced braces for ' + name);
}

const src = ['mpMobile', 'mpAnyPhone', 'memberMobile', 'memberAnyPhone'].map(extract).join('\n');
// eslint-disable-next-line no-new-func
const mod = new Function(src + '\nreturn { mpMobile, mpAnyPhone, memberMobile, memberAnyPhone };')();
const { mpMobile, mpAnyPhone, memberMobile, memberAnyPhone } = mod;

const tests = []; const t = (n, f) => tests.push([n, f]);
// mp result -> the string|null shape the member* path uses (blank OR invalid => null)
const asMember = (r) => (r.err ? null : r.val);

t('member* helpers delegate to the canonical mp* validators (single source of truth)', () => {
  // guard the actual delegation in source, not just behavior
  assert.match(SRC, /function memberMobile\(v\)\s*\{\s*const r = mpMobile\(v, ""\);\s*return r\.err \? null : r\.val;\s*\}/,
    'memberMobile must delegate to mpMobile');
  assert.match(SRC, /function memberAnyPhone\(v\)\s*\{\s*const r = mpAnyPhone\(v, ""\);\s*return r\.err \? null : r\.val;\s*\}/,
    'memberAnyPhone must delegate to mpAnyPhone');
});

t('mpMobile golden table — India rule, international, formatting, leading 0/+91, blank, invalid', () => {
  const G = [
    // [input, expected .val (undefined => expect .err)]
    ['', null],                              // blank -> {val:null}
    ['   ', null],
    ['9876543210', '+919876543210'],         // bare India 10-digit
    ['98765 43210', '+919876543210'],        // spaces
    ['98765-43210', '+919876543210'],        // dashes
    ['(987) 654-3210', '+919876543210'],     // punctuation
    ['09876543210', '+919876543210'],        // leading trunk 0
    ['919876543210', '+919876543210'],       // 91 + 10 (no +)
    ['+91 98765 43210', '+919876543210'],    // +91 prefixed
    ['+919876543210', '+919876543210'],
    ['+447700900123', '+447700900123'],      // international +44
    ['+971501234567', '+971501234567'],      // international +971 (UAE)
    ['+12015550100', '+12015550100'],        // international +1
  ];
  for (const [inp, exp] of G) {
    const r = mpMobile(inp, 'Mobile number');
    assert.equal(asMember(r), exp, 'mpMobile ' + JSON.stringify(inp));
  }
  // invalids -> .err set
  for (const bad of ['5876543210', '12345', 'abcdef', '+91 58765 43210', '+9', '+9876543210123456']) {
    assert.ok(mpMobile(bad, 'Mobile number').err, 'mpMobile should reject ' + JSON.stringify(bad));
  }
  // India-rule message is preserved
  assert.match(mpMobile('5876543210', 'Mobile number').err, /starting with 6, 7, 8 or 9/);
});

t('mpAnyPhone golden table — India mobile OR international-with-+', () => {
  assert.equal(asMember(mpAnyPhone('9876543210', 'EC')), '+919876543210');
  assert.equal(asMember(mpAnyPhone('+441234567', 'EC')), '+441234567'); // intl via leading +
  assert.equal(asMember(mpAnyPhone('', 'EC')), null);
  assert.ok(mpAnyPhone('12345', 'EC').err);       // not India, no +
  assert.ok(mpAnyPhone('5876543210', 'EC').err);  // India-shaped but bad prefix, no +
});

t('CROSS-CHECK: member* === mp*(mapped) across a broad fuzz space (fails if copies diverge)', () => {
  const inputs = [];
  const seeds = ['', '   ', '+', '0', '00', '91', '+91', '971', '+971', '1', '+1', '98765 43210',
    '098765 43210', '+91 98765 43210', '91 98765 43210', '(987) 654-3210', '98765-43210',
    '5876543210', '0000000000', '9876543210', '919876543210', '+919876543210', '+44 20 7946 0958',
    '+971501234567', 'abcdefg', '++91', '0012125550100', '+91a', '12.34.56.78', null, undefined, 123];
  for (let n = 4; n <= 17; n++) {
    const ones = '1'.repeat(n), six = '6' + '5'.repeat(n - 1), nine = '9' + '8'.repeat(n - 1);
    seeds.push(ones, '+' + ones, '0' + ones, '00' + ones, '+91' + ones, '91' + ones,
      six, '+' + six, nine, '+' + nine, '+971' + ones);
  }
  for (const inp of seeds) inputs.push(inp);

  let checked = 0;
  for (const inp of inputs) {
    assert.equal(memberMobile(inp), asMember(mpMobile(inp, '')),
      'memberMobile diverged from mpMobile on ' + JSON.stringify(inp));
    assert.equal(memberAnyPhone(inp), asMember(mpAnyPhone(inp, '')),
      'memberAnyPhone diverged from mpAnyPhone on ' + JSON.stringify(inp));
    checked++;
  }
  assert.ok(checked >= 150, 'expected a broad fuzz space, got ' + checked);
});

let passed = 0;
for (const [n, f] of tests) { f(); passed++; console.log('  ✓ ' + n); }
console.log('phone-validation.test.mjs: ' + passed + ' passed');
