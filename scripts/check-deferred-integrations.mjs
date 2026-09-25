#!/usr/bin/env node
/* ============================================================================
 * check-deferred-integrations.mjs — fail-closed guard for DEFERRED providers.
 *
 * Razorpay (payments) and WhatsApp are OUT OF CURRENT RELEASE SCOPE. They are
 * intentionally NOT implemented. This guard makes their dormant state safe and
 * makes ACCIDENTAL activation fail CI, so nobody can flip them on without the
 * secure server-side implementation described in docs/DEFERRED-INTEGRATIONS.md.
 *
 * READ-ONLY, no network. Fails (exit 1) when:
 *   1. public/config.js liveChannels.pay or .whatsapp is `true`.
 *   2. The app_config `channels` seed defaults pay_live to true.
 *   3. A provider secret looks committed in client code (razorpay key_secret,
 *      Evolution API key value, WhatsApp token).
 *   4. A live provider webhook/endpoint handler is present in the static app.
 * ========================================================================== */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
const fail = (m) => { console.error('  ✗ ' + m); errors++; };
const ok = (m) => console.log('  ✓ ' + m);

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p, out); }
    else out.push(p);
  }
  return out;
}

// 1) config feature flags default false ------------------------------------
console.log('Deferred integrations: feature flags default OFF:');
const cfgPath = join(ROOT, 'public', 'config.js');
if (!existsSync(cfgPath)) fail('public/config.js missing');
else {
  const cfg = readFileSync(cfgPath, 'utf8');
  // isolate the liveChannels {...} block to avoid matching comments elsewhere
  const block = (cfg.match(/liveChannels\s*:\s*\{[\s\S]*?\}/) || [''])[0];
  for (const ch of ['pay', 'whatsapp']) {
    const m = block.match(new RegExp('\\b' + ch + '\\s*:\\s*(true|false)'));
    if (!m) fail(`config.js liveChannels.${ch} not found (expected an explicit false)`);
    else if (m[1] === 'true') fail(`config.js liveChannels.${ch} = true — ${ch} is DEFERRED and must stay false (see docs/DEFERRED-INTEGRATIONS.md)`);
    else ok(`config.js liveChannels.${ch} = false`);
  }
}

// 2) SQL app_config channels seed must not default pay_live true ------------
console.log('Deferred integrations: DB channel flags default OFF:');
const otp = join(ROOT, 'supabase', 'otp-payments.sql');
if (existsSync(otp)) {
  const s = readFileSync(otp, 'utf8');
  /"pay_live"\s*:\s*true/.test(s)
    ? fail('otp-payments.sql seeds pay_live:true — Razorpay is DEFERRED, keep it false')
    : ok('otp-payments.sql seeds pay_live false (Razorpay dormant)');
} else ok('otp-payments.sql not present (skipped)');

// 3) no committed provider secrets in client code --------------------------
console.log('Deferred integrations: no committed provider secrets:');
const SECRET_PATTERNS = [
  [/rzp_live_[A-Za-z0-9]+/, 'Razorpay live key id'],
  [/rzp_test_[A-Za-z0-9]{10,}/, 'Razorpay test key id'],
  [/key_secret\s*[:=]\s*['"][^'"]{6,}/i, 'Razorpay key_secret'],
  [/razorpay[_-]?secret\s*[:=]\s*['"][^'"]{6,}/i, 'Razorpay secret'],
  [/EVOLUTION_API_KEY\s*[:=]\s*['"][^'"]{4,}/i, 'Evolution/WhatsApp API key value'],
  [/whatsapp[_-]?token\s*[:=]\s*['"][^'"]{6,}/i, 'WhatsApp token'],
];
let leaked = 0;
for (const f of walk(join(ROOT, 'public'))) {
  if (!/\.(js|html)$/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(src)) { fail(`possible ${label} committed in ${f.replace(ROOT + '/', '')}`); leaked++; }
  }
}
if (!leaked) ok('no Razorpay/WhatsApp secret patterns in public/');

// 4) provider code is not part of the STATIC deploy ------------------------
console.log('Deferred integrations: no provider endpoint in the static deploy:');
// The production deploy is static (public/ only; no api/ dir). Provider code
// legitimately lives as Supabase Edge Functions under supabase/functions/ —
// those are deployed SEPARATELY and only when explicitly enabled. What must
// NOT happen is a provider webhook/handler served from the static app.
let staticEndpoints = 0;
for (const f of walk(join(ROOT, 'public'))) {
  if (!/\.(js|mjs|ts)$/.test(f)) continue;
  const src = readFileSync(f, 'utf8');
  if (/(x-razorpay-signature|razorpay.*webhook|Deno\.serve|createHmac.*razorpay)/i.test(src)) {
    fail(`provider webhook/handler code in the STATIC app: ${f.replace(ROOT + '/', '')}`);
    staticEndpoints++;
  }
}
if (!staticEndpoints) ok('no provider webhook/handler in public/ (static deploy)');

// 5) dormant Edge Functions must be secret-safe + fail-closed --------------
console.log('Deferred integrations: dormant Edge Functions are secret-safe & fail-closed:');
const fnDir = join(ROOT, 'supabase', 'functions');
if (!existsSync(fnDir)) ok('no supabase/functions (nothing to check)');
else {
  // 5a) no committed secret LITERALS — must read from Deno.env
  let fnLeak = 0;
  for (const f of walk(fnDir)) {
    if (!/\.(ts|js|mjs)$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const [re, label] of SECRET_PATTERNS) {
      if (re.test(src)) { fail(`possible ${label} committed in ${f.replace(ROOT + '/', '')}`); fnLeak++; }
    }
  }
  if (!fnLeak) ok('Edge Functions read secrets from Deno.env (no committed secrets)');

  // 5b) the razorpay webhook, if present, MUST verify a signature (fail closed)
  const rzp = join(fnDir, 'razorpay-webhook', 'index.ts');
  if (existsSync(rzp)) {
    const s = readFileSync(rzp, 'utf8');
    const verifies = /x-razorpay-signature/i.test(s) && /(timingSafeEqual|hmac|createHmac|crypto\.subtle)/i.test(s);
    const usesEnvSecret = /Deno\.env\.get\(\s*["']RAZORPAY_WEBHOOK_SECRET/.test(s);
    (verifies && usesEnvSecret)
      ? ok('razorpay-webhook verifies HMAC signature with a server-only secret (fail closed)')
      : fail('razorpay-webhook does not verify a signature with a server-only secret — insecure if deployed');
  } else ok('no razorpay-webhook function present');
}

console.log('');
if (errors) { console.error(`FAILED — ${errors} deferred-integration problem(s). Razorpay/WhatsApp must stay DEFERRED — SECURELY DISABLED.`); process.exit(1); }
console.log('Deferred integrations: Razorpay & WhatsApp are DEFERRED — SECURELY DISABLED.');
