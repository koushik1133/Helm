// Template editor UI (fix/template-editor-ui):
//   1 Control Center > Layout templates cards: one even grid of same-height actions, "Edit layout" first + primary,
//     names / descriptions clamped (full text in the title)
//   2 builder template-edit bar: labelled one-row fields (description = single-line input), Save template + Done
//     grouped and always visible, green theme tokens (the bar and the trial strip were on the violet :root accent)
//   3 "Edit layout" opens the template's items: loading state from the URL at once (never the blank-floor prompt),
//     a read error retries and then shows Retry (never a silent blank "new" template), not-found starts a new one
// Runs the real studio-templates.js in a tiny fake DOM with fake builder globals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const tick = async (k = 8) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 5)); };
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

// ---- tiny fake DOM (ids are indexed so getElementById works) ----------------------------------------
let IDS = {};
class El {
  constructor(tag, ns) { this.tag = tag; this.ns = ns || null; this.children = []; this.attrs = {}; this.ls = {}; this.parentNode = null; this._t = ''; this._cls = new Set(); this.hidden = false; this.dataset = {}; this.nodeType = 1; this.disabled = false; this.value = ''; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const s = this._cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ?? !s.has(c)) ? s.add(c) : s.delete(c) }; }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); if (k === 'id') IDS[v] = this; if (k === 'hidden') this.hidden = true; if (k === 'value') this.value = String(v); if (k === 'checked') this.checked = true; }
  getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(nw, old) { const i = this.children.indexOf(old); nw.parentNode = this; old.parentNode = null; this.children[i] = nw; return old; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); if (this.attrs.id && IDS[this.attrs.id] === this) delete IDS[this.attrs.id]; }
  get childNodes() { return this.children; } get firstChild() { return this.children[0] || null; } get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  set textContent(v) { this._t = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }
  click() { (this.ls.click || []).forEach((f) => f({ type: 'click', target: this, preventDefault() {} })); }
  focus() {} closest() { return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const tags = sel.split(',').map((s) => s.trim()); return all(this, (e) => tags.includes(e.tag)); }
}
const txt = (s) => ({ nodeType: 3, nodeValue: String(s), get textContent() { return this.nodeValue; }, children: [], parentNode: null });
const all = (node, pred, out = []) => { for (const c of node.children || []) { if (c instanceof El && pred(c)) out.push(c); all(c, pred, out); } return out; };
const labels = (node) => all(node, (e) => e.tag === 'button' || e.tag === 'a').map((e) => e.textContent);

const SEED = { items: [
  { x: 56, y: 1, type: 'stage', color: '#2f6fed', width: 76, height: 15, category: 'structure', rotation: 0 },
  { x: 110, y: 46, type: 'seatblock', color: '#0d9488', width: 60, height: 48, category: 'seating', rotation: 0 }],
  scale: { pxPerFt: 12, worldFt: { w: 200, h: 140 } }, venue: { capacity: 450 } };
const ID = '11111111-1111-4111-8111-111111111111';
const ROWS = [{ id: ID, name: 'Demo · Wedding — Grand Lawn (450+ guests)', event_type: 'wedding', description: 'A long sample description', thumbnail: 'data:image/jpeg;base64,AAAA', is_default: false, archived: false, updated_at: 'a' }];

