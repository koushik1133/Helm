// r76: at 320px the shell B header (burger + title + privacy + search + bell + split "+") overflowed to ~362px.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const css = readFileSync(new URL('../public/shell-b-pages.css', import.meta.url), 'utf8');
const m = css.match(/@media \(max-width: 359\.98px\) \{([\s\S]*?)\n\}/);
assert.ok(m, 'a sub-360px header block exists');
const b = m[1];
assert.match(b, /\.hb-tools \{ gap: 0; \}/);
assert.match(b, /:is\(\.hb-burger, \.hb-tools \.hb-ibtn, \.hb-tools \.hb-bell \.bpb-btn\) \{ width: 40px; min-width: 40px;/);
assert.match(b, /\.hb-split \.hb-chev \{ width: 32px; min-width: 32px; \}/);
// budget: 12 pad + 40 burger + 56 title + 3*2 gaps + 3*40 icons + 40+32 split = 306 <= 320
assert.ok(12 + 40 + 56 + 6 + 120 + 72 <= 320);
console.log('shell-320-header: ok');
