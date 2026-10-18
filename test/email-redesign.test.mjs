// 2026-10 e-mail redesign: shared layout, generated Supabase Auth templates, edge-function e-mails.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const r = (p) => readFileSync(new URL(p, root), 'utf8');
const L = await import('../supabase/functions/_shared/email-layout.mjs');
const W = await import('../supabase/functions/wa-proposal/logic.mjs');
const { TEMPLATES } = await import('../scripts/gen-email-templates.mjs');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const html = L.layout('T <x>', 'Pre <y>', L.h1('Hi') + L.button('https://a.test/', 'Go'));
ok(html.includes('width="600"') && html.includes('max-width:600px'), '600px container');
ok(html.includes('src="https://www.helm.events/email/helm-logo.png"') && html.includes('alt="Helm"'), 'hosted logo');
ok((html.match(/<img\b/g) || []).length === 1, 'exactly one image (logo), no tracking pixel');
ok(/prefers-color-scheme:dark/.test(html) && /\[data-ogsc\]/.test(html), 'dark-mode friendly');
ok(html.includes('Helm Events &middot;') && html.includes('helm.events</a>'), 'footer');
ok(html.includes('Pre &lt;y&gt;') && html.includes('<title>T &lt;x&gt;</title>'), 'title + preheader escaped');
ok(/role="presentation"/.test(html) && !/<script/i.test(html), 'tables, no script');
ok(existsSync(new URL('public/email/helm-logo.png', root)), 'logo PNG shipped');
const png = readFileSync(new URL('public/email/helm-logo.png', root));
ok(png.readUInt32BE(16) === 112 && png.readUInt32BE(20) === 112, 'logo is 2x (112px for 40-56px display)');

const names = ['confirm-signup', 'invite-user', 'magic-link', 'reset-password', 'change-email', 'reauthentication'];
ok(names.every((k) => TEMPLATES[k] && TEMPLATES[k].subject && TEMPLATES[k].supabase), 'six auth templates with subjects');
for (const k of names) {
  const h = r('docs/ops/email-templates/' + k + '.html');
  ok(h.includes('{{ .Email }}'), k + ' email var');
  if (k === 'reauthentication') ok(h.includes('{{ .Token }}') && !h.includes('ConfirmationURL'), k + ' token only');
  else ok(!h.includes('ConfirmationURL') && (h.match(/\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}/g) || []).length >= 3, k + ' button + fallback (own domain, 0201)');
  ok(!/6d28d9|6C4CF1|Helm<span/i.test(h), k + ' old purple "Helm." gone');
}
ok(r('docs/ops/email-templates/change-email.html').includes('{{ .NewEmail }}'), 'change-email shows new address');
execFileSync(process.execPath, [new URL('scripts/gen-email-templates.mjs', root).pathname, '--check'], { stdio: 'pipe' });
ok(true, 'generated files up to date');

const o = W.otpEmail('123456', 'Studio <A>');
ok(o.html && o.html.includes('123456') && o.html.includes('Studio &lt;A&gt;') && o.text.includes('Helm Events'), 'OTP e-mail has html + text');
ok(/subject: m\.subject, html: m\.html, text: m\.text/.test(r('supabase/functions/send-otp/index.ts')), 'send-otp sends html + text');
for (const f of ['invite-mailer/templates.ts', 'pkg-client-notify/templates.ts', 'welcome-mailer/templates.ts', 'billing-reminder/trial-email.ts']) {
  const s = r('supabase/functions/' + f);
  ok(s.includes('_shared/email-layout.mjs') && !/6C4CF1/i.test(s), f + ' uses shared layout');
}
const doc = r('docs/ops/EMAIL-TEMPLATES.md');
ok(doc.includes('reauthentication.html') && doc.includes('Your Helm verification code'), 'owner doc lists reauthentication');
console.log(`email-redesign: ${n} checks passed`);
