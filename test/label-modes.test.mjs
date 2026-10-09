// 0083 label modes: None | Numbers | Names for the builder's live 3D view, the client pictures
// (2D + 3D captured in all three styles) and the booklet's picture toggle.
//  * capture-frame.js: labelMode / snapKind / layoutTags (name tags never overlap, stay in bounds)
//  * store-api.js: snapshot kinds 2d|3d[_none|_names] only; snapshotInfo lists variants
//  * builder: Labels segmented control, remembered choice, capture3D(w,{labels}), planBlob labels, all variants uploaded
//  * booklet.js: toggle only for captured variants, default Numbers, instant switch, lightbox follows
//  * edge function + 0083 SQL: kinds allow-listed, tenant-scoped; APPLY-0083 pure ASCII with verify rows
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const CF = createRequire(import.meta.url)('../public/capture-frame.js');

t('labelMode: only none|numbers|names, default numbers', () => {
  assert.equal(CF.labelMode('none'), 'none'); assert.equal(CF.labelMode('NAMES'), 'names');
  assert.equal(CF.labelMode('x'), 'numbers'); assert.equal(CF.labelMode(undefined), 'numbers');
  assert.deepEqual([...CF.LABEL_MODES], ['none', 'numbers', 'names']);
});
t('snapKind: numbers keeps the original kind; variants suffixed', () => {
  assert.equal(CF.snapKind('3d', 'numbers'), '3d'); assert.equal(CF.snapKind('2d'), '2d');
  assert.equal(CF.snapKind('3d', 'none'), '3d_none'); assert.equal(CF.snapKind('2d', 'names'), '2d_names');
  assert.equal(CF.snapKind('evil', 'none'), '2d_none');
});
t('layoutTags: overlapping tags pushed apart, inside bounds, duplicates dropped', () => {
  const A = []; for (let i = 0; i < 12; i++) A.push({ x: 100 + (i % 3), y: 100 + (i % 2), w: 60, h: 14, text: 'T' + i });
  A.push({ x: 100, y: 100, w: 60, h: 14, text: 'T0' });   // same text, same spot -> dropped
  const P = CF.layoutTags(A, { w: 400, h: 300 }, { gap: 2 });
  assert.equal(P.length, 12);
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    assert.ok(p.x - p.w / 2 >= 0 && p.x + p.w / 2 <= 400 && p.y - p.h / 2 >= 0 && p.y + p.h / 2 <= 300, 'in bounds');
    for (let j = i + 1; j < P.length; j++) { const q = P[j];
      const ox = (p.w + q.w) / 2 - Math.abs(p.x - q.x), oy = (p.h + q.h) / 2 - Math.abs(p.y - q.y);
      assert.ok(ox <= 0.5 || oy <= 0.5, 'tags ' + i + '/' + j + ' overlap'); }
  }
  assert.equal(CF.layoutTags([{ x: NaN, y: 1, w: 5, h: 5, text: 'x' }, { x: 1, y: 1, w: 0, h: 5, text: 'y' }], { w: 10, h: 10 }).length, 0);
});

