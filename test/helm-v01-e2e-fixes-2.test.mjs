// helm-v01-e2e-fixes-2.test.mjs - static guards for the second round of helm-v01 trial E2E fixes (Oct 2026)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const TOOLS = ['settlement', 'budget', 'closure', 'runsheet', 'resources', 'logistics', 'teardown', 'command', 'ready'];

t('slug routes for workspace tool pages + /<slug>/events → quotes (server, vercel, HelmUrl)', () => {
  const { prettyPage } = require('../server.js');
  TOOLS.forEach((p) => assert.equal(prettyPage('/demo-studio/' + p), p));
  assert.equal(prettyPage('/demo-studio/events'), 'quotes');
  assert.equal(prettyPage('/demo-studio/events/DEMO-202'), 'event');
  const v = JSON.parse(r('vercel.json'));
  TOOLS.forEach((p) => assert.ok(v.rewrites.some((x) => x.source === '/([a-z0-9-]+)/' + p && x.destination === '/' + p), p));
  assert.ok(v.rewrites.some((x) => x.source === '/([a-z0-9-]+)/events' && x.destination === '/quotes'));
  const priv = v.headers.find((h) => /^\/\(\[a-z0-9-\]\+\)\/\(dashboard\|/.test(h.source));
  TOOLS.concat(['events']).forEach((p) => assert.ok(priv.source.includes('|' + p + '|'), 'private headers ' + p));
  const api = r('public/store-api.js');
  assert.match(api, /integrations\|settlement\|budget\|closure\|runsheet\|resources\|logistics\|teardown\|command\|ready"\.split/);
  assert.match(api, /: "quotes";\s+\/\/ \/<studio>\/events/);
  assert.match(api, /async function toolQuoteRef\(\)/); assert.match(api, /if \(await toolQuoteRef\(\)\) await HANG\(\);/);
  TOOLS.forEach((p) => assert.match(r('public/' + p + '.html'), /<head>\n<base href="\/">/, p + ' base href'));
});
t('demo staff rows never show the invalid-phone warning; 0138 touches demo rows only', () => {
  assert.match(r('public/store-api.js'), /phoneInvalid: \(s\) => !!\(s && s\.phone && !\(s\.is_demo === true/);
  const m = r('supabase/migrations/0138_demo_staff_phones.sql'), a = r('supabase/APPLY-0136-0138.sql');
  assert.ok(/^[\x00-\x7f]*$/.test(m) && /^[\x00-\x7f]*$/.test(a), 'ASCII only');
  assert.match(m, /where is_demo is true\s+and profile_id is null\s+and phone like '\+91 00000 %'/);
  assert.doesNotMatch(m, /\b(delete|drop|truncate|insert)\b/i);
  assert.ok(a.includes(m.trim()), 'APPLY embeds 0138 verbatim'); assert.match(a, /'0138 no demo staff row left/);
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0138_demo_staff_phones\.sql/);
});
t('invite create reports the e-mail status; #account opens the Pricing tab account card', () => {
  const c = r('public/control.html');
  assert.match(c, /Invitation email sent to \$\{email\}\. The link below also works/);
  assert.match(c, /Invitation email queued for \$\{email\}\. The link below also works/);
  assert.match(c, /switchTab\("pricing"\);\s+\/\/ these cards live on the Pricing tab/);
  assert.match(c, /window\.addEventListener\("hashchange", focusHashCard\)/);
});
t('over-balance payment: no "Record anyway"', () => {
  ['public/settlement.html', 'public/flow.html'].forEach((p) => {
    const s = r(p); assert.doesNotMatch(s, /Record anyway/);
    assert.match(s, /Payments can't exceed the balance\. Approve a change order to increase the total first\./);
  });
});
t('confirm dialog: effective rates, "—" when invalid, total-change warning, awaiting approval label', () => {
  const q = r('public/quotes.html');
  assert.match(q, /function paintRateNote\(p\)/); assert.match(q, /\$\{valid\?inr\(t\.total\):"—"\}/);
  assert.match(q, /Total changes from \$\{esc\(inr\(saved\)\)\} to/); assert.match(q, /Total changes from \$\{inr\(sv\)\} to/);
  assert.match(q, /Confirmed · awaiting client approval/); assert.match(r('public/event.html'), /Confirmed · awaiting client approval/);
  assert.match(q, /<option>V\$\{esc\(x\.currentVersion\)\}<\/option>/); assert.match(q, /\/v\(\\d\+\)\/i\.exec/);
});
t('workspace: one Next-step CTA, vendors not double counted, event group stays on page', () => {
  const e = r('public/event.html');
  assert.match(e, /if\(canEdit && !hasNext && cur<STAGES\.length-1\)/); assert.doesNotMatch(e, /booked · \$\{vendorSummary\.confirmed\} confirmed/);
  assert.match(e, /stay:true/); assert.match(r('public/event-group-picker.js'), /if \(stay && onDone\)/);
});
console.log(`helm-v01-e2e-fixes-2: ${n} passed`);
