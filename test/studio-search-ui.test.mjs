// Universal studio search (0061) — front end.
//  * pure helpers: query cleaning (trim / 80 chars), safe links (own pages only, ?hs= gets
//    the encoded title), normalize() (known kinds only, bad rows dropped), highlight runs
//  * palette in a tiny fake DOM: combobox/listbox ARIA, aria-activedescendant follows
//    ↑/↓, Tab jumps groups, Enter navigates, Esc closes, 200ms debounce, stale results
//    dropped, empty + error states, recent searches (storage that throws is fine),
//    quick actions filtered by the role checks
//  * wiring: store-api has BPStore.search (→ {} before 0061 / short query) + loader that
//    skips HQ and public pages, no inline style / innerHTML in studio-search.js, CSS via
//    __helmAdoptCss, store-api ?v= identical on every page
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/studio-search.js');
const STORE = read('public/store-api.js');

/* ---- minimal fake DOM ------------------------------------------------------ */
class Node_ {
  constructor(tag, doc) { this.tagName = tag ? tag.toUpperCase() : null; this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._text = ''; this.hidden = false; this.value = ''; this.classSet = new Set(); }
  get firstChild() { return this.childNodes[0] || null; }
  get id() { return this.attrs.id || ''; }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument.body) return true; n = n.parentNode; } return false; }
  get classList() { const s = this.classSet; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') String(v).split(/\s+/).forEach((c) => c && this.classSet.add(c)); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return k in this.attrs; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; this._text = String(v); }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  dispatch(ev, extra = {}) { const e = Object.assign({ type: ev, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, extra); (this.ls[ev] || []).forEach((f) => f(e)); return e; }
  focus() { this.ownerDocument.activeElement = this; }
  select() {}
  scrollIntoView() {}
  click() { this.dispatch('click'); }
  walk(fn) { fn(this); this.childNodes.forEach((c) => c.walk && c.walk(fn)); }
  find(pred) { let r = null; this.walk((n) => { if (!r && pred(n)) r = n; }); return r; }
  findAll(pred) { const r = []; this.walk((n) => { if (pred(n)) r.push(n); }); return r; }
}
class Text_ { constructor(t) { this.textContent = t; this.parentNode = null; } }
function makeDoc() {
  const doc = { readyState: 'complete', activeElement: null, ls: {} };
  doc.createElement = (t) => new Node_(t, doc);
  doc.createElementNS = (ns, t) => new Node_(t, doc);
  doc.createTextNode = (t) => new Text_(t);
  doc.body = new Node_('body', doc);
  doc.documentElement = new Node_('html', doc);
  doc.getElementById = (id) => doc.body.find((n) => n.attrs && n.attrs.id === id);
  doc.querySelector = (sel) => (sel.startsWith('.') ? doc.body.find((n) => n.classSet && n.classSet.has(sel.slice(1))) : null);
  doc.contains = (n) => !!(n && n.isConnected);
  doc.addEventListener = (ev, fn) => { (doc.ls[ev] = doc.ls[ev] || []).push(fn); };
  return doc;
}

