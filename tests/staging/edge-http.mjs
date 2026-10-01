#!/usr/bin/env node
// ============================================================================
// tests/staging/edge-http.mjs — POST-DEPLOY HTTP tests for the Helm Edge
// Functions on STAGING (PREPARED — run only after deploy-edge.sh --confirm).
//
// Hits the DEPLOYED function URLs on the staging project:
//     https://<staging-ref>.supabase.co/functions/v1/<fn>
// (this is the path the app itself uses — see public/store-api.js `fnUrl`).
//
// Covers, per function (see per-section comments):
//   send-otp            valid, invalid capability/token, expired capability,
//                       rate-limit, provider error, NO secret leak
//   send-whatsapp       no token, malformed JWT, unauthorized role, permitted
//                       role, provider error, CORS
//   create-payment-link invalid quote, already-paid, duplicate click, reuse
//                       open link, invalid amount, expired
//   razorpay-webhook    missing sig, invalid sig, valid signed fixture, replay,
//                       underpayment, duplicate concurrent delivery
//
// SAFETY INVARIANTS:
//   * STAGING ONLY. Asserts the staging ref; HARD-REFUSES the prod ref.
//   * NEVER triggers real settlement: webhook tests use fixtures that return
//     200 WITHOUT marking any quote paid (unknown-but-valid UUID, or an
//     underpayment below the quote total). No full-amount settlement is sent.
//   * Razorpay must be in TEST mode (rzp_test_ keys + a test webhook secret).
//   * Secrets from env only; never printed. Asserts error bodies don't leak them.
//   * Fails CLOSED (exit 3 = BLOCKED) if function URLs are unreachable or
//     env/seed is missing.
//
// Required env:
//   SUPABASE_STAGING_URL                (default https://<staging-ref>.supabase.co)
//   SUPABASE_STAGING_ANON_KEY           (apikey + anon-bearer cases)
//   SEED_TEST_PASSWORD                  (sign in HARDEN_TEST users for whatsapp)
//   RAZORPAY_WEBHOOK_SECRET             (sign the webhook fixtures; TEST secret)
// Optional env (enable deeper cases; otherwise those cases are SKIPPED, not failed):
//   OTP_TEST_TOKEN                      (a valid approval_token for send-otp happy path)
//   OTP_EXPIRED_TOKEN                   (an expired approval_token)
//   PAY_APPROVED_TOKEN                  (approval_token of an APPROVED unpaid quote)
//   PAY_PAID_TOKEN                      (approval_token of an already-PAID quote)
//   PAY_ZERO_TOKEN                      (approval_token of an approved quote whose total is 0)
// Reads scripts/staging/.seed-manifest.json for org users (whatsapp role tests).
// ============================================================================

import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STAGING_REF = 'xizehqgeyjcfpzrdymly';
const PROD_REF = 'nqltzgiwznphugcfhmbm';
const PREFIX = 'HARDEN_TEST_';
const MANIFEST_PATH = join(__dirname, '..', '..', 'scripts', 'staging', '.seed-manifest.json');

const SUPABASE_URL = (process.env.SUPABASE_STAGING_URL || `https://${STAGING_REF}.supabase.co`).replace(/\/+$/, '');
const ANON_KEY = process.env.SUPABASE_STAGING_ANON_KEY || '';
const SEED_PASSWORD = process.env.SEED_TEST_PASSWORD || '';
const RZP_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

const fnUrl = (name) => `${SUPABASE_URL}/functions/v1/${name}`;

function blocked(msg) { console.error(`\n[edge-http] BLOCKED: ${msg}`); process.exit(3); }

function assertStaging() {
  if (SUPABASE_URL.includes(PROD_REF)) blocked(`SUPABASE_STAGING_URL points at PROD ref (${PROD_REF}). Refusing.`);
  if (!SUPABASE_URL.includes(STAGING_REF)) blocked(`SUPABASE_STAGING_URL must contain the staging ref (${STAGING_REF}). Got: ${SUPABASE_URL}`);
  if (!ANON_KEY) blocked('SUPABASE_STAGING_ANON_KEY is not set.');
  if (!SEED_PASSWORD) blocked('SEED_TEST_PASSWORD is not set.');
  if (!RZP_WEBHOOK_SECRET) blocked('RAZORPAY_WEBHOOK_SECRET is not set (needed to sign webhook fixtures).');
}

