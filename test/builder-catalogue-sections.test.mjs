// Complete-catalogue pass (2026-10d): every builder item sits in exactly one toolbox section, generic basics
// exist, every styled item has 3D handling, each new type has a render phrase + event rule, and search hits.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), pr = read('public/photo-render-prompt.js'), lw = read('public/layout-wizard.js');
const ASSETS = new Function('return ' + b.slice(b.indexOf('const ASSETS = {') + 15, b.indexOf('\n};', b.indexOf('const ASSETS = {')) + 3))();
const META = new Function('return ' + b.slice(b.indexOf('const PRODUCT_META = {') + 21, b.indexOf('\n};', b.indexOf('const PRODUCT_META = {')) + 3))();
const SECTIONS = new Function('return ' + b.slice(b.indexOf('const TOOLBOX_SECTIONS = [') + 25, b.indexOf('\n];', b.indexOf('const TOOLBOX_SECTIONS = [')) + 3))();
const seen = new Map();
for (const [name, types] of SECTIONS) for (const t of types) { assert.ok(ASSETS[t], 'section ' + name + ' lists unknown type ' + t); assert.ok(!seen.has(t), t + ' in two sections'); seen.set(t, name); }
for (const t of Object.keys(ASSETS)) assert.ok(seen.has(t), 'toolbox section for ' + t);
assert.equal(SECTIONS[0][0], 'Generic basics');
for (const t of ['arch', 'backdrop', 'floralstand', 'decorbox', 'signage', 'recttable', 'chiavari']) assert.equal(seen.get(t), 'Generic basics', t);
assert.ok(ASSETS.stage && ASSETS.table && ASSETS.uplight, 'generic stage / table / light kept');
const NEW = ['backdrop', 'floralstand', 'decorbox', 'signage', 'recttable', 'stageroof', 'varmala', 'micstand', 'teleprompter', 'projector', 'tvstand', 'interpreter', 'pyro', 'towerlight', 'gaddi', 'urli', 'umbrellas', 'doli', 'kalash', 'altar', 'shoerack', 'dessert', 'coffee', 'stall', 'counter', 'plinth', 'kiosk', 'ticketbooth', 'stanchion', 'watchtower', 'extinguisher', 'ambulance'];
for (const t of NEW) {
  assert.ok(ASSETS[t], 'asset ' + t); assert.ok(META[t] && META[t][1].length > 5, 'search tags ' + t);
  assert.ok(new RegExp('\\n    ' + t + ": '").test(pr), 'render phrase ' + t);
  assert.ok(new RegExp("case '" + t + "'").test(b3), '3D model ' + t);
  assert.ok(ASSETS[t].w >= 1 && ASSETS[t].h >= 1 && ASSETS[t].w <= 40 && ASSETS[t].h <= 24, 'real-world size ' + t);
}
// every style option of every variant is handled somewhere in 3D (styledFrame or the item's own case reads VAR.style)
const VS = new Function('return ' + b.slice(b.indexOf('const VARIANT_STYLES = {') + 23, b.indexOf('\n};', b.indexOf('const VARIANT_STYLES = {')) + 3).replace(/ENTRANCE_STYLES/g, '[]'))();
for (const [t, opts] of Object.entries(VS)) for (const [v] of opts) if (v) assert.ok(b3.includes("'" + v + "'") || b3.includes(v + ':['), '3D handles style ' + t + '/' + v);
// photo render has a whitelisted phrase for every style word
const words = pr.slice(pr.indexOf('var VARIANT_WORDS'), pr.indexOf('flower: { rose'));
for (const [, opts] of Object.entries(VS)) for (const [v] of opts) if (v) assert.ok(new RegExp('[ {]' + v + ": '").test(words), 'render words for style ' + v);
// event rules: religious-only / wedding-only pieces are grouped
for (const [t, gname] of [['altar', 'religious'], ['varmala', 'wedding'], ['doli', 'wedding'], ['urli', 'floral']]) assert.match(lw, new RegExp(t + ": '" + gname + "'"));
// search: what planners type finds the product
for (const t in META) if (ASSETS[t]) ASSETS[t].tags = META[t][1];
const cx = {}; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(read('public/builder-tools.js'), cx);
const top = (q, n = 3) => cx.HelmBuilderTools.searchAssets(q, ASSETS, {}, { limit: n }).map((r) => r.type);
for (const [q, t] of [['mandap', 'mandap'], ['kalash', 'kalash'], ['photo booth', 'photobooth'], ['cocktail', 'cocktail'], ['uplighter', 'uplight'], ['podium', 'podium'],
  ['truss', 'truss'], ['barricade', 'barricade'], ['neon sign', 'neonsign'], ['swing', 'jhoola'], ['canopy', 'canopy'], ['projector', 'projector'], ['stanchion', 'stanchion'],
  ['pooja', 'altar'], ['generic', 'backdrop'], ['dessert', 'dessert'], ['ticket', 'ticketbooth'], ['fire extinguisher', 'extinguisher'], ['standee', 'signage'], ['chair', 'chiavari']])
  assert.ok(top(q, 5).includes(t), 'search "' + q + '" → ' + t + ' (got ' + top(q, 5).join(',') + ')');
// toolbox is built with the DOM API (no innerHTML with data)
const tb = b.slice(b.indexOf('function buildToolbox('), b.indexOf('function assetGlyph('));
assert.ok(!/host\.innerHTML/.test(tb), 'toolbox via DOM API');
console.log('builder-catalogue-sections: ok (' + Object.keys(ASSETS).length + ' items in ' + SECTIONS.length + ' sections)');
