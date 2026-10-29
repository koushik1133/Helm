// R62 (owner feedback on the 3D walkthrough): fewer, meaningful stops; the entrance stop centred on the entry item;
// the 3D Move / Rotate / Scale gizmo drawn over the name tags, off for view-only roles, with a pressed state.
// Layout = the owner's case: ~73 objects, 974 seats, 200 x 140 ft, stage + LED screens + ramps, 8 seat blocks with
// aisles, a red carpet lined with stanchions, lounges, side screens, dance floor + DJ, bar, buffet, photo spots,
// entrance arch + security check (back-right) with a queue line, exits.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(rd('public/capture-frame.js'), cx);
cx.window.HelmCaptureFrame = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
vm.runInContext(rd('public/walkthrough.js'), cx);
const WT = cx.window.HelmWalkthrough;
let n = 0;
const it = (type, x, y, w, h, props, extra) => Object.assign({ id: 'r62_' + type + '_' + (++n), type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});
const hall = { w: 200, h: 140 };
const items = [
  it('stage', 70, 4, 60, 22, null, { label: 'Main Stage' }), it('ledscreen', 52, 6, 14, 2), it('ledscreen', 134, 6, 14, 2), it('speaker', 64, 20, 3, 3), it('speaker', 133, 20, 3, 3),
  it('walkway', 88, 26, 4, 10, null, { label: 'Ramp' }), it('walkway', 108, 26, 4, 10, null, { label: 'Ramp' }), it('dancefloor', 80, 36, 40, 14), it('dj', 122, 38, 8, 4),
  it('redcarpet', 97, 52, 6, 82),
  ...Array.from({ length: 8 }, (_, i) => it('stanchion', 95, 54 + i * 10, 1, 10)), ...Array.from({ length: 8 }, (_, i) => it('stanchion', 104, 54 + i * 10, 1, 10)),
  it('seatblock', 52, 54, 40, 24, { rows: 12, cols: 12 }), it('seatblock', 108, 54, 40, 24, { rows: 12, cols: 12 }), it('seatblock', 52, 82, 40, 24, { rows: 12, cols: 12 }),
  it('seatblock', 108, 82, 40, 24, { rows: 12, cols: 12 }), it('seatblock', 10, 54, 36, 24, { rows: 12, cols: 12 }), it('seatblock', 154, 54, 36, 24, { rows: 12, cols: 12 }),
  it('seatblock', 10, 82, 36, 12, { rows: 5, cols: 11 }), it('seatblock', 154, 82, 36, 12, { rows: 5, cols: 11 }),
  it('walkway', 46, 54, 6, 52, null, { label: 'Aisle' }), it('walkway', 148, 54, 6, 52, null, { label: 'Aisle' }),
  it('walkway', 10, 79, 80, 3, null, { label: 'Cross aisle' }), it('walkway', 110, 79, 80, 3, null, { label: 'Cross aisle' }),
  it('sofa', 8, 112, 8, 3), it('sofa', 8, 122, 8, 3), it('sofa', 20, 112, 8, 3), it('armchair', 30, 116, 3, 3), it('coffeetable', 10, 117, 4, 3), it('coffeetable', 22, 117, 4, 3),
  it('sofa', 172, 112, 8, 3), it('sofa', 184, 112, 8, 3), it('loveseat', 178, 122, 6, 3),
  it('bar', 6, 30, 20, 5), it('barstool', 8, 36, 2, 2), it('barstool', 12, 36, 2, 2), it('barstool', 16, 36, 2, 2),
  it('buffet', 172, 30, 22, 6), it('buffet', 172, 40, 22, 6), it('livecounter', 160, 18, 10, 6),
  it('photobooth', 60, 118, 10, 10), it('selfieframe', 132, 124, 6, 2), it('backdrop', 140, 126, 10, 1, null, { label: 'Photo backdrop' }),
  it('projector', 2, 64, 12, 2, null, { rotation: 90 }), it('projector', 186, 64, 12, 2, null, { rotation: 90 }),
  it('arch', 94, 132, 12, 4, null, { label: 'Entrance arch' }), it('checkpoint', 176, 130, 8, 6, null, { label: 'Security check' }),
  it('stanchion', 160, 128, 14, 1), it('stanchion', 160, 134, 14, 1), it('desk', 112, 128, 8, 3, null, { label: 'Welcome desk' }),
  it('exit', 0, 68, 2, 6), it('exit', 198, 68, 2, 6), it('exit', 40, 136, 8, 4),
  it('uplight', 70, 26, 1, 1), it('uplight', 129, 26, 1, 1), it('floral', 92, 128, 2, 2), it('floral', 106, 128, 2, 2), it('cableramp', 60, 50, 6, 1), it('cableramp', 134, 50, 6, 1),
];
assert.equal(items.length, 73);
assert.equal(items.reduce((s, x) => s + (x.properties.rows || 0) * (x.properties.cols || 0), 0), 974);
const byId = new Map(items.map((x) => [x.id, x]));
const cands = WT.entryCandidates(items, hall);
assert.equal(cands[0].label, 'Security check (back-right)');

