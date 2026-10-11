// Walkthrough camera smoothness: tween math (monotonic distance, no spikes), single cancellable
// flight, constant FOV across stops, distance-scaled duration, reduced motion, rapid-click debounce,
// controls paused / damping flushed during a flight, auto-play paced from arrival.
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

// 1. tween endpoints exact; distance strictly monotonic and spike-free between very different views
const pairs = [
  [{ pos: [120, 160, 200], target: [0, 0, 0], fov: 65 }, { pos: [0, 5.25, 40], target: [0, 3, 10], fov: 65 }],   // overview -> eye
  [{ pos: [0, 5.25, 40], target: [0, 3, 10], fov: 65 }, { pos: [-60, 5.25, -20], target: [-60, 3, -50], fov: 65 }], // eye -> eye across hall
  [{ pos: [0, 5.25, 40], target: [0, 6, 0], fov: 65 }, { pos: [0, 5.25, -40], target: [0, 6, 0], fov: 65 }],      // opposite sides
  [{ pos: [10, 5, 10], target: [0, 3, 0], fov: 65 }, { pos: [180, 220, 260], target: [0, 0, 0], fov: 65 }],       // eye -> final overview
];
for (const [a, b] of pairs) {
  const v0 = WT.tweenView(a, b, 0), v1 = WT.tweenView(a, b, 1);
  assert.ok(close(v0.pos, a.pos, 1e-6) && close(v0.target, a.target), 'starts exactly at from');
  assert.ok(close(v1.pos, b.pos, 1e-6) && close(v1.target, b.target), 'ends exactly at to');
  const N = 120; let prev = d(v0); const dir = Math.sign(d(b) - d(a)); let maxJump = 0, prevPos = v0.pos;
  for (let i = 1; i <= N; i++) {
    const v = WT.tweenView(a, b, i / N), dist = d(v);
    if (dir !== 0) assert.ok((dist - prev) * dir >= -1e-9, `distance monotonic (${prev.toFixed(3)} -> ${dist.toFixed(3)})`);
    const lo = Math.min(d(a), d(b)) - 1e-6, hi = Math.max(d(a), d(b)) + 1e-6;
    assert.ok(dist >= lo && dist <= hi, 'distance never overshoots the two stops');
    assert.equal(v.fov, 65, 'constant FOV during the glide');
    maxJump = Math.max(maxJump, Math.hypot(...v.pos.map((x, k) => x - prevPos[k]))); prevPos = v.pos; prev = dist;
  }
  // per-frame movement bounded: no frame moves more than ~4x the average step (ease-in-out peak is 3x)
  const pathAvg = (Math.hypot(...b.pos.map((x, k) => x - a.pos[k])) + Math.PI * Math.max(d(a), d(b))) / N;
  assert.ok(maxJump <= pathAvg * 4 + 1e-6, 'no per-frame position spike');
}
// eased: zero speed at both ends
assert.equal(WT.ease(0), 0); assert.equal(WT.ease(1), 1); assert.ok(WT.ease(0.01) < 0.0001 && WT.ease(0.99) > 0.9999);
// FOV interpolates (never jumps) when a stop does ask for a different one
const fv = WT.tweenView({ pos: [0, 10, 10], target: [0, 0, 0], fov: 48 }, { pos: [0, 10, 10], target: [0, 0, 0], fov: 65 }, 0.5);
assert.ok(fv.fov > 48 && fv.fov < 65);

// 2. every walkthrough stop uses the same FOV (no zoom between overview and eye stops)
const it = (type, x, y, w, h) => ({ id: type + x + y, type, x, y, width: w, height: h, rotation: 0, properties: { seats: 8 } });
const items = [it('stage', 70, 10, 60, 24), it('exit', 95, 136, 10, 4), it('redcarpet', 97, 100, 6, 30), it('table', 40, 60, 6, 6), it('table', 140, 60, 6, 6),
  it('dancefloor', 80, 40, 40, 16), it('buffet', 170, 60, 20, 6), it('bar', 10, 110, 20, 5)];
for (const hall of [{ w: 200, h: 140 }, { w: 200, h: 200 }, { w: 60, h: 40 }]) {
  const S = WT.walkthroughStops(items, hall, { aspect: 16 / 9 });
  assert.ok(S.length >= 4);
  assert.deepEqual([...new Set(S.map((s) => s.fov))], [WT.WALK_FOV], 'one FOV for all stops ' + JSON.stringify(hall));
}

