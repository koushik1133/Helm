// 0207: free-trial terms in the onboarding - "Your 8-day free trial" + a required "I agree" tick.
//  * public/trial-facts.js is the ONE source of the trial facts (sign-up box, welcome step, one-time window, Terms)
//  * the numbers equal what a new trial really gets (tests/db/trial-terms-0207.sql checks the same literal on the DB)
//  * welcome: Step 1 of 3 = the terms; Continue disabled until ticked; accept_trial_terms records it (server-driven)
//  * trials that finished the welcome before: a one-time window (Esc cannot close it); teammates: a short notice
//  * every other studio page sends a trial owner who has not agreed back to the dashboard (trial-lock.js)
//  * 0207 SQL: ASCII, additive, APPLY = migration + VERIFY, MANIFEST + run-all wired
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const FX = read('public/trial-facts.js'), TD = read('public/trial-demo.js'), TS = read('public/trial-signup.js'), TL = read('public/trial-lock.js');
const API = read('public/store-api.js'), DASH = read('public/dashboard.html'), LOGIN = read('public/login.html'), TERMS = read('public/terms.html');
const CSS = read('public/trial-terms.css');
const MIG = read('supabase/migrations/0207_trial_terms_acceptance.sql'), APPLY = read('supabase/APPLY-0207.sql');
// 0211: the terms wording changed (quotes / events not capped) -> the current version lives in 0211
const M211 = read('supabase/migrations/0211_trial_quotes_uncapped.sql');
const DBT = read('tests/db/trial-terms-0207.sql'), M181 = read('supabase/migrations/0181_trial_guards.sql');
const F = require('../public/trial-facts.js');
const S = require('../public/trial-signup.js');
let n = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name); console.log(e && e.message); } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const code = (s) => s.replace(/--.*$/gm, '');

// ---- a small DOM (tree, classList, events) to run the real code ------------------------------------
function makeDoc() {
  const all = [];
  function node(tag) {
    const e = { tagName: String(tag).toUpperCase(), children: [], parentNode: null, attrs: {}, hidden: false, value: '', className: '', _text: '',
      disabled: false, checked: false, on: {},
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      get firstChild() { return this.children[0] || null; },
      get id() { return this.attrs.id || ''; }, set id(v) { this.attrs.id = v; },
      classList: null,
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
      remove() { if (this.parentNode) this.parentNode.removeChild(this); this.removed = true; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
      addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); },
      fire(k, ev) { (this.on[k] || []).forEach((f) => f(Object.assign({ preventDefault() { this.prevented = true; }, currentTarget: this }, ev || {}))); },
      focus() { doc.activeElement = this; }, showModal() { this.open = true; }, close() { this.open = false; },
      querySelector() { return null; }, querySelectorAll() { return []; } };
    const cls = new Set();
    e.classList = { add: (c) => { cls.add(c); e.className = [...cls].join(' '); }, remove: (c) => { cls.delete(c); e.className = [...cls].join(' '); },
      toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); e.className = [...cls].join(' '); }, contains: (c) => cls.has(c) || String(e.className).split(' ').includes(c) };
    all.push(e); return e;
  }
  const doc = { readyState: 'complete', all, activeElement: null, createElement: node, createElementNS: (ns, tag) => node(tag),
    createTextNode: (s) => { const x = node('#text'); x._text = String(s); return x; },
    querySelector: () => null, querySelectorAll: () => [], getElementById: (id) => all.find((x) => x.attrs.id === id && !x.removed) || null,
    addEventListener() {} };
  doc.body = node('body'); doc.documentElement = node('html');
  return doc;
}
const find = (root, pred) => { if (pred(root)) return root; for (const c of root.children || []) { const r = find(c, pred); if (r) return r; } return null; };
const findAll = (root, pred, out = []) => { if (pred(root)) out.push(root); for (const c of root.children || []) findAll(c, pred, out); return out; };
const byText = (root, re) => find(root, (x) => x.tagName === 'BUTTON' && re.test(x.textContent));