function boot({ trial = false, search = '', builder = false, get } = {}) {
  IDS = {};
  const doc = { readyState: 'complete', body: new El('body'), getElementById: (id) => IDS[id] || null, querySelectorAll: () => [],
    createElement: (tg) => new El(tg), createElementNS: (ns, tg) => new El(tg, ns), createTextNode: txt, addEventListener() {} };
  const log = { toasts: [], loadItems: [], es: 0, reset: 0, base: 0, saves: [] };
  const cx = { document: doc, console, setTimeout, clearTimeout, URLSearchParams, URL, Promise };
  cx.window = cx; cx.globalThis = cx;
  cx.location = { search, hash: '', href: 'https://x.test/' + (builder ? 'builder.html' : 'control.html') + search, reload() { log.reloaded = true; } };
  cx.history = { replaceState(a, b, u) { log.url = u; } };
  cx.BPUI = { toast: (m) => log.toasts.push(m), friendlyError: (e) => 'Could not reach the server' };
  cx.BPStore = {
    auth: { role: async () => 'admin', user: () => ({ id: 'u' }) },
    subscription: { trial: async () => ({ status: trial ? 'trial' : 'active' }) },
    layoutTemplates: {
      list: async () => ROWS,
      get: get || (async (id) => { const r = ROWS.find((x) => x.id === id); return r ? { ...r, data: SEED } : null; }),
      save: async (id, p) => { log.saves.push([id, p.name, p.data.items.length]); return { id: id || '44444444-4444-4444-8444-444444444444', name: p.name }; } },
  };
  if (builder) {
    // the builder page: #preset (studio-templates.js mounts in builder mode), the blank-floor prompt + loading state
    const hdr = new El('div'); doc.body.appendChild(hdr);
    const preset = new El('select'); preset.setAttribute('id', 'preset'); hdr.appendChild(preset);
    const es = new El('div'); es.setAttribute('id', 'emptyState'); const h3 = new El('h3'); h3.textContent = 'This event is a blank floor'; es.appendChild(h3); doc.body.appendChild(es);
    const ld = new El('div'); ld.setAttribute('id', 'layoutLoading'); ld.appendChild(new El('span')); ld.appendChild(txt('Loading event…')); doc.body.appendChild(ld);
    vm.createContext(cx);
    // builder.js globals the module reads defensively (typeof)
    vm.runInContext(`var WORLD = { w: 120, h: 80 }; var CAPS = { hall: 1000 }; var RO = false; var store = { items: [], venue: {} };
      function loadItems(items, name) { store.items = items.slice(); __log.loadItems.push([items.length, name]); }
      function updateEmptyState() { __log.es++; var m = window.__helmTplEdit && window.__helmTplEdit.mode;
        document.getElementById('emptyState').hidden = m === 'loading' || m === 'edit' || m === 'error' || store.items.length > 0;
        document.getElementById('layoutLoading').hidden = m !== 'loading'; }
      function resetHistory() { __log.reset++; } function setSavedBaseline() { __log.base++; }
      function updateDimsLabel() {} function sizeCanvas() {}`, Object.assign(cx, { __log: log }));
  } else vm.createContext(cx);
  vm.runInContext(read('public/studio-templates-core.js'), cx);
  vm.runInContext(read('public/studio-templates.js'), cx);
  return { cx, doc, log };
}

await t('CC cards: Edit layout first + primary, Open in builder secondary, clamped name / description carry the full text', async () => {
  const { cx, doc } = boot();
  const root = new El('div'); doc.body.appendChild(root);
  cx.HelmStudioTemplates.renderManager(root, { newHref: 'n', editHref: (r) => 'builder.html?new=1&tplEdit=' + r.id, useHref: (r) => 'builder.html?new=1&useTpl=' + r.id }); await tick();
  const acts = all(root, (e) => e.classList.contains('st-acts'))[0];
  const names = acts.children.map((b) => b.textContent);
  assert.deepEqual(names, ['Edit layout', 'Open in builder', 'Rename', 'Duplicate', 'Set default', 'Archive']);
  assert.ok(acts.children[0].classList.contains('primary'), 'Edit layout is the primary action');
  assert.equal(acts.children.filter((b) => b.classList.contains('primary')).length, 1, 'exactly one primary per card');
  assert.ok(acts.children.every((b) => b.classList.contains('btn') && b.classList.contains('sm')), 'links and buttons share the same classes');
  const nm = all(root, (e) => e.classList.contains('st-name'))[0], ds = all(root, (e) => e.classList.contains('st-desc'))[0];
  assert.equal(nm.attrs.title, ROWS[0].name); assert.equal(ds.attrs.title, ROWS[0].description);
});

await t('CC cards in a trial: Open in builder is the one (primary) action', async () => {
  const { cx, doc } = boot({ trial: true });
  const root = new El('div'); doc.body.appendChild(root);
  cx.HelmStudioTemplates.renderManager(root, { editHref: (r) => 'e', useHref: (r) => 'u' }); await tick();
  const acts = all(root, (e) => e.classList.contains('st-acts'))[0];
  assert.deepEqual(acts.children.map((b) => b.textContent), ['Open in builder']); assert.ok(acts.children[0].classList.contains('primary'));
});

