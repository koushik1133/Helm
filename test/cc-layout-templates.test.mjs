// Control Center > Layout templates (fix/cc-layout-templates):
//   1 cards without a stored picture draw a preview from the layout JSON (core previewShapes + SVG)
//   2 "Edit layout" -> builder tplEdit uses the template's own hall (scale.worldFt on SQL-seeded samples),
//     "Done" returns to the Layout templates section (control-split #ltemplates alias)
//   3 free-trial studio: only Use / Open in builder - no New / Edit / Rename / Duplicate / Archive / Default
//   4 archived templates (0175 archives "Demo - Corporate - Theatre/conference") never listed in a trial
// Runs the real studio-templates.js manager in a tiny fake DOM, for a PAID and a TRIAL studio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const tick = async (k = 8) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 5)); };

// ---- tiny fake DOM ------------------------------------------------------------------------------
class El {
  constructor(tag, ns) { this.tag = tag; this.ns = ns || null; this.children = []; this.attrs = {}; this.ls = {}; this.parentNode = null; this._t = ''; this._cls = new Set(); this.hidden = false; }
  get className() { return [...this._cls].join(' '); } set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() { const s = this._cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), toggle: (c, on) => (on ?? !s.has(c)) ? s.add(c) : s.delete(c) }; }
  setAttribute(k, v) { if (k === 'class') this.className = v; else this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'checked') this.checked = true; }
  getAttribute(k) { return k === 'class' ? this.className : (k in this.attrs ? this.attrs[k] : null); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; }
  replaceChild(nw, old) { const i = this.children.indexOf(old); if (i < 0) throw new Error('not a child'); nw.parentNode = this; old.parentNode = null; this.children[i] = nw; return old; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get childNodes() { return this.children; }
  set textContent(v) { this._t = String(v); this.children.forEach((c) => { c.parentNode = null; }); this.children = []; }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }
  click() { (this.ls.click || []).forEach((f) => f({ type: 'click', target: this, preventDefault() {} })); }
  focus() {}
  closest() { return null; }
}
const txt = (s) => ({ textContent: String(s), children: [], parentNode: null });
const all = (node, pred, out = []) => { for (const c of node.children || []) { if (c instanceof El && pred(c)) out.push(c); all(c, pred, out); } return out; };
const labels = (node) => all(node, (e) => e.tag === 'button' || e.tag === 'a').map((e) => e.textContent);

function boot({ trial }) {
  const doc = { readyState: 'complete', body: new El('body'), getElementById: () => null, querySelectorAll: () => [],
    createElement: (tg) => new El(tg), createElementNS: (ns, tg) => new El(tg, ns), createTextNode: txt, addEventListener() {} };
  const SEED = { items: [
    { x: 56, y: 1, type: 'stage', color: '#2f6fed', width: 76, height: 15, category: 'structure', rotation: 0 },
    { x: 110, y: 46, type: 'seatblock', color: '#0d9488', width: 60, height: 48, category: 'seating', rotation: 0 },
    { x: 84, y: 111, type: 'fountain', color: 'red;background:url(x)', width: 6, height: 6, category: 'decor', rotation: 450 },
    { x: 33, y: 29, type: 'dj', width: 8, height: 5, category: 'av', rotation: 300 }],
    scale: { pxPerFt: 12, worldFt: { w: 200, h: 140 } }, venue: { capacity: 450 } };
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Demo · Wedding — Grand Lawn (450+ guests)', event_type: 'wedding', thumbnail: null, is_default: false, archived: false, updated_at: 'a' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Studio rounds', event_type: 'corporate', thumbnail: 'data:image/jpeg;base64,AAAA', is_default: true, archived: false, updated_at: 'b' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Demo · Corporate — Theatre/conference', event_type: 'conference', thumbnail: null, is_default: false, archived: true, updated_at: 'c' }];
  const calls = { get: 0, writes: [] };
  const cx = { document: doc, console, setTimeout, clearTimeout, URLSearchParams, URL, Promise };
  cx.window = cx; cx.globalThis = cx;
  cx.location = { search: '', hash: '', href: 'https://x.test/control.html' };
  cx.BPStore = {
    auth: { role: async () => 'admin', user: () => ({ id: 'u' }) },
    subscription: { trial: async () => ({ state: trial ? 'trial' : 'none', status: trial ? 'trial' : 'active' }) },
    layoutTemplates: {
      list: async (o) => rows.filter((r) => (o && o.all) || !r.archived),
      get: async (id) => { calls.get++; const r = rows.find((x) => x.id === id); return r ? { ...r, data: SEED } : null; },
      save: async () => { calls.writes.push('save'); }, duplicate: async () => { calls.writes.push('dup'); },
      setArchived: async () => { calls.writes.push('arch'); }, setDefault: async () => { calls.writes.push('def'); } },
  };
  vm.createContext(cx);
  vm.runInContext(read('public/studio-templates-core.js'), cx);
  vm.runInContext(read('public/studio-templates.js'), cx);
  return { cx, doc, calls };
}
const CC_OPTS = { newHref: 'builder.html?new=1&tplEdit=new', editHref: (r) => 'builder.html?new=1&tplEdit=' + r.id, useHref: (r) => 'builder.html?new=1&useTpl=' + r.id };