// 3. duration: reduced motion = instant; 1.2-2 s scaled by travel distance
assert.equal(WT.flightMs(true, 500), 0);
assert.equal(WT.flightMs(false), 1200); assert.equal(WT.flightMs(false, 0), 1200);
assert.ok(WT.flightMs(false, 50) > 1200 && WT.flightMs(false, 50) < 2000);
assert.equal(WT.flightMs(false, 5000), 2000);
assert.ok(WT.flightMs(false, 100) < WT.flightMs(false, 150));

// 4. one cancellable flight: fake clock + frames
function fakeFrames() {
  let t = 0, q = new Map(), id = 0;
  return { now: () => t, raf: (f) => { q.set(++id, f); return id; }, caf: (i) => q.delete(i),
    tick(ms) { t += ms; const fs = [...q.values()]; q.clear(); fs.forEach((f) => f(t)); }, pending: () => q.size };
}
{
  const F = fakeFrames(); const seen = []; let done = 0;
  const a = { pos: [100, 100, 100], target: [0, 0, 0], fov: 65 }, b = { pos: [0, 5, 30], target: [0, 3, 0], fov: 65 };
  const fl = WT.createFlight({ from: a, to: b, ms: 1500, now: F.now, raf: F.raf, caf: F.caf, apply: (v) => seen.push(d(v)), done: () => done++ });
  for (let i = 0; i < 200 && F.pending(); i++) F.tick(16);
  assert.equal(done, 1, 'done once'); assert.equal(fl.active, false);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] <= seen[i - 1] + 1e-9, 'flight distance monotonic');
  assert.ok(Math.abs(seen[seen.length - 1] - d(b)) < 1e-9, 'lands exactly');
  // cancel mid-flight: no further frames, done never called
  const F2 = fakeFrames(); let applied = 0, done2 = 0;
  const f2 = WT.createFlight({ from: a, to: b, ms: 1500, now: F2.now, raf: F2.raf, caf: F2.caf, apply: () => applied++, done: () => done2++ });
  F2.tick(16); F2.tick(16); const n = applied; f2.cancel(); F2.tick(16); F2.tick(16);
  assert.equal(applied, n); assert.equal(done2, 0); assert.equal(F2.pending(), 0); assert.equal(f2.active, false);
  // ms 0 (reduced motion) = instant cut, synchronously
  let cut = null; WT.createFlight({ from: a, to: b, ms: 0, now: F2.now, raf: F2.raf, caf: F2.caf, apply: (v) => { cut = v; } });
  assert.ok(cut && close(cut.pos, b.pos));
}

// 5. debounce gate
{
  let t = 0; const g = WT.makeGate(WT.NAV_GAP_MS, () => t);
  assert.equal(g.allow(), true); t += 50; assert.equal(g.allow(), false); t += 100; assert.equal(g.allow(), false);
  t += WT.NAV_GAP_MS; assert.equal(g.allow(), true);
  assert.ok(WT.NAV_GAP_MS >= 250 && WT.NAV_GAP_MS <= 500);
}