// ---- the shared facts ------------------------------------------------------------------------------------
await t('facts: the real numbers (verified on a trial clone; same literal as the DB suite)', () => {
  assert.equal(F.VERSION, 'trial-2026-10-19'); assert.equal(F.DAYS, 8); assert.equal(F.KEEP_DAYS, 60); assert.equal(F.TEAM_EXTRA, 2);
  assert.equal(F.CREATE_CAP, 2); assert.equal(F.EXTENSION_DAYS, 7); assert.deepEqual(F.DELETE_WARN_DAYS, [30, 7, 1]);
  assert.deepEqual(F.REGION, { currency: 'INR', symbol: '₹', timezone: 'Asia/Kolkata', tz: 'IST' });
  const m = DBT.match(/v_want jsonb := '(\{[^']+\})'::jsonb;/); assert.ok(m, 'SAMPLE-COUNTS literal in tests/db/trial-terms-0207.sql');
  const want = JSON.parse(m[1]), got = {}; F.SAMPLE.forEach((x) => { got[x.k] = x.n; });
  assert.deepEqual(got, want);
  assert.deepEqual(want, { leads: 16, events: 7, requirements: 41, inventory: 165, vendors: 16, staff: 12, venues: 4, menus: 6, dishes: 145, layouts: 3, coupons: 3 });
});
await t('facts: VERSION = the server version; the capped lists = the server cap list (0181 minus quotes, 0211)', () => {
  assert.match(M211, new RegExp("select '" + F.VERSION + "'::text;"), 'the latest _trial_terms_version() (0211)');
  assert.match(MIG, /select 'trial-2026-10-18'::text;/, '0207 itself is unchanged (forward-only)');
  const arr = M211.match(/foreach t in array array\[([^\]]+)\] loop\s*\n\s*v_used/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual(arr, ['leads', 'inventory_items', 'vendors', 'crew_members', 'venues']);
  assert.deepEqual(F.CAP_LISTS, ['leads / clients', 'inventory items', 'vendors', 'staff', 'venues'], 'one label per server list, same order');
  assert.deepEqual(F.UNCAPPED, ['events & quotes']);
  assert.match(M211, /drop trigger if exists zzzz_tl173_cap on public\.quotes;/); assert.match(M211, /drop trigger if exists zzzz_tl181_cap on public\.quotes;/);
});
await t('facts: the four sections say exactly what the owner asked for', () => {
  assert.deepEqual(F.SECTIONS.map((s) => s.id), ['included', 'can', 'locked', 'after']);
  const txt = (id) => { const s = F.SECTIONS.find((x) => x.id === id); return [s.lead, s.foot].concat((s.items || []).map((i) => i.t + ' ' + (i.s || ''))).join('\n'); };
  const inc = txt('included'), can = txt('can'), lock = txt('locked'), aft = txt('after');
  for (const re of [/Free for 8 days, no card needed/, /₹ INR/, /times in IST/, /“Demo ·”/, /“Sample”/]) assert.match(inc, re, String(re));
  for (const re of [/Create as many quotes and events as you like/, /Add up to 2 new records in each other list/, /Leads \(clients\), inventory items, vendors, staff and venues/,
    /deleting a record does not free a slot/, /Edit the sample data/, /Change menu prices/, /cannot be added, renamed or removed/,
    /Invite up to 2 teammates/, /Open invitations count/, /2D and 3D/, /3 layout templates/, /past event/, /Pricing & coupons, layout rules, and roles & access/]) assert.match(can, re, String(re));
  for (const re of [/Studio setup and branding/, /Imports/, /Data export and every download or print/, /Photo renders/, /Notification settings/,
    /client link auto-expire/, /templates and the activity log/, /Real messages to clients/, /OTP/, /WhatsApp/, /payment links run in test mode/]) assert.match(lock, re, String(re));
  for (const re of [/Read-only after 8 days/, /including invited teammates/, /Data kept 60 days, then permanently deleted/, /30, 7 and 1 day before/,
    /3 days before, 1 day before, on the last day, and 7 days after/, /Choose a plan anytime/, /keep the sample data, remove the sample data and keep your own records, or start completely clean/,
    /One free trial per person and e-mail address/, /one extension of up to 7 days/]) assert.match(aft, re, String(re));
  assert.equal(F.AGREE_LABEL, 'I have read and agree to the free-trial terms, the Terms of Service and the Privacy Policy');
  assert.deepEqual(F.LINKS.map((l) => l.href), ['/terms#trial', '/privacy']);
});
await t('one source: the sign-up box uses the same facts objects (numbers never drift)', () => {
  assert.equal(S.TRIAL_KEY, F.SIGNUP_KEY); assert.equal(S.TRIAL_ALL, F.SIGNUP_ALL); assert.equal(S.DAYS, F.DAYS); assert.equal(S.KEEP_DAYS, F.KEEP_DAYS);
  assert.match(TS, /require\("\.\/trial-facts\.js"\) : \(global && global\.HelmTrialFacts\)/);
  assert.ok(!/var TRIAL_KEY = \[|var TRIAL_ALL = \[/.test(TS), 'no second copy of the rules in trial-signup.js');
  assert.match(LOGIN, /<script src="\/trial-facts\.js\?v=\d+"><\/script>\n<script src="\/trial-signup\.js\?v=\d+"><\/script>/);
  for (const x of F.SAMPLE) assert.ok(F.SIGNUP_ALL.join(' ').includes(x.n + ' ' + x.many), 'sign-up lists ' + x.k);
});
await t('Terms of Service section 4 states the same facts', () => {
  const at = TERMS.indexOf('<section id="trial"'), sec = TERMS.slice(at, TERMS.indexOf('</section>', at));
  for (const x of F.SAMPLE) assert.ok(sec.includes(x.n + ' ' + x.many), 'terms.html: ' + x.n + ' ' + x.many);
  for (const re of [/8-day free trial/, /up to 2 teammates/, /Open invitations count/, /as many quotes and events as you like/, /up to 2 new records of each other kind/, /60 days/, /30, 7 and 1 day before deletion/,
    /3 days before the trial ends, 1 day before, on the last day and 7 days after/, /extension of up to 7 days/, /keep the sample data, remove the sample data and keep your own records, or start completely clean/,
    /tick “I agree”/, /Approval codes \(OTP\) and payment links run in test mode/, /client link auto-expire/]) assert.match(sec, re, String(re));
});

// ---- DOM of the terms --------------------------------------------------------------------------------------
await t('panel DOM: 4 labelled sections, 11 count tiles, links open in a new tab; tick box is a real labelled checkbox', () => {
  const doc = makeDoc();
  const p = F.panel(doc, 'x');
  const secs = findAll(p, (e) => e.tagName === 'SECTION');
  assert.equal(secs.length, 4); secs.forEach((s) => assert.ok(doc.getElementById(s.attrs['aria-labelledby']), 'heading id'));
  assert.equal(findAll(p, (e) => e.className === 'tw-tile').length, 11);
  const links = findAll(p, (e) => e.tagName === 'A');
  assert.deepEqual(links.map((a) => a.href), ['/terms#trial', '/privacy']); links.forEach((a) => { assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener'); });
  let seen = null; const ab = F.agreeBox(doc, 'ok1', (v) => { seen = v; });
  assert.equal(ab.input.type, 'checkbox'); assert.equal(ab.input.id, 'ok1');
  const lab = find(ab.box, (e) => e.tagName === 'LABEL'); assert.equal(lab.htmlFor, 'ok1'); assert.equal(lab.textContent, F.AGREE_LABEL + '.');
  ab.input.checked = true; ab.input.fire('change'); assert.equal(seen, true); assert.ok(ab.box.classList.contains('on'));
  const nt = F.notice(doc); assert.equal(findAll(nt, (e) => e.tagName === 'LI').length, F.NOTICE.length);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\.|eval\(|new Function/.test(FX), 'CSP-safe DOM');
});

// ---- which window -------------------------------------------------------------------------------------------
const ctx = {}; vm.runInNewContext(fnSrc(TD, 'termsPlan') + '\nglobalThis.plan = termsPlan;', ctx);
await t('termsPlan: welcome + terms / welcome / one-time window / teammate notice / nothing', () => {
  const T = { is_trial_org: true, is_admin: true, ended: false, locked: false };
  assert.equal(ctx.plan(T, { trial: true, must_agree: true }, true), 'welcome+terms');
  assert.equal(ctx.plan(T, null, true), 'welcome+terms', '0207 not installed / offline: still asked');
  assert.equal(ctx.plan(T, { trial: true, must_agree: false, accepted: true }, true), 'welcome', 'agreed on another device');
  assert.equal(ctx.plan(T, { trial: true, must_agree: true }, false), 'terms', 'finished the welcome before 0207');
  assert.equal(ctx.plan({ is_trial_org: true, is_admin: false }, { trial: true, notice: true }, false), 'notice');
  assert.equal(ctx.plan(T, { trial: true, must_agree: false, notice: false }, false), null);
  assert.equal(ctx.plan(T, null, false), null, 'unknown + no welcome: never blocks');
  assert.equal(ctx.plan({ is_trial_org: false, is_admin: true }, { trial: false }, false), null, 'paid');
  assert.equal(ctx.plan(Object.assign({}, T, { ended: true }), { trial: true, must_agree: true }, false), null, 'ended trial');
  assert.equal(ctx.plan(Object.assign({}, T, { locked: true }), { trial: true, notice: true }, false), null, 'read-only');
});

// ---- the real trial-demo.js on a dashboard --------------------------------------------------------------------
async function runDash({ server, terms, trial, acceptErr }) {
  const doc = makeDoc(), ls = new Map(), calls = [];
  const store = {
    init: async () => {},
    auth: { admin: { roles: () => ['manager', 'coordinator'], roleLabel: (r) => r } },
    trialOrg: {
      status: async () => trial,
      welcomePending: async () => server,
      welcomeDone: async () => { calls.push('welcomeDone'); },
      welcome: async (a, b, c) => { calls.push('welcome:' + a); },
      terms: async () => terms,
      acceptTerms: async (v) => { calls.push('accept:' + v); if (acceptErr) throw acceptErr; return { result: 'ok' }; },
    },
  };
  const win = { document: doc, BPStore: store, location: { pathname: '/dashboard', search: '', assign() {}, replace(u) { win.replaced = u; } },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) },
    alert() {}, confirm() { return false; }, navigator: { userAgent: 'test' } };
  const c = vm.createContext({ window: win, globalThis: win, setTimeout, clearTimeout, Promise, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(FX.replace('(typeof window !== "undefined" ? window : globalThis)', '(window)'), c);
  vm.runInContext(TD.replace('(typeof window !== "undefined" ? window : globalThis)', '(window)'), c);
  const on = await win.HelmTrialDemo.welcomeDecision();
  await new Promise((r) => setTimeout(r, 20));
  const dialogs = doc.all.filter((e) => e.tagName === 'DIALOG');
  return { on, doc, dialogs, calls, win, ls };
}
const owner = { is_trial_org: true, is_admin: true, name: 'Demo 7', trial_mode: 'demo', ended: false, locked: false, ends_at: '2026-10-26T10:00:00Z', timezone: 'Asia/Kolkata' };
await t('welcome step 1 "Your 8-day free trial": Continue disabled until ticked, agreement recorded, then "Name"', async () => {
  const r = await runDash({ server: true, terms: { trial: true, owner: true, must_agree: true }, trial: owner });
  assert.equal(r.on, true); assert.equal(r.dialogs.length, 1);
  const d = r.dialogs[0];
  assert.ok(d.open); assert.ok(d.classList.contains('tw-dlg'));
  assert.match(d.textContent, /Step 1 of 3/); assert.match(d.textContent, /Your 8-day free trial/);
  for (const re of [/What’s included/, /What you can do/, /Locked in the trial/, /After the trial/, /165inventory items/]) assert.match(d.textContent, re, String(re));
  const go = byText(d, /Agree and continue/); assert.ok(go); assert.equal(go.disabled, true, 'disabled before the tick');
  const cb = find(d, (e) => e.tagName === 'INPUT' && e.type === 'checkbox'); assert.ok(cb);
  assert.equal(r.doc.activeElement && r.doc.activeElement.className, 'tw-scroll', 'focus on the scrollable terms (keyboard can scroll)');
  cb.checked = true; cb.fire('change'); assert.equal(go.disabled, false, 'enabled once ticked');
  cb.checked = false; cb.fire('change'); assert.equal(go.disabled, true, 'unticked -> disabled again');
  cb.checked = true; cb.fire('change');
  await go.on.click[0]({ currentTarget: go });
  assert.deepEqual(r.calls, ['accept:trial-2026-10-19']);
  assert.match(d.textContent, /Step 2 of 3/); assert.match(d.textContent, /Name your trial studio/);
  assert.ok(!d.classList.contains('tw-dlg'), 'back to the small dialog'); assert.ok(!find(d, (e) => e.tagName === 'INPUT' && e.type === 'checkbox'), 'tick box gone');
  const ev = { prevented: false, preventDefault() { this.prevented = true; } }; d.on.cancel[0](ev); assert.equal(ev.prevented, true, 'Esc never closes the welcome');
});
await t('welcome: saving the agreement fails -> stays on the terms with an error, nothing skipped', async () => {
  const r = await runDash({ server: true, terms: { trial: true, owner: true, must_agree: true }, trial: owner, acceptErr: new Error('offline') });
  const d = r.dialogs[0], cb = find(d, (e) => e.tagName === 'INPUT' && e.type === 'checkbox'), go = byText(d, /Agree and continue/);
  cb.checked = true; cb.fire('change'); await go.on.click[0]({ currentTarget: go });
  assert.match(d.textContent, /Your 8-day free trial/); assert.ok(!/Name your trial studio/.test(d.textContent));
  const err = find(d, (e) => e.className === 'td-err'); assert.equal(err.hidden, false); assert.match(err.textContent, /offline/);
});
await t('welcome: already agreed (another device) -> the 2-step welcome starts at "Name"', async () => {
  const r = await runDash({ server: true, terms: { trial: true, owner: true, must_agree: false, accepted: true }, trial: owner });
  const d = r.dialogs[0];
  assert.match(d.textContent, /Step 1 of 2/); assert.match(d.textContent, /Name your trial studio/); assert.ok(!/Your 8-day free trial/.test(d.textContent));
});
await t('trial that finished the welcome before: one-time window, Esc cannot close it, the tour waits for it', async () => {
  const r = await runDash({ server: false, terms: { trial: true, owner: true, must_agree: true }, trial: owner });
  assert.equal(r.on, false, 'no welcome'); assert.equal(r.dialogs.length, 1);
  const d = r.dialogs[0]; assert.match(d.textContent, /Free-trial terms/); assert.match(d.textContent, /Your 8-day free trial/); assert.match(d.textContent, /only need to do this once/);
  let gateDone = false; r.win.HelmTrialDemo.termsGate().then(() => { gateDone = true; });
  await new Promise((x) => setTimeout(x, 10)); assert.equal(gateDone, false, 'tour held while the window is open');
  const ev = { prevented: false, preventDefault() { this.prevented = true; } }; d.on.cancel[0](ev); assert.equal(ev.prevented, true);
  d.open = false; d.on.close.forEach((f) => f({})); assert.equal(d.open, true, 'closed by the browser anyway (no click yet): opens again');
  const go = byText(d, /Agree and continue/), cb = find(d, (e) => e.tagName === 'INPUT' && e.type === 'checkbox');
  assert.equal(go.disabled, true); cb.checked = true; cb.fire('change');
  await go.on.click[0]({ currentTarget: go }); await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(r.calls, ['accept:trial-2026-10-19']); assert.ok(d.removed, 'closed after agreeing'); assert.equal(gateDone, true, 'tour may run now');
  assert.equal(d.attrs['data-done'], '1', 'finished: not opened again');
});
await t('invited teammate: a short read-only notice with "Got it" (no tick, no agreement)', async () => {
  const r = await runDash({ server: null, terms: { trial: true, owner: false, notice: true }, trial: Object.assign({}, owner, { is_admin: false }) });
  assert.equal(r.dialogs.length, 1); const d = r.dialogs[0];
  assert.match(d.textContent, /You’re in a free-trial studio/); assert.match(d.textContent, /“Demo 7” is trying Helm until 26 October 2026/);
  assert.ok(!find(d, (e) => e.tagName === 'INPUT' && e.type === 'checkbox'), 'nothing to agree to');
  const b = byText(d, /Got it/); await b.on.click[0]({ currentTarget: b }); await new Promise((x) => setTimeout(x, 5));
  assert.deepEqual(r.calls, ['accept:trial-2026-10-19'], 'seen once (server)'); assert.ok(d.removed);
});
await t('paid studio / agreed / ended trial: no window at all, the tour is not held', async () => {
  for (const [tr, terms] of [[{ is_trial_org: false, is_admin: true }, { trial: false }], [owner, { trial: true, owner: true, must_agree: false, accepted: true }],
                             [Object.assign({}, owner, { ended: true, locked: true }), { trial: false }]]) {
    const r = await runDash({ server: false, terms, trial: tr });
    assert.equal(r.dialogs.length, 0); let ok = false; await r.win.HelmTrialDemo.termsGate().then(() => { ok = true; }); assert.equal(ok, true);
  }
});

// ---- wiring --------------------------------------------------------------------------------------------------
await t('dashboard: facts + styles loaded; the tour waits for the terms window', () => {
  assert.match(DASH, /<script src="trial-facts\.js\?v=\d+"><\/script>\n<script src="trial-demo\.js\?v=\d+"><\/script>/);
  assert.match(DASH, /<link rel="stylesheet" href="trial-terms\.css\?v=\d+">/);
  assert.match(DASH, /if\(HelmTrialDemo\.termsGate\)\{ try\{ await HelmTrialDemo\.termsGate\(\); \}catch\{\} \}/);
  assert.ok(DASH.indexOf('termsGate()') < DASH.indexOf('localStorage.removeItem("bp_force_tour")'));
});
await t('store-api: terms() / acceptTerms() (null when 0207 is missing) + status is a read-only RPC', () => {
  assert.match(API, /terms: \(\) => \(supa \? rpc\("my_trial_terms_status", \{\}\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\)/);
  assert.match(API, /acceptTerms: \(version\) => \(supa \? rpc\("accept_trial_terms", \{ p_version: String\(version \|\| ""\),/);
  assert.match(API, /\|my_trial_welcome_pending\|my_trial_terms_status\|/);
});
await t('trial-lock.js: other studio pages send an owner who has not agreed to the dashboard', () => {
  const g = fnSrc(TL, 'termsGuard');
  assert.match(g, /if \(TERMS_HOME\.test\(path\) \|\| BLOCKED_PAGES\.test\(path\)\) return;/);
  assert.match(g, /de\.hasAttribute\("data-shell"\)/); assert.match(g, /builder/);
  assert.match(g, /if \(!r \|\| r\.must_agree !== true\) return;/); assert.match(g, /location\.replace\(dashHome\(\)\)/);
  assert.match(fnSrc(TL, 'apply'), /termsGuard\(\);/);
});
await t('styles: theme tokens, scrolling terms with a fixed footer, phone layout', () => {
  assert.match(CSS, /\.td-dlg\.tw-dlg\[open\]\{display:flex;flex-direction:column;/);
  assert.match(CSS, /\.tw-scroll\{flex:1 1 auto;min-height:0;overflow:auto;/);
  assert.match(CSS, /\.tw-agree input\{[^}]*accent-color:var\(--accent\)/);
  assert.match(CSS, /@media\(max-width:560px\)\{/);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(CSS.slice(CSS.indexOf('0207'))), 'no hard-coded colours in the 0207 styles');
});

// ---- 0207 SQL --------------------------------------------------------------------------------------------------
await t('0207 SQL: ASCII, additive, definer functions, consent record kept', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY), 'ASCII only');
  assert.ok(!/\b(drop\s+(table|column|function|policy|trigger)|truncate|delete\s+from|update\s+public\.)/i.test(code(MIG)), 'nothing dropped / deleted / updated');
  assert.match(MIG, /create table if not exists public\.trial_terms_acceptances \(/);
  assert.match(MIG, /primary key \(org_id, user_id, version\)/);
  assert.match(MIG, /on conflict \(org_id, user_id, version\) do nothing;/);
  assert.match(MIG, /'''trial_grants'', ''trial_extensions'', ''trial_terms_acceptances'''/);
  assert.match(MIG, /hint = 'trial_terms_version'/);
});
await t('APPLY-0207 = migration verbatim inside begin/commit + VERIFY; MANIFEST + run-all wired', () => {
  assert.ok(APPLY.includes(MIG), 'migration verbatim'); assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.indexOf('commit;') < APPLY.indexOf('-- VERIFY'), 'VERIFY after commit');
  assert.ok(!/create temp|temporary table/i.test(APPLY), 'no temp tables in an editor paste');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0207_trial_terms_acceptance\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-terms-0207" "TRIAL-TERMS-0207: ALL PASS \\\(39\/39\\\)" psql -q -f tests\/db\/trial-terms-0207\.sql/);
});

if (fail) { console.log('trial-terms-agree: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-terms-agree: ' + n + ' passed');
