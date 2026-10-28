// Walkaround camera motion (R49): the eye and the head move separately (smootherstep, shortest yaw, clamped
// pitch, eye >= 4 ft), duration from distance + turn, a pausable frame-delta clock, Next mid-flight keeps its
// speed, reduced motion = instant cut, controls paused / clamps relaxed during a flight, normal 3D zoom.
// The old "swing over the top" for opposite-facing stops is GONE: it is a level turn now.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(rd('public/capture-frame.js'), cx);
cx.window.HelmCaptureFrame = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
vm.runInContext(rd('public/walkthrough.js'), cx);
const WT = cx.window.HelmWalkthrough;
const d = (v) => Math.hypot(v.pos[0] - v.target[0], v.pos[1] - v.target[1], v.pos[2] - v.target[2]);
const close = (a, b, eps = 1e-6) => a.every((x, i) => Math.abs(x - b[i]) < eps);
const deg = (r) => r * 180 / Math.PI;

// 1. endpoints exact; look distance monotonic; no per-frame spikes; never below 4 ft; pitch in [-80, 35]
const pairs = [
  [{ pos: [120, 160, 200], target: [0, 0, 0], fov: 55 }, { pos: [0, 5.25, 40], target: [0, 3, 10], fov: 55 }],   // overview -> eye
  [{ pos: [0, 5.25, 40], target: [0, 3, 10], fov: 55 }, { pos: [-60, 5.25, -20], target: [-60, 3, -50], fov: 55 }], // eye -> eye across hall
  [{ pos: [0, 5.25, 40], target: [0, 4, 0], fov: 55 }, { pos: [0, 5.25, -40], target: [0, 3, -80], fov: 55 }],    // opposite headings
  [{ pos: [10, 5, 10], target: [0, 3, 0], fov: 55 }, { pos: [180, 220, 260], target: [0, 0, 0], fov: 55 }],       // eye -> final overview
];
for (const [a, b] of pairs) {
  const P = WT.planFlight(a, b);
  const v0 = WT.viewAt(P, 0), v1 = WT.viewAt(P, 1);
  assert.ok(close(v0.pos, a.pos, 1e-6) && close(v0.target, a.target, 1e-6), 'starts exactly at from');
  assert.ok(close(v1.pos, b.pos) && close(v1.target, b.target), 'ends exactly at to');
  const N = 120, dir = Math.sign(d(b) - d(a)); let prev = d(v0), prevPos = v0.pos, maxJump = 0, lastYaw = WT.heading(v0).yaw, yawT = 0;
  for (let i = 1; i <= N; i++) {
    const v = WT.viewAt(P, i / N), dist = d(v), h = WT.heading(v);
    if (dir !== 0) assert.ok((dist - prev) * dir >= -1e-9, `look distance monotonic (${prev.toFixed(3)} -> ${dist.toFixed(3)})`);
    assert.ok(v.pos[1] >= WT.EYE_MIN - 1e-9 || v.pos[1] >= Math.min(a.pos[1], b.pos[1]) - 1e-9, 'never below 4 ft');
    assert.ok(h.pitch >= WT.PITCH_MIN - 1e-9 && h.pitch <= WT.PITCH_MAX + 1e-9, 'pitch clamped');
    assert.equal(v.fov, 55, 'constant FOV during the glide');
    maxJump = Math.max(maxJump, Math.hypot(...v.pos.map((x, k) => x - prevPos[k]))); prevPos = v.pos; prev = dist;
    const dy = Math.atan2(Math.sin(h.yaw - lastYaw), Math.cos(h.yaw - lastYaw)); assert.ok(Math.abs(dy) < 5 * Math.PI / 180, 'no yaw jump between frames'); yawT += dy; lastYaw = h.yaw;
  }
  // smootherstep peak speed is 1.875x the average: no frame moves more than ~2x the average step
  assert.ok(maxJump <= P.L / N * 2 + 1e-6, 'no per-frame position spike');
  const net = Math.atan2(Math.sin(WT.heading(b).yaw - WT.heading(a).yaw), Math.cos(WT.heading(b).yaw - WT.heading(a).yaw));
  assert.ok(Math.abs(Math.abs(yawT) - Math.abs(net)) < 0.02, 'turns the short way round');
}
{ // opposite headings: a level turn, never straight up / down (the old zenith flip)
  const [a, b] = pairs[2], P = WT.planFlight(a, b); let mx = 0;
  for (let i = 0; i <= 60; i++) mx = Math.max(mx, Math.abs(deg(WT.heading(WT.viewAt(P, i / 60)).pitch)));
  assert.ok(mx < 5, 'opposite-facing stops: level turn, pitch never beyond ' + mx.toFixed(1));
}
// eased: zero speed at both ends (smootherstep), C2
assert.equal(WT.ease(0), 0); assert.equal(WT.ease(1), 1); assert.ok(WT.ease(0.01) < 1e-4 && WT.ease(0.99) > 0.9999);
assert.ok(Math.abs(WT.ease(0.5) - 0.5) < 1e-12);
// retarget mid-flight: the new flight starts at the old speed (no brake to zero)
{ const e = WT.easeFrom(1.2); assert.ok(Math.abs((e(1e-4) - e(0)) / 1e-4 - 1.2) < 1e-3, 'starts at speed v0'); assert.equal(e(1), 1); }
// FOV interpolates (never jumps) when a stop does ask for a different one
const fv = WT.tweenView({ pos: [0, 10, 10], target: [0, 0, 0], fov: 48 }, { pos: [0, 10, 10], target: [0, 0, 0], fov: 65 }, 0.5);
assert.ok(fv.fov > 48 && fv.fov < 65);

