#!/usr/bin/env node
/* numbering-integrity.test.mjs — MONEY-03/04/05 regression (READ-ONLY, source).
 * Asserts phase90 adds UNIQUE backstops + unique_violation retry loops for
 * receipt numbers and quotation-version labels, and an idempotency key for
 * record_payment. NOT runtime proof — concurrency must be verified on staging. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'supabase/phase90-numbering-integrity.sql'), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('MONEY-03: unique index on (quote_id, receipt_no)', () =>
  assert.ok(/unique index[\s\S]*quote_payments\(quote_id,\s*receipt_no\)/i.test(src)));
t('MONEY-04: unique index on (quote_id, label)', () =>
  assert.ok(/unique index[\s\S]*quotation_versions\(quote_id,\s*label\)/i.test(src)));
t('MONEY-05: idempotency_key column + unique index', () => {
  assert.ok(/add column if not exists idempotency_key/i.test(src));
  assert.ok(/quote_payments\(quote_id,\s*idempotency_key\)/i.test(src));
});
t('record_payment retries on unique_violation', () => {
  const body = (src.match(/function public\.record_payment[\s\S]*?\$\$;/) || [''])[0];
  assert.ok(/when unique_violation/i.test(body), 'no unique_violation handler in record_payment');
  assert.ok(/idempotent_replay/i.test(body), 'no idempotent replay path');
});
t('save_quotation_version retries on unique_violation + rejects negative total', () => {
  const body = (src.match(/function public\.save_quotation_version[\s\S]*?\$\$;/) || [''])[0];
  assert.ok(/when unique_violation/i.test(body), 'no unique_violation handler in save_quotation_version');
  assert.ok(/cannot be negative/i.test(body), 'no negative-total guard');
});
t('pre-existing duplicates fail LOUD, not silently dropped', () =>
  assert.ok(/duplicate[\s\S]*resolve manually/i.test(src), 'no loud pre-check for existing dupes'));

console.log(`\nnumbering-integrity: ${passed} assertion(s) passed.`);
