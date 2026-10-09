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
  assert.match(html, /capture-frame\.js\?v=2"><\/script>\n<script src="builder-3d\.js\?v=6"/);
});
t('panel toggle re-fits the 2D plan only while at fit zoom', () => {
  const js = read('public/builder.js');
  assert.match(js, /function setZoom\(z, anchor\)\{\n  viewAtFit=false;/);
  assert.match(js, /viewAtFit=true;/);
  assert.match(js, /if\(viewAtFit && !is3DActive\(\)\) fitView\(\)/);
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
  assert.match(h, /<script src="audit-format\.js\?v=1"><\/script>/); assert.match(h, /AuditFormat\.describeUpdate\(c,5\)/);
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
console.log('capture-polish: ' + n + ' passed');
