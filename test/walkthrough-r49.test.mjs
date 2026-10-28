// R49 walkaround: every item shown exactly once, framed in the clear band, never hidden, flights that never dip /
// pass through / flip, a perf budget, and the tour UI (reduced-motion auto-play, key blocking, exploring) driven
// through a tiny fake DOM. Layouts = the analysts' fixtures (test/fixtures/walk-layouts.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { COVERAGE, EDGES, OCCLUSION, LAYOUTS, ALL } from './fixtures/walk-layouts.mjs';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
function loadWT(extra) {
  const cx = Object.assign({ window: {} }, extra || {}); cx.globalThis = cx; if (extra && extra.window) cx.window = extra.window; vm.createContext(cx);
  vm.runInContext(rd('public/capture-frame.js'), cx);
  cx.window.HelmCaptureFrame = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
  vm.runInContext(rd('public/walkthrough.js'), cx);
  return { WT: cx.window.HelmWalkthrough, cx };
}
const { WT } = loadWT();
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// ---------- 1. coverage proof on every analyst layout, at desktop and phone aspects ----------
const summary = [];
for (const [name, items, hall, opts] of ALL) {
  for (const aspect of [1.6, 0.55]) {
    const S = WT.walkthroughStops(items, hall, Object.assign({ aspect }, opts || {}));
    const pr = WT.proveCoverage(S);
    ok(pr.ok, `${name} @${aspect}: coverage proof\n  ${pr.errors.slice(0, 6).join('\n  ')}`);
    ok(S[0].key === 'overview', name + ': starts with the overview');
    if (S.length > 1) {
      ok(S[1].key === 'entrance', name + ': then the entrance');
      ok(S[S.length - 1].key === 'final', name + ': ends on the final overview');
      ok(S[0].pos.some((v, i) => Math.abs(v - S[S.length - 1].pos[i]) > 5), name + ': the final overview is a different view');
    }
    // keys unique, titles unique (no duplicate "Main stage — Main Stage")
    ok(new Set(S.map((s) => s.key)).size === S.length, name + ': unique keys');
    ok(new Set(S.map((s) => s.title)).size === S.length, name + ': unique titles ' + S.map((s) => s.title).join(' | '));
    for (const s of S) ok(!/—\s*(main\s+)?stage$/i.test(s.title) && !/NaN|undefined|Infinity/.test(s.title + s.desc), name + ': clean caption ' + s.title + ' / ' + s.desc);
    if (aspect === 1.6) summary.push(`${name}: ${S.length} stops, ${pr.owned}/${pr.items} owned`);
  }
}
// ownership details: accessories ride with their host, nested items with the host, roofs with the overview
{
  const [, items, hall] = COVERAGE[0];   // wedding: mandap on the stage, chairs round tables, uplights, chandeliers
  const S = WT.walkthroughStops(items, hall, { aspect: 1.6 });
  const own = new Map(); S.forEach((s) => s.owns.forEach((id) => own.set(id, s.key)));
  const by = (t) => items.filter((i) => i.type === t);
  ok(own.get(by('mandap')[0].id) === own.get(by('stage')[0].id), 'mandap on the stage = the stage stop');
  ok(by('chiavari').every((c) => own.get(c.id) && own.get(c.id).startsWith('seating')), 'chairs belong to their table');
  ok(!S.some((s) => s.key === 'uplight' || s.key === 'centrepiece' || s.key === 'chiavari'), 'accessories are never visited on their own');
  const seat = S.filter((s) => s.key.startsWith('seating'));
  ok(seat.reduce((n, s) => n + (s.guests || 0), 0) === 24 * 8, 'guests counted once (table seats, not seats + chairs)');
  ok(seat.every((s) => /^\d+ round tables? · /.test(s.desc) && / \d+ guests$/.test(s.desc)), 'count-first seating captions: ' + seat.map((s) => s.desc).join(' | '));
  const st = S.find((s) => s.key === 'stage'); ok(st.title === 'Main stage' && /^40 × 16 ft stage · /.test(st.desc) && /mandap/.test(st.desc), 'stage caption: ' + st.title + ' / ' + st.desc);
}
{ // unknown types always get their own stop; empty = one overview; tiny = one overview that owns everything
  const S = WT.walkthroughStops([{ id: 'u', type: 'spaceship', x: 100, y: 60, width: 20, height: 20 }, { id: 's', type: 'stage', x: 70, y: 10, width: 60, height: 24 }], { w: 200, h: 140 });
  ok(S.some((s) => s.owns.includes('u') && s.view === 'frame'), 'unknown type gets a stop');
  const E = WT.walkthroughStops([], { w: 200, h: 140 }); ok(E.length === 1 && E[0].view === 'overview' && /add items/.test(E[0].desc), 'empty layout: overview only');
  const T = WT.walkthroughStops(COVERAGE[5][1], COVERAGE[5][2]); ok(T.length === 1 && T[0].owns.length === 2, 'tiny hall: one overview owns everything');
}
{ // hostile type names never leak prototype keys
  const S = WT.walkthroughStops([{ id: 'c', type: 'constructor', x: 40, y: 90, width: 10, height: 10 }, { id: 't', type: 'toString', x: 150, y: 90, width: 6, height: 6 }], { w: 200, h: 140 });
  ok(!S.some((s) => /seat|guest/i.test(s.desc)), 'constructor / toString are not seating');
}