await t('CSS: even same-height action grid, clamps, tidy edit bar with Save + Done grouped', () => {
  const css = read('public/studio-templates.css');
  assert.match(css, /\.st-acts\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /\.st-acts>\.btn\{display:inline-flex;align-items:center;justify-content:center;[^}]*height:32px/);
  assert.match(css, /\.st-acts>\.btn:last-child:nth-child\(odd\)\{grid-column:1\/-1\}/);
  assert.match(css, /\.st-tools>\.btn\{display:inline-flex;align-items:center/);
  assert.match(css, /\.st-name\{[^}]*-webkit-line-clamp:2/); assert.match(css, /\.st-desc\{[^}]*-webkit-line-clamp:3/);
  assert.match(css, /\.st-card\{[^}]*height:100%/);
  assert.match(css, /\.st-editbar\{position:sticky;top:0;[^}]*flex-wrap:wrap/);
  assert.match(css, /\.st-editbar \.st-eb-acts\{[^}]*flex:0 0 auto/, 'Save + Done never shrink off the edge');
  assert.match(css, /\.st-editbar \.st-fld-name\{flex:2 1 240px\}/);
  assert.doesNotMatch(css, /textarea\{flex/, 'no oversized description textarea in the bar');
  assert.doesNotMatch(css, /#2b6cb0|#6d28d9|#7c5cff/i, 'no blue / violet fallbacks');
});

await t('green theme: builder-v2 scopes the theme tokens onto the edit bar and the trial strip / reminder', () => {
  const v2 = read('public/builder-v2.css');
  const lists = v2.match(/:is\(header,aside,[^)]*\.htour[^)]*\)/g);
  assert.ok(lists.length >= 17, String(lists.length));
  for (const l of lists) assert.ok(/\.st-editbar,\.htr,\.htrm,\.htb\)$/.test(l), 'scope list misses the bar / trial strip: ' + l.slice(0, 60));
  assert.match(v2, /html\[data-hb-theme="emerald"\] :is\([^)]*\.st-editbar,\.htr[^)]*\) \{[^}]*--accent:#047857/);
  assert.match(v2, /html\[data-hb-theme\] :is\(\.htour,\.htour-fab,\.st-editbar,\.htr,\.htrm,\.htb\) \{ --hb-bg:var\(--panel\);[^}]*--hb-acc:var\(--accent\)/);
  assert.match(v2, /html\[data-hb-theme\] \.tbtn\.primary \{ background:var\(--accent\)/);
});

await t('Edit layout: loading state from the URL at once, then the template items, edit bar, clean baseline', async () => {
  const { cx, doc, log } = boot({ builder: true, search: '?new=1&tplEdit=' + ID });
  assert.equal(cx.__helmTplEdit && cx.__helmTplEdit.mode, 'loading', 'loading before auth / the template read finish');
  assert.equal(IDS.emptyState.hidden, true, 'no blank-floor prompt while loading');
  assert.equal(IDS.layoutLoading.hidden, false); assert.equal(IDS.layoutLoading.lastChild.nodeValue, 'Loading template…');
  await until(() => log.loadItems.length);
  assert.deepEqual([...log.loadItems[0]], [2, ROWS[0].name]);
  assert.equal(cx.__helmTplEdit.mode, 'edit'); assert.equal(IDS.emptyState.hidden, true); assert.equal(IDS.layoutLoading.hidden, true);
  assert.equal(IDS.layoutLoading.lastChild.nodeValue, 'Loading event…', 'loading text restored');
  assert.equal(cx.WORLD.w, 200, 'template hall size'); assert.ok(log.reset >= 1 && log.base >= 1, 'opened template = clean baseline');
  const bar = IDS.st_editbar; assert.ok(bar); assert.equal(doc.body.firstChild, bar);
  assert.match(bar.textContent, /Editing studio template/);
  assert.equal(IDS.st_f_name.value, ROWS[0].name);
  assert.equal(IDS.st_f_desc.tag, 'input', 'description is a single-line input in the bar'); assert.equal(IDS.st_f_desc.attrs.type, 'text');
  const acts = all(bar, (e) => e.classList.contains('st-eb-acts'))[0];
  assert.deepEqual(labels(acts), ['Save template', 'Done']);
  assert.equal(all(acts, (e) => e.tag === 'a')[0].attrs.href, 'control.html#layout-templates');
  // saving keeps the same template id and re-baselines
  const b0 = log.base; IDS.st_edit_save.click(); await until(() => log.saves.length);
  await tick(); assert.deepEqual([...log.saves[0]], [ID, ROWS[0].name, 2]); assert.ok(log.base > b0);
});

