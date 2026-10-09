#!/usr/bin/env node
/* builder-r2.test.mjs — collapsible panels + past-layout re-pricing from the current catalog. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(root, 'public/builder.js'), 'utf8');
const html = readFileSync(join(root, 'public/builder.html'), 'utf8');
const css = readFileSync(join(root, 'public/builder.css'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// --- re-pricing: extract the pure helpers and run them
const grab = (re) => { const m = js.match(re); assert.ok(m, 'helper present: ' + re); return m[0]; };
const src = grab(/const STALE_PRICE_KEYS = [^\n]+/) + '\n' +
  grab(/function stripStalePrices\(items\)\{[\s\S]*?\n\}/) + '\n' +
  grab(/function inCatalog\(type, assetPrices\)\{[^\n]+/);
const { stripStalePrices, inCatalog } = new Function(src + '\nreturn { stripStalePrices, inCatalog };')();
const old = [{ id: 'a', type: 'stage', price: 99, unitPrice: 5, cost: 1, properties: { price: 7, seats: 0 } }, { id: 'b', type: 'bar' }];
const out = stripStalePrices(old);
ok(out[0].price === undefined && out[0].unitPrice === undefined && out[0].cost === undefined, 'top-level stale prices stripped');
ok(out[0].properties.price === undefined && out[0].properties.seats === 0, 'nested stale price stripped, other props kept');
ok(old[0].price === 99 && old[0].properties.price === 7, 'source layout not mutated');
ok(out[0].id === 'a' && out[0].type === 'stage' && out[1].type === 'bar', 'identity/type preserved');
ok(inCatalog('stage', { stage: 50000 }) && !inCatalog('bar', { stage: 50000 }) && !inCatalog('stage', null), 'catalog membership');
ok(/loadItems\(stripStalePrices\(items\)/.test(js), 'past layout load strips stale prices');
ok(/Prices updated to current rates/.test(js), 'toast on re-price');
ok(/price not in catalog/.test(js), 'non-catalog objects flagged in breakdown');

// --- collapsible panels
for (const id of ['leftToggle', 'rightToggle']) {
  ok(new RegExp(`id="${id}"[^>]*aria-expanded="true"`).test(html) || new RegExp(`aria-expanded="true"[^>]*`).test(html), id + ' aria-expanded');
  ok(html.includes(`id="${id}"`), id + ' present');
}
ok(/aria-controls="leftPanel"/.test(html) && /aria-controls="rightPanel"/.test(html), 'aria-controls');
ok(/function initPanelToggles/.test(js) && /localStorage\.setItem\(key\(\)/.test(js) && /'bps\.panels\.'/.test(js), 'per-user persisted state');
ok(/dispatchEvent\(new Event\('resize'\)\)/.test(js), 'canvas resize triggered after toggle');
ok(/aside\.left\.collapsed/.test(css) && /transition:width/.test(css), 'slide animation css');
ok(/builder\.js\?v=11/.test(html) && /builder\.css\?v=8/.test(html), 'cache-bust bumped');
console.log('builder-r2: ' + n + ' checks passed');
