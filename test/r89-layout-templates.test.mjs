// R89 Settings > Layout templates: built-in starter layouts + studio templates with versions (0310).
//   1 core BUILTINS == every preset in builder.html #preset (and builder.js TEMPLATES has each key)
//   2 Settings (paid studio) lists the built-in starter layouts with Use / Customise, studio cards get Versions
//   3 free-trial studio: NO built-ins, NO Versions (trial rule unchanged: sample layouts, use only)
//   4 Versions list + "Put back" re-saves the old layout through layoutTemplates.save (never overwrites history)
//   5 builder glue: ?useBuiltin / ?fromBuiltin handled; trial gets the trial message, not the built-ins
//   6 migration 0310 + APPLY + MANIFEST: additive, ASCII, select-only grant, frozen history, v1 backfill
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const tick = async (k = 8) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 5)); };

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.ls = {}; this.parentNode = null; this._t = ''; this._cls = new Set(); this.hidden = false; this.dataset = {}; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const s = this._cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ?? !s.has(c)) ? s.add(c) : s.delete(c) }; }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); }
  getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(nw, old) { const i = this.children.indexOf(old); nw.parentNode = this; this.children[i] = nw; return old; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get childNodes() { return this.children; } get lastChild() { return this.children[this.children.length - 1] || null; }
  set textContent(v) { this._t = String(v); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }
  click() { (this.ls.click || []).forEach((f) => f({ type: 'click', target: this, preventDefault() {} })); }
  focus() {} closest() { return null; } querySelectorAll() { return []; }
}
const all = (node, pred, out = []) => { for (const c of node.children || []) { if (c instanceof El && pred(c)) out.push(c); all(c, pred, out); } return out; };
const btns = (node) => all(node, (e) => e.tag === 'button' || e.tag === 'a');
const byText = (node, s) => btns(node).filter((e) => e.textContent === s);

const core = read('public/studio-templates-core.js'), mgr = read('public/studio-templates.js');
function boot({ trial }) {
  const doc = { readyState: 'complete', body: new El('body'), getElementById: () => null, querySelectorAll: () => [], documentElement: new El('html'),
    createElement: (tg) => new El(tg), createElementNS: (ns, tg) => new El(tg), createTextNode: (s) => ({ textContent: String(s), children: [] }), addEventListener() {} };
  const rows = [{ id: '22222222-2222-4222-8222-222222222222', name: 'Studio rounds', event_type: 'corporate', description: 'd', thumbnail: null, is_default: false, archived: false, updated_at: 'b' }];
  const calls = { saves: [], versions: 0 };
  const cx = { document: doc, console, setTimeout, clearTimeout, URLSearchParams, URL, Promise };
  cx.window = cx; cx.globalThis = cx; cx.location = { search: '', hash: '', href: 'https://x.test/control.html' };
  cx.BPUI = { confirm: async () => true, toast() {} };
  cx.BPStore = {
    auth: { role: async () => 'admin', user: () => ({ id: 'u' }) },
    subscription: { trial: async () => ({ status: trial ? 'trial' : 'active' }) },
    fmtDateTime: (s) => 'when:' + s,
    layoutTemplates: {
      list: async () => rows, get: async () => ({ ...rows[0], data: { items: [] } }),
      versions: async () => { calls.versions++; return [{ id: 'v3', version_no: 3, created_at: 'c3' }, { id: 'v2', version_no: 2, created_at: 'c2' }, { id: 'v1', version_no: 1, created_at: 'c1' }]; },
      getVersion: async (id) => ({ id, data: { items: [{ type: 'stage', x: 1, y: 1, width: 10, height: 5 }] } }),
      save: async (id, p) => { calls.saves.push([id, p]); return { id, ...p }; },
      setArchived: async () => ({}), setDefault: async () => ({}), duplicate: async () => ({}) } };
  vm.createContext(cx); vm.runInContext(core, cx); vm.runInContext(mgr, cx);
  const root = new El('div');
  cx.HelmStudioTemplates.renderManager(root, { builtins: true, newHref: 'builder.html?new=1&tplEdit=new', editHref: (r) => 'e/' + r.id, useHref: (r) => 'u/' + r.id });
  return { root, calls, cx };
}

