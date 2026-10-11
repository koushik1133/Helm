/* layout-wizard.test.mjs — the "Create layout" requirements wizard (public/layout-wizard.js).
 * Every event type × halls 40×30, 80×50, 200×140, 262×164 × several seating configs:
 * exact planned seats (every seat counts), requested objects present with their qty/size, mandatory items on,
 * nothing overlapping, everything inside the hall, aisle carpet OFF by default and entrance→front only when on,
 * honest warnings + suggestions when the hall is too small. Plus wiring / CSP / cache-bust checks. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const js = rd('public/builder.js');
const block = (s) => { let i = js.indexOf('{', s), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const fn = (name) => { const s = js.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = js.indexOf('{', js.indexOf(')', s)), d = 0;
  for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const line = (h) => { const s = js.indexOf(h); assert.ok(s >= 0, h); return js.slice(s, js.indexOf('\n', s)); };
const B = new Function([block(js.indexOf('const ASSETS = {')) + ';', line('const round1 = '), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '),
  'let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";', fn('makeItem'), fn('genSeats'), fn('sumSeats'),
  'return { ASSETS, makeItem, genSeats, sumSeats };'].join('\n'))();
const require = createRequire(import.meta.url);
const HW = require(join(ROOT, 'public/layout-wizard.js'));
const D = { ASSETS: B.ASSETS, makeItem: B.makeItem, genSeats: B.genSeats };
let n = 0;

const rectOf = (it) => { const q = (((+it.rotation || 0) % 180) + 180) % 180, sw = q > 45 && q < 135 ? it.height : it.width, sh = q > 45 && q < 135 ? it.width : it.height;
  return { x: it.x + it.width / 2 - sw / 2, y: it.y + it.height / 2 - sh / 2, w: sw, h: sh }; };
const hit = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
function check(spec, out, tag) {
  const W = spec.hall.w, H = spec.hall.h, its = out.items;
  for (const it of its) { const r = rectOf(it);
    assert.ok([r.x, r.y, r.w, r.h].every(Number.isFinite), tag + ' finite');
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6, `${tag}: ${it.label} outside hall`); }
  const solid = its.filter((i) => !(i.properties && i.properties.onStage));
  for (let a = 0; a < solid.length; a++) for (let b = a + 1; b < solid.length; b++)
    assert.ok(!hit(rectOf(solid[a]), rectOf(solid[b])), `${tag}: ${solid[a].label} overlaps ${solid[b].label}`);
  const stage = its.find((i) => i.type === 'stage');
  for (const i of its.filter((x) => x.properties && x.properties.onStage)) { assert.ok(stage, tag + ' on-stage needs a stage');
    const r = rectOf(i), s = rectOf(stage); assert.ok(r.x >= s.x - 1e-6 && r.x + r.w <= s.x + s.w + 1e-6 && r.y >= s.y - 1e-6 && r.y + r.h <= s.y + s.h + 1e-6, tag + ' ' + i.label + ' on the stage'); }
  // seats reported == seats on the floor
  assert.equal(out.seats, B.sumSeats(its), tag + ' seat count');
}
// live-round1 B7: main seating balanced around the centre aisle (stage / walkway centre line)
globalThis.__symStats = [];
function symmetric(spec, out, tag) {
  const cx = spec.hall.w / 2; let L = 0, R = 0, mainN = 0;
  for (const it of out.items) {
    const main = it.type === 'seatblock' || it.type === 'chairrow' && /^Seating block/.test(it.label || '') || (it.type === 'table' && /^T\d/.test(it.label || '')) || it.type === 'longtable';
    if (!main) continue; const r = rectOf(it), k = B.genSeats(it); mainN++;
    const c = r.x + r.w / 2; if (Math.abs(c - cx) < 0.5) continue; if (c < cx) L += k; else R += k;
    if (it.type === 'seatblock' || it.type === 'chairrow') assert.ok(r.x + r.w <= cx + 1e-6 || r.x >= cx - 1e-6, tag + ' block crosses the centre aisle');
  }
  globalThis.__symStats.push([tag, L, R]);
  const tol = Math.max(1, Math.ceil((L + R) * 0.02));
  assert.ok(Math.abs(L - R) <= tol, `${tag}: unbalanced seating L=${L} R=${R}`);
  // theatre blocks: mirrored x around the centre
  const blocks = out.items.filter((i) => i.type === 'seatblock').map(rectOf);
  for (const b of blocks) assert.ok(blocks.some((o) => Math.abs((o.x + o.w / 2 - cx) + (b.x + b.w / 2 - cx)) < 0.6 && Math.abs(o.y - b.y) < 0.6) || Math.abs(b.x + b.w / 2 - cx) < 0.6, `${tag}: block at x=${b.x.toFixed(1)} has no mirror`);
}
const SEATINGS = [
  { style: null },                                  // the type's default style
  { style: 'rounds', spt: 10 },
  { style: 'theatre', blocks: 4, cols: 12 },
  { style: 'banquet', perLong: 12 },
  { style: 'mixed' },
];
const HALLS = [[40, 30], [80, 50], [200, 140], [262, 164]];
const GUESTS = { 40: 40, 80: 160, 200: 900, 262: 1500 };
for (const type of Object.keys(HW.TYPES)) for (const [W, H] of HALLS) for (const sc of SEATINGS) {
  const spec = HW.defaults(type, { guests: GUESTS[W], w: W, h: H });
  const tag = `${type} ${W}x${H} ${sc.style || 'default'}`;
  // defaults: mandatory on, carpet off, chairs = 70% of guests
  assert.equal(spec.carpet, false, tag + ' carpet off by default');
  assert.equal(spec.chairs, Math.ceil(GUESTS[W] * 0.7), tag + ' 70% rule');
  for (const [k, o] of Object.entries(spec.objects)) if (o.mandatory) assert.ok(o.on, tag + ' mandatory ' + k);
  if (sc.style) { Object.assign(spec.seating, sc); HW.fitSeating(spec); }
  const plan = HW.seatPlan(spec);
  if (spec.seating.style !== 'standing' && plan.extras <= spec.chairs) assert.equal(plan.total, spec.chairs, tag + ' plan reconciles with the target');
  if (spec.seating.style === 'rounds' && !sc.spt) assert.equal(spec.seating.tables, Math.ceil((spec.chairs - plan.extras) / 8), tag + ' tables = chairs ÷ 8');
  const out = HW.layout(spec, D);
  check(spec, out, tag);
  assert.ok(!out.items.some((i) => i.type === 'redcarpet'), tag + ' no carpet unless chosen');
  if (out.fits) {
    assert.equal(out.seats, plan.total, tag + ' exact seats');
    for (const [k, o] of Object.entries(spec.objects)) { if (!o.on) continue; const c = HW.OBJECTS[k];
      const got = out.items.filter((i) => i.type === c.type && (k !== 'dais' || (i.properties && i.properties.onStage)) && (k !== 'viprow' || /^VIP row/.test(i.label)) && (k !== 'standing' || /Standing/.test(i.label)) && (k !== 'dancefloor' || /Dance/.test(i.label)));
      assert.ok(got.length >= (c.multi ? o.qty : 1), `${tag}: ${k} qty ${got.length}/${o.qty}`); }
  } else {
    assert.ok(out.warnings.length > 0, tag + ' warns when it does not fit');
  }
  if (out.fits) symmetric(spec, out, tag);
  if (W >= 200 && spec.seating.style !== 'mixed') assert.ok(out.fits, tag + ' big halls fit: ' + out.warnings.join(' | '));
  n++;
}
// big halls fit every default exactly, incl. mixed
for (const type of Object.keys(HW.TYPES)) { const spec = HW.defaults(type, { guests: 600, w: 200, h: 140 }); const out = HW.layout(spec, D);
  assert.ok(out.fits, type + ' default fits 200x140'); assert.equal(out.seats, spec.chairs > 0 && spec.seating.style !== 'standing' ? spec.chairs : out.extras, type + ' exact'); }

// requested sizes are honoured (dance floor ft×ft, stage L×W, LED width) and qty (buffets)
{ const spec = HW.defaults('wedding', { guests: 300, w: 200, h: 140 });
  Object.assign(spec.objects.dancefloor, { w: 30, h: 20 }); Object.assign(spec.objects.stage, { w: 40, h: 14 }); spec.objects.led.w = 14; spec.objects.buffet.qty = 3;
  const out = HW.layout(spec, D); check(spec, out, 'sizes');
  const df = out.items.find((i) => /Dance/.test(i.label)); assert.equal(df.width, 30); assert.equal(df.height, 20);
  const st = out.items.find((i) => i.type === 'stage'); assert.equal(st.width, 40); assert.equal(st.height, 14);
  assert.ok(out.items.filter((i) => i.type === 'led').every((i) => i.width === 14));
  assert.equal(out.items.filter((i) => i.type === 'buffet').length, 3);
  // stage front-centre, dance floor before the stage, exits in the back corners, buffet on a side wall
  assert.ok(Math.abs(st.x + st.width / 2 - 100) < 0.6 && st.y < 15, 'stage front centre');
  assert.ok(df.y > st.y + st.height && Math.abs(df.x + df.width / 2 - 100) < 1, 'dance floor before the stage');
  const ex = out.items.filter((i) => i.type === 'exit'); assert.ok(ex.some((e) => e.x < 5) && ex.some((e) => e.x + e.width > 195) && ex.every((e) => e.y + e.height > 125), 'exits back corners');
  assert.ok(out.items.filter((i) => i.type === 'buffet').every((b) => rectOf(b).x + rectOf(b).w > 190), 'buffets on the right wall');
  n++; }
// carpet: only entrance → front of the aisle, never through anything
{ for (const type of ['wedding', 'political', 'corporate', 'concert']) { const spec = HW.defaults(type, { guests: 400, w: 200, h: 140 }); spec.carpet = true;
    const out = HW.layout(spec, D); check(spec, out, 'carpet ' + type);
    const c = out.items.find((i) => i.type === 'redcarpet'); assert.ok(c, type + ' carpet present');
    const ent = out.items.find((i) => i.label === 'Entrance');
    assert.ok(Math.abs(c.y + c.height - ent.y) < 0.6, type + ' carpet ends at the entrance');
    const st = out.items.find((i) => i.type === 'stage'); assert.ok(c.y > st.y + st.height, type + ' carpet starts in front of the stage');
    assert.ok(c.height < 140 - 10, type + ' not "till the end"'); n++; } }
// exact controls: theatre blocks × rows × cols, trimmed to the target
{ const spec = HW.defaults('political', { guests: 1000, w: 262, h: 164 }); Object.assign(spec.seating, { style: 'theatre', blocks: 4, rows: 20, cols: 10 }); spec.chairs = 0;
  const pl = HW.seatPlan(spec); assert.equal(pl.main, 800); const out = HW.layout(spec, D); check(spec, out, 'theatre exact'); assert.ok(out.fits); assert.equal(out.seats, 800 + pl.extras);
  assert.equal(out.items.filter((i) => i.type === 'seatblock').length, 4); n++; }
{ const spec = HW.defaults('wedding', { guests: 0, w: 200, h: 140 }); spec.chairs = 0; Object.assign(spec.seating, { style: 'rounds', tables: 20, spt: 10 });
  Object.values(spec.objects).forEach((o) => { if (!o.mandatory) o.on = false; });
  const out = HW.layout(spec, D); check(spec, out, 'rounds exact'); assert.equal(out.items.filter((i) => i.type === 'table').length, 20); assert.equal(out.seats, 200); n++; }
// every seat counts: VIP sofas + VIP rows + dais
{ const spec = HW.defaults('political', { guests: 500, w: 200, h: 140 }); spec.objects.viprow.qty = 3; spec.objects.viprow.seats = 10; spec.objects.dais.seats = 6;
  const ex = HW.extraSeats(spec); assert.equal(ex, 36); HW.fitSeating(spec); const out = HW.layout(spec, D); check(spec, out, 'vip'); assert.equal(out.seats, spec.chairs); n++; }
// too-small hall → warning with suggestions, still valid geometry
{ const spec = HW.defaults('wedding', { guests: 2000, w: 40, h: 30 }); const out = HW.layout(spec, D); check(spec, out, 'tiny');
  assert.equal(out.fits, false); assert.ok(out.warnings.some((w) => /Try: a hall of about/.test(w))); n++; }
// type aliases + the per-type suggestion lists
assert.equal(HW.typeKey('Product launch'), 'product_launch'); assert.equal(HW.typeKey('Rally'), 'political'); assert.equal(HW.typeKey('Gala'), 'wedding');
assert.equal(HW.typeKey('???'), 'wedding');
for (const k of ['stage', 'mandap', 'dj', 'dancefloor', 'led', 'buffet', 'caketable', 'entrance', 'backdrop', 'floral', 'photobooth', 'bar', 'gifttable', 'vipsofa']) assert.ok(HW.defaults('wedding').objects[k], 'wedding ' + k);
for (const k of ['stage', 'podium', 'led', 'barricade', 'walkway', 'linearray', 'generator', 'press', 'viprow']) assert.ok(HW.defaults('political').objects[k], 'political ' + k);
for (const k of ['stage', 'podium', 'led', 'desk', 'brandwall', 'cocktail']) assert.ok(HW.defaults('product_launch').objects[k], 'launch ' + k);
for (const k of ['stage', 'linearray', 'barricade', 'foh', 'standing']) assert.ok(HW.defaults('concert').objects[k].mandatory, 'concert mandatory ' + k);
assert.ok(HW.defaults('birthday').objects.caketable.mandatory);
for (const t of Object.keys(HW.TYPES)) for (const k of Object.keys(HW.defaults(t).objects)) assert.ok(B.ASSETS[HW.OBJECTS[k].type], 'asset exists ' + k);

// ---- wiring ----
const bh = rd('public/builder.html');
assert.match(bh, /<script src="layout-wizard\.js\?v=7"><\/script>/); assert.match(bh, /<link rel="stylesheet" href="layout-wizard\.css\?v=4">/);
assert.match(bh, /builder\.js\?v=43/);
const lw = rd('public/layout-wizard.js');
assert.ok(!/\beval\s*\(|new Function|\.style\.|innerHTML|on[a-z]+=\s*["']/.test(lw), 'CSP-safe: no eval / inline style / innerHTML');
assert.match(lw, /helm\.layoutWizard\.v1\./, 'remembers per quote');
console.log(`  ✓ layout-wizard: ${n} configurations (types × halls × seating) + sizes, carpet, exact seats, VIP, warnings, wiring`);