// ---- 1. stop count: meaningful stops only (was 27 on this layout) ----
for (const aspect of [16 / 9, 1.3, 0.6]) for (const c of cands) {
  const S = WT.walkthroughStops(items, hall, { aspect, entry: c.id });
  const tag = c.label + ' @ ' + aspect.toFixed(2);
  assert.ok(S.length >= 8 && S.length <= 15, 'roughly 8-14 stops: ' + S.length + ' ' + tag + '\n' + S.map((s) => s.key).join(','));
  const proof = WT.proveCoverage(S); assert.ok(proof.ok, tag + '\n' + proof.errors.join('\n')); assert.equal(proof.owned, items.length, 'every item still owned once: ' + tag);
  for (const s of S) {
    if (s.view === 'overview' || s.key === 'entrance') continue;
    const subj = (s.subject || []).map((id) => byId.get(id).type);
    assert.ok(!subj.some((t) => /^(walkway|redcarpet|aisle|carpet|stanchion|cableramp)$/.test(t)), 'no stop for an aisle / ramp / walk / rope line: ' + s.key + ' ' + subj + ' ' + tag);
    assert.doesNotMatch(s.key, /^aisle/, tag);
  }
}
const S = WT.walkthroughStops(items, hall, { aspect: 16 / 9 });
const keys = S.map((s) => s.key);
console.log('r62 stops (' + S.length + '): ' + keys.join(', '));
for (const k of ['overview', 'entrance', 'stage', 'dancefloor', 'seating', 'lounge', 'bar', 'dining', 'photo', 'final']) assert.ok(keys.includes(k), 'has ' + k + ': ' + keys);
const own = (k) => S.find((s) => s.key === k).owns.map((id) => byId.get(id).type);
assert.ok(own('stage').filter((t) => t === 'ledscreen').length === 2, 'the LED screens beside the stage ride with it: ' + own('stage'));
assert.ok(own('stage').filter((t) => t === 'walkway').length === 2, 'the two ramps ride with the stage: ' + own('stage'));
assert.ok(own('dancefloor').includes('dj'), 'the DJ booth rides with the dance floor');
assert.ok(S[1].owns.map((id) => byId.get(id).type).filter((t) => t === 'stanchion').length === 2, 'the queue line at the security check rides with the entrance');
assert.ok(S[0].owns.map((id) => byId.get(id).type).includes('redcarpet'), 'the overview owns the red carpet + its rope line');
assert.equal(S.filter((s) => s.key.startsWith('seating')).reduce((a, s) => a + s.guests, 0), 974, 'seat count adds up once');
assert.equal(new Set(keys).size, keys.length);

