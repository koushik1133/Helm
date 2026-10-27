/* walk-layouts.mjs — the R49 walkaround analysts' sample layouts, shared by test/walkthrough*.test.mjs, the
 * perf budget and the visual harness (test/walkaround-visual.harness.mjs). Feet, top-left origin, y down. */

// ---- coverage analyst: wedding (266 items), theatre, gala, mixed outdoor, empty, tiny ----
let n = 0;
const it = (type, x, y, w, h, props, extra) =>
  Object.assign({ id: type + '-' + (++n), type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});

// round table at (cx,cy) with 8 separate chiavari chairs (how "Arrange chairs" lays singles out) + centrepiece on top
function tableWithChairs(cx, cy, label) {
  const out = [it('table', cx - 3, cy - 3, 6, 6, { seats: 8 }, { label })];
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; out.push(it('chiavari', cx + Math.cos(a) * 4.2 - 0.8, cy + Math.sin(a) * 4.2 - 0.8, 1.6, 1.6)); }
  out.push(it('centrepiece', cx - 1, cy - 1, 2, 2));
  return out;
}

function wedding() {
  const items = [
    it('stage', 80, 6, 40, 16, {}, { label: 'Stage' }),
    it('mandap', 92, 6, 16, 16),                         // mandap ON the stage (nested)
    it('stagebackdrop', 88, 6, 24, 2),                   // backdrop on the stage edge
    it('redcarpet', 97, 60, 6, 72),                      // aisle from the entrance to the dance floor
    it('floralentrance', 93, 134, 14, 4, {}, { label: 'Entrance Floral Arch' }),                // entrance arch at the back wall
    it('exit', 0, 60, 2, 12, {}, { label: 'Side exit' }),
    it('dancefloor', 85, 30, 30, 24),
    it('welcomeboard', 110, 128, 3, 2.5),
  ];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) {
    items.push(...tableWithChairs(20 + c * 16, 64 + r * 18, 'L' + (r * 4 + c + 1)));
    items.push(...tableWithChairs(132 + c * 16, 64 + r * 18, 'R' + (r * 4 + c + 1)));
  }
  items.push(it('buffet', 182, 10, 3, 18), it('buffet', 182, 32, 3, 18), it('livecounter', 160, 8, 8, 4), it('caketable', 150, 30, 4, 4));
  items.push(it('bar', 6, 10, 4, 14), it('barstool', 12, 12, 1.6, 1.6), it('barstool', 12, 16, 1.6, 1.6), it('barstool', 12, 20, 1.6, 1.6));
  items.push(it('photobooth', 4, 124, 8, 8), it('photobooth', 186, 124, 8, 8));   // two corners
  items.push(it('chandelier', 38, 80, 4, 4), it('chandelier', 158, 80, 4, 4));      // over the table blocks
  for (let k = 0; k < 6; k++) items.push(it('uplight', 3 + k * 38, 2, 1, 1));
  return { name: 'wedding', hall: { w: 200, h: 140 }, items };
}

function theatre() {
  const items = [
    it('stage', 45, 4, 60, 18), it('podium', 90, 10, 3, 3), it('lectern', 55, 12, 2.5, 2),
    it('ledscreen', 8, 8, 24, 2), it('ledscreen', 118, 8, 24, 2),
    it('chairrow', 45, 30, 26, 2, { rows: 1, cols: 12 }, { label: 'VIP row 1' }), it('chairrow', 79, 30, 26, 2, { rows: 1, cols: 12 }, { label: 'VIP row 2' }),
    it('foh', 71, 100, 8, 8), it('exit', 0, 50, 2, 10), it('exit', 148, 50, 2, 10), it('exit', 68, 138, 14, 2, {}, { label: 'Main entrance' }),
    it('desk', 60, 128, 8, 2.5, {}, { label: 'Registration' }), it('desk', 82, 128, 8, 2.5, {}, { label: 'Registration' }),
    it('bar', 120, 126, 14, 4, {}, { label: 'Coffee bar' }), it('press', 4, 110, 24, 12),
  ];
  // 4 x 2 seating blocks with a centre aisle and a cross aisle
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) items.push(it('seatblock', 20 + c * 58, 38 + r * 16, 52, 12, { rows: 5, cols: 24 }));
  return { name: 'theatre', hall: { w: 150, h: 140 }, items };
}

