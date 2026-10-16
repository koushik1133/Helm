/* builder-tools.test.mjs — snap & grid root-cause fixes, measure offsets, product search, hide-price mode,
 * fullscreen Safari shim (public/builder-tools.js, builder.js, builder-3d.js, fullscreen.js). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = {}; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(rd('public/builder-tools.js'), cx);
const T = cx.HelmBuilderTools;
const FT_PER_M = 3.28084;

// ---- snap: metre grid stays ON the drawn lines (old path re-rounded to 0.1 ft → 3.3 / 9.8)
assert.equal(T.snapTo(3.1, FT_PER_M, true), 3.2808);
assert.equal(T.snapTo(10, FT_PER_M, true), 9.8425);
for (let n = 0; n < 200; n++) { const v = T.snapTo(n * FT_PER_M + 0.7, FT_PER_M, true); assert.ok(Math.abs(v / FT_PER_M - Math.round(v / FT_PER_M)) < 1e-4, 'metre snap on grid ' + n); }
assert.equal(T.snapTo(12.4, 1, true), 12); assert.equal(T.snapTo(12.46, 1, false), 12.5, 'snap off → 0.1 ft');
assert.equal(T.snapTo(NaN, 1, true), 0);

// ---- 3D grid alignment: every GridHelper line must coincide with a 2D grid line (hall-relative multiple of cell)
function linesOnGrid(W, H, cell) {
  const g = T.gridAlign(W, H, cell); assert.ok(Math.abs(g.size / g.divisions - cell) < 1e-9, 'cell kept');
  assert.ok(g.divisions % 2 === 0 && g.divisions <= 1200);
  for (const [len, off] of [[W, g.offX], [H, g.offZ]]) {
    for (let k = 0; k <= g.divisions; k += Math.max(1, Math.floor(g.divisions / 37))) {
      const world = off - g.size / 2 + k * cell, hallRel = world + len / 2;
      assert.ok(Math.abs(hallRel / cell - Math.round(hallRel / cell)) < 1e-6, `W${W} H${H} cell${cell}: line ${k} off-grid (${hallRel})`);
    }
  }
}
[[200, 140, 1], [75, 61, 1], [121, 33, 1], [100, 80, FT_PER_M], [65.6, 49.2, FT_PER_M], [999, 1000, 1]].forEach(([w, h, c]) => linesOnGrid(w, h, c));
// the OLD helper (gs = max+40, centred, 1 ft) was half a cell off on an odd hall — this is the regression guard
{ const W = 80, H = 61, gs = Math.max(W, H) + 40, hallRel = (-gs / 2) + H / 2; assert.ok(Math.abs(hallRel - Math.round(hallRel)) > 0.4, 'old helper was half a cell off on the short axis when W / H parity differ (80×61)'); }

// ---- measure offsets
{ const o = T.offsets({ x: 10, y: 5, width: 20, height: 10 }, { w: 100, h: 60 });
  assert.deepEqual([o.left, o.right, o.top, o.bottom, o.x, o.y], [10, 70, 5, 45, 10, 5]);
  assert.equal(o.fromCentreX, -30); assert.equal(o.fromCentreY, -20);
  assert.deepEqual(JSON.parse(JSON.stringify(o.nearestX)), { side: 'left', gap: 10 });
  assert.deepEqual(JSON.parse(JSON.stringify(o.nearestY)), { side: 'top', gap: 5 }); }
{ const o = T.offsets({ x: 90, y: 50, width: 8, height: 8 }, { w: 100, h: 60 });
  assert.equal(o.nearestX.side, 'right'); assert.equal(o.nearestX.gap, 2); assert.equal(o.nearestY.side, 'bottom'); }

// ---- product search (fuzzy name / category / tags)
const ASSETS = { stage: { label: 'Main Stage', category: 'structure' }, table: { label: 'Round Table', category: 'seating' },
  longtable: { label: 'Banquet Table', category: 'seating' }, restroom: { label: 'Restrooms', category: 'logistics' },
  speaker: { label: 'Speaker Stack', category: 'av' }, mandap: { label: 'Decor Mandap', category: 'decor' }, caketable: { label: 'Cake Table', category: 'logistics' } };
const CATS = { structure: { name: 'Structure' }, seating: { name: 'Seating' }, logistics: { name: 'Logistics' }, av: { name: 'AV' }, decor: { name: 'Decor' } };
const s = (q) => T.searchAssets(q, ASSETS, CATS, { limit: 5 }).map((r) => r.type);
assert.equal(s('stage')[0], 'stage'); assert.equal(s('round')[0], 'table');
assert.ok(s('table').includes('longtable') && s('table').includes('caketable'));
assert.equal(s('toilet')[0], 'restroom', 'tags'); assert.equal(s('sound')[0], 'speaker', 'tags');
assert.equal(s('rnd tbl')[0], 'table', 'subsequence'); assert.ok(s('seating').includes('table'), 'category');
assert.equal(s('zzzz').length, 0); assert.equal(s('').length, 0);
assert.ok(T.eventSuggestions('wedding_banquet', ASSETS).includes('mandap'));
assert.ok(T.eventSuggestions('Concert', ASSETS).includes('speaker'));
assert.equal(T.eventSuggestions('', ASSETS).length, 0);

// ---- hide-price mode
assert.deepEqual(JSON.parse(JSON.stringify(T.normPriceDisplay(null))), { hidden: false, manualAmount: null });
assert.deepEqual(JSON.parse(JSON.stringify(T.normPriceDisplay({ hidden: true, manualAmount: '125000.456' }))), { hidden: true, manualAmount: 125000.46 });
assert.equal(T.normPriceDisplay({ hidden: 'yes' }).hidden, false, 'only literal true');
assert.equal(T.normPriceDisplay({ manualAmount: -5 }).manualAmount, null); assert.equal(T.normPriceDisplay({ manualAmount: 'abc' }).manualAmount, null);

// ---- wiring
const js = rd('public/builder.js'), js3 = rd('public/builder-3d.js'), html = rd('public/builder.html'), fs = rd('public/fullscreen.js');
assert.match(js, /it\.x=posRound\(g\.ox\+dx\); it\.y=posRound\(g\.oy\+dy\)/, 'move keeps snapped precision');
assert.match(js, /store\.grid = Object\.assign\(sanitizeGrid\(data\.grid\), keep\)/, 'opening a layout keeps the planner\'s Snap / Grid toggles');
assert.match(js, /__on3DGridChange/, 'Grid toggle reaches 3D');
assert.match(js3, /HelmBuilderTools\.gridAlign\(floorW,floorH,cellFt\(\)\)/, '3D grid aligned to the 2D grid');
assert.match(js3, /it\.x=clamp\(snapFt\(cxft-it\.width\/2\)/, '3D gizmo snaps the top-left like 2D');
assert.match(js3, /floorCell===cellFt\(\)/, '3D grid rebuilt on unit change');
assert.match(js, /priceDisplay: priceDisp\(\)/, 'hide-price saved in layout + quote pricing');
assert.match(js, /if\(pd\.hidden\) renderManualPrice\(box, pd\)/);
assert.ok(!/renderManualPrice[\s\S]{0,400}innerHTML/.test(js.slice(js.indexOf('function renderManualPrice'))), 'manual price built without innerHTML');
assert.match(html, /id="assetSearch"[^>]*role="combobox"/); assert.match(html, /id="hidePriceChk"/);
assert.ok(html.indexOf('builder-tools.js') < html.indexOf('builder.js?v='), 'tools load before builder.js');
assert.ok(!/style="/.test(rd('public/builder-tools.js')) && !/innerHTML/.test(rd('public/builder-tools.js')), 'CSP-clean');

// ---- fullscreen: Safari ≤11 spelling + Esc exits in every mode
{ const FS = (() => { const c = {}; c.globalThis = c; vm.createContext(c); vm.runInContext(fs, c); return c.HelmFullscreen; })();
  let called = 0; const el = { webkitRequestFullScreen() { called++; } };
  const a = FS.api({ documentElement: el, webkitCurrentFullScreenElement: el, webkitCancelFullScreen() {} });
  assert.equal(a.native, true, 'old Safari has no *Enabled flag'); await a.request(el); assert.equal(called, 1); assert.equal(a.element(), el);
  assert.equal(FS.api({ documentElement: el, webkitFullscreenEnabled: false }).native, false, 'explicitly disabled (iframe) → pseudo'); }
assert.match(fs, /a === 'exit' && isOn\(\)/, 'Esc exits native too when the browser passes it through');
assert.match(rd('public/layout-wizard.css'), /\.viewport:-webkit-full-screen\{/);
console.log('builder-tools: all assertions passed');