// 2. every walkaround stop uses the same FOV (no zoom between overview and eye stops), chosen from the aspect
const it = (type, x, y, w, h) => ({ id: type + x + y, type, x, y, width: w, height: h, rotation: 0, properties: { seats: 8 } });
const items = [it('stage', 70, 10, 60, 24), it('exit', 95, 136, 10, 4), it('redcarpet', 97, 100, 6, 30), it('table', 40, 60, 6, 6), it('table', 140, 60, 6, 6),
  it('dancefloor', 80, 40, 40, 16), it('buffet', 170, 60, 20, 6), it('bar', 10, 110, 20, 5)];
for (const hall of [{ w: 200, h: 140 }, { w: 200, h: 200 }, { w: 300, h: 140 }]) for (const aspect of [16 / 9, 0.55]) {
  const S = WT.walkthroughStops(items, hall, { aspect });
  assert.ok(S.length >= 4);
  assert.deepEqual([...new Set(S.map((s) => s.fov))], [WT.walkFov(aspect)], 'one FOV for all stops ' + JSON.stringify(hall));
}
assert.equal(WT.walkFov(16 / 9), 55); assert.ok(WT.walkFov(0.55) > 69 && WT.walkFov(0.55) < 71, 'portrait phone: wider vertical FOV');

// 3. duration: reduced motion = instant; 0.9-4.2 s from distance and turn
assert.equal(WT.flightMs(true, 500), 0);
assert.equal(WT.flightMs(false), 900); assert.equal(WT.flightMs(false, 0), 900);
assert.ok(WT.flightMs(false, 50) > 900 && WT.flightMs(false, 50) < 4200);
assert.equal(WT.flightMs(false, 5000), 4200);
assert.ok(WT.flightMs(false, 100) < WT.flightMs(false, 150));
{ const turn = WT.planFlight({ pos: [0, 5, 0], target: [0, 5, -10] }, { pos: [0, 5, 0], target: [0, 5, 10] }); assert.ok(turn.ms >= 2400, 'a 180 deg turn in place takes its time (<= 70 deg/s): ' + turn.ms); }
assert.equal(WT.planFlight(pairs[0][0], pairs[0][1], { reduced: true }).ms, 0);