// ---------- 2. framing: inside the CLEAR band at 4 aspects, with and without the stop card ----------
for (const [name, items, hall] of [...COVERAGE.slice(0, 4), ...LAYOUTS.map((l) => [l.name, l.items, l.hall])]) {
  for (const aspect of [1.9, 1.33, 0.75, 0.55]) for (const band of [{ t: 0, b: 0, l: 0, r: 0 }, { t: 0.06, b: 0.3, l: 0, r: 0 }]) {
    const S = WT.walkthroughStops(items, hall, { aspect, band });
    const fov = S[0].fov; ok(Math.abs(fov - WT.walkFov(aspect)) < 1e-9 && S.every((s) => s.fov === fov), 'one FOV per walk');
    ok(Math.tan(fov * Math.PI / 360) * aspect >= Math.tan(21 * Math.PI / 180) - 1e-9, 'at least 42 deg across at aspect ' + aspect);
    const lo = [-1 + 2 * band.l, -1 + 2 * band.b], hi = [1 - 2 * band.r, 1 - 2 * band.t];
    for (const s of S) {
      if (s.view !== 'frame') continue;
      const pts = []; for (const id of s.owns) { const it = S.items.find((i) => i.id === id); if (it && !WT.ACCESSORY[it.type]) pts.push(...WT.itemPts(it, S.hall.w, S.hall.h, null)); }
      const P = WT.projectPts(pts, s.pos, s.target, s.fov, aspect);
      const bad = P.filter((q) => !(q.z > 0.5 && q.x >= lo[0] - 0.03 && q.x <= hi[0] + 0.03 && q.y >= lo[1] - 0.03 && q.y <= hi[1] + 0.03));
      ok(!bad.length, `${name} ${s.key} @${aspect} band ${band.b}: ${bad.length}/${P.length} points outside the clear band`);
      ok(s.pos[1] >= WT.EYE_MIN && s.pos[1] > s.target[1], `${name} ${s.key}: camera above the floor and above its look-at point`);
      ok(s.target[1] >= -1e-6, `${name} ${s.key}: orbit pivot never underground`);
    }
    const o = S[0]; ok(o.target[1] === 0, 'overview pivot on the floor');
  }
}
// re-solve for another aspect (resize / rotate / fullscreen / photo render) keeps the subject in frame
{
  const [, items, hall] = COVERAGE[0], S = WT.walkthroughStops(items, hall, { aspect: 1.6 });
  for (const s of S.filter((x) => x.view === 'frame')) {
    const v = WT.resolveStop(s, { aspect: 16 / 9, band: { t: 0, b: 0, l: 0, r: 0 } });
    const pts = []; for (const id of s.owns) { const it = S.items.find((i) => i.id === id); if (it && !WT.ACCESSORY[it.type]) pts.push(...WT.itemPts(it, S.hall.w, S.hall.h, null)); }
    ok(WT.projectPts(pts, v.pos, v.target, v.fov, 16 / 9).every((q) => q.z > 0.5 && Math.abs(q.x) <= 1.02 && Math.abs(q.y) <= 1.02), 'photo-render re-solve frames ' + s.key);
  }
}

