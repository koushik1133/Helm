#!/usr/bin/env node
/* ============================================================================
 * wave15b-security-fixes.test.mjs — regression pins for the Cloudflare-audit
 * fixes shipped in Wave 15B (source-assertion tests; no DB, no network).
 *
 * Covers three CONFIRMED findings remediated this wave:
 *   CF client-side/stored-xss-javascript-uri-href — href/img scheme allowlist
 *   CF payments/record_payment-idempotency-key-unused — UI passes a stable key
 *   CF deploy/legacy-base-files-missing-do-not-run-banner — SUPERSEDED-BY notes
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// --- XSS: scheme allowlist on the flagged href/img sinks ---------------------
t('portal.html video href/img guard the URL scheme (no raw esc(m.url) in href)', () => {
  const s = read('public/portal.html');
  assert.ok(!/href="\$\{esc\(m\.url\)\}"/.test(s), 'portal video href must not use raw esc(m.url)');
  assert.match(s, /href="\$\{isUrl\(m\.url\)\?esc\(m\.url\):"#"\}"/, 'portal video href must scheme-allowlist via isUrl');
});
t('invite.html map link scheme-allowlists d.mapUrl', () => {
  const s = read('public/invite.html');
  assert.ok(!/d\.mapUrl\?` <a href="\$\{esc\(d\.mapUrl\)\}"/.test(s), 'invite map href must not be unconditionally rendered');
  assert.match(s, /d\.mapUrl&&\/\^https\?:\\\/\\\/\/i\.test\(d\.mapUrl\)/, 'invite map href must test https scheme');
});
t('proposal-view.html filters gallery images to http(s)', () => {
  const s = read('public/proposal-view.html');
  assert.match(s, /p\.images:\[\]\)\.filter\(u=>\/\^https\?:\\\/\\\/\/i\.test/, 'proposal images must be scheme-filtered');
});

// --- Payment idempotency: UI generates a stable key + no re-enable on success -
t('store-api milestones.record forwards p_idempotency_key', () => {
  const s = read('public/store-api.js');
  assert.match(s, /record:\s*\(quoteId, amount, method, receiptNo, milestoneId, note, idempotencyKey\)/, 'record must accept idempotencyKey');
  assert.match(s, /p_idempotency_key:\s*idempotencyKey\s*\|\|\s*null/, 'record must forward p_idempotency_key');
});
t('flow.html recordPayment generates one stable key, passes it, and does not re-enable on success', () => {
  const s = read('public/flow.html');
  assert.match(s, /const idem=\(typeof crypto/, 'a per-submission idempotency key must be generated');
  assert.match(s, /BPStore\.milestones\.record\(id, amount, method,[\s\S]*?, null, null, idem\)/, 'the key must be passed to record()');
  // re-enable must live in the catch, not an unconditional finally
  assert.ok(!/finally\{ \$\("#pay_record"\)\.disabled=false; \}/.test(s), 'button must not be re-enabled unconditionally after success');
  assert.match(s, /catch\(e\)\{ \$\("#pay_record"\)\.disabled=false;/, 're-enable only on failure');
});

// --- Deploy hygiene: SUPERSEDED-BY notes on the legacy base files ------------
t('operations.sql / control-center.sql / schema.sql carry SUPERSEDED-BY notes', () => {
  assert.match(read('supabase/operations.sql'), /PARTIALLY SUPERSEDED[\s\S]*phase72/, 'operations.sql note must reference phase72');
  assert.match(read('supabase/control-center.sql'), /PARTIALLY SUPERSEDED[\s\S]*phase97/, 'control-center.sql note must reference phase97');
  assert.match(read('supabase/schema.sql'), /PARTIALLY SUPERSEDED[\s\S]*phase89/, 'schema.sql note must reference phase89');
});

console.log('\nwave15b-security-fixes: ' + passed + ' assertion(s) passed.');
