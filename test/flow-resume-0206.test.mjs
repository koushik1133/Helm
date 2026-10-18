// 0206 "Continue where you left off" stays until the quote is finished (owner, Oct 2026).
// flow-resume.js v3: server rows -> label / link / "3 of 8"; mount waits for BPStore.init() before it
// decides who the user is; the step save is debounced and only fires on a change; the browser copy keeps
// one entry per quote; Dismiss; re-mount on Back / Forward; dashboard block, Quotes "In progress (N)" tab,
// workspace banner, New quote prompt (trial cap aware); store helpers; SQL 0206 pins.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(10); } await flush(); return true; };

/* ---------- tiny DOM ---------- */
class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ''; this.hidden = false; this.cls = new Set(); this.style = {}; this.id = ''; this.href = ''; this.type = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); if (k === 'id') this.id = String(v); if (k === 'href') this.href = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.cls].join(' '); }
  get classList() { const s = this.cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ? s.add(c) : s.delete(c)) }; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  set textContent(v) { this.childNodes = []; this._t = String(v); } get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  fire(type, extra) { const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, extra || {}); (this.ls[type] || []).forEach((f) => f(e)); return e; }
  click() { this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => [c, ...c.all()]); }
  querySelector(sel) { const c = sel.replace(/^\./, ''); return this.all().find((x) => x.cls.has(c)) || null; }
}
function makeWin(path) {
  const doc = { readyState: 'complete', ls: {}, createElement: (tg) => new El(tg, doc), addEventListener(ev, fn) { (doc.ls[ev] = doc.ls[ev] || []).push(fn); }, removeEventListener(ev, fn) { doc.ls[ev] = (doc.ls[ev] || []).filter((f) => f !== fn); } };
  doc.body = new El('body', doc); doc.documentElement = doc.body;
  doc.getElementById = (id) => [doc.body, ...doc.body.all()].find((x) => x.id === id) || null;
  doc.querySelector = (s) => doc.body.querySelector(s);
  const ls = {}, store = {};
  const win = { document: doc, URLSearchParams, Date, Math, JSON, Promise, Object, Array, Number, String, setTimeout, clearTimeout, isFinite, encodeURIComponent,
    location: { pathname: path || '/dashboard.html', search: '' }, ls,
    addEventListener(ev, fn) { (ls[ev] = ls[ev] || []).push(fn); },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { getRandomValues: (a) => a }, adopted: [] };
  win.__helmAdoptCss = (_d, css) => win.adopted.push(css);
  win.globalThis = win; win.window = win;
  return { win, doc, store };
}
const FR_SRC = read('public/flow-resume.js'), NQ_SRC = read('public/new-quote-dialog.js');
function load(env, src) { vm.runInContext(src, vm.createContext(env.win)); }
const R = require('../public/flow-resume.js');
const Q1 = 'a0000000-0000-4000-8000-0000000000c1', Q2 = 'a0000000-0000-4000-8000-0000000000c2';
const row = (o) => Object.assign({ id: Q1, code: 'WED-01', title: 'WED_HYD_300', event_type: 'Wedding', client: { name: 'Asha' }, my_step: 'venue', my_step_at: new Date(Date.now() - 2 * 3600e3).toISOString(),
  last_step: 'venue', last_step_at: new Date(Date.now() - 2 * 3600e3).toISOString(), last_by_me: true, last_user_name: 'Koushik', steps_done: ['client', 'discovery', 'reqs'], steps_total: 8 }, o || {});
