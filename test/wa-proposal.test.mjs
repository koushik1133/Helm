// 0151 send proposal on WhatsApp + WhatsApp / e-mail approval OTP: pure template builders,
// studio widget helpers, page wiring, SQL + edge-function safety (static; no DB, no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const L = await import('../supabase/functions/wa-proposal/logic.mjs');
const TOK = 'a0000000-0000-4000-8000-0000000000aa';
const V = { client_name: 'Alice', studio_name: 'Studio A', event_type: 'wedding', event_date: '12 Dec 2026', total: 'INR 236,000' };

await t('proposal_sent: 5 body vars + URL button suffix = token', () => {
  const m = L.templateMessage('919876543210', 'proposal_sent', V, TOK);
  assert.equal(m.template.name, 'proposal_sent');
  assert.deepEqual(m.template.components[0].parameters.map((p) => p.text), ['Alice', 'Studio A', 'wedding', '12 Dec 2026', 'INR 236,000']);
  assert.equal(m.template.components[1].sub_type, 'url'); assert.equal(m.template.components[1].parameters[0].text, TOK);
});
await t('approved_pay / payment_received var counts', () => {
  assert.equal(L.bodyVars('proposal_approved_pay', V).length, 4);
  assert.equal(L.bodyVars('payment_received', V).length, 3);
  assert.equal(L.bodyVars('proposal_reminder', V).length, 5);
});
await t('bad input refused (number, token, kind, code)', () => {
  assert.throws(() => L.templateMessage('+91 98765', 'proposal_sent', V, TOK));
  assert.throws(() => L.templateMessage('919876543210', 'proposal_sent', V, 'x'));
  assert.throws(() => L.templateMessage('919876543210', 'free_text', V, TOK));
  assert.throws(() => L.otpMessage('919876543210', '12345'));
});
await t('vars are single-line and capped', () => {
  const v = L.bodyVars('proposal_sent', { ...V, client_name: 'A\nB\tC' + 'x'.repeat(500) });
  assert.ok(!/[\n\t]/.test(v[0]) && v[0].length <= 120);
});
await t('OTP auth template: code in body + copy-code button', () => {
  const m = L.otpMessage('919876543210', '123456');
  assert.equal(m.template.name, 'proposal_approval_otp');
  assert.equal(m.template.components[0].parameters[0].text, '123456');
  assert.equal(m.template.components[1].parameters[0].text, '123456');
});
await t('simulated until both Meta secrets exist', () => {
  assert.equal(L.isLive({}), false); assert.equal(L.isLive({ WHATSAPP_TOKEN: 'x' }), false);
  assert.equal(L.isLive({ WHATSAPP_TOKEN: 'x', WHATSAPP_PHONE_ID: '1' }), true);
  assert.equal(L.statusLabel('read'), 'Read'); assert.equal(L.statusLabel('simulated'), 'Simulated');
});
await t('studio widget: E.164 + kind choice', () => {
  const ctx = { window: {}, document: {} }; ctx.window.BPStore = { waNumber: (s) => String(s).replace(/\D/g, '').replace(/^(\d{10})$/, '91$1') };
  vm.runInNewContext(r('public/wa-proposal.js'), ctx);
  const W = ctx.window.HelmWaProposal;
  assert.equal(W.e164('98765 43210'), '+919876543210'); assert.equal(W.e164('123'), '');
  assert.equal(W.pickKind('paid'), 'payment_received'); assert.equal(W.pickKind('approved'), 'proposal_approved_pay');
  assert.equal(W.pickKind('sent', null), 'proposal_sent'); assert.equal(W.pickKind('sent', { status: 'sent', template: 'proposal_sent' }), 'proposal_reminder');
});
await t('widget is CSP-safe (no innerHTML / inline style / handlers)', () => {
  const s = r('public/wa-proposal.js');
  assert.ok(!/innerHTML|\.style\.|setAttribute\("on|\bon[a-z]+=/.test(s));
});
await t('flow.html mounts the widget and keeps copy-link + manual wa.me', () => {
  const h = r('public/flow.html');
  assert.match(h, /wa-proposal\.js\?v=\d+/); assert.match(h, /wa-proposal\.css\?v=\d+/);
  assert.match(h, /HelmWaProposal\.mount\(/); assert.match(h, /id="copyLink"/); assert.match(h, /WhatsApp \(manual\)/);
});
await t('approve.html: WhatsApp code, email fallback, SMS kept, no typed number for channels', () => {
  const h = r('public/approve.html');
  assert.match(h, /id="sendWa"/); assert.match(h, /id="emailFallback"/); assert.match(h, /id="sendOtp"/);
  assert.match(h, /requestChannelOtp\(token, channel\)/); assert.match(h, /setTimeout\(offerEmail, 60000\)/);
  assert.match(h, /verifyChannel\(token, otpChannel/);
});
await t('store-api routes live vs simulated', () => {
  const s = r('public/store-api.js');
  assert.match(s, /requestChannelOtp: \(token, channel\) => LIVE\.whatsapp \? callFn\("send-otp", \{ token, channel \}\)/);
  assert.match(s, /callFn\("wa-proposal"/); assert.match(s, /p_simulate: true/);
});
await t('SQL 0151: additive, ASCII, RLS, append-only, grants, MANIFEST + APPLY verify', () => {
  const s = r('supabase/migrations/0151_wa_proposal.sql');
  assert.ok(!/[^\x00-\x7F]/.test(s));
  assert.ok(!/\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b|\bupdate\s+public\.(?!.*set\s+status)/i.test(s.replace(/before update or delete/g, '')));
  assert.match(s, /enable row level security/); assert.match(s, /append-only/);
  assert.match(s, /'public\.wa_otp_begin\(uuid, text, text\)', 'none'/);
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0151_wa_proposal\.sql/);
  const a = r('supabase/APPLY-0151.sql'); assert.match(a, /^begin;/m); assert.match(a, /^commit;/m); assert.match(a, /select item, ok from/);
});
await t('edge functions: no secrets in code, fixed hosts, phone from the DB', () => {
  const e = r('supabase/functions/wa-proposal/index.ts'), o = r('supabase/functions/send-otp/index.ts');
  for (const s of [e, o]) { assert.ok(!/EAA[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}/.test(s)); }
  assert.match(e, /rpc\("wa_proposal_prepare"/); assert.match(e, /p_simulate: !live/);
  assert.match(o, /rpc\("wa_otp_begin"/); assert.match(o, /dest\.phone_key/);
});
await t('setup doc lists the 5 templates', () => {
  const d = r('docs/ops/WHATSAPP-SETUP.md');
  for (const n2 of ['proposal_sent', 'proposal_approval_otp', 'proposal_approved_pay', 'payment_received', 'proposal_reminder']) assert.match(d, new RegExp('`' + n2 + '`'));
  assert.match(d, /AUTHENTICATION/);
});
console.log(`wa-proposal: ${n} passed`);
