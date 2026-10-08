// Trial-ending reminders (0058) — front end.
//  * trialNotice (auth-ui.js, pure): calm > 3 days, urgent <= 3 days, ended = urgent + NOT
//    dismissible; members / clients / paid studios / junk → no notice
//  * bell: trial_reminder rows get a label, "warning" toast type and a /checkout link
//  * checkout.js: an in-trial / ended-trial studio is upgrading (pay only, no new trial)
//  * CSP: no inline style attributes / innerHTML in the new code; versions bumped
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AUI = read('public/auth-ui.js'), API = read('public/store-api.js'), CO = read('public/checkout.js'), COH = read('public/checkout.html');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(fnSrc(AUI, 'trialNotice') + '\n' + ['notifLink', 'bellTypeOf', 'bellLabel', 'bellToastPick'].map((f) => fnSrc(API, f)).join('\n')
  + '\nglobalThis.notice=trialNotice; globalThis.pick=bellToastPick; globalThis.label=bellLabel;', ctx);
const notice = (x) => JSON.parse(JSON.stringify(ctx.notice(x)));
const admin = (o) => Object.assign({ is_admin: true, can_pay: true }, o);

t('7 days left: calm, dismissible, "ends in 7 days"', () => {
  const s = notice(admin({ state: 'trial', days_left: 7, ends_at: '2026-10-15' }));
  assert.equal(s.urgent, false); assert.equal(s.dismissible, true); assert.equal(s.tone, '');
  assert.equal(s.title, 'Your free trial ends in 7 days');
});
t('4 days left: still calm', () => assert.equal(notice(admin({ state: 'trial', days_left: 4 })).urgent, false));
t('3 days left: urgent, still dismissible', () => {
  const s = notice(admin({ state: 'trial', days_left: 3 }));
  assert.equal(s.urgent, true); assert.equal(s.tone, 'urgent'); assert.equal(s.dismissible, true);
  assert.equal(s.title, 'Your free trial ends in 3 days');
});
t('1 day → "tomorrow", 0 → "today"', () => {
  assert.equal(notice(admin({ state: 'trial', days_left: 1 })).title, 'Your free trial ends tomorrow');
  assert.equal(notice(admin({ state: 'trial', days_left: 0 })).title, 'Your free trial ends today');
});
t('ended: urgent and NOT dismissible', () => {
  const s = notice(admin({ state: 'ended', days_left: 0 }));
  assert.equal(s.dismissible, false); assert.equal(s.urgent, true);
  assert.equal(s.title, 'Your trial has ended — choose a plan to keep using Helm');
});
t('no notice: members, clients, paid studios, junk', () => {
  assert.equal(ctx.notice({ state: 'trial', days_left: 2, is_admin: false, can_pay: false }), null);
  assert.equal(ctx.notice(admin({ state: 'none' })), null);
  assert.equal(ctx.notice(null), null);
  assert.equal(ctx.notice('x'), null);
  assert.equal(ctx.notice(admin({ state: 'trial', days_left: 'abc' })), null);
  assert.equal(ctx.notice({ state: 'ended', is_admin: true, can_pay: false }), null);
});
t('negative days are clamped (never "-2 days")', () => assert.equal(notice(admin({ state: 'trial', days_left: -2 })).title, 'Your free trial ends today'));

t('auth-ui: trial notice wired via the notice-card system, links /checkout, not on /checkout', () => {
  const body = fnSrc(AUI, 'trialStatus');
  assert.match(body, /showNote\(/); assert.match(body, /checkout\.html\?next=/); assert.match(body, /pageName\(\) === "checkout"/);
  assert.match(body, /spec\.dismissible \? function/);           // ended → no dismiss handler
  assert.match(body, /"Choose a plan"/);
  assert.match(AUI, /trialStatus\(\);/);
  assert.match(AUI, /\.hau-note\.urgent\{/);
  assert.doesNotMatch(body + fnSrc(AUI, 'trialNotice'), /innerHTML|style:|style=/);
});
t('store-api: subscription.trial → my_trial_status, fail-soft before 0058', () => {
  assert.match(API, /trial: \(\) => \(supa \? rpc\("my_trial_status"\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\)/);
});

const FEED = [{ id: 'n9', kind: 'trial_reminder', detail: { label: 'Your free trial ends in 3 days', trial: 'trial_3d' }, created_at: '2026-10-08T10:00:00Z', unread: true }];
t('bell label for trial reminders (plain text)', () => {
  const L = ctx.label(FEED[0]); assert.equal(L.text, 'Your free trial ends in 3 days'); assert.equal(L.icon, '⏳');
  assert.equal(ctx.label({ kind: 'trial_reminder', detail: {} }).text, 'Free trial update');
});
t('toast: warning type, /checkout link, plan message', () => {
  const r = JSON.parse(JSON.stringify(ctx.pick(FEED, { t: '2026-10-01T00:00:00Z', ids: [] }, { label: ctx.label })));
  assert.equal(r.toasts.length, 1);
  assert.equal(r.toasts[0].type, 'warning'); assert.equal(r.toasts[0].href, 'checkout.html');
  assert.equal(r.toasts[0].message, 'Choose a plan to keep using Helm');
});
t('bell panel item links trial reminders to /checkout', () => assert.match(API, /if \(k === "trial_reminder"\) return "checkout\.html";/));

t('checkout: in-trial / ended trial = upgrade (no new trial, test bypass hidden)', () => {
  assert.match(CO, /st\.upgrade = st\.opts\.status === "trial" \|\| st\.opts\.status === "past_due";/);
  assert.match(CO, /\$\("#coTest"\)\.hidden = st\.upgrade \|\|/);
  assert.match(CO, /if \(st\.upgrade && !st\.live\) throw/);                 // never calls startTrial while upgrading
  assert.match(CO, /up\.textContent = /); assert.doesNotMatch(CO, /innerHTML/);
  assert.match(COH, /<div class="alert info" id="coUpgrade" role="status" hidden><\/div>/);
});
t('asset versions bumped everywhere', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const h = read('public/' + f);
    assert.doesNotMatch(h, /store-api\.js\?v=123\b/, f); assert.doesNotMatch(h, /auth-ui\.js\?v=14\b/, f); assert.doesNotMatch(h, /checkout\.js\?v=1"/, f);
  }
  assert.match(API, /const AUTH_UI_VERSION = "16";/);
});
console.log(`trial-reminders-ui: ${n} passed`);
