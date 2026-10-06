#!/usr/bin/env node
/* ============================================================================
 * injection-sinks.test.mjs — Security audit Phase 6 (injection / XSS) regressions.
 * Each case pins a confirmed sink to its fix and, where the fix is a pure
 * expression, runs it against the original attack payload.
 *   chat.html     reaction emoji rendered as HTML               → esc()
 *   store-api.js  chat media: outside URLs loaded as <img>/<audio> → own storage keys only
 *   quotes.html   print popup: raw pricing fields + opener      → numbers only, opener=null
 *   flow.html     package card: dishes.length from jsonb        → Array.isArray guard
 *   flow.html     Email button: address not URL-encoded (Bcc)   → encodeURIComponent
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const chat = read('public/chat.html');
const api = read('public/store-api.js');
const quotes = read('public/quotes.html');
const flow = read('public/flow.html');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --- chat reactions ---------------------------------------------------------
t('chat: every reaction emoji is escaped where it is shown', () => {
  const m = chat.match(/const rx=Object\.keys\(by\)\.map\(e=>`([^`]*)`\)/);
  assert.ok(m, 'reaction renderer must exist');
  const tpl = m[1];
  // no bare ${e} anywhere in the template — attribute AND text
  assert.ok(!/\$\{e\}/.test(tpl), 'reaction emoji must never be interpolated raw: ' + tpl);
  assert.match(tpl, />\$\{esc\(e\)\} \$\{by\[e\]\.length\}</, 'visible emoji must go through esc()');
});

// --- chat media ---------------------------------------------------------------
const keyM = api.match(/const CHAT_MEDIA_KEY = (\/.*\/[a-z]*);/);
const mediaM = api.match(/async mediaUrl\(path, seconds\) \{([\s\S]*?)\n    \},/);
t('chat media: only our own storage keys are signed — outside URLs never load', () => {
  assert.ok(keyM && mediaM, 'CHAT_MEDIA_KEY + chat.mediaUrl must exist');
  const KEY = eval(keyM[1]);
  const org = 'a0000000-0000-4000-8000-000000000001', conv = '43a79ca3-b090-460f-bb01-d0b12f74c053';
  for (const ok of [`${org}/${conv}/0b0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11.png`, `${org}/${conv}/1730000000000a1b2c3.m4a`])
    assert.ok(KEY.test(ok), 'real upload key must pass: ' + ok);
  for (const bad of ['https://attacker.supabase.co/storage/v1/object/public/p/pixel.png', 'http://evil.example/x.png',
    'data:image/svg+xml,<svg onload=alert(1)>', 'javascript:alert(1)', `${org}/${conv}/../../x.png`, `//evil.example/${org}/${conv}/a.png`])
    assert.ok(!KEY.test(bad), 'must be refused: ' + bad);
  const body = mediaM[1];
  assert.ok(!/\^https\?:/.test(body), 'mediaUrl must not pass http(s) URLs through');
  assert.ok(!/\^data:/.test(body), 'mediaUrl must not pass data: URLs through in supabase mode');
  assert.ok(body.indexOf('CHAT_MEDIA_KEY.test(path)') > -1 && body.indexOf('CHAT_MEDIA_KEY.test(path)') < body.indexOf('createSignedUrl'),
    'the key check must run before signing');
});

// --- quotes.html print popup ------------------------------------------------
const dlM = quotes.match(/async function downloadQuote\(id, ver\)\{([\s\S]*?)\n  \}\n/);
t('quotes print: pricing fields reach the popup only as numbers', () => {
  assert.ok(dlM, 'downloadQuote must exist');
  const body = dlM[1];
  for (const f of ['chairs', 'guests', 'serviceChargePct'])
    assert.ok(!new RegExp('\\$\\{p\\.' + f + '[^a-zA-Z]').test(body), `p.${f} must not be interpolated raw`);
  const numM = body.match(/const num=(\(v\)=>\{[^\n]*\});/);
  assert.ok(numM, 'num() coercion helper must exist');
  const num = eval(numM[1]);
  assert.equal(num("0)</td></tr></table><meta http-equiv=refresh content='0;url=https://evil.example'>"), 0);
  assert.equal(num({ length: '<b>' }), 0);
  assert.equal(num('12'), 12);
  assert.equal(num(250), 250);
});
t('print popups cannot navigate the Helm tab (opener cleared)', () => {
  assert.match(dlM[1], /window\.open\("","_blank"\); if\(w\)\{ w\.opener=null;/, 'quotes popup must clear opener first');
  assert.match(flow, /window\.open\('','_blank'\); if\(w\)\{ w\.opener=null;/, 'flow popup must clear opener first');
});

// --- flow.html package cards --------------------------------------------------
t('flow packages: dish count is a real number even for non-list jsonb', () => {
  assert.ok(!/\(p\.dishes\|\|\[\]\)\.length/.test(flow), 'must not trust dishes.length from jsonb');
  const m = flow.match(/\$\{(Array\.isArray\(p\.dishes\)\?p\.dishes\.length:0)\} dishes/);
  assert.ok(m, 'dish count must be Array.isArray-guarded');
  const count = (p) => eval(m[1]);
  assert.equal(count({ dishes: { length: '<meta http-equiv=refresh content=0;url=https://evil.example>' } }), 0);
  assert.equal(count({ dishes: [1, 2, 3] }), 3);
  assert.equal(count({}), 0);
});

// --- flow.html Email button ---------------------------------------------------
t('flow Email button: a stored address cannot add Cc/Bcc headers', () => {
  const m = flow.match(/const mailHref=([^;]+);/);
  assert.ok(m, 'mailHref builder must exist');
  assert.match(flow, /href="\$\{esc\(mailHref\)\}">Email<\/a>/, 'Email href must be the encoded mailHref');
  assert.ok(!/href="mailto:\$\{/.test(flow), 'no raw mailto:${…} interpolation left');
  const build = (ev, waText) => eval(m[1]);
  const waText = encodeURIComponent('Hi, link: https://www.helm.events/x/portal/tok');
  const href = build({ client: { email: 'client@corp.com?bcc=attacker%40evil.example&x=' } }, waText);
  const [addr, query] = [href.slice(7, href.indexOf('?')), href.slice(href.indexOf('?') + 1)];
  assert.equal(addr, 'client@corp.com%3Fbcc%3Dattacker%2540evil.example%26x%3D', 'address must be fully encoded');
  const keys = new URLSearchParams(query); assert.deepEqual([...keys.keys()], ['subject', 'body'], 'only subject + body headers');
  assert.equal(build({ client: { email: 'priya@studio.in' } }, waText).slice(0, 23), 'mailto:priya@studio.in?', 'a normal address stays readable');
  assert.ok(!esc(href).includes('"'), 'html-escaped href stays inside its attribute');
});

// --- create-payment-link: only Razorpay-issued links are re-served --------------
// (audit Phase 8: the reuse decision moved into payment_link_begin / 0027 under the
//  per-quote lock; the Edge Function re-checks what Razorpay hands back)
t('payment link: a stored link is reused only if Razorpay issued it', () => {
  const fn = read('supabase/functions/create-payment-link/index.ts');
  const mig = read('supabase/migrations/0027_uploads_payments.sql');
  const P = fn.match(/const PLINK = (\/.*\/);/), U = fn.match(/const RZP_URL = (\/.*\/);/);
  assert.ok(P && U && /const isRazorpayLink = /.test(fn), 'isRazorpayLink check must exist');
  const PLINK = eval(P[1]), RZP_URL = eval(U[1]);
  const check = (open) => !!open && PLINK.test(String(open.provider_ref || '')) && RZP_URL.test(String(open.link_url || ''));
  assert.equal(check({ provider_ref: 'plink_NdQ2kZ8sJ3', link_url: 'https://rzp.io/i/Ab3dE' }), true);
  for (const bad of [{ provider_ref: 'plink_x', link_url: 'https://rzp-io.pay-secure.example/i/abc' },
    { provider_ref: 'plink_x', link_url: 'https://rzp.io.evil.example/i/abc' }, { provider_ref: 'fake', link_url: 'https://rzp.io/i/abc' },
    { provider_ref: 'plink_x', link_url: 'javascript:alert(1)' }, null])
    assert.equal(check(bad), false, 'must refuse ' + JSON.stringify(bad));
  // the SQL reuse + attach gates use the same two patterns
  assert.match(mig, /coalesce\(open_row\.provider_ref, ''\) ~ '\^plink_\[A-Za-z0-9\]\+\$'/);
  assert.match(mig, /coalesce\(open_row\.link_url, ''\) ~ '\^https:\/\/rzp\\\.io\/\[A-Za-z0-9\/_-\]\+\$'/);
  assert.match(mig, /coalesce\(p_link_url, ''\) !~ '\^https:\/\/rzp\\\.io\//);
  assert.match(fn, /isRazorpayLink\(link\.id, link\.short_url\)/, 'a non-Razorpay link from the provider is never stored');
});

console.log(`\ninjection-sinks: ${passed} passed`);