await t('1 built-in list matches the builder presets', async () => {
  const cx = {}; cx.window = cx; vm.createContext(cx); vm.runInContext(core, cx);
  const keys = JSON.parse(JSON.stringify(cx.HelmStudioTemplatesCore.BUILTINS.map((b) => b[0])));
  const html = read('public/builder.html'), sel = html.slice(html.indexOf('id="preset"'), html.indexOf('</select>', html.indexOf('id="preset"')));
  const presets = [...sel.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);
  assert.deepEqual(keys, presets);
  const js = read('public/builder.js');
  for (const k of keys) assert.match(js, new RegExp('\\n  ' + k + '\\(\\)\\{'), 'TEMPLATES.' + k);
  for (const b of cx.HelmStudioTemplatesCore.BUILTINS) assert.ok(cx.HelmStudioTemplatesCore.EVENT_TYPES.some((e) => e[0] === b[2]), b[2]);
});

await t('2 paid studio: built-ins with Use / Customise, Versions on studio cards', async () => {
  const { root } = boot({ trial: false }); await tick();
  const txt = root.textContent;
  assert.match(txt, /Your studio templates/); assert.match(txt, /Built-in starter layouts/); assert.match(txt, /Theatre seating rally/);
  const use = byText(root, 'Use'), cus = byText(root, 'Customise');
  assert.equal(use.length, 18); assert.equal(cus.length, 18);
  assert.equal(use[0].attrs.href, 'builder.html?new=1&useBuiltin=political_theatre');
  assert.equal(cus[0].attrs.href, 'builder.html?new=1&tplEdit=new&fromBuiltin=political_theatre');
  assert.equal(byText(root, 'Versions').length, 1); assert.equal(byText(root, 'Edit layout').length, 1);
});

await t('3 free trial: no built-ins, no Versions (rule unchanged)', async () => {
  const { root } = boot({ trial: true }); await tick();
  assert.doesNotMatch(root.textContent, /Built-in starter layouts/);
  assert.equal(byText(root, 'Customise').length, 0); assert.equal(byText(root, 'Versions').length, 0);
  assert.equal(byText(root, 'Edit layout').length, 0); assert.equal(byText(root, 'Open in builder').length, 1);
});

await t('4 Versions + Put back re-saves through studio_template_save', async () => {
  const { root, calls } = boot({ trial: false }); await tick();
  byText(root, 'Versions')[0].click(); await tick();
  assert.equal(calls.versions, 1);
  assert.match(root.textContent, /v3 \(current\)/); assert.match(root.textContent, /when:c2/);
  const pb = byText(root, 'Put back'); assert.equal(pb.length, 2, 'never on the current version');
  pb[1].click(); await tick();
  assert.equal(calls.saves.length, 1);
  const [id, p] = calls.saves[0];
  assert.equal(id, '22222222-2222-4222-8222-222222222222'); assert.equal(p.name, 'Studio rounds'); assert.equal(p.data.items[0].type, 'stage'); assert.equal(p.thumbnail, null);
  assert.match(root.textContent, /Version 1 put back/);
});

await t('5 builder glue for built-ins', async () => {
  assert.match(mgr, /useBuiltin/); assert.match(mgr, /fromBuiltin/);
  assert.match(mgr, /if \(ub0 && !tp0\) \{ if \(trial\) toast\(TRIAL_MSG, true\); else useBuiltinOnArrival\(ub0\); \}/);
  assert.match(mgr, /typeof TEMPLATES !== "undefined"/);
  assert.match(mgr, /\(my copy\)/);
  const sa = read('public/store-api.js');
  assert.match(sa, /from\("studio_layout_template_versions"\)\.select\("id,version_no,name,created_at,created_by"\)/);
  assert.doesNotMatch(mgr, /\.style\.|innerHTML/);
});

await t('6 migration 0310 / APPLY / MANIFEST', async () => {
  const m = read('supabase/migrations/0310_r89_template_versions.sql'), a = read('supabase/APPLY-0310.sql'), man = read('supabase/migrations/MANIFEST');
  for (const s of [m, a]) assert.ok(!/[^\x00-\x7f]/.test(s), 'ASCII only');
  assert.match(m, /create table if not exists public\.studio_layout_template_versions/);
  assert.match(m, /grant select on table public\.studio_layout_template_versions to authenticated/);
  assert.doesNotMatch(m, /grant (insert|update|delete|all)[^;]*authenticated/i);
  assert.match(m, /before update or delete on public\.studio_layout_template_versions/);
  assert.match(m, /after insert or update of data on public\.studio_layout_templates/);
  assert.match(m, /new\.data is not distinct from old\.data then return null/);
  assert.match(m, /where not exists \(select 1 from public\.studio_layout_template_versions v where v\.template_id = t\.id\)/);
  assert.doesNotMatch(m, /\b(drop table|truncate|delete from)\b/i);
  assert.match(man, /forward  supabase\/migrations\/0310_r89_template_versions\.sql/);
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /VERIFY/);
});

console.log('r89-layout-templates: ' + n + ' passed');
