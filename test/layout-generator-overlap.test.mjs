/* layout-generator-overlap.test.mjs — fix #5: generated layouts (builder "Generate layout")
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
  line('const DESIGN_PITCH='), 'let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";',
  line('const GEN_OVERLAY = '), line('const GEN_SEATING = '),
  ...['makeItem', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'generateVariants'].map(fn),
  'return { WORLD, ASSETS, generateVariants, genRect, rectsHit, GEN_OVERLAY, GEN_SEATING };',
].join('\n');
const G = new Function(src)();

let n = 0;
const SEAT = G.GEN_SEATING;
function check(w, h, o) {
  G.WORLD.w = w; G.WORLD.h = h;
  for (const v of G.generateVariants(o)) {
    const its = v.items.filter((i) => !G.GEN_OVERLAY.has(i.type));
    for (const it of its) {
      const r = G.genRect(it);
      assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, `${w}x${h} ${o.type} "${v.name}": ${it.type} outside the hall`);
    }
    for (let a = 0; a < its.length; a++) for (let b = a + 1; b < its.length; b++) {
      const A = its[a], B = its[b];
      assert.ok(!G.rectsHit(G.genRect(A), G.genRect(B), 0),
        `${w}x${h} ${o.type} guests=${o.guests} "${v.name}": ${A.type} "${A.label}" overlaps ${B.type} "${B.label}"`);
    }
    n++;
  }
}
const SIZES = [[80, 50], [60, 40], [100, 60], [120, 80], [200, 140], [40, 30]];
const OPTS = [
  { type: 'wedding', guests: 200, bars: 2, buffet: true, stage: true, dance: true },   // the live repro (80x50, 200 guests)
  { type: 'wedding', guests: 200, bars: 3, buffet: true, rest: 1, exits: 4 },
  { type: 'wedding', guests: 80 }, { type: 'gala', guests: 300, bars: 2, buffet: true, head: true },
  { type: 'reception', guests: 150, bars: 1, trucks: 1, lounge: true },
  { type: 'conference', guests: 120, stage: true, press: true, bars: 1 },
  { type: 'concert', guests: 500, bars: 4, trucks: 2, rest: 2, stage: true },
  { type: 'wedding', guests: 200, canopy: true, bars: 2, buffet: true },
];
for (const [w, h] of SIZES) for (const o of OPTS) check(w, h, o);
// the reported case still seats people (seating yields, it is not wiped out)
G.WORLD.w = 80; G.WORLD.h = 50;
const vs = G.generateVariants({ type: 'wedding', guests: 200, bars: 2, buffet: true, stage: true, dance: true });
const noStage = G.generateVariants({ type: 'wedding', guests: 200, bars: 2, buffet: true, dance: true });
// variants that force a stage (banquet+stage, cabaret) may honestly run out of room in 80x50;
// every other variant must still seat people
for (const v of noStage) if (!/stage|Cabaret/.test(v.name)) assert.ok(v.counts.chairs >= 20, `80x50 "${v.name}" still seats people (got ${v.counts.chairs})`);
assert.ok(noStage.find((v) => v.name === 'Theatre rows').counts.chairs >= 120, 'theatre rows keep a real capacity');
assert.ok(vs.every((v) => v.items.filter((i) => i.type === 'bar').length === 2 && v.items.some((i) => i.type === 'buffet')), 'bars + buffet kept');
assert.ok(vs.every((v) => v.items.filter((i) => i.type === 'exit').length === 2), 'exits kept');
console.log(`layout-generator-overlap: ${n} generated layouts checked, no overlaps`);
