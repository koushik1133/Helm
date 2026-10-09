// Venue walkthrough: stop generation, keys, reduced motion, capture host exclusion, wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
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
assert.match(b, /builder-3d\.js\?v=12/);
const b3 = rd('public/builder-3d.js');
assert.match(b3, /window\.__helm3D=/); assert.match(b3, /if\(ev\) setEvening\(false\)/, 'evening is off during client capture');
const w = rd('public/walkthrough.js');
assert.doesNotMatch(w, /innerHTML|insertAdjacentHTML/); assert.doesNotMatch(w, /store\.items\s*=|commit\(/, 'never writes the layout');
assert.match(w, /helm-capture/, 'UI is inert inside the capture host');
console.log('walkthrough: ok');
