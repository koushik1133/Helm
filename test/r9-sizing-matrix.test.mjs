/* r9-sizing-matrix.test.mjs — R9 exhaustive edge-case matrix for sizing / seats / pricing (PR #77 follow-up).
 * Generator lifted from public/builder.js (same loader as r8b-seats-exact); HelmSizing + reconcile loaded directly. */
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
  line('const GEN_OVERLAY = '), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '), line('const GEN_SEATING = '),
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'generateVariants'].map(fn),
  'return { WORLD, ASSETS, generateVariants, sumSeats, exactSeats, seatFitWarning, genRect, rectsHit, GEN_OVERLAY, GEN_SEATING };',
].join('\n');
const G = new Function(src)();
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const S = require(join(ROOT, 'public/event-sizing.js'));
globalThis.HelmSizing = S;
const L = require(join(ROOT, 'public/flow-layout-sync.js'));
let n = 0;

// ---- 1. generator matrix: exact N, inside hall, finite, no overlaps (halls that can hold the template) ----
const HALLS = [[20, 20], [60, 40], [200, 140], [1000, 800]];
const TYPES = ['wedding', 'corporate', 'birthday', 'conference', 'unknown', 'gala', 'reception', 'concert'];
const NS = [1, 2, 3, 7, 9, 10, 69, 70, 99, 100, 233, 500, 700, 999, 1000, 1001];
for (const [w, h] of HALLS) for (const type of TYPES) for (const N of NS) {
  G.WORLD.w = w; G.WORLD.h = h;
  const vs = G.generateVariants({ type, guests: Math.ceil(N / 0.7), chairs: N, head: type === 'wedding', stage: type === 'concert', lounge: type === 'reception', bars: 1, buffet: true });
  assert.ok(vs.length >= 4, `${type} variants`);
  for (const v of vs) {
    const tag = `${w}x${h} ${type} N=${N} "${v.name}"`;
    assert.equal(G.sumSeats(v.items), N, tag + ' seats');
    assert.equal(v.counts.chairs, N, tag + ' counts.chairs');
    const its = v.items.filter((i) => !G.GEN_OVERLAY.has(i.type));
    for (const it of its) {
      const r = G.genRect(it);
      assert.ok([r.x, r.y, r.w, r.h].every(Number.isFinite), tag + ' finite');
      assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, tag + ' inside hall');
    }
    if (v.counts.natural < N) assert.ok(G.seatFitWarning(N, v.counts.natural).length > 0, tag + ' warns');
    // a 20x20 hall cannot hold a stage/dance floor AND seats — that case must warn (asserted above), not be silent
    if (w >= 60 && N <= 100) for (let a = 0; a < its.length; a++) for (let b = a + 1; b < its.length; b++)
      assert.ok(!G.rectsHit(G.genRect(its[a]), G.genRect(its[b]), 0), `${tag}: ${its[a].type} overlaps ${its[b].type}`);
    n++;
  }
}
// R9 fix: the tiny-hall warning no longer claims "need ~116 sq ft; hall is 400" (need < hall)
G.WORLD.w = 20; G.WORLD.h = 20;
assert.match(G.seatFitWarning(10, 0), /don’t fit this template in a 400 sq ft hall/);
assert.match(G.seatFitWarning(700, 300), /^700 seats need ~[\d,]+ sq ft; hall is 400 sq ft$/);

// R9 live bug: Birthday 7 guests → 5 seats in a 30x20 hall warned "5 seats need ~58 sq ft; hall is 600".
// Now: no warning when the seats fit comfortably in the space actually left; when they don't, the
// message names the real constraint (seating area left after stage / dance floor / buffet / bars).
G.WORLD.w = 30; G.WORLD.h = 20;
{ const vs = G.generateVariants({ type: 'birthday', guests: 7, chairs: 5, dance: true, bars: 1, buffet: true });
  const best = Math.max(...vs.map((v) => v.counts.natural)), free = Math.max(0, ...vs.map((v) => v.counts.free || 0));
  assert.equal(G.seatFitWarning(5, best, free), '', '30x20 / 5 seats fits — no warning');
  for (const v of vs) { assert.equal(G.sumSeats(v.items), 5); const w = G.seatFitWarning(5, v.counts.natural, v.counts.free);
    if (w) assert.match(w, /seating area left after the stage, dance floor, buffet & bars is ~\d+ sq ft/);
    const m = w.match(/need ~([\d,]+) sq ft.*is ~([\d,]+) sq ft/); if (m) assert.ok(+m[1].replace(/,/g, '') > +m[2].replace(/,/g, ''), 'need > available'); } }
