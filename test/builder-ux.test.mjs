#!/usr/bin/env node
/* builder-ux.test.mjs — pins the builder UX pass (compact header, units dropdown,
 * dismissible toolbox hint + shortcuts dialog, on-canvas camera pan pad).
 * Pure Node, no deps: source-level checks + a tiny behavioural check of setUnit(). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public/builder.html'), 'utf8');
const js = readFileSync(join(ROOT, 'public/builder.js'), 'utf8');
const js3d = readFileSync(join(ROOT, 'public/builder-3d.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public/builder.css'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// 1. units dropdown
ok(/<select id="unitSel"[^>]*>\s*<option value="ft"[^>]*>Feet<\/option>\s*<option value="m">Meter<\/option>/.test(html), 'units is a Feet/Meter <select>');
ok(!/id="unitSeg"/.test(html) && !/#unitSeg/.test(js), 'old unit button segment is gone');
ok(/\$\('#unitSel'\)\.addEventListener\('change',e=>setUnit\(e\.target\.value\)\)/.test(js), 'select change calls setUnit');
const m = js.match(/function setUnit\(u\)\{[\s\S]*?\n\}/); ok(m, 'setUnit exists');
{
  const store = { grid: { unit: 'ft', sizeFt: 1 } }; const sel = { value: 'ft' }; const corner = { textContent: 'ft' }; let renders = 0;
  const $ = s => (s === '#unitSel' ? sel : corner);
  const cellFt = () => (store.grid.unit === 'm' ? 3.28084 : 1);
  const uLabel = () => store.grid.unit;
  const setUnit = new Function('store', '$', 'cellFt', 'uLabel', 'renderAll', m[0] + '; return setUnit;')(store, $, cellFt, uLabel, () => renders++);
  setUnit('m');
  ok(store.grid.unit === 'm' && Math.abs(store.grid.sizeFt - 3.28084) < 1e-9 && corner.textContent === 'm' && renders === 1, 'switching to meter converts grid');
  setUnit('evil'); ok(store.grid.unit === 'ft' && store.grid.sizeFt === 1, 'unknown unit falls back to feet');
}
ok(/\$\('#unitSel'\)\.value = store\.grid\.unit/.test(js), 'syncGridUI reflects unit into the select');

// 2. no SUPABASE connection indicator
ok(!/SUPABASE/i.test(html.replace(/<link\b[^>]*>/g, '')), 'no Supabase text in builder.html (head preconnect/preload <link>s are not UI text)');
ok(!/id="conn"|id="connLbl"/.test(html) && !/#connLbl/.test(js), 'connection indicator removed');
ok(/id="acctMenu"/.test(html) && /id="acct"/.test(html), 'account menu keeps role/email/sign-out');
for (const id of ['exportBtn', 'jsonBtn', 'importBtn']) ok(new RegExp(`id="moreMenu"[\\s\\S]*id="${id}"[\\s\\S]*</details>`).test(html), `${id} lives in More menu`);

// 3. dismissible hint + shortcuts dialog
ok(/id="toolHint"[^>]*data-tour="toolbox-shortcuts"/.test(html), 'hint has a data-tour anchor');
ok(/id="hintClose"[^>]*aria-label="Hide hint"/.test(html), 'hint has a close button');
ok(/id="shortcutsBtn"[^>]*aria-label="Show keyboard shortcuts"/.test(html), 'hint has a shortcuts button');
ok(/id="shortcutsModal"[^>]*role="dialog"/.test(html) && /<dl class="sclist">/.test(html), 'shortcuts dialog exists');
ok(!/Drag empty floor<\/b> to marquee-select/.test(html), 'long help paragraph removed');
ok(/try\{ hidden=localStorage\.getItem\(KEY\)==='1'; \}catch\{\}/.test(js) && /try\{ localStorage\.setItem\(KEY,'1'\); \}catch\{\}/.test(js), 'dismissal persisted with try/catch');

// 4. nav pad
const pad = html.match(/<div class="navpad" id="navPad"[\s\S]*?<\/div>/); ok(pad, 'nav pad exists');
const btns = [...pad[0].matchAll(/<button type="button" data-pan="(\w+)"[^>]*aria-label="([^"]+)"/g)];
ok(btns.length === 5, 'nav pad has 5 labelled buttons');
assert.deepEqual(btns.map(b => b[1]).sort(), ['center', 'down', 'left', 'right', 'up']); n++;
ok(/function pan2D\(dir, frac\)/.test(js) && /function recenterView\(\)/.test(js), '2D pan functions exist');
ok(/function pan3D\(dir, frac\)/.test(js3d) && /window\.__pan3D=pan3D/.test(js3d) && /function recenter3D\(\)/.test(js3d), '3D pan functions exist');
ok(/controls\.target\.add\(d\); camera\.position\.add\(d\)/.test(js3d), '3D pan moves target and camera together');
ok(/requestAnimationFrame\(tick\)/.test(js) && /prefers-reduced-motion/.test(js), 'press-and-hold uses rAF, respects reduced motion');
ok(/e=>e\.stopPropagation\(\)/.test(js), 'pad stops propagation to the canvas');
ok(/\.navpad\{position:absolute/.test(css), 'pad is positioned on the canvas');

// CSP: no inline handlers
ok(!/\son[a-z]+="/i.test(html), 'no inline event handlers');
console.log(`builder-ux: ${n} checks passed`);