function load({ role = 'admin', view = () => true, edit = () => true, can = () => true, search, storageThrows = false, pathname = '/dashboard.html', search_qs = '' } = {}) {
  const doc = makeDoc();
  const store = {};
  const ls = storageThrows
    ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }
    : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const calls = [];
  const timers = [];
  const ctx = {
    module: { exports: {} }, console, Promise, URLSearchParams, encodeURIComponent, AbortController, JSON, Math, String, Array, Object, Set, Error,
    document: doc, localStorage: ls, navigator: { platform: 'MacIntel', userAgent: 'x' },
    location: { pathname, search: search_qs, hash: '', href: '' },
    history: { state: null, replaceState() {} },
    Event: class { constructor(t, o) { this.type = t; Object.assign(this, o); } },
    MutationObserver: class { observe() {} },
    open: (u) => calls.push(['open', u]),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    __helmAdoptCss: (d, css) => { ctx.__css = css; },
    BPStore: {
      mode: () => 'supabase',
      search: search || (async (q) => { calls.push(['search', q]); return {}; }),
      auth: { user: () => ({ id: 'u1' }), role: async () => role, canView: async (a) => view(a), canEditArea: async (a) => edit(a), can: async (c) => can(c) },
    },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const flushTimers = async (maxMs = 10000) => { for (let i = 0; i < timers.length; i++) { const t = timers[i]; if (t.fn && t.ms <= maxMs) { const f = t.fn; t.fn = null; f(); } } await tick(); };
  return { ctx, doc, api: ctx.module.exports, calls, timers, store, flushTimers };
}
const J = (v) => JSON.parse(JSON.stringify(v));
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
const input = (env) => env.doc.getElementById('hssInput');
const options = (env) => env.doc.body.findAll((n) => n.attrs && n.attrs.role === 'option');
const key = (env, k, extra = {}) => input(env).dispatch('keydown', Object.assign({ key: k }, extra));
async function typeQ(env, q) { const i = input(env); i.value = q; i.dispatch('input'); await env.flushTimers(); await tick(); }

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const SAMPLE = {
  events: [{ id: 'e1', title: 'Wedding Ravi', subtitle: 'A-0001 / Alice', link: 'event.html?id=e1' }],
  leads: [{ id: 'l1', title: 'Ravi Kumar', subtitle: 'new / Wedding', link: 'leads.html?hs=' }, { id: 'l2', title: 'Ravi K', subtitle: '', link: 'leads.html?hs=' }],
  vendors: [{ id: 'v1', title: 'Ravi Tents', subtitle: 'Tents', link: 'vendors.html?hs=' }],
};

/* ---- pure helpers ---------------------------------------------------------- */
t('cleanQuery trims, collapses spaces, caps at 80', () => {
  const { api } = load();
  assert.equal(api.cleanQuery('  a   b  '), 'a b');
  assert.equal(api.cleanQuery('x'.repeat(200)).length, 80);
  assert.equal(api.cleanQuery(null), '');
});
t('safeLink: own pages only; ?hs= gets the encoded title', () => {
  const { api } = load();
  assert.equal(api.safeLink('event.html?id=abc-1', 't'), 'event.html?id=abc-1');
  assert.equal(api.safeLink('leads.html?hs=', 'Ravi & <Co>'), 'leads.html?hs=Ravi%20%26%20%3CCo%3E');
  assert.equal(api.safeLink('control.html#users', 'x'), 'control.html#users');
  for (const bad of ['javascript:alert(1)', 'https://evil.test/x.html', '//evil.test/a.html', '/abs.html', 'x.html?a=<b>', 'event.html?id="x"', '', null]) {
    assert.equal(api.safeLink(bad, 't'), null, String(bad));
  }
});
t('normalize: known kinds in display order, bad rows dropped', () => {
  const { api } = load();
  const g = api.normalize({ vendors: SAMPLE.vendors, unknown: [{ id: 1, title: 'x', link: 'a.html' }], leads: [...SAMPLE.leads, { id: 'z', link: 'leads.html?hs=' }, { id: 'y', title: 'bad', link: 'https://x' }], events: [] });
  assert.deepEqual(J(g.map((x) => x.type)), ['leads', 'vendors']);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(J(api.normalize(null)), []); assert.deepEqual(J(api.normalize([1])), []); assert.deepEqual(J(api.normalize('x')), []);
});
t('highlight marks every case-insensitive occurrence', () => {
  const { api } = load();
  const r = api.highlight('Ravi and ravi', 'RAVI');
  assert.deepEqual(J(r.map((p) => [p.t, p.hit])), [['Ravi', true], [' and ', false], ['ravi', true]]);
  assert.deepEqual(J(api.highlight('abc', '').map((p) => p.t)), ['abc']);
});

