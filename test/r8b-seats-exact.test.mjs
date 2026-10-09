/* r8b-seats-exact.test.mjs — generated layouts carry EXACTLY the quote's seats value N.
 * (loader copied from layout-generator-overlap.test.mjs) — fix #5: generated layouts (builder "Generate layout")
 * never place bars / buffet / exits / stage pieces over seating, and seats never stack.
 * Pure Node: the generator is lifted out of public/builder.js by brace matching. */
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


let n = 0;
const TYPES = [{ type: 'wedding' }, { type: 'conference' }, { type: 'concert', stage: true }, { type: 'gala', head: true, bars: 2, buffet: true }, { type: 'reception', lounge: true }];
const HALLS = [[200, 140], [120, 80], [60, 40]];
for (const [w, h] of HALLS) for (const base of TYPES) for (const N of [7, 70, 233, 700, 1000]) {
  G.WORLD.w = w; G.WORLD.h = h;
  for (const v of G.generateVariants({ ...base, guests: Math.ceil(N / 0.7), chairs: N })) {
    assert.equal(G.sumSeats(v.items), N, `${w}x${h} ${base.type} N=${N} "${v.name}" has ${G.sumSeats(v.items)} seats`);
    assert.equal(v.counts.chairs, N);
    n++;
  }
}
// exactSeats on its own: trims trailing seating, fills shortfalls, partial last row
G.WORLD.w = 200; G.WORLD.h = 140;
const blk = () => [{ id: 'a', type: 'seatblock', x: 10, y: 10, width: 30, height: 24, rotation: 0, properties: { rows: 10, cols: 14 } }];
for (const N of [1, 13, 140, 141, 333]) { const it = G.exactSeats(blk(), N); assert.equal(G.sumSeats(it), N, 'block → ' + N); }
const tabs = [0, 1, 2].map((i) => ({ id: 't' + i, type: 'table', x: 10 + i * 9, y: 10, width: 6, height: 6, properties: { seats: 8 } }));
assert.equal(G.sumSeats(G.exactSeats(tabs.map((t) => ({ ...t, properties: { ...t.properties } })), 19)), 19);
assert.equal(G.sumSeats(G.exactSeats(tabs.map((t) => ({ ...t, properties: { ...t.properties } })), 30)), 30);
assert.match(G.seatFitWarning(700, 300), /^700 seats need ~[\d,]+ sq ft; hall is 28,000 sq ft$/);
assert.equal(G.seatFitWarning(700, 900), '');
console.log(`r8b-seats-exact: ${n} generated layouts have exactly N seats`);