/* a store whose auth only turns on after init() (the v2 race: mode starts "local") */
function fakeStore(o) {
  o = o || {}; let mode = 'local'; const calls = { list: [], mark: [], dismiss: [] };
  const S = { calls, mode: () => mode,
    init: () => (S._ready = S._ready || new Promise((r) => setTimeout(() => { mode = 'supabase'; r(); }, o.initMs || 30))),
    auth: { enabled: () => mode === 'supabase', user: () => (mode === 'supabase' ? { id: 'u-real' } : null) },
    quotes: { get: async () => ({ status: 'quote' }) },
    flowProgress: { available: () => mode === 'supabase' && o.server !== false,
      list: async (a) => { calls.list.push(a); return o.list ? o.list(a) : { total: 3, rows: [row(), row({ id: Q2, title: 'BDAY_PUNE_50' })], can_edit: true }; },
      mark: async (q, s) => { calls.mark.push([q, s]); return o.mark ? o.mark(q, s) : { ok: true, step: s }; },
      dismiss: async (q) => { calls.dismiss.push(q); return { ok: true }; } } };
  return S;
}

await t('server rows -> label, link, "3 of 8", last worked by', () => {
  const v = R.fromServer(row(), true), now = Date.now();
  assert.equal(R.label(v, now), 'WED_HYD_300 · step 4 of 8 · Venue · edited 2 h ago');
  assert.equal(R.href(v), 'flow.html?quote=' + Q1 + '#sec-venue');
  assert.equal(R.progressText(v), '3 of 8');
  assert.equal(R.lastBy(v, now), '', 'nothing when I was last');
  const t2 = R.fromServer(row({ my_step: null, last_step: 'menu', last_by_me: false, last_user_name: 'Priya', last_step_at: new Date(now - 10 * 60e3).toISOString() }), false);
  assert.equal(t2.step, 'menu'); assert.equal(R.lastBy(t2, now), 'Last worked on by Priya, 10 min ago');
  const fresh = R.fromServer(row({ my_step: null, last_step: null, steps_done: ['client', 'discovery'] }), true);
  assert.equal(fresh.step, 'reqs', 'never opened in the flow: the first step not done');
  assert.equal(R.fromServer(row({ my_step: 'gone', last_step: null, steps_done: [] }), true).step, 'client', 'a step no longer in the flow falls back');
  assert.equal(R.stepText(R.fromServer(row({ my_step: 'pay' }), true)), 'step 9 · Advance payment');
  assert.equal(R.firstNotDone(['client', 'discovery', 'reqs', 'venue', 'menu', 'proposal', 'layout', 'quote']), 'quote');
  assert.equal(R.ago(Date.now() - 30e3), 'just now'); assert.equal(R.ago(Date.now() - 864e5), 'yesterday');
});

await t('mount waits for BPStore.init() before reading who the user is (v2 read "anon" too early)', async () => {
  const env = makeWin('/quotes.html'); const S = fakeStore({ initMs: 400 }); env.win.BPStore = S;
  env.doc.body.appendChild(Object.assign(new El('main', env.doc), { id: 'main' }));
  load(env, FR_SRC);
  assert.equal(S.auth.enabled(), false, 'before init the store still says local');
  env.win.HelmFlowResume.mount(); await sleep(30);
  assert.equal(S.calls.list.length, 0, 'no read before init finished');
  await until(() => S.calls.list.length > 0 && env.doc.getElementById('flowResume'));
  assert.equal(S.calls.list.length, 1, 'read once init is done');
  assert.deepEqual(JSON.parse(JSON.stringify(S.calls.list[0])), { scope: 'mine', limit: 1, maxDays: 60 }, 'dashboard card: mine, 60-day window (owner E)');
  const box = env.doc.getElementById('flowResume'); assert.ok(box, 'card mounted above the page content');
  assert.match(box.textContent, /Continue where you left off/); assert.match(box.textContent, /WED_HYD_300 · step 4 of 8 · Venue · edited 2 h ago/);
  assert.match(box.textContent, /2 more in progress →/);
  const more = box.all().find((x) => x.cls.has('fr-more')); assert.equal(more.href, 'quotes.html?view=inprogress');
  const go = box.all().find((x) => x.tagName === 'A' && x.textContent === 'Continue'); assert.equal(go.href, 'flow.html?quote=' + Q1 + '#sec-venue');
});

