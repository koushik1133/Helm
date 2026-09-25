#!/usr/bin/env node
/* deferred-integrations.test.mjs — Razorpay/WhatsApp stay DEFERRED (READ-ONLY).
 * Delegates to scripts/check-deferred-integrations.mjs and asserts it passes. */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('deferred-integration guard passes (providers securely disabled)', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/check-deferred-integrations.mjs')], { stdio: 'pipe' });
});

console.log(`\ndeferred-integrations: ${passed} assertion(s) passed.`);