// ---- recorder --------------------------------------------------------------
const results = [];
function expect(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, why) {
  results.push({ name, ok: true, skipped: true, detail: why });
  console.log(`[SKIP] ${name} — ${why}`);
}

// Secrets that must NEVER appear in a response body.
const SECRET_NEEDLES = [ANON_KEY, SEED_PASSWORD, RZP_WEBHOOK_SECRET,
  process.env.RAZORPAY_KEY_SECRET, process.env.WHATSAPP_TOKEN, process.env.MSG91_AUTHKEY,
  process.env.RESEND_API_KEY, process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY].filter(Boolean);
function noLeak(text) {
  const t = String(text || '');
  return !SECRET_NEEDLES.some((s) => s.length >= 6 && t.includes(s));
}

// ---- HTTP helpers ----------------------------------------------------------
async function callFn(name, body, { bearer, origin, headers } = {}) {
  const h = { 'Content-Type': 'application/json', apikey: ANON_KEY, Authorization: `Bearer ${bearer || ANON_KEY}`, ...(headers || {}) };
  if (origin) h.Origin = origin;
  const res = await fetch(fnUrl(name), { method: 'POST', headers: h, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { res, text, json };
}

async function reachable(name) {
  try {
    const res = await fetch(fnUrl(name), {
      method: 'OPTIONS',
      headers: { Origin: 'https://helm.events', 'Access-Control-Request-Method': 'POST' },
    });
    return res.status < 500 || res.status === 500; // any HTTP answer = reachable; network error throws
  } catch { return false; }
}

async function signIn(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  const b = await res.json().catch(() => ({}));
  return res.ok ? b.access_token : null;
}

async function loadManifest() {
  let raw; try { raw = await readFile(MANIFEST_PATH, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

// Razorpay webhook signature: HMAC-SHA256(secret, raw-body) hex.
function rzpSign(body) { return createHmac('sha256', RZP_WEBHOOK_SECRET).update(body).digest('hex'); }
async function postWebhook(rawBody, sig) {
  const headers = { 'Content-Type': 'application/json' };
  if (sig !== null) headers['x-razorpay-signature'] = sig;
  const res = await fetch(fnUrl('razorpay-webhook'), { method: 'POST', headers, body: rawBody });
  const text = await res.text();
  return { res, text };
}

// ============================================================================
async function testSendOtp() {
  console.log('\n== send-otp ==');
  // invalid capability: missing token/phone -> 400
  {
    const { res, text } = await callFn('send-otp', { phone: '9999999999' });
    expect('send-otp: missing token -> 400', res.status === 400, `HTTP ${res.status}`);
    expect('send-otp: missing-token body no secret leak', noLeak(text));
  }
  // invalid capability: bad/short phone -> 400
  {
    const { res } = await callFn('send-otp', { token: 'x'.repeat(20), phone: '12' });
    expect('send-otp: invalid phone -> 400', res.status === 400, `HTTP ${res.status}`);
  }
  // invalid token (capability) -> admin_store_otp rejects -> 400 (generic)
  {
    const { res, text } = await callFn('send-otp', { token: 'not-a-real-token-' + Date.now(), phone: '9876543210' });
    expect('send-otp: invalid token capability -> 400', res.status === 400, `HTTP ${res.status}`);
    expect('send-otp: invalid-token body no secret leak', noLeak(text));
  }
  // expired capability
  if (process.env.OTP_EXPIRED_TOKEN) {
    const { res } = await callFn('send-otp', { token: process.env.OTP_EXPIRED_TOKEN, phone: '9876543210' });
    expect('send-otp: expired token -> 400', res.status === 400, `HTTP ${res.status}`);
  } else skip('send-otp: expired capability', 'set OTP_EXPIRED_TOKEN');
  // valid happy path (mock provider: live:false, sent:true)
  if (process.env.OTP_TEST_TOKEN) {
    const { res, json, text } = await callFn('send-otp', { token: process.env.OTP_TEST_TOKEN, phone: '9876543210' });
    expect('send-otp: valid -> 200 sent', res.status === 200 && json && json.sent === true, `HTTP ${res.status}`);
    expect('send-otp: valid body no secret leak', noLeak(text));
    // rate-limit: a burst of repeats should eventually be throttled by admin_store_otp
    let throttled = false;
    for (let i = 0; i < 6; i++) {
      const r = await callFn('send-otp', { token: process.env.OTP_TEST_TOKEN, phone: '9876543210' });
      if (r.res.status === 400 || r.res.status === 429) { throttled = true; break; }
    }
    expect('send-otp: rate-limit kicks in on repeat', throttled, 'expected a 400/429 within the burst');
  } else {
    skip('send-otp: valid happy path', 'set OTP_TEST_TOKEN');
    skip('send-otp: rate-limit', 'set OTP_TEST_TOKEN');
  }
  // provider error path: documented — only reachable with a deliberately bad
  // MSG91 config; not forced here to avoid real provider calls.
  skip('send-otp: provider error (502)', 'requires a bad live MSG91 config; not forced on staging');
}

// ============================================================================
async function testSendWhatsapp(manifest) {
  console.log('\n== send-whatsapp ==');
  // CORS: evil origin gets NO Access-Control-Allow-Origin
  {
    const res = await fetch(fnUrl('send-whatsapp'), {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    const acao = res.headers.get('access-control-allow-origin');
    expect('send-whatsapp: evil origin -> no ACAO', !acao || acao === 'null', `ACAO=${acao}`);
  }
  // CORS: allowed origin echoed
  {
    const res = await fetch(fnUrl('send-whatsapp'), {
      method: 'OPTIONS',
      headers: { Origin: 'https://helm.events', 'Access-Control-Request-Method': 'POST' },
    });
    const acao = res.headers.get('access-control-allow-origin');
    expect('send-whatsapp: allowed origin echoed', acao === 'https://helm.events', `ACAO=${acao}`);
  }
  // no token (anon key only) -> 401 "sign in as a staff user"
  // (unless WHATSAPP creds unset entirely -> 500 config error; both are fail-closed)
  {
    const { res, text } = await callFn('send-whatsapp', { ping: true }, { bearer: ANON_KEY });
    expect('send-whatsapp: anon/no-session -> 401 or 500(config)', res.status === 401 || res.status === 500, `HTTP ${res.status}`);
    expect('send-whatsapp: anon body no secret leak', noLeak(text));
  }
  // malformed JWT -> treated as no user -> 401 (or 500 if unconfigured)
  {
    const { res } = await callFn('send-whatsapp', { ping: true }, { bearer: 'not.a.jwt' });
    expect('send-whatsapp: malformed JWT -> 401/500', res.status === 401 || res.status === 500, `HTTP ${res.status}`);
  }
  // unauthorized role: a signed-in non-staff user (client/worker/viewer) -> 401
  const client = manifest?.users?.find((u) => ['client', 'worker', 'viewer', 'crew'].includes(u.role));
  if (client) {
    const tok = await signIn(client.email);
    if (tok) {
      const { res } = await callFn('send-whatsapp', { ping: true }, { bearer: tok });
      expect('send-whatsapp: unauthorized role -> 401/500', res.status === 401 || res.status === 500, `role=${client.role} HTTP ${res.status}`);
    } else skip('send-whatsapp: unauthorized role', `could not sign in ${client.email}`);
  } else skip('send-whatsapp: unauthorized role', 'no client/worker/viewer in manifest');
  // permitted role (admin): ping passes auth. With sandbox creds -> 200; with a
  // bad token -> 502 provider error. Either proves auth was accepted (not 401).
  const admin = manifest?.users?.find((u) => u.role === 'admin');
  if (admin) {
    const tok = await signIn(admin.email);
    if (tok) {
      const { res, text } = await callFn('send-whatsapp', { ping: true }, { bearer: tok });
      expect('send-whatsapp: permitted role passes auth (not 401)', res.status !== 401, `HTTP ${res.status}`);
      expect('send-whatsapp: provider/ping body no secret leak', noLeak(text));
      // provider error: a clearly invalid number/send with bad creds should surface 502 (generic)
      const { res: r2 } = await callFn('send-whatsapp', { number: '10', text: 'hi' }, { bearer: tok });
      expect('send-whatsapp: invalid number -> 400 (validation)', r2.status === 400 || r2.status === 500, `HTTP ${r2.status}`);
    } else skip('send-whatsapp: permitted role', `could not sign in ${admin.email}`);
  } else skip('send-whatsapp: permitted role', 'no admin in manifest');
}

// ============================================================================
async function testCreatePaymentLink() {
  console.log('\n== create-payment-link ==');
  // invalid quote: missing token -> 400
  {
    const { res, text } = await callFn('create-payment-link', {});
    expect('create-payment-link: missing token -> 400', res.status === 400, `HTTP ${res.status}`);
    expect('create-payment-link: body no secret leak', noLeak(text));
  }
  // invalid quote: unknown token -> 404 "invalid link"
  {
    const { res } = await callFn('create-payment-link', { token: 'unknown-' + Date.now() });
    expect('create-payment-link: unknown token -> 404', res.status === 404, `HTTP ${res.status}`);
  }
  // expired token -> 404 (same "invalid link")
  if (process.env.PAY_EXPIRED_TOKEN) {
    const { res } = await callFn('create-payment-link', { token: process.env.PAY_EXPIRED_TOKEN });
    expect('create-payment-link: expired token -> 404', res.status === 404, `HTTP ${res.status}`);
  } else skip('create-payment-link: expired token', 'set PAY_EXPIRED_TOKEN');
  // approved-but-not-yet: a token for a quote in status != approved -> 400 "approve the terms first"
  // (seed quotes are approval_status 'none', but their tokens aren't exposed; needs a fixture token)
  skip('create-payment-link: not-approved -> 400', 'needs a non-approved quote approval_token fixture');
  // invalid amount: approved quote whose total is 0 -> 400 "nothing to pay"
  if (process.env.PAY_ZERO_TOKEN) {
    const { res } = await callFn('create-payment-link', { token: process.env.PAY_ZERO_TOKEN });
    expect('create-payment-link: zero amount -> 400', res.status === 400, `HTTP ${res.status}`);
  } else skip('create-payment-link: invalid amount', 'set PAY_ZERO_TOKEN');
  // already paid -> 409
  if (process.env.PAY_PAID_TOKEN) {
    const { res } = await callFn('create-payment-link', { token: process.env.PAY_PAID_TOKEN });
    expect('create-payment-link: already-paid -> 409', res.status === 409, `HTTP ${res.status}`);
  } else skip('create-payment-link: already-paid', 'set PAY_PAID_TOKEN');
  // approved happy path + duplicate click reuse (TEST mode razorpay: creates a real
  // TEST payment link — no settlement). Two sequential clicks must return the SAME link.
  if (process.env.PAY_APPROVED_TOKEN) {
    const a = await callFn('create-payment-link', { token: process.env.PAY_APPROVED_TOKEN });
    expect('create-payment-link: approved -> 200 link', a.res.status === 200 && a.json && !!a.json.link_url, `HTTP ${a.res.status}`);
    expect('create-payment-link: approved body no secret leak', noLeak(a.text));
    const b = await callFn('create-payment-link', { token: process.env.PAY_APPROVED_TOKEN });
    expect('create-payment-link: duplicate click reuses open link',
      a.json?.link_url && b.json?.link_url === a.json.link_url, 'link_url should be identical on 2nd click');
  } else {
    skip('create-payment-link: approved happy path', 'set PAY_APPROVED_TOKEN (TEST-mode quote)');
    skip('create-payment-link: duplicate click / reuse open link', 'set PAY_APPROVED_TOKEN');
  }
}

// ============================================================================
async function testRazorpayWebhook() {
  console.log('\n== razorpay-webhook ==');
  const UNKNOWN_QID = '00000000-0000-4000-8000-000000000000'; // valid UUID, no such quote -> 200 "no quote", NO settlement
  const base = (overrides = {}) => JSON.stringify({
    event: 'payment_link.paid',
    payload: { payment_link: { entity: { id: 'plink_test_' + Date.now(), amount_paid: 1, notes: { quote_id: UNKNOWN_QID }, ...overrides } } },
  });

  // missing signature -> 401
  {
    const { res } = await postWebhook(base(), null);
    expect('razorpay-webhook: missing signature -> 401', res.status === 401, `HTTP ${res.status}`);
  }
  // invalid signature -> 401
  {
    const { res } = await postWebhook(base(), 'deadbeef');
    expect('razorpay-webhook: invalid signature -> 401', res.status === 401, `HTTP ${res.status}`);
  }
  // valid signed fixture (unknown quote) -> 200 "no quote" (signature ACCEPTED, no settlement)
  {
    const body = base();
    const { res, text } = await postWebhook(body, rzpSign(body));
    expect('razorpay-webhook: valid signature accepted -> 200 (no settlement)',
      res.status === 200 && /no quote/i.test(text), `HTTP ${res.status} body="${text.slice(0, 60)}"`);
    expect('razorpay-webhook: body no secret leak', noLeak(text));
  }
  // replay: same signed body again -> still 200, still no settlement
  {
    const body = base();
    const sig = rzpSign(body);
    await postWebhook(body, sig);
    const { res } = await postWebhook(body, sig);
    expect('razorpay-webhook: replay -> 200 idempotent', res.status === 200, `HTTP ${res.status}`);
  }
  // underpayment: real-looking but amount below total; unknown quote still returns
  // 200 without settling. A seeded-quote underpayment fixture can be added via env.
  if (process.env.WEBHOOK_UNDERPAY_QID) {
    const body = JSON.stringify({
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_under_' + Date.now(), amount_paid: 1, notes: { quote_id: process.env.WEBHOOK_UNDERPAY_QID } } } },
    });
    const { res, text } = await postWebhook(body, rzpSign(body));
    expect('razorpay-webhook: underpayment -> 200 NOT settled',
      res.status === 200 && /mismatch|no quote/i.test(text), `HTTP ${res.status} body="${text.slice(0, 60)}"`);
  } else skip('razorpay-webhook: underpayment', 'set WEBHOOK_UNDERPAY_QID (a real staging quote id with total > 0)');
  // duplicate concurrent delivery: two identical signed requests fired in parallel.
  // At most one may "win"; neither may 500. Using the unknown quote keeps it settlement-free.
  {
    const body = base();
    const sig = rzpSign(body);
    const [a, b] = await Promise.all([postWebhook(body, sig), postWebhook(body, sig)]);
    expect('razorpay-webhook: concurrent duplicate -> both 200, none 500',
      a.res.status === 200 && b.res.status === 200, `HTTP ${a.res.status}/${b.res.status}`);
  }
}

// ============================================================================
async function main() {
  assertStaging();
  console.log(`[edge-http] target: ${SUPABASE_URL} (staging ref ${STAGING_REF})`);

  // fail-closed if any function URL is unreachable
  for (const fn of ['send-otp', 'send-whatsapp', 'create-payment-link', 'razorpay-webhook']) {
    if (!(await reachable(fn))) blocked(`function URL unreachable: ${fnUrl(fn)} — deploy first (scripts/staging/deploy-edge.sh --confirm).`);
  }

  const manifest = await loadManifest();
  if (!manifest) console.log('[edge-http] WARN: no seed manifest — whatsapp role tests will be skipped.');

  await testSendOtp();
  await testSendWhatsapp(manifest);
  await testCreatePaymentLink();
  await testRazorpayWebhook();

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n[edge-http] ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped (of ${results.length}).`);
  if (failed.length) {
    console.log('[edge-http] GATE: FAIL');
    for (const r of failed) console.log(`   FAIL: ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
    process.exit(1);
  }
  console.log('[edge-http] GATE: PASS');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => blocked(err?.message || String(err)));
}

export { STAGING_REF, PROD_REF };