await t('dashboard: fills the #hdResume block (never lands below the whole dashboard); Dismiss hides it for me', async () => {
  const env = makeWin('/dashboard.html'); const S = fakeStore({ list: () => ({ total: 1, rows: [row()], can_edit: true }) }); env.win.BPStore = S;
  const block = new El('section', env.doc); block.id = 'hdResume'; block.hidden = true; block.setAttribute('data-block', 'resume');
  const body = new El('div', env.doc); body.className = 'hd-body'; body.appendChild(new El('div', env.doc)); block.appendChild(body); env.doc.body.appendChild(block);
  load(env, FR_SRC); env.win.HelmFlowResume.mount(); await until(() => !block.hidden);
  assert.equal(block.hidden, false, 'shown'); assert.equal(env.doc.getElementById('flowResume'), null, 'no second card at the top of #main');
  const x = block.all().find((n) => n.tagName === 'BUTTON' && n.textContent === 'Dismiss'); assert.ok(x);
  assert.ok(block.all().some((n) => n.tagName === 'A' && n.cls.has('hd-primary')), 'dashboard button style');
  S.flowProgress.list = async () => ({ total: 0, rows: [], can_edit: true });
  x.click(); await until(() => S.calls.dismiss.length > 0);
  assert.deepEqual(S.calls.dismiss, [Q1]); assert.equal(block.hidden, true, 'hidden after Dismiss');
});

await t('editing blocked (view-only / ended trial): Open instead of Continue; offline: nothing, no error', async () => {
  const env = makeWin('/quotes.html'); env.win.BPStore = fakeStore({ list: () => ({ total: 1, rows: [row()], can_edit: false, read_only: true }) });
  env.doc.body.appendChild(Object.assign(new El('main', env.doc), { id: 'main' }));
  load(env, FR_SRC); env.win.HelmFlowResume.mount(); await until(() => env.doc.getElementById('flowResume'));
  const box = env.doc.getElementById('flowResume');
  assert.ok(!box.all().some((n) => n.textContent === 'Continue' && n.tagName === 'A')); assert.ok(box.all().some((n) => n.textContent === 'Open'));
  const env2 = makeWin('/quotes.html'); env2.win.BPStore = fakeStore({ list: () => { throw new Error('offline'); } });
  env2.doc.body.appendChild(Object.assign(new El('main', env2.doc), { id: 'main' }));
  load(env2, FR_SRC); env2.win.HelmFlowResume.mount(); await until(() => env2.win.BPStore.mode() === 'supabase'); await sleep(50); await flush();
  assert.equal(env2.doc.getElementById('flowResume'), null);
});

await t('step save: once on open, then debounced and only on a change', async () => {
  const S = fakeStore(); await S.init();
  const tr = R.track({ quoteId: Q1, uid: 'u-real', canEdit: true, store: S, delay: 250, name: () => 'X' });
  await tr.land('client'); assert.deepEqual(S.calls.mark, [[Q1, 'client']]);
  tr.step('client'); await sleep(300); assert.equal(S.calls.mark.length, 1, 'same step: no save');
  tr.step('discovery'); tr.step('reqs'); tr.step('venue'); await sleep(20); assert.equal(S.calls.mark.length, 1, 'still debouncing');
  await until(() => S.calls.mark.length > 1); await sleep(300); assert.deepEqual(S.calls.mark[1], [Q1, 'venue'], 'one save for the burst, the last step');
  assert.equal(S.calls.mark.length, 2);
  tr.step('menu'); await tr.flush(); assert.deepEqual(S.calls.mark[2], [Q1, 'menu'], 'leaving the page sends the pending step');
  assert.equal(tr.step('bogus'), false);
  const ro = R.track({ quoteId: Q1, uid: 'u', canEdit: false, store: S, delay: 1 }); assert.equal(ro.step('venue'), false, 'view-only: never saves');
  const S2 = fakeStore({ mark: () => ({ ok: false, read_only: true }) }); await S2.init();
  const tr2 = R.track({ quoteId: Q1, uid: 'u', canEdit: true, store: S2, delay: 1 }); await tr2.land('client');
  assert.equal(tr2.step('venue'), false, 'read-only studio: stops trying');
});