G.WORLD.w = 20; G.WORLD.h = 20;
for (const v of G.generateVariants({ type: 'concert', stage: true, chairs: 200 })) {
  const w = G.seatFitWarning(200, v.counts.natural, v.counts.free); assert.ok(w, 'tiny hall warns');
  const m = w.match(/need ~([\d,]+) sq ft.*(?:is|in a) ~?([\d,]+) sq ft/); assert.ok(m && +m[1].replace(/,/g, '') > +m[2].replace(/,/g, ''), 'warning is never self-contradictory: ' + w); }

// ---- 2. garbage guest / chairs inputs: never a NaN, never a stray partial target ----
G.WORLD.w = 200; G.WORLD.h = 140;
const natural = G.generateVariants({ type: 'wedding' }).map((v) => G.sumSeats(v.items));
for (const bad of [-5, 0, '', 'abc', null, undefined, NaN, Infinity, -Infinity]) {
  const got = G.generateVariants({ type: 'wedding', guests: bad, chairs: bad }).map((v) => G.sumSeats(v.items));
  assert.deepEqual(got, natural, 'bad input ' + String(bad) + ' = no target');
}
assert.ok(G.generateVariants({ type: 'wedding', guests: 7.5 }).every((v) => G.sumSeats(v.items) === 8), 'decimal rounds');
for (const big of [5000, 20000]) for (const [w, h] of [[200, 140], [1000, 800], [20, 20]]) {
  G.WORLD.w = w; G.WORLD.h = h; const t0 = Date.now();
  const vs = G.generateVariants({ type: 'wedding', chairs: big });
  assert.ok(Date.now() - t0 < 2000, `N=${big} ${w}x${h} under 2s`);
  vs.forEach((v) => assert.equal(G.sumSeats(v.items), big));
}

// ---- 3. HelmSizing table: defaults, flags, legacy quotes, dialog ----
const G7 = (g) => Math.ceil(g * 7 / 10);
for (const g of [0, 1, 2, 3, 7, 9, 10, 69, 70, 99, 100, 233, 500, 700, 999, 1000, 1001, 5000, 20000]) {
  assert.equal(S.defaultChairs(g), G7(g)); assert.equal(S.defaultChairs(String(g)), G7(g));
  assert.equal(S.quoteChairs({ guests: g }, {}), G7(g));
  for (const m of [0, 1, g, g + 5, 1e6]) {
    assert.equal(S.quoteChairs({ guests: g, chairs: m, chairsManual: true }, { chairs: 3, chairsManual: true }), m, `manual ${m}`);
    const d = S.dialogSizing({ guests: g, chairs: m, chairsManual: true }, {}, null, null, null);
    assert.equal(d.chairs, m); assert.equal(d.tables, Math.ceil(m / 8)); assert.equal(d.chairsManual, true);
  }
  n++;
}
for (const bad of [-1, -0.5, '', 'abc', null, undefined, NaN, Infinity]) {
  assert.equal(S.defaultChairs(bad), null, 'bad guests ' + bad); assert.equal(S.quoteChairs({ guests: bad }, {}, null), null);
  assert.equal(S.layoutChairsNote(bad, bad), null);
}
assert.equal(S.defaultChairs(9.6), 7);               // decimals round first (10 → 7)
assert.equal(S.defaultTables(700), 88); assert.equal(S.defaultTables(650), 82); assert.equal(S.defaultTables(0), 0); assert.equal(S.defaultTables(1), 1);
// manual flags: reset really resets, typing marks manual, guests re-derive only while not manual
let c = S.merge({}, { guests: 1000 }); assert.equal(c.chairs, 700); assert.equal(c.tables, 88);
c = S.merge(c, { chairs: 650, chairsManual: true }); assert.equal(c.chairs, 650); assert.equal(c.tables, 82);
c = S.merge(c, { guests: 2000 }); assert.equal(c.chairs, 650, 'manual chairs survive a guests change');
c = S.merge(c, { chairsManual: false, guests: 2000 }); assert.equal(c.chairs, 1400, 'reset re-derives');
// R9 fix: client flag is authoritative — a reset on the client is not undone by a stale pricing flag
assert.equal(S.quoteChairs({ guests: 1000, chairs: 700, chairsManual: false }, { chairs: 650, chairsManual: true }), 700);
assert.equal(S.isChairsManual({ guests: 1000, chairsManual: false }, { chairs: 650, chairsManual: true }), false);
// R9 fix: a pre-R8 quote (no flags anywhere) keeps the chairs it was billed for — total unchanged on open
assert.equal(S.quoteChairs({ guests: 200 }, { chairs: 150, guests: 200 }), 150);
assert.equal(S.isChairsManual({ guests: 200 }, { chairs: 150 }), true);
assert.equal(S.quoteChairs({ guests: 200 }, { chairs: 140 }), 140);
assert.equal(S.isChairsManual({ guests: 200 }, { chairs: 140 }), false);
// layout note only when different
assert.equal(S.layoutChairsNote(650, 650), null); assert.equal(S.layoutChairsNote(650, 0), null);
assert.equal(S.layoutChairsNote(650, 700).text, 'Layout has 700 chairs — use 700 for pricing?');
// coordinator live bug: right panel 700 → 650, dialog must show 650 / 82 (not the ?gen 700 / 88)
const dz = S.dialogSizing({ guests: 1000, chairs: 650, chairsManual: true, hallLen: 120, hallWid: 80 }, { chairs: 650, chairsManual: true }, null, 1000, null);
assert.deepEqual([dz.guests, dz.chairs, dz.tables, dz.len, dz.wid], [1000, 650, 82, 120, 80]);
assert.equal(S.dialogSizing({ guests: 1000, tables: 50, tablesManual: true, chairs: 650, chairsManual: true }, {}).tables, 50);
assert.equal(S.dialogSizing({}, {}, { w: 60, h: 40 }, 100, 10).tables, 7);   // 70 chairs / 10 per table
// plates default = guests and stay editable
assert.equal(S.resolve({ guests: 300 }, {}).plates, 300); assert.equal(S.resolve({ guests: 300 }, { guests: 280 }).plates, 280);