// 4. one cancellable, pausable flight: fake clock + frames
function fakeFrames() {
  let t = 0; const q = new Map(); let id = 0;
  return { now: () => t, raf: (f) => { q.set(++id, f); return id; }, caf: (i) => q.delete(i),
    tick(ms) { t += ms; const fs = [...q.values()]; q.clear(); fs.forEach((f) => f(t)); }, pending: () => q.size };
}
{
  const F = fakeFrames(); const seen = []; let done = 0;
  const a = { pos: [100, 100, 100], target: [0, 0, 0], fov: 55 }, b = { pos: [0, 5, 30], target: [0, 3, 0], fov: 55 };
  const fl = WT.createFlight({ from: a, to: b, ms: 1500, now: F.now, raf: F.raf, caf: F.caf, apply: (v) => seen.push(d(v)), done: () => done++ });
  for (let i = 0; i < 400 && F.pending(); i++) F.tick(16);
  assert.equal(done, 1, 'done once'); assert.equal(fl.active, false);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1] + 1e-9, 'flight look distance monotonic');
  assert.ok(Math.abs(seen[seen.length - 1] - d(b)) < 1e-9, 'lands exactly');
  // cancel mid-flight: no further frames, done never called
  const F2 = fakeFrames(); let applied = 0, done2 = 0;
  const f2 = WT.createFlight({ from: a, to: b, ms: 1500, now: F2.now, raf: F2.raf, caf: F2.caf, apply: () => applied++, done: () => done2++ });
  F2.tick(16); F2.tick(16); const n = applied; f2.cancel(); F2.tick(16); F2.tick(16);
  assert.equal(applied, n); assert.equal(done2, 0); assert.equal(F2.pending(), 0); assert.equal(f2.active, false);
  // ms 0 (reduced motion) = instant cut, synchronously, done() called, and no live flight left behind
  let cut = null, d3 = 0; const f3 = WT.createFlight({ from: a, to: b, ms: 0, now: F2.now, raf: F2.raf, caf: F2.caf, apply: (v) => { cut = v; }, done: () => d3++ });
  assert.ok(cut && close(cut.pos, b.pos)); assert.equal(d3, 1); assert.equal(f3.active, false);
  // a 5 s frame stall (hidden tab) advances the flight by at most 150 ms - no jump to the end
  const F4 = fakeFrames(); let last = null; const f4 = WT.createFlight({ from: a, to: b, ms: 1500, now: F4.now, raf: F4.raf, caf: F4.caf, apply: (v) => { last = v; } });
  F4.tick(16); F4.tick(5000); assert.ok(f4.active && d(last) > d(b) + 10, 'stall: no teleport');
  // pause / resume
  f4.pause(); const p0 = last.pos.slice(); F4.tick(16); F4.tick(16); assert.ok(close(last.pos, p0, 1e-9), 'paused: the camera holds');
  f4.resume(); F4.tick(16); F4.tick(16); assert.ok(!close(last.pos, p0, 1e-6), 'resumed');
  assert.ok(Array.isArray(f4.velocity()) && Math.hypot(...f4.velocity()) > 0, 'reports its speed for a smooth retarget');
}

// 5. key auto-repeat gate
{
  let t = 0; const g = WT.makeGate(WT.NAV_GAP_MS, () => t);
  assert.equal(g.allow(), true); t += 50; assert.equal(g.allow(), false); t += WT.NAV_GAP_MS; assert.equal(g.allow(), true);
}
// 6. dwell scales with the caption, overviews hold 5 s
assert.equal(WT.dwellMs({ view: 'overview', title: 'x', desc: 'y' }), 5000);
assert.ok(WT.dwellMs({ view: 'frame', title: 'Bar', desc: '1 bar counter' }) < WT.dwellMs({ view: 'frame', title: 'Guest seating · back-left', desc: '12 round tables · 2 long tables · 120 guests' }));
assert.ok(WT.dwellMs({ view: 'frame', title: 'x'.repeat(400), desc: '' }) <= 8000);