await t('no 0206 / local mode: the browser copy keeps ONE ENTRY PER QUOTE; other quotes are untouched', async () => {
  const store = {}; globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const S = fakeStore({ mark: () => ({ ok: false, missing: true }) }); await S.init();
  const a = R.track({ quoteId: Q1, uid: 'u1', canEdit: true, store: S, delay: 1, name: () => 'Quote one' });
  const b = R.track({ quoteId: Q2, uid: 'u1', canEdit: true, store: S, delay: 1, name: () => 'Quote two' });
  await a.land('venue'); await b.land('menu');
  assert.equal(R.lastStep('u1', Q1), 'venue', 'opening quote two did not replace quote one'); assert.equal(R.lastStep('u1', Q2), 'menu');
  assert.equal(R.readAll('u1').length, 2);
  // legacy v2 single slot is carried over, never lost
  store['helm_flow_resume_u9'] = JSON.stringify({ quoteId: Q2, name: 'Old', step: 'layout', at: Date.now() });
  assert.equal(R.lastStep('u9', Q2), 'layout');
  R.dismissLocal('u1', Q1); assert.equal(R.read('u1', Q1).dismissed, true);
  await a.land('quote'); assert.equal(R.read('u1', Q1).dismissed, false, 'working on it again brings it back');
});

await t('local fallback list drops a finished quote for THAT quote only; dismissed ones are hidden', async () => {
  const store = {}; globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  R.record('u1', { quoteId: Q1, name: 'One', step: 'venue' }); R.record('u1', { quoteId: Q2, name: 'Two', step: 'menu' });
  const S = { flowProgress: { available: () => false }, quotes: { get: async (id) => (id === Q1 ? { status: 'confirmed' } : { status: 'quote', title: 'Two' }) } };
  const d = await R.load(S, 'u1', { scope: 'mine' });
  assert.equal(d.source, 'local'); assert.deepEqual(d.rows.map((v) => v.quoteId), [Q2]);
  assert.equal(R.read('u1', Q1), null, 'the confirmed quote left'); assert.equal(R.lastStep('u1', Q2), 'menu', 'the other one stayed');
  R.dismissLocal('u1', Q2); assert.equal((await R.load(S, 'u1', { scope: 'mine' })).rows.length, 0);
  assert.equal((await R.load(S, 'u1', { scope: 'studio' })).source, 'none', 'no studio-wide list without the server');
});

await t('resumeStep: my step first, else where a teammate stopped; a slow server never blocks the flow', async () => {
  const S = fakeStore({ list: () => ({ total: 1, rows: [row({ my_step: 'menu' })] }) }); await S.init();
  const r1 = await R.resumeStep(S, 'u-real', Q1); assert.equal(r1.step, 'menu'); assert.equal(r1.mine, true); assert.equal(r1.who, ''); assert.ok(r1.at);
  assert.deepEqual(JSON.parse(JSON.stringify(S.calls.list[0])), { scope: 'studio', quote: Q1, limit: 1 });
  const S2 = fakeStore({ list: () => ({ total: 1, rows: [row({ my_step: null, last_step: 'proposal', last_user_name: 'Priya', last_by_me: false })] }) }); await S2.init();
  const r2 = await R.resumeStep(S2, 'u-real', Q1); assert.equal(r2.step, 'proposal'); assert.equal(r2.mine, false); assert.equal(r2.who, 'Priya');
  const S3 = fakeStore({ list: () => new Promise(() => {}) }); await S3.init();
  const t0 = Date.now(); assert.equal(await R.resumeStep(S3, 'u-real', Q1, 50), null); assert.ok(Date.now() - t0 < 500);
  const S4 = fakeStore({ list: () => ({ total: 0, rows: [] }) }); await S4.init();
  assert.equal(await R.resumeStep(S4, 'u-real', Q1), null, 'finished quote: no jump');
});