function gala() {
  const items = [
    it('stage', 90, 4, 60, 20), it('videowall', 108, 4, 24, 3), it('headtable', 101, 14, 38, 3, { seats: 12 }),
    it('dancefloor', 95, 30, 50, 30), it('bar', 6, 60, 4, 20), it('bar', 230, 60, 4, 20),
    it('piano', 70, 34, 8, 6), it('photobooth', 220, 140, 10, 10), it('coatcheck', 10, 146, 10, 4),
    it('checkpoint', 112, 152, 6, 3), it('trophytable', 160, 34, 6, 2.5), it('trophytable', 168, 34, 6, 2.5),
  ];
  for (const [x, y] of [[4, 4], [224, 4], [4, 120], [224, 120]]) items.push(it('lounge', x, y, 12, 9));
  for (let r = 0; r < 5; r++) for (let c = 0; c < 6; c++) {
    const x = 20 + c * 40 + (r % 2) * 10; if (x > 225) continue;
    items.push(it('table', x, 66 + r * 16, 6, 6, { seats: 10 }));
  }
  return { name: 'gala', hall: { w: 240, h: 160 }, items };
}

function mixed() {
  const items = [
    it('entrancegate', 140, 194, 16, 4, {}, { label: 'Entrance Gate' }), it('walkway', 145, 150, 6, 44), it('stage', 120, 6, 60, 20), it('ledscreen', 100, 8, 16, 2),
    it('tent', 10, 40, 60, 50), it('parking', 230, 150, 60, 40), it('bleacher', 120, 40, 24, 8), it('bleacher', 156, 40, 24, 8),
    it('kidszone', 220, 20, 30, 24), it('restroom', 270, 90, 12, 8), it('generator', 285, 5, 10, 4), it('firstaid', 6, 180, 8, 8),
    it('stageroof', 120, 6, 60, 24),
  ];
  for (let k = 0; k < 4; k++) items.push(it('truck', 10 + k * 26, 110, 22, 8));
  for (let k = 0; k < 6; k++) items.push(it('booth', 200 + (k % 3) * 12, 100 + Math.floor(k / 3) * 12, 10, 10));
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) items.push(it('table', 16 + c * 14, 48 + r * 14, 6, 6, { seats: 8 }));  // inside the tent
  items.push(it('cocktail', 160, 70, 3.5, 3.5, { seats: 3 }), it('cocktail', 168, 74, 3.5, 3.5, { seats: 3 }), it('cocktail', 176, 70, 3.5, 3.5, { seats: 3 }));
  items.push(it('cableramp', 150, 30, 6, 1), it('distro', 182, 20, 3, 2));
  return { name: 'mixed', hall: { w: 300, h: 200 }, items };
}

function empty() { return { name: 'empty', hall: { w: 200, h: 140 }, items: [] }; }
function tiny() { return { name: 'tiny', hall: { w: 12, h: 10 }, items: [it('table', 3, 2, 6, 6, { seats: 4 }), it('chiavari', 1, 4, 1.6, 1.6)] }; }
export const COVERAGE = [wedding, theatre, gala, mixed, empty, tiny].map((f) => { const l = f(); return [l.name, l.items, l.hall]; });

// ---- edge-case analyst: 19 nasty layouts ----
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
let nid = 0;
const eit = (type, x, y, w, h, props, extra) => Object.assign({ id: type + '-' + (nid++), type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});

