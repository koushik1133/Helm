#!/usr/bin/env node
// email-compliance.test.mjs - static guarantees for the e-mail compliance pass (0165).
// READ-ONLY, no network. Behaviour is proven in tests/edge/email-compliance.test.ts (Deno).
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (n, fn) => { fn(); passed++; console.log('  ✓ ' + n); };

const { txFooter, mktFooter, listUnsubHeaders, TX_REASONS } = await import('../supabase/functions/_shared/email-compliance.mjs');

t('migration 0165 + APPLY-0165: ASCII, additive (no drop/delete/truncate), VERIFY block', () => {
  for (const p of ['supabase/migrations/0165_email_unsubscribe.sql', 'supabase/APPLY-0165.sql']) {
    const s = read(p);
    assert.ok(/^[\x00-\x7F]*$/.test(s), p + ' ASCII');
    assert.doesNotMatch(s, /\b(drop\s+(table|column|function)|delete\s+from|truncate)\b/i, p + ' additive');
  }
  assert.match(read('supabase/APPLY-0165.sql'), /-- VERIFY[\s\S]*forged token refused/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0165_email_unsubscribe\.sql/);
});
t('every Resend/SMTP sender adds a compliance footer', () => {
  for (const f of ['invite-mailer', 'welcome-mailer', 'pkg-client-notify', 'security-alert-mailer', 'razorpay-webhook', 'billing-reminder', 'integrations-test', 'comms-dispatch'])
    assert.match(read(`supabase/functions/${f}/index.ts`), /txFooter\(|mktFooter\(/, f);
  assert.match(read('supabase/functions/_shared/mailer.ts'), /txFooter\(msg\.txReason/);
});
t('non-transactional senders fail closed without an unsubscribe token', () => {
  const cd = read('supabase/functions/comms-dispatch/index.ts');
  assert.match(cd, /NON_TRANSACTIONAL = new Set\(\["follow_up"\]\)/);
  assert.match(cd, /extra \? await sendEmail\([^)]*\) : "skipped"/);
  assert.match(read('supabase/functions/billing-reminder/index.ts'), /extra \? await sendEmail\(to, msg\.subject, msg\.html, extra\) : "skipped"/);
});
t('footers: transactional never says unsubscribe; marketing always does; headers are RFC 8058', () => {
  for (const k of Object.keys(TX_REASONS)) assert.doesNotMatch(txFooter(k).html, /unsubscribe/i, k);
  assert.match(mktFooter('https://www.helm.events/unsubscribe?t=x').html, />Unsubscribe<\/a>/);
  assert.equal(listUnsubHeaders('https://x.example/u', '')['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});
t('/unsubscribe page: no inline script/handlers, noindex, script + css files exist', () => {
  const h = read('public/unsubscribe.html');
  assert.doesNotMatch(h, /<script>(?!<\/script>)/); assert.doesNotMatch(h, /\son[a-z]+=/i);
  assert.match(h, /noindex/); assert.match(h, /\/unsubscribe\.js\?v=\d+/); assert.match(h, /\/unsubscribe\.css\?v=\d+/);
  const js = read('public/unsubscribe.js');
  assert.doesNotMatch(js, /innerHTML/); assert.match(js, /email-unsubscribe/);
});
t('auth e-mail templates carry the transactional footer', () => {
  for (const d of ['docs/ops/email-templates', 'docs/email-templates'])
    for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.html')))
      assert.match(read(`${d}/${f}`), /You received this because[\s\S]*Privacy[\s\S]*Helm Events, Mindspace IT Park, Madhapur, Hyderabad, Telangana 500081/, `${d}/${f}`);
});
t('EMAIL-COMPLIANCE.md documents classification + DNS', () => {
  const md = read('docs/ops/EMAIL-COMPLIANCE.md');
  for (const w of ['SPF', 'DKIM', 'DMARC', 'p=quarantine', 'Postmaster', 'List-Unsubscribe-Post', 'Transactional', 'Non-transactional']) assert.ok(md.includes(w), w);
});
console.log(`email-compliance: ${passed} passed`);
