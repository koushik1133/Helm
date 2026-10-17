// verify-1021: phone wrapper must keep the shell-b 38px input floor (quotes/nurture measured 36 vs 38).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const css = readFileSync(new URL('../public/shell-b-style.css', import.meta.url), 'utf8');
assert.match(css, /min-height: 38px;/);
assert.match(css, /html\[data-shell="b"\] \.hp \{ min-height: max\(38px, var\(--hp-h, 38px\)\); \}/);
console.log('  ✓ shell-b .hp phone wrapper matches the 38px input floor');
console.log('verify-1021: ok');