// ---- camera constants mirrored from builder-3d.js (initScene / zoomLimits / setWalkMode) ----

const L = [];
L.push(['01 empty hall', [], { w: 200, h: 140 }]);
L.push(['02a one item (plain table, no seats)', [eit('table', 95, 65, 6, 6)], { w: 200, h: 140 }]);
L.push(['02b one item (stage)', [eit('stage', 70, 10, 60, 24)], { w: 200, h: 140 }]);
{ const a = [eit('stage', 150, 10, 100, 24)]; const types = ['table', 'chiavari', 'buffet', 'bar', 'pillar', 'uplight', 'speaker', 'planter', 'cocktail', 'photobooth', 'lanterns', 'signage'];
  for (let i = 0; i < 499; i++) { const t = types[i % types.length]; a.push(eit(t, 5 + rand() * 380, 40 + rand() * 250, t === 'buffet' ? 16 : 5, t === 'buffet' ? 4 : 5, t === 'table' ? { seats: 8 } : {})); }
  L.push(['03 500 items', a, { w: 400, h: 300 }]); }
L.push(['04a huge hall 1000x1000, tiny items', [eit('stage', 480, 10, 40, 16), eit('piano', 100, 900, 1, 1), eit('fountain', 900, 900, 1, 1), eit('bar', 10, 500, 1, 1), eit('table', 500, 500, 1, 1, { seats: 2 })], { w: 1000, h: 1000 }]);
L.push(['04b uncapped hall 3000x3000 (template/sandbox path)', [eit('stage', 1480, 10, 40, 16), eit('bar', 2900, 2900, 4, 2)], { w: 3000, h: 3000 }]);
L.push(['05 tiny hall 20x20, stage 18x18', [eit('stage', 1, 1, 18, 18), eit('exit', 8, 19, 4, 1)], { w: 20, h: 20 }]);
L.push(['06 items outside hall', [eit('stage', 70, -40, 60, 24), eit('bar', 230, 60, 20, 5), eit('photobooth', -30, 120, 10, 10), eit('table', 90, 200, 6, 6, { seats: 8 }), eit('table', 300, 300, 6, 6, { seats: 8 })], { w: 200, h: 140 }]);
L.push(['07 overlapping items', [eit('stage', 70, 10, 60, 24), eit('dancefloor', 70, 10, 60, 24), eit('buffet', 90, 60, 20, 6), eit('bar', 90, 60, 20, 6), eit('photobooth', 92, 60, 10, 10),
  eit('table', 100, 100, 6, 6, { seats: 8 }), eit('table', 100, 100, 6, 6, { seats: 8 }), eit('table', 101, 101, 6, 6, { seats: 8 })], { w: 200, h: 140 }]);
L.push(['08 rotated 45deg', [eit('stage', 70, 30, 60, 24, {}, { rotation: 45 }), eit('redcarpet', 120, 60, 6, 60, {}, { rotation: 45 }), eit('ledscreen', 20, 20, 20, 2, {}, { rotation: 45 }),
  eit('buffet', 150, 100, 30, 6, {}, { rotation: '45' }), eit('table', 60, 100, 6, 6, { seats: 8 }, { rotation: 45 })], { w: 200, h: 140 }]);
{ // L-shape: 200x140 rect, top-right quadrant 100x70 is "not hall" — closed off with fence/drape lines; items only in the L
  const a = [eit('fence', 100, 0, 1, 70), eit('fence', 100, 70, 100, 1), eit('stage', 20, 5, 60, 20), eit('bar', 170, 120, 20, 5), eit('buffet', 150, 90, 20, 6),
    eit('table', 30, 60, 6, 6, { seats: 8 }), eit('table', 60, 100, 6, 6, { seats: 8 }), eit('table', 140, 110, 6, 6, { seats: 8 }), eit('photobooth', 185, 80, 10, 10)];
  L.push(['09 L-shaped hall (notch fenced off)', a, { w: 200, h: 140 }]); }
