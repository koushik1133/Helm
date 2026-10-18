#!/usr/bin/env node
/* trial-setup-chip.test.mjs — the dashboard greeting's dashed "Setup 0% done ──── →" pill
 * (studio set-up progress, links to /onboarding) is NOT shown to a free-trial studio
 * (its studio is ready-made with sample data and has no studio set-up). Paid studios keep it.
 * Runs the real setupChip() from shell-b-dash.js in a stubbed DOM. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DASH = readFileSync(join(ROOT, 'public', 'shell-b-dash.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'trial-lock.css'), 'utf8');
let passed = 0;
const t = async (n, f) => { await f(); passed++; console.log('  ✓ ' + n); };

const a = DASH.indexOf('  function setupChip() {'), b = DASH.indexOf('\n  }\n', a) + 4;
assert.ok(a > 0 && b > a, 'setupChip() found');
const FN = DASH.slice(a, b);

function run({ trialClass = false, inTrial = false, nudge = { pct: 0, href: '/onboarding.html' } } = {}) {
  const listeners = {};
  const node = () => ({ hidden: false, children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}, querySelector: () => null, textContent: '' });
  const gs = node();
  const html = { cls: new Set(trialClass ? ['helm-trial'] : []), classList: { contains(c) { return html.cls.has(c); }, toggle() {} } };
  const ctx = {
    document: { getElementById: (id) => (id === 'gsCard' ? gs : null), documentElement: html, addEventListener: (k, f) => { listeners[k] = f; } },
    window: { HelmOnbWizard: { lastNudge: nudge }, BPStore: { trialOrg: { inTrial: () => Promise.resolve(inTrial) } },
      addEventListener: (k, f) => { listeners[k] = f; } },
    MutationObserver: function () { this.observe = () => {}; },
    el: (tag, cls, txt) => Object.assign(node(), { tag, className: cls, textContent: txt || '' }),
    clear: (n) => { n.children = []; return n; }, meter: () => node(), icon: () => node(), IC: { arrow: '' },
    Promise,
  };
  ctx.window.window = ctx.window; ctx.BPStore = ctx.window.BPStore;
  vm.runInNewContext(FN + '\nthis.chip = setupChip();', ctx);
  return { chip: ctx.chip, html, listeners };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

await t('paid studio: the "Setup 0% done" pill is shown', async () => {
  const { chip } = run(); await tick();
  assert.equal(chip.hidden, false);
  assert.equal(chip.children[0].textContent, 'Setup 0% done');
});
await t('free trial (html.helm-trial from trial-lock.js): the pill stays hidden', async () => {
  const { chip } = run({ trialClass: true }); await tick();
  assert.equal(chip.hidden, true);
});
await t('free trial (BPStore.trialOrg.inTrial() answers true after the first paint): the pill is hidden', async () => {
  const { chip } = run({ inTrial: true }); await tick();
  assert.equal(chip.hidden, true);
});
await t('trial-lock turns on later (helm:trial event): the pill hides', async () => {
  const r = run(); await tick();
  assert.equal(r.chip.hidden, false);
  r.html.cls.add('helm-trial'); r.listeners['helm:trial']();
  assert.equal(r.chip.hidden, true);
});
await t('trial-lock.css also hides #hdSetup (no flash before the JS answer)', async () => {
  assert.match(CSS, /html\.helm-trial #hdSetup/);
});

console.log(`\ntrial-setup-chip: ${passed} check(s) passed.`);
