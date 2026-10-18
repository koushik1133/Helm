// Getting-started checklist for PAID studios and the FREE TRIAL + paid onboarding fixes (Oct 2026).
//  * trial: its own 5-step list (sample event, builder, test-mode quote, invite, plan), never a
//    step the trial hides (studio set-up, branding, import, notifications...), per-account dismissal
//  * paid: lead / floor plan / quote tick from the studio's OWN rows (sample rows never count, a
//    quote's floor plan counts), the list hides itself for good once every required step is done
//  * two-step "Start" opens Account settings at two-step sign-in
//  * onboarding: step numbers match "Step N of M", a typed teammate e-mail is invited (not dropped)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/getting-started.js');
const ctx = { module: { exports: {} }, setTimeout, console, Promise };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const GS = ctx.module.exports;
const keys = (m) => Array.from(m.steps, (s) => s.key);

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const ADMIN = { admin: true, dismissed: false, steps: ['profile', 'studio', 'pricing', 'lead', 'floor_plan', 'quote', 'team', 'mfa']
  .map((k) => ({ key: k, done: k === 'lead' || k === 'quote' || k === 'pricing', ...(k === 'mfa' ? { optional: true } : {}) })) };
const clone = (o) => JSON.parse(JSON.stringify(o));
const HIDDEN_IN_TRIAL = /studio details|billing details|branding|import|notification|whatsapp|two-step/i;

t('trial admin: exactly the 5 trial steps, in order', () => {
  const d = GS.trialData(clone(ADMIN), { eventId: 'a1b2', layoutQuoteId: 'c3d4', ownQuoteSent: false }, {}, { state: 'trial', status: 'trial' });
  const m = GS.model(d);
  assert.deepEqual(keys(m), ['t_event', 't_builder', 't_quote', 't_team', 't_plan']);
  assert.equal(m.trial, true); assert.equal(m.done, 0);
  for (const s of m.steps) assert.doesNotMatch(s.title + ' ' + s.why, HIDDEN_IN_TRIAL, s.key);
});
t('trial: sample rows never tick a step (server said lead/quote done; trial list ignores them)', () => {
  const m = GS.model(GS.trialData(clone(ADMIN), {}, {}, { state: 'trial' }));
  assert.equal(m.done, 0);
  assert.ok(!keys(m).some((k) => ['lead', 'quote', 'pricing', 'studio', 'profile'].includes(k)));
});
t('trial: Start links go to a real sample event / its floor plan (falls back to the lists)', () => {
  const m = GS.model(GS.trialData(clone(ADMIN), { eventId: '1f0e-aa', layoutQuoteId: '9c-77' }, {}, { state: 'trial' }));
  assert.equal(m.steps[0].href, 'event.html?id=1f0e-aa');
  assert.equal(m.steps[1].href, 'builder.html?quote=9c-77');
  assert.equal(m.steps[3].href, 'control.html#users');
  assert.equal(m.steps[4].href, 'control.html#billing');
  const f = GS.model(GS.trialData(clone(ADMIN), null, {}, { state: 'trial' }));
  assert.equal(f.steps[0].href, 'quotes.html'); assert.equal(f.steps[1].href, 'builder.html?new=1');
  assert.equal(f.steps[2].href, 'quotes.html?new=1');
});
t('trial: unsafe per-studio hrefs are ignored', () => {
  const d = GS.trialData(clone(ADMIN), {}, {}, { state: 'trial' });
  d.steps[0].href = 'javascript:alert(1)'; d.steps[1].href = 'https://evil.example/x.html';
  const m = GS.model(d);
  assert.equal(m.steps[0].href, 'quotes.html'); assert.equal(m.steps[1].href, 'builder.html?new=1');
  assert.equal(GS.SAFE_HREF.test('event.html?id=0b1c2d3e-0000-4000-8000-000000000000'), true);
});
t('trial: ticks from account flags, own sent quote and the server "team" flag', () => {
  const s = clone(ADMIN); s.steps.find((x) => x.key === 'team').done = true;
  const m = GS.model(GS.trialData(s, { ownQuoteSent: true }, { event: true, builder: true }, { state: 'trial' }));
  assert.equal(m.done, 4); assert.equal(m.next.key, 't_plan'); assert.equal(m.complete, false);
});
t('trial: teammate without admin/quotes access gets only what they can do; no plan / invite', () => {
  const member = { admin: false, steps: [{ key: 'profile', done: true }, { key: 'floor_plan', done: true }] };
  const m = GS.model(GS.trialData(member, {}, {}, { state: 'trial' }));
  assert.deepEqual(keys(m), ['t_event', 't_builder']);
  const sales = { admin: false, steps: [{ key: 'profile', done: true }, { key: 'quote', done: true }] };
  assert.deepEqual(keys(GS.model(GS.trialData(sales, {}, {}, { state: 'trial' }))), ['t_event', 't_builder', 't_quote']);
});
t('trial ended: only "Choose a plan" (studio is read-only)', () => {
  assert.deepEqual(keys(GS.model(GS.trialData(clone(ADMIN), {}, {}, { state: 'ended' }))), ['t_plan']);
  assert.equal(GS.model(GS.trialData({ admin: false, steps: [{ key: 'quote' }] }, {}, {}, { state: 'ended' })), null);
});
t('trial dismissal comes from the account flag, not the paid list', () => {
  assert.equal(GS.model(GS.trialData(Object.assign(clone(ADMIN), { dismissed: true }), {}, {}, { state: 'trial' })).dismissed, false);
  assert.equal(GS.model(GS.trialData(clone(ADMIN), {}, { dismissed: true }, { state: 'trial' })).dismissed, true);
});
t('paid list never shows trial steps; trial list never shows paid steps', () => {
  const mixed = { admin: true, steps: [{ key: 'lead', done: false }, { key: 't_plan', done: false }] };
  assert.deepEqual(keys(GS.model(mixed)), ['lead']);
  assert.deepEqual(keys(GS.model(Object.assign({}, mixed, { trial: true }))), ['t_plan']);
});
t('trial markup: own heading, "Open" on event/builder with data-mark, no inline style', () => {
  const html = GS.render(GS.model(GS.trialData(clone(ADMIN), { eventId: 'e1' }, {}, { state: 'trial' })), false);
  assert.match(html, /Try Helm in a few steps/);
  assert.match(html, /href="event\.html\?id=e1" data-mark="event">Open/);
  assert.match(html, /data-mark="builder">Open/);
  assert.doesNotMatch(html, /\sstyle=/i);
});