/* ---- palette behaviour ---------------------------------------------------- */
t('trigger mounts into #helm-topbar-search when present', async () => {
  const env = load();
  const mount = env.doc.createElement('div'); mount.setAttribute('id', 'helm-topbar-search'); env.doc.body.appendChild(mount);
  await env.api.boot();
  const trig = env.doc.getElementById('hssTrigger');
  assert.ok(trig && trig.parentNode === mount);
  assert.equal(trig.getAttribute('aria-haspopup'), 'dialog');
});
t('fallback: own slot left of the account chip', async () => {
  const env = load();
  const header = env.doc.createElement('header'); const acct = env.doc.createElement('div'); const lo = env.doc.createElement('button');
  lo.setAttribute('id', 'logoutBtn'); acct.appendChild(lo); header.appendChild(acct); env.doc.body.appendChild(header);
  await env.api.boot();
  const slot = header.childNodes[0];
  assert.ok(slot.classSet.has('hss-slot')); assert.equal(header.childNodes[1], acct);
});
t('client role: nothing mounts, no shortcut', async () => {
  const env = load({ role: 'client' });
  const ok = await env.api.boot();
  assert.equal(ok, false); assert.equal(env.doc.getElementById('hssTrigger'), null); assert.ok(!env.doc.ls.keydown);
});
t('HQ page: never boots', async () => {
  const env = load({ pathname: '/hq.html' });
  assert.equal(await env.api.boot(), false);
});
t('Cmd+K opens; ARIA combobox + listbox wiring', async () => {
  const env = load(); await env.api.boot();
  const e = { key: 'k', metaKey: true, preventDefault() {}, target: env.doc.body };
  env.doc.ls.keydown.forEach((f) => f(e)); await tick();
  const i = input(env);
  assert.ok(i, 'palette open');
  assert.equal(i.getAttribute('role'), 'combobox');
  assert.equal(i.getAttribute('aria-controls'), 'hssList');
  assert.equal(env.doc.getElementById('hssList').getAttribute('role'), 'listbox');
  assert.equal(i.getAttribute('maxlength'), '80');
  assert.equal(env.doc.activeElement, i);
});
t('empty query shows quick actions filtered by role access', async () => {
  const env = load({ role: 'sales', view: (a) => ['leads', 'quotes'].includes(a), edit: (a) => a === 'leads', can: () => false });
  await env.api.boot(); await env.api.open(); await tick();
  const labels = options(env).map((o) => o.textContent);
  assert.ok(labels.some((l) => l.includes('New lead')));
  assert.ok(labels.some((l) => l.includes('Go to quotes')));
  assert.ok(!labels.some((l) => l.includes('New quote')), 'needs create capability');
  assert.ok(!labels.some((l) => l.includes('Go to calendar')), 'no calendar view');
  assert.ok(!labels.some((l) => l.includes('Control Center')), 'no controls view');
});
t('1 character: no request', async () => {
  const env = load(); await env.api.boot(); await env.api.open();
  await typeQ(env, 'r');
  assert.equal(env.calls.filter((c) => c[0] === 'search').length, 0);
});
t('debounce 200ms: only the last query is sent', async () => {
  const env = load(); await env.api.boot(); await env.api.open();
  const i = input(env);
  for (const q of ['ra', 'rav', 'ravi']) { i.value = q; i.dispatch('input'); }
  const live = env.timers.filter((x) => x.fn && x.ms === 200);
  assert.equal(live.length, 1, 'one pending timer');
  await env.flushTimers(); await tick();
  assert.deepEqual(env.calls.filter((c) => c[0] === 'search').map((c) => c[1]), ['ravi']);
});
t('stale request is aborted and its answer ignored', async () => {
  const pending = [];
  const env = load({ search: (q, o) => new Promise((res) => pending.push({ q, o, res })) });
  await env.api.boot(); await env.api.open();
  const i = input(env);
  i.value = 'ra'; i.dispatch('input'); await env.flushTimers();
  i.value = 'ravi'; i.dispatch('input'); await env.flushTimers();
  assert.equal(pending.length, 2);
  assert.equal(pending[0].o.signal.aborted, true, 'first aborted');
  pending[1].res(SAMPLE); await tick();
  pending[0].res({ leads: [{ id: 'old', title: 'STALE', link: 'leads.html?hs=' }] }); await tick();
  assert.ok(!options(env).some((o) => o.textContent.includes('STALE')));
  assert.ok(options(env).some((o) => o.textContent.includes('Ravi Kumar')));
});
t('grouped results with highlighted match; first option active', async () => {
  const env = load({ search: async () => SAMPLE }); await env.api.boot(); await env.api.open();
  await typeQ(env, 'ravi');
  const groups = env.doc.body.findAll((n) => n.attrs && n.attrs.role === 'group');
  const heads = groups.map((g) => g.childNodes[0].textContent);
  assert.deepEqual(heads.slice(0, 3), ['Events & quotes', 'Leads', 'Vendors']);
  const marks = env.doc.body.findAll((n) => n.tagName === 'MARK').map((m) => m.textContent);
  assert.ok(marks.includes('Ravi'));
  const opts = options(env);
  assert.equal(opts[0].getAttribute('aria-selected'), 'true');
  assert.equal(input(env).getAttribute('aria-activedescendant'), opts[0].id);
});
t('↑/↓ move, Tab / Shift+Tab jump groups, wrap around', async () => {
  const env = load({ search: async () => SAMPLE }); await env.api.boot(); await env.api.open();
  await typeQ(env, 'ravi');
  const opts = options(env); const act = () => input(env).getAttribute('aria-activedescendant');
  key(env, 'ArrowDown'); assert.equal(act(), opts[1].id);
  key(env, 'Tab'); assert.equal(act(), opts[3].id, 'next group = vendors');
  key(env, 'Tab', { shiftKey: true }); assert.equal(act(), opts[1].id, 'back to first lead');
  key(env, 'ArrowUp'); key(env, 'ArrowUp'); assert.equal(act(), opts[opts.length - 1].id, 'wraps');
});
t('Enter opens the active result and records a recent search', async () => {
  const env = load({ search: async () => SAMPLE }); await env.api.boot(); await env.api.open();
  await typeQ(env, 'ravi');
  key(env, 'ArrowDown'); key(env, 'Enter');
  assert.equal(env.ctx.location.href, 'leads.html?hs=Ravi%20Kumar');
  assert.equal(env.doc.getElementById('hssInput'), null, 'closed');
  assert.deepEqual(J(env.api.recentGet()), ['ravi']);
});
t('recent searches are listed when the box is empty and re-run on Enter', async () => {
  const env = load({ search: async () => SAMPLE }); await env.api.boot();
  env.api.recentAdd('tents'); env.api.recentAdd('ravi'); env.api.recentAdd('Ravi');
  assert.deepEqual(J(env.api.recentGet()), ['Ravi', 'tents'], 'deduped, newest first');
  await env.api.open(); await tick();
  const first = options(env)[0];
  assert.ok(first.textContent.includes('Ravi'));
  key(env, 'Enter'); await env.flushTimers(); await tick();
  assert.equal(input(env).value, 'Ravi');
});
t('storage that throws never breaks the palette', async () => {
  const env = load({ storageThrows: true, search: async () => SAMPLE }); await env.api.boot(); await env.api.open();
  env.api.recentAdd('ravi'); assert.deepEqual(J(env.api.recentGet()), []);
  await typeQ(env, 'ravi'); key(env, 'Enter');
  assert.equal(env.ctx.location.href, 'event.html?id=e1');
});
t('no matches state', async () => {
  const env = load({ search: async () => ({ leads: [] }) }); await env.api.boot(); await env.api.open();
  await typeQ(env, 'zzzz');
  assert.ok(env.doc.body.textContent.includes('No matches for'));
});
t('error state with retry', async () => {
  let fail = true;
  const env = load({ search: async () => { if (fail) throw new Error('network'); return SAMPLE; } }); await env.api.boot(); await env.api.open();
  await typeQ(env, 'ravi');
  assert.ok(env.doc.body.textContent.includes("Search isn't available"));
  fail = false;
  const retry = env.doc.body.find((n) => n.tagName === 'BUTTON' && n.textContent === 'Try again');
  retry.click(); await tick();
  assert.ok(options(env).some((o) => o.textContent.includes('Ravi Kumar')));
});
t('Esc closes and returns focus', async () => {
  const env = load(); await env.api.boot();
  const before = env.doc.createElement('button'); env.doc.body.appendChild(before); before.focus();
  await env.api.open();
  key(env, 'Escape');
  assert.equal(env.doc.getElementById('hssInput'), null);
  assert.equal(env.doc.activeElement, before);
});
t('result text is never parsed as HTML', async () => {
  const env = load({ search: async () => ({ leads: [{ id: 'x', title: '<img src=x onerror=alert(1)>', subtitle: '<b>', link: 'leads.html?hs=' }] }) });
  await env.api.boot(); await env.api.open(); await typeQ(env, 'img');
  assert.equal(env.doc.body.findAll((n) => n.tagName === 'IMG').length, 0);
  assert.ok(options(env)[0].textContent.includes('<img src=x'));
});

