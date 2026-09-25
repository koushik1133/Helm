#!/usr/bin/env node
/* env-safety.test.mjs — ENV separation regression (READ-ONLY, source).
 * Delegates to scripts/check-env-safety.mjs and asserts it passes. */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('check-env-safety guard passes', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/check-env-safety.mjs')], { stdio: 'pipe' });
});

console.log(`\nenv-safety: ${passed} assertion(s) passed.`);