// ---------- 3. camOK + 3-ray visibility for every stop camera ----------
for (const [name, items, hall] of [...OCCLUSION, ...COVERAGE.slice(0, 4), ...EDGES]) {
  const S = WT.walkthroughStops(items, hall, { aspect: 1.6 });
  for (const s of S) {
    if (s.view === 'overview') continue;
    const ign = new Set(s.owns);
    ok(WT.camOK(s.pos, S.index, S.hall.w / 2, S.hall.h / 2, s.key === 'entrance' ? ign : null, s.pos[1] >= 12), `${name} ${s.key}: camera spot is clear`);
    if (s.view === 'frame') ok(WT.visibility(s.pos, s.aim, 0.5, S.index, ign) >= (s.partial ? 2 / 3 - 1e-9 : 1), `${name} ${s.key}: subject visible (all 3 rays; 2 of 3 for a table packed under a tent roof)`);
  }
}
{ // tent over the lawn: no stop camera on / above the roof, and the stage camera stands in front of the stage
  const L3 = OCCLUSION.find((l) => l[0].startsWith('L3')), S = WT.walkthroughStops(L3[1], L3[2], { aspect: 1.6 });
  const st = S.find((s) => s.key === 'stage'); ok(st && st.pos[2] > st.target[2], 'L3: stage camera in front of the stage');
  ok(S.find((s) => s.key === 'final').hideRoofs === true && S[0].hideRoofs === false, 'roofs shown at the first overview, lifted for the final one');
}

// ---------- 4. flight legs: no floor dip, no pass-through, pitch / yaw limits, shortest yaw ----------
let legs = 0; const kinds = {};
for (const [name, items, hall] of ALL) {
  const S = WT.walkthroughStops(items, hall, { aspect: 1.6 });
  for (let i = 0; i + 1 < S.length; i++) {
    const a = S[i], b = S[i + 1], ign = new Set(S.filter((s) => s.key === 'entrance').flatMap((s) => s.owns));
    const P = WT.planFlight(a, b, { index: S.index, hall: S.hall, ignore: ign }); legs++; kinds[P.path.kind] = (kinds[P.path.kind] || 0) + 1;
    ok(P.ms >= 900 && P.ms <= 4200, 'duration from distance + turn');
    let prev = WT.viewAt(P, 0), lastYaw = WT.heading(prev).yaw, yawT = 0;
    for (let k = 1; k <= 90; k++) {
      const v = WT.viewAt(P, k / 90), h = WT.heading(v);
      assert.ok(v.pos[1] >= WT.EYE_MIN - 1e-9, `${name} ${a.key}->${b.key}: floor dip ${v.pos[1]}`);
      assert.ok(h.pitch >= WT.PITCH_MIN - 1e-9 && h.pitch <= WT.PITCH_MAX + 1e-9, `${name} ${a.key}->${b.key}: pitch ${h.pitch}`);
      assert.ok(WT.segClear(prev.pos, v.pos, S.index, ign), `${name} ${a.key}->${b.key}: passes through an object at k=${k}`);
      const dy = Math.atan2(Math.sin(h.yaw - lastYaw), Math.cos(h.yaw - lastYaw)); assert.ok(Math.abs(dy) < 0.2, 'no yaw flip in one frame'); yawT += dy; lastYaw = h.yaw; prev = v;
    }
    const net = Math.atan2(Math.sin(WT.heading(b).yaw - WT.heading(a).yaw), Math.cos(WT.heading(b).yaw - WT.heading(a).yaw));
    ok(Math.abs(Math.abs(yawT) - Math.abs(net)) < 0.05, `${name} ${a.key}->${b.key}: turns the short way (${(yawT * 57.3).toFixed(0)} vs ${(net * 57.3).toFixed(0)})`);
    const end = WT.viewAt(P, 1); ok(end.pos.every((x, k) => x === b.pos[k]) && end.target.every((x, k) => x === b.target[k]), 'lands exactly');
  }
}
{ // the old "over the top" case: stage behind, fountain in front on one axis -> a level turn, never a zenith flip
  const v = (pos, target) => ({ pos, target, fov: 55 });
  const P = WT.planFlight(v([0, 5.25, 40], [0, 6, 0]), v([0, 5.25, -40], [0, 3, -80]));
  let maxPitch = 0; for (let k = 0; k <= 60; k++) maxPitch = Math.max(maxPitch, Math.abs(WT.heading(WT.viewAt(P, k / 60)).pitch));
  ok(maxPitch < 10 * Math.PI / 180, 'opposite-facing stops: no swing over the top');
}

