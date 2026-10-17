// 0150 studio WhatsApp + e-mail setup: validation, three-word status, Send test results,
// SQL shape, edge-function safety (static + pure checks; no DB, no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

globalThis.window = undefined;
const H = require('../public/integrations.js');
const L = await import('../supabase/functions/integrations-test/logic.mjs');
const html = r('public/integrations.html'), js = r('public/integrations.js');
const mig = r('supabase/migrations/0150_studio_channel_settings.sql'), apply = r('supabase/APPLY-0150.sql');
const fn = r('supabase/functions/integrations-test/index.ts'), disp = r('supabase/functions/comms-dispatch/index.ts');

await t('E.164 phone validation', () => {
  assert.deepEqual(H.parseE164('+91 98765 43210'), { ok: true, digits: '919876543210' });
  assert.deepEqual(H.parseE164('00971 50 123 4567'), { ok: true, digits: '971501234567' });
  assert.deepEqual(H.parseE164(''), { ok: true, digits: '' });
  for (const bad of ['9876543210', '+0 1234 5678', '+91 98765', '+1 23', '+91 98765 43210 1', 'abc', '+44 20x']) assert.equal(H.parseE164(bad).ok, false, bad);
  assert.equal(H.parseE164('+1 415 555 0100').digits, '14155550100');
});
await t('e-mail + sender-name validation (client and server agree)', () => {
  assert.ok(H.validEmail('bookings@rao.in')); assert.ok(H.validEmail(''));
  for (const bad of ['a@b', 'x y@z.com', 'a@b.c', '<a@b.com>', 'a,b@c.com']) assert.ok(!H.validEmail(bad), bad);
  assert.ok(H.validFromName('Rao Events')); assert.ok(!H.validFromName('A <b>')); assert.ok(!H.validFromName('x'.repeat(61)));
  assert.ok(L.EMAIL_RE.test('bookings@rao.in') && !L.EMAIL_RE.test('a,b@c.com'));
});
await t('status words: Not connected / Simulated / Live', () => {
  const num = { studio_whatsapp: '919876543210' };
  assert.equal(H.whatsappStatus({}, null).label, 'Not connected');
  assert.equal(H.whatsappStatus(num, null).label, 'Simulated');
  assert.equal(H.whatsappStatus(num, { whatsapp: { live: false } }).label, 'Simulated');
  assert.equal(H.whatsappStatus(num, { whatsapp: { live: true } }).label, 'Live');
  assert.equal(H.emailStatus(null, null).label, 'Not connected');
  assert.equal(H.emailStatus({}, { email: { live: false } }).label, 'Simulated');
  assert.equal(H.emailStatus({}, { email: { live: true } }).label, 'Live');
});
await t('Send test result lines', () => {
  assert.match(H.testResultText('email', { mode: 'simulated', to: 'a***@b.com', reason: 'RESEND_API_KEY is not set yet' }).text, /^Simulated .*RESEND_API_KEY/);
  assert.equal(H.testResultText('whatsapp', { mode: 'live', sent: true, to: '+91******10' }).state, 'on');
  assert.equal(H.testResultText('whatsapp', { mode: 'live', sent: false, error: 'Meta refused it' }).state, 'off');
  assert.equal(H.localSimulation('whatsapp', { phone: '+91 1' }).mode, 'simulated');
});
await t('edge logic: status booleans only, sender/reply-to, masking', () => {
  const env = (m) => (k) => m[k];
  assert.deepEqual(L.channelStatus(env({})).whatsapp.live, false);
  const live = L.channelStatus(env({ RESEND_API_KEY: 're_x', RESEND_FROM: 'Helm <hello@helm.events>', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1234567', COMMS_WHATSAPP_TEMPLATE: 'helm_notice' }));
  assert.equal(live.email.live, true); assert.equal(live.whatsapp.live, true); assert.equal(live.email.sender, 'hello@helm.events');
  assert.ok(!JSON.stringify(live).includes('re_x') && !JSON.stringify(live).includes('"t"'), 'no secret values in status');
  assert.equal(L.channelStatus(env({ WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1234567' })).whatsapp.live, false, 'no template -> not live');
  assert.equal(L.fromHeader('Helm <hello@helm.events>', 'Rao "Events"', 'X'), '"Rao Events" <hello@helm.events>');
  assert.equal(L.fromHeader('', '', 'Studio'), '"Studio" <onboarding@resend.dev>');
  assert.equal(L.replyToOf('Bad <x>'), ''); assert.equal(L.replyToOf('B@Rao.in'), 'b@rao.in');
  assert.equal(L.maskEmail('owner@rao.in'), 'o***@rao.in'); assert.equal(L.maskPhone('919876543210'), '+91******10');
  assert.equal(L.waTestContent(env({ COMMS_WHATSAPP_TEMPLATE: 'helm_notice' })).template.name, 'helm_notice');
  assert.equal(L.waTestContent(env({})), null);
});
await t('edge function: caller JWT, fixed recipients, host allowlist, no secret echoed', () => {
  assert.match(fn, /jwt === anonKey/); assert.match(fn, /rpc\("integrations_test_target"/);
  assert.ok(!/body\.(to|number|email|phone)/.test(fn), 'recipient never taken from the request');
  assert.match(fn, /ALLOWED_HOSTS = new Set\(\["api\.resend\.com", "graph\.facebook\.com"\]\)/);
  assert.match(fn, /checkLimits\(\[\["itest:send:" \+ user\.id, 5, 600_000\]\]\)/);
  assert.ok(!/json\([^;]*env\("(WHATSAPP_TOKEN|RESEND_API_KEY|WHATSAPP_APP_SECRET)"\)/.test(fn), 'secret values never returned');
  assert.match(disp, /comms_outbox_email_identity/); assert.match(disp, /reply_to: replyTo/);
});
await t('page: CSP-safe forms + Send test buttons, no secret inputs', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)); assert.ok(!/\sstyle=/i.test(html)); assert.ok(!/\son[a-z]+=/i.test(html));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js));
  for (const id of ['itgWaNum', 'itgWaSave', 'itgWaTest', 'itgFromName', 'itgReplyTo', 'itgEmailSave', 'itgEmailTest']) assert.match(html, new RegExp('id="' + id + '"'));
  for (const tag of html.match(/<input[^>]*>/g) || []) assert.ok(!/password|token|secret|api.?key/i.test(tag), 'no secret fields: ' + tag);
  assert.ok(!/localStorage|sessionStorage/.test(js));
});
await t('SQL 0150: additive, idempotent, ASCII, gated, VERIFY (item, ok), MANIFEST', () => {
  const body = mig.replace(/--.*$/gm, '');
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(body)); assert.ok(!/[^\x00-\x7F]/.test(mig + apply));
  assert.match(mig, /add column if not exists email_from_name/); assert.match(mig, /not valid/);
  assert.match(mig, /has_area\('controls', 'edit'\)/);
  assert.match(mig, /revoke all on function public\.studio_email_identity\(uuid\) from authenticated/);
  assert.ok(apply.includes('begin;') && apply.includes('commit;') && /select '[^']+' as item,[\s\S]*as ok/.test(apply));
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0150_studio_channel_settings\.sql/);
});
console.log('integrations-setup: ' + n + ' passed');