const C = (() => { const g = { window: {} }; g.globalThis = g; vm.createContext(g); vm.runInContext(read('public/studio-templates-core.js'), g); return g.window.HelmStudioTemplatesCore; })();

await t('core roomOf: own data.room first, then scale.worldFt, then venue.room, else null', () => {
  assert.deepEqual({ ...C.roomOf({ room: { w: 90, h: 60 }, scale: { worldFt: { w: 200, h: 140 } } }) }, { w: 90, h: 60 });
  assert.deepEqual({ ...C.roomOf({ scale: { worldFt: { w: 200, h: 140 } }, venue: { room: { w: 1, h: 1 } } }) }, { w: 200, h: 140 });
  assert.deepEqual({ ...C.roomOf({ venue: { room: { w: 170, h: 150 } } }) }, { w: 170, h: 150 });
  assert.equal(C.roomOf({ room: { w: 0, h: 10 } }), null); assert.equal(C.roomOf(null), null); assert.equal(C.roomOf([]), null);
});
await t('core fitToHall: a SQL-seeded sample (scale.worldFt only) keeps its positions in the same-size hall', () => {
  const data = { items: [{ x: 10, y: 10, width: 20, height: 10 }], scale: { worldFt: { w: 200, h: 140 } } };
  const r = C.fitToHall(data, { w: 200, h: 140 }, 1000);
  assert.equal(r.scaled, false); assert.equal(r.items[0].x, 10); assert.equal(r.items[0].width, 20);
  assert.deepEqual({ ...r.from }, { w: 200, h: 140 });
});
await t('core previewShapes: safe colours, normalised rotation, round items, big first, capped', () => {
  const P = C.previewShapes({ items: [
    { x: 0, y: 0, width: 2, height: 2, type: 'table', color: '#ABCDEF' },
    { x: 5, y: 5, width: 50, height: 20, type: 'stage', color: 'url(javascript:1)', category: 'structure', rotation: -90 },
    { x: 1, y: 1, width: 0, height: 3 }, null, 'x',
    { x: 9, y: 9, width: 3, height: 3, type: 'table', properties: { shape: 'square' } }], room: { w: 100, h: 50 } });
  assert.equal(P.w, 100); assert.equal(P.h, 50); assert.equal(P.rects.length, 3, 'zero-size / junk items dropped');
  assert.equal(P.rects[0].w, 50, 'largest first'); assert.equal(P.rects[0].fill, '#2f6fed', 'bad colour -> category colour'); assert.equal(P.rects[0].rot, 270);
  const tbl = P.rects.find((q) => q.w === 2); assert.equal(tbl.fill, '#abcdef'); assert.equal(tbl.round, true);
  assert.equal(P.rects.find((q) => q.w === 3).round, false, 'square table stays a rectangle');
  const many = C.previewShapes({ items: Array.from({ length: 30 }, (_, i) => ({ x: i, y: 0, width: 1, height: 1 })) }, 10);
  assert.equal(many.rects.length, 10); assert.equal(many.more, 20);
  const ext = C.previewShapes({ items: [{ x: 250, y: 10, width: 10, height: 10 }], room: { w: 200, h: 140 } });
  assert.equal(ext.w, 260, 'objects past the saved hall still fit the preview');
  assert.equal(C.previewShapes({ items: [] }).rects.length, 0);
});