await t('Edit layout: a read error retries, then shows Retry - never a blank "new" template that would save a copy', async () => {
  let calls = 0;
  const { cx, log } = boot({ builder: true, search: '?new=1&tplEdit=' + ID, get: async () => { calls++; throw new Error('Failed to fetch'); } });
  await until(() => cx.__helmTplEdit && cx.__helmTplEdit.mode === 'error', 6000);
  assert.equal(calls, 3, 'tried three times'); assert.equal(log.loadItems.length, 0, 'floor not replaced');
  assert.equal(IDS.emptyState.hidden, true, 'no blank-floor prompt on a read error');
  assert.equal(IDS.st_edit_save.textContent, 'Retry'); assert.ok(IDS.st_f_name.disabled);
  assert.match(IDS.st_editbar.textContent, /Could not open this template/);
  IDS.st_edit_save.click(); assert.equal(log.reloaded, true); assert.equal(log.saves.length, 0);
});

await t('Edit layout: a transient error recovers on retry', async () => {
  let calls = 0;
  const { cx, log } = boot({ builder: true, search: '?new=1&tplEdit=' + ID, get: async (id) => { if (++calls === 1) throw new Error('blip'); return { ...ROWS[0], data: SEED }; } });
  await until(() => log.loadItems.length, 4000);
  assert.equal(cx.__helmTplEdit.mode, 'edit'); assert.deepEqual([...log.loadItems[0]], [2, ROWS[0].name]);
});

await t('New template / not found: new mode, starter prompt re-worded for templates; trial: state cleared', async () => {
  { const { cx, log } = boot({ builder: true, search: '?new=1&tplEdit=new' });
    await until(() => log.loadItems.length);
    assert.equal(cx.__helmTplEdit.mode, 'new'); assert.equal(IDS.emptyState.hidden, false, 'starter prompt offered on an empty new template');
    assert.match(IDS.emptyState.firstChild.textContent, /new template/i); assert.match(IDS.st_editbar.textContent, /New studio template/); }
  { const { cx, log } = boot({ builder: true, search: '?new=1&tplEdit=99999999-1111-4111-8111-111111111111' });
    await until(() => log.loadItems.length);
    assert.equal(cx.__helmTplEdit.mode, 'new'); assert.ok(log.toasts.some((m) => /could not be found/.test(m))); }
  { const { cx, log } = boot({ builder: true, trial: true, search: '?new=1&tplEdit=' + ID });
    await until(() => log.toasts.length);
    assert.equal(cx.__helmTplEdit, null, 'trial: no template edit state left behind'); assert.equal(IDS.st_editbar, undefined);
    assert.equal(IDS.emptyState.firstChild.textContent, 'This event is a blank floor'); }
});

await t('builder.js: the blank-floor prompt honours the template-edit state', () => {
  const b = read('public/builder.js');
  assert.match(b, /const tpl=window\.__helmTplEdit, tplMode=tpl&&tpl\.mode, tplLoading=tplMode==='loading';/);
  assert.match(b, /es\.hidden = layoutLoading \|\| tplLoading \|\| tplMode==='edit' \|\| tplMode==='error' \|\| RO/);
  assert.match(b, /ld\.hidden = !\(layoutLoading \|\| \(tplLoading && !threeD\)\)/);
  const st = read('public/studio-templates.js');
  assert.doesNotMatch(st, /innerHTML|insertAdjacentHTML|outerHTML/);
});

console.log('template-editor-ui: ok (' + n + ')');