L.push(['10 outdoor: tents over tables, no walls', [eit('stage', 70, 10, 60, 24), eit('tent', 20, 50, 160, 80), eit('table', 40, 70, 6, 6, { seats: 8 }), eit('table', 140, 110, 6, 6, { seats: 8 }),
  eit('buffet', 60, 100, 20, 6), eit('generator', 190, 130, 8, 6)], { w: 200, h: 140, setting: 'outdoor' }]);
L.push(['11 multi-level: stage + stageroof + dais + viprisers + walkway', [eit('stage', 70, 10, 60, 24), eit('stageroof', 68, 8, 64, 28), eit('walkway', 97, 34, 6, 40), eit('dais', 20, 60, 20, 10),
  eit('viprisers', 150, 60, 30, 20), eit('seatblock', 60, 90, 80, 30, { rows: 8, cols: 20 })], { w: 200, h: 140 }]);
L.push(['12 zero-size items', [eit('stage', 100, 20, 0, 0), eit('table', 50, 50, 0, 0, { seats: 8 }), eit('bar', 150, 100, 0, 0), eit('dancefloor', 80, 60, NaN, -5), eit('photobooth', 10, 10, 0, 12)], { w: 200, h: 140 }]);
L.push(['13 unknown / hostile types', [eit('stage', 70, 10, 60, 24), eit('spaceship', 100, 80, 20, 20), eit('constructor', 40, 90, 10, 10), eit('toString', 150, 90, 6, 6), eit('__proto__', 20, 20, 4, 4), eit(5, 160, 30, 6, 6), eit('', 10, 120, 5, 5)], { w: 200, h: 140 }]);
L.push(['14 duplicate ids', [Object.assign(eit('stage', 70, 10, 60, 24), { id: 'dup' }), Object.assign(eit('stage', 70, 110, 60, 24), { id: 'dup' }), Object.assign(eit('checkpoint', 10, 130, 4, 4), { id: 'x' }), Object.assign(eit('checkpoint', 186, 130, 4, 4), { id: 'x' }),
  Object.assign(eit('bar', 10, 60, 20, 5), { id: 'x' })], { w: 200, h: 140 }]);
L.push(['15 very long thin hall 1000x12', [eit('stage', 2, 1, 10, 10), eit('table', 300, 3, 6, 6, { seats: 8 }), eit('table', 700, 3, 6, 6, { seats: 8 }), eit('bar', 900, 1, 20, 4), eit('buffet', 500, 7, 20, 4), eit('exit', 990, 4, 4, 4)], { w: 1000, h: 12 }]);
// extras that fell out of the scenarios above
L.push(['16 seating in the round (seats around stage centre)', [eit('stage', 90, 60, 20, 20), ...Array.from({ length: 8 }, (_, k) => eit('table', 97 + Math.cos(k * Math.PI / 4) * 40, 67 + Math.sin(k * Math.PI / 4) * 40, 6, 6, { seats: 8 }))], { w: 200, h: 140 }]);
L.push(['17 two seating clusters far apart', [eit('stage', 70, 10, 60, 24), eit('table', 10, 100, 6, 6, { seats: 8 }), eit('table', 184, 100, 6, 6, { seats: 8 })], { w: 200, h: 140 }]);
L.push(['18 hall as strings / bad hall', [eit('stage', 70, 10, 60, 24)], { w: '300', h: '200' }]);
L.push(['19 null/garbage entries', [null, undefined, 5, 'x', {}, { type: 'bar' }, eit('stage', 70, 10, 60, 24)], { w: 200, h: 140 }]);
export const EDGES = L;