t('store-api: only the six kinds are accepted; variants listed and passed through', () => {
  const s = read('public/store-api.js');
  assert.match(s, /const SNAP_KINDS = \["2d", "3d", "2d_none", "3d_none", "2d_names", "3d_names"\];/);
  assert.match(s, /if \(!SNAP_KINDS\.includes\(kind\)\) throw new Error\("Unknown snapshot kind\."\);/);
  assert.match(s, /\/\^\(\(\?:2d\|3d\)\(\?:_none\|_names\)\?\)\\\.\(png\|jpg\|webp\)\$\//);
  assert.match(s, /p_kind: SNAP_KINDS\.includes\(kind\) \? kind : "2d"/);
  assert.match(s, /"&k=" \+ \(SNAP_KINDS\.includes\(kind\) \? kind : "2d"\)/);
});
t('builder: Labels None | Numbers | Names control in the 3D toolbar + legend card', () => {
  const h = read('public/builder.html');
  assert.match(h, /<span class="labels3d" id="labels3d" role="group" aria-label="Labels">[\s\S]*data-l="none"[\s\S]*data-l="numbers"[\s\S]*data-l="names"[\s\S]*<\/span>\s*<\/div>\s*<div class="legend3d" id="legend3d" hidden/);
  assert.match(h, /builder\.js\?v=18/); assert.match(h, /builder-3d\.js\?v=9/); assert.match(h, /capture-frame\.js\?v=5/); assert.match(h, /builder\.css\?v=10/);
  assert.match(read('public/builder.css'), /\.legend3d\[hidden\]\{display:none\}/);
});
t('builder-3d: live mode remembered (try/catch), badges + legend in Numbers, capture honours opts.labels', () => {
  const d = read('public/builder-3d.js');
  assert.match(d, /try\{ const v=localStorage\.getItem\('bps\.labels3d'\);/);
  assert.match(d, /try\{ localStorage\.setItem\('bps\.labels3d',liveLabels\); \}catch\(_\)\{\}/);
  assert.match(d, /lp\.visible=liveLabels==='names'/);
  assert.match(d, /const n=liveLabels==='numbers' \? num\.byId\.get\(it\.id\) : null;/);
  assert.match(d, /async function capture3D\(maxW, opts\)\{\n    const CF=window\.HelmCaptureFrame, mode=CF\.labelMode\(opts && opts\.labels\);/);
  assert.match(d, /const RW=mode==='numbers' \? CF\.legendSplit\(W\)\.renderW : W;/);
  assert.match(d, /if\(o\.userData\.badge \|\| mode==='none'\) return;/);
  assert.match(d, /else if\(mode==='names'\) CF\.drawNameTags\(ctx, tags,/);
  assert.ok(!/innerHTML/.test(d.slice(d.indexOf('function renderLegendCard'), d.indexOf('function setLiveLabels'))), 'legend card via textContent');
});
t('builder.js: planBlob labels option; Update client images uploads all three styles, numbers first', () => {
  const b = read('public/builder.js');
  assert.match(b, /const LM=CF \? CF\.labelMode\(o\.labels\) : 'numbers';/);
  assert.match(b, /panel=CF && LM==='numbers' \? Math\.round\(pw\*0\.25\) : 0;/);
  assert.match(b, /await window\.__capture3D\(1920,\{labels:m\}\)/);
  const i2 = b.indexOf("await BPStore.booklet.uploadSnapshot(qid,'2d',p2.numbers);"), iv = b.indexOf("await BPStore.booklet.uploadSnapshot(qid,kind('2d',m),p2[m]);");
  assert.ok(i2 > 0 && iv > i2, 'originals uploaded before the variants');
  assert.match(b, /catch\(e\)\{ console\.warn\('client image variant skipped'\); break; \}/);
});

// booklet toggle: a tiny DOM good enough for el()/snapFigure
function fakeDoc() {
  const mk = (tag) => { const n = { tagName: tag.toUpperCase(), children: [], attrs: {}, listeners: {}, className: '', textContent: '', parentNode: null,
    classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); },
    fire(e) { (this.listeners[e] || []).slice().forEach((f) => f({ stopPropagation() {} })); },
    all() { return this.children.flatMap((c) => [c, ...c.all()]); },
    querySelectorAll(sel) { if (sel === 'button') return this.all().filter((x) => x.tagName === 'BUTTON');
      const m = /^\[data-l="(\w+)"\]$/.exec(sel); return m ? this.all().filter((x) => x.attrs['data-l'] === m[1]) : []; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; } };
    return n; };
  return { createElement: mk, getElementById: () => null, createTextNode: (s) => ({ textContent: s }), body: mk('body') };
}
const ctx = { console, URLSearchParams, document: fakeDoc() };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const B = ctx.HelmBooklet;
const U = (k) => 'https://x.test/fn/booklet-snapshot?t=tok&k=' + k;
t('booklet snapUrl / snapVariants: only captured variants, numbers = original', () => {
  const d = { snapshots: { '3d': U('3d'), '3d_none': U('3d_none'), '3d_names': false, '2d': U('2d') } };
  assert.equal(B.snapUrl(d, 'layout3d', 'none'), U('3d_none'));
  assert.equal(B.snapUrl(d, 'layout3d', 'names'), null);
  assert.equal(B.snapUrl(d, 'layout3d'), U('3d'));
  assert.deepEqual(JSON.parse(JSON.stringify(B.snapVariants(d, 'layout3d').map((v) => v.mode))), ['none', 'numbers']);
  assert.equal(B.snapVariants(d, 'layout2d').length, 1);   // old booklet: one picture -> no toggle
  assert.equal(B.snapUrl({ snapshots: { layout3d: U('3d') } }, 'layout3d', 'none'), null, 'legacy key never serves a variant');
});
t('booklet toggle: default Numbers, instant switch, lightbox follows, hidden with one picture', () => {
  const d = { snapshots: { '3d': U('3d'), '3d_none': U('3d_none'), '3d_names': U('3d_names') } };
  const fig = ctx.document.createElement('figure');
  B.snapFigure(fig, U('3d'), '3D view', () => {}, B.snapVariants(d, 'layout3d'));
  const bar = fig.children[0], zoom = fig.children[1], img = zoom.children[0];
  assert.equal(bar.className, 'snap-labels'); assert.equal(bar.attrs['aria-label'], 'Labels');
  const btns = bar.querySelectorAll('button');
  assert.deepEqual(btns.map((b) => b.textContent), ['None', 'Numbers', 'Names']);
  assert.equal(img.attrs.src, U('3d')); assert.equal(btns[1].attrs['aria-pressed'], 'true');
  btns[2].fire('click');
  assert.equal(img.attrs.src, U('3d_names')); assert.equal(btns[2].attrs['aria-pressed'], 'true'); assert.equal(btns[1].attrs['aria-pressed'], 'false');
  const lbImg = ctx.document.createElement('img'), lbWrap = ctx.document.createElement('div'); let opened = false;
  const dlg = { open: false, showModal() { opened = true; }, querySelector: (q) => (q === '.lb-img' ? lbImg : lbWrap) };
  ctx.document.getElementById = (id) => (id === 'bkLightbox' ? dlg : null);
  zoom.fire('click');
  assert.ok(opened); assert.equal(lbImg.attrs.src, U('3d_names'), 'lightbox shows the chosen variant');
  ctx.document.getElementById = () => null;
  // a missing variant drops its option and returns to the numbered picture
  btns[0].fire('click'); img.fire('error');
  assert.equal(img.attrs.src, U('3d')); assert.equal(bar.querySelectorAll('button').length, 2);
  // one picture only -> no toggle
  const fig2 = ctx.document.createElement('figure');
  B.snapFigure(fig2, U('3d'), '3D view', () => {}, B.snapVariants({ snapshots: { '3d': U('3d') } }, 'layout3d'));
  assert.equal(fig2.children.length, 1); assert.equal(fig2.children[0].className, 'snap-zoom');
});
t('booklet: render wiring passes the variants; versions bumped; print hides toggle', () => {
  const j = read('public/booklet.js');
  assert.match(j, /snapVariants\(d, "layout2d"\)\); return; \}/); assert.match(j, /snapVariants\(d, "layout3d"\)\); return; \}/);
  assert.match(j, /zoom\.addEventListener\("click", \(\) => openLightbox\(cur, alt\)\)/);
  assert.ok(!/innerHTML/.test(j.slice(j.indexOf("function snapVariants"), j.indexOf("function openLightbox"))));
  for (const p of ['public/booklet.html', 'public/event.html', 'public/client.html', 'public/flow.html']) assert.match(read(p), /booklet\.js\?v=12/, p);
  assert.match(read('public/booklet.html'), /booklet\.css\?v=3/);
  assert.match(read('public/booklet.css'), /\.snap-labels\{display:none\}/);
});
t('share checklist attaches the builder variants with the stored pictures', () => {
  const s = read('public/share-checklist.js');
  assert.match(s, /function variantKinds\(base\) \{ return base === "3d" \? \["3d_none", "3d_names"\] : \["2d_none", "2d_names"\]; \}/);
  assert.match(s, /await B\.attachSnapshot\(quoteId, v, x\.path\); \} catch \(e\) \{ return; \}/);
});
t('edge function + 0083: kinds allow-listed, tenant path, APPLY pure ASCII with verify rows', () => {
  const f = read('supabase/functions/booklet-snapshot/index.ts');
  assert.match(f, /const KINDS = new Set\(\["2d", "3d", "2d_none", "3d_none", "2d_names", "3d_names"\]\);/);
  assert.match(f, /!KINDS\.has\(kind\)/); assert.match(f, /\(2d\|3d\)\(_none\|_names\)\?\\\.\(png\|jpg\|webp\)\$\//);
  assert.match(f, /!p\.includes\("\/" \+ kind \+ "\."\)/);
  const m = read('supabase/migrations/0083_snapshot_label_variants.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0083_snapshot_label_variants\.sql/);
  assert.match(m, /add column if not exists snap_variants jsonb not null default/);
  assert.ok(!/\b(delete from|drop table|truncate)\b/i.test(m), 'never deletes data');
  assert.match(m, /coalesce\(p_kind, ''\) in \('2d', '3d', '2d_none', '3d_none', '2d_names', '3d_names'\)/);
  const a = read('supabase/APPLY-0083.sql');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(a), 'APPLY-0083 pure ASCII');
  assert.match(a, /select item, ok from \(values/);
});

t('DASHBOARD-PASTE.ts matches index.ts: same kinds, path regex, checks; self-contained', () => {
  const f = read('supabase/functions/booklet-snapshot/index.ts'), p = read('supabase/functions/booklet-snapshot/DASHBOARD-PASTE.ts');
  const grab = (s, re) => { const m = re.exec(s); assert.ok(m, String(re)); return m[0]; };
  for (const re of [/const PATH = .*;/, /const KINDS = .*;/, /const TYPES: .*;/, /const MAX = .*;/, /if \(!UUID_RE\.test\(token\).*/, /if \(!PATH\.test\(p\).*/, /Deno\.env\.get\("HELM_BOOKLET_SNAPSHOT_ENABLED"\) !== "true"/])
    assert.equal(grab(p, re), grab(f, re));
  const tail = (s) => s.slice(s.indexOf('Deno.serve('));
  assert.equal(tail(p), tail(f), 'handler body identical');
  assert.ok(!/from "\.\.\//.test(p), 'no ../_shared imports');
  assert.match(p, /Function name: booklet-snapshot/); assert.match(p, /turn OFF "Verify JWT"/); assert.match(p, /HELM_BOOKLET_SNAPSHOT_ENABLED = true/);
});
console.log('label-modes: ' + n + ' passed');
