// capture-polish: 3D capture framing math, panel re-fit, friendly audit diffs, recents dedupe, design page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; };

const { frameBox } = require('../public/capture-frame.js');
const { projectBox, labelWorldHeight } = require('../public/capture-frame.js');
for (const [name, box, aspect] of [['wide hall', { min: [-60, 0, -40], max: [60, 6, 40] }, 16 / 9],
  ['deep hall', { min: [-20, 0, -90], max: [25, 10, 70] }, 16 / 9], ['off-centre cluster', { min: [30, 0, 10], max: [70, 4, 35] }, 16 / 9],
  ['square frame', { min: [-50, 0, -50], max: [50, 8, 50] }, 1]]) {
  t('frameBox: ' + name + ' - projected 8 corners within [5%,95%], binding extent >= 85%', () => {
    const o = { fovDeg: 48, aspect, fill: 0.88, elevationDeg: 38, azimuthDeg: 35 };
    const f = frameBox(box, o), P = projectBox(box, f, o);
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const [nx, ny, z] of P) {
      assert.ok(z > 0, 'in front of camera');
      const fx = (nx + 1) / 2, fy = (ny + 1) / 2;
      assert.ok(fx >= 0.05 && fx <= 0.95 && fy >= 0.05 && fy <= 0.95, name + ' corner at ' + fx.toFixed(3) + ',' + fy.toFixed(3));
      x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy);
    }
    assert.ok(Math.max(x1 - x0, y1 - y0) >= 0.85, 'tight framing ' + (x1 - x0) + ' x ' + (y1 - y0));
    assert.ok(Math.abs((x0 + x1) / 2 - 0.5) < 0.01 && Math.abs((y0 + y1) / 2 - 0.5) < 0.01, 'centred');
    const el = Math.asin(f.dir[1]) * 180 / Math.PI; assert.ok(el >= 35 && el <= 40, 'elevated ~38deg');
  });
}
t('labelWorldHeight scales with framed distance (constant fraction of image height)', () => {
  assert.ok(Math.abs(labelWorldHeight(200, 48, 0.03) / labelWorldHeight(100, 48, 0.03) - 2) < 1e-9);
  assert.ok(Math.abs(labelWorldHeight(100, 90, 0.5) - 100) < 1e-9);
});
t('frameBox: bigger layout -> farther camera; tiny box respects minDist', () => {
  const a = frameBox({ min: [-20, 0, -20], max: [20, 4, 20] }), b = frameBox({ min: [-80, 0, -80], max: [80, 4, 80] });
  assert.ok(b.distance > a.distance * 3);
  assert.equal(frameBox({ min: [0, 0, 0], max: [0, 0, 0] }, { minDist: 20 }).distance, 20);
});
t('capture3D uses the framing helper, hides grid/edge, 2x supersample, restores state', () => {
  const js = read('public/builder-3d.js');
  assert.match(js, /HelmCaptureFrame\.frameBox/); assert.match(js, /SS=2/); assert.match(js, /edge\.visible=false/);
  assert.match(js, /renderMode=false; applyProfile\(\);\n      scene\.background=new THREE\.Color\('#e9ecf2'\)/);
  const cap = js.slice(js.indexOf('async function capture3D'), js.indexOf('window.__capture3D='));
  assert.doesNotMatch(cap, /ACESFilmic|toneMappingExposure|multiplyScalar\(0\.72\)|sun\.intensity=1|hemi\.intensity=0/); assert.match(js, /keep\.labels\.forEach/);
  const html = read('public/builder.html');
  assert.match(html, /capture-frame\.js\?v=12"><\/script>\n<script src="builder-3d\.js\?v=13"/);
});
t('panel toggle re-fits the 2D plan only while at fit zoom', () => {
  const js = read('public/builder.js');
  assert.match(js, /function setZoom\(z, anchor\)\{\n  viewAtFit=false;/);
  assert.match(js, /viewAtFit=true;/);
  assert.match(js, /if\(viewAtFit && !is3DActive\(\)\) fitView\(\)/);
});

const CF = require('../public/capture-frame.js');
for (const [name, objs, fw, fh] of [['200x140 hall, 18 objects clustered', { min: [-70, 0, -40], max: [60, 12, 55] }, 200, 140],
  ['objects past the floor', { min: [-110, 0, -20], max: [30, 8, 20] }, 200, 140], ['empty hall', null, 120, 80], ['narrow hall', { min: [-5, 0, -60], max: [5, 6, 60] }, 30, 150]]) {
  t('R4 floor framing: ' + name + ' - all 8 union corners inside [4%,96%], fills >= 85%', () => {
    const u = CF.unionFloor(objs, fw, fh, 1);
    assert.ok(u.min[0] <= -fw / 2 && u.max[0] >= fw / 2 && u.min[2] <= -fh / 2 && u.max[2] >= fh / 2, 'union covers the floor');
    if (objs) assert.ok(u.min[0] <= objs.min[0] && u.max[2] >= objs.max[2] && u.max[1] >= objs.max[1], 'union covers objects');
    const o = { fovDeg: 48, aspect: 16 / 9, fill: 0.88, elevationDeg: 38, azimuthDeg: 35, minDist: 20 };
    const f = CF.frameBox(u, o), P = CF.projectBox(u, f, o);
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const [nx, ny, z] of P) { assert.ok(z > 0);
      const fx = (nx + 1) / 2, fy = (ny + 1) / 2;
      assert.ok(fx >= 0.04 && fx <= 0.96 && fy >= 0.04 && fy <= 0.96, name + ' corner ' + fx.toFixed(3) + ',' + fy.toFixed(3));
      x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); }
    assert.ok(Math.max(x1 - x0, y1 - y0) >= 0.85, 'layout still as large as possible');
  });
}
t('R4 labels: screen-constant size (scale proportional to depth, cap height ~1.7% of image)', () => {
  const near = CF.labelScaleForDepth(100, 48, 0.017, 2.5), far = CF.labelScaleForDepth(300, 48, 0.017, 2.5);
  assert.ok(Math.abs(far / near - 3) < 1e-9, 'front and back labels render the same size');
  const capFrac = (2.5 * near * CF.LABEL_CAP_RATIO) / (2 * 100 * Math.tan(24 * Math.PI / 180));
  assert.ok(capFrac >= 0.016 && capFrac <= 0.018, 'cap height ' + capFrac);
});
t('R4 labels: overlap + nearby-duplicate culling keeps the nearest', () => {
  const L = [{ text: 'Exit', x: 0, y: 0, w: 0.1, h: 0.03 }, { text: 'Exit', x: 0.05, y: 0.02, w: 0.1, h: 0.03 },
    { text: 'Bar', x: 0.01, y: 0.005, w: 0.1, h: 0.03 }, { text: 'Bar', x: 0.5, y: 0.5, w: 0.1, h: 0.03 }, { text: 'Exit', x: -0.6, y: 0, w: 0.1, h: 0.03 }];
  assert.deepEqual(CF.pickLabels(L), [0, 3, 4]);
});
t('R5 capture3D: frames floor union, trims ground, hides name tags for badges + legend, restores', () => {
  const cap = read('public/builder-3d.js');
  assert.match(cap, /HelmCaptureFrame\.unionFloor\(/); assert.match(cap, /CF\.numberItems\(store\.items\)/);
  assert.match(cap, /CF\.layoutBadges\(anchors, br, \{w:RW, h:H\}\)/); assert.match(cap, /CF\.drawLegend\(ctx, num\.legend, RW, 0, W-RW, H\)/);
  assert.match(cap, /aspect:RW\/H/); assert.match(cap, /b\.legend=/); assert.match(cap, /ground\.scale\.copy\(keep\.groundScale\)/);
  assert.match(cap, /o\.visible=v;/); assert.doesNotMatch(cap, /labelWorldHeight\(fr\.distance/);
});
t('R4 builder: neutral loading state while an existing event loads (no blank-floor flash)', () => {
  const js = read('public/builder.js'), html = read('public/builder.html');
  assert.match(html, /id="layoutLoading"[^>]*hidden>/);
  assert.match(js, /es\.hidden = layoutLoading \|\| RO/);
  assert.match(js, /if\(quoteId \|\| evId\) setLayoutLoading\(true\);/);
  assert.match(js, /if\(layoutLoading\) setLayoutLoading\(false\);[^\n]*\n  populateRefEvents\(\);/);
  assert.ok(js.indexOf('setLayoutLoading(true)') < js.indexOf('renderAll();\n  fitView();'), 'set before the first render');
  assert.match(js, /pn\.placeholder='Loading…'/);
});

const A = require('../public/audit-format.js');
const line = (k, o, nw) => A.describeUpdate({ [k]: [o, nw] }).lines[0].text;
t('audit: friendly wording, no raw JSON', () => {
  assert.equal(A.inr(147500), '₹1,47,500'); assert.equal(A.inr(1200060), '₹12,00,060');
  assert.equal(line('pricing', { other: 0, total: 147500 }, { other: 0, total: 1200060 }), 'Total ₹1,47,500 → ₹12,00,060');
  assert.equal(line('client', {}, { name: 'John Doe', email: 'j@x.in' }), 'Client set to John Doe');
  assert.equal(line('client', { name: 'A', phone: '1', city: 'X' }, { name: 'A', phone: '2', city: 'Y', guests: 50 }), 'Client details changed: phone, city, guests');
  assert.equal(line('lifecycle_stage', 'resources', 'proposal'), 'Stage: Resources → Proposal');
  assert.equal(line('current_version', 4, 5), 'Saved version 5');
  assert.equal(line('event_date', null, '2026-10-30'), 'Event date set to 30 Oct 2026');
  assert.equal(line('event_type', 'X', 'Corporate Annual Gala'), 'Event type: Corporate Annual Gala');
  const long = line('venue_notes', 'a', 'x'.repeat(200));
  assert.match(long, /^Venue notes: a → x+…$/); assert.ok(long.length < 90);
  assert.equal(A.describeUpdate({ a: [1, 2], b: [1, 2], c: [1, 2], d: [1, 2], e: [1, 2], f: [1, 2] }).more, 1);
  for (const l of [line('pricing', { total: 1 }, { total: 2 }), line('client', {}, { name: 'Z' })]) assert.doesNotMatch(l, /[{}"]/);
});
t('audit.html loads the formatter and uses it for updates', () => {
  const h = read('public/audit.html');
  assert.match(h, /<script src="audit-format\.js\?v=2"><\/script>/); assert.match(h, /AuditFormat\.describeUpdate\(c,5\)/);
});

globalThis.window = undefined;
const T = require('../public/nav-trail.js');
t('recents: one entry per record (builder/flow/event of a quote share a key)', () => {
  const id = '932994a4-330b-4c1a-9a2b-000000000001';
  assert.equal(T.recKey('builder.html?quote=' + id), 'quote:' + id);
  assert.equal(T.recKey('flow.html?quote=' + id), 'quote:' + id);
  assert.equal(T.recKey('event.html?id=' + id), 'quote:' + id);
  assert.equal(T.recKey('client.html?id=c1'), 'client:c1');
  assert.equal(T.recKey('dashboard.html'), 'dashboard.html');
});
t('flow + client pages record recents with kind and title', () => {
  assert.match(read('public/flow.html'), /HelmTrail\.setCurrent\(\{title:\[ev\.code,ev\.title\][^}]*kind:"quote",href:"flow\.html\?quote="/);
  assert.match(read('public/client.js'), /setCurrent\(\{ title: model\.client\.name, kind: "client", href: "client\.html\?id="/);
  assert.match(read('public/store-api.js'), /NAV_TRAIL_VERSION = "3"/);
});
t('design.html: code · title heading, builder/quote links, stage hints', () => {
  const h = read('public/design.html');
  assert.match(h, /"Design — "\+name/); assert.match(h, /Open floor builder/); assert.match(h, />Open quote</);
  assert.match(h, /approved_2d:"the floor plan is signed off internally; next build the 3D view"/);
  assert.doesNotMatch(h, /esc\(rec\.event_code\|\|rec\.quote_id\)/);
});
const items = [
  { id: 'a', label: 'Speaker Stack', x: 150, y: 10, width: 4, height: 4, type: 'speaker' },
  { id: 'b', label: 'LED Screen', x: 80, y: 2, width: 30, height: 2, type: 'screen' },
  { id: 'c', label: 'Speaker Stack', x: 40, y: 10, width: 4, height: 4, type: 'speaker' },
  { id: 'd', label: 'Exit', x: 0, y: 130, width: 6, height: 2, type: 'exit' },
  { id: 'e', label: ' Exit ', x: 190, y: 130, width: 6, height: 2, type: 'exit' },
  { id: 'f', label: 'Block A', x: 50, y: 50, width: 40, height: 30, type: 'seatblock' },
  { id: 'g', label: '', x: 5, y: 5, width: 2, height: 2, type: 'table' }];
t('R5 numbering: same name -> same number, back-to-front then left-to-right, deterministic', () => {
  const r = CF.numberItems(items);
  // R10: seating is in the legend — chair blocks as "Guest seating — N seats"; an unnamed table without seats still gets none
  assert.deepEqual(r.legend, [{ n: 1, name: 'LED Screen', count: 1 }, { n: 2, name: 'Speaker Stack', count: 2 }, { n: 3, name: 'Guest seating', count: 1, seats: 0 }, { n: 4, name: 'Exit', count: 2 }]);
  assert.equal(r.byId.get('a'), r.byId.get('c')); assert.equal(r.byId.get('d'), r.byId.get('e'));
  assert.ok(r.byId.has('f') && !r.byId.has('g'), 'seat block badged; unnamed seatless table gets no marker');
  const r2 = CF.numberItems(items.slice().reverse());
  assert.deepEqual(r2.legend, r.legend); assert.deepEqual([...r2.byId].sort(), [...r.byId].sort());
});
t('R5 badges: clustered anchors never overlap after layout, stay in bounds, near dup dropped', () => {
  const A = []; for (let i = 0; i < 30; i++) A.push({ n: i + 1, x: 500 + (i % 5) * 3, y: 300 + Math.floor(i / 5) * 2 });
  A.push({ n: 1, x: 501, y: 300 }); A.push({ n: 2, x: 2, y: 2 }); A.push({ n: 3, x: 2, y: 3 });
  const r = 12, P = CF.layoutBadges(A, r, { w: 1536, h: 1080 });
  assert.equal(P.length, 32, 'only the same-number duplicate right next to its twin is dropped');
  for (let i = 0; i < P.length; i++) { assert.ok(P[i].x >= r && P[i].x <= 1536 - r && P[i].y >= r && P[i].y <= 1080 - r);
    for (let j = i + 1; j < P.length; j++) assert.ok(Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) >= 2 * r - 1e-6, 'overlap ' + i + ',' + j); }
  assert.deepEqual(CF.layoutBadges(A, r, { w: 1536, h: 1080 }), P, 'deterministic');
});
t('R5 legend: rows fit the panel, wraps into 2 columns when many', () => {
  const mk = (k) => Array.from({ length: k }, (_, i) => ({ n: i + 1, name: 'Item number ' + (i + 1) + ' with a long descriptive name', count: i % 3 + 1 }));
  const one = CF.legendLayout(mk(8), 384, 1080), two = CF.legendLayout(mk(60), 384, 1080);
  assert.equal(one.cols, 1); assert.equal(two.cols, 2); assert.equal(two.rows.length, 60);
  for (const L of [one, two]) for (const R of L.rows) {
    assert.ok(R.x >= 0 && R.x + L.colW <= 384 + 1e-6 && R.y >= L.titleH && R.y + L.rowH <= 1080, 'row inside panel');
    const lines = R.lines || [R.text], f = R.lines && R.lines.length > 1 ? Math.max(9, Math.round(L.font * 0.86)) : L.font;   // R10: long names wrap to 2 lines
    for (const ln of lines) assert.ok(ln.length * f * 0.56 + L.badgeR * 2 + L.font * 0.6 <= L.colW + 1, 'text fits column: ' + ln); }
  assert.match(one.rows.find(R => R.n === 2).text, /×2$/);
  const sp = CF.legendSplit(1920); assert.equal(sp.renderW + sp.panelW, 1920); assert.equal(sp.panelW, 384);
});
t('R5 2D clean plan: name text removed, same numbering + legend panel', () => {
  const js = read('public/builder.js');
  assert.match(js, /if\(CF\) clone\.querySelectorAll\('text\.lbl'\)\.forEach\(n=>n\.remove\(\)\)/);
  assert.match(js, /CF\.numberItems\(store\.items\)/); assert.match(js, /CF\.drawLegend\(ctx, num\.legend, pw, 0, panel, ph\)/);
});
console.log('capture-polish: ' + n + ' passed');