// 6. wiring: single flight, controls paused, walk mode, auto-play from arrival, no setInterval
const src = rd('public/walkthrough.js'), b3 = rd('public/builder-3d.js');
assert.doesNotMatch(src, /setInterval\(/, 'auto-play no longer a fixed interval');
assert.match(src, /W\.timer = setTimeout\([^]*DWELL_MS\)/);
assert.match(src, /function fly\(to, done\) \{\s*const h = H3\(\); if \(!h\) return; stopFlight\(\);/, 'previous flight cancelled first');
assert.match(src, /h\.setFlying\(true\)/); assert.match(src, /setWalkMode\(true\)/); assert.match(src, /setWalkMode\(false\)/);
assert.match(src, /bNext\.addEventListener\('click', \(\) => step\(1\)\)/); assert.match(src, /bPrev\.addEventListener\('click', \(\) => step\(-1\)\)/);
assert.match(src, /apply: \(v\) => h\.setView\(v\.pos, v\.target, null, v\.fov\)/, 'no per-frame min-distance changes');
assert.match(b3, /setFlying\(on\)\{[^]*controls\.enabled=false; controls\.enableDamping=false; controls\.update\(\);/);
assert.match(b3, /setWalkMode\(on\)\{[^]*controls\.maxPolarAngle=Math\.PI-0\.05; controls\.minDistance=1;/);

// 7. entrance: real entry point in priority order, level eye-level view toward the stage, "Start from" list
{
  const H = { w: 200, h: 140 };
  const L = [it('stage', 70, 10, 60, 24), it('exit', 10, 134, 10, 4), it('exit', 180, 134, 10, 4), it('checkpoint', 170, 118, 6, 3), it('arch', 95, 128, 10, 4)];
  const C = WT.entryCandidates(L, H);
  assert.deepEqual([...C.map((c) => c.label)], ['Security check (back-right)', 'Entrance arch (back-centre)', 'Exit 1 (back-left)', 'Exit 2 (back-right)', 'Back centre']);
  const st = (entry) => WT.walkthroughStops(L, H, { aspect: 16 / 9, entry }).find((x) => x.key === 'entrance');
  const e0 = st(); assert.equal(e0.entry, C[0].id, 'defaults to the security check');
  for (const c of C) {
    const e = st(c.id); assert.equal(e.entry, c.id);
    assert.equal(e.pos[1], WT.EYE); assert.equal(e.target[1], WT.EYE, 'level');
    assert.equal(e.fov, WT.WALK_FOV);
    const look = Math.hypot(e.target[0] - e.pos[0], e.target[2] - e.pos[2]);
    assert.ok(look > 40, 'looks across the venue, not at the entry item (' + c.label + ' ' + look.toFixed(1) + ')');
    assert.ok(e.target[2] < e.pos[2], 'faces the stage');
    assert.ok(WT.isClear({ x: e.pos[0] + 100, y: e.pos[2] + 70 }, L), 'clear of objects');
  }
  // entry-labelled exit beats a plain exit; unknown remembered id falls back to the best one
  const L2 = [it('stage', 70, 10, 60, 24), it('exit', 10, 134, 10, 4), Object.assign(it('exit', 180, 134, 10, 4), { label: 'Main entry' })];
  assert.match(WT.entryCandidates(L2, H)[0].label, /^Main entry/);
  assert.equal(WT.walkthroughStops(L2, H, { entry: 'nope' }).find((x) => x.key === 'entrance').entry, WT.entryCandidates(L2, H)[0].id);
  assert.deepEqual([...WT.entryCandidates([], H).map((c) => c.id)], ['back-centre']);
  assert.match(src, /'helm\.wt\.entry\.' \+/); assert.match(src, /Start from/); assert.match(src, /saveEntry\(fromSel\.value\)/);
}

// 8. normal 3D zoom: own smooth dolly (wheel / pinch / buttons / fit), hall-relative limits
assert.match(b3, /controls\.enableZoom=false;/); assert.match(b3, /addEventListener\('wheel', onWheel3D, \{passive:false\}\)/);
assert.match(b3, /e\.ctrlKey \? 0\.008 : 0\.0016/, 'pinch vs wheel sensitivity'); assert.match(b3, /Math\.max\(-240, Math\.min\(240, dy\)\)/, 'per-event clamp');
assert.match(b3, /const ZOOM_SMOOTH=0\.22;/); assert.match(b3, /window\.__zoom3D=/);
const bj = rd('public/builder.js');
assert.match(bj, /if\(in3D\(\)\) window\.__zoom3D\(1\/1\.25\)/); assert.match(bj, /if\(in3D\(\)\) window\.__zoom3D\('fit'\)/);
{ // the per-frame step is a geometric approach in log space: monotonic, no overshoot
  let d = 300; const goal = 60, seq = [d];
  for (let i = 0; i < 60; i++) { const lg = Math.log(goal / d); d = Math.abs(lg) < 0.002 ? goal : d * Math.exp(lg * 0.22); seq.push(d); }
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1] && seq[i] >= goal);
  assert.equal(seq[seq.length - 1], goal);
}
console.log('walkthrough-smooth: all assertions passed');
// using the rest of the builder ends the walkthrough (no stuck state); the card / 3D view don't
{
  const { readFileSync } = await import('node:fs');
  const w = readFileSync('public/walkthrough.js', 'utf8');
  if (!/doc\.addEventListener\('pointerdown', \(e\) => \{\s*if \(!W\) return;[\s\S]*?exit\(\);\s*\}, true\);/.test(w)) throw new Error('walkthrough auto-exit on outside use missing');
  if (!/to2D\) W\.from2D = false/.test(w)) throw new Error('2D click should not double-switch');
  console.log('walkthrough auto-exit: ok');
}