// ---- 4. flow reconcile follows the quote's one chairs value (never the layout) ----
let r = L.reconcile({ chairs: 700, other: 0, otherAuto: 0 }, { chairs: 900 }, { guests: 1000, chairs: 650, chairsManual: true });
assert.equal(r.chairs, 650); assert.ok(r.chairsChanged && r.chairsMismatch);
r = L.reconcile({ chairs: 150 }, { chairs: 300 }, { guests: 200 });   // legacy: unchanged
assert.equal(r.chairs, 150); assert.equal(r.chairsChanged, false);

// ---- 5. server parity: D8 authority bills pricing.chairs; nothing server-side derives chairs from a layout ----
const d8 = rd('supabase/migrations/0001_pricing_authority.sql');
assert.match(d8, /chairs\s*:= coalesce\(\(p->>'chairs'\)::numeric, 0\)/);
assert.match(d8, /rental\s*:= chairs \* chair_price \+ other/);
const store = rd('public/store-api.js');
const qt = store.slice(store.indexOf('const chairs=+p.chairs||0'), store.indexOf('const chairs=+p.chairs||0') + 400);
assert.match(qt, /chairs=\+p\.chairs\|\|0/); assert.match(qt, /chairs\*chairPrice/);
// every client writes pricing.chairs = the displayed quoteChairs value
const bjs = rd('public/builder.js'), flow = rd('public/flow.html'), quotes = rd('public/quotes.html');
assert.match(bjs, /const chairs = quoteChairsNow\(\);/);
assert.match(flow, /HelmSizing\.quoteChairs\(cl, pr, null\)/);
assert.match(flow, /chairsManual=HelmSizing\.isChairsManual\(cl,pr\)/);
assert.match(quotes, /event-sizing\.js\?v=3/);
assert.match(quotes, /HelmSizing\.quoteChairs\(cl,pr,seats\)/);
assert.match(quotes, /pricing = \{ \.\.\.p, computed:t, total:t\.total, client, chairsManual, otherAuto: prevPr\.otherAuto \}/);
// builder: Custom Event dialog re-reads the quote on every open; writes chairs back; ?gen never beats saved guests
assert.match(bjs, /if\(!wasOpen\) _ceFresh=true;/);
assert.match(bjs, /if\(currentQuoteId\) fill\('c_chairs', quoteChairsNow\(\)\)/);
assert.match(bjs, /\$\('#c_chairs'\)\.addEventListener\('change',\(\)=>\{ const v=\$\('#c_chairs'\)\.value; if\(v!=='' && currentQuoteId && !RO\) setQuoteChairs\(v\); \}\);/);
assert.match(bjs, /ceAutoFill\(\); resetQuoteChairs\(\);/);
assert.match(bjs, /if\(guests && PRICING\.guests==null\)\{ PRICING\.guests=guests;/);
assert.match(bjs, /renderPrice\(\); syncChairsPanel\(\); \}catch\(e\)\{\}   \/\/ R9/);
for (const f of ['public/builder.html', 'public/flow.html', 'public/capture.html']) {
  const h = rd(f); if (/event-sizing\.js/.test(h)) assert.match(h, /event-sizing\.js\?v=3/, f);
  if (/flow-layout-sync\.js/.test(h)) assert.match(h, /flow-layout-sync\.js\?v=4/, f);
}
console.log(`r9-sizing-matrix: ${n} generated layouts + sizing cases OK`);