// ---- 2. the entrance stop: on the entry item's own centre line, just inside it, facing into the hall ----
const T = (s) => [s.pos[0] + hall.w / 2, s.pos[2] + hall.h / 2];
for (const c of cands.filter((x) => x.type !== 'edge')) {
  const st = WT.walkthroughStops(items, hall, { aspect: 16 / 9, entry: c.id }), e = st[1], ent = byId.get(c.id);
  assert.equal(e.key, 'entrance'); const [px, py] = T(e);
  const ecx = ent.x + ent.width / 2, ecy = ent.y + ent.height / 2;
  // which way is "in": the axis across the item's thinner side, pointing away from the nearest wall
  const across = ent.width >= ent.height ? 'y' : 'x';
  if (across === 'y') { assert.ok(Math.abs(px - ecx) < 0.5, c.label + ': centred on the entry (x ' + px + ' vs ' + ecx + ')'); assert.ok(Math.abs(py - ecy) <= ent.height / 2 + 12, c.label + ': just inside'); }
  else { assert.ok(Math.abs(py - ecy) < 0.5, c.label + ': centred on the entry (y ' + py + ' vs ' + ecy + ')'); assert.ok(Math.abs(px - ecx) <= ent.width / 2 + 12, c.label + ': just inside'); }
  const fx = e.target[0] - e.pos[0], fz = e.target[2] - e.pos[2], toC = [hall.w / 2 - ecx, hall.h / 2 - ecy];
  assert.ok(fx * toC[0] + fz * toC[1] > 0, c.label + ': faces into the hall');
  assert.ok(e.pos[1] >= WT.EYE && e.pos[1] <= 12, c.label + ': eye height');
  const pitch = Math.atan2(e.target[1] - e.pos[1], Math.hypot(fx, fz)) * 180 / Math.PI; assert.ok(pitch < 0 && pitch > -6, c.label + ': near-level ' + pitch);
  assert.ok(WT.proveCoverage(st).ok);
}
// security check at the back wall: straight in (the stage stays in view)
{ const e = S[1], [px, py] = T(e); assert.ok(Math.abs(px - 180) < 0.5 && py < 130 && py > 124, 'checkpoint: centred, a step inside: ' + [px, py]);
  const fx = e.target[0] - e.pos[0], fz = e.target[2] - e.pos[2], yaw = Math.atan2(fx, -fz) * 180 / Math.PI; assert.ok(Math.abs(yaw) < 30, 'looks up the hall: ' + yaw); }
// a rotated arch on the left wall: the axis follows its rotation
{ const arch = it('arch', -4, 60, 12, 4, null, { rotation: 90 }), L = [it('stage', 140, 40, 22, 60, null, { rotation: 0 }), arch, it('table', 80, 60, 6, 6, { seats: 8 })];
  const e = WT.walkthroughStops(L, hall, { aspect: 16 / 9 })[1], [px, py] = T(e);
  assert.ok(Math.abs(py - 62) < 0.5 && px > 2 && px < 12, 'rotated arch: centred on its axis ' + [px, py]); assert.ok(e.target[0] > e.pos[0], 'faces into the hall'); }

// ---- 3. 3D gizmo wiring (builder-3d.js / builder.html) ----
const b3 = rd('public/builder-3d.js'), bh = rd('public/builder.html');
assert.match(b3, /transform\.traverse\(o=>\{ o\.renderOrder=999; \}\)/, 'handles drawn over the name tags');
assert.match(b3, /transform\.setSize\(1\.1\)/, 'a bigger gizmo');
assert.match(b3, /walkKeep \|\| \(typeof RO!=='undefined' && RO\)\)\{ transform\.detach\(\)/, 'no edit handles for view-only roles');
assert.match(b3, /b\.setAttribute\('aria-pressed', on\?'true':'false'\)/, 'mode buttons expose the pressed state');
assert.match(b3, /Select an object first, then drag its handles/, 'a mode click with nothing selected says what to do');
for (const m of ['translate', 'rotate', 'scale']) assert.match(bh, new RegExp('<button type="button" data-m="' + m + '"[^>]*aria-pressed="(true|false)"'), m);
console.log('walkthrough-r62: ok');
