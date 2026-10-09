/* r10-gen.test.mjs — R10 live fixes: ?gen=1 arrival yields exactly N seats; area warning uses the rankTemplates capacity model; Reception maps to Reception; banquet quality; 0 chairs rejected; seating in the legend. */



import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const js = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/builder.js'), 'utf8');
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
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatSqftFor', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'seatBanquetRounds', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'generateVariants', 'genTargetSeats'].map(fn), decl('const TEMPLATES = {'),
  'return { WORLD, ASSETS, TEMPLATES, generateVariants, sumSeats, exactSeats, seatFitWarning, genRect, rectsHit, GEN_OVERLAY, genTargetSeats };',
].join('\n');
const G = new Function(src)();
const EVENT_TYPE_PRESET = new Function(js.slice(js.indexOf('const EVENT_TYPE_PRESET'), js.indexOf('};', js.indexOf('const EVENT_TYPE_PRESET')) + 2) + ' return EVENT_TYPE_PRESET;')();

// 1. ?gen=1 arrival: the default template for the flow's type, at the flow's hall, gets EXACTLY N seats
let n = 0;
for (const [type, w, h, N] of [['reception', 80, 50, 105], ['wedding', 220, 160, 700], ['birthday', 30, 20, 5], ['gala', 120, 80, 300], ['conference', 60, 40, 45], ['concert', 200, 140, 999]]) {
  G.WORLD.w = w; G.WORLD.h = h;
  const target = G.genTargetSeats(null, String(N), String(Math.ceil(N / 0.7)));   // fresh flow hand-off: URL chairs
  assert.equal(target, N);
  const items = G.exactSeats(G.TEMPLATES[EVENT_TYPE_PRESET[type]](), target);
  assert.equal(G.sumSeats(items), N, `${type} ${w}x${h} arrival has ${G.sumSeats(items)} seats, want ${N}`); n++;
}
assert.equal(G.genTargetSeats(120, '105', '150'), 120, 'the quote\'s saved seats win over the URL');
assert.equal(G.genTargetSeats(null, '', '150'), 105, 'no chairs in the URL → 70% of guests');
assert.equal(G.genTargetSeats(null, '0', 'abc'), 0, 'garbage → no target');
const gen = js.slice(js.indexOf("if(params.get('gen')==='1'"), js.indexOf("openCustomModal();", js.indexOf("if(params.get('gen')==='1'")));
assert.match(gen, /if\(_autoDefaultLoaded\)\{ const N=arrivalSeats\(\); if\(N>0 && sumSeats\(store\.items\)!==N\)\{ exactSeats\(store\.items, N\)/);
assert.match(js, /const N=arrivalSeats\(\);[\s\S]{0,200}if\(N>0\) exactSeats\(store\.items, N\);/);

// 2. warning: same capacity model as rankTemplates — 105 seats in 80x50 fits (no "12,728 sq ft")
G.WORLD.w = 80; G.WORLD.h = 50;
for (const nat of [0, 3, 33, 48, 104]) assert.equal(G.seatFitWarning(105, nat, null, 'reception'), '', 'fits: ' + nat);
assert.match(G.seatFitWarning(1000, 33), /^1,000 seats need ~6,000 sq ft; hall is 4,000 sq ft$/);
const HS = (() => { const cx = { window: {} }; new Function('window', readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/event-sizing.js'), 'utf8'))(cx.window); return cx.window.HelmSizing; })();
assert.equal(HS.seatSqft('reception'), 9); assert.equal(HS.seatSqft('concert'), 6);
const rec = HS.rankTemplates({ type: 'Reception', guests: 150, chairs: 105, len: 80, wid: 50 }, null, 3);
assert.ok(rec[0].fits && 4000 >= 105 * HS.seatSqft('reception'), 'recommendation and warning agree');

// 3. Reception keeps its own option + mapping
const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/builder.html'), 'utf8');
assert.match(html, /<option value="reception">Reception<\/option>/);
assert.match(js, /const CE_TYPE = \{ wedding:'wedding', reception:'reception',/);
assert.match(gen, /const ct=CE_TYPE\[rawType\]\|\|'wedding';/);
assert.ok(!/TMAP/.test(gen), 'one shared map');

// 4. banquet quality: round tables of 8 spread at comfortable spacing, nothing overlaps
for (const [w, h, N] of [[80, 50, 105], [120, 80, 300], [220, 160, 700]]) {
  G.WORLD.w = w; G.WORLD.h = h;
  for (const v of G.generateVariants({ type: 'reception', guests: Math.ceil(N / 0.7), chairs: N })) {
    assert.equal(G.sumSeats(v.items), N);
    for (const b of v.items.filter((i) => i.properties && i.properties.rows && i.properties.cols))
      if (v.name.startsWith('Banquet')) assert.ok(b.width / b.properties.cols >= 2.2 && b.height / b.properties.rows >= 2.2, v.name + ' block too dense');
  }
  const v = G.generateVariants({ type: 'reception', guests: Math.ceil(N / 0.7), chairs: N }).find((x) => x.name.startsWith('Banquet'));
  const tabs = v.items.filter((i) => i.type === 'table');
  assert.equal(tabs.length, Math.ceil(N / 8), `${w}x${h}: ${tabs.length} tables`);
  assert.ok(tabs.every((t) => t.properties.seats <= 8), 'no over-packed table');
  assert.equal(v.counts.natural, N, 'all N fit naturally — no packing');
  const stage = v.items.find((i) => i.type === 'stage'); assert.ok(stage.width <= Math.max(12, w * 0.3) + 1e-6, 'stage ≤ 30% of hall width');
  const xs = tabs.map((t) => t.x), ys = tabs.map((t) => t.y);
  const spread = (Math.max(...xs) - Math.min(...xs) + 6) * (Math.max(...ys) - Math.min(...ys) + 6);
  assert.ok(spread >= 0.3 * w * h, `${w}x${h}: seating spread ${spread} over the floor`);
  const its = v.items.filter((i) => !G.GEN_OVERLAY.has(i.type));
  for (let a = 0; a < its.length; a++) for (let b = a + 1; b < its.length; b++) assert.ok(!G.rectsHit(G.genRect(its[a]), G.genRect(its[b]), 0), `${its[a].type} overlaps ${its[b].type}`);
}

// 5. 0 chairs is rejected on every generate path (the hardener must not turn 0 into 1 first)
assert.match(html, /id="c_chairs" min="0"/);
for (const f of ['function runCustomGenerate(', 'function applyRecommendation(']) { const s = js.indexOf(f); assert.match(js.slice(s, s + 800), /if\(!chairsOk\(o\.chairs\)\) return;/, f); }

// 6. seating appears in the client-picture legend
{ const cx = { window: {} }; cx.globalThis = cx; const vm = (await import('node:vm')).default; vm.createContext(cx);
  vm.runInContext(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/capture-frame.js'), 'utf8'), cx);
  const CF = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
  const items = []; for (let i = 1; i <= 13; i++) items.push({ id: 't' + i, type: 'table', label: 'T' + i, x: i * 7, y: 30, width: 6, height: 6, properties: { seats: 8 } });
  items.push({ id: 't14', type: 'table', label: 'T14', x: 5, y: 40, width: 6, height: 6, properties: { seats: 1 } });
  items.push({ id: 's1', type: 'seatblock', label: 'Left Seating', x: 5, y: 60, width: 20, height: 10, properties: { rows: 4, cols: 8 } }, { id: 's2', type: 'chairrow', label: 'Seating · last row', x: 5, y: 72, width: 6, height: 2, properties: { rows: 1, cols: 3 } });
  const r = CF.numberItems(items);
  assert.equal(r.legend.find((l) => l.name === '8-seat round table').count, 13);
  assert.ok(r.legend.find((l) => l.name === '1-seat round table'));
  assert.equal(r.legend.find((l) => l.name === 'Guest seating').seats, 35);
  assert.ok(items.every((it) => r.byId.has(it.id)), 'every table / block gets a badge');
  const L = CF.legendLayout(r.legend, 600, 1000); assert.ok(L.rows.some((x) => /Guest seating — 35 seats/.test(x.text)) && L.rows.some((x) => /8-seat round table ×13/.test(x.text)));
}
console.log(`r10-gen: ${n} ?gen=1 arrivals exact + warning / Reception / banquet quality / 0-chairs / legend OK`);