// ---- occlusion analyst: L1-L7 ----
const OCC = [];
const oit = (type, x, y, w, h, props, extra) => Object.assign({ id: type + x + '_' + y, type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});
const H200 = { w: 200, h: 140 };
// L1: the existing unit-test "full" layout
const tables = Array.from({ length: 14 }, (_, i) => oit('table', 30 + (i % 7) * 20, 60 + Math.floor(i / 7) * 20, 6, 6, { seats: 8 }));
OCC.push(['L1 test full layout', [oit('stage', 70, 10, 60, 24), oit('exit', 95, 136, 10, 4), oit('redcarpet', 97, 100, 6, 30), ...tables,
  oit('dancefloor', 80, 40, 40, 16), oit('buffet', 170, 60, 20, 6), oit('bar', 10, 110, 20, 5), oit('photobooth', 170, 110, 10, 10),
  oit('fountain', 10, 10, 8, 8), oit('ledscreen', 20, 10, 20, 2)], H200]);

// L2: wedding hall 120x90 - mandap in the middle aisle, a row of 4 structural pillars, LED screens either side of stage,
// photobooth on the left wall with floral pillars between it and the centre, bar in a corner, buffet right wall.
const H2 = { w: 120, h: 90 };
const L2 = [oit('stage', 40, 4, 40, 16), oit('ledscreen', 22, 6, 14, 1), oit('ledscreen', 84, 6, 14, 1),
  oit('mandap', 52, 40, 16, 16), oit('exit', 55, 86, 10, 4),
  oit('pillar', 30, 30, 3, 3), oit('pillar', 87, 30, 3, 3), oit('pillar', 30, 60, 3, 3), oit('pillar', 87, 60, 3, 3),
  ...Array.from({ length: 8 }, (_, i) => oit('table', 10 + (i % 4) * 8 + (i > 3 ? 70 : 0), 66 + (i % 2) * 8, 6, 6, { seats: 8 })),
  oit('photobooth', 2, 40, 10, 8, {}, { rotation: 90 }), oit('floralpillar', 16, 42, 3, 3), oit('floralpillar', 16, 46, 3, 3),
  oit('bar', 100, 80, 16, 4), oit('buffet', 112, 30, 6, 24, {}, {}), oit('chandelier', 54, 25, 12, 12), oit('dancefloor', 45, 22, 30, 14)]
OCC.push(['L2 wedding with mandap + pillars', L2, H2]);

// L3: outdoor lawn, one big tent covering most of the floor
const H3 = { w: 160, h: 120 };
OCC.push(['L3 tent over the lawn', [oit('tent', 10, 10, 140, 100), oit('stage', 55, 14, 50, 16), oit('dancefloor', 60, 40, 40, 20),
  ...Array.from({ length: 12 }, (_, i) => oit('table', 20 + (i % 6) * 22, 70 + Math.floor(i / 6) * 16, 6, 6, { seats: 8 })), oit('bar', 130, 100, 16, 5)], H3]);

// L4: dense theatre seating, no free floor near the seating centre
const H4 = { w: 100, h: 80 };
OCC.push(['L4 wall-to-wall seat blocks', [oit('stage', 30, 2, 40, 12),
  ...Array.from({ length: 12 }, (_, i) => oit('seatblock', 3 + (i % 3) * 32, 20 + Math.floor(i / 3) * 15, 30, 13, { rows: 6, cols: 15 }))], H4]);

// L5: LED screen against the back wall (front faces the wall) + photobooth in a corner behind a truss tower
OCC.push(['L5 screen facing wall / booth behind truss', [oit('stage', 30, 5, 40, 14), oit('ledscreen', 40, 76, 20, 1, {}, { rotation: 0 }),
  oit('photobooth', 2, 2, 10, 10), oit('truss', 14, 14, 4, 4), oit('speaker', 12, 12, 3, 3)], { w: 100, h: 80 }]);

// L6: small hall (40x30) - stage + bar; zone camera d = r + 12 overshoots the walls
OCC.push(['L6 small room', [oit('stage', 10, 1, 20, 8), oit('bar', 2, 24, 12, 4), oit('photobooth', 30, 22, 8, 7), oit('table', 17, 15, 6, 6, { seats: 8 })], { w: 40, h: 30 }]);

