#!/usr/bin/env node
/**
 * check-base-immutable.mjs
 *
 * CI guard: the canonical baseline schema must never change in place.
 * It is frozen as of 2026-09-25. Any schema change must be a NEW numbered
 * forward migration (append it to supabase/migrations/MANIFEST), or — for an
 * unavoidable hard break — a brand new baseline (base-v2).
 *
 * This script recomputes the sha256 of base-v1 and compares it to the pinned
 * expected hash below. Exit 0 (prints OK) on match; exit 1 on any mismatch,
 * missing file, or read error.
 *
 * To intentionally re-baseline: create base-v2 and a new guard, do NOT edit
 * base-v1 or bump this hash.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the immutable canonical baseline, relative to this script.
const BASE_REL = '../supabase/canonical-base/base-v1-2026-09-25.sql';
const BASE_PATH = resolve(__dirname, BASE_REL);

// Pinned sha256 of base-v1-2026-09-25.sql (computed 2026-10-01).
const EXPECTED_SHA256 =
  '4615b0044a2dfc7a1a0a8994ecdbd280f2b22a4f39830d1ef8207aadc75ee0ae';

const IMMUTABLE_MSG =
  'base-v1 is immutable; make a new numbered forward migration or cut base-v2 instead.';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  console.error(IMMUTABLE_MSG);
  process.exit(1);
}

let buf;
try {
  buf = readFileSync(BASE_PATH);
} catch (err) {
  fail(`could not read canonical baseline at ${BASE_PATH} (${err.code || err.message}).`);
}

const actual = createHash('sha256').update(buf).digest('hex');

if (actual !== EXPECTED_SHA256) {
  console.error(`base-v1 sha256 mismatch for ${BASE_PATH}`);
  console.error(`  expected: ${EXPECTED_SHA256}`);
  console.error(`  actual:   ${actual}`);
  fail('the canonical baseline has changed.');
}

console.log(`OK: base-v1 is unchanged (sha256 ${actual}).`);
process.exit(0);