await t('Back / Forward (bfcache) re-mounts the card', async () => {
  const env = makeWin('/quotes.html'); const S = fakeStore(); env.win.BPStore = S;
  env.doc.body.appendChild(Object.assign(new El('main', env.doc), { id: 'main' }));
  env.doc.currentScript = { hasAttribute: (k) => k === 'data-mount' };
  load(env, FR_SRC); await until(() => env.doc.getElementById('flowResume'));
  assert.equal(S.calls.list.length, 1);
  (env.win.ls.pageshow || []).forEach((f) => f({ persisted: false })); await sleep(30); assert.equal(S.calls.list.length, 1, 'normal load: no second read');
  S.flowProgress.list = async (a) => { S.calls.list.push(a); return { total: 0, rows: [], can_edit: true }; };
  (env.win.ls.pageshow || []).forEach((f) => f({ persisted: true })); await until(() => S.calls.list.length > 1 && !env.doc.getElementById('flowResume'));
  assert.equal(S.calls.list.length, 2, 're-read on restore'); assert.equal(env.doc.getElementById('flowResume'), null, 'finished meanwhile: card gone');
});

await t('In progress list rows: name, client, bar "3 of 8", Stopped at, last worked by, Continue (phones: cards)', () => {
  const env = makeWin('/quotes.html'); load(env, FR_SRC); const H = env.win.HelmFlowResume;
  const host = new El('div', env.doc); env.doc.body.appendChild(host);
  const rows = [H.fromServer(row({ last_by_me: false, last_user_name: 'Priya' }), false), H.fromServer(row({ id: Q2, last_step: null, my_step: null, steps_done: [] }), false)];
  assert.equal(H.renderList(host, { rows, total: 2, canEdit: true }), 2);
  const txt = host.textContent;
  assert.match(txt, /WED_HYD_300/); assert.match(txt, /Asha/); assert.match(txt, /3 of 8 steps done/); assert.match(txt, /Stopped at: Venue/); assert.match(txt, /Last worked by Priya · 2 h ago/);
  assert.match(txt, /Not opened in the flow yet/);
  const bar = host.all().find((x) => x.cls.has('fr-bar')); assert.ok(bar.cls.has('fr-w3')); assert.equal(bar.getAttribute('aria-label'), '3 of 8 steps done');
  assert.ok(host.all().some((x) => x.tagName === 'A' && x.textContent === 'Continue' && x.href === 'flow.html?quote=' + Q1 + '#sec-venue'));
  assert.ok(env.win.adopted.join('').includes('@media (max-width:760px){.fr-row{grid-template-columns:1fr}'), 'phones: one column cards');
  H.renderList(host, { rows: [], total: 0 }); assert.match(host.textContent, /No quotes in progress/);
});

await t('workspace banner + flow notice', () => {
  const env = makeWin('/event.html'); load(env, FR_SRC); const H = env.win.HelmFlowResume;
  const app = new El('div', env.doc), head = new El('div', env.doc); head.id = 'evHead'; app.appendChild(new El('div', env.doc)); app.appendChild(head); env.doc.body.appendChild(app);
  const v = H.fromServer(row({ my_step: null, last_step: 'venue', last_by_me: false, last_user_name: 'Priya', last_step_at: new Date(Date.now() - 600e3).toISOString() }), true);
  const b = H.renderBanner(app, v, { canEdit: true, before: head });
  assert.equal(app.childNodes.indexOf(b), app.childNodes.indexOf(head) - 1, 'right above the event header');
  assert.match(b.textContent, /This quote is at step 4 of 8 \(Venue\)\. 3 of 8 steps done\./); assert.match(b.textContent, /Last worked on by Priya, 10 min ago/);
  assert.ok(b.all().some((x) => x.textContent === 'Continue where you left off'));
  H.renderBanner(app, null); assert.equal(env.doc.getElementById('flowResumeBanner'), null, 'finished: banner removed');
  const sec = new El('section', env.doc); let top = 0; const n = H.renderNotice(sec, { step: 'venue', mine: true }, () => { top++; });
  assert.match(n.textContent, /You stopped at Venue·Go to top/); n.all().find((x) => x.tagName === 'BUTTON').click(); assert.equal(top, 1);
});

