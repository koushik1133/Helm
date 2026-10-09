// Dashboard "Getting started" checklist (0059) — front end.
//  * model(): server flags → steps, "X of N done", next step, completion (optional
//    steps never block completion), unknown keys ignored, bad input → null
//  * markup: every step has icon/title/why/Start, done steps show "Done", no style=""
//    attributes, values are escaped, ring offset is numeric, celebratory state
//  * wiring: dashboard has the card + script, store-api calls the two RPCs,
//    Control Center deep-link anchors exist, CSS goes through __helmAdoptCss
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/getting-started.js');

const ctx = { module: { exports: {} }, setTimeout, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const GS = ctx.module.exports;

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ALL = ['profile', 'studio', 'pricing', 'lead', 'floor_plan', 'quote', 'team', 'mfa'];
const data = (doneKeys, keys = ALL, extra = {}) => Object.assign({ admin: true, dismissed: false,
  steps: keys.map((k) => ({ key: k, done: doneKeys.includes(k), ...(k === 'mfa' ? { optional: true } : {}) })) }, extra);

t('admin: 8 steps, 0 done, next = profile', () => {
  const m = GS.model(data([]));
  assert.equal(m.total, 8); assert.equal(m.done, 0); assert.equal(m.next.key, 'profile'); assert.equal(m.complete, false);
});
t('every step has icon, title, one-line why and a Start target', () => {
  for (const k of ALL) {
    const s = GS.STEPS[k];
    assert.ok(s.icon && s.title && s.why, k);
    assert.ok(s.href || s.act, k + ' has no Start target');
    assert.ok(!/\n/.test(s.why) && s.why.length < 110, k + ' why is one line');
  }
});
t('deep links point at the right pages/sections', () => {
  assert.equal(GS.STEPS.studio.href, 'control.html#account');
  assert.equal(GS.STEPS.pricing.href, 'control.html#pricing');
  assert.equal(GS.STEPS.team.href, 'control.html#users');
  assert.equal(GS.STEPS.lead.href, 'leads.html');
  assert.equal(GS.STEPS.floor_plan.href, 'builder.html');
  assert.equal(GS.STEPS.quote.href, 'quotes.html');
  assert.equal(GS.STEPS.profile.act, 'profile');
  assert.equal(GS.STEPS.mfa.act, 'mfa');
});
t('progress counts and next step', () => {
  const m = GS.model(data(['profile', 'studio', 'lead']));
  assert.equal(m.done, 3); assert.equal(m.pct, 38); assert.equal(m.next.key, 'pricing');
});
t('complete when every REQUIRED step is done (two-step is optional)', () => {
  const m = GS.model(data(ALL.filter((k) => k !== 'mfa')));
  assert.equal(m.complete, true); assert.equal(m.done, 7);
  assert.equal(GS.model(data(ALL.filter((k) => k !== 'team'))).complete, false);
});
t('member list: shorter, keeps server order', () => {
  const m = GS.model(data(['profile'], ['profile', 'lead', 'quote', 'mfa'], { admin: false }));
  assert.equal(m.total, 4); assert.deepEqual(Array.from(m.steps, (s) => s.key), ['profile', 'lead', 'quote', 'mfa']);
});
t('unknown keys are ignored; bad input → null', () => {
  const m = GS.model({ steps: [{ key: 'profile', done: true }, { key: '<img src=x onerror=1>', done: true }] });
  assert.equal(m.total, 1);
  assert.equal(GS.model(null), null); assert.equal(GS.model({}), null); assert.equal(GS.model({ steps: [] }), null);
});
t('done must be literally true (no truthy strings)', () => {
  const m = GS.model({ steps: [{ key: 'lead', done: 'yes' }] });
  assert.equal(m.done, 0);
});
t('dismissed flag carried through', () => { assert.equal(GS.model(data([], ALL, { dismissed: true })).dismissed, true); });

t('markup: X of N done, Start buttons, Done badges, Dismiss', () => {
  const html = GS.render(GS.model(data(['profile', 'lead'])), false);
  assert.match(html, /2 of 8 done/);
  assert.equal((html.match(/class="gs-go"/g) || []).length, 6);
  assert.equal((html.match(/class="gs-done"/g) || []).length, 2);
  assert.match(html, /Dismiss checklist/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Optional/);
});
t('markup: never a style="" attribute (CSP)', () => {
  for (const d of [data([]), data(ALL)]) for (const c of [true, false]) assert.doesNotMatch(GS.render(GS.model(d), c), /\sstyle=/i);
  assert.doesNotMatch(SRC, /style=\\?"/);
});
t('markup: collapsed hides the body', () => {
  const html = GS.render(GS.model(data([])), true);
  assert.match(html, /id="gsBody" class="gs-body" hidden/); assert.match(html, /aria-expanded="false"/);
});
t('markup: celebratory completion state', () => {
  const html = GS.render(GS.model(data(ALL)), false);
  assert.match(html, /You're all set up/); assert.match(html, /gs-confetti/); assert.match(html, /Hide checklist/);
});
t('ring offset is numeric and clamped', () => {
  assert.equal(GS.ringOffset(100), 0);
  assert.ok(GS.ringOffset(0) > 138 && GS.ringOffset(0) < 139);
  assert.equal(GS.ringOffset(-5), GS.ringOffset(0)); assert.equal(GS.ringOffset('x'), GS.ringOffset(0));
});
t('esc() escapes HTML', () => { assert.equal(GS.esc('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;'); });
t('reduced motion + phone layout in CSS; CSS adopted, never inline', () => {
  assert.match(GS._css, /prefers-reduced-motion/); assert.match(GS._css, /max-width:420px/); assert.match(GS._css, /data-theme=dark/);
  assert.match(SRC, /__helmAdoptCss\(global\.document, CSS\)/);
});

t('dashboard: card placeholder + script tag', () => {
  const d = read('public/dashboard.html');
  assert.match(d, /<section id="gsCard" class="gs" data-gs-auto hidden/);
  assert.match(d, /<script src="getting-started\.js\?v=\d+"><\/script>/);
});
t('store-api: get + dismiss call the 0059 RPCs; missing RPC → null', () => {
  const s = read('public/store-api.js');
  assert.match(s, /rpc\("my_getting_started"\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null/);
  assert.match(s, /rpc\("my_getting_started_dismiss", \{ p_dismissed: on !== false \}\)/);
});
t('Control Center: deep-link anchors exist', () => {
  const c = read('public/control.html');
  for (const id of ['accCard', 'pricingCard', 'menuCard']) assert.match(c, new RegExp(`id="${id}"`));
  assert.match(c, /"#account":"accCard"/); assert.match(c, /focusHashCard\(\);/);
});
t('tour hint: one-time, waits for the main tour', () => {
  assert.match(SRC, /HINT_KEY = "bp_seen_gs_hint"/);
  assert.match(SRC, /lsGet\("bp_seen_tour"\) \|\| \(auth && .*auth\.tourSeen\(\) === true\)/);
  assert.match(SRC, /if \(!tourSeen\) return;/);
});
t('tour hint: seen state is per account (auth user_metadata), not per device', () => {
  assert.match(SRC, /auth\.gsHintSeen\(\)/);
  assert.match(SRC, /if \(acctSeen === true\) \{ lsSet\(HINT_KEY, "1"\); return; \}/);
  assert.match(SRC, /auth\.markGsHintSeen\(\)/);
  const api = read('public/store-api.js');
  assert.match(api, /gsHintSeen: \(\) =>[^\n]*helm_gs_hint_seen === true/);
  assert.match(api, /updateUser\(\{ data: \{ helm_gs_hint_seen: true \} \}\)/);
  assert.match(SRC, /HelmTour\.start\(\[\{ sel: "#gsCard"/);
});

let fail = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok - ' + name); } catch (e) { fail++; console.log('not ok - ' + name + '\n  ' + (e && e.message)); }
}
console.log(`getting-started-ui: ${tests.length - fail}/${tests.length} passed`);
if (fail) process.exit(1);
