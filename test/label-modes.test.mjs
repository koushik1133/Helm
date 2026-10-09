// 0083 label modes + database pictures.
//  * builder live 3D view keeps None | Numbers | Names (capture-frame labelMode / layoutTags)
//  * client pictures: 2D + 3D in two styles, 'labels' (numbered badges + legend) and 'plain',
//    stored IN THE DATABASE (booklet_put_image), JPEG <= 1600 px; no edge function needed
//  * booklet.js: "With labels | Without labels" toggle only when both exist, lazy per-picture RPC,
//    lightbox follows, hidden in print
//  * share-checklist: per-section style toggles; missing pictures block the share with
//    "Open builder to capture"; styles saved on the link
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const T = []; const t = (name, fn) => T.push([name, fn]);
const CF = createRequire(import.meta.url)('../public/capture-frame.js');

t('labelMode: only none|numbers|names, default numbers', () => {
  assert.equal(CF.labelMode('none'), 'none'); assert.equal(CF.labelMode('NAMES'), 'names');
  assert.equal(CF.labelMode('x'), 'numbers'); assert.equal(CF.labelMode(undefined), 'numbers');
  assert.deepEqual([...CF.LABEL_MODES], ['none', 'numbers', 'names']);
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

t('store-api: database picture API (put / info / staff preview / styles / public reader)', () => {
  const s = read('public/store-api.js');
  assert.match(s, /const BOOKLET_IMG_KINDS = \["2d", "3d"\], BOOKLET_IMG_VARIANTS = \["labels", "plain"\], BOOKLET_IMG_MAX = 1536 \* 1024;/);
  assert.match(s, /rpc\("booklet_put_image", \{ p_quote_id: quoteId, p_kind: kind, p_variant: variant, p_mime: enc\.mime, p_data: enc\.data \}\)/);
  assert.match(s, /rpc\("public_get_booklet_image", \{ p_token: String\(token\), p_kind: kind, p_variant: variant \}\)\.then\(bookletDataUrl\)/);
  assert.match(s, /rpc\("booklet_set_image_variants"/); assert.match(s, /rpc\("booklet_image_info"/); assert.match(s, /rpc\("booklet_staff_image"/);
  assert.match(s, /maxW = Math\.max\(200, Math\.min\(4000, Number\(maxW\) \|\| 1600\)\); q = Math\.max\(0\.5, Math\.min\(0\.95, Number\(q\) \|\| 0\.85\)\);/);
  assert.match(s, /cv\.toBlob\(\(x\) => res\(x\), "image\/jpeg", q\)/);
  assert.ok(!/2d_none|3d_names|SNAP_KINDS = \[/.test(s), 'old variant kinds gone');
});
t('store-api bookletDataUrl: only jpeg/png/webp + base64 characters', () => {
  const s = read('public/store-api.js');
  const src = s.slice(s.indexOf('  const BOOKLET_IMG_KINDS'), s.indexOf('  // blob / canvas -> {mime'));
  const f = new Function(src + '; return bookletDataUrl;')();
  assert.equal(f({ mime: 'image/jpeg', data: '/9j/4AAQ' }), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(f({ mime: 'image/svg+xml', data: 'PHN2Zz4=' }), null);
  assert.equal(f({ mime: 'image/png', data: 'abc"><script>' }), null);
  assert.equal(f(null), null); assert.equal(f({ mime: 'image/png', data: '' }), null);
});
t('builder: Labels None | Numbers | Names control in the 3D toolbar + legend card', () => {
  const h = read('public/builder.html');
  assert.match(h, /<span class="labels3d" id="labels3d" role="group" aria-label="Labels">[\s\S]*data-l="none"[\s\S]*data-l="numbers"[\s\S]*data-l="names"[\s\S]*<\/span>\s*<\/div>\s*<div class="legend3d" id="legend3d" hidden/);
  assert.match(h, /builder\.js\?v=33/); assert.match(h, /builder-3d\.js\?v=13/); assert.match(h, /capture-frame\.js\?v=12/); assert.match(h, /builder\.css\?v=10/);
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
t('builder.js: Update client images stores 2D + 3D, with and without labels, in the database', () => {
  const b = read('public/builder.js');
  assert.match(b, /const LM=CF \? CF\.labelMode\(o\.labels\) : 'numbers';/);
  assert.match(b, /const CLIENT_IMG_STYLES=\[\['labels','numbers'\],\['plain','none'\]\];/);
  assert.match(b, /await window\.__capture3D\(1600,\{labels:m\}\)/);
  assert.match(b, /for\(const \[k,pics\] of \[\['2d',p2\],\['3d',p3\]\]\)/);
  assert.match(b, /await BPStore\.booklet\.putImage\(qid,k,v,pics\[v\]\);/);
  assert.match(b, /const info=await BPStore\.booklet\.imageInfo\(qid\)\|\|\{\};/);
  assert.ok(!/uploadSnapshot|snapKind|2d_none/.test(b.slice(b.indexOf('client booklet images'), b.indexOf('function importJSON'))));
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
      return []; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; } };
    return n; };
  return { createElement: mk, getElementById: () => null, createTextNode: (s) => ({ textContent: s }), body: mk('body') };
}
const ctx = { console, URLSearchParams, document: fakeDoc() };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const B = ctx.HelmBooklet;
const IMG = { labels: 'data:image/jpeg;base64,/9j/AAAA', plain: 'data:image/jpeg;base64,/9j/BBBB' };
const tick = () => new Promise((r) => setTimeout(r, 0));
t('booklet dbImages: flags only, labels first', () => {
  const d = { images: { '3d': { labels: true, plain: true }, '2d': { labels: false, plain: true } } };
  assert.deepEqual(JSON.parse(JSON.stringify(B.dbImages(d, 'layout3d'))), [{ variant: 'labels', label: 'With labels' }, { variant: 'plain', label: 'Without labels' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(B.dbImages(d, 'layout2d').map((v) => v.variant))), ['plain']);
  assert.equal(B.dbImages({}, 'layout3d').length, 0); assert.equal(B.dbImages({ images: { '3d': 'x' } }, 'layout3d').length, 0);
  assert.ok(B.isDataImg(IMG.labels)); assert.ok(!B.isDataImg('https://x.test/a.png')); assert.ok(!B.isDataImg('data:image/svg+xml;base64,AAAA'));
  // visibleSections keeps a layout-less section that has database pictures
  assert.equal(B.visibleSections({ sections: { layout3d: true }, images: { '3d': { labels: true } } }).show.layout3d, true);
  assert.equal(B.visibleSections({ sections: { layout3d: true } }).show.layout3d, false);
});
t('booklet toggle: default With labels, lazy per picture, lightbox follows, one style = no toggle', async () => {
  const calls = [];
  ctx.BPStore = { booklet: { publicImage: (tok, k, v) => { calls.push([tok, k, v].join('/')); return Promise.resolve(IMG[v]); } } };
  const d = { __token: 'tok', images: { '3d': { labels: true, plain: true } } };
  const fig = ctx.document.createElement('figure');
  B.dbFigure(fig, d, '3d', B.dbImages(d, 'layout3d'), '3D view', () => { throw new Error('no fallback'); });
  await tick(); await tick();
  const bar = fig.children[0], zoom = fig.children[1], img = zoom.children[0];
  assert.equal(bar.className, 'snap-labels');
  const btns = bar.querySelectorAll('button');
  assert.deepEqual(btns.map((x) => x.textContent), ['With labels', 'Without labels']);
  assert.equal(img.attrs.src, IMG.labels); assert.equal(btns[0].attrs['aria-pressed'], 'true');
  assert.deepEqual(calls, ['tok/3d/labels'], 'only the shown picture is fetched');
  btns[1].fire('click'); await tick(); await tick();
  assert.equal(img.attrs.src, IMG.plain); assert.equal(btns[1].attrs['aria-pressed'], 'true'); assert.equal(btns[0].attrs['aria-pressed'], 'false');
  btns[0].fire('click'); await tick(); await tick();
  assert.equal(calls.length, 2, 'cached');
  btns[1].fire('click'); await tick(); await tick();
  const lbImg = ctx.document.createElement('img'), lbWrap = ctx.document.createElement('div'); let opened = false;
  const dlg = { open: false, showModal() { opened = true; }, querySelector: (q) => (q === '.lb-img' ? lbImg : lbWrap) };
  ctx.document.getElementById = (id) => (id === 'bkLightbox' ? dlg : null);
  zoom.fire('click');
  assert.ok(opened); assert.equal(lbImg.attrs.src, IMG.plain, 'lightbox shows the chosen style');
  ctx.document.getElementById = () => null;
  const fig2 = ctx.document.createElement('figure');
  B.dbFigure(fig2, d, '3d', [{ variant: 'plain', label: 'Without labels' }], '3D view', () => {});
  await tick(); await tick();
  assert.equal(fig2.children.length, 1); assert.equal(fig2.children[0].className, 'snap-zoom');
  // revoked / expired link -> null picture -> fallback (drawn plan)
  ctx.BPStore = { booklet: { publicImage: () => Promise.resolve(null) } };
  let fell = false; const fig3 = ctx.document.createElement('figure');
  B.dbFigure(fig3, d, '3d', B.dbImages(d, 'layout3d'), '3D view', () => { fell = true; });
  await tick(); await tick();
  assert.ok(fell); assert.equal(fig3.children.length, 0);
});
t('booklet: render wiring, versions bumped, print hides toggle, CSP allows data: images', () => {
  const j = read('public/booklet.js');
  assert.match(j, /dbFigure\(fig, d, "2d", dbImages\(d, "layout2d"\)/); assert.match(j, /dbFigure\(fig, d, "3d", dbImages\(d, "layout3d"\)/);
  assert.ok(!/innerHTML/.test(j.slice(j.indexOf("function dbImages"), j.indexOf("function openLightbox"))));
  for (const p of ['public/booklet.html', 'public/event.html', 'public/client.html', 'public/flow.html']) assert.match(read(p), /booklet\.js\?v=13/, p);
  assert.match(read('public/booklet.html'), /booklet\.css\?v=4/);
  assert.match(read('public/booklet.css'), /\.snap-labels\{display:none\}/); assert.match(read('public/booklet.css'), /\.snap-zoom\[hidden\]\{display:none\}/);
  const v = JSON.parse(read('vercel.json'));
  const csp = v.headers.filter((h) => /booklet/.test(h.source)).flatMap((h) => h.headers.filter((x) => x.key === 'Content-Security-Policy').map((x) => x.value));
  assert.ok(csp.length >= 3); csp.forEach((c) => assert.match(c, /img-src 'self' data:/));
});
t('share checklist: style toggles, missing pictures block the share, styles saved on the link', () => {
  const s = read('public/share-checklist.js');
  const cx = { console, URLSearchParams, document: null, location: { search: '' } }; cx.window = cx; cx.globalThis = cx;
  vm.createContext(cx); vm.runInContext(s, cx);
  const S = cx.HelmShareChecklist;
  const sec = { layout2d: true, layout3d: true };
  const info = { '2d': { labels: 't', plain: 't' }, '3d': { labels: 't' } };
  assert.deepEqual(JSON.parse(JSON.stringify(S.missingImages(sec, {}, info))), [{ section: 'layout3d', kind: '3d', variant: 'plain' }]);
  assert.equal(S.missingImages(sec, { layout3d: { plain: false } }, info).length, 0);
  assert.equal(S.missingImages({ layout2d: true, layout3d: false }, {}, info).length, 0, 'hidden section needs nothing');
  assert.equal(S.missingImages(sec, {}, {}).length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(S.variantFlags({ layout3d: { plain: false } }))), { '2d_labels': true, '2d_plain': true, '3d_labels': true, '3d_plain': false });
  assert.ok(!/Open builder to capture/.test(s), 'R8b: no manual "Open builder to capture" block');
  assert.match(s, /await B\.setImageVariants\(quoteId, variantFlags\(state\.variants\)\);/);
  assert.match(s, /const need = needsCapture\(sec, state\.variants, state\.info, state\.stale\);/);
  assert.ok(!/uploadSnapshot\(|rasterSvg|innerHTML/.test(s), 'no rough sketch upload, no innerHTML');
});
t('0083 SQL: database pictures, additive, tenant-scoped; APPLY pure ASCII with verify rows', () => {
  const m = read('supabase/migrations/0083_booklet_images.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0083_booklet_images\.sql/);
  assert.match(m, /create table if not exists public\.client_booklet_images/);
  assert.match(m, /alter table public\.client_booklet_images enable row level security;/);
  assert.match(m, /check \(bytes > 0 and bytes <= 1572864 and bytes = octet_length\(data\)\)/);
  assert.match(m, /v_org := public\._booklet_staff_quote\(p_quote_id, true\);/);
  assert.match(m, /public\.rate_hit\('booklet\.read', md5\('booklet:' \|\| p_token::text\), 600, 120\)/);
  assert.match(m, /alter function public\.public_get_booklet\(uuid\) rename to public_get_booklet__pre0083;/);
  assert.ok(!/\b(delete from|drop table|truncate|create temp)\b/i.test(m), 'never deletes data');
  assert.ok(!/snap_variants|2d_none|3d_names/.test(m), 'old variant kinds gone');
  const a = read('supabase/APPLY-0083.sql');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(a), 'APPLY-0083 pure ASCII');
  assert.match(a, /select item, ok from \(values/);
  assert.ok(a.includes(m.trim()), 'APPLY-0083 carries the migration verbatim');
});
t('edge function: legacy/optional, DASHBOARD-PASTE removed', () => {
  assert.ok(!existsSync(new URL('supabase/functions/booklet-snapshot/DASHBOARD-PASTE.ts', root)));
  const f = read('supabase/functions/booklet-snapshot/index.ts');
  assert.match(f, /LEGACY \/ OPTIONAL since 0083/);
  assert.match(f, /kind !== "2d" && kind !== "3d"/);
});
for (const [name, fn] of T) { await fn(); n++; console.log('  ✓ ' + name); }
console.log('label-modes: ' + n + ' passed');
