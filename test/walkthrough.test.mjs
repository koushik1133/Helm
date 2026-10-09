// Venue walkthrough: stop generation, keys, reduced motion, capture host exclusion, wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(rd('public/capture-frame.js'), cx);
cx.window.HelmCaptureFrame = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
vm.runInContext(rd('public/walkthrough.js'), cx);
const WT = cx.window.HelmWalkthrough;
const hall = { w: 200, h: 140 };
const it = (type, x, y, w, h, props, extra) => Object.assign({ id: type + x + y, type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});
const tables = Array.from({ length: 14 }, (_, i) => it('table', 30 + (i % 7) * 20, 60 + Math.floor(i / 7) * 20, 6, 6, { seats: i < 7 ? 8 : 7 }));
const full = [it('stage', 70, 10, 60, 24), it('exit', 95, 136, 10, 4), it('redcarpet', 97, 100, 6, 30), ...tables,
  it('dancefloor', 80, 40, 40, 16), it('buffet', 170, 60, 20, 6), it('bar', 10, 110, 20, 5), it('photobooth', 170, 110, 10, 10),
  it('fountain', 10, 10, 8, 8), it('ledscreen', 20, 10, 20, 2)];
const S = WT.walkthroughStops(full, hall);
const keys = S.map((s) => s.key);
assert.deepEqual([...keys], ['overview', 'entrance', 'aisle', 'seating', 'stage', 'dancefloor', 'dining', 'bar', 'photobooth', 'fountain', 'screen', 'final']);
const seat = S.find((s) => s.key === 'seating');
assert.equal(seat.title, 'Guest seating'); assert.equal(seat.desc, '105 seats at 14 round tables');
for (const s of S) {
  assert.ok(s.title && s.desc, 'title + description: ' + s.key);
  if (s.key === 'overview' || s.key === 'final') { assert.ok(s.pos[1] > 40, 'overview is high'); continue; }
  assert.ok(Math.abs(s.pos[1] - WT.EYE) < 1e-6, 'eye level 1.6 m: ' + s.key);
  assert.ok(Math.abs(s.pos[0]) <= 100 && Math.abs(s.pos[2]) <= 70, 'camera inside hall: ' + s.key + ' ' + s.pos);
  assert.ok(Math.hypot(s.pos[0] - s.target[0], s.pos[2] - s.target[2]) > 1, 'looks at something: ' + s.key);
}
// stage stop sits in front (+z) of the stage, looking at it
const st = S.find((s) => s.key === 'stage'); assert.ok(st.pos[2] > st.target[2]);
// entrance uses the exit item (bottom edge)
assert.ok(S[1].pos[2] > 50);
// missing zones are skipped; no final overview for a tiny layout
const few = WT.walkthroughStops([it('stage', 70, 10, 60, 24)], hall).map((s) => s.key);
assert.deepEqual([...few], ['overview', 'entrance', 'stage', 'final']);
assert.deepEqual([...WT.walkthroughStops([], hall).map((s) => s.key)], ['overview', 'entrance']);
// no stage, no exit: entrance at the bottom edge, inside the hall
const e2 = WT.walkthroughStops([it('bar', 10, 10, 10, 4)], hall)[1]; assert.equal(e2.pos[2], 68);
// garbage-tolerant
assert.doesNotThrow(() => WT.walkthroughStops([null, {}, { type: 'table' }], {}));
// keys + reduced motion
assert.equal(WT.walkKey('ArrowRight'), 'next'); assert.equal(WT.walkKey('ArrowLeft'), 'prev');
assert.equal(WT.walkKey('Escape'), 'exit'); assert.equal(WT.walkKey('a'), null);
assert.equal(WT.flightMs(true), 0); assert.equal(WT.flightMs(false), 1200);
assert.equal(WT.ease(0), 0); assert.equal(WT.ease(1), 1); assert.ok(Math.abs(WT.ease(0.5) - 0.5) < 1e-9);
assert.ok(WT.eveningLightPoints(full, hall).length <= 8);
// capture host must not load the walkthrough; builder must
const b = rd('public/builder.html'), c = rd('public/capture.html');
assert.match(b, /<script src="walkthrough\.js\?v=\d+"><\/script>/); assert.match(b, /walkthrough\.css\?v=\d+/);
assert.doesNotMatch(c, /walkthrough/);
assert.match(b, /builder-3d\.js\?v=13/);
const b3 = rd('public/builder-3d.js');
assert.match(b3, /window\.__helm3D=/); assert.match(b3, /if\(ev\) setEvening\(false\)/, 'evening is off during client capture');
const w = rd('public/walkthrough.js');
assert.doesNotMatch(w, /innerHTML|insertAdjacentHTML/); assert.doesNotMatch(w, /store\.items\s*=|commit\(/, 'never writes the layout');
assert.match(w, /helm-capture/, 'UI is inert inside the capture host');

// ---- prod findings (80x50 reception) ----
const h2 = { w: 80, h: 50 };
const rec = [it('stage', 25, 2, 30, 10), it('ledscreen', 30, 1, 20, 1), it('podium', 20, 6, 3, 3), it('dancefloor', 30, 16, 20, 12),
  ...Array.from({ length: 14 }, (_, i) => it('table', 4 + (i % 7) * 11, 31 + Math.floor(i / 7) * 9, 6, 6, { seats: 8 }, { label: 'T' + (i + 1) })),
  it('exit', 38, 48, 4, 2), it('exit', 0, 25, 2, 4)];
// overview framing: hall floor box projected spans ~80% on the binding axis (both via frameBox and fallback)
const proj = (v, aspect, fov) => { const f = [v.target[0] - v.pos[0], v.target[1] - v.pos[1], v.target[2] - v.pos[2]]; const fl = Math.hypot(...f); f.forEach((_, i) => { f[i] /= fl; });
  let r = [-f[2], 0, f[0]]; const rl = Math.hypot(r[0], r[2]); r = [r[0] / rl, 0, r[2] / rl]; const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const t = Math.tan(fov * Math.PI / 360); let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
  for (const [x, z] of [[-40, -25], [40, -25], [-40, 25], [40, 25]]) { const q = [x - v.pos[0], -v.pos[1], z - v.pos[2]]; const d = q[0] * f[0] + q[1] * f[1] + q[2] * f[2];
    const px = (q[0] * r[0] + q[2] * r[2]) / d / (t * aspect), py = (q[0] * u[0] + q[1] * u[1] + q[2] * u[2]) / d / t;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
  return Math.max((x1 - x0) / 2, (y1 - y0) / 2); };
for (const a of [16 / 9, 1.3, 0.8]) {
  const v = WT.overviewView(h2, a, 48, 0.8), e = proj(v, a, 48);
  assert.ok(e > 0.7 && e < 0.9, 'overview fills ~80% at aspect ' + a + ': ' + e);
  assert.ok(v.pos[1] > 0 && v.pos[0] > 0 && v.pos[2] > 0, 'three-quarter, elevated');
}
const ov2 = WT.walkthroughStops(rec, h2, { aspect: 16 / 9 })[0];
assert.equal(ov2.view, 'overview'); assert.ok(proj(ov2, 16 / 9, ov2.fov) > 0.7, 'overview stop framed');
const saveCF = cx.window.HelmCaptureFrame; cx.window.HelmCaptureFrame = undefined;
const fb = WT.overviewView(h2, 16 / 9, 48, 0.8), fe = proj(fb, 16 / 9, 48); cx.window.HelmCaptureFrame = saveCF;
assert.ok(fe > 0.6 && fe < 0.95, 'fallback framing fills most of the view: ' + fe);
// clearance nudge
const tbl = [it('table', 40, 20, 6, 6)];
assert.equal(WT.isClear({ x: 43, y: 23 }, tbl), false); assert.equal(WT.isClear({ x: 43, y: 30 }, tbl), true);
const n1 = WT.clearSpot({ x: 43, y: 23 }, { x: 43, y: 0 }, tbl, h2);
assert.ok(WT.isClear(n1, tbl), 'nudged out'); assert.ok(n1.y > 23, 'backs away from the look target first');
assert.deepEqual({ ...WT.clearSpot({ x: 10, y: 10 }, null, tbl, h2) }, { x: 10, y: 10 }, 'already clear: unchanged');
assert.ok(WT.isClear({ x: 40, y: 22 }, [it('dancefloor', 30, 16, 20, 12)]), 'walkable floor items do not block');
const n2 = WT.clearSpot({ x: 3, y: 23 }, { x: 40, y: 23 }, [it('table', 0, 20, 8, 6)], h2);
assert.ok(n2.x >= 2 && n2.x <= 78 && n2.y >= 2 && n2.y <= 48 && WT.isClear(n2, [it('table', 0, 20, 8, 6)]), 'stays inside the hall');
// every eye-level stop of the reception layout is >= 2 ft off any footprint, wider FOV, labels hidden
const RS = WT.walkthroughStops(rec, h2, { aspect: 16 / 9 });
for (const s of RS) {
  if (s.view === 'overview') { assert.equal(WT.stopShowsLabels(s), true); continue; }
  assert.equal(s.fov, 65); assert.equal(WT.stopShowsLabels(s), false, 'tags hidden at eye level: ' + s.key);
  const p = { x: s.pos[0] + 40, y: s.pos[2] + 25 };
  assert.ok(WT.isClear(p, rec), 'camera clear of footprints: ' + s.key + ' ' + JSON.stringify(p));
}
assert.equal(WT.stopShowsLabels(RS[1], true), true); assert.equal(WT.stopShowsLabels(RS[0], false), false, 'user toggle wins');
// entrance: from the exit opposite the stage, looking slightly down toward the stage
const en = RS.find((s) => s.key === 'entrance');
assert.ok(en.pos[2] > 15, 'entrance near the far edge'); assert.ok(en.target[1] < en.pos[1], 'looks slightly downward');
assert.ok(en.target[2] < en.pos[2], 'faces the stage');
assert.match(b3, /setLabelsHidden/); assert.match(b3, /updateProjectionMatrix/);
console.log('walkthrough: ok');