t('paid: own rows decide lead / floor plan / quote (sample rows no longer tick them)', () => {
  const d = GS.applyOwnFacts(clone(ADMIN), { lead: false, floorPlan: true, quoteSent: false });
  const by = Object.fromEntries(d.steps.map((s) => [s.key, s.done]));
  assert.equal(by.lead, false); assert.equal(by.floor_plan, true); assert.equal(by.quote, false);
  assert.equal(by.pricing, true, 'other server flags kept');
  const keep = GS.applyOwnFacts(clone(ADMIN), null);
  assert.deepEqual(keep, clone(ADMIN), 'no facts = server flags unchanged');
  const partial = GS.applyOwnFacts(clone(ADMIN), { lead: 'yes' });
  assert.equal(partial.steps.find((s) => s.key === 'lead').done, true, 'only real booleans override');
});
t('paid wording: plain "Helm billing details" step (not the old "Fill in studio details")', () => {
  assert.equal(GS.STEPS.studio.title, 'Add your Helm billing details');
  assert.doesNotMatch(SRC, /Fill in studio details/);
  for (const k of Object.keys(GS.STEPS).filter((k) => k === 'studio' || /^t_/.test(k))) assert.ok(GS.STEPS[k].why.length < 110 && !/\n/.test(GS.STEPS[k].why), k);
});
t('two-step Start opens Account settings at the two-step section', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(GS.accountOpts('mfa'))), { section: 'settings', focus: 'mfa' });
  assert.deepEqual(JSON.parse(JSON.stringify(GS.accountOpts('profile'))), { focus: 'profile' });
  assert.match(read('public/auth-ui.js'), /var jumpTo = \{ mfa: mf, password: pw, devices: dv \}\[opts && opts\.focus\];/);
});
t('trialState asks the server first (does not depend on trial-lock.js having loaded)', async () => {
  assert.equal((await GS.trialState({ subscription: { trial: async () => ({ status: 'trial', state: 'trial' }) } })).trial, true);
  assert.equal((await GS.trialState({ subscription: { trial: async () => ({ status: 'active', state: 'none' }) } })).trial, false);
  assert.equal((await GS.trialState({ subscription: { trial: async () => ({ status: 'trial', state: 'ended' }) } })).trial, true);
  assert.equal((await GS.trialState({ subscription: { trial: async () => { throw new Error('x'); } } })).trial, false);
});
t('dismissal: trial -> account flag; paid -> server RPC; a failed account write throws', async () => {
  const calls = [];
  const store = { auth: { markTrialStep: async (k, on) => { calls.push(['meta', k, on]); return true; } }, gettingStarted: { dismiss: async (on) => { calls.push(['rpc', on]); } } };
  await GS._setDismissed(store, true, true); await GS._setDismissed(store, false, true); await GS._setDismissed(store, true, false);
  assert.deepEqual(calls, [['meta', 'dismissed', true], ['rpc', true], ['meta', 'dismissed', false]]);
  await assert.rejects(GS._setDismissed({ auth: { markTrialStep: async () => false } }, true, true));
});

