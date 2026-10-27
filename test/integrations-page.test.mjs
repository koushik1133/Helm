// 0134 Integrations page + setup checklist + emergency-contact fix: static + pure checks (no DB, no network).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const html = r('public/integrations.html'), js = r('public/integrations.js');
const mig = r('supabase/migrations/0134_integrations_overview.sql'), apply = r('supabase/APPLY-0134.sql'), verify = r('supabase/VERIFY-0134.sql');

t('page: CSP-safe (no inline script, no style attrs, no on* handlers)', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>');
  assert.ok(!/\sstyle=/i.test(html)); assert.ok(!/\son[a-z]+=/i.test(html));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js), 'status painted with textContent only');
  assert.match(html, /class="auth-pending"/); assert.match(html, /integrations\.js\?v=4/);
});
t('page: three cards + WhatsApp guide names both templates and Settings number field', () => {
  for (const id of ['itgEmail', 'itgWa', 'itgPay']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(html, /helm_task_assigned/); assert.match(html, /helm_event_reminder/); assert.match(html, /\{\{1\}\}/);
  assert.match(html, /control\.html#notify/); assert.match(html, /WHATSAPP_TPL_TASK_ASSIGNED=helm_task_assigned/);
});
t('pure status helpers', () => {
  globalThis.window = undefined;
  const H = require('../public/integrations.js');
  assert.equal(H.emailStatus(null).state, 'off');
  assert.equal(H.emailStatus({ has_invite_mailer: true, email: { sent_30d: 3 } }).state, 'on');
  assert.equal(H.emailStatus({ has_invite_mailer: true, email: { skipped_30d: 1 } }, { email: { live: false } }).state, 'wait');
  assert.equal(H.whatsappStatus({ studio_whatsapp: '919876543210' }, { whatsapp: { live: true } }).state, 'on');
  assert.equal(H.whatsappStatus({ studio_whatsapp: '919876543210' }, null).state, 'wait');
  assert.equal(H.whatsappStatus({}, false).label, 'Not connected');
  assert.equal(H.razorpayStatus(null, false).label, 'Not connected');
  assert.equal(H.showPhone('919876543210'), '+91 98765 43210');
});
t('routing: pretty /<studio>/integrations wired in server, vercel, store-api, private headers', () => {
  const { prettyPage } = require('../server.js');
  assert.equal(prettyPage('/acme-events/integrations'), 'integrations');
  const v = r('vercel.json'); assert.match(v, /"\/\(\[a-z0-9-\]\+\)\/integrations"/); assert.match(v, /\|integrations\|control\|(?:[a-z|]+\|)?events/);
  assert.match(r('public/store-api.js'), /onboarding\|integrations(?:\|[a-z|]+)?"\.split/);
  assert.match(r('public/_headers'), /\/integrations\.html\n  X-Robots-Tag: noindex/);
  assert.match(r('public/shell-b.js'), /"Integrations", "integrations\.html"/);
});
t('SQL 0134: read-only, definer, gated, no anon, no secrets, APPLY bundle shape', () => {
  assert.match(mig, /returns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(mig, /has_area\('controls', 'view'\)/);
  assert.ok(!/\b(insert|update|delete|truncate|drop|alter)\b/i.test(mig.replace(/--.*$/gm, '')), 'no writes / DDL beyond the function');
  assert.ok(!/key_secret|token|webhook_secret/i.test(mig.split('$$')[1] || ''), 'body reads no secrets');
  assert.match(mig, /revoke all on function public\.integrations_overview\(\) from anon/);
  assert.ok(apply.startsWith('-- APPLY 0134') && /\nbegin;/.test(apply) && /\ncommit;/.test(apply) && apply.includes(verify.trim()));
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0134_integrations_overview\.sql/);
});
t('setup checklist + wizard link to the Integrations page', () => {
  const gs = require('../public/getting-started.js');
  assert.equal(gs.STEPS.whatsapp.href, 'integrations.html#whatsapp');
  assert.match(gs.STEPS.team.why, /e-mails each invite/);
  assert.match(r('public/onboarding.js'), /kind === "connect"/);
});
t('MVP flag: HELM_FEATURES.integrationsPage=false hides sidebar entry, checklist step, wizard step; page redirects', () => {
  assert.match(r('public/config.js'), /HELM_FEATURES = Object\.assign\(\{ integrationsPage: \/\^\(localhost\|127\\\.0\\\.0\\\.1\)\$\/\.test\(location\.hostname\) \}/, 'page on for localhost only, hidden on live hosts');
  assert.match(r('public/shell-b.js'), /HELM_FEATURES\.integrationsPage === true\), "integrations", "Integrations"/);
  assert.match(js, /\/integrations\\\/\?\$\/[\s\S]*\/dashboard"[\s\S]*"\/dashboard\.html"/);
  const gs = require('../public/getting-started.js');
  const data = { admin: true, steps: [{ key: 'team', done: false }] };
  return gs.addWhatsappStep(data, { integrations: { overview: async () => ({}) } }).then(() => assert.ok(!data.steps.some((s) => s.key === 'whatsapp')));
});
t('emergency contact: section is never left as an empty dropdown; helper explains who it is for', () => {
  const a = r('public/auth-ui.js');
  assert.ok(!/if \(noEmerg\) sE\.hidden = true;/.test(a), 'body no longer hidden behind a clickable summary');
  assert.match(a, /hurt or unwell while working an event/);
});
console.log('integrations-page: ' + n + ' passed');