// ---------- 5. perf budget ----------
{
  const time = (items, hall, n) => { const t = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); WT.walkthroughStops(items, hall, { aspect: 1.6 }); t.push(performance.now() - t0); } return Math.min(...t); };   // best of n: other processes on the machine only ever add time
  let n = 0; const it = (type, x, y, w, h, props) => ({ id: type + '-' + (n++), type, x, y, width: w, height: h, rotation: 0, properties: props || {} });
  // a real 500-item wedding: stage, dance floor, bar, buffets, 49 round tables with their chairs and centrepieces
  const w500 = [it('stage', 110, 6, 60, 20), it('dancefloor', 115, 34, 50, 26), it('exit', 130, 196, 20, 4), it('bar', 8, 20, 4, 20), it('buffet', 266, 20, 4, 30)];
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) { const cx = 30 + c * 36 + (c > 3 ? 12 : 0), cy = 80 + r * 16;
    w500.push(it('table', cx - 3, cy - 3, 6, 6, { seats: 8 })); for (let k = 0; k < 8; k++) w500.push(it('chiavari', cx + Math.cos(k * Math.PI / 4) * 4.2 - 0.8, cy + Math.sin(k * Math.PI / 4) * 4.2 - 0.8, 1.6, 1.6)); w500.push(it('centrepiece', cx - 1, cy - 1, 2, 2)); }
  const m500 = time(w500, { w: 300, h: 200 }, 5); ok(w500.length === 495 && m500 < 50, w500.length + '-item wedding plans in < 50 ms (best of 5 ' + m500.toFixed(1) + ')');
  ok(WT.proveCoverage(WT.walkthroughStops(w500, { w: 300, h: 200 }, { aspect: 1.6 })).ok, '500-item wedding: coverage proof');
  // stress: 500 random items of 12 types sprinkled over a 400 x 300 hall (119 separate stops) - never a freeze
  const e500 = EDGES.find((l) => l[0].startsWith('03')), r500 = time(e500[1], e500[2], 3); ok(r500 < 250, '500 random items: no freeze (median ' + r500.toFixed(1) + ' ms)');
  const wed = [it('stage', 160, 6, 80, 20), it('dancefloor', 170, 40, 60, 40), it('exit', 190, 296, 20, 4)];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) { if (c === 4 || c === 5) continue; const cx = 20 + c * 38, cy = 100 + r * 19;
    wed.push(it('table', cx - 3, cy - 3, 6, 6, { seats: 8 })); for (let k = 0; k < 8; k++) wed.push(it('chiavari', cx + Math.cos(k * Math.PI / 4) * 4.2 - 0.8, cy + Math.sin(k * Math.PI / 4) * 4.2 - 0.8, 1.6, 1.6)); wed.push(it('centrepiece', cx - 1, cy - 1, 2, 2)); }
  while (wed.length < 1000) wed.push(it('uplight', 2 + (wed.length % 50) * 8, 2, 1, 1));
  const m1k = time(wed, { w: 400, h: 300 }, 5); ok(m1k < 50, '1000-item wedding plans in < 50 ms (best of 5 ' + m1k.toFixed(1) + ')');
  ok(WT.proveCoverage(WT.walkthroughStops(wed, { w: 400, h: 300 }, { aspect: 1.6 })).ok, '1000-item wedding: coverage proof');
  summary.push(`perf (best of n): 495-item wedding ${m500.toFixed(1)} ms, 1000-item wedding ${m1k.toFixed(1)} ms, 500 random-scatter items ${r500.toFixed(1)} ms`);
}

