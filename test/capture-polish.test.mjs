// capture-polish: 3D capture framing math, panel re-fit, friendly audit diffs, recents dedupe, design page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; };

const { frameBox } = require('../public/capture-frame.js');
t('frameBox: every bbox corner projects inside ~85% of a 16:9 frame, and one touches the edge', () => {
  const box = { min: [-60, 0, -40], max: [60, 6, 40] }, o = { fovDeg: 48, aspect: 16 / 9, fill: 0.85 };
  const f = frameBox(box, o);
  assert.deepEqual(f.target, [0, 3, 0]);
  const fw = f.dir.map((x) => -x), r0 = [-fw[2], 0, fw[0]], rl = Math.hypot(r0[0], r0[2]), r = [r0[0] / rl, 0, r0[2] / rl];
  const u = [r[1] * fw[2] - r[2] * fw[1], r[2] * fw[0] - r[0] * fw[2], r[0] * fw[1] - r[1] * fw[0]];
  const tv = Math.tan(24 * Math.PI / 180), th = tv * 16 / 9; let maxFill = 0;
  for (let i = 0; i < 8; i++) {
    const p = [(i & 1 ? 60 : -60) - f.position[0], (i & 2 ? 6 : 0) - f.position[1], (i & 4 ? 40 : -40) - f.position[2]];
    const z = p[0] * fw[0] + p[1] * fw[1] + p[2] * fw[2]; assert.ok(z > 0);
    const x = Math.abs(p[0] * r[0] + p[2] * r[2]) / z / th, y = Math.abs(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / z / tv;
    assert.ok(x <= 0.8501 && y <= 0.8501); maxFill = Math.max(maxFill, x, y);
  }
  assert.ok(maxFill > 0.84, 'tight framing ' + maxFill);
  const el = Math.asin(f.dir[1]) * 180 / Math.PI; assert.ok(el > 34 && el < 41, 'elevated ~38deg');
});
t('frameBox: bigger layout -> farther camera; tiny box respects minDist', () => {
  const a = frameBox({ min: [-20, 0, -20], max: [20, 4, 20] }), b = frameBox({ min: [-80, 0, -80], max: [80, 4, 80] });
  assert.ok(b.distance > a.distance * 3);
  assert.equal(frameBox({ min: [0, 0, 0], max: [0, 0, 0] }, { minDist: 20 }).distance, 20);
});
t('capture3D uses the framing helper, hides grid/edge, 2x supersample, restores state', () => {
  const js = read('public/builder-3d.js');
  assert.match(js, /HelmCaptureFrame\.frameBox/); assert.match(js, /SS=2/); assert.match(js, /edge\.visible=false/);
  assert.match(js, /ACESFilmicToneMapping/); assert.match(js, /keep\.labels\.forEach/);
  const html = read('public/builder.html');
  assert.match(html, /capture-frame\.js\?v=1"><\/script>\n<script src="builder-3d\.js\?v=5"/);
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
