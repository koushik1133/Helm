// Venue walkaround: stop generation, captions, entrance, overview, keys, capture host exclusion, wiring.
// (R49: the deep checks - coverage proof, band framing, occlusion, flights, perf, UI - live in walkthrough-r49.test.mjs)
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
const S = WT.walkthroughStops(full, hall, { aspect: 16 / 9 });
const keys = S.map((s) => s.key);
// overview -> entrance -> a spatial route over every zone -> a final overview; every item shown exactly once
assert.equal(keys[0], 'overview'); assert.equal(keys[1], 'entrance'); assert.equal(keys[keys.length - 1], 'final');
for (const k of ['stage', 'dancefloor', 'dining', 'bar', 'photo', 'fountain', 'screen', 'seating']) assert.ok(keys.includes(k), 'has a ' + k + ' stop: ' + keys);
// R62: a red carpet / aisle is never a stop of its own - the overview shows it
assert.ok(!keys.some((k) => /^aisle/.test(k)), 'no aisle stop: ' + keys);
assert.ok(S[0].owns.includes(full[2].id), 'the overview owns the red carpet');
assert.equal(new Set(keys).size, keys.length, 'no stop twice');
const proof = WT.proveCoverage(S); assert.ok(proof.ok, proof.errors.join('\n')); assert.equal(proof.owned, full.length);
// count-first seating captions; guests add up to the seats once
const seat = S.filter((s) => s.key.startsWith('seating'));
assert.equal(seat.reduce((n, s) => n + s.guests, 0), 105);
for (const s of seat) assert.match(s.desc, /^\d+ round tables? · \d+ guests$/);
for (const s of S) {
  assert.ok(s.title && s.desc, 'title + description: ' + s.key);
  if (s.view === 'overview') { assert.ok(s.pos[1] > 40, 'overview is high'); assert.equal(s.target[1], 0, 'overview pivot on the floor'); continue; }
  assert.ok(s.pos[1] >= WT.EYE_MIN, 'never below 4 ft: ' + s.key);
  assert.ok(Math.abs(s.pos[0]) <= 100 && Math.abs(s.pos[2]) <= 70, 'camera inside hall: ' + s.key + ' ' + s.pos);
  assert.ok(Math.hypot(s.pos[0] - s.target[0], s.pos[2] - s.target[2]) > 1, 'looks at something: ' + s.key);
}
assert.deepEqual([...S.find((s) => s.key === 'stage').owns].sort(), [full[0].id], 'stage stop owns the stage');
// stage stop sits in front (+z) of the stage, looking at it; caption has no duplicate title
const st = S.find((s) => s.key === 'stage'); assert.ok(st.pos[2] > st.target[2]); assert.equal(st.title, 'Main stage'); assert.match(st.desc, /^60 × 24 ft stage/);
assert.equal(WT.walkthroughStops([Object.assign(it('stage', 70, 10, 60, 24), { label: 'Main Stage' })], hall)[2].title, 'Main stage', 'no "Main stage — Main Stage"');
assert.equal(WT.walkthroughStops([Object.assign(it('stage', 70, 10, 60, 24), { label: 'Sangeet stage' })], hall)[2].title, 'Sangeet stage');
// entrance uses the exit item (bottom edge)
assert.ok(S[1].pos[2] > 50);
// one zone: overview, entrance, the zone, a final overview from another angle
const few = WT.walkthroughStops([it('stage', 70, 10, 60, 24)], hall);
assert.deepEqual([...few.map((s) => s.key)], ['overview', 'entrance', 'stage', 'final']);
assert.ok(few[0].pos.some((v, i) => Math.abs(v - few[3].pos[i]) > 5), 'the final overview is not a repeat of the first');
// empty layout: one overview that says what to do
const em = WT.walkthroughStops([], hall); assert.deepEqual([...em.map((s) => s.key)], ['overview']); assert.match(em[0].desc, /add items/);
// no stage, no exit: entrance at the bottom edge, inside the hall
const e2 = WT.walkthroughStops([it('bar', 10, 10, 10, 4)], hall)[1]; assert.equal(e2.key, 'entrance'); assert.ok(e2.pos[2] > 67 && e2.pos[2] <= 68, 'back edge, 2 ft inside: ' + e2.pos);
// garbage-tolerant
assert.doesNotThrow(() => WT.walkthroughStops([null, {}, { type: 'table' }, 5, 'x'], {}));
// keys + reduced motion
assert.equal(WT.walkKey('ArrowRight'), 'next'); assert.equal(WT.walkKey('ArrowLeft'), 'prev'); assert.equal(WT.walkKey('Home'), 'first'); assert.equal(WT.walkKey('End'), 'last');
assert.equal(WT.walkKey(' '), 'toggle'); assert.equal(WT.walkKey('k'), 'toggle');
assert.equal(WT.walkKey('Escape'), 'exit'); assert.equal(WT.walkKey('a'), null);
for (const k of ['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'r', 'd']) assert.equal(WT.walkKey(k), 'block', k);
assert.equal(WT.walkKey('d', { metaKey: true }), 'block'); assert.equal(WT.walkKey('s', { metaKey: true }), null, 'Cmd+S still saves');
assert.equal(WT.flightMs(true), 0); assert.equal(WT.flightMs(false), 900);
assert.equal(WT.ease(0), 0); assert.equal(WT.ease(1), 1); assert.ok(Math.abs(WT.ease(0.5) - 0.5) < 1e-9);
assert.ok(WT.eveningLightPoints(full, hall).length <= 8);
// capture host must not load the walkthrough; builder must
const b = rd('public/builder.html'), c = rd('public/capture.html');
assert.match(b, /<script src="walkthrough\.js\?v=\d+"><\/script>/); assert.match(b, /walkthrough\.css\?v=\d+/);
assert.doesNotMatch(c, /walkthrough/);
assert.match(b, /builder-3d\.js\?v=\d+/);
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
  assert.ok(v.pos[1] > 0 && v.pos[0] > 0 && v.pos[2] > 0, 'three-quarter, elevated'); assert.equal(v.target[1], 0, 'orbit pivot on the floor, not underground');
}
const ov2 = WT.walkthroughStops(rec, h2, { aspect: 16 / 9 })[0];
assert.equal(ov2.view, 'overview'); assert.ok(proj(ov2, 16 / 9, ov2.fov) > 0.42, 'overview stop framed (in the band above the stop card)');
const ovFull = WT.walkthroughStops(rec, h2, { aspect: 16 / 9, band: { t: 0, b: 0, l: 0, r: 0 } })[0]; assert.ok(proj(ovFull, 16 / 9, ovFull.fov) > 0.6, 'no card: the overview fills the view');
const saveCF = cx.window.HelmCaptureFrame; cx.window.HelmCaptureFrame = Object.assign({}, saveCF, { frameBox: undefined });
const fb = WT.overviewView(h2, 16 / 9, 48, 0.8), fe = proj(fb, 16 / 9, 48); cx.window.HelmCaptureFrame = saveCF;
assert.ok(fe > 0.6 && fe < 0.95, 'fallback framing fills most of the view: ' + fe);
// every stop camera of the reception layout is clear of every solid; one FOV; tags hidden at eye level
const RS = WT.walkthroughStops(rec, h2, { aspect: 16 / 9 });
assert.ok(WT.proveCoverage(RS).ok, WT.proveCoverage(RS).errors.join('\n'));
for (const s of RS) {
  assert.equal(s.fov, WT.walkFov(16 / 9));
  if (s.view === 'overview') { assert.equal(WT.stopShowsLabels(s), true); continue; }
  assert.equal(WT.stopShowsLabels(s), false, 'tags hidden at eye level: ' + s.key);
  assert.ok(WT.camOK(s.pos, RS.index, 40, 25, s.key === 'entrance' ? new Set(s.owns) : null, s.pos[1] >= 12), 'camera clear of solids: ' + s.key);
}
assert.equal(WT.stopShowsLabels(RS[1], true), true); assert.equal(WT.stopShowsLabels(RS[0], false), false, 'user toggle wins');
// entrance: from the exit opposite the stage, at eye height, looking (near-)level toward the stage
const en = RS.find((s) => s.key === 'entrance');
assert.ok(en.pos[2] > 15, 'entrance near the far edge'); assert.ok(en.pos[1] >= WT.EYE && en.pos[1] <= 12, 'eye height, or a raised view right at the entry when tables crowd it');
const pitch = Math.atan2(en.target[1] - en.pos[1], Math.hypot(en.target[0] - en.pos[0], en.target[2] - en.pos[2])) * 180 / Math.PI;
assert.ok(pitch < -1.75 && pitch > -6, 'near-level, inside the normal orbit limit: ' + pitch);
assert.ok(en.target[2] < en.pos[2], 'faces the stage');
assert.match(b3, /setLabelsHidden/); assert.match(b3, /updateProjectionMatrix/);
console.log('walkthrough: ok');