// 7. wiring: single flight, controls paused + clamps relaxed in flight, normal polar limit at rest, auto-play from arrival
const src = rd('public/walkthrough.js'), b3 = rd('public/builder-3d.js');
assert.doesNotMatch(src, /setInterval\(/, 'auto-play is not a fixed interval');
assert.match(src, /d\.timer = setTimeout\(dwellDone, ms\)/, 'dwell starts on arrival');
assert.match(src, /h\.setFlying\(true\)/); assert.match(src, /setWalkMode\(true\)/); assert.match(src, /setWalkMode\(false\)/);
assert.match(src, /apply: \(v\) => h\.setView\(v\.pos, v\.target, null, v\.fov\)/, 'no per-frame min-distance changes');
assert.match(b3, /setFlying\(on\)\{[^]*controls\.enabled=false; controls\.enableDamping=false; controls\.minDistance=0\.5; controls\.maxDistance=Infinity; controls\.maxPolarAngle=Math\.PI-0\.05; controls\.update\(\);/);
assert.match(b3, /setWalkMode\(on\)\{ if\(!controls\) return;\s+if\(on\)\{ if\(!walkKeep\) walkKeep=\{maxPolar:controls\.maxPolarAngle, minD:controls\.minDistance, maxD:controls\.maxDistance\}; if\(transform\) transform\.detach\(\); \}/);
assert.match(b3, /setStopLimits\(L\)/); assert.match(b3, /function walkGuardStep\(\)/);

// 8. normal 3D zoom: own smooth dolly (wheel / pinch / buttons / fit), hall-relative limits
assert.match(b3, /controls\.enableZoom=false;/); assert.match(b3, /addEventListener\('wheel', onWheel3D, \{passive:false\}\)/);
assert.match(b3, /e\.ctrlKey \? 0\.008 : 0\.0016/, 'pinch vs wheel sensitivity'); assert.match(b3, /Math\.max\(-240, Math\.min\(240, dy\)\)/, 'per-event clamp');
assert.match(b3, /const ZOOM_SMOOTH=0\.22;/); assert.match(b3, /window\.__zoom3D=/);
const bj = rd('public/builder.js');
assert.match(bj, /if\(in3D\(\)\) window\.__zoom3D\(1\/1\.25\)/); assert.match(bj, /if\(in3D\(\)\) window\.__zoom3D\('fit'\)/);
{ // the per-frame step is a geometric approach in log space: monotonic, no overshoot
  let dd = 300; const goal = 60, seq = [dd];
  for (let i = 0; i < 60; i++) { const lg = Math.log(goal / dd); dd = Math.abs(lg) < 0.002 ? goal : dd * Math.exp(lg * 0.22); seq.push(dd); }
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1] && seq[i] >= goal);
  assert.equal(seq[seq.length - 1], goal);
}
console.log('walkthrough-smooth: all assertions passed');
// using the rest of the builder ends the walkthrough (no stuck state); the card / 3D view don't
{
  const w = readFileSync('public/walkthrough.js', 'utf8');
  if (!/doc\.addEventListener\('pointerdown', \(e\) => \{\s*if \(!W\) return;[\s\S]*?exit\(\);\s*\}, true\);/.test(w)) throw new Error('walkthrough auto-exit on outside use missing');
  if (!/to2D\) W\.from2D = false/.test(w)) throw new Error('2D click should not double-switch');
  if (!/if \(t\.closest\('canvas, #scene3d'\)\) \{ explore\(\); return; \}/.test(w)) throw new Error('a drag on the 3D view must pause the tour (exploring)');
  console.log('walkthrough auto-exit: ok');
}
