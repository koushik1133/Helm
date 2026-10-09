/* cross-feature-matrix.test.mjs — venues × item specs × event defaults × walkthrough × client legend × pricing.
 * Every event type × hall (incl. a venue-provided size in metres) × seats N: the default layout has the
 * required items, exactly N seats, no overlaps, all inside the hall, a sensibly scaled stage; the walkthrough
 * gives finite eye-level stops inside the hall and counts the same seats; the legend has friendly grouped
 * names; spec pricing is finite and equals the canonical total formula. Generator lifted from builder.js. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const js = rd('public/builder.js');
const block = (startAt) => { let i = js.indexOf('{', startAt), d = 0;
  for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(startAt, i + 1); };
const fn = (name) => { const s = js.indexOf('function ' + name + '('); assert.ok(s >= 0, name);
  let i = js.indexOf('{', js.indexOf(')', s)), d = 0;
  for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const decl = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return block(s) + ';'; };
const line = (head) => { const s = js.indexOf(head); assert.ok(s >= 0, head); return js.slice(s, js.indexOf('\n', s)); };
const G = new Function([
  decl('const ASSETS = {'), 'const WORLD = { w: 200, h: 140 };', line('const clamp = '), line('const round1 = '),
  line('const DESIGN_PITCH='), 'let _packFit = null; let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";',
  line('const GEN_OVERLAY = '), line('const SEAT_SQFT_FALLBACK='), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '), line('const GEN_SEATING = '),
  decl('const EVENT_FAMILY = {'), decl('const EVENT_DEFAULT_REQUIRED = {'), decl('const EVENT_DEFAULT_NAME = {'),
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatSqftFor', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'seatBanquetRounds', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'eventFamily', 'eventDefaultItems', 'buildEventDefault'].map(fn),
  'return { WORLD, ASSETS, EVENT_DEFAULT_REQUIRED, eventFamily, buildEventDefault, sumSeats, genRect, rectsHit, GEN_OVERLAY, clampItem };',
].join('\n'))();
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(rd('public/walkthrough.js'), cx); vm.runInContext(rd('public/venues-core.js'), cx);
const WT = cx.window.HelmWalkthrough, V = cx.window.HelmVenues;
const require = createRequire(import.meta.url);
const CF = require(join(ROOT, 'public/capture-frame.js'));
const s = rd('public/store-api.js'); const a0 = s.indexOf('const OBJECT_CAT_PRICE'), p0 = s.indexOf('const pricing = {', a0);
let pi = s.indexOf('{', p0), pd = 0; for (; pi < s.length; pi++) { if (s[pi] === '{') pd++; else if (s[pi] === '}' && --pd === 0) break; }
const { pricing: P, ITEM_SPEC: S } = new Function(s.slice(a0, pi + 1) + '; return { pricing, ITEM_SPEC };')();
let n = 0;

// a venue that is 80 × 50 m: the builder hall is its feet conversion (rounded to whole feet)
const venueHall = V.fillFor({ length_m: 80, width_m: 50 });
assert.deepEqual([venueHall.lenFt, venueHall.widFt], [262, 164]);
const HALLS = [[60, 40], [80, 50], [200, 140], [300, 200], [venueHall.lenFt, venueHall.widFt]];
const TYPES = ['Wedding', 'Reception', 'Engagement', 'Birthday', 'Political', 'Corporate', 'Product launch', 'Conference', 'Concert', 'Festival', 'Unknown thing'];
const SEATS = [1, 50, 105, 700, 2000];
const fits = () => true;   // every hall builds (dense halls pack tighter); kept as a hook
const SPEC_FOR = { stage: null, generator: { kva: 125, days: 1 }, dj: { setup: 'speakers2', power: 'pin3' }, led: { pitch: 'p39_indoor', widthM: 4, heightM: 2.5, days: 1 },
  lighting: { kind: 'par', qty: 8 }, chandelier: { size: 'medium', qty: 2 }, photobooth: { kind: 'standard', hours: 3 }, chocolatefountain: { size: 'medium', servings: 100 },
  chariot: { kind: 'horse', trips: 1 }, smoke: { kind: 'cold_pyro', units: 2 }, dancers: { count: 6, basis: 'show', qty: 1 } };

for (const [w, h] of HALLS) for (const type of TYPES) for (const N of SEATS) {
  const fam = G.eventFamily(type);
  if (type === 'Unknown thing') { assert.equal(fam, null); continue; }
  assert.ok(fam, type);
  if (!fits(w, h, N)) continue;
  G.WORLD.w = w; G.WORLD.h = h;
  const tag = `${w}x${h} ${type} N=${N}`;
  const items = G.buildEventDefault(fam, N);
  assert.equal(G.sumSeats(items), N, tag + ' seats == N');
  for (const t of G.EVENT_DEFAULT_REQUIRED[fam]) assert.ok(items.some((i) => i.type === t), `${tag}: missing ${t}`);
  const solid = items.filter((i) => !G.GEN_OVERLAY.has(i.type));
  for (const it of items) { const r = G.genRect(it);
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isFinite), tag + ' finite');
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, `${tag}: ${it.type} outside hall`); }
  for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++)
    assert.ok(!G.rectsHit(G.genRect(solid[a]), G.genRect(solid[b]), 0), `${tag}: ${solid[a].type} overlaps ${solid[b].type}`);
  const st = items.find((i) => i.type === 'stage');
  assert.ok(st.width <= Math.max(12, w * 0.3) + 0.5 && st.width >= Math.min(12, w) && st.height < h / 2, tag + ' stage scaled');
  const led = items.find((i) => i.type === 'led' || i.type === 'ledscreen');
  if (led) assert.ok(led.width <= st.width + 1e-6, tag + ' LED no wider than the stage');
  // walkthrough: finite stops, eye level inside the hall, seat count matches
  const stops = WT.walkthroughStops(items, { w, h });
  assert.ok(stops.length >= 3, tag + ' stops');
  for (const sp of stops) { assert.ok([...sp.pos, ...sp.target].every(Number.isFinite), tag + ' NaN stop ' + sp.key);
    if (sp.key === 'overview' || sp.key === 'final') continue;
    assert.ok(Math.abs(sp.pos[1] - WT.EYE) < 1e-9 && Math.abs(sp.pos[0]) <= w / 2 && Math.abs(sp.pos[2]) <= h / 2, tag + ' eye inside ' + sp.key); }
  const seatStop = stops.find((x) => x.key === 'seating');
  assert.ok(seatStop && new RegExp('^' + N + ' seats?\\b').test(seatStop.desc), `${tag}: walkthrough seats "${seatStop && seatStop.desc}"`);
  // legend: friendly names, no raw type keys, grouped counts add up
  const { legend, byId } = CF.numberItems(items);
  for (const L of legend) { assert.ok(L.name && !/^[a-z]+$/.test(L.name), `${tag}: raw legend name ${L.name}`); assert.ok(L.count >= 1); }
  assert.equal(new Set(legend.map((L) => L.name.toLowerCase())).size, legend.length, tag + ' grouped');
  // pricing with specs on every spec'able item + an edited rate card == canonical formula, finite
  const priced = items.map((it) => { const c = JSON.parse(JSON.stringify(it));
    if (S.TYPES.includes(c.type)) c.properties = Object.assign({}, c.properties, { spec: SPEC_FOR[c.type] || S.defaultSpec(c.type, c) });
    return c; });
  const cards = Object.assign({}, S.DEFAULT_RATES, { stage: { base: 1500, perSqM: 480.5, stdHeightM: 0.6, heightPerSqMPerM: 150 } });
  const oi = P.fromItems(priced, {}, cards);
  assert.ok(Number.isFinite(oi.objectsCost) && Number.isInteger(oi.objectsCost), tag + ' objectsCost');
  let manual = 0;
  for (const it of priced) { if (P.isSeat(it)) continue; manual += S.price(it, cards, P.unitPrice(it, {})).price; }
  assert.equal(oi.objectsCost, manual, tag + ' objectsCost == Σ item prices');
  for (const l of oi.objectLines.filter((x) => x.spec)) assert.ok(/= ₹[\d,]+$/.test(l.label), tag + ' breakdown text ' + l.label);
  const t = P.quoteTotal({ chairs: oi.chairs, chairPrice: 100, guests: N, platePrice: 500, catering: { mode: 'inhouse', amount: 0 }, gstPct: 18, other: oi.objectsCost });
  assert.ok(Number.isFinite(t.total) && t.total > 0, tag + ' total');
  n++;
}

// ======== item specs × builder: edges, resize <-> spec sync (incl. 90°), undo/redo, copy/paste, save/load ========
const R = S.DEFAULT_RATES;
const EDGE = { stage: ['lengthM', 0.5, 200], generator: ['kva', 1, 3000], dj: ['extraSpeakers', 0, 100], lighting: ['qty', 1, 10000], led: ['widthM', 0.5, 100],
  chandelier: ['qty', 1, 10000], photobooth: ['hours', 1, 72], chocolatefountain: ['servings', 0, 20000], chariot: ['trips', 1, 50], smoke: ['units', 1, 500], dancers: ['count', 1, 500] };
for (const type of S.TYPES) {
  const base = SPEC_FOR[type] || S.defaultSpec(type, { width: 26.25, height: 16.4 });
  const [k, lo, hi] = EDGE[type];
  for (const [v, ok] of [[lo, true], [hi, true], [(lo + hi) / 2 + 0.25, true], [0, lo === 0], [-1, false], [hi * 10 + 1, false], ['abc', false], [NaN, false], [Infinity, false]]) {
    const sp = Object.assign({}, base, { [k]: v });
    const r = S.price({ type, properties: { spec: sp } }, R, 777);
    if (ok) { assert.ok(r.spec && Number.isInteger(r.price) && r.price >= 0, `${type}.${k}=${v} priced`); assert.ok(/= ₹[\d,]+$/.test(r.label), `${type} label ${r.label}`); }
    else { assert.equal(r.price, 777, `${type}.${k}=${v} falls back`); assert.match(r.note, /^spec invalid/); }
    n++;
  }
  // missing rate card for the type -> catalog price + "rate not set"
  const miss = S.price({ type, properties: { spec: base } }, Object.assign({}, R, { [type]: undefined }), 555);
  assert.equal(miss.price, 555); assert.equal(miss.note, 'rate not set');
  // fromItems total == breakdown objectsCost
  const b = P.breakdown({ items: [{ type, category: 'av', properties: { spec: base } }], guests: 0 }, { gstPct: 18 });
  assert.equal(b.objectsCost, S.compute(type, base, R[type]).price, type + ' breakdown');
}
assert.equal(CF.numberItems([{ id: 'g', type: 'generator', label: 'Generator', properties: { spec: { kva: 125, days: 1 } }, x: 0, y: 0, width: 10, height: 4 }]).legend[0].name, 'Generator 125 kVA');

const B = new Function('S', [line('const clamp = '), line('const round1 = '), 'const WORLD = { w: 200, h: 140 }; const store = { items: [] }; const CATS = { structure: 1, av: 1 }; let uid = 1; const nid = () => "n" + (uid++); const catColor = () => "#000";',
  line('const MAX_ITEMS='), 'const ASSETS = { stage: { w: 24, h: 12 } };', 'function specApi(){ return S; }',
  ...['specSyncAll', 'clampItem', 'sanitizeItem'].map(fn), 'return { WORLD, store, specSyncAll, clampItem, sanitizeItem };'].join('\n'))(S);
for (const rot of [0, 90, 180, 270]) {
  // Adjust in feet: preview price == price after Apply + commit (no re-rounding of an unchanged stage)
  const draft = { lengthM: S.toM(26.25, 'ft'), widthM: S.toM(16.4, 'ft'), heightM: 0.6, unit: 'ft' };
  const preview = S.compute('stage', draft, R.stage).price;
  const st = { id: 's', type: 'stage', category: 'structure', x: 10, y: 10, width: draft.lengthM / S.FT, height: draft.widthM / S.FT, rotation: rot, properties: { spec: { ...draft } } };
  B.store.items = [st]; B.specSyncAll();
  assert.equal(S.compute('stage', st.properties.spec, R.stage).price, preview, 'preview == applied price at ' + rot + '°');
  // resizing the stage (handles change item-local width/height at any rotation) moves the spec
  st.width = 40; st.height = 20; B.specSyncAll();
  assert.equal(st.properties.spec.lengthM, 12.19); assert.equal(st.properties.spec.widthM, 6.1); assert.equal(st.rotation, rot);
  // undo/redo snapshots, copy/paste and save/load all keep the spec
  const snap = JSON.stringify(B.store.items); assert.deepEqual(JSON.parse(snap)[0].properties.spec, st.properties.spec);
  const pasted = B.clampItem(B.sanitizeItem(JSON.parse(JSON.stringify(st)))); assert.deepEqual(pasted.properties.spec, st.properties.spec);
  const loaded = JSON.parse(JSON.stringify({ items: B.store.items })).items.map((x) => B.clampItem(B.sanitizeItem(x)));
  assert.deepEqual(loaded[0].properties.spec, st.properties.spec); n++;
}
// LED spec key "pitch" lives under properties.spec — the seat-prop sanitiser (properties.pitch) must not touch it
{ const led = B.sanitizeItem({ id: 'l', type: 'led', properties: { spec: { pitch: 'p39_indoor', widthM: 4, heightM: 2.5, days: 1 } } });
  assert.equal(led.properties.spec.pitch, 'p39_indoor'); }
assert.match(js, /toast\('Stage trimmed to fit the hall/);

// ======== venues × flow / builder ========
for (let f = 1; f <= 3000; f++) assert.equal(V.fromMeters(V.toMeters(f, 'ft'), 'ft'), f, 'ft round trip ' + f);
for (let t = 1; t <= 3000; t++) assert.equal(V.fromMeters(V.toMeters(t / 10, 'ft'), 'ft'), t / 10, 'ft round trip ' + t / 10);
for (let m = 1; m <= 500; m++) assert.equal(V.fromMeters(V.toMeters(m, 'm'), 'm'), m);
assert.equal(V.eventKey('Music festival'), 'festival'); assert.equal(V.eventKey('Live concert'), 'concert'); assert.equal(V.eventKey('DJ night'), 'concert');
const gen = { type: 'generator' }, dj = { type: 'dj' }, chairs = { type: 'seatblock', properties: { rows: 10, cols: 10 } };
const noGen = { seated_capacity: 300, floating_capacity: 500, event_types: ['wedding'], restrictions: ['generator_not_allowed'] };
const needGen = { seated_capacity: 300, event_types: [], restrictions: ['generator_required', 'sound_curfew'], sound_curfew: '22:00' };
const code = (v, c) => V.warnings(v, c).map((w) => w.level + ':' + w.code);
assert.ok(code(noGen, { items: [gen] }).includes('warn:generator_not_allowed'), 'generator in layout, venue disallows');
assert.ok(code(noGen, { items: [dj] }).includes('info:generator_not_allowed'));
assert.ok(code(needGen, { items: [chairs] }).includes('warn:generator_required'), 'required but missing');
assert.ok(code(needGen, { items: [gen] }).includes('info:generator_required'));
assert.ok(code(needGen, {}).includes('info:generator_required'), 'flow (no layout) stays informational');
assert.ok(code(needGen, { eventType: 'conference', items: [dj] }).includes('warn:sound_curfew'), 'DJ in layout trips the curfew');
assert.ok(!code(needGen, { eventType: 'conference', items: [chairs] }).includes('warn:sound_curfew'));
assert.ok(code(noGen, { seats: 350, guests: 350 }).includes('warn:seats'), 'seats over seated capacity');
assert.ok(!code(noGen, { seats: 300 }).includes('warn:seats'));
assert.ok(code(noGen, { eventType: 'Concert' }).includes('warn:event_type'));
assert.ok(code(noGen, { guests: 600 }).includes('warn:capacity'));
// picker: layout fed from the builder; a linked venue that was deactivated is flagged even if no venue is active
const vp = rd('public/venue-picker.js');
assert.match(vp, /items: lay \? lay\.items : null, seats: lay \? lay\.seats : null/);
assert.match(vp, /if \(L\.id && !picked\(\) && loaded\) linkName/);
assert.match(js, /layout: \(\) => \(\{ items: \(store && store\.items\) \|\| \[\], seats: sumSeats/);

// ======== walkthrough edges ========
const it = (type, x, y, w, h, extra) => Object.assign({ id: type + x + y, type, x, y, width: w, height: h, rotation: 0, properties: {} }, extra || {});
const finite = (stops, hall, tag) => { for (const sp of stops) { assert.ok([...sp.pos, ...sp.target].every(Number.isFinite), tag + ' ' + sp.key);
  if (sp.key !== 'overview' && sp.key !== 'final') assert.ok(Math.abs(sp.pos[0]) <= hall.w / 2 && Math.abs(sp.pos[2]) <= hall.h / 2, tag + ' inside ' + sp.key); } };
const hall = { w: 200, h: 140 };
finite(WT.walkthroughStops([], hall), hall, 'empty');
finite(WT.walkthroughStops([it('seatblock', 20, 20, 60, 40, { properties: { rows: 10, cols: 12 } })], hall), hall, 'only seating');
const huge = Array.from({ length: 5000 }, (_, i) => it(i % 7 ? 'table' : 'seatblock', (i * 13) % 190, (i * 7) % 130, 6, 6, { properties: { seats: 8 }, rotation: (i * 37) % 360 }));
huge.push(it('stage', 70, 5, 60, 20, { rotation: 90 }));
const t0 = Date.now(); finite(WT.walkthroughStops(huge, hall), hall, 'huge'); assert.ok(Date.now() - t0 < 2000, 'huge layout fast');
finite(WT.walkthroughStops([it('stage', -500, 900, 60, 20), it('bar', 5000, -40, 10, 4), it('table', 1e6, 1e6, 6, 6, { properties: { seats: 8 } })], hall), hall, 'outside hall');
finite(WT.walkthroughStops([it('stage', 70, 10, 60, 24, { rotation: 'x' }), it('redcarpet', 90, 40, 6, 60, { rotation: 45 }), it('ledscreen', 20, 10, 20, 2, { rotation: 270 })], hall), hall, 'rotated');
assert.ok(WT.eveningLightPoints(huge, hall).length <= 8);
// Evening never leaks into the client picture; labels toggle is inert inside the capture host
const b3 = rd('public/builder-3d.js'), wt = rd('public/walkthrough.js');
assert.match(b3, /if\(ev\) setEvening\(false\)/); assert.match(wt, /helm-capture/);

// ======== RBAC: UI mirrors the venues / item_pricing area rights ========
const va = rd('public/venues-admin.js'), ip = rd('public/item-pricing.js');
assert.match(va, /var canView = state\.isAdmin \|\| await S\.auth\.canView\("venues"\);\s*if \(!canView\) return;/, 'no view -> tab stays hidden');
assert.match(va, /state\.canEdit = state\.isAdmin \|\| \(S\.auth\.canEditArea \? await S\.auth\.canEditArea\("venues"\) : false\);/);
assert.match(va, /state\.canEdit \? h\("button", \{ type: "button", cls: "btn primary", id: "vn_add"/, 'add only for editors');
assert.match(va, /state\.canEdit \? h\("div", \{ cls: "vn-acts" \}/, 'edit / deactivate only for editors');
assert.match(ip, /A\.canView\("item_pricing"\)[\s\S]*if \(!ok\) return;/, 'no view -> card stays hidden');
assert.match(ip, /ro = !data\.canEdit/); assert.match(ip, /if \(!ro\) \{/, 'no Save buttons when view-only');
assert.match(rd('public/control.html'), /id="itemPricingCard" hidden/);
console.log(`cross-feature-matrix: ${n} checks OK`);
