#!/usr/bin/env node
/* form-hardener.test.mjs — guards the shared input-hardening layer in
 * public/store-api.js: the phone (tel) digit-only hardener and the required-field
 * "*" renderer, plus the pre-existing number hardener. Geometry/DOM behavior is
 * verified in a browser; this locks the wiring at the source level (the repo's
 * established pattern for config-router / tour-positioning). Pure Node, no deps.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'public', 'store-api.js'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('BPStore.validate exposes phone/email/required validators', () => {
  assert.ok(/BPStore\.validate\s*=\s*V/.test(SRC), 'BPStore.validate is published');
  assert.ok(/phone:\s*function/.test(SRC), 'phone validator present');
  assert.ok(/email:\s*function/.test(SRC), 'email validator present');
  assert.ok(/required:\s*function/.test(SRC), 'required validator present');
});

t('phone hardener exists and strips to a single leading + and digits', () => {
  assert.ok(/function\s+hardenPhone/.test(SRC), 'hardenPhone() present');
  // the core strip: non-digits removed, one optional leading +
  assert.ok(/replace\(\s*\/\[\^\\d\]\/g\s*,\s*""\s*\)/.test(SRC), 'strips all non-digits');
  assert.ok(/charAt\(0\)\s*===\s*"\+"/.test(SRC), 'preserves a single leading +');
});

t('scan() hardens tel inputs (type=tel OR inputmode=tel), idempotently', () => {
  assert.ok(/input\[type="tel"\]:not\(\[data-phone-hardened\]\)/.test(SRC), 'selects type=tel not-yet-hardened');
  assert.ok(/input\[inputmode="tel"\]:not\(\[data-phone-hardened\]\)/.test(SRC), 'selects inputmode=tel');
  assert.ok(/data-phone-hardened/.test(SRC), 'marks hardened to avoid double-binding');
});

t('required-field marker adds aria-required and a "*", idempotently', () => {
  assert.ok(/function\s+markRequired/.test(SRC), 'markRequired() present');
  assert.ok(/setAttribute\(\s*"aria-required"\s*,\s*"true"\s*\)/.test(SRC), 'sets aria-required=true');
  assert.ok(/req-star/.test(SRC), 'renders a .req-star element');
  assert.ok(/data-req-marked/.test(SRC), 'marks processed fields to stay idempotent');
  assert.ok(/aria-hidden/.test(SRC), 'the visual star is aria-hidden (SR hears "required", not "star")');
});

t('scan() also marks required/aria-required/data-required fields', () => {
  assert.ok(/\[required\]:not\(\[data-req-marked\]\)/.test(SRC), 'selects [required]');
  assert.ok(/\[aria-required="true"\]:not\(\[data-req-marked\]\)/.test(SRC), 'selects aria-required');
  assert.ok(/\[data-required\]:not\(\[data-req-marked\]\)/.test(SRC), 'selects data-required');
});

t('a MutationObserver hardens dynamically-added inputs (modals)', () => {
  assert.ok(/new MutationObserver/.test(SRC), 'MutationObserver installed');
  assert.ok(/isPhone\(nd\)/.test(SRC), 'observer hardens added phone inputs');
});

console.log(`\nform-hardener: ${passed} assertion(s) passed.`);
