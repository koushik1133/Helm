/* v-spread.test.mjs — event defaults use the whole hall: seating spans or is centred in the floor behind the
 * stage, stage centred, exits in different corners, generator outside the seating; exact N / no overlaps kept. */
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
for (const fam of Object.keys(G.EVENT_DEFAULT_REQUIRED)) for (const [w, h] of [[80, 50], [200, 140], [262, 164], [300, 200]]) for (const N of [100, 700, 2000]) {
  G.WORLD.w = w; G.WORLD.h = h; const tag = `${fam} ${w}x${h} N=${N}`;
  const items = G.buildEventDefault(fam, N);
  assert.equal(G.sumSeats(items), N, tag + ' exact N');
  const solid = items.filter((i) => !G.GEN_OVERLAY.has(i.type));
  for (let a = 0; a < solid.length; a++) { const r = G.genRect(solid[a]);
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= w + 1e-6 && r.y + r.h <= h + 1e-6, tag + ' inside');
    for (let b = a + 1; b < solid.length; b++) assert.ok(!G.rectsHit(r, G.genRect(solid[b]), 0), `${tag} overlap ${solid[a].type}/${solid[b].type}`); }
  const st = G.genRect(items.find((i) => i.type === 'stage'));
  assert.ok(Math.abs(st.x + st.w / 2 - w / 2) <= w * 0.05, tag + ' stage centred');
  const seats = items.filter((i) => G.sumSeats([i]) > 0).map(G.genRect);
  assert.ok(seats.length, tag + ' has seating');
  const bb = { x0: Math.min(...seats.map((r) => r.x)), y0: Math.min(...seats.map((r) => r.y)),
    x1: Math.max(...seats.map((r) => r.x + r.w)), y1: Math.max(...seats.map((r) => r.y + r.h)) };
  // available depth = behind the front zone (stage, barricade, standing zone / dance floor)
  const front = items.filter((i) => ['stage', 'barricade', 'dancefloor'].includes(i.type)).map(G.genRect);
  const a0 = Math.max(...front.map((r) => r.y + r.h)), depth = h - a0;
  const span = (bb.y1 - bb.y0) / depth, off = Math.abs((bb.y0 + bb.y1) / 2 - (a0 + h) / 2) / depth;
  assert.ok(span >= 0.5 || off <= 0.1, `${tag} seating uses the floor (span ${span.toFixed(2)}, offset ${off.toFixed(2)})`);
  const corner = (r) => (r.x + r.w / 2 < w / 2 ? 'L' : 'R') + (r.y + r.h / 2 < h / 2 ? 'T' : 'B');
  const exits = items.filter((i) => i.type === 'exit').map(G.genRect);
  assert.ok(exits.length >= 2 && new Set(exits.map(corner)).size >= 2, tag + ' exits in different corners');
  if (h > 150) assert.ok(exits.length >= 3, tag + ' side emergency exit');
  const gen = items.find((i) => i.type === 'generator');
  if (gen) { const g = G.genRect(gen);
    assert.ok(!(g.x < bb.x1 && g.x + g.w > bb.x0 && g.y < bb.y1 && g.y + g.h > bb.y0), tag + ' generator outside seating'); }
  n++;
}
console.log(`v-spread: ${n} default layouts use the hall`);