// ---------- 6. the tour UI in a fake DOM: reduced-motion auto-play, key blocking, exploring ----------
function fakeEnv(reducedMotion) {
  let now = 0; const timers = []; let tid = 0;
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.style = {}; this.hidden = false; this.className = ''; this.textContent = ''; this.parent = null; this.dataset = {}; this.isConnected = true; this.offsetParent = {}; this.value = ''; }
    get classList() { const self = this; const list = () => self.className.split(/\s+/).filter(Boolean);
      return { add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); }, remove: (...c) => { self.className = list().filter((x) => !c.includes(x)).join(' '); },
        toggle: (c, on) => { const has = list().includes(c); const want = on == null ? !has : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; }, contains: (c) => list().includes(c) }; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } removeAttribute(k) { delete this.attrs[k]; }
    append(...c) { for (const x of c) { if (x && typeof x === 'object') { x.parent = this; this.children.push(x); } } } prepend(...c) { this.append(...c); } after() {}
    replaceChildren(...c) { this.children = []; this.append(...c); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    dispatch(t, e) { (this.listeners[t] || []).forEach((f) => f(Object.assign({ target: this, preventDefault() {}, stopImmediatePropagation() {} }, e || {}))); }
    click() { this.dispatch('click'); }
    matches(sel) { return sel.split(',').some((q) => { q = q.trim(); if (q.startsWith('.')) return this.classList.contains(q.slice(1)); if (q.startsWith('#')) return this.attrs.id === q.slice(1) || this.id === q.slice(1); return this.tagName === q.toUpperCase(); }); }
    closest(sel) { let e = this; while (e) { if (e.matches && e.matches(sel)) return e; e = e.parent; } return null; }
    contains(x) { while (x) { if (x === this) return true; x = x.parent; } return false; }
    all() { return this.children.flatMap((c) => [c, ...c.all()]); }
    querySelectorAll(sel) { return this.all().filter((e) => e.matches(sel.split(' ').pop())); } querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; } focus() { doc.activeElement = this; }
  }
  const winL = {}, docL = {};
  const body = new El('body'), canvas = new El('canvas');
  const doc = { readyState: 'complete', body, hidden: false, activeElement: body, createElement: (t) => new El(t), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); } };
  const view = { pos: [0, 140, 180], target: [0, 0, 0], fov: 48, aspect: 1.6, minD: 20 }, calls = [];
  const h3 = { isActive: () => true, getView: () => ({ pos: view.pos.slice(), target: view.target.slice(), fov: view.fov, aspect: 1.6, minD: 20 }),
    setView: (p, t, m, f) => { view.pos = p.slice(); view.target = t.slice(); if (f) view.fov = f; }, setFlying: (on) => calls.push('fly:' + on), setWalkMode: (on) => calls.push('walk:' + on),
    setLabelsHidden() {}, setLabelFocus() {}, setHighlight() {}, setRoofsHidden() {}, setStopLimits() {}, setWalkGuard: (f) => calls.push('guard:' + (typeof f)), boundsOf: () => null };
  const frames = new Map(); let fid = 0;
  const win = { document: doc, __helm3D: h3, performance: { now: () => now }, location: { search: '' }, localStorage: { getItem: () => null, setItem() {} },
    matchMedia: (q) => ({ matches: /reduce/.test(q) ? reducedMotion : false }), requestAnimationFrame: (f) => { frames.set(++fid, f); return fid; }, cancelAnimationFrame: (i) => frames.delete(i),
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); } };
  const env = { window: win, setTimeout: (f, ms) => { timers.push({ id: ++tid, at: now + ms, f }); return tid; }, clearTimeout: (i) => { const k = timers.findIndex((t) => t.id === i); if (k >= 0) timers.splice(k, 1); },
    WORLD: { w: 200, h: 140 }, store: { items: OCCLUSION[0][1] }, URLSearchParams };
  win.clearSelection = () => calls.push('clearSelection'); win.renderAll = () => {};
  const { WT: UIWT } = loadWT(env);
  return { UI: UIWT._ui, view, calls, canvas, doc, docL, winL,
    advance(ms) { const end = now + ms; for (;;) { const t = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      const step = Math.min(16, end - now); if (t && t.at <= now + step) { now = t.at; timers.splice(timers.indexOf(t), 1); t.f(); continue; }
      if (now >= end) break; now += step; const fs = [...frames.values()]; frames.clear(); fs.forEach((f) => f(now)); } },
    key(key, extra) { const e = Object.assign({ key, target: body, defaultPrevented: false, stopped: false, repeat: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } }, extra || {});
      for (const f of winL.keydown || []) { f(e); if (e.stopped) break; } return e; } };
}
{
  const E = fakeEnv(true); let builderKeys = 0;
  E.winL.keydown = E.winL.keydown || []; E.winL.keydown.push(() => { builderKeys++; });   // the builder's own shortcuts (delete, nudge, rotate...)
  await E.UI.start();
  const W = E.UI.state(); ok(W && W.auto === true, 'auto-play starts on');
  ok(E.calls.includes('clearSelection') && E.calls.includes('walk:true') && E.calls.includes('guard:function'), 'selection cleared, walk mode + orbit guard on');
  ok(E.view.pos.every((v, i) => v === W.stops[0].pos[i]), 'reduced motion: an instant cut to the stop');
  E.advance(5800); ok(E.UI.state().i === 1, 'reduced motion: auto-play still advances after the dwell (M6)');
  E.UI.setAuto(false); E.UI.setAuto(true); E.advance(9000); ok(E.UI.state().i === 2, 'pause + play at a stop resumes auto-play (M6)');
  for (const k of ['Delete', 'Backspace', 'ArrowUp', 'ArrowDown', 'r', 'd', 'g', 't', 'y']) { const e = E.key(k); ok(e.defaultPrevented && e.stopped, 'blocked during the tour: ' + k); }
  for (const k of ['d', 'v', 'z', 'x', 'a', 'y']) { const e = E.key(k, { metaKey: true }); ok(e.stopped, 'blocked during the tour: Cmd+' + k); }
  ok(builderKeys === 0, 'no layout-editing shortcut reached the builder');
  const i0 = E.UI.state().i; E.key('ArrowRight'); ok(E.UI.state().i === i0 + 1, '→ next'); E.key('ArrowLeft'); ok(E.UI.state().i === i0, '← previous');
  E.key('End'); ok(E.UI.state().i === E.UI.state().stops.length - 1, 'End = last stop'); E.key('Home'); ok(E.UI.state().i === 0, 'Home = first stop');
  E.key(' '); ok(E.UI.state().auto === false, 'Space pauses'); E.key('k'); ok(E.UI.state().auto === true, 'K plays');
  E.key('Escape'); ok(E.UI.state() === null, 'Esc exits'); ok(E.calls.includes('walk:false'), 'walk mode off on exit');
  E.key('Delete'); ok(builderKeys === 1, 'after the tour the builder shortcuts work again');
}
{ // full motion: a drag on the 3D view mid-flight cancels the flight and pauses ("Paused — exploring"); Resume flies back
  const E = fakeEnv(false);
  await E.UI.start(); E.advance(6000);   // land on the overview, dwell, start flying to the entrance
  E.advance(200); const before = E.view.pos.slice();
  for (const f of E.docL.pointerdown || []) f({ target: E.canvas });
  E.advance(500); ok(E.view.pos.every((v, i) => v === before[i]), 'drag on the 3D view: the camera stays where the user grabbed it');
  ok(E.UI.state().exploring === true && E.UI.state().auto === false, 'drag = paused, exploring');
  E.UI.setAuto(true); ok(E.UI.state().exploring === false && E.UI.state().auto === true, 'Resume');
  E.advance(5000); const s = E.UI.state().stops[E.UI.state().i]; ok(E.view.pos.every((v, k) => Math.abs(v - s.pos[k]) < 1e-9), 'Resume flies back to the current stop');
  E.UI.exit();
}
// wiring that the fake DOM cannot see
{
  const src = rd('public/walkthrough.js'), b3 = rd('public/builder-3d.js');
  ok(/flight = f\.active \? f : null;/.test(src), 'no dead flight stub after an instant cut');
  ok(/visibilitychange/.test(src) && /flight\.pause\(\)/.test(src) && /dwellPause\(\)/.test(src), 'hidden tab pauses the flight + dwell');
  ok(/if\(walkKeep\) return;\s+\/\/ R49/.test(b3), 'click-select is off during the walkaround');
  ok(/if\(!it \|\| !active \|\| walkKeep\)\{ transform\.detach\(\); return; \}/.test(b3), 'no move handles during the walkaround');
  ok(/const L=walkKeep \? \{min:controls\.minDistance, max:controls\.maxDistance\}/.test(b3), 'wheel respects the per-stop zoom limits');
  ok(!/controls\.maxPolarAngle=Math\.PI-0\.05; controls\.minDistance=1;/.test(b3), 'walk mode no longer lets the camera under the floor');
  ok(/camera\.far=Math\.max\(3000, Math\.max\(floorW,floorH\)\*5\)/.test(b3), 'far plane follows huge halls');
  ok(/R\.setPixelRatio\(1\)/.test(b3) && /pointer: coarse/.test(b3), 'pixel ratio 1 on touch devices during flights');
  ok(/window\.HelmCaptureFrame\.itemTop\(it\)/.test(b3) && /ITEM_TOP/.test(rd('public/capture-frame.js')), 'one shared height table');
  ok(/HelmWalkthrough\._ui\.viewFor\(16 \/ 9\)/.test(rd('public/photo-render-ui.js')), 'photo render re-frames the stop for its own aspect');
}
console.log(summary.join('\n'));
console.log(`walkthrough-r49: ${checks} checks passed (${legs} flight legs: ${JSON.stringify(kinds)})`);
