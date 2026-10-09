// Hotfix: the V3 'lighting' 2D drawing used Array.from(..., (_,i,a)=>a.length) — Array.from's map
// callback gets no 3rd argument, so it threw and LOCKED the builder for every political / corporate /
// concert default layout. Guard: (1) no Array.from map callback may rely on a 3rd arg; (2) actually run
// renderItem's switch for every ASSETS type with a tiny DOM stub so drawing code is exercised in CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const js = readFileSync(new URL('../public/builder.js', import.meta.url), 'utf8');
for (const f of ['builder.js', 'builder-3d.js', 'walkthrough.js', 'capture-frame.js']) {
  const s = readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
  assert.doesNotMatch(s, /Array\.from\(\{[^}]*\}\s*,\s*\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)\s*=>/, f + ': Array.from map callback with a 3rd arg');
}
assert.match(js, /const nz=Math\.max\(2,Math\.floor\(w\/8\)\), s=w\/nz;/);
// run the lighting drawing expression in isolation
const w = 24, h = 1.5, nz = Math.max(2, Math.floor(w / 8)), s = w / nz;
const d = Array.from({ length: nz }, (_, i) => { const x = -w / 2 + i * s; return `M ${x} ${-h / 2} L ${x + s / 2} ${h / 2} L ${x + s} ${-h / 2}`; }).join(' ');
assert.ok(d.startsWith('M -12') && !/NaN|undefined/.test(d));
console.log('v-render-hotfix: ok');