await t('PAID studio: full manager, generated preview for the seeded template, archived hidden until ticked', async () => {
  const { cx, doc, calls } = boot({ trial: false });
  const root = new El('div'); doc.body.appendChild(root);
  cx.HelmStudioTemplates.renderManager(root, CC_OPTS); await tick();
  const L = labels(root);
  assert.ok(L.includes('+ New template')); assert.ok(L.includes('Edit layout')); assert.ok(L.includes('Rename'));
  assert.ok(L.includes('Duplicate')); assert.ok(L.includes('Archive')); assert.ok(L.includes('Set default') || L.includes('Unset default'));
  assert.ok(L.includes('Open in builder'));
  assert.ok(all(root, (e) => e.tag === 'input' && e.attrs.type === 'checkbox').length === 1, 'Show archived checkbox');
  assert.doesNotMatch(root.textContent, /Theatre\/conference/, 'archived hidden by default');
  const svgs = all(root, (e) => e.tag === 'svg');
  assert.equal(svgs.length, 1, 'one generated preview (the other card has a stored picture)');
  assert.equal(svgs[0].ns, 'http://www.w3.org/2000/svg'); assert.equal(svgs[0].attrs.viewBox, '0 0 200 140');
  assert.ok(svgs[0].classList.contains('st-thumb') && svgs[0].classList.contains('st-gen'));
  const shapes = all(svgs[0], (e) => e.tag === 'rect' || e.tag === 'ellipse');
  assert.equal(shapes.length, 5, 'hall outline + 4 items'); assert.ok(shapes.some((e) => e.tag === 'ellipse'), 'fountain drawn round');
  assert.ok(shapes.every((e) => /^(#[0-9a-f]{3,6}|none)$/.test(e.attrs.fill)), 'only plain hex fills');
  assert.ok(shapes.some((e) => e.attrs.transform === 'rotate(300 37 31.5)'), 'rotation about the item centre');
  assert.equal(all(root, (e) => e.tag === 'img').length, 1, 'stored picture still used');
  assert.equal(all(root, (e) => e.classList.contains('st-nothumb')).length, 0, 'no grey placeholder left');
  const edit = all(root, (e) => e.tag === 'a' && e.textContent === 'Edit layout')[0];
  assert.equal(edit.attrs.href, 'builder.html?new=1&tplEdit=11111111-1111-4111-8111-111111111111');
  // ticking Show archived shows the archived one (paid studios can restore)
  const chk = all(root, (e) => e.tag === 'input')[0]; (chk.ls.change || []).forEach((f) => f({ target: { checked: true } })); await tick();
  assert.match(root.textContent, /Theatre\/conference/); assert.ok(labels(root).includes('Restore'));
  const before = calls.get; cx.HelmStudioTemplates.renderManager(root, CC_OPTS); await tick();
  assert.ok(calls.get - before <= 1, 'layout data cached between repaints');
});

await t('TRIAL studio: only Open in builder, sample names, no archived, no Show archived, no writes', async () => {
  const { cx, doc, calls } = boot({ trial: true });
  const root = new El('div'); doc.body.appendChild(root);
  cx.HelmStudioTemplates.renderManager(root, CC_OPTS); await tick();
  const L = labels(root);
  for (const b of ['+ New template', 'Edit layout', 'Rename', 'Duplicate', 'Archive', 'Restore', 'Set default', 'Unset default']) assert.ok(!L.includes(b), 'trial must not show ' + b);
  assert.equal(L.filter((x) => x === 'Open in builder').length, 2);
  assert.equal(all(root, (e) => e.tag === 'input').length, 0, 'no Show archived in a trial');
  assert.doesNotMatch(root.textContent, /Theatre\/conference/, 'archived sample never listed');
  assert.match(root.textContent, /Wedding — Grand Lawn/); assert.doesNotMatch(root.textContent, /Demo ·/, 'sample names without the Demo prefix');
  assert.match(root.textContent, /Free trial: these sample layouts are ready to use/);
  assert.equal(all(root, (e) => e.tag === 'svg').length, 1, 'trial cards get the generated preview too');
  assert.deepEqual(calls.writes, []);
  // the builder "Save as template" entry refuses in a trial
  cx.HelmStudioTemplates.openSave(); assert.equal(all(doc.body, (e) => e.attrs.id === 'stSaveModal').length, 0);
});

await t('wiring: builder trial gate, useTpl, seeded hall, Done link, control-split alias, pages load the CSS', () => {
  const st = read('public/studio-templates.js'), cs = read('public/control-split.js'), css = read('public/studio-templates.css');
  assert.match(st, /bSave\.hidden = !perm\.manage \|\| B\.ro\(\)/);
  assert.match(st, /if \(tp && perm\.trial\) toast\(TRIAL_MSG, true\);\s*else if \(tp && perm\.manage\) tplEditMode/);
  assert.match(st, /else if \(use && \/\^\[0-9a-f-\]\{36\}\$\/i\.test\(use\)\) useOnArrival\(use\)/);
  assert.match(st, /var room = C\.roomOf\(editing\.data\) \|\| \{\}/);
  assert.match(st, /href: "control\.html#layout-templates", text: "Done"/);
  assert.match(st, /t && t\.status === "trial"/);
  assert.match(cs, /"#ltemplates":"ltemplates"/);
  assert.match(css, /\.st-thumb\.st-gen\{/); assert.match(css, /\.st-trial\{/);
  assert.doesNotMatch(st, /innerHTML|insertAdjacentHTML|outerHTML/);
});

console.log('cc-layout-templates: ok (' + n + ')');
