// Default catalog prices for every builder item (2026-10). Code-level defaults only:
// a studio's own Control Center price (config.assetPrices) always wins, nothing is written.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), sa = read('public/store-api.js'), cc = read('public/control.html'), doc = read('docs/ITEM-PRICING-DEFAULTS.md');
const obj = (src, re) => { const m = src.match(re); assert.ok(m, String(re)); return new Function('return {' + m[1] + '}')(); };
const DEF = obj(b, /const DEFAULT_PRICES = \{[^\n]*\n([\s\S]*?)\n\};/);
const OBJ = obj(sa, /const OBJECT_PRICE = \{\n([\s\S]*?)\n  \};/);
const CAT = new Function('return ' + cc.match(/const ITEM_CATALOG = (\[[\s\S]*?\n  \]);/)[1])();
// builder and the shared pricing engine agree
for (const [k, v] of Object.entries(OBJ)) assert.equal(DEF[k], v, 'builder default for ' + k);
for (const [k, v] of Object.entries(DEF)) if (k !== 'mandap_decor') assert.equal(OBJ[k], v, 'store-api default for ' + k);
// Control Center lists every priced item with the same default, so admins can edit it
const catMap = Object.fromEntries(CAT.map(([t, , p]) => [t, p]));
for (const [k, v] of Object.entries(OBJ)) assert.equal(catMap[k], v, 'Control Center item ' + k);
assert.equal(new Set(CAT.map((c) => c[0])).size, CAT.length, 'no duplicate Control Center rows');
// every non-seat builder asset has a shipped default (no more "price not in catalog")
const a0 = b.indexOf('const ASSETS = {'), a1 = b.indexOf('\n};', a0);
const assets = [...b.slice(a0, a1).matchAll(/^\s*([a-z_0-9]+):\s*\{\s*label:'[^']*',\s*category:'[a-z]+'(.*)$/gm)].map((m) => ({ t: m[1], seat: /props:\{(rows|seats)/.test(m[2]) || /^(chiavari|barstool)$/.test(m[1]) }));
assert.ok(assets.length > 60, 'parsed builder assets');
for (const { t, seat } of assets) if (!seat) assert.ok(DEF[t] != null, 'default price for ' + t);
for (const t of ['led', 'walkway', 'brandwall', 'lighting', 'podium', 'barricade', 'exit', 'linearray', 'generator', 'photobooth', 'stagebarrier']) {
  assert.ok(DEF[t] != null, t); assert.match(doc, new RegExp('`' + t + '`'), 'documented: ' + t); }
assert.equal(DEF.led, 18000); assert.equal(DEF.exit, 500); assert.equal(DEF.barricade, 1800);
// studio overrides still win (additive defaults only)
const engine = { OBJECT_PRICE: OBJ, OBJECT_CAT_PRICE: {}, unitPrice: new Function('OBJECT_PRICE', 'OBJECT_CAT_PRICE', 'return function' + sa.match(/unitPrice(\(it, assetPrices\)\{[\s\S]*?return OBJECT_CAT_PRICE\[it\.category\] \|\| 3000; \})/)[1])(OBJ, {}) };
assert.equal(engine.unitPrice({ type: 'led' }, { led: 25000 }), 25000, 'studio price wins');
assert.equal(engine.unitPrice({ type: 'led' }, {}), 18000, 'default when studio has none');
assert.equal(engine.unitPrice({ type: 'led' }, null), 18000);
// badge only for items with neither a studio price nor a shipped default
assert.match(b, /!inCatalog\(l\.type, PRICING\.assetPrices\) && DEFAULT_PRICES\[l\.type\]==null/);
// Control Center save keeps only typed values (blank = use default), never writes defaults
assert.match(cc, /const v=inp\.value\.trim\(\); if\(v===""\) continue;/);
console.log('catalog-defaults: ok');
