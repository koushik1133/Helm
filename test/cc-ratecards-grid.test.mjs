// Control Center > Pricing > "Object & item prices (layout builder)" grid (asset-price-grid.js):
// aligned subgrid layout, default under the input, categories + search, Reset, and rate validation
// (empty = default, negative / unreadable blocked, unlisted stored prices kept).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

const src = read('public/asset-price-grid.js'), css = read('public/asset-price-grid.css'), html = read('public/control.html');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(src, cx);
const G = cx.window.HelmAssetPriceGrid;
const J = (x) => JSON.parse(JSON.stringify(x));   // vm-realm values -> this realm for deepEqual
// the catalog lives in control.html; parse its [type,label,default] rows
const block = html.slice(html.indexOf('const ITEM_CATALOG = ['), html.indexOf('function renderItemPrices'));
const CATALOG = [...block.matchAll(/\['([a-z0-9]+)','([^']+)',(\d+)\]/g)].map((m) => [m[1], m[2], +m[3]]);

t('catalog parsed', () => { assert.ok(CATALOG.length > 100, 'catalog rows: ' + CATALOG.length); });
t('every catalog item has a real category (none fall into Other)', () => {
  const other = CATALOG.filter((c) => G.categoryOf(c[0]) === 'other').map((c) => c[0]);
  assert.deepEqual(other, []);
});
t('groups follow the category order, items A-Z, nothing lost', () => {
  const gs = J(G.groupCatalog(CATALOG));
  const order = J(G.CATS).map((c) => c[0]);
  assert.deepEqual(gs.map((g) => g.key), order.filter((k) => gs.some((g) => g.key === k)));
  assert.equal(gs.reduce((s, g) => s + g.items.length, 0), CATALOG.length);
  gs.forEach((g) => { const names = g.items.map((i) => i.label); assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b))); });
  assert.equal(gs[0].name, 'Structure & stage');
  assert.ok(gs.find((g) => g.key === 'av').items.some((i) => i.type === 'dj'));
  assert.ok(gs.find((g) => g.key === 'seating').items.some((i) => i.type === 'sofa'));
  assert.ok(gs.find((g) => g.key === 'safety').items.some((i) => i.type === 'firstaid'));
});
t('unknown type goes to Other (future catalog rows still render)', () => {
  const gs = G.groupCatalog([['newthing', 'New Thing', 10]]);
  assert.equal(gs.length, 1); assert.equal(gs[0].key, 'other');
});
t('search: by name, or a whole category when the query is its name', () => {
  const items = G.groupCatalog(CATALOG).flatMap((g) => g.items);
  const floral = Object.keys(G.filterTypes(items, 'floral'));
  assert.ok(floral.includes('floral') && floral.includes('floralarch'));
  assert.ok(!floral.includes('balloonarch'), 'category "Decor & florals" must not pull every decor item');
  const seat = Object.keys(G.filterTypes(items, 'seating'));
  assert.ok(seat.includes('sofa') && seat.includes('bench') && seat.includes('gaddi'), 'category word');
  const food = Object.keys(G.filterTypes(items, 'food'));
  assert.ok(food.includes('buffet') && food.includes('truck') && food.includes('livecounter'));
  assert.equal(Object.keys(G.filterTypes(items, '')).length, items.length);
  assert.equal(Object.keys(G.filterTypes(items, 'zzzz')).length, 0);
  assert.ok(Object.keys(G.filterTypes(items, 'EXPO   booth')).includes('booth'), 'case / spaces');
});
t('shownValue: stored "" / null / junk show as empty (default), numbers as-is', () => {
  assert.equal(G.shownValue(undefined), ''); assert.equal(G.shownValue(null), '');
  assert.equal(G.shownValue(''), ''); assert.equal(G.shownValue('  '), '');
  assert.equal(G.shownValue('abc'), ''); assert.equal(G.shownValue(0), '0');
  assert.equal(G.shownValue(1500), '1500'); assert.equal(G.shownValue('2500.5'), '2500.5');
});
t('checkRate: empty = default, numbers ok, bad blocked', () => {
  assert.deepEqual(J(G.checkRate('', 'Tent')), { ok: true, value: null });
  assert.deepEqual(J(G.checkRate('  ', 'Tent')), { ok: true, value: null });
  assert.equal(G.checkRate('0', 'Tent').value, 0);
  assert.equal(G.checkRate('1500', 'Tent').value, 1500);
  assert.equal(G.checkRate('12.345', 'Tent').value, 12.35);
  for (const bad of ['-1', 'abc', '1e5', '12a', 'Infinity', '20000000']) {
    const r = G.checkRate(bad, 'Tent'); assert.equal(r.ok, false, bad); assert.match(r.error, /^Tent price /); assert.ok(r.short);
  }
  assert.equal(G.checkRate('-1', 'Tent').short, "Can't be negative");
  assert.equal(G.checkRate('20000000', 'Tent').short, 'Too large');
});
t('checkRate: browser-unreadable input and hardener-cleared negatives block (not silently default)', () => {
  assert.equal(G.checkRate('', 'Tent', { badInput: true }).ok, false);
  const neg = G.checkRate('', 'Tent', { rejected: 'negative' });
  assert.equal(neg.ok, false); assert.match(neg.error, /cannot be negative/);
  assert.equal(G.checkRate('5', 'Tent', { rejected: 'negative' }).ok, true, 'a new value clears it');
});
t('mergePrices keeps stored prices for types the grid does not list; empty drops the override', () => {
  const prev = { zzz_custom: 5, booth: 8000, stage: 1 };
  const out = G.mergePrices(prev, [{ type: 'booth', value: 9000 }, { type: 'stage', value: null }], ['booth', 'stage']);
  assert.deepEqual(J(out), { zzz_custom: 5, booth: 9000 });
  assert.deepEqual(J(G.mergePrices(null, [{ type: 'a', value: 0 }], ['a'])), { a: 0 }, '0 is a real price');
});