// ---- mount() against a tiny fake card ---------------------------------------------------------
function fakeCard() {
  const attrs = {}, stub = { addEventListener() {}, hidden: false, setAttribute() {}, querySelector: () => null };
  return { hidden: true, innerHTML: '', attrs, setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return attrs[k] == null ? null : attrs[k]; },
    hasAttribute(k) { return k in attrs; }, querySelector: () => stub, querySelectorAll: () => [] };
}
function runMount(store) {
  const card = fakeCard();
  const g = { module: { exports: {} }, setTimeout, console, Promise, document: { readyState: 'complete', getElementById: () => card, querySelector: () => null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  g.globalThis = g; g.BPStore = store; vm.createContext(g); vm.runInContext(SRC, g);
  return g.module.exports.mount({ hint: false }).then((m) => ({ m, card }));
}
const baseStore = (over) => Object.assign({
  auth: { trialSteps: () => ({}), markTrialStep: async () => true },
  subscription: { trial: async () => ({ status: 'active', state: 'none' }) },
  gettingStarted: { get: async () => clone(ADMIN), dismiss: async () => {}, ownFacts: async () => ({ lead: true, floorPlan: false, quoteSent: true }),
    trialFacts: async () => ({ eventId: 'ev1', layoutQuoteId: 'ev1', ownQuoteSent: false }) },
}, over || {});
t('mount (trial studio): trial list, data attributes for the Setup chip', async () => {
  const { m, card } = await runMount(baseStore({ subscription: { trial: async () => ({ status: 'trial', state: 'trial' }) } }));
  assert.deepEqual(keys(m), ['t_event', 't_builder', 't_quote', 't_team', 't_plan']);
  assert.equal(card.hidden, false); assert.equal(card.attrs['data-gs-mode'], 'trial'); assert.equal(card.attrs['data-gs-total'], '5');
  assert.doesNotMatch(card.innerHTML, /Fill in studio details|Add your Helm billing details|Set your prices/);
});
t('mount (trial, dismissed on the account): hidden, no data fetched', async () => {
  let fetched = false;
  const st = baseStore({ subscription: { trial: async () => ({ status: 'trial', state: 'trial' }) }, auth: { trialSteps: () => ({ dismissed: true }) } });
  st.gettingStarted.trialFacts = async () => { fetched = true; return {}; };
  const { card } = await runMount(st);
  assert.equal(card.hidden, true); assert.equal(fetched, false);
});
t('mount (paid): own-row facts applied; dismissed list stays hidden', async () => {
  const { m, card } = await runMount(baseStore());
  assert.equal(m.trial, false); assert.equal(card.attrs['data-gs-mode'], 'setup');
  assert.equal(m.steps.find((s) => s.key === 'floor_plan').done, false);
  const st = baseStore(); st.gettingStarted.get = async () => Object.assign(clone(ADMIN), { dismissed: true });
  assert.equal((await runMount(st)).card.hidden, true);
});
t('mount (paid, every required step done): celebrates once and saves the dismissal', async () => {
  let dismissed = null;
  const st = baseStore();
  st.gettingStarted.get = async () => ({ admin: true, steps: ['profile', 'lead', 'quote', 'team'].map((k) => ({ key: k, done: true })).concat([{ key: 'mfa', optional: true, done: false }]) });
  st.gettingStarted.ownFacts = async () => ({ lead: true, floorPlan: true, quoteSent: true });
  st.gettingStarted.dismiss = async (on) => { dismissed = on; };
  const { m, card } = await runMount(st);
  assert.equal(m.complete, true); assert.match(card.innerHTML, /You're all set up/);
  assert.equal(card.attrs['data-gs-complete'], '1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(dismissed, true);
});

// ---- wiring in other files --------------------------------------------------------------------
t('store-api: ownFacts / trialFacts read own vs sample rows; account flags for the trial list', () => {
  const s = read('public/store-api.js');
  assert.match(s, /async ownFacts\(\)/); assert.match(s, /async trialFacts\(\)/);
  assert.match(s, /from\("quote_versions"\)\.select\("quote_id"\)\.gt\("object_count", 0\)/);
  // review: newest versions first, so a kept-after-trial studio's own plans are not crowded out by sample ones
  assert.match(s, /\.gt\("object_count", 0\)\.order\("created_at", \{ ascending: false \}\)\.limit\(200\)/);
  assert.match(s, /\.eq\("is_demo", false\)\.in\("approval_status", \["sent", "approved", "paid"\]\)/);
  assert.match(s, /trialSteps: \(\) =>/); assert.match(s, /updateUser\(\{ data: \{ helm_trial_gs: next \} \}\)/);
  assert.match(s, /\["event", "builder", "dismissed"\]\.indexOf\(key\) < 0\) return false/);
});
t('trial-lock.js: opening an event page or the builder ticks the trial step', () => {
  const s = read('public/trial-lock.js');
  assert.match(s, /markVisit\(\);/); assert.match(s, /A\.markTrialStep\(m\[2\]\)/);
  const re = /(^|\/)(event|builder)(\.html)?\/?$/;
  for (const p of ['/event.html', '/event', '/builder.html', '/builder/']) assert.ok(re.test(p), p);
  for (const p of ['/events.html', '/dashboard.html', '/quotes.html']) assert.ok(!re.test(p), p);
  assert.match(s, /var VISIT = \/\(\^\|\\\/\)\(event\|builder\)\(\\\.html\)\?\\\/\?\$\/;/);
});
t('dashboard chip: hides when complete, says "Trial steps" in the trial', () => {
  const s = read('public/shell-b-dash.js');
  assert.match(s, /gs\.getAttribute\("data-gs-complete"\) === "1"/);
  assert.match(s, /data-gs-mode"\) === "trial" \? "Trial steps " : "Setup "/);
});
t('onboarding: step numbers match "Step N of M"; typed teammate e-mail is invited; plain section name', () => {
  const s = read('public/onboarding.js');
  assert.match(s, /billingOk\(\) \? "✓" : "1"\}<\/span>Business details/);
  assert.match(s, /st\.done \? "✓" : Number\(i\) \+ 2\}/);
  assert.match(s, /if \(typed && !invites\.some\(\(x\) => x\.email === typed\)\) \{ await createInvite\(\); return; \}/);
  assert.match(s, /if \(!invites\.length\) \{ setVals\.team = \{\}; setErr\.team = \{\}; if \(!st\.done\) st\.skipped = true; go\(S\.step \+ 1\); return; \}/);
  // review: a resumed setup whose team step was already done (invites sent earlier) must not flip to "skipped"
  assert.doesNotMatch(s, /st\.done = false; st\.skipped = true; go\(S\.step \+ 1\)/);
  assert.doesNotMatch(s, /Control Center → Studio details/);
});

let fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('ok - ' + name); } catch (e) { fail++; console.log('not ok - ' + name + '\n  ' + (e && e.stack)); }
}
console.log(`checklist-trial-onboarding: ${tests.length - fail}/${tests.length} passed`);
if (fail) process.exit(1);
