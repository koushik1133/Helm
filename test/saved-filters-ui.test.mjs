// Saved filters / views (0064) — front end.
//  * pure: pageKey, clean() (known controls only, length caps, junk dropped), inventory low-stock match
//  * adapter in a tiny fake DOM: readState / applyState set controls + fire input/change/click
//  * chip row: presets, own + shared views, Save (admin asked to share, member never),
//    rename / default / delete / share menu (share only for admins), ?view= deep link + default view
//  * wiring: 5 list pages load saved-filters.js, inventory render consults match(), store-api
//    savedViews uses saved_views + saved_view_set_default, no innerHTML / inline style, APPLY ASCII
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/saved-filters.js');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.message)); } };

class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ''; this.hidden = false; this.value = ''; this.checked = false; this.dataset = {}; this.cls = new Set(); this.options = []; this.fired = []; }
  get firstChild() { return this.childNodes[0] || null; }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.cls].join(' '); }
  get classList() { const s = this.cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { if (c.isFrag) { c.childNodes.slice().forEach((x) => this.appendChild(x)); return c; } if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); if (this.tagName === 'SELECT' && c.tagName === 'OPTION') this.options.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  set textContent(v) { this.childNodes = []; this._t = String(v); } get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  dispatchEvent(e) { this.fired.push(e.type); (this.ls[e.type] || []).forEach((f) => f(e)); return true; }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() {}
  all() { return this.childNodes.flatMap((c) => [c, ...c.all()]); }
  querySelectorAll(sel) { if (sel === 'button') return this.all().filter((x) => x.tagName === 'BUTTON'); return []; }
  querySelector(sel) { if (sel === 'button.on') return this.all().find((x) => x.tagName === 'BUTTON' && x.cls.has('on')) || null; return null; }
}
function makeEnv(path, search = '') {
  const doc = { readyState: 'complete', ids: {}, createElement: (t) => new El(t, doc), createDocumentFragment: () => { const f = new El('frag', doc); f.isFrag = true; return f; }, getElementById: (id) => doc.ids[id] || null, addEventListener() {} };
  doc.body = new El('body', doc);
  const add = (parent, tag, id) => { const e = new El(tag, doc); if (id) { e.attrs.id = id; doc.ids[id] = e; } parent.appendChild(e); return e; };
  const loc = { pathname: path, search, href: 'https://x.test' + path + search, hash: '' };
  const hist = { state: null, replaceState: (_s, _t, u) => { const q = u.indexOf('?'); loc.search = q >= 0 ? u.slice(q).replace(/#.*$/, '') : ''; } };
  const win = { document: doc, location: loc, history: hist, URLSearchParams, URL: class extends URL { constructor(h) { super(h); } }, Event: class { constructor(type) { this.type = type; } }, setTimeout: () => 0, adopted: [] };
  win.__helmAdoptCss = (_d, css) => win.adopted.push(css);
  win.globalThis = win;
  return { doc, win, add, loc };
}
function load(env) { const ctx = vm.createContext(env.win); vm.runInContext(SRC, ctx); return env.win.HelmSavedFilters; }
const flush = () => new Promise((r) => setImmediate(r));
const btnTexts = (row) => row.all().filter((x) => x.tagName === 'BUTTON').map((b) => b.textContent);

function invPage(search) {
  const env = makeEnv('/inventory.html', search);
  const bar = env.add(env.doc.body, 'div');
  const q = env.add(bar, 'input', 'search');
  const cat = env.add(bar, 'select', 'catFilter'); const o = env.doc.createElement('option'); o.value = 'Decor'; cat.appendChild(o);
  const pri = env.add(bar, 'select', 'priFilter'); ['A', 'B', 'C'].forEach((v) => { const x = env.doc.createElement('option'); x.value = v; pri.appendChild(x); });
  const chk = env.add(bar, 'input', 'showInactive');
  return { env, q, cat, pri, chk, bar };
}
function stubStore(rows) {
  const calls = [];
  return { calls, rows,
    list: async (p) => { calls.push(['list', p]); return rows.slice(); },
    save: async (p, n, s, sh) => { calls.push(['save', p, n, s, sh]); const v = { id: '11111111-1111-4111-8111-11111111111' + rows.length, user_id: 'me', name: n, state: s, shared: sh }; rows.push(v); return v; },
    update: async (id, patch) => { calls.push(['update', id, patch]); return true; },
    remove: async (id) => { calls.push(['remove', id]); return true; },
    setDefault: async (id, on) => { calls.push(['default', id, on]); } };
}

await t('pageKey: only the 5 list pages', () => {
  const H = load(makeEnv('/leads.html'));
  assert.deepEqual(['leads', 'quotes', 'staff', 'vendors', 'inventory', 'dashboard', 'x'].map((p) => H.pageKey('/' + p + '.html')), ['leads', 'quotes', 'staff', 'vendors', 'inventory', null, null]);
  assert.equal(H.pageKey('/inventory'), 'inventory');
});
await t('clean(): known controls only, caps, junk dropped', () => {
  const H = load(makeEnv('/inventory.html'));
  const c = H.clean(H.PAGES.inventory, { q: 'x'.repeat(500), sel: { priFilter: 'A', evil: 'x', catFilter: 5 }, chk: { showInactive: true, other: true }, tab: 'confirmed', x: 'low', y: 1 });
  assert.equal(c.q.length, 120); assert.deepEqual({ ...c.sel }, { priFilter: 'A' }); assert.deepEqual({ ...c.chk }, { showInactive: true });
  assert.equal(c.tab, ''); assert.equal(c.x, 'low');
  assert.equal(H.clean(H.PAGES.quotes, { tab: '<script>' }).tab, '');
  assert.equal(H.clean(H.PAGES.quotes, { x: 'low' }).x, '');
  assert.deepEqual({ ...H.clean(H.PAGES.leads, [1, 2]) , sel: {}, chk: {} }, { q: '', sel: {}, chk: {}, tab: '', x: '' });
});
await t('applyState / readState round-trip on inventory (fires change/input, adds late option)', () => {
  const p = invPage(); const H = load(p.env);
  H.applyState(H.PAGES.inventory, { q: 'chair', sel: { catFilter: 'Lighting', priFilter: 'B' }, chk: { showInactive: true } });
  assert.equal(p.q.value, 'chair'); assert.equal(p.pri.value, 'B'); assert.equal(p.cat.value, 'Lighting'); assert.equal(p.chk.checked, true);
  assert.ok(p.q.fired.includes('input') && p.pri.fired.includes('change') && p.chk.fired.includes('change'));
  assert.ok(p.cat.options.some((o) => o.value === 'Lighting'));
  const s = H.readState(H.PAGES.inventory);
  assert.equal(s.q, 'chair'); assert.equal(s.sel.priFilter, 'B'); assert.equal(s.chk.showInactive, true);
});
await t('inventory Low stock preset: match() hides healthy stock only while active', () => {
  const p = invPage(); const H = load(p.env); H._current.page = 'inventory';
  const item = { total_qty: 100 };
  assert.equal(H.match('inventory', { item, avail: { available: 90 } }), true);
  H.applyState(H.PAGES.inventory, { x: 'low' });
  assert.equal(H.match('inventory', { item, avail: { available: 90 } }), false);
  assert.equal(H.match('inventory', { item, avail: { available: 10 } }), true);
  assert.equal(H.match('inventory', { item, avail: { available: 0 } }), true);
  H.applyState(H.PAGES.inventory, {});
  assert.equal(H.match('inventory', { item, avail: { available: 90 } }), true);
});
await t('quotes tabs: preset clicks the tab button; readState reads it back', () => {
  const env = makeEnv('/quotes.html'); const tabs = env.add(env.doc.body, 'div', 'tabs');
  const mk = (f, on) => { const b = env.add(tabs, 'button'); b.dataset.f = f; if (on) b.cls.add('on'); b.addEventListener('click', () => { tabs.childNodes.forEach((x) => x.cls.delete('on')); b.cls.add('on'); }); return b; };
  mk('all', true); const conf = mk('confirmed'); const bar = env.add(env.doc.body, 'div'); env.add(bar, 'input', 'search'); env.add(bar, 'select', 'typeFilter');
  const H = load(env);
  H.applyState(H.PAGES.quotes, { tab: 'confirmed' });
  assert.ok(conf.cls.has('on')); assert.equal(H.readState(H.PAGES.quotes).tab, 'confirmed');
});
await t('chip row: presets, own + shared views, member gets no Share option and no share prompt', async () => {
  const p = invPage(); const H = load(p.env);
  const st = stubStore([{ id: '22222222-2222-4222-8222-222222222222', user_id: 'me', name: 'Mine', state: { q: 'a' } },
                       { id: '33333333-3333-4333-8333-333333333333', user_id: 'boss', name: 'Team', state: { q: 'b' }, shared: true }]);
  let asked = 0;
  const ctl = new H.Ctl('inventory', H.PAGES.inventory, st, { prompt: () => 'Lights', confirm: () => { asked++; return true; } });
  ctl.me = 'me'; ctl.admin = false; await ctl.start();
  const row = p.env.doc.body.childNodes[0];
  assert.equal(row.getAttribute('role'), 'toolbar');
  const texts = btnTexts(row);
  for (const want of ['All', 'Low stock', 'High value (A)', 'Mine', 'Team · studio', '+ Save view']) assert.ok(texts.includes(want), want + ' in ' + texts);
  assert.ok(!texts.includes('Share with studio'));
  assert.equal(texts.filter((x) => x === '⋯').length, 1, 'menu only on own view');
  await ctl.saveNew(); await flush();
  const sv = st.calls.find((c) => c[0] === 'save');
  assert.equal(sv[1], 'inventory'); assert.equal(sv[2], 'Lights'); assert.equal(sv[4], false); assert.equal(asked, 0);
  assert.ok(p.env.loc.search.includes('view='));
});
await t('admin: Save asks to share; menu offers Share / rename / default / delete', async () => {
  const p = invPage(); const H = load(p.env);
  const v = { id: '22222222-2222-4222-8222-222222222222', user_id: 'me', name: 'Mine', state: {} };
  const st = stubStore([v]);
  const ctl = new H.Ctl('inventory', H.PAGES.inventory, st, { prompt: () => 'Renamed', confirm: () => true });
  ctl.me = 'me'; ctl.admin = true; await ctl.start();
  await ctl.saveNew(); assert.equal(st.calls.find((c) => c[0] === 'save')[4], true);
  const row = p.env.doc.body.childNodes[0];
  const texts = btnTexts(row);
  for (const want of ['Share with studio', 'Rename', 'Set as default', 'Delete', 'Update with current filters']) assert.ok(texts.includes(want), want);
  const click = (txt) => row.all().find((x) => x.tagName === 'BUTTON' && x.textContent === txt).click();
  click('Rename'); click('Set as default'); click('Share with studio'); click('Delete'); await flush();
  assert.deepEqual(st.calls.filter((c) => c[0] === 'update').map((c) => c[2]).map((x) => JSON.stringify(x)).sort(), ['{"name":"Renamed"}', '{"shared":true}']);
  assert.ok(st.calls.some((c) => c[0] === 'default' && c[2] === true));
  assert.ok(st.calls.some((c) => c[0] === 'remove' && c[1] === v.id));
});
await t('?view=<id> deep link applies that view; else own default; ?view=preset:low works', async () => {
  const rows = () => [{ id: '22222222-2222-4222-8222-222222222222', user_id: 'me', name: 'D', state: { q: 'def' }, is_default: true },
                      { id: '33333333-3333-4333-8333-333333333333', user_id: 'boss', name: 'S', state: { q: 'shared' }, shared: true }];
  let p = invPage('?view=33333333-3333-4333-8333-333333333333'); let H = load(p.env);
  let ctl = new H.Ctl('inventory', H.PAGES.inventory, stubStore(rows())); ctl.me = 'me'; await ctl.start();
  assert.equal(p.q.value, 'shared');
  p = invPage(); H = load(p.env); ctl = new H.Ctl('inventory', H.PAGES.inventory, stubStore(rows())); ctl.me = 'me'; await ctl.start();
  assert.equal(p.q.value, 'def');
  p = invPage('?view=preset:low'); H = load(p.env); H._current.page = 'inventory'; ctl = new H.Ctl('inventory', H.PAGES.inventory, stubStore([])); await ctl.start();
  assert.equal(H.match('inventory', { item: { total_qty: 10 }, avail: { available: 10 } }), false);
  p = invPage('?view=not-a-uuid'); H = load(p.env); ctl = new H.Ctl('inventory', H.PAGES.inventory, stubStore(rows())); ctl.me = 'me'; await ctl.start();
  assert.equal(p.q.value, '', 'bad id ignored, default not forced over an explicit link');
});
await t('signed-out / local: no Save button, presets still shown', async () => {
  const p = invPage(); const H = load(p.env);
  const ctl = new H.Ctl('inventory', H.PAGES.inventory, stubStore([])); await ctl.start();
  const texts = btnTexts(p.env.doc.body.childNodes[0]);
  assert.ok(texts.includes('Low stock') && !texts.includes('+ Save view'));
});
await t('wiring: pages, inventory hook, store-api, CSP hygiene, migration', () => {
  for (const f of ['leads', 'quotes', 'staff', 'vendors', 'inventory']) assert.match(read('public/' + f + '.html'), /<script src="saved-filters\.js\?v=1"><\/script>/, f);
  assert.match(read('public/inventory.html'), /HelmSavedFilters\.match\("inventory"/);
  const S = read('public/store-api.js');
  assert.match(S, /savedViews:\s*\{/); assert.match(S, /from\("saved_views"\)/); assert.match(S, /rpc\("saved_view_set_default"/);
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|style=/.test(SRC), 'no html sinks / inline style');
  assert.match(SRC, /__helmAdoptCss/);
  assert.match(read('supabase/migrations/MANIFEST'), /0064_saved_views\.sql/);
  assert.ok(/^[\x00-\x7F]*$/.test(read('supabase/APPLY-0064.sql')), 'APPLY-0064 pure ASCII');
  assert.match(read('supabase/migrations/0064_saved_views.sql'), /zzz_studio_read_only/);
});

console.log(`saved-filters-ui: ${fail ? fail + ' failed, ' : 'all '}${pass} passed`);
if (fail) process.exit(1);