await t('New quote with quotes in progress: "You have 3 quotes in progress" - Continue / Start a new one; trial at its cap: Continue only', async () => {
  for (const [lim, canNew] of [[{ trial: false }, true], [{ trial: true, cap: 2, used: { quotes: 2 } }, false]]) {
    const env = makeWin('/dashboard.html'); load(env, FR_SRC); load(env, NQ_SRC);
    const S = fakeStore(); await S.init(); S.subscription = { limits: async () => lim }; env.win.BPStore = S;
    const p = env.win.HelmNewQuote.ask({}); await flush();
    assert.equal(await env.win.HelmNewQuote.ask({}), null, 'double click: one dialog');
    const ov = env.doc.body.childNodes.find((n) => n.cls.has('bpui-overlay')); assert.ok(ov);
    assert.match(ov.textContent, /You have 3 quotes in progress/);
    const links = ov.all().filter((x) => x.tagName === 'A'); assert.equal(links.length, 2);
    assert.match(links[0].textContent, /^Continue WED_HYD_300 \(step 4 of 8 · Venue\)$/); assert.equal(links[0].href, 'flow.html?quote=' + Q1 + '#sec-venue');
    const startNew = ov.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Start a new one');
    assert.equal(!!startNew, canNew);
    if (canNew) {
      ov.all().find((x) => x.tagName === 'FORM').fire('submit'); await flush();
      const ov2 = env.doc.body.childNodes.find((n) => n.cls.has('bpui-overlay')); assert.ok(ov2 && ov2.all().some((x) => x.textContent === 'Create quote'), 'then the normal create dialog');
      ov2.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click();
    } else {
      assert.match(ov.textContent, /free trial has used its new quotes/);
      ov.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click();
    }
    assert.equal(await p, null);
  }
  // nothing in progress -> straight to the create dialog
  const env = makeWin('/dashboard.html'); load(env, FR_SRC); load(env, NQ_SRC);
  const S = fakeStore({ list: () => ({ total: 0, rows: [] }) }); await S.init(); env.win.BPStore = S;
  const p = env.win.HelmNewQuote.ask({}); await flush();
  const ov = env.doc.body.childNodes.find((n) => n.cls.has('bpui-overlay')); assert.ok(ov.all().some((x) => x.textContent === 'Create quote'));
  ov.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click(); assert.equal(await p, null);
});

