#!/usr/bin/env node
/* deferred-integrations.test.mjs — Razorpay/WhatsApp stay DEFERRED (READ-ONLY).
 * Delegates to scripts/check-deferred-integrations.mjs and asserts it passes. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

t('deferred-integration guard passes (providers securely disabled)', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/check-deferred-integrations.mjs')], { stdio: 'pipe' });
});

/* ---------------------------------------------------------------------------
 * Fail-closed source characterization for the DORMANT provider Edge Functions.
 * The guard above proves the providers are OFF; these assertions PIN the
 * safety properties that must hold the day someone turns them on, so a product
 * edit that weakens fail-closed behaviour trips CI. READ-ONLY, no network.
 * ------------------------------------------------------------------------- */
const payLink  = read('supabase/functions/create-payment-link/index.ts');
const webhook  = read('supabase/functions/razorpay-webhook/index.ts');
const whatsapp = read('supabase/functions/send-whatsapp/index.ts');
const sendOtp  = read('supabase/functions/send-otp/index.ts');

// ---- Razorpay create-payment-link ----
t('create-payment-link reads secrets from Deno.env (no committed key)', () => {
  assert.match(payLink, /Deno\.env\.get\(\s*["']RAZORPAY_KEY_ID/);
  assert.match(payLink, /Deno\.env\.get\(\s*["']RAZORPAY_KEY_SECRET/);
});
t('create-payment-link amount is SERVER-authoritative (from stored quote, not request body)', () => {
  // request body carries only { token }; amount is derived from the DB row q.pricing.total
  assert.match(payLink, /q\.pricing\?\.\s*total/);
  assert.match(payLink, /Math\.round\(total\s*\*\s*100\)/);
  assert.doesNotMatch(payLink, /body\.(amount|total)|req\.\w*\.amount/i,
    'amount must never come from the client request');
});
t('create-payment-link cannot double-charge: refuses an already-paid quote', () => {
  assert.match(payLink, /approval_status\s*===\s*["']paid["']/);
  assert.match(payLink, /already\s*paid/i);
});
t('create-payment-link requires an approved quote (no fake success before consent)', () => {
  assert.match(payLink, /approval_status\s*!==\s*["']approved["']/);
});

// ---- Razorpay webhook: HMAC + amount-coverage + idempotency, no retry loop ----
t('razorpay-webhook verifies HMAC signature before acting (fail closed)', () => {
  assert.match(webhook, /x-razorpay-signature/i);
  assert.match(webhook, /timingSafeEqual/);
  assert.match(webhook, /Deno\.env\.get\(\s*["']RAZORPAY_WEBHOOK_SECRET/);
  assert.match(webhook, /status:\s*401/);
});
t('razorpay-webhook settles only when paid amount COVERS the current quote total', () => {
  assert.match(webhook, /paidPaise\s*<\s*expectedPaise/);
});
t('razorpay-webhook transition is idempotent (conditional UPDATE guards replays)', () => {
  assert.match(webhook, /\.neq\(\s*["']approval_status["']\s*,\s*["']paid["']\s*\)/);
});
t('razorpay-webhook does not loop: bad/unknown ids return 200, not 5xx', () => {
  assert.match(webhook, /no quote["']\s*,\s*\{\s*status:\s*200/);
});

// ---- WhatsApp: fail closed, staff-only, token never echoed ----
t('send-whatsapp fails closed when TOKEN/PHONE_ID unset', () => {
  assert.match(whatsapp, /if\s*\(\s*!TOKEN\s*\|\|\s*!PHONE_ID\s*\)/);
  assert.match(whatsapp, /not configured/i);
});
t('send-whatsapp requires a signed-in staff user (not the anon key)', () => {
  assert.match(whatsapp, /staffUserId/);
  assert.match(whatsapp, /sign in as a staff user/i);
});
t('send-whatsapp reads the token from Deno.env and only uses it in the Authorization header', () => {
  assert.match(whatsapp, /Deno\.env\.get\(\s*["']WHATSAPP_TOKEN/);
  // Every reference to the TOKEN identifier must be the env read or the
  // "Bearer " + TOKEN auth header — never a json() response or a console log.
  const refs = whatsapp.match(/\bTOKEN\b/g) || [];
  assert.ok(refs.length >= 2, 'expected the TOKEN constant to be defined and used');
  assert.doesNotMatch(whatsapp, /return\s+json\([^;]*\bTOKEN\b/); // not echoed in a response
  assert.doesNotMatch(whatsapp, /console\.\w+\([^;]*\bTOKEN\b/);  // not written to logs
});

// ---- OTP/SMS: simulated code is NEVER a production consent bypass ----
t('send-otp never returns the plaintext code to the caller', () => {
  assert.doesNotMatch(sendOtp, /json\([^)]*\bcode\b/);
  assert.match(sendOtp, /admin_store_otp/); // only the hash is stored server-side
});
t('send-otp marks the notification simulated (not "sent") when MSG91 is unset', () => {
  assert.match(sendOtp, /status:\s*authkey\s*\?\s*["']sent["']\s*:\s*["']simulated["']/);
});

console.log(`\ndeferred-integrations: ${passed} assertion(s) passed.`);