/* ---- static wiring -------------------------------------------------------- */
t('studio-search.js: no innerHTML / inline style / eval', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\.|style=|eval\(|new Function/.test(SRC));
  assert.ok(/__helmAdoptCss/.test(SRC));
});
t('store-api: BPStore.search → studio_search, {} before 0061 and for short queries', () => {
  assert.match(STORE, /search: \(q, opts\) =>/);
  assert.match(STORE, /supa\.rpc\("studio_search", \{ p_q: t, p_limit:/);
  assert.match(STORE, /if \(!supa \|\| t\.length < 2\) return Promise\.resolve\(\{\}\)/);
  assert.match(STORE, /if \(rpcMissing\(error\)\) return \{\};/);
  assert.match(STORE, /abortSignal\(sig\)/);
});
t('store-api: loader skips HQ, sign-in and public client pages', () => {
  assert.match(STORE, /NO_SEARCH_PAGES = \{ hq: 1, login: 1, "reset-password": 1, "profile-setup": 1 \}/);
  assert.match(STORE, /PUBLIC_PAGES\[pageKey\(\)\] \|\| publicLinkPath\(\)/);
  assert.match(STORE, /studio-search\.js\?v=/);
});
t('store-api.js ?v= is identical on every page', () => {
  const dir = new URL('public/', root);
  const vs = new Set();
  for (const f of readdirSync(dir)) if (f.endsWith('.html')) for (const m of read('public/' + f).matchAll(/store-api\.js\?v=(\d+)/g)) vs.add(m[1]);
  assert.equal(vs.size, 1, [...vs].join(','));
});
t('migration 0061 is listed in the MANIFEST and APPLY-0061 is pure ASCII', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0061_studio_search\.sql/);
  const ap = read('supabase/APPLY-0061.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(ap), 'non-ASCII in APPLY-0061.sql');
  assert.ok(!/create\s+table/i.test(ap));
  assert.match(ap, /select item, ok from \(values/);
});

let fails = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ✓', name); } catch (e) { fails++; console.log('  ✗', name); console.log('   ', e && e.message); }
}
console.log(fails ? `studio-search-ui: ${fails} FAILED` : `studio-search-ui: all ${tests.length} passed`);
if (fails) process.exit(1);