// L7: entrance blocked view - a stagebackdrop/photo wall placed in the middle of the hall between the entry and the stage
OCC.push(['L7 tall decor between entry and stage', [oit('stage', 60, 4, 80, 20), oit('exit', 95, 136, 10, 4), oit('brandwall', 80, 90, 40, 2),
  oit('truss', 60, 70, 4, 4), oit('truss', 136, 70, 4, 4), oit('led', 70, 60, 60, 2)], H200]);
export const OCCLUSION = OCC;

// ---- visual harness: the two unit-test layouts + a rotated wedding ----
const hit = (type, x, y, w, h, props, extra) => Object.assign({ id: type + '_' + x + '_' + y, type, x, y, width: w, height: h, rotation: 0, properties: props || {} }, extra || {});
export const LAYOUTS = [
  { // = test/walkthrough.test.mjs "full" banquet
    name: 'banquet-200x140', hall: { w: 200, h: 140 },
    items: [hit('stage', 70, 10, 60, 24), hit('exit', 95, 136, 10, 4), hit('redcarpet', 97, 100, 6, 30),
      ...Array.from({ length: 14 }, (_, i) => hit('table', 30 + (i % 7) * 20, 60 + Math.floor(i / 7) * 20, 6, 6, { seats: i < 7 ? 8 : 7 })),
      hit('dancefloor', 80, 40, 40, 16), hit('buffet', 170, 60, 20, 6), hit('bar', 10, 110, 20, 5), hit('photobooth', 170, 110, 10, 10),
      hit('fountain', 10, 10, 8, 8), hit('ledscreen', 20, 10, 20, 2)] },
  { // = test/walkthrough.test.mjs prod finding "rec" 80x50 reception
    name: 'reception-80x50', hall: { w: 80, h: 50 },
    items: [hit('stage', 25, 2, 30, 10), hit('ledscreen', 30, 1, 20, 1), hit('podium', 20, 6, 3, 3), hit('dancefloor', 30, 16, 20, 12),
      ...Array.from({ length: 14 }, (_, i) => hit('table', 4 + (i % 7) * 11, 31 + Math.floor(i / 7) * 9, 6, 6, { seats: 8 }, { label: 'T' + (i + 1) })),
      hit('exit', 38, 48, 4, 2), hit('exit', 0, 25, 2, 4)] },
  { // wedding: stage on the RIGHT wall (rotated 90), mandap, pillars, chandelier, seat blocks, floral-arch entry
    name: 'wedding-150x100-rotated', hall: { w: 150, h: 100 },
    items: [hit('stage', 115, 42, 40, 16, null, { rotation: 90, label: 'Stage' }), hit('mandap', 88, 40, 20, 20),
      hit('seatblock', 35, 12, 40, 26, { rows: 8, cols: 12 }), hit('seatblock', 35, 62, 40, 26, { rows: 8, cols: 12 }),
      hit('pillar', 28, 48, 2, 2), hit('pillar', 82, 20, 2, 2), hit('pillar', 82, 78, 2, 2), hit('chandelier', 55, 47, 6, 6),
      hit('floralarch', 0, 45, 4, 10, null, { rotation: 90 }), hit('redcarpet', 6, 47, 80, 6, null, { rotation: 0 }),
      hit('buffet', 5, 90, 25, 5), hit('bar', 118, 3, 20, 5), hit('photobooth', 132, 84, 10, 10),
      hit('ledscreen', 140, 15, 20, 2, null, { rotation: 90 }), hit('sofa', 10, 5, 8, 3), hit('sofa', 10, 12, 8, 3)] },
];
export const ALL = [...COVERAGE, ...EDGES, ...OCCLUSION, ...LAYOUTS.map((l) => [l.name, l.items, l.hall])];
