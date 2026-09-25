#!/usr/bin/env node
/* rel-save-failure.test.mjs — REL-01 regression (READ-ONLY, source).
 * Asserts flow.html saveQuotation only falls back when the versioning RPC is
 * genuinely missing, and re-throws (no false "Saved") on any other failure. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/flow.html'), 'utf8');
const body = (src.match(/async function saveQuotation\(\)[\s\S]*?\n  \}/) || [''])[0];
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('classifies a genuinely-missing RPC (PGRST202 / does not exist)', () =>
  assert.ok(/rpcMissing/.test(body) && /PGRST202/.test(body), 'no RPC-missing classification'));
t('re-throws (does not swallow) on non-missing failures', () =>
  assert.ok(/if\(!rpcMissing\)[\s\S]*throw e/.test(body), 'does not re-throw real failures'));
t('does not blindly show success in the catch', () =>
  assert.ok(/Couldn't save/.test(body), 'no honest failure message'));

console.log(`\nrel-save-failure: ${passed} assertion(s) passed.`);