await t('pages: Quotes "In progress (N)" tab, dashboard block, workspace banner, flow hooks, store helpers, pins', () => {
  const q = read('public/quotes.html'), d = read('public/shell-b-dash.js'), e = read('public/event.html'), f = read('public/flow.html'), s = read('public/store-api.js');
  assert.match(q, /<button type="button" data-f="inprogress" aria-pressed="false" id="tab_inprogress" hidden[^>]*>In progress<span class="tcount" id="cnt_inprogress"><\/span><\/button>/);
  assert.match(q, /<div id="ipWrap" class="ip-wrap" hidden aria-live="polite"><\/div>/);
  assert.match(q, /if\(view==="inprogress"\)\{ if\(!offset\) await renderInProgress\(\); return \{ rows:\[\], hasMore:false, offset:0 \}; \}/);
  assert.match(q, /HelmFlowResume\.load\(BPStore, ipUid\(\), \{ scope:"studio", limit:100 \}\)/);
  assert.match(q, /get\("view"\)==="inprogress"/);
  assert.match(q, /loadInProgressCount\(\);/);
  assert.match(d, /var cResume = card\("hdResume", "Continue where you left off", IC\.doc, \{ skel: 1, span: "hd-s-full", block: "resume" \}\); cResume\.hidden = true;/);
  assert.match(d, /\[cResume, cShift, cCal,/); assert.match(d, /resume: "Continue where you left off"/);
  assert.match(e, /<script src="flow-resume\.js\?v=\d+"><\/script>/);
  assert.match(e, /BPStore\.flowProgress\.list\(\{ scope:"studio", quote:ev\.id\|\|id, limit:1 \}\)/);
  assert.match(e, /HelmFlowResume\.renderBanner\(host, r\?HelmFlowResume\.fromServer\(r,true\):null, \{ canEdit:canEdit && !!d && d\.can_edit!==false, before:\$\("#evHead"\) \}\)/);
  assert.match(f, /flowTrack\.land\(st\)/); assert.match(f, /window\.addEventListener\("pagehide",\(\)=>\{ if\(flowTrack\) flowTrack\.flush\(\)/);
  assert.match(f, /window\.addEventListener\("hashchange"/); assert.doesNotMatch(f, /HelmFlowResume\.record\(/, 'the flow no longer writes the old single slot');
  assert.match(s, /const flowProgress = \{/); assert.match(s, /rpc\("mark_flow_step", \{ p_quote: String\(quoteId\), p_step: step \}\)/);
  assert.match(s, /rpc\("mark_flow_resume_dismissed", \{ p_quote: String\(quoteId\) \}\)/); assert.match(s, /rpc\("my_unfinished_quotes", args\)/);
  assert.match(s, /auth, quotes, flowProgress, recents,/);
  assert.match(s, /\|privacy_pin_status\|my_unfinished_quotes\)\(\\\?\|\$\)\/;/, 'the list is a read (does not drop shared reads)');
  // mark_ keeps the cached reads (SWR_KEEP_RPCS): frequent step saves don't throw the cache away
  assert.match(s, /const SWR_KEEP_RPCS = [^\n]*\|mark_\|/);
  assert.match(FR_SRC, /root\.addEventListener\("pageshow", function \(e\) \{ if \(e && e\.persisted\) mount\(\); \}\);/);
});

await t('SQL 0206: table + 3 functions, never touches quotes, 0141 ignore list, trial retention, MANIFEST, run-all, APPLY', () => {
  const m = read('supabase/migrations/0206_flow_progress.sql'), a = read('supabase/APPLY-0206.sql');
  assert.ok(!/[^\x00-\x7f]/.test(m), 'ASCII only'); assert.ok(!/[^\x00-\x7f]/.test(a), 'APPLY ASCII only');
  assert.match(m, /create table if not exists public\.quote_flow_progress \(/);
  for (const fn of ['mark_flow_step(p_quote uuid, p_step text)', 'mark_flow_resume_dismissed(p_quote uuid)', 'my_unfinished_quotes(p_scope text default \'mine\'']) assert.ok(m.includes('create or replace function public.' + fn), fn);
  const code = m.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /update public\.quotes|delete from|truncate|drop table|drop column|drop policy|drop function/i, 'additive: never changes quotes / deletes');
  assert.match(m, /and c\.table_name not in \('quotes', 'quote_versions', 'audit_log', 'quote_flow_progress'\)/);
  assert.match(m, /and cl\.relname not in \('quotes', 'quote_versions', 'audit_log', 'quote_flow_progress'\)/);
  assert.match(m, /not exists \(select 1 from public\.quotation_versions qv where qv\.quote_id = q\.id\)/, 'owner A: finished = a saved quotation version');
  assert.match(m, /and not coalesce\(q\.is_demo, false\)/, 'owner D: no trial sample quotes');
  assert.match(m, /execute replace\(v_def, '''quotes''', '''quote_flow_progress'', ''quotes'''\);/);
  assert.match(a, /^-- APPLY-0206\.sql/); assert.match(a, /\nbegin;\n/); assert.match(a, /notify pgrst, 'reload schema';\ncommit;/); assert.match(a, /-- VERIFY/);
  assert.ok(a.includes(m), 'APPLY carries the migration verbatim');
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0206_flow_progress\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "flow-progress-0206" "FLOW-PROGRESS-0206: ALL PASS \\\(46\/46\\\)" psql -q -f tests\/db\/flow-progress-0206\.sql/);
  assert.match(read('tests/db/trial-retention-0184.sql'), /\\ir \.\.\/\.\.\/supabase\/migrations\/0206_flow_progress\.sql/);
});

console.log(`flow-resume-0206: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
