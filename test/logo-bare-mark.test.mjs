// Dashboard logo: bare Helm mark (no tile) + per-theme mark colours with strong contrast on the rail.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CSS = read('public/shell-b.css'), STUDIO = read('public/shell-b-theme-studio.css'), LUXE = read('public/shell-b-theme-luxe.css'), MARK = read('public/brand/mark.svg');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

t('tile background removed for every theme', () => {
  assert.match(CSS, /html\[data-shell="b"\] \.hb-logo, html\[data-shell="b"\]\[data-hb-theme\] \.hb-logo \{ background: none;[^}]*box-shadow: none/);
  assert.doesNotMatch(CSS, /\.hb-logo \{ background: var\(--hb-tile\)/);
  assert.match(STUDIO, /"studio"\] \.hb-logo \{ background:none;/);
  assert.match(LUXE, /"luxe"\] \.hb-logo \{ background:none;/);
});
t('mark pills follow theme tokens', () => {
  assert.match(CSS, /--hb-mark: var\(--hb-ink\); --hb-mark2: var\(--hb-acc-text\)/);
  assert.match(CSS, /\[data-hb-theme="graphite"\] \{ --hb-mark2: var\(--hb-ink3\)/);
  assert.match(CSS, /\.helm-mark \{[^}]*color: var\(--hb-mark\); stroke: var\(--hb-mark2\)/);
});
t('mark.svg stays theme-aware (currentColor + inherited stroke)', () => {
  assert.match(MARK, /stroke="currentColor"/);
  assert.match(MARK, /<path d="M29\.81[^"]*" stroke-width="13" stroke-linecap="round"\/>/);
});
t('every theme pill colour has >= 4.5:1 contrast on its rail background', () => {
  // [theme, rail bg, pill1 (ink), pill2 (accent text / graphite ink3)] — values copied from the token blocks
  const rows = [
    ['cobalt light', '#ffffff', '#0b1b3f', '#1d44d8'], ['cobalt dark', '#111833', '#e8edfb', '#93acff'], ['os-dark fallback', '#121212', '#f2f2f2', '#93acff'],
    ['emerald light', '#ffffff', '#0b2a22', '#036b4d'], ['emerald dark', '#0f1f1c', '#e6f4ef', '#5fe0b0'],
    ['midnight light', '#ffffff', '#12133a', '#3f34c2'], ['midnight dark', '#14152f', '#ebebfa', '#a9a4ff'],
    ['graphite light', '#ffffff', '#111111', '#6e6e6a'], ['graphite dark', '#161616', '#f2f2f2', '#999999'],
    ['studio light', '#faf8f5', '#1f1a24', '#5b2a86'], ['studio dark', '#141216', '#f3f0f5', '#b794e0'],
    ['luxe light', '#f7f3ea', '#1b1814', '#6b1e24'], ['luxe dark', '#14120f', '#efe8db', '#d29a96'],
  ];
  for (const [name, bg, a, b] of rows) {
    assert.ok(ratio(a, bg) >= 7, name + ' pill1 ' + ratio(a, bg).toFixed(2));
    assert.ok(ratio(b, bg) >= 4.5, name + ' pill2 ' + ratio(b, bg).toFixed(2));
  }
  for (const v of ['#1d44d8', '#93acff', '#036b4d', '#5fe0b0', '#3f34c2', '#a9a4ff']) assert.ok(CSS.toLowerCase().includes(v), v);
});
console.log(n + ' tests passed');