// ---- wiring ----
t('control.html loads the grid script + stylesheet', () => {
  assert.match(html, /<script src="asset-price-grid\.js\?v=\d+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="asset-price-grid\.css\?v=\d+">/);
  assert.match(html, /<div id="itemPriceList"><\/div>/, 'no 3-col .grid on the host');
});
t('renderItemPrices uses the module (no "(default ...)" inside labels)', () => {
  const fn = html.slice(html.indexOf('function renderItemPrices'), html.indexOf('$("#p_country").addEventListener'));
  assert.match(fn, /HelmAssetPriceGrid\.render\(\$\("#itemPriceList"\)/);
  assert.doesNotMatch(fn, /\(default \$\{/);
});
t('save: reads through the grid, blocks on error, saves a COPY then commits', () => {
  const h = html.slice(html.indexOf('$("#saveItemPrices").addEventListener'), html.indexOf('async function renderLayoutRules'));
  assert.match(h, /itemGrid\.read\(\)/);
  assert.match(h, /if\(!res\.ok\)\{ setMsg\("err",res\.error\)/);
  assert.match(h, /const nextCfg=Object\.assign\(\{\}, pricingCfg, \{ assetPrices: res\.prices \}\)/);
  assert.match(h, /await BPStore\.config\.setPricing\(nextCfg\); pricingCfg=nextCfg; itemGrid\.markSaved/);
  assert.doesNotMatch(h, /pricingCfg\.assetPrices=ap/, 'no in-memory mutation before the server accepts it');
});
t('module: DOM API only, privacy-masked default, search kept out of the unsaved tracker', () => {
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(src, /amt\.setAttribute\("data-money", "1"\)/, 'default amount is masked by the privacy screen');
  assert.match(src, /inp\.placeholder = "Default"/, 'placeholder never shows an amount (inputs are not masked)');
  assert.match(src, /e\.stopPropagation\(\)/);
  assert.match(src, /data-cs-nodirty/);
  assert.match(src, /validity\.badInput/);
  assert.match(src, /getAttribute\("data-rejected"\)/);
  assert.match(src, /lab\.title = it\.label/, 'tooltip for clamped names');
});
t('css: subgrid alignment, right-aligned numbers, currency inside, reset keeps its space', () => {
  assert.match(css, /grid-template-rows:subgrid/);
  assert.match(css, /grid-row:span 3/);
  assert.match(css, /@supports not \(grid-template-rows:subgrid\)/);
  assert.match(css, /text-align:right/);
  assert.match(css, /-webkit-line-clamp:2/);
  assert.match(css, /\.apg-reset\.is-off\{visibility:hidden\}/);
  assert.match(css, /minmax\(min\(100%,180px\),1fr\)/);
  assert.match(css, /\.apg-field \.neg-hint\{display:none!important\}/);
});
console.log('cc-ratecards-grid: ' + n + ' passed');
