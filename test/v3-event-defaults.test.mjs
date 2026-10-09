/* v3-event-defaults.test.mjs — V3 event assets: per event-type default layouts carry the validated item
 * set, exactly N seats, no overlaps, everything inside the hall (80×50, 200×140, 300×200 × N 100/700/2000);
 * every new asset has a 2D icon/drawing, a 3D model builder that runs (THREE stubbed), and a friendly legend name.
 * Generator lifted from public/builder.js (same loader as r9-sizing-matrix). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const js = rd('public/builder.js');
const block = (startAt) => {
  let i = js.indexOf('{', startAt), depth = 0;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(startAt, i + 1);
};
const fn = (name) => { const s = js.indexOf('function ' + name + '('); assert.ok(s >= 0, name);
  let i = js.indexOf('{', js.indexOf(')', s)), depth = 0;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(s, i + 1); };
const decl = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return block(s) + ';'; };
const line = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return js.slice(s, js.indexOf('\n', s)); };
const src = [
  decl('const ASSETS = {'), 'const WORLD = { w: 200, h: 140 };', line('const clamp = '), line('const round1 = '),
  line('const DESIGN_PITCH='), 'let _packFit = null; let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";',
  line('const GEN_OVERLAY = '), line('const SEAT_SQFT_FALLBACK='), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '), line('const GEN_SEATING = '),
  decl('const EVENT_FAMILY = {'), decl('const EVENT_DEFAULT_REQUIRED = {'), decl('const EVENT_DEFAULT_NAME = {'),
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatSqftFor', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'seatBanquetRounds', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'eventFamily', 'eventDefaultItems', 'buildEventDefault', 'generateVariants'].map(fn),
  'return { WORLD, ASSETS, EVENT_DEFAULT_REQUIRED, EVENT_DEFAULT_NAME, eventFamily, buildEventDefault, generateVariants, sumSeats, genRect, rectsHit, GEN_OVERLAY };',
].join('\n');
const G = new Function(src)();
let n = 0;

// ---- 1. flow event types → family ----
const MAP = { Wedding: 'wedding', Reception: 'wedding', Engagement: 'wedding', Birthday: 'wedding', Political: 'political', Corporate: 'corporate',
  'Product launch': 'corporate', product_launch: 'corporate', Conference: 'corporate', Concert: 'concert', Festival: 'concert' };
for (const [t, f] of Object.entries(MAP)) assert.equal(G.eventFamily(t), f, t);
assert.equal(G.eventFamily('Religious / Puja'), null);

// ---- 2. matrix: validated items, exact N, inside hall, no overlaps ----
const check = (items, w, h, N, req, tag) => {
  assert.equal(G.sumSeats(items), N, tag + ' seats == N');
  for (const t of req) assert.ok(items.some((i) => i.type === t), `${tag}: missing ${t}`);
  const its = items.filter((i) => !G.GEN_OVERLAY.has(i.type));
  for (const it of its) { const r = G.genRect(it);
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isFinite), tag + ' finite');
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, `${tag}: ${it.type} outside hall`); }
  for (let a = 0; a < its.length; a++) for (let b = a + 1; b < its.length; b++)
    assert.ok(!G.rectsHit(G.genRect(its[a]), G.genRect(its[b]), 0), `${tag}: ${its[a].type} overlaps ${its[b].type}`);
  // podium stands on the stage
  const st = items.find((i) => i.type === 'stage'), po = items.find((i) => i.type === 'podium');
  if (po) assert.ok(G.rectsHit(G.genRect(po), G.genRect(st), 0), tag + ' podium on stage');
};
for (const [w, h] of [[80, 50], [200, 140], [300, 200]]) for (const fam of Object.keys(G.EVENT_DEFAULT_REQUIRED)) for (const N of [100, 700, 2000]) {
  G.WORLD.w = w; G.WORLD.h = h;
  const tag = `${w}x${h} ${fam} N=${N}`;
  check(G.buildEventDefault(fam, N), w, h, N, G.EVENT_DEFAULT_REQUIRED[fam], tag);
  // stage scales with the hall
  const st = G.buildEventDefault(fam, N).find((i) => i.type === 'stage');
  assert.ok(st.width <= Math.max(12, w * 0.3) + 0.5 && st.width >= Math.min(12, w), tag + ' stage scaled');
  // the Custom Event recommendation variant is the same validated set
  const types = { wedding: 'wedding', political: 'political', corporate: 'product_launch', concert: 'concert' };
  const v = G.generateVariants({ type: types[fam], guests: Math.ceil(N / 0.7), chairs: N }).find((x) => x.name === G.EVENT_DEFAULT_NAME[fam]);
  assert.ok(v, tag + ' recommendation variant'); check(v.items, w, h, N, G.EVENT_DEFAULT_REQUIRED[fam], tag + ' variant');
  n++;
}

// ---- 3. arrival + dialog wiring ----
assert.match(js, /const fam=eventFamily\(q\.eventType\);/);
assert.match(js, /store\.items = fam \? buildEventDefault\(fam, N\) : TEMPLATES\[presetKey\]\(\);/);
const bh = rd('public/builder.html');
assert.match(bh, /<option value="product_launch">Corporate \/ product launch<\/option>/);
assert.match(bh, /<option value="political">Political \/ rally<\/option>/);
assert.match(rd('public/flow.html'), /"Product launch","Political"/);
for (const f of ['public/builder.html', 'public/capture.html']) { const h = rd(f);
  assert.match(h, /builder\.js\?v=33/, f); assert.match(h, /builder-3d\.js\?v=12/, f); assert.match(h, /capture-frame\.js\?v=12/, f); }

// ---- 4. every new asset: toolbox entry, 2D drawing + icon, 3D model builder that runs ----
const NEW = ['dj', 'speaker', 'generator', 'stage', 'lighting', 'truss', 'led', 'ledscreen', 'chandelier', 'photobooth', 'chocolatefountain', 'chariot', 'smoke',
  'dancers', 'podium', 'walkway', 'brandwall', 'linearray', 'barricade'];
for (const t of NEW) { assert.ok(G.ASSETS[t] && G.ASSETS[t].w > 0 && G.ASSETS[t].h > 0, t + ' asset');
  assert.ok(js.includes(`case '${t}': return wrap(`), t + ' toolbox icon'); }
for (const t of ['lighting', 'led', 'chocolatefountain', 'chariot', 'smoke', 'dancers', 'walkway', 'brandwall', 'generator'])
  assert.ok(new RegExp(`case '${t}':(?: case '\\w+':)? \\{`).test(js), t + ' 2D drawing');
// THREE stub: every constructor yields an object with position/rotation/scale/add — enough to run the builders
const b3 = rd('public/builder-3d.js');
const b3fn = (name) => { const s = b3.indexOf('function ' + name + '('); let i = b3.indexOf('{', b3.indexOf(')', s)), d = 0;
  for (; i < b3.length; i++) { if (b3[i] === '{') d++; else if (b3[i] === '}' && --d === 0) break; } return b3.slice(s, i + 1); };
const b3line = (head) => { const s = b3.indexOf(head); assert.ok(s >= 0, head); return b3.slice(s, b3.indexOf('\n', s)); };
const v3 = () => ({ x: 0, y: 0, z: 0, set() { return this; }, setScalar() { return this; } });
class Obj { constructor(...a) { this.position = v3(); this.rotation = v3(); this.scale = v3(); this.children = []; this.material = a[1] || {}; } add(c) { assert.ok(c, 'add(undefined)'); this.children.push(c); return this; }
  translate() { return this; } rotateX() { return this; } rotateZ() { return this; } }
const THREE = new Proxy({}, { get: () => Obj });
const build3 = new Function('THREE', 'store', 'congestionOf', 'CONG_COLORS', 'label', 'chairs', [b3fn('rotOff'), b3line('const col = '), b3line('const mat = '), b3fn('boxMesh'), b3fn('buildFurniture'), 'return buildFurniture;'].join('\n'))(THREE, {}, () => 'ok', {}, () => new Obj(), []);
for (const t of Object.keys(G.ASSETS)) {
  const a = G.ASSETS[t];
  for (const props of [{}, { kva: 125 }]) {
    const g = build3({ type: t, x: 0, y: 0, rotation: 0, width: a.w, height: a.h, color: '#3366ff', properties: { ...(a.props || {}), ...props }, label: a.label }, []);
    if (t === 'seatblock' || t === 'chairrow') continue;   // chairs are instanced separately
    assert.ok(g && g.children.length > 0, t + ' 3D model has parts');
  }
}
for (const t of ['lighting', 'led', 'chocolatefountain', 'chariot', 'smoke', 'dancers', 'walkway', 'brandwall']) assert.ok(b3.includes(`case '${t}'`), t + ' 3D case');

// ---- 5. friendly legend names (client picture) ----
const require = createRequire(import.meta.url);
globalThis.window = globalThis.window || {};
const CF = require(join(ROOT, 'public/capture-frame.js'));
const H = CF && CF.numberItems ? CF : globalThis.window.HelmCaptureFrame;
const names = (items) => H.numberItems(items).legend.map((L) => L.name);
assert.deepEqual(names([{ id: 'a', type: 'generator', label: 'Generator', properties: { kva: 125 }, x: 0, y: 0, width: 10, height: 4 }]), ['Generator 125 kVA']);
assert.deepEqual(names([{ id: 'a', type: 'generator', label: 'Generator', properties: { spec: { kva: '62.5' } }, x: 0, y: 0, width: 10, height: 4 }]), ['Generator 62.5 kVA']);
assert.deepEqual(names([{ id: 'a', type: 'generator', label: 'Generator', properties: {}, x: 0, y: 0, width: 10, height: 4 }]), ['Generator']);
assert.deepEqual(names([{ id: 'a', type: 'chocolatefountain', label: '', properties: {}, x: 0, y: 0, width: 4, height: 4 }]), ['Chocolate fountain']);
assert.deepEqual(names([{ id: 'a', type: 'generator', label: 'Backup genset', properties: { kva: 125 }, x: 0, y: 0, width: 10, height: 4 }]), ['Backup genset'], 'custom names kept');
console.log(`v3-event-defaults: ${n} default layouts + assets OK`);
